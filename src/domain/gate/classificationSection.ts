// The classification section of a signed policy (feature classification@1; Phase 70.1, D-07, D-10, D-11, D-13, D-16): your organization's security
// officer's settings for how a label may be proposed and raised. Pure: no I/O, no clock, no vscode, no package. src/domain/classify reads this file;
// nothing here imports src/domain/classify (70.1 D-02).
//
// Shape (every number is a whole number, as in every policy section):
//   { v: 1, systemHigh?: [label], thresholds: { 'scale/level': { costRatio, recallTarget, secondFamily } }, shadow: { defaultMode, levels },
//     roles: [{ passport, role, levels, evaluation, since }], review: { jumpLevels, topLevel, lowerRequestAgeDays }, markings: [{ id, pattern, label }] }
// `recallTarget` is in basis points (9800 is a recall of 0.98): a policy holds no fractions (Phase 41 D-08), so the arithmetic stays exact. Nothing here
// ships a threshold as a value: a level with no entry has no automatic model raise (D-07).
// Your organization's guide as signed rules (D-16, D-18, 70.1-03): `factTypes` adds to the shipped base vocabulary; `codeWords` is
// { listLabel, entries: [{ id, token, label }] }, the list labelled at its own level; `guideRules` and `compilationRules` are
// [{ id, guideRef, label, description, when: { allOf, sameSubject }, then }], where `label` is the label of the rule's own text and `then` is a label v1
// (owner-confirmed shape, 2026-11-25). Rule ids are unique across both lists. Guide text itself is never in the bundle.
// Marking patterns are literal words matched at word boundaries, never regular expressions, so a policy cannot inject one (T-70.1-04).
import { HEX_64, parseSetList } from './bundle';
import { LABEL_TOKEN_PATTERN, labelKey, levelIndex, parseLabel, splitLabelKey } from './labels';
import type { Label, ScaleTable } from './labels';
import { PASSPORT_ID_PATTERN } from './models';
import { openSection } from './sections';
import { checkKeys, childPath, isRecord, isSafeIntegerInRange, ownValue, parseIsoMillis, refused } from './shape';
import type { Fields, Parsed, Refusal } from './shape';

/** Every key the section may hold, in the order POLICY-SCHEMA lists them (D-16). */
export const CLASSIFICATION_SECTION_KEYS = Object.freeze([
  'systemHigh', 'thresholds', 'shadow', 'roles', 'review', 'markings', 'codeWords', 'factTypes', 'guideRules', 'compilationRules'
] as const);

/**
 * The shipped fact types (D-18): what a fact about content may be. A fact holds its type and an opaque subject key, never the value. `factTypes` in the
 * section adds to this list; an addition may not repeat a base type.
 */
export const BASE_FACT_TYPES = Object.freeze([
  'unit', 'location', 'date', 'future-date', 'capability', 'operation', 'named-person', 'codeword', 'marking', 'controlled-item', 'hidden-instruction'
] as const);

/** A fact type: lowercase letters and digits with `-` between, at most 48 characters. */
export const FACT_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;

export const SHADOW_MODES = Object.freeze(['shadow', 'enforce'] as const);
export type ShadowMode = (typeof SHADOW_MODES)[number];

/** The jobs a classifier may hold at a level (D-16; 74.3 D-24 gives a role only after a signed evaluation passes there). */
export const CLASSIFIER_ROLES = Object.freeze(['primary', 'second-family', 'hidden-instruction'] as const);
export type ClassifierRole = (typeof CLASSIFIER_ROLES)[number];

/** A recall target or a probability in basis points: 10000 is 1. */
export const BASIS_POINTS = 10_000;

export interface ThresholdEntry {
  /** The cost of under-classifying at this level over the cost of over-classifying, a whole number from 1. The raise threshold is 1 / (1 + costRatio). */
  readonly costRatio: number;
  /** The recall the blind audit must measure at this level, in basis points (1 to 10000). */
  readonly recallTarget: number;
  /** Whether a second model family must also find nothing to raise before a result at this level is none or kept (74.3 D-04). */
  readonly secondFamily: boolean;
}

