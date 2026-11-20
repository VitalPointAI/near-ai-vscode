// Every record names the policy version that decided it (Phase 41 D-10, T-41-134): bundle-2 under your organization's layer or a version 2 personal layer,
// bundle-1 otherwise, a failed-closed state included, from the one policyVersionOf in host.ts. The host stamps it on every record its sinks append (tool
// calls, mark raises, calls refused before the gate and model requests, all of which leave agent/gateAdapter.ts through the runtime's sink) and on its own
// label and policy events. Real files in temp folders; every key is made at test time (policyFixtures). Every fetch is a counting stub.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES, RunGrants as Grants } from '../agent/permissions';
import { gateToolCall, recordMarkRaised, recordRefusedBeforeGate } from '../agent/gateAdapter';
import { writeTool } from '../agent/tools';
import type { Label } from '../domain/gate/labels';
import { buildDecisionRecord, validateDecisionRecord } from '../domain/gate/record';
import type { DecisionRecord } from '../domain/gate/record';
import { GATE_DIR_NAME } from '../gate/bundleStore';
import { DECISIONS_DIR, INSTALL_LOG_KEY, MODEL_REQUESTS_DIR, projectLogKey } from '../gate/decisionLog';
import { GateHost } from '../gate/host';
import { ORGANIZATION_ISSUER_SECRET } from '../gate/organizationStore';
import { sessionRouteFrom, setDefaultSessionRoute, withSessionRoute } from '../gate/sessionMark';
import { NearAiClient } from '../services/nearAiClient';
import { enrolmentTextFor } from './helpers/enrolmentFixtures';
import { FIXED_NOW, issuerKey } from './helpers/policyFixtures';
import { MemorySecrets } from './helpers/teamHarness';

const NEAR = 'https://cloud-api.near.ai/v1';
const ORG_PUBLIC: Label = { scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] };
const ORG_INTERNAL: Label = { ...ORG_PUBLIC, level: 'Internal' };

interface PolicyWorld {
  readonly host: GateHost;
  readonly storage: string;
  readonly project: string;
  /** Every record of one log, in the order written, after the host's queue is flushed. */
  readonly read: (kind: 'project' | 'model-requests' | 'install') => Promise<DecisionRecord[]>;
}

/** A host started with the starting rules, under your organization's layer when `organization`, or with a damaged pin (a failed-closed start). */
async function withPolicyWorld(start: 'starting-rules' | 'organization' | 'failed-closed', work: (world: PolicyWorld) => Promise<void>): Promise<void> {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-policy-version-'));
  const project = path.join(storage, 'project');
  await mkdir(project, { recursive: true });
  const secrets = new MemorySecrets();
  if (start === 'failed-closed') await secrets.store(ORGANIZATION_ISSUER_SECRET, '{"v":1,"not":"a pin"}');
  const host = new GateHost({ globalStorageDir: storage, secrets, productVersion: '0.4.40-test', now: () => new Date(FIXED_NOW), projectRoot: () => project });
  try {
    await host.start();
    if (start === 'organization') assert.equal((await host.acceptOrganizationFile(enrolmentTextFor(issuerKey('policy-version')), { wordsConfirmed: true })).state, 'valid');
    if (start === 'failed-closed') assert.equal(host.bundleState().state, 'failed-closed');
    const read = async (kind: 'project' | 'model-requests' | 'install'): Promise<DecisionRecord[]> => {
      await host.flush();
      const folder = kind === 'model-requests' ? MODEL_REQUESTS_DIR : DECISIONS_DIR;
      const key = kind === 'install' ? INSTALL_LOG_KEY : projectLogKey(project);
      let text = '';
      try { text = await readFile(path.join(storage, GATE_DIR_NAME, folder, `${key}.jsonl`), 'utf8'); } catch { return []; }
      return text.trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as DecisionRecord);
    };
    await work({ host, storage, project, read });
  } finally {
    setDefaultSessionRoute(undefined);
    await host.flush().catch(() => undefined);
    await rm(storage, { recursive: true, force: true });
  }
}

