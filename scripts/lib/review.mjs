// The `agent-review` gate (scripts/agent-review.mjs), as functions so the order of what it posts
// can be tested with a fake gh (scripts/test/review.test.mjs).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gh, prFiles, viewPr } from './gh.mjs';
import { AGENT_REVIEW_ACCOUNT, AGENT_REVIEW_CONTEXT, CI_CHECKS, evaluateChecks, fitComment, normalizeChecks, parseReview, reviewDecision } from './workflow.mjs';

function checkSummary(checks) {
  const lines = checks
    .filter((check) => check.name !== AGENT_REVIEW_CONTEXT)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((check) => `| ${check.name} | ${check.state} |`);
  const ci = evaluateChecks(checks, CI_CHECKS);
  return { table: ['| Check | State |', '| --- | --- |', ...lines].join('\n'), ci };
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
  writeFileSync(path.join(dir, 'diff.patch'), gh(['pr', 'diff', String(number), '--repo', repo]));
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

/**
 * The token the review process posts with. It belongs to the reviewer identity, not the author, so
 * the `agent-review` status is independent of whoever wrote or merged the change (B of the gate
 * hardening). Without it, submit refuses: signing as the author would defeat the gate.
 */
export const REVIEW_TOKEN_ENV = 'NEAR_AI_REVIEW_TOKEN';

function reviewEnv() {
  const token = process.env[REVIEW_TOKEN_ENV]?.trim();
  if (!token) throw new Error(`${REVIEW_TOKEN_ENV} is not set. The agent review must post as the reviewer identity, not as the author; see docs/development-workflow.md ("The agent review gate").`);
  return { ...process.env, GH_TOKEN: token };
}

/** The login the review token belongs to, so the gate's account is checked against the token, not gh's own. */
function reviewLogin() {
  const login = gh(['api', 'user', '--jq', '.login'], { env: reviewEnv() }).trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(login)) throw new Error(`could not read the reviewer account (got ${login})`);
  return login;
}

function setStatus(repo, sha, state, description, targetUrl) {
  const args = ['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`,
    '-f', `state=${state}`, '-f', `context=${AGENT_REVIEW_CONTEXT}`, '-f', `description=${description.slice(0, 140)}`];
  if (/^https:\/\//.test(targetUrl ?? '')) args.push('-f', `target_url=${targetUrl}`);
  gh(args, { env: reviewEnv() });
}

/**
 * Posts the review file as a PR comment and sets `agent-review` on the head commit. Throws when
 * the PR is not open, gh does not run as AGENT_REVIEW_ACCOUNT, or posting fails.
 *
 * Order matters: `agent-review` is set to pending first, so an older success on the same commit
 * stops counting before anything else happens. If the comment then fails, the status stays
 * pending (the merge gate refuses) rather than leaving an earlier success in place. The final
 * state is set only after the comment is posted.
 *
 * Returns { state, reasons, commentUrl }.
 */
export function submitReview(repo, number, text, { dryRun = false, log = console.log } = {}) {
  const pr = viewPr(repo, number);
  if (pr.state !== 'OPEN') throw new Error(`PR #${number} is ${pr.state}; only open PRs are reviewed`);
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
  const description = decision.state === 'success'
    ? `PASS: ${counts.major} major, ${counts.minor} minor, ${counts.nit} nit, ${counts.resolved} resolved`
    : `FAIL: ${decision.reasons[0]}`;

  // Only the reviewer identity's status counts at merge and release (AGENT_REVIEW_ACCOUNT). The
  // token is checked, not gh's own account, so the author running this cannot certify their work.
  const login = dryRun && !process.env[REVIEW_TOKEN_ENV]?.trim() ? `(no ${REVIEW_TOKEN_ENV})` : reviewLogin();
  const trusted = login.toLowerCase() === AGENT_REVIEW_ACCOUNT.toLowerCase();
  if (dryRun) {
    if (!trusted) log(`[dry run] note: the review token belongs to ${login}, but only ${AGENT_REVIEW_ACCOUNT}'s ${AGENT_REVIEW_CONTEXT} counts; a real submit would refuse.`);
    log(body);
    log(`\n[dry run] would set ${AGENT_REVIEW_CONTEXT}=${decision.state} on ${pr.headRefOid}: ${description.slice(0, 140)}`);
    return { state: decision.state, reasons: decision.reasons };
  }
  if (!trusted) throw new Error(`the review token belongs to ${login}, but the merge and release gates trust ${AGENT_REVIEW_CONTEXT} only from ${AGENT_REVIEW_ACCOUNT}; nothing was posted`);

  setStatus(repo, pr.headRefOid, 'pending', 'Posting the agent review');
  const commentDir = mkdtempSync(path.join(tmpdir(), 'agent-review-comment-'));
  let commentUrl;
  try {
    const commentFile = path.join(commentDir, 'comment.md');
    writeFileSync(commentFile, body, { mode: 0o600 });
    commentUrl = gh(['pr', 'comment', String(number), '--repo', repo, '--body-file', commentFile], { env: reviewEnv() }).trim().split(/\s+/).pop();
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
