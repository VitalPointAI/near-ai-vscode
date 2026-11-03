import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { SandboxTier } from '../domain/cyber';

// The offensive sandbox (D-08) and its two-way cleanup proof (D-10). Container tier: a per-run
// `docker run --rm -d --network none` container with a unique name, executed through fixed argv.
// Temp tier: a per-run temporary directory and an executable allowlist resolved from PATH.
// Disabled: a stated reason, never a silent downgrade. Every tier stops in a finally path.

export type ContainerRuntime = 'docker' | 'podman';

export type Runner = (command: string, args: string[]) => Promise<string>;

export const DEFAULT_SANDBOX_IMAGE = 'alpine:3.20';

const VERSION_TIMEOUT_MS = 3_000;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

export const runCapture: Runner = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) { reject(error); return; }
    resolve(`${stdout}${stderr}`.trim());
  });
});

/**
 * The same runner, for a command whose non-zero exit is a result rather than a failure. `docker exec`
 * returns the containerised command's own exit code as its process code, so `runCapture` would throw
 * on every failing payload and the sandbox could never report a failed exploit — it reported a crash.
 */
export const runCapturingExit: Runner = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (!error) { resolve(`0\n${stdout}${stderr}`); return; }
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') { resolve(`${code}\n${stdout}${stderr}`); return; }
    reject(error);
  });
});

/** docker first, then podman; undefined when neither answers. Nothing is installed. */
export async function detectRuntime(run: Runner = runCapture): Promise<ContainerRuntime | undefined> {
  for (const candidate of ['docker', 'podman'] as const) {
    try {
      const output = await run(candidate, ['--version']);
      if (output.trim()) return candidate;
    } catch { /* not installed, or not usable */ }
  }
  return undefined;
}

/** Which tier an engagement may use, and the reason when offensive mode is unavailable. */
export interface TierChoice { tier: SandboxTier; runtime?: ContainerRuntime; reason?: string }

/**
 * Container when a runtime answers, else the temp tier when it is permitted, else disabled with a
 * reason naming what is missing. A runtime that answered and then failed to start is NOT a reason
 * to fall back: startSandbox reports that failure and the run is disabled (the plan's prohibition).
 */
export async function chooseTier(options: { allowTempTier?: boolean; run?: Runner } , runtime?: ContainerRuntime): Promise<TierChoice> {
  const detected = runtime ?? await detectRuntime(options.run ?? runCapture);
  if (detected) return { tier: 'container', runtime: detected };
  if (options.allowTempTier ?? true) return { tier: 'tempFolder', reason: 'No container runtime (docker or podman) answered --version, so the temporary-folder tier is used: the payload runs on this machine with no container isolation or outbound-network filtering.' };
  return { tier: 'disabled', reason: 'No container runtime (docker or podman) answered --version, and the engagement does not permit the temporary-folder tier, so offensive mode is disabled.' };
}

export interface ExecResult { argv: string[]; exitCode: number; stdout: string; stderr: string }

export interface Sandbox {
  tier: SandboxTier;
  /** The container name or the temporary directory; empty for a disabled sandbox. */
  id: string;
  exec(argv: string[], signal?: AbortSignal): Promise<ExecResult>;
  /** Runs in a finally path; resolves once the container is gone or the directory is removed. */
  stop(): Promise<void>;
}

export interface SandboxOptions {
  image?: string;
  /** A local path mounted read-only at /target/ in the container; always matched with :ro. */
  mountTarget?: string;
  runner?: Runner;
  /** The temporary tier's executables, resolved from PATH at creation; defaults to a read-only set. */
  allowlist?: string[];
  execTimeoutMs?: number;
  /** The signal the stop path honours; an already-aborted signal starts nothing. */
  signal?: AbortSignal;
}

export class SandboxError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

const TEMP_ALLOWLIST = ['sh', 'cat', 'ls', 'whoami', 'hostname', 'id', 'uname', 'echo', 'printf', 'sleep'];

async function which(binary: string): Promise<string | undefined> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binary);
    const usable = await access(candidate, constants.X_OK).then(() => true).catch(() => false);
    if (usable) return candidate;
  }
  return undefined;
}

const CONTAINER_NAME = /^cyber-[0-9a-f]{8}$/;

