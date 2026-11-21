// The dashboard contract (44-05, D-29, D-50): what buildDashboard writes validates against dashboard.schema.json, and the docs site's lib.mjs reads
// the same file. One test runs both sides, so the producer and the pages cannot drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildDashboard, countStates, fillReason, type DashboardBuildInput } from '../src/dashboard.ts';
import { validateOurs } from '../src/validate.ts';
import { NS, REASONS, STATES, STATE_WORDS, type ComponentInput, type EvidenceRule, type TestReportRow } from '../src/model.ts';
import { levelCounts, parseDashboard, STATE_WORDS as VIEW_STATE_WORDS } from '../../docs-site/src/compliance/lib.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const TRACER = path.join(TEST_DIR, 'fixtures', 'tracer');
const DASHBOARD_FIXTURE = path.join(TEST_DIR, 'fixtures', 'dashboard', 'dashboard.json');
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
