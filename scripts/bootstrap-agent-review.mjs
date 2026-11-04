#!/usr/bin/env node
// One-time bootstrap of the automatic agent review. GitHub runs workflow_run and workflow_dispatch
// workflows only from the default branch, so the PR that adds .github/workflows/agent-review.yml
// cannot be reviewed by that workflow. The owner runs this once, from a checkout of that PR, to do
// locally exactly what the workflow's `review` and `approve` jobs do:
//
//   gather -> ci-review-prompt -> ci-review-call -> submit -> approve (only when agent-review is
//   success on the current head)
//
//   node scripts/bootstrap-agent-review.mjs <pr>
//
// Everything secret comes from the environment, never from arguments:
//   GH_TOKEN               near-ai-reviewer's token (the script refuses any other account)
//   REVIEW_MODEL_API_KEY   the review model's key
//   REVIEW_MODEL           the model id; REVIEW_MODEL_BASE_URL optional (see ci-review-call.mjs)
//   GH_REPO                optional owner/name; defaults to this checkout's repository
//
// Nothing secret is printed. The scratch directory, which holds the model's reply, is removed when
// the script ends. The status and the approval are posted only if the model's verdict passes the
// same gate rules a workflow review is held to. After the bootstrap, reviews run in the workflow.
import { fail, resolveRepo } from './lib/gh.mjs';
import { bootstrapReview, checkBootstrapPreconditions } from './lib/bootstrap.mjs';

const usage = 'usage: GH_TOKEN=... REVIEW_MODEL_API_KEY=... REVIEW_MODEL=... node scripts/bootstrap-agent-review.mjs <pr>  (secrets only from the environment)';

try {
  const args = process.argv.slice(2);
  // Exactly one argument, the PR number: a key passed here would land in shell history and `ps`.
  if (args.length !== 1 || !/^\d+$/.test(args[0])) fail(usage);
  // Refuse a missing secret or the wrong account before anything else runs.
  checkBootstrapPreconditions();
  const result = await bootstrapReview(resolveRepo(), args[0]);
  if (!result.approved) process.exitCode = 2;
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
