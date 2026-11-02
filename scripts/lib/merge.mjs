// The merge agent's gate (scripts/merge-pr.mjs), as a function so it can be tested with a fake
// gh (scripts/test/merge.test.mjs). See merge-pr.mjs for what it checks.
import { behindBy, commitChecks, fileAt, gh, ghJson, protectedContexts, sleep, tagCommit, unresolvedThreads, viewPrSettled } from './gh.mjs';
import { tagRelease } from './release.mjs';
import { AGENT_REVIEW_ACCOUNT, BRANCH_PATTERN, REQUIRED_CHECKS, evaluateCommit, mergeOutcomeProblem, releasePrProblems, releaseVersionFromBranch } from './workflow.mjs';

/**
 * Checks every gate for PR `number` and, unless dryRun, squash-merges it and tags a release PR.
 * Throws an Error listing every reason when a gate refuses, or when the merge cannot be
 * confirmed. Returns { merged, mergeSha, tag }. `wait` and `ci` (options for waitForCi) are for
 * tests.
 */
export async function mergePr(repo, number, { dryRun = false, noTag = false, log = console.log, wait = sleep, ci = {} } = {}) {
  const pr = await viewPrSettled(repo, number, { wait });
  const reasons = [];

  if (pr.state !== 'OPEN') reasons.push(`the PR is ${pr.state}`);
  if (pr.isDraft) reasons.push('the PR is a draft');
  if (pr.baseRefName !== 'main') reasons.push(`the PR targets ${pr.baseRefName}, not main`);
  if (!BRANCH_PATTERN.test(pr.headRefName)) reasons.push(`branch "${pr.headRefName}" does not follow the naming rules (feat|fix|chore|docs/<name>, release|hotfix/x.y.z)`);

  const required = [...new Set([...REQUIRED_CHECKS, ...protectedContexts(repo, pr.baseRefName)])];
  const checks = evaluateCommit(commitChecks(repo, pr.headRefOid), { required, reviewer: AGENT_REVIEW_ACCOUNT });
  reasons.push(...checks.problems);

  const position = behindBy(repo, pr.baseRefName, pr.headRefOid);
  if (position.behind > 0) reasons.push(`the branch is ${position.behind} commit(s) behind ${pr.baseRefName}; update it (gh pr update-branch ${number} --rebase) and let CI and the agent review run again`);
  if (pr.mergeable === 'CONFLICTING') reasons.push('the branch has merge conflicts with main');
  else if (pr.mergeable !== 'MERGEABLE') reasons.push(`GitHub has not confirmed the PR is mergeable (${pr.mergeable})`);
  if (['DIRTY', 'BLOCKED', 'BEHIND', 'UNSTABLE', 'DRAFT'].includes(pr.mergeStateStatus) && reasons.length === 0) {
    reasons.push(`GitHub reports the merge state as ${pr.mergeStateStatus}`);
  }

  const threads = unresolvedThreads(repo, number);
  if (threads.length > 0) reasons.push(`${threads.length} review conversation(s) are unresolved`);

  const version = releaseVersionFromBranch(pr.headRefName);
  if (version) {
    reasons.push(...releasePrProblems({
      version,
      pkgVersion: JSON.parse(fileAt(repo, 'package.json', pr.headRefOid)).version,
      changelog: fileAt(repo, 'CHANGELOG.md', pr.headRefOid),
      existingTag: tagCommit(repo, `v${version}`),
      noTag
    }));
  }
  if (reasons.length > 0) throw new Error(`Refusing to merge #${number} (${pr.title}):\n- ${reasons.join('\n- ')}`);

  log(`All gates pass for #${number} at ${pr.headRefOid.slice(0, 7)}: ${required.join(', ')}.`);
  if (dryRun) { log('[dry run] not merging.'); return { merged: false }; }

  // --repo keeps gh from touching local branches (it skips local branch deletion and checkout),
  // so no worktree or local main is changed. --match-head-commit refuses if the head moved.
  gh(['pr', 'merge', String(number), '--repo', repo, '--squash', '--delete-branch', '--match-head-commit', pr.headRefOid, '--subject', `${pr.title} (#${pr.number})`]);
  let mergeSha;
  let problem;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) await wait(3_000);
    const merged = ghJson(['pr', 'view', String(number), '--repo', repo, '--json', 'state,mergeCommit']);
    mergeSha = merged?.mergeCommit?.oid;
    problem = mergeOutcomeProblem(merged?.state, mergeSha);
    if (!problem) break;
  }
  if (problem) throw new Error(`The merge of #${number} could not be confirmed: ${problem}. Nothing was tagged; check the PR on GitHub.`);
  log(`Merged #${number} as ${mergeSha.slice(0, 7)}. The branch was deleted.`);

  let tag;
  if (version && !noTag) {
    log(`This is a release PR for ${version}.`);
    tag = await tagRelease(repo, version, mergeSha, { wait: true, log, ci: { wait, ...ci } });
  }
  return { merged: true, mergeSha, tag };
}
