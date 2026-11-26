import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { makeTlsFixture } from '../../hub/test/helpers/tlsFixture';
import { certPinOf } from '@ext/domain/replica/hubFile';
import { HUB_HOLD_MS, readHubSmoke } from '../src/hub.ts';
import { verifyRunFile, writeRunFile } from '../src/runfile.ts';
import { runStages } from '../src/stages.ts';
import { fakeClock, fakeMeasure, fakeService, people } from '../test/fixtures/fakes.ts';
import { makeRun, stage } from '../test/fixtures/run.ts';

type WorkerMessage = { type: 'ready' | 'stalled' | 'pin-refused' | 'failed' } | { type: 'result'; result: unknown };

assert.deepEqual(Object.keys(networkInterfaces()), ['lo'], 'hub fixture requires loopback-only isolation');

function worker(input: object) {
  const child = fork(fileURLToPath(new URL('./hub-worker.mjs', import.meta.url)), [], {
    execPath: process.execPath, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: '--max-old-space-size=1536' }
  });
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const reports: WorkerMessage[] = [];
  child.once('error', () => reports.push({ type: 'failed' }));
  child.once('exit', (code, signal) => { exited = { code, signal }; });
  child.on('message', (message) => reports.push(message as WorkerMessage));
  child.send(input, (error) => { if (error) reports.push({ type: 'failed' }); });
  // Explicitly disconnecting the parent's channel does not reliably emit the combined close event.
  return { child, reports, exit: () => child.connected ? undefined : exited };
}

async function within<T>(value: () => T | undefined, ms: number): Promise<T | undefined> {
  const deadline = performance.now() + ms;
  for (;;) {
    const found = value();
    if (found !== undefined || performance.now() >= deadline) return found;
    await delay(10);
  }
}

async function reap(run: ReturnType<typeof worker>) {
  if (run.exit()) return run.exit();
  run.child.kill('SIGTERM');
  const graceful = await within(run.exit, 500);
  if (graceful) return graceful;
  run.child.kill('SIGKILL');
  return within(run.exit, 2000);
}

test('a sealed loopback hub experiment observes five streams and accepted appends', { timeout: 22000 }, async () => {
  const run = worker({ mode: 'smoke' });
  try {
    const first = await within(() => run.reports[0], 10000);
    assert.equal(first?.type, 'ready', 'fixture setup must complete before its measurement');
    assert.deepEqual(await within(run.exit, HUB_HOLD_MS + 2000), { code: 0, signal: null });
    assert.deepEqual(run.reports.map(({ type }) => type), ['ready', 'result']);
    const report = run.reports[1];
    const hub = readHubSmoke(report?.type === 'result' ? report.result : undefined);
    assert.ok(hub && hub.streams === 5 && hub.appends > 0 && hub.healthMs.length > 0);
    const initial = makeRun({ id: '20261123T120000Z-hub-smoke', rig: 'hub-smoke', kind: 'experiment', stages: [stage(5)] });
    const inputs = { ...initial.inputs, holdMs: HUB_HOLD_MS };
    const clock = fakeClock();
    const result = await runStages({ plan: inputs, people: people(5), clock, service: fakeService(clock), measure: fakeMeasure(), hubs: async () => hub });
    const dir = mkdtempSync(path.join(tmpdir(), 'hub-smoke-run-'));
    const file = writeRunFile(dir, { ...initial, ...result, inputs, schema: 2 });
    assert.deepEqual(verifyRunFile(readFileSync(file, 'utf8')).stages[0]?.hubs, [hub]);
  } finally {
    assert.ok(await reap(run), 'fixture worker exited');
  }
});

test('a wrong pinned certificate sends no HTTP request', { timeout: 14000 }, async () => {
  const run = worker({ mode: 'wrong-pin' });
  try {
    assert.deepEqual(await within(run.exit, 10000), { code: 0, signal: null });
    assert.deepEqual(run.reports, [{ type: 'pin-refused' }]);
  } finally {
    assert.ok(await reap(run), 'fixture worker exited');
  }
});

for (const shutdown of ['signals', 'disconnect'] as const) {
  test(`a stalled TLS handshake releases its worker and peer socket on ${shutdown}`, { timeout: 14000 }, async () => {
    const cert = makeTlsFixture();
    let accepted: Socket | undefined;
    let peerClosed = false;
    const peer = createServer((socket) => {
      accepted = socket;
      socket.once('close', () => { peerClosed = true; });
      socket.on('error', () => {});
      socket.resume();
    });
    const listening = once(peer.listen(0, '127.0.0.1'), 'listening');
    let run: ReturnType<typeof worker> | undefined;
    try {
      await listening;
      const { port } = peer.address() as AddressInfo;
      run = worker({ mode: 'stall', port, pin: certPinOf(cert.certDer) });
      const running = run;
      assert.ok(await within(() => running.reports[0]?.type === 'stalled' ? accepted : undefined, 10000), 'the private peer accepted the pending handshake');
      assert.deepEqual(run.reports, [{ type: 'stalled' }]);
      assert.equal(run.exit(), undefined);
      if (shutdown === 'disconnect') run.child.disconnect();
      const exited = shutdown === 'signals' ? await reap(run) : await within(run.exit, 2000);
      assert.deepEqual(exited, shutdown === 'signals' ? { code: null, signal: 'SIGKILL' } : { code: 1, signal: null });
      assert.ok(await within(() => peerClosed ? true : undefined, 2000), 'the peer observed its socket close before cleanup');
      assert.deepEqual(run.reports, [{ type: 'stalled' }], 'no result could be sealed');
    } finally {
      const reaped = run ? await reap(run) : true;
      accepted?.destroy();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
      cert.cleanup();
      assert.ok(reaped, 'fixture worker exited');
      assert.equal(peer.listening, false);
    }
  });
}
