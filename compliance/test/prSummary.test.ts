import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prSummary, renderPrSummary } from '../src/prSummary.ts';

const fixtureUrl = (name: string) => new URL(`./fixtures/prsummary/${name}`, import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(fixtureUrl(name), 'utf8'));
const main = fixture('main-dashboard.json'); const pr = fixture('pr-inputs.json'); const changed = readFileSync(fixtureUrl('changed-files.txt'), 'utf8').trim().split('\n');

test('reports a removed mapped test as a Not met drop with its reason', () => { const result = prSummary(main, pr, changed); assert.match(renderPrSummary(result), /AC-1.*Not met.*test-missing-name/s); });
test('reports a 25-hour audit as Stale', () => { const result = prSummary(main, pr, changed); assert.match(renderPrSummary(result), /AU-2.*Stale/s); });
test('omits unchanged rows', () => { const result = prSummary(main, pr, changed); assert.ok(!renderPrSummary(result).includes('CM-1')); });
test('reports no state changes plainly', () => { assert.match(renderPrSummary(prSummary(main, main, [])), /No control changed state/); });
test('counts drops without a review change', () => { assert.equal(prSummary(main, pr, changed).dropsWithoutReview, 2); });
test('recognizes tailoring or POA&M review changes', () => { assert.equal(prSummary(main, pr, ['compliance/tailoring/ac-1.json']).dropsWithoutReview, 0); });
test('caps rendered rows at fifty', () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({ level: 'protected-b', control: `ac-${index}`, label: `AC-${index}`, state: 'not-met', reason: 'no-rules', reasonText: 'No rule.', components: [] }));
  const many = { ...pr, rows };
  const prior = { ...main, rows: rows.map((row) => ({ ...row, state: 'met' })) };
  assert.match(renderPrSummary(prSummary(prior, many, [])), /10 more/);
});
