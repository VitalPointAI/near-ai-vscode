// The non-fixture tracer for the first product control.  It proves that a
// committed report row is required before evidence can affect a real page.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadComponents } from '../src/components.ts';
import { loadEvidenceRules } from '../src/evidenceRuleFiles.ts';
import { buildDashboard } from '../src/dashboard.ts';
import { checkRuleTargets } from '../src/rules.ts';
import { run as runBundleCommand } from '../src/commands/bundle.ts';

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

// 48-07 (D-12, D-14): the first workbench control on the real hosted Protected B level, from a Phase 46 test row in the workbench package's
// report. The fixture holds every row of a real local run of the workbench unit tests (NEAR_AI_TEST_REPORT, `npm test` in workbench/ on
// Node 26), whose files the tests collector maps from dist/test/*.js back to workbench/test/*.ts exactly as CI's report is read.
const WORKBENCH_REPORT = path.join(ROOT, 'compliance', 'test', 'fixtures', 'content', 'workbench-report.ndjson');
const TRACER_RULE = 'workbench.ia-05.kv-write';
const workbenchRows = () => readFileSync(WORKBENCH_REPORT, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

/** The workbench row of hosted Protected B ia-05 from a bundle over the real sources with the given workbench report rows (none: no input). */
async function hostedWorkbench(rows: readonly unknown[] | undefined): Promise<any> {
  const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-workbench-'));
  const collectors: Record<string, unknown> = {};
  if (rows) {
    const file = path.join(dir, 'test-report-workbench.ndjson');
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    collectors.tests = { reports: [{ package: 'workbench', file }] };
  }
  const inputs = path.join(dir, 'inputs.json');
  writeFileSync(inputs, JSON.stringify({ repository: 'owner/repo', commit: 'a'.repeat(40), kind: 'pr', repoRoot: ROOT, collectors }));
  const out = path.join(dir, 'out');
  assert.equal(await runBundleCommand(['--inputs', inputs, '--out', out]), 0);
  const dashboard = JSON.parse(readFileSync(path.join(out, 'dashboard', 'dashboard.json'), 'utf8'));
  return dashboard.rows.find((row: any) => row.level === 'hosted-protected-b' && row.control === 'ia-05')?.components.find((item: any) => item.component === 'workbench');
}

test('every workbench test rule names a Phase 46 test that exists literally in its file and passed in the fixture run', () => {
  const rules = loadEvidenceRules(path.join(ROOT, 'compliance', 'evidence-rules'));
  const tracer = rules.find((item) => item.id === TRACER_RULE);
  assert.equal(tracer?.component, 'workbench');
  assert.equal(tracer?.test?.file, 'workbench/test/key-store.test.ts');
  const workbench = rules.filter((item) => item.component === 'workbench' && item.kind === 'test');
  assert.deepEqual([...checkRuleTargets(workbench, ROOT).entries()].filter(([, state]) => state !== 'ok'), []);
  // The generated supply-chain rules (44.1-09, ids ending .inventory) cite the register check in the root report; supplyChainStatements.test.ts
  // checks those. Every other workbench test rule is a Phase 46 test of the workbench report.
  for (const item of workbench.filter((rule) => !rule.id.endsWith('.inventory'))) {
    const compiled = item.test!.file.replace(/^workbench\/test\/(.+)\.ts$/, 'dist/test/$1.js');
    assert.ok(workbenchRows().some((row) => row.file === compiled && row.name === item.test!.name && row.status === 'passed'), `${item.id}: no passing fixture row`);
  }
});

test('the workbench report makes the per-person secret store Met on hosted Protected B; skipped reads test-skipped, absent test-not-run', async () => {
  const name = loadEvidenceRules(path.join(ROOT, 'compliance', 'evidence-rules')).find((item) => item.id === TRACER_RULE)!.test!.name;
  const met = await hostedWorkbench(workbenchRows());
  assert.equal(met?.state, 'met', met?.reason);
  assert.ok(met.evidence.some((item: any) => item.rule === TRACER_RULE && item.passed === true));
  const skipped = await hostedWorkbench(workbenchRows().map((row) => row.name === name ? { ...row, status: 'skipped' } : row));
  assert.deepEqual([skipped?.state, skipped?.reason], ['not-met', 'test-skipped']);
  const absent = await hostedWorkbench(workbenchRows().filter((row) => row.name !== name));
  assert.deepEqual([absent?.state, absent?.reason], ['not-met', 'test-not-run']);
  const none = await hostedWorkbench(undefined);
  assert.notEqual(none?.state, 'met');
});
