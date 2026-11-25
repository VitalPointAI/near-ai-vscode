// 48.2-03 (D-12, D-13, D-14, D-24): every rule result's freshness (Current, Ageing, Out of date) from its time, its window kind and the policy,
// by the same rule that makes a state Stale; a site policy that only tightens; the honest clock; the new collectors' windows; layering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGEING, FRESHNESS, type EvidenceRule, type RuleResult } from '../src/model.ts';
import { FUTURE_TOLERANCE_MS, computeStatus } from '../src/status.ts';
import { windowForCollector } from '../src/rules.ts';
import { effectivePolicy, freshnessOf, JUDGEMENT_FORMAT, judgementRow, rejudge, type Judgement } from '../src/judgement.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const commit = 'a'.repeat(40);
const BUILT = Date.parse('2026-11-25T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function result(window: RuleResult['window'], collectedAt: number, extra: Partial<RuleResult> = {}): RuleResult {
  return { rule: `rule.${window}`, passed: true, reason: 'met', collectedAt: iso(collectedAt), commit, window, ...extra };
}

const testRule = (control: string, id: string): EvidenceRule => ({ id, component: 'workbench', control, statement: `${control}_smt`, kind: 'test', test: { file: 'workbench/test/x.test.ts', path: [], name: id } });
const observationRule = (control: string, id: string, collector: string, subject: string): EvidenceRule => ({ id, component: 'workbench', control, statement: `${control}_smt`, kind: 'observation', observation: { collector, subject } });

/** A judgement row with one component, one statement and the given rules and results. */
function row(control: string, rules: readonly EvidenceRule[], results: readonly RuleResult[]) {
  return judgementRow({
    level: 'unclassified', control, claim: true, responsibility: 'product',
    components: [{ control, component: 'workbench', level: 'unclassified', responsibility: 'product', statements: rules.length ? [{ id: `${control}_smt`, description: control }] : [],
      rulesByStatement: rules.length ? { [`${control}_smt`]: rules } : {}, results: Object.fromEntries(results.map((item) => [item.rule, item])) }],
  }, { label: control.toUpperCase(), family: control.split('-')[0]!, title: control });
}

function judgement(rows: ReturnType<typeof row>[]): Judgement {
  return {
    format: JUDGEMENT_FORMAT, generatedAt: iso(BUILT), commit, head: commit,
    levels: [{ id: 'unclassified', title: 'Unclassified', kind: 'level', profile: 'p', claim: true, components: ['workbench'], overlays: [] }], rows,
  };
}

test('labels: audit 17, 19 and 25 hours and settings 4, 6 and 8 days give current, ageing and out of date; out of date is Stale', () => {
  const now = new Date(BUILT + 40 * DAY);
  const age = (window: RuleResult['window'], ms: number) => freshnessOf(result(window, now.getTime() - ms), { head: commit, now });
  assert.deepEqual([17, 19, 25].map((hours) => age('audit', hours * HOUR)), ['current', 'ageing', 'out-of-date']);
  assert.deepEqual([4, 6, 8].map((days) => age('settings', days * DAY)), ['current', 'ageing', 'out-of-date']);
  for (const hours of [17, 19, 25]) {
    const audit = { ...result('audit', now.getTime() - hours * HOUR), rule: 'au-06.check' };
    const judged = rejudge(judgement([row('au-06', [testRule('au-06', 'au-06.check')], [audit])]), { now });
    const outcome = computeStatus({ control: 'au-06', component: 'workbench', level: 'unclassified', responsibility: 'product', statements: [{ id: 'au-06_smt', description: 'x' }],
      rulesByStatement: { 'au-06_smt': [testRule('au-06', 'au-06.check')] }, results: { 'au-06.check': audit }, head: commit, now });
    assert.equal(judged.rows[0]!.state, outcome.state);
    assert.equal(judged.rows[0]!.state === 'stale', judged.rows[0]!.freshness === 'out-of-date', `${hours} hours`);
  }
  assert.equal(FRESHNESS.audit, 24 * HOUR, 'the existing out-of-date thresholds are unchanged');
  assert.equal(AGEING.audit, 18 * HOUR);
});

test('head: a head-window result is current at any age while head is its commit, and out of date when it is not', () => {
  const old = result('head', BUILT - 400 * DAY);
  assert.equal(freshnessOf(old, { head: commit, now: new Date(BUILT) }), 'current');
  assert.equal(freshnessOf(old, { head: 'b'.repeat(40), now: new Date(BUILT) }), 'out-of-date');
});

