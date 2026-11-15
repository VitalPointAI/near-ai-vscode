import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Phase 68, plans 01 and 02 (RELAY-01, RELAY-02, RELAY-04): the built relay starts through its guard, answers GET /healthz, passes its own
// healthcheck and stops on SIGTERM. Everything it prints is one JSON line through the redacting logger on stdout (D-11); stderr stays empty.

const BIN = fileURLToPath(new URL('../bin.mjs', import.meta.url));
const PACKAGE = new URL('../../package.json', import.meta.url);

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Launched {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
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
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString(); });
  const exited = new Promise<Exit>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  return { child, stdout: () => out, stderr: () => err, exited };
}

type LogLine = Record<string, unknown> & { time: string; level: string; event: string };

/** Every complete stdout line, parsed. A line that is not a JSON object with time, level and event fails the test. */
function logLines(launched: Launched): LogLine[] {
  const lines = launched.stdout().split('\n');
  lines.pop(); // the text after the last newline is a line still being written, or empty
  return lines.map((line) => {
    const parsed = JSON.parse(line) as LogLine;
    assert.equal(typeof parsed, 'object');
    assert.equal(typeof parsed.time, 'string', `no time in ${line}`);
    assert.ok(!Number.isNaN(Date.parse(parsed.time)), `time is not a date in ${line}`);
    assert.ok(['info', 'warn', 'error'].includes(parsed.level), `bad level in ${line}`);
    assert.equal(typeof parsed.event, 'string', `no event in ${line}`);
    return parsed;
  });
}

function eventsOf(launched: Launched): string[] {
  return logLines(launched).map((line) => line.event);
}

async function waitForEvent(launched: Launched, event: string, ms: number): Promise<LogLine> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = logLines(launched).find((line) => line.event === event);
    if (found) return found;
    if (Date.now() > deadline) assert.fail(`no ${event} line within ${ms} ms; stdout was: ${launched.stdout()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
  const launched = launch([], { RELAY_HOST: '127.0.0.1', RELAY_PORT: '0', RELAY_STATE_DIR: stateDir });
  try {
    const listening = await waitForEvent(launched, 'relay.listening', 5000);
    assert.equal(typeof listening.port, 'number');
    assert.ok((listening.port as number) > 0, 'relay.listening must carry the bound port, not 0');
    return { ...launched, port: listening.port as number };
  } catch (error) {
    launched.child.kill('SIGKILL');
    throw error;
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

test('tracer: the relay logs relay.listening, answers /healthz, logs a rejected path without echoing it, and SIGTERM stops it with exit 0', async () => {
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

      const listening = logLines(relay).find((line) => line.event === 'relay.listening');
      assert.ok(listening, 'no relay.listening line');
      assert.equal(listening.level, 'info');
      assert.equal(listening.host, '127.0.0.1');
      assert.equal(listening.port, relay.port);
      assert.equal(listening.version, manifest.version);

      const missing = await fetch(`http://127.0.0.1:${relay.port}/nope`);
      assert.equal(missing.status, 404);
      await missing.arrayBuffer();
      const rejected = await waitForEvent(relay, 'http.rejected', 5000);
      assert.equal(rejected.level, 'warn');
      assert.equal(rejected.route, 'unknown');
      assert.equal(rejected.method, 'GET');
      assert.equal(rejected.status, 404);
      assert.ok(!JSON.stringify(rejected).includes('nope'), 'the rejected path was echoed into the log');
    } finally {
      relay.child.kill('SIGTERM');
    }
    const exit = await within(relay.exited, 5000, 'the relay shutting down on SIGTERM');
    assert.deepEqual(exit, { code: 0, signal: null });
    const events = eventsOf(relay);
    assert.ok(events.indexOf('relay.stopping') >= 0, 'no relay.stopping line');
    assert.ok(events.indexOf('relay.stopped') > events.indexOf('relay.stopping'), 'relay.stopped must follow relay.stopping');
    assert.ok(!events.includes('relay.crashed'));
    assert.equal(relay.stderr(), '', 'the relay wrote to stderr');
  });
});

test('--healthcheck exits 0 against a running relay and prints nothing', async () => {
  await withTempState(async (stateDir) => {
    const relay = await startRelay(stateDir);
    try {
      const check = launch(['--healthcheck'], { RELAY_HOST: '127.0.0.1', RELAY_PORT: String(relay.port), RELAY_STATE_DIR: stateDir });
      const exit = await within(check.exited, 5000, 'the healthcheck');
      assert.equal(exit.code, 0);
      assert.equal(check.stdout(), '');
      assert.equal(check.stderr(), '');
    } finally {
      relay.child.kill('SIGTERM');
      await relay.exited;
    }
  });
});

test('--healthcheck exits 1 when nothing answers and logs relay.healthcheck_failed', async () => {
  const port = await freePort();
  const check = launch(['--healthcheck'], { RELAY_HOST: '127.0.0.1', RELAY_PORT: String(port) });
  const exit = await within(check.exited, 5000, 'the healthcheck');
  assert.equal(exit.code, 1);
  const lines = logLines(check);
  assert.deepEqual(lines.map((line) => line.event), ['relay.healthcheck_failed']);
  assert.equal(lines[0]?.level, 'error');
  assert.equal(typeof lines[0]?.error, 'string');
  assert.equal(check.stderr(), '');
});

