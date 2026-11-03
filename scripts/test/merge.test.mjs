// Orchestration tests for the merge and release scripts, against a fake gh (fake-github.mjs):
// what is called, in which order, and what is never done when a gate refuses.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setRunner, tagCommit } from '../lib/gh.mjs';
import { mergePr } from '../lib/merge.mjs';
import { tagRelease, waitForCi } from '../lib/release.mjs';
import { CI_CHECKS } from '../lib/workflow.mjs';
import { REPO, fakeGitHub, greenCommit, openPr } from './fake-github.mjs';

const HEAD = '1'.repeat(40);
const SQUASH = '2'.repeat(40);
const noWait = async () => {};
const quiet = { log: () => {}, wait: noWait };
afterEach(() => setRunner());

function install(state) {
  const fake = fakeGitHub(state);
  setRunner(fake.runner);
  return fake;
}

const pending = () => ({
  checkRuns: CI_CHECKS.map((name, i) => ({ id: 500 + i, name, status: 'in_progress', conclusion: null, startedAt: '2026-01-01T00:00:00Z', app: 'github-actions', suiteId: 5 })),
  workflowRuns: [{ id: 55, name: 'CI', path: '.github/workflows/ci.yml', event: 'push', status: 'in_progress', conclusion: null, suiteId: 5 }],
  statuses: []
});

// ---- waitForCi ---------------------------------------------------------------------------------

test('waitForCi waits while CI runs, announces it once, and returns when it is green', async () => {
  const fake = install({ commits: { [HEAD]: [pending(), pending(), greenCommit({ suiteId: 5, runId: 55, event: 'push', review: false })] } });
  const logs = [];
  const waits = [];
  await waitForCi(REPO, HEAD, { log: (m) => logs.push(m), wait: async (ms) => { waits.push(ms); }, pollMs: 7 });
  assert.deepEqual(waits, [7, 7]);
  assert.equal(logs.filter((m) => /Waiting for CI/.test(m)).length, 1);
  assert.equal(fake.called(/check-runs/).length, 3);
});

test('waitForCi refuses at once on a failed job, without waiting', async () => {
  const failed = greenCommit({ review: false });
  failed.checkRuns[1].conclusion = 'failure';
  install({ commits: { [HEAD]: failed } });
  let waited = false;
  await assert.rejects(waitForCi(REPO, HEAD, { log: () => {}, wait: async () => { waited = true; } }), /is not green:\n- required check "test" is failure/);
  assert.equal(waited, false);
});

test('waitForCi gives up when CI is still running at the deadline', async () => {
  install({ commits: { [HEAD]: pending() } });
  let clock = 0;
  const run = waitForCi(REPO, HEAD, { log: () => {}, timeoutMs: 60_000, now: () => clock, wait: async () => { clock += 30_000; } });
  await assert.rejects(run, /did not finish within 1 minutes:\n- required check "lint" is still running/);
});

test('tagging a release waits for a dispatched run that has not started its jobs', async () => {
  const queued = { ...greenCommit({ review: false }) };
  queued.workflowRuns = [...queued.workflowRuns, { id: 77, name: 'CI', path: '.github/workflows/ci.yml', event: 'push', status: 'queued', conclusion: null, suiteId: 7 }];
  const done = greenCommit({ suiteId: 7, runId: 77, event: 'push', review: false });
  const fake = install({
    commits: { [SQUASH]: [queued, done] }, mainContains: new Set([SQUASH]),
    files: { [`${SQUASH}:package.json`]: '{"version":"1.2.3"}', [`${SQUASH}:CHANGELOG.md`]: '## 1.2.3\n\nFixes.\n' }
  });
  assert.equal(await tagRelease(REPO, '1.2.3', SQUASH, { log: () => {}, ci: { wait: noWait } }), 'v1.2.3');
  assert.equal(fake.called(/check-runs/).length, 2, 'it polled until the run finished');
  assert.equal(fake.world.tags['v1.2.3'], SQUASH);
});

// ---- merge-pr ----------------------------------------------------------------------------------

function readyToMerge(extra = {}) {
  return {
    prs: { 7: openPr(7, 'fix/thing', HEAD) },
    commits: { [HEAD]: greenCommit() },
    mergeSha: SQUASH,
    ...extra
  };
}

