// The classification proposal record v1 (Phase 70.1, D-03, D-06, D-21; research 3.4, 3.9). Pure: no I/O, no clock, no vscode, no package; the hash
// function is the caller's. A record says what one proposal for one revision of one item did, and why. It holds data attributes only (labels, bases,
// typed facts about the content, confidence): never a key for a person attribute (owner decision D1). Every object in it has a closed key set. Once a
// release ships these keys they never change in place; a change is a v2 beside v1 (Phase 70 D-22).
//
// The record stays with the item, at the item's label: its rationale is derived content. recordForLog gives the copy the decision log keeps, with the
// rationale text and the fact subjects replaced by their hashes, and the record's own hash (SHA-256 of its canonical JSON) beside them.
//
// What Phase 74.3's panel reads (74.3-UI-SPEC, drafted for the 70.1-01 shapes checkpoint):
//   - the label block: `applied`, with `start` for "raised from";
//   - Why: `bases` (kind and ref; the ref looks up the marking, guide entry, detector or source), with `facts` (types only) for the compilation and
//     judgement rows;
//   - Suggestions: `suggestions` (label, reason, and who may decide a lowering);
//   - the trust line: `model` (passport id, endpoint class, use tier) and, under Show trust details, `confidence.calibration`,
//     `confidence.secondFamilyAgreement` and `prompt.templateHash`;
//   - notices: `outcome` and `exceptions` (large raise, possible spill, hidden text, full fact set).
// Numbers are whole numbers (canonical JSON refuses a fraction): probabilities and agreements are basis points, 10000 being 1.
import { ENDPOINT_CLASSES } from '../gate/endpoints';
import type { EndpointClass } from '../gate/endpoints';
import type { Mark } from '../gate/dominance';
import { labelKey, parseLabel, splitLabelKey } from '../gate/labels';
import type { Label, ScaleTable } from '../gate/labels';
import { PASSPORT_ID_PATTERN, USE_TIERS } from '../gate/models';
import type { UseTier } from '../gate/models';
import { checkKeys, childPath, isRecord, isSafeIntegerInRange, ownValue, refused } from '../gate/shape';
import type { Fields, Parsed, Refusal } from '../gate/shape';
import { canonicalize } from '../team/canonical';

export const PROPOSAL_RECORD_VERSION = 1;

/**
 * Why a label or a part of it was proposed (D-06), the same six kinds as Phase 33.1 D-40's `basis`, in the same order. Every basis here has a `ref`: the
 * source item id, the marking pattern id, the guide rule id, the detector id, the compilation rule id, or for `judgement` the SHA-256 of the labelled
 * rationale. Never the matched text.
 */
export const BASIS_KINDS = Object.freeze(['source', 'marking', 'guide', 'detector', 'compilation', 'judgement'] as const);
export type BasisKind = (typeof BASIS_KINDS)[number];

export interface Basis {
  readonly kind: BasisKind;
  /** 1 to 128 characters, no line break. */
  readonly ref: string;
}

/** What a proposal did, recorded as the record's outcome (D-21). `affirmed`, `reverted-by-request` and `lowered` are later events about a record, never edits. */
export const PROPOSAL_OUTCOMES = Object.freeze(['auto-raised', 'suggested', 'kept', 'none', 'stale', 'possible-spill'] as const);
export type ProposalOutcome = (typeof PROPOSAL_OUTCOMES)[number];

/** Why a proposal part is a suggestion and not applied (D-04, D-08 to D-10; the 74.3 panel's suggestion rows). */
export const SUGGESTION_REASONS = Object.freeze(['band', 'no-threshold', 'shadow', 'judgement-only', 'second-family', 'could-be-lower', 'wider-release'] as const);
export type SuggestionReason = (typeof SUGGESTION_REASONS)[number];

