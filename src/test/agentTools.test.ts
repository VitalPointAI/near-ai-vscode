import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { ShellSession } from '../agent/shell';
import { decidePermissionAsync, DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { editTool, findRipgrep, globTool, grepTool, killShellTool, parseRipgrepOutput, readTool, todoTool, writeTool, ToolContext, Todo } from '../agent/tools';

const VSCODE_APP_ROOT = '/snap/code/current/usr/share/code/resources/app';

async function project(): Promise<ToolContext & { todos: Todo[][] }> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-tools-'));
  await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'export const alpha = 1;\nexport const beta = 2;\nexport const alpha2 = alpha + 1;\n');
  await writeFile(path.join(root, 'src', 'nested', 'b.ts'), 'import { alpha } from "../a";\n');
  await writeFile(path.join(root, 'node_modules', 'dep', 'index.ts'), 'alpha');
  await writeFile(path.join(root, 'README.md'), '# Demo\n');
  const todos: Todo[][] = [];
  return { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('t'), shell: new ShellSession(root), readFiles: new Set(), onTodos: (list) => todos.push(list), todos };
}

test('Read numbers lines, pages long files, and refuses binaries and directories', async () => {
  const context = await project();
  assert.equal(await readTool.run(readTool.parse({ file_path: 'src/a.ts' }), context), '1\texport const alpha = 1;\n2\texport const beta = 2;\n3\texport const alpha2 = alpha + 1;');
  assert.match(await readTool.run(readTool.parse({ file_path: 'src/a.ts', offset: 2, limit: 1 }), context), /^2\texport const beta = 2;\n\n\[1 more lines\. Read again with offset 3/);
  await writeFile(path.join(context.root, 'bin.dat'), Buffer.from([1, 0, 2]));
  await assert.rejects(() => readTool.run(readTool.parse({ file_path: 'bin.dat' }), context), /binary/);
  await assert.rejects(() => readTool.run(readTool.parse({ file_path: 'src' }), context), /directory/);
});

test('Edit requires a prior Read, a unique match, and records a checkpoint', async () => {
  const context = await project();
  const file = path.join(context.root, 'src', 'a.ts');
  await assert.rejects(() => editTool.run(editTool.parse({ file_path: 'src/a.ts', old_string: 'beta = 2', new_string: 'beta = 3' }), context), /Read the file first/);
  await readTool.run(readTool.parse({ file_path: 'src/a.ts' }), context);
  await assert.rejects(() => editTool.run(editTool.parse({ file_path: 'src/a.ts', old_string: 'alpha', new_string: 'gamma' }), context), /appears 3 times/);
  await assert.rejects(() => editTool.run(editTool.parse({ file_path: 'src/a.ts', old_string: 'missing', new_string: 'x' }), context), /not found/);
  const preview = await editTool.preview!(editTool.parse({ file_path: 'src/a.ts', old_string: 'beta = 2', new_string: 'beta = 3' }), context);
  assert.equal(preview.kind === 'diff' && preview.diff.includes('-export const beta = 2;\n+export const beta = 3;'), true);
  await editTool.run(editTool.parse({ file_path: 'src/a.ts', old_string: 'beta = 2', new_string: 'beta = 3' }), context);
  assert.match(await readFile(file, 'utf8'), /beta = 3/);
  await editTool.run(editTool.parse({ file_path: 'src/a.ts', old_string: 'alpha', new_string: 'gamma', replace_all: true }), context);
  assert.equal((await readFile(file, 'utf8')).includes('alpha'), false);
  await context.checkpoints.revert();
  assert.match(await readFile(file, 'utf8'), /alpha = 1;\nexport const beta = 2;/);
});

test('Write creates new files freely but must Read an existing file before replacing it', async () => {
  const context = await project();
  assert.match(await writeTool.run(writeTool.parse({ file_path: 'src/new/c.ts', content: 'export {};\n' }), context), /Created src\/new\/c\.ts/);
  await assert.rejects(() => writeTool.run(writeTool.parse({ file_path: 'README.md', content: 'x' }), context), /Read the file first/);
  await assert.rejects(() => writeTool.run(writeTool.parse({ file_path: '../outside.txt', content: 'x' }), context), /outside the workspace/);
});

test('Glob finds files by pattern and skips node_modules unless asked', async () => {
  const context = await project();
  assert.deepEqual((await globTool.run(globTool.parse({ pattern: '**/*.ts' }), context)).split('\n').sort(), ['src/a.ts', 'src/nested/b.ts']);
  assert.equal(await globTool.run(globTool.parse({ pattern: 'node_modules/**/*.ts' }), context), 'node_modules/dep/index.ts');
  assert.equal(await globTool.run(globTool.parse({ pattern: '*.md', path: 'src' }), context), 'No files matched.');
});

for (const [label, ripgrepPath] of [['JS fallback', undefined], ['bundled ripgrep', findRipgrep(VSCODE_APP_ROOT, existsSync)]] as const) {
  test(`Grep (${label}) lists files, shows numbered lines, and counts`, { skip: label === 'bundled ripgrep' && !ripgrepPath ? 'VS Code ripgrep not installed here' : false }, async () => {
    const context = { ...(await project()), ripgrepPath };
    assert.deepEqual((await grepTool.run(grepTool.parse({ pattern: 'alpha' }), context)).split('\n').sort(), ['src/a.ts', 'src/nested/b.ts']);
    assert.equal(await grepTool.run(grepTool.parse({ pattern: 'beta', output_mode: 'content' }), context), 'src/a.ts:2:export const beta = 2;');
    assert.equal((await grepTool.run(grepTool.parse({ pattern: 'alpha', output_mode: 'count', glob: '*.ts', path: 'src/a.ts' }), context)).replace(/^.*a\.ts:/, ''), '2');
    assert.equal(await grepTool.run(grepTool.parse({ pattern: 'zzz' }), context), 'No matches.');
  });
}

test('TodoWrite validates the list and publishes it', async () => {
  const context = await project();
  await todoTool.run(todoTool.parse({ todos: [{ content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' }, { content: 'Ship', status: 'pending' }] }), context);
  assert.deepEqual(context.todos[0].map((todo) => todo.status), ['in_progress', 'pending']);
  assert.throws(() => todoTool.parse({ todos: [{ content: 'x', status: 'done' }] }), /status must be/);
});

test('Glob and Grep search a skipped folder only when a pattern names it as a whole path segment', async () => {
  const context = await project();
  for (const dir of ['routes', '.github', 'distance']) await mkdir(path.join(context.root, dir), { recursive: true });
  await writeFile(path.join(context.root, 'routes', 'r.ts'), 'alpha');
  await writeFile(path.join(context.root, '.github', 'ci.yml'), 'alpha');
  await writeFile(path.join(context.root, 'distance.ts'), 'alpha');
  await mkdir(path.join(context.root, '.git'), { recursive: true });
  await writeFile(path.join(context.root, '.git', 'ci.yml'), 'alpha');
  await mkdir(path.join(context.root, 'routes', 'out'), { recursive: true });
  await writeFile(path.join(context.root, 'routes', 'out', 'gen.ts'), 'alpha');
  // "routes" contains "out", ".github" contains ".git", "distance" contains "dist": none of them names a skipped folder.
  assert.deepEqual((await globTool.run(globTool.parse({ pattern: '**/routes/**' }), context)).split('\n'), ['routes/r.ts']);
  assert.equal(await globTool.run(globTool.parse({ pattern: '.github/**/*.yml' }), context), '.github/ci.yml');
  assert.equal(await globTool.run(globTool.parse({ pattern: '**/distance*' }), context), 'distance.ts');
  assert.equal(await globTool.run(globTool.parse({ pattern: '**/*.yml' }), context), '.github/ci.yml', '.git stays skipped');
  // Naming one skipped folder un-skips only that one.
  assert.deepEqual((await globTool.run(globTool.parse({ pattern: 'routes/out/**' }), context)).split('\n'), ['routes/out/gen.ts']);
  assert.equal(await globTool.run(globTool.parse({ pattern: 'node_modules/**/out/*.ts' }), context), 'No files matched.');
  assert.equal(await globTool.run(globTool.parse({ pattern: 'node_modules/**/*.ts' }), context), 'node_modules/dep/index.ts');
  assert.ok(!(await grepTool.run(grepTool.parse({ pattern: 'alpha', glob: '**/routes/**' }), context)).includes('node_modules'));
});

test('Edit matches multi-line text in a CRLF file and keeps its line endings', async () => {
  const context = await project();
  const file = path.join(context.root, 'win.ts');
  await writeFile(file, 'one\r\ntwo\r\nthree\r\n');
  await readTool.run(readTool.parse({ file_path: 'win.ts' }), context);
  await editTool.run(editTool.parse({ file_path: 'win.ts', old_string: 'one\ntwo', new_string: 'one\nTWO\nand a half' }), context);
  assert.equal(await readFile(file, 'utf8'), 'one\r\nTWO\r\nand a half\r\nthree\r\n');
  // A file with mixed endings still matches the text exactly as given.
  await writeFile(file, 'a\nb\r\nc\r\n');
  await editTool.run(editTool.parse({ file_path: 'win.ts', old_string: 'a\nb', new_string: 'A\nB' }), context);
  assert.equal(await readFile(file, 'utf8'), 'A\nB\r\nc\r\n');
  // An old_string that already carries \r\n still gets a CRLF new_string, so no LF lines are introduced into a CRLF file.
  await writeFile(file, 'one\r\ntwo\r\n');
  await editTool.run(editTool.parse({ file_path: 'win.ts', old_string: 'one\r\ntwo', new_string: 'uno\ndos' }), context);
  assert.equal(await readFile(file, 'utf8'), 'uno\r\ndos\r\n');
});

const systemRipgrep = ['/usr/bin/rg', '/usr/local/bin/rg', '/opt/homebrew/bin/rg'].find(existsSync);
for (const [label, ripgrepPath] of [['JS fallback', undefined], ['system ripgrep', systemRipgrep]] as const) {
  test(`Grep (${label}) hides context lines of credential files too`, { skip: label === 'system ripgrep' && !ripgrepPath ? 'ripgrep not installed here' : false }, async () => {
    const context = { ...(await project()), ripgrepPath };
    await writeFile(path.join(context.root, 'credentials.json'), 'token one\nNEEDLE\ntoken two\n');
    const output = await grepTool.run(grepTool.parse({ pattern: 'NEEDLE', output_mode: 'content', context: 1 }), context);
    assert.doesNotMatch(output, /token/);
    assert.match(output, /3 lines hidden/);
    assert.match(await grepTool.run(grepTool.parse({ pattern: 'beta', output_mode: 'content', context: 1 }), context), /^src\/a\.ts-1-export const alpha = 1;\nsrc\/a\.ts:2:export const beta = 2;/);
  });
}

test('ripgrep output is split at the NUL after each path, so a Windows drive letter is not taken for a separator', () => {
  const lines = parseRipgrepOutput('C:\\proj\\.env\x001-API=1\nC:\\proj\\.env\x002:NEEDLE=1\n--\nC:\\proj\\a.ts\x007:NEEDLE\n', 'content');
  assert.deepEqual(lines, [{ file: 'C:\\proj\\.env', text: '-1-API=1' }, { file: 'C:\\proj\\.env', text: ':2:NEEDLE=1' }, { text: '--' }, { file: 'C:\\proj\\a.ts', text: ':7:NEEDLE' }]);
  assert.deepEqual(parseRipgrepOutput('C:\\proj\\a.ts\x00C:\\proj\\.env\x00', 'files_with_matches').map((line) => line.file), ['C:\\proj\\a.ts', 'C:\\proj\\.env']);
  assert.deepEqual(parseRipgrepOutput('C:\\proj\\a.ts\x003\n', 'count'), [{ file: 'C:\\proj\\a.ts', text: ':3' }]);
});

test('KillShell stops only the run\'s own jobs, so it runs without asking in every mode', async () => {
  for (const mode of ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'] as const) {
    const decided = await decidePermissionAsync(killShellTool.capability, undefined, { mode, emergencyStop: false }, DEFAULT_RULES, new RunGrants());
    assert.equal(decided.decision, 'allow', mode);
  }
});

test('a shell that exits while a process it started holds the output open says later output was not captured', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-shell-held-'));
  const shell = new ShellSession(root);
  try {
    const started = Date.now();
    const exited = await shell.run('echo before; (sleep 5; echo late) & exit 2', 60_000);
    assert.ok(Date.now() - started < 4_000, 'it ended on the drain cap, not when the background process finished');
    assert.equal(exited.exitCode, 2);
    assert.match(exited.output, /before[\s\S]*ended the shell with exit code 2[\s\S]*later output was not captured/);
    assert.doesNotMatch(exited.output, /late\n/);
  } finally {
    shell.dispose();
  }
});

test('a command that ends the shell finishes at once, and the next command gets a fresh shell', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-shell-exit-'));
  const shell = new ShellSession(root);
  try {
    await shell.run('cd /; export KEPT=1');
    const started = Date.now();
    const exited = await shell.run('echo before; exit 3', 60_000);
    assert.ok(Date.now() - started < 10_000, 'it did not wait for the timeout');
    assert.equal(exited.exitCode, 3);
    assert.equal(exited.timedOut, false);
    assert.match(exited.output, /before[\s\S]*ended the shell with exit code 3/);
    assert.doesNotMatch(exited.output, /not captured/, 'the output closed with the shell, so nothing was lost');
    const next = await shell.run('echo "again:${KEPT:-unset}"; pwd');
    assert.equal(next.exitCode, 0);
    assert.match(next.output, /again:unset/);
    assert.equal(path.resolve(next.cwd), path.resolve(root), 'the earlier cd / was reset too, as the message says: the fresh shell starts in the workspace');
    // A large burst printed just before exit is kept whole, not cut off when the shell ends.
    const burst = await shell.run('seq 1 20000; exit 4', 60_000);
    assert.equal(burst.exitCode, 4);
    assert.match(burst.output, /\b20000\b[\s\S]*ended the shell/);
    const failed = await shell.run('set -e; false; echo unreachable', 60_000);
    assert.equal(failed.exitCode, 1);
    assert.doesNotMatch(failed.output, /unreachable/);
    // set -e from a command that succeeded does not stay on and end the shell on the next failure.
    await shell.run('set -e; export STAYS=1');
    const afterSetE = await shell.run('false; echo "still:$STAYS"', 60_000);
    assert.match(afterSetE.output, /still:1/);
  } finally {
    shell.dispose();
  }
});

test('a missing bash fails only the shell, when it is first used', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    const shell = new ShellSession(tmpdir());
    await assert.rejects(() => shell.run('echo hi'), /needs bash/);
    assert.throws(() => shell.startBackground('echo hi'), /needs bash/);
    shell.dispose();
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('temporary checkpoint files left by a cut-off save are deleted for that run, but not fresh ones or other runs\' ones', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-ckpt-tmp-'));
  const storage = path.join(root, 'store');
  await mkdir(storage, { recursive: true });
  const old = new Date(Date.now() - 10 * 60_000);
  const stale = async (name: string) => { await writeFile(path.join(storage, name), '[]'); await utimes(path.join(storage, name), old, old); };
  await writeFile(path.join(storage, 'r1.json'), '[]');
  await stale('.r1.0badf00d.tmp');
  await stale('.r2.0badf00d.tmp');
  await stale('.r1.notes.tmp');
  await writeFile(path.join(storage, '.r1.cafe0001.tmp'), '[]');
  assert.ok(await RunCheckpoints.load('r1', storage));
  assert.deepEqual((await readdir(storage)).sort(), ['.r1.cafe0001.tmp', '.r1.notes.tmp', '.r2.0badf00d.tmp', 'r1.json']);
  // The first save of a run sweeps too, so a run that resumes under its id does not keep the leftovers.
  const file = path.join(root, 'a.txt');
  await writeFile(file, 'a');
  await new RunCheckpoints('r2', storage).capture(file);
  assert.deepEqual((await readdir(storage)).sort(), ['.r1.cafe0001.tmp', '.r1.notes.tmp', 'r1.json', 'r2.json']);
});

test('checkpoints captured in parallel are all saved, one complete file at a time', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-ckpt-'));
  const storage = path.join(root, 'store');
  const checkpoints = new RunCheckpoints('parallel', storage);
  const files = Array.from({ length: 40 }, (_, index) => path.join(root, `f${index}.txt`));
  await Promise.all(files.map(async (file, index) => { await writeFile(file, `content ${index} `.repeat(2_000)); await checkpoints.capture(file); }));
  const loaded = await RunCheckpoints.load('parallel', storage);
  assert.deepEqual(loaded?.changedFiles.sort(), [...files].sort());
  assert.deepEqual(await readdir(storage), ['parallel.json'], 'no temporary file is left behind');
  await checkpoints.revert();
  assert.deepEqual(await readdir(storage), []);
});