test('merge-pr squash-merges a PR whose gates pass, matching the head it checked', async () => {
  const fake = install(readyToMerge());
  const result = await mergePr(REPO, '7', quiet);
  assert.deepEqual(result, { merged: true, mergeSha: SQUASH, tag: undefined });
  const [merge] = fake.called(/^gh pr merge/);
  assert.deepEqual(merge, ['gh', 'pr', 'merge', '7', '--repo', REPO, '--squash', '--delete-branch', '--match-head-commit', HEAD, '--subject', 'fix: thing 7 (#7)']);
  assert.equal(fake.called(/--admin/).length, 0, 'never bypasses protection');
  assert.equal(fake.called(/git\/(tags|refs)/).length, 0, 'a normal PR is not tagged');
});

test('merge-pr refuses with every reason and merges nothing when a gate fails', async () => {
  const commit = greenCommit({ reviewer: 'someone-else' });
  commit.checkRuns[2].conclusion = 'failure';
  const fake = install(readyToMerge({
    prs: { 7: openPr(7, 'feature/thing', HEAD, { isDraft: true, mergeable: 'CONFLICTING' }) },
    commits: { [HEAD]: commit }, behind: { [HEAD]: 2 }, threads: [{ isResolved: false, path: 'a' }]
  }));
  const error = await mergePr(REPO, '7', quiet).then(() => undefined, (e) => e);
  assert.ok(error, 'refused');
  for (const reason of [/is a draft/, /does not follow the naming rules/, /"e2e" is failure/, /"agent-review" was also set by someone-else/, /2 commit\(s\) behind main/, /merge conflicts/, /1 review conversation/]) {
    assert.match(error.message, reason);
  }
  assert.equal(fake.called(/^gh pr merge/).length, 0);
});

