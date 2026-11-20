import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { finishStartup } from '../src/startup';
import { BIN, launchHub, startHubProcess, within, type Exit } from './helpers/hubProcess';
import { makeTlsFixture } from './helpers/tlsFixture';

// Phase 32, plan 14 (D-26, D-28), ported from relay/test/startup.test.ts: the built hub starts through its guard, passes its own healthcheck, refuses
// bad arguments and a taken port, and stops cleanly on SIGTERM even when the signal arrives the moment hub.listening is logged. Everything it prints
// is one JSON line through the redacting logger on stdout; stderr stays empty.

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test('--healthcheck exits 0 against a running hub and prints nothing', async () => {
  const hub = await startHubProcess();
  try {
    const check = launchHub({ args: ['--healthcheck'], env: { HUB_PORT: String(hub.port) } });
    try {
      const exit = await within(check.exited, 10_000, 'the healthcheck');
      assert.equal(exit.code, 0, check.stdout());
      assert.equal(check.stdout(), '');
      assert.equal(check.stderr(), '');
    } finally {
      check.cleanup();
    }
  } finally {
    await hub.kill('SIGTERM');
    hub.cleanup();
  }
});

test('--healthcheck exits 1 when nothing answers and logs hub.healthcheck_failed', async () => {
  const port = await freePort();
  const check = launchHub({ args: ['--healthcheck'], env: { HUB_PORT: String(port) } });
  try {
    const exit = await within(check.exited, 10_000, 'the healthcheck');
    assert.equal(exit.code, 1);
    const lines = check.logs();
    assert.deepEqual(lines.map((line) => line.event), ['hub.healthcheck_failed']);
    assert.equal(lines[0]?.level, 'error');
    assert.equal(typeof lines[0]?.error, 'string');
    assert.equal(check.stderr(), '');
  } finally {
    check.cleanup();
  }
});

test('an unknown argument stops startup with exit 1 and hub.start_refused without echoing it', async () => {
  const run = launchHub({ args: ['--serve-secret-xyz'] });
  try {
    const exit = await within(run.exited, 10_000, 'the hub refusing an unknown argument');
    assert.equal(exit.code, 1);
    const lines = run.logs();
    assert.deepEqual(lines.map((line) => line.event), ['hub.start_refused']);
    assert.equal(lines[0]?.reason, 'config');
    assert.ok(!run.stdout().includes('serve-secret'), 'the argument was echoed into the log');
  } finally {
    run.cleanup();
  }
});

test('a port that is already taken stops startup with exit 1 and hub.start_refused with reason listen', async () => {
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = holder.address() as net.AddressInfo;
    const run = launchHub({ env: { HUB_PORT: String(port) } });
    try {
      const exit = await within(run.exited, 10_000, 'the hub failing to listen');
      assert.equal(exit.code, 1);
      const lines = run.logs();
      assert.deepEqual(lines.map((line) => line.event), ['secrets.loaded', 'hub.start_refused']);
      assert.equal(lines[1]?.reason, 'listen');
      assert.match(String(lines[1]?.detail), /EADDRINUSE/);
      assert.equal(run.stderr(), '');
    } finally {
      run.cleanup();
    }
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
});

test('a TLS certificate and key that do not belong together stop startup with reason tls and a plain sentence', async () => {
  const other = makeTlsFixture();
  const run = launchHub({ secrets: { HUB_TLS_KEY: other.keyPem } });
  try {
    const exit = await within(run.exited, 10_000, 'the hub refusing a mismatched TLS pair');
    assert.equal(exit.code, 1);
    const lines = run.logs();
    assert.deepEqual(lines.map((line) => line.event), ['secrets.loaded', 'hub.start_refused']);
    assert.equal(lines[1]?.reason, 'tls');
    assert.match(String(lines[1]?.detail), /HUB_TLS_CERT and HUB_TLS_KEY do not belong together/);
    assert.ok(!run.stdout().includes('-----BEGIN '), 'PEM text reached the log');
  } finally {
    run.cleanup();
    other.cleanup();
  }
});

