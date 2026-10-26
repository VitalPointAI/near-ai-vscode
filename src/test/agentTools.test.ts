import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { ShellSession } from '../agent/shell';
import { editTool, findRipgrep, globTool, grepTool, readTool, todoTool, writeTool, ToolContext, Todo } from '../agent/tools';

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
