// Products in several cells (plan 32-08; D-15 to D-18, D-20, D-21, D-22 revised, D-67). Pure: no I/O, no clock, imports from src/domain only.
//
// The fold already keeps a product and its text per (stream, product), so nothing in the fold's mechanics changes. These are the rules that assume
// more than one place, kept in one file so the fold and the host (32-09) decide them with the same function: the host refuses before it writes what
// the fold would refuse.
import { isRecord, ownValue } from '../gate/shape';
import { parseLabel } from '../gate/labels';
import type { Label, ScaleTable } from '../gate/labels';
import { REPLICA_KINDS, kindFamily } from './kinds';
import type { ImportScope } from './kindSchemas/project';

// The label a product gets when it is converted or created with none in its header (D-17): today's host default (staffHost.ts propose).
export const DEFAULT_PRODUCT_LABEL = 'org/Internal';

// What the base cell (stream id = project id) may carry (D-15, D-16): the roster, the integrity kinds, the project genesis and the session key
// certificates (Phase 33 D-62). Never a product, its
// text or a legacy import, so granting the hub the base cell (D-40) exposes no product text. kinds.ts does not import this file, so there is no cycle.
export const BASE_CELL_KINDS: readonly string[] = Object.freeze([
  'project.genesis',
  ...REPLICA_KINDS.filter((kind) => kindFamily(kind) === 'roster' || kindFamily(kind) === 'integrity' || kindFamily(kind) === 'session')
]);
const BASE_CELL_KIND_SET: ReadonlySet<string> = new Set(BASE_CELL_KINDS);

export function baseCellAllows(kind: string): boolean {
  return BASE_CELL_KIND_SET.has(kind);
}

// What connecting a 0.4.35 preview project to a hub is refused with, and the way forward (D-22 revised). 32-12 and 32-24 show it word for word.
export const PREVIEW_WAY_FORWARD_TEXT = 'This project was made shared by an earlier preview, and its products sit in the part of the project the hub must read. Make a single-machine copy and make that copy multi-user again; the new shared project keeps each product in its own part.';

// The families whose entries are product text or product history.
const PRODUCT_FAMILIES: readonly string[] = ['versions', 'doc'];

// The parts of a fold result this file reads, so it needs no import of fold.ts.
export interface FoldLike {
  families: Record<string, unknown>;
  held?: ReadonlyArray<{ stream?: string; family?: string }>;
}

const holdsStream = (items: unknown, stream: string): boolean =>
  Array.isArray(items) && items.some((item: unknown) => isRecord(item) && ownValue(item, 'stream') === stream);

// Did the base stream ever hold a product-family entry (D-22 revised)? True when the fold output lists a product or a product text in it, or when a
// versions or doc entry of it is held. Given a plain versions output (an array of products with their stream), true when one is in the base stream.
// A 0.4.35 preview project answers true; a project made shared in Phase 32 keeps every product in a label cell and answers false.
// Not seen: a refused or kept entry, because the fold result names no stream for those; a product whose create was refused leaves its text in the
// doc output, which is seen.
export function baseCellHeldProducts(source: FoldLike | ReadonlyArray<{ stream: string }>, base: string): boolean {
  if (Array.isArray(source)) return holdsStream(source, base);
  const fold = source as FoldLike;
  if (PRODUCT_FAMILIES.some((family) => holdsStream(ownValue(fold.families, family), base))) return true;
  return (fold.held ?? []).some((item) => item.stream === base && item.family !== undefined && PRODUCT_FAMILIES.includes(item.family));
}

// What a project.import carries: the whole ledger unless it says cell (D-20). Anything else reads as whole, as the schema allows no other word.
export function importScopeOf(data: { scope?: unknown }): ImportScope {
  return data.scope === 'cell' ? 'cell' : 'whole';
}

// ---- label text (D-15, D-17, D-20) ----

