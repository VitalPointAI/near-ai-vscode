// GUIDE-03, GUIDE-06, GUIDE-07: pure setup contract tracer tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSetupRegistries } from '../domain/setup/registries';
import { createServerAdapterRegistry, identifyFromAnswers, matchSignature, SERVER_PROBE_TABLE } from '../domain/setup/servers';
import { fromLegacyStep } from '../domain/setup/steps';
import { initialViability, isChoosable, nextViability } from '../domain/setup/viability';
import { discoveryWays, listedNetworkOf } from '../domain/setup/network';
import { cleanFreeText, derivedLocality, parseGuideAnswers, parseGuidePrefill, parseSetupGuideEntry } from '../domain/setup/answers';
import { AUDIT_EVENT_IDS, createAuditEventRegistry, GUIDE_AUDIT_EVENT_SPECS, validateAuditBody } from '../domain/setup/records';
import { contactsFor, GENERIC_CONTACT_TEXT, readGuidePolicy } from '../domain/setup/policy';

test('D-01: a registered option source reaches a choosable option', async () => {
  const registries = createSetupRegistries();
  registries.options.register({
    id: 'fake-local',
    kinds: ['this-computer'],
    async check() {
      const started = nextViability(initialViability('this-computer', 'this-computer', 'desktop'), { type: 'start', at: 1_000 });
      return nextViability(started, { type: 'answered', at: 1_000, models: [{ id: 'example-model' }] });
    }
  });
  const source = registries.options.active()[0];
  assert.ok(source);
  const result = await source.check({} as never, new AbortController().signal);
  assert.equal(isChoosable(result, 600_999), true);
  assert.equal(isChoosable(result, 601_000), false);
});

test('owner viability rule: checks stop at the first failure', () => {
  const initial = initialViability('this-computer', 'this-computer', 'desktop');
  for (const [check, state] of [['detected', 'not-detected'], ['configured', 'not-configured'], ['allowed', 'not-allowed'], ['answered', 'test-failed']] as const) {
    const result = nextViability(initial, { type: 'failed', at: 1, check, reasonCode: 'test-failed' });
    assert.equal(result.state, state);
    assert.equal(result.failedAt, check);
    assert.equal(isChoosable(result, 1), false);
  }
});

test('GUIDE 8.6: viable goes stale for time, network, server, and policy changes', () => {
  const viable = nextViability(nextViability(initialViability('this-computer', 'this-computer', 'desktop'), { type: 'start', at: 1 }), { type: 'answered', at: 2, models: [] });
  for (const event of [
    { type: 'tick', at: 600_002 },
    { type: 'network-changed', at: 3 },
    { type: 'server-stopped', at: 3 },
    { type: 'policy-changed', at: 3, policyHash: 'next' }
  ] as const) {
    const stale = nextViability(viable, event);
    assert.equal(stale.state, 'stale');
  }
  assert.equal(nextViability(nextViability(viable, { type: 'tick', at: 600_002 }), { type: 'start', at: 600_003 }).state, 'checking');
});

test('D-41: sources and device providers can be superseded', () => {
  const registries = createSetupRegistries();
  registries.options.register({ id: 'first', kinds: ['this-computer'], async check() { return initialViability('this-computer', 'this-computer', 'desktop'); } });
  registries.options.register({ id: 'second', kinds: ['this-computer'], supersedes: ['first'], async check() { return initialViability('this-computer', 'this-computer', 'desktop'); } });
  assert.deepEqual(registries.options.active().map((source) => source.id), ['second']);
  registries.devices.register({ id: 'low', rank: 1, async read() { return {} as never; } });
  registries.devices.register({ id: 'high', rank: 2, async read() { return {} as never; } });
  assert.equal(registries.devices.best()?.id, 'high');
});