export interface ShadowSettings {
  readonly defaultMode: ShadowMode;
  /** The `scale/level` keys your organization has moved to the other mode, sorted; each has a threshold entry. */
  readonly levels: readonly string[];
}

export interface RoleEntry {
  /** A passport id of the models section. */
  readonly passport: string;
  readonly role: ClassifierRole;
  /** The `scale/level` keys the role holds at, sorted; each has a threshold entry. */
  readonly levels: readonly string[];
  /** SHA-256 of the signed evaluation report that justified the role, 64 lowercase hex. */
  readonly evaluation: string;
  /** When the role began, in the gate's one time form. */
  readonly since: string;
}

export interface ReviewSettings {
  /** A raise by more than this many levels also goes to review (default 1). */
  readonly jumpLevels: number;
  /** A raise to a scale's top level also goes to review (default true). */
  readonly topLevel: boolean;
  /** How old a request for a lower label may get before it is shown as waiting (default 7; read by 74.3). */
  readonly lowerRequestAgeDays: number;
}

export interface MarkingPattern {
  readonly id: string;
  /** Literal words, matched case-sensitively at word boundaries, for example `SECRET` or `PROTÉGÉ B`. */
  readonly pattern: string;
  readonly label: Label;
}

/** The facts a rule needs: every type in `allOf`, and with `sameSubject` all on one subject. Fact types only, never values. */
export interface FactPattern {
  readonly allOf: readonly string[];
  readonly sameSubject: boolean;
}

/** A code word on your organization's list: the token found in content, and the label it implies. The ref a floor names is the entry id. */
export interface CodeWord {
  readonly id: string;
  readonly token: string;
  readonly label: Label;
}

export interface CodeWords {
  /** The label of the list itself: a code-word list is often classified. */
  readonly listLabel: Label;
  readonly entries: readonly CodeWord[];
}

/** A guide or compilation rule. `label` is the label of the rule's own text; `then` is the label the rule implies. */
export interface ClassificationRule {
  readonly id: string;
  readonly guideRef: string;
  readonly label: Label;
  readonly description: string;
  readonly when: FactPattern;
  readonly then: Label;
}

export interface ClassificationSection {
  readonly v: 1;
  /** The highest labels this system may hold, at most one per scale. Absent: no possible-spill outcome (D-13). */
  readonly systemHigh?: readonly Label[];
  readonly thresholds: Readonly<Record<string, ThresholdEntry>>;
  readonly shadow: ShadowSettings;
  readonly roles: readonly RoleEntry[];
  readonly review: ReviewSettings;
  readonly markings: readonly MarkingPattern[];
  readonly codeWords?: CodeWords;
  /** Additions to BASE_FACT_TYPES, sorted. */
  readonly factTypes: readonly string[];
  readonly guideRules: readonly ClassificationRule[];
  readonly compilationRules: readonly ClassificationRule[];
}

export const REVIEW_DEFAULTS: ReviewSettings = Object.freeze({ jumpLevels: 1, topLevel: true, lowerRequestAgeDays: 7 });

const MAX_THRESHOLDS = 256;
const MAX_ROLES = 64;
const MAX_MARKINGS = 512;
const MAX_COST_RATIO = 1_000_000;
const MAX_JUMP_LEVELS = 16;
const MAX_REQUEST_AGE_DAYS = 90;
const MAX_PATTERN = 64;
const MAX_RULES = 512;
const MAX_CODE_WORDS = 512;
const MAX_FACT_TYPES = 64;
const MAX_ALL_OF = 16;
const MAX_DESCRIPTION = 280;
const MAX_GUIDE_REF = 64;
const LINE_BREAK = /[\r\n\u2028\u2029]/;
const CONTROL = /[\u0000-\u001F\u007F]/;
/** An id a record or a basis may name: lowercase letters, digits and `.`, `_`, `-`, at most 64 characters. */
export const SECTION_ENTRY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Letters (any script) and digits, single spaces, `-` and `/` between them. No regular-expression syntax has any meaning here. */
const PATTERN_WORDS = /^[\p{L}\p{N}](?:[\p{L}\p{N}/-]| (?! ))*$/u;

