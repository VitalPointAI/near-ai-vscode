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

async function decide(root: string, command: string, options: { mode?: ActionPolicyMode; unattended?: boolean; tainted?: boolean; planScripts?: string[]; runStartedAt?: number } = {}) {
  const grants = new RunGrants();
  grants.tainted = options.tainted === true;
  const auto: AutoApprovalContext = { root, cwd: root, home: homedir(), packageScripts: { test: 'node --test', lint: 'tsc --noEmit' }, ...(options.unattended === false ? {} : { unattended: { planScripts: options.planScripts ?? [], runStartedAt: options.runStartedAt ?? 0 } }) };
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
  assert.deepEqual(scriptInvocation('bash scripts/verify.sh --quick', '/p'), { script: '/p/scripts/verify.sh', cwd: '/p' });
  assert.equal(scriptInvocation('node -e "x"', '/p'), undefined);
  assert.equal(scriptInvocation('bash scripts/verify.sh; rm x', '/p'), undefined);
  assert.equal(scriptInvocation('node $(echo x).mjs', '/p'), undefined);
  assert.equal(forbiddenScriptContent('#!/usr/bin/env node\nconsole.log(1)\n', '/p'), undefined);
  assert.match(String(forbiddenScriptContent("readFileSync('../secret')", '/p')), /above its own folder/);
  assert.match(String(forbiddenScriptContent('cat /var/log/x', '/p')), /outside the project/);
  assert.deepEqual(scriptsNamedIn('Run `scripts/verify-gates.sh` then node scripts/figures.mjs and ../evil.sh'), ['scripts/verify-gates.sh', 'scripts/figures.mjs']);
});
