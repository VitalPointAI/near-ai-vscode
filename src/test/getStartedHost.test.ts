import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setProjectLabel } from '../domain/gate/labelMap';
import { createAuditEventRegistry, GUIDE_AUDIT_EVENT_SPECS } from '../domain/setup/records';
import type { GuideInbound, GuideOutbound } from '../domain/setup/guideMessages';
import type { ViabilityResult } from '../domain/setup/viability';
import { projectLogKey } from '../gate/decisionLog';
import { GateHost } from '../gate/host';
import { SetupAuditLog } from '../gate/setupAuditLog';
import { createGuideController, type GuideControllerDeps } from '../services/setup/guideController';
import { routeFactsOf } from '../services/setup/guideFacts';
import { readSetupGuide } from '../services/setup/projectStore';
import { singleMachineSink } from '../services/setup/projectLayerSink';
import { MemorySecrets } from './helpers/teamHarness';

const at = Date.parse('2026-11-22T22:13:07.034Z');
const local: ViabilityResult = {
  optionId: 'this-computer', kind: 'this-computer', state: 'not-detected', models: [],
  hostKind: 'container', sentence: 'No local AI server was found. This computer has 16 GB of memory.'
};
const url = 'https://cloud-api.near.ai/v1';
const near: ViabilityResult = {
  optionId: 'near-private', kind: 'near-private', state: 'viable', models: [], hostKind: 'container',
  answeredAt: at, routeFacts: { clientRoute: 'near', host: url, model: { id: 'fixture', privacyBoundary: 'tee' },
    binding: { state: 'bound', host: url, checkedAt: at } }
};

test('route facts use the observed option and do not invent an unavailable route', () => {
  assert.equal(routeFactsOf(local, at), undefined);
  const fact = routeFactsOf(near, at);
  assert.equal(fact?.clientRoute, 'near');
  assert.equal(fact?.host, url);
  assert.equal(fact?.nearEndpoint, true);
  assert.equal(fact?.now, at);
  assert.deepEqual(fact?.model, near.routeFacts?.model);
  assert.deepEqual(fact?.binding, near.routeFacts?.binding);
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'near-guide-host-'));
  const storage = await mkdtemp(path.join(tmpdir(), 'near-guide-storage-'));
  const host = new GateHost({ globalStorageDir: storage, projectRoot: root, secrets: new MemorySecrets(), productVersion: '0.4.36', now: () => new Date(at) });
  await host.start();
  const label = host.labelPolicy().defaultLabel;
  await host.changeLabels(root, (map) => setProjectLabel(map, { ...label, scale: 'org', level: 'Public' }));
  const registry = createAuditEventRegistry();
  for (const spec of GUIDE_AUDIT_EVENT_SPECS) registry.register(spec);
  const audit = new SetupAuditLog({ globalStorageDir: storage, projectRoot: root, projectKey: projectLogKey(root), registry, clock: () => at, onWriteFailure: assert.fail });
  const runtime = await host.runtimeFor({ root, actor: { kind: 'person', sessionId: 'setup-test' }, presence: 'person', context: 'interactive' });
  const posted: GuideOutbound[] = [];
  const calls = { checks: 0, lands: 0 };
  const deps: GuideControllerDeps = {
    root, hostKind: 'container', machine: 'test host', clock: () => at,
    readPolicy: async (now) => {
      const state = runtime.bundleState();
      const layers = host.policyLayers();
      const route = runtime.routePolicy?.(now);
      return state.state === 'valid' && route ? {
        view: { effective: layers.effective, organization: layers.organization.state, startingRules: true, issuedHere: false },
        route, hash: state.hash, routing: state.bundle.routing, defaultLabel: state.bundle.defaultLabel,
        floor: undefined, projectLabel: (await host.labelsFor(root).view(state.bundle.scales)).resolve('', state.bundle.defaultLabel).mark[0]
      } : { view: { organization: 'failed', startingRules: false, issuedHere: false } };
    },
    check: async (snapshot, progress) => {
      calls.checks++;
      const results = [local, near].map((result) => ({ ...result, policyHash: snapshot.hash }));
      results.forEach(progress);
      return { results, stillChecking: [], dispose() {} };
    },
    apply: {
      labelHost: host, sink: singleMachineSink(root, { effective: () => host.policyLayers().effective }), audit,
      connection: () => ({ changeId: 'connection', alreadyDone: async () => true, run: async () => assert.fail('saved connection does not need changing') })
    },
    landing: { async land() { calls.lands++; } },
    post: (message) => posted.push(message)
  };
  return { root, host, audit, deps, posted, calls };
}

