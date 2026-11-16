// Decision record tests (GATE-07, D-20, D-21): the OCSF-shaped record, its ids per verb and outcome, redaction, the validator, and one frozen golden record. A
// change to the golden literal is a change to recordVersion 1 and needs a recordVersion 2 beside it. Token-shaped strings are built at run time, never written.
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize } from '../domain/team/canonical';
import { CAPABILITY_VERBS } from '../domain/gate/vocabulary';
import type { Capability } from '../domain/gate/vocabulary';
import type { ActorRef } from '../domain/gate/decide';
import {
  DECISION_OUTCOMES, OCSF_API_ACTIVITY, OCSF_VERSION, RECORD_VERSION, buildDecisionRecord, outcomeOf, redactRecord, validateDecisionRecord
} from '../domain/gate/record';
import type { DecisionOutcome, DecisionRecord, DecisionRecordInput } from '../domain/gate/record';

const NOW = 1794830400000;
const HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const PERSON: ActorRef = { kind: 'person', deviceFingerprint: 'dev-0123456789abcdef0123456789abcdef', sessionId: 'session-1' };

function inputFor(capability: Capability, overrides: Partial<DecisionRecordInput> = {}): DecisionRecordInput {
  return {
    recordId: 'rec-1', sequence: 0, time: NOW, productVersion: '0.4.25', actor: PERSON, callId: 'call-1', capability, resource: { name: 'src/app.ts', type: 'file' },
    outcome: 'allowed', rule: 'settings.mode.other', bundleHash: HASH, ...overrides
  };
}

// One valid example of every verb, in the order of CAPABILITY_VERBS.
const EXAMPLES: Readonly<Record<string, Capability>> = {
  read: { verb: 'read', paths: ['src/**'] },
  plan: { verb: 'plan' },
  workspaceWrite: { verb: 'workspaceWrite', paths: ['src/**'] },
  shell: { verb: 'shell', cwd: 'workspace' },
  network: { verb: 'network', hosts: ['example.org'] },
  mcp: { verb: 'mcp', server: 'docs', tools: ['search'] },
  send: { verb: 'send', channel: 'email' },
  publish: { verb: 'publish', target: 'registry' },
  destroy: { verb: 'destroy', paths: ['build/**'] },
  spawn: { verb: 'spawn', agent: 'reviewer' },
  schedule: { verb: 'schedule', maxPerDay: 4 },
  'skill.write': { verb: 'skill.write', scope: 'team' },
  spend: { verb: 'spend', nanoUsdPerRun: 5000000 },
  useSecret: { verb: 'useSecret', handle: 'deploy-token' },
  infer: { verb: 'infer', tier: 'any-cloud', provider: 'example', model: 'example-model' }
};

test('activity ids: read and plan are 2, a workspace write is 3, destroy is 4, every other verb is 99 named by the verb, and type_uid is 600300 plus the activity', () => {
  const expected: Record<string, number> = { read: 2, plan: 2, workspaceWrite: 3, destroy: 4 };
  for (const verb of CAPABILITY_VERBS) {
    if (verb === 'gpu') continue;
    const record = buildDecisionRecord(inputFor(EXAMPLES[verb] as Capability));
    const id = expected[verb] ?? 99;
    assert.equal(record.activity_id, id, verb);
    assert.equal(record.type_uid, 600300 + id, verb);
    assert.equal(record.class_uid, 6003);
    assert.equal(record.category_uid, 6);
    assert.equal(record.api.operation, verb);
    if (id === 99) assert.equal(record.activity_name, verb);
    assert.equal(validateDecisionRecord(record).ok, true, verb);
  }
  assert.equal(OCSF_API_ACTIVITY.class_uid, 6003);
  assert.equal(OCSF_VERSION, '1.9.0');
  assert.equal(RECORD_VERSION, 1);
});

test('outcome ids: allowed 1/1, asked 3 with its detail, approved 1/8, denied 2/25, refused-by-floor 2/2, and a clearance failure 2/26', () => {
  const write: Capability = { verb: 'workspaceWrite', paths: ['src/a.ts'] };
  const table: Record<DecisionOutcome, [number, number, number | undefined, number]> = {
    allowed: [1, 1, undefined, 1], asked: [3, 3, undefined, 3], approved: [1, 8, undefined, 3], denied: [2, 25, undefined, 4], 'refused-by-floor': [2, 2, undefined, 4]
  };
  assert.deepEqual([...DECISION_OUTCOMES].sort(), Object.keys(table).sort());
  for (const outcome of DECISION_OUTCOMES) {
    const record = buildDecisionRecord(inputFor(write, { outcome }));
    const [action, disposition, , severity] = table[outcome];
    assert.equal(record.action_id, action, outcome);
    assert.equal(record.disposition_id, disposition, outcome);
    assert.equal(record.severity_id, severity, outcome);
    assert.equal(record.status_id, action === 1 || outcome === 'asked' ? 1 : 2, outcome);
  }
  assert.equal(buildDecisionRecord(inputFor(write, { outcome: 'asked' })).status_detail, 'waiting for a person');
  const unauthorized = buildDecisionRecord(inputFor(write, { outcome: 'denied', clearanceFailure: true, reason: 'Your clearance does not cover this label.' }));
  assert.equal(unauthorized.action_id, 2);
  assert.equal(unauthorized.disposition_id, 26);
  assert.equal(unauthorized.status_detail, 'Your clearance does not cover this label.');
  assert.equal(buildDecisionRecord(inputFor(write, { outcome: 'refused-by-floor', clearanceFailure: true })).disposition_id, 2, 'only a plain denial becomes unauthorized');
});

