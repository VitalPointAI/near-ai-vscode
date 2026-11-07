// Whether an Open-GSD workflow carries on to its next step by itself (owner, 2026-11-06): "it didn't auto progress from gsd planning to gsd execution",
// then "maybe surface that setting like the auto approve picker and put it next to the picker so user can adjust it during the runs".
//
// The cause was not the extension: Open-GSD reads `workflow.auto_advance` and `workflow._auto_chain_active` from the project's .planning/config.json, and
// when both are false it prints "▶ Recommended next step" and exits at every boundary. NEAR AI never set them, so even in Auto mode GSD was told to stop
// and wait for a person. This module is the one rule for what those flags should be, so the switch beside the approval picker and the config write agree.
// Pure: no I/O, no vscode.

export interface AutoAdvanceFlags { auto_advance: boolean; _auto_chain_active: boolean }

/**
 * The flags an Open-GSD project should carry for this approval mode. Auto means "run on its own", so the workflow advances; every other mode keeps
 * Open-GSD's own default of stopping at a boundary, which is what a person choosing "ask me about changes" expects. `auto_advance` is the project's
 * own setting and is left alone unless Auto is on, so a person who turned it on by hand does not lose it.
 */
export function autoAdvanceFlags(mode: string, current?: Partial<AutoAdvanceFlags>): Partial<AutoAdvanceFlags> {
  const wanted = mode === 'auto' || mode === 'fully-autonomous';
  const existing = current ?? {};
  const flags: Partial<AutoAdvanceFlags> = {};
  // Only writes what differs, so the file is not rewritten on every switch flip.
  if (wanted !== (existing._auto_chain_active === true)) flags._auto_chain_active = wanted;
  if (wanted !== (existing.auto_advance === true)) flags.auto_advance = wanted;
  return flags;
}

/** The plain sentence the switch shows, and what it means when on. */
export const AUTO_ADVANCE_TEXT = Object.freeze({
  on: 'Carrying on by itself: each step of a workflow starts the next one without asking.',
  off: 'Stopping at each step: a workflow asks before it starts the next one.'
});

/**
 * Whether an approval mode should carry on by itself. Auto and fully autonomous do; the other modes stop at a boundary, because their whole point is
 * that a person decides what happens next.
 */
export function carriesOn(mode: string): boolean {
  return mode === 'auto' || mode === 'fully-autonomous';
}