const versionOf = (record: DecisionRecord | undefined): string | undefined => record?.authorizations[0]?.policy.version;
const ruleOf = (record: DecisionRecord | undefined): string | undefined => record?.authorizations[0]?.policy.name;

function onlyRule(records: readonly DecisionRecord[], rule: string): DecisionRecord {
  const found = records.filter((record) => ruleOf(record) === rule || record.api.operation === rule);
  assert.ok(found.length > 0, `a record of ${rule}; found ${records.map((record) => ruleOf(record)).join(', ')}`);
  return found[found.length - 1]!;
}

function assertVersion(record: DecisionRecord, version: string, what: string): void {
  assert.equal(versionOf(record), version, what);
  assert.equal(validateDecisionRecord(record).ok, true, `${what}: ${JSON.stringify(validateDecisionRecord(record))}`);
}

/** A NEAR AI Cloud client that serves a catalog and answers every content request. */
async function cloudClient(): Promise<NearAiClient> {
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'cloud-model' }] }), { status: 200 });
    if (method === 'GET') return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
  const client = new NearAiClient({ baseUrl: NEAR, apiKey: 'test-key', fetchFn, route: 'near' });
  await client.listModels();
  return client;
}

/** Writes one of each record the host's sinks and events carry: a tool call, a mark raise, a call refused before the gate, a label event, a policy event and two model requests. */
async function writeEveryKind(world: PolicyWorld): Promise<void> {
  const runtime = await world.host.runtimeFor({ root: world.project, actor: { kind: 'agent', sessionId: 'policy-version', agentLabel: 'agent' }, presence: 'person', context: 'interactive' });
  await gateToolCall(runtime, {
    tool: writeTool, raw: { file_path: 'notes.md', content: 'hello' }, root: world.project, callId: 'call-write', policy: { mode: 'approve-risky', emergencyStop: false },
    rules: DEFAULT_RULES, grants: new Grants(), buildAuto: async () => undefined
  });
  recordMarkRaised(runtime, [ORG_INTERNAL], 'Read');
  recordRefusedBeforeGate(runtime, { tool: 'no_such_tool', callId: 'call-unknown', rule: 'call.unknown-tool', reason: 'This run has no tool by that name.' });
  world.host.recordLabelEvent(world.project, { event: 'label.set', path: 'notes.md', label: ORG_INTERNAL, reason: 'A person set it.' });
  world.host.recordPolicyEvent('policy.migrated');
  const client = await cloudClient();
  const ask = () => client.completeOnce('cloud-model', [{ role: 'user', content: 'hello' }], { maxTokens: 16 });
  // Through the route of a run (the runtime's sink), and outside every route (the host's route for requests with no session).
  assert.equal((await withSessionRoute(sessionRouteFrom(runtime, { markOf: () => [ORG_PUBLIC] }), ask)).text, 'ok');
  setDefaultSessionRoute(world.host.sessionRouteWithoutContext());
  assert.equal((await ask()).text, 'ok');
}

test('D-10: under your organization\'s layer a tool call gated through a runtime from the host writes policy.version bundle-2', async () => {
  await withPolicyWorld('organization', async (world) => {
    await writeEveryKind(world);
    const records = await world.read('project');
    const call = records.find((record) => record.api.request?.uid === 'call-write');
    assert.ok(call !== undefined, 'the tool call was recorded');
    assertVersion(call, 'bundle-2', 'tool call');
  });
});

test('D-10: under your organization\'s layer a mark raise and a call refused before the gate write bundle-2', async () => {
  await withPolicyWorld('organization', async (world) => {
    await writeEveryKind(world);
    const records = await world.read('project');
    assertVersion(onlyRule(records, 'label.mark-raised'), 'bundle-2', 'mark raise');
    assertVersion(onlyRule(records, 'call.unknown-tool'), 'bundle-2', 'refused before the gate');
  });
});