test('row: rejudge gives each result its freshness and each row the worst of them; a row with no results has none', () => {
  const now = new Date(BUILT + 19 * HOUR);
  const rules = [testRule('au-06', 'au-06.head'), testRule('au-06', 'au-06.audit')];
  const results = [{ ...result('head', BUILT), rule: 'au-06.head' }, { ...result('audit', BUILT), rule: 'au-06.audit' }];
  const judged = rejudge(judgement([row('au-06', rules, results), row('pl-02', [], [])]), { now });
  assert.deepEqual(judged.rows[0]!.components[0]!.evidence.map(({ rule, freshness }) => [rule, freshness]), [['au-06.head', 'current'], ['au-06.audit', 'ageing']]);
  assert.equal(judged.rows[0]!.freshness, 'ageing');
  assert.equal(judged.rows[0]!.asOf, iso(BUILT));
  assert.equal(judged.rows[1]!.freshness, 'none');
  assert.equal(Object.hasOwn(judged.rows[1]!, 'asOf'), false);
});

test('tighten: a site policy can only shorten the thresholds; looser values are clamped and reported, malformed policies refused whole', () => {
  const now = new Date(BUILT + 60 * DAY);
  const scan = (days: number, policy?: unknown) => {
    const effective = effectivePolicy(policy);
    return freshnessOf(result('vulnerability', now.getTime() - days * DAY), { head: commit, now, windows: effective.windows, ageing: effective.ageing });
  };
  const tight = { vulnerability: { ageingAfterHours: 72, outOfDateAfterHours: 240 } };
  assert.equal(scan(4, tight), 'ageing');
  assert.equal(scan(11, tight), 'out-of-date');
  assert.equal(scan(4), 'current', 'the release default ages a scan after 7 days');
  assert.deepEqual([scan(8), scan(31)], ['ageing', 'out-of-date']);
  const loose = effectivePolicy({ audit: { outOfDateAfterHours: 48 }, live: { ageingAfterHours: 1 } });
  assert.equal(loose.windows.audit, FRESHNESS.audit);
  assert.deepEqual(loose.clamped, ['audit.outOfDateAfterHours', 'live.ageingAfterHours']);
  assert.equal(loose.refused, undefined);
  for (const bad of [{ unknown: { ageingAfterHours: 1 } }, { audit: { ageingAfterHours: -1 } }, { audit: { ageingAfterHours: 1.5 } }, { audit: { ageingAfterHours: 10, outOfDateAfterHours: 5 } }, { head: { ageingAfterHours: 1 } }, 'tight']) {
    const refused = effectivePolicy(bad);
    assert.ok(refused.refused, JSON.stringify(bad));
    assert.deepEqual([refused.windows, refused.ageing, refused.clamped], [effectivePolicy().windows, effectivePolicy().ageing, []]);
  }
  const judged = rejudge(judgement([row('ra-05', [testRule('ra-05', 'ra-05.scan')], [{ ...result('vulnerability', now.getTime() - 4 * DAY), rule: 'ra-05.scan' }])]), { now, policy: tight });
  assert.equal(judged.rows[0]!.freshness, 'ageing');
  assert.deepEqual(judged.policy, { clamped: [] });
});

test('clock floor: a clock earlier than the release build shows every row, every freshness Unknown, nothing Met, with the clock note', () => {
  const now = new Date(BUILT - 2 * HOUR);
  const rows = [row('cm-08', [testRule('cm-08', 'cm-08.head')], [{ ...result('head', BUILT), rule: 'cm-08.head' }]), row('pl-02', [], [])];
  const judged = rejudge(judgement(rows), { now });
  assert.equal(judged.clock, 'clock-behind-build');
  assert.equal(judged.rows.length, 2);
  assert.ok(judged.rows.every(({ state }) => state !== 'met'));
  // Every row with evidence reads Unknown; a row with no evidence still says it has none.
  assert.deepEqual(judged.rows.map(({ freshness }) => freshness), ['unknown', 'none']);
  assert.ok(judged.rows.flatMap(({ components }) => components.flatMap(({ evidence }) => evidence)).every(({ freshness }) => freshness === 'unknown'));
  assert.deepEqual(judged.refused, [], 'the clock case is never did-not-verify');
  assert.equal(rejudge(judgement(rows), { now: new Date(BUILT - FUTURE_TOLERANCE_MS + 1000) }).clock, undefined, 'within the tolerance is not the clock case');
});