function containerName(): string {
  return `cyber-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/** A disabled sandbox: every exec refuses with the reason, and stop is a no-op. */
function disabledSandbox(reason: string): Sandbox {
  return {
    tier: 'disabled',
    id: '',
    async exec() { throw new SandboxError(`Offensive mode is disabled: ${reason}`); },
    async stop() { /* nothing was started */ }
  };
}

/** Runs `fn`, and stops the sandbox whether it resolved or threw (research Pitfall 2). */
export async function withSandbox<T>(sandbox: Sandbox, fn: (sandbox: Sandbox) => Promise<T>): Promise<T> {
  try {
    return await fn(sandbox);
  } finally {
    await sandbox.stop();
  }
}

export async function startSandbox(tier: SandboxTier, options: SandboxOptions = {}): Promise<Sandbox> {
  if (tier === 'disabled') return disabledSandbox('the engagement selected the disabled tier.');
  if (options.signal?.aborted) throw new SandboxError('The stop control was engaged before the sandbox started.');
  return tier === 'container' ? startContainer(options) : startTempTier(options);
}

async function startContainer(options: SandboxOptions): Promise<Sandbox> {
  const run = options.runner ?? runCapture;
  const runtime = await detectRuntime(run);
  if (!runtime) throw new SandboxError('No container runtime (docker or podman) answered --version; the run is disabled rather than downgraded to the host.');
  const name = containerName();
  const image = options.image ?? DEFAULT_SANDBOX_IMAGE;
  const args = ['run', '--rm', '-d', '--name', name, '--network', 'none'];
  // `:ro` alone is not enough: a target directory created with mode 700 (mkdtemp's default) is
  // bind-mounted but not traversable by the container's user, so the payload sees an empty /target.
  // `:ro` keeps it read-only; the mount is given a readable identity via docker's own default user.
  if (options.mountTarget) args.push('-v', `${path.resolve(options.mountTarget)}:/target:ro`);
  args.push(image, 'sleep', 'infinity');
  // A runtime that answered and then failed is NOT a fallback: the caller gets the failure.
  await run(runtime, args);

  return {
    tier: 'container',
    id: name,
    async exec(argv, signal) {
      if (!argv.length) throw new SandboxError('An empty command was given to the sandbox.');
      if (signal?.aborted) throw new SandboxError('The stop control was engaged before the command started.');
      // Fixed argv, never a joined shell string: an argument with a space or a quote must survive.
      const started = await (options.runner ? run : runCapturingExit)(runtime, ['exec', name, ...argv]);
      if (signal?.aborted) throw new SandboxError('The stop control stopped the sandbox command.');
      const match = /^(\d+)\n([\s\S]*)$/.exec(started);
      return { argv, exitCode: match ? Number(match[1]) : 0, stdout: match ? match[2] : started, stderr: '' };
    },
    async stop() {
      try {
        // `docker rm -f <name>` runs with fixed argv (no shell), inside the try of the finally path.
        await run(runtime, ['rm', '-f', name]);
      } finally {
        const remaining = await run(runtime, ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}']).catch(() => '');
        if (remaining.split('\n').map((line) => line.trim()).includes(name)) throw new SandboxError(`Cleanup failed: container ${name} is still listed by ${runtime} ps -a.`);
      }
    }
  };
}

async function startTempTier(options: SandboxOptions): Promise<Sandbox> {
  const allowed = options.allowlist ?? TEMP_ALLOWLIST;
  const resolved = new Map<string, string>();
  for (const binary of allowed) {
    const found = await which(binary);
    if (found) resolved.set(binary, found);
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'cyber-'));
  const timeout = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  return {
    tier: 'tempFolder',
    id: directory,
    async exec(argv, signal) {
      if (!argv.length) throw new SandboxError('An empty command was given to the sandbox.');
      const binary = resolved.get(argv[0]);
      if (!binary) throw new SandboxError(`"${argv[0]}" is not on this run's temporary-tier allowlist (${[...resolved.keys()].join(', ')}).`);
      if (signal?.aborted) throw new SandboxError('The stop control was engaged before the command started.');
      return new Promise<ExecResult>((resolve, reject) => {
        execFile(binary, argv.slice(1), { cwd: directory, timeout, windowsHide: true, signal, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          const exitCode = error ? Number((error as { code?: unknown }).code ?? 1) || 1 : 0;
          if (error && (error as { killed?: boolean }).killed) { reject(new SandboxError(`The command was stopped after ${timeout} ms.`)); return; }
          if (error && typeof (error as { code?: unknown }).code !== 'number') { reject(error); return; }
          resolve({ argv, exitCode, stdout, stderr });
        });
      });
    },
    async stop() {
      try {
        await rm(directory, { recursive: true, force: true });
      } finally {
        const removed = await stat(directory).then(() => false).catch(() => true);
        if (!removed) throw new SandboxError(`Cleanup failed: the temporary sandbox ${directory} still exists.`);
      }
    }
  };
}

/** D-10's second half: what a step recorded as written must be gone after the run. */
export async function verifyCleanup(recorded: { filesDropped: string[]; credentialsCreated: string[] }, sandbox: Sandbox): Promise<string[]> {
  const problems: string[] = [];
  for (const file of [...recorded.filesDropped, ...recorded.credentialsCreated]) {
    if (sandbox.tier === 'tempFolder') {
      const present = await stat(path.join(sandbox.id, file)).then(() => true).catch(() => false);
      if (present) problems.push(`${file} was recorded as written and is still in ${sandbox.id}.`);
      continue;
    }
    // A recorded path that exists on the host means the payload escaped the container (T-25-14).
    const leaked = await stat(path.resolve(file)).then(() => true).catch(() => false);
    if (leaked) problems.push(`${path.resolve(file)} was recorded as written inside the container but exists on the host.`);
  }
  return problems;
}
