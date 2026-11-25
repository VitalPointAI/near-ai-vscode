// Success criterion 2 of Phase 48 on the real sources (48-08, D-12, D-14, VER-04, VER-05): a hosted component's statement reads Met on the
// hosted Protected B level only from a collected passing result of its rule, and every hosted row traces to its rules and their results.
// The report fixture holds the rows of a real local run of every deploy/test file (NEAR_AI_TEST_REPORT), read by the tests collector
// through the bundle command exactly as CI reads the deploy package's report. A statement that also needs the running site reads Met only
// with a fresh export signed by a key in the trust list, Stale once that export is older than 7 days, and missing-result with no export;
// the export is signed by a key generated here, listed in a temporary trust list (no key is committed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as runBundleCommand } from '../src/commands/bundle.ts';
import { loadComponents } from '../src/components.ts';
import { loadEvidenceRules } from '../src/evidenceRuleFiles.ts';
import { loadTailoring } from '../src/tailoring.ts';
import { buildUnsignedExport, signExport } from '../src/siteExport.ts';
import { compliantFacts, freshKey, signersText } from './fixtures/collectors/deployment/helpers.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPLIANCE = path.join(ROOT, 'compliance');
const REPORT = path.join(COMPLIANCE, 'test', 'fixtures', 'hosted', 'deploy-report.ndjson');
const LEVEL = 'hosted-protected-b';
const RENDER_TEST = 'every rendered release meets the global invariants';

/** The Phase 47 statements on main, each proven by the render test's global invariants. */
const BATCH = [
  { component: 'rke2', control: 'cm-07', rule: 'rke2.cm-07.no-k3s' },
  { component: 'ingress', control: 'cm-07', rule: 'ingress.cm-07.no-ingress-nginx' },
  { component: 'cert-manager', control: 'sc-17', rule: 'cert-manager.sc-17.no-acme' }
] as const;

/** Every hosted component and control whose statements rest only on deploy report tests: each must read Met from the passing report alone. */
function deployOnlyPairs(): { component: string; control: string; rules: string[] }[] {
  const hosted = levels().find((level) => level.id === LEVEL)!;
  const rules = loadEvidenceRules(path.join(COMPLIANCE, 'evidence-rules'));
  return loadComponents(path.join(COMPLIANCE, 'components')).components.filter((component) => hosted.components.includes(component.id))
    .flatMap((component) => component.implemented.filter((item) => item.statements.length > 0).map((item) => ({
      component: component.id, control: item.control,
      rules: rules.filter((rule) => rule.component === component.id && rule.control === item.control)
    })))
    .filter(({ rules: list }) => list.length > 0 && list.every((rule) => rule.kind === 'test' && rule.test!.file.startsWith('deploy/test/')))
    .map((pair) => ({ ...pair, rules: pair.rules.map((rule) => rule.id).sort() }));
}

const levels = () => (JSON.parse(readFileSync(path.join(COMPLIANCE, 'levels.json'), 'utf8')).levels as { id: string; components: string[] }[]);
const reportRows = () => readFileSync(REPORT, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

/**
 * Runs the bundle command over the checkout's real sources with the given deploy report rows (none: no tests input at all) and, when
 * `exportAgeMs` is given, a site export of the compliant fixture facts signed that long before now by a fresh key in a temporary trust list.
 */
async function bundle(rows?: readonly unknown[], exportAgeMs?: number): Promise<{ dashboard: any; testRows: any[]; observations: any[] }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-hosted-'));
  const collectors: Record<string, unknown> = {};
  if (rows) {
    const file = path.join(dir, 'test-report-deploy.ndjson');
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    collectors.tests = { reports: [{ package: 'deploy', file }] };
  }
  if (exportAgeMs !== undefined) {
    const key = freshKey();
    const signedAt = new Date(Date.now() - exportAgeMs).toISOString();
    writeFileSync(path.join(dir, 'export.json'), JSON.stringify(signExport(buildUnsignedExport('fixture-site', signedAt, compliantFacts(), key.publicKey), key.privateKeyPem)));
    writeFileSync(path.join(dir, 'site-signers.json'), signersText(key));
    collectors.deployment = { file: path.join(dir, 'export.json'), signersFile: path.join(dir, 'site-signers.json') };
  }
  const inputs = path.join(dir, 'inputs.json');
  writeFileSync(inputs, JSON.stringify({ repository: 'owner/repo', commit: 'a'.repeat(40), kind: 'pr', repoRoot: ROOT, collectors }));
  const out = path.join(dir, 'out');
  assert.equal(await runBundleCommand(['--inputs', inputs, '--out', out]), 0);
  const read = (file: string) => JSON.parse(readFileSync(path.join(out, file), 'utf8'));
  return { dashboard: read('dashboard/dashboard.json'), testRows: read('test-rows.json'), observations: read('observations.json').observations };
}
let passing: ReturnType<typeof bundle> | undefined;
const passingBundle = () => (passing ??= bundle(reportRows()));

