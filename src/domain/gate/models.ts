// The `models` section of policy bundle v2 (models@1, FND-08, Phase 41 D-42): the model passport schema of the model provenance design (5.1 to 5.3),
// anchored model matching where the stricter of two passports wins, and the passport hash. Pure: no I/O, no clock, no vscode, no package.
// Keys are exact at every level (checkKeys), values are read as own properties and never spread, every result is frozen, and set-like lists are sorted
// and unique so two sections that mean the same thing hash the same. A section that is exactly `{ v: 1 }` is the empty section (41-01's wire form) and
// stays `{ v: 1 }`; any other section has `mode` (report) and `unknownMaxTier` (T0) filled, so a parsed section is its own wire form.
// Report mode only in Phase 41: nothing here refuses a request. 41-10's passport step of decideRoute calls these helpers and records `wouldRefuse`.
// This file imports nothing from bundle.ts: 41-10's routing.ts imports it, and bundle.ts imports routing.ts, which would make a load-time cycle.
// ENDPOINT_CLASSES is used only inside functions, never at module load.
import { createHash } from 'node:crypto';
import { canonicalBytes } from '../team/canonical';
import { ENDPOINT_CLASSES } from './endpoints';
import type { EndpointClass } from './endpoints';
import type { ScaleTable } from './labels';
import { checkKeys, childPath, isRecord, ownValue, parseIsoMillis, refused } from './shape';
import type { Fields, Parsed, Refusal } from './shape';

/** The use tiers of provenance 3.2, lowest first: research only, chat you review, agent work, operational work. */
export const USE_TIERS = Object.freeze(['T0', 'T1', 'T2', 'T3'] as const);
export type UseTier = (typeof USE_TIERS)[number];

/** The jobs a default model is named for (provenance 5.1, "Models by job"). */
export const MODEL_JOBS = Object.freeze(['standard', 'deep', 'fast', 'vision', 'embed', 'rerank', 'safety', 'transcription', 'image', 'backup', 't0'] as const);
export type ModelJob = (typeof MODEL_JOBS)[number];

/** `report` works out and records every decision without refusing; `enforce` refuses (Phase 74.1). */
export const MODELS_MODES = Object.freeze(['report', 'enforce'] as const);
export type ModelsMode = (typeof MODELS_MODES)[number];

export const MAX_PASSPORTS = 256;
export const MAX_MATCH_PATTERNS = 8;
/** A passport lives at most this long after it is issued. */
export const MAX_PASSPORT_DAYS = 365;
const MAX_LIST = 16;
const MAX_LIST_TEXT = 128;
const DAY_MS = 24 * 60 * 60 * 1000;

export const TEACHER_METHODS = Object.freeze(['synthetic-data', 'distillation', 'preference'] as const);
export type TeacherMethod = (typeof TEACHER_METHODS)[number];
/** How an artifact was made from its base, joined with `+` in `lineage.method`. */
export const LINEAGE_METHODS = Object.freeze(['pretrain', 'sft', 'rl', 'lora', 'qlora', 'merge', 'abliteration', 'quantization'] as const);
/** Weight formats a passport may name: never pickle. */
export const ARTIFACT_FORMATS = Object.freeze(['gguf', 'safetensors'] as const);
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number];
/** The triggers that end a passport early (provenance 5.4). */
export const REEVALUATION_TRIGGERS = Object.freeze(['artifact-change', 'quantization', 'fine-tune', 'licence-change', 'us-law-change', 'canada-law-change', 'hosting-change'] as const);
export type ReevaluationTrigger = (typeof REEVALUATION_TRIGGERS)[number];

export interface PassportTeacher {
  readonly model: string;
  /** ISO 3166-1 alpha-2 of the teacher's developer. */
  readonly origin: string;
  readonly method: TeacherMethod;
}

export interface PassportLineage {
  /** The family of the base, a short token (`nemotron`, `llama`, `qwen`, ...): the different-lineage rule reads it. */
  readonly family: string;
  readonly base: string;
  readonly teachers: readonly PassportTeacher[];
  /** `pretrain+sft+rl` and the like. */
  readonly method: string;
}

export interface PassportLicence {
  readonly id: string;
  readonly obligations: readonly string[];
  readonly inherited: readonly string[];
}