/** Who may decide a lowering suggestion (research 3.1). 74.3 enforces the authority; the record only names it. */
export const LOWERING_DECIDERS = Object.freeze(['classification-authority', 'compartment-owner', 'release-authority', 'steward'] as const);
export type LoweringDecider = (typeof LOWERING_DECIDERS)[number];

/** Why a person must look (D-11, D-13, D-18, D-19), each queued as label.exception-queued. */
export const EXCEPTION_KINDS = Object.freeze(['large-raise', 'possible-spill', 'hidden-instruction', 'aggregate-cap'] as const);
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

/** Keys refused by name anywhere a record could carry them (D-03): a person's attributes are never a classifier's to propose. */
export const PERSON_ATTRIBUTE_KEYS = Object.freeze([
  'clearance', 'nationality', 'organization', 'serves', 'compartmentHoldings', 'exportEligibility', 'agreements', 'roleAuthority'
] as const);

/** The keys of the proposal record v1, exactly (D-21). */
export const PROPOSAL_RECORD_KEYS = Object.freeze([
  'v', 'item', 'contentHash', 'revision', 'start', 'proposal', 'bases', 'facts', 'confidence', 'model', 'prompt', 'rationale', 'outcome', 'applied',
  'suggestions', 'exceptions', 'actor'
] as const);

/** The keys of the log copy: the record's, plus the record's own hash. */
export const PROPOSAL_LOG_COPY_KEYS = Object.freeze([...PROPOSAL_RECORD_KEYS, 'recordHash'] as const);

export type ItemRef = { readonly item: string; readonly contentHash: string; readonly revision: number };

/** A label's start and its proposed label on one scale, each field with its direction (D-04). */
export type LevelDirection = 'up' | 'same' | 'down';
export type SetDirection = 'added' | 'removed' | 'both' | 'same';
export type ReleaseDirection = 'narrowed' | 'widened' | 'both' | 'same';

export interface ProposalPart {
  readonly label: Label;
  readonly level: LevelDirection;
  readonly compartments: SetDirection;
  readonly releasability: ReleaseDirection;
  readonly handling: SetDirection;
}

/** A typed fact about the content (D-18): its type and, when it names something, an opaque subject key the caller derives per session. Never the value. */
export interface Fact {
  readonly type: string;
  readonly subject?: string;
}

export interface Confidence {
  /** Calibrated probability that the true level is at least this level, per `scale/level`, in basis points. */
  readonly levels: Readonly<Record<string, number>>;
  readonly calibration: string;
  /** Agreement between samples, in basis points. */
  readonly sampleAgreement: number;
  /** Agreement with a second model family, in basis points, when one was asked. */
  readonly secondFamilyAgreement?: number;
}

export interface ModelRef {
  readonly passport: string;
  readonly passportHash: string;
  readonly artifactHash: string;
  readonly endpointClass: EndpointClass;
  readonly useTier: UseTier;
}

export interface PromptRef {
  /** The policy bundle the rules came from. */
  readonly bundleHash: string;
  /** With a model only: the prompt template and the decoding settings, each as SHA-256. */
  readonly templateHash?: string;
  readonly decodingHash?: string;
}

export interface Suggestion {
  readonly label: Label;
  readonly reason: SuggestionReason;
  /** Only on could-be-lower and wider-release. */
  readonly decidedBy?: LoweringDecider;
}

export interface ProposalRecord extends ItemRef {
  readonly v: 1;
  readonly start: Mark;
  readonly proposal: readonly ProposalPart[];
  readonly bases: readonly Basis[];
  readonly facts: readonly Fact[];
  /** Null for rules only. */
  readonly confidence: Confidence | null;
  /** `none` for rules only. */
  readonly model: ModelRef | 'none';
  readonly prompt: PromptRef;
  /** The model's short reason, labelled at the item's label; null for rules only. */
  readonly rationale: { readonly label: Label; readonly text: string } | null;
  readonly outcome: ProposalOutcome;
  readonly applied: Mark;
  readonly suggestions: readonly Suggestion[];
  readonly exceptions: readonly { readonly kind: ExceptionKind }[];
  /** The agent's did:key for an automatic step, or `rules` when no model took part. */
  readonly actor: string;
}

