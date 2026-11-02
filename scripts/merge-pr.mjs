#!/usr/bin/env node
// The merge agent's gate. Squash-merges a PR only when every gate passes, and refuses with the
// reasons otherwise:
//   - the PR is open, not a draft, targets main, and comes from a branch named by the convention;
//   - every required check (CI jobs plus `agent-review`) is green on the current head commit,
//     and no other check failed;
//   - the branch is up to date with main and GitHub reports it mergeable;
//   - no review conversation is unresolved.
// For a release/x.y.z or hotfix/x.y.z PR it then waits for CI on the squash commit and tags it
// v<x.y.z>, which starts the Release workflow (publishing still waits for the owner).
//
//   node scripts/merge-pr.mjs <pr> [--repo owner/name] [--dry-run] [--no-tag]
import { behindBy, fail, gh, parseArgs, protectedContexts, resolveRepo, unresolvedThreads, viewPr, viewPrSettled } from './lib/gh.mjs';
import { tagRelease } from './lib/release.mjs';
import { BRANCH_PATTERN, REQUIRED_CHECKS, evaluateChecks, normalizeChecks, releaseVersionFromBranch } from './lib/workflow.mjs';

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
  const checks = evaluateChecks(normalizeChecks(pr.statusCheckRollup), required);
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
  if (reasons.length > 0) fail(`Refusing to merge #${number} (${pr.title}):\n- ${reasons.join('\n- ')}`);

  console.log(`All gates pass for #${number} at ${pr.headRefOid.slice(0, 7)}: ${required.join(', ')}.`);
  if (options['dry-run']) { console.log('[dry run] not merging.'); return; }

  // --repo keeps gh from touching local branches (it skips local branch deletion and checkout),
  // so no worktree or local main is changed. --match-head-commit refuses if the head moved.
  gh(['pr', 'merge', String(number), '--repo', repo, '--squash', '--delete-branch', '--match-head-commit', pr.headRefOid, '--subject', `${pr.title} (#${pr.number})`]);
  const merged = viewPr(repo, number);
  const mergeSha = gh(['pr', 'view', String(number), '--repo', repo, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid']).trim();
  console.log(`Merged #${number} as ${mergeSha.slice(0, 7)} (${merged.state}). The branch was deleted.`);

  if (version && !options['no-tag']) {
    console.log(`This is a release PR for ${version}.`);
    await tagRelease(repo, version, mergeSha, { wait: true });
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
