// A label written for allies and read back (Phase 45.1, D-02, XCHG-01). Pure: no I/O, no clock, no vscode, no package.
// mapOut turns one of your organization's labels into the abstract form of a NATO confidentiality label (ADatP-4774 section 3, cited only): a policy
// identifier, a classification value and categories, each restrictive or permissive with its values. mapIn reads that form back. Both go only through the
// labelInterop table of the signed policy (label-interop@1), and anything the table does not cover is refused, never guessed. The XML form is Phase 45.2's.
// Refusal sentences never name a category value or a label (D-10).
import type { InteropCategoryValue, InteropScale, LabelInteropTable } from '../gate/labelInteropSection';
import { LABEL_TOKEN_PATTERN, RELEASABILITY_NONE } from '../gate/labels';
import type { Label } from '../gate/labels';

export const CATEGORY_TYPES = Object.freeze(['permissive', 'restrictive'] as const);
export type CategoryType = (typeof CATEGORY_TYPES)[number];

export interface ExternalCategory {
  readonly tag: string;
  readonly type: CategoryType;
  /** Sorted and unique. */
  readonly values: readonly string[];
}

/** A label in the abstract form a partner's system reads. Categories are sorted by type, then tag. */
export interface ExternalLabel {
  /** The version of your organization's table that wrote it. */
  readonly mapping: number;
  readonly policy: string;
  readonly classification: string;
  readonly categories: readonly ExternalCategory[];
}

export const LABEL_INTEROP_REFUSALS = Object.freeze({
  'not-set': 'Your organization\'s security officer has not set how labels are written for allies yet, so nothing can be sent to a partner.',
  'no-mapping': 'This label has a part that your organization\'s table for allies does not cover, so it cannot be sent to a partner or read from one.',
  'releasable-to-none': 'This content is releasable to no one, so it cannot be sent to a partner.',
  'handling': 'This label carries handling rules that stay inside your organization, so it cannot be sent to a partner.',
  'mapping-version': 'This label was written with another version of your organization\'s table for allies.',
  'malformed': 'This label is not in a form this version can read.'
} as const);
export type LabelInteropRefusal = keyof typeof LABEL_INTEROP_REFUSALS;

export type InteropResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: LabelInteropRefusal; readonly message: string };

function refuse(reason: LabelInteropRefusal): { readonly ok: false; readonly reason: LabelInteropRefusal; readonly message: string } {
  return Object.freeze({ ok: false, reason, message: LABEL_INTEROP_REFUSALS[reason] });
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function sorted(values: Iterable<string>): readonly string[] {
  return Object.freeze([...values].sort());
}

function categoryOrder(a: ExternalCategory, b: ExternalCategory): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
}

/**
 * One of your organization's labels in the partner form, or the reason it cannot leave: no table in force, a label releasable to no one, a handling
 * flag (it stays inside your organization), or a scale, level, compartment or releasability token the table does not list.
 */
export function mapOut(label: Label, table: LabelInteropTable | undefined): InteropResult<ExternalLabel> {
  if (table === undefined) return refuse('not-set');
  if (label.releasability.includes(RELEASABILITY_NONE)) return refuse('releasable-to-none');
  if (label.handling.length > 0) return refuse('handling');
  const scale = own(table.scales, label.scale);
  if (scale === undefined) return refuse('no-mapping');
  const classification = own(scale.levels, label.level);
  if (classification === undefined) return refuse('no-mapping');
  const restrictive = new Map<string, Set<string>>();
  for (const token of label.compartments) {
    const entry = own(scale.compartments, token);
    if (entry === undefined) return refuse('no-mapping');
    const values = restrictive.get(entry.category) ?? new Set<string>();
    values.add(entry.value);
    restrictive.set(entry.category, values);
  }
  const categories: ExternalCategory[] = [...restrictive].map(([tag, values]) => Object.freeze({ tag, type: 'restrictive' as const, values: sorted(values) }));
  if (label.releasability.length > 0) {
    const values: string[] = [];
    for (const token of label.releasability) {
      const value = own(scale.releasableTo.values, token);
      if (value === undefined) return refuse('no-mapping');
      values.push(value);
    }
    categories.push(Object.freeze({ tag: scale.releasableTo.category, type: 'permissive' as const, values: sorted(values) }));
  }
  categories.sort(categoryOrder);
  return { ok: true, value: Object.freeze({ mapping: table.version, policy: scale.policy, classification, categories: Object.freeze(categories) }) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Reading a label that came from outside

const MAX_TEXT = 256;
const MAX_CATEGORIES = 64;
const MAX_VALUES = 256;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT && !CONTROL.test(value);
}

function readCategory(value: unknown): ExternalCategory | undefined {
  if (!isRecord(value) || !exactKeys(value, ['tag', 'type', 'values'])) return undefined;
  const { tag, type, values } = value;
  if (!isText(tag) || !(CATEGORY_TYPES as readonly unknown[]).includes(type)) return undefined;
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_VALUES) return undefined;
  for (let index = 0; index < values.length; index += 1) {
    const entry: unknown = values[index];
    if (!isText(entry)) return undefined;
    if (index > 0 && entry <= (values[index - 1] as string)) return undefined;
  }
  return Object.freeze({ tag, type: type as CategoryType, values: Object.freeze([...(values as string[])]) });
}