test('future: a result or an observation dated more than five minutes ahead is did-not-verify and not used; the rest is judged normally', () => {
  const now = new Date(BUILT + DAY);
  const future = { ...result('audit', now.getTime() + FUTURE_TOLERANCE_MS + 60_000), rule: 'au-06.check' };
  const fine = { ...result('head', BUILT), rule: 'cm-08.head' };
  const scanRule = observationRule('ra-05', 'ra-05.scan', 'image-scan', 'sterling-image');
  const scan = { ...result('vulnerability', BUILT - DAY), rule: 'ra-05.scan' };
  const judged = rejudge(judgement([row('au-06', [testRule('au-06', 'au-06.check')], [future]), row('cm-08', [testRule('cm-08', 'cm-08.head')], [fine]), row('ra-05', [scanRule], [scan])]), {
    now, observations: [{ collector: 'image-scan', subject: 'sterling-image', passed: true, collectedAt: iso(now.getTime() + 2 * HOUR) }],
  });
  assert.deepEqual(judged.refused, [
    { kind: 'result', rule: 'au-06.check', reason: 'future-dated', at: future.collectedAt },
    { kind: 'observation', collector: 'image-scan', subject: 'sterling-image', reason: 'future-dated', at: iso(now.getTime() + 2 * HOUR) },
  ]);
  assert.equal(judged.rows[0]!.reason, 'missing-result');
  assert.deepEqual(judged.rows[0]!.components[0]!.evidence, []);
  assert.equal(judged.rows[1]!.state, 'met');
  assert.equal(judged.rows[2]!.components[0]!.evidence[0]!.source, 'release', 'the refused site observation does not replace the release scan');
});

test('windows: image-scan ages as vulnerability, site-live as live, site-agreements as document; existing collectors unchanged', () => {
  assert.equal(windowForCollector('image-scan'), 'vulnerability');
  assert.equal(windowForCollector('site-live'), 'live');
  assert.equal(windowForCollector('site-agreements'), 'document');
  assert.deepEqual(['audit', 'settings', 'harness', 'documents', 'crypto', 'attestations', 'deployment', 'tests', 'ci'].map((collector) => windowForCollector(collector)),
    ['audit', 'settings', 'harness', 'document', 'document', 'attestation', 'settings', 'head', 'head']);
  assert.equal(windowForCollector('settings', 'codeowners-valid'), 'head');
  assert.equal(FRESHNESS.vulnerability, 30 * DAY);
  assert.equal(FRESHNESS.live, 2 * HOUR);
  assert.deepEqual([AGEING.vulnerability, AGEING.live, AGEING.settings, AGEING.harness, AGEING.document, AGEING.attestation], [7 * DAY, 30 * 60 * 1000, 5 * DAY, 23 * DAY, 335 * DAY, 335 * DAY]);
  assert.equal(Object.hasOwn(AGEING, 'head'), false);
});

test('layering: a newer site scan replaces the release result for every rule on that collector and subject; the judgement is never changed', () => {
  const now = new Date(BUILT + 40 * DAY);
  const rules = [observationRule('ra-05', 'ra-05.scan', 'image-scan', 'sterling-image'), observationRule('ra-05', 'ra-05.scan-2', 'image-scan', 'sterling-image')];
  const release = rules.map((rule) => ({ ...result('vulnerability', BUILT - DAY), rule: rule.id }));
  const deploymentRule = observationRule('cm-02', 'cm-02.deployment', 'deployment', 'release-record');
  const reference = { ...result('settings', BUILT - DAY), rule: 'cm-02.deployment' };
  const source = judgement([row('ra-05', rules, release), row('cm-02', [deploymentRule], [reference])]);
  const before = structuredClone(source);
  const alone = rejudge(source, { now });
  assert.equal(alone.rows[0]!.state, 'stale', 'the release scan is out of date after 30 days');
  assert.deepEqual(alone.rows[0]!.components[0]!.evidence.map(({ source: from }) => from), ['release', 'release']);
  assert.deepEqual(alone.rows[1]!.components[0]!.evidence.map(({ source: from }) => from), ['reference-site'], 'a release result on a site-only collector is the supplier reference site');
  const site = { collector: 'image-scan', subject: 'sterling-image', passed: true, collectedAt: iso(now.getTime() - DAY) };
  const layered = rejudge(source, { now, observations: [site, { collector: 'image-scan', subject: 'no-such-subject', passed: false, collectedAt: iso(now.getTime() - DAY) }] });
  assert.equal(layered.rows[0]!.state, 'met');
  assert.deepEqual(layered.rows[0]!.components[0]!.evidence.map(({ rule, source: from, collectedAt, window }) => [rule, from, collectedAt, window]), [
    ['ra-05.scan', 'site', site.collectedAt, 'vulnerability'], ['ra-05.scan-2', 'site', site.collectedAt, 'vulnerability'],
  ]);
  assert.deepEqual(layered.rows[1], alone.rows[1], 'an observation for a subject no rule names changes nothing');
  const older = rejudge(source, { now, observations: [{ ...site, collectedAt: iso(BUILT - 2 * DAY) }] });
  assert.deepEqual(older.rows[0]!.components[0]!.evidence.map(({ source: from }) => from), ['release', 'release'], 'an older site observation does not replace a newer release result');
  assert.deepEqual(source, before, 'the release judgement is never changed in place');
});
