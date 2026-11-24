// The dashboard contract (44-05, D-29, D-50): what buildDashboard writes validates against dashboard.schema.json, and the docs site's lib.mjs reads
// the same file. One test runs both sides, so the producer and the pages cannot drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildDashboard, countStates, fillReason, type DashboardBuildInput } from '../src/dashboard.ts';
import { validateOurs } from '../src/validate.ts';
import { NS, REASONS, STATES, STATE_WORDS, type ComponentInput, type EvidenceRule, type TestReportRow } from '../src/model.ts';
import { levelCounts, parseDashboard, STATE_WORDS as VIEW_STATE_WORDS } from '../../docs-site/src/compliance/lib.mjs';
import { deploymentCollector } from '../src/collectors/deployment.ts';
import { buildUnsignedExport, signExport } from '../src/siteExport.ts';
import { compliantFacts, fileContext, freshKey, signersText, tempDir } from './fixtures/collectors/deployment/helpers.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const TRACER = path.join(TEST_DIR, 'fixtures', 'tracer');
const DASHBOARD_FIXTURE = path.join(TEST_DIR, 'fixtures', 'dashboard', 'dashboard.json');
const CONTROL_TEXT_FIXTURE = path.join(TEST_DIR, 'fixtures', 'dashboard', 'text', 'fixture', 'tr.json');
const readJson = (file: string): any => JSON.parse(readFileSync(file, 'utf8'));
const readNdjson = (file: string): TestReportRow[] => readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const COMMIT = 'a'.repeat(40);
const NOW = new Date('2026-11-21T12:00:00Z');

/** The tracer component, read with our props only. */
function tracerComponents(): ComponentInput[] {
  const doc = readJson(path.join(TRACER, 'component.json'))['component-definition'];
  const ours = (props: any[] | undefined, name: string): string | undefined => props?.find((prop) => prop.ns === NS && prop.name === name)?.value;
  return doc.components.map((component: any) => ({
    id: ours(component.props, 'component-id'),
    implemented: component['control-implementations'].flatMap((impl: any) => impl['implemented-requirements'].map((req: any) => ({
      control: req['control-id'],
      responsibility: ours(req.props, 'responsibility'),
      statements: req.statements.map((statement: any) => ({ id: statement['statement-id'], description: statement.description }))
    })))
  }));
}

function tracerInput(overrides: Partial<DashboardBuildInput> = {}): DashboardBuildInput {
  return {
    commit: COMMIT,
    generatedAt: '2026-11-21T11:00:00Z',
    now: NOW,
    head: COMMIT,
    levels: [{ id: 'fixture', title: 'Fixture level', kind: 'level', profile: 'profiles/fixture.json', claim: true, controls: ['tr-01'], components: ['tracer-fixture'] }],
    components: tracerComponents(),
    rules: readJson(path.join(TRACER, 'evidence-rules.json')).rules as EvidenceRule[],
    testRows: readNdjson(path.join(TRACER, 'report-passed.ndjson')),
    observations: [],
    source: { kind: 'main', ref: 'refs/heads/main' },
    controls: { 'tr-01': { label: 'TR-01', title: 'Tracer fixture control' } },
    ...overrides
  };
}

test('buildDashboard over the tracer fixtures validates against dashboard.schema.json, with every top-level field', () => {
  const dashboard = buildDashboard(tracerInput());
  assert.deepEqual(validateOurs(JSON.parse(JSON.stringify(dashboard)), 'dashboard'), { ok: true, errors: [] });
  assert.deepEqual(Object.keys(dashboard).sort(), ['collectors', 'commit', 'gaps', 'generatedAt', 'levels', 'matrix', 'refusedAcceptances', 'rows', 'schemaVersion', 'source', 'textIndex']);
  const [level] = dashboard.levels;
  assert.equal(level.kind, 'level');
  assert.equal(level.claim, true);
  assert.equal(level.counts.met, 1);
  assert.equal(level.counts.metTotal, 1);
  assert.equal(level.counts.notMetTotal, 0);
  const [row] = dashboard.rows;
  assert.equal(row.label, 'TR-01');
  assert.equal(row.title, 'Tracer fixture control');
  assert.equal(row.family, 'tr');
  assert.equal(row.reasonText, REASONS.met);
  assert.equal(row.components[0].reasonText, REASONS.met);
  assert.equal(row.components[0].statement, 'Each tracer event is recorded by the fixture component.');
});

