// The GSD parser turns the project's own planning files into a work graph without trusting a byte of them (D-06 to D-09, T-62-09, T-62-10).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { buildGsdGraph, currentMilestoneKey, normalisePhase, parseFrontmatter, parsePlanTasks, parseRoadmap, planIdentity } from '../domain/team/gsdImport';
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

test('IN-06: the plan title comes from the first heading after the closing --- line, never from a comment or a ---- line inside the frontmatter', () => {
  const third = '.planning/phases/90-alpha/90-03-PLAN.md';
  const text = '---\nphase: 90\nplan: 03\n----\n# Injected from the frontmatter\n---x\n---\n\n# Plan 90-03: Third slice\n';
  for (const eol of ['\n', '\r\n']) {
    const source = fixtureSource();
    const files = new Map(source.files);
    files.set(third, text.replace(/\n/g, eol));
    const graph = graphOf({ paths: [...source.paths, third], files });
    assert.equal(graph.plans.find((plan) => plan.plan === '03')?.title, 'Third slice', JSON.stringify(eol));
  }
});

test('the same files with CRLF line endings give the same graph', () => {
  const lf = graphOf(fixtureSource());
  const crlf = graphOf(fixtureSource((text) => text.replace(/\n/g, '\r\n')));
  assert.deepEqual(crlf, lf);
});

test('an archived milestone is built from its bullet range and the folders under milestones, with plans that have no frontmatter', () => {
  const graph = graphOf(fixtureSource(), { milestone: 'v0.1.0' });
  assert.deepEqual(graph.milestone, { key: 'v0.1.0', title: 'v0.1.0 Start', current: false });
  assert.deepEqual(graph.phases, [{ number: '1', title: 'Start', dependsOn: [], requirements: [] }]);
  assert.equal(graph.plans.length, 1);
  const plan = graph.plans[0];
  assert.ok(plan !== undefined);
  assert.equal(plan.title, 'Walking Skeleton');
  assert.equal(plan.estimateTokens, undefined);
  assert.equal(plan.confidence, undefined);
  assert.deepEqual(plan.tasks.map((task) => [task.index, task.title, task.type]), [[1, 'Scaffold the project', 'auto'], [2, 'Add the quality gates', 'auto']]);
  assert.deepEqual(graph.warnings, []);
  assert.deepEqual(graphOf(fixtureSource()).milestones.map((m) => m.key), ['v0.1.0', 'v0.9.0']);
});

test('a milestone the roadmap does not have, or a missing roadmap, gives an error instead of a graph', () => {
  assert.deepEqual(buildGsdGraph(fixtureSource(), { milestone: 'v7.7.7' }), { error: 'The roadmap has no milestone v7.7.7.' });
  assert.ok('error' in buildGsdGraph({ paths: [], files: new Map() }));
});

test('the current milestone comes from STATE.md, then the construction sign, then the bullet that says current', () => {
  const roadmap = parseRoadmap(['## Milestones', '', '- **v1.0.0 One**: Phases 1-2 (SHIPPED)', '- **v1.1.0 Two**: Phases 3-4 (current)', '- \u{1F6A7} **v1.2.0 Three**: Phases 5-6', '', '## v1.2.0 Three', '', '### Phase 5: Five', ''].join('\n'));
  assert.equal(currentMilestoneKey(roadmap, '---\nmilestone: v1.0.0\n---\n'), 'v1.0.0');
  assert.equal(currentMilestoneKey(roadmap, '---\nmilestone: "1.1.0"\n---\n'), 'v1.1.0');
  assert.equal(currentMilestoneKey(roadmap, '---\nmilestone: nothing-like-it\n---\n'), 'v1.2.0');
  assert.equal(currentMilestoneKey(roadmap, undefined), 'v1.2.0');
  assert.equal(currentMilestoneKey(parseRoadmap('## Milestones\n\n- **v1.0.0 One**: Phases 1-2 (SHIPPED)\n'), undefined), undefined);
});

