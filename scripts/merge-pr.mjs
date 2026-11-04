#!/usr/bin/env node
// The merge agent's gate. Squash-merges a PR only when every gate passes, and refuses with the
// reasons otherwise:
//   - the PR is open, not a draft, targets main, and comes from a branch named by the convention;
//   - every required check is green on the current head commit, and no other check failed. The
//     CI jobs count only from the CI workflow (a job of the same name from anywhere else refuses)
//     and `agent-review` only as a commit status set by the reviewer identity, near-ai-reviewer
//     (REVIEW_ACCOUNT in scripts/lib/workflow.mjs), whoever runs this script;
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
// and released from its branch. The logic is in scripts/lib/merge.mjs.
import { fail, parseArgs, resolveRepo } from './lib/gh.mjs';
import { mergePr } from './lib/merge.mjs';

const usage = 'usage: merge-pr.mjs <pr> [--repo owner/name] [--dry-run] [--no-tag]';

try {
  const { positional, options } = parseArgs(process.argv.slice(2), { string: ['repo'], boolean: ['dry-run', 'no-tag'] });
  const [number] = positional;
  if (!/^\d+$/.test(number ?? '')) fail(usage);
  await mergePr(resolveRepo(options.repo), number, { dryRun: Boolean(options['dry-run']), noTag: Boolean(options['no-tag']) });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
