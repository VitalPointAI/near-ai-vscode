// Runs the decode worker (decodeWorker.ts) for the replica store (D-05 as refined by D-43). Bytes from outside the machine are inspected in one
// reused child process with its own heap and stack limits and a time limit per job, so a decoder bug or a hostile or large accepted update can
// cost that process and never the extension host.
//
// Why a child process and not a worker thread: a worker thread's heap is the extension host's own memory, and its resourceLimits are not a hard
// bound. V8 flags are process-wide, so a host started with --max-old-space-size (on its command line or in NODE_OPTIONS) gives every worker that
// limit whatever resourceLimits says (measured on Node 24: 16 MB asked, 906 MB given), and a worker cannot be given V8 flags of its own (execArgv
// with --max-old-space-size is refused with ERR_WORKER_INVALID_EXEC_ARGV). Watching a worker's heap from the host does not close the gap either:
// one synchronous step (a single large allocation) runs to its end before the worker can answer. A child process gets its limits from its own
// command line: fork() is given an explicit execArgv (so the host's flags are not passed on) and an environment without NODE_OPTIONS (so they cannot
// come in that way), and V8 in the child then stops any decode at the cap. In the editor, fork() runs the editor's own executable; the environment
// sets ELECTRON_RUN_AS_NODE so it runs as Node, as language servers forked from extensions do (checked with the editor's Electron 43: the child
// reports the cap as its heap limit while the host has NODE_OPTIONS=--max-old-space-size=1536).
//
// The host sees a decode that ran out of heap as V8's "out of memory" fatal error on the child's stderr, and ends the child there; a job past the
// time limit is ended with SIGKILL, which stops a child even in the middle of a synchronous loop. Either way the job is too-large.
//
// Child lifecycle (one child at a time, jobs one at a time):
//   none --inspect--> running (a new child is started; starts counts it)
//   running --job answered--> running (the same child takes the next job)
//   running --out of memory or past the time limit--> none, the job is too-large and restarts counts it
//   running --any other end, an error, or a reply it cannot read or did not owe--> none, the job is malformed and restarts counts it
//   running --close()--> none, after the jobs already asked have been answered; restarts does not count it
// The next inspect after "none" starts a new child, so a failure costs one job and one restart, never the next job. lastFailure names the most
// recent failure, for logs and tests.
//
// The host only reports what the child found (P-31-12): it never holds an entry back from the store or changes what the fold sees. What to do
// with a refusal is the store's decision (31-13), and the pure fold keeps its own checks as a second line in any case.
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { DecodeKind } from './decodeWorker';

export type { DecodeKind } from './decodeWorker';

export interface DecodeLimits {
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
  stackSizeMb: number;
  timeoutMs: number;
}

// 128 MB old generation passes the largest update the skim lets through (100,000 text items, about 40 MB) with room to spare, and refuses
// anything that grows past it; measured in 31-RESEARCH.md "D-05".
export const DECODE_LIMITS: Readonly<DecodeLimits> = Object.freeze({ maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4, timeoutMs: 5000 });

export type DecodeError = 'too-large' | 'malformed' | 'forbidden-content';
// structs, deletes and clients are counts, the same as the in-process inspectUpdate gives for the same bytes.
export type DecodeVerdict = { ok: true; structs: number; deletes: number; clients: number } | { ok: false; error: DecodeError };
// Why the last child was dropped: it ran out of heap, a job passed the time limit, or it failed in any other way.
export type DecodeFailure = 'out-of-memory' | 'timeout' | 'crashed';

export interface DecodeHostOptions {
  workerFile?: string;
  limits?: Partial<DecodeLimits>;
}

interface PendingJob {
  id: number;
  child: ChildProcess;
  timer: NodeJS.Timeout;
  resolve: (verdict: DecodeVerdict) => void;
}

const ERRORS: readonly DecodeError[] = ['too-large', 'malformed', 'forbidden-content'];
const MALFORMED: DecodeVerdict = { ok: false, error: 'malformed' };
const TOO_LARGE: DecodeVerdict = { ok: false, error: 'too-large' };

// How much of a child's stderr is kept: V8's out-of-memory line comes within the first few lines (after a short list of the last collections), and
// the rest (a native stack) is read and thrown away so a chatty child can never fill the host's memory or block on a full pipe.
const STDERR_KEPT = 16 * 1024;
// Node prints "FATAL ERROR: ... JavaScript heap out of memory" (or "process out of memory") when V8 reaches the heap limit.
const OUT_OF_MEMORY = /\bout of memory\b/i;
// V8's default stack limit, which fits the 1 MB main-thread stack Windows executables are usually given.
const DEFAULT_STACK_KB = 984;

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

