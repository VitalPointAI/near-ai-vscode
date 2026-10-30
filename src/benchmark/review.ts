// Build-then-review for the live model eval (live.test.ts only): one model does the task, a second reviews the work
// against the task and lists gaps, and the first fixes them in one more pass, as GSD's verifier and
// gap closure do. Measures whether a cheap builder plus a review matches a stronger builder alone.

export const REVIEW_FILE = 'REVIEW.md';

/** "builder" or "builder+reviewer". */
export function parseCandidate(spec: string): { builder: string; reviewer?: string } {
  const [builder, reviewer] = spec.split('+').map((part) => part.trim());
  return reviewer ? { builder, reviewer } : { builder };
}

export function reviewPrompt(task: string): string {
  return [
    'Another agent was given the task below in this folder and says it is done. Review its work; do not do or redo the task yourself.',
    '',
    '<task>', task, '</task>',
    '',
    'Check:',
    '- every requirement of the task, and of any plan, issue, or spec file it names, against what was actually built or written;',
    '- that every test the task asked for exists and tests what it should;',
    '- that tests the agent was given are unchanged and still pass (run them);',
    '- edge cases the task or its files spell out.',
    '',
    `Then write ${REVIEW_FILE} and change no other file. If the work is complete, its first line is exactly APPROVED. Otherwise list each gap as a numbered item naming the file and what is missing or wrong, specifically enough to fix without re-reviewing.`
  ].join('\n');
}

/**
 * APPROVED on the first line passes; anything else, including no review, is a list of gaps. Reviewers
 * often open with a heading ("# Review of brief.md") before the verdict, so headings are read past.
 */
export function reviewVerdict(review: string | undefined): { approved: boolean; gaps: string } {
  const text = (review ?? '').trim();
  if (!text) return { approved: false, gaps: '' };
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const opening = lines.slice(0, lines.findIndex((line) => !line.startsWith('#')) + 1 || lines.length);
  return opening.some((line) => /^\W*approved\b/i.test(line)) ? { approved: true, gaps: '' } : { approved: false, gaps: text };
}

export function fixPrompt(task: string, gaps: string): string {
  return [
    'You were given this task in this folder earlier and reported it done:',
    '', '<task>', task, '</task>', '',
    'A reviewer found these gaps in the work:',
    '', '<review>', gaps, '</review>', '',
    `Fix each gap that is real, then run the tests and confirm they pass. Do not edit ${REVIEW_FILE}. Where you disagree with a point, say why in your answer instead of changing the code.`
  ].join('\n');
}
