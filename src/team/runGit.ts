// The one place the team core starts git. Arguments are an array (no shell), output is raw bytes, and every call has a timeout.
import { spawn } from 'node:child_process';
import { redactSecrets } from '../domain/redaction';

export interface GitResult { code: number; stdout: Buffer; stderr: string }
export interface GitOptions { cwd?: string; env?: Record<string, string>; input?: string | Buffer; timeoutMs?: number }
export type GitRunner = (args: string[], options?: GitOptions) => Promise<GitResult>;

const DEFAULT_TIMEOUT_MS = 60_000;
const TIMED_OUT_CODE = 124;

// Coordination commits never carry a member's name or email (D-04). Attribution lives in the signed event.
export const NEUTRAL_IDENTITY_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'SovAI Team',
  GIT_AUTHOR_EMAIL: 'coordination@near-ai.invalid',
  GIT_COMMITTER_NAME: 'SovAI Team',
  GIT_COMMITTER_EMAIL: 'coordination@near-ai.invalid'
};

export class GitNotFoundError extends Error {
  public constructor(message = 'git was not found on PATH') {
    super(message);
    this.name = 'GitNotFoundError';
  }
}

export class GitCommandError extends Error {
  public readonly code: number;
  public readonly stderr: string;
  public constructor(message: string, code: number, stderr: string) {
    super(message);
    this.name = 'GitCommandError';
    this.code = code;
    this.stderr = stderr;
  }
}

function killTree(pid: number | undefined, ownGroup: boolean, fallback: () => void): void {
  try {
    if (ownGroup && pid !== undefined) process.kill(-pid, 'SIGKILL');
    else fallback();
  } catch {
    try { fallback(); } catch { /* the process is already gone */ }
  }
}

export const runGit: GitRunner = (args, options = {}) => new Promise<GitResult>((resolve, reject) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GCM_INTERACTIVE: 'never', ...options.env };
  const hasInput = options.input !== undefined;
  // On POSIX git runs in its own process group so a timeout can stop its helpers (git-remote-https, ssh) as well as git itself.
  const ownGroup = process.platform !== 'win32';
  const child = spawn('git', args, { cwd: options.cwd, env, windowsHide: true, detached: ownGroup, stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let settled = false;
  const finish = (action: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    action();
  };
  const timer = setTimeout(() => {
    killTree(child.pid, ownGroup, () => child.kill('SIGKILL'));
    // Do not wait for 'close': a helper that survived the kill can hold the pipes open and 'close' would never fire.
    finish(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code: TIMED_OUT_CODE, stdout: Buffer.concat(out), stderr: `git timed out after ${timeoutMs} ms` });
    });
  }, timeoutMs);
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
  child.on('error', (error: NodeJS.ErrnoException) => {
    finish(() => reject(error.code === 'ENOENT' ? new GitNotFoundError() : error));
  });
  child.on('close', (code) => {
    finish(() => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }));
  });
  if (hasInput && child.stdin) {
    // A child that exits before reading its input reports EPIPE on stdin; keep the text with stderr, the exit code carries the outcome.
    child.stdin.on('error', (error: Error) => err.push(Buffer.from(`stdin: ${error.message}\n`)));
    child.stdin.end(options.input);
  }
});

export function gitText(result: GitResult): string {
  return result.stdout.toString('utf8').trim();
}

export function mustSucceed(result: GitResult, what: string): GitResult {
  if (result.code === 0) return result;
  const detail = redactGitMessage(result.stderr.trim() || `exit code ${result.code}`);
  throw new GitCommandError(`${what} failed: ${detail}`, result.code, redactGitMessage(result.stderr));
}

// Remote URLs can embed credentials (https://user:token@host). Strip userinfo, then apply the shared secret redaction.
export function redactGitMessage(message: string): string {
  return redactSecrets(message.replace(/(:\/\/)[^\s/@]*@/g, '$1'));
}
