// REVIEW BLOCKER 1 (agent boundary) and the minor on commandSafety.ts: one shared rule makes every agent write to the state folder, the locks
// folder or a *.git folder ask, and every read of the state folder's keys ask, in the file tools and in the shell guard alike.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { classifyCommand, CommandContext } from '../agent/commandSafety';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentRun } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { bashTool, editTool, globTool, grepTool, isSensitivePath, isStateKeysPath, protectedWrite, readTool, scriptNamingStateKeys, ToolContext, writeTool } from '../agent/tools';
import { resolveInWorkspace } from '../agent/workspace';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import { namesStateKeys, PROTECTED_WRITE, protectedWriteReason, STATE_FOLDER_PATH, STATE_FOLDER_TEXT } from '../domain/protectedPaths';
import { ShellSession } from '../agent/shell';

const shellContext: CommandContext = { root: '/work/app', cwd: '/work/app', home: '/home/dev' };

async function project(): Promise<ToolContext> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-protected-'));
  return { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('p'), shell: new ShellSession(root), readFiles: new Set() };
}

test('file tools: a write into the state folder, the locks folder, a *.git folder or .git asks, even with edits allowed for the run', async () => {
  const context = await project();
  for (const asked of [
    '.near-ai/state/meta.json', '.near-ai/state/keys/local.key', '.near-ai/state/sync/hooks/pre-push', '.near-ai/locks/meta.lock',
    'vendor/mirror.git/config', '.git/hooks/pre-commit', '.near-ai/state.previous-20261113T120000000Z-ab12/keys/recovery.json', '.near-ai/scratch/../state/meta.json'
  ]) {
    assert.match(String(await protectedWrite(asked, context)), /Approve this write only if you expect it/, `${asked} should ask`);
  }
  for (const quiet of ['.near-ai/scratch/check.py', '.near-ai/attachments/a.png', '.github/workflows/ci.yml', '.gitignore', 'src/app.ts', '.gitattributes']) {
    assert.equal(await protectedWrite(quiet, context), undefined, `${quiet} should not ask`);
  }
});

test('the sentences: .git and .planning/.near-ai keep their wording, .near-ai and a *.git folder get their own', () => {
  assert.equal(protectedWriteReason('.git/config'), '.git/config is inside .git, where hooks and config run code on the next git command. Approve this write only if you expect it.');
  assert.equal(protectedWriteReason('.planning/.near-ai/x.json'), ".planning/.near-ai/x.json is inside .planning/.near-ai, which holds this project's NEAR AI settings. Approve this write only if you expect it.");
  assert.equal(protectedWriteReason('.near-ai/state/meta.json'), ".near-ai/state/meta.json is inside .near-ai, where NEAR AI keeps this project's saved state, keys and locks. Approve this write only if you expect it.");
  assert.match(String(protectedWriteReason('vendor/mirror.git/config')), /is inside mirror\.git, where hooks and config run code/);
  assert.equal(protectedWriteReason('src/app.ts'), undefined);
  assert.equal(PROTECTED_WRITE.test('.near-ai/scratch/x.py'), false);
  assert.equal(PROTECTED_WRITE.test('.near-ai/scratch-other/x'), true, 'a sibling that only shares the prefix is not the scratch folder');
});

test('reads: the state folder, its previous copies and its keys are sensitive; a similar name is not', async () => {
  for (const file of ['.near-ai/state/keys/recovery.json', '.near-ai/state/keys/api/p.enc', '.near-ai/state/threads/x/log.jsonl', '.near-ai/state.previous-20261113T120000000Z-ab12/keys/recovery.json', '.near-ai/state', '/work/app/.near-ai/state/keys/local.key']) {
    assert.equal(isSensitivePath(file), true, `${file} is sensitive`);
  }
  assert.equal(isSensitivePath('.near-ai/statement.md'), false);
  assert.equal(isSensitivePath('.near-ai/scratch/state.txt'), false);
  assert.equal(STATE_FOLDER_PATH.test('.near-ai/statement.md'), false);
  assert.equal(STATE_FOLDER_TEXT.test('cat .near-ai/statement.md'), false);

  const context = await project();
  const asked = await readTool.sensitive?.(readTool.parse({ file_path: '.near-ai/state/keys/recovery.json' }), context);
  assert.match(String(asked), /looks like it may contain credentials/);
});

