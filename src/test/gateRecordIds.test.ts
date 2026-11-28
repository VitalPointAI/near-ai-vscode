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
import { LABEL_EVENT_IDS } from '../domain/gate/labels';
import { ROUTE_EVENT_IDS, ROUTE_REFUSALS, ROUTE_REFUSALS_NAMED_AHEAD, ROUTE_RULES, ROUTE_RULES_NAMED_AHEAD } from '../domain/gate/routing';
import { GATE_RULE_IDS, RECORD_RULE_IDS, RECORD_UNKNOWN_RULE } from '../domain/gate/decide';
import { POLICY_RECORD_VERSIONS, buildDecisionRecord, isModelRequestRecord, unknownRuleListeners, validateDecisionRecord } from '../domain/gate/record';
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
  // Phase 41 (D-10) appends seven events, in order, after the base's five.
  assert.deepEqual([...POLICY_EVENT_IDS], [
    'policy.created', 'policy.renewed', 'policy.reset', 'policy.load', 'policy.edit', 'policy.enrolled', 'policy.organization-updated',
    'policy.organization-refused', 'policy.migrated', 'policy.proposal-applied', 'policy.proposal-exported', 'policy.reset-personal'
  ]);
  for (const event of POLICY_EVENT_IDS) assert.ok(!GATE_RULE_IDS.includes(event), `${event} is an event, not a rule`);
  assert.deepEqual([...RECORD_RULE_IDS].sort(), [...GATE_RULE_IDS, ...POLICY_EVENT_IDS, ...LABEL_EVENT_IDS, ...ROUTE_EVENT_IDS, ...ROUTE_RULES_NAMED_AHEAD, RECORD_UNKNOWN_RULE].sort());
  assert.equal(RECORD_UNKNOWN_RULE, 'record.unknown-rule');
  assert.equal(new Set(RECORD_RULE_IDS).size, RECORD_RULE_IDS.length, 'no id is on both lists');
});

test('Phase 70.1 (D-15): the five classification label events are appended to LABEL_EVENT_IDS in order and a record accepts each', () => {
  assert.deepEqual([...LABEL_EVENT_IDS].slice(-5), ['label.auto-raised', 'label.exception-queued', 'label.exception-resolved', 'label.could-be-lower', 'label.affirmed']);
  assert.deepEqual([...LABEL_EVENT_IDS].slice(0, 5), ['label.set', 'label.branch-accepted', 'label.mark-raised', 'label.declassify', 'label.declassify-rejected'], 'appended, never inserted');
  for (const event of LABEL_EVENT_IDS.slice(-5)) {
    const record = buildDecisionRecord(input(event, { outcome: 'allowed' }));
    assert.equal(validateDecisionRecord({ ...record, api: { ...record.api, operation: event } }).ok, true, event);
  }
});

test('a record is valid with every known rule, and refused with a rule or an operation nobody knows', () => {
  for (const rule of RECORD_RULE_IDS) assert.equal(validateDecisionRecord(buildDecisionRecord(input(rule))).ok, true, rule);
  // The check itself still refuses a rule nobody knows (the builder and the log put one under record.unknown-rule before it gets here).
  const known = buildDecisionRecord(input('policy.load'));
  const invented = validateDecisionRecord({ ...known, authorizations: [{ ...known.authorizations[0]!, policy: { ...known.authorizations[0]!.policy, name: 'policy.invented' } }] });
  assert.equal(invented.ok, false);
  assert.equal(invented.ok ? '' : invented.path, 'authorizations[0].policy.name');
  const record = buildDecisionRecord(input('policy.load'));
  for (const operation of [...CAPABILITY_VERBS, ...POLICY_EVENT_IDS, ...LABEL_EVENT_IDS]) {
    assert.equal(validateDecisionRecord({ ...record, api: { ...record.api, operation } }).ok, true, operation);
  }
  const strange = validateDecisionRecord({ ...record, api: { ...record.api, operation: 'policy.invented' } });
  assert.equal(strange.ok ? '' : strange.path, 'api.operation');
});

/**
 * The Phase 41 route rules decideRoute reaches (41-10), moved from the named-ahead list into ROUTE_RULES in this order, each with its sentence unchanged;
 * Phase 74.1 moved route.passport last (D-11).
 */
const ROUTE_RULES_MOVED = ['route.model-not-allowed', 'route.endpoint-unknown', 'route.endpoint-ceiling', 'route.endpoint-pin', 'route.authorization-missing',
  'route.accredited-device', 'route.residency', 'route.clearance', 'route.passport'];
