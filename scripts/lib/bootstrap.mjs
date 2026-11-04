// The one-time bootstrap of the automatic agent review (scripts/bootstrap-agent-review.mjs), as a
// function so it can be tested with a fake gh and a fake model (scripts/test/bootstrap.test.mjs).
//
// GitHub runs workflow_run and workflow_dispatch workflows only from the default branch, so the PR
// that adds .github/workflows/agent-review.yml cannot be reviewed by it. This performs the same
// steps the workflow's `review` and `approve` jobs perform, on the owner's machine, with the
// reviewer identity's token: gather, build the prompt, ask the model, submit, and approve only when
// `agent-review` is success on the current head.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitChecks, currentLogin, gh, viewPr } from './gh.mjs';
import { gatherReview, submitReview } from './review.mjs';
import { AGENT_REVIEW_CONTEXT, REVIEW_ACCOUNT } from './workflow.mjs';

const SCRIPTS = path.resolve(import.meta.dirname, '..');

/** Runs one of this repository's scripts with node and resolves its standard output. */
export function runScript(script, args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => (status === 0 ? resolve(stdout) : reject(new Error(`${script} failed: ${stderr.trim() || `exit ${status}`}`))));
  });
}

/**
 * The approving review's body: the reviewer's "Recommendation" block, so the owner reads it where
 * they act on it. Mirrors the inline script in the workflow's `approve` job.
 */
export function approvalBody(text) {
  const start = text.search(/^#{2,3}\s*Recommendation:/m);
  const end = text.search(/^Verdict:/m);
  const block = start === -1 ? '' : text.slice(start, end === -1 ? undefined : end).trim();
  return `${block || 'Approved by the agent review gate.'}\n\n---\n\`${AGENT_REVIEW_CONTEXT}\` passed on this commit. Findings are in the review comment.`;
}

/** The newest `agent-review` state set on `sha` by REVIEW_ACCOUNT, or 'none'. */
export function reviewerState(repo, sha) {
  const mine = commitChecks(repo, sha).statuses
    .filter((status) => status.context === AGENT_REVIEW_CONTEXT && String(status.creator ?? '').toLowerCase() === REVIEW_ACCOUNT.toLowerCase())
    .sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0) || (b.id ?? 0) - (a.id ?? 0));
  return mine[0]?.state ?? 'none';
}

/**
 * Checks the environment and the identity before anything runs. The token and the model key come
 * only from the environment, never from arguments, so they stay out of shell history and `ps`.
 */
export function checkBootstrapPreconditions(env = process.env) {
  const missing = ['GH_TOKEN', 'REVIEW_MODEL_API_KEY', 'REVIEW_MODEL'].filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. Set them in the environment (GH_TOKEN is ${REVIEW_ACCOUNT}'s token; read secrets with read -s), never as arguments; nothing was run.`);
  }
  const login = currentLogin();
  if (login.toLowerCase() !== REVIEW_ACCOUNT.toLowerCase()) {
    throw new Error(`gh runs as ${login}, but the review must run as ${REVIEW_ACCOUNT}; GH_TOKEN must be ${REVIEW_ACCOUNT}'s token. Nothing was run.`);
  }
  return login;
}

/**
 * gather -> ci-review-prompt -> ci-review-call -> submit -> approve (only when agent-review is
 * success on the current head). Returns { state, approved }. The scratch directory, which holds the
 * model's reply, is always removed.
 */
export async function bootstrapReview(repo, number, { env = process.env, log = console.log, run = runScript } = {}) {
  checkBootstrapPreconditions(env);
  const dir = mkdtempSync(path.join(tmpdir(), `agent-review-bootstrap-${number}-`));
  try {
    gatherReview(repo, number, dir, { log });
    const promptFile = path.join(dir, 'prompt.md');
    writeFileSync(promptFile, await run('ci-review-prompt.mjs', [String(number), '--dir', dir], { env }), { mode: 0o600 });
    log('Asking the review model...');
    const review = await run('ci-review-call.mjs', [promptFile], { env });
    writeFileSync(path.join(dir, 'review.md'), review, { mode: 0o600 });

    const result = submitReview(repo, number, review, { log });
    if (result.state !== 'success') {
      log(`#${number}: ${AGENT_REVIEW_CONTEXT} is ${result.state}, not approving.`);
      return { state: result.state, approved: false, dir };
    }

    // Approve only when the gate itself is green on the current head, as the workflow does: an
    // approval without the status would be a bypass, and a push since the review voids it.
    const head = viewPr(repo, number).headRefOid;
    const state = reviewerState(repo, head);
    if (state !== 'success') {
      log(`#${number}: ${AGENT_REVIEW_CONTEXT} by ${REVIEW_ACCOUNT} is ${state} on the current head ${head.slice(0, 7)}, not approving.`);
      return { state, approved: false, dir };
    }
    const bodyFile = path.join(dir, 'approval.md');
    writeFileSync(bodyFile, approvalBody(review), { mode: 0o600 });
    gh(['pr', 'review', String(number), '--repo', repo, '--approve', '--body-file', bodyFile]);
    log(`#${number}: approved as ${REVIEW_ACCOUNT}.`);
    return { state, approved: true, dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
