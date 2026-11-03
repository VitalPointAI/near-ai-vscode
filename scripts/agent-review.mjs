#!/usr/bin/env node
// The `agent-review` gate. The owner's agents act as the owner's GitHub account, so they cannot
// approve a PR the owner opened. Instead the review team's result is recorded as a commit status
// named `agent-review` on the PR's head commit, which branch protection requires.
//
//   node scripts/agent-review.mjs gather <pr> [--out <dir>] [--repo owner/name]
//       Writes what reviewers need into <dir>: pr.json, diff.patch, checks.json, files.txt.
//   node scripts/agent-review.mjs submit <pr> --review <file.md> [--repo owner/name] [--dry-run]
//       Sets `agent-review` to pending, posts the review file as a PR comment, then sets the
//       result on the head commit: success only if the file says "Verdict: PASS", names the
//       current head in "Head-SHA:", and has no open [BLOCKER] finding. Anything else sets
//       failure. Refuses unless gh runs as the owner's account (AGENT_REVIEW_ACCOUNT).
//
// See docs/development-workflow.md and .claude/commands/review-pr.md. The logic is in
// scripts/lib/review.mjs.
import { readFileSync } from 'node:fs';
import { fail, parseArgs, resolveRepo } from './lib/gh.mjs';
import { gatherReview, submitReview } from './lib/review.mjs';

const usage = 'usage: agent-review.mjs gather <pr> [--out dir] | submit <pr> --review <file.md> [--dry-run]  (both accept --repo owner/name)';

try {
  const { positional, options } = parseArgs(process.argv.slice(2), { string: ['repo', 'out', 'review'], boolean: ['dry-run'] });
  const [command, number] = positional;
  if (!['gather', 'submit'].includes(command) || !/^\d+$/.test(number ?? '')) fail(usage);
  const repo = resolveRepo(options.repo);
  if (command === 'gather') gatherReview(repo, number, options.out);
  else {
    if (!options.review) fail(`--review <file.md> is required\n${usage}`);
    const dryRun = Boolean(options['dry-run']);
    const result = submitReview(repo, number, readFileSync(options.review, 'utf8'), { dryRun });
    if (!dryRun && result.state !== 'success') process.exitCode = 2;
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