/** The Phase 41 route rules still named ahead, in order. */
const ROUTE_RULES_STILL_AHEAD = ['route.export-control'];

test('D-10, D-51: every route rule Phase 41 writes is named ahead until decideRoute reaches it, on one list only, with a sentence that says nothing was sent', () => {
  const named = [...ROUTE_RULES_NAMED_AHEAD];
  assert.deepEqual(named, ROUTE_RULES_STILL_AHEAD);
  assert.deepEqual(ROUTE_RULES.slice(ROUTE_RULES.length - ROUTE_RULES_MOVED.length), ROUTE_RULES_MOVED, 'appended to ROUTE_RULES in order');
  for (const id of ROUTE_RULES_MOVED) {
    assert.ok(!(named as string[]).includes(id), `${id} is no longer named ahead`);
    const sentence = (ROUTE_REFUSALS as Readonly<Record<string, string>>)[id];
    assert.ok(sentence !== undefined && sentence.startsWith('Nothing was sent. ') && sentence.length < 400, id);
    for (const word of [/NEAR organization/, /TEE/, /\btier/i, /endpoint/i]) assert.ok(!word.test(sentence), `${id} says ${String(word)}`);
  }
  // D-63: route.export-control is named ahead last, until Phase 45, and its sentence uses the shown words, never the officials' words.
  assert.equal(named[named.length - 1], 'route.export-control');
  const exportSentence = ROUTE_REFUSALS_NAMED_AHEAD['route.export-control'];
  for (const word of [/regime/i, /designated official/i, /empowered official/i]) assert.ok(!word.test(exportSentence), String(word));
  assert.match(exportSentence, /Controlled goods \(Canada\), ITAR or US export-controlled \(EAR\)/);
  assert.deepEqual(Object.keys(ROUTE_REFUSALS_NAMED_AHEAD).sort(), [...named].sort());
  const emDash = String.fromCharCode(0x2014);
  for (const id of named) {
    assert.ok(!(ROUTE_RULES as readonly string[]).includes(id) && !(ROUTE_EVENT_IDS as readonly string[]).includes(id) && !GATE_RULE_IDS.includes(id), `${id} is only named ahead`);
    const sentence = ROUTE_REFUSALS_NAMED_AHEAD[id];
    assert.ok(sentence.startsWith('Nothing was sent. '), id);
    assert.ok(sentence.length < 400, `${id} is ${String(sentence.length)} characters`);
    assert.ok(!sentence.includes(emDash), id);
    for (const word of [/NEAR organization/, /TEE/, /\btier/i, /endpoint/i]) assert.ok(!word.test(sentence), `${id} says ${String(word)}`);
  }
  // route.accredited-device is the refusal; route.not-accredited stays the report event (D-34).
  assert.ok((ROUTE_EVENT_IDS as readonly string[]).includes('route.not-accredited'));
  assert.equal(new Set(RECORD_RULE_IDS).size, RECORD_RULE_IDS.length);
});

test('D-10, D-36: a record names its policy version (bundle-2 for a v2 policy, bundle-1 by default) and the report-only rules that would have refused', () => {
  assert.deepEqual([...POLICY_RECORD_VERSIONS], ['bundle-1', 'bundle-2']);
  const v1 = buildDecisionRecord(input('policy.load'));
  assert.equal(v1.authorizations[0]?.policy.version, 'bundle-1');
  assert.equal(validateDecisionRecord(v1).ok, true);
  const v2 = buildDecisionRecord(input('policy.load', { policyVersion: 'bundle-2' }));
  assert.equal(v2.authorizations[0]?.policy.version, 'bundle-2');
  assert.equal(validateDecisionRecord(v2).ok, true);
  const short = buildDecisionRecord(input('policy.load', { policyVersion: 'bundle-2', short: true }));
  assert.equal(short.authorizations[0]?.policy.version, 'bundle-2');
  const newer = validateDecisionRecord({ ...v1, authorizations: [{ ...v1.authorizations[0]!, policy: { ...v1.authorizations[0]!.policy, version: 'bundle-3' } }] });
  assert.equal(newer.ok ? '' : `${newer.reason} ${newer.path}`, 'not-allowed-here authorizations[0].policy.version');
  const reported = buildDecisionRecord(input('route.any-cloud', { capability: { verb: 'infer' } as never, wouldRefuse: ['route.passport', 'route.accredited-device'] }));
  assert.deepEqual(reported.unmapped.nearAi.wouldRefuse, ['route.accredited-device', 'route.passport'], 'written sorted');
  assert.equal(validateDecisionRecord(reported).ok, true);
  assert.equal(validateDecisionRecord(buildDecisionRecord(input('route.any-cloud', { wouldRefuse: ['route.passport'] }))).ok, true);
  assert.equal(validateDecisionRecord(buildDecisionRecord(input('route.any-cloud', { wouldRefuse: ['route.not-tee'] }))).ok, true, 'a shipped refusing rule');
  for (const bad of [['route.any-cloud'], ['route.invented'], ['policy.load']]) {
    const record = validateDecisionRecord(buildDecisionRecord(input('route.any-cloud', { wouldRefuse: bad })));
    assert.equal(record.ok ? '' : `${record.reason} ${record.path}`, 'not-allowed-here unmapped.nearAi.wouldRefuse[0]', bad[0]);
  }
  const notList = validateDecisionRecord({ ...v1, unmapped: { nearAi: { ...v1.unmapped.nearAi, wouldRefuse: 'route.passport' } } });
  assert.equal(notList.ok ? '' : `${notList.reason} ${notList.path}`, 'wrong-type unmapped.nearAi.wouldRefuse');
  assert.equal(Object.prototype.hasOwnProperty.call(v1.unmapped.nearAi, 'wouldRefuse'), false, 'absent unless given');
});