test('Grep over the project leaves out the state folder\'s keys unless the search was aimed at them', async () => {
  const context = await project();
  await mkdir(path.join(context.root, '.near-ai', 'state', 'keys'), { recursive: true });
  await mkdir(path.join(context.root, 'src'), { recursive: true });
  await writeFile(path.join(context.root, '.near-ai', 'state', 'keys', 'recovery.json'), '{"code":"needle-secret"}');
  await writeFile(path.join(context.root, 'src', 'a.ts'), 'const needle = 1;\n');
  const wide = await grepTool.run(grepTool.parse({ pattern: 'needle', output_mode: 'content' }), context);
  assert.match(wide, /src\/a\.ts/);
  assert.doesNotMatch(wide, /recovery\.json|needle-secret/);
  // 0.4.23: a search aimed at the state folder includes its other files, but never the key folder.
  await mkdir(path.join(context.root, '.near-ai', 'state', 'threads'), { recursive: true });
  await writeFile(path.join(context.root, '.near-ai', 'state', 'threads', 'x.json'), '{"note":"needle-thread"}');
  const aimed = await grepTool.run(grepTool.parse({ pattern: 'needle', path: '.near-ai/state', output_mode: 'content' }), context);
  assert.match(aimed, /needle-thread/);
  assert.doesNotMatch(aimed, /needle-secret|recovery\.json/);
  assert.match(String(await grepTool.sensitive?.(grepTool.parse({ pattern: 'needle', path: '.near-ai/state' }), context)), /may contain credentials/);
});

test('shell guard: commands that write the state folder, a *.git folder or read the keys are risky; scratch work and ordinary commands are not', () => {
  const risky = [
    'echo x > .near-ai/state/meta.json', 'cp evil .near-ai/state/keys/local.key', 'mkdir -p .near-ai/state/sync/hooks', 'grep -r token .near-ai/state',
    'cat .near-ai/state/keys/recovery.json', 'tar czf out.tgz .near-ai/state', 'touch .near-ai/locks/meta.lock', 'cp x vendor/mirror.git/config',
    'cat .near-ai/state.previous-20261113T120000000Z-ab12/keys/recovery.json', 'echo x > .near-ai/hooks/pre-push'
  ];
  const wrong = risky.map((command) => ({ command, result: classifyCommand(command, shellContext) })).filter(({ result }) => result.verdict !== 'risky');
  assert.deepEqual(wrong.map(({ command, result }) => `${command} -> ${result.verdict} (${result.reason})`), []);
  for (const command of ['python3 .near-ai/scratch/verify.py', 'ls src', 'cat .near-ai/statement.md', 'touch .near-ai/scratch/a.txt', 'cp a.png .near-ai/attachments/a.png']) {
    assert.notEqual(classifyCommand(command, shellContext).verdict, 'risky', `${command} should not be held`);
  }
});

// 0.4.23: the key folder is off limits to agents. A real run wrote a Node script that read .near-ai/state/keys/local.key and decrypted the project's
// own chats. Direct references (file tools, a command line) are refused in every mode; a script the command runs that names the folder asks.

test('the key folder rule: paths and text that name it, and similar names that do not', () => {
  for (const file of ['.near-ai/state/keys', '.near-ai/state/keys/local.key', '/work/app/.near-ai/state/keys/api/p.enc', '.near-ai/state.previous-20261113T120000000Z-ab12/keys/recovery.json', '.near-ai/state.adopt-x/keys/local.key', 'sub\\.near-ai\\state\\keys\\local.key', '.near-ai/scratch/../state/keys/local.key']) {
    assert.equal(isStateKeysPath(file), true, `${file} is in the key folder`);
  }
  for (const file of ['.near-ai/state/meta.json', '.near-ai/state/threads/keys/x', '.near-ai/statekeys', '.near-ai/state/keys.json', 'src/keys/local.key', '.near-ai/scratch/keys/a']) {
    assert.equal(isStateKeysPath(file), false, `${file} is not`);
  }
  for (const text of [
    "cat .near-ai/state/keys/local.key", "node -e \"require('fs').readFileSync('.near-ai/state/keys/local.key')\"",
    "const key = fs.readFileSync(path.join(root, '.near-ai', 'state', 'keys', 'local.key'));", "open('.near-ai/' + 'state/keys/recovery.json')",
    'cd .near-ai && cat state/keys/local.key', 'ls .near-ai/state/k*', 'cat .near-ai/*/keys/*', 'xxd .near-ai/state.previous-1/keys/local.key', 'base64 < .near-ai\\state\\keys\\local.key'
  ]) {
    assert.equal(namesStateKeys(text), true, `${text} names the key folder`);
  }
  for (const text of ['python3 .near-ai/scratch/verify.py', 'node -e "console.log(Object.keys(require(\'./.near-ai/scratch/x.json\')))"', 'cat .near-ai/state/meta.json', 'ls src/keys', 'grep keys README.md', 'cat .near-ai/statement.md']) {
    assert.equal(namesStateKeys(text), false, `${text} does not`);
  }
});

