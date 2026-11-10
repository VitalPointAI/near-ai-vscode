// The automatic review (scripts/lib/auto-review.mjs), as the workflow (ci-review-run.mjs) and the
// one-time bootstrap (bootstrap-agent-review.mjs) run it: it refuses any identity but
// near-ai-reviewer and any secret passed as an argument, approves only its own passing review of
// the current head, holds gate changes for the owner, never prints a secret, and removes its
// scratch directory. gh is faked (fake-github.mjs in process, a stub executable for the CLIs) and
// so is the model (a local server).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { approvePr, reviewPr } from '../lib/auto-review.mjs';
import { setRunner } from '../lib/gh.mjs';
import { OWNER, REPO, REVIEWER, fakeGitHub, greenCommit, openPr } from './fake-github.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HEAD = '1'.repeat(40);
// Fake values only, shaped so they cannot match a real key format (secret-scan stays clean).
const TOKEN = 'fake-reviewer-token-value-0001';
const MODEL_KEY = 'fake-model-key-value-0002';
const quiet = { log: () => {} };
const servers = [];
afterEach(() => setRunner());
after(() => { for (const server of servers) server.close(); });

const PASS = `## Recommendation: MERGE\n\nSafe to merge.\n\n- [MINOR] src/x.ts:1 wording\n\nVerdict: PASS\nHead-SHA: ${HEAD}\n`;

function fakeModel(reply) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      request.on('data', () => {});
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(`http://127.0.0.1:${server.address().port}/v1`); });
  });
}

function install(state = {}, prExtra = {}) {
  const fake = fakeGitHub({ login: REVIEWER, prs: { 12: openPr(12, 'feat/thing', HEAD, prExtra) }, commits: { [HEAD]: greenCommit({ review: false }) }, ...state });
  setRunner(fake.runner);
  return fake;
}

const env = (baseUrl = 'http://127.0.0.1:9/v1') => ({ ...process.env, GH_TOKEN: TOKEN, REVIEW_MODEL_API_KEY: MODEL_KEY, REVIEW_MODEL: 'test-model', REVIEW_MODEL_BASE_URL: baseUrl });

test('the review refuses the owner\'s account before running anything', async () => {
  const fake = install({ login: OWNER });
  const ran = [];
  await assert.rejects(
    reviewPr(REPO, '12', { ...quiet, env: env(), run: async (script) => { ran.push(script); return ''; } }),
    /gh runs as ALuhning, but the review must run as near-ai-reviewer.*Nothing was run/
  );
  assert.deepEqual(ran, [], 'no script ran');
  assert.deepEqual(fake.calls.map((call) => call.slice(1).join(' ')), ['api user --jq .login'], 'only the identity was read');
  assert.deepEqual(fake.world.commits[HEAD].statuses, []);
  assert.throws(() => approvePr(REPO, '12', HEAD, { ...quiet, env: env() }), /gh runs as ALuhning/);
  assert.deepEqual(fake.world.reviews, []);
});

test('the review refuses when a secret is missing from the environment, before calling gh', async () => {
  const fake = install();
  for (const missing of ['GH_TOKEN', 'REVIEW_MODEL_API_KEY', 'REVIEW_MODEL']) {
    await assert.rejects(reviewPr(REPO, '12', { ...quiet, env: { ...env(), [missing]: '' } }), new RegExp(`${missing} is not set.*never as arguments`));
  }
  assert.deepEqual(fake.calls, []);
});

