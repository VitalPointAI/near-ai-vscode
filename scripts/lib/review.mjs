// The `agent-review` gate (scripts/agent-review.mjs), as functions so the order of what it posts
// can be tested with a fake gh (scripts/test/review.test.mjs).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { currentLogin, gh, prFilePatches, prFiles, viewPr } from './gh.mjs';
import { AGENT_REVIEW_CONTEXT, REVIEW_ACCOUNT, CI_CHECKS, evaluateChecks, fitComment, normalizeChecks, parseReview, reviewDecision } from './workflow.mjs';

function checkSummary(checks) {
  const lines = checks
    .filter((check) => check.name !== AGENT_REVIEW_CONTEXT)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((check) => `| ${check.name} | ${check.state} |`);
  const ci = evaluateChecks(checks, CI_CHECKS);
  return { table: ['| Check | State |', '| --- | --- |', ...lines].join('\n'), ci };
}

/** True for gh's refusal to return the diff of a PR that changes more files or lines than GitHub serves as one diff. */
export function isDiffTooLarge(error) {
  return /too_large|HTTP 406|exceeded the maximum/i.test(String(error?.message ?? error));
}

/** The most the per-file fallback assembles; files past it keep their header only, so they still show as left out. */
export const MAX_ASSEMBLED_DIFF_BYTES = 16_000_000;

/**
 * The PR's unified diff. GitHub refuses `gh pr diff` above 300 files or 20,000 lines (HTTP 406
 * too_large); the review then builds the same diff from the paginated per-file API, which serves
 * up to 3,000 files. A file GitHub sends no patch for (binary, or itself too large) gets a
 * section saying so, so the reviewer sees it changed and that its content was not shown. The
 * assembled text stops growing at `maxBytes` (later files keep a header saying they were left
 * out), and when the API returned fewer files than the PR changes, a last section says so.
 */
export function prDiff(repo, number, { log = console.log, changedFiles, maxBytes = MAX_ASSEMBLED_DIFF_BYTES } = {}) {
  try {
    return gh(['pr', 'diff', String(number), '--repo', repo]);
  } catch (error) {
    if (!isDiffTooLarge(error)) throw error;
  }
  const entries = prFilePatches(repo, number);
  const sections = [];
  let used = 0;
  let withoutPatch = 0;
  let leftOut = 0;
  for (const entry of entries) {
    const to = entry.filename;
    const from = entry.previous_filename ?? to;
    const header = `diff --git a/${from} b/${to}\n`;
    let section;
    if (typeof entry.patch !== 'string') {
      withoutPatch += 1;
      section = `${header}(${entry.status}: no text diff from GitHub, binary or too large to show)\n`;
    } else {
      const oldName = entry.status === 'added' ? '/dev/null' : `a/${from}`;
      const newName = entry.status === 'removed' ? '/dev/null' : `b/${to}`;
      section = `${header}--- ${oldName}\n+++ ${newName}\n${entry.patch.endsWith('\n') ? entry.patch : `${entry.patch}\n`}`;
      if (used + Buffer.byteLength(section) > maxBytes) {
        leftOut += 1;
        section = `${header}(${entry.status}: left out, the assembled diff reached ${maxBytes} bytes)\n`;
      }
    }
    used += Buffer.byteLength(section);
    sections.push(section);
  }
  const missing = Number.isInteger(changedFiles) && changedFiles > entries.length ? changedFiles - entries.length : 0;
  if (missing) {
    sections.push(`diff --git a/(more files) b/(more files)\n(the PR changes ${changedFiles} files; GitHub listed only ${entries.length}, so the changes to ${missing} file(s) are not shown and not named)\n`);
  }
  log(`GitHub refused the whole diff as too large; built it from the per-file API (${entries.length} files, ${withoutPatch} without a text patch, ${leftOut} left out over the size cap${missing ? `, ${missing} not listed by GitHub` : ''}).`);
  return sections.join('');
}

/** Writes pr.json, checks.json, files.txt and diff.patch for the reviewers into `out` (or a new temp dir). */
export function gatherReview(repo, number, out, { log = console.log } = {}) {
  const pr = viewPr(repo, number);
  const dir = out ?? mkdtempSync(path.join(tmpdir(), `agent-review-${repo.replace('/', '-')}-${number}-`));
  mkdirSync(dir, { recursive: true });
  const checks = normalizeChecks(pr.statusCheckRollup);
  // `gh pr view --json files` may stop at 100 files; the API pages through all of them.
  const files = prFiles(repo, number);
  const { statusCheckRollup, files: _capped, ...rest } = pr;
  writeFileSync(path.join(dir, 'pr.json'), `${JSON.stringify({ ...rest, files: files.map((file) => ({ path: file })) }, null, 2)}\n`);
  writeFileSync(path.join(dir, 'checks.json'), `${JSON.stringify(checks, null, 2)}\n`);
  writeFileSync(path.join(dir, 'files.txt'), `${files.join('\n')}\n`);
  writeFileSync(path.join(dir, 'diff.patch'), prDiff(repo, number, { log, changedFiles: pr.changedFiles }));
  const { table, ci } = checkSummary(checks);
  log(`PR #${pr.number}: ${pr.title}`);
  log(`${pr.headRefName} -> ${pr.baseRefName} @ ${pr.headRefOid}`);
  log(`${files.length} files, +${pr.additions} -${pr.deletions}`);
  log(table);
  log(ci.ok ? 'CI: all required jobs passed.' : `CI is not green yet:\n- ${ci.problems.join('\n- ')}`);
  log(`Wrote pr.json, checks.json, files.txt and diff.patch to ${dir}`);
  log(`Head-SHA for the review file: ${pr.headRefOid}`);
  return dir;
}

