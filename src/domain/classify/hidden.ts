// The hidden-instruction detector (Phase 70.1, D-19; research 3.6). Pure: no I/O, no clock, no vscode, no package.
// The caller passes what a reader does not see (comments, zero-width text, alt text, metadata) as hidden parts. Text there that tells a classifier or an
// AI what label to give is itself a fact, `hidden-instruction`, which adds `no-agent-tools` and goes to a person; it never lowers anything.
// Matching is a fixed list of English and French phrases, after the text is put in compatibility form, lower-cased, stripped of zero-width characters
// and accents, and has every run of anything that is not a letter or digit read as one space. No regular expression comes from content or policy.
import type { Fact } from './record';

/**
 * The phrases, as they read after normalisation (no accents, single spaces): instructions that override a classifier's instructions, and instruction
 * verbs aimed at a label, in English and French. Fixed in code; your organization cannot extend it in this version (gap register).
 */
export const HIDDEN_INSTRUCTION_PHRASES = Object.freeze([
  // English: overriding instructions
  'ignore previous instructions', 'ignore all previous instructions', 'ignore the previous instructions', 'ignore prior instructions', 'ignore all prior instructions',
  'ignore your instructions', 'disregard previous instructions', 'disregard all previous instructions', 'disregard prior instructions', 'forget previous instructions',
  'forget your instructions',
  // English: instructions aimed at a label
  'classify as', 'classify this', 'classify the document', 'classify it as', 'label this', 'label it as', 'label as', 'mark this document', 'mark this as',
  'set the label', 'set label to', 'set the classification', 'change the classification', 'downgrade this', 'declassify this', 'treat this document as',
  'this document is unclassified', 'output public', 'output unclassified', 'respond with unclassified', 'answer unclassified',
  // French: overriding instructions
  'ignorez les instructions', 'ignore les instructions', 'ignorez toutes les instructions', 'oubliez les instructions', 'ne tenez pas compte des instructions',
  // French: instructions aimed at a label
  'classez ce document', 'classez le document', 'classez comme', 'classer comme', 'classez en', 'etiquetez ce document', 'etiquetez comme', 'marquez ce document',
  'marquez comme', 'declassifiez', 'declassez', 'ce document est non classifie'
] as const);

const INVISIBLE = /[\u00ad\u180e\u200b-\u200f\u2060-\u2064\ufeff]/g;
const COMBINING = /\p{M}/gu;
const NOT_WORD = /[^\p{L}\p{N}]+/gu;

/** The text as the phrases are matched against it, padded with one space at each end. */
export function hiddenText(text: string): string {
  const plain = text.normalize('NFKC').replace(INVISIBLE, '').normalize('NFD').replace(COMBINING, '').toLowerCase().replace(NOT_WORD, ' ').trim();
  return ` ${plain} `;
}

/** Whether one hidden part holds an instruction aimed at a label, a classifier or an AI. */
export function isHiddenInstruction(part: string): boolean {
  const text = hiddenText(part);
  return HIDDEN_INSTRUCTION_PHRASES.some((phrase) => text.includes(` ${phrase} `));
}

/** One `hidden-instruction` fact per hidden part that holds such an instruction. Visible text is never passed here. */
export function hiddenInstructionFacts(parts: readonly string[]): readonly Fact[] {
  return Object.freeze(parts.filter(isHiddenInstruction).map(() => Object.freeze({ type: 'hidden-instruction' })));
}
