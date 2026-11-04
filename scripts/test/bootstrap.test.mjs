// The one-time bootstrap (scripts/bootstrap-agent-review.mjs): it refuses any identity but
// near-ai-reviewer and any secret passed as an argument, runs the workflow's review steps, approves
// only on a passing review, never prints a secret, and removes its scratch directory. gh is faked
// (fake-github.mjs in process, a stub executable for the CLI) and so is the model (a local server).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { setRunner } from '../lib/gh.mjs';
import { approvalBody, bootstrapReview } from '../lib/bootstrap.mjs';
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

function install(state) {
  const fake = fakeGitHub({ login: REVIEWER, prs: { 12: openPr(12, 'feat/auto-agent-review', HEAD) }, commits: { [HEAD]: greenCommit({ review: false }) }, ...state });
  setRunner(fake.runner);
  return fake;
}

const env = (baseUrl) => ({ ...process.env, GH_TOKEN: TOKEN, REVIEW_MODEL_API_KEY: MODEL_KEY, REVIEW_MODEL: 'test-model', REVIEW_MODEL_BASE_URL: baseUrl });

test('the bootstrap refuses the owner\'s account before running anything', async () => {
  const fake = install({ login: OWNER });
  const ran = [];
  await assert.rejects(
    bootstrapReview(REPO, '12', { ...quiet, env: env('http://127.0.0.1:9/v1'), run: async (script) => { ran.push(script); return ''; } }),
    /gh runs as ALuhning, but the review must run as near-ai-reviewer.*Nothing was run/
  );
  assert.deepEqual(ran, [], 'no script ran');
  assert.deepEqual(fake.calls.map((call) => call.slice(1).join(' ')), ['api user --jq .login'], 'only the identity was read');
  assert.deepEqual(fake.world.commits[HEAD].statuses, []);
  assert.deepEqual(fake.world.reviews, []);
});

test('the bootstrap refuses when a secret is missing from the environment, before calling gh', async () => {
  const fake = install({});
  for (const missing of ['GH_TOKEN', 'REVIEW_MODEL_API_KEY', 'REVIEW_MODEL']) {
    const partial = { ...env('http://127.0.0.1:9/v1'), [missing]: '' };
    await assert.rejects(bootstrapReview(REPO, '12', { ...quiet, env: partial }), new RegExp(`${missing} is not set.*never as arguments`));
  }
  assert.deepEqual(fake.calls, []);
});

test('the bootstrap reviews, submits as near-ai-reviewer and approves a passing review, then cleans up', async () => {
  const reply = `## Agent review for #12\n\n### Recommendation: merge\nSafe to merge.\n\nVerdict: PASS\nHead-SHA: ${HEAD}\n\n### Findings\n- [MINOR] wording\n`;
  const baseUrl = await fakeModel(reply);
  const fake = install({});
  const logs = [];
  const result = await bootstrapReview(REPO, '12', { env: env(baseUrl), log: (m) => logs.push(String(m)) });
  assert.equal(result.state, 'success');
  assert.equal(result.approved, true);
  const statuses = fake.world.commits[HEAD].statuses;
  assert.deepEqual(statuses.map((status) => status.state), ['pending', 'success']);
  assert.ok(statuses.every((status) => status.creator === REVIEWER), 'every status is near-ai-reviewer\'s');
  assert.deepEqual(fake.world.reviews, [{ number: '12', by: REVIEWER, approve: true }]);
  assert.equal(existsSync(result.dir), false, 'the scratch directory is removed');
  const output = logs.join('\n');
  assert.ok(!output.includes(TOKEN) && !output.includes(MODEL_KEY), 'no secret is printed');
});

test('the bootstrap never approves a failing review, and still cleans up', async () => {
  const baseUrl = await fakeModel(`Verdict: PASS\nHead-SHA: ${HEAD}\n- [BLOCKER] the token is logged\n`);
  const fake = install({});
  const result = await bootstrapReview(REPO, '12', { ...quiet, env: env(baseUrl) });
  assert.equal(result.state, 'failure');
  assert.equal(result.approved, false);
  assert.equal(fake.world.commits[HEAD].statuses.at(-1).state, 'failure');
  assert.deepEqual(fake.world.reviews, []);
  assert.equal(existsSync(result.dir), false);
});

test('the bootstrap does not approve when the head moved after the review', async () => {
  const reply = `Verdict: PASS\nHead-SHA: ${HEAD}\n`;
  const baseUrl = await fakeModel(reply);
  const moved = '3'.repeat(40);
  const fake = install({});
  let views = 0;
  const runner = fake.runner;
  setRunner((command, args) => {
    // The PR's head moves between submit and the approval check.
    if (args[0] === 'pr' && args[1] === 'view' && ++views === 3) fake.world.prs[12].headRefOid = moved;
    return runner(command, args);
  });
  const result = await bootstrapReview(REPO, '12', { ...quiet, env: env(baseUrl) });
  assert.equal(result.approved, false);
  assert.deepEqual(fake.world.reviews, []);
});

test('the approval body carries the reviewer\'s recommendation', () => {
  const body = approvalBody(`## Review\n### Recommendation: merge\nIt is fine.\n\nVerdict: PASS\n`);
  assert.match(body, /^### Recommendation: merge\nIt is fine\.\n\n---\n`agent-review` passed/);
  assert.match(approvalBody('Verdict: PASS\n'), /^Approved by the agent review gate\./);
});

/** Runs the CLI with a stub `gh` first on PATH that answers `api user` with `login`. */
function runCli(args, { login, extraEnv = {} }) {
  const bin = mkdtempSync(path.join(tmpdir(), 'fake-gh-'));
  const log = path.join(bin, 'calls.log');
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> "${log}"\nif [ "$1 $2" = "api user" ]; then echo "${login}"; exit 0; fi\necho "unexpected gh $*" >&2\nexit 1\n`);
  chmodSync(path.join(bin, 'gh'), 0o755);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'bootstrap-agent-review.mjs'), ...args], {
      cwd: ROOT,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GH_REPO: REPO, GH_TOKEN: TOKEN, REVIEW_MODEL_API_KEY: MODEL_KEY, REVIEW_MODEL: 'test-model', ...extraEnv }
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

test('the CLI refuses a wrong identity reported by gh, posting nothing and printing no secret', async () => {
  for (const login of [OWNER, 'Em-kale']) {
    const result = await runCli(['12'], { login });
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, new RegExp(`gh runs as ${login}, but the review must run as near-ai-reviewer`));
    assert.deepEqual(result.calls, ['api user --jq .login'], 'nothing but the identity was asked');
    assert.ok(!result.out.includes(TOKEN) && !result.out.includes(MODEL_KEY));
  }
});

test('the CLI takes only the PR number, so a key cannot be passed as an argument', async () => {
  for (const args of [[], ['12', MODEL_KEY], ['--token', TOKEN, '12'], ['not-a-number']]) {
    const result = await runCli(args, { login: REVIEWER });
    assert.equal(result.status, 1);
    assert.match(result.out, /usage: .*secrets only from the environment/);
    assert.deepEqual(result.calls, []);
    assert.ok(!result.out.includes(TOKEN) && !result.out.includes(MODEL_KEY), 'the usage message does not echo the arguments');
  }
  const missing = await runCli(['12'], { login: REVIEWER, extraEnv: { REVIEW_MODEL_API_KEY: '' } });
  assert.equal(missing.status, 1);
  assert.match(missing.out, /REVIEW_MODEL_API_KEY is not set/);
  assert.deepEqual(missing.calls, []);
});