export interface ProposalLogCopy extends Omit<ProposalRecord, 'facts' | 'rationale'> {
  readonly facts: readonly { readonly type: string; readonly subjectHash?: string }[];
  readonly rationale: { readonly label: Label; readonly textHash: string } | null;
  readonly recordHash: string;
}

/** SHA-256 as lowercase hex of the UTF-8 bytes of a text, supplied by the caller so this folder stays pure. */
export type HashText = (text: string) => string;

const HEX_64 = /^[0-9a-f]{64}$/;
const LINE_BREAK = /[\r\n\u2028\u2029]/;
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const ITEM_ID = /^[A-Za-z0-9._:/-]{1,128}$/;
const FACT_TYPE = /^[a-z][a-z0-9-]{0,47}$/;
const SUBJECT_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const CALIBRATION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DID_KEY = /^did:key:z[1-9A-HJ-NP-Za-km-z]{1,120}$/;
const MAX_LIST = 256;
const MAX_FACTS = 4096;
const MAX_RATIONALE = 600;
const BASIS_POINTS = 10_000;

function personKey(value: Fields, path: string): Refusal | undefined {
  const found = PERSON_ATTRIBUTE_KEYS.find((key) => Object.prototype.hasOwnProperty.call(value, key));
  return found === undefined ? undefined : refused('not-allowed-here', childPath(path, found));
}

/** checkKeys, with a person-attribute key refused by name first (D-03). */
function closed(value: Fields, path: string, required: readonly string[], optional: readonly string[] = []): Refusal | undefined {
  return personKey(value, path) ?? checkKeys(value, path, required, optional);
}

function text(value: unknown, path: string, pattern: RegExp): Parsed<string> {
  return typeof value === 'string' && pattern.test(value) ? { ok: true, value } : refused('wrong-type', path);
}

function choice<T extends string>(value: unknown, path: string, allowed: readonly T[]): Parsed<T> {
  if (typeof value !== 'string') return refused('wrong-type', path);
  const found = allowed.find((entry) => entry === value);
  return found === undefined ? refused('not-allowed-here', path) : { ok: true, value: found };
}

function list<T>(value: unknown, path: string, max: number, one: (item: unknown, where: string) => Parsed<T>, allowEmpty = true): Parsed<readonly T[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  if (value.length > max) return refused('not-allowed-here', path);
  if (value.length === 0 && !allowEmpty) return refused('empty-list', path);
  const out: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = one(value[index], `${path}[${String(index)}]`);
    if (!item.ok) return item;
    out.push(item.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

/** A basis ref: 1 to 128 characters, no line break and no control character, never the matched text (the caller passes an id or a hash). */
export function isBasisRef(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && !LINE_BREAK.test(value) && !CONTROL.test(value);
}

export function parseBasis(value: unknown, path: string): Parsed<Basis> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = closed(value, path, ['kind', 'ref']);
  if (keys !== undefined) return keys;
  const kind = choice(ownValue(value, 'kind'), childPath(path, 'kind'), BASIS_KINDS);
  if (!kind.ok) return kind;
  const ref = ownValue(value, 'ref');
  if (!isBasisRef(ref)) return refused('wrong-type', childPath(path, 'ref'));
  return { ok: true, value: Object.freeze({ kind: kind.value, ref }) };
}

/** A mark as a record holds it: labels in raiseMark's order (by `scale/level`), at most one per scale, at least one. */
function parseMark(value: unknown, scales: ScaleTable, path: string): Parsed<Mark> {
  const labels = list(value, path, MAX_LIST, (item, where) => parseLabel(item, scales, where), false);
  if (!labels.ok) return labels;
  const seen = new Set<string>();
  for (let index = 0; index < labels.value.length; index += 1) {
    const label = labels.value[index] as Label;
    const where = `${path}[${String(index)}]`;
    if (seen.has(label.scale)) return refused('duplicate', where);
    if (index > 0 && labelKey(label) < labelKey(labels.value[index - 1] as Label)) return refused('not-sorted', where);
    seen.add(label.scale);
  }
  return labels;
}

function parsePart(value: unknown, scales: ScaleTable, path: string): Parsed<ProposalPart> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = closed(value, path, ['label', 'level', 'compartments', 'releasability', 'handling']);
  if (keys !== undefined) return keys;
  const label = parseLabel(ownValue(value, 'label'), scales, childPath(path, 'label'));
  if (!label.ok) return label;
  const level = choice(ownValue(value, 'level'), childPath(path, 'level'), ['up', 'same', 'down'] as const);
  if (!level.ok) return level;
  const compartments = choice(ownValue(value, 'compartments'), childPath(path, 'compartments'), ['added', 'removed', 'both', 'same'] as const);
  if (!compartments.ok) return compartments;
  const releasability = choice(ownValue(value, 'releasability'), childPath(path, 'releasability'), ['narrowed', 'widened', 'both', 'same'] as const);
  if (!releasability.ok) return releasability;
  const handling = choice(ownValue(value, 'handling'), childPath(path, 'handling'), ['added', 'removed', 'both', 'same'] as const);
  if (!handling.ok) return handling;
  return { ok: true, value: Object.freeze({ label: label.value, level: level.value, compartments: compartments.value, releasability: releasability.value, handling: handling.value }) };
}