test('a passing review of an ordinary PR posts as near-ai-reviewer and is approved, pinned to the commit', async () => {
  const fake = install();
  const logs = [];
  const result = await reviewPr(REPO, '12', { env: env(await fakeModel(PASS)), log: (m) => logs.push(String(m)) });
  assert.equal(result.state, 'success');
  assert.equal(result.reviewedSha, HEAD);
  assert.deepEqual(result.gateFiles, []);
  assert.equal(existsSync(result.dir), false, 'the scratch directory is removed');
  const statuses = fake.world.commits[HEAD].statuses;
  assert.deepEqual(statuses.map((status) => status.state), ['pending', 'success']);
  assert.ok(statuses.every((status) => status.creator === REVIEWER));
  assert.match(result.approvalBody, /^## Recommendation: MERGE\n\nSafe to merge\.\n\n---/);
  assert.doesNotMatch(result.approvalBody, /\[MINOR\]/, 'the findings stay out of the approval');

  assert.deepEqual(approvePr(REPO, '12', result.reviewedSha, { env: env(), log: (m) => logs.push(String(m)), body: result.approvalBody }), { approved: true });
  assert.deepEqual(fake.world.reviews, [{ number: '12', by: REVIEWER, event: 'APPROVE', commit: HEAD }]);
  const output = logs.join('\n');
  assert.ok(!output.includes(TOKEN) && !output.includes(MODEL_KEY), 'no secret is printed');
});

test('a PR that changes the gates is reported as such, so the approval waits for the owner', async () => {
  install({}, { files: [{ path: 'src/x.ts' }, { path: '.github/workflows/agent-review.yml' }, { path: 'scripts/lib/merge.mjs' }, { path: 'SECURITY.md' }] });
  const result = await reviewPr(REPO, '12', { ...quiet, env: env(await fakeModel(PASS)) });
  assert.equal(result.state, 'success');
  assert.deepEqual(result.gateFiles, ['.github/workflows/agent-review.yml', 'scripts/lib/merge.mjs', 'SECURITY.md']);
});

test('a failing review is never approved', async () => {
  const fake = install();
  const result = await reviewPr(REPO, '12', { ...quiet, env: env(await fakeModel(`## Recommendation: MERGE\n\n- [BLOCKER] src/x.ts:1 the token is logged\n\nVerdict: PASS\nHead-SHA: ${HEAD}\n`)) });
  assert.equal(result.state, 'failure');
  assert.equal(fake.world.commits[HEAD].statuses.at(-1).state, 'failure');
  assert.deepEqual(approvePr(REPO, '12', HEAD, { ...quiet, env: env() }), { approved: false });
  assert.deepEqual(fake.world.reviews, []);
});

test('a PASS whose recommendation says do not merge, or that has none, fails', async () => {
  for (const reply of [
    `## Recommendation: DO NOT MERGE\n\nRisky.\n\n- [MAJOR] src/x.ts:1 thing\n\nVerdict: PASS\nHead-SHA: ${HEAD}\n`,
    `- [MINOR] src/x.ts:1 thing\n\nVerdict: PASS\nHead-SHA: ${HEAD}\n`
  ]) {
    install();
    const result = await reviewPr(REPO, '12', { ...quiet, env: env(await fakeModel(reply)) });
    assert.equal(result.state, 'failure', reply);
  }
});

test('the approval refuses a moved head, another account\'s status, and a closed PR', () => {
  const moved = '3'.repeat(40);
  // The head moved after the review.
  let fake = install({ commits: { [HEAD]: greenCommit() } });
  fake.world.prs[12].headRefOid = moved;
  assert.deepEqual(approvePr(REPO, '12', HEAD, { ...quiet, env: env() }), { approved: false });
  // The success on the head was set by the owner, not by near-ai-reviewer.
  fake = install({ commits: { [HEAD]: greenCommit({ reviewer: OWNER }) } });
  assert.deepEqual(approvePr(REPO, '12', HEAD, { ...quiet, env: env() }), { approved: false });
  // Closed.
  fake = install({ commits: { [HEAD]: greenCommit() } }, { state: 'CLOSED' });
  assert.deepEqual(approvePr(REPO, '12', HEAD, { ...quiet, env: env() }), { approved: false });
  assert.deepEqual(fake.world.reviews, []);
});

test('a refused approval of an open PR fails loudly instead of being hidden', () => {
  install({ commits: { [HEAD]: greenCommit() }, approveFails: true });
  assert.throws(() => approvePr(REPO, '12', HEAD, { ...quiet, env: env() }), /HTTP 422/);
});

test('a review whose CI passed on an older head is skipped', async () => {
  const fake = install();
  const result = await reviewPr(REPO, '12', { ...quiet, env: env(), expectedHead: '4'.repeat(40) });
  assert.equal(result.skipped, true);
  assert.deepEqual(fake.world.commits[HEAD].statuses, []);
});

test('a review is not posted when the PR moved while the model was reviewing, so it cannot overwrite the new head\'s result', async () => {
  // Both heads' reviews run at once (concurrency is per head); the older one finishing last used to stamp its failure on the new head.
  const fake = install();
  const moved = '5'.repeat(40);
  fake.world.commits[moved] = greenCommit({ review: false });
  const result = await reviewPr(REPO, '12', { ...quiet, env: env(), run: async () => { fake.world.prs[12].headRefOid = moved; return PASS; } });
  assert.equal(result.skipped, true);
  assert.deepEqual(fake.world.commits[HEAD].statuses, []);
  assert.deepEqual(fake.world.commits[moved].statuses, [], 'nothing is set on the new head');
  assert.deepEqual(fake.world.comments ?? [], [], 'and no comment is posted');
});

/** Runs a CLI with a stub `gh` first on PATH that answers `api user` with `login`. */
function runCli(script, args, { login, extraEnv = {} }) {
  const bin = mkdtempSync(path.join(tmpdir(), 'fake-gh-'));
  const log = path.join(bin, 'calls.log');
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> "${log}"\nif [ "$1 $2" = "api user" ]; then echo "${login}"; exit 0; fi\necho "unexpected gh $*" >&2\nexit 1\n`);
  chmodSync(path.join(bin, 'gh'), 0o755);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GH_REPO: REPO, GH_TOKEN: TOKEN, REVIEW_MODEL_API_KEY: MODEL_KEY, REVIEW_MODEL: 'test-model', GITHUB_OUTPUT: '', ...extraEnv }
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
      rmSync(bin, { recursive: true, force: true });
      resolve({ status, out, calls });
    });
  });
}

test('the bootstrap and the workflow CLI refuse a wrong identity reported by gh, printing no secret', async () => {
  const runs = [
    ['bootstrap-agent-review.mjs', ['12']],
    ['bootstrap-agent-review.mjs', ['12', '--approve-gates']],
    ['ci-review-run.mjs', ['review', '12']],
    ['ci-review-run.mjs', ['approve', '12', '--sha', HEAD]]
  ];
  for (const login of [OWNER, 'Em-kale']) {
    for (const [script, args] of runs) {
      const result = await runCli(script, args, { login });
      assert.equal(result.status, 1, `${script} ${args.join(' ')}: ${result.out}`);
      assert.match(result.out, new RegExp(`gh runs as ${login}, but the review must run as near-ai-reviewer`));
      assert.deepEqual(result.calls, ['api user --jq .login'], 'nothing but the identity was asked');
      assert.ok(!result.out.includes(TOKEN) && !result.out.includes(MODEL_KEY));
    }
  }
});

test('the bootstrap takes only the PR number and one flag, so a key cannot be passed as an argument', async () => {
  for (const args of [[], ['12', MODEL_KEY], ['--token', TOKEN, '12'], ['not-a-number'], ['12', '--approve-gates', TOKEN]]) {
    const result = await runCli('bootstrap-agent-review.mjs', args, { login: REVIEWER });
    assert.equal(result.status, 1);
    assert.match(result.out, /usage: .*secrets only from the environment/);
    assert.deepEqual(result.calls, []);
    assert.ok(!result.out.includes(TOKEN) && !result.out.includes(MODEL_KEY), 'the usage message does not echo the arguments');
  }
  const missing = await runCli('bootstrap-agent-review.mjs', ['12'], { login: REVIEWER, extraEnv: { REVIEW_MODEL_API_KEY: '' } });
  assert.equal(missing.status, 1);
  assert.match(missing.out, /REVIEW_MODEL_API_KEY is not set/);
  assert.deepEqual(missing.calls, []);
});