export interface PassportLegal {
  readonly coveredByUsLaw: boolean;
  readonly entityList: boolean;
  readonly removalOrders: readonly string[];
}

export interface PassportArtifact {
  readonly format: ArtifactFormat;
  /** SHA-256 of the exact weights, 64 lowercase hex. */
  readonly sha256: string;
  readonly quantization: string;
  readonly remoteCode: false;
}

export interface PassportEvaluation {
  /** A URI or document id of your organization's evaluation report for this exact artifact. */
  readonly report: string;
  readonly sha256: string;
  readonly at: string;
}

/** One model passport (provenance 5.2). */
export interface Passport {
  readonly id: string;
  /** One to eight anchored, case-sensitive model id patterns; `*` is the only wildcard and never stands alone. Sorted and unique. */
  readonly match: readonly string[];
  readonly developer: string;
  /** ISO 3166-1 alpha-2 of the base model's developer; `XX` is unknown and caps the passport at T0. */
  readonly origin: string;
  readonly lineage: PassportLineage;
  readonly licence: PassportLicence;
  readonly legal: PassportLegal;
  /** The endpoint classes the model may run on, sorted and unique. */
  readonly hosting: readonly EndpointClass[];
  readonly artifact?: PassportArtifact;
  readonly evaluation?: PassportEvaluation;
  readonly maxTier: UseTier;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** Sorted and unique. */
  readonly reevaluateOn: readonly ReevaluationTrigger[];
}

/**
 * The models section. `mode`, `unknownMaxTier` and `passports` are absent only in the empty section `{ v: 1 }`, which means the shipped behaviour: report
 * mode, T0 for a model with no passport and the shipped passports alone.
 */
export interface ModelsSection {
  readonly v: 1;
  readonly mode?: ModelsMode;
  readonly unknownMaxTier?: 'T0';
  readonly passports?: readonly Passport[];
}

/** The passport a model id resolves to, with its hash and its tier at the time asked. */
export interface ResolvedPassport {
  readonly passport: Passport;
  readonly hash: string;
  /** effectiveMaxTier at the time asked: T0 when expired, not yet issued, legally flagged or of unknown origin. */
  readonly maxTier: UseTier;
  readonly source: 'policy' | 'shipped';
}

/** The keys of the models section in the provenance design's schema (WP-0), in the order the design lists them. */
export const MODELS_SECTION_KEYS = Object.freeze(['mode', 'unknownMaxTier', 'tierByLevel', 'tierByProject', 'passports', 'defaults', 'localCatalogue', 'order'] as const);
/** The keys a later task of plan 41-05 reads; refused as not available yet until then. */
const NOT_YET = Object.freeze(['tierByLevel', 'tierByProject', 'defaults', 'localCatalogue', 'order']);

const PASSPORT_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const MATCH_PATTERN = /^[A-Za-z0-9._/:*-]{1,128}$/;
const ORIGIN_PATTERN = /^[A-Z]{2}$/;
const FAMILY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Small readers

