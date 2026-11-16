// The signed policy bundle v1 (OFFL-02, OFFL-03, CLAS-02, CLAS-05, D-11 to D-15, D-39, D-47). Pure: no I/O, no clock (the caller passes `now`), no vscode, no
// package. The bundle is the ceiling: it holds what may happen at all, and a person's settings only narrow inside it. It is signed with the one signer
// Phase 69 built (signPayload, purpose policy-bundle) and checked with the one verifier (verifyPayload), so this file verifies and never signs, and it
// holds no key. Once a release ships a field its meaning never changes in place: a change is bundleVersion 2 beside this one, and the reserved fields
// (anchorRoots, statusLists, maxOfflineAge) are never dropped.
import { createHash } from 'node:crypto';
import type { ActionPolicyMode } from '../policy';
import { canonicalBytes, isStrictBase64url } from '../team/canonical';
import type { KeyStatusLookup } from '../team/keyStatus';
import { verifyPayload } from '../team/signedPayload';
import type { PayloadFailureReason, PayloadSignerRef } from '../team/signedPayload';
import { SCALE_PRESETS, parseClearance, parseLabel, parseMapping } from './labels';
import type { Clearance, Label, Scale, ScaleMapping, ScaleTable } from './labels';
import { DEFAULT_ROUTING, parseRouting } from './routing';
import type { RoutingTable } from './routing';
import { checkKeys, childPath, isRecord, ownValue, refused } from './shape';
import type { Parsed, Refusal } from './shape';
import { CAPABILITY_VERBS, GATE_VOCABULARY_VERSION, isCapabilityVerb } from './vocabulary';
import type { CapabilityVerb } from './vocabulary';

export const BUNDLE_VERSION = 1;

/** The contexts a capability can run in. `relay` and `routine` are validated and reserved: no tool lists them until Phases 74 and 77 (D-47). */
export const GATE_CONTEXTS = Object.freeze(['interactive', 'unattended', 'relay', 'routine'] as const);
export type GateContextName = (typeof GATE_CONTEXTS)[number];

const ACTION_MODES: readonly ActionPolicyMode[] = Object.freeze(['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'] as const);

export interface BundleIssuer {
  readonly fingerprint: string;
  /** The raw 32 byte Ed25519 key as base64url. */
  readonly publicKey: string;
  /** A slot for Phase 71's DID; absent now. */
  readonly did?: string;
}

export interface BundleCeiling {
  /** The highest approval mode allowed in each context. A setting can narrow below it and never widen past it. */
  readonly maxMode: Readonly<Record<GateContextName, ActionPolicyMode>>;
  /** For each verb, the contexts it may run in. A verb with no entry is allowed in no context. */
  readonly contexts: Readonly<Partial<Record<CapabilityVerb, readonly GateContextName[]>>>;
  /** MCP servers allowed in unattended runs, by id. Empty means none is named. */
  readonly unattendedMcp: readonly string[];
}

export interface PolicyBundle {
  readonly bundleVersion: 1;
  readonly vocabulary: 1;
  readonly issuer: BundleIssuer;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly ceiling: BundleCeiling;
  readonly scales: ScaleTable;
  readonly mappings: readonly ScaleMapping[];
  readonly clearances: readonly Clearance[];
  readonly routing: RoutingTable;
  readonly defaultLabel: Label;
  /** Reserved (D-12): validated for shape and ignored. */
  readonly anchorRoots: readonly unknown[];
  /** Reserved (D-12): validated for shape and ignored. */
  readonly statusLists: readonly unknown[];
  /** Reserved (D-12): scale/level to whole seconds, validated for shape and ignored. */
  readonly maxOfflineAge: Readonly<Record<string, number>>;
}

