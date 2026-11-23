import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { DiscoverySection } from '../domain/gate/sections';
import { parseGuideInbound, type GuideInbound } from '../domain/setup/guideMessages';
import type { FoundServerRow, GuideDiscoveryPort, GuideScreenModel, ScanOffer } from '../domain/setup/screens';
import { createGuideController, type GuideController, type GuideControllerDeps } from '../services/setup/guideController';
import { at, local, setup } from './helpers/getStartedHostFixture';

type Run = Awaited<ReturnType<typeof setup>>;
const ranges = ['192.0.2.0/30'];
const discoveryPolicy: DiscoverySection = {
  networks: [{ id: 'office', dnsSuffix: 'corp.example.org' }],
  scanRanges: [{ cidr: ranges[0], network: 'office' }], announce: true, personalApprovals: false
};
const candidate: FoundServerRow = {
  id: 'fixture-server', name: 'Fixture server', host: 'server.corp.example.org', port: 443, state: 'found', action: 'approve',
};
const confirm: GuideInbound = { type: 'scan-confirm', ranges };
const approve: GuideInbound = { type: 'approve-candidate', candidateId: candidate.id };

async function enableDiscovery(run: Run, discovery: DiscoverySection = discoveryPolicy) {
  const personal = run.host.policyLayers().personal;
  assert.ok(personal);
  await run.host.applyPolicyDraft(JSON.stringify({
    ...personal.document,
    requires: [...new Set([...personal.document.requires, 'onboarding@1'])].sort(),
    onboarding: { v: 1, discovery },
  }), personal.hash);
}

function fakeDiscovery() {
  let rows: readonly FoundServerRow[] = [candidate, { ...candidate, id: 'ask-only', action: 'ask' }];
  let offer: ScanOffer = { offered: true, running: false, ranges, confirmText: 'Review the range and approved ports.' };
  const listeners = new Set<() => void>();
  const published = () => listeners.forEach((listener) => listener());
  const refreshes: AbortSignal[] = [];
  const refreshWaiters = new Map<number, () => void>();
  const scans: (readonly string[])[] = [];
  const approvals: string[] = [];
  let stops = 0;
  const port: GuideDiscoveryPort = {
    rows: () => rows,
    scanOffer: () => offer,
    async refresh(signal) {
      refreshes.push(signal);
      refreshWaiters.get(refreshes.length)?.();
      refreshWaiters.delete(refreshes.length);
    },
    async startScan(confirmed) {
      scans.push(confirmed);
      offer = { ...offer, offered: false, running: true, done: 0, total: 2 };
      published();
    },
    stopScan() {
      stops++;
      offer = { ...offer, offered: true, running: false };
      published();
    },
    async approve(id) {
      approvals.push(id);
      rows = rows.map((row) => row.id === id ? { ...row, action: 'none', state: 'proposed' } : row);
      published();
      return 'opened';
    },
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    }
  };
  return {
    port, refreshes, scans, approvals, listeners,
    get stops() { return stops; },
    async waitForRefresh(number: number) {
      if (refreshes.length < number) await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('The expected discovery refresh did not start')), 2000);
        refreshWaiters.set(number, () => { clearTimeout(timeout); resolve(); });
      });
      await nextTurn();
    },
    changeOffer(confirmText: string) { offer = { ...offer, confirmText }; published(); },
    changeRow() { rows = [{ ...candidate, action: 'ask' }]; published(); },
    published,
  };
}

function guideFor(t: TestContext, run: Run, discovery: GuideDiscoveryPort, readPolicy = run.deps.readPolicy) {
  const guide = createGuideController({ ...run.deps, discovery, readPolicy });
  t.after(() => guide.dispose());
  return guide;
}

function screen<K extends GuideScreenModel['kind']>(run: Run, kind: K) {
  const message = run.posted.at(-1);
  assert.ok(message?.type === 'screen' && message.screen.kind === kind, JSON.stringify(message));
  return message.screen as Extract<GuideScreenModel, { kind: K }>;
}

async function enterOptions(guide: GuideController, classified = false) {
  await guide.open();
  const events: GuideInbound[] = [
    { type: 'answer', key: 'kindOfWork', value: 'analysis' }, { type: 'next' },
    { type: 'answer', key: 'data', value: [classified ? 'classified' : 'internal'] }, { type: 'next' },
    { type: 'answer', key: 'canada', value: 'no' }, { type: 'next' },
  ];
  for (const event of events) await guide.receive(event);
  await nextTurn();
}