function has(value: Fields, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseText(value: unknown, path: string, max: number): Parsed<string> {
  if (typeof value !== 'string' || value === '' || value.length > max || CONTROL_CHARACTERS.test(value)) return refused('wrong-type', path);
  return { ok: true, value };
}

function parsePattern(value: unknown, path: string, pattern: RegExp): Parsed<string> {
  return typeof value === 'string' && pattern.test(value) ? { ok: true, value } : refused('wrong-type', path);
}

function parseChoice<T extends string>(value: unknown, path: string, allowed: readonly T[]): Parsed<T> {
  if (typeof value !== 'string') return refused('wrong-type', path);
  const found = allowed.find((candidate) => candidate === value);
  return found === undefined ? refused('not-allowed-here', path) : { ok: true, value: found };
}

function parseFlag(value: unknown, path: string): Parsed<boolean> {
  return typeof value === 'boolean' ? { ok: true, value } : refused('wrong-type', path);
}

function parseTime(value: unknown, path: string): Parsed<string> {
  return typeof value === 'string' && !Number.isNaN(parseIsoMillis(value)) ? { ok: true, value } : refused('wrong-type', path);
}

function parseList<T>(value: unknown, path: string, max: number, one: (item: unknown, where: string) => Parsed<T>): Parsed<readonly T[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  if (value.length > max) return refused('not-allowed-here', path);
  const out: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = one(value[index], `${path}[${String(index)}]`);
    if (!item.ok) return item;
    out.push(item.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

/** A set-like list has one valid order: strictly ascending by key. A repeat is `duplicate` wherever it sits; any other step back is `not-sorted`. */
function checkSetOrder(keys: readonly string[], path: string): Refusal | undefined {
  const seen = new Set<string>();
  let before: string | undefined;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    const where = `${path}[${String(index)}]`;
    if (seen.has(key)) return refused('duplicate', where);
    if (before !== undefined && key < before) return refused('not-sorted', where);
    seen.add(key);
    before = key;
  }
  return undefined;
}

function parseSetList<T>(value: unknown, path: string, max: number, one: (item: unknown, where: string) => Parsed<T>, keyOf: (item: T) => string): Parsed<readonly T[]> {
  const list = parseList(value, path, max, one);
  if (!list.ok) return list;
  return checkSetOrder(list.value.map(keyOf), path) ?? list;
}

function parseTextList(value: unknown, path: string): Parsed<readonly string[]> {
  return parseList(value, path, MAX_LIST, (item, where) => parseText(item, where, MAX_LIST_TEXT));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// One parser per object

function parseTeacher(value: unknown, path: string): Parsed<PassportTeacher> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['model', 'origin', 'method']);
  if (keys !== undefined) return keys;
  const model = parseText(ownValue(value, 'model'), childPath(path, 'model'), MAX_LIST_TEXT);
  if (!model.ok) return model;
  const origin = parsePattern(ownValue(value, 'origin'), childPath(path, 'origin'), ORIGIN_PATTERN);
  if (!origin.ok) return origin;
  const method = parseChoice(ownValue(value, 'method'), childPath(path, 'method'), TEACHER_METHODS);
  if (!method.ok) return method;
  return { ok: true, value: Object.freeze({ model: model.value, origin: origin.value, method: method.value }) };
}

function parseLineageMethod(value: unknown, path: string): Parsed<string> {
  if (typeof value !== 'string' || value === '' || value.length > MAX_LIST_TEXT) return refused('wrong-type', path);
  const tokens = value.split('+');
  if (new Set(tokens).size !== tokens.length) return refused('wrong-type', path);
  if (!tokens.every((token) => (LINEAGE_METHODS as readonly string[]).includes(token))) return refused('wrong-type', path);
  return { ok: true, value };
}

function parseLineage(value: unknown, path: string): Parsed<PassportLineage> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['family', 'base', 'teachers', 'method']);
  if (keys !== undefined) return keys;
  const family = parsePattern(ownValue(value, 'family'), childPath(path, 'family'), FAMILY_PATTERN);
  if (!family.ok) return family;
  const base = parseText(ownValue(value, 'base'), childPath(path, 'base'), MAX_LIST_TEXT);
  if (!base.ok) return base;
  const teachers = parseList(ownValue(value, 'teachers'), childPath(path, 'teachers'), MAX_LIST, parseTeacher);
  if (!teachers.ok) return teachers;
  const method = parseLineageMethod(ownValue(value, 'method'), childPath(path, 'method'));
  if (!method.ok) return method;
  return { ok: true, value: Object.freeze({ family: family.value, base: base.value, teachers: teachers.value, method: method.value }) };
}

function parseLicence(value: unknown, path: string): Parsed<PassportLicence> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['id', 'obligations', 'inherited']);
  if (keys !== undefined) return keys;
  const id = parseText(ownValue(value, 'id'), childPath(path, 'id'), MAX_LIST_TEXT);
  if (!id.ok) return id;
  const obligations = parseTextList(ownValue(value, 'obligations'), childPath(path, 'obligations'));
  if (!obligations.ok) return obligations;
  const inherited = parseTextList(ownValue(value, 'inherited'), childPath(path, 'inherited'));
  if (!inherited.ok) return inherited;
  return { ok: true, value: Object.freeze({ id: id.value, obligations: obligations.value, inherited: inherited.value }) };
}

