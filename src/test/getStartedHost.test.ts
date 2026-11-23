import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { createProjectCredentialScope, type OrganizationProfile } from '../domain/auth';
import { DEFAULT_BASE_URL, type PrivacyModeSetting } from '../domain/config';
import type { GuideInbound, GuideOutbound } from '../domain/setup/guideMessages';
import { KIND_OF_WORK_STATE_KEY } from '../domain/setup/ids';
import { createSetupRegistries } from '../domain/setup/registries';
import type { OptionCheckInput } from '../domain/setup/viability';
import { GATE_DIR_NAME } from '../gate/bundleStore';
import { projectLogKey } from '../gate/decisionLog';
import { SETUP_AUDIT_DIR } from '../gate/setupAuditLog';
import { AuthService } from '../services/auth';
import { memoryOnlyDeviceProvider } from '../services/setup/deviceFacts';
import { createProjectGetStartedDeps } from '../services/setup/getStartedRun';
import { createGuideController } from '../services/setup/guideController';
import { createGateGuideChecks, routeFactsOf } from '../services/setup/guideFacts';
import { readSetupGuide } from '../services/setup/projectStore';

import { at, local, near, setup } from './helpers/getStartedHostFixture';
import { MemorySecrets } from './helpers/teamHarness';

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

test('Gate-backed checks use the current signed snapshot and cancel the registered sources', async () => {
  const { host, root } = await setup();
  const registries = createSetupRegistries();
  let privacy: PrivacyModeSetting = 'tee-only';
  const device = await memoryOnlyDeviceProvider({ hostKind: 'container', totalmem: () => 16e9 }).read();
  registries.devices.register({ id: 'fixture-device', rank: 1, async read(signal) {
    assert.equal(signal?.aborted, false);
    return device;
  } });
  const identify = () => assert.fail('the fake source must not probe');
  const checks = createGateGuideChecks({
    gate: host, root, privacy: () => privacy, hostKind: 'container', registries, identify, clock: () => at
  });
  const snapshot = await checks.readPolicy(at);
  assert.ok('route' in snapshot);
  assert.equal(snapshot.floor, 'attested-cloud');
  let sourceCalls = 0;
  let abandonSource!: () => void;
  let sourceStarted!: () => void;
  const stalled = new Promise<void>((resolve) => { abandonSource = resolve; });
  const started = new Promise<void>((resolve) => { sourceStarted = resolve; });
  let sourceSignal: AbortSignal | undefined;
  let sourceInput: OptionCheckInput | undefined;
  registries.options.register({ id: 'fixture', kinds: ['this-computer'], async check(input, signal) {
    sourceCalls++;
    sourceInput = input;
    sourceSignal = signal;
    sourceStarted();
    await stalled;
    input.progress(local);
    return local;
  } });

  privacy = 'standard';
  await assert.rejects(checks.check(snapshot, () => assert.fail('stale snapshot published progress'),
    new AbortController().signal), /project rules changed/);
  assert.equal(sourceCalls, 0);
  privacy = 'tee-only';
  const controller = new AbortController();
  const progress: string[] = [];
  const running = checks.check(snapshot, (result) => progress.push(result.optionId), controller.signal);
  await Promise.race([started, running.then(() => assert.fail('the blocked source finished'))]);
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(sourceSignal?.aborted, true);
  abandonSource();
  await nextTurn();
  assert.ok(sourceInput);
  assert.equal(sourceInput.hostKind, 'container');
  assert.equal(sourceInput.device, device);
  assert.equal(sourceInput.identify, identify);
  assert.equal(sourceInput.policyHash, snapshot.hash);
  assert.equal(sourceInput.floorOn, true);
  assert.deepEqual(sourceInput.endpoints, snapshot.route.endpoints);
  assert.deepEqual(sourceInput.candidates, []);
  assert.deepEqual(progress, []);
  assert.equal(sourceCalls, 1);
});

