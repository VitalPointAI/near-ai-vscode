import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';
import type { GuideInbound, GuideOutbound } from '../domain/setup/guideMessages';
import { createGuideController } from '../services/setup/guideController';
import { routeFactsOf } from '../services/setup/guideFacts';
import { readSetupGuide } from '../services/setup/projectStore';

import { at, local, near, setup } from './helpers/getStartedHostFixture';

test('route facts use the observed option and do not invent an unavailable route', () => {
  assert.equal(routeFactsOf(local, at), undefined);
  const fact = routeFactsOf(near, at);
  assert.equal(fact?.clientRoute, 'near');
  assert.equal(fact?.host, near.routeFacts?.host);
  assert.equal(fact?.nearEndpoint, true);
  assert.equal(fact?.now, at);
  assert.deepEqual(fact?.model, near.routeFacts?.model);
  assert.deepEqual(fact?.binding, near.routeFacts?.binding);
});

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