function parseFact(value: unknown, path: string, subjectKey: 'subject' | 'subjectHash'): Parsed<{ readonly type: string; readonly subject?: string; readonly subjectHash?: string }> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = closed(value, path, ['type'], [subjectKey]);
  if (keys !== undefined) return keys;
  const type = text(ownValue(value, 'type'), childPath(path, 'type'), FACT_TYPE);
  if (!type.ok) return type;
  if (!Object.prototype.hasOwnProperty.call(value, subjectKey)) return { ok: true, value: Object.freeze({ type: type.value }) };
  const subject = text(ownValue(value, subjectKey), childPath(path, subjectKey), subjectKey === 'subject' ? SUBJECT_KEY : HEX_64);
  if (!subject.ok) return subject;
  return { ok: true, value: Object.freeze({ type: type.value, [subjectKey]: subject.value }) };
}

function basisPoints(value: unknown, path: string): Parsed<number> {
  return isSafeIntegerInRange(value, 0, BASIS_POINTS) ? { ok: true, value } : refused('wrong-type', path);
}

function parseConfidence(value: unknown, path: string): Parsed<Confidence | null> {
  if (value === null) return { ok: true, value: null };
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = closed(value, path, ['levels', 'calibration', 'sampleAgreement'], ['secondFamilyAgreement']);
  if (keys !== undefined) return keys;
  const levelsPath = childPath(path, 'levels');
  const levels = ownValue(value, 'levels');
  if (!isRecord(levels) || Object.keys(levels).length > MAX_LIST) return refused('wrong-type', levelsPath);
  const out: Record<string, number> = {};
  for (const key of Object.keys(levels)) {
    const where = childPath(levelsPath, key.slice(0, 40));
    if (splitLabelKey(key) === undefined || key.length > 128 || CONTROL.test(key) || LINE_BREAK.test(key)) return refused('not-allowed-here', where);
    const probability = basisPoints(ownValue(levels, key), where);
    if (!probability.ok) return probability;
    out[key] = probability.value;
  }
  const calibration = text(ownValue(value, 'calibration'), childPath(path, 'calibration'), CALIBRATION_ID);
  if (!calibration.ok) return calibration;
  const sample = basisPoints(ownValue(value, 'sampleAgreement'), childPath(path, 'sampleAgreement'));
  if (!sample.ok) return sample;
  const base = { levels: Object.freeze(out), calibration: calibration.value, sampleAgreement: sample.value };
  if (!Object.prototype.hasOwnProperty.call(value, 'secondFamilyAgreement')) return { ok: true, value: Object.freeze(base) };
  const second = basisPoints(ownValue(value, 'secondFamilyAgreement'), childPath(path, 'secondFamilyAgreement'));
  if (!second.ok) return second;
  return { ok: true, value: Object.freeze({ ...base, secondFamilyAgreement: second.value }) };
}