function levelKeyKnown(key: string, scales: ScaleTable): boolean {
  const split = splitLabelKey(key);
  return split !== undefined && levelIndex(scales, split.scale, split.level) >= 0;
}

function parseSortedLevelKeys(value: unknown, path: string, allowed: (key: string) => boolean, allowEmpty: boolean): Parsed<readonly string[]> {
  if (!Array.isArray(value) || value.length > MAX_THRESHOLDS) return refused('wrong-type', path);
  if (value.length === 0 && !allowEmpty) return refused('empty-list', path);
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    const where = `${path}[${String(index)}]`;
    if (typeof entry !== 'string') return refused('wrong-type', where);
    if (!allowed(entry)) return refused('not-allowed-here', where);
    if (index > 0) {
      const before = value[index - 1] as string;
      if (entry === before) return refused('duplicate', where);
      if (entry < before) return refused('not-sorted', where);
    }
  }
  return { ok: true, value: Object.freeze([...(value as string[])]) };
}

function parseSystemHigh(value: unknown, scales: ScaleTable, path: string): Parsed<readonly Label[]> {
  const list = parseSetList(value, path, MAX_THRESHOLDS, (item, where) => parseLabel(item, scales, where), (label) => label.scale);
  if (!list.ok) return list;
  return list.value.length === 0 ? refused('empty-list', path) : list;
}

function parseThreshold(value: unknown, path: string): Parsed<ThresholdEntry> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['costRatio', 'recallTarget', 'secondFamily']);
  if (keys !== undefined) return keys;
  const costRatio = ownValue(value, 'costRatio');
  if (!isSafeIntegerInRange(costRatio, 1, MAX_COST_RATIO)) return refused('wrong-type', childPath(path, 'costRatio'));
  const recallTarget = ownValue(value, 'recallTarget');
  if (!isSafeIntegerInRange(recallTarget, 1, BASIS_POINTS)) return refused('wrong-type', childPath(path, 'recallTarget'));
  const secondFamily = ownValue(value, 'secondFamily');
  if (typeof secondFamily !== 'boolean') return refused('wrong-type', childPath(path, 'secondFamily'));
  return { ok: true, value: Object.freeze({ costRatio, recallTarget, secondFamily }) };
}

function parseThresholds(value: unknown, scales: ScaleTable, path: string): Parsed<Readonly<Record<string, ThresholdEntry>>> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = Object.keys(value);
  if (keys.length > MAX_THRESHOLDS) return refused('not-allowed-here', path);
  const out: Record<string, ThresholdEntry> = {};
  for (const key of keys) {
    const where = childPath(path, key.slice(0, 40));
    if (!levelKeyKnown(key, scales)) return refused('not-allowed-here', where);
    const entry = parseThreshold(ownValue(value, key), where);
    if (!entry.ok) return entry;
    out[key] = entry.value;
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseChoice<T extends string>(value: unknown, path: string, allowed: readonly T[]): Parsed<T> {
  if (typeof value !== 'string') return refused('wrong-type', path);
  const found = allowed.find((candidate) => candidate === value);
  return found === undefined ? refused('not-allowed-here', path) : { ok: true, value: found };
}

function parseShadow(value: unknown, thresholds: Readonly<Record<string, ThresholdEntry>>, path: string): Parsed<ShadowSettings> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, [], ['defaultMode', 'levels']);
  if (keys !== undefined) return keys;
  const defaultMode = Object.prototype.hasOwnProperty.call(value, 'defaultMode')
    ? parseChoice(ownValue(value, 'defaultMode'), childPath(path, 'defaultMode'), SHADOW_MODES)
    : { ok: true as const, value: 'shadow' as ShadowMode };
  if (!defaultMode.ok) return defaultMode;
  const levels = Object.prototype.hasOwnProperty.call(value, 'levels')
    ? parseSortedLevelKeys(ownValue(value, 'levels'), childPath(path, 'levels'), (key) => Object.prototype.hasOwnProperty.call(thresholds, key), true)
    : { ok: true as const, value: Object.freeze([]) as readonly string[] };
  if (!levels.ok) return levels;
  return { ok: true, value: Object.freeze({ defaultMode: defaultMode.value, levels: levels.value }) };
}