test('file tools refuse the key folder in every mode, by path, through a link, and leave it out of Glob and Grep', async () => {
  const context = await project();
  const keys = path.join(context.root, '.near-ai', 'state', 'keys');
  await mkdir(keys, { recursive: true });
  await writeFile(path.join(keys, 'local.key'), 'secret-key-bytes');
  for (const [tool, raw] of [
    [readTool, { file_path: '.near-ai/state/keys/local.key' }],
    [readTool, { file_path: path.join(keys, 'local.key') }],
    [writeTool, { file_path: '.near-ai/state/keys/local.key', content: 'planted' }],
    [editTool, { file_path: '.near-ai/state/keys/local.key', old_string: 'secret', new_string: 'x' }],
    [globTool, { pattern: '**/*', path: '.near-ai/state/keys' }],
    [globTool, { pattern: '.near-ai/state/keys/*' }],
    [grepTool, { pattern: 'secret', path: '.near-ai/state/keys' }]
  ] as const) {
    const reason = await (tool as typeof readTool).forbidden?.((tool as typeof readTool).parse(raw as never), context);
    assert.match(String(reason), /names the project's key folder/, `${tool.name} ${JSON.stringify(raw)} is refused`);
  }
  // A link elsewhere in the project that points into the key folder is refused too, and so is any path that resolves there.
  await symlink(keys, path.join(context.root, 'innocent'));
  assert.match(String(await readTool.forbidden?.(readTool.parse({ file_path: 'innocent/local.key' }), context)), /names the project's key folder/);
  await assert.rejects(resolveInWorkspace(context.root, 'innocent/local.key'), /names the project's key folder/, 'every file tool resolves through this check');
  // Ordinary files are not refused.
  assert.equal(await readTool.forbidden?.(readTool.parse({ file_path: '.near-ai/state/meta.json' }), context), undefined);
  assert.equal(await readTool.forbidden?.(readTool.parse({ file_path: 'src/app.ts' }), context), undefined);
  // A wide Glob never lists the key folder.
  const listed = await globTool.run(globTool.parse({ pattern: '**/*.key' }), context);
  assert.doesNotMatch(listed, /local\.key/);
});

/** A model that makes the given tool calls one per turn, then stops; returns what each call answered. */
async function runCalls(context: ToolContext, calls: Array<{ name: string; args: Record<string, unknown> }>, mode: 'fully-autonomous' | 'auto' | 'approve-risky', approvals: string[] = []): Promise<string[]> {
  let turn = 0;
  const client = {
    async *streamCompletion(_model: string, _messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
      const next = calls[turn];
      turn += 1;
      if (!next) { yield { type: 'done', message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage }; return; }
      const call: ToolCall = { id: `c${turn}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } };
      yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call] }, finishReason: 'tool_calls', usage };
    }
  };
  const run = new AgentRun({
    client: client as never, model: 'm', tools: [readTool, writeTool, editTool, globTool, grepTool, bashTool], context, policy: { mode, emergencyStop: false }, rules: DEFAULT_RULES,
    requestApproval: async (approval: { title: string; reason?: string }) => { approvals.push(`${approval.title}: ${approval.reason ?? ''}`); return { decision: 'deny' }; },
    emit: () => undefined
  } as never);
  const result = await run.run([{ role: 'system', content: 's' }, { role: 'user', content: 'go' }], new AbortController().signal);
  return result.messages.filter((message) => message.role === 'tool').map((message) => String(message.content));
}

test('the real-world pattern: a script that reads keys/local.key, written with Write and run with node, never reads the key (0.4.23)', async () => {
  const context = await project();
  const keys = path.join(context.root, '.near-ai', 'state', 'keys');
  await mkdir(keys, { recursive: true });
  await writeFile(path.join(keys, 'local.key'), 'secret-key-bytes');
  const script = "const fs = require('fs');\nprocess.stdout.write(fs.readFileSync('.near-ai/state/keys/local.key', 'utf8'));\n";
  const approvals: string[] = [];
  try {
    const results = await runCalls(context, [
      // Writing the script is allowed: it is text, and a file may name the folder for honest reasons.
      { name: 'Write', args: { file_path: '.near-ai/scratch/peek.cjs', content: script } },
      // Running it asks, in fully-autonomous mode too, and here the person says no.
      { name: 'Bash', args: { command: 'node .near-ai/scratch/peek.cjs' } },
      // The same read on the command line is refused outright, with no card.
      { name: 'Bash', args: { command: "node -e \"process.stdout.write(require('fs').readFileSync('.near-ai/state/keys/local.key','utf8'))\"" } },
      { name: 'Bash', args: { command: 'cat .near-ai/state/keys/local.key' } },
      { name: 'Read', args: { file_path: '.near-ai/state/keys/local.key' } }
    ], 'fully-autonomous', approvals);
    assert.match(results[0], /Created \.near-ai\/scratch\/peek\.cjs/);
    assert.equal(await readFile(path.join(context.root, '.near-ai', 'scratch', 'peek.cjs'), 'utf8'), script);
    assert.match(results[1], /declined/, 'the script run asked and was declined');
    assert.equal(approvals.length, 1, `only the script run asked: ${approvals.join(' | ')}`);
    assert.match(approvals[0], /runs \.near-ai\/scratch\/peek\.cjs, which names the project's key folder/);
    for (const refused of results.slice(2)) assert.match(refused, /^Not allowed: .*names the project's key folder/);
    assert.equal(results.some((text) => text.includes('secret-key-bytes')), false, 'the key never reached the model');
  } finally {
    context.shell.dispose();
  }
  // The scan sees only files named on the command line.
  const other = await project();
  try {
    await mkdir(path.join(other.root, 'tools'), { recursive: true });
    await writeFile(path.join(other.root, 'tools', 'k.py'), "open('/x/.near-ai/state/keys/local.key').read()\n");
    await writeFile(path.join(other.root, 'tools', 'ok.py'), "print('hello')\n");
    assert.equal(await scriptNamingStateKeys('python3 tools/k.py --verbose', other), 'tools/k.py');
    assert.equal(await scriptNamingStateKeys('python3 tools/ok.py', other), undefined);
    assert.equal(await scriptNamingStateKeys('npm test', other), undefined, 'a script npm runs is not seen: a documented limit');
  } finally {
    other.shell.dispose();
  }
});

test('Auto mode: a command naming the key folder is refused without a card, even one the rules would allow', async () => {
  const context = await project();
  const approvals: string[] = [];
  try {
    const results = await runCalls(context, [{ name: 'Bash', args: { command: 'ls .near-ai/state/keys' } }, { name: 'Bash', args: { command: 'ls src' } }], 'auto', approvals);
    assert.match(results[0], /^Not allowed: ls \.near-ai\/state\/keys names the project's key folder/);
    assert.doesNotMatch(results[1], /Not allowed/);
    assert.equal(approvals.some((text) => /keys/.test(text)), false);
  } finally {
    context.shell.dispose();
  }
});

// PR 51 review: the persistent shell keeps its folder between commands, so the key folder could be reached from a folder the line does not name.
test('the shell guard follows the shell\'s folder: words that resolve into the key folder from there are refused, and so is the folder itself', async () => {
  const context = await project();
  const keys = path.join(context.root, '.near-ai', 'state', 'keys');
  await mkdir(keys, { recursive: true });
  await writeFile(path.join(keys, 'local.key'), 'secret-key-bytes');
  await writeFile(path.join(context.root, '.near-ai', 'state', 'meta.json'), '{}');
  const forbidden = (command: string) => bashTool.forbidden?.(bashTool.parse({ command }), context);
  try {
    // From the state folder: `cat keys/local.key` and `cat keys/*` name no .near-ai, but resolve into the key folder.
    assert.equal(await forbidden('cd .near-ai/state'), undefined, 'the state folder itself is not the key folder');
    await context.shell.run('cd .near-ai/state', 5_000);
    for (const command of ['cat keys/local.key', 'cat keys/*', 'ls keys', 'cat k*/local.key', 'cat ./keys/../keys/local.key', 'cat {keys,x}/local.key', 'cd keys', 'pushd keys', 'cat */local.key', 'xxd "keys/local.key"']) {
      assert.match(String(await forbidden(command)), /names the project's key folder/, `${command} from .near-ai/state is refused`);
    }
    for (const command of ['cat meta.json', 'ls', 'ls threads', 'cat ../../README.md']) assert.equal(await forbidden(command), undefined, `${command} from .near-ai/state is allowed`);
    // From .near-ai: `cat state/keys/*` and a glob over the state folder's subfolders.
    await context.shell.run('cd ..', 5_000);
    for (const command of ['cat state/keys/*', 'cat state/*/local.key', 'cat */keys/local.key', 'ls state/keys']) {
      assert.match(String(await forbidden(command)), /names the project's key folder/, `${command} from .near-ai is refused`);
    }
    assert.equal(await forbidden('cat state/meta.json'), undefined);
    // From the root: a `cd` earlier in the same line moves the words after it.
    await context.shell.run(`cd ${JSON.stringify(context.root)}`, 5_000);
    for (const command of ['cd .near-ai/state && cat keys/*', 'cd .near-ai; cd state; ls keys', 'pushd .near-ai/state >/dev/null && xxd keys/local.key']) {
      assert.match(String(await forbidden(command)), /names the project's key folder/, `${command} is refused`);
    }
    for (const command of ['cd src && ls keys', 'ls keys', 'cat *', 'ls -la']) assert.equal(await forbidden(command), undefined, `${command} from the root is allowed`);
    // A link to the key folder, reached from the shell's folder.
    await symlink(path.join(context.root, '.near-ai', 'state', 'keys'), path.join(context.root, '.near-ai', 'state', 'shortcut'));
    await context.shell.run('cd .near-ai/state', 5_000);
    assert.match(String(await forbidden('cat shortcut/local.key')), /names the project's key folder/);
    // A shell already inside the key folder (reached some way the check did not see) runs nothing there but a cd out.
    await context.shell.run('cd "$(printf "%s" ke)ys"', 5_000);
    assert.equal(path.basename(context.shell.workingDirectory), 'keys');
    for (const command of ['ls', 'cat local.key', 'cd .', 'cd ../keys', 'cd .. && cat local.key', 'echo hi']) {
      assert.match(String(await forbidden(command)), /current folder, \.near-ai\/state\/keys, is inside the project's key folder/, `${command} inside the key folder is refused`);
    }
    assert.equal(await forbidden('cd ..'), undefined, 'a lone cd out is allowed');
    assert.equal(await forbidden(`cd "${context.root}"`), undefined);
  } finally {
    context.shell.dispose();
  }
});

test('the shell guard, end to end: cd into the state folder, then reading keys/local.key is refused in fully-autonomous mode', async () => {
  const context = await project();
  const keys = path.join(context.root, '.near-ai', 'state', 'keys');
  await mkdir(keys, { recursive: true });
  await writeFile(path.join(keys, 'local.key'), 'secret-key-bytes');
  const approvals: string[] = [];
  try {
    const results = await runCalls(context, [
      { name: 'Bash', args: { command: 'cd .near-ai/state' } },
      { name: 'Bash', args: { command: 'cat keys/local.key' } },
      { name: 'Bash', args: { command: 'cat keys/*' } },
      { name: 'Bash', args: { command: 'cd keys' } }
    ], 'fully-autonomous', approvals);
    assert.doesNotMatch(results[0], /Not allowed/);
    for (const refused of results.slice(1)) assert.match(refused, /^Not allowed: .*names the project's key folder/);
    assert.equal(results.some((text) => text.includes('secret-key-bytes')), false, 'the key never reached the model');
    assert.equal(approvals.length, 0);
  } finally {
    context.shell.dispose();
  }
});

test('the script scan reports a word that resolves into the key folder instead of passing over it', async () => {
  const context = await project();
  const keys = path.join(context.root, '.near-ai', 'state', 'keys');
  await mkdir(keys, { recursive: true });
  await writeFile(path.join(keys, 'local.key'), 'secret-key-bytes');
  await symlink(keys, path.join(context.root, 'innocent'));
  try {
    assert.equal(await scriptNamingStateKeys('node innocent/local.key', context), 'innocent/local.key');
  } finally {
    context.shell.dispose();
  }
});