// The child runs this extension's own code, but its reply crosses a process boundary, so it is read as untrusted shape. undefined for a reply that
// is not one the child writes.
function verdictOf(reply: Partial<Record<string, unknown>>): DecodeVerdict | undefined {
  if (reply.ok === true && isCount(reply.structs) && isCount(reply.deletes) && isCount(reply.clients)) {
    return { ok: true, structs: reply.structs, deletes: reply.deletes, clients: reply.clients };
  }
  if (reply.ok === false && ERRORS.includes(reply.error as DecodeError)) return { ok: false, error: reply.error as DecodeError };
  return undefined;
}

function limitOf(given: number | undefined, fallback: number): number {
  return typeof given === 'number' && Number.isFinite(given) && given > 0 ? given : fallback;
}

// V8's young generation is three semi-spaces, each a power of two in megabytes: the largest semi-space whose three fit the young limit, at least 1 MB.
function semiSpaceMb(youngMb: number): number {
  let semi = 1;
  while (semi * 2 * 3 <= youngMb) semi *= 2;
  return semi;
}

// The child's whole command line for V8. Only these flags reach it: fork() is given this list instead of the host's own execArgv.
function childExecArgv(limits: DecodeLimits): string[] {
  // --stack-size only says where V8 throws a RangeError; the thread's real stack must be larger. Linux and macOS give a main thread 8 MB, so the
  // configured stack is used there; on Windows it stays at V8's default. A recursion past the real stack still only ends the child (malformed).
  const stackKb = Math.max(1, Math.floor(limits.stackSizeMb * 1024));
  return [
    `--max-old-space-size=${Math.max(1, Math.floor(limits.maxOldGenerationSizeMb))}`,
    `--max-semi-space-size=${semiSpaceMb(limits.maxYoungGenerationSizeMb)}`,
    `--stack-size=${process.platform === 'win32' ? Math.min(stackKb, DEFAULT_STACK_KB) : stackKb}`
  ];
}

// The host's environment without NODE_OPTIONS (in any letter case: Windows names are case-insensitive), so flags the host was started with cannot
// raise the child's limits, and with ELECTRON_RUN_AS_NODE so the editor's executable runs the child as Node. Plain Node ignores that variable.
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== 'NODE_OPTIONS' && key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  }
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

export class DecodeHost {
  private readonly workerFile: string;
  private readonly limits: DecodeLimits;
  private child: ChildProcess | undefined;
  private pending: PendingJob | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private restartCount = 0;
  private startCount = 0;
  private failure: DecodeFailure | undefined;

  constructor(options: DecodeHostOptions = {}) {
    this.workerFile = options.workerFile ?? path.join(__dirname, 'decodeWorker.js');
    const given = options.limits ?? {};
    this.limits = {
      maxOldGenerationSizeMb: limitOf(given.maxOldGenerationSizeMb, DECODE_LIMITS.maxOldGenerationSizeMb),
      maxYoungGenerationSizeMb: limitOf(given.maxYoungGenerationSizeMb, DECODE_LIMITS.maxYoungGenerationSizeMb),
      stackSizeMb: limitOf(given.stackSizeMb, DECODE_LIMITS.stackSizeMb),
      timeoutMs: limitOf(given.timeoutMs, DECODE_LIMITS.timeoutMs)
    };
  }

  // Children dropped after a failure (out of memory, past the time limit, an error or an unexpected end). close() is not a failure.
  get restarts(): number {
    return this.restartCount;
  }

  // Children started so far, so a caller can see that jobs reuse one child.
  get starts(): number {
    return this.startCount;
  }

  // Why the most recent child was dropped; undefined while none has failed.
  get lastFailure(): DecodeFailure | undefined {
    return this.failure;
  }

  // Inspects one update, snapshot or state. Never rejects: every failure, including a child that cannot start, is a verdict. Jobs run one at a time
  // in the order asked.
  inspect(kind: DecodeKind, bytes: Uint8Array): Promise<DecodeVerdict> {
    const run = this.tail.then(() => this.run(kind, bytes));
    this.tail = run;
    return run;
  }

  // Ends the child once the jobs already asked have been answered, and waits until it has exited. A later inspect starts a new child.
  async close(): Promise<void> {
    await this.tail;
    const child = this.child;
    this.child = undefined;
    if (child !== undefined) await stopped(child);
  }

