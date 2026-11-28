// Docker helpers for the workbench container suite, with the hub suite's hygiene (hub/test/container/container.test.ts):
// one random suffix per run; every object the suite makes is named with it, and removeOwn() removes exactly those. A prebuilt image given in
// WORKBENCH_TEST_IMAGE is used as is and never removed. With no Docker the suite fails with a plain sentence; it never skips.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The suite's random suffix: every image tag, container and network it makes carries it. */
export const suffix = randomBytes(4).toString('hex');
/** workbench/ (this file is bundled to workbench/dist/test/helpers/docker.js). */
export const workbenchRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
export const repoRoot = path.dirname(workbenchRoot);
/** The default memory limit of every container the suite starts. */
export const CONTAINER_MEMORY = '3g';

const ownContainers = new Set<string>();
let ownImage: string | undefined;
let image: Promise<string> | undefined;

export function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? repoRoot, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal, killSignal: options.signal ? 'SIGKILL' : 'SIGTERM' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input ?? '');
  });
}

export async function mustRun(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Result> {
  const result = await run(command, args, options);
  assert.equal(result.code, 0, `${command} ${args.join(' ')} exited ${result.code}\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`);
  return result;
}

export async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function requireDocker(): Promise<void> {
  const result = await run('docker', ['info', '--format', '{{.ServerVersion}}']).catch(() => undefined);
  assert.ok(result?.code === 0, 'The workbench container suite needs Docker with BuildKit: install or start Docker and run it again.');
}

/** The image under test: WORKBENCH_TEST_IMAGE when set, otherwise sterling-workbench:test-<suffix>, built once from the repository root. */
export function testImage(): Promise<string> {
  image ??= (async () => {
    await requireDocker();
    const given = process.env.WORKBENCH_TEST_IMAGE?.trim();
    if (given) {
      await mustRun('docker', ['image', 'inspect', given]);
      return given;
    }
    const tag = `sterling-workbench:test-${suffix}`;
    ownImage = tag;
    await mustRun('docker', ['build', '-f', path.join('workbench', 'Dockerfile'), '-t', tag, '.']);
    return tag;
  })();
  return image;
}

/** `docker run` with a suite-owned name and the default memory limit unless the caller passes its own `--memory`. Returns the result. */
export async function runContainer(name: string, args: string[]): Promise<Result> {
  const full = `sterling-workbench-test-${suffix}-${name}`;
  ownContainers.add(full);
  const memory = args.some((arg) => arg === '--memory' || arg.startsWith('--memory=')) ? [] : [`--memory=${CONTAINER_MEMORY}`];
  return run('docker', ['run', '--name', full, ...memory, ...args]);
}

/** The suite-owned container name for `name`. */
export const containerName = (name: string): string => `sterling-workbench-test-${suffix}-${name}`;

/** Waits until the container reports healthy through /healthz on the published address, or fails with its logs. */
export async function waitHealthy(name: string, url: string, timeoutMs = 120_000, failureMessage?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/healthz', url), { signal: AbortSignal.timeout(3000) });
      if (response.status === 200 && (await response.text()) === 'ok') return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (failureMessage !== undefined) assert.fail(failureMessage());
  const logs = await run('docker', ['logs', containerName(name)]);
  assert.fail(`The workbench did not answer /healthz within ${timeoutMs / 1000} s.\n${logs.stdout.slice(-4000)}\n${logs.stderr.slice(-4000)}`);
}

/** Runs one Playwright spec against the started workbench (WORKBENCH_URL), from workbench/; `args` adds options such as `--grep`. */
export function runPlaywright(spec: string, env: NodeJS.ProcessEnv, args: string[] = []): Promise<Result> {
  return run('npx', ['playwright', 'test', '-c', 'test/e2e/playwright.config.ts', spec, ...args], { cwd: workbenchRoot, env: { ...process.env, ...env } });
}

/** Removes the containers this suite started and the image it built; never anything else. */
export async function removeOwn(): Promise<void> {
  for (const name of ownContainers) await run('docker', ['rm', '-f', name]);
  ownContainers.clear();
  if (ownImage) await run('docker', ['image', 'rm', '-f', ownImage]);
}