test('a malformed RELAY_PORT stops startup with exit 1 and relay.start_refused naming the setting, not its value', async () => {
  const run = launch([], { RELAY_PORT: 'abc' });
  const exit = await within(run.exited, 5000, 'the relay refusing RELAY_PORT=abc');
  assert.equal(exit.code, 1);
  const lines = logLines(run);
  assert.deepEqual(lines.map((line) => line.event), ['relay.start_refused']);
  assert.equal(lines[0]?.reason, 'config');
  assert.match(String(lines[0]?.detail), /RELAY_PORT/);
  assert.ok(!run.stdout().includes('abc'), 'the refused value was echoed into the log');
  assert.equal(run.stderr(), '');
});

test('an unknown RELAY_ variable stops startup with exit 1 and relay.start_refused naming it, not its value', async () => {
  const run = launch([], { RELAY_COLOR: 'blue' });
  const exit = await within(run.exited, 5000, 'the relay refusing RELAY_COLOR');
  assert.equal(exit.code, 1);
  const lines = logLines(run);
  assert.deepEqual(lines.map((line) => line.event), ['relay.start_refused']);
  assert.equal(lines[0]?.reason, 'config');
  assert.match(String(lines[0]?.detail), /RELAY_COLOR/);
  assert.ok(!run.stdout().includes('blue'), 'the refused value was echoed into the log');
  assert.equal(run.stderr(), '');
});

test('an unknown argument stops startup with exit 1 and relay.start_refused without echoing it', async () => {
  const run = launch(['--serve-secret-xyz'], {});
  const exit = await within(run.exited, 5000, 'the relay refusing an unknown argument');
  assert.equal(exit.code, 1);
  const lines = logLines(run);
  assert.deepEqual(lines.map((line) => line.event), ['relay.start_refused']);
  assert.equal(lines[0]?.reason, 'config');
  assert.ok(!run.stdout().includes('serve-secret'), 'the argument was echoed into the log');
});

test('a port that is already taken stops startup with exit 1 and relay.start_refused with reason listen', async () => {
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = holder.address() as net.AddressInfo;
    // The relay opens its state before it listens, so it gets a temporary state directory, never the development default relay/state.
    await withTempState(async (stateDir) => {
      const run = launch([], { RELAY_HOST: '127.0.0.1', RELAY_PORT: String(port), RELAY_STATE_DIR: stateDir });
      const exit = await within(run.exited, 5000, 'the relay failing to listen');
      assert.equal(exit.code, 1);
      const lines = logLines(run);
      // secrets.loaded and log.pseudonym_key (plan 06) come before the server tries to listen.
      assert.deepEqual(lines.map((line) => line.event), ['secrets.loaded', 'log.pseudonym_key', 'relay.start_refused']);
      assert.equal(lines[2]?.reason, 'listen');
      assert.match(String(lines[2]?.detail), /EADDRINUSE/);
      assert.equal(run.stderr(), '');
    });
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
});

test('an unknown path answers 404 without echoing it, and another method on /healthz answers 405, both logged without the path', async () => {
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
      const deadline = Date.now() + 5000;
      while (logLines(relay).filter((line) => line.event === 'http.rejected').length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      relay.child.kill('SIGTERM');
      await relay.exited;
    }
    const rejected = logLines(relay).filter((line) => line.event === 'http.rejected');
    assert.deepEqual(rejected.map((line) => [line.route, line.method, line.status]), [['unknown', 'GET', 404], ['healthz', 'POST', 405]]);
    assert.ok(!relay.stdout().includes('acme'), 'the request path was echoed into the log');
    assert.equal(relay.stderr(), '');
  });
});

test('a missing or damaged app.mjs prints one fixed sentence on stderr, no path or stack, and exits 1', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-relay-noapp-'));
  try {
    const bin = path.join(dir, 'bin.mjs');
    await copyFile(BIN, bin);
    const runGuard = (): Promise<{ code: number | null; stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [bin], { env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });
    for (const situation of ['missing', 'damaged'] as const) {
      if (situation === 'damaged') await writeFile(path.join(dir, 'app.mjs'), 'export async function main( {\n');
      const run = await runGuard();
      assert.equal(run.code, 1, situation);
      assert.equal(run.stdout, '', situation);
      assert.equal(run.stderr, 'near-ai-relay could not load its code; reinstall it.\n', `${situation}: ${run.stderr}`);
      assert.ok(!run.stderr.includes(dir), `${situation}: the sentence names no path`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Regression: relay.listening was logged before the SIGTERM handler existed, so a supervisor (or a
// test) that stopped the relay as soon as it saw that line could hit the default kill instead of a
// clean stop (seen in CI on PR #54). The timing window is too small to hit reliably here, so the
// order is pinned in the source.
test('the relay registers its SIGTERM and SIGINT handlers before it logs relay.listening', async () => {
  const source = await readFile(fileURLToPath(new URL('../../src/main.ts', import.meta.url)), 'utf8');
  const listening = source.indexOf("logger.info('relay.listening'");
  const sigterm = source.indexOf("process.on('SIGTERM'");
  const sigint = source.indexOf("process.on('SIGINT'");
  assert.ok(listening > 0 && sigterm > 0 && sigint > 0, 'main.ts logs relay.listening and handles SIGTERM and SIGINT');
  assert.ok(sigterm < listening && sigint < listening, 'both handlers are registered before relay.listening is logged');
});