test('a plan whose phase is in no milestone is skipped with one warning, and not warned about when an archived copy exists', () => {
  const base = fixtureSource();
  const orphan = '.planning/phases/25-orphan/25-01-PLAN.md';
  const plain = graphOf({ paths: [...base.paths, orphan], files: new Map([...base.files, [orphan, '# Plan 25-01: Orphan\n']]) });
  assert.deepEqual(plain.plans.map((plan) => `${plan.phase}-${plan.plan}`), ['90-01', '90-02', '91.1-01']);
  assert.equal(plain.warnings.length, 1);
  assert.match(plain.warnings[0] ?? '', /25-01/);
  const archivedCopy = '.planning/milestones/old-phases/25-orphan/25-01-PLAN.md';
  const twin = graphOf({ paths: [...base.paths, orphan, archivedCopy], files: new Map([...base.files, [orphan, '# x\n'], [archivedCopy, '# x\n']]) });
  assert.deepEqual(twin.warnings, []);
});

test('frontmatter hostile input is bounded and inert', () => {
  const started = Date.now();
  const huge = parseFrontmatter(`---\n${'a: b\n'.repeat(180_000)}---\n`);
  assert.ok(Date.now() - started < 1000, 'a 1 MB frontmatter is rejected quickly');
  assert.equal(huge.fields, undefined);
  assert.match(huge.problems.join(' '), /longer than 400 lines/);

  const proto = parseFrontmatter('---\n__proto__:\n  polluted: true\nconstructor:\n  prototype:\n    polluted: true\nplan: 3\n---\n');
  assert.equal(proto.fields?.plan, '3');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);

  const open = parseFrontmatter('---\nphase: 1\nplan: 2\n');
  assert.equal(open.fields, undefined);
  assert.match(open.problems.join(' '), /not closed/);

  const items = Array.from({ length: 10_000 }, (_, i) => `61-${i}`).join(', ');
  const many = parseFrontmatter(`---\ndepends_on: [${items}]\n---\n`);
  assert.equal(many.fields?.dependsOn.length, 64);
  assert.match(many.problems.join(' '), /more than 64 entries/);

  const block = parseFrontmatter(`---\nfiles_modified:\n${'  - a/b.ts\n'.repeat(300)}---\n`);
  assert.equal(block.fields?.filesModified.length, 64);

  const none = parseFrontmatter('# Heading\n\ntext\n---\nnot: frontmatter\n---\n');
  assert.deepEqual(none, { fields: undefined, problems: [] });
});

test('a task element without a closing tag is ignored and a task count above the cap is cut', () => {
  const open = parsePlanTasks('<tasks>\n<task type="auto">\n  <name>Task 1: never closed</name>\n');
  assert.deepEqual(open, []);
  const closed = Array.from({ length: 70 }, (_, i) => `<task type="auto">\n<name>Task ${i + 1}: step ${i + 1}</name>\n</task>\n`).join('');
  const tasks = parsePlanTasks(`<tasks>\n${closed}</tasks>`);
  assert.equal(tasks.length, 50);
  assert.equal(tasks[49]?.title, 'step 50');
  const inline = parsePlanTasks('Prose that mentions <task type="auto"> inline is not a task.\n</task>');
  assert.deepEqual(inline, []);
});

test('a flood of unclosed task tags and of milestone bullets is read in bounded time', () => {
  const started = Date.now();
  assert.deepEqual(parsePlanTasks('<task type="auto">\n'.repeat(60_000)), []);
  assert.deepEqual(parsePlanTasks(`${'<task\n'.repeat(60_000)}x`), []);
  const bullets = Array.from({ length: 5000 }, (_, i) => `- **v${i}.0.0 Name ${i}**: Phases ${i}-${i + 1}`).join('\n');
  const phases = Array.from({ length: 5000 }, (_, i) => `### Phase ${i}: Name ${i}\n**Depends on**: Phase ${i + 1}`).join('\n');
  const roadmap = parseRoadmap(`## Milestones\n${bullets}\n\n## v1.0.0 Big\n${phases}\n`);
  assert.ok(roadmap.milestones.length <= 200);
  assert.ok(roadmap.problems.length > 0);
  const paths = Array.from({ length: 6000 }, (_, i) => `.planning/phases/${100_000 + i}-x/${100_000 + i}-01-PLAN.md`);
  const result = buildGsdGraph({ paths, files: new Map([['.planning/ROADMAP.md', `## Milestones\n${bullets}\n\n## v1.0.0 Big\n${phases}\n`]]) });
  assert.ok('milestone' in result ? result.warnings.length <= 100 : true);
  assert.ok(Date.now() - started < 3000, 'hostile roadmaps and task floods finish quickly');
});

