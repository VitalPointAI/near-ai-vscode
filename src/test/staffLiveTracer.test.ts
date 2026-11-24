// The tracer of Phase 33 (D-09, D-11, D-34, D-46, D-49): two people's computers, each with its own store folder and device key, share one real hub
// started as a child process on Node 26 with a temporary state directory and loopback TLS. A types a sentence into a product through the product
// editing core; the change is stored on A first and pushed after; the hub's heads event wakes B's live replicator, which pulls with syncOnce, and
// B's fold shows the same text. The real-hub tests run when NEAR_AI_HUB_NODE names a Node 26.13.1 binary and are skipped with a printed reason
// otherwise, except in GitHub Actions, where a missing binary fails them. Fictional people and data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { HubTransportError } from '../staff/replica/hubTransport';
import type { LiveReplicator, LiveStatus, LiveTransport } from '../staff/replica/liveReplicator';
import { ProductEditor } from '../staff/replica/productEditing';
import type { ReplicaProject } from '../staff/replica/replicaProject';
import { HUB_NODE_REASON, hubNodeOrSkip, hubNodeRule, startHubChild } from './helpers/hubChild';
import { FakeTimers, createLiveWorld, settle } from './helpers/liveWorld';

const SENTENCE = 'Enemy forces hold the bridge.';
const PRODUCT = 'intel-estimate';

/** Resolves when the replicator reports the state, or fails after ms with the status it last had. */
function until(replicator: LiveReplicator, state: LiveStatus['state'], ms = 20_000): Promise<LiveStatus> {
  return new Promise((resolve, reject) => {
    if (replicator.status.state === state) { resolve(replicator.status); return; }
    const timer = setTimeout(() => { listener.dispose(); reject(new Error(`no ${state} within ${ms} ms; last status ${JSON.stringify(replicator.status)}`)); }, ms);
    const listener = replicator.onStatus((status) => {
      if (status.state !== state) return;
      clearTimeout(timer);
      listener.dispose();
      resolve(status);
    });
  });
}

/** Resolves when the replicator's status passes the check, or fails after ms with the status it last had. */
function reaches(replicator: LiveReplicator, check: (status: LiveStatus) => boolean, what: string, ms = 20_000): Promise<LiveStatus> {
  return new Promise((resolve, reject) => {
    if (check(replicator.status)) { resolve(replicator.status); return; }
    const timer = setTimeout(() => { listener.dispose(); reject(new Error(`${what}: not within ${ms} ms; last status ${JSON.stringify(replicator.status)}`)); }, ms);
    const listener = replicator.onStatus((status) => {
      if (!check(status)) return;
      clearTimeout(timer);
      listener.dispose();
      resolve(status);
    });
  });
}

