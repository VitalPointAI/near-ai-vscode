// Markings found in content (Phase 70.1, D-06, D-09, D-16; research 3.2, 3.4): a banner or portion marking your organization's signed section lists is a
// floor that raises with certainty and uses no threshold. Pure: no I/O, no clock, no vscode, no package.
// A pattern is literal words, never a regular expression (T-70.1-04). It matches case-sensitively at word boundaries, after the text is put in NFC form,
// stripped of zero-width characters and soft hyphens, and has every run of white space read as one space, so `SE<zero-width>CRET` and a non-breaking space
// inside `PROTECTED B` still match. Finding a marking only ever raises: nothing here can lower or suppress anything.
import type { ClassificationSection } from '../gate/classificationSection';
import type { Label } from '../gate/labels';
import type { Basis } from './record';

/** A label the engine must apply whatever else the content says, with the basis that requires it (D-09). */
export interface Floor {
  readonly label: Label;
  readonly basis: Basis;
}

const INVISIBLE = /[­᠎​-‍⁠﻿]/g;
const SPACE_RUN = /\s+/gu;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/** The text as markings are matched against it. */
export function markingText(text: string): string {
  return text.normalize('NFC').replace(INVISIBLE, '').replace(SPACE_RUN, ' ');
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

/** Whether the words occur in the (already normalised) text with no letter, digit or combining mark directly before or after them. */
function occursAsWords(haystack: string, words: string): boolean {
  if (words === '') return false;
  for (let at = haystack.indexOf(words); at >= 0; at = haystack.indexOf(words, at + 1)) {
    if (!isWordChar(codePointBefore(haystack, at)) && !isWordChar(codePointAt(haystack, at + words.length))) return true;
  }
  return false;
}

function codePointAt(text: string, at: number): string | undefined {
  const point = text.codePointAt(at);
  return point === undefined ? undefined : String.fromCodePoint(point);
}

/** The whole code point that ends just before `at` (the two halves of a pair read as one). */
function codePointBefore(text: string, at: number): string | undefined {
  if (at <= 0) return undefined;
  const low = text.charCodeAt(at - 1);
  return low >= 0xdc00 && low <= 0xdfff && at >= 2 ? text.slice(at - 2, at) : text.slice(at - 1, at);
}

/** One floor per marking of the section found in the text, in the section's order (sorted by id), each with a `marking` basis naming the pattern id. */
export function markingFloors(text: string, section: ClassificationSection): readonly Floor[] {
  const haystack = markingText(text);
  const out: Floor[] = [];
  for (const marking of section.markings) {
    if (occursAsWords(haystack, markingText(marking.pattern))) out.push(Object.freeze({ label: marking.label, basis: Object.freeze({ kind: 'marking', ref: marking.id }) }));
  }
  return Object.freeze(out);
}
