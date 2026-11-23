// Tracer (44-01): one fixture control travels from an OSCAL catalogue through a component statement, an evidence rule and a per-test report row to
// a computed state in the dashboard JSON. The fixtures are written for these tests and quote no published catalogue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildDashboard } from '../src/dashboard.ts';
import { computeStatus } from '../src/status.ts';
import { evaluateObservationRule, evaluateTestRule } from '../src/rules.ts';
import {
  NS, RESPONSIBILITIES, STATES, sourcePathForReport,
  type ComponentInput, type DashboardInput, type EvidenceRule, type Observation, type Responsibility, type StatusInput, type TestReportRow
} from '../src/model.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tracer');
const readFixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');
const readJsonFixture = (name: string): any => JSON.parse(readFixture(name));
const readNdjson = (name: string): TestReportRow[] => readFixture(name).split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));

const EVIDENCE_COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const NOW = new Date('2026-11-21T12:00:00Z');

/** The catalogue's control ids: the level's scope. */
function catalogControls(): string[] {
  return readJsonFixture('catalog.json').catalog.controls.map((control: { id: string }) => control.id);
}

/** A minimal reading of the fixture component definition: our NS props only (44-05 writes the real loader). */
function fixtureComponents(responsibilityOverride?: Responsibility): ComponentInput[] {
  const doc = readJsonFixture('component.json')['component-definition'];
  return doc.components.map((component: any) => {
    const ours = (props: any[] | undefined, name: string): string | undefined => props?.find((prop) => prop.ns === NS && prop.name === name)?.value;
    return {
      id: ours(component.props, 'component-id'),
      implemented: component['control-implementations'].flatMap((impl: any) => impl['implemented-requirements'].map((req: any) => {
        const responsibility = responsibilityOverride ?? ours(req.props, 'responsibility');
        assert.ok(RESPONSIBILITIES.includes(responsibility as Responsibility), `fixture responsibility ${responsibility}`);
        return {
          control: req['control-id'],
          responsibility,
          statements: req.statements.map((statement: any) => ({ id: statement['statement-id'], description: statement.description }))
        };
      }))
    };
  });
}

function fixtureRules(): EvidenceRule[] {
  return readJsonFixture('evidence-rules.json').rules;
}

function input(overrides: Partial<DashboardInput> = {}): DashboardInput {
  return {
    commit: EVIDENCE_COMMIT,
    generatedAt: '2026-11-21T11:00:00Z',
    now: NOW,
    head: EVIDENCE_COMMIT,
    levels: [{ id: 'fixture', title: 'Fixture level', controls: catalogControls(), components: ['tracer-fixture'] }],
    components: fixtureComponents(),
    rules: fixtureRules(),
    testRows: readNdjson('report-passed.ndjson'),
    observations: [],
    ...overrides
  };
}

function fixtureRow(dashboardInput: DashboardInput) {
  const dashboard = buildDashboard(dashboardInput);
  const row = dashboard.rows.find((candidate) => candidate.level === 'fixture' && candidate.control === 'tr-01');
  assert.ok(row, 'the dashboard has a row for level fixture, control tr-01');
  return { dashboard, row };
}

test('a passing report row makes the fixture control met, with one head-window result on its one component row', () => {
  const { dashboard, row } = fixtureRow(input());
  assert.equal(dashboard.schemaVersion, 1);
  assert.equal(dashboard.commit, EVIDENCE_COMMIT);
  assert.equal(dashboard.generatedAt, '2026-11-21T11:00:00Z');
  assert.equal(row.state, 'met');
  assert.equal(row.reason, 'met');
  assert.equal(row.components.length, 1);
  const [component] = row.components;
  assert.equal(component.component, 'tracer-fixture');
  assert.equal(component.state, 'met');
  assert.equal(component.responsibility, 'product');
  assert.equal(component.evidence.length, 1);
  assert.deepEqual(component.evidence[0], {
    rule: 'tracer-fixture.tr-01.proves', passed: true, reason: 'met', collectedAt: '2026-11-21T11:00:00Z', commit: EVIDENCE_COMMIT, window: 'head'
  });
  assert.equal(JSON.parse(JSON.stringify(dashboard)).rows[0].state, 'met', 'the state survives the JSON the pages read');
});

test('the same row skipped makes the control not met with reason test-skipped', () => {
  const { row } = fixtureRow(input({ testRows: readNdjson('report-skipped.ndjson') }));
  assert.equal(row.state, 'not-met');
  assert.equal(row.reason, 'test-skipped');
  assert.equal(row.components[0].evidence[0].passed, false);
});

