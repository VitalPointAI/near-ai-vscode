// Unit tests for the rules behind the review, merge, release and secret-scan scripts.
// Fake secrets are assembled at runtime so this file never matches the scanner itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BRANCH_PATTERN, CI_CHECKS, REQUIRED_CHECKS, changelogSection, evaluateChecks, evaluateCommit, fitComment, isSecretFileName, latestReleaseVersion, mergeOutcomeProblem, releaseGate, releasePrProblems,
  isVersionBump, maskLine, normalizeChecks, parseAllowlist, parseReview, releaseVersionFromBranch, reviewDecision, scanLine
} from '../lib/workflow.mjs';
import { isNotFound } from '../lib/gh.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

test('a passing review names the head it covers and has no open blocker', () => {
  const review = parseReview(`# Review\n\nVerdict: PASS\nHead-SHA: ${SHA}\n\n- [MAJOR] tighten the regex\n- [BLOCKER][RESOLVED] fixed in abc1234\n- [NIT] wording`);
  assert.equal(review.verdict, 'PASS');
  assert.equal(review.headSha, SHA);
  assert.deepEqual(review.openBlockers, []);
  assert.deepEqual(review.counts, { blocker: 0, major: 1, minor: 0, nit: 1, resolved: 1 });
  assert.deepEqual(reviewDecision(review, SHA), { state: 'success', reasons: [] });
});

test('an open blocker fails the review even when the verdict says PASS', () => {
  const decision = reviewDecision(parseReview(`Verdict: PASS\nHead-SHA: ${SHA}\n- [BLOCKER] token logged in plain text`), SHA);
  assert.equal(decision.state, 'failure');
  assert.match(decision.reasons.join(), /1 open BLOCKER/);
});

test('every severity tag on a line counts, so a resolved one cannot hide an open one', () => {
  const review = parseReview(`Verdict: PASS\nHead-SHA: ${SHA}\n- [BLOCKER][RESOLVED] fixed in abc1234; [BLOCKER] the token is still logged\n- [MAJOR] one [MAJOR] two`);
  assert.equal(review.openBlockers.length, 1);
  assert.deepEqual(review.counts, { blocker: 1, major: 2, minor: 0, nit: 0, resolved: 1 });
  assert.equal(reviewDecision(review, SHA).state, 'failure');
});