function parseRole(value: unknown, thresholds: Readonly<Record<string, ThresholdEntry>>, path: string): Parsed<RoleEntry> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['passport', 'role', 'levels', 'evaluation', 'since']);
  if (keys !== undefined) return keys;
  const passport = ownValue(value, 'passport');
  if (typeof passport !== 'string' || !PASSPORT_ID_PATTERN.test(passport)) return refused('wrong-type', childPath(path, 'passport'));
  const role = parseChoice(ownValue(value, 'role'), childPath(path, 'role'), CLASSIFIER_ROLES);
  if (!role.ok) return role;
  const levels = parseSortedLevelKeys(ownValue(value, 'levels'), childPath(path, 'levels'), (key) => Object.prototype.hasOwnProperty.call(thresholds, key), false);
  if (!levels.ok) return levels;
  const evaluation = ownValue(value, 'evaluation');
  if (typeof evaluation !== 'string' || !HEX_64.test(evaluation)) return refused('wrong-type', childPath(path, 'evaluation'));
  const since = ownValue(value, 'since');
  if (typeof since !== 'string' || Number.isNaN(parseIsoMillis(since))) return refused('wrong-type', childPath(path, 'since'));
  return { ok: true, value: Object.freeze({ passport, role: role.value, levels: levels.value, evaluation, since }) };
}

function parseReview(value: unknown, path: string): Parsed<ReviewSettings> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, [], ['jumpLevels', 'topLevel', 'lowerRequestAgeDays']);
  if (keys !== undefined) return keys;
  const jumpLevels = Object.prototype.hasOwnProperty.call(value, 'jumpLevels') ? ownValue(value, 'jumpLevels') : REVIEW_DEFAULTS.jumpLevels;
  if (!isSafeIntegerInRange(jumpLevels, 1, MAX_JUMP_LEVELS)) return refused('wrong-type', childPath(path, 'jumpLevels'));
  const topLevel = Object.prototype.hasOwnProperty.call(value, 'topLevel') ? ownValue(value, 'topLevel') : REVIEW_DEFAULTS.topLevel;
  if (typeof topLevel !== 'boolean') return refused('wrong-type', childPath(path, 'topLevel'));
  const age = Object.prototype.hasOwnProperty.call(value, 'lowerRequestAgeDays') ? ownValue(value, 'lowerRequestAgeDays') : REVIEW_DEFAULTS.lowerRequestAgeDays;
  if (!isSafeIntegerInRange(age, 1, MAX_REQUEST_AGE_DAYS)) return refused('wrong-type', childPath(path, 'lowerRequestAgeDays'));
  return { ok: true, value: Object.freeze({ jumpLevels, topLevel, lowerRequestAgeDays: age }) };
}

/** Whether a marking pattern is plain words: letters and digits of any script with single spaces, `-` and `/` between them, at most 64 characters. */
export function isMarkingPattern(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PATTERN && value === value.normalize('NFC') && PATTERN_WORDS.test(value)
    && !/[ /-]$/.test(value);
}

