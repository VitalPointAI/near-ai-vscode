// Orchestration tests for agent-review.mjs submit and gather, against a fake gh
// (fake-github.mjs): the order of the status and the comment, and what is never posted.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { setRunner } from '../lib/gh.mjs';
import { gatherReview, submitReview } from '../lib/review.mjs';
import { evaluateCommit } from '../lib/workflow.mjs';
import { OWNER, REPO, fakeGitHub, greenCommit, openPr } from './fake-github.mjs';

const HEAD = '1'.repeat(40);
/** The review posts as the reviewer identity, through its own token. */
const reviewerToken = () => { process.env.NEAR_AI_REVIEW_TOKEN = 'reviewer-token'; };
const noToken = () => { delete process.env.NEAR_AI_REVIEW_TOKEN; };
const quiet = { log: () => {} };
afterEach(() => { setRunner(); noToken(); });

function install(state) {
  const fake = fakeGitHub({ prs: { 7: openPr(7, 'fix/thing', HEAD) }, commits: { [HEAD]: greenCommit() }, ...state });
  setRunner(fake.runner);
  return fake;
}

const posts = (fake) => fake.calls.map((call) => call.join(' '))
  .filter((call) => /statuses\/|pr comment/.test(call) && !/--paginate/.test(call))
  .map((call) => (call.includes('pr comment') ? 'comment' : `status ${/state=(\w+)/.exec(call)[1]}`));

const PASS = `Verdict: PASS\nHead-SHA: ${HEAD}\n- [MINOR] wording\n`;
const BLOCKED = `Verdict: PASS\nHead-SHA: ${HEAD}\n- [BLOCKER] token logged\n`;

test('submit sets agent-review to pending, then posts the comment, then sets the result', () => {
  reviewerToken();
  const fake = install({});
  const result = submitReview(REPO, '7', PASS, quiet);
  assert.equal(result.state, 'success');
  assert.deepEqual(posts(fake), ['status pending', 'comment', 'status success']);
  const [final] = fake.called(/state=success/);
  assert.ok(final.includes(`target_url=https://github.com/${REPO}/pull/7#issuecomment-1`), 'the status links to the comment');
});

test('a failed comment leaves agent-review pending, never an older success', () => {
  reviewerToken();
  // The commit already carries the owner's success from an earlier review; the re-review found a
  // blocker but its comment fails to post.
  const fake = install({ commentFails: true });
  assert.throws(() => submitReview(REPO, '7', BLOCKED, quiet), /could not be posted, so agent-review is left pending/);
  assert.deepEqual(posts(fake), ['status pending', 'comment']);
  const gate = evaluateCommit(fake.world.commits[HEAD], { reviewer: OWNER });
  assert.equal(gate.ok, false);
  assert.match(gate.problems.join('\n'), /"agent-review" is pending/);
});

test('a status that cannot be set stops the submit before anything is posted', () => {
  reviewerToken();
  const fake = install({ statusFails: (state) => state === 'pending' });
  assert.throws(() => submitReview(REPO, '7', PASS, quiet), /HTTP 502/);
  assert.deepEqual(posts(fake).filter((p) => p === 'comment'), []);
});

test('submit refuses, posting nothing, when the token is not the reviewer', () => {
  // A fake whose token belongs to someone else: the gate trusts only AGENT_REVIEW_ACCOUNT.
  reviewerToken();
  process.env.NEAR_AI_REVIEW_TOKEN = 'someone-elses-token';
  const fake = install({ login: 'Em-kale' });
  assert.throws(() => submitReview(REPO, '7', PASS, quiet), /the review token belongs to Em-kale.*only from near-ai-reviewer; nothing was posted/);
  assert.deepEqual(posts(fake), []);
  const logs = [];
  assert.equal(submitReview(REPO, '7', PASS, { log: (m) => logs.push(m), dryRun: true }).state, 'success');
  assert.match(logs.join('\n'), /a real submit would refuse/);
  assert.deepEqual(posts(fake), [], 'a dry run posts nothing');
});

test('gather lists every changed file through the paginated API', () => {
  reviewerToken();
  const files = Array.from({ length: 130 }, (_, i) => ({ path: `src/f${i}.ts` }));
  const fake = fakeGitHub({ prs: { 7: openPr(7, 'fix/thing', HEAD, { files }) } });
  // gh pr view returns only the first 100 files; the files endpoint returns all of them.
  setRunner((command, args) => (args[0] === 'pr' && args[1] === 'view'
    ? JSON.stringify(openPr(7, 'fix/thing', HEAD, { files: files.slice(0, 100) }))
    : fake.runner(command, args)));
  const dir = mkdtempSync(path.join(tmpdir(), 'gather-test-'));
  try {
    gatherReview(REPO, '7', dir, quiet);
    assert.equal(readFileSync(path.join(dir, 'files.txt'), 'utf8').trim().split('\n').length, 130);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
