#!/usr/bin/env node
// One-time bootstrap of the automatic agent review. GitHub runs workflow_run and workflow_dispatch
// workflows only from the default branch, so the PR that adds .github/workflows/agent-review.yml
// (#12) cannot be reviewed by that workflow. The owner runs this once, from a checkout of that PR,
// to do locally what the workflow's jobs do (scripts/lib/auto-review.mjs, the same code):
//
//   node scripts/bootstrap-agent-review.mjs <pr>
//       review: gather -> prompt -> model -> submit, as near-ai-reviewer. Then approve, if the
//       review passed and the PR does not change the gates. A PR that changes the gates (as #12
//       does) stops here, as the workflow waits for the owner's `agent-review-gates` approval.
//   node scripts/bootstrap-agent-review.mjs <pr> --approve-gates
//       The owner's approval of a gate change, after reading the review comment: approves the
//       current head as near-ai-reviewer, only if near-ai-reviewer's `agent-review` on it is success.
//
// Everything secret comes from the environment, never from arguments:
//   GH_TOKEN               near-ai-reviewer's token (the script refuses any other account)
//   REVIEW_MODEL_API_KEY   the review model's key (not needed for --approve-gates)
//   REVIEW_MODEL           the model id; REVIEW_MODEL_BASE_URL optional (see ci-review-call.mjs)
//   GH_REPO                optional owner/name; defaults to this checkout's repository
//
// Nothing secret is printed, and the scratch directory, which holds the model's reply, is removed.
// Exit 0: approved. Exit 2: not approved (the review failed, or the approval waits for the owner).
import { approvePr, checkReviewPreconditions, checkReviewerIdentity, reviewPr } from './lib/auto-review.mjs';
import { fail, resolveRepo, viewPr } from './lib/gh.mjs';
import { GATE_HOLD_MESSAGE } from './lib/workflow.mjs';

const usage = 'usage: GH_TOKEN=... REVIEW_MODEL_API_KEY=... REVIEW_MODEL=... node scripts/bootstrap-agent-review.mjs <pr> [--approve-gates]  (secrets only from the environment)';

try {
  const args = process.argv.slice(2);
  // Only the PR number and the one flag: a key passed here would land in shell history and `ps`.
  const approveGates = args.length === 2 && args[1] === '--approve-gates';
  if (!(args.length === 1 || approveGates) || !/^\d+$/.test(args[0])) fail(usage);
  const number = args[0];
  // Refuse a missing secret or the wrong account before anything else runs.
  if (approveGates) checkReviewerIdentity(); else checkReviewPreconditions();
  const repo = resolveRepo();

  if (approveGates) {
    const head = viewPr(repo, number).headRefOid;
    const { approved } = approvePr(repo, number, head, {
      body: `The owner approved this change to the review or merge gates after the agent review passed on ${head.slice(0, 7)}. Findings are in the review comment.`
    });
    process.exitCode = approved ? 0 : 2;
  } else {
    const result = await reviewPr(repo, number);
    if (result.skipped || result.state !== 'success') {
      console.log(`#${number}: agent-review is ${result.state}; not approving.`);
      process.exitCode = 2;
    } else if (result.gateFiles.length || result.omitted.length) {
      console.log(GATE_HOLD_MESSAGE);
      for (const file of result.gateFiles) console.log(`- ${file}`);
      if (result.omitted.length) console.log(`The diff was too large for a complete review; ${result.omitted.length} file(s) were not seen.`);
      console.log(`Read the review comment on the PR, then approve as the owner with:\n  node scripts/bootstrap-agent-review.mjs ${number} --approve-gates`);
      process.exitCode = 2;
    } else {
      const { approved } = approvePr(repo, number, result.reviewedSha, { body: result.approvalBody });
      process.exitCode = approved ? 0 : 2;
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