test('a damaged hub key line stops startup with reason keys, naming the setting and never the key', async () => {
  const run = launchHub({ secrets: { HUB_SIGNING_KEY: 'near-ai-hub-signing-key:v1:fake-truncated-seed\n' } });
  try {
    const exit = await within(run.exited, 10_000, 'the hub refusing a damaged key');
    assert.equal(exit.code, 1);
    const lines = run.logs();
    assert.deepEqual(lines.map((line) => line.event), ['secrets.loaded', 'hub.start_refused']);
    assert.equal(lines[1]?.reason, 'keys');
    assert.match(String(lines[1]?.detail), /HUB_SIGNING_KEY is damaged/);
    assert.ok(!run.stdout().includes('fake-truncated-seed'), 'the key text reached the log');
  } finally {
    run.cleanup();
  }
});

test('a missing or damaged app.mjs prints one fixed sentence on stderr, no path or stack, and exits 1', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-hub-noapp-'));
  try {
    const bin = path.join(dir, 'bin.mjs');
    await copyFile(BIN(), bin);
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
      assert.equal(run.stderr, 'near-ai-hub could not load its code; reinstall it.\n', `${situation}: ${run.stderr}`);
      assert.ok(!run.stderr.includes(dir), `${situation}: the sentence names no path`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Regression carried over from the relay (its PR #54): the listening line was logged before the SIGTERM handler existed, so a supervisor that
// stopped the service as soon as it saw that line could hit the default kill instead of a clean stop. main.ts finishes startup through
// finishStartup; these tests call it in order, and the last test checks the order on real runs.
test('finishStartup reads first, then registers the SIGTERM and SIGINT handlers, then announces', async () => {
  const signals = new EventEmitter();
  const steps: string[] = [];
  const stopped: string[] = [];
  let release: (id: string) => void = () => undefined;
  const finished = finishStartup({
    read: () => {
      steps.push('read');
      return new Promise<string>((resolve) => { release = resolve; });
    },
    signals,
    stop: (signal) => stopped.push(signal),
    announce: (id) => {
      steps.push(`announce ${id}`);
      assert.equal(signals.listenerCount('SIGTERM'), 1);
      assert.equal(signals.listenerCount('SIGINT'), 1);
      signals.emit('SIGTERM');
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, ['read'], 'nothing more happens while the read is in flight');
  assert.equal(signals.listenerCount('SIGTERM'), 0, 'no stop can run while startup is still reading');
  release('writer-1');
  assert.equal(await finished, 'writer-1');
  assert.deepEqual(steps, ['read', 'announce writer-1']);
  assert.deepEqual(stopped, ['SIGTERM']);
  signals.emit('SIGINT');
  assert.deepEqual(stopped, ['SIGTERM', 'SIGINT']);
});

test('finishStartup registers no handlers and announces nothing when the read fails', async () => {
  const signals = new EventEmitter();
  let announced = false;
  await assert.rejects(
    finishStartup({ read: () => Promise.reject(new Error('read failed')), signals, stop: () => undefined, announce: () => { announced = true; } }),
    /read failed/,
  );
  assert.equal(announced, false);
  assert.equal(signals.listenerCount('SIGTERM') + signals.listenerCount('SIGINT'), 0);
});

test('SIGTERM sent the moment hub.listening appears always stops the hub cleanly with exit 0 (20 runs)', async () => {
  const once = async (): Promise<void> => {
    const run = launchHub();
    try {
      let sent = false;
      run.child.stdout?.on('data', () => {
        if (!sent && run.stdout().includes('"event":"hub.listening"')) {
          sent = true;
          run.child.kill('SIGTERM');
        }
      });
      let exit: Exit;
      try {
        exit = await within(run.exited, 15_000, 'the hub stopping on SIGTERM sent at hub.listening');
      } catch (error) {
        run.child.kill('SIGKILL');
        throw error;
      }
      assert.ok(sent, `hub.listening was never logged; stdout was: ${run.stdout()}`);
      assert.deepEqual(exit, { code: 0, signal: null }, `stdout was: ${run.stdout()}`);
      const events = run.events();
      assert.ok(events.indexOf('hub.stopped') > events.indexOf('hub.stopping'), 'hub.stopping then hub.stopped');
      assert.equal(run.stderr(), '', 'the hub wrote to stderr');
    } finally {
      run.cleanup();
    }
  };
  // Four at a time keeps the 20 runs quick without starting 20 processes at once.
  for (let batch = 0; batch < 5; batch += 1) await Promise.all([once(), once(), once(), once()]);
});
