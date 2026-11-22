// The non-fixture tracer for the first product control.  It proves that a
// committed report row is required before evidence can affect a real page.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadComponents } from '../src/components.ts';
import { loadEvidenceRules } from '../src/evidenceRuleFiles.ts';
import { buildDashboard } from '../src/dashboard.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const report = () => readFileSync(path.join(ROOT, 'compliance', 'test', 'fixtures', 'content', 'gate-report.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const input = (rows = report()) => ({ commit: 'a'.repeat(40), head: 'a'.repeat(40), generatedAt: '2026-11-21T00:00:00Z', now: new Date('2026-11-21T00:00:00Z'), levels: [{ id: 'protected-b', title: 'Protected B', controls: ['ac-03'], components: ['extension'] }], components: loadComponents(path.join(ROOT, 'compliance', 'components')).components, rules: loadEvidenceRules(path.join(ROOT, 'compliance', 'evidence-rules')), observations: [], testRows: rows });

test('a real extension statement, rule, and gate report exist for ac-03', () => {
  assert.ok(existsSync(path.join(ROOT, 'compliance', 'components', 'extension.json')), 'the source statement must exist');
  assert.ok(existsSync(path.join(ROOT, 'compliance', 'evidence-rules', 'extension.json')), 'the source rule must exist');
  assert.ok(existsSync(path.join(ROOT, 'compliance', 'test', 'fixtures', 'content', 'gate-report.ndjson')), 'the proof report must exist');
});

test('the compiled gate report makes ac-03 met with named, current evidence', () => {
  const row = buildDashboard(input()).rows[0]!;
  assert.equal(row.state, 'met');
  assert.equal(row.components[0]?.evidence[0]?.rule, 'extension.ac-03.gate-decision');
  assert.equal(row.components[0]?.evidence[0]?.commit, 'a'.repeat(40));
});

test('a skipped or absent gate row leaves ac-03 not met', () => {
  const skipped = report().map((row) => row.name.startsWith('tracer:') ? { ...row, status: 'skipped' } : row);
  assert.equal(buildDashboard(input(skipped)).rows[0]!.reason, 'test-skipped');
  const absent = report().filter((row) => !row.name.startsWith('tracer:'));
  assert.equal(buildDashboard(input(absent)).rows[0]!.reason, 'test-not-run');
});
