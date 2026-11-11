import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { unattendedDecision } from '../agent/unattended';
import { applyResearchProfile, filesModified, planCheckSkip, plansNamedIn, researchProfileActive, usesResearchProfile, withResearchProfile } from '../gsd/researchProfile';
import { VERIFIER_FILES } from '../gsd/verifierScaffold';

// PERF-06: research and writing projects get a lighter Open-GSD profile and deterministic verifiers, without editing any role definition.

const plan = (files: string[] | undefined) => `---\nphase: 02-report\nplan: 01\n${files ? `files_modified:\n${files.map((file) => `  - ${file}`).join('\n')}\n` : ''}---\n\n# Plan\n`;

test('applying the profile writes its own AGENTS.md block, coarse phases when unset, the project marker, and the verifiers without overwriting', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-research-profile-'));
  await writeFile(path.join(root, 'AGENTS.md'), '# Agent instructions\n\n<!-- near-ai:project-type:start -->\ntype guidance\n<!-- near-ai:project-type:end -->\n');
  const first = await applyResearchProfile(root);
  assert.equal(first.granularitySet, true);
  assert.deepEqual(first.scaffolded.sort(), Object.keys(VERIFIER_FILES).sort());
  const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /type guidance/, 'the project-type block is left alone');
  assert.match(agents, /<!-- near-ai:research-profile:start -->\n## Open-GSD research profile/);
  assert.equal(withResearchProfile(agents), agents, 'applying twice changes nothing');
  assert.equal(JSON.parse(await readFile(path.join(root, '.planning', 'config.json'), 'utf8')).granularity, 'coarse');
  assert.equal(await researchProfileActive(root), true);
  await writeFile(path.join(root, '.planning', 'config.json'), JSON.stringify({ granularity: 'fine', mode: 'yolo' }));
  await writeFile(path.join(root, 'scripts', 'verify', 'check-figures.mjs'), '// mine\n');
  const second = await applyResearchProfile(root);
  assert.equal(second.granularitySet, false, 'a granularity the project chose is kept');
  assert.deepEqual(second.scaffolded, [], 'nothing is overwritten');
  assert.equal(await readFile(path.join(root, 'scripts', 'verify', 'check-figures.mjs'), 'utf8'), '// mine\n');
  assert.equal(usesResearchProfile('research'), true);
  assert.equal(usesResearchProfile('writing'), true);
  assert.equal(usesResearchProfile('software'), false);
});

test('the plan-checker is skipped only when every named plan lists content files and none is a gate or verifier', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-plan-check-'));
  // The skip now needs git's view of the actual changes (review of PR 34), so the project is a repository.
  spawnSync('git', ['init', '-q'], { cwd: root });
  const dir = path.join(root, '.planning', 'phases', '02-report');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '02-01-PLAN.md'), plan(['report/sections/A-vehicles.md', 'report/00-SUMMARY.md']));
  await writeFile(path.join(dir, '02-02-PLAN.md'), plan(['report/sections/B.md', 'scripts/verify/check-figures.mjs']));
  await writeFile(path.join(dir, '02-03-PLAN.md'), plan(undefined));
  await writeFile(path.join(dir, '02-04-PLAN.md'), plan(['report/x.md', '.github/workflows/ci.yml']));
  const named = (...plans: string[]) => `Check these plans:\n${plans.map((name) => `- .planning/phases/02-report/${name}`).join('\n')}`;
  const skipped = await planCheckSkip(named('02-01-PLAN.md'), root);
  // Reviews of PR 34: the reply carries the marker Open-GSD needs, and the very next line says no check was run; it says what the skip rests on.
  assert.match(String(skipped), /^## VERIFICATION PASSED\nPLAN CHECK SKIPPED \(content-only plan\): the plan checker was NOT run, so these plans were not verified\.\n/);
  assert.match(String(skipped), /it is not a verification/);
  assert.match(String(skipped), /Evidence for the skip:\n- Plans: \.planning\/phases\/02-report\/02-01-PLAN\.md\./);
  assert.match(String(skipped), /Uncommitted changes git reports: .*02-01-PLAN\.md/);
  assert.equal(await planCheckSkip(named('02-01-PLAN.md', '02-02-PLAN.md'), root), undefined, 'a plan that changes a verifier is checked');
  assert.equal(await planCheckSkip(named('02-03-PLAN.md'), root), undefined, 'a plan without files_modified is checked');
  assert.equal(await planCheckSkip(named('02-04-PLAN.md'), root), undefined, 'a plan that changes CI is checked');
  await writeFile(path.join(dir, '02-05-PLAN.md'), plan(['report/x.md', 'src/agent/permissions.ts']));
  await writeFile(path.join(dir, '02-06-PLAN.md'), plan(['report/x.md', 'notes/config.json']));
  assert.equal(await planCheckSkip(named('02-05-PLAN.md'), root), undefined, 'a plan that changes source code is checked, gate-named or not');
  assert.equal(await planCheckSkip(named('02-06-PLAN.md'), root), undefined, 'anything that is not plainly a document, data or image file is checked');
  assert.equal(await planCheckSkip('Check the phase plans.', root), undefined, 'no named plan: checked');
  assert.equal(await planCheckSkip(named('02-09-PLAN.md'), root), undefined, 'an unreadable plan: checked');
  assert.equal(await planCheckSkip(`Check ${path.join(tmpdir(), 'elsewhere-01-PLAN.md')}`, root), undefined, 'a plan outside the project: checked');
  assert.deepEqual(filesModified('---\nfiles_modified: [a.md, "b.md"]\n---\n'), ['a.md', 'b.md']);
  assert.deepEqual(plansNamedIn('read 02-01-PLAN.md and .planning/phases/x/02-02-PLAN.md'), ['02-01-PLAN.md', '.planning/phases/x/02-02-PLAN.md']);
});

