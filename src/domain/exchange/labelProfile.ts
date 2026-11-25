// Label policy profiles with provenance (45.2-11, CONTEXT D-21 and D-22). A profile in the format `label-profile/1` holds a label policy's identifier
// and its optional `urn:oid:` URI, its classifications in rank order with their marking words, and its category tags with their values, modelled on
// the concepts of an XML policy information file (ADatP-4774 Appendix 2 Annex B; ADatP-4778.2 section 12.11) so a verified one can replace it later.
// Every value says where it came from: `provenance` (verified, public-unverified or assumed), `source`, `date`, and, unless verified, the gap id that
// tracks its replacement. A value may instead be a marked placeholder set per target system, which an operational export always refuses.
//
// Pure: no I/O, no clock (the caller passes the day), no package. Drafts ship as data in resources/label-profiles/; no policy's own values are written
// in this file (D-02). Parsed input is read key by key and never spread, so a hostile prototype key cannot reach a trusted object.
import { checkKeys, childPath, isRecord, isSafeIntegerInRange, ownValue, refused, type Parsed } from '../gate/shape';

export const LABEL_PROFILE_FORMAT = 'label-profile/1' as const;

/** How sure we are of a value, most sure first. */
export const PROVENANCE_LEVELS = Object.freeze(['verified', 'public-unverified', 'assumed'] as const);
export type Provenance = (typeof PROVENANCE_LEVELS)[number];

/** The category types of ADatP-4774 Appendix 1. */
export const CATEGORY_TYPES = Object.freeze(['RESTRICTIVE', 'PERMISSIVE', 'INFORMATIVE'] as const);
export type CategoryType = (typeof CATEGORY_TYPES)[number];

/** The defined subcategory tags of ADatP-4774 section 4.2 (Table 1) that a label request names. Matched case-insensitively (section 5.1). */
export const CONTEXT_TAG = 'Context';
export const RELEASABLE_TO_TAG = 'Releasable To';

export interface ProfileValue {
  readonly value: string;
  readonly provenance: Provenance;
  readonly source: string;
  readonly date: string;
  readonly gap?: string;
}

export interface ProfilePlaceholder {
  /** What is not known yet, in words, for example "The policy identifier's OID". */
  readonly placeholder: string;
  readonly configurablePerTarget: true;
  readonly provenance: 'assumed';
  readonly source: string;
  readonly date: string;
  readonly gap: string;
}

export type ProfileLeaf = ProfileValue | ProfilePlaceholder;

export interface ProfileClassification { readonly value: ProfileLeaf; readonly rank: number; readonly marking?: ProfileLeaf }
export interface ProfileCategory { readonly type: CategoryType; readonly tagName: ProfileLeaf; readonly uri?: ProfileLeaf; readonly values: readonly ProfileLeaf[] }

export interface LabelProfile {
  readonly format: typeof LABEL_PROFILE_FORMAT;
  readonly id: string;
  readonly title: string;
  readonly policyIdentifier: ProfileLeaf;
  readonly uri?: ProfileLeaf;
  readonly classifications: readonly ProfileClassification[];
  readonly categories: readonly ProfileCategory[];
  readonly note: string;
}

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const GAP_ID = /^G[0-9]{1,5}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A `urn:oid:` URN: arcs of digits with no leading zero (ADatP-4774 section 5.1). */
const URN_OID = /^urn:oid:[0-2](?:\.(?:0|[1-9][0-9]{0,15})){1,40}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_VALUE = 200;
const MAX_SOURCE = 400;
const MAX_NOTE = 2000;
const MAX_CLASSIFICATIONS = 32;
const MAX_CATEGORIES = 32;
const MAX_CATEGORY_VALUES = 512;

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && !CONTROL.test(value) && value.trim() === value;
}

/** A calendar day, `YYYY-MM-DD`, that does not roll over. */
export function isDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DAY.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

export function isPlaceholder(leaf: ProfileLeaf): leaf is ProfilePlaceholder {
  return Object.prototype.hasOwnProperty.call(leaf, 'placeholder');
}

