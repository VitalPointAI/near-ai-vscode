// Runs the decode worker (decodeWorker.ts) for the replica store (D-05 as refined by D-43). Bytes from outside the machine are inspected in one
// reused worker thread whose heap and stack are capped with resourceLimits, with a time limit per job, so a decoder bug or a large accepted update
// can cost a worker and never the extension host.
//
// Two controls hold the heap cap. resourceLimits is the first: V8 stops the worker with ERR_WORKER_OUT_OF_MEMORY. But a process started with
// --max-old-space-size (on its command line or in NODE_OPTIONS) gives every worker that limit instead, whatever resourceLimits says (measured on
// Node 24), so the host also watches the worker's heap while a job runs and stops it once the heap passes the same cap. Either way the job is
// too-large.
//
// Worker lifecycle (one worker at a time, jobs one at a time):
//   none --inspect--> running (a new worker is started; starts counts it)
//   running --job answered--> running (the same worker takes the next job)
//   running --out of memory (either control) or past the time limit--> none, the job is too-large and restarts counts it
//   running --any other error, an unexpected exit, or a reply it cannot read--> none, the job is malformed and restarts counts it
//   running --close()--> none, after the jobs already asked have been answered; restarts does not count it
// The next inspect after "none" starts a new worker, so a failure costs one job and one restart, never the next job. lastFailure names the most
// recent failure, for logs and tests.
//
// The host only reports what the worker found (P-31-12): it never holds an entry back from the store or changes what the fold sees. What to do
// with a refusal is the store's decision (31-13), and the pure fold keeps its own checks as a second line in any case.
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
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

// How often the host reads the worker's heap while a job runs.
const HEAP_WATCH_MS = 10;
const MB = 1024 * 1024;

export type DecodeError = 'too-large' | 'malformed' | 'forbidden-content';
// structs, deletes and clients are counts, the same as the in-process inspectUpdate gives for the same bytes.
export type DecodeVerdict = { ok: true; structs: number; deletes: number; clients: number } | { ok: false; error: DecodeError };
// Why the last worker was dropped: its heap passed the cap, a job passed the time limit, or it failed in any other way.
export type DecodeFailure = 'out-of-memory' | 'timeout' | 'crashed';

export interface DecodeHostOptions {
  workerFile?: string;
  limits?: Partial<DecodeLimits>;
}

interface PendingJob {
  id: number;
  worker: Worker;
  timer: NodeJS.Timeout;
  watch: NodeJS.Timeout;
  reading: boolean;
  resolve: (verdict: DecodeVerdict) => void;
}

const ERRORS: readonly DecodeError[] = ['too-large', 'malformed', 'forbidden-content'];
const MALFORMED: DecodeVerdict = { ok: false, error: 'malformed' };
const TOO_LARGE: DecodeVerdict = { ok: false, error: 'too-large' };

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

// The worker is this extension's own code, but its reply crosses a thread boundary, so it is read as untrusted shape. undefined for a reply that is
// not one the worker writes.
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