const BUNDLE_FIELDS = [
  'bundleVersion', 'vocabulary', 'issuer', 'issuedAt', 'expiresAt', 'ceiling', 'scales', 'mappings', 'clearances', 'routing', 'defaultLabel',
  'anchorRoots', 'statusLists', 'maxOfflineAge'
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
export const SELF_SIGNED_LIFETIME_DAYS = 365;

/** Epoch milliseconds in, so the folder holds no clock. */
export interface DefaultBundleInput {
  readonly issuer: BundleIssuer;
  readonly now: number;
}

function plainCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * What a fresh install gets: everything today's settings can allow, so it decides and routes exactly as it did before (D-11, D-24, D-27). Every verb runs
 * in interactive and unattended contexts except the reserved `gpu`, the two reserved contexts stay at approve-risky, the four scale presets ship with no
 * mapping, the one clearance is org Restricted (the whole commercial scale), and an unlabelled project is org Public. Returns a fresh object each call.
 */
export function defaultBundlePayload(input: DefaultBundleInput): PolicyBundle {
  const contexts: Partial<Record<CapabilityVerb, readonly GateContextName[]>> = {};
  for (const verb of CAPABILITY_VERBS) {
    if (verb !== 'gpu') contexts[verb] = ['interactive', 'unattended'];
  }
  const scales: Record<string, Scale> = {};
  for (const id of Object.keys(SCALE_PRESETS)) {
    const preset = SCALE_PRESETS[id] as Scale;
    scales[id] = { name: preset.name, levels: [...preset.levels] };
  }
  return plainCopy({
    bundleVersion: BUNDLE_VERSION,
    vocabulary: GATE_VOCABULARY_VERSION,
    issuer: input.issuer.did === undefined
      ? { fingerprint: input.issuer.fingerprint, publicKey: input.issuer.publicKey }
      : { fingerprint: input.issuer.fingerprint, publicKey: input.issuer.publicKey, did: input.issuer.did },
    issuedAt: new Date(input.now).toISOString(),
    expiresAt: new Date(input.now + SELF_SIGNED_LIFETIME_DAYS * DAY_MS).toISOString(),
    ceiling: {
      maxMode: { interactive: 'fully-autonomous', unattended: 'fully-autonomous', relay: 'approve-risky', routine: 'approve-risky' },
      contexts,
      unattendedMcp: []
    },
    scales,
    mappings: [],
    clearances: [{ scale: 'org', level: 'Restricted', compartments: [], releasability: [] }],
    routing: DEFAULT_ROUTING,
    defaultLabel: { scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] },
    anchorRoots: [],
    statusLists: [],
    maxOfflineAge: {}
  } as PolicyBundle);
}

/** Lowercase hex SHA-256 of the canonical bytes, so key order in a stored file never changes the hash and one changed value always does. */
export function bundleHash(payload: unknown): string {
  return createHash('sha256').update(canonicalBytes(payload)).digest('hex');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Parsing

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SCALE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const MAX_TEXT = 64;
const MAX_SERVER_ID = 128;
const MAX_SCALES = 16;
const MAX_LEVELS = 16;
const PUBLIC_KEY_BYTES = 32;

function isoMillis(value: string): number {
  if (!TIMESTAMP_PATTERN.test(value)) return Number.NaN;
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === value ? ms : Number.NaN;
}

function parseTimestamp(value: unknown, path: string): Parsed<string> {
  if (typeof value !== 'string' || Number.isNaN(isoMillis(value))) return refused('wrong-type', path);
  return { ok: true, value };
}

function parseText(value: unknown, path: string, max: number): Parsed<string> {
  if (typeof value !== 'string' || value === '' || value.length > max || CONTROL_CHARACTERS.test(value)) return refused('wrong-type', path);
  return { ok: true, value };
}

function parseIssuer(value: unknown, path: string): Parsed<BundleIssuer> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['fingerprint', 'publicKey'], ['did']);
  if (keys !== undefined) return keys;
  const fingerprint = ownValue(value, 'fingerprint');
  if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) return refused('wrong-type', childPath(path, 'fingerprint'));
  const publicKey = ownValue(value, 'publicKey');
  if (typeof publicKey !== 'string' || !isStrictBase64url(publicKey, PUBLIC_KEY_BYTES)) return refused('wrong-type', childPath(path, 'publicKey'));
  if (!Object.prototype.hasOwnProperty.call(value, 'did')) return { ok: true, value: Object.freeze({ fingerprint, publicKey }) };
  const did = ownValue(value, 'did');
  if (typeof did !== 'string' || did.length > 256 || !DID_PATTERN.test(did)) return refused('wrong-type', childPath(path, 'did'));
  return { ok: true, value: Object.freeze({ fingerprint, publicKey, did }) };
}

