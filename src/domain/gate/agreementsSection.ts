// The agreements section of a signed policy (feature agreements@1; Phase 71, D-12): your organization's agreements with other organizations, the
// replacement for the free-text agreementRef. Cited by marking.approve and by exports (33.1-20). Pure: no I/O, no clock, no vscode, no package.
// An agreement is a record of the policy, never a credential: { id, partner, tokens, levelCeiling, compartments, until, clearanceProcessVetted? }.
// clearanceProcessVetted (Phase 45.1, owner decision D-12) is your organization's record that it vetted the partner's clearance process; only your
// organization's signed layer can set it (agreements.items is organization-only with its subtree in layers.ts). Absent means not vetted.
import { parseText, parseTimestamp } from './bundle';
import { LABEL_TOKEN_PATTERN, RELEASABILITY_NONE, levelIndex, splitLabelKey } from './labels';
import type { ScaleTable } from './labels';
import { openSection } from './sections';
import { checkKeys, childPath, isRecord, ownValue, refused } from './shape';
import type { Parsed } from './shape';

export interface Agreement {
  /** Permanent once cited: lowercase letters, digits and dashes. */
  readonly id: string;
  /** The other organization, as people read it. */
  readonly partner: string;
  /** The releasability tokens the agreement covers, sorted. */
  readonly tokens: readonly string[];
  /** The highest label the agreement covers, as `scale/level`. */
  readonly levelCeiling: string;
  /** The compartments it covers, sorted (may be empty). */
  readonly compartments: readonly string[];
  /** When it ends. */
  readonly until: string;
  /** D-12: who in your organization vetted the partner's clearance process, when, and on what grounds. Absent means not vetted. */
  readonly clearanceProcessVetted?: ClearanceProcessVetting;
}

export interface ClearanceProcessVetting {
  /** Who vetted it, as people read it. */
  readonly by: string;
  /** When: a timestamp. A vetting dated after now is not in force yet. */
  readonly on: string;
  /** On what grounds. */
  readonly basis: string;
}

export interface AgreementsSection {
  readonly v: 1;
  /** Sorted by id. */
  readonly items: readonly Agreement[];
}

const AGREEMENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_AGREEMENTS = 256;
const MAX_TOKENS = 64;
const MAX_PARTNER = 200;
const MAX_VETTED_BY = 200;
const MAX_VETTED_BASIS = 500;
const ITEM_FIELDS = ['id', 'partner', 'tokens', 'levelCeiling', 'compartments', 'until'] as const;
const ITEM_OPTIONAL = ['clearanceProcessVetted'] as const;
const VETTING_FIELDS = ['by', 'on', 'basis'] as const;

function parseVetting(value: unknown, path: string): Parsed<ClearanceProcessVetting> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, VETTING_FIELDS);
  if (keys !== undefined) return keys;
  const by = parseText(ownValue(value, 'by'), childPath(path, 'by'), MAX_VETTED_BY);
  if (!by.ok) return by;
  const on = parseTimestamp(ownValue(value, 'on'), childPath(path, 'on'));
  if (!on.ok) return on;
  const basis = parseText(ownValue(value, 'basis'), childPath(path, 'basis'), MAX_VETTED_BASIS);
  if (!basis.ok) return basis;
  return { ok: true, value: Object.freeze({ by: by.value, on: on.value, basis: basis.value }) };
}

function tokenList(value: unknown, path: string, allowEmpty: boolean): Parsed<readonly string[]> {
  if (!Array.isArray(value) || value.length > MAX_TOKENS) return refused('wrong-type', path);
  if (value.length === 0 && !allowEmpty) return refused('empty-list', path);
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    // "Releasable to no one" is never something an agreement covers.
    if (typeof entry !== 'string' || !LABEL_TOKEN_PATTERN.test(entry) || entry === RELEASABILITY_NONE) return refused('wrong-type', `${path}[${String(index)}]`);
    if (index > 0) {
      const before = value[index - 1] as string;
      if (entry === before) return refused('duplicate', `${path}[${String(index)}]`);
      if (entry < before) return refused('not-sorted', `${path}[${String(index)}]`);
    }
  }
  return { ok: true, value: Object.freeze([...(value as string[])]) };
}

function parseAgreement(value: unknown, scales: ScaleTable, path: string): Parsed<Agreement> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ITEM_FIELDS, ITEM_OPTIONAL);
  if (keys !== undefined) return keys;
  const id = ownValue(value, 'id');
  if (typeof id !== 'string' || !AGREEMENT_ID.test(id)) return refused('wrong-type', childPath(path, 'id'));
  const partner = parseText(ownValue(value, 'partner'), childPath(path, 'partner'), MAX_PARTNER);
  if (!partner.ok) return partner;
  const tokens = tokenList(ownValue(value, 'tokens'), childPath(path, 'tokens'), false);
  if (!tokens.ok) return tokens;
  const ceiling = ownValue(value, 'levelCeiling');
  const split = typeof ceiling === 'string' ? splitLabelKey(ceiling) : undefined;
  if (split === undefined || levelIndex(scales, split.scale, split.level) < 0) return refused('not-allowed-here', childPath(path, 'levelCeiling'));
  const compartments = tokenList(ownValue(value, 'compartments'), childPath(path, 'compartments'), true);
  if (!compartments.ok) return compartments;
  const until = parseTimestamp(ownValue(value, 'until'), childPath(path, 'until'));
  if (!until.ok) return until;
  const agreement: Record<string, unknown> = { id, partner: partner.value, tokens: tokens.value, levelCeiling: ceiling as string, compartments: compartments.value, until: until.value };
  if (Object.prototype.hasOwnProperty.call(value, 'clearanceProcessVetted')) {
    const vetting = parseVetting(ownValue(value, 'clearanceProcessVetted'), childPath(path, 'clearanceProcessVetted'));
    if (!vetting.ok) return vetting;
    agreement.clearanceProcessVetted = vetting.value;
  }
  return { ok: true, value: Object.freeze(agreement) as unknown as Agreement };
}

/** Reads the agreements section against the document's scales: items sorted by id, each id once. */
export function parseAgreementsSection(value: unknown, scales: ScaleTable, path = 'agreements'): Parsed<AgreementsSection> {
  const section = openSection(value, path, ['items']);
  if (!section.ok) return section;
  const items = ownValue(section.value, 'items');
  const where = childPath(path, 'items');
  if (!Array.isArray(items) || items.length > MAX_AGREEMENTS) return refused('wrong-type', where);
  const out: Agreement[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = parseAgreement(items[index], scales, `${where}[${String(index)}]`);
    if (!item.ok) return item;
    const before = out[out.length - 1];
    if (before !== undefined && item.value.id === before.id) return refused('duplicate', `${where}[${String(index)}]`);
    if (before !== undefined && item.value.id < before.id) return refused('not-sorted', `${where}[${String(index)}]`);
    out.push(item.value);
  }
  return { ok: true, value: Object.freeze({ v: 1, items: Object.freeze(out) }) };
}
