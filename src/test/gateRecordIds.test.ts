// Every id a decision record carries is on a known list (PR #70 review carry-over): the gate's rules (GATE_RULE_IDS) and the policy's own events
// (POLICY_EVENT_IDS), joined as RECORD_RULE_IDS. The decision log refuses a record whose rule or operation is not known, so a writer that invents an id is
// caught at its first record; a scan of the sources finds every rule-shaped id written in code, so a new id is listed the moment it is written.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { POLICY_EVENT_IDS } from '../domain/gate/bundle';
import { GATE_RULE_IDS, RECORD_RULE_IDS } from '../domain/gate/decide';
import { buildDecisionRecord, validateDecisionRecord } from '../domain/gate/record';
import type { DecisionRecordInput } from '../domain/gate/record';
import { CAPABILITY_VERBS } from '../domain/gate/vocabulary';
import { GATE_DIR_NAME } from '../gate/bundleStore';
import { DECISIONS_DIR, DecisionLog, projectLogKey } from '../gate/decisionLog';
import { GateHost } from '../gate/host';
import { MemorySecrets } from './helpers/teamHarness';

const REPO = path.resolve(__dirname, '..', '..');

function input(rule: string, extra: Partial<DecisionRecordInput> = {}): DecisionRecordInput {
  return {
    recordId: 'r1', sequence: 1, time: 1_700_000_000_000, productVersion: '0.0.0-test',
    actor: { kind: 'agent', deviceFingerprint: 'device', sessionId: 's' }, callId: 'c1', capability: { verb: 'plan' },
    resource: { name: 'x', type: 'tool' }, outcome: 'denied', rule, bundleHash: '', ...extra
  };
}

test('the policy events are a list of their own, kept apart from the gate\'s rules, and both are known to a record', () => {
  assert.deepEqual([...POLICY_EVENT_IDS], ['policy.created', 'policy.renewed', 'policy.reset', 'policy.load']);
  for (const event of POLICY_EVENT_IDS) assert.ok(!GATE_RULE_IDS.includes(event), `${event} is an event, not a rule`);
  assert.deepEqual([...RECORD_RULE_IDS].sort(), [...GATE_RULE_IDS, ...POLICY_EVENT_IDS].sort());
  assert.equal(new Set(RECORD_RULE_IDS).size, RECORD_RULE_IDS.length, 'no id is on both lists');
});

test('a record is valid with every known rule, and refused with a rule or an operation nobody knows', () => {
  for (const rule of RECORD_RULE_IDS) assert.equal(validateDecisionRecord(buildDecisionRecord(input(rule))).ok, true, rule);
  const invented = validateDecisionRecord(buildDecisionRecord(input('policy.invented')));
  assert.equal(invented.ok, false);
  assert.equal(invented.ok ? '' : invented.path, 'authorizations[0].policy.name');
  const record = buildDecisionRecord(input('policy.load'));
  for (const operation of [...CAPABILITY_VERBS, ...POLICY_EVENT_IDS]) {
    assert.equal(validateDecisionRecord({ ...record, api: { ...record.api, operation } }).ok, true, operation);
  }
  const strange = validateDecisionRecord({ ...record, api: { ...record.api, operation: 'policy.invented' } });
  assert.equal(strange.ok ? '' : strange.path, 'api.operation');
});