/** The abstract partner form read strictly: exact keys, texts without control characters, categories sorted by type then tag, values sorted and unique. */
export function readExternalLabel(value: unknown): InteropResult<ExternalLabel> {
  if (!isRecord(value) || !exactKeys(value, ['mapping', 'policy', 'classification', 'categories'])) return refuse('malformed');
  const { mapping, policy, classification, categories } = value;
  if (typeof mapping !== 'number' || !Number.isSafeInteger(mapping) || mapping < 1) return refuse('malformed');
  if (!isText(policy) || !isText(classification)) return refuse('malformed');
  if (!Array.isArray(categories) || categories.length > MAX_CATEGORIES) return refuse('malformed');
  const out: ExternalCategory[] = [];
  for (const entry of categories as unknown[]) {
    const category = readCategory(entry);
    if (category === undefined) return refuse('malformed');
    const before = out[out.length - 1];
    if (before !== undefined && categoryOrder(before, category) >= 0) return refuse('malformed');
    out.push(category);
  }
  return { ok: true, value: Object.freeze({ mapping, policy, classification, categories: Object.freeze(out) }) };
}

function levelFor(scale: InteropScale, classification: string): string | undefined {
  return Object.keys(scale.levels).find((level) => scale.levels[level] === classification);
}

function compartmentFor(scale: InteropScale, tag: string, value: string): string | undefined {
  return Object.keys(scale.compartments).find((token) => {
    const entry = scale.compartments[token] as InteropCategoryValue;
    return entry.category === tag && entry.value === value;
  });
}

function releasabilityFor(scale: InteropScale, value: string): string | undefined {
  return Object.keys(scale.releasableTo.values).find((token) => scale.releasableTo.values[token] === value);
}

/**
 * A label in the partner form read back as one of your organization's labels, through the same table and the same mapping version: an unknown policy
 * identifier, classification value, category or value is refused, never guessed. The label has no handling flags (they never leave).
 */
export function mapIn(external: unknown, table: LabelInteropTable | undefined): InteropResult<Label> {
  if (table === undefined) return refuse('not-set');
  const read = readExternalLabel(external);
  if (!read.ok) return read;
  const label = read.value;
  if (label.mapping !== table.version) return refuse('mapping-version');
  const scaleId = Object.keys(table.scales).find((id) => (table.scales[id] as InteropScale).policy === label.policy);
  if (scaleId === undefined) return refuse('no-mapping');
  const scale = table.scales[scaleId] as InteropScale;
  const level = levelFor(scale, label.classification);
  if (level === undefined) return refuse('no-mapping');
  const compartments = new Set<string>();
  const releasability = new Set<string>();
  for (const category of label.categories) {
    if (category.type === 'permissive') {
      if (category.tag !== scale.releasableTo.category) return refuse('no-mapping');
      for (const value of category.values) {
        const token = releasabilityFor(scale, value);
        if (token === undefined) return refuse('no-mapping');
        releasability.add(token);
      }
      continue;
    }
    for (const value of category.values) {
      const token = compartmentFor(scale, category.tag, value);
      if (token === undefined) return refuse('no-mapping');
      compartments.add(token);
    }
  }
  // The table only holds tokens of the label pattern; a second check keeps a hand-built table from passing anything else through.
  for (const token of [...compartments, ...releasability]) if (!LABEL_TOKEN_PATTERN.test(token) || token === RELEASABILITY_NONE) return refuse('no-mapping');
  return {
    ok: true,
    value: Object.freeze({ scale: scaleId, level, compartments: sorted(compartments), releasability: sorted(releasability), handling: Object.freeze([]) })
  };
}