test('the passing row judged against another head commit is stale', () => {
  const { row } = fixtureRow(input({ head: OTHER_COMMIT }));
  assert.equal(row.state, 'stale');
  assert.equal(row.reason, 'stale');
  assert.equal(row.detail?.date, '2026-11-21T11:00:00Z');
});

test('no report row at all makes the control not met with reason test-not-run', () => {
  const { row } = fixtureRow(input({ testRows: [] }));
  assert.equal(row.state, 'not-met');
  assert.equal(row.reason, 'test-not-run');
});

test('your organization responsibility is your-organizations-responsibility and never met, even with passing evidence', () => {
  const { row } = fixtureRow(input({ components: fixtureComponents('your-organization') }));
  assert.equal(row.state, 'your-organizations-responsibility');
  assert.equal(row.reason, 'your-organization');
  const inherited = fixtureRow(input({ components: fixtureComponents('inherited') })).row;
  assert.equal(inherited.state, 'your-organizations-responsibility');
  assert.equal(inherited.reason, 'inherited');
  const notApplicable = fixtureRow(input({ components: fixtureComponents('not-applicable') })).row;
  assert.equal(notApplicable.state, 'not-met', 'not applicable without a reviewed tailoring record counts as not met');
  assert.equal(notApplicable.reason, 'not-applicable-unreviewed');
});

test('a control no component implements is not met with reason no-statement', () => {
  const { row } = fixtureRow(input({ components: [] }));
  assert.equal(row.state, 'not-met');
  assert.equal(row.reason, 'no-statement');
  assert.deepEqual(row.components.map(({ component, state, reason }) => [component, state, reason]), [['tracer-fixture', 'not-met', 'no-statement']]);
});

test('one component meeting a control does not make it met while another in-scope component is silent', () => {
  const level = { id: 'fixture', title: 'Fixture level', controls: catalogControls(), components: ['tracer-fixture', 'silent-service'] };
  const { row, dashboard } = fixtureRow(input({ levels: [level] }));
  assert.equal(row.state, 'partly-met');
  assert.deepEqual(row.components.map(({ component, state, reason }) => [component, state, reason]),
    [['tracer-fixture', 'met', 'met'], ['silent-service', 'not-met', 'no-statement']]);
  assert.equal(dashboard.matrix.some((entry) => entry.component === 'silent-service'), false, 'a silent component adds no responsibility matrix row');
});

function statusInput(overrides: Partial<StatusInput> = {}): StatusInput {
  const [rule] = fixtureRules();
  return {
    control: 'tr-01', component: 'tracer-fixture', level: 'fixture', responsibility: 'product',
    statements: [{ id: 'tr-01_smt', description: 'Each tracer event is recorded.' }],
    rulesByStatement: { 'tr-01_smt': [rule] },
    results: { [rule.id]: { rule: rule.id, passed: true, reason: 'met', collectedAt: '2026-11-21T11:00:00Z', commit: EVIDENCE_COMMIT, window: 'head' } },
    head: EVIDENCE_COMMIT,
    now: NOW,
    ...overrides
  };
}

test('computeStatus never returns met when any rule has no result', () => {
  const [rule] = fixtureRules();
  const second: EvidenceRule = { ...rule, id: 'tracer-fixture.tr-01.second' };
  const outcome = computeStatus(statusInput({ rulesByStatement: { 'tr-01_smt': [rule, second] } }));
  assert.deepEqual(outcome, { state: 'not-met', reason: 'missing-result' });
  assert.deepEqual(computeStatus(statusInput()), { state: 'met', reason: 'met' });
});

test('a statement with no rules is not met with reason no-rules; no statements at all is no-statement', () => {
  assert.deepEqual(computeStatus(statusInput({ rulesByStatement: {} })), { state: 'not-met', reason: 'no-rules' });
  const twoStatements = statusInput({ statements: [{ id: 'tr-01_smt', description: 'one' }, { id: 'tr-01_smt.b', description: 'two' }] });
  assert.deepEqual(computeStatus(twoStatements), { state: 'partly-met', reason: 'partly-statements' }, 'some met statements and one not met statement are partly met');
  assert.deepEqual(computeStatus(statusInput({ statements: [] })), { state: 'not-met', reason: 'no-statement' });
});

