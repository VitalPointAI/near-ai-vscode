#!/usr/bin/env node
// The merge agent's gate. Squash-merges a PR only when every gate passes, and refuses with the
// reasons otherwise:
//   - the PR is open, not a draft, targets main, and comes from a branch named by the convention;
//   - every required check is green on the current head commit, and no other check failed. The
//     CI jobs count only from the CI workflow (a job of the same name from anywhere else refuses)
//     and `agent-review` only as a commit status set by the account this script runs as;
//   - the branch is up to date with main and GitHub reports it mergeable;
//   - no review conversation is unresolved.
// For a release/x.y.z or hotfix/x.y.z PR it first checks the head's package.json version, its
// CHANGELOG section and that v<x.y.z> does not exist yet; after the merge it waits for CI on the
// squash commit and tags it v<x.y.z>, which starts the Release workflow (publishing still waits
// for the owner).
//
//   node scripts/merge-pr.mjs <pr> [--repo owner/name] [--dry-run] [--no-tag]
//
// --no-tag merges a release or hotfix PR without tagging, for a hotfix that was already tagged
// and released from its branch.
import { behindBy, commitChecks, currentLogin, fail, fileAt, gh, ghJson, parseArgs, protectedContexts, resolveRepo, tagCommit, unresolvedThreads, viewPrSettled } from './lib/gh.mjs';
import { tagRelease } from './lib/release.mjs';
import { BRANCH_PATTERN, REQUIRED_CHECKS, evaluateCommit, mergeOutcomeProblem, releasePrProblems, releaseVersionFromBranch } from './lib/workflow.mjs';

const usage = 'usage: merge-pr.mjs <pr> [--repo owner/name] [--dry-run] [--no-tag]';

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2), { string: ['repo'], boolean: ['dry-run', 'no-tag'] });
  const [number] = positional;
  if (!/^\d+$/.test(number ?? '')) fail(usage);
  const repo = resolveRepo(options.repo);
  const pr = await viewPrSettled(repo, number);
  const reasons = [];

  if (pr.state !== 'OPEN') reasons.push(`the PR is ${pr.state}`);
  if (pr.isDraft) reasons.push('the PR is a draft');
  if (pr.baseRefName !== 'main') reasons.push(`the PR targets ${pr.baseRefName}, not main`);
  if (!BRANCH_PATTERN.test(pr.headRefName)) reasons.push(`branch "${pr.headRefName}" does not follow the naming rules (feat|fix|chore|docs/<name>, release|hotfix/x.y.z)`);

  const required = [...new Set([...REQUIRED_CHECKS, ...protectedContexts(repo, pr.baseRefName)])];
  const checks = evaluateCommit(commitChecks(repo, pr.headRefOid), { required, reviewer: currentLogin() });
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
      noTag: Boolean(options['no-tag'])
    }));
  }
  if (reasons.length > 0) fail(`Refusing to merge #${number} (${pr.title}):\n- ${reasons.join('\n- ')}`);

  console.log(`All gates pass for #${number} at ${pr.headRefOid.slice(0, 7)}: ${required.join(', ')}.`);
  if (options['dry-run']) { console.log('[dry run] not merging.'); return; }

  // --repo keeps gh from touching local branches (it skips local branch deletion and checkout),
  // so no worktree or local main is changed. --match-head-commit refuses if the head moved.
  gh(['pr', 'merge', String(number), '--repo', repo, '--squash', '--delete-branch', '--match-head-commit', pr.headRefOid, '--subject', `${pr.title} (#${pr.number})`]);
  let merged;
  let mergeSha;
  let problem;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 3_000));
    merged = ghJson(['pr', 'view', String(number), '--repo', repo, '--json', 'state,mergeCommit']);
    mergeSha = merged?.mergeCommit?.oid;
    problem = mergeOutcomeProblem(merged?.state, mergeSha);
    if (!problem) break;
  }
  if (problem) fail(`The merge of #${number} could not be confirmed: ${problem}. Nothing was tagged; check the PR on GitHub.`);
  console.log(`Merged #${number} as ${mergeSha.slice(0, 7)}. The branch was deleted.`);

  if (version && !options['no-tag']) {
    console.log(`This is a release PR for ${version}.`);
    await tagRelease(repo, version, mergeSha, { wait: true });
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
