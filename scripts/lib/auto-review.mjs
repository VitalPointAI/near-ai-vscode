// The automatic agent review of one PR, as functions: .github/workflows/agent-review.yml runs them
// through scripts/ci-review-run.mjs, and the one-time bootstrap through
// scripts/bootstrap-agent-review.mjs, so both do exactly the same thing. Tested with a fake gh and
// a fake model (scripts/test/auto-review.test.mjs).
//
// reviewPr:  gather -> build the prompt -> ask the model -> submit (sets near-ai-reviewer's
//            `agent-review`). Reports whether the PR changes the gates, which makes the approval
//            wait for the owner (the `agent-review-gates` environment in the workflow).
// approvePr: approves the reviewed commit, only when it is still the PR's head and
//            near-ai-reviewer's newest `agent-review` on it is success.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_DIFF_BYTES, MAX_REVIEW_PARTS, approvalBody, buildReviewPrompt, defuse, splitDiff } from './ci-review.mjs';
import { commitChecks, currentLogin, gh, viewPr } from './gh.mjs';
import { gatherReview, submitReview } from './review.mjs';
import { AGENT_REVIEW_CONTEXT, REVIEW_ACCOUNT, gateFileChanges, parseReview, reviewDecision } from './workflow.mjs';

const SCRIPTS = path.resolve(import.meta.dirname, '..');

/** Runs one of this repository's scripts with node and resolves its standard output. */
export function runScript(script, args, { env = process.env, progress = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    // Passed through as it arrives, so a person sees "still thinking..." and each failed attempt while
    // the model works. The scripts write only counts and plain reasons there, never the prompt or a key.
    child.stderr.on('data', (chunk) => { stderr += chunk; progress?.write(chunk); });
    child.on('error', reject);
    child.on('close', (status) => (status === 0 ? resolve(stdout) : reject(new Error(`${script} failed: ${stderr.trim() || `exit ${status}`}`))));
  });
}

/** The newest `agent-review` state set on `sha` by REVIEW_ACCOUNT, or 'none'. */
export function reviewerState(repo, sha) {
  const mine = commitChecks(repo, sha).statuses
    .filter((status) => status.context === AGENT_REVIEW_CONTEXT && String(status.creator ?? '').toLowerCase() === REVIEW_ACCOUNT.toLowerCase())
    .sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0) || (b.id ?? 0) - (a.id ?? 0));
  return mine[0]?.state ?? 'none';
}

/** Refuses unless GH_TOKEN is set and gh runs as REVIEW_ACCOUNT. */
export function checkReviewerIdentity(env = process.env) {
  if (!env.GH_TOKEN) throw new Error(`GH_TOKEN is not set. Set it in the environment to ${REVIEW_ACCOUNT}'s token (read it with read -s), never as an argument; nothing was run.`);
  const login = currentLogin();
  if (login.toLowerCase() !== REVIEW_ACCOUNT.toLowerCase()) {
    throw new Error(`gh runs as ${login}, but the review must run as ${REVIEW_ACCOUNT}; GH_TOKEN must be ${REVIEW_ACCOUNT}'s token. Nothing was run.`);
  }
  return login;
}

/**
 * Checks the environment and the identity before a review runs. The token and the model key come
 * only from the environment, never from arguments, so they stay out of shell history and `ps`.
 */
export function checkReviewPreconditions(env = process.env) {
  const missing = ['GH_TOKEN', 'REVIEW_MODEL_API_KEY', 'REVIEW_MODEL'].filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. Set them in the environment (GH_TOKEN is ${REVIEW_ACCOUNT}'s token; read secrets with read -s), never as arguments; nothing was run.`);
  }
  return checkReviewerIdentity(env);
}

