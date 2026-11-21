// The dependency audit collector (44-08, D-09, D-23): npm audit JSON per package becomes one observation with counts per severity, and a daily
// audit that stops arriving turns the controls relying on it Stale. Fixtures are synthetic npm audit files; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { auditCollector } from '../src/collectors/audit.ts';
import type { CollectorContext } from '../src/collectors/types.ts';
import { buildDashboard } from '../src/dashboard.ts';
import type { ComponentInput, DashboardInput, EvidenceRule, Observation } from '../src/model.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'collectors', 'audit');
const COMMIT = 'c'.repeat(40);
const CLOCK = new Date('2026-11-21T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function context(now: Date, files: Record<string, string> = {}): CollectorContext {
  return {
    now,
    commit: COMMIT,
    runUrl: 'https://github.com/example-org/example-repo/actions/runs/1001',
    readFile: async (file) => (Object.hasOwn(files, file) ? files[file] : readFileSync(path.join(FIXTURES, file), 'utf8'))
  };
}

const COMPONENT = 'component-x';
const CONTROL = 'xx-01';
const STATEMENT = 'xx-01_smt';

/** A tiny in-memory component, level and rule on `audit` / <subject>, run through buildDashboard at the clock. */
function dashboardFor(observations: readonly Observation[], subject: string) {
  const components: ComponentInput[] = [{
    id: COMPONENT,
    implemented: [{ control: CONTROL, responsibility: 'product', statements: [{ id: STATEMENT, description: 'Synthetic statement: dependencies are audited daily.' }] }]
  }];
  const rules: EvidenceRule[] = [{ id: `rule-audit-${subject}`, component: COMPONENT, control: CONTROL, statement: STATEMENT, kind: 'observation', observation: { collector: 'audit', subject } }];
  const input: DashboardInput = {
    commit: COMMIT,
    generatedAt: CLOCK.toISOString(),
    now: CLOCK,
    levels: [{ id: 'level-x', title: 'Synthetic level', controls: [CONTROL], components: [COMPONENT] }],
    components,
    rules,
    testRows: [],
    observations,
    head: COMMIT
  };
  const dashboard = buildDashboard(input);
  const row = dashboard.rows.find((candidate) => candidate.control === CONTROL);
  assert.ok(row);
  const metAtLevel = dashboard.rows.filter((candidate) => candidate.level === 'level-x' && candidate.state === 'met').length;
  return { row, metAtLevel };
}

test('a clean audit (no high or critical) gives audit / root passed with counts per severity', async () => {
  const observations = await auditCollector.collect({ audits: [{ package: 'root', file: 'root.json' }] }, context(CLOCK));
  assert.equal(observations.length, 1);
  const [observation] = observations;
  assert.equal(observation.collector, 'audit');
  assert.equal(observation.subject, 'root');
  assert.equal(observation.passed, true);
  assert.equal(observation.collectedAt, CLOCK.toISOString());
  assert.equal(observation.commit, COMMIT);
  assert.deepEqual(observation.counts, { info: 0, low: 1, moderate: 1, high: 0, critical: 0, total: 2 });
  assert.equal(auditCollector.id, 'audit');
  assert.equal(auditCollector.window, 'audit');
});

test('an audit with a high finding gives audit / relay failing with high 1', async () => {
  const observations = await auditCollector.collect({ audits: [{ package: 'relay', file: 'relay-high.json' }] }, context(CLOCK));
  assert.equal(observations.length, 1);
  assert.equal(observations[0].subject, 'relay');
  assert.equal(observations[0].passed, false);
  assert.equal(observations[0].counts?.high, 1);
  assert.equal(observations[0].counts?.critical, 0);
});

test('every audited package becomes its own observation, in input order', async () => {
  const observations = await auditCollector.collect({
    audits: [
      { package: 'root', file: 'root.json' },
      { package: 'relay', file: 'relay-high.json' },
      { package: 'hub', file: 'root.json' },
      { package: 'docs-site', file: 'root.json' },
      { package: 'compliance', file: 'root.json' }
    ]
  }, context(CLOCK));
  assert.deepEqual(observations.map((observation) => [observation.subject, observation.passed]), [
    ['root', true], ['relay', false], ['hub', true], ['docs-site', true], ['compliance', true]
  ]);
});