test('only the selected profile receives a scoped gap for a shared control', () => {
  const input = tracerInput();
  const first = input.levels[0];
  const second = { ...first, id: 'other-profile', components: ['other'] };
  const dashboard = buildDashboard(tracerInput({
    levels: [first, second],
    gapRegister: {
      gaps: [{ id: 'G100', controls: ['tr-01'], profiles: [first.id], ownerRole: 'owner', remediation: 'Verify scoped evidence', closesInPhase: '44.1' }],
      poam: [],
      attestationsDir: path.join(TRACER, 'unused-attestations')
    }
  }));
  assert.deepEqual(validateOurs(JSON.parse(JSON.stringify(dashboard)), 'dashboard'), { ok: true, errors: [] });
  assert.deepEqual(dashboard.rows.map(row => [row.level, row.gap]), [[first.id, 'G100'], [second.id, undefined]]);
  assert.deepEqual(dashboard.gaps, [{
    id: 'G100', state: 'closed', overdue: false, title: 'G100', controls: ['tr-01'],
    remediation: 'Verify scoped evidence', ownerRole: 'owner', levelsBlocked: 0, profiles: [first.id]
  }]);
});

test('responsibility falls back to the family only when the component has no explicit allocation', () => {
  const base = tracerInput();
  const dashboard = buildDashboard(tracerInput({
    levels: [{ ...base.levels[0], controls: ['tr-01', 'tr-02', 'ac-01', 'unknown-01'] }],
    responsibilityTable: {
      families: {
        tr: { responsibility: 'your-organization', reason: 'The organization owns this family.' },
        ac: { responsibility: 'product', reason: 'Assess the product evidence.' },
      },
      exceptions: [],
    },
  }));
  assert.deepEqual(dashboard.rows.map(({ control, state, reason }) => [control, state, reason]), [
    ['tr-01', 'met', 'met'],
    ['tr-02', 'your-organizations-responsibility', 'your-organization'],
    ['ac-01', 'not-met', 'no-statement'],
    ['unknown-01', 'not-met', 'no-statement'],
  ]);
});

test('reviewed tailoring stays scoped to its level and component', () => {
  const base = tracerInput();
  const component = base.components[0].id;
  const reviewed = { control: 'tr-01', reason: 'This deployment does not use the fixture feature.', reviewer: 'Assigned reviewer', reviewedAt: '2026-11-20' };
  const dashboard = buildDashboard(tracerInput({
    levels: [base.levels[0], { ...base.levels[0], id: 'second' }, { ...base.levels[0], id: 'third' }],
    tailoring: {
      removals: [{ ...reviewed, level: 'third' }],
      notApplicable: [{ ...reviewed, level: 'fixture', component }],
    },
  }));
  assert.deepEqual(dashboard.rows.map(({ level, state, reason }) => [level, state, reason]), [
    ['fixture', 'not-applicable', 'not-applicable'],
    ['second', 'met', 'met'],
  ]);
  assert.equal(dashboard.rows[0].components[0].detail?.reason, reviewed.reason);
  assert.equal(dashboard.levels[2].counts.metTotal, 0);
});

test('reviewed component exclusions do not mask the remaining evidence or excuse an unreviewed exclusion', () => {
  const base = tracerInput();
  const level = { ...base.levels[0], components: [...base.levels[0].components, 'other'] };
  const other: ComponentInput = { id: 'other', implemented: [{ control: 'tr-01', responsibility: 'not-applicable', statements: [] }] };
  const withOther = { levels: [level], components: [...base.components, other] };
  const unreviewed = buildDashboard(tracerInput(withOther)).rows[0];
  assert.equal(unreviewed.reason, 'not-applicable-unreviewed');
  const record = { level: 'fixture', control: 'tr-01', component: 'other', reason: 'This part does not implement the fixture feature.', reviewer: 'Assigned reviewer', reviewedAt: '2026-11-20' };
  const reviewed = buildDashboard(tracerInput({ ...withOther, tailoring: { notApplicable: [record], removals: [] } })).rows[0];
  assert.equal(reviewed.state, 'met');
  assert.equal(reviewed.components[1].state, 'not-applicable');
});