function setStatus(repo, sha, state, description, targetUrl) {
  const args = ['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`,
    '-f', `state=${state}`, '-f', `context=${AGENT_REVIEW_CONTEXT}`, '-f', `description=${description.slice(0, 140)}`];
  if (/^https:\/\//.test(targetUrl ?? '')) args.push('-f', `target_url=${targetUrl}`);
  gh(args);
}

/**
 * Posts the review file as a PR comment and sets `agent-review` on the head commit. Throws when
 * the PR is not open, gh does not run as REVIEW_ACCOUNT (near-ai-reviewer), or posting fails.
 *
 * Order matters: `agent-review` is set to pending first, so an older success on the same commit
 * stops counting before anything else happens. If the comment then fails, the status stays
 * pending (the merge gate refuses) rather than leaving an earlier success in place. The final
 * state is set only after the comment is posted.
 *
 * Returns { state, reasons, commentUrl }.
 */
export function submitReview(repo, number, text, { dryRun = false, log = console.log, requireRecommendation = false, reviewedHead } = {}) {
  const pr = viewPr(repo, number);
  if (pr.state !== 'OPEN') throw new Error(`PR #${number} is ${pr.state}; only open PRs are reviewed`);
  // A review takes minutes; the PR can move meanwhile, and the run for the new head reviews it. Posting this one would stamp a verdict about the old head on
  // the new one, overwriting that run's result (both run at once: the workflow's concurrency groups are per head). Say so and post nothing.
  if (reviewedHead && pr.headRefOid !== reviewedHead) {
    log(`#${number}: this review covers ${reviewedHead.slice(0, 7)}, but the head is now ${pr.headRefOid.slice(0, 7)}; nothing was posted, and the run for the new head reviews it.`);
    return { state: 'none', skipped: true, reasons: [] };
  }
  const review = parseReview(text);
  const decision = reviewDecision(review, pr.headRefOid, { requireRecommendation });
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
  const description = decision.state === 'success'
    ? `PASS: ${counts.major} major, ${counts.minor} minor, ${counts.nit} nit, ${counts.resolved} resolved`
    : `FAIL: ${decision.reasons[0]}`;

  // Only the reviewer identity's status counts at merge and release (REVIEW_ACCOUNT), so a status
  // from any other account, the owner's included, would only confuse; refuse before posting
  // anything. The reviewer's token lives only in the agent-review environment, so in practice
  // this runs in .github/workflows/agent-review.yml (or the one-time bootstrap script).
  const login = currentLogin();
  const trusted = login.toLowerCase() === REVIEW_ACCOUNT.toLowerCase();
  if (dryRun) {
    if (!trusted) log(`[dry run] note: gh runs as ${login}, but only ${REVIEW_ACCOUNT}'s ${AGENT_REVIEW_CONTEXT} counts; a real submit would refuse.`);
    log(body);
    log(`\n[dry run] would set ${AGENT_REVIEW_CONTEXT}=${decision.state} on ${pr.headRefOid}: ${description.slice(0, 140)}`);
    return { state: decision.state, reasons: decision.reasons };
  }
  if (!trusted) throw new Error(`gh runs as ${login}, but the merge and release gates trust ${AGENT_REVIEW_CONTEXT} only from ${REVIEW_ACCOUNT}; nothing was posted. The workflow posts it as ${REVIEW_ACCOUNT}; start it from an account that can run workflows here: gh workflow run agent-review.yml -f pr=${number}`);

  setStatus(repo, pr.headRefOid, 'pending', 'Posting the agent review');
  const commentDir = mkdtempSync(path.join(tmpdir(), 'agent-review-comment-'));
  let commentUrl;
  try {
    const commentFile = path.join(commentDir, 'comment.md');
    writeFileSync(commentFile, body, { mode: 0o600 });
    commentUrl = gh(['pr', 'comment', String(number), '--repo', repo, '--body-file', commentFile]).trim().split(/\s+/).pop();
  } catch (error) {
    throw new Error(`the review comment could not be posted, so ${AGENT_REVIEW_CONTEXT} is left pending on ${pr.headRefOid.slice(0, 7)} (the merge gate refuses it); submit again. ${error instanceof Error ? error.message : error}`);
  } finally {
    rmSync(commentDir, { recursive: true, force: true });
  }
  setStatus(repo, pr.headRefOid, decision.state, description, commentUrl);
  log(`Posted the review: ${commentUrl}`);
  log(`Set ${AGENT_REVIEW_CONTEXT}=${decision.state} on ${pr.headRefOid}.`);
  if (decision.state !== 'success') log(`Not passing because:\n- ${decision.reasons.join('\n- ')}`);
  return { state: decision.state, reasons: decision.reasons, commentUrl };
}