/**
 * Reviews PR `number` and sets near-ai-reviewer's `agent-review` on the head it reviewed.
 * - expectedHead: the commit CI passed on (workflow_run). The review is skipped when the PR's head
 *   has moved on, since the newer head gets its own CI run and review.
 * Returns { state, skipped, reviewedSha, gateFiles, omitted, approvalBody, dir }. `gateFiles` are
 * the changed files on the gate list (GATE_PATHS); `omitted` the files whose diff did not fit the
 * prompt. Either one means the approval waits for the owner. Throws on a real failure, so the
 * workflow run fails visibly. The scratch directory, which holds the model's reply, is removed.
 */
export async function reviewPr(repo, number, { env = process.env, log = console.log, run = runScript, expectedHead } = {}) {
  checkReviewPreconditions(env);
  const before = viewPr(repo, number);
  if (before.state !== 'OPEN') {
    log(`#${number} is ${before.state}; nothing to review.`);
    return { state: 'none', skipped: true };
  }
  if (expectedHead && before.headRefOid !== expectedHead) {
    log(`#${number}: CI passed on ${expectedHead.slice(0, 7)}, but the head is now ${before.headRefOid.slice(0, 7)}; the run for the new head reviews it.`);
    return { state: 'none', skipped: true };
  }
  const dir = mkdtempSync(path.join(tmpdir(), `agent-review-${number}-`));
  try {
    gatherReview(repo, number, dir, { log });
    const read = (name) => readFileSync(path.join(dir, name), 'utf8');
    const pr = JSON.parse(read('pr.json'));
    const files = read('files.txt').split('\n').map((line) => line.trim()).filter(Boolean);
    const diff = read('diff.patch');
    const { parts, omitted } = splitDiff(diff, MAX_DIFF_BYTES, MAX_REVIEW_PARTS);
    const base = { number, pr, checks: read('checks.json'), files: files.join('\n') };
    if (omitted.length) log(`The diff is too large even for ${MAX_REVIEW_PARTS} parts; left out ${omitted.length} file(s).`);
    let review;
    if (parts.length <= 1) {
      const { prompt } = buildReviewPrompt({ ...base, diff: parts[0]?.diff ?? diff, alsoOmitted: omitted });
      const promptFile = path.join(dir, 'prompt.md');
      writeFileSync(promptFile, prompt, { mode: 0o600 });
      log('Asking the review model...');
      // Model text is posted under the reviewer identity, so mentions are defused first.
      review = defuse(await run('ci-review-call.mjs', [promptFile], { env }), Infinity);
    } else {
      const replies = [];
      for (const [index, part] of parts.entries()) {
        const { prompt } = buildReviewPrompt({ ...base, diff: part.diff, part: { index: index + 1, total: parts.length, files: part.files }, alsoOmitted: omitted });
        const promptFile = path.join(dir, `prompt-${index + 1}.md`);
        writeFileSync(promptFile, prompt, { mode: 0o600 });
        log(`Asking the review model about part ${index + 1} of ${parts.length} (${part.files.length} file(s))...`);
        replies.push(defuse(await run('ci-review-call.mjs', [promptFile], { env }), Infinity));
      }
      review = combinePartReviews(replies, pr.headRefOid, { omitted });
    }
    writeFileSync(path.join(dir, 'review.md'), review, { mode: 0o600 });

    // The head this review read: if the PR moved while the model ran, nothing is posted (submitReview), as for the expectedHead check above.
    const result = submitReview(repo, number, review, { log, requireRecommendation: true, reviewedHead: pr.headRefOid });
    if (result.skipped) return { state: 'none', skipped: true, reviewedSha: pr.headRefOid, gateFiles: [], omitted: [], dir };
    return {
      state: result.state,
      skipped: false,
      reviewedSha: pr.headRefOid,
      gateFiles: gateFileChanges(files),
      omitted,
      approvalBody: approvalBody(review),
      dir
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One review file from the replies of a review done in parts. Each part is judged on its own by the
 * same parseReview and reviewDecision as a whole review; the result passes only when every part
 * passed. Each part's text is kept under its own heading with its Verdict and Head-SHA lines taken
 * out and its Recommendation heading renamed, so the file has exactly one of each; every severity
 * tag stays, so an open BLOCKER in any part still fails the gate.
 */
export function combinePartReviews(replies, headSha, { omitted = [] } = {}) {
  const total = replies.length;
  const reasons = [];
  const sections = replies.map((reply, index) => {
    const decision = reviewDecision(parseReview(reply), headSha, { requireRecommendation: true });
    for (const reason of decision.reasons) reasons.push(`Part ${index + 1}: ${reason}`);
    const body = String(reply ?? '').split(/\r?\n/)
      .filter((line) => !/^ {0,3}[*_`]*(?:verdict|head-sha)[*_`]*\s*:/i.test(line))
      .map((line) => line.replace(/^( {0,3})#{1,6}\s*recommendation\s*:/i, `$1#### Part ${index + 1} recommendation:`))
      .join('\n').trim();
    return `### Part ${index + 1} of ${total}\n\n${body}`;
  });
  const pass = reasons.length === 0;
  return [
    `## Recommendation: ${pass ? 'MERGE' : 'DO NOT MERGE'}`,
    '',
    `This pull request's diff is larger than one review can read, so it was reviewed in ${total} parts, each by its own call. It passes only when every part passed.`,
    ...(reasons.length ? ['', ...reasons.map((reason) => `- ${reason}`)] : []),
    ...(omitted.length ? ['', `- ${omitted.length} file(s) fit in no part and were not reviewed, so this PR waits for the owner.`] : []),
    '',
    ...sections.flatMap((section) => [section, '']),
    `Verdict: ${pass ? 'PASS' : 'FAIL'}`,
    `Head-SHA: ${headSha}`,
    ''
  ].join('\n');
}

/**
 * Approves PR `number` at `reviewedSha` as REVIEW_ACCOUNT. Refuses (returns approved: false) when
 * the head has moved or near-ai-reviewer's newest `agent-review` on it is not success. The approval
 * is pinned to the commit, so a push in between cannot inherit it. Throws when GitHub refuses the
 * approval of a PR that is still open, so a real failure is never hidden.
 */
export function approvePr(repo, number, reviewedSha, { env = process.env, log = console.log, body } = {}) {
  checkReviewerIdentity(env);
  if (!/^[0-9a-f]{40}$/.test(reviewedSha ?? '')) throw new Error(`the reviewed commit "${reviewedSha}" is not a full SHA; nothing was approved`);
  const pr = viewPr(repo, number);
  if (pr.state !== 'OPEN') {
    log(`#${number} is ${pr.state}; nothing to approve.`);
    return { approved: false };
  }
  if (pr.headRefOid !== reviewedSha) {
    log(`#${number}: the head moved from ${reviewedSha.slice(0, 7)} to ${pr.headRefOid.slice(0, 7)} after the review; not approving.`);
    return { approved: false };
  }
  const state = reviewerState(repo, reviewedSha);
  if (state !== 'success') {
    log(`#${number}: ${AGENT_REVIEW_CONTEXT} by ${REVIEW_ACCOUNT} is ${state} on ${reviewedSha.slice(0, 7)}; not approving.`);
    return { approved: false };
  }
  const dir = mkdtempSync(path.join(tmpdir(), `agent-review-approve-${number}-`));
  try {
    const bodyFile = path.join(dir, 'approval.md');
    writeFileSync(bodyFile, body || approvalBody(''), { mode: 0o600 });
    try {
      gh(['api', '-X', 'POST', `repos/${repo}/pulls/${number}/reviews`, '-f', 'event=APPROVE', '-f', `commit_id=${reviewedSha}`, '-F', `body=@${bodyFile}`]);
    } catch (error) {
      // The only failure that is not a failure: the PR closed in the meantime.
      if (viewPr(repo, number).state !== 'OPEN') {
        log(`#${number} closed before the approval; nothing to approve.`);
        return { approved: false };
      }
      throw error;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  log(`#${number}: approved ${reviewedSha.slice(0, 7)} as ${REVIEW_ACCOUNT}.`);
  return { approved: true };
}