function parseLegal(value: unknown, path: string): Parsed<PassportLegal> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['coveredByUsLaw', 'entityList', 'removalOrders']);
  if (keys !== undefined) return keys;
  const coveredByUsLaw = parseFlag(ownValue(value, 'coveredByUsLaw'), childPath(path, 'coveredByUsLaw'));
  if (!coveredByUsLaw.ok) return coveredByUsLaw;
  const entityList = parseFlag(ownValue(value, 'entityList'), childPath(path, 'entityList'));
  if (!entityList.ok) return entityList;
  const removalOrders = parseTextList(ownValue(value, 'removalOrders'), childPath(path, 'removalOrders'));
  if (!removalOrders.ok) return removalOrders;
  return { ok: true, value: Object.freeze({ coveredByUsLaw: coveredByUsLaw.value, entityList: entityList.value, removalOrders: removalOrders.value }) };
}

function parseArtifact(value: unknown, path: string): Parsed<PassportArtifact> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['format', 'sha256', 'quantization', 'remoteCode']);
  if (keys !== undefined) return keys;
  const format = parseChoice(ownValue(value, 'format'), childPath(path, 'format'), ARTIFACT_FORMATS);
  if (!format.ok) return format;
  const sha256 = parsePattern(ownValue(value, 'sha256'), childPath(path, 'sha256'), HEX_64);
  if (!sha256.ok) return sha256;
  const quantization = parseText(ownValue(value, 'quantization'), childPath(path, 'quantization'), 64);
  if (!quantization.ok) return quantization;
  const remoteCode = ownValue(value, 'remoteCode');
  if (remoteCode !== false) return refused('wrong-type', childPath(path, 'remoteCode'));
  return { ok: true, value: Object.freeze({ format: format.value, sha256: sha256.value, quantization: quantization.value, remoteCode }) };
}

function parseEvaluation(value: unknown, path: string): Parsed<PassportEvaluation> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['report', 'sha256', 'at']);
  if (keys !== undefined) return keys;
  const report = parseText(ownValue(value, 'report'), childPath(path, 'report'), 256);
  if (!report.ok) return report;
  const sha256 = parsePattern(ownValue(value, 'sha256'), childPath(path, 'sha256'), HEX_64);
  if (!sha256.ok) return sha256;
  const at = parseTime(ownValue(value, 'at'), childPath(path, 'at'));
  if (!at.ok) return at;
  return { ok: true, value: Object.freeze({ report: report.value, sha256: sha256.value, at: at.value }) };
}

function parseMatch(value: unknown, path: string): Parsed<readonly string[]> {
  if (Array.isArray(value) && value.length === 0) return refused('empty-list', path);
  return parseSetList(value, path, MAX_MATCH_PATTERNS, (item, where) => parsePattern(item, where, MATCH_PATTERN), (item) => item);
}

function parseHosting(value: unknown, path: string): Parsed<readonly EndpointClass[]> {
  if (Array.isArray(value) && value.length === 0) return refused('empty-list', path);
  return parseSetList(value, path, ENDPOINT_CLASSES.length, (item, where) => parseChoice(item, where, ENDPOINT_CLASSES), (item) => item);
}

const PASSPORT_REQUIRED = ['id', 'match', 'developer', 'origin', 'lineage', 'licence', 'legal', 'hosting', 'maxTier', 'issuedAt', 'expiresAt', 'reevaluateOn'] as const;

