// Every role gets a graded task, and a role added later gets one automatically (owner, 2026-11-08). The grader runs on a real folder, so these tests
// write the answers a good and a careless run would leave behind and check that the scores separate them.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gradeRoleAnswer, roleOutputs } from '../benchmark/roleGraders';
import { fallbackRoleTask, kindForRoleName, ROLE_TASKS, roleTaskFor } from '../benchmark/roleTasks';
import { TEAM_ROLE_IDS } from '../services/teamStudioPage';

async function folder(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-role-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}

test('every role the studio offers has a task written for it, so no role is ever measured on a guess', () => {
  for (const role of TEAM_ROLE_IDS) {
    assert.ok(roleTaskFor(role), `${role} needs a task of its own, or its model is chosen by guesswork`);
    assert.ok(ROLE_TASKS.some((task) => task.role === role && task.prompt.length > 80), `${role}'s task must actually ask for something`);
  }
  // And every written task belongs to a role the studio still offers, so a renamed role does not leave a stale task behind.
  for (const task of ROLE_TASKS) assert.ok(TEAM_ROLE_IDS.includes(task.role), `${task.role} is not a studio role any more`);
});

test('a role added later still gets a task and a score, from the kind of work its name describes', () => {
  const added = fallbackRoleTask('compliance-auditor');
  assert.equal(added.written, false, 'it says the task was not written for this role');
  assert.equal(kindForRoleName('compliance-auditor'), 'coding');
  assert.ok(added.task.prompt.length > 80);
  assert.match(added.task.label, /used because compliance-auditor has no task of its own/);
  // A role whose name gives nothing away is measured on the broadest task rather than skipped.
  assert.equal(kindForRoleName('zebra'), 'planning');
  assert.ok(fallbackRoleTask('zebra').task);
  // Named by kind: a planner plans, a researcher researches, an implementer implements.
  assert.equal(kindForRoleName('planner'), 'planning');
  assert.equal(kindForRoleName('researcher'), 'research');
  assert.equal(kindForRoleName('implementer'), 'coding');
});

test('a good reviewer scores full marks and a careless one does not, on the same grader', async () => {
  const files = { 'shop.js': 'export function totalAfterTax(){}\n' };
  const good = await folder({ ...files, 'review.md': '1. High: the discount is applied AFTER tax, because `taxed` is discounted on line 5 of shop.js.\n2. Medium: the `>= threshold` comparison gives the discount at exactly the threshold; the brief says more than.\n' });
  const careless = await folder({ ...files, 'review.md': 'Looks fine.\n' });
  const goodGrade = gradeRoleAnswer('reviewer', good, files);
  const carelessGrade = gradeRoleAnswer('reviewer', careless, files);
  assert.equal(goodGrade.score, goodGrade.outOf, `a good review should score full marks, missed: ${goodGrade.misses.join(', ')}`);
  assert.ok(carelessGrade.score < goodGrade.score, 'a review that finds nothing scores lower');
  assert.ok(carelessGrade.misses.includes('found the discount order'));
  assert.ok(carelessGrade.misses.includes('cites the file'));
});

test('a role with no grader of its own is still scored, so a new role can be ranked', async () => {
  // The task the role was given decides which file it should have written: a coding-kind role is asked for a review.
  const kind = fallbackRoleTask('compliance-auditor').task.kind;
  const output = roleOutputs('compliance-auditor', kind)[0] as string;
  const files = { [output]: '' };
  const wrote = await folder({ [output]: '1. High: the discount is applied after tax, in shop.js.\n2. Medium: the threshold comparison is off by one.\n' });
  const placeholder = await folder({ [output]: 'TODO\n' });
  const nothing = await folder({});
  const wroteGrade = gradeRoleAnswer('compliance-auditor', wrote, files, kind);
  assert.equal(wroteGrade.outOf, 3);
  assert.equal(wroteGrade.score, wroteGrade.outOf, `the default grader should pass a real output, missed: ${wroteGrade.misses.join(', ')}`);
  assert.ok(gradeRoleAnswer('compliance-auditor', placeholder, files, kind).score < wroteGrade.score, 'a placeholder is not an answer');
  // One check is "it did not break the fixtures", which an empty folder passes; the output checks are what fail.
  const empty = gradeRoleAnswer('compliance-auditor', nothing, files, kind);
  assert.ok(empty.misses.includes('wrote its output'), 'no output is a miss, not a crash');
  assert.ok(empty.score < wroteGrade.score);
});

test('every grader is mechanical: the same folder scores the same twice', async () => {
  const files = { 'shop.js': 'x' };
  const root = await folder({ ...files, 'plan.md': '1. Fix shop.js so the discount is applied to the subtotal before tax.\n2. Use more than the threshold, not equal.\n' });
  for (const role of ROLE_TASKS.map((task) => task.role)) {
    const first = gradeRoleAnswer(role, root, files);
    const second = gradeRoleAnswer(role, root, files);
    assert.deepEqual(first, second, `${role} must grade the same folder the same way`);
    assert.equal(first.score + first.misses.length, first.outOf, `${role}: every check is either a pass or a miss`);
  }
});