test('disposing an old setup registration again keeps its replacement', () => {
  const registries = createSetupRegistries();
  const source = { id: 'local', kinds: ['this-computer'] as const, async check() {
    return initialViability('this-computer', 'this-computer', 'desktop');
  } };
  const provider = { id: 'device', rank: 1, async read() { return {} as never; } };
  const factory = () => ({ endpoint: {} as never });
  const spec = { id: 'local-models.installed' as const, required: [], optional: [] };
  const old = [
    registries.options.register(source), registries.devices.register(provider),
    registries.servers.register('ollama', factory), registries.events.register(spec),
  ];
  for (const registration of old) registration.dispose();
  registries.options.register(source);
  registries.devices.register(provider);
  registries.servers.register('ollama', factory);
  registries.events.register(spec);
  for (const registration of old) registration.dispose();
  assert.deepEqual(registries.options.active(), [source]);
  assert.deepEqual(registries.devices.list(), [provider]);
  assert.equal(registries.servers.get('ollama'), factory);
  assert.equal(registries.events.specFor(spec.id), spec);
});

test('Phase 33 overlap: a legacy step adapts into the new contract', async () => {
  const calls: string[] = [];
  const step = fromLegacyStep({
    id: 'example', label: 'Example', detail: 'Example detail', icon: 'symbol-event', command: 'example.run', isDone: () => true
  }, async (command) => { calls.push(command); });
  const context = { setting: () => undefined, facts: {} };
  assert.equal(step.title, 'Example');
  assert.equal(await step.state(context), 'done');
  assert.deepEqual(await step.viability(context), { available: true });
  await step.run(context);
  assert.deepEqual(calls, ['example.run']);
});

test('32.2 D-27: one row per server and ports are data', () => {
  assert.deepEqual(SERVER_PROBE_TABLE.map((row) => row.kind), ['ollama', 'llama-cpp', 'lemonade', 'lm-studio', 'vllm', 'nim', 'localai', 'jan', 'openai-compatible']);
  assert.deepEqual(SERVER_PROBE_TABLE.find((row) => row.kind === 'ollama')?.ports, [11434]);
  assert.equal(SERVER_PROBE_TABLE.some((row) => row.signatures.some((signature) => signature.path === '/health')), false);
});

test('32.2 D-27: shared ports require exactly one signature match', () => {
  assert.deepEqual(identifyFromAnswers(8000, [{ kind: 'vllm', path: '/version', status: 200, body: { version: '0.9' } }]), { state: 'identified', kind: 'vllm', version: '0.9' });
  assert.deepEqual(identifyFromAnswers(8000, [{ kind: 'vllm', path: '/version', status: 200, body: { version: '0.9' } }, { kind: 'nim', path: '/v1/health/ready', status: 200, body: { ready: true } }, { kind: 'nim', path: '/v1/metadata', status: 200, body: { name: 'nim' } }]), { state: 'unknown-server' });
  assert.deepEqual(identifyFromAnswers(1337, [{ kind: 'jan', path: '/v1/models', status: 401 }]), { state: 'needs-key' });
  assert.deepEqual(identifyFromAnswers(8000, []), { state: 'no-answer' });
});

test('matchSignature reads shapes, not status alone', () => {
  assert.deepEqual(matchSignature('ollama-version', 200, { version: '0.12.3' }), { version: '0.12.3' });
  assert.equal(matchSignature('ollama-version', 500, { version: '0.12.3' }), undefined);
  assert.equal(matchSignature('ollama-version', 200, { version: 3 }), undefined);
});

test('D-44: listed networks and discovery ways are policy scoped', () => {
  const discovery = { networks: [{ id: 'office', dnsSuffix: 'corp.example.org' }], announce: true, scanRanges: [{ cidr: '192.0.2.0/24', network: 'office' }], personalApprovals: false };
  const listed = listedNetworkOf({ dnsSearch: ['CORP.example.org.'], source: 'linux' }, discovery);
  assert.equal(listed?.id, 'office');
  assert.deepEqual(discoveryWays(discovery, { dnsSearch: ['none.example'], source: 'linux' }), { named: true, announce: false, scanRanges: [], reason: 'network-not-listed' });
  assert.deepEqual(discoveryWays(undefined, { dnsSearch: [], source: 'linux' }), { named: true, announce: false, scanRanges: [], reason: 'no-discovery-section' });
});