function parseLeaf(input: unknown, path: string, kind: 'text' | 'uri'): Parsed<ProfileLeaf> {
  if (!isRecord(input)) return refused('wrong-type', path);
  const placeholder = Object.prototype.hasOwnProperty.call(input, 'placeholder');
  const keyProblem = placeholder
    ? checkKeys(input, path, ['placeholder', 'configurablePerTarget', 'provenance', 'source', 'date', 'gap'])
    : checkKeys(input, path, ['value', 'provenance', 'source', 'date'], ['gap']);
  if (keyProblem) return keyProblem;
  const provenance = ownValue(input, 'provenance');
  if (!PROVENANCE_LEVELS.includes(provenance as Provenance)) return refused('wrong-type', childPath(path, 'provenance'));
  const source = ownValue(input, 'source');
  if (!isText(source, MAX_SOURCE)) return refused('wrong-type', childPath(path, 'source'));
  const date = ownValue(input, 'date');
  if (!isDay(date)) return refused('wrong-type', childPath(path, 'date'));
  const gap = ownValue(input, 'gap');
  if (gap !== undefined && (typeof gap !== 'string' || !GAP_ID.test(gap))) return refused('wrong-type', childPath(path, 'gap'));
  if (provenance !== 'verified' && gap === undefined) return refused('missing-field', childPath(path, 'gap'));
  if (placeholder) {
    const what = ownValue(input, 'placeholder');
    if (!isText(what, MAX_VALUE)) return refused('wrong-type', childPath(path, 'placeholder'));
    if (ownValue(input, 'configurablePerTarget') !== true) return refused('wrong-type', childPath(path, 'configurablePerTarget'));
    if (provenance !== 'assumed') return refused('not-allowed-here', childPath(path, 'provenance'));
    return { ok: true, value: Object.freeze({ placeholder: what, configurablePerTarget: true as const, provenance: 'assumed' as const, source, date, gap: gap as string }) };
  }
  const value = ownValue(input, 'value');
  if (!isText(value, MAX_VALUE)) return refused('wrong-type', childPath(path, 'value'));
  if (kind === 'uri' && !URN_OID.test(value)) return refused('wrong-type', childPath(path, 'value'));
  const leaf: ProfileValue = gap === undefined
    ? { value, provenance: provenance as Provenance, source, date }
    : { value, provenance: provenance as Provenance, source, date, gap: gap as string };
  return { ok: true, value: Object.freeze(leaf) };
}

/** The text a leaf compares by: its value, case-insensitively (ADatP-4774 section 5.1); a placeholder has none. */
function comparable(leaf: ProfileLeaf): string | undefined {
  return isPlaceholder(leaf) ? undefined : leaf.value.toUpperCase();
}

