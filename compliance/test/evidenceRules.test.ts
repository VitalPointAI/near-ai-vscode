// The mapped-test check (44-07, D-21, pitfall 15): every reason a mapped test can fail is told apart, from a report the real runner wrote
// (fixtures/collectors/tests/root.ndjson, made by make-report.mjs) and a fixture checkout holding the test's source file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkRuleTargets, evaluateTestRule, hasStringLiteral, windowForCollector, type RuleContext } from '../src/rules.ts';
import { readReport } from '../src/collectors/tests.ts';
import type { EvidenceRule, ReasonCode, TestReportRow } from '../src/model.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'collectors');
const CHECKOUT = path.join(FIXTURES, 'checkout');
const SAMPLE = 'src/test/sample.test.ts';
const COMMIT = 'c'.repeat(40);

const rule = (id: string, name: string, suite: readonly string[] = [], file = SAMPLE): EvidenceRule => ({
  id, component: 'fixture', control: 'fx-01', statement: 'fx-01_smt', kind: 'test', test: { file, path: suite, name }
});

const RULES = {
  passes: rule('r-passes', 'sample passes'),
  skipped: rule('r-skipped', 'sample is skipped'),
  todo: rule('r-todo', 'sample is still to do'),
  failed: rule('r-failed', 'sample fails on purpose', ['sample suite']),
  notRun: rule('r-not-run', 'sample runs only when asked'),
  renamed: rule('r-renamed', 'sample passes under its old name'),
  movedSuite: rule('r-moved-suite', 'sample fails on purpose', ['sample suite before it moved']),
  missingFile: rule('r-missing-file', 'sample passes', [], 'src/test/gone.test.ts')
} as const;

async function rootRows(): Promise<TestReportRow[]> {
  const { rows, errors } = await readReport(path.join(FIXTURES, 'tests', 'root.ndjson'));
  assert.deepEqual(errors, []);
  return rows;
}

async function evaluate(target: EvidenceRule): Promise<{ passed: boolean; reason: ReasonCode }> {
  const targets = checkRuleTargets(Object.values(RULES), CHECKOUT);
  const context: RuleContext = { commit: COMMIT, collectedAt: '2026-11-21T12:00:00Z', targets };
  const result = evaluateTestRule(target, await rootRows(), context);
  assert.equal(result.rule, target.id);
  assert.equal(result.commit, COMMIT);
  assert.equal(result.window, 'head');
  return { passed: result.passed, reason: result.reason };
}

test('a mapped test that passed in the report is ok in the checkout and passes', async () => {
  assert.equal(checkRuleTargets([RULES.passes], CHECKOUT).get(RULES.passes.id), 'ok');
  assert.deepEqual(await evaluate(RULES.passes), { passed: true, reason: 'met' });
});

test('a skipped mapped test gives test-skipped', async () => {
  assert.deepEqual(await evaluate(RULES.skipped), { passed: false, reason: 'test-skipped' });
});

test('a todo mapped test gives test-todo', async () => {
  assert.deepEqual(await evaluate(RULES.todo), { passed: false, reason: 'test-todo' });
});

test('a failing mapped test inside a suite gives test-failed', async () => {
  assert.deepEqual(await evaluate(RULES.failed), { passed: false, reason: 'test-failed' });
});

test('a name present in the source but absent from the report gives test-not-run', async () => {
  assert.equal(checkRuleTargets([RULES.notRun], CHECKOUT).get(RULES.notRun.id), 'ok');
  assert.deepEqual(await evaluate(RULES.notRun), { passed: false, reason: 'test-not-run' });
});

test('a name absent from the source gives test-missing-name, even when an old report still holds a passing row for it', async () => {
  assert.deepEqual(await evaluate(RULES.renamed), { passed: false, reason: 'test-missing-name' });
  const staleRow: TestReportRow = { file: 'dist/test/sample.test.js', path: [], name: RULES.renamed.test!.name, status: 'passed', skip: null, ms: 0 };
  const targets = checkRuleTargets([RULES.renamed], CHECKOUT);
  const result = evaluateTestRule(RULES.renamed, [staleRow], { commit: COMMIT, collectedAt: '2026-11-21T12:00:00Z', targets });
  assert.equal(result.reason, 'test-missing-name');
  assert.equal(result.passed, false);
});

test('a suite name absent from the source gives test-missing-name', async () => {
  assert.deepEqual(await evaluate(RULES.movedSuite), { passed: false, reason: 'test-missing-name' });
});

test('a source file that does not exist gives test-missing-file, never an unmatched pass', async () => {
  assert.equal(checkRuleTargets([RULES.missingFile], CHECKOUT).get(RULES.missingFile.id), 'test-missing-file');
  assert.deepEqual(await evaluate(RULES.missingFile), { passed: false, reason: 'test-missing-file' });
});

test('a rule file outside the checkout, absolute, or a folder is test-missing-file', () => {
  const escaping = [
    rule('r-up', 'sample passes', [], '../checkout/src/test/sample.test.ts'),
    rule('r-abs', 'sample passes', [], path.join(CHECKOUT, SAMPLE)),
    rule('r-dir', 'sample passes', [], 'src/test'),
    rule('r-back', 'sample passes', [], 'src\\test\\sample.test.ts'),
    { ...rule('r-none', 'x'), test: undefined }
  ];
  const targets = checkRuleTargets(escaping, CHECKOUT);
  for (const r of escaping) assert.equal(targets.get(r.id), 'test-missing-file', r.id);
});

test('checkRuleTargets answers for test rules only, once per rule', () => {
  const observationRule: EvidenceRule = { id: 'r-obs', component: 'fixture', control: 'fx-01', statement: 'fx-01_smt', kind: 'observation', observation: { collector: 'ci', subject: 'lint' } };
  const targets = checkRuleTargets([...Object.values(RULES), observationRule], CHECKOUT);
  assert.equal(targets.has('r-obs'), false);
  assert.equal(targets.size, Object.values(RULES).length);
  assert.deepEqual([...targets.values()].filter((state) => state === 'ok').length, 5);
});

test('without targets, evaluateTestRule keeps the report-only reasons', async () => {
  const rows = await rootRows();
  const context: RuleContext = { commit: COMMIT, collectedAt: '2026-11-21T12:00:00Z' };
  assert.equal(evaluateTestRule(RULES.missingFile, rows, context).reason, 'test-not-run');
  assert.equal(evaluateTestRule(RULES.passes, rows, context).reason, 'met');
});

test('a test name counts only as a whole quoted string literal, in any of the three quote forms', () => {
  assert.equal(hasStringLiteral("test('the owner\\'s check', () => {});", "the owner's check"), true);
  assert.equal(hasStringLiteral('test("the owner\'s check", () => {});', "the owner's check"), true);
  assert.equal(hasStringLiteral('test(`the owner\'s check`, () => {});', "the owner's check"), true);
  assert.equal(hasStringLiteral('test("say \\"hi\\"", () => {});', 'say "hi"'), true);
  assert.equal(hasStringLiteral("test('the owner check and more', () => {});", 'the owner check'), false);
  assert.equal(hasStringLiteral('// the owner check', 'the owner check'), false);
  assert.equal(hasStringLiteral('test(`case ${n}`, () => {});', 'case 1'), false, 'a name built at run time cannot be mapped');
});

test('the collector windows: documents and the crypto inventory age as documents, run evidence is judged at the head', () => {
  assert.equal(windowForCollector('documents'), 'document');
  assert.equal(windowForCollector('crypto'), 'document');
  for (const id of ['tests', 'ci', 'secret-scan']) assert.equal(windowForCollector(id), 'head');
});