export class DecodeHost {
  private readonly workerFile: string;
  private readonly limits: DecodeLimits;
  private readonly heapCapBytes: number;
  private worker: Worker | undefined;
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
    this.heapCapBytes = (this.limits.maxOldGenerationSizeMb + this.limits.maxYoungGenerationSizeMb) * MB;
  }

  // Workers dropped after a failure (out of memory, past the time limit, an error or an unexpected exit). close() is not a failure.
  get restarts(): number {
    return this.restartCount;
  }

  // Workers started so far, so a caller can see that jobs reuse one worker.
  get starts(): number {
    return this.startCount;
  }

  // Why the most recent worker was dropped; undefined while none has failed.
  get lastFailure(): DecodeFailure | undefined {
    return this.failure;
  }

  // Inspects one update, snapshot or state. Never rejects: every failure, including a worker that cannot start, is a verdict. Jobs run one at a
  // time in the order asked.
  inspect(kind: DecodeKind, bytes: Uint8Array): Promise<DecodeVerdict> {
    const run = this.tail.then(() => this.run(kind, bytes));
    this.tail = run;
    return run;
  }

  // Ends the worker once the jobs already asked have been answered. A later inspect starts a new worker.
  async close(): Promise<void> {
    await this.tail;
    const worker = this.worker;
    this.worker = undefined;
    if (worker !== undefined) await worker.terminate().catch(() => undefined);
  }

  private run(kind: DecodeKind, bytes: Uint8Array): Promise<DecodeVerdict> {
    return new Promise<DecodeVerdict>((resolve) => {
      let worker: Worker;
      try {
        worker = this.current();
      } catch {
        resolve(MALFORMED);
        return;
      }
      const id = this.nextId;
      this.nextId += 1;
      // Past the time limit the worker is stopped: a job that runs this long is treated as too large to inspect.
      const timer = setTimeout(() => this.drop(worker, TOO_LARGE, 'timeout'), this.limits.timeoutMs);
      const job: PendingJob = { id, worker, timer, watch: setInterval(() => this.watchHeap(job), HEAP_WATCH_MS), reading: false, resolve };
      job.watch.unref();
      this.pending = job;
      try {
        // A copy of exactly the bytes asked about (a view may sit on a larger buffer), moved to the worker rather than copied again.
        const copy = Uint8Array.from(bytes);
        worker.postMessage({ id, kind, bytes: copy }, [copy.buffer]);
      } catch {
        this.drop(worker, MALFORMED, 'crashed');
      }
    });
  }

  // The second heap control: the worker's heap is read between its own steps (Node interrupts a busy worker to answer), so a decode that grows past
  // the cap is stopped even where resourceLimits has no effect.
  // One read at a time per job; a read that comes back after its job has been answered changes nothing.
  private watchHeap(job: PendingJob): void {
    if (job.reading || typeof job.worker.getHeapStatistics !== 'function') return;
    job.reading = true;
    job.worker.getHeapStatistics().then((stats) => {
      job.reading = false;
      if (this.pending === job && stats.used_heap_size > this.heapCapBytes) this.drop(job.worker, TOO_LARGE, 'out-of-memory');
    }, () => { job.reading = false; });
  }

  private current(): Worker {
    if (this.worker !== undefined) return this.worker;
    const { maxOldGenerationSizeMb, maxYoungGenerationSizeMb, stackSizeMb } = this.limits;
    const worker = new Worker(this.workerFile, { resourceLimits: { maxOldGenerationSizeMb, maxYoungGenerationSizeMb, stackSizeMb } });
    this.startCount += 1;
    // An idle worker must not keep the process alive; a job in flight keeps it alive through its timer.
    worker.unref();
    worker.on('message', (reply: unknown) => this.answer(worker, reply));
    // Always listened to: an 'error' event with no listener would be thrown on the extension host's thread.
    worker.on('error', (error: Error) => {
      if ((error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY') this.drop(worker, TOO_LARGE, 'out-of-memory');
      else this.drop(worker, MALFORMED, 'crashed');
    });
    worker.on('messageerror', () => this.drop(worker, MALFORMED, 'crashed'));
    worker.on('exit', () => this.drop(worker, MALFORMED, 'crashed'));
    this.worker = worker;
    return worker;
  }

  private answer(worker: Worker, reply: unknown): void {
    const job = this.pending;
    if (job === undefined || job.worker !== worker || typeof reply !== 'object' || reply === null || (reply as { id?: unknown }).id !== job.id) return;
    const verdict = verdictOf(reply as Record<string, unknown>);
    // A worker that answers in a shape it never writes is not trusted with the next job.
    if (verdict === undefined) this.drop(worker, MALFORMED, 'crashed');
    else this.settle(job, verdict);
  }

  private settle(job: PendingJob, verdict: DecodeVerdict): void {
    clearTimeout(job.timer);
    clearInterval(job.watch);
    if (this.pending === job) this.pending = undefined;
    job.resolve(verdict);
  }

  // Drops a worker after a failure and answers its job, if it had one, with the verdict. Only the current worker counts: a worker already dropped
  // (its exit after an error, or the exit close() causes) changes nothing.
  private drop(worker: Worker, verdict: DecodeVerdict, failure: DecodeFailure): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    this.restartCount += 1;
    this.failure = failure;
    void worker.terminate().catch(() => undefined);
    const job = this.pending;
    if (job !== undefined && job.worker === worker) this.settle(job, verdict);
  }
}
