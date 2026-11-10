import assert from 'node:assert/strict';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AutoApprovalContext, decidePermissionAsync, DEFAULT_RULES, PermissionRules, RunGrants } from '../agent/permissions';
import { forbiddenScriptContent, scriptInvocation, scriptsNamedIn, unattendedDecision } from '../agent/unattended';
import type { ActionPolicyMode } from '../domain/policy';

// PERF-01: a sub-agent nobody watches runs its own safe and verification commands without a card, and nothing that the approval policy promises will ask
// (a push, a delete outside the project, publishing, the network, a credential path) is ever let through by it.

const RULES: PermissionRules = { allowCommands: [], denyCommands: DEFAULT_RULES.denyCommands };

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-unattended-'));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'tsc --noEmit' } }));
  await writeFile(path.join(root, 'a.md'), 'a');
  await writeFile(path.join(root, 'scripts', 'verify.sh'), '#!/usr/bin/env bash\nset -euo pipefail\ngrep -c "cite" report.md\ntest -f report.md\necho ok\n');
  await writeFile(path.join(root, 'scripts', 'check-citations.mjs'), "import { readFileSync } from 'node:fs';\nconst text = readFileSync('report.md', 'utf8');\nif (!text.includes('[^1]')) process.exitCode = 1;\n");
  await writeFile(path.join(root, 'scripts', 'build-report.sh'), '#!/bin/sh\necho building\n');
  const bad: Record<string, string> = {
    'verify-curl.sh': 'curl -s https://example.test/x\n',
    'verify-rm.sh': 'rm -rf build\n',
    'check-spawn.mjs': "import { execSync } from 'node:child_process';\nexecSync('ls');\n",
    'gate-push.sh': 'git push origin main\n',
    'check-keys.py': "open('/home/someone/.ssh/id_rsa').read()\n",
    'check-outside.mjs': "import { readFileSync } from 'node:fs';\nreadFileSync('/etc/passwd', 'utf8');\n",
    'lint-env.mjs': 'console.log(process.env.GITHUB_TOKEN);\n',
    'check-fetch.mjs': "await fetch('http://169.254.169.254/');\n",
    'verify-source.sh': 'echo start\nsource helpers.sh\n',
    'gate-dot.sh': '. ./helpers.sh\n'
  };
  for (const [name, text] of Object.entries(bad)) await writeFile(path.join(root, 'scripts', name), text);
  return root;
}

async function decide(root: string, command: string, options: { mode?: ActionPolicyMode; unattended?: boolean; tainted?: boolean; planScripts?: string[]; runStartedAt?: number; taintedAt?: number } = {}) {
  const grants = new RunGrants();
  grants.tainted = options.tainted === true;
  const auto: AutoApprovalContext = { root, cwd: root, home: homedir(), packageScripts: { test: 'node --test', lint: 'tsc --noEmit' }, ...(options.unattended === false ? {} : { unattended: { planScripts: options.planScripts ?? [], runStartedAt: options.runStartedAt ?? 0, ...(options.taintedAt !== undefined ? { taintedAt: options.taintedAt } : {}) } }) };
  return decidePermissionAsync('shell', command, { mode: options.mode ?? 'mostly-autonomous', emergencyStop: false }, RULES, grants, auto);
}

test('an unattended sub-agent runs tests, type checks, read-only git and writes inside its own folder without a card', async () => {
  const root = await project();
  for (const command of ['npm test', 'npm run lint', 'npx tsc --noEmit', 'git status', 'git log --oneline -5', 'git diff --stat', 'git show HEAD', 'mkdir -p out && cp a.md out/b.md', 'git add -A && git commit -m "feat: x"', 'grep -rn cite .']) {
    for (const mode of ['mostly-autonomous', 'auto'] as const) {
      const decided = await decide(root, command, { mode });
      assert.equal(decided.decision, 'allow', `${mode}: ${command} → ${JSON.stringify(decided)}`);
    }
  }
});