function parseClassifications(input: unknown, path: string): Parsed<readonly ProfileClassification[]> {
  if (!Array.isArray(input)) return refused('wrong-type', path);
  if (input.length === 0) return refused('empty-list', path);
  if (input.length > MAX_CLASSIFICATIONS) return refused('wrong-type', path);
  const out: ProfileClassification[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const here = `${path}[${index}]`;
    const entry: unknown = input[index];
    if (!isRecord(entry)) return refused('wrong-type', here);
    const keys = checkKeys(entry, here, ['value', 'rank'], ['marking']);
    if (keys) return keys;
    const rank = ownValue(entry, 'rank');
    if (!isSafeIntegerInRange(rank, 1, MAX_CLASSIFICATIONS)) return refused('wrong-type', childPath(here, 'rank'));
    const previous = out[out.length - 1];
    if (previous !== undefined && rank === previous.rank) return refused('duplicate', childPath(here, 'rank'));
    if (previous !== undefined && rank < previous.rank) return refused('not-sorted', childPath(here, 'rank'));
    const value = parseLeaf(ownValue(entry, 'value'), childPath(here, 'value'), 'text');
    if (!value.ok) return value;
    const key = comparable(value.value);
    if (key !== undefined && seen.has(key)) return refused('duplicate', childPath(here, 'value'));
    if (key !== undefined) seen.add(key);
    let marking: ProfileLeaf | undefined;
    if (ownValue(entry, 'marking') !== undefined) {
      const parsedMarking = parseLeaf(ownValue(entry, 'marking'), childPath(here, 'marking'), 'text');
      if (!parsedMarking.ok) return parsedMarking;
      marking = parsedMarking.value;
    }
    out.push(Object.freeze(marking === undefined ? { value: value.value, rank } : { value: value.value, rank, marking }));
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseCategories(input: unknown, path: string): Parsed<readonly ProfileCategory[]> {
  if (!Array.isArray(input) || input.length > MAX_CATEGORIES) return refused('wrong-type', path);
  const out: ProfileCategory[] = [];
  const tags = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const here = `${path}[${index}]`;
    const entry: unknown = input[index];
    if (!isRecord(entry)) return refused('wrong-type', here);
    const keys = checkKeys(entry, here, ['type', 'tagName', 'values'], ['uri']);
    if (keys) return keys;
    const type = ownValue(entry, 'type');
    if (!CATEGORY_TYPES.includes(type as CategoryType)) return refused('wrong-type', childPath(here, 'type'));
    const tagName = parseLeaf(ownValue(entry, 'tagName'), childPath(here, 'tagName'), 'text');
    if (!tagName.ok) return tagName;
    const tag = comparable(tagName.value);
    if (tag !== undefined && tags.has(tag)) return refused('duplicate', childPath(here, 'tagName'));
    if (tag !== undefined) tags.add(tag);
    let uri: ProfileLeaf | undefined;
    if (ownValue(entry, 'uri') !== undefined) {
      const parsedUri = parseLeaf(ownValue(entry, 'uri'), childPath(here, 'uri'), 'uri');
      if (!parsedUri.ok) return parsedUri;
      uri = parsedUri.value;
    }
    const rawValues = ownValue(entry, 'values');
    if (!Array.isArray(rawValues) || rawValues.length > MAX_CATEGORY_VALUES) return refused('wrong-type', childPath(here, 'values'));
    const values: ProfileLeaf[] = [];
    const seen = new Set<string>();
    for (let valueIndex = 0; valueIndex < rawValues.length; valueIndex += 1) {
      const leaf = parseLeaf(rawValues[valueIndex], `${childPath(here, 'values')}[${valueIndex}]`, 'text');
      if (!leaf.ok) return leaf;
      const key = comparable(leaf.value);
      if (key !== undefined && seen.has(key)) return refused('duplicate', `${childPath(here, 'values')}[${valueIndex}]`);
      if (key !== undefined) seen.add(key);
      values.push(leaf.value);
    }
    const category = { type: type as CategoryType, tagName: tagName.value, values: Object.freeze(values) };
    out.push(Object.freeze(uri === undefined ? category : { ...category, uri }));
  }
  return { ok: true, value: Object.freeze(out) };
}

/** Parses a `label-profile/1` file, a shipped draft and an adopted profile alike. */
export function parseLabelProfile(input: unknown): Parsed<LabelProfile> {
  if (!isRecord(input)) return refused('wrong-type', '');
  const keys = checkKeys(input, '', ['format', 'id', 'title', 'policyIdentifier', 'classifications', 'categories', 'note'], ['uri']);
  if (keys) return keys;
  if (ownValue(input, 'format') !== LABEL_PROFILE_FORMAT) return refused('unknown-version', 'format');
  const id = ownValue(input, 'id');
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) return refused('wrong-type', 'id');
  const title = ownValue(input, 'title');
  if (!isText(title, MAX_VALUE)) return refused('wrong-type', 'title');
  const note = ownValue(input, 'note');
  if (typeof note !== 'string' || note.length > MAX_NOTE) return refused('wrong-type', 'note');
  const policyIdentifier = parseLeaf(ownValue(input, 'policyIdentifier'), 'policyIdentifier', 'text');
  if (!policyIdentifier.ok) return policyIdentifier;
  let uri: ProfileLeaf | undefined;
  if (ownValue(input, 'uri') !== undefined) {
    const parsedUri = parseLeaf(ownValue(input, 'uri'), 'uri', 'uri');
    if (!parsedUri.ok) return parsedUri;
    uri = parsedUri.value;
  }
  const classifications = parseClassifications(ownValue(input, 'classifications'), 'classifications');
  if (!classifications.ok) return classifications;
  const categories = parseCategories(ownValue(input, 'categories'), 'categories');
  if (!categories.ok) return categories;
  const profile = { format: LABEL_PROFILE_FORMAT, id, title, policyIdentifier: policyIdentifier.value, classifications: classifications.value, categories: categories.value, note };
  return { ok: true, value: Object.freeze(uri === undefined ? profile : { ...profile, uri }) };
}

