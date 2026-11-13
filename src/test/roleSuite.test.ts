// Planning and ranking a team's role runs (owner, 2026-11-08). The plan is what the studio shows as a cost before starting, and the ranking is what
// decides each member's model, so a failed run must never win and a cheaper-but-worse model must never be chosen.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bestOf, planRoleSuite } from '../benchmark/roleSuite';

test('the plan runs every member on its own role task with every candidate model, and says how many runs that is', () => {
  const plan = planRoleSuite(
    [{ name: 'scout', role: 'researcher' }, { name: 'architect', role: 'planner' }, { name: 'mapper' }],
    ['a', 'b']
  );
  assert.equal(plan.estimatedRuns, 6, 'three members, two models each');
  assert.equal(plan.members, 3);
  assert.equal(plan.models, 2);
  // A member's task is its ROLE's task, not one shared task.
  assert.equal(plan.runs.find((run) => run.member === 'scout')?.task.role, 'researcher');
  assert.equal(plan.runs.find((run) => run.member === 'architect')?.task.role, 'planner');
  // A member with no role is measured on the task for its own name, which is how it is addressed.
  assert.equal(plan.runs.find((run) => run.member === 'mapper')?.role, 'mapper');
  assert.equal(plan.runs.find((run) => run.member === 'mapper')?.written, false, 'and it says the task was guessed');
  assert.equal(plan.runs.find((run) => run.member === 'scout')?.written, true);
});

test('the best model for a member is the most accurate, then the quickest, and a failed run never wins', () => {
  const outcomes: Parameters<typeof bestOf>[0] = [
    { member: 'scout', role: 'researcher', best: 'cheap', current: 'old', written: true, results: [
      { model: 'strong', score: 9, outOf: 10, seconds: 90, failed: false, misses: [] },
      { model: 'cheap', score: 9, outOf: 10, seconds: 30, failed: false, misses: [] },
      { model: 'fast-but-failed', score: 10, outOf: 10, seconds: 5, failed: true, misses: ['stalled'] }
    ] },
    { member: 'architect', role: 'planner', best: undefined, written: true, results: [
      { model: 'a', score: 0, outOf: 6, seconds: 10, failed: true, misses: ['timed out'] }
    ] }
  ];
  const picks = bestOf(outcomes);
  assert.equal(picks.length, 1, 'a member whose every run failed gets no recommendation at all');
  assert.equal(picks[0]?.model, 'cheap', 'equal scores, so the quicker model wins');
  assert.equal(picks[0]?.current, 'old', 'the studio can say what changed');
  assert.match(picks[0]?.why ?? '', /best on its role task \(9\/10\)/);
});

test('a member whose name has a task of its own is measured on it, even when its role is generic', () => {
  const plan = planRoleSuite([{ name: 'plagiarism-checker', role: 'reviewer' }, { name: 'source-verifier', role: 'reviewer' }], ['a']);
  assert.equal(plan.runs[0]?.task.role, 'plagiarism-checker', 'the research team\'s checker is measured on checking a draft, not on a code review');
  assert.equal(plan.runs[0]?.written, true);
  assert.equal(plan.runs[1]?.task.role, 'reviewer', 'a name with no task of its own falls back to its role');
});