test('an unattended sub-agent runs clean verification scripts inside the project, and ones the plan names', async () => {
  const root = await project();
  for (const command of ['bash scripts/verify.sh', 'node scripts/check-citations.mjs', `cd ${root} && bash scripts/verify.sh`, './scripts/verify.sh']) {
    assert.equal((await decide(root, command)).decision, 'allow', command);
  }
  assert.equal((await decide(root, 'bash scripts/build-report.sh')).decision, 'ask', 'a script not named like a check asks');
  assert.equal((await decide(root, 'bash scripts/build-report.sh', { planScripts: ['scripts/build-report.sh'] })).decision, 'allow', 'unless the plan names it');
});

test('a push, a delete outside the project, publishing, the network and credential paths still ask', async () => {
  const root = await project();
  const stillAsk = [
    'git push', 'git push origin main', 'rm -rf /home/someone/other-project', 'rm -rf ../other', 'npm publish', 'npx vsce publish', 'gh release create v1',
    'cat ~/.ssh/id_rsa', 'cat ~/.near-credentials/mainnet/owner.near.json', 'cp ~/.aws/credentials notes.md', 'curl -s https://example.test', 'wget https://example.test/x',
    'node -e "require(\'child_process\').execSync(\'ls\')"', 'bash -c "git push"'
  ];
  for (const mode of ['mostly-autonomous', 'auto'] as const) {
    for (const command of stillAsk) {
      const decided = await decide(root, command, { mode });
      assert.notEqual(decided.decision, 'allow', `${mode}: ${command} must not run unattended (${JSON.stringify(decided)})`);
    }
  }
});

test('a verification script that reaches the network, deletes, publishes, spawns, or touches credentials or outside paths still asks', async () => {
  const root = await project();
  for (const name of ['verify-curl.sh', 'verify-rm.sh', 'check-spawn.mjs', 'gate-push.sh', 'check-keys.py', 'check-outside.mjs', 'lint-env.mjs', 'check-fetch.mjs', 'verify-source.sh', 'gate-dot.sh']) {
    const command = name.endsWith('.py') ? `python3 scripts/${name}` : name.endsWith('.sh') ? `bash scripts/${name}` : `node scripts/${name}`;
    const verdict = await unattendedDecision(command, { root, cwd: root, home: homedir() }, false);
    assert.equal(verdict.allow, false, `${name}: ${verdict.reason}`);
    assert.notEqual((await decide(root, command)).decision, 'allow', name);
  }
});

test('a script outside the project, or one this run wrote after reading outside content, still asks', async () => {
  const root = await project();
  const outside = await mkdtemp(path.join(tmpdir(), 'near-ai-unattended-outside-'));
  await writeFile(path.join(outside, 'verify.sh'), 'echo ok\n');
  assert.notEqual((await decide(root, `bash ${path.join(outside, 'verify.sh')}`)).decision, 'allow');
  const startedAt = Date.now() - 60_000;
  await utimes(path.join(root, 'scripts', 'verify.sh'), new Date(), new Date());
  assert.notEqual((await decide(root, 'bash scripts/verify.sh', { tainted: true, runStartedAt: startedAt })).decision, 'allow', 'written this run after outside content');
  assert.equal((await decide(root, 'bash scripts/verify.sh', { tainted: false, runStartedAt: startedAt })).decision, 'allow', 'written this run, no outside content');
});

test('Ask before edits, the main run, the deny list and the emergency stop are unchanged', async () => {
  const root = await project();
  assert.equal((await decide(root, 'npm test', { mode: 'approve-risky' })).decision, 'ask', 'approve-risky asks for every command');
  assert.equal((await decide(root, 'bash scripts/verify.sh', { mode: 'approve-risky' })).decision, 'ask');
  assert.equal((await decide(root, 'npm test', { unattended: false })).decision, 'ask', 'the main run in mostly-autonomous still asks');
  assert.equal((await decide(root, 'rm -rf / && npm test')).decision, 'deny', 'the deny list refuses first');
  const grants = new RunGrants();
  const stopped = await decidePermissionAsync('shell', 'npm test', { mode: 'mostly-autonomous', emergencyStop: true }, RULES, grants, { root, cwd: root, unattended: {} });
  assert.equal(stopped.decision, 'deny');
});