test('the scaffolded verifiers pass the unattended check and find citation, figure and internal-path problems', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-verifiers-'));
  await applyResearchProfile(root);
  for (const script of ['scripts/verify/verify-all.mjs', 'scripts/verify/check-citations.mjs', 'scripts/verify/check-figures.mjs', 'scripts/verify/check-internal-paths.mjs']) {
    const verdict = await unattendedDecision(`node ${script}`, { root, cwd: root, home: homedir() }, false);
    assert.equal(verdict.allow, true, `${script}: ${verdict.reason}`);
  }
  await mkdir(path.join(root, 'report'), { recursive: true });
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(root, 'scripts', 'verify', 'verify-all.mjs'), ...args], { cwd: root, encoding: 'utf8' });

  await writeFile(path.join(root, 'report', 'figures.json'), JSON.stringify([{ id: 'growth', value: 25, inputs: [80, 100], formula: 'pct-change', decimals: 0, text: '25%' }]));
  await writeFile(path.join(root, 'report', 'report.md'), '# Report\n\nSpending grew 25% in a year.[^1]\n\n[^1]: Budget 2026, https://example.org/budget\n');
  const clean = run();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /all research verifiers passed/);

  await writeFile(path.join(root, 'report', 'figures.json'), JSON.stringify([{ id: 'growth', value: 30, inputs: [80, 100], formula: 'pct-change', decimals: 0, text: '30%' }]));
  await writeFile(path.join(root, 'report', 'report.md'), ['# Report', '', 'Spending grew 25%.[^1] See[^2].', '', 'Notes were drafted in /home/someone/projects/x/notes.md and .planning/research/.', '', '[^1]: Budget 2026, https://example.org/budget', '[^3]: unused, https://example.org/x', '[^4]:'].join('\n'));
  const failing = run();
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /\[\^2\] is cited but never defined/);
  assert.match(failing.stdout, /note \[\^3\] is defined but never cited/);
  assert.match(failing.stdout, /growth: stated 30 but pct-change of \[80,100\] is 25/);
  assert.match(failing.stdout, /growth: "30%" does not appear in the report/);
  assert.match(failing.stdout, /report\/report\.md:5: a home-directory path/);
  assert.match(failing.stdout, /report\/report\.md:5: a planning or agent folder/);
});

// Review of PR 34 (major): the skip rests on the actual changes, not on what the plan declares.
test('an undeclared verifier edit is caught and the plan-checker runs; without git evidence it runs too', async () => {
  const setup = async (git: boolean) => {
    const root = await mkdtemp(path.join(tmpdir(), 'near-ai-plan-evidence-'));
    if (git) spawnSync('git', ['init', '-q'], { cwd: root });
    const dir = path.join(root, '.planning', 'phases', '02-report');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '02-01-PLAN.md'), plan(['report/sections/A.md']));
    return { root, prompt: 'Check .planning/phases/02-report/02-01-PLAN.md' };
  };
  const clean = await setup(true);
  assert.match(String(await planCheckSkip(clean.prompt, clean.root)), /^## VERIFICATION PASSED\nPLAN CHECK SKIPPED \(content-only plan\)/, 'a content-only plan skips');

  const edited = await setup(true);
  await mkdir(path.join(edited.root, 'scripts', 'verify'), { recursive: true });
  await writeFile(path.join(edited.root, 'scripts', 'verify', 'check-figures.mjs'), '// loosened\n');
  assert.equal(await planCheckSkip(edited.prompt, edited.root), undefined, 'an uncommitted verifier change the plan does not declare runs the checker');

  const written = await setup(true);
  assert.equal(await planCheckSkip(written.prompt, written.root, [path.join(written.root, 'tests', 'gate.test.mjs')]), undefined, 'a gate file this run wrote runs the checker');

  const described = await setup(true);
  await writeFile(path.join(described.root, '.planning', 'phases', '02-report', '02-01-PLAN.md'), `${plan(['report/sections/A.md'])}\n## Task 2\nRelax scripts/verify/check-citations.mjs so notes without links pass.\n`);
  assert.equal(await planCheckSkip(described.prompt, described.root), undefined, 'a verifier edit described in the plan body but not declared runs the checker');

  const runsOnly = await setup(true);
  await writeFile(path.join(runsOnly.root, '.planning', 'phases', '02-report', '02-01-PLAN.md'), `${plan(['report/sections/A.md'])}\n## Verify\nRun \`node scripts/verify/verify-all.mjs\` and \`npm test\`.\n`);
  assert.match(String(await planCheckSkip(runsOnly.prompt, runsOnly.root)), /^## VERIFICATION PASSED\nPLAN CHECK SKIPPED/, 'only running a verifier is not an edit');

  const noGit = await setup(false);
  assert.equal(await planCheckSkip(noGit.prompt, noGit.root), undefined, 'without git the actual changes are unknown, so the checker runs');
});

