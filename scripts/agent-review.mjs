#!/usr/bin/env node
// The `agent-review` gate. The owner's agents act as the owner's GitHub account, so they cannot
// approve a PR the owner opened. Instead the review team's result is recorded as a commit status
// named `agent-review` on the PR's head commit, which branch protection requires.
//
//   node scripts/agent-review.mjs gather <pr> [--out <dir>] [--repo owner/name]
//       Writes what reviewers need into <dir>: pr.json, diff.patch, checks.json, files.txt.
//   node scripts/agent-review.mjs submit <pr> --review <file.md> [--repo owner/name] [--dry-run]
//       Posts the review file as a PR comment and sets `agent-review` on the head commit:
//       success only if the file says "Verdict: PASS", names the current head in "Head-SHA:",
//       and has no open [BLOCKER] finding. Anything else sets failure.
//
// See docs/development-workflow.md and .claude/commands/review-pr.md.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fail, gh, parseArgs, resolveRepo, viewPr } from './lib/gh.mjs';
import { AGENT_REVIEW_CONTEXT, CI_CHECKS, evaluateChecks, fitComment, normalizeChecks, parseReview, reviewDecision } from './lib/workflow.mjs';

const usage = 'usage: agent-review.mjs gather <pr> [--out dir] | submit <pr> --review <file.md> [--dry-run]  (both accept --repo owner/name)';

function checkSummary(checks) {
  const lines = checks
    .filter((check) => check.name !== AGENT_REVIEW_CONTEXT)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((check) => `| ${check.name} | ${check.state} |`);
  const ci = evaluateChecks(checks, CI_CHECKS);
  return { table: ['| Check | State |', '| --- | --- |', ...lines].join('\n'), ci };
}

function gather(repo, number, out) {
  const pr = viewPr(repo, number);
  const dir = out ?? mkdtempSync(path.join(tmpdir(), `agent-review-${repo.replace('/', '-')}-${number}-`));
  mkdirSync(dir, { recursive: true });
  const checks = normalizeChecks(pr.statusCheckRollup);
  const { statusCheckRollup, ...rest } = pr;
  writeFileSync(path.join(dir, 'pr.json'), `${JSON.stringify(rest, null, 2)}\n`);
  writeFileSync(path.join(dir, 'checks.json'), `${JSON.stringify(checks, null, 2)}\n`);
  writeFileSync(path.join(dir, 'files.txt'), `${pr.files.map((file) => file.path).join('\n')}\n`);
  writeFileSync(path.join(dir, 'diff.patch'), gh(['pr', 'diff', String(number), '--repo', repo]));
  const { table, ci } = checkSummary(checks);
  console.log(`PR #${pr.number}: ${pr.title}`);
  console.log(`${pr.headRefName} -> ${pr.baseRefName} @ ${pr.headRefOid}`);
  console.log(`${pr.files.length} files, +${pr.additions} -${pr.deletions}`);
  console.log(table);
  console.log(ci.ok ? 'CI: all required jobs passed.' : `CI is not green yet:\n- ${ci.problems.join('\n- ')}`);
  console.log(`Wrote pr.json, checks.json, files.txt and diff.patch to ${dir}`);
  console.log(`Head-SHA for the review file: ${pr.headRefOid}`);
}

function submit(repo, number, reviewPath, dryRun) {
  if (!reviewPath) fail(`--review <file.md> is required\n${usage}`);
  const text = readFileSync(reviewPath, 'utf8');
  const pr = viewPr(repo, number);
  if (pr.state !== 'OPEN') fail(`PR #${number} is ${pr.state}; only open PRs are reviewed`);
  const review = parseReview(text);
  const decision = reviewDecision(review, pr.headRefOid);
  const { table, ci } = checkSummary(normalizeChecks(pr.statusCheckRollup));
  const verdictLine = decision.state === 'success'
    ? '**agent-review: success.** The review passed with no open blockers.'
    : `**agent-review: failure.**\n${decision.reasons.map((reason) => `- ${reason}`).join('\n')}`;
  const body = fitComment(text.trim(), [
    '---',
    verdictLine,
    '',
    `<details><summary>CI on ${pr.headRefOid.slice(0, 7)} when this review was submitted${ci.ok ? ' (all green)' : ' (not all green)'}</summary>`,
    '',
    table,
    '</details>',
    '',
    `<!-- agent-review head=${pr.headRefOid} state=${decision.state} -->`
  ].join('\n'));

  const counts = review.counts;
  const description = (decision.state === 'success'
    ? `PASS: ${counts.major} major, ${counts.minor} minor, ${counts.nit} nit, ${counts.resolved} resolved`
    : `FAIL: ${decision.reasons[0]}`).slice(0, 140);

  if (dryRun) {
    console.log(body);
    console.log(`\n[dry run] would set ${AGENT_REVIEW_CONTEXT}=${decision.state} on ${pr.headRefOid}: ${description}`);
    return;
  }
  const commentDir = mkdtempSync(path.join(tmpdir(), 'agent-review-comment-'));
  let commentUrl;
  try {
    const commentFile = path.join(commentDir, 'comment.md');
    writeFileSync(commentFile, body, { mode: 0o600 });
    commentUrl = gh(['pr', 'comment', String(number), '--repo', repo, '--body-file', commentFile]).trim().split(/\s+/).pop();
  } finally {
    rmSync(commentDir, { recursive: true, force: true });
  }
  const args = ['api', '-X', 'POST', `repos/${repo}/statuses/${pr.headRefOid}`,
    '-f', `state=${decision.state}`, '-f', `context=${AGENT_REVIEW_CONTEXT}`, '-f', `description=${description}`];
  if (/^https:\/\//.test(commentUrl ?? '')) args.push('-f', `target_url=${commentUrl}`);
  gh(args);
  console.log(`Posted the review: ${commentUrl}`);
  console.log(`Set ${AGENT_REVIEW_CONTEXT}=${decision.state} on ${pr.headRefOid}.`);
  if (decision.state !== 'success') {
    console.log(`Not passing because:\n- ${decision.reasons.join('\n- ')}`);
    process.exitCode = 2;
  }
}

try {
  const { positional, options } = parseArgs(process.argv.slice(2), { string: ['repo', 'out', 'review'], boolean: ['dry-run'] });
  const [command, number] = positional;
  if (!['gather', 'submit'].includes(command) || !/^\d+$/.test(number ?? '')) fail(usage);
  const repo = resolveRepo(options.repo);
  if (command === 'gather') gather(repo, number, options.out);
  else submit(repo, number, options.review, Boolean(options['dry-run']));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