const sortedUnique = (list: readonly string[]): string[] => [...new Set(list)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// A label as people read it: scale/level, then //COMPARTMENTS joined by '/', then //REL and the releasability joined by ', ', each list sorted.
// For example org/Confidential//ALPHA//REL CAN. Handling flags are not part of the text.
export function labelText(label: Label): string {
  const compartments = sortedUnique(label.compartments);
  const releasability = sortedUnique(label.releasability);
  return `${label.scale}/${label.level}${compartments.length > 0 ? `//${compartments.join('/')}` : ''}${releasability.length > 0 ? `//REL ${releasability.join(', ')}` : ''}`;
}

// A product header's label text (scale/level, as the staff ledger keeps it) as a label with no compartments, releasability or handling, or undefined
// when the scale or level is not one of the given scales.
export function labelFromText(text: unknown, scales: ScaleTable): Label | undefined {
  if (typeof text !== 'string') return undefined;
  const slash = text.indexOf('/');
  if (slash <= 0) return undefined;
  const parsed = parseLabel({ scale: text.slice(0, slash), level: text.slice(slash + 1), compartments: [], releasability: [], handling: [] }, scales);
  return parsed.ok ? parsed.value : undefined;
}

// A whole label read back from its text as labelText writes it (scale/level, then //COMPARTMENTS joined by '/', then //REL and the releasability
// joined by ', '), or undefined when the text is not that form or names a scale, level or token the given scales do not know. A version header's
// label is this text, so a cell can check every part of it, not scale and level only (WR-01). Handling flags have no text, so the label has none.
export function labelFromHeaderText(text: unknown, scales: ScaleTable): Label | undefined {
  if (typeof text !== 'string') return undefined;
  const [head, ...rest] = text.split('//');
  const base = labelFromText(head, scales);
  if (base === undefined || rest.length > 2) return undefined;
  let compartments: string[] = [];
  let releasability: string[] = [];
  for (const [index, part] of rest.entries()) {
    if (part.startsWith('REL ')) {
      if (releasability.length > 0) return undefined;
      releasability = part.slice(4).split(', ');
    } else {
      // Compartments come before releasability, once.
      if (index > 0 || compartments.length > 0) return undefined;
      compartments = part.split('/');
    }
  }
  const parsed = parseLabel({ scale: base.scale, level: base.level, compartments, releasability, handling: [] }, scales);
  return parsed.ok ? parsed.value : undefined;
}

// The structural form sameLabel and the legacy label read; a parsed Label fits it.
export interface LabelLike {
  readonly scale: string;
  readonly level: string;
  readonly compartments: readonly string[];
  readonly releasability: readonly string[];
  readonly handling: readonly string[];
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const left = sortedUnique(a);
  const right = sortedUnique(b);
  return left.length === right.length && left.every((item, index) => item === right[index]);
};

// Are two labels the same, whatever order their tokens are in? Scale, level, compartments, releasability and handling all count.
export function sameLabel(a: LabelLike | undefined, b: LabelLike | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.scale === b.scale && a.level === b.level && sameSet(a.compartments, b.compartments) && sameSet(a.releasability, b.releasability) && sameSet(a.handling, b.handling);
}

// The label sealed into the lead-only legacy cell's grants (D-20): the set of every label in the legacy ledger, never one label, so nothing that reads
// a single label can mistake it for an ordinary cell. legacy is a format number.
export interface LegacyCellLabel { legacy: 1; labels: Label[] }

// The most labels a legacy cell label lists. A project has a handful; the bound only keeps a hostile grant from costing much.
export const MAX_LEGACY_LABELS = 256;

const normalLabel = (label: LabelLike): Label => ({
  scale: label.scale,
  level: label.level,
  compartments: sortedUnique(label.compartments),
  releasability: sortedUnique(label.releasability),
  handling: sortedUnique(label.handling)
});
const labelSortKey = (label: Label): string => JSON.stringify([label.scale, label.level, label.compartments, label.releasability, label.handling]);

// The legacy form for a set of labels: each label with sorted tokens, the set sorted and without duplicates, so the same set always gives the same form.
export function legacyCellLabel(labels: readonly LabelLike[]): LegacyCellLabel {
  const unique = new Map<string, Label>();
  for (const label of labels) {
    const normal = normalLabel(label);
    unique.set(labelSortKey(normal), normal);
  }
  const keys = [...unique.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { legacy: 1, labels: keys.map((key) => unique.get(key) as Label) };
}

// Reads an opened cell label as the legacy form, or undefined when it is anything else (an ordinary label, a newer format, extra keys, a label the
// scales do not know). The labels come back in the legacy form's order.
export function readLegacyCellLabel(raw: unknown, scales: ScaleTable): Label[] | undefined {
  if (!isRecord(raw)) return undefined;
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !keys.includes('legacy') || !keys.includes('labels')) return undefined;
  if (ownValue(raw, 'legacy') !== 1) return undefined;
  const list = ownValue(raw, 'labels');
  if (!Array.isArray(list) || list.length > MAX_LEGACY_LABELS) return undefined;
  const labels: Label[] = [];
  for (const item of list) {
    const parsed = parseLabel(item, scales);
    if (!parsed.ok) return undefined;
    labels.push(parsed.value);
  }
  return legacyCellLabel(labels).labels;
}

// The refusal the versions family adds (D-18). Spread into VERSION_REFUSALS, so the fold and the host show the same sentence.
export const PRODUCT_CELL_REFUSALS = {
  'pin-above-cell': 'This version pins a product that is not in its own part of the project or in a part its label covers, so it is refused. A version may pin only products at its own label or below.'
} as const;
export type ProductCellRefusal = keyof typeof PRODUCT_CELL_REFUSALS;

// A product a pin may name: where it lives and the hashes of its accepted versions.
export interface PinCandidate {
  stream: string;
  product: string;
  hashes: ReadonlySet<string>;
}

// The cell order of ReplicaContext: may the citing stream cite the cited one (write up, never down).
export type CellOrder = (citingStream: string, citedStream: string) => boolean;

// The pin rule (D-18, D-67). Without a cell order nothing is checked, as in Phase 30 and 31. With one, each pin needs a candidate of that product name
// that holds the pinned hash and lives in the version's own stream or in a stream the own cell dominates. A pin nothing here can place counts as above:
// a machine below a cell cannot see the products in it, and every machine must decide the same way (D-23).
export function pinProblem(own: string, pins: ReadonlyArray<{ product: string; hash: string }>, candidates: Iterable<PinCandidate>, cellOrder?: CellOrder): ProductCellRefusal | undefined {
  if (cellOrder === undefined || pins.length === 0) return undefined;
  const list = [...candidates];
  for (const pin of pins) {
    const placed = list.some((candidate) =>
      candidate.product === pin.product && candidate.hashes.has(pin.hash) && (candidate.stream === own || cellOrder(own, candidate.stream) === true));
    if (!placed) return 'pin-above-cell';
  }
  return undefined;
}
