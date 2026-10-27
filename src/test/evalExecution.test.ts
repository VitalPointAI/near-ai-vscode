import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gradeExecution, loadExecutionTasks, setUpExecutionTask } from './evalExecution';

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