test('D-51: a record whose rule is named ahead is a model-request record and is valid', () => {
  for (const rule of ROUTE_RULES_NAMED_AHEAD) {
    const record = buildDecisionRecord(input(rule));
    assert.equal(record.authorizations[0]?.policy.name, rule);
    assert.equal(isModelRequestRecord(record), true, rule);
    assert.equal(validateDecisionRecord(record).ok, true, rule);
  }
  assert.equal(isModelRequestRecord(buildDecisionRecord(input('policy.enrolled'))), false);
  assert.ok(Object.keys(ROUTE_REFUSALS).every((id) => !(ROUTE_RULES_NAMED_AHEAD as readonly string[]).includes(id)));
});

// PR #74 review round 11: a record with a rule nobody knows is not dropped. It is kept under record.unknown-rule, with the id it was given beside it, so no
// decision is ever missing from the log; the log says so once. In a test run, the gate's test helper makes the same thing fail the test (loud), so a
// writer with a new id is caught before it ships.
test('a record built with a rule nobody knows is kept under record.unknown-rule with the id it was given, and the log says so once', async () => {
  const built = buildDecisionRecord(input('newspace.invented'));
  assert.equal(built.authorizations[0]?.policy.name, RECORD_UNKNOWN_RULE);
  assert.equal(built.unmapped.nearAi.unknownRule, 'newspace.invented');
  assert.equal(validateDecisionRecord(built).ok, true);
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-record-ids-'));
  const problems: string[] = [];
  const log = new DecisionLog({ globalStorageDir: storage, projectKey: projectLogKey(path.join(storage, 'project')), onWriteFailure: (message) => problems.push(message) });
  await log.append(buildDecisionRecord(input('settings.read-plan')));
  // A record put together by hand, past the builder, with an unknown rule: also kept, not dropped.
  const handMade = buildDecisionRecord(input('settings.read-plan'));
  await log.append({ ...handMade, authorizations: [{ ...handMade.authorizations[0]!, policy: { ...handMade.authorizations[0]!.policy, name: 'other.invented' } }] });
  await log.append(buildDecisionRecord(input('policy.invented')));
  const dir = path.join(storage, GATE_DIR_NAME, DECISIONS_DIR);
  const [file] = await readdir(dir);
  const lines = (await readFile(path.join(dir, file as string), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { authorizations: Array<{ policy: { name: string } }>; unmapped: { nearAi: { unknownRule?: string } } });
  assert.deepEqual(lines.map((line) => line.authorizations[0]?.policy.name), ['settings.read-plan', RECORD_UNKNOWN_RULE, RECORD_UNKNOWN_RULE]);
  assert.deepEqual(lines.map((line) => line.unmapped.nearAi.unknownRule), [undefined, 'other.invented', 'policy.invented']);
  assert.equal(problems.length, 1, 'said once');
});

test('a listener hears every unknown rule the builder keeps, which is how a test run makes it fail loudly', () => {
  const heard: string[] = [];
  const listener = (id: string): void => { heard.push(id); };
  unknownRuleListeners.add(listener);
  try {
    buildDecisionRecord(input('newspace.invented'));
    buildDecisionRecord(input('settings.read-plan'));
  } finally {
    unknownRuleListeners.delete(listener);
  }
  assert.deepEqual(heard, ['newspace.invented']);
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
  'policy.name': 'a field path inside a record (authorizations[].policy.name), read by the record check',
  'agent.allowCommands': 'a setting name (nearAi.agent.allowCommands) an allow rule is saved under, never a record rule'
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

/**
 * Every string literal in a place that becomes a record's rule or operation, whatever its namespace (PR #74 review round 11): a `rule:` property, a rule
 * comparison, decide()'s `make(outcome, rule, ...)`, the literals a *Rule* function returns, and an `operation:` property. A new namespace is caught here,
 * not only the ones RULE_SHAPED lists.
 */
export function recordIdLiterals(text: string): Array<{ kind: 'rule' | 'operation'; id: string }> {
  const source = code(text);
  const found: Array<{ kind: 'rule' | 'operation'; id: string }> = [];
  const literal = "(['\"\\x60])([^'\"\\x60$\\n]+)\\1";
  for (const match of source.matchAll(new RegExp(String.raw`\brule\s*(?::|[!=]==?)\s*` + literal, 'g'))) found.push({ kind: 'rule', id: match[2]! });
  for (const match of source.matchAll(new RegExp(literal + String.raw`\s*[!=]==?\s*[\w.?]*\brule\b`, 'g'))) found.push({ kind: 'rule', id: match[2]! });
  for (const match of source.matchAll(new RegExp(String.raw`\bmake\(\s*'(?:allow|ask|deny)',\s*` + literal, 'g'))) found.push({ kind: 'rule', id: match[2]! });
  for (const match of source.matchAll(new RegExp(String.raw`\boperation\s*:\s*` + literal, 'g'))) found.push({ kind: 'operation', id: match[2]! });
  // Inside a function whose name says it gives a rule (settingsRuleFor, shellRule), every id-shaped literal it can return.
  for (const fn of source.matchAll(/function (\w*[Rr]ule\w*)\([^)]*\)[^{]*\{/g)) {
    const start = (fn.index ?? 0) + fn[0].length;
    let depth = 1;
    let end = start;
    for (; end < source.length && depth > 0; end += 1) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') depth -= 1;
    }
    for (const match of source.slice(start, end).matchAll(/(['"`])([a-z][\w-]*(?:\.[a-z][\w-]*)+)\1/g)) found.push({ kind: 'rule', id: match[2]! });
  }
  return found;
}

test('every literal that becomes a record rule or operation, in any namespace, is a known id', () => {
  const operations = new Set<string>([...CAPABILITY_VERBS, ...POLICY_EVENT_IDS, ...LABEL_EVENT_IDS]);
  const wrong: string[] = [];
  let seen = 0;
  // The files that write records or decide what they say: the gate's own (src/gate, src/domain/gate, the adapter) and every file that imports from them.
  const gateFiles = productionSources().filter((file) => {
    const relative = path.relative(REPO, file).split(path.sep).join('/');
    return /^src\/(?:gate|domain\/gate)\//.test(relative) || relative === 'src/agent/gateAdapter.ts'
      || /from '[./]*(?:\/|)(?:domain\/gate|gate|agent\/gateAdapter)(?:\/[\w]+)?'|from '\.\/gateAdapter'|from '\.\.\/gate\//.test(readFileSync(file, 'utf8'));
  });
  assert.ok(gateFiles.length >= 15, `${gateFiles.length} files that write or decide records`);
  for (const file of gateFiles) {
    for (const { kind, id } of recordIdLiterals(readFileSync(file, 'utf8'))) {
      // A rule id has a dot (namespace.name); a type name or a path segment that a `rule` variable is compared with is not one.
      if (kind === 'rule' && !/^[a-z][\w-]*(?:\.[a-z][\w-]*)+$/.test(id)) continue;
      seen += 1;
      const known = kind === 'rule' ? RECORD_RULE_IDS.includes(id) || id in NOT_RECORD_IDS : operations.has(id);
      if (!known) wrong.push(`${path.relative(REPO, file)}: ${kind} ${id}`);
    }
  }
  assert.deepEqual(wrong, []);
  assert.ok(seen > 30, `${seen} literals checked`);
  // The scan finds a planted id in a namespace no list names, in each place.
  const planted = recordIdLiterals("const a = { rule: 'brandnew.thing' };\nif (x.rule === 'other.place') {}\nmake('deny', 'third.space', mode);\nfunction pickRule() { return 'fourth.kind'; }\nconst b = { operation: 'fifth.op' };");
  assert.deepEqual(planted.map((entry) => entry.id).sort(), ['brandnew.thing', 'fifth.op', 'fourth.kind', 'other.place', 'third.space']);
});

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

// ---- Phase 74.1 (D-23): the use and the passport of a model request, optional record version 1 fields ----

const PASSPORT_SHA = 'a1'.repeat(32);

test('74.1 D-23: a model request record carries useTier, the passport by id and hash, and the gap under unmapped.nearAi', () => {
  const record = buildDecisionRecord(input('route.passport', { capability: { verb: 'infer' } as never, useTier: 'T2', passport: { id: 'z-ai/glm', hash: PASSPORT_SHA }, passportGap: 'tier-exceeded' }));
  const fields = record.unmapped.nearAi;
  assert.deepEqual({ useTier: fields.useTier, passport: fields.passport, passportHash: fields.passportHash, passportGap: fields.passportGap }, { useTier: 'T2', passport: 'z-ai/glm', passportHash: PASSPORT_SHA, passportGap: 'tier-exceeded' });
  assert.equal(validateDecisionRecord(record).ok, true);
  assert.equal(fields.recordVersion, 1, 'the record version stays 1');
});

test('74.1 D-23: a record without the passport fields still passes, and has none of them', () => {
  const record = buildDecisionRecord(input('route.any-cloud'));
  assert.equal(validateDecisionRecord(record).ok, true);
  for (const key of ['useTier', 'passport', 'passportHash', 'passportGap']) assert.equal(Object.prototype.hasOwnProperty.call(record.unmapped.nearAi, key), false, key);
});

test('74.1 D-23: a passport gap outside PASSPORT_GAPS, a use outside USE_TIERS, or a malformed hash or id is refused by the record check', () => {
  const base = buildDecisionRecord(input('route.passport', { useTier: 'T1', passport: { id: 'openai/gpt-oss', hash: PASSPORT_SHA }, passportGap: 'unknown' }));
  const withField = (key: string, value: unknown): string => {
    const checked = validateDecisionRecord({ ...base, unmapped: { nearAi: { ...base.unmapped.nearAi, [key]: value } } });
    return checked.ok ? 'ok' : `${checked.reason} ${checked.path}`;
  };
  assert.equal(withField('passportGap', 'model.same-lineage'), 'not-allowed-here unmapped.nearAi.passportGap');
  assert.equal(withField('useTier', 'T4'), 'not-allowed-here unmapped.nearAi.useTier');
  assert.equal(withField('passportHash', 'A1'.repeat(32)), 'not-allowed-here unmapped.nearAi.passportHash');
  assert.equal(withField('passport', 'Not An Id'), 'not-allowed-here unmapped.nearAi.passport');
  assert.equal(withField('passportGap', 'not-evaluated'), 'ok');
});

test('74.1 D-23: a checker\'s record carries both families; one whose checker family is a writer\'s is refused; a record without them still passes', () => {
  const checked = buildDecisionRecord(input('route.any-cloud', { capability: { verb: 'infer' } as never, checkFamilies: { author: ['nemotron'], checker: 'gpt' } }));
  assert.deepEqual(checked.unmapped.nearAi.checkFamilies, { author: ['nemotron'], checker: 'gpt' });
  assert.equal(validateDecisionRecord(checked).ok, true);
  const withFamilies = (value: unknown): string => {
    const found = validateDecisionRecord({ ...checked, unmapped: { nearAi: { ...checked.unmapped.nearAi, checkFamilies: value } } });
    return found.ok ? 'ok' : `${found.reason} ${found.path}`;
  };
  assert.equal(withFamilies({ author: ['nemotron', 'gpt'], checker: 'gpt' }), 'not-allowed-here unmapped.nearAi.checkFamilies', 'a forged same-family check');
  assert.equal(withFamilies({ author: 'nemotron', checker: 'gpt' }), 'not-allowed-here unmapped.nearAi.checkFamilies');
  assert.equal(withFamilies({ author: [], checker: 'Not A Family' }), 'not-allowed-here unmapped.nearAi.checkFamilies');
  const plain = buildDecisionRecord(input('route.any-cloud', {}));
  assert.equal(Object.prototype.hasOwnProperty.call(plain.unmapped.nearAi, 'checkFamilies'), false);
  assert.equal(validateDecisionRecord(plain).ok, true);
});