const answers: GuideInbound[] = [
  { type: 'answer', key: 'kindOfWork', value: 'software' }, { type: 'next' },
  { type: 'answer', key: 'data', value: ['internal'] }, { type: 'next' },
  { type: 'answer', key: 'canada', value: 'no' }, { type: 'next' }
];

test('the guide reviews and applies a viable private route through the real label writer and audit', async (t) => {
  const { root, host, audit, deps, posted, calls } = await setup();
  const guide = createGuideController(deps);
  t.after(() => guide.dispose());
  await guide.open();
  for (const event of answers) await guide.receive(event);
  assert.ok(posted.some(message => message.type === 'screen' && message.screen.kind === 'checking' && message.screen.checkedOn.includes('test host, a container')));
  const options = posted.at(-1);
  assert.ok(options?.type === 'screen' && options.screen.kind === 'options');
  assert.equal(options.screen.recommended[0]?.optionId, 'near-private');
  assert.equal(options.screen.notAvailable[0]?.reason, local.sentence);
  await guide.receive({ type: 'choose', optionId: 'near-private' });
  await guide.receive({ type: 'review' });
  const check = posted.at(-1);
  assert.ok(check?.type === 'screen' && check.screen.kind === 'check');
  await guide.receive({ type: 'apply' });
  const done = posted.at(-1);
  assert.ok(done?.type === 'screen' && done.screen.kind === 'done');
  assert.deepEqual(readSetupGuide(root)?.chosen, ['near-private']);
  const labelPolicy = host.labelPolicy();
  assert.equal((await host.labelsFor(root).view(labelPolicy.scales)).resolve('', labelPolicy.defaultLabel).mark[0]?.level, 'Internal');
  assert.equal(calls.checks, 2, 'Apply runs fresh viability before writing');
  assert.equal(calls.lands, 1);
  const chain = await audit.verify();
  assert.ok(chain.ok);
  assert.equal(chain.head?.seq, 1);
});