const componentRow = (dashboard: any, control: string, component: string) =>
  dashboard.rows.find((row: any) => row.level === LEVEL && row.control === control)?.components.find((item: any) => item.component === component);

test('the report fixture holds a passing row of the render test that the batch rules name', () => {
  const rules = loadEvidenceRules(path.join(COMPLIANCE, 'evidence-rules'));
  assert.ok(reportRows().some((row) => row.file === 'deploy/test/render.test.mjs' && row.name === RENDER_TEST && row.status === 'passed'));
  for (const { rule } of BATCH) assert.deepEqual(rules.find((item) => item.id === rule)?.test, { file: 'deploy/test/render.test.mjs', path: [], name: RENDER_TEST }, rule);
});

test('a passing render-test row makes each batch statement Met for its component on hosted Protected B', async () => {
  const { dashboard } = await passingBundle();
  for (const { component, control, rule } of BATCH) {
    const row = componentRow(dashboard, control, component);
    assert.equal(row?.state, 'met', `${control}/${component}: ${row?.reason}`);
    assert.deepEqual(row.evidence.map((item: any) => [item.rule, item.passed]), [[rule, true]], `${control}/${component}`);
  }
});

test('every hosted statement proven only by deploy tests names passing rows of the fixture and reads Met from it on hosted Protected B', async () => {
  const rules = loadEvidenceRules(path.join(COMPLIANCE, 'evidence-rules'));
  const pairs = deployOnlyPairs();
  assert.ok(pairs.length > BATCH.length, 'the later batches add statements proven by deploy tests');
  const { dashboard } = await passingBundle();
  for (const { component, control, rules: ids } of pairs) {
    for (const id of ids) {
      const target = rules.find((rule) => rule.id === id)!.test!;
      assert.ok(reportRows().some((row) => row.file === target.file && row.name === target.name && row.status === 'passed'), `${id}: no passing fixture row`);
    }
    const row = componentRow(dashboard, control, component);
    assert.equal(row?.state, 'met', `${control}/${component}: ${row?.reason}`);
    assert.deepEqual(row.evidence.map((item: any) => item.rule).sort(), ids, `${control}/${component}`);
  }
});

test('with every deploy row failed, or no deploy report, no statement proven only by deploy tests reads Met', async () => {
  const failed = await bundle(reportRows().map((row) => ({ ...row, status: 'failed' })));
  const absent = await bundle();
  for (const { component, control } of deployOnlyPairs()) {
    assert.equal(componentRow(failed.dashboard, control, component)?.reason, 'test-failed', `${control}/${component}`);
    assert.equal(componentRow(absent.dashboard, control, component)?.reason, 'test-not-run', `${control}/${component}`);
  }
});

test('a failed render-test row, or no deploy report, leaves each batch statement not Met', async () => {
  const failed = await bundle(reportRows().map((row) => row.name === RENDER_TEST ? { ...row, status: 'failed' } : row));
  const absent = await bundle();
  for (const { component, control } of BATCH) {
    assert.equal(componentRow(failed.dashboard, control, component)?.reason, 'test-failed', `${control}/${component}`);
    assert.equal(componentRow(absent.dashboard, control, component)?.reason, 'test-not-run', `${control}/${component}`);
    assert.notEqual(componentRow(absent.dashboard, control, component)?.state, 'met', `${control}/${component}`);
  }
});

