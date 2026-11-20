// term(): the only way code gets a mode word (FND-07, Phase 41 D-39, D-40; portfolio design 5.1 and 5.5). Pure: no I/O, no clock, no vscode, no package.
// This file reads the one mode table in modes.ts and spells no mode word of its own.
import { CONCEPT_KEYS, DEFAULT_MODE, MODES, MODE_IDS } from './modes';
import type { ConceptKey, ModeId, ModeRow } from './modes';

/** The user words for the switch between modes (glossary section 2: "Kind of organization"). */
export const HOW_YOUR_ORGANIZATION_WORKS = 'How your organization works';

function rowOf(mode: ModeId): ModeRow {
  const row = (MODE_IDS as readonly string[]).includes(mode) ? MODES[mode] : undefined;
  // A programming error, never user input: parsed policies only ever carry known mode ids.
  if (row === undefined) throw new TypeError(`No mode row for ${String(mode).slice(0, 40)}.`);
  return row;
}

/** The word screens show for `concept` in `mode` (Corporate and software when no mode is given, portfolio D12). Throws a TypeError for an unknown key. */
export function term(concept: ConceptKey, mode: ModeId = DEFAULT_MODE): string {
  if (!(CONCEPT_KEYS as readonly string[]).includes(concept)) throw new TypeError(`No concept key ${String(concept).slice(0, 40)}.`);
  return rowOf(mode).words[concept].word;
}

/** The mode's own name, as the "How your organization works" choice shows it. */
export function modeName(mode: ModeId): string {
  return rowOf(mode).name;
}
