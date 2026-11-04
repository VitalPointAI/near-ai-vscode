#!/usr/bin/env node
// The automatic agent review, as .github/workflows/agent-review.yml runs it. The logic is in
// scripts/lib/auto-review.mjs, shared with the one-time scripts/bootstrap-agent-review.mjs.
//
//   node scripts/ci-review-run.mjs review <pr> [--expected-head <sha>]
//       Reviews the PR as near-ai-reviewer and sets `agent-review`. Writes the job outputs to
//       $GITHUB_OUTPUT: state, sha (the reviewed commit), gate (true when the PR changes the gates
//       or its diff did not fit, so the approval waits for the owner), gate_files, body_b64.
//       Exits 0 whenever a review was posted, whatever its verdict.
//   node scripts/ci-review-run.mjs approve <pr> --sha <reviewed sha>
//       Approves the PR at that commit as near-ai-reviewer, only if it is still the head and
//       near-ai-reviewer's `agent-review` on it is success. The body comes from APPROVAL_BODY_B64.
//
// Secrets come only from the environment: GH_TOKEN (near-ai-reviewer's token), REVIEW_MODEL_API_KEY,
// REVIEW_MODEL and optionally REVIEW_MODEL_BASE_URL. GH_REPO names the repository.
import { appendFileSync } from 'node:fs';
import { approvePr, reviewPr } from './lib/auto-review.mjs';
import { defuse } from './lib/ci-review.mjs';
import { fail, parseArgs, resolveRepo } from './lib/gh.mjs';
import { GATE_HOLD_MESSAGE } from './lib/workflow.mjs';

const usage = 'usage: ci-review-run.mjs review <pr> [--expected-head <sha>] | approve <pr> --sha <sha>';
const SHA = /^[0-9a-f]{40}$/;

/** One job output per line; values are made single-line and plain, so they cannot add keys. */
function output(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value ?? '').replace(/[^\w./,=+-]/g, '_')}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

try {
  const { positional, options } = parseArgs(process.argv.slice(2), { string: ['expected-head', 'sha'] });
  const [command, number] = positional;
  if (!['review', 'approve'].includes(command) || !/^\d+$/.test(number ?? '') || positional.length !== 2) fail(usage);
  const repo = resolveRepo();
  if (command === 'review') {
    const expectedHead = options['expected-head'];
    if (expectedHead !== undefined && !SHA.test(expectedHead)) fail('--expected-head must be a full commit SHA');
    const result = await reviewPr(repo, number, { expectedHead });
    const gate = !result.skipped && (result.gateFiles.length > 0 || result.omitted.length > 0);
    if (gate && result.state === 'success') {
      console.log(GATE_HOLD_MESSAGE);
      for (const file of result.gateFiles) console.log(`- ${file}`);
      if (result.omitted.length) console.log(`The diff was too large for a complete review; ${result.omitted.length} file(s) were not seen.`);
    }
    output({
      state: result.state,
      sha: result.reviewedSha ?? '',
      gate: String(gate),
      gate_files: (result.gateFiles ?? []).join(','),
      body_b64: result.approvalBody ? Buffer.from(result.approvalBody).toString('base64') : ''
    });
  } else {
    if (!SHA.test(options.sha ?? '')) fail(`--sha <reviewed commit> is required\n${usage}`);
    const encoded = process.env.APPROVAL_BODY_B64 ?? '';
    const body = encoded ? defuse(Buffer.from(encoded, 'base64').toString('utf8')) : undefined;
    await approvePr(repo, number, options.sha, { body });
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
