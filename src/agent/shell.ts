import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ToolError } from './workspace';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_BACKGROUND_BUFFER = 1_000_000;

export interface CommandResult { output: string; exitCode: number | null; timedOut: boolean; cwd: string }

interface BackgroundJob { process: ChildProcess; output: string; read: number; exitCode: number | null | undefined; command: string }

/**
 * A persistent shell for one agent run: `cd` and exported variables carry over between
 * commands, as in a terminal. Each command is written to a private file and sourced with stdin
 * from /dev/null, so neither its input nor an unterminated heredoc or quote can consume the
 * session's own control lines; its exit status and working directory are read from a random
 * end marker. A timeout or cancellation kills the whole process group and starts a fresh shell.
 */
export class ShellSession {
  private process: ChildProcess | undefined;
  private pending = '';
  private queue: Promise<unknown> = Promise.resolve();
  private cwd: string;
  private readonly jobs = new Map<string, BackgroundJob>();
  private scripts: string | undefined;

  public constructor(root: string, private readonly shellPath: string = findShell(), private readonly extraEnv: NodeJS.ProcessEnv = {}, private readonly allowEnv: string[] = []) {
    this.cwd = root;
  }

  public run(command: string, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<CommandResult> {
    const result = this.queue.then(() => this.execute(command, Math.min(Math.max(timeoutMs, 1_000), MAX_TIMEOUT_MS), signal));
    this.queue = result.catch(() => undefined);
    return result;
  }

  public startBackground(command: string): string {
    const id = `bash_${randomBytes(4).toString('hex')}`;
    const child = spawn(this.shellPath, ['-c', command], { cwd: this.cwd, env: shellEnv(this.extraEnv, this.allowEnv), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (this.scripts) rmSync(this.scripts, { recursive: true, force: true });
    this.scripts = undefined;
  }

  public get workingDirectory(): string { return this.cwd; }
  /** The environment the shell starts with (later `export`s in the session are not reflected). */
  public get environment(): NodeJS.ProcessEnv { return shellEnv(this.extraEnv, this.allowEnv); }

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
      this.scripts ??= mkdtempSync(path.join(tmpdir(), 'near-ai-shell-'));
      const script = path.join(this.scripts, `${marker}.sh`);
      writeFileSync(script, `${command}\n`, { mode: 0o600 });
      const quoted = `'${script.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
      shell.stdin?.write(`{ . ${quoted}; } < /dev/null; __near_status=$?; rm -f ${quoted}; printf '\\n${marker}:%d:%s\\n' "$__near_status" "$PWD"\n`);
    });
  }

  private ensureShell(): ChildProcess {
    if (this.process && this.process.exitCode === null) return this.process;
    const args = /bash(\.exe)?$/.test(this.shellPath) ? ['--noprofile', '--norc'] : [];
    const child = spawn(this.shellPath, args, { cwd: this.cwd, env: shellEnv(this.extraEnv, this.allowEnv), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
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

/** Variable names that usually hold credentials. */
const SECRET_NAME = /(?:^|_)(?:TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH|COOKIE|SESSION_?KEY)(?:_|$)|_PAT$|^AWS_(?:SECRET|SESSION)|^(?:DATABASE|REDIS|MONGO(?:DB)?)_URL$|_DSN$|CONNECTION_?STRING/i;
/** Values shaped like well-known credentials, whatever the variable is called. */
const SECRET_VALUE = /^(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|glpat-|AKIA[A-Z0-9]{16}|xox[baprs]-|eyJ[A-Za-z0-9_-]{10,}\.eyJ)/;

/** Whether a variable is kept out of commands the agent runs (unless allowed by name). */
/** The same words run together in camelCase or lowercase, e.g. npm_config__authToken or apiKey. */
const SECRET_JOINED = /(?:auth|access|refresh|bearer|api|client|private|session|secret)_?(?:token|key|secret)|password|passwd|passphrase/i;

export function isSecretVariable(name: string, value: string | undefined): boolean {
  return SECRET_NAME.test(name) || SECRET_JOINED.test(name) || SECRET_VALUE.test(value ?? '');
}

/**
 * The agent's shell environment: the editor's, minus anything that looks like a credential (by
 * name or value), since commands such as `env` would send it to the model. `allow` names
 * variables to pass anyway (nearAi.agent.shellEnvAllow); `extra` (set by the extension) is kept.
 */
function shellEnv(extra: NodeJS.ProcessEnv, allow: string[] = []): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (allow.includes(name) || !isSecretVariable(name, value)) base[name] = value;
  Object.assign(base, { PAGER: 'cat', GIT_PAGER: 'cat', TERM: 'dumb', NO_COLOR: '1', CI: process.env.CI ?? '' });
  // Electron's own flag must not leak into commands the agent runs, nor a parent test runner's
  // context: with NODE_TEST_CONTEXT set, a failing `node --test` exits 0 and the agent sees a pass.
  delete base.ELECTRON_RUN_AS_NODE;
  delete base.NODE_TEST_CONTEXT;
  return { ...base, ...extra };
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