const HOUR_MS = 60 * 60 * 1000;
const KEYCLOAK = { control: 'ia-02', rules: ['keycloak.ia-02.live-no-otp', 'keycloak.ia-02.live-no-password', 'keycloak.ia-02.realm-actions', 'keycloak.ia-02.realm-flows'] };

test('the Keycloak sign-in statement names the realm tests and both live authenticator observations', () => {
  const rules = loadEvidenceRules(path.join(COMPLIANCE, 'evidence-rules')).filter((rule) => rule.component === 'keycloak' && rule.control === KEYCLOAK.control);
  assert.deepEqual(rules.map((rule) => rule.id).sort(), KEYCLOAK.rules);
  assert.deepEqual(rules.filter((rule) => rule.kind === 'observation').map((rule) => rule.observation).sort((a, b) => a!.subject.localeCompare(b!.subject)),
    [{ collector: 'deployment', subject: 'keycloak/no-otp-authenticator' }, { collector: 'deployment', subject: 'keycloak/no-password-authenticator' }]);
  for (const rule of rules.filter((item) => item.kind === 'test')) {
    assert.equal(rule.test?.file, 'deploy/test/realm.test.mjs');
    assert.ok(reportRows().some((row) => row.file === rule.test?.file && row.name === rule.test?.name && row.status === 'passed'), rule.id);
  }
});

test('the Keycloak sign-in statement is Met with the passing realm tests and an export signed an hour ago, Stale at 8 days, missing-result without one', async () => {
  const fresh = componentRow((await bundle(reportRows(), HOUR_MS)).dashboard, KEYCLOAK.control, 'keycloak');
  assert.equal(fresh?.state, 'met', fresh?.reason);
  assert.deepEqual(fresh.evidence.map((item: any) => item.rule).sort(), KEYCLOAK.rules);
  const lapsed = componentRow((await bundle(reportRows(), 8 * 24 * HOUR_MS)).dashboard, KEYCLOAK.control, 'keycloak');
  assert.equal(lapsed?.state, 'stale', lapsed?.reason);
  const none = componentRow((await passingBundle()).dashboard, KEYCLOAK.control, 'keycloak');
  assert.deepEqual([none?.state, none?.reason], ['not-met', 'missing-result']);
});

test('every hosted Protected B row lists every hosted component and traces each stated component to its rules and collected results', async () => {
  const { dashboard, testRows, observations } = await passingBundle();
  const hosted = levels().find((level) => level.id === LEVEL)!;
  const rules = loadEvidenceRules(path.join(COMPLIANCE, 'evidence-rules'));
  const stated = new Set(loadComponents(path.join(COMPLIANCE, 'components')).components
    .flatMap((component) => component.implemented.filter((item) => item.statements.length > 0).map((item) => `${component.id}/${item.control}`)));
  const rows = dashboard.rows.filter((row: any) => row.level === LEVEL);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.deepEqual(row.components.map((item: any) => item.component), hosted.components, row.control);
    for (const item of row.components) {
      const at = `${row.control}/${item.component}`;
      const expected = rules.filter((rule) => rule.component === item.component && rule.control === row.control).map((rule) => rule.id).sort();
      if (!stated.has(`${item.component}/${row.control}`)) { assert.deepEqual(item.evidence, [], at); continue; }
      assert.deepEqual(item.evidence.map((result: any) => result.rule).sort(), expected, at);
      for (const result of item.evidence.filter((entry: any) => entry.passed)) {
        const rule = rules.find((entry) => entry.id === result.rule)!;
        const collected = rule.kind === 'test'
          ? testRows.some((entry) => entry.file === rule.test?.file && entry.name === rule.test?.name && entry.status === 'passed')
          : observations.some((entry) => entry.collector === rule.observation?.collector && entry.subject === rule.observation?.subject && entry.passed);
        assert.ok(collected, `${at}: ${result.rule} reads passed without a collected result in the bundle`);
      }
    }
  }
});

test('no tailoring file names a hosted level', () => {
  const hosted = new Set(levels().filter((level) => level.id.startsWith('hosted-')).map((level) => level.id));
  assert.ok(hosted.has(LEVEL));
  const tailoring = loadTailoring(path.join(COMPLIANCE, 'tailoring'));
  assert.deepEqual([...tailoring.notApplicable, ...tailoring.removals].filter((entry) => hosted.has(entry.level)), []);
});