test('Get Started delegates the displayed candidate and one exact scan confirmation', async (t) => {
  const run = await setup();
  await enableDiscovery(run);
  const discovery = fakeDiscovery();
  const guide = guideFor(t, run, discovery.port);
  await enterOptions(guide);
  await discovery.waitForRefresh(1);
  assert.equal(discovery.refreshes.length, 1);
  assert.deepEqual(screen(run, 'options').candidates.map(({ id }) => id), [candidate.id, 'ask-only']);
  assert.deepEqual(screen(run, 'options').scan.ranges, ranges);
  for (const input of [
    { type: 'approve-candidate', candidateId: 'ask-only' }, { type: 'approve-candidate', candidateId: 'missing' },
    { type: 'scan-confirm', ranges: ['192.0.2.4/30'] },
  ]) {
    const parsed = parseGuideInbound(input);
    assert.ok(parsed);
    await guide.receive(parsed);
  }
  assert.deepEqual(discovery.approvals, []);
  assert.deepEqual(discovery.scans, []);
  await guide.receive(approve);
  assert.deepEqual(discovery.approvals, [candidate.id]);
  assert.equal(screen(run, 'options').candidates[0]?.state, 'proposed');
  await Promise.all([guide.receive(confirm), guide.receive(confirm)]);
  assert.deepEqual(discovery.scans, [ranges]);
  assert.equal(screen(run, 'options').scan.running, true);
  await guide.receive({ type: 'scan-stop' });
  assert.equal(discovery.stops, 1);
  assert.equal(screen(run, 'options').scan.running, false);
  assert.equal(screen(run, 'options').scan.offered, false);
  await guide.receive(confirm);
  assert.equal(discovery.scans.length, 1);
});

test('Get Started refuses stale selections and cancels discovery across review and disposal', async (t) => {
  const run = await setup({ results: [{
    ...local, state: 'viable', answeredAt: at,
    routeFacts: { clientRoute: 'local', host: 'http://127.0.0.1:11434', model: { id: 'fixture', privacyBoundary: 'local' } }
  }] });
  await enableDiscovery(run);
  const discovery = fakeDiscovery();
  let release: (() => void) | undefined;
  let hold = false;
  const readPolicy: GuideControllerDeps['readPolicy'] = async (now) => {
    if (hold) await new Promise<void>((resolve) => { release = resolve; });
    return run.deps.readPolicy(now);
  };
  const guide = guideFor(t, run, discovery.port, readPolicy);
  await enterOptions(guide);
  await discovery.waitForRefresh(1);
  const original = discovery.refreshes[0];
  hold = true;
  const staleScan = guide.receive(confirm);
  discovery.changeOffer('The ports changed while confirmation was pending.');
  hold = false;
  assert.ok(release);
  release();
  await staleScan;
  assert.deepEqual(discovery.scans, []);

  hold = true;
  const cancelledScan = guide.receive(confirm);
  await guide.receive({ type: 'scan-stop' });
  hold = false;
  assert.ok(release);
  release();
  await cancelledScan;
  assert.deepEqual(discovery.scans, []);

  hold = true;
  const staleApproval = guide.receive(approve);
  discovery.changeRow();
  hold = false;
  assert.ok(release);
  release();
  await staleApproval;
  assert.deepEqual(discovery.approvals, []);

  await guide.receive({ type: 'choose', optionId: 'this-computer' });
  assert.equal(screen(run, 'options').canReview, true);
  await guide.receive({ type: 'review' });
  screen(run, 'check');
  assert.equal(original.aborted, true);
  assert.equal(discovery.listeners.size, 0);
  await guide.receive(confirm);
  assert.deepEqual(discovery.scans, []);

  await guide.receive({ type: 'back' });
  await discovery.waitForRefresh(2);
  assert.equal(discovery.refreshes.length, 2);
  assert.equal(discovery.refreshes[1].aborted, false);
  await guide.receive(confirm);
  assert.deepEqual(discovery.scans, [ranges]);
  await guide.dispose();
  assert.equal(discovery.refreshes[1].aborted, true);
  assert.equal(discovery.listeners.size, 0);
  const notifications = run.posted.length;
  discovery.published();
  assert.equal(run.posted.length, notifications);
});

test('Get Started keeps discovery closed without signed permission and for classified work', async (t) => {
  for (const classified of [false, true]) {
    const run = await setup();
    if (classified) await enableDiscovery(run);
    const discovery = fakeDiscovery();
    const guide = guideFor(t, run, discovery.port);
    await enterOptions(guide, classified);
    if (classified) screen(run, 'stopped');
    else assert.equal(screen(run, 'options').scan.offered, false);
    await guide.receive(confirm);
    await guide.receive(approve);
    assert.deepEqual(discovery.refreshes, []);
    assert.deepEqual(discovery.scans, []);
    assert.deepEqual(discovery.approvals, []);
    assert.equal(discovery.listeners.size, 0);
  }
});

test('Get Started refuses actions after signed discovery permission changes', async (t) => {
  const run = await setup();
  await enableDiscovery(run);
  const discovery = fakeDiscovery();
  const guide = guideFor(t, run, discovery.port);
  await enterOptions(guide);
  await discovery.waitForRefresh(1);
  assert.equal(screen(run, 'options').scan.offered, true);
  await enableDiscovery(run, { ...discoveryPolicy, announce: false, scanRanges: [] });
  await guide.receive(confirm);
  screen(run, 'fix');
  assert.deepEqual(discovery.scans, []);
  assert.equal(discovery.refreshes[0].aborted, true);
  await guide.receive(approve);
  assert.deepEqual(discovery.approvals, []);
});

test('Get Started only offers a scan for ranges in the signed setup policy', async (t) => {
  const run = await setup();
  await enableDiscovery(run, { ...discoveryPolicy, scanRanges: [] });
  const discovery = fakeDiscovery();
  const guide = guideFor(t, run, discovery.port);
  await enterOptions(guide);
  await discovery.waitForRefresh(1);
  assert.equal(screen(run, 'options').scan.offered, false);
  await guide.receive(confirm);
  assert.deepEqual(discovery.scans, []);
});