function parseMarking(value: unknown, scales: ScaleTable, path: string): Parsed<MarkingPattern> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['id', 'pattern', 'label']);
  if (keys !== undefined) return keys;
  const id = ownValue(value, 'id');
  if (typeof id !== 'string' || !SECTION_ENTRY_ID.test(id)) return refused('wrong-type', childPath(path, 'id'));
  const pattern = ownValue(value, 'pattern');
  if (typeof pattern !== 'string' || pattern === '') return refused('wrong-type', childPath(path, 'pattern'));
  if (!isMarkingPattern(pattern)) return refused('not-allowed-here', childPath(path, 'pattern'));
  const label = parseLabel(ownValue(value, 'label'), scales, childPath(path, 'label'));
  if (!label.ok) return label;
  return { ok: true, value: Object.freeze({ id, pattern, label: label.value }) };
}

function optional<T>(opened: Fields, key: string, fallback: T, parse: (value: unknown) => Parsed<T>): Parsed<T> {
  return Object.prototype.hasOwnProperty.call(opened, key) ? parse(ownValue(opened, key)) : { ok: true, value: fallback };
}

function parseFactTypes(value: unknown, path: string): Parsed<readonly string[]> {
  if (!Array.isArray(value) || value.length > MAX_FACT_TYPES) return refused('wrong-type', path);
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    const where = `${path}[${String(index)}]`;
    if (typeof entry !== 'string' || !FACT_TYPE_PATTERN.test(entry)) return refused('wrong-type', where);
    if ((BASE_FACT_TYPES as readonly string[]).includes(entry)) return refused('duplicate', where);
    if (index > 0) {
      const before = value[index - 1] as string;
      if (entry === before) return refused('duplicate', where);
      if (entry < before) return refused('not-sorted', where);
    }
  }
  return { ok: true, value: Object.freeze([...(value as string[])]) };
}

function parseCodeWord(value: unknown, scales: ScaleTable, path: string): Parsed<CodeWord> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['id', 'token', 'label']);
  if (keys !== undefined) return keys;
  const id = ownValue(value, 'id');
  if (typeof id !== 'string' || !SECTION_ENTRY_ID.test(id)) return refused('wrong-type', childPath(path, 'id'));
  const token = ownValue(value, 'token');
  if (typeof token !== 'string' || !LABEL_TOKEN_PATTERN.test(token)) return refused('wrong-type', childPath(path, 'token'));
  const label = parseLabel(ownValue(value, 'label'), scales, childPath(path, 'label'));
  if (!label.ok) return label;
  return { ok: true, value: Object.freeze({ id, token, label: label.value }) };
}

function parseCodeWords(value: unknown, scales: ScaleTable, path: string): Parsed<CodeWords> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['listLabel', 'entries']);
  if (keys !== undefined) return keys;
  const listLabel = parseLabel(ownValue(value, 'listLabel'), scales, childPath(path, 'listLabel'));
  if (!listLabel.ok) return listLabel;
  const entries = parseSetList(ownValue(value, 'entries'), childPath(path, 'entries'), MAX_CODE_WORDS, (item, where) => parseCodeWord(item, scales, where), (entry) => entry.id);
  if (!entries.ok) return entries;
  const tokens = new Set<string>();
  for (let index = 0; index < entries.value.length; index += 1) {
    const token = (entries.value[index] as CodeWord).token;
    if (tokens.has(token)) return refused('duplicate', `${childPath(path, 'entries')}[${String(index)}].token`);
    tokens.add(token);
  }
  return { ok: true, value: Object.freeze({ listLabel: listLabel.value, entries: entries.value }) };
}

function plainText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && !LINE_BREAK.test(value) && !CONTROL.test(value) && value.trim() === value;
}

