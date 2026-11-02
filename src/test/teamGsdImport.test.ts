// The GSD parser turns the project's own planning files into a work graph without trusting a byte of them (D-06 to D-09, T-62-09, T-62-10).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { buildGsdGraph, normalisePhase, parseFrontmatter, planIdentity } from '../domain/team/gsdImport';
import type { GsdGraph, GsdSource } from '../domain/team/gsdImport';

const FIXTURE_ROOT = path.join(__dirname, '..', '..', 'test', 'fixtures', 'gsd-import', 'planning');

function walk(dir: string, prefix: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, `${prefix}/${name}`, out);
    else out.push(`${prefix}/${name}`);
  }
}

function fixtureSource(transform: (text: string) => string = (text) => text): GsdSource {
  const paths: string[] = [];
  walk(FIXTURE_ROOT, '.planning', paths);
  const files = new Map<string, string>();
  for (const file of paths) files.set(file, transform(readFileSync(path.join(FIXTURE_ROOT, ...file.split('/').slice(1)), 'utf8')));
  return { paths, files };
}

function graphOf(source: GsdSource, options?: { milestone?: string }): GsdGraph {
  const result = buildGsdGraph(source, options);
  if ('error' in result) assert.fail(`unexpected error: ${result.error}`);
  return result;
}

test('the fixture roadmap becomes a milestone, phases, plans and tasks with dependencies, scope, estimate and SUMMARY state', () => {
  const graph = graphOf(fixtureSource());
  assert.deepEqual(graph.milestone, { key: 'v0.9.0', title: 'v0.9.0 Fixture Team', current: true });
  assert.deepEqual(graph.milestones, [
    { key: 'v0.1.0', title: 'v0.1.0 Start', current: false },
    { key: 'v0.9.0', title: 'v0.9.0 Fixture Team', current: true },
  ]);
  assert.deepEqual(graph.phases.map((phase) => [phase.number, phase.title, phase.dependsOn, phase.requirements]), [
    ['90', 'Alpha work', [], ['FIX-01', 'FIX-02']],
    ['91', 'Beta', ['90'], ['FIX-03']],
    ['91.1', 'Beta fix', ['91'], ['FIX-03']],
    ['92', 'Empty', [], ['FIX-04']],
  ]);
  assert.deepEqual(graph.plans.map((plan) => `${plan.phase}-${plan.plan}`), ['90-01', '90-02', '91.1-01']);

  const [one, two, fix] = graph.plans;
  assert.ok(one !== undefined && two !== undefined && fix !== undefined);
  assert.equal(one.path, '.planning/phases/90-alpha/90-01-PLAN.md');
  assert.equal(one.title, 'Tracer: first slice');
  assert.equal(one.wave, 1);
  assert.deepEqual(one.dependsOn, []);
  assert.deepEqual(one.filesModified, ['src/fixture/alpha.ts', 'src/test/fixtureAlpha.test.ts']);
  assert.deepEqual(one.requirements, ['FIX-01']);
  assert.equal(one.estimateTokens, 48000);
  assert.equal(one.confidence, 'high');
  assert.equal(one.hasSummary, true);
  assert.equal(one.gapClosure, false);
  assert.deepEqual(one.truths, ['The alpha slice returns the value the roadmap promises', 'A caller can read "alpha" back by name without any other setup']);
  assert.deepEqual(one.tasks, [
    { index: 1, title: 'Tracer: alpha value end to end', type: 'tracer', files: ['src/fixture/alpha.ts', 'src/test/fixtureAlpha.test.ts'] },
    { index: 2, title: 'Expand the alpha value to a list', type: 'auto', files: ['src/fixture/alpha.ts'] },
  ]);

  assert.equal(two.title, 'Second slice');
  assert.equal(two.wave, 2);
  assert.deepEqual(two.dependsOn, ['90-01']);
  assert.deepEqual(two.requirements, ['FIX-02']);
  assert.equal(two.gapClosure, true);
  assert.equal(two.hasSummary, false);
  assert.equal(two.estimateTokens, 52000);
  assert.equal(two.confidence, 'medium');
  assert.deepEqual(two.filesModified, ['src/fixture/beta.ts']);
  assert.equal(two.truths.length, 3);
  assert.equal(two.truths[1], 'No error message ever contains a bearer token, a refresh token or a key secret');
  assert.equal(two.truths[2], "The single quoted truth has an 'inner' quote");
  assert.deepEqual(two.tasks, [
    { index: 1, title: 'Pick the beta shape', type: 'checkpoint:decision', files: [] },
    { index: 2, title: 'Write the beta slice', type: 'auto', files: ['src/fixture/beta.ts'] },
  ]);

  assert.equal(fix.title, 'Repair the beta slice');
  assert.deepEqual(fix.dependsOn, ['90-02']);
  assert.equal(fix.tasks.length, 1);
  assert.deepEqual(graph.warnings, []);
});

test('plan identity comes from the file name: leading zeros leave the phase, decimal phases survive, summaries are told apart', () => {
  assert.deepEqual(planIdentity('.planning/phases/05.1-x/05.1-02-PLAN.md'), { phase: '5.1', plan: '02', kind: 'plan' });
  assert.deepEqual(planIdentity('.planning/phases/061-x/061-9-SUMMARY.md'), { phase: '61', plan: '09', kind: 'summary' });
  assert.deepEqual(planIdentity('.planning/milestones/v0.4.0-phases/01-a/01-01-PLAN.md'), { phase: '1', plan: '01', kind: 'plan' });
  assert.equal(planIdentity('.planning/phases/x/README.md'), undefined);
  assert.equal(planIdentity('.planning/phases/x/61-PLAN.md'), undefined);
  assert.equal(planIdentity('src/61-01-PLAN.md'), undefined);
  assert.equal(normalisePhase('05.1'), '5.1');
  assert.equal(normalisePhase('061'), '61');
  assert.equal(normalisePhase('0'), '0');
});

test('the frontmatter reader takes inline, quoted inline and block lists and skips every other key', () => {
  const text = [
    '---', 'phase: 61-invitations', 'plan: 12', 'wave: 3', 'depends_on: ["61-09", \'61-10\']', 'requirements:', '  - TEAM-02', '  - TEAM-03',
    'files_modified:', '  - a/b.ts', 'coupling_justified: "ignored text"', 'user_setup:', '  - service: x', '    env_vars:', '      - name: Y', 'autonomous: false',
    'estimate:', '  tokens: 1234', '  raw_tokens: 1000', '  tasks: 4', '  confidence: low', 'must_haves:', '  truths:', '    - "one"', '  artifacts:', '    - path: nope', '---', 'body',
  ].join('\n');
  const { fields, problems } = parseFrontmatter(text);
  assert.deepEqual(problems, []);
  assert.deepEqual(fields, {
    phase: '61-invitations', plan: '12', wave: 3, dependsOn: ['61-09', '61-10'], filesModified: ['a/b.ts'], requirements: ['TEAM-02', 'TEAM-03'],
    truths: ['one'], autonomous: false, gapClosure: false, estimateTokens: 1234, estimateTasks: 4, confidence: 'low',
  });
});