test('the responsibility matrix combines statement and organization text once per control and component', () => {
  const base = tracerInput();
  const component = base.components[0];
  const requirement = component.implemented[0];
  const dashboard = buildDashboard(tracerInput({
    levels: [base.levels[0], { ...base.levels[0], id: 'second' }],
    components: [{ ...component, implemented: [{
      ...requirement, responsibility: 'shared',
      statements: [
        { ...requirement.statements[0], yourOrganizationDoes: 'Review the event log.' },
        { id: 'second-statement', description: 'The fixture records a second event.', yourOrganizationDoes: 'Review the event log.' },
      ],
    }] }],
  }));
  assert.deepEqual(dashboard.matrix, [{
    control: 'tr-01',
    component: component.id,
    responsibility: 'shared',
    weProvide: 'Each tracer event is recorded by the fixture component.\nThe fixture records a second event.',
    youDo: 'Review the event log.',
  }]);
  assert.equal(validateOurs(dashboard, 'dashboard').ok, true);
});

test('the schema refuses an extra top-level key, a row without a state, a state outside the six and a count missing', () => {
  const good = JSON.parse(JSON.stringify(buildDashboard(tracerInput())));
  const cases: [string, (doc: any) => void][] = [
    ['extra top-level key', (doc) => { doc.extra = true; }],
    ['row without state', (doc) => { delete doc.rows[0].state; }],
    ['state outside the six', (doc) => { doc.rows[0].state = 'compliant'; }],
    ['reason outside REASONS', (doc) => { doc.rows[0].reason = 'trust-us'; }],
    ['count missing', (doc) => { delete doc.levels[0].counts.stale; }],
    ['schema version 2', (doc) => { doc.schemaVersion = 2; }],
    ['unknown key on a component row', (doc) => { doc.rows[0].components[0].status = 'met'; }],
    ['unknown source kind', (doc) => { doc.source.kind = 'pull-request'; }],
    ['unknown detail placeholder', (doc) => { doc.rows[0].detail = { colour: 'green' }; }]
  ];
  for (const [label, mutate] of cases) {
    const doc = clone(good);
    mutate(doc);
    assert.equal(validateOurs(doc, 'dashboard').ok, false, label);
  }
});

test('lib.mjs parseDashboard reads the producer output as JSON and levelCounts gives met 1 for the fixture level', () => {
  const dashboard = buildDashboard(tracerInput());
  const result = parseDashboard(JSON.stringify(dashboard), 'application/json; charset=utf-8');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.dashboard.rows, JSON.parse(JSON.stringify(dashboard.rows)));
  const counts = levelCounts(result.dashboard, 'fixture');
  assert.equal(counts.met, 1);
  assert.deepEqual(counts, dashboard.levels[0].counts, 'the view counts from the rows and agrees with the producer');
});

test('the view counts every state the same way as the producer, Stale counted as not met', () => {
  const skipped = buildDashboard(tracerInput({ testRows: readNdjson(path.join(TRACER, 'report-skipped.ndjson')) }));
  const stale = buildDashboard(tracerInput({ head: 'b'.repeat(40) }));
  const organization = buildDashboard(tracerInput({ components: tracerComponents().map((component) => ({ ...component, implemented: component.implemented.map((req) => ({ ...req, responsibility: 'your-organization' as const })) })) }));
  for (const [label, dashboard, state] of [['skipped', skipped, 'not-met'], ['stale', stale, 'stale'], ['organization', organization, 'your-organizations-responsibility']] as const) {
    assert.equal(dashboard.rows[0].state, state, label);
    assert.deepEqual(levelCounts(JSON.parse(JSON.stringify(dashboard)), 'fixture'), dashboard.levels[0].counts, label);
    assert.equal(validateOurs(JSON.parse(JSON.stringify(dashboard)), 'dashboard').ok, true, label);
  }
  assert.equal(stale.levels[0].counts.notMetTotal, 1, 'a level summary counts Stale as not met');
  assert.equal(stale.levels[0].counts.metTotal, 0);
  const rows = STATES.map((state) => ({ state }));
  const counts = countStates(rows);
  for (const state of STATES) assert.equal(counts[state], 1, state);
  assert.equal(counts.notMetTotal, 2);
  assert.equal(counts.metTotal, 1);
});

test('reasonText fills the reason placeholders: the stale date and the inherited provider', () => {
  const stale = buildDashboard(tracerInput({ head: 'b'.repeat(40) }));
  assert.equal(stale.rows[0].reasonText, REASONS.stale.replace('{date}', '2026-11-21T11:00:00Z'));
  const inherited = buildDashboard(tracerInput({
    components: tracerComponents().map((component) => ({ ...component, implemented: component.implemented.map((req) => ({ ...req, responsibility: 'inherited' as const, inheritedFrom: 'Example Provider' })) }))
  }));
  assert.equal(inherited.rows[0].components[0].reasonText, REASONS.inherited.replace('{provider}', 'Example Provider'));
  assert.equal(inherited.rows[0].components[0].inheritedFrom, 'Example Provider');
  assert.ok(!fillReason('not-applicable', undefined).includes('{'), 'a missing placeholder never shows as a brace');
});