test('adapter registry refuses duplicate server kinds', () => {
  const registry = createServerAdapterRegistry();
  const factory = () => ({ endpoint: {} as never });
  registry.register('ollama', factory);
  assert.equal(registry.get('jan'), undefined);
  assert.throws(() => registry.register('ollama', factory));
});

test('D-15: failed closed policy exposes only its fix and contacts', () => {
  const policy = readGuidePolicy({ organization: 'failed', failedSentence: 'Fix this', failedContacts: [{ topic: 'security', name: 'Security', how: 'example.org' }], startingRules: false, issuedHere: false });
  assert.deepEqual(policy, { state: 'failed-closed', sentence: 'Fix this', contacts: [{ topic: 'security', name: 'Security', how: 'example.org' }] });
});

test('D-15: policy contacts keep topic order and generic copy is stable', () => {
  const policy = readGuidePolicy({ organization: 'failed', failedContacts: [{ topic: 'security', name: 'Security', how: 'example.org' }], startingRules: false, issuedHere: false });
  assert.equal(contactsFor(policy, 'security').length, 1);
  assert.equal(GENERIC_CONTACT_TEXT, "your organization's security officer");
});

test('GUIDE-01: answers reject unknown shapes and normalize unique data', () => {
  assert.equal(parseGuideAnswers({ data: ['public', 'internal'] })?.data.join(','), 'public,internal');
  assert.equal(parseGuideAnswers({ data: ['public', 'public'] }), undefined);
  assert.equal(parseGuideAnswers({ data: [], unexpected: true }), undefined);
});

test('D-14: free text removes controls and redacts a fake secret', () => {
  assert.equal(cleanFreeText('ok\u0000 sk-abcdefghijklmnopqrstuvwx', 60), 'ok [REDACTED]');
});

test('D-39: prefill accepts known fixed answers only', () => {
  assert.deepEqual(parseGuidePrefill({ projectName: 'Example', fixed: [] }), { projectName: 'Example', section: undefined, fixed: [] });
  assert.equal(parseGuidePrefill({ fixed: ['unknown'] }), undefined);
});

test('setupGuide entries pin v1 and known option ids', () => {
  assert.ok(parseSetupGuideEntry({ v: 1, answers: { data: [] }, chosen: ['this-computer'], pending: [] }));
  assert.equal(parseSetupGuideEntry({ v: 2, answers: { data: [] }, chosen: [], pending: [] }), undefined);
});

test('D-38: derived locality follows chosen option locations', () => {
  assert.equal(derivedLocality(['this-computer']), 'local');
  assert.equal(derivedLocality(['near-private']), 'cloud');
  assert.equal(derivedLocality(['this-computer', 'near-private']), 'hybrid');
});

test('D-19: audit registry only accepts closed event ids', () => {
  assert.equal(AUDIT_EVENT_IDS.length, 10);
  const registry = createAuditEventRegistry();
  assert.throws(() => registry.register({ id: 'setup.other' as never, required: [], optional: [] }));
  registry.register({ id: 'local-models.installed', required: [], optional: [] });
});

test('D-19: audit bodies reject unknown keys, paths, and URLs', () => {
  const spec = GUIDE_AUDIT_EVENT_SPECS[1];
  assert.ok(spec);
  assert.equal(validateAuditBody(spec, { answers: ['public'], screen: 'data', hostKind: 'desktop' }), true);
  assert.equal(validateAuditBody(spec, { answers: [], screen: '/tmp/no', hostKind: 'desktop' }), false);
  assert.equal(validateAuditBody(spec, { answers: [], screen: 'https://example.org', hostKind: 'desktop' }), false);
  assert.equal(validateAuditBody(spec, { answers: [], screen: 'done', hostKind: 'desktop', extra: true }), false);
});
