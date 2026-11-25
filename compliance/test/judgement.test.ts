// 48.2-01 (D-11, D-15): every bundle carries its judgement, the engine inputs of each row with no state and no clock; rejudge at the bundle's
// own generation time reproduces every dashboard row and level count; the release evidence manifest check refuses each kind of mismatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.ts';
import { buildJudgement } from '../src/dashboard.ts';
import { checkEvidenceManifest, EVIDENCE_FORMAT, JUDGEMENT_FORMAT, rejudge, type Judgement, type MeasuredEvidenceFile } from '../src/judgement.ts';
import { NS, type ComponentInput, type DashboardInput, type TestReportRow } from '../src/model.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const TRACER = path.join(here, 'fixtures', 'tracer');
const fixture = (name: string): any => JSON.parse(readFileSync(path.join(TRACER, name), 'utf8'));
const commit = 'a'.repeat(40);

/** The 44-01 tracer fixtures as dashboard input: one level, the fixture catalogue's controls, one component. */
function tracerInput(): DashboardInput {
  const doc = fixture('component.json')['component-definition'];
  const ours = (props: any[] | undefined, name: string) => props?.find((prop) => prop.ns === NS && prop.name === name)?.value;
  const components: ComponentInput[] = doc.components.map((component: any) => ({
    id: ours(component.props, 'component-id'),
    implemented: component['control-implementations'].flatMap((impl: any) => impl['implemented-requirements'].map((req: any) => ({
      control: req['control-id'], responsibility: ours(req.props, 'responsibility'),
      statements: req.statements.map((statement: any) => ({ id: statement['statement-id'], description: statement.description })),
    }))),
  }));
  const testRows: TestReportRow[] = readFileSync(path.join(TRACER, 'report-passed.ndjson'), 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  return {
    commit, generatedAt: '2026-11-21T11:00:00Z', now: new Date('2026-11-21T12:00:00Z'), head: commit,
    levels: [{ id: 'fixture', title: 'Fixture level', controls: fixture('catalog.json').catalog.controls.map((control: { id: string }) => control.id), components: components.map(({ id }) => id) }],
    components, rules: fixture('evidence-rules.json').rules, testRows, observations: [],
  };
}

/** A re-judged row without the freshness annotations rejudge adds (48.2-03), so it can be compared with a dashboard row. */
function dashboardShape(row: any): any {
  const { freshness: _freshness, asOf: _asOf, ...rest } = row;
  return { ...rest, components: row.components.map((component: any) => ({ ...component, evidence: component.evidence.map(({ freshness: _f, source: _s, ...result }: any) => result) })) };
}

/** Every key path in a value, for "no state anywhere" checks. */
function keys(value: unknown, trail = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => keys(item, `${trail}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => [`${trail}.${key}`, ...keys(child, `${trail}.${key}`)]);
  return [];
}

test('judgement from the loop: one row per level, control and component, inputs only, results with their own fields', () => {
  const input = tracerInput();
  const { dashboard, judgement } = buildJudgement(input);
  assert.equal(judgement.format, JUDGEMENT_FORMAT);
  assert.equal(judgement.rows.length, dashboard.rows.length);
  assert.deepEqual(judgement.rows.map(({ level, control }) => `${level}/${control}`), dashboard.rows.map(({ level, control }) => `${level}/${control}`));
  for (const row of judgement.rows) assert.deepEqual(row.components.map(({ component }) => component), input.levels[0]!.components);
  const paths = keys(judgement);
  assert.deepEqual(paths.filter((key) => /\.state$/.test(key)), [], 'no state key anywhere in the judgement');
  for (const row of judgement.rows) {
    for (const holder of [row, ...row.components]) for (const outcome of ['state', 'reason', 'detail', 'reasonText']) assert.equal(Object.hasOwn(holder, outcome), false, `${row.control} carries ${outcome}`);
  }
  const met = judgement.rows.find((row) => row.control === 'tr-01')!.components[0]!;
  assert.deepEqual(Object.values(met.results), [{ rule: 'tracer-fixture.tr-01.proves', passed: true, reason: 'met', collectedAt: '2026-11-21T11:00:00Z', commit, window: 'head' }]);
  assert.equal(Object.hasOwn(judgement, 'now'), false);
  // The same judgement read back from JSON and judged at the dashboard's clock gives the dashboard's rows.
  const again = rejudge(JSON.parse(JSON.stringify(judgement)) as Judgement, { now: input.now });
  assert.deepEqual(again.rows.map(dashboardShape), JSON.parse(JSON.stringify(dashboard.rows)));
});

test('parity: a bundle from the real compliance sources carries its judgement, and rejudge at generatedAt reproduces every row and level count', async () => {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'near-ai-judgement-'));
  const out = path.join(dir, 'bundle');
  const sbom = path.join(repoRoot, 'compliance/test/fixtures/collectors/sbom/vsix.cdx.json');
  const audit = path.join(repoRoot, 'compliance/test/fixtures/collectors/audit/root.json');
  const report = path.join(dir, 'root.ndjson');
  const rules = JSON.parse(readFileSync(path.join(repoRoot, 'compliance/evidence-rules/release-pipeline.json'), 'utf8'));
  const regression = rules.rules.find(({ id }: { id: string }) => id === 'release.si-02.policy-feature-regression').test;
  writeFileSync(report, JSON.stringify({ ...regression, status: 'passed', skip: null, ms: 1 }));
  const collectors = { sbom: { sboms: [{ subject: 'vsix', file: sbom }] }, audit: { audits: [{ package: 'root', file: audit }] }, tests: { reports: [{ package: 'root', file: report }] } };
  writeFileSync(path.join(dir, 'inputs.json'), JSON.stringify({ repository: 'owner/repo', commit, kind: 'main', repoRoot, collectors }));
  assert.equal(await main(['bundle', '--inputs', path.join(dir, 'inputs.json'), '--out', out]), 0);
  const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.some(({ path: file }: { path: string }) => file === 'dashboard/judgement.json'), 'the manifest lists the judgement');
  const dashboard = JSON.parse(readFileSync(path.join(out, 'dashboard/dashboard.json'), 'utf8'));
  const judgement = JSON.parse(readFileSync(path.join(out, 'dashboard/judgement.json'), 'utf8')) as Judgement;
  assert.equal(judgement.generatedAt, dashboard.generatedAt);
  const { levels } = JSON.parse(readFileSync(path.join(repoRoot, 'compliance/levels.json'), 'utf8')) as { levels: { id: string }[] };
  assert.deepEqual(new Set(dashboard.rows.map(({ level }: { level: string }) => level)), new Set(levels.map(({ id }) => id)), 'every level has rows');
  const judged = rejudge(judgement, { now: new Date(judgement.generatedAt) });
  assert.equal(judged.rows.length, dashboard.rows.length);
  for (const [index, row] of judged.rows.entries()) assert.deepStrictEqual(dashboardShape(row), dashboard.rows[index], `${row.level}/${row.control}`);
  assert.deepStrictEqual(judged.levels, dashboard.levels);
  // The parity covers each branch of the one row rule: a level with no claim, an aggregate of components, and single outcomes.
  const outcomes = new Set(judged.rows.map(({ state, reason }) => `${state}:${reason}`));
  for (const outcome of ['not-met:appliance-only', 'partly-met:partly-statements', 'your-organizations-responsibility:your-organization', 'not-met:no-statement', 'not-met:test-not-run']) assert.ok(outcomes.has(outcome), outcome);
  assert.ok(judged.rows.some(({ textFile }) => textFile) && judged.rows.some(({ gap }) => gap), 'the presentation fields travel with the rows');
  // H-11 (44.1-05 with 48.2-01): the bundle's judgement carries each silent component's applicability, so re-judging reproduces the
  // applicability reasons: the signed stage 1 levels read Not applicable to this component, the unsigned levels read it awaiting sign-off.
  const componentReasons = new Set<string>(judged.rows.flatMap(({ components }) => components.map(({ reason }) => reason)));
  for (const reason of ['component-not-applicable', 'component-not-applicable-unreviewed']) assert.ok(componentReasons.has(reason), reason);
  assert.ok(judgement.rows.some(({ components }) => components.some((component) => component.applicability?.class === 'not-applicable')), 'the judgement carries applicability');
});

test('H-11: a row whose every component the signed map gives no part reads no-component-applies, in the dashboard and re-judged alike', () => {
  const tracer = tracerInput();
  // One silent component, so the map answers for every pair (a component with a statement has a part whatever the map says).
  const input: DashboardInput = { ...tracer, components: [{ id: 'silent', implemented: [] }], levels: [{ ...tracer.levels[0]!, components: ['silent'] }] };
  const record = (reviewed: boolean) => ({ class: 'not-applicable' as const, reason: 'Fixture: this component has no part in the control.', reviewed });
  for (const reviewed of [true, false]) {
    const applicability = { rules: {} as any, reviews: { kind: 'reviews', stages: [] } as any, sectionHash: () => '', for: () => record(reviewed) };
    const { dashboard, judgement } = buildJudgement({ ...input, applicability });
    assert.ok(dashboard.rows.length > 0);
    for (const row of dashboard.rows) {
      const cells: readonly any[] = row.components;
      if (reviewed) {
        assert.deepEqual([row.state, row.reason], ['your-organizations-responsibility', 'no-component-applies'], row.control);
        assert.ok(cells.every((cell) => cell.reason === 'component-not-applicable' && cell.responsibility === 'not-applicable' && cell.applicability === 'not-applicable'), row.control);
      } else {
        assert.deepEqual([row.state, row.reason], ['not-met', 'component-not-applicable-unreviewed'], row.control);
        assert.ok(cells.every((cell) => cell.responsibility !== 'not-applicable'), row.control);
      }
    }
    const again = rejudge(JSON.parse(JSON.stringify(judgement)) as Judgement, { now: input.now });
    assert.deepEqual(again.rows.map(dashboardShape), JSON.parse(JSON.stringify(dashboard.rows)));
  }
});

test('manifest check: a missing or extra file, a size or hash mismatch, an unknown format and a missing field each refuse with their own reason', () => {
  const content = (text: string) => ({ size: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
  const files: MeasuredEvidenceFile[] = [
    { path: 'bundle/dashboard/judgement.json', ...content('{}') },
    { path: 'sbom/sterling-image.cdx.json', ...content('sbom') },
  ];
  const manifest = {
    format: EVIDENCE_FORMAT, release: '0.5.0', commit, builtAt: '2026-11-25T10:00:00Z', subject: `sha256:${'c'.repeat(64)}`, bundle: 'included', package: 'none',
    files: files.map((file) => ({ ...file })),
  };
  assert.equal(checkEvidenceManifest(manifest, files).ok, true);
  const refused = (value: unknown, measured: readonly MeasuredEvidenceFile[] = files) => {
    const result = checkEvidenceManifest(value, measured);
    return result.ok ? 'ok' : `${result.reason}:${result.file}`;
  };
  assert.equal(refused(manifest, files.slice(1)), 'missing:bundle/dashboard/judgement.json');
  assert.equal(refused(manifest, [...files, { path: 'scan/grype.json', ...content('[]') }]), 'extra:scan/grype.json');
  assert.equal(refused(manifest, [files[0]!, { path: 'sbom/sterling-image.cdx.json', ...content('sbom!') }]), 'size:sbom/sterling-image.cdx.json');
  assert.equal(refused(manifest, [files[0]!, { path: 'sbom/sterling-image.cdx.json', ...content('SBOM') }]), 'hash:sbom/sterling-image.cdx.json');
  assert.equal(refused(manifest, [files[0]!, { path: 'sbom/sterling-image.cdx.json', link: true }]), 'symlink:sbom/sterling-image.cdx.json');
  assert.equal(refused({ ...manifest, format: 'sterling-evidence/2' }), 'format:manifest.json');
  for (const field of ['release', 'commit', 'builtAt', 'subject', 'bundle', 'package', 'files']) {
    const { [field]: _dropped, ...rest } = manifest as Record<string, unknown>;
    assert.equal(refused(rest), 'field:manifest.json', field);
  }
  assert.equal(refused({ ...manifest, files: [...manifest.files, { path: '../escape', ...content('x') }] }), 'path:../escape');
  assert.equal(refused({ ...manifest, bundle: 'none', files: manifest.files.slice(1) }, files.slice(1)), 'ok', 'a release with no bundle needs no judgement');
});