function parseModel(value: unknown, path: string): Parsed<ModelRef | 'none'> {
  if (value === 'none') return { ok: true, value: 'none' };
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = closed(value, path, ['passport', 'passportHash', 'artifactHash', 'endpointClass', 'useTier']);
  if (keys !== undefined) return keys;
  const passport = text(ownValue(value, 'passport'), childPath(path, 'passport'), PASSPORT_ID_PATTERN);
  if (!passport.ok) return passport;
  const passportHash = text(ownValue(value, 'passportHash'), childPath(path, 'passportHash'), HEX_64);
  if (!passportHash.ok) return passportHash;
  const artifactHash = text(ownValue(value, 'artifactHash'), childPath(path, 'artifactHash'), HEX_64);
  if (!artifactHash.ok) return artifactHash;
  const endpointClass = choice(ownValue(value, 'endpointClass'), childPath(path, 'endpointClass'), ENDPOINT_CLASSES);
  if (!endpointClass.ok) return endpointClass;
  const useTier = choice(ownValue(value, 'useTier'), childPath(path, 'useTier'), USE_TIERS);
  if (!useTier.ok) return useTier;
  return { ok: true, value: Object.freeze({ passport: passport.value, passportHash: passportHash.value, artifactHash: artifactHash.value, endpointClass: endpointClass.value, useTier: useTier.value }) };
}

function parsePrompt(value: unknown, withModel: boolean, path: string): Parsed<PromptRef> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = withModel ? closed(value, path, ['bundleHash', 'templateHash', 'decodingHash']) : closed(value, path, ['bundleHash']);
  if (keys !== undefined) return keys;
  const out: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    const hash = text(ownValue(value, key), childPath(path, key), HEX_64);
    if (!hash.ok) return hash;
    out[key] = hash.value;
  }
  return { ok: true, value: Object.freeze(out) as unknown as PromptRef };
}

function parseRationale(value: unknown, scales: ScaleTable, path: string, textKey: 'text' | 'textHash'): Parsed<{ readonly label: Label; readonly text?: string; readonly textHash?: string } | null> {
  if (value === null) return { ok: true, value: null };
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = closed(value, path, ['label', textKey]);
  if (keys !== undefined) return keys;
  const label = parseLabel(ownValue(value, 'label'), scales, childPath(path, 'label'));
  if (!label.ok) return label;
  const body = ownValue(value, textKey);
  const where = childPath(path, textKey);
  if (textKey === 'textHash') {
    if (typeof body !== 'string' || !HEX_64.test(body)) return refused('wrong-type', where);
  } else if (typeof body !== 'string' || body.length < 1 || body.length > MAX_RATIONALE || CONTROL.test(body)) {
    return refused('wrong-type', where);
  }
  return { ok: true, value: Object.freeze({ label: label.value, [textKey]: body }) };
}

function parseSuggestion(value: unknown, scales: ScaleTable, path: string): Parsed<Suggestion> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = closed(value, path, ['label', 'reason'], ['decidedBy']);
  if (keys !== undefined) return keys;
  const label = parseLabel(ownValue(value, 'label'), scales, childPath(path, 'label'));
  if (!label.ok) return label;
  const reason = choice(ownValue(value, 'reason'), childPath(path, 'reason'), SUGGESTION_REASONS);
  if (!reason.ok) return reason;
  const lowering = reason.value === 'could-be-lower' || reason.value === 'wider-release';
  const has = Object.prototype.hasOwnProperty.call(value, 'decidedBy');
  if (lowering !== has) return refused(lowering ? 'missing-field' : 'not-allowed-here', childPath(path, 'decidedBy'));
  if (!has) return { ok: true, value: Object.freeze({ label: label.value, reason: reason.value }) };
  const decidedBy = choice(ownValue(value, 'decidedBy'), childPath(path, 'decidedBy'), LOWERING_DECIDERS);
  if (!decidedBy.ok) return decidedBy;
  return { ok: true, value: Object.freeze({ label: label.value, reason: reason.value, decidedBy: decidedBy.value }) };
}