test('D-10: under your organization\'s layer a label event and a policy event write bundle-2, in the project\'s log and the install log', async () => {
  await withPolicyWorld('organization', async (world) => {
    await writeEveryKind(world);
    assertVersion(onlyRule(await world.read('project'), 'label.set'), 'bundle-2', 'label event');
    assertVersion(onlyRule(await world.read('project'), 'policy.migrated'), 'bundle-2', 'policy event, project log');
    assertVersion(onlyRule(await world.read('install'), 'policy.migrated'), 'bundle-2', 'policy event, install log');
  });
});

test('D-10: under your organization\'s layer a model request through a run\'s route and through the route outside every session writes bundle-2', async () => {
  await withPolicyWorld('organization', async (world) => {
    await writeEveryKind(world);
    const requests = await world.read('model-requests');
    assert.equal(requests.length, 2);
    for (const request of requests) assertVersion(request, 'bundle-2', ruleOf(request) ?? 'model request');
    assert.deepEqual(requests.map((request) => ruleOf(request)), ['route.any-cloud', 'route.default-session']);
  });
});

test('D-10: with the starting rules every one of the same records says bundle-1', async () => {
  await withPolicyWorld('starting-rules', async (world) => {
    await writeEveryKind(world);
    const records = [...await world.read('project'), ...await world.read('model-requests'), ...await world.read('install')];
    assert.ok(records.length >= 9, String(records.length));
    for (const record of records) assertVersion(record, 'bundle-1', `${ruleOf(record) ?? '?'} (${record.api.operation})`);
  });
});

test('D-10: a failed-closed start\'s policy record says bundle-1', async () => {
  await withPolicyWorld('failed-closed', async (world) => {
    const install = await world.read('install');
    const failed = install.filter((record) => ruleOf(record) === 'bundle.failed-closed');
    assert.ok(failed.length > 0, install.map((record) => ruleOf(record)).join(', '));
    for (const record of failed) assertVersion(record, 'bundle-1', 'failed-closed start');
    // And so does every record a run writes while it is failed closed.
    await writeEveryKind(world).catch(() => undefined);
    for (const record of await world.read('project')) assert.equal(versionOf(record), 'bundle-1', ruleOf(record));
  });
});

test('D-10: the stamp changes nothing else in a record: what the sink is given and what the log keeps differ only in the version and the log\'s sequence', async () => {
  await withPolicyWorld('organization', async (world) => {
    const runtime = await world.host.runtimeFor({ root: world.project, actor: { kind: 'agent', sessionId: 'policy-version', agentLabel: 'agent' }, presence: 'person', context: 'interactive' });
    const given = buildDecisionRecord({
      recordId: 'rec-policy-version-1', sequence: 0, time: FIXED_NOW, productVersion: '0.4.40-test', actor: runtime.actor, callId: 'call-plain',
      capability: { verb: 'plan' }, resource: { name: 'plan', type: 'tool' }, outcome: 'denied', rule: 'call.check-failed', reason: 'The tool\'s own check could not run.', bundleHash: 'a'.repeat(64)
    });
    assert.equal(versionOf(given), 'bundle-1');
    runtime.sink.record(given);
    const kept = (await world.read('project')).find((record) => record.metadata.uid === 'rec-policy-version-1');
    assert.ok(kept !== undefined);
    const first = given.authorizations[0]!;
    const expected = { ...given, authorizations: [{ ...first, policy: { ...first.policy, version: 'bundle-2' } }, ...given.authorizations.slice(1)], metadata: { ...given.metadata, sequence: kept.metadata.sequence } };
    assert.deepEqual(kept, JSON.parse(JSON.stringify(expected)));
    assert.equal(versionOf(given), 'bundle-1', 'the record the sink was given is not changed in place');
  });
});