test('script invocations, forbidden content and plan-named scripts are parsed conservatively', () => {
  assert.deepEqual(scriptInvocation('bash scripts/verify.sh --quick', '/p'), { script: '/p/scripts/verify.sh', cwd: '/p', args: ['--quick'] });
  assert.equal(scriptInvocation('node -e "x"', '/p'), undefined);
  assert.equal(scriptInvocation('bash scripts/verify.sh; rm x', '/p'), undefined);
  assert.equal(scriptInvocation('node $(echo x).mjs', '/p'), undefined);
  assert.equal(forbiddenScriptContent('#!/usr/bin/env node\nconsole.log(1)\n', '/p'), undefined);
  assert.match(String(forbiddenScriptContent("readFileSync('../secret')", '/p')), /above its own folder/);
  assert.match(String(forbiddenScriptContent('cat /var/log/x', '/p')), /outside the project/);
  assert.deepEqual(scriptsNamedIn('Run `scripts/verify-gates.sh` then node scripts/figures.mjs and ../evil.sh'), ['scripts/verify-gates.sh', 'scripts/figures.mjs']);
});

// Agent review of PR 34 (blocker): the check follows everything a script can run, not only the entry file.
test('the whole import closure is checked: changed scaffold helpers, new imports, dynamic and non-relative loads, cycles and invoked scripts ask', async () => {
  const { applyResearchProfile } = await import('../gsd/researchProfile');
  const root = await project();
  await applyResearchProfile(root);
  const run = async (command: string, options: { tainted?: boolean; runStartedAt?: number } = {}) => (await decide(root, command, options)).decision;
  assert.equal(await run('node scripts/verify/verify-all.mjs'), 'allow', 'an untouched scaffold still runs by itself');
  assert.equal(await run('node scripts/verify/check-citations.mjs'), 'allow');

  const shared = path.join(root, 'scripts', 'verify', 'shared.mjs');
  const original = await import('node:fs/promises').then((fs) => fs.readFile(shared, 'utf8'));
  await writeFile(shared, `${original}\nconsole.log('changed');\n`);
  assert.equal(await run('node scripts/verify/verify-all.mjs'), 'ask', 'a modified imported helper asks, even though the entry is unchanged');
  assert.equal(await run('node scripts/verify/check-figures.mjs'), 'ask');
  await writeFile(shared, original);
  assert.equal(await run('node scripts/verify/verify-all.mjs'), 'allow', 'restored, it runs again');

  const figures = path.join(root, 'scripts', 'verify', 'check-figures.mjs');
  const figuresText = await import('node:fs/promises').then((fs) => fs.readFile(figures, 'utf8'));
  await writeFile(path.join(root, 'scripts', 'verify', 'extra.mjs'), 'export const x = 1;\n');
  await writeFile(figures, `import { x } from './extra.mjs';\n${figuresText}`);
  assert.equal(await run('node scripts/verify/check-figures.mjs'), 'ask', 'a newly added import in a scaffolded verifier asks');
  await writeFile(figures, figuresText);

  const write = (name: string, text: string) => writeFile(path.join(root, 'scripts', name), text);
  await write('helper-clean.mjs', "import { readFileSync } from 'node:fs';\nexport const read = (file) => readFileSync(file, 'utf8');\n");
  await write('helper-bad.mjs', "import { execSync } from 'node:child_process';\nexport const go = () => execSync('ls');\n");
  await write('check-clean-import.mjs', "import { read } from './helper-clean.mjs';\nread('a.md');\n");
  await write('check-bad-import.mjs', "import { go } from './helper-bad.mjs';\ngo();\n");
  await write('check-dynamic.mjs', "const name = './helper-' + 'bad.mjs';\nawait import(name);\n");
  await write('check-require.cjs', "const _ = require('lodash');\n");
  await write('check-missing.mjs', "import './not-there.mjs';\n");
  await write('check-cycle-a.mjs', "import './check-cycle-b.mjs';\n");
  await write('check-cycle-b.mjs', "import './check-cycle-a.mjs';\n");
  await write('verify-runs-node.sh', 'node scripts/helper-bad.mjs\n');
  await write('verify-runs-clean.sh', 'node scripts/helper-clean.mjs\n');
  await write('check-imports.py', 'import json\nimport subprocess\n');
  assert.equal(await run('node scripts/check-clean-import.mjs'), 'allow', 'a clean relative import is followed and allowed');
  assert.equal(await run('node scripts/check-bad-import.mjs'), 'ask', 'a helper that spawns asks');
  assert.equal(await run('node scripts/check-dynamic.mjs'), 'ask', 'a dynamic import() asks');
  assert.equal(await run('node scripts/check-require.cjs'), 'ask', 'require of a non-relative module asks');
  assert.equal(await run('node scripts/check-missing.mjs'), 'ask', 'an unresolvable import asks');
  assert.equal(await run('node scripts/check-cycle-a.mjs'), 'ask', 'a cyclic import asks');
  assert.equal(await run('bash scripts/verify-runs-node.sh'), 'ask', 'a script a shell script runs is checked too');
  assert.equal(await run('bash scripts/verify-runs-clean.sh'), 'allow');
  assert.equal(await run('python3 scripts/check-imports.py'), 'ask', 'a Python import outside the allowed standard modules asks');

  const startedAt = Date.now() - 60_000;
  const { utimes: touch } = await import('node:fs/promises');
  await touch(path.join(root, 'scripts', 'helper-clean.mjs'), new Date(), new Date());
  assert.equal(await run('node scripts/check-clean-import.mjs', { tainted: true, runStartedAt: startedAt }), 'ask', 'a helper changed during a tainted run asks, not only the entry');
});

