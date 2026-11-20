// A proposed policy change as a list of changed keys, each with one plain sentence (FND-09, Phase 41 D-44). Pure: no I/O, no clock, no vscode, no package.
// Every flow that would change the rules hands the editor a next document; proposalOf compares it with the rules in force and says, per key, what changes
// and whether the rules get wider or stricter. A key whose direction is not known counts as widening, so a change is never applied as harmless by default.
// Imported values are used only inside functions, never at module load.
import { labelKeyShown } from './labelAlgebra';
import type { ScaleTable } from './labels';
import type { PolicyDocument } from './policyDocument';

export type ProposalDirection = 'narrows' | 'widens' | 'neutral';

/**
 * Says whether a change of one key makes the rules stricter, wider or neither; undefined when it cannot tell. 41-14 builds it from 41-02's narrowingOf,
 * joining section and key into its path.
 */
export type DirectionOf = (section: string, key: string, before: unknown, after: unknown) => ProposalDirection | undefined;

/** The judge that knows nothing: every change counts as widening. */
export const UNKNOWN_WIDENS: DirectionOf = () => undefined;

export interface ProposalChange {
  /** The document section the key belongs to (`labels`, `endpoints`, ...). */
  readonly section: string;
  /** The key inside the section: dotted for objects, `[id]` for a list item with an id. */
  readonly key: string;
  /** Absent when the key is new. */
  readonly before?: unknown;
  /** Absent when the key is removed. */
  readonly after?: unknown;
  readonly direction: ProposalDirection;
  /** One plain sentence about what the change does. */
  readonly effect: string;
}

const ROUTING_LEVELS = 'routing.levels.';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function routingEffect(level: string, after: unknown, direction: ProposalDirection, scales: ScaleTable): string {
  const shown = labelKeyShown(level, scales);
  if (after === 'any-cloud') return `${shown} work could go to a server that is not verified.`;
  if (after === 'attested-cloud') {
    return direction === 'narrows'
      ? `${shown} work will only go to NEAR AI private hardware or this computer.`
      : `${shown} work could go to NEAR AI private hardware (checked each time it is used).`;
  }
  if (after === 'local-only') return direction === 'widens' ? `${shown} work could go to this computer.` : `${shown} work will only go to this computer.`;
  return `${shown} work will not go to any AI service.`;
}

/** Every changed key from `base` to `next`, with one plain sentence each, frozen and sorted by section then key. */
export function proposalOf(base: PolicyDocument, next: PolicyDocument, directionOf: DirectionOf = UNKNOWN_WIDENS, scales?: ScaleTable): readonly ProposalChange[] {
  const shownScales = scales ?? base.labels.scales;
  const before = base.labels.routing.levels as Readonly<Record<string, unknown>>;
  const after = next.labels.routing.levels as Readonly<Record<string, unknown>>;
  const out: ProposalChange[] = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const level of keys) {
    const was = isRecord(before) ? before[level] : undefined;
    const now = isRecord(after) ? after[level] : undefined;
    if (same(was, now)) continue;
    const key = `${ROUTING_LEVELS}${level}`;
    const direction = directionOf('labels', key, was, now) ?? 'widens';
    out.push(Object.freeze({
      section: 'labels', key, ...(was === undefined ? {} : { before: was }), ...(now === undefined ? {} : { after: now }), direction,
      effect: routingEffect(level, now, direction, shownScales)
    }));
  }
  return Object.freeze(out);
}