test('Get Started opens one kit panel, rejects malformed messages, and reads the live gate', async () => {
  const { deps, host, root } = await setup();
  const posted: GuideOutbound[] = [];
  const handlers: { receive?: (message: unknown) => Promise<void>; close?: () => void } = {};
  let views = 0;
  let reveals = 0;
  const panel = {
    webview: {
      html: '', cspSource: 'vscode-resource:',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: async (message: GuideOutbound) => { posted.push(message); return true; },
      onDidReceiveMessage(receive: NonNullable<typeof handlers.receive>) { handlers.receive = receive; return { dispose() {} }; }
    },
    onDidDispose(callback: () => void) { handlers.close = callback; return { dispose() {} }; },
    onDidChangeViewState() { return { dispose() {} }; },
    reveal() { reveals++; },
    dispose() { handlers.close?.(); }
  };
  const uri = (value: string) => ({ path: value, fsPath: value, toString: () => value });
  const stub = {
    Uri: { joinPath: (base: ReturnType<typeof uri>, ...parts: string[]) => uri([base.path, ...parts].join('/')) },
    ViewColumn: { Active: -1 },
    window: { createWebviewPanel(type: string, title: string) {
      assert.equal(type, 'nearAiGetStarted');
      assert.equal(title, 'Get Started');
      views++;
      return panel;
    } }
  };
  const loader = Module as unknown as { _load: (request: string, ...args: unknown[]) => unknown };
  const previous = loader._load;
  const imports = ['../services/setup/getStarted', '../services/webview/openPanel', '../services/layoutProbe']
    .map((name) => require.resolve(name));
  const cached = imports.map((name) => require.cache[name]);
  let registrar!: typeof import('../services/setup/getStarted');
  try {
    for (const name of imports) delete require.cache[name];
    loader._load = (request, ...args) => request === 'vscode' ? stub : previous.call(Module, request, ...args);
    registrar = require('../services/setup/getStarted');
  } finally {
    loader._load = previous;
    imports.forEach((name, index) => {
      const prior = cached[index];
      if (prior) require.cache[name] = prior;
      else delete require.cache[name];
    });
  }
  const readPolicy = registrar.gateGuidePolicy(host, root, () => 'standard');
  const run = registrar.registerGetStarted({ extensionUri: uri('/extension') as never }, { createRun: () => ({ ...deps, readPolicy }) });
  try {
    await run.openGetStarted();
    const first = posted[0];
    assert.ok(first?.type === 'screen' && first.screen.kind === 'question');
    assert.equal(first.screen.screen, 'kind-of-work');
    assert.match(panel.webview.html, /default-src 'none'/);
    assert.match(panel.webview.html, /<main id="guide">/);
    assert.match(panel.webview.html, /getStarted\.js/);
    assert.match(panel.webview.html, /getStartedScreens\.js/);
    await handlers.receive?.({ type: 'answer', key: 'kindOfWork', value: 'software', unknown: true });
    assert.equal(posted.length, 1);
    await run.openGetStarted();
    assert.equal(views, 1);
    assert.equal(reveals, 1);
  } finally { run.dispose(); }
});

test('a live gate refusal during Apply leaves the project and connection untouched', async (t) => {
  const { root, deps, calls, posted } = await setup();
  let denied = false;
  const guide = createGuideController({ ...deps, readPolicy: (now) => denied
    ? Promise.resolve({ view: { organization: 'failed', startingRules: false, issuedHere: false } })
    : deps.readPolicy(now) });
  t.after(() => guide.dispose());
  await guide.open();
  for (const event of answers) await guide.receive(event);
  await guide.receive({ type: 'choose', optionId: 'near-private' });
  await guide.receive({ type: 'review' });
  denied = true;
  await guide.receive({ type: 'apply' });
  assert.equal(readSetupGuide(root), undefined);
  assert.equal(calls.lands, 0);
  const after = posted.at(-1);
  assert.ok(after?.type === 'screen' && after.screen.kind === 'fix');
});

test('the guide checks the live policy before probing and shows its fix and contact', async (t) => {
  const { root, deps, calls, posted } = await setup();
  let denied = false;
  const guide = createGuideController({ ...deps, readPolicy: (now) => denied
    ? Promise.resolve({ view: {
      organization: 'failed', startingRules: false, issuedHere: false, failedSentence: 'The rules could not be verified.',
      failedContacts: [{ topic: 'security', name: 'Security Desk', how: 'security@example.test' }]
    } })
    : deps.readPolicy(now) });
  t.after(() => guide.dispose());
  await guide.open();
  for (const event of answers.slice(0, -1)) await guide.receive(event);
  denied = true;
  await guide.receive({ type: 'next' });
  const fix = posted.at(-1);
  assert.ok(fix?.type === 'screen' && fix.screen.kind === 'fix');
  assert.equal(fix.screen.sentence, 'The rules could not be verified.');
  assert.match(fix.screen.whoToAsk, /Security Desk/);
  assert.equal(calls.checks, 0);
  assert.equal(readSetupGuide(root), undefined);
});