// Review of PR 34: the recency check uses the moment the RUN first read outside content, not the start of the agent that runs the script.
test('a script written after the main agent read outside content still asks when a helper started later runs it', async () => {
  const root = await project();
  const grants = new RunGrants();
  assert.equal(grants.taintedAt, undefined);
  grants.tainted = true;
  const taintedAt = grants.taintedAt!;
  assert.equal(typeof taintedAt, 'number');
  grants.tainted = true;
  assert.equal(grants.taintedAt, taintedAt, 'the first moment is kept');
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The main agent writes the script after reading outside content; the helper that runs it starts a minute later.
  await writeFile(path.join(root, 'scripts', 'verify-planted.sh'), 'echo ok\n');
  const helperStartedAt = Date.now() + 60_000;
  assert.notEqual((await decide(root, 'bash scripts/verify-planted.sh', { tainted: true, runStartedAt: helperStartedAt, taintedAt })).decision, 'allow', 'still asks');
  assert.equal((await decide(root, 'bash scripts/verify-planted.sh', { tainted: true, runStartedAt: helperStartedAt, taintedAt: Date.now() + 120_000 })).decision, 'allow', 'a script from before the taint runs');

  const { AgentRun } = await import('../agent/loop');
  const { RunCheckpoints } = await import('../agent/checkpoints');
  const { ShellSession } = await import('../agent/shell');
  const { CORE_TOOLS } = await import('../agent/tools');
  let turn = 0;
  const asked: string[] = [];
  const client = { async *streamCompletion(): AsyncGenerator<import('../services/nearAiClient').CompletionEvent> { turn += 1; yield { type: 'done', message: turn === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'v1', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'bash scripts/verify-planted.sh' }) } }] } : { role: 'assistant', content: 'done' }, finishReason: 'stop', usage: { verificationStatus: 'unknown', latencyMs: 1 } }; } };
  const shell = new ShellSession(root);
  try {
    // The helper shares the run's grants (tainted earlier by the main agent) and is created after the script was written.
    const helper = new AgentRun({ client, model: 'm', tools: CORE_TOOLS, grants, unattended: {}, context: { root, checkpoints: new RunCheckpoints('taint'), shell, readFiles: new Set() }, policy: { mode: 'mostly-autonomous', emergencyStop: false }, rules: RULES, requestApproval: async (request) => { asked.push(request.title); return { decision: 'deny' }; }, emit: () => undefined });
    await helper.run([{ role: 'user', content: 'verify' }], new AbortController().signal);
  } finally {
    shell.dispose();
  }
  assert.equal(asked.length, 1, 'the helper was asked, not allowed silently');
});

