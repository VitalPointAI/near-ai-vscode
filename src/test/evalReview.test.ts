import assert from 'node:assert/strict';
import test from 'node:test';
import { fixPrompt, parseCandidate, reviewPrompt, reviewVerdict } from '../benchmark/review';

test('a candidate is a builder alone or a builder with a reviewer', () => {
  assert.deepEqual(parseCandidate('z-ai/glm-5.3'), { builder: 'z-ai/glm-5.3' });
  assert.deepEqual(parseCandidate(' Qwen/Qwen3.6-35B-A3B-FP8 + z-ai/glm-5.3 '), { builder: 'Qwen/Qwen3.6-35B-A3B-FP8', reviewer: 'z-ai/glm-5.3' });
});

test('only APPROVED on the first line passes review; a missing review counts as gaps', () => {
  assert.deepEqual(reviewVerdict('APPROVED\n'), { approved: true, gaps: '' });
  assert.deepEqual(reviewVerdict('**Approved.** Everything is in place.'), { approved: true, gaps: '' });
  assert.deepEqual(reviewVerdict('1. test/search.test.js is missing: the plan asks for search tests.'), { approved: false, gaps: '1. test/search.test.js is missing: the plan asks for search tests.' });
  assert.deepEqual(reviewVerdict(undefined), { approved: false, gaps: '' });
  assert.equal(reviewVerdict('Not approved: 1. CRLF is not handled.').approved, false);
  // From the review run: the verdict under a heading was read as gaps, and the builder was sent an approval to "fix".
  assert.equal(reviewVerdict('# Review of brief.md\n\nAPPROVED\n\n## Checklist\n1. Cited. ✓').approved, true);
  assert.equal(reviewVerdict('# Review\n## Verdict\nAPPROVED').approved, true);
  assert.equal(reviewVerdict('# Review — changes required\n\nThe brief is not approvable as-is.\n\nAPPROVED once fixed.').approved, false);
  assert.equal(reviewVerdict('NOT APPROVED\n\n1. csv.js reports the wrong line.').approved, false);
});

test('the review and fix prompts carry the task and the gaps', () => {
  assert.match(reviewPrompt('Carry out PLAN.md.'), /<task>\nCarry out PLAN\.md\.\n<\/task>[\s\S]*first line is exactly APPROVED/);
  assert.match(fixPrompt('Carry out PLAN.md.', '1. no tests'), /<task>\nCarry out PLAN\.md\.\n<\/task>[\s\S]*<review>\n1\. no tests\n<\/review>/);
});