function parseWhen(value: unknown, factTypes: readonly string[], path: string): Parsed<FactPattern> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['allOf'], ['sameSubject']);
  if (keys !== undefined) return keys;
  const known = (type: string): boolean => (BASE_FACT_TYPES as readonly string[]).includes(type) || factTypes.includes(type);
  const allOf = ownValue(value, 'allOf');
  const allOfPath = childPath(path, 'allOf');
  if (!Array.isArray(allOf) || allOf.length > MAX_ALL_OF) return refused('wrong-type', allOfPath);
  if (allOf.length === 0) return refused('empty-list', allOfPath);
  for (let index = 0; index < allOf.length; index += 1) {
    const entry: unknown = allOf[index];
    const where = `${allOfPath}[${String(index)}]`;
    if (typeof entry !== 'string') return refused('wrong-type', where);
    if (!known(entry)) return refused('not-allowed-here', where);
    if (index > 0) {
      const before = allOf[index - 1] as string;
      if (entry === before) return refused('duplicate', where);
      if (entry < before) return refused('not-sorted', where);
    }
  }
  const sameSubject = Object.prototype.hasOwnProperty.call(value, 'sameSubject') ? ownValue(value, 'sameSubject') : false;
  if (typeof sameSubject !== 'boolean') return refused('wrong-type', childPath(path, 'sameSubject'));
  return { ok: true, value: Object.freeze({ allOf: Object.freeze([...(allOf as string[])]), sameSubject }) };
}

function parseRule(value: unknown, scales: ScaleTable, factTypes: readonly string[], path: string): Parsed<ClassificationRule> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['id', 'guideRef', 'label', 'description', 'when', 'then']);
  if (keys !== undefined) return keys;
  const id = ownValue(value, 'id');
  if (typeof id !== 'string' || !SECTION_ENTRY_ID.test(id)) return refused('wrong-type', childPath(path, 'id'));
  const guideRef = ownValue(value, 'guideRef');
  if (!plainText(guideRef, MAX_GUIDE_REF)) return refused('wrong-type', childPath(path, 'guideRef'));
  const label = parseLabel(ownValue(value, 'label'), scales, childPath(path, 'label'));
  if (!label.ok) return label;
  const description = ownValue(value, 'description');
  if (!plainText(description, MAX_DESCRIPTION)) return refused('wrong-type', childPath(path, 'description'));
  const when = parseWhen(ownValue(value, 'when'), factTypes, childPath(path, 'when'));
  if (!when.ok) return when;
  const then = parseLabel(ownValue(value, 'then'), scales, childPath(path, 'then'));
  if (!then.ok) return then;
  return { ok: true, value: Object.freeze({ id, guideRef, label: label.value, description, when: when.value, then: then.value }) };
}

function parseRules(value: unknown, scales: ScaleTable, factTypes: readonly string[], path: string): Parsed<readonly ClassificationRule[]> {
  return parseSetList(value, path, MAX_RULES, (item, where) => parseRule(item, scales, factTypes, where), (entry) => entry.id);
}

/** Rule ids are unique across guide and compilation rules, and there are at most 512 rules in all. */
function checkRuleIds(guide: readonly ClassificationRule[], compilation: readonly ClassificationRule[], path: string): Refusal | undefined {
  if (guide.length + compilation.length > MAX_RULES) return refused('not-allowed-here', childPath(path, 'compilationRules'));
  const ids = new Set(guide.map((entry) => entry.id));
  const clash = compilation.findIndex((entry) => ids.has(entry.id));
  return clash < 0 ? undefined : refused('duplicate', `${childPath(path, 'compilationRules')}[${String(clash)}]`);
}

/**
 * Parses the section against the policy's scales. Defaults are filled (shadow mode by default, no level in enforce, no role, the review defaults, no
 * marking, fact type or rule), so a parsed section is its own wire form; `systemHigh` and `codeWords` stay absent when absent. One plain reason per problem, as every Phase 41 section.
 */