test('tracer: an audit collected 23 hours before the clock is Met; 25 hours is Stale and the level count drops', async () => {
  const fresh = await auditCollector.collect({ audits: [{ package: 'root', file: 'root.json' }] }, context(new Date(CLOCK.getTime() - 23 * HOUR)));
  const metFresh = dashboardFor(fresh, 'root');
  assert.equal(metFresh.row.state, 'met');
  assert.equal(metFresh.row.reason, 'met');
  assert.equal(metFresh.metAtLevel, 1);

  const lapsed = await auditCollector.collect({ audits: [{ package: 'root', file: 'root.json' }] }, context(new Date(CLOCK.getTime() - 25 * HOUR)));
  const stale = dashboardFor(lapsed, 'root');
  assert.equal(stale.row.state, 'stale');
  assert.equal(stale.row.reason, 'stale');
  assert.equal(stale.row.detail?.date, new Date(CLOCK.getTime() - 25 * HOUR).toISOString());
  assert.equal(stale.metAtLevel, 0);
});

test('tracer: a failing audit makes the control Not met with observation-failed', async () => {
  const observations = await auditCollector.collect({ audits: [{ package: 'relay', file: 'relay-high.json' }] }, context(new Date(CLOCK.getTime() - HOUR)));
  const { row, metAtLevel } = dashboardFor(observations, 'relay');
  assert.equal(row.state, 'not-met');
  assert.equal(row.reason, 'observation-failed');
  assert.equal(metAtLevel, 0);
});

test('the observation holds no package names, advisory titles or URLs from the audit file', async () => {
  const observations = await auditCollector.collect({ audits: [{ package: 'root', file: 'root.json' }, { package: 'relay', file: 'relay-high.json' }] }, context(CLOCK));
  const text = JSON.stringify(observations);
  for (const forbidden of ['example-lib', 'example-other', 'example-server-lib', 'Synthetic', 'advisor', 'example.invalid', '1000001', '<1.2.3', 'node_modules']) {
    assert.ok(!text.includes(forbidden), `observation leaks ${forbidden}`);
  }
  for (const observation of observations) {
    assert.deepEqual(Object.keys(observation).sort(), ['collectedAt', 'collector', 'commit', 'counts', 'passed', 'runUrl', 'subject']);
  }
});

test('a file that is not npm audit JSON is a collector error, never a pass', async () => {
  const cases: Record<string, string> = {
    'not-json.json': 'this is not JSON',
    'other.json': JSON.stringify({ hello: 'world' }),
    'npm-error.json': JSON.stringify({ error: { code: 'ENOAUDIT', summary: 'synthetic failure' } }),
    'no-metadata.json': JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }),
    'negative.json': JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: -1, critical: 0, total: -1 } } }),
    'fraction.json': JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0.5, critical: 0, total: 0.5 } } }),
    'missing-critical.json': JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, total: 0 } } }),
    'bad-total.json': JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 3 } } }),
    'version-1.json': JSON.stringify({ auditReportVersion: 1, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } })
  };
  for (const file of Object.keys(cases)) {
    await assert.rejects(
      auditCollector.collect({ audits: [{ package: 'root', file }] }, context(CLOCK, cases)),
      (error: Error & { code?: string }) => { assert.equal(error.code, 'not-npm-audit-json', file); return true; },
      file
    );
  }
});

test('an invalid input (no audits, a bad package id) is a collector error', async () => {
  await assert.rejects(auditCollector.collect({ audits: [] }, context(CLOCK)), (error: Error & { code?: string }) => error.code === 'invalid-input');
  await assert.rejects(auditCollector.collect({ audits: [{ package: '../root', file: 'root.json' }] }, context(CLOCK)), (error: Error & { code?: string }) => error.code === 'invalid-input');
  await assert.rejects(auditCollector.collect({ audits: [{ package: 'root', file: 'root.json' }, { package: 'root', file: 'root.json' }] }, context(CLOCK)), (error: Error & { code?: string }) => error.code === 'invalid-input');
});