test('asked and approved for one call are two records with one call id, and refused-by-floor differs from denied', () => {
  const write: Capability = { verb: 'workspaceWrite', paths: ['.git/hooks/pre-commit'] };
  const asked = buildDecisionRecord(inputFor(write, { outcome: 'asked', recordId: 'rec-a', sequence: 1, rule: 'floor.protected-write' }));
  const approved = buildDecisionRecord(inputFor(write, { outcome: 'approved', recordId: 'rec-b', sequence: 2, rule: 'floor.protected-write' }));
  assert.equal(asked.api.request.uid, approved.api.request.uid);
  assert.notEqual(asked.metadata.uid, approved.metadata.uid);
  assert.notEqual(asked.disposition_id, approved.disposition_id);
  const refused = buildDecisionRecord(inputFor(write, { outcome: 'refused-by-floor', rule: 'floor.protected-write' }));
  const denied = buildDecisionRecord(inputFor(write, { outcome: 'denied', rule: 'settings.deny-list' }));
  assert.deepEqual([refused.action_id, refused.disposition_id], [2, 2]);
  assert.deepEqual([denied.action_id, denied.disposition_id], [2, 25]);
});

test('outcomeOf maps a gate decision to what is recorded, and a floor refusal is its own outcome', () => {
  assert.equal(outcomeOf({ outcome: 'allow', floor: false }), 'allowed');
  assert.equal(outcomeOf({ outcome: 'ask', floor: true }), 'asked');
  assert.equal(outcomeOf({ outcome: 'deny', floor: true }), 'refused-by-floor');
  assert.equal(outcomeOf({ outcome: 'deny', floor: false }), 'denied');
});

test('the record carries the actor, the agent, the resource, the rule, the bundle hash and the session label', () => {
  const label = { scale: 'org', level: 'Restricted', compartments: ['HR'], releasability: [], handling: ['local-only'] };
  const sub: ActorRef = { kind: 'sub-agent', deviceFingerprint: PERSON.deviceFingerprint, sessionId: 'session-9', agentId: 'agent-3', agentLabel: 'Builder' };
  const record = buildDecisionRecord(inputFor(EXAMPLES.read as Capability, { actor: sub, model: { name: 'example-model', provider: 'example' }, label, tier: 'local-only', rule: 'settings.read-plan' }));
  assert.equal(record.actor.user.uid, PERSON.deviceFingerprint);
  assert.equal(record.actor.session.uid, 'session-9');
  assert.deepEqual(record.ai_agent, { name: 'Builder', uid: 'agent-3', instance_uid: 'session-9', ai_model: { name: 'example-model', ai_provider: 'example' } });
  assert.deepEqual(record.metadata.profiles, ['ai_operation']);
  assert.deepEqual(record.metadata.data_classifications, [{ confidentiality: 'org/Restricted', confidentiality_id: 99, category_id: 99 }]);
  assert.equal(record.authorizations[0]?.policy.name, 'settings.read-plan');
  assert.equal(record.authorizations[0]?.policy.uid, HASH);
  assert.equal(record.authorizations[0]?.policy.version, 'bundle-1');
  assert.equal(record.unmapped.nearAi.bundleHash, HASH);
  assert.equal(record.unmapped.nearAi.recordVersion, 1);
  assert.deepEqual(record.unmapped.nearAi.label, label);
  assert.equal(record.unmapped.nearAi.tier, 'local-only');
  assert.equal(record.src_endpoint.name, 'near-ai-vscode');
  assert.equal(buildDecisionRecord(inputFor(EXAMPLES.read as Capability)).ai_agent, undefined, 'a person has no agent block');
  assert.equal(buildDecisionRecord(inputFor(EXAMPLES.read as Capability)).metadata.data_classifications, undefined);
});

test('a token-shaped string in a reason is redacted before the record exists, and the validator refuses an unredacted one', () => {
  const token = `sk-${'a1B2c3D4'.repeat(4)}`;
  const record = buildDecisionRecord(inputFor(EXAMPLES.shell as Capability, { outcome: 'denied', reason: `The command used ${token} directly.`, resource: { name: `run --key ${token}`, type: 'command' } }));
  const text = JSON.stringify(record);
  assert.ok(!text.includes(token));
  assert.match(record.status_detail ?? '', /\[REDACTED\]/);
  assert.equal(validateDecisionRecord(record).ok, true);
  const leaked = { ...record, status_detail: `The command used ${token} directly.` };
  const refused = validateDecisionRecord(leaked);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, 'not-allowed-here');
  assert.ok(!JSON.stringify(redactRecord(leaked as DecisionRecord)).includes(token));
});