/** Every value of a profile with its path, in file order: the list the gap register check and the provenance shown on an export read. */
export function profileLeaves(profile: LabelProfile): Array<{ path: string; leaf: ProfileLeaf }> {
  const out: Array<{ path: string; leaf: ProfileLeaf }> = [{ path: 'policyIdentifier', leaf: profile.policyIdentifier }];
  if (profile.uri) out.push({ path: 'uri', leaf: profile.uri });
  profile.classifications.forEach((entry, index) => {
    out.push({ path: `classifications[${index}].value`, leaf: entry.value });
    if (entry.marking) out.push({ path: `classifications[${index}].marking`, leaf: entry.marking });
  });
  profile.categories.forEach((category, index) => {
    out.push({ path: `categories[${index}].tagName`, leaf: category.tagName });
    if (category.uri) out.push({ path: `categories[${index}].uri`, leaf: category.uri });
    category.values.forEach((leaf, valueIndex) => out.push({ path: `categories[${index}].values[${valueIndex}]`, leaf }));
  });
  return out;
}

/** The least sure provenance among the given values; `verified` when there are none. */
export function lowestProvenance(leaves: Iterable<ProfileLeaf>): Provenance {
  let lowest = 0;
  for (const leaf of leaves) lowest = Math.max(lowest, PROVENANCE_LEVELS.indexOf(leaf.provenance));
  return PROVENANCE_LEVELS[lowest] as Provenance;
}

// Sentences shown to people (D-19: plain short sentences).
export const NO_CONTEXT_VALUES_TEXT = "This label policy has no context values; they come with the mission's policy file.";
export const UNKNOWN_CLASSIFICATION_TEXT = 'This label policy has no classification at that level.';
export const UNKNOWN_VALUE_TEXT = 'This label policy has no such value for that category.';
export const NO_CATEGORY_TEXT = 'This label policy has no such category.';

export const LABEL_VALUE_REFUSALS = Object.freeze({
  'unknown-classification': UNKNOWN_CLASSIFICATION_TEXT,
  'unknown-value': UNKNOWN_VALUE_TEXT,
  'no-category': NO_CATEGORY_TEXT,
  'no-context-values': NO_CONTEXT_VALUES_TEXT
} as const);
export type LabelValueRefusal = keyof typeof LABEL_VALUE_REFUSALS;

/** One value a label uses, with the profile it came from. */
export interface UsedValue { readonly profile: string; readonly title: string; readonly path: string; readonly leaf: ProfileLeaf }

export interface LabelCategoryValues { readonly type: CategoryType; readonly tagName: ProfileLeaf; readonly uri?: ProfileLeaf; readonly values: readonly ProfileLeaf[] }

export interface LabelValues {
  readonly profile: string;
  readonly policyIdentifier: ProfileLeaf;
  readonly uri?: ProfileLeaf;
  readonly classification: ProfileLeaf;
  readonly marking?: ProfileLeaf;
  readonly categories: readonly LabelCategoryValues[];
  /** Every value the label uses, in the order written. */
  readonly used: readonly UsedValue[];
  readonly lowestProvenance: Provenance;
}

export interface LabelRequest {
  /** The rank of the classification in the profile. */
  readonly classification: number;
  readonly releasableTo?: readonly string[];
  readonly context?: readonly string[];
}

export type LabelValuesResult = { readonly ok: true; readonly value: LabelValues } | { readonly ok: false; readonly reason: LabelValueRefusal; readonly message: string };

function valueRefusal(reason: LabelValueRefusal): { ok: false; reason: LabelValueRefusal; message: string } {
  return { ok: false, reason, message: LABEL_VALUE_REFUSALS[reason] };
}

function categoryIndex(profile: LabelProfile, tag: string): number {
  return profile.categories.findIndex((category) => comparable(category.tagName) === tag.toUpperCase());
}

