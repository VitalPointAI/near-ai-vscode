import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Execution tasks for the model benchmark: build or fix something in a small multi-file project
// from a plan, an issue report, or a spec, as GSD executors do. Each is scored by acceptance tests
// the model never sees, copied in only after it finishes, so partial work earns partial credit.
// Shared by the live eval (src/test/live.test.ts) and NEAR AI: Compare Models; the fixtures ship
// with the extension under resources/benchmark/execution.

export const EXECUTION_FIXTURES = path.join(__dirname, '..', '..', 'resources', 'benchmark', 'execution');
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

export async function loadExecutionTasks(fixtures = EXECUTION_FIXTURES): Promise<ExecutionTask[]> {
  const names = (await readdir(fixtures, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return Promise.all(names.map(async (name) => ({ name, dir: path.join(fixtures, name), ...JSON.parse(await readFile(path.join(fixtures, name, 'task.json'), 'utf8')) })));
}

/** Copies the task's starting project into `root`; `withReference` adds the reference solution on top, for checking the grader. */
export async function setUpExecutionTask(task: ExecutionTask, root: string, withReference = false): Promise<void> {
  await cp(path.join(task.dir, 'start'), root, { recursive: true });
  if (withReference) await cp(path.join(task.dir, 'reference'), root, { recursive: true });
}

/**
 * The Node.js that runs the tests. Inside VS Code the extension host is Electron, whose binary runs
 * as plain Node.js with ELECTRON_RUN_AS_NODE=1 (the `code` CLI does the same); child processes the
 * tests start inherit it, so `process.execPath` in a test file works too.
 */
export function nodeRuntime(): { command: string; env: Record<string, string> } {
  return { command: process.execPath, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

/** Without the parent test runner's context, under which a failing `node --test` exits 0. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...nodeRuntime().env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** Runs Node.js with `args` in `cwd` without blocking the caller; never rejects. */
export function runNode(args: string[], cwd: string, extraEnv: Record<string, string> = {}, timeoutMs = 120_000, signal?: AbortSignal): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(nodeRuntime().command, args, { cwd, env: cleanEnv(extraEnv), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) }, (error, stdout) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolve({ status: error ? (typeof code === 'number' ? code : null) : 0, stdout: stdout ?? '' });
    });
  });
}

export async function gradeExecution(task: ExecutionTask, root: string, signal?: AbortSignal): Promise<{ score: number; passed: number; total: number; misses: string[] }> {
  const total = (await hiddenTestNames(task)).length;
  for (const name of task.visibleTests) {
    const given = await readFile(path.join(task.dir, 'start', name), 'utf8');
    if (await readFile(path.join(root, name), 'utf8').catch(() => '') !== given) return { score: 0, passed: 0, total, misses: [`changed the given test ${name}`] };
  }
  const visible = await runNode(['--test', ...task.visibleTests], root, {}, 120_000, signal);
  if (visible.status !== 0) return { score: 0, passed: 0, total, misses: ['the given tests fail'] };
  const check = path.join(root, ACCEPTANCE_DIR);
  await mkdir(check, { recursive: true });
  await cp(path.join(task.dir, 'hidden'), check, { recursive: true });
  let passed = 0;
  const misses: string[] = [];
  for (const file of (await readdir(check)).filter((name) => name.endsWith('.test.js')).sort()) {
    // Run directly, not with --test, so each test() reports at the top level of the TAP output.
    const result = await runNode(['--test-reporter=tap', path.join(check, file)], root, task.hiddenEnv, 120_000, signal);
    for (const match of result.stdout.matchAll(/^(not )?ok \d+ - (.+)$/gm)) {
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

/** Every file of a task (prompt, starting project, hidden tests), for its version hash. */
export async function executionTaskFiles(task: ExecutionTask): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      else files[`${prefix}${entry.name}`] = await readFile(path.join(dir, entry.name), 'utf8');
    }
  };
  for (const part of ['start', 'hidden']) await walk(path.join(task.dir, part), `${part}/`);
  files['task.json'] = await readFile(path.join(task.dir, 'task.json'), 'utf8');
  return files;
}
