// Product content checks for Phase 44.  The dashboard computes a state; these
// checks keep its source material tied to real catalogues and real evidence.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadComponents } from '../src/components.ts';
import { loadEvidenceRules } from '../src/evidenceRuleFiles.ts';
import { checkRuleTargets } from '../src/rules.ts';
import { buildDashboard } from '../src/dashboard.ts';
import type { Observation, TestReportRow } from '../src/model.ts';
import { selectedIds } from '../src/profiles.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPONENTS = path.join(ROOT, 'compliance', 'components');

test('the phase supplies the extension component definition', () => {
  assert.ok(existsSync(path.join(COMPONENTS, 'extension.json')), 'extension statements must be present before a dashboard can make a control met');
});

test('the responsibility table is present for controls without statements', () => {
  assert.ok(existsSync(path.join(ROOT, 'compliance', 'responsibility', 'families.json')), 'family responsibilities must be present');
});

test('the root development dependency baseline declares the exact locked versions', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    devDependencies: Record<string, string>;
  };
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { devDependencies?: Record<string, string>; version?: string }>;
  };
  assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
  for (const [name, version] of Object.entries(manifest.devDependencies)) {
    assert.equal(version, lock.packages[`node_modules/${name}`]?.version, `${name} must specify its exact locked version`);
  }
  assert.match(readFileSync(path.join(ROOT, '.npmrc'), 'utf8'), /^save-exact=true$/m);
});

test('the extension evidence file names a real gate decision test', () => {
  const file = path.join(ROOT, 'compliance', 'evidence-rules', 'extension.json');
  assert.ok(existsSync(file), 'extension evidence rules must be present');
  assert.match(readFileSync(file, 'utf8'), /src\/test\/gateDecide\.test\.ts/, 'a dashboard rule must name its source test');
});

test('all six component definitions load as OSCAL content', () => {
  const loaded = loadComponents(COMPONENTS);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.components.map((component) => component.id), ['appliance', 'extension', 'hub', 'model-endpoints', 'relay', 'release-pipeline']);
});

test('every mapped test rule has an exact literal target in the checkout', () => {
  const rules = loadEvidenceRules(path.join(ROOT, 'compliance', 'evidence-rules'));
  assert.deepEqual([...checkRuleTargets(rules, ROOT).values()].filter((state) => state !== 'ok'), []);
});

test('each stated requirement has exactly one valid responsibility', () => {
  const { components, errors } = loadComponents(COMPONENTS);
  assert.deepEqual(errors, []);
  for (const component of components) for (const requirement of component.implemented) assert.ok(requirement.responsibility);
});

test('provider responsibilities identify a provider class, not a company', () => {
  const endpoint = loadComponents(COMPONENTS).components.find((component) => component.id === 'model-endpoints')!;
  assert.equal(endpoint.implemented.find((requirement) => requirement.control === 'sc-08')?.inheritedFrom, 'configured-model-provider');
});

test('the release rule keeps docs-required visible as a settings observation', () => {
  const rules = loadEvidenceRules(path.join(ROOT, 'compliance', 'evidence-rules'));
  assert.ok(rules.some((rule) => rule.id === 'release.cm-03.docs-required' && rule.kind === 'observation' && rule.observation?.subject === 'docs-required'));
});

test('Protected A credits only the scoped audit timestamp evidence from a passing mapped test', () => {
  const now = new Date('2026-11-23T12:00:00Z');
  const commit = 'a'.repeat(40);
  const { components } = loadComponents(COMPONENTS);
  const rules = loadEvidenceRules(path.join(ROOT, 'compliance', 'evidence-rules'));
  const controls = selectedIds(path.join(ROOT, 'compliance', 'profiles', 'protected-a.json'));
  const result = (testRows: TestReportRow[]) => buildDashboard({
    head: commit, commit, generatedAt: now.toISOString(), now, components, rules, observations: [], testRows,
    levels: [{ id: 'protected-a', title: 'Protected A', controls, components: ['extension'] }]
  }).rows.find((row) => row.control === 'au-08');
  const receipt: TestReportRow = {
    file: 'src/test/gateHostLogs.test.ts', path: [],
    name: 'gate decision logs preserve runtime timestamps as epoch milliseconds', status: 'passed', skip: null, ms: 1
  };
  assert.equal(result([receipt])?.state, 'partly-met');
  assert.equal(result([receipt])?.reason, 'limitation');
  assert.equal(result([{ ...receipt, status: 'failed' }])?.state, 'not-met');
  assert.equal(result([])?.state, 'not-met');
});

test('CM-03 needs the assessed commit review and verified main protection, and credits only partial support', () => {
  const now = new Date('2026-11-22T12:00:00Z');
  const commit = 'a'.repeat(40);
  const common = { passed: true, collectedAt: now.toISOString(), commit };
  const ci: Observation = { ...common, collector: 'ci', subject: 'test' };
  const docs: Observation = { ...common, collector: 'settings', subject: 'docs-required' };
  const main: Observation = { ...common, collector: 'settings', subject: 'main-change-protection' };
  const review: Observation = { ...common, collector: 'review-trail', subject: 'assessed-commit-agent-review' };
  const { components } = loadComponents(COMPONENTS);
  const rules = loadEvidenceRules(path.join(ROOT, 'compliance', 'evidence-rules'));
  const status = (observations: Observation[]) => buildDashboard({
    head: commit, commit, generatedAt: now.toISOString(), now, components, rules, observations, testRows: [],
    levels: [{ id: 'unclassified', title: 'Unclassified', controls: ['cm-03'], components: ['release-pipeline'] }]
  }).rows[0];
  const confirmed = status([ci, docs, main, review]);
  assert.equal(confirmed.state, 'partly-met');
  assert.equal(confirmed.reason, 'limitation');
  assert.equal(status([ci, docs, main, { ...review, subject: 'gate-approvals' }]).state, 'not-met');
  assert.equal(status([ci, docs, main, { ...review, commit: 'b'.repeat(40) }]).state, 'stale');
  assert.equal(status([ci, docs, { ...main, passed: false }, review]).state, 'not-met');
  assert.equal(status([ci, { ...docs, passed: false }, main, review]).state, 'not-met');
});

test('the appliance makes no claim of an implemented Classified safeguard', () => {
  const appliance = loadComponents(COMPONENTS).components.find((component) => component.id === 'appliance')!;
  assert.equal(appliance.implemented[0]?.statements[0]?.description, 'No appliance implementation statement exists today; this component reserves the Classified boundary for later work.');
});
