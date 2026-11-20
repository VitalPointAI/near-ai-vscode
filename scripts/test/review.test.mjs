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
import { OWNER, REPO, REVIEWER, fakeGitHub, greenCommit, openPr } from './fake-github.mjs';

const HEAD = '1'.repeat(40);
const quiet = { log: () => {} };
afterEach(() => setRunner());

function install(state) {
  // submit runs as the reviewer identity, as it does in .github/workflows/agent-review.yml.
  const fake = fakeGitHub({ login: REVIEWER, prs: { 7: openPr(7, 'fix/thing', HEAD) }, commits: { [HEAD]: greenCommit() }, ...state });
  setRunner(fake.runner);
  return fake;
}

const posts = (fake) => fake.calls.map((call) => call.join(' '))
  .filter((call) => /statuses\/|pr comment/.test(call) && !/--paginate/.test(call))
  .map((call) => (call.includes('pr comment') ? 'comment' : `status ${/state=(\w+)/.exec(call)[1]}`));

const PASS = `Verdict: PASS\nHead-SHA: ${HEAD}\n- [MINOR] wording\n`;
const BLOCKED = `Verdict: PASS\nHead-SHA: ${HEAD}\n- [BLOCKER] token logged\n`;

test('submit sets agent-review to pending, then posts the comment, then sets the result', () => {
  const fake = install({});
  const result = submitReview(REPO, '7', PASS, quiet);
  assert.equal(result.state, 'success');
  assert.deepEqual(posts(fake), ['status pending', 'comment', 'status success']);
  const [final] = fake.called(/state=success/);
  assert.ok(final.includes(`target_url=https://github.com/${REPO}/pull/7#issuecomment-1`), 'the status links to the comment');
});

test('a failed comment leaves agent-review pending, never an older success', () => {
  // The commit already carries the reviewer's success from an earlier review; the re-review found a
  // blocker but its comment fails to post.
  const fake = install({ commentFails: true });
  assert.throws(() => submitReview(REPO, '7', BLOCKED, quiet), /could not be posted, so agent-review is left pending/);
  assert.deepEqual(posts(fake), ['status pending', 'comment']);
  const gate = evaluateCommit(fake.world.commits[HEAD], { reviewer: REVIEWER });
  assert.equal(gate.ok, false);
  assert.match(gate.problems.join('\n'), /"agent-review" is pending/);
});

test('a status that cannot be set stops the submit before anything is posted', () => {
  const fake = install({ statusFails: (state) => state === 'pending' });
  assert.throws(() => submitReview(REPO, '7', PASS, quiet), /HTTP 502/);
  assert.deepEqual(posts(fake).filter((p) => p === 'comment'), []);
});

test('submit posts as near-ai-reviewer, and the gates accept that status', () => {
  const fake = install({});
  assert.equal(submitReview(REPO, '7', PASS, quiet).state, 'success');
  assert.ok(fake.world.commits[HEAD].statuses.every((status) => status.creator === REVIEWER));
  assert.equal(evaluateCommit(fake.world.commits[HEAD], { reviewer: REVIEWER }).ok, true);
});

test('submit refuses the owner\'s account (the authoring agents), posting nothing', () => {
  // The authoring agents run gh as the owner; a status they post would be self-certification.
  const fake = install({ login: OWNER, commits: { [HEAD]: greenCommit({ review: false }) } });
  assert.throws(() => submitReview(REPO, '7', PASS, quiet), /gh runs as ALuhning.*only from near-ai-reviewer; nothing was posted.*gh workflow run agent-review\.yml -f pr=7/);
  assert.deepEqual(posts(fake), []);
});

test('submit refuses, posting nothing, when gh runs as another account', () => {
  const fake = install({ login: 'Em-kale' });
  assert.throws(() => submitReview(REPO, '7', PASS, quiet), /gh runs as Em-kale.*only from near-ai-reviewer; nothing was posted/);
  assert.deepEqual(posts(fake), []);
  const logs = [];
  assert.equal(submitReview(REPO, '7', PASS, { log: (m) => logs.push(m), dryRun: true }).state, 'success');
  assert.match(logs.join('\n'), /a real submit would refuse/);
  assert.deepEqual(posts(fake), [], 'a dry run posts nothing');
});

test('gather lists every changed file through the paginated API', () => {
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

test('gather builds the diff from the per-file API when GitHub refuses it as too large', () => {
  const files = [
    { path: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' },
    { path: 'src/b.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+fresh\n' },
    { path: 'media/tile.webp', status: 'added' },
    { path: 'src/c.ts', previous: 'src/old-c.ts', status: 'renamed', patch: '@@ -1 +1 @@\n-x\n+y' },
    { path: 'src/gone.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-bye' }
  ];
  const fake = fakeGitHub({ diffTooLarge: true, prs: { 7: openPr(7, 'fix/thing', HEAD, { files }) } });
  setRunner(fake.runner);
  const logged = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'gather-test-'));
  try {
    gatherReview(REPO, '7', dir, { log: (line) => logged.push(line) });
    const diff = readFileSync(path.join(dir, 'diff.patch'), 'utf8');
    assert.equal(diff, [
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new',
      'diff --git a/src/b.ts b/src/b.ts', '--- /dev/null', '+++ b/src/b.ts', '@@ -0,0 +1 @@', '+fresh',
      'diff --git a/media/tile.webp b/media/tile.webp', '(added: no text diff from GitHub, binary or too large to show)',
      'diff --git a/src/old-c.ts b/src/c.ts', '--- a/src/old-c.ts', '+++ b/src/c.ts', '@@ -1 +1 @@', '-x', '+y',
      'diff --git a/src/gone.ts b/src/gone.ts', '--- a/src/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye', ''
    ].join('\n'));
    assert.ok(logged.some((line) => /too large.*5 files, 1 without a text patch/.test(line)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gather still fails on any other diff error', () => {
  const fake = fakeGitHub({ failOn: /^pr diff/, prs: { 7: openPr(7, 'fix/thing', HEAD) } });
  setRunner(fake.runner);
  const dir = mkdtempSync(path.join(tmpdir(), 'gather-test-'));
  try {
    assert.throws(() => gatherReview(REPO, '7', dir, quiet), /HTTP 500/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