test('a FAIL verdict, a missing verdict, or a missing head fails the review', () => {
  assert.equal(reviewDecision(parseReview(`Verdict: FAIL\nHead-SHA: ${SHA}`), SHA).state, 'failure');
  assert.match(reviewDecision(parseReview(`Head-SHA: ${SHA}`), SHA).reasons.join(), /no "Verdict/);
  assert.match(reviewDecision(parseReview('Verdict: PASS'), SHA).reasons.join(), /no "Head-SHA/);
});

test('the verdict must be exactly one "Verdict: PASS" or "Verdict: FAIL" line', () => {
  const fails = (text, pattern) => {
    const decision = reviewDecision(parseReview(text), SHA);
    assert.equal(decision.state, 'failure', text);
    assert.match(decision.reasons.join('\n'), pattern, text);
  };
  fails(`Verdict: PASS\nVerdict: FAIL\nHead-SHA: ${SHA}`, /2 Verdict lines/);
  fails(`Verdict: PASS\nVerdict: PASS\nHead-SHA: ${SHA}`, /2 Verdict lines/);
  fails(`Verdict: PASS | FAIL\nHead-SHA: ${SHA}`, /not exactly "Verdict: PASS" or "Verdict: FAIL"/);
  fails(`Verdict: Pass with blockers\nHead-SHA: ${SHA}`, /not exactly/);
  fails(`Verdict: pass\nHead-SHA: ${SHA}`, /not exactly/);
  fails(`Verdict: PASS            <- or FAIL\nHead-SHA: ${SHA}`, /not exactly/);
  for (const ok of ['Verdict: PASS', '**Verdict:** PASS', '**Verdict: PASS**', 'verdict:PASS']) {
    assert.deepEqual(reviewDecision(parseReview(`${ok}\nHead-SHA: ${SHA}`), SHA), { state: 'success', reasons: [] }, ok);
  }
});

test('the Head-SHA must be exactly one full 40-character commit hash', () => {
  const reasons = (text, head = SHA) => reviewDecision(parseReview(text), head).reasons.join('\n');
  assert.match(reasons(`Verdict: PASS\nHead-SHA: ${SHA}abcd`), /not exactly "Head-SHA: <40-character commit>"/);
  assert.match(reasons(`Verdict: PASS\nHead-SHA: ${SHA}\nHead-SHA: ${OTHER}`), /2 Head-SHA lines/);
  assert.match(reasons(`Verdict: PASS\nHead-SHA: \`${SHA}\``), /^$/);
  assert.match(reviewDecision(parseReview(`Verdict: PASS\nHead-SHA: ${SHA}`), undefined).reasons.join(), /current head of the PR is unknown/);
});

test('a review of an older head is stale once new commits are pushed', () => {
  const decision = reviewDecision(parseReview(`Verdict: PASS\nHead-SHA: ${OTHER}`), SHA);
  assert.equal(decision.state, 'failure');
  assert.match(decision.reasons.join(), /review the new commits/);
});

test('a verdict inside a code fence is ignored, but a BLOCKER tag inside one still counts', () => {
  const review = parseReview(`Verdict: FAIL\nHead-SHA: ${SHA}\n\`\`\`\nVerdict: PASS\n- [BLOCKER] example\n\`\`\``);
  assert.equal(review.verdict, 'FAIL');
  assert.equal(review.openBlockers.length, 1);
  assert.equal(parseReview('**Verdict:** PASS').verdict, 'PASS');
});

test('an unclosed code fence fails the review instead of hiding the findings after it', () => {
  const text = `## Agent review for #1\n\nVerdict: PASS\nHead-SHA: ${SHA}\n\n### Findings\n- [MAJOR] a.js:1 example:\n\`\`\`js\nconst x = 1;\n- [BLOCKER] scripts/x.mjs:1 token is logged\n`;
  const decision = reviewDecision(parseReview(text), SHA);
  assert.equal(decision.state, 'failure');
  assert.match(decision.reasons.join('\n'), /code fence opened on line 8 is never closed/);
  assert.match(decision.reasons.join('\n'), /1 open BLOCKER/);
});

test('a code fence closes only on the same character, at least as long, with nothing after it', () => {
  const head = `Verdict: PASS\nHead-SHA: ${SHA}\n`;
  // A ``` line inside a ~~~ block does not close it, so the block ends at the second ~~~.
  const tilde = parseReview(`${head}~~~\n\`\`\`\n~~~\n- [BLOCKER] after the block\n`);
  assert.deepEqual(tilde.problems, []);
  assert.equal(tilde.openBlockers.length, 1);
  // A four-backtick fence is not closed by three backticks: the fence stays open.
  assert.match(parseReview(`${head}\`\`\`\`\n\`\`\`\n`).problems.join(), /never closed/);
  // A line with an info string cannot close a fence.
  assert.match(parseReview(`${head}\`\`\`\n\`\`\` js\n`).problems.join(), /never closed/);
  // Inline code that starts with three backticks is not a fence.
  assert.deepEqual(parseReview(`${head}\`\`\`x\`\`\` is inline\n`).problems, []);
  assert.equal(reviewDecision(parseReview(`${head}~~~\n\`\`\`\n~~~\n`), SHA).state, 'success');
});

test('check runs and commit statuses are normalized, keeping the latest run per name', () => {
  const checks = normalizeChecks([
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-01-01T00:00:00Z' },
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-01-01T01:00:00Z' },
    { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'StatusContext', context: 'agent-review', state: 'SUCCESS' }
  ]);
  assert.deepEqual(checks.map(({ name, state }) => [name, state]), [['test', 'success'], ['e2e', 'pending'], ['agent-review', 'success']]);
});

test('a queued re-run with no start time replaces an older finished run', () => {
  const checks = normalizeChecks([
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-01-01T00:00:00Z' },
    { __typename: 'CheckRun', name: 'test', status: 'QUEUED', conclusion: '' }
  ]);
  assert.deepEqual(checks.map(({ name, state }) => [name, state]), [['test', 'pending']]);
});

test('every required check must be green, and any other failed check blocks too', () => {
  const green = REQUIRED_CHECKS.map((name) => ({ name, state: 'success' }));
  assert.deepEqual(evaluateChecks(green), { ok: true, problems: [] });
  const missingReview = green.filter((check) => check.name !== 'agent-review');
  assert.match(evaluateChecks(missingReview).problems.join(), /"agent-review" has not reported/);
  const extraFailure = [...green, { name: 'codeql', state: 'failure' }];
  assert.match(evaluateChecks(extraFailure).problems.join(), /"codeql" failed/);
  assert.match(evaluateChecks(green.map((c) => (c.name === 'e2e' ? { ...c, state: 'pending' } : c))).problems.join(), /"e2e" is pending/);
  assert.ok(CI_CHECKS.every((name) => REQUIRED_CHECKS.includes(name)));
});

// ---- The merge and release gate over one commit's checks ----------------------------------------

const OWNER = 'ALuhning';
const CI_SUITE = 101;
const ciWorkflowRun = { id: 1, name: 'CI', path: '.github/workflows/ci.yml', event: 'pull_request', status: 'completed', conclusion: 'success', suiteId: CI_SUITE };
const ciRun = (name, extra = {}) => ({ id: name.length, name, status: 'completed', conclusion: 'success', startedAt: '2026-01-01T00:00:00Z', app: 'github-actions', suiteId: CI_SUITE, ...extra });
const ownerReview = (state = 'success', extra = {}) => ({ id: 1, context: 'agent-review', state, createdAt: '2026-01-01T01:00:00Z', creator: OWNER, ...extra });
const greenCommit = () => ({ checkRuns: CI_CHECKS.map((name) => ciRun(name)), workflowRuns: [ciWorkflowRun], statuses: [ownerReview()] });
const gate = (commit, options = {}) => evaluateCommit(commit, { reviewer: OWNER, ...options });

test('the gate passes green CI jobs from the CI workflow and the owner\'s agent-review status', () => {
  assert.deepEqual(gate(greenCommit()), { ok: true, problems: [], waiting: false });
  assert.equal(gate({ ...greenCommit(), statuses: [] }, { required: CI_CHECKS }).ok, true, 'CI only needs no review');
});

test('agent-review counts only as a commit status set by the expected account', () => {
  const asCheckRun = { ...greenCommit(), checkRuns: [...greenCommit().checkRuns, ciRun('agent-review', { suiteId: 202 })], statuses: [] };
  assert.match(gate(asCheckRun).problems.join('\n'), /check run named "agent-review"/);
  const checkRunOverFailure = { ...asCheckRun, statuses: [ownerReview('failure')] };
  assert.equal(gate(checkRunOverFailure).ok, false);
  assert.match(gate(checkRunOverFailure).problems.join('\n'), /"agent-review" is failure/);
  const byOther = { ...greenCommit(), statuses: [ownerReview('success', { creator: 'someone-else' })] };
  assert.match(gate(byOther).problems.join('\n'), /set by someone-else/);
  assert.match(gate(byOther).problems.join('\n'), /has not been set on this commit by ALuhning/);
  const otherAfterOwner = { ...greenCommit(), statuses: [ownerReview('success'), ownerReview('success', { id: 2, creator: 'github-actions[bot]' })] };
  assert.equal(gate(otherAfterOwner).ok, false, 'a status from another account refuses even beside the owner\'s');
  assert.match(gate(greenCommit(), { reviewer: undefined }).problems.join('\n'), /account allowed to set "agent-review" is unknown/);
  const newerFailure = { ...greenCommit(), statuses: [ownerReview('success'), ownerReview('failure', { id: 2, createdAt: '2026-01-01T02:00:00Z' })] };
  assert.match(gate(newerFailure).problems.join('\n'), /"agent-review" is failure/);
});

test('a duplicate-named job from outside the CI workflow cannot mask a failing CI job', () => {
  const commit = greenCommit();
  commit.checkRuns = commit.checkRuns.map((run) => (run.name === 'test' ? { ...run, conclusion: 'failure' } : run));
  commit.workflowRuns.push({ id: 2, name: 'Other', path: '.github/workflows/other.yml', event: 'pull_request', suiteId: 303 });
  commit.checkRuns.push(ciRun('test', { suiteId: 303, startedAt: '2026-01-01T05:00:00Z' }));
  const result = gate(commit);
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /required check "test" is failure/);
  assert.match(result.problems.join('\n'), /"test" also comes from .*not the CI workflow/);
  const fromOtherApp = greenCommit();
  fromOtherApp.checkRuns.push(ciRun('lint', { app: 'some-app', suiteId: 404 }));
  assert.match(gate(fromOtherApp).problems.join('\n'), /"lint" also comes from some-app/);
  const workflowNamedCi = greenCommit();
  workflowNamedCi.workflowRuns.push({ id: 3, name: 'CI', path: '.github/workflows/fake.yml', event: 'pull_request', suiteId: 505 });
  workflowNamedCi.checkRuns.push(ciRun('e2e', { suiteId: 505 }));
  assert.equal(gate(workflowNamedCi).ok, false, 'a second workflow named CI in another file does not count');
  const asStatus = { ...greenCommit(), statuses: [ownerReview(), { id: 9, context: 'audit', state: 'success', creator: OWNER }] };
  assert.match(gate(asStatus).problems.join('\n'), /commit status named "audit"/);
});

test('every CI run on the commit must pass; within one run the newest attempt counts', () => {
  const rerun = greenCommit();
  rerun.checkRuns.push(ciRun('e2e', { id: 99, conclusion: 'failure', startedAt: '2025-12-31T00:00:00Z' }));
  assert.equal(gate(rerun).ok, true, 'a re-run that passed replaces the failed attempt');
  const queued = greenCommit();
  queued.checkRuns.push(ciRun('e2e', { id: 98, status: 'queued', conclusion: null, startedAt: null }));
  assert.deepEqual(gate(queued), { ok: false, problems: ['required check "e2e" is still running'], waiting: true });
  const twoRuns = greenCommit();
  twoRuns.workflowRuns.push({ ...ciWorkflowRun, id: 2, event: 'workflow_dispatch', suiteId: 606 });
  twoRuns.checkRuns.push(ciRun('test', { suiteId: 606, conclusion: 'failure' }));
  assert.match(gate(twoRuns).problems.join('\n'), /required check "test" is failure/);
  const missing = { ...greenCommit(), checkRuns: greenCommit().checkRuns.filter((run) => run.name !== 'audit') };
  assert.deepEqual(gate(missing), { ok: false, problems: ['required check "audit" has not reported from the CI workflow on this commit'], waiting: true });
  const otherFailure = greenCommit();
  otherFailure.checkRuns.push(ciRun('codeql', { app: 'github-code-scanning', suiteId: 707, conclusion: 'failure' }));
  assert.match(gate(otherFailure).problems.join('\n'), /check "codeql" failed/);
  const extraRequired = greenCommit();
  assert.match(gate(extraRequired, { required: [...REQUIRED_CHECKS, 'codeql'] }).problems.join('\n'), /"codeql" has not reported/);
});

test('a release commit on main needs CI; a hotfix head also needs the owner\'s agent-review', () => {
  assert.deepEqual(releaseGate({ version: '1.2.3', sha: SHA, onMain: true }), { ok: true, hotfix: false, required: CI_CHECKS });
  assert.deepEqual(releaseGate({ version: '1.2.3', sha: SHA, onMain: false, hotfixHead: SHA }), { ok: true, hotfix: true, required: REQUIRED_CHECKS });
  const stray = releaseGate({ version: '1.2.3', sha: SHA, onMain: false, hotfixHead: OTHER });
  assert.equal(stray.ok, false);
  assert.match(stray.reason, /neither on main nor the head of hotfix\/1\.2\.3/);
  assert.equal(releaseGate({ version: '1.2.3', sha: SHA, onMain: false }).ok, false);
});

test('tagging needs a CI run that tested the commit itself, not only a pull request merge', () => {
  const prOnly = greenCommit();
  assert.match(gate(prOnly, { exactCommitCi: true }).problems.join('\n'), /gh workflow run ci\.yml/);
  assert.equal(gate(prOnly, { exactCommitCi: true }).waiting, false);
  const dispatched = greenCommit();
  dispatched.workflowRuns.push({ ...ciWorkflowRun, id: 2, event: 'workflow_dispatch', suiteId: 808 });
  dispatched.checkRuns.push(...CI_CHECKS.map((name) => ciRun(name, { suiteId: 808 })));
  assert.equal(gate(dispatched, { exactCommitCi: true }).ok, true);
  const notStarted = { checkRuns: [], workflowRuns: [], statuses: [] };
  assert.equal(gate(notStarted, { required: CI_CHECKS, exactCommitCi: true }).waiting, true, 'CI that has not started yet is waited for');
});

/** A green PR run plus a CI run on the commit itself (workflow_dispatch) with the given jobs. */
function withExactRun(run, jobs = CI_CHECKS.map((name) => ciRun(name, { suiteId: 909 }))) {
  const commit = greenCommit();
  commit.workflowRuns.push({ ...ciWorkflowRun, id: 77, event: 'workflow_dispatch', suiteId: 909, ...run });
  commit.checkRuns.push(...jobs);
  return commit;
}

test('tagging needs the CI run on the commit itself to have finished with every job green', () => {
  const exact = (commit) => gate(commit, { exactCommitCi: true });
  // Reproduced in review: a green PR run plus a dispatched run that has no jobs yet passed.
  const queued = exact(withExactRun({ status: 'queued', conclusion: null }, []));
  assert.equal(queued.ok, false);
  assert.equal(queued.waiting, true, 'a queued run is waited for');
  assert.match(queued.problems.join('\n'), /run 77 .*queued/);
  const running = exact(withExactRun({ status: 'in_progress', conclusion: null }, CI_CHECKS.map((name) => ciRun(name, { suiteId: 909, status: 'in_progress', conclusion: null }))));
  assert.deepEqual([running.ok, running.waiting], [false, true]);
  for (const conclusion of ['startup_failure', 'cancelled', 'failure', 'timed_out']) {
    const result = exact(withExactRun({ conclusion }, conclusion === 'startup_failure' ? [] : undefined));
    assert.equal(result.ok, false, conclusion);
    assert.equal(result.waiting, false, `${conclusion} is refused, not waited for`);
    assert.match(result.problems.join('\n'), new RegExp(`run 77 .*${conclusion}.*gh run rerun 77`), conclusion);
  }
  const failedJob = exact(withExactRun({}, CI_CHECKS.map((name) => ciRun(name, { suiteId: 909, conclusion: name === 'e2e' ? 'failure' : 'success' }))));
  assert.equal(failedJob.ok, false, 'a failed job refuses even if the run reports success');
  assert.match(failedJob.problems.join('\n'), /"e2e" is failure/);
  const cancelledJob = exact(withExactRun({}, CI_CHECKS.map((name) => ciRun(name, { suiteId: 909, conclusion: name === 'audit' ? 'cancelled' : 'success' }))));
  assert.match(cancelledJob.problems.join('\n'), /"audit" is cancelled/, 'cancelled is reported as cancelled');
  const missingJob = exact(withExactRun({}, CI_CHECKS.filter((name) => name !== 'lint').map((name) => ciRun(name, { suiteId: 909 }))));
  assert.deepEqual([missingJob.ok, missingJob.waiting], [false, false], 'a finished run that never ran a job is refused');
  assert.equal(exact(withExactRun({})).ok, true, 'a finished, green run on the commit passes');
});

test('for tagging only the newest run on the commit itself counts, not pull request runs', () => {
  const exact = (commit) => gate(commit, { exactCommitCi: true });
  // A hotfix whose PR run (its merge with main) failed, while CI on the hotfix head passed.
  const prFailed = withExactRun({});
  prFailed.checkRuns = prFailed.checkRuns.map((run) => (run.suiteId === CI_SUITE && run.name === 'test' ? { ...run, conclusion: 'failure' } : run));
  assert.equal(exact(prFailed).ok, true);
  assert.equal(gate(prFailed).ok, false, 'the merge gate still needs every run green');
  // A newer run on the commit that failed wins over an older one that passed.
  const newerFailure = withExactRun({});
  newerFailure.workflowRuns.push({ ...ciWorkflowRun, id: 78, event: 'workflow_dispatch', conclusion: 'failure', suiteId: 910 });
  newerFailure.checkRuns.push(...CI_CHECKS.map((name) => ciRun(name, { suiteId: 910, conclusion: name === 'test' ? 'failure' : 'success' })));
  assert.match(exact(newerFailure).problems.join('\n'), /run 78 .*failure/);
});

test('a failed CI job names its run and how to re-run it', () => {
  const commit = greenCommit();
  commit.checkRuns = commit.checkRuns.map((run) => (run.name === 'e2e' ? { ...run, conclusion: 'cancelled' } : run));
  const message = gate(commit).problems.join('\n');
  assert.match(message, /"e2e" is cancelled in CI run 1 \(gh run rerun 1 --failed\)/);
});

test('a release PR is checked before it merges, not only when it is tagged afterwards', () => {
  const changelog = '# Changelog\n\n## 1.2.3\n\nFixes.\n';
  assert.deepEqual(releasePrProblems({ version: '1.2.3', pkgVersion: '1.2.3', changelog }), []);
  assert.match(releasePrProblems({ version: '1.2.3', pkgVersion: '1.2.2', changelog }).join(), /package\.json on the branch is 1\.2\.2/);
  assert.match(releasePrProblems({ version: '1.2.3', pkgVersion: '1.2.3', changelog: '# Changelog\n' }).join(), /no "## 1\.2\.3" section/);
  const tagged = { version: '1.2.3', pkgVersion: '1.2.3', changelog, existingTag: SHA };
  assert.match(releasePrProblems(tagged).join(), /v1\.2\.3 already exists on aaaaaaa.*--no-tag/);
  assert.deepEqual(releasePrProblems({ ...tagged, noTag: true }), [], 'a hotfix tagged from its branch merges with --no-tag');
});

test('the merge result must be MERGED with a full squash commit hash before anything is tagged', () => {
  assert.equal(mergeOutcomeProblem('MERGED', SHA), undefined);
  assert.match(mergeOutcomeProblem('OPEN', SHA), /OPEN/);
  assert.match(mergeOutcomeProblem('MERGED', ''), /squash commit/);
  assert.match(mergeOutcomeProblem('MERGED', 'null'), /squash commit/);
});

test('branch names follow the convention', () => {
  for (const name of ['feat/team-mode', 'fix/proxy-hint', 'chore/dev-workflow', 'docs/readme', 'release/0.4.12', 'hotfix/0.4.13']) assert.ok(BRANCH_PATTERN.test(name), name);
  for (const name of ['main', 'feature/x', 'release/next', 'fix/', 'Fix/Thing', 'hotfix/0.4']) assert.ok(!BRANCH_PATTERN.test(name), name);
  assert.equal(releaseVersionFromBranch('release/1.2.3'), '1.2.3');
  assert.equal(releaseVersionFromBranch('hotfix/1.2.4'), '1.2.4');
  assert.equal(releaseVersionFromBranch('feat/1.2.3'), undefined);
});

test('the changelog section for a version is extracted without its heading', () => {
  const md = '# Changelog\n\n## 0.4.12\n\nNew things.\n\n- one\n\n## 0.4.11\n\nOld things.\n';
  assert.equal(changelogSection(md, '0.4.12'), 'New things.\n\n- one\n');
  assert.equal(changelogSection(md, '0.4.11'), 'Old things.\n');
  assert.equal(changelogSection(md, '0.4.1'), undefined);
});

test('version bumps must go up', () => {
  assert.ok(isVersionBump('0.4.11', '0.4.12'));
  assert.ok(isVersionBump('0.4.11', '0.5.0'));
  assert.ok(!isVersionBump('0.4.11', '0.4.11'));
  assert.ok(!isVersionBump('0.4.11', '0.4.9'));
  assert.ok(!isVersionBump('0.4.11', 'v0.4.12'));
});

test('the last release is the highest v<x.y.z> tag listed by git ls-remote', () => {
  const refs = [`${SHA}\trefs/tags/v0.4.9`, `${OTHER}\trefs/tags/v0.4.12`, `${SHA}\trefs/tags/v0.4.10`, `${SHA}\trefs/tags/v1.0.0-rc.1`, `${SHA}\trefs/tags/latest`, ''].join('\n');
  assert.equal(latestReleaseVersion(refs), '0.4.12');
  assert.equal(latestReleaseVersion(''), undefined);
});

test('long review comments are truncated to fit GitHub', () => {
  const body = fitComment('x'.repeat(70_000));
  assert.ok(body.length <= 65_000);
  assert.match(body, /Truncated/);
});

test('truncating a review keeps its verdict and the footer with the head marker', () => {
  const review = `Verdict: PASS\nHead-SHA: ${SHA}\n${'- [NIT] long finding\n'.repeat(5_000)}`;
  const footer = `---\n**agent-review: success.**\n\n<!-- agent-review head=${SHA} state=success -->`;
  const body = fitComment(review, footer);
  assert.ok(body.length <= 65_000);
  assert.ok(body.startsWith(`Verdict: PASS\nHead-SHA: ${SHA}\n`));
  assert.ok(body.endsWith(footer));
  assert.match(body, /Truncated/);
  assert.equal(fitComment('short', footer), `short\n\n${footer}`);
});

test('the secret scan catches common key formats and masks them in its output', () => {
  const gh = ['ghp', '_', 'Z'.repeat(36)].join('');
  const near = ['ed25519', ':', '3'.repeat(88)].join('');
  const pem = ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ');
  const aws = ['AKIA', 'Q'.repeat(16)].join('');
  assert.deepEqual(scanLine(`token = "${gh}"`), ['github-token']);
  assert.deepEqual(scanLine(near), ['near-private-key']);
  assert.deepEqual(scanLine(pem), ['private-key']);
  assert.deepEqual(scanLine(aws), ['aws-access-key']);
  assert.deepEqual(scanLine(`${gh} // secret-scan: allow`), []);
  assert.deepEqual(scanLine('ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp'), [], 'a NEAR public key is not a secret');
  const masked = maskLine(`token = "${gh}"`);
  assert.ok(!masked.includes(gh));
  assert.match(masked, /redacted 40 chars/);
});

test('committed credential files are flagged by name', () => {
  for (const path of ['.env', 'app/.env.production', 'id_rsa', 'home/.near-credentials/mainnet/a.json', 'cert.p12']) assert.ok(isSecretFileName(path), path);
  for (const path of ['.env.example', 'src/env.ts', 'docs/id_rsa.md']) assert.ok(!isSecretFileName(path), path);
});

test('the allowlist names, per path, only the rules its fake keys may match', () => {
  const allow = parseAllowlist('# header\nsrc/a.ts   github-token,openai-key   # fake keys\n\n test/b.pem private-key\n');
  assert.deepEqual([...allow].map(([path, rules]) => [path, [...rules]]), [['src/a.ts', ['github-token', 'openai-key']], ['test/b.pem', ['private-key']]]);
  assert.throws(() => parseAllowlist('src/a.ts   # no rules named\n'), /names no rules/);
  assert.throws(() => parseAllowlist('src/a.ts not-a-rule\n'), /unknown rule "not-a-rule"/);
});

test('only a 404 from GitHub means "does not exist"; other API errors are raised', () => {
  assert.equal(isNotFound(new Error('gh api repos/o/r/git/ref/tags/v1.0.0 failed: gh: Not Found (HTTP 404)')), true);
  assert.equal(isNotFound(new Error('gh api repos/o/r/git/ref/tags/v1.0.0 failed: gh: Bad credentials (HTTP 401)')), false);
  assert.equal(isNotFound(new Error('gh api ... failed: error connecting to api.github.com')), false);
});