function parsePassport(value: unknown, path: string): Parsed<Passport> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, PASSPORT_REQUIRED, ['artifact', 'evaluation']);
  if (keys !== undefined) return keys;
  const id = parsePattern(ownValue(value, 'id'), childPath(path, 'id'), PASSPORT_ID_PATTERN);
  if (!id.ok) return id;
  const match = parseMatch(ownValue(value, 'match'), childPath(path, 'match'));
  if (!match.ok) return match;
  const developer = parseText(ownValue(value, 'developer'), childPath(path, 'developer'), 64);
  if (!developer.ok) return developer;
  const origin = parsePattern(ownValue(value, 'origin'), childPath(path, 'origin'), ORIGIN_PATTERN);
  if (!origin.ok) return origin;
  const lineage = parseLineage(ownValue(value, 'lineage'), childPath(path, 'lineage'));
  if (!lineage.ok) return lineage;
  const licence = parseLicence(ownValue(value, 'licence'), childPath(path, 'licence'));
  if (!licence.ok) return licence;
  const legal = parseLegal(ownValue(value, 'legal'), childPath(path, 'legal'));
  if (!legal.ok) return legal;
  const hosting = parseHosting(ownValue(value, 'hosting'), childPath(path, 'hosting'));
  if (!hosting.ok) return hosting;
  const out: Record<string, unknown> = {
    id: id.value, match: match.value, developer: developer.value, origin: origin.value, lineage: lineage.value, licence: licence.value,
    legal: legal.value, hosting: hosting.value
  };
  if (has(value, 'artifact')) {
    const artifact = parseArtifact(ownValue(value, 'artifact'), childPath(path, 'artifact'));
    if (!artifact.ok) return artifact;
    out['artifact'] = artifact.value;
  }
  if (has(value, 'evaluation')) {
    const evaluation = parseEvaluation(ownValue(value, 'evaluation'), childPath(path, 'evaluation'));
    if (!evaluation.ok) return evaluation;
    out['evaluation'] = evaluation.value;
  }
  const maxTier = parseChoice(ownValue(value, 'maxTier'), childPath(path, 'maxTier'), USE_TIERS);
  if (!maxTier.ok) return maxTier;
  const issuedAt = parseTime(ownValue(value, 'issuedAt'), childPath(path, 'issuedAt'));
  if (!issuedAt.ok) return issuedAt;
  const expiresAt = parseTime(ownValue(value, 'expiresAt'), childPath(path, 'expiresAt'));
  if (!expiresAt.ok) return expiresAt;
  const reevaluateOn = parseSetList(ownValue(value, 'reevaluateOn'), childPath(path, 'reevaluateOn'), REEVALUATION_TRIGGERS.length, (item, where) => parseChoice(item, where, REEVALUATION_TRIGGERS), (item) => item);
  if (!reevaluateOn.ok) return reevaluateOn;
  out['maxTier'] = maxTier.value;
  out['issuedAt'] = issuedAt.value;
  out['expiresAt'] = expiresAt.value;
  out['reevaluateOn'] = reevaluateOn.value;
  return { ok: true, value: Object.freeze(out) as unknown as Passport };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The section