export function parseClassificationSection(value: unknown, scales: ScaleTable, path = 'classification'): Parsed<ClassificationSection> {
  const section = openSection(value, path, [], CLASSIFICATION_SECTION_KEYS);
  if (!section.ok) return section;
  const opened = section.value;
  const out: Record<string, unknown> = { v: 1 };
  if (Object.prototype.hasOwnProperty.call(opened, 'systemHigh')) {
    const systemHigh = parseSystemHigh(ownValue(opened, 'systemHigh'), scales, childPath(path, 'systemHigh'));
    if (!systemHigh.ok) return systemHigh;
    out['systemHigh'] = systemHigh.value;
  }
  const thresholds = optional(opened, 'thresholds', Object.freeze({}) as Readonly<Record<string, ThresholdEntry>>,
    (item) => parseThresholds(item, scales, childPath(path, 'thresholds')));
  if (!thresholds.ok) return thresholds;
  out['thresholds'] = thresholds.value;
  const shadow = optional(opened, 'shadow', Object.freeze({ defaultMode: 'shadow', levels: Object.freeze([]) }) as ShadowSettings,
    (item) => parseShadow(item, thresholds.value, childPath(path, 'shadow')));
  if (!shadow.ok) return shadow;
  out['shadow'] = shadow.value;
  const roles = optional(opened, 'roles', Object.freeze([]) as readonly RoleEntry[], (item) => parseSetList(
    item, childPath(path, 'roles'), MAX_ROLES, (entry, where) => parseRole(entry, thresholds.value, where), (entry) => `${entry.passport} ${entry.role}`
  ));
  if (!roles.ok) return roles;
  out['roles'] = roles.value;
  const review = optional(opened, 'review', REVIEW_DEFAULTS, (item) => parseReview(item, childPath(path, 'review')));
  if (!review.ok) return review;
  out['review'] = review.value;
  const markings = optional(opened, 'markings', Object.freeze([]) as readonly MarkingPattern[], (item) => parseSetList(
    item, childPath(path, 'markings'), MAX_MARKINGS, (entry, where) => parseMarking(entry, scales, where), (entry) => entry.id
  ));
  if (!markings.ok) return markings;
  out['markings'] = markings.value;
  if (Object.prototype.hasOwnProperty.call(opened, 'codeWords')) {
    const codeWords = parseCodeWords(ownValue(opened, 'codeWords'), scales, childPath(path, 'codeWords'));
    if (!codeWords.ok) return codeWords;
    out['codeWords'] = codeWords.value;
  }
  const factTypes = optional(opened, 'factTypes', Object.freeze([]) as readonly string[], (item) => parseFactTypes(item, childPath(path, 'factTypes')));
  if (!factTypes.ok) return factTypes;
  out['factTypes'] = factTypes.value;
  const guideRules = optional(opened, 'guideRules', Object.freeze([]) as readonly ClassificationRule[],
    (item) => parseRules(item, scales, factTypes.value, childPath(path, 'guideRules')));
  if (!guideRules.ok) return guideRules;
  out['guideRules'] = guideRules.value;
  const compilationRules = optional(opened, 'compilationRules', Object.freeze([]) as readonly ClassificationRule[],
    (item) => parseRules(item, scales, factTypes.value, childPath(path, 'compilationRules')));
  if (!compilationRules.ok) return compilationRules;
  out['compilationRules'] = compilationRules.value;
  const clash = checkRuleIds(guideRules.value, compilationRules.value, path);
  if (clash !== undefined) return clash;
  return { ok: true, value: Object.freeze(out) as unknown as ClassificationSection };
}

/** The system-high label of a scale, or undefined when the section names none for it. */
export function systemHighOn(section: ClassificationSection, scale: string): Label | undefined {
  return section.systemHigh?.find((label) => label.scale === scale);
}

/** The threshold entry of a `scale/level`, by own property only. */
export function thresholdFor(section: ClassificationSection, label: Pick<Label, 'scale' | 'level'>): ThresholdEntry | undefined {
  const key = labelKey(label);
  return Object.prototype.hasOwnProperty.call(section.thresholds, key) ? section.thresholds[key] : undefined;
}