test('titles keep a lone surrogate half but lose tabs and repeated spaces', () => {
  const tasks = parsePlanTasks('<task type="auto">\n<name>Task 1:\tStep \ud800   with\t\tgaps  </name>\n<files>a.ts,\tb.ts , </files>\n</task>');
  assert.deepEqual(tasks, [{ index: 1, title: 'Step \ud800 with gaps', type: 'auto', files: ['a.ts', 'b.ts'] }]);
});

test('requirement ranges expand and a trailing requirement group leaves the checklist title', () => {
  const roadmap = parseRoadmap([
    '## v2.0.0 Range', '', '### Phase 1: One', '**Depends on**: Phases 64, 65 and 66.1', '**Requirements**: CYBER-01 \u2026 CYBER-03, SEC-04', '',
    '- [ ] 01-01: Plain name (SEC-04, CYBER-01)', '- [x] 01-02-PLAN.md \u2014 Dashed name',
  ].join('\n'));
  const phase = roadmap.sections[0]?.phases[0];
  assert.deepEqual(phase?.dependsOn, ['64', '65', '66.1']);
  assert.deepEqual(phase?.requirements, ['CYBER-01', 'CYBER-02', 'CYBER-03', 'SEC-04']);
  assert.deepEqual(phase?.plans.map((p) => [p.phase, p.plan, p.title, p.checked, p.requirements]), [
    ['1', '01', 'Plain name', false, ['SEC-04', 'CYBER-01']],
    ['1', '02', 'Dashed name', true, []],
  ]);
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// This repository's own planning files at HEAD

const REPO_ROOT = path.join(__dirname, '..', '..');

function git(args: string[]): string {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

test('every plan committed at HEAD parses, and HEAD gives milestone v0.6.0 with phases 60 to 67 and finished phases 60 and 61', () => {
  const listed = git(['ls-tree', '-r', '-z', '--full-tree', '--name-only', 'HEAD', '--', '.planning']).split('\0').filter((name) => name !== '');
  const files = new Map<string, string>();
  const planPaths = listed.filter((name) => name.endsWith('-PLAN.md'));
  assert.ok(planPaths.length >= 76, 'the repository has at least 76 plans at HEAD');
  for (const name of ['.planning/ROADMAP.md', '.planning/STATE.md', ...planPaths]) files.set(name, git(['cat-file', 'blob', `HEAD:${name}`]));
  for (const name of planPaths) {
    const text = files.get(name) ?? '';
    const { fields } = parseFrontmatter(text);
    const identity = planIdentity(name);
    assert.ok(identity !== undefined, name);
    parsePlanTasks(text);
    if (fields !== undefined) {
      const slug = /^\d+(?:\.\d+)*/.exec(fields.phase ?? '')?.[0] ?? '';
      assert.equal(normalisePhase(slug), identity.phase, name);
      assert.ok(Number.isInteger(fields.wave), `${name} has an integer wave`);
    }
  }
  const graph = graphOf({ paths: listed, files });
  assert.equal(graph.milestone.key, 'v0.6.0');
  assert.equal(graph.milestone.current, true);
  assert.deepEqual(graph.phases.map((phase) => phase.number), ['60', '61', '62', '63', '64', '65', '66', '67']);
  const inPhase = (number: string) => graph.plans.filter((plan) => plan.phase === number);
  assert.equal(inPhase('60').length, 12);
  assert.equal(inPhase('61').length, 14);
  for (const plan of [...inPhase('60'), ...inPhase('61')]) assert.equal(plan.hasSummary, true, `${plan.phase}-${plan.plan} has a SUMMARY`);
  const onDisk = planPaths.filter((name) => planIdentity(name)?.phase === '62').length;
  assert.equal(inPhase('62').length, onDisk);
  assert.ok(graph.plans.every((plan) => plan.tasks.length > 0 && plan.title !== ''));
});