function parseException(value: unknown, path: string): Parsed<{ readonly kind: ExceptionKind }> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = closed(value, path, ['kind']);
  if (keys !== undefined) return keys;
  const kind = choice(ownValue(value, 'kind'), childPath(path, 'kind'), EXCEPTION_KINDS);
  return kind.ok ? { ok: true, value: Object.freeze({ kind: kind.value }) } : kind;
}

/** The fields the record and its log copy share, read in key order. The two differ only in `facts`, `rationale` and the log copy's `recordHash`. */
function parseShared(value: Fields, scales: ScaleTable, path: string, log: boolean): Parsed<Record<string, unknown>> {
  if (ownValue(value, 'v') !== PROPOSAL_RECORD_VERSION) {
    return typeof ownValue(value, 'v') === 'number' ? refused('unknown-version', childPath(path, 'v')) : refused('wrong-type', childPath(path, 'v'));
  }
  const out: Record<string, unknown> = { v: PROPOSAL_RECORD_VERSION };
  const item = text(ownValue(value, 'item'), childPath(path, 'item'), ITEM_ID);
  if (!item.ok) return item;
  const contentHash = text(ownValue(value, 'contentHash'), childPath(path, 'contentHash'), HEX_64);
  if (!contentHash.ok) return contentHash;
  const revision = ownValue(value, 'revision');
  if (!isSafeIntegerInRange(revision, 0, Number.MAX_SAFE_INTEGER)) return refused('wrong-type', childPath(path, 'revision'));
  Object.assign(out, { item: item.value, contentHash: contentHash.value, revision });
  const start = parseMark(ownValue(value, 'start'), scales, childPath(path, 'start'));
  if (!start.ok) return start;
  const proposal = list(ownValue(value, 'proposal'), childPath(path, 'proposal'), MAX_LIST, (entry, where) => parsePart(entry, scales, where));
  if (!proposal.ok) return proposal;
  const bases = list(ownValue(value, 'bases'), childPath(path, 'bases'), MAX_LIST, parseBasis);
  if (!bases.ok) return bases;
  const facts = list(ownValue(value, 'facts'), childPath(path, 'facts'), MAX_FACTS, (entry, where) => parseFact(entry, where, log ? 'subjectHash' : 'subject'));
  if (!facts.ok) return facts;
  const model = parseModel(ownValue(value, 'model'), childPath(path, 'model'));
  if (!model.ok) return model;
  const withModel = model.value !== 'none';
  const confidence = parseConfidence(ownValue(value, 'confidence'), childPath(path, 'confidence'));
  if (!confidence.ok) return confidence;
  // A model answer carries its confidence; rules alone carry none, and only a model gives a judgement.
  if ((confidence.value === null) === withModel) return refused(withModel ? 'missing-field' : 'not-allowed-here', childPath(path, 'confidence'));
  if (!withModel && bases.value.some((basis) => basis.kind === 'judgement')) return refused('not-allowed-here', childPath(path, 'bases'));
  const prompt = parsePrompt(ownValue(value, 'prompt'), withModel, childPath(path, 'prompt'));
  if (!prompt.ok) return prompt;
  const rationale = parseRationale(ownValue(value, 'rationale'), scales, childPath(path, 'rationale'), log ? 'textHash' : 'text');
  if (!rationale.ok) return rationale;
  if (!withModel && rationale.value !== null) return refused('not-allowed-here', childPath(path, 'rationale'));
  const outcome = choice(ownValue(value, 'outcome'), childPath(path, 'outcome'), PROPOSAL_OUTCOMES);
  if (!outcome.ok) return outcome;
  const applied = parseMark(ownValue(value, 'applied'), scales, childPath(path, 'applied'));
  if (!applied.ok) return applied;
  const suggestions = list(ownValue(value, 'suggestions'), childPath(path, 'suggestions'), MAX_LIST, (entry, where) => parseSuggestion(entry, scales, where));
  if (!suggestions.ok) return suggestions;
  const exceptions = list(ownValue(value, 'exceptions'), childPath(path, 'exceptions'), EXCEPTION_KINDS.length, parseException);
  if (!exceptions.ok) return exceptions;
  const actor = ownValue(value, 'actor');
  if (actor !== 'rules' && (typeof actor !== 'string' || !DID_KEY.test(actor))) return refused('wrong-type', childPath(path, 'actor'));
  if (actor === 'rules' && withModel) return refused('not-allowed-here', childPath(path, 'actor'));
  Object.assign(out, {
    start: start.value, proposal: proposal.value, bases: bases.value, facts: facts.value, confidence: confidence.value, model: model.value, prompt: prompt.value,
    rationale: rationale.value, outcome: outcome.value, applied: applied.value, suggestions: suggestions.value, exceptions: exceptions.value, actor
  });
  return { ok: true, value: out };
}

