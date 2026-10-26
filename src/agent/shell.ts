import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ToolError } from './workspace';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_BACKGROUND_BUFFER = 1_000_000;

export interface CommandResult { output: string; exitCode: number | null; timedOut: boolean; cwd: string }

interface BackgroundJob { process: ChildProcess; output: string; read: number; exitCode: number | null | undefined; command: string }

/**
 * A persistent shell for one agent run: `cd` and exported variables carry over between
 * commands, as in a terminal. Each command's stdin is /dev/null so it cannot consume the
 * session's own control lines; its exit status and working directory are read from a random
 * end marker. A timeout or cancellation kills the whole process group and starts a fresh shell.
 */
export class ShellSession {
  private process: ChildProcess | undefined;
  private pending = '';
  private queue: Promise<unknown> = Promise.resolve();
  private cwd: string;
  private readonly jobs = new Map<string, BackgroundJob>();

  public constructor(root: string, private readonly shellPath: string = findShell()) {
    this.cwd = root;
  }

  public run(command: string, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<CommandResult> {
    const result = this.queue.then(() => this.execute(command, Math.min(Math.max(timeoutMs, 1_000), MAX_TIMEOUT_MS), signal));
    this.queue = result.catch(() => undefined);
    return result;
  }

  public startBackground(command: string): string {
    const id = `bash_${randomBytes(4).toString('hex')}`;
    const child = spawn(this.shellPath, ['-c', command], { cwd: this.cwd, env: shellEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const job: BackgroundJob = { process: child, output: '', read: 0, exitCode: undefined, command };
    const append = (chunk: Buffer) => { job.output = (job.output + chunk.toString()).slice(-MAX_BACKGROUND_BUFFER); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('close', (code) => { job.exitCode = code; });
    child.on('error', (error) => { job.output += `\n${error.message}`; job.exitCode = null; });
    this.jobs.set(id, job);
    return id;
  }

  /** Output produced since the last read, and whether the job is still running. */
  public readBackground(id: string): { output: string; running: boolean; exitCode: number | null | undefined } {
    const job = this.jobs.get(id);
    if (!job) throw new ToolError(`No background shell with id ${id}.`);
    const output = job.output.slice(job.read);
    job.read = job.output.length;
    return { output: truncate(output), running: job.exitCode === undefined, exitCode: job.exitCode };
  }

  public kill(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.exitCode !== undefined) return false;
    killGroup(job.process);
    return true;
  }

  public dispose(): void {
    for (const job of this.jobs.values()) if (job.exitCode === undefined) killGroup(job.process);
    this.stopShell();
  }

  public get workingDirectory(): string { return this.cwd; }

  private async execute(command: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const shell = this.ensureShell();
    const marker = `__NEAR_AI_${randomBytes(8).toString('hex')}__`;
    this.pending = '';
    return new Promise<CommandResult>((resolve) => {
      let settled = false;
      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        shell.stdout?.off('data', onData);
        resolve(result);
      };
      const onData = (chunk: Buffer) => {
        this.pending += chunk.toString();
        const match = new RegExp(`\\n?${marker}:(\\d+):([^\\n]*)\\n`).exec(this.pending);
        if (!match) return;
        this.cwd = match[2] || this.cwd;
        finish({ output: truncate(this.pending.slice(0, match.index)), exitCode: Number(match[1]), timedOut: false, cwd: this.cwd });
      };
      const interrupt = (note: string) => {
        const output = this.pending;
        this.stopShell();
        finish({ output: truncate(`${output}\n${note}`), exitCode: null, timedOut: true, cwd: this.cwd });
      };
      const onAbort = () => interrupt('[Stopped by the user.]');
      const timer = setTimeout(() => interrupt(`[Command timed out after ${Math.round(timeoutMs / 1000)}s and was killed. The shell was restarted, so earlier cd and exported variables were reset.]`), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      shell.stdout?.on('data', onData);
      shell.stdin?.write(`{\n${command}\n} < /dev/null\nprintf '\\n${marker}:%d:%s\\n' "$?" "$PWD"\n`);
    });
  }

  private ensureShell(): ChildProcess {
    if (this.process && this.process.exitCode === null) return this.process;
    const args = /bash(\.exe)?$/.test(this.shellPath) ? ['--noprofile', '--norc'] : [];
    const child = spawn(this.shellPath, args, { cwd: this.cwd, env: shellEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr?.on('data', (chunk: Buffer) => { child.stdout?.emit('data', chunk); });
    child.on('error', () => undefined);
    child.stdin?.write('exec 2>&1\n');
    this.process = child;
    return child;
  }

  private stopShell(): void {
    if (this.process) killGroup(this.process);
    this.process = undefined;
  }
}

function shellEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', TERM: 'dumb', NO_COLOR: '1', CI: process.env.CI ?? '' };
}

function killGroup(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const half = MAX_OUTPUT_CHARS / 2;
  return `${output.slice(0, half)}\n\n[… ${output.length - MAX_OUTPUT_CHARS} characters omitted …]\n\n${output.slice(-half)}`;
}

function findShell(): string {
  if (process.platform === 'win32') {
    for (const candidate of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) if (existsSync(candidate)) return candidate;
    throw new ToolError('The Bash tool needs bash. Install Git for Windows (which includes Git Bash) and reload.');
  }
  return existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}
