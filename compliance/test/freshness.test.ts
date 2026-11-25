// 48.2-03 (D-12, D-13, D-14, D-24): every rule result's freshness (Current, Ageing, Out of date) from its time, its window kind and the policy,
// by the same rule that makes a state Stale; a site policy that only tightens; the honest clock; the new collectors' windows; layering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGEING, FRESHNESS, type EvidenceRule, type RuleResult } from '../src/model.ts';
import { computeStatus } from '../src/status.ts';
import { freshnessOf, JUDGEMENT_FORMAT, judgementRow, rejudge, type Judgement } from '../src/judgement.ts';

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