test('the Get Started run factory binds profile, writes and cancellation to the captured project', async () => {
  const { host, root, storage } = await setup();
  const otherRoot = await mkdtemp(path.join(tmpdir(), 'near-started-other-'));
  const auth = new AuthService(new MemorySecrets());
  const profile: OrganizationProfile = {
    version: 1, profileId: 'profile-fixture', displayName: 'Fixture', organization: 'Fixture', provider: 'near-ai',
    baseUrl: DEFAULT_BASE_URL, authMode: 'apiKey', validation: { status: 'valid' },
    createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString()
  };
  const scopeFor = (projectRoot: string) => createProjectCredentialScope(projectRoot, profile.profileId);
  await auth.saveScopedApiKey(scopeFor(root), 'fixture-first', DEFAULT_BASE_URL);
  await auth.saveScopedApiKey(scopeFor(otherRoot), 'fixture-other', DEFAULT_BASE_URL);
  let chosenRoot = root;
  let firstProfile = true;
  const configured: string[] = [];
  const requests: (string | null)[] = [];
  let notifyRequest!: () => void;
  const otherRequest = new Promise<void>((resolve) => { notifyRequest = resolve; });
  let otherSignal: AbortSignal | null | undefined;
  const unexpected = () => assert.fail('the fixture must not probe or modify profiles');
  const factory = createProjectGetStartedDeps({
    project: () => ({ root: chosenRoot, name: 'Fixture' }), gate: host, auth, globalStorageDir: storage,
    hostKind: 'container', machine: 'fixture', privacy: () => 'standard', clock: () => at,
    landing: () => ({ land: unexpected }), onAuditFailure: unexpected,
    local: { identify: unexpected, listModels: unexpected, localClient: unexpected },
    configureConnection: async (projectRoot) => { configured.push(projectRoot); firstProfile = true; return true; },
    profiles: (projectRoot) => ({
      getScope: () => scopeFor(projectRoot),
      getActiveProfile: async () => projectRoot === root && !firstProfile ? undefined : profile,
      list: async () => [], select: unexpected, configure: unexpected,
    }),
    fetchFn: async (_url, init) => {
      const credential = new Headers(init?.headers).get('authorization');
      requests.push(credential);
      if (credential !== 'Bearer fixture-other') return Response.json({ data: [] });
      otherSignal = init?.signal;
      notifyRequest();
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
    },
  });
  const registries = createSetupRegistries();
  const first = factory.createRun(undefined, registries);
  chosenRoot = otherRoot;
  const second = factory.createRun(undefined, registries);
  assert.deepEqual([first.root, second.root], [root, otherRoot]);
  const firstPolicy = await first.readPolicy(at);
  assert.ok('route' in firstPolicy);
  (await first.check(firstPolicy, () => {}, new AbortController().signal)).dispose();
  assert.deepEqual(requests, ['Bearer fixture-first', 'Bearer fixture-first']);
  assert.equal(first.apply.connection({ ...near, kind: 'org-server' }), undefined);
  firstProfile = false;
  assert.equal((await first.apply.connection(near)?.run())?.outcome, 'done');
  assert.deepEqual(configured, [root]);
  const written = await first.apply.audit.append('setup.guide.abandoned', { answers: {}, screen: 'kind-of-work', hostKind: 'container' });
  assert.equal(written.ok, true);
  const audit = await readFile(path.join(storage, GATE_DIR_NAME, SETUP_AUDIT_DIR, projectLogKey(root) + '.jsonl'), 'utf8');
  assert.match(audit, /setup\.guide\.abandoned/);
  assert.doesNotMatch(audit, /fixture-first|fixture-other/);

  const secondPolicy = await second.readPolicy(at);
  assert.ok('route' in secondPolicy);
  const abort = new AbortController();
  const running = second.check(secondPolicy, unexpected, abort.signal);
  await Promise.race([otherRequest, running.then(() => assert.fail('the fixture request did not start'))]);
  abort.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(otherSignal?.aborted, true);
  assert.deepEqual(requests, ['Bearer fixture-first', 'Bearer fixture-first', 'Bearer fixture-other']);
});

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

