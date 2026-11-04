#!/usr/bin/env node
// Builds the prompt an automatic review sends to the model, from the artifacts
// `agent-review.mjs gather` already wrote. The prompt itself is in scripts/lib/ci-review.mjs:
// everything the PR author controls (title, branch, description, file names, diff) is wrapped in
// nonce-delimited blocks the content cannot close, and the model is told it is data, never
// instructions. The diff is capped; files left out are named in the prompt and on stderr.
//
//   node scripts/ci-review-prompt.mjs <pr> --dir <gathered dir>
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildReviewPrompt } from './lib/ci-review.mjs';
import { fail, parseArgs } from './lib/gh.mjs';

const usage = 'usage: ci-review-prompt.mjs <pr> --dir <gathered dir>';

try {
  const { positional, options } = parseArgs(process.argv.slice(2), { string: ['dir'] });
  const [number] = positional;
  if (!/^\d+$/.test(number ?? '') || !options.dir) fail(usage);

  const read = (name) => readFileSync(path.join(options.dir, name), 'utf8');
  const { prompt, omitted } = buildReviewPrompt({
    number,
    pr: JSON.parse(read('pr.json')),
    checks: read('checks.json'),
    files: read('files.txt'),
    diff: read('diff.patch')
  });
  if (omitted.length) console.error(`The diff is too large for one review; left out ${omitted.length} file(s): ${omitted.join(', ')}`);
  process.stdout.write(prompt);
} catch (error) {
  fail(error.message);
}