test('a passed result that carries a failing reason, or a far-future time, does not count as met', () => {
  const [rule] = fixtureRules();
  const inconsistent = statusInput({ results: { [rule.id]: { rule: rule.id, passed: true, reason: 'test-skipped', collectedAt: '2026-11-21T11:00:00Z', commit: EVIDENCE_COMMIT, window: 'head' } } });
  assert.equal(computeStatus(inconsistent).state, 'not-met');
  const future = statusInput({ results: { [rule.id]: { rule: rule.id, passed: true, reason: 'met', collectedAt: '2027-01-01T00:00:00Z', window: 'audit' } } });
  assert.equal(computeStatus(future).state, 'stale', 'a result dated in the future cannot keep itself fresh');
  const noCommit = statusInput({ results: { [rule.id]: { rule: rule.id, passed: true, reason: 'met', collectedAt: '2026-11-21T11:00:00Z', window: 'head' } } });
  assert.equal(computeStatus(noCommit).state, 'stale', 'a head-window result with no commit cannot show it is for the head');
});

test('unsettled, a self-signed decision where an official must sign, and a declared limitation never raise a row above not met here', () => {
  assert.deepEqual(computeStatus(statusInput({ unsettled: 'tee-question' })), { state: 'not-met', reason: 'unsettled', detail: { question: 'tee-question' } });
  assert.deepEqual(
    computeStatus(statusInput({ statements: [{ id: 'tr-01_smt', description: 'x', unsettled: 'third-party-encrypted-storage' }] })),
    { state: 'not-met', reason: 'unsettled', detail: { question: 'third-party-encrypted-storage' } }
  );
  assert.deepEqual(
    computeStatus(statusInput({ selfSigned: true, statements: [{ id: 'tr-01_smt', description: 'x', requiresOfficialSignature: true }] })),
    { state: 'not-met', reason: 'self-signed' }
  );
  assert.deepEqual(computeStatus(statusInput({ selfSigned: true })), { state: 'met', reason: 'met' }, 'self-signed matters only where an official must sign');
  assert.deepEqual(computeStatus(statusInput({ limitation: 'Fixture limitation text.' })), { state: 'partly-met', reason: 'limitation', detail: { text: 'Fixture limitation text.' } });
  for (const outcome of [computeStatus(statusInput({ unsettled: 'x' })), computeStatus(statusInput({ limitation: 'y' }))]) assert.ok(STATES.includes(outcome.state));
});

test('evaluateTestRule matches source path, suite path and name exactly, and reports todo and failed rows by their reason', () => {
  const [rule] = fixtureRules();
  const context = { commit: EVIDENCE_COMMIT, collectedAt: '2026-11-21T11:00:00Z' };
  const row = (status: TestReportRow['status'], extra: Partial<TestReportRow> = {}): TestReportRow => ({
    file: 'dist/test/tracerFixture.test.js', path: ['fixture suite'], name: 'proves the fixture control', status, skip: null, ms: 1, ...extra
  });
  assert.equal(evaluateTestRule(rule, [row('passed')], context).reason, 'met');
  assert.equal(evaluateTestRule(rule, [row('todo')], context).reason, 'test-todo');
  assert.equal(evaluateTestRule(rule, [row('failed')], context).reason, 'test-failed');
  assert.equal(evaluateTestRule(rule, [row('passed', { name: 'proves the fixture control too' })], context).reason, 'test-not-run');
  assert.equal(evaluateTestRule(rule, [row('passed', { path: [] })], context).reason, 'test-not-run');
  assert.equal(evaluateTestRule(rule, [row('passed', { path: ['fixture suite', 'nested'] })], context).reason, 'test-not-run');
  assert.equal(evaluateTestRule(rule, [row('passed'), row('failed')], context).reason, 'test-failed', 'a duplicate failing row wins over a passing one');
  const relayRule: EvidenceRule = { ...rule, test: { file: 'relay/test/tracerFixture.test.ts', path: ['fixture suite'], name: 'proves the fixture control' } };
  assert.equal(evaluateTestRule(relayRule, [row('passed')], { ...context, packagePrefix: 'relay' }).passed, true);
  assert.equal(evaluateTestRule(relayRule, [row('passed')], context).passed, false, 'a root report never satisfies a relay rule');
});

