// One label ranking and one way to show a label (coherence review S7 and S8, ADR-004 "one label algebra"): the start of the single label module. Pure apart
// from the one registered source of the active policy's scales: no I/O, no clock, no vscode, no package.
//
// Every check that ranks a level reads the active signed policy's scales, never the shipped presets on its own: the gate host registers its policy as the
// source (setActiveScaleSource), and the presets are used only while no policy has been read or the policy failed closed, which is what the gate itself uses
// then (GateHost.labelPolicy). Labels are still stored by id (`org/Confidential`); only what a person reads changes.
import { atLeast, joinLabels } from './dominance';
import { SCALE_PRESETS, exportMarkingsShown, labelKey, levelIndex, parseLabelKey, scaleOf, splitLabelKey } from './labels';
import type { Label, ScaleTable } from './labels';

let source: (() => ScaleTable) | undefined;

/**
 * Sets (or, with undefined, clears) where the active policy's scales come from: the gate host's label policy. The returned function clears the source only
 * while it is still the one set, so a replaced host never clears its replacement's.
 */
export function setActiveScaleSource(next: (() => ScaleTable) | undefined): () => void {
  source = next;
  return () => { if (source === next) source = undefined; };
}

/** The scales labels are ranked by now: the active policy's, or the shipped presets when no source is set, the source throws or gives nothing usable. */
export function activeScales(): ScaleTable {
  if (source === undefined) return SCALE_PRESETS;
  try {
    const scales = source();
    return typeof scales === 'object' && scales !== null && Object.keys(scales).length > 0 ? scales : SCALE_PRESETS;
  } catch {
    return SCALE_PRESETS;
  }
}

// The one splitter lives in the label module (D-35); re-exported so its importers here compile unchanged.
export { splitLabelKey } from './labels';

/** The rank of a `scale/level` text on its scale in `scales`, or -1 when the scale or the level is unknown. */
export function labelKeyRank(text: string, scales: ScaleTable = activeScales()): number {
  const split = splitLabelKey(text);
  return split === undefined ? -1 : levelIndex(scales, split.scale, split.level);
}

/** Whether `label` is on the same scale as `floor` and at least as high, both known on `scales`. An unknown level is never at least anything. */
export function labelKeyAtLeast(label: string, floor: string, scales: ScaleTable = activeScales()): boolean {
  const read = parseLabelKey(label, scales);
  const least = parseLabelKey(floor, scales);
  return read !== undefined && least !== undefined && atLeast(read, least, scales);
}

/**
 * The highest of several `scale/level` texts on one scale, ranked on `scales`. Labels on different scales do not join without a mapping, so mixing them, an
 * unknown level or an empty list gives undefined and the caller refuses what it was deriving.
 */
export function joinLabelKeys(labels: readonly string[], scales: ScaleTable = activeScales()): string | undefined {
  let joined: Label | undefined;
  for (const text of labels) {
    const read = parseLabelKey(text, scales);
    if (read === undefined) return undefined;
    joined = joined === undefined ? read : joinLabels(joined, read, scales);
    if (joined === undefined) return undefined;
  }
  return joined === undefined ? undefined : labelKey(joined);
}

/**
 * Levels shown under another name than their id (glossary, owner decision Q8): the organization scale's "Confidential" reads "Sensitive", so it is never
 * mistaken for the Canadian classified level of the same name, whose content never leaves this computer. The id in files, records and policies is unchanged.
 */
export const LEVEL_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({ 'org/Confidential': 'Sensitive' });

/** The name a person reads for a level: its display name when it has one, otherwise the level itself. */
export function levelShown(scale: string, level: string): string {
  const key = `${scale}/${level}`;
  return Object.prototype.hasOwnProperty.call(LEVEL_DISPLAY_NAMES, key) ? (LEVEL_DISPLAY_NAMES[key] as string) : level;
}

/** The name a person reads for a scale: the policy's own name for it, or the id when the policy does not know it. */
export function scaleShown(scale: string, scales: ScaleTable = activeScales()): string {
  return scaleOf(scales, scale)?.name ?? scaleOf(SCALE_PRESETS, scale)?.name ?? scale;
}

/** A label as a person reads it: the scale's name, then the level ("Organization: Sensitive", "Canada, Classified: Confidential"). */
export function labelKeyShown(label: { readonly scale: string; readonly level: string } | string, scales: ScaleTable = activeScales()): string {
  const split = typeof label === 'string' ? splitLabelKey(label) : label;
  if (split === undefined) return typeof label === 'string' ? label : '';
  return `${scaleShown(split.scale, scales)}: ${levelShown(split.scale, split.level)}`;
}

/**
 * A label as a person reads it with its export markings (D-62): the scale's name and the level, then the shown words of each reserved export compartment
 * ("Organization: Internal · ITAR"). The one helper label displays call (41-14's labelShown, 41-10's trust line); the tokens stay what records hold.
 */
export function labelKeyShownWithMarkings(label: { readonly scale: string; readonly level: string; readonly compartments: readonly string[] }, scales: ScaleTable = activeScales()): string {
  return exportMarkingsShown(labelKeyShown(label, scales), label.compartments);
}
