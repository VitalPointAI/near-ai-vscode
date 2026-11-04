#!/usr/bin/env node
// Builds the prompt a CI review sends to the model, from the artifacts `agent-review.mjs gather`
// already wrote. It mirrors `.claude/commands/review-pr.md` so a review produced here and one
// produced locally ask the same questions and are judged by the same rules; the difference is only
// who answers.
//
//   node scripts/ci-review-prompt.mjs <pr> --dir <gathered dir>
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fail, parseArgs } from './lib/gh.mjs';

const usage = 'usage: ci-review-prompt.mjs <pr> --dir <gathered dir>';

try {
  const { positional, options } = parseArgs(process.argv.slice(2), { string: ['dir'] });
  const [number] = positional;
  if (!/^\d+$/.test(number ?? '') || !options.dir) fail(usage);

  const read = (name) => readFileSync(path.join(options.dir, name), 'utf8');
  const pr = JSON.parse(read('pr.json'));
  const checks = read('checks.json');
  const files = read('files.txt');

  // The diff is large; it goes last so the model reads the instructions first.
  const diff = read('diff.patch');

  process.stdout.write(
    [
      'You are reviewing a pull request in the near-ai-vscode repository, a VS Code extension written',
      'in TypeScript. You did not write it. Judge it only from what follows.',
      '',
      `# Pull request #${number}: ${pr.title}`,
      '',
      '## What the author says it does',
      '',
      pr.body || '(no description)',
      '',
      '## CI results',
      '',
      '```json',
      checks.trim(),
      '```',
      '',
      '## Changed files',
      '',
      '```',
      files.trim(),
      '```',
      '',
      '## How to judge it',
      '',
      'Look for real defects, not style, and be skeptical of the description:',
      '',
      '- Does the code do what the description claims, and is the claim true?',
      '- Correctness, error paths, async races, resource leaks, unhandled rejections.',
      '- Security: secrets, credentials, host execution, path traversal, injection, what reaches a model.',
      '- Tests: do they exercise the code they claim to, or would a regression still pass?',
      '- Docs: is a user-visible change in CHANGELOG.md, and a required doc updated?',
      '- Gates: does the change weaken a check, or add a bypass?',
      '',
      '## Reply format, exactly',
      '',
      'Reply with a markdown list of findings and nothing else, then the two required lines.',
      'Every finding line starts with one of [BLOCKER], [MAJOR], [MINOR] or [NIT], then `path:line`,',
      'then what is wrong and the concrete fix. BLOCKER means a security hole, data loss, a broken gate,',
      'a regression that breaks users, or a claim that is false.',
      '',
      'Then, on its own line:',
      '',
      '```',
      `Verdict: PASS`,
      `Head-SHA: ${pr.headRefOid}`,
      '```',
      '',
      'Use `Verdict: FAIL` when there is any open BLOCKER. The verdict must match the findings: a',
      'BLOCKER with a PASS will be refused by the gate.',
      '',
      '## The diff',
      '',
      '```diff',
      diff.trim(),
      '```',
      ''
    ].join('\n')
  );
} catch (error) {
  fail(error.message);
}
