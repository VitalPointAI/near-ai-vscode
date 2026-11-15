import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Phase 68, plan 01 (RELAY-01, RELAY-02): the built relay starts through its guard, answers GET /healthz, passes its own healthcheck, stops on
// SIGTERM and prints nothing, because no output path may exist before the redacting logger (D-11, plan 02).

const BIN = fileURLToPath(new URL('../bin.mjs', import.meta.url));
const PACKAGE = new URL('../../package.json', import.meta.url);

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Launched {
  child: ChildProcess;
  output: () => string;
  exited: Promise<Exit>;
}

interface Relay extends Launched {
  port: number;
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function cleanEnv(settings: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ...settings };
}

function launch(args: string[], settings: Record<string, string>): Launched {
  const child = spawn(process.execPath, [BIN, ...args], { env: cleanEnv(settings), stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout?.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  const exited = new Promise<Exit>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, output: () => text, exited };
}

async function withTempState<T>(body: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'near-ai-relay-startup-'));
  try {
    return await body(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function startRelay(stateDir: string): Promise<Relay> {
  const port = await freePort();
  const relay: Relay = { ...launch([], { RELAY_HOST: '127.0.0.1', RELAY_PORT: String(port), RELAY_STATE_DIR: stateDir }), port };
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      await response.arrayBuffer();
      if (response.status === 200) return relay;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      relay.child.kill('SIGKILL');
      assert.fail('the relay did not answer /healthz within 5 seconds');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test('tracer: GET /healthz answers exactly the five fields, SIGTERM stops the relay with exit 0, and nothing is printed', async () => {
  await withTempState(async (stateDir) => {
    const relay = await startRelay(stateDir);
    try {
      const response = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = (await response.json()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ['inFlightRuns', 'signal', 'teams', 'uptimeSeconds', 'version']);
      assert.equal(body.teams, 'not-configured');
      assert.equal(body.signal, 'not-configured');
      assert.equal(body.inFlightRuns, 0);
      assert.equal(typeof body.uptimeSeconds, 'number');
      const manifest = JSON.parse(await readFile(PACKAGE, 'utf8')) as { version: string };
      assert.equal(body.version, manifest.version);
    } finally {
      relay.child.kill('SIGTERM');
    }
    const exit = await within(relay.exited, 5000, 'the relay shutting down on SIGTERM');
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(relay.output(), '', 'the relay printed something before the redacting logger exists');
  });
});

test('--healthcheck exits 0 against a running relay', async () => {
  await withTempState(async (stateDir) => {
    const relay = await startRelay(stateDir);
    try {
      const check = launch(['--healthcheck'], { RELAY_HOST: '127.0.0.1', RELAY_PORT: String(relay.port), RELAY_STATE_DIR: stateDir });
      const exit = await within(check.exited, 5000, 'the healthcheck');
      assert.equal(exit.code, 0);
      assert.equal(check.output(), '');
    } finally {
      relay.child.kill('SIGTERM');
      await relay.exited;
    }
  });
});

test('--healthcheck exits 1 when nothing answers', async () => {
  const port = await freePort();
  const check = launch(['--healthcheck'], { RELAY_HOST: '127.0.0.1', RELAY_PORT: String(port) });
  const exit = await within(check.exited, 5000, 'the healthcheck');
  assert.equal(exit.code, 1);
  assert.equal(check.output(), '');
});

test('a malformed RELAY_PORT stops startup with exit 1 and no output', async () => {
  const run = launch([], { RELAY_PORT: 'abc' });
  const exit = await within(run.exited, 5000, 'the relay refusing RELAY_PORT=abc');
  assert.equal(exit.code, 1);
  assert.equal(run.output(), '');
});

test('an unknown RELAY_ variable stops startup with exit 1 and no output', async () => {
  const run = launch([], { RELAY_COLOR: 'blue' });
  const exit = await within(run.exited, 5000, 'the relay refusing RELAY_COLOR');
  assert.equal(exit.code, 1);
  assert.equal(run.output(), '');
});

test('an unknown path answers 404 without echoing it, and another method on /healthz answers 405', async () => {
  await withTempState(async (stateDir) => {
    const relay = await startRelay(stateDir);
    try {
      const missing = await fetch(`http://127.0.0.1:${relay.port}/tenant-acme-secret?x=1`);
      assert.equal(missing.status, 404);
      const text = await missing.text();
      assert.equal(text, '{"error":"not-found"}');
      assert.ok(!text.includes('acme'));
      const post = await fetch(`http://127.0.0.1:${relay.port}/healthz`, { method: 'POST', body: 'x' });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get('allow'), 'GET');
      await post.arrayBuffer();
    } finally {
      relay.child.kill('SIGTERM');
      await relay.exited;
    }
    assert.equal(relay.output(), '');
  });
});