/** Reads the models section against the document's scales (the scales name the levels of `tierByLevel`). */
export function parseModelsSection(value: unknown, scales: ScaleTable, path = 'models'): Parsed<ModelsSection> {
  void scales;
  if (!isRecord(value)) return refused('wrong-type', path);
  const v = ownValue(value, 'v');
  if (typeof v === 'number' && v !== 1) return refused('unknown-version', childPath(path, 'v'));
  const keys = checkKeys(value, path, ['v'], MODELS_SECTION_KEYS);
  if (keys !== undefined) return keys;
  if (v !== 1) return refused('wrong-type', childPath(path, 'v'));
  for (const key of NOT_YET) if (has(value, key)) return refused('not-available-yet', childPath(path, key));
  if (Object.keys(value).length === 1) return { ok: true, value: Object.freeze({ v: 1 }) };
  let mode: ModelsMode = 'report';
  if (has(value, 'mode')) {
    const parsedMode = parseChoice(ownValue(value, 'mode'), childPath(path, 'mode'), MODELS_MODES);
    if (!parsedMode.ok) return parsedMode;
    mode = parsedMode.value;
  }
  if (has(value, 'unknownMaxTier')) {
    const unknown = parseChoice(ownValue(value, 'unknownMaxTier'), childPath(path, 'unknownMaxTier'), ['T0'] as const);
    if (!unknown.ok) return unknown;
  }
  let passports: readonly Passport[] = Object.freeze([]);
  if (has(value, 'passports')) {
    const parsedPassports = parseSetList(ownValue(value, 'passports'), childPath(path, 'passports'), MAX_PASSPORTS, parsePassport, (item) => item.id);
    if (!parsedPassports.ok) return parsedPassports;
    passports = parsedPassports.value;
  }
  return { ok: true, value: Object.freeze({ v: 1, mode, unknownMaxTier: 'T0', passports }) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Matching and resolving

/**
 * Whether a model id matches a passport pattern: anchored at both ends, case-sensitive, `*` the only wildcard (any run of characters, also none). The
 * pattern is split on `*` and its pieces found in order, which is what the anchored regular expression of the pieces would do, without building a
 * regular expression from policy text (no backtracking on a hostile pattern). Never a substring match.
 */
export function matchesModelPattern(pattern: string, id: string): boolean {
  if (typeof pattern !== 'string' || typeof id !== 'string') return false;
  const pieces = pattern.split('*');
  if (pieces.length === 1) return pattern === id;
  const first = pieces[0] as string;
  const last = pieces[pieces.length - 1] as string;
  if (id.length < first.length + last.length || !id.startsWith(first) || !id.endsWith(last)) return false;
  const middle = id.slice(first.length, id.length - last.length);
  let at = 0;
  for (let index = 1; index < pieces.length - 1; index += 1) {
    const piece = pieces[index] as string;
    const found = middle.indexOf(piece, at);
    if (found < 0) return false;
    at = found + piece.length;
  }
  return true;
}

function tierRank(tier: UseTier): number {
  return USE_TIERS.indexOf(tier);
}

/** The tier a passport may serve whatever the time: T0 for an unknown origin, a legal flag or a removal order, else its maxTier. */
function declaredMaxTier(passport: Passport): UseTier {
  const legal = passport.legal;
  if (passport.origin === 'XX' || legal.coveredByUsLaw || legal.entityList || legal.removalOrders.length > 0) return 'T0';
  return passport.maxTier;
}

/** The tier a passport serves at `now`: T0 when expired or not yet issued, and the caps of declaredMaxTier. */
export function effectiveMaxTier(passport: Passport, now: number): UseTier {
  const issued = parseIsoMillis(passport.issuedAt);
  const expires = parseIsoMillis(passport.expiresAt);
  if (!(now >= issued && now < expires)) return 'T0';
  return declaredMaxTier(passport);
}

/** SHA-256 hex of the passport's canonical bytes: bundleHash's computation, without importing bundle.ts. Records cite it. */
export function passportHash(passport: Passport): string {
  return createHash('sha256').update(canonicalBytes(passport)).digest('hex');
}

function shippedCandidates(): readonly Passport[] {
  return [];
}

/**
 * The passport for a model id, or undefined (an unknown model, which counts as T0). Candidates are the section's passports and the shipped ones whose id
 * the section does not use (your organization's passport replaces a shipped one by id). Of those whose pattern matches, the stricter wins: the lower
 * tier at `now`, then the earlier expiry, then the lower id.
 */
export function resolvePassport(models: ModelsSection | undefined, modelId: string, now: number): ResolvedPassport | undefined {
  const own = models?.passports ?? [];
  const ownIds = new Set(own.map((passport) => passport.id));
  const candidates: Array<{ passport: Passport; source: 'policy' | 'shipped' }> = [];
  for (const passport of own) candidates.push({ passport, source: 'policy' });
  for (const passport of shippedCandidates()) if (!ownIds.has(passport.id)) candidates.push({ passport, source: 'shipped' });
  let best: { passport: Passport; source: 'policy' | 'shipped'; tier: UseTier; expires: number } | undefined;
  for (const candidate of candidates) {
    if (!candidate.passport.match.some((pattern) => matchesModelPattern(pattern, modelId))) continue;
    const tier = effectiveMaxTier(candidate.passport, now);
    const expires = parseIsoMillis(candidate.passport.expiresAt);
    if (best === undefined || stricter(tier, expires, candidate.passport.id, best)) best = { ...candidate, tier, expires };
  }
  if (best === undefined) return undefined;
  return Object.freeze({ passport: best.passport, hash: passportHash(best.passport), maxTier: best.tier, source: best.source });
}

function stricter(tier: UseTier, expires: number, id: string, than: { tier: UseTier; expires: number; passport: Passport }): boolean {
  if (tierRank(tier) !== tierRank(than.tier)) return tierRank(tier) < tierRank(than.tier);
  if (expires !== than.expires) return expires < than.expires;
  return id < than.passport.id;
}