test('sourcePathForReport maps compiled root, relay and hub report paths to their sources and leaves .mjs and .ts paths as they are', () => {
  assert.equal(sourcePathForReport('dist/test/X.test.js'), 'src/test/X.test.ts');
  assert.equal(sourcePathForReport('dist/test/sub/X.test.js'), 'src/test/sub/X.test.ts');
  assert.equal(sourcePathForReport('dist/test/a.test.js', 'relay'), 'relay/test/a.test.ts');
  assert.equal(sourcePathForReport('dist/test/container/b.test.js', 'relay'), 'relay/test/container/b.test.ts');
  assert.equal(sourcePathForReport('dist/test/c.test.js', 'hub'), 'hub/test/c.test.ts');
  assert.equal(sourcePathForReport('scripts/test/workflow-files.test.mjs'), 'scripts/test/workflow-files.test.mjs');
  assert.equal(sourcePathForReport('test/tracer.test.ts', 'compliance'), 'compliance/test/tracer.test.ts');
  assert.equal(sourcePathForReport('test/serve.test.mjs', 'docs-site'), 'docs-site/test/serve.test.mjs');
  assert.equal(sourcePathForReport('.\\dist\\test\\X.test.js'), 'src/test/X.test.ts', 'Windows separators and a leading ./ are normalized');
  for (const [file, prefix] of [['src/test/X.test.ts', undefined], ['relay/test/a.test.ts', 'relay'], ['compliance/test/tracer.test.ts', 'compliance']] as const) {
    assert.equal(sourcePathForReport(file, prefix), file, `mapping ${file} again changes nothing`);
  }
});

test('evaluateObservationRule takes the newest observation for its collector and subject, with the window from the collector kind', () => {
  const rule: EvidenceRule = { id: 'tracer-fixture.tr-01.audit', component: 'tracer-fixture', control: 'tr-01', statement: 'tr-01_smt', kind: 'observation', observation: { collector: 'audit', subject: 'root' } };
  const context = { commit: EVIDENCE_COMMIT, collectedAt: '2026-11-21T11:00:00Z' };
  const observation = (passed: boolean, collectedAt: string, extra: Partial<Observation> = {}): Observation => ({ collector: 'audit', subject: 'root', passed, collectedAt, ...extra });
  assert.equal(evaluateObservationRule(rule, [], context).reason, 'missing-result');
  assert.equal(evaluateObservationRule(rule, [observation(true, '2026-11-21T10:00:00Z', { subject: 'relay' })], context).reason, 'missing-result');
  const newest = evaluateObservationRule(rule, [observation(true, '2026-11-20T10:00:00Z'), observation(false, '2026-11-21T10:00:00Z'), observation(true, '2026-11-19T10:00:00Z')], context);
  assert.equal(newest.reason, 'observation-failed');
  assert.equal(newest.window, 'audit');
  assert.equal(newest.collectedAt, '2026-11-21T10:00:00Z');
  const passed = evaluateObservationRule(rule, [observation(true, '2026-11-20T10:59:00Z', { runUrl: 'https://example.invalid/run/1' })], context);
  assert.equal(passed.passed, true);
  assert.equal(passed.runUrl, 'https://example.invalid/run/1');
  const stale = computeStatus(statusInput({ rulesByStatement: { 'tr-01_smt': [rule] }, results: { [rule.id]: passed } }));
  assert.equal(stale.state, 'stale', 'an audit result 25 hours old is stale');
  const fresh = computeStatus(statusInput({ rulesByStatement: { 'tr-01_smt': [rule] }, results: { [rule.id]: { ...passed, collectedAt: '2026-11-20T13:00:00Z' } } }));
  assert.equal(fresh.state, 'met', 'an audit result 23 hours old is fresh');
  const unknownKind: EvidenceRule = { ...rule, observation: { collector: 'secret-scan', subject: 'root' } };
  assert.equal(evaluateObservationRule(unknownKind, [{ collector: 'secret-scan', subject: 'root', passed: true, collectedAt: '2026-11-21T10:00:00Z', commit: EVIDENCE_COMMIT }], context).window, 'head');
});

test('no dashboard input built from the fixtures carries a status, state or met key', () => {
  const seen: string[] = [];
  const walk = (value: unknown, at: string): void => {
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${at}[${index}]`));
    else if (value && typeof value === 'object' && !(value instanceof Date)) {
      for (const [key, child] of Object.entries(value)) {
        if (['state', 'met'].includes(key) || (key === 'status' && !at.includes('testRows'))) seen.push(`${at}.${key}`);
        walk(child, `${at}.${key}`);
      }
    }
  };
  walk(input(), 'input');
  assert.deepEqual(seen, []);
});