/** The values of one label from a profile: the policy, its URI, the classification at a rank and the category values asked for, each with its provenance. */
export function valuesFor(profile: LabelProfile, request: LabelRequest): LabelValuesResult {
  const used: UsedValue[] = [];
  const use = (path: string, leaf: ProfileLeaf): ProfileLeaf => {
    used.push(Object.freeze({ profile: profile.id, title: profile.title, path, leaf }));
    return leaf;
  };
  const classIndex = profile.classifications.findIndex((entry) => entry.rank === request.classification);
  const entry = profile.classifications[classIndex];
  if (entry === undefined) return valueRefusal('unknown-classification');
  const policyIdentifier = use('policyIdentifier', profile.policyIdentifier);
  const uri = profile.uri ? use('uri', profile.uri) : undefined;
  const classification = use(`classifications[${classIndex}].value`, entry.value);
  const marking = entry.marking ? use(`classifications[${classIndex}].marking`, entry.marking) : undefined;
  const categories: LabelCategoryValues[] = [];
  const asked: Array<[string, readonly string[] | undefined]> = [[CONTEXT_TAG, request.context], [RELEASABLE_TO_TAG, request.releasableTo]];
  for (const [tag, wanted] of asked) {
    if (wanted === undefined || wanted.length === 0) continue;
    const index = categoryIndex(profile, tag);
    const category = profile.categories[index];
    if (tag === CONTEXT_TAG && (category === undefined || category.values.length === 0)) return valueRefusal('no-context-values');
    if (category === undefined) return valueRefusal('no-category');
    const tagName = use(`categories[${index}].tagName`, category.tagName);
    const categoryUri = category.uri ? use(`categories[${index}].uri`, category.uri) : undefined;
    const values: ProfileLeaf[] = [];
    for (const want of wanted) {
      const valueIndex = category.values.findIndex((leaf) => comparable(leaf) === want.toUpperCase());
      const leaf = category.values[valueIndex];
      if (leaf === undefined) return valueRefusal('unknown-value');
      values.push(use(`categories[${index}].values[${valueIndex}]`, leaf));
    }
    const written = { type: category.type, tagName, values: Object.freeze(values) };
    categories.push(Object.freeze(categoryUri === undefined ? written : { ...written, uri: categoryUri }));
  }
  const value: LabelValues = {
    profile: profile.id,
    policyIdentifier,
    classification,
    categories: Object.freeze(categories),
    used: Object.freeze(used),
    lowestProvenance: lowestProvenance(used.map((item) => item.leaf)),
    ...(uri === undefined ? {} : { uri }),
    ...(marking === undefined ? {} : { marking })
  };
  return { ok: true, value: Object.freeze(value) };
}

// The operational rule (D-22): an operational export refuses a placeholder always, and an assumed value unless your security officer has recorded an
// exception for that profile and those values that has not ended; public, not yet verified values pass and are shown. Trial exports may use both.
export const EXPORT_PURPOSES = Object.freeze(['trial', 'operational'] as const);
export type ExportPurpose = (typeof EXPORT_PURPOSES)[number];

export const ASSUMED_VALUES_TEXT = (profiles: string): string =>
  `This export would use assumed label values (${profiles}). Your security officer can record an exception, or the values must be verified first.`;
export const placeholderText = (what: string): string => `${what} is not known for this target system.`;

/** An exception your security officer records in the signed policy (`labelXml.assumedExceptions`): these assumed values of this profile, until a day. */
export interface AssumedException { readonly profile: string; readonly values: readonly string[]; readonly reason: string; readonly until: string }

export interface ProvenanceShown { readonly profile: string; readonly title: string; readonly provenance: Provenance }

export type ProvenanceVerdict =
  | { readonly ok: true; readonly lowestProvenance: Provenance; readonly shown: readonly ProvenanceShown[]; readonly exceptionsUsed: readonly AssumedException[] }
  | { readonly ok: false; readonly reason: 'placeholder' | 'assumed-values'; readonly message: string };

export interface ProvenanceOptions {
  readonly purpose: ExportPurpose;
  readonly exceptions: readonly AssumedException[];
  /** Today, `YYYY-MM-DD`, from the caller's clock. An exception counts through its `until` day. */
  readonly today: string;
}

/** Whether an exception covers every assumed value a profile contributes, today. Anything malformed covers nothing. */
function covers(exception: AssumedException, profile: string, assumed: readonly ProfileValue[], today: string): boolean {
  if (exception.profile !== profile || !Array.isArray(exception.values) || !isDay(exception.until) || !isDay(today) || today > exception.until) return false;
  const named = new Set(exception.values.filter((value): value is string => typeof value === 'string').map((value) => value.toUpperCase()));
  return assumed.every((leaf) => named.has(leaf.value.toUpperCase()));
}