/** Resolves once the log holds the line, or fails after ms. */
async function logged(log: readonly string[], line: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!log.includes(line)) {
    if (Date.now() > deadline) assert.fail(`no "${line}" within ${ms} ms; the log was:\n${log.join('\n')}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The product's text as this computer's fold has it, or undefined. */
async function foldText(project: ReplicaProject, stream: string, product: string): Promise<string | undefined> {
  const { fold } = await project.state();
  return ((fold.families.doc as ProductTextOutput[] | undefined) ?? []).find((item) => item.stream === stream && item.product === product)?.text;
}

/** Polls until the product text equals the wanted text, or fails after ms. */
async function textReaches(project: ReplicaProject, stream: string, product: string, wanted: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const text = await foldText(project, stream, product);
    if (text === wanted) return;
    if (Date.now() > deadline) assert.fail(`text did not converge within ${ms} ms; expected length ${wanted.length}, got ${text?.length ?? 'no text'}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('the real-hub rule: run with NEAR_AI_HUB_NODE, skip with the printed reason without it, fail in GitHub Actions without it (D-46)', () => {
  assert.deepEqual(hubNodeRule({ NEAR_AI_HUB_NODE: '/opt/node-26/bin/node' }), { run: '/opt/node-26/bin/node' });
  assert.deepEqual(hubNodeRule({ NEAR_AI_HUB_NODE: '/opt/node-26/bin/node', GITHUB_ACTIONS: 'true' }), { run: '/opt/node-26/bin/node' });
  assert.deepEqual(hubNodeRule({}), { skip: HUB_NODE_REASON });
  assert.deepEqual(hubNodeRule({ NEAR_AI_HUB_NODE: '' }), { skip: HUB_NODE_REASON });
  assert.deepEqual(hubNodeRule({ GITHUB_ACTIONS: 'true' }), { fail: HUB_NODE_REASON });
  assert.equal(HUB_NODE_REASON, 'Set NEAR_AI_HUB_NODE to a Node 26.13.1 binary to run the real-hub test');
  const skipped: string[] = [];
  const printed: string[] = [];
  assert.equal(hubNodeOrSkip({ skip: (message) => skipped.push(message ?? '') }, {}, (line) => printed.push(line)), undefined);
  assert.deepEqual(skipped, [HUB_NODE_REASON]);
  assert.deepEqual(printed, [HUB_NODE_REASON]);
  assert.throws(() => hubNodeOrSkip({ skip: (message) => skipped.push(message ?? '') }, { GITHUB_ACTIONS: 'true' }, (line) => printed.push(line)), { message: HUB_NODE_REASON });
  assert.equal(skipped.length, 1, 'in GitHub Actions nothing is skipped');
  assert.equal(hubNodeOrSkip({ skip: () => assert.fail('not skipped') }, { NEAR_AI_HUB_NODE: '/opt/node-26/bin/node' }), '/opt/node-26/bin/node');
});

test('a project without your organization\'s server stays single-machine and opens no connection', async () => {
  const world = await createLiveWorld({ people: [{ label: 'solo', name: 'Avery Lead' }] });
  try {
    let opened = 0;
    const replicator = world.replicator(world.lead, { open: () => { opened += 1; throw new Error('no transport may open'); } });
    await replicator.start();
    assert.equal(replicator.status.state, 'single-machine');
    assert.equal(opened, 0);
    await replicator.stop();
    assert.equal(replicator.status.state, 'single-machine');
  } finally {
    await world.close();
  }
});

async function traceThroughHub(t: TestContext, text: string, records: number): Promise<void> {
  const node = hubNodeOrSkip(t);
  if (node === undefined) return;
  const server = await startHubChild(node);
  try {
    const world = await createLiveWorld({ people: [{ label: 'avery', name: 'Avery Lead' }, { label: 'blake', name: 'Blake Rivers' }], hub: { fileText: await server.hubFileText() } });
    try {
      const [a, b] = world.devices;
      const logA: string[] = [];
      const logB: string[] = [];
      const ra = world.replicator(a, { log: (line) => logA.push(line) });
      const rb = world.replicator(b, { log: (line) => logB.push(line) });
      await ra.start();
      await until(ra, 'live');
      await rb.start();
      await until(rb, 'live');
      // Both have caught up on what arrived while their event streams opened; from here on B syncs only when the hub wakes it.
      await logged(logA, 'exchange stream-open done synced');
      await logged(logB, 'exchange stream-open done synced');
      assert.equal(rb.status.findings.length, 0, JSON.stringify(rb.status));

      const stream = a.project.projectId;
      const editor = await ProductEditor.open(a.project, { stream, product: PRODUCT, actor: { kind: 'person' } }, { onAppended: () => ra.localAppended() });
      editor.insert(0, text);
      assert.ok(editor.text() === text);
      const pushedBefore = ra.status.pushed;
      const wakesBefore = logB.filter((line) => line === 'wake heads').length;
      const flushed = await editor.flush();
      const flushedAt = Date.now();
      assert.deepEqual(flushed, { appended: records, queued: 0 });
      assert.equal(ra.status.pushed, pushedBefore, 'nothing was pushed before the store held the change');
      // Stored first: the registration and the changes are in A's store before the replicator pushed anything.
      assert.equal((await a.project.findOwnAll('doc.client', (data) => (data as { product?: unknown }).product === PRODUCT)).length, 1);
      assert.equal((await a.project.findOwnAll('doc.update', (data) => (data as { product?: unknown }).product === PRODUCT)).length, records);

      await textReaches(b.project, stream, PRODUCT, text);
      const seenAfterMs = Date.now() - flushedAt;
      console.log(`B saw A's change ${seenAfterMs} ms after A stored it`);
      assert.ok(await foldText(a.project, stream, PRODUCT) === text);
      await reaches(ra, (status) => status.pushed >= pushedBefore + 1 + records, 'A pushed the registration and the changes');
      // B was woken by the hub's heads frame: its only exchanges after going live start from a heads frame, and B has no timer that syncs.
      assert.ok(logB.filter((line) => line === 'wake heads').length > wakesBefore, logB.join('\n'));
      assert.ok(logB.includes('exchange heads'), logB.join('\n'));
      assert.equal(logB.some((line) => line === 'exchange timer'), false, logB.join('\n'));
      assert.equal(ra.status.state, 'live');
      assert.equal(rb.status.state, 'live');
      await reaches(rb, (status) => status.pulled >= 1 + records, 'B stored the registration and the changes');
      editor.close();
    } finally {
      await world.close();
    }
  } finally {
    await server.dispose();
  }
}

test('tracer: A types one sentence, it is stored first, pushed through a real hub child process, and B\'s fold shows it, woken by the heads event', (t) =>
  traceThroughHub(t, SENTENCE, 1));

test('tracer: a 300 KiB paste crosses the real hub as ordered records', (t) =>
  traceThroughHub(t, '🌎'.repeat(75 * 1024), 2));

/** A transport whose server never answers: every call waits until close(), which ends it as unreachable. Counts opens and closes. */
function silentServer(project: string, hub: string): { open: () => LiveTransport; opened: () => number; closed: () => number } {
  let opened = 0;
  let closed = 0;
  const open = (): LiveTransport => {
    opened += 1;
    const waiting: Array<(error: Error) => void> = [];
    let gone = false;
    const never = <T>(): Promise<T> => new Promise<T>((_, reject) => { if (gone) reject(new HubTransportError('unreachable')); else waiting.push(reject); });
    const transport = {
      project,
      hub,
      hubHeads: () => never(),
      entries: () => never(),
      append: () => never(),
      getBlob: () => never(),
      grant: () => never(),
      askCheckpoint: () => never(),
      events: () => never(),
      close: () => {
        closed += 1;
        gone = true;
        for (const reject of waiting.splice(0)) reject(new HubTransportError('unreachable'));
      }
    };
    return transport as unknown as LiveTransport;
  };
  return { open, opened: () => opened, closed: () => closed };
}

test('the replicator gives up connecting after its give-up time, retries on its timers with back-off, and Sync Now retries at once from 1 s again', async () => {
  const world = await createLiveWorld({ people: [{ label: 'gale', name: 'Avery Lead' }] });
  try {
    const timers = new FakeTimers();
    const hubWriter = 'e'.repeat(64);
    const server = silentServer(world.lead.project.projectId, hubWriter);
    const seen: LiveStatus[] = [];
    const replicator = world.replicator(world.lead, {
      hub: { id: 'hub-0011223344556677', writer: hubWriter, certPin: 'f'.repeat(64) }, address: () => Promise.resolve('127.0.0.1:9'),
      open: server.open, timers, now: () => timers.date(), giveUpMs: 3000
    });
    replicator.onStatus((status) => seen.push(status));
    await replicator.start();
    await settle();
    assert.equal(replicator.status.state, 'connecting');
    assert.equal(server.opened(), 1);
    await timers.advance(2999);
    assert.equal(replicator.status.state, 'connecting', 'not before the give-up time');
    await timers.advance(1);
    assert.equal(replicator.status.state, 'offline');
    assert.equal(replicator.status.reason, 'timeout');
    assert.equal(replicator.status.retryAt, timers.now() + 1000);
    assert.equal(server.closed(), 1, 'the connection that never answered is closed');
    await timers.advance(1000);
    assert.equal(replicator.status.state, 'connecting', 'the timed retry');
    assert.equal(server.opened(), 2);
    await timers.advance(3000);
    assert.equal(replicator.status.state, 'offline');
    assert.equal(replicator.status.retryAt, timers.now() + 2000, 'the second wait doubles');
    replicator.syncNow();
    await settle();
    assert.equal(replicator.status.state, 'connecting', 'Sync Now retries at once');
    assert.equal(server.opened(), 3);
    await timers.advance(3000);
    assert.equal(replicator.status.retryAt, timers.now() + 1000, 'after Sync Now the wait is 1 s again');
    assert.ok(seen.some((status) => status.state === 'offline' && status.retryAt !== undefined), 'every change is reported with its retry time');
    await replicator.stop();
    assert.equal(replicator.status.state, 'single-machine');
    assert.equal(timers.pending, 0, 'stop leaves no timer');
  } finally {
    await world.close();
  }
});

test('offline and back over the real hub: B shows offline within the give-up time when the hub stops, A\'s change made offline is kept, and Sync Now brings both back live', async (t) => {
  const node = hubNodeOrSkip(t);
  if (node === undefined) return;
  const server = await startHubChild(node);
  try {
    const world = await createLiveWorld({ people: [{ label: 'avery', name: 'Avery Lead' }, { label: 'blake', name: 'Blake Rivers' }], hub: { fileText: await server.hubFileText() } });
    try {
      const [a, b] = world.devices;
      const logA: string[] = [];
      const logB: string[] = [];
      const giveUpMs = 3000;
      const ra = world.replicator(a, { log: (line) => logA.push(line), giveUpMs });
      const rb = world.replicator(b, { log: (line) => logB.push(line), giveUpMs });
      await ra.start();
      await until(ra, 'live');
      await rb.start();
      await until(rb, 'live');
      await logged(logA, 'exchange stream-open done synced');
      await logged(logB, 'exchange stream-open done synced');

      const stoppedAt = Date.now();
      await server.stop();
      await until(rb, 'offline', giveUpMs);
      const tookMs = Date.now() - stoppedAt;
      assert.ok(tookMs <= giveUpMs, `B showed offline after ${tookMs} ms`);
      await until(ra, 'offline', giveUpMs);
      assert.ok(rb.status.retryAt !== undefined, 'offline names when it tries again');

      // A types while the server is gone: the change is stored on A and waits there.
      const stream = a.project.projectId;
      const text = 'The bridge is held at dawn.';
      const editor = await ProductEditor.open(a.project, { stream, product: PRODUCT, actor: { kind: 'person' } }, { onAppended: () => ra.localAppended() });
      editor.insert(0, text);
      assert.deepEqual(await editor.flush(), { appended: 1, queued: 0 });
      assert.equal(await foldText(a.project, stream, PRODUCT), text);
      assert.equal(ra.status.state, 'offline');

      await server.restart();
      rb.syncNow();
      ra.syncNow();
      await until(ra, 'live', 10_000);
      await until(rb, 'live', 10_000);
      await textReaches(b.project, stream, PRODUCT, text);
      editor.close();
    } finally {
      await world.close();
    }
  } finally {
    await server.dispose();
  }
});
