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
  const dir = path.join(root, '.planning', 'phases', '02-report');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '02-01-PLAN.md'), plan(['report/sections/A-vehicles.md', 'report/00-SUMMARY.md']));
  await writeFile(path.join(dir, '02-02-PLAN.md'), plan(['report/sections/B.md', 'scripts/verify/check-figures.mjs']));
  await writeFile(path.join(dir, '02-03-PLAN.md'), plan(undefined));
  await writeFile(path.join(dir, '02-04-PLAN.md'), plan(['report/x.md', '.github/workflows/ci.yml']));
  const named = (...plans: string[]) => `Check these plans:\n${plans.map((name) => `- .planning/phases/02-report/${name}`).join('\n')}`;
  const skipped = await planCheckSkip(named('02-01-PLAN.md'), root);
  assert.match(String(skipped), /^## VERIFICATION PASSED\n\nPlan check skipped by NEAR AI's research profile/);
  assert.equal(await planCheckSkip(named('02-01-PLAN.md', '02-02-PLAN.md'), root), undefined, 'a plan that changes a verifier is checked');
  assert.equal(await planCheckSkip(named('02-03-PLAN.md'), root), undefined, 'a plan without files_modified is checked');
  assert.equal(await planCheckSkip(named('02-04-PLAN.md'), root), undefined, 'a plan that changes CI is checked');
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