/** Checks the values an export would write against the rule of D-22, and reports the provenance to show and the lowest provenance used. */
export function provenanceCheck(used: readonly UsedValue[], options: ProvenanceOptions): ProvenanceVerdict {
  const groups = new Map<string, { title: string; leaves: ProfileLeaf[] }>();
  for (const entry of used) {
    const group = groups.get(entry.profile) ?? { title: entry.title, leaves: [] };
    group.leaves.push(entry.leaf);
    groups.set(entry.profile, group);
  }
  const shown = [...groups].map(([profile, group]) => Object.freeze({ profile, title: group.title, provenance: lowestProvenance(group.leaves) }));
  const exceptionsUsed: AssumedException[] = [];
  // Anything but a trial is held to the operational rule, so a purpose this version does not know fails closed.
  if (options.purpose !== 'trial') {
    const placeholder = used.find((entry) => isPlaceholder(entry.leaf));
    if (placeholder !== undefined) return { ok: false, reason: 'placeholder', message: placeholderText((placeholder.leaf as ProfilePlaceholder).placeholder) };
    const uncovered: string[] = [];
    for (const [profile, group] of groups) {
      const assumed = group.leaves.filter((leaf): leaf is ProfileValue => !isPlaceholder(leaf) && leaf.provenance === 'assumed');
      if (assumed.length === 0) continue;
      const exception = options.exceptions.find((candidate) => covers(candidate, profile, assumed, options.today));
      if (exception === undefined) uncovered.push(group.title);
      else exceptionsUsed.push(exception);
    }
    if (uncovered.length > 0) return { ok: false, reason: 'assumed-values', message: ASSUMED_VALUES_TEXT(uncovered.join(', ')) };
  }
  return { ok: true, lowestProvenance: lowestProvenance(used.map((entry) => entry.leaf)), shown: Object.freeze(shown), exceptionsUsed: Object.freeze(exceptionsUsed) };
}

/** The same profile with each leaf passed through `replace`, keeping its shape. */
function mapLeaves(profile: LabelProfile, replace: (path: string, leaf: ProfileLeaf) => ProfileLeaf): LabelProfile {
  const classifications = profile.classifications.map((entry, index) => {
    const value = replace(`classifications[${index}].value`, entry.value);
    return Object.freeze(entry.marking === undefined ? { value, rank: entry.rank } : { value, rank: entry.rank, marking: replace(`classifications[${index}].marking`, entry.marking) });
  });
  const categories = profile.categories.map((category, index) => {
    const mapped = { type: category.type, tagName: replace(`categories[${index}].tagName`, category.tagName), values: Object.freeze(category.values.map((leaf, valueIndex) => replace(`categories[${index}].values[${valueIndex}]`, leaf))) };
    return Object.freeze(category.uri === undefined ? mapped : { ...mapped, uri: replace(`categories[${index}].uri`, category.uri) });
  });
  const base = { format: profile.format, id: profile.id, title: profile.title, policyIdentifier: replace('policyIdentifier', profile.policyIdentifier), classifications: Object.freeze(classifications), categories: Object.freeze(categories), note: profile.note };
  return Object.freeze(profile.uri === undefined ? base : { ...base, uri: replace('uri', profile.uri) });
}

/**
 * The profile as it applies to one target system (D-12 `profileOverrides`): each override names the path of a placeholder and gives its value with its
 * provenance, under the same value rules. Only placeholders can be set this way; the profile itself is not changed.
 */
export function withTargetOverrides(profile: LabelProfile, overrides: unknown): Parsed<LabelProfile> {
  if (!isRecord(overrides)) return refused('wrong-type', '');
  const leaves = new Map(profileLeaves(profile).map((entry) => [entry.path, entry.leaf]));
  const replacements = new Map<string, ProfileLeaf>();
  for (const path of Object.keys(overrides)) {
    const current = leaves.get(path);
    if (current === undefined) return refused('unknown-field', path);
    if (!isPlaceholder(current)) return refused('not-allowed-here', path);
    const leaf = parseLeaf(ownValue(overrides, path), path, path === 'uri' || path.endsWith('.uri') ? 'uri' : 'text');
    if (!leaf.ok) return leaf;
    replacements.set(path, leaf.value);
  }
  return { ok: true, value: mapLeaves(profile, (path, leaf) => replacements.get(path) ?? leaf) };
}