function parseContextList(value: unknown, path: string): Parsed<readonly GateContextName[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  const out: GateContextName[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const where = `${path}[${String(index)}]`;
    const entry: unknown = value[index];
    if (typeof entry !== 'string') return refused('wrong-type', where);
    const context = GATE_CONTEXTS.find((candidate) => candidate === entry);
    if (context === undefined) return refused('not-allowed-here', where);
    if (out.includes(context)) return refused('duplicate', where);
    out.push(context);
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseMaxMode(value: unknown, path: string): Parsed<Record<GateContextName, ActionPolicyMode>> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, GATE_CONTEXTS);
  if (keys !== undefined) return keys;
  const out = {} as Record<GateContextName, ActionPolicyMode>;
  for (const context of GATE_CONTEXTS) {
    const mode = ownValue(value, context);
    if (typeof mode !== 'string') return refused('wrong-type', childPath(path, context));
    const found = ACTION_MODES.find((candidate) => candidate === mode);
    if (found === undefined) return refused('not-allowed-here', childPath(path, context));
    out[context] = found;
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseContexts(value: unknown, path: string): Parsed<Partial<Record<CapabilityVerb, readonly GateContextName[]>>> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const out: Partial<Record<CapabilityVerb, readonly GateContextName[]>> = {};
  for (const key of Object.keys(value)) {
    if (!isCapabilityVerb(key)) return refused('unknown-verb', childPath(path, key.slice(0, 40)));
    const list = parseContextList(ownValue(value, key), childPath(path, key));
    if (!list.ok) return list;
    out[key] = list.value;
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseServerIds(value: unknown, path: string): Parsed<readonly string[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const where = `${path}[${String(index)}]`;
    const id = parseText(value[index], where, MAX_SERVER_ID);
    if (!id.ok) return id;
    // A server is named, never matched by a pattern: an unattended run only ever reaches a server a person wrote down.
    if (id.value.includes('*')) return refused('not-allowed-here', where);
    if (out.includes(id.value)) return refused('duplicate', where);
    out.push(id.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseCeiling(value: unknown, path: string): Parsed<BundleCeiling> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['maxMode', 'contexts', 'unattendedMcp']);
  if (keys !== undefined) return keys;
  const maxMode = parseMaxMode(ownValue(value, 'maxMode'), childPath(path, 'maxMode'));
  if (!maxMode.ok) return maxMode;
  const contexts = parseContexts(ownValue(value, 'contexts'), childPath(path, 'contexts'));
  if (!contexts.ok) return contexts;
  const unattendedMcp = parseServerIds(ownValue(value, 'unattendedMcp'), childPath(path, 'unattendedMcp'));
  if (!unattendedMcp.ok) return unattendedMcp;
  return { ok: true, value: Object.freeze({ maxMode: maxMode.value, contexts: contexts.value, unattendedMcp: unattendedMcp.value }) };
}

function parseScale(value: unknown, path: string): Parsed<Scale> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['name', 'levels']);
  if (keys !== undefined) return keys;
  const name = parseText(ownValue(value, 'name'), childPath(path, 'name'), MAX_TEXT);
  if (!name.ok) return name;
  const levels = ownValue(value, 'levels');
  const levelsPath = childPath(path, 'levels');
  if (!Array.isArray(levels)) return refused('wrong-type', levelsPath);
  if (levels.length === 0) return refused('empty-list', levelsPath);
  if (levels.length > MAX_LEVELS) return refused('not-allowed-here', levelsPath);
  const out: string[] = [];
  for (let index = 0; index < levels.length; index += 1) {
    const where = `${levelsPath}[${String(index)}]`;
    const level = parseText(levels[index], where, MAX_TEXT);
    if (!level.ok) return level;
    if (out.includes(level.value)) return refused('duplicate', where);
    out.push(level.value);
  }
  return { ok: true, value: Object.freeze({ name: name.value, levels: Object.freeze(out) }) };
}

function parseScales(value: unknown, path: string): Parsed<ScaleTable> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const ids = Object.keys(value);
  if (ids.length === 0) return refused('empty-list', path);
  if (ids.length > MAX_SCALES) return refused('not-allowed-here', path);
  const out: Record<string, Scale> = {};
  for (const id of ids) {
    if (!SCALE_ID_PATTERN.test(id)) return refused('wrong-type', childPath(path, id.slice(0, 40)));
    const scale = parseScale(ownValue(value, id), childPath(path, id));
    if (!scale.ok) return scale;
    out[id] = scale.value;
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseList<T>(value: unknown, path: string, one: (item: unknown, where: string) => Parsed<T>): Parsed<readonly T[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  const out: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = one(value[index], `${path}[${String(index)}]`);
    if (!item.ok) return item;
    out.push(item.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

/**
 * Checks a payload against the bundle v1 shape, in place and with exact keys at every level: an unknown field is refused, never ignored, and a missing
 * field is refused, so absent and empty are never confused. The vocabulary and bundle versions are read first so a newer bundle is reported as newer.
 */
export function parseBundle(value: unknown, path = ''): Parsed<PolicyBundle> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const version = ownValue(value, 'bundleVersion');
  if (typeof version === 'number' && version !== BUNDLE_VERSION) return refused('unknown-version', childPath(path, 'bundleVersion'));
  const vocabulary = ownValue(value, 'vocabulary');
  if (typeof vocabulary === 'number' && vocabulary !== GATE_VOCABULARY_VERSION) return refused('unknown-version', childPath(path, 'vocabulary'));
  const keys = checkKeys(value, path, BUNDLE_FIELDS);
  if (keys !== undefined) return keys;
  if (version !== BUNDLE_VERSION) return refused('wrong-type', childPath(path, 'bundleVersion'));
  if (vocabulary !== GATE_VOCABULARY_VERSION) return refused('wrong-type', childPath(path, 'vocabulary'));
  const issuer = parseIssuer(ownValue(value, 'issuer'), childPath(path, 'issuer'));
  if (!issuer.ok) return issuer;
  const issuedAt = parseTimestamp(ownValue(value, 'issuedAt'), childPath(path, 'issuedAt'));
  if (!issuedAt.ok) return issuedAt;
  const expiresAt = parseTimestamp(ownValue(value, 'expiresAt'), childPath(path, 'expiresAt'));
  if (!expiresAt.ok) return expiresAt;
  const ceiling = parseCeiling(ownValue(value, 'ceiling'), childPath(path, 'ceiling'));
  if (!ceiling.ok) return ceiling;
  const scales = parseScales(ownValue(value, 'scales'), childPath(path, 'scales'));
  if (!scales.ok) return scales;
  const mappings = parseList(ownValue(value, 'mappings'), childPath(path, 'mappings'), (item, where) => parseMapping(item, scales.value, where));
  if (!mappings.ok) return mappings;
  const clearances = parseList(ownValue(value, 'clearances'), childPath(path, 'clearances'), (item, where) => parseClearance(item, scales.value, where));
  if (!clearances.ok) return clearances;
  const routing = parseRouting(ownValue(value, 'routing'), scales.value, childPath(path, 'routing'));
  if (!routing.ok) return routing;
  const defaultLabel = parseLabel(ownValue(value, 'defaultLabel'), scales.value, childPath(path, 'defaultLabel'));
  if (!defaultLabel.ok) return defaultLabel;
  const anchorRoots = ownValue(value, 'anchorRoots');
  if (!Array.isArray(anchorRoots)) return refused('wrong-type', childPath(path, 'anchorRoots'));
  const statusLists = ownValue(value, 'statusLists');
  if (!Array.isArray(statusLists)) return refused('wrong-type', childPath(path, 'statusLists'));
  const maxOfflineAge = ownValue(value, 'maxOfflineAge');
  if (!isRecord(maxOfflineAge)) return refused('wrong-type', childPath(path, 'maxOfflineAge'));
  return {
    ok: true,
    value: Object.freeze({
      bundleVersion: BUNDLE_VERSION,
      vocabulary: GATE_VOCABULARY_VERSION,
      issuer: issuer.value,
      issuedAt: issuedAt.value,
      expiresAt: expiresAt.value,
      ceiling: ceiling.value,
      scales: scales.value,
      mappings: mappings.value,
      clearances: clearances.value,
      routing: routing.value,
      defaultLabel: defaultLabel.value,
      anchorRoots: Object.freeze([...anchorRoots]) as readonly unknown[],
      statusLists: Object.freeze([...statusLists]) as readonly unknown[],
      maxOfflineAge: Object.freeze({}) as Readonly<Record<string, number>>
    })
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Failing closed (OFFL-02, D-13)

const RESET_FIX = 'Run NEAR AI: Reset Policy to Defaults to sign a fresh one.';

/**
 * Every reason a bundle is not usable, each with one plain sentence that names the cause and the fix. The first group is the verifier's own closed list
 * (its message is replaced here, because a person needs the fix and not only the cause). A reason is added here with its sentence and a test, never at a
 * call site. No sentence uses an em-dash.
 */
export const BUNDLE_FAILURES = {
  missing: `NEAR AI has no policy file to read. ${RESET_FIX}`,
  unparseable: `Your policy file could not be read as a policy. ${RESET_FIX}`,
  malformed: `Your policy file is not a signed policy this version can read. ${RESET_FIX}`,
  'unsupported-version': `Your policy file was made by a newer version of NEAR AI. Update the extension, or run NEAR AI: Reset Policy to Defaults to sign a fresh one.`,
  'unknown-purpose': `Your policy file is a signed item made for something this version does not know, not a policy. ${RESET_FIX}`,
  'wrong-purpose': `Your policy file is a signed item made for a different use, not a policy. ${RESET_FIX}`,
  'too-large': `Your policy file is larger than the allowed size. ${RESET_FIX}`,
  'key-mismatch': `The key named in your policy file does not match its fingerprint. ${RESET_FIX}`,
  'bad-signature': `Your policy file was changed outside NEAR AI. ${RESET_FIX}`,
  'unknown-key': `Your policy file was signed by a key this computer does not know. ${RESET_FIX}`,
  'key-revoked': `The key that signed your policy file was revoked, so nothing it signed is accepted. ${RESET_FIX}`,
  'key-rotated': `The key that signed your policy file was replaced by a newer one, and the file was signed at or after the replacement. ${RESET_FIX}`,
  expired: `Your policy file has expired. ${RESET_FIX}`,
  'vocabulary-unknown': `Your policy file uses a list of actions this version does not know. Update the extension, or run NEAR AI: Reset Policy to Defaults to sign a fresh one.`,
  'unknown-field': `Your policy file has a setting this version does not know. ${RESET_FIX}`,
  'wrong-type': `Your policy file has a setting that is missing or is not the right kind of value. ${RESET_FIX}`,
  'signer-mismatch': `Your policy file names a different signer than the one that signed it. ${RESET_FIX}`,
  'clock-behind': 'This computer\'s clock is earlier than the time your policy file was signed. Set the clock to the right time, then reload the window.',
  'no-identity': `NEAR AI has no signing key on this computer yet, so there is no policy to check. ${RESET_FIX}`,
  'identity-unavailable': 'NEAR AI could not save its signing key on this computer, so only reading and planning are allowed until it can.'
} as const;
export type BundleFailureReason = keyof typeof BUNDLE_FAILURES;

/** Besides the floor, a failed-closed gate still allows these and nothing else (D-13). */
export const FAILED_CLOSED_VERBS: readonly CapabilityVerb[] = Object.freeze(['read', 'plan'] as const);

export type BundleState =
  | { readonly state: 'valid'; readonly bundle: PolicyBundle; readonly hash: string; readonly signer: PayloadSignerRef; readonly expiresAt: string; readonly renewDue: boolean }
  | { readonly state: 'failed-closed'; readonly reason: BundleFailureReason; readonly sentence: string; readonly detail?: string };

/** The failed-closed state for one reason. `detail` is a diagnostic for logs (never shown as the sentence). */
export function failedClosed(reason: BundleFailureReason, detail?: string): Extract<BundleState, { state: 'failed-closed' }> {
  return detail === undefined
    ? { state: 'failed-closed', reason, sentence: BUNDLE_FAILURES[reason] }
    : { state: 'failed-closed', reason, sentence: BUNDLE_FAILURES[reason], detail };
}

function payloadReason(reason: PayloadFailureReason): BundleFailureReason {
  // The verifier's reasons are a subset of ours with the same names. This keeps a new verifier reason from compiling until it has a sentence here.
  const own: Record<PayloadFailureReason, BundleFailureReason> = {
    malformed: 'malformed', 'unsupported-version': 'unsupported-version', 'unknown-purpose': 'unknown-purpose', 'wrong-purpose': 'wrong-purpose',
    'too-large': 'too-large', 'key-mismatch': 'key-mismatch', 'bad-signature': 'bad-signature', 'unknown-key': 'unknown-key', 'key-revoked': 'key-revoked',
    'key-rotated': 'key-rotated'
  };
  return own[reason];
}

function shapeReason(refusal: Refusal): BundleFailureReason {
  if (refusal.reason === 'unknown-version') return refusal.path.startsWith('bundleVersion') ? 'unsupported-version' : 'vocabulary-unknown';
  if (refusal.reason === 'unknown-field' || refusal.reason === 'unknown-verb') return 'unknown-field';
  return 'wrong-type';
}

export interface VerifyBundleOptions {
  /** Where key states come from: the person's own key history for a solo install. */
  readonly status: KeyStatusLookup;
  /** Epoch milliseconds from the wall clock. */
  readonly now: number;
  /** Epoch milliseconds of the last time this install saw a valid bundle, or undefined when it never has. */
  readonly lastValidAt?: number;
}

/**
 * Turns a stored envelope into a valid bundle or one failed-closed state with one plain sentence. Never throws. The verifier decides signature, purpose
 * and key status, so a tampered, unsigned, wrong-purpose, unknown-key, revoked or rotated bundle each fails here with its own cause.
 */
export function verifyBundleEnvelope(envelope: unknown, options: VerifyBundleOptions): BundleState {
  if (envelope === undefined) return failedClosed('missing');
  const verdict = verifyPayload<unknown>(envelope, { purpose: 'policy-bundle', status: options.status });
  if (!verdict.ok) return failedClosed(payloadReason(verdict.reason));
  const parsed = parseBundle(verdict.payload);
  if (!parsed.ok) return failedClosed(shapeReason(parsed), parsed.message);
  return {
    state: 'valid',
    bundle: parsed.value,
    hash: bundleHash(verdict.payload),
    signer: verdict.signer,
    expiresAt: parsed.value.expiresAt,
    renewDue: false
  };
}