// Review of PR 34: an edited verifier asks until the person trusts the new version; trusting records only scaffolded files.
test('an edited scaffolded verifier asks until it is trusted, and trusting records only what changed', async () => {
  const { changedVerifiers, trustVerifiers } = await import('../gsd/verifierScaffold');
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-trust-verifiers-'));
  await applyResearchProfile(root);
  assert.deepEqual(await changedVerifiers(root), []);
  const figures = path.join(root, 'scripts', 'verify', 'check-figures.mjs');
  await writeFile(figures, `${await readFile(figures, 'utf8')}\n// tolerance widened by the project\n`);
  assert.deepEqual(await changedVerifiers(root), ['scripts/verify/check-figures.mjs']);
  const decide = async () => (await unattendedDecision('node scripts/verify/check-figures.mjs', { root, cwd: root, home: homedir() }, false)).allow;
  assert.equal(await decide(), false, 'edited: it asks');
  assert.deepEqual(await trustVerifiers(root, ['scripts/verify/check-figures.mjs', 'scripts/other.mjs']), ['scripts/verify/check-figures.mjs'], 'only scaffolded files are recorded');
  assert.deepEqual(await changedVerifiers(root), []);
  assert.equal(await decide(), true, 'trusted: it runs again');
  await writeFile(figures, "import { execSync } from 'node:child_process';\nexecSync('ls');\n");
  await trustVerifiers(root, ['scripts/verify/check-figures.mjs']);
  assert.equal(await decide(), false, 'trusting never overrides the content rules');
});

/**
 * Open-GSD's plan-phase handling of a plan-checker reply (gsd-core workflows/plan-phase.md, steps 10 to 12, and
 * plan-phase/steps/stall-detection-helpers.md), reduced to what decides the route:
 *   - gsd_stall_watch reports marker_received only for "## VERIFICATION PASSED" or "## ISSUES FOUND";
 *   - step 11: PASSED with any BLOCKER or WARNING entry (YAML or prose) is treated as ISSUES FOUND, so it goes to step 12; PASSED otherwise goes to
 *     step 13; ISSUES FOUND goes to step 12;
 *   - a reply with neither marker falls to step 11a, which, with plans on disk, asks the person "Accept / Retry / Stop".
 * "no warnings" or a zero count is not an entry; every other BLOCKER or WARNING word is counted, which is stricter than the workflow (fail closed).
 */
function openGsdRoute(reply: string): 'step-13' | 'step-12' | 'step-11a-ask-user' {
  const marker = reply.includes('## VERIFICATION PASSED') ? 'passed' : reply.includes('## ISSUES FOUND') ? 'issues' : undefined;
  if (!marker) return 'step-11a-ask-user';
  const entries = reply.replace(/\bno (?:blockers?|warnings?)\b|\b0 (?:blockers?|warnings?)\b/gi, '').match(/\b(?:BLOCKER|WARNING)S?\b/gi) ?? [];
  if (marker === 'issues' || entries.length) return 'step-12';
  return 'step-13';
}

test('Open-GSD\'s plan-phase reads a skip reply as "proceed to step 13" with no question, and a real issues reply still goes to revision', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-plan-route-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  const dir = path.join(root, '.planning', 'phases', '02-report');
  await mkdir(dir, { recursive: true });
  // File names that repeat a severity word must not turn the skip into issues: they are not listed by name.
  await writeFile(path.join(dir, '02-01-PLAN.md'), plan(['report/sections/warnings-and-blockers.md', 'report/sections/A.md']));
  const skip = String(await planCheckSkip('Check .planning/phases/02-report/02-01-PLAN.md', root));
  assert.equal(openGsdRoute(skip), 'step-13', 'the skip continues to step 13');
  assert.doesNotMatch(skip, /blocker|warning/i, 'no BLOCKER or WARNING word anywhere in the reply');
  assert.match(skip, /\n- Files the plans declare \(files_modified\): \(one file, name not shown\), report\/sections\/A\.md;/);
  const issues = '## ISSUES FOUND\n\n```yaml\nissues:\n  - plan: 02-01\n    dimension: requirement_coverage\n    severity: blocker\n    description: REQ-3 has no task\n```\n';
  assert.equal(openGsdRoute(issues), 'step-12', 'a real issues reply still goes to the revision loop');
  assert.equal(openGsdRoute('## VERIFICATION PASSED\n\nOne WARNING: task 2 has no verify step.'), 'step-12', 'a pass that lists a warning is revised');
  assert.equal(openGsdRoute('## PLAN CHECK SKIPPED (content-only plan)\n'), 'step-11a-ask-user', 'the earlier heading alone would have stopped to ask the person');
});