// Review of PR 34: a `..` segment is refused in every form, not only as `../`.
test('every form of a parent-folder path keeps a verification script asking', async () => {
  const root = await project();
  const forms: Record<string, string> = {
    'check-join.mjs': "import { join } from 'node:path';\nimport { readFileSync } from 'node:fs';\nreadFileSync(join('..', 'other', 'x.md'), 'utf8');\n",
    'check-bare.mjs': "import { readdirSync } from 'node:fs';\nreaddirSync('..');\n",
    'check-double.mjs': 'import { readdirSync } from "node:fs";\nreaddirSync("..");\n',
    'check-backtick.mjs': "import { readdirSync } from 'node:fs';\nreaddirSync(`..`);\n",
    'check-slash-up.mjs': "import { readFileSync } from 'node:fs';\nreadFileSync('report/..', 'utf8');\n",
    'verify-arg.sh': 'ls ..\n',
    'check-pardir.py': 'import os\nprint(os.path.pardir)\n',
    'check-chdir.mjs': "process.chdir('/');\n",
    'check-dirname.mjs': "import { dirname } from 'node:path';\nconsole.log(dirname(dirname(process.argv[1])));\n"
  };
  for (const [name, text] of Object.entries(forms)) {
    await writeFile(path.join(root, 'scripts', name), text);
    const command = name.endsWith('.py') ? `python3 scripts/${name}` : name.endsWith('.sh') ? `bash scripts/${name}` : `node scripts/${name}`;
    assert.notEqual((await decide(root, command)).decision, 'allow', name);
  }
  await writeFile(path.join(root, 'scripts', 'check-spread.mjs'), "const parts = [...['a', 'b']];\nconsole.log(parts.join('..b'));\n");
  assert.equal((await decide(root, 'node scripts/check-spread.mjs')).decision, 'allow', 'a spread and a dot inside a name are not parent paths');
});

// Review of PR 34 (blocker): a verification script's arguments are held to the same rules as the script.
test('a verification script with an argument that leaves the project asks; a clean relative argument still runs', async () => {
  const root = await project();
  await mkdir(path.join(root, 'report'), { recursive: true });
  await writeFile(path.join(root, 'report', 'a.md'), 'a');
  const outside = await mkdtemp(path.join(tmpdir(), 'near-ai-arg-outside-'));
  const { symlink } = await import('node:fs/promises');
  await symlink(outside, path.join(root, 'linked-out'));
  const asks = ['../x', '../../etc', '/etc/passwd', '~/.ssh/id_rsa', '$HOME/x', '${HOME}', 'report/*.md', '/tmp/*', '--file=../x', '--file=/etc/passwd', 'report/../../x', 'linked-out/secret.txt', 'C:/Windows'];
  for (const arg of asks) assert.notEqual((await decide(root, `node scripts/check-citations.mjs ${arg}`)).decision, 'allow', arg);
  for (const arg of ['report', 'report/a.md', '--strict', '--figures=report/figures.json', 'a.md']) assert.equal((await decide(root, `node scripts/check-citations.mjs ${arg}`)).decision, 'allow', arg);
  await writeFile(path.join(root, 'scripts', 'verify-calls.sh'), 'node scripts/check-citations.mjs ../outside\n');
  assert.notEqual((await decide(root, 'bash scripts/verify-calls.sh')).decision, 'allow', 'a script a shell script runs is held to the same argument rules');
});