test('STATE_WORDS in lib.mjs equals STATE_WORDS in model.ts', () => {
  assert.deepEqual({ ...VIEW_STATE_WORDS }, { ...STATE_WORDS });
  assert.ok(Object.isFrozen(VIEW_STATE_WORDS));
});

test('the hand-checked fixture dashboard validates, has two levels and one overlay, rows in every state and one gap, and its counts match its rows', () => {
  const fixture = readJson(DASHBOARD_FIXTURE);
  assert.deepEqual(validateOurs(fixture, 'dashboard'), { ok: true, errors: [] });
  assert.equal(fixture.levels.filter((level: any) => level.kind === 'level').length, 2);
  assert.equal(fixture.levels.filter((level: any) => level.kind === 'overlay').length, 1);
  assert.deepEqual([...new Set(fixture.rows.map((row: any) => row.state))].sort(), [...STATES].sort());
  assert.equal(fixture.gaps.length, 1);
  for (const level of fixture.levels) assert.deepEqual(levelCounts(fixture, level.id), level.counts, level.id);
  for (const row of fixture.rows) {
    assert.ok(row.reasonText.length > 0, `${row.level} ${row.control}`);
    for (const component of row.components) assert.ok(component.reasonText.length > 0);
  }
});

test('the control text, bundle manifest, refresh record and organization overlay fixtures satisfy their strict schemas', () => {
  assert.equal(validateOurs(readJson(CONTROL_TEXT_FIXTURE), 'control-text').ok, true);
  assert.equal(validateOurs({ schemaVersion: 1, createdAt: '2026-11-21T00:00:00Z', commit: COMMIT, files: [{ path: 'dashboard.json', sha256: 'b'.repeat(64), bytes: 1 }] }, 'bundle-manifest').ok, true);
  assert.equal(validateOurs({ source: 'main', commit: COMMIT, fetchedAt: '2026-11-21T00:00:00Z', manifest: 'verified', attestation: 'not-checked' }, 'refresh').ok, true);
  assert.equal(validateOurs(readJson(path.join(TEST_DIR, 'fixtures', 'overlay', 'answers.json')), 'overlay').ok, true);
});

/** The tracer control decided by one observation rule on the deployment collector, fed by an export the collector verified (48-02). */
async function deploymentDashboard(signedAgoMs: number) {
  const key = freshKey();
  const dir = tempDir();
  const signedAt = new Date(NOW.getTime() - signedAgoMs).toISOString();
  writeFileSync(path.join(dir, 'export.json'), JSON.stringify(signExport(buildUnsignedExport('fixture-site', signedAt, compliantFacts(), key.publicKey), key.privateKeyPem)));
  writeFileSync(path.join(dir, 'site-signers.json'), signersText(key));
  const observations = await deploymentCollector.collect({ file: path.join(dir, 'export.json'), signersFile: path.join(dir, 'site-signers.json') }, fileContext(NOW, COMMIT));
  const rules: EvidenceRule[] = [{ id: 'tracer-fixture.tr-01.deployment', component: 'tracer-fixture', control: 'tr-01', statement: 'tr-01_smt', kind: 'observation', observation: { collector: 'deployment', subject: 'keycloak/no-password-authenticator' } }];
  return buildDashboard(tracerInput({ rules, testRows: [], observations }));
}

test('a deployment export signed an hour ago makes its control Met', async () => {
  const dashboard = await deploymentDashboard(60 * 60 * 1000);
  assert.equal(dashboard.rows[0].state, 'met');
  assert.equal(validateOurs(JSON.parse(JSON.stringify(dashboard)), 'dashboard').ok, true);
});

test('a deployment export signed 7 days and an hour ago makes its control Stale', async () => {
  const dashboard = await deploymentDashboard(7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000);
  assert.equal(dashboard.rows[0].state, 'stale');
});

test('a deployment export exactly 7 days old is still fresh and one a millisecond older is Stale', async () => {
  assert.equal((await deploymentDashboard(7 * 24 * 60 * 60 * 1000)).rows[0].state, 'met');
  assert.equal((await deploymentDashboard(7 * 24 * 60 * 60 * 1000 + 1)).rows[0].state, 'stale');
});
