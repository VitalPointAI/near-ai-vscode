import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Execution tasks for the model eval: build or fix something in a small multi-file project from
// a plan, an issue report, or a spec, as GSD executors do. Each is scored by acceptance tests the
// model never sees, copied in only after it finishes, so partial work earns partial credit.

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'eval');
const ACCEPTANCE_DIR = '.acceptance-check';

export interface ExecutionTask {
  name: string;
  prompt: string;
  /** Tests the model is given; they must be unchanged and still pass. */
  visibleTests: string[];
  /** Environment for the hidden tests, e.g. a time zone that exposes a bug. */
  hiddenEnv?: Record<string, string>;
  dir: string;
}

export async function loadExecutionTasks(): Promise<ExecutionTask[]> {
  const names = (await readdir(FIXTURES, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return Promise.all(names.map(async (name) => ({ name, dir: path.join(FIXTURES, name), ...JSON.parse(await readFile(path.join(FIXTURES, name, 'task.json'), 'utf8')) })));
}

/** Copies the task's starting project into `root`; `withReference` adds the reference solution on top, for checking the grader. */
export async function setUpExecutionTask(task: ExecutionTask, root: string, withReference = false): Promise<void> {
  await cp(path.join(task.dir, 'start'), root, { recursive: true });
  if (withReference) await cp(path.join(task.dir, 'reference'), root, { recursive: true });
}

/** Without the parent test runner's context, under which a failing `node --test` exits 0. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

export async function gradeExecution(task: ExecutionTask, root: string): Promise<{ score: number; passed: number; total: number; misses: string[] }> {
  const total = (await hiddenTestNames(task)).length;
  for (const name of task.visibleTests) {
    const given = await readFile(path.join(task.dir, 'start', name), 'utf8');
    if (await readFile(path.join(root, name), 'utf8').catch(() => '') !== given) return { score: 0, passed: 0, total, misses: [`changed the given test ${name}`] };
  }
  const visible = spawnSync(process.execPath, ['--test', ...task.visibleTests], { cwd: root, env: cleanEnv(), encoding: 'utf8', timeout: 120_000 });
  if (visible.status !== 0) return { score: 0, passed: 0, total, misses: ['the given tests fail'] };
  const check = path.join(root, ACCEPTANCE_DIR);
  await mkdir(check, { recursive: true });
  await cp(path.join(task.dir, 'hidden'), check, { recursive: true });
  let passed = 0;
  const misses: string[] = [];
  for (const file of (await readdir(check)).filter((name) => name.endsWith('.test.js')).sort()) {
    // Run directly, not with --test, so each test() reports at the top level of the TAP output.
    const result = spawnSync(process.execPath, ['--test-reporter=tap', path.join(check, file)], { cwd: root, env: cleanEnv(task.hiddenEnv), encoding: 'utf8', timeout: 120_000 });
    for (const match of (result.stdout ?? '').matchAll(/^(not )?ok \d+ - (.+)$/gm)) {
      if (match[1]) misses.push(match[2].trim()); else passed += 1;
    }
  }
  // A crash before any test ran (e.g. a syntax error) leaves tests unreported: they count as failed.
  if (passed + misses.length < total) misses.push(`${total - passed - misses.length} acceptance tests did not run`);
  return { score: total ? Math.round((10 * passed) / total) : 0, passed, total, misses };
}

async function hiddenTestNames(task: ExecutionTask): Promise<string[]> {
  const names: string[] = [];
  for (const file of (await readdir(path.join(task.dir, 'hidden'))).filter((name) => name.endsWith('.test.js'))) {
    for (const match of (await readFile(path.join(task.dir, 'hidden', file), 'utf8')).matchAll(/^test\((['"])(.+?)\1/gm)) names.push(match[2]);
  }
  return names;
}