test('the decision log does not write a record with an unknown rule, and says so once', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-record-ids-'));
  const problems: string[] = [];
  const log = new DecisionLog({ globalStorageDir: storage, projectKey: projectLogKey(path.join(storage, 'project')), onWriteFailure: (message) => problems.push(message) });
  await log.append(buildDecisionRecord(input('settings.read-plan')));
  await log.append(buildDecisionRecord(input('policy.invented')));
  const dir = path.join(storage, GATE_DIR_NAME, DECISIONS_DIR);
  const [file] = await readdir(dir);
  const lines = (await readFile(path.join(dir, file as string), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(problems.length, 1);
});

test('the host\'s policy events (created, loaded, reset) are written with known ids, to the install log and the open project\'s log', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-record-ids-host-'));
  const secrets = new MemorySecrets();
  const problems: string[] = [];
  const root = path.join(storage, 'project');
  const first = new GateHost({ globalStorageDir: storage, secrets, productVersion: '0.0.0-test', projectRoot: root, onProblem: (message) => problems.push(message) });
  await first.start();
  await first.reset();
  await first.flush();
  const second = new GateHost({ globalStorageDir: storage, secrets, productVersion: '0.0.0-test', projectRoot: root, onProblem: (message) => problems.push(message) });
  await second.start();
  await second.flush();
  assert.deepEqual(problems, []);
  const dir = path.join(storage, GATE_DIR_NAME, DECISIONS_DIR);
  const seen = new Set<string>();
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    for (const line of (await readFile(path.join(dir, file), 'utf8')).trim().split('\n')) {
      const record = JSON.parse(line) as { api: { operation: string }; authorizations: Array<{ policy: { name: string } }> };
      assert.equal(validateDecisionRecord(record).ok, true, line);
      for (const entry of record.authorizations) assert.ok(RECORD_RULE_IDS.includes(entry.policy.name), entry.policy.name);
      seen.add(record.api.operation);
    }
  }
  assert.deepEqual([...seen].sort(), ['policy.created', 'policy.load', 'policy.reset']);
});

// ---- the scan: every rule-shaped id written in the sources is a known id, or is named here as something else ----

/** The namespaces a gate rule or policy event id is written in. */
const RULE_SHAPED = /(['"`])((?:policy|settings|floor|bundle|manifest|label|route|taint|call)\.[a-z][a-z0-9.-]*)\1/g;

/**
 * Rule-shaped strings in the sources that are not decision-record ids, each with what it is. A new one is added here with its reason, or to the gate's lists
 * if a record can carry it; it is never left unlisted.
 */
const NOT_RECORD_IDS: Readonly<Record<string, string>> = {
  'policy.changed': 'a Team Mode event type (src/domain/team), written to the team log, never to a decision record',
  'policy.change': 'a Team Mode permission, never written to a decision record',
  'manifest.json': 'a file name',
  'settings.xml': 'a file name',
  'bundle.lock': 'the policy file\'s lock file name',
  'settings.approved': 'the answer of the settings layer after a person approved; an allow, which a record never carries as its rule (the record keeps the asked call\'s rule)',
  'settings.mode.': 'a prefix decide() matches, not an id',
  'policy.name': 'a field path inside a record (authorizations[].policy.name), read by the record check'
};

function productionSources(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (full !== path.join(REPO, 'src', 'test')) walk(full); continue; }
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(full);
    }
  };
  walk(path.join(REPO, 'src'));
  return found;
}

/** The text with whole-line and trailing `//` comments removed, so an id named in a comment is not code. */
function code(text: string): string {
  return text.split('\n').filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).map((line) => line.replace(/\s\/\/\s.*$/, '')).join('\n');
}

export function ruleShapedIds(text: string): string[] {
  return [...code(text).matchAll(RULE_SHAPED)].map((match) => match[2] as string);
}

test('every rule-shaped id written in the production sources is a known record id or is named as something else', () => {
  const unknown: string[] = [];
  const files = productionSources();
  assert.ok(files.length > 200, 'the scan read all of src');
  for (const file of files) {
    for (const id of ruleShapedIds(readFileSync(file, 'utf8'))) {
      if (!RECORD_RULE_IDS.includes(id) && !(id in NOT_RECORD_IDS)) unknown.push(`${path.relative(REPO, file)}: ${id}`);
    }
  }
  assert.deepEqual(unknown, []);
  assert.deepEqual(ruleShapedIds("const rule = 'floor.made-up';\n// 'floor.in-a-comment'\nreturn `policy.load`;"), ['floor.made-up', 'policy.load'], 'the scan finds a planted id and skips a comment');
});