  private run(kind: DecodeKind, bytes: Uint8Array): Promise<DecodeVerdict> {
    return new Promise<DecodeVerdict>((resolve) => {
      let child: ChildProcess;
      try {
        child = this.current();
      } catch {
        resolve(MALFORMED);
        return;
      }
      const id = this.nextId;
      this.nextId += 1;
      // Past the time limit the child is killed: a job that runs this long is treated as too large to inspect. The timer also keeps the host's event
      // loop alive while the job is in flight (the idle child does not).
      const timer = setTimeout(() => this.drop(child, TOO_LARGE, 'timeout'), this.limits.timeoutMs);
      this.pending = { id, child, timer, resolve };
      try {
        // The advanced serialization sends exactly the bytes of the view, not the rest of a larger buffer it may sit on, and the child receives a
        // Uint8Array.
        child.send({ id, kind, bytes }, (error) => {
          if (error) this.drop(child, MALFORMED, 'crashed');
        });
      } catch {
        this.drop(child, MALFORMED, 'crashed');
      }
    });
  }

  private current(): ChildProcess {
    if (this.child !== undefined) return this.child;
    const child = fork(this.workerFile, [], {
      execArgv: childExecArgv(this.limits),
      env: childEnv(),
      serialization: 'advanced',
      // stdin and stdout are not used; stderr is read for the out-of-memory line; the fourth is the job channel.
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true
    });
    this.startCount += 1;
    this.child = child;
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length >= STDERR_KEPT) return;
      stderr += chunk.slice(0, STDERR_KEPT - stderr.length);
      // V8 prints the line as soon as the heap limit is reached, then spends a second or more printing a native stack. The child is ended at the
      // line, so an out-of-memory job is answered in milliseconds and never runs into the time limit instead.
      if (OUT_OF_MEMORY.test(stderr)) this.drop(child, TOO_LARGE, 'out-of-memory');
    });
    // An idle child must not keep the host's process alive; a job in flight keeps it alive through its timer.
    child.unref();
    child.channel?.unref();
    (child.stderr as { unref?: () => void } | null)?.unref?.();
    child.on('message', (reply: unknown) => this.answer(child, reply));
    // Always listened to: an 'error' event with no listener would be thrown on the extension host's thread. It comes when the child cannot be
    // started or a job cannot be sent to it.
    child.on('error', () => this.drop(child, MALFORMED, 'crashed'));
    // A child that closes its job channel can no longer answer; it is ended, and 'close' below gives the verdict.
    child.on('disconnect', () => { killNow(child); });
    // 'close' comes after the child has exited and its stderr has been read to the end, so an out-of-memory end can be told from any other.
    child.on('close', () => {
      if (OUT_OF_MEMORY.test(stderr)) this.drop(child, TOO_LARGE, 'out-of-memory');
      else this.drop(child, MALFORMED, 'crashed');
    });
    return child;
  }

  private answer(child: ChildProcess, reply: unknown): void {
    // A message from a child already dropped changes nothing.
    if (this.child !== child) return;
    const job = this.pending;
    // The current child answering a job it was not asked (another id, no job pending, or not an object) is not trusted with the next job: it is
    // dropped as crashed at once, and the job in flight is answered malformed instead of waiting for the time limit.
    if (job === undefined || job.child !== child || typeof reply !== 'object' || reply === null || (reply as { id?: unknown }).id !== job.id) {
      this.drop(child, MALFORMED, 'crashed');
      return;
    }
    const verdict = verdictOf(reply as Record<string, unknown>);
    // A child that answers in a shape it never writes is not trusted with the next job.
    if (verdict === undefined) this.drop(child, MALFORMED, 'crashed');
    else this.settle(job, verdict);
  }

  private settle(job: PendingJob, verdict: DecodeVerdict): void {
    clearTimeout(job.timer);
    if (this.pending === job) this.pending = undefined;
    job.resolve(verdict);
  }

  // Drops a child after a failure and answers its job, if it had one, with the verdict. Only the current child counts: a child already dropped (its
  // end after a time limit, or the end close() causes) changes nothing.
  private drop(child: ChildProcess, verdict: DecodeVerdict, failure: DecodeFailure): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.restartCount += 1;
    this.failure = failure;
    killNow(child);
    const job = this.pending;
    if (job !== undefined && job.child === child) this.settle(job, verdict);
  }
}

// SIGKILL, so a child stuck in synchronous code ends at once. A child that has already ended is left alone.
function killNow(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

// Ends a child and resolves once it has exited (at once if it already has).
function stopped(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    killNow(child);
  });
}