test('Get Started opens one kit panel, validates messages, and resumes a closed panel from workspace state', async () => {
  const { deps, host, root, audit } = await setup();
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
  const workspace = new Map<string, unknown>();
  let waitToSave = Promise.resolve();
  const personal = new Map<string, unknown>();
  const context = { extensionUri: uri('/extension') as never, globalState: {
    get<T>(key: string): T | undefined { return personal.get(key) as T | undefined; },
    async update(key: string, value: unknown) { personal.set(key, value); },
    keys: () => [...personal.keys()],
    setKeysForSync() {}
  }, workspaceState: {
    get<T>(key: string): T | undefined { return workspace.get(key) as T | undefined; },
    async update(key: string, value: unknown) {
      await waitToSave;
      if (value === undefined) workspace.delete(key);
      else workspace.set(key, JSON.parse(JSON.stringify(value)));
    },
    keys: () => [...workspace.keys()]
  } };
  const originalPolicy = registrar.gateGuidePolicy(host, root, () => 'standard');
  let denied = false;
  const readPolicy: typeof originalPolicy = (now) => denied
    ? Promise.resolve({ view: { organization: 'failed', startingRules: false, issuedHere: false } })
    : originalPolicy(now);
  let project = { ...deps, readPolicy };
  const registries = createSetupRegistries();
  const providedDevice = { ...memoryOnlyDeviceProvider(), id: 'provided', rank: 1 };
  registries.devices.register(providedDevice);
  const unexpectedCheck = () => assert.fail('registration must not check a source');
  let failProjectLoad = true;
  const run = registrar.registerGetStarted(context, {
    registries,
    sources: {
      local: { identify: unexpectedCheck, listModels: unexpectedCheck, localClient: unexpectedCheck },
      near: { hasKey: unexpectedCheck, client: unexpectedCheck, binding: unexpectedCheck, baseUrl: unexpectedCheck },
      device: { platform: () => 'linux', hostKind: 'container', totalmem: () => 16_000_000_000 }
    },
    createRun(_request, active) {
      assert.equal(active, registries);
      assert.deepEqual(active.options.active().map(({ id }) => id), ['local-servers', 'near-ai']);
      assert.deepEqual(active.devices.list().map(({ id }) => id), ['provided', 'memory-only']);
      if (failProjectLoad) throw new Error('fixture project load failed');
      return project;
    }
  });
  try {
    assert.deepEqual(registries.options.active(), []);
    await assert.rejects(run.openGetStarted(), /fixture project load failed/);
    assert.deepEqual(registries.options.active(), []);
    assert.deepEqual(registries.devices.list(), [providedDevice]);
    assert.equal(views, 0);
    failProjectLoad = false;
    await run.openGetStarted();
    const fallback = registries.devices.list().find(({ id }) => id === 'memory-only');
    assert.ok(fallback);
    const device = await fallback.read();
    assert.equal(device.hostKind, 'container');
    assert.equal(device.totalMemoryBytes, 16_000_000_000);
    assert.equal(registries.devices.best(), providedDevice);
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

    const token = `sk-${'f'.repeat(24)}`; // secret-scan: allow (fictional fixture)
    await handlers.receive?.({ type: 'answer', key: 'kindOfWork', value: 'something-else' });
    await handlers.receive?.({ type: 'answer', key: 'otherKind', value: `Research ${token}` });
    assert.deepEqual(personal.get(KIND_OF_WORK_STATE_KEY), { kindOfWork: 'something-else', otherKind: 'Research [REDACTED]' });
    await handlers.receive?.({ type: 'next' });
    let finishSave!: () => void;
    waitToSave = new Promise<void>((resolve) => { finishSave = resolve; });
    panel.dispose();
    const reopened = run.openGetStarted();
    assert.equal(views, 1);
    denied = true;
    finishSave();
    await reopened;
    const fix = posted.at(-1);
    assert.ok(fix?.type === 'screen' && fix.screen.kind === 'fix');
    assert.equal(workspace.size, 1);
    const saved = JSON.stringify([...workspace]);
    assert.ok(saved.includes('Research [REDACTED]'));
    assert.ok(!saved.includes(token) && !saved.includes(root));
    panel.dispose();

    denied = false;
    await run.openGetStarted();
    const resumed = posted.at(-1);
    assert.ok(resumed?.type === 'screen' && resumed.screen.kind === 'question');
    assert.equal(resumed.screen.screen, 'data');
    await handlers.receive?.({ type: 'back' });
    const kind = posted.at(-1);
    assert.ok(kind?.type === 'screen' && kind.screen.kind === 'question');
    assert.deepEqual(kind.screen.fields.find(({ key }) => key === 'otherKind')?.selected, ['Research [REDACTED]']);
    await handlers.receive?.({ type: 'abandon' });
    await handlers.receive?.({ type: 'abandon' });
    const chain = await audit.verify();
    assert.ok(chain.ok);
    assert.equal(chain.head?.seq, 1);
    panel.dispose();
    await run.openGetStarted();
    const restarted = posted.at(-1);
    assert.ok(restarted?.type === 'screen' && restarted.screen.kind === 'question');
    assert.equal(restarted.screen.screen, 'kind-of-work');
    assert.equal(workspace.size, 0);

    await handlers.receive?.({ type: 'answer', key: 'kindOfWork', value: 'writing' });
    assert.deepEqual([...personal.keys()], [KIND_OF_WORK_STATE_KEY]);
    assert.deepEqual(personal.get(KIND_OF_WORK_STATE_KEY), { kindOfWork: 'writing' });
    panel.dispose();
    project = (await setup()).deps;
    await run.openGetStarted();
    const anotherProject = posted.at(-1);
    assert.ok(anotherProject?.type === 'screen' && anotherProject.screen.kind === 'question');
    assert.deepEqual(anotherProject.screen.fields[0].selected, ['writing']);
    await handlers.receive?.({ type: 'answer', key: 'kindOfWork', value: 'analysis' });
    const changed = posted.at(-1);
    assert.ok(changed?.type === 'screen' && changed.screen.kind === 'question');
    assert.deepEqual(changed.screen.fields[0].selected, ['analysis']);
  } finally { run.dispose(); }
  assert.deepEqual(registries.options.active(), []);
  assert.deepEqual(registries.devices.list(), [providedDevice]);
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
