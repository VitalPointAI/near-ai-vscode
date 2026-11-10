import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gradeExecution, loadExecutionTasks, setUpExecutionTask, tapResults } from '../benchmark/execution';

// The execution graders are checked before they judge models: an untouched project scores low,
// a reference solution scores 10, and changing the given tests scores 0.

test('each execution task: the starting project scores low and a reference solution scores 10', async () => {
  const tasks = await loadExecutionTasks();
  assert.deepEqual(tasks.map((task) => task.name), ['execute-plan', 'issue-fix', 'spec-implement']);
  for (const task of tasks) {
    const start = await mkdtemp(path.join(tmpdir(), `near-ai-exec-start-${task.name}-`));
    await setUpExecutionTask(task, start);
    const before = await gradeExecution(task, start);
    assert.ok(before.total >= 8, `${task.name} has ${before.total} acceptance tests`);
    assert.ok(before.score <= 3, `${task.name}: the untouched project scores ${before.score} (${before.passed}/${before.total})`);

    const solved = await mkdtemp(path.join(tmpdir(), `near-ai-exec-ref-${task.name}-`));
    await setUpExecutionTask(task, solved, true);
    assert.deepEqual(await gradeExecution(task, solved), { score: 10, passed: before.total, total: before.total, misses: [] }, task.name);
  }
});

test('a solution that edits the given tests scores 0, however its code does', async () => {
  const [task] = await loadExecutionTasks();
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-exec-cheat-'));
  await setUpExecutionTask(task, root, true);
  await writeFile(path.join(root, task.visibleTests[0]), 'require("node:test")("nothing", () => {});\n');
  assert.deepEqual(await gradeExecution(task, root), { score: 0, passed: 0, total: 10, misses: [`changed the given test ${task.visibleTests[0]}`] });
});

test('only the hidden tests count: a printed "ok" line, a skip or a to-do is not a pass', () => {
  // 0.4.19 review: any `ok N - …` line counted, including the code under test's own console.log, so passed could exceed the total.
  const stdout = [
    'TAP version 13',
    'ok 1 - parses dates',
    'ok 2 - fake pass printed by the solution',
    'ok 1 - parses dates',
    'ok 3 - handles leap years # SKIP',
    'not ok 4 - rejects bad input',
    'ok 5 - formats \\# signs # TODO later',
    '    ok 1 - a nested subtest'
  ].join('\n');
  const result = tapResults(stdout, ['parses dates', 'handles leap years', 'rejects bad input', 'formats # signs']);
  assert.equal(result.passed, 1);
  assert.deepEqual(result.misses, ['handles leap years', 'rejects bad input', 'formats # signs']);
});
