// The one place project sync starts git (D-09). Arguments are an array (no shell), output is raw bytes, every call has a timeout and its own
// process group, hooks, signing, the ext transport and fsmonitor are switched off on every call, and the environment a person's shell may carry
// (GIT_DIR, GIT_WORK_TREE, GIT_CONFIG*, GIT_AUTHOR_*...) is removed before git starts, so no call can be redirected into the person's repository or
// pick up their identity. Shaped after the Team transport's runGit (unmerged branch, copied, never imported). No vscode import.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { redactSecrets } from '../domain/redaction';

/** `overflowed` is true when git wrote more than `maxStdoutBytes`: git was stopped and `stdout` holds only the first bytes, so it is incomplete. */
export interface GitResult { code: number; stdout: Buffer; stderr: string; overflowed?: boolean }
export interface GitOptions {
  cwd?: string;
  /** Applied after the inherited environment is cleaned, so a caller can set what it needs (the commit identity, a test's config file). */
  env?: Record<string, string>;
  input?: string | Buffer;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  /** An empty folder git is pointed at for hooks. Without one a private empty folder is made once per process. */
  hooksDir?: string;
}
export type GitRunner = (args: string[], options?: GitOptions) => Promise<GitResult>;

const DEFAULT_TIMEOUT_MS = 60_000;
export const TIMED_OUT_CODE = 124;
export const OUTPUT_LIMIT_CODE = 125;

/** Every sync commit is made by this one anonymous identity at one fixed time, so a commit says nothing about who or when (D-09). */
export const STATE_IDENTITY_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'near-ai-state',
  GIT_AUTHOR_EMAIL: 'state@near-ai.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'near-ai-state',
  GIT_COMMITTER_EMAIL: 'state@near-ai.invalid',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
};

export const STATE_COMMIT_MESSAGE = 'Update encrypted project state';

/** Variables removed from the inherited environment: each can point git at another repository, another index, or another identity. */
export const STRIPPED_ENV_NAMES: readonly string[] = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE'
];
export const STRIPPED_ENV_PREFIXES: readonly string[] = ['GIT_CONFIG', 'GIT_AUTHOR_', 'GIT_COMMITTER_'];

/** The `-c` pairs put in front of every call: no hooks, no signing (a signed push would name the person), no helper transports, no fsmonitor. */
export function SAFE_GIT_CONFIG(hooksDir: string): string[] {
  return [
    '-c', `core.hooksPath=${hooksDir}`,
    '-c', 'commit.gpgsign=false',
    '-c', 'push.gpgSign=false',
    '-c', 'protocol.ext.allow=never',
    '-c', 'core.fsmonitor=false'
  ];
}

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

/** Raised before git starts when a commit would be made without the anonymous identity. */
export class GitIdentityMissingError extends Error {
  public constructor() {
    super('A sync commit needs the anonymous identity environment, and it was not supplied.');
    this.name = 'GitIdentityMissingError';
  }
}

let defaultHooksDir: string | undefined;

/** A private, empty folder (random name, owner-only) that stands in when a caller gives no hooks folder. */
function emptyHooksDir(): string {
  defaultHooksDir ??= mkdtempSync(path.join(tmpdir(), 'near-ai-no-hooks-'));
  return defaultHooksDir;
}

function strippedEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (STRIPPED_ENV_NAMES.includes(name)) continue;
    if (STRIPPED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    clean[name] = value;
  }
  return clean;
}

function carriesIdentity(env: Record<string, string> | undefined): boolean {
  return env !== undefined && Object.entries(STATE_IDENTITY_ENV).every(([name, value]) => env[name] === value);
}

function killTree(pid: number | undefined, ownGroup: boolean, fallback: () => void): void {
  try {
    if (ownGroup && pid !== undefined) process.kill(-pid, 'SIGKILL');
    else fallback();
  } catch {
    try { fallback(); } catch { /* the process is already gone */ }
  }
}

export const runStateGit: GitRunner = (args, options = {}) => new Promise<GitResult>((resolve, reject) => {
  // A commit made without the override would record the person's own name and email, so it is never started (Pitfall 19).
  if (args.includes('commit-tree') && !carriesIdentity(options.env)) {
    reject(new GitIdentityMissingError());
    return;
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env: NodeJS.ProcessEnv = { ...strippedEnvironment(process.env), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GCM_INTERACTIVE: 'never', ...options.env };
  const fullArgs = [...SAFE_GIT_CONFIG(options.hooksDir ?? emptyHooksDir()), ...args];
  const hasInput = options.input !== undefined;
  // On POSIX git runs in its own process group so a timeout can stop its helpers (git-remote-https, ssh) as well as git itself.
  const ownGroup = process.platform !== 'win32';
  const child = spawn('git', fullArgs, { cwd: options.cwd, env, windowsHide: true, detached: ownGroup, stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
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
  // With maxStdoutBytes, git is stopped as soon as it writes more, so a huge answer is never held in memory.
  const maxOut = options.maxStdoutBytes;
  let outBytes = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    if (settled) return;
    if (maxOut !== undefined && outBytes + chunk.length > maxOut) {
      out.push(chunk.subarray(0, Math.max(0, maxOut - outBytes)));
      outBytes = maxOut;
      killTree(child.pid, ownGroup, () => child.kill('SIGKILL'));
      finish(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve({ code: OUTPUT_LIMIT_CODE, stdout: Buffer.concat(out), stderr: `git wrote more than ${maxOut} bytes and was stopped`, overflowed: true });
      });
      return;
    }
    outBytes += chunk.length;
    out.push(chunk);
  });
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