/** Parses a proposal record v1 against the policy's scales. Exact keys at every level; a person-attribute key is refused by name (D-03). */
export function parseProposalRecord(value: unknown, scales: ScaleTable, path = ''): Parsed<ProposalRecord> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = closed(value, path, PROPOSAL_RECORD_KEYS);
  if (keys !== undefined) return keys;
  const shared = parseShared(value, scales, path, false);
  if (!shared.ok) return shared;
  return { ok: true, value: Object.freeze(shared.value) as unknown as ProposalRecord };
}

/** Parses the log copy of a record: the record's keys and its hash, with hashes in place of the rationale text and the fact subjects. */
export function parseProposalLogCopy(value: unknown, scales: ScaleTable, path = ''): Parsed<ProposalLogCopy> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = closed(value, path, PROPOSAL_LOG_COPY_KEYS);
  if (keys !== undefined) return keys;
  const shared = parseShared(value, scales, path, true);
  if (!shared.ok) return shared;
  const recordHash = text(ownValue(value, 'recordHash'), childPath(path, 'recordHash'), HEX_64);
  if (!recordHash.ok) return recordHash;
  return { ok: true, value: Object.freeze({ ...shared.value, recordHash: recordHash.value }) as unknown as ProposalLogCopy };
}

/** SHA-256 of the record's canonical JSON (the team log's canonical form), by the caller's hash function: the ref a cell entry's basis carries (74.3). */
export function proposalRecordHash(record: ProposalRecord, hash: HashText): string {
  return hash(canonicalize(record));
}

/**
 * The copy the decision log keeps (D-21, T-70.1-02): ids, hashes, kinds, counts, labels and the outcome, with the rationale text and every fact subject
 * replaced by its hash, and the record's own hash added. The rationale stays with the item, at the item's label.
 */
export function recordForLog(record: ProposalRecord, hash: HashText): ProposalLogCopy {
  const facts = record.facts.map((fact) => Object.freeze(fact.subject === undefined ? { type: fact.type } : { type: fact.type, subjectHash: hash(fact.subject) }));
  const rationale = record.rationale === null ? null : Object.freeze({ label: record.rationale.label, textHash: hash(record.rationale.text) });
  const { facts: _facts, rationale: _rationale, ...rest } = record;
  return Object.freeze({ ...rest, facts: Object.freeze(facts), rationale, recordHash: proposalRecordHash(record, hash) });
}