test('the validator accepts only whole numbers, the class arithmetic, every required key and the right versions', () => {
  const good = buildDecisionRecord(inputFor(EXAMPLES.spend as Capability));
  assert.equal(validateDecisionRecord(good).ok, true);
  const copy = (): Record<string, unknown> => JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
  const fraction = { ...copy(), time: 1.5 };
  assert.equal(validateDecisionRecord(fraction).ok, false);
  const nested = copy();
  (nested.unmapped as { nearAi: { capability: { nanoUsdPerRun: number } } }).nearAi.capability.nanoUsdPerRun = 0.25;
  const fractional = validateDecisionRecord(nested);
  assert.equal(fractional.ok, false);
  if (!fractional.ok) assert.equal(fractional.path, 'canonical');
  assert.equal(validateDecisionRecord({ ...copy(), type_uid: 600300 }).ok, false, 'type_uid must be 600300 plus the activity');
  assert.equal(validateDecisionRecord({ ...copy(), class_uid: 6002 }).ok, false);
  assert.equal(validateDecisionRecord({ ...copy(), category_uid: 5 }).ok, false);
  for (const key of ['time', 'actor', 'api', 'resources', 'authorizations', 'unmapped', 'metadata', 'src_endpoint', 'activity_id', 'action_id']) {
    const missing = copy();
    delete missing[key];
    assert.equal(validateDecisionRecord(missing).ok, false, key);
  }
  const wrongVersion = copy();
  (wrongVersion.unmapped as { nearAi: { recordVersion: number } }).nearAi.recordVersion = 2;
  assert.equal(validateDecisionRecord(wrongVersion).ok, false);
  assert.equal(validateDecisionRecord('text').ok, false);
  assert.equal(validateDecisionRecord(null).ok, false);
  assert.equal(validateDecisionRecord([]).ok, false);
});

test('a record names things and never carries contents: no key that holds a file, a prompt or model output exists anywhere in it', () => {
  const record = buildDecisionRecord(inputFor(EXAMPLES.workspaceWrite as Capability, { outcome: 'denied', reason: 'Not allowed.' }));
  const keys: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) { keys.push(key); walk((value as Record<string, unknown>)[key]); }
    }
  };
  walk(record);
  assert.deepEqual(keys.filter((key) => /content|prompt|output|body|text|message|completion/i.test(key)), []);
});

test('frozen golden: a fixed input always builds this exact canonical record (recordVersion 1)', () => {
  const record = buildDecisionRecord({
    recordId: 'rec-golden-1', sequence: 7, time: NOW, productVersion: '0.4.25',
    actor: { kind: 'sub-agent', deviceFingerprint: 'dev-0123456789abcdef0123456789abcdef', sessionId: 'session-golden', agentId: 'agent-7', agentLabel: 'Reviewer' },
    model: { name: 'example-model', provider: 'near-ai-cloud' }, callId: 'call-golden-1', capability: { verb: 'workspaceWrite', paths: ['.git/hooks/pre-commit'] },
    resource: { name: '.git/hooks/pre-commit', type: 'file' }, outcome: 'refused-by-floor', rule: 'floor.protected-write', reason: 'Nobody is here to approve this.',
    bundleHash: HASH, label: { scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] }, tier: 'any-cloud', shadowFloor: 'floor.protected-write'
  });
  const GOLDEN = '{"action_id":2,"activity_id":3,"activity_name":"Update","actor":{"session":{"uid":"session-golden"},"user":{"uid":"dev-0123456789abcdef0123456789abcdef"}},"ai_agent":{"ai_model":{"ai_provider":"near-ai-cloud","name":"example-model"},"instance_uid":"session-golden","name":"Reviewer","uid":"agent-7"},"api":{"operation":"workspaceWrite","request":{"uid":"call-golden-1"}},"authorizations":[{"decision":"Denied","policy":{"is_applied":true,"name":"floor.protected-write","uid":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","version":"bundle-1"}}],"category_uid":6,"class_uid":6003,"disposition_id":2,"metadata":{"data_classifications":[{"category_id":99,"confidentiality":"org/Public","confidentiality_id":99}],"product":{"name":"NEAR AI for VS Code","vendor_name":"VitalPoint","version":"0.4.25"},"profiles":["ai_operation"],"sequence":7,"uid":"rec-golden-1","version":"1.9.0"},"resources":[{"name":".git/hooks/pre-commit","type":"file"}],"severity_id":4,"src_endpoint":{"name":"near-ai-vscode"},"status_detail":"Nobody is here to approve this.","status_id":2,"time":1794830400000,"type_uid":600303,"unmapped":{"nearAi":{"bundleHash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","capability":{"paths":[".git/hooks/pre-commit"],"verb":"workspaceWrite"},"label":{"compartments":[],"handling":[],"level":"Public","releasability":[],"scale":"org"},"recordVersion":1,"shadowFloor":"floor.protected-write","tier":"any-cloud"}}}';
  assert.equal(canonicalize(record), GOLDEN);
  assert.equal(validateDecisionRecord(JSON.parse(GOLDEN)).ok, true);
});
