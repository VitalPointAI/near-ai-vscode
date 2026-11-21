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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPONENTS = path.join(ROOT, 'compliance', 'components');

test('the phase supplies the extension component definition', () => {
  assert.ok(existsSync(path.join(COMPONENTS, 'extension.json')), 'extension statements must be present before a dashboard can make a control met');
});

test('the responsibility table is present for controls without statements', () => {
  assert.ok(existsSync(path.join(ROOT, 'compliance', 'responsibility', 'families.json')), 'family responsibilities must be present');
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

test('the appliance makes no claim of an implemented Classified safeguard', () => {
  const appliance = loadComponents(COMPONENTS).components.find((component) => component.id === 'appliance')!;
  assert.equal(appliance.implemented[0]?.statements[0]?.description, 'No appliance implementation statement exists today; this component reserves the Classified boundary for later work.');
});