test('merge-pr --dry-run checks everything and merges nothing', async () => {
  const fake = install(readyToMerge());
  const logs = [];
  assert.deepEqual(await mergePr(REPO, '7', { ...quiet, log: (m) => logs.push(m), dryRun: true }), { merged: false });
  assert.match(logs.join('\n'), /All gates pass for #7.*\n\[dry run\] not merging/);
  assert.equal(fake.called(/^gh pr merge/).length, 0);
});

test('merge-pr tags nothing when GitHub does not confirm the merge', async () => {
  const fake = install(readyToMerge({ prs: { 9: openPr(9, 'release/1.2.3', HEAD) }, mergeUnconfirmed: true, files: releaseFiles(HEAD) }));
  await assert.rejects(mergePr(REPO, '9', quiet), /could not be confirmed: GitHub reports the PR as OPEN.*Nothing was tagged/);
  assert.equal(fake.called(/^gh pr view 9 .*state,mergeCommit/).length, 5, 'it re-read the state before giving up');
  assert.equal(fake.called(/git\/(tags|refs)/).length, 0);
});

function releaseFiles(...shas) {
  const files = {};
  for (const sha of shas) {
    files[`${sha}:package.json`] = '{"version":"1.2.3"}';
    files[`${sha}:CHANGELOG.md`] = '# Changelog\n\n## 1.2.3\n\nFixes.\n';
  }
  return files;
}

test('merge-pr merges a release PR, waits for CI on the squash commit, then tags it', async () => {
  const fake = install(readyToMerge({
    prs: { 9: openPr(9, 'release/1.2.3', HEAD, { title: 'chore(release): 1.2.3' }) },
    commits: { [HEAD]: greenCommit(), [SQUASH]: [pending(), greenCommit({ suiteId: 5, runId: 55, event: 'push', review: false })] },
    mainContains: new Set([SQUASH]), files: releaseFiles(HEAD, SQUASH)
  }));
  const result = await mergePr(REPO, '9', quiet);
  assert.deepEqual(result, { merged: true, mergeSha: SQUASH, tag: 'v1.2.3' });
  const order = fake.calls.map((call) => call.join(' '));
  const merged = order.findIndex((call) => call.startsWith('gh pr merge'));
  const tagged = order.findIndex((call) => /git\/tags/.test(call));
  const lastCiRead = order.findLastIndex((call) => call.includes(`commits/${SQUASH}/check-runs`));
  assert.ok(merged >= 0 && merged < lastCiRead && lastCiRead < tagged, 'merge, then CI on the squash commit, then the tag');
  assert.equal(fake.world.tags['v1.2.3'], SQUASH);
});

test('merge-pr refuses a release PR whose version tag already exists, unless --no-tag', async () => {
  const state = () => readyToMerge({ prs: { 9: openPr(9, 'release/1.2.3', HEAD) }, files: releaseFiles(HEAD), tags: { 'v1.2.3': '3'.repeat(40) } });
  let fake = install(state());
  await assert.rejects(mergePr(REPO, '9', quiet), /v1\.2\.3 already exists on 3333333/);
  assert.equal(fake.called(/^gh pr merge/).length, 0);
  fake = install(state());
  assert.deepEqual(await mergePr(REPO, '9', { ...quiet, noTag: true }), { merged: true, mergeSha: SQUASH, tag: undefined });
  assert.equal(fake.called(/git\/(tags|refs)/).length, 0);
});

test('only the configured owner\'s agent-review counts, whoever runs merge-pr or tag-release', async () => {
  // Another admin runs the merge with their own agent-review status: refused.
  let fake = install(readyToMerge({ login: 'Em-kale', commits: { [HEAD]: greenCommit({ reviewer: 'Em-kale' }) } }));
  await assert.rejects(mergePr(REPO, '7', quiet), /"agent-review" has not been set on this commit by near-ai-reviewer/);
  assert.equal(fake.called(/^gh pr merge/).length, 0);
  // The same admin can merge a PR the owner's review passed.
  fake = install(readyToMerge({ login: 'Em-kale' }));
  assert.equal((await mergePr(REPO, '7', quiet)).merged, true);
  // A hotfix head tagged by another admin still needs the owner's review on it.
  const hotfix = greenCommit({ reviewer: 'Em-kale', event: 'workflow_dispatch' });
  install({ login: 'Em-kale', commits: { [HEAD]: hotfix }, branches: { 'hotfix/1.2.3': HEAD }, files: releaseFiles(HEAD) });
  await assert.rejects(tagRelease(REPO, '1.2.3', HEAD, { log: () => {}, wait: false }), /has not been set on this commit by near-ai-reviewer/);
});

test('merge-pr points out a PR that changes the gates themselves', async () => {
  const logs = [];
  install(readyToMerge({ prs: { 7: openPr(7, 'fix/thing', HEAD, { files: [{ path: 'src/x.ts' }, { path: '.github/workflows/ci.yml' }, { path: 'scripts/lib/workflow.mjs' }] }) } }));
  await mergePr(REPO, '7', { ...quiet, log: (m) => logs.push(m), dryRun: true });
  assert.match(logs.join('\n'), /changes the gates themselves.*\.github\/workflows\/ci\.yml, scripts\/lib\/workflow\.mjs/s);
  logs.length = 0;
  install(readyToMerge());
  await mergePr(REPO, '7', { ...quiet, log: (m) => logs.push(m), dryRun: true });
  assert.doesNotMatch(logs.join('\n'), /gates themselves/);
});

test('branch protection is read as unprotected only on a 404; other errors refuse', async () => {
  install(readyToMerge({ failOn: /protection\/required_status_checks/ }));
  await assert.rejects(mergePr(REPO, '7', quiet), /HTTP 500/);
  install(readyToMerge({ protection: ['agent-review', 'codeql'] }));
  await assert.rejects(mergePr(REPO, '7', quiet), /"codeql" has not reported/);
});

test('a tag that points at another tag is followed down to its commit', () => {
  const commit = '4'.repeat(40);
  setRunner((command, args) => {
    const endpoint = args[1];
    if (endpoint.endsWith('/git/ref/tags/v1.2.3')) return JSON.stringify({ object: { type: 'tag', sha: 'a1' } });
    if (endpoint.endsWith('/git/tags/a1')) return JSON.stringify({ object: { type: 'tag', sha: 'a2' } });
    if (endpoint.endsWith('/git/tags/a2')) return JSON.stringify({ object: { type: 'commit', sha: commit } });
    throw new Error(`unexpected ${args.join(' ')}`);
  });
  assert.equal(tagCommit(REPO, 'v1.2.3'), commit);
});
