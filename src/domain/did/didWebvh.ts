// did:webvh v1.0 logs for people and your organization's root, verified from any copy (Phase 71, D-13, DLGT-01; https://identity.foundation/didwebvh/v1.0/
// read 2026-11-24; 71-RESEARCH.md "(b) did:webvh"). Pure: node:crypto for SHA-256 and Ed25519 only; no I/O, no network, no clock (the caller passes the
// log text, the witness file and the time). A copy from a hub cache or a trust export verifies exactly like one fetched from the DID's HTTPS location.
//
// Every entry is fully checked, in the specification's order: parameters; the eddsa-jcs-2022 proof by a key the active updateKeys authorize (a did:key
// URL whose fragment repeats its body); the version number and entry-hash chain; versionTime strictly increasing and not ahead of the caller's clock by
// more than five minutes; the SCID of the first entry; state.id parsed as a did:webvh DID with the same SCID in every entry (portability may change
// only the host and path, and only when portable was set in the first entry); pre-rotation (every new update key hashes to a value the previous entry
// committed to, and both lists are explicit while it is on); deactivation (no entry after it). Witness proofs are checked last, at the threshold the
// governing witness list sets, counting distinct witnesses, and only proofs for versionIds in this log count.
//
// WebvhState is plain frozen data a host stores and passes back as `cached`: the next call checks that the new copy starts with exactly the verified
// bytes and verifies only the entries after them (the specification's note on caching verified state).
import { createHash } from 'node:crypto';
import { canonicalBytes } from '../team/canonical';
import { EDDSA_JCS_2022, createProof, verifyProof } from '../credentials/dataIntegrity';
import type { CredentialSigner, DataIntegrityProof } from '../credentials/dataIntegrity';
import { MultibaseError, base58btcDecode, base58btcEncode, decodePublicKeyMultibase } from '../credentials/multibase';
import { readDidDocument, verificationMethodsOf } from './didDocument';
import type { VerificationMethod, VerificationRelationship } from './didDocument';
import { resolveDidKey } from './didKey';

export const WEBVH_METHOD = 'did:webvh:1.0';
export const WEBVH_PREFIX = 'did:webvh:';
export const SCID_PLACEHOLDER = '{SCID}';
/** A person's log is one entry of about 1.5 KB for most of a career (71-RESEARCH.md); the root's grows by one entry per rotation. */
export const MAX_LOG_BYTES = 1024 * 1024;
export const MAX_LOG_ENTRIES = 1000;
/** A witness file holds about 400 bytes per proof, one proof per witness per published entry once pruned. */
export const MAX_WITNESS_FILE_BYTES = 256 * 1024;
/** The specification: a resolver SHOULD allow no more than five minutes of clock skew for a versionTime ahead of its own clock. */
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
export const DEFAULT_TTL_SECONDS = 3600;
const MAX_TTL = 2 ** 31;
const MAX_PROOFS = 8;
const MAX_KEYS = 32;
const MAX_WITNESSES = 32;
const SHA256_MULTIHASH = [0x12, 0x20] as const;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const SCID = /^[1-9A-HJ-NP-Za-km-z]{46}$/;
const VERSION_ID = /^([1-9]\d{0,8})-([1-9A-HJ-NP-Za-km-z]{46})$/;
const VERSION_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|\+00:00)$/;
const DNS_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const ENTRY_MEMBERS = ['versionId', 'versionTime', 'parameters', 'state', 'proof'];
const PARAMETERS = ['method', 'scid', 'updateKeys', 'nextKeyHashes', 'witness', 'watchers', 'portable', 'deactivated', 'ttl'];

// Closed list. Sentences never quote a key, a signature or log content.
export const WEBVH_FAILURES = {
  'invalid-did': 'This is not a valid did:webvh DID.',
  'too-large': 'This DID log or witness file is larger than this version reads.',
  'bad-log': 'This DID log is not one JSON object per line in the expected form.',
  'bad-parameters': 'A DID log entry has a parameter that is missing, unknown or not allowed there.',
  'unknown-method': 'This DID log uses a did:webvh version this release does not read.',
  'bad-version-id': 'A DID log entry is out of order or its version id is malformed.',
  'bad-entry-hash': 'A DID log entry does not chain to the entry before it.',
  'bad-scid': 'The DID\'s self-certifying id does not match its first log entry.',
  'bad-version-time': 'A DID log entry\'s time is not a UTC time later than the entry before it.',
  'version-time-future': 'A DID log entry is dated later than this computer\'s clock allows. It is not accepted yet; the last verified version stays in use.',
  'bad-state': 'A DID log entry\'s document names a different DID than the log, or moves without being allowed to.',
  'unauthorized-key': 'A DID log entry was signed by a key that may not update this DID.',
  'bad-proof': 'A DID log entry\'s proof does not verify.',
  'pre-rotation': 'A DID log entry uses an update key the entry before it did not commit to.',
  'deactivated': 'This DID was deactivated, and nothing may follow that entry.',
  'witness-threshold': 'Not enough of this DID\'s witnesses approved one of its entries.',
  'did-not-in-log': 'No entry of this log names the DID being read.',
  'cache-mismatch': 'This copy of the DID log does not start with the history verified before.'
} as const;
export type WebvhFailure = keyof typeof WEBVH_FAILURES;

export interface WitnessConfig { readonly threshold: number; readonly witnesses: readonly string[] }

export interface WebvhParameters {
  readonly method: typeof WEBVH_METHOD;
  readonly scid: string;
  readonly updateKeys: readonly string[];
  readonly nextKeyHashes: readonly string[];
  readonly witness: WitnessConfig | null;
  readonly watchers: readonly string[];
  readonly portable: boolean;
  readonly deactivated: boolean;
  readonly ttl: number;
}

export interface WebvhVersion {
  readonly versionId: string;
  readonly versionTime: string;
  /** The DID this version's document names (it changes only under portability). */
  readonly did: string;
  readonly deactivated: boolean;
  /** The version's DID document exactly as the log holds it. */
  readonly document: Readonly<Record<string, unknown>>;
}

/** What a host stores per DID to resume verification and to answer questions about the past. */
export interface WebvhState {
  readonly format: 'webvh-state/1';
  readonly scid: string;
  /** The DID of the latest version. */
  readonly did: string;
  /** UTF-8 length and SHA-256 (hex) of the verified log, one entry per line, each line ending in a newline. */
  readonly logBytes: number;
  readonly logHash: string;
  readonly versions: readonly WebvhVersion[];
  /** The parameters in force after the last entry. */
  readonly parameters: WebvhParameters;
}

export type WebvhResult =
  | { readonly ok: true; readonly state: WebvhState; readonly checked: number }
  | { readonly ok: false; readonly reason: WebvhFailure; readonly message: string; readonly entry?: number };

export interface VerifyWebvhOptions {
  /** The caller's clock, epoch milliseconds. */
  readonly now: number;
  /** The state from an earlier full verification of a prefix of this log. */
  readonly cached?: WebvhState;
  /** The did-witness.json text, needed whenever an entry is witnessed. */
  readonly witnessFile?: string;
  /** The DID being read: at least one version must name it. */
  readonly did?: string;
}

export interface ParsedWebvhDid {
  readonly did: string;
  readonly scid: string;
  readonly host: string;
  readonly port?: number;
  readonly path: readonly string[];
  /** Where the log lives under the DID-to-HTTPS transformation (our hubs serve the same file on their trust routes). */
  readonly logUrl: string;
}

class WebvhError extends Error {
  public constructor(public readonly reason: WebvhFailure, public readonly entry?: number) {
    super(WEBVH_FAILURES[reason]);
  }
}

function fail(reason: WebvhFailure, entry?: number): never {
  throw new WebvhError(reason, entry);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sha256(bytes: Buffer | string): Buffer {
  return createHash('sha256').update(bytes).digest();
}

/** base58btc of the SHA-256 multihash of the bytes: the form of the SCID, the entry hash and a pre-rotation key hash. */
export function multihashBase58(bytes: Buffer | string): string {
  return base58btcEncode(new Uint8Array(Buffer.concat([Buffer.from(SHA256_MULTIHASH), sha256(bytes)])));
}

/** The pre-rotation hash of a Multikey public key: base58btc(multihash(SHA-256, the Multikey text)). */
export function nextKeyHash(multikey: string): string {
  return multihashBase58(Buffer.from(multikey, 'utf8'));
}

function percentDecodeOnce(text: string): string | undefined {
  if (/%(?![0-9A-Fa-f]{2})/.test(text)) return undefined;
  try {
    return decodeURIComponent(text);
  } catch {
    // Percent-encoding that is not valid UTF-8 is not a valid DID component.
    return undefined;
  }
}

function isDomainName(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label))) return false;
  // A host a URL parser would read as an IP address: its last label is a number (decimal or hexadecimal).
  const last = labels[labels.length - 1] as string;
  return !/^(\d+|0x[0-9a-f]*)$/i.test(last);
}

/** Parses a bare did:webvh DID by the method-specific identifier rules (DID Core syntax, SCID, domain, optional port, path segments). Never throws. */
export function parseWebvhDid(did: unknown): { readonly ok: true; readonly value: ParsedWebvhDid } | { readonly ok: false; readonly reason: 'invalid-did'; readonly message: string } {
  const invalid = { ok: false as const, reason: 'invalid-did' as const, message: WEBVH_FAILURES['invalid-did'] };
  if (typeof did !== 'string' || did.length > 2048 || !did.startsWith(WEBVH_PREFIX)) return invalid;
  const rest = did.slice(WEBVH_PREFIX.length);
  // DID Core idchar plus the ':' separators: no path, query or fragment, no raw Unicode.
  if (!/^[A-Za-z0-9._%:-]+$/.test(rest)) return invalid;
  const parts = rest.split(':');
  if (parts.length < 2 || parts.some((part) => part.length === 0)) return invalid;
  const [scid, rawDomain, ...rawPath] = parts as [string, string, ...string[]];
  if (!SCID.test(scid)) return invalid;
  let domain = rawDomain;
  let port: number | undefined;
  const portMatch = /^(.*)%3[Aa](\d{1,5})$/.exec(rawDomain);
  if (portMatch !== null) {
    domain = portMatch[1] as string;
    port = Number(portMatch[2]);
    if (port < 1 || port > 65535) return invalid;
  }
  if (/%3a/i.test(domain)) return invalid;
  const host = percentDecodeOnce(domain);
  if (host === undefined || !isDomainName(host)) return invalid;
  const path: string[] = [];
  for (const raw of rawPath) {
    const segment = percentDecodeOnce(raw);
    if (segment === undefined || segment === '.' || segment === '..' || /[/\\\0]/.test(segment) || /^\s|\s$/.test(segment)) return invalid;
    path.push(segment);
  }
  const origin = `https://${host.toLowerCase()}${port === undefined ? '' : `:${String(port)}`}`;
  const location = path.length === 0 ? '.well-known' : path.map((segment) => encodeURIComponent(segment)).join('/');
  return { ok: true, value: Object.freeze({ did, scid, host, ...(port === undefined ? {} : { port }), path: Object.freeze(path), logUrl: `${origin}/${location}/did.jsonl` }) };
}

function versionTimeMs(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const match = VERSION_TIME.exec(value);
  if (match === null) return Number.NaN;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(ms);
  // No date that rolls over (February 30), no hour 24.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || check.getUTCHours() !== hour) return Number.NaN;
  const fraction = match[7] === undefined ? 0 : Math.floor(Number(`0${match[7]}`) * 1000);
  return ms + fraction;
}

function ed25519Multikey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128) return false;
  try {
    return decodePublicKeyMultibase(value).type === 'Ed25519';
  } catch (error) {
    if (error instanceof MultibaseError) return false;
    throw error;
  }
}

function stringList(value: unknown, check: (entry: unknown) => boolean, max: number): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > max || !value.every(check)) return undefined;
  if (new Set(value).size !== value.length) return undefined;
  return Object.freeze([...(value as string[])]);
}

function readWitness(value: unknown, entry: number): WitnessConfig | null {
  if (!isRecord(value)) fail('bad-parameters', entry);
  if (Object.keys(value).length === 0) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('threshold') || !keys.includes('witnesses')) fail('bad-parameters', entry);
  const list = own(value, 'witnesses');
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_WITNESSES) fail('bad-parameters', entry);
  const ids: string[] = [];
  for (const witness of list) {
    if (!isRecord(witness) || Object.keys(witness).length !== 1) fail('bad-parameters', entry);
    const id = own(witness, 'id');
    // A witness is an Ed25519 did:key, named once (checked here, so a bad witness list never takes effect).
    const resolved = resolveDidKey(id);
    if (typeof id !== 'string' || id.includes('#') || !resolved.ok || resolved.publicKey.type !== 'Ed25519') fail('bad-parameters', entry);
    if (ids.includes(id.normalize('NFC'))) fail('bad-parameters', entry);
    ids.push(id.normalize('NFC'));
  }
  const threshold = own(value, 'threshold');
  if (typeof threshold !== 'number' || !Number.isSafeInteger(threshold) || threshold < 1 || threshold > ids.length) fail('bad-parameters', entry);
  return Object.freeze({ threshold, witnesses: Object.freeze(ids) });
}

interface Context {
  number: number;
  lastVersionId: string;
  lastTimeMs: number;
  lastDid: string;
  params: WebvhParameters | undefined;
  versions: WebvhVersion[];
}

interface EntryOutcome { params: WebvhParameters; witness: WitnessConfig | null }

function readParameters(raw: unknown, ctx: Context, index: number): { params: WebvhParameters; authorized: readonly string[]; witness: WitnessConfig | null } {
  if (!isRecord(raw)) fail('bad-parameters', index);
  for (const key of Object.keys(raw)) if (!PARAMETERS.includes(key)) fail('bad-parameters', index);
  // A null parameter is refused rather than read as its default (the specification's SHOULD for early logs): our logs never write one, and every
  // DIF vector is null-free, so refusing keeps one meaning per entry.
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(raw, key);
  const prev = ctx.params;
  if (prev === undefined) {
    if (own(raw, 'method') !== WEBVH_METHOD) fail(has('method') ? 'unknown-method' : 'bad-parameters', index);
    if (typeof own(raw, 'scid') !== 'string' || !SCID.test(own(raw, 'scid') as string)) fail('bad-scid', index);
    if (!has('updateKeys')) fail('bad-parameters', index);
  } else {
    if (prev.deactivated) fail('deactivated', index);
    if (has('scid')) fail('bad-parameters', index);
    if (has('method') && own(raw, 'method') !== WEBVH_METHOD) fail('unknown-method', index);
    if (own(raw, 'portable') === true) fail('bad-parameters', index);
  }
  const updateKeys = has('updateKeys') ? stringList(own(raw, 'updateKeys'), ed25519Multikey, MAX_KEYS) : prev?.updateKeys;
  const nextKeyHashes = has('nextKeyHashes') ? stringList(own(raw, 'nextKeyHashes'), (entry) => typeof entry === 'string' && entry.length <= 128 && BASE58.test(entry), MAX_KEYS) : (prev?.nextKeyHashes ?? Object.freeze([]));
  const watchers = has('watchers') ? stringList(own(raw, 'watchers'), (entry) => typeof entry === 'string' && entry.length <= 2048, MAX_KEYS) : (prev?.watchers ?? Object.freeze([]));
  if (updateKeys === undefined || nextKeyHashes === undefined || watchers === undefined) fail('bad-parameters', index);
  const portable = has('portable') ? own(raw, 'portable') : (prev?.portable ?? false);
  const deactivated = has('deactivated') ? own(raw, 'deactivated') : (prev?.deactivated ?? false);
  const ttl = has('ttl') ? own(raw, 'ttl') : (prev?.ttl ?? DEFAULT_TTL_SECONDS);
  if (typeof portable !== 'boolean' || typeof deactivated !== 'boolean') fail('bad-parameters', index);
  if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < 0 || ttl > MAX_TTL) fail('bad-parameters', index);
  const ownWitness = has('witness') ? readWitness(own(raw, 'witness'), index) : undefined;
  const witness = ownWitness === undefined ? (prev?.witness ?? null) : ownWitness;
  let authorized: readonly string[];
  if (prev === undefined) {
    authorized = updateKeys;
  } else if (prev.nextKeyHashes.length > 0) {
    // Pre-rotation is on: both lists explicit, and every key of the new list committed to by the entry before.
    if (!has('updateKeys') || !has('nextKeyHashes')) fail('pre-rotation', index);
    if (!updateKeys.every((key) => prev.nextKeyHashes.includes(nextKeyHash(key)))) fail('pre-rotation', index);
    authorized = updateKeys;
  } else {
    authorized = prev.updateKeys;
  }
  // The list governing this entry: a list switched on from none applies at once; any other change applies after this entry.
  const governing = prev === undefined ? witness : prev.witness ?? ownWitness ?? null;
  const scid = prev === undefined ? (own(raw, 'scid') as string) : prev.scid;
  const params: WebvhParameters = Object.freeze({
    method: WEBVH_METHOD, scid, updateKeys, nextKeyHashes, witness, watchers, portable: portable as boolean, deactivated: deactivated as boolean, ttl: ttl as number
  });
  return { params, authorized, witness: governing };
}

function entryHash(entry: Record<string, unknown>, previousVersionId: string): string {
  const { proof: _proof, ...rest } = entry;
  return multihashBase58(canonicalBytes({ ...rest, versionId: previousVersionId }));
}

function scidOf(firstEntry: Record<string, unknown>, scid: string): string {
  const { proof: _proof, ...rest } = firstEntry;
  const text = JSON.stringify({ ...rest, versionId: SCID_PLACEHOLDER }).split(scid).join(SCID_PLACEHOLDER);
  return multihashBase58(canonicalBytes(JSON.parse(text) as unknown));
}

function checkProofs(entry: Record<string, unknown>, authorized: readonly string[], index: number): void {
  const proofs = own(entry, 'proof');
  if (!Array.isArray(proofs) || proofs.length === 0 || proofs.length > MAX_PROOFS) fail('bad-proof', index);
  const { proof: _proof, ...unsecured } = entry;
  for (const proof of proofs) {
    if (!isRecord(proof)) fail('bad-proof', index);
    const method = own(proof, 'verificationMethod');
    const resolved = resolveDidKey(method);
    if (typeof method !== 'string' || !method.includes('#') || !resolved.ok || resolved.publicKey.type !== 'Ed25519') fail('unauthorized-key', index);
    if (!authorized.includes(resolved.method.publicKeyMultibase)) fail('unauthorized-key', index);
    if (own(proof, 'cryptosuite') !== EDDSA_JCS_2022 || !verifyProof({ ...unsecured, proof }, resolved.publicKey.key, { proofPurpose: 'assertionMethod' }).ok) fail('bad-proof', index);
  }
}

function verifyEntry(line: string, ctx: Context, index: number, now: number): EntryOutcome {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    // A line that is not JSON is not a log entry.
    fail('bad-log', index);
  }
  if (!isRecord(entry) || Object.keys(entry).length !== ENTRY_MEMBERS.length || !ENTRY_MEMBERS.every((key) => Object.prototype.hasOwnProperty.call(entry, key))) fail('bad-log', index);
  const { params, authorized, witness } = readParameters(entry.parameters, ctx, index);
  checkProofs(entry, authorized, index);
  const versionId = own(entry, 'versionId');
  const match = typeof versionId === 'string' ? VERSION_ID.exec(versionId) : null;
  if (match === null || Number(match[1]) !== ctx.number + 1) fail('bad-version-id', index);
  const previous = ctx.params === undefined ? params.scid : ctx.lastVersionId;
  if (entryHash(entry, previous) !== match[2]) fail('bad-entry-hash', index);
  const time = versionTimeMs(own(entry, 'versionTime'));
  if (Number.isNaN(time) || time <= ctx.lastTimeMs) fail('bad-version-time', index);
  if (time > now + FUTURE_TOLERANCE_MS) fail('version-time-future', index);
  if (ctx.params === undefined && scidOf(entry, params.scid) !== params.scid) fail('bad-scid', index);
  const state = own(entry, 'state');
  if (!isRecord(state)) fail('bad-state', index);
  const parsed = parseWebvhDid(own(state, 'id'));
  if (!parsed.ok || parsed.value.scid !== params.scid) fail('bad-state', index);
  if (ctx.params !== undefined && parsed.value.did !== ctx.lastDid) {
    const aka = own(state, 'alsoKnownAs');
    if (!ctx.params.portable || !Array.isArray(aka) || !aka.includes(ctx.lastDid)) fail('bad-state', index);
  }
  ctx.number += 1;
  ctx.lastVersionId = versionId as string;
  ctx.lastTimeMs = time;
  ctx.lastDid = parsed.value.did;
  ctx.params = params;
  ctx.versions.push(Object.freeze({
    versionId: versionId as string, versionTime: own(entry, 'versionTime') as string, did: parsed.value.did, deactivated: params.deactivated,
    document: deepFreeze(state)
  }));
  return { params, witness };
}

function readWitnessFile(text: string | undefined): Array<{ versionId: string; proofs: unknown[] }> {
  if (text === undefined) return [];
  if (Buffer.byteLength(text, 'utf8') > MAX_WITNESS_FILE_BYTES) fail('too-large');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // An unreadable witness file approves nothing.
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: Array<{ versionId: string; proofs: unknown[] }> = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const versionId = own(item, 'versionId');
    const proofs = own(item, 'proof');
    if (typeof versionId === 'string' && Array.isArray(proofs)) out.push({ versionId, proofs: proofs.slice(0, MAX_WITNESSES * 2) });
  }
  return out;
}

/** The distinct witnesses of `config` with a valid proof for `versionIds` (this entry or a later one of this log). Unattributable proofs are discarded. */
function approvals(config: WitnessConfig, versionIds: ReadonlySet<string>, file: ReturnType<typeof readWitnessFile>, verified: Map<string, string | null>): number {
  const approved = new Set<string>();
  file.forEach((item, itemIndex) => {
    if (!versionIds.has(item.versionId)) return;
    item.proofs.forEach((proof, proofIndex) => {
      const key = `${String(itemIndex)}/${String(proofIndex)}`;
      if (!verified.has(key)) {
        let witness: string | null = null;
        if (isRecord(proof)) {
          const resolved = resolveDidKey(own(proof, 'verificationMethod'));
          const method = own(proof, 'verificationMethod');
          if (resolved.ok && typeof method === 'string' && method.includes('#') && resolved.publicKey.type === 'Ed25519' && own(proof, 'cryptosuite') === EDDSA_JCS_2022
            && verifyProof({ versionId: item.versionId, proof }, resolved.publicKey.key, { proofPurpose: 'assertionMethod' }).ok) {
            witness = resolved.did;
          }
        }
        verified.set(key, witness);
      }
      const witness = verified.get(key);
      if (witness !== null && witness !== undefined && config.witnesses.includes(witness)) approved.add(witness);
    });
  });
  return approved.size;
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.some((line) => line.length === 0 || line.includes('\r'))) fail('bad-log');
  return lines;
}

function freezeState(ctx: Context, lines: readonly string[]): WebvhState {
  const text = lines.map((line) => `${line}\n`).join('');
  const params = ctx.params as WebvhParameters;
  return Object.freeze({
    format: 'webvh-state/1', scid: params.scid, did: ctx.lastDid, logBytes: Buffer.byteLength(text, 'utf8'), logHash: sha256(text).toString('hex'),
    versions: Object.freeze([...ctx.versions]), parameters: params
  });
}

/**
 * Verifies a did:webvh log from any copy. With `cached` (an earlier result for a prefix of this log), the new copy must start with exactly those
 * bytes, and only the entries after them are checked. Returns the state and how many entries this call checked. Never throws.
 */
export function verifyWebvhLog(log: string, options: VerifyWebvhOptions): WebvhResult {
  try {
    if (typeof log !== 'string' || Buffer.byteLength(log, 'utf8') > MAX_LOG_BYTES) fail('too-large');
    if (!Number.isFinite(options.now)) fail('bad-version-time');
    const lines = splitLines(log);
    if (lines.length === 0) fail('bad-log');
    if (lines.length > MAX_LOG_ENTRIES) fail('too-large');
    const ctx: Context = { number: 0, lastVersionId: '', lastTimeMs: Number.NEGATIVE_INFINITY, lastDid: '', params: undefined, versions: [] };
    let start = 0;
    const cached = options.cached;
    if (cached !== undefined) {
      const prefix = cached.versions.length;
      const text = lines.slice(0, prefix).map((line) => `${line}\n`).join('');
      if (prefix === 0 || prefix > lines.length || cached.format !== 'webvh-state/1' || Buffer.byteLength(text, 'utf8') !== cached.logBytes || sha256(text).toString('hex') !== cached.logHash) {
        fail('cache-mismatch');
      }
      const last = cached.versions[prefix - 1] as WebvhVersion;
      Object.assign(ctx, { number: prefix, lastVersionId: last.versionId, lastTimeMs: versionTimeMs(last.versionTime), lastDid: last.did, params: cached.parameters, versions: [...cached.versions] });
      start = prefix;
    }
    const governing: Array<WitnessConfig | null> = [];
    for (let index = start; index < lines.length; index += 1) governing.push(verifyEntry(lines[index] as string, ctx, index, options.now).witness);
    // Witnesses last, after every other check (the specification's order).
    if (governing.some((config) => config !== null)) {
      const file = readWitnessFile(options.witnessFile);
      const verified = new Map<string, string | null>();
      for (let offset = 0; offset < governing.length; offset += 1) {
        const config = governing[offset];
        if (config === null || config === undefined) continue;
        const later = new Set(ctx.versions.slice(start + offset).map((version) => version.versionId));
        if (approvals(config, later, file, verified) < config.threshold) fail('witness-threshold', start + offset);
      }
    }
    if (options.did !== undefined && !ctx.versions.some((version) => version.did === options.did)) fail('did-not-in-log');
    return { ok: true, state: freezeState(ctx, lines), checked: lines.length - start };
  } catch (error) {
    if (error instanceof WebvhError) return { ok: false, reason: error.reason, message: WEBVH_FAILURES[error.reason], ...(error.entry === undefined ? {} : { entry: error.entry }) };
    // Anything else unreadable in a log (a value canonical JSON refuses, a malformed key) is not a log this version accepts.
    return { ok: false, reason: 'bad-log', message: WEBVH_FAILURES['bad-log'] };
  }
}

/** The version in force at `time` (epoch milliseconds): the last one whose versionTime is at or before it, or undefined before the first. */
export function versionAt(state: WebvhState, time: number): WebvhVersion | undefined {
  let found: WebvhVersion | undefined;
  for (const version of state.versions) {
    if (versionTimeMs(version.versionTime) <= time) found = version;
  }
  return found;
}

/**
 * The verification methods in force at `time` for a relationship (assertionMethod by default), so a credential signed before a key rotation verifies
 * at its own time. Empty before the first version, after a deactivation, and when that version's document is not the minimal DID document.
 */
export function methodsAt(state: WebvhState, time: number, relationship: VerificationRelationship = 'assertionMethod'): readonly VerificationMethod[] {
  const version = versionAt(state, time);
  if (version === undefined || version.deactivated) return Object.freeze([]);
  const read = readDidDocument(version.document, version.did);
  return read.ok ? verificationMethodsOf(read.document, relationship) : Object.freeze([]);
}

// ---- Building entries (the person's backend at first sign-in, 71-10; the root's key ceremony, scripts/org-issuer.mjs) ----

export interface GenesisInput {
  /** The host, with an optional %3A port, as it appears in the DID. */
  readonly domain: string;
  readonly path: readonly string[];
  readonly updateKeys: readonly string[];
  readonly nextKeyHashes?: readonly string[];
  readonly portable: boolean;
  readonly witness?: WitnessConfig;
  readonly versionTime: string;
  /** The DID document for a DID (called with the DID holding the {SCID} placeholder). */
  readonly document: (did: string) => Record<string, unknown>;
}

export interface UpdateInput {
  /** Only the parameters that change (updateKeys and nextKeyHashes are required while pre-rotation is on). */
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly versionTime: string;
  readonly document: (did: string) => Record<string, unknown>;
}

export interface BuiltEntry { readonly did: string; readonly scid: string; readonly entry: Readonly<Record<string, unknown>>; readonly line: string }

async function sign(unsigned: Record<string, unknown>, versionTime: string, signer: CredentialSigner): Promise<Record<string, unknown>> {
  const proof: DataIntegrityProof = await createProof(unsigned, { proofPurpose: 'assertionMethod', created: versionTime }, signer);
  return { ...unsigned, proof: [proof] };
}

function witnessParameter(config: WitnessConfig): Record<string, unknown> {
  return { threshold: config.threshold, witnesses: config.witnesses.map((id) => ({ id })) };
}

/** The first entry of a new DID, signed by one of its update keys (a did:key URL signer). Pre-rotation is on when nextKeyHashes is not empty. */
export async function buildGenesisEntry(input: GenesisInput, signer: CredentialSigner): Promise<BuiltEntry> {
  const placeholderDid = [`${WEBVH_PREFIX}${SCID_PLACEHOLDER}`, input.domain, ...input.path].join(':');
  const preliminary = {
    versionId: SCID_PLACEHOLDER,
    versionTime: input.versionTime,
    parameters: {
      method: WEBVH_METHOD, scid: SCID_PLACEHOLDER, updateKeys: [...input.updateKeys], portable: input.portable,
      ...(input.nextKeyHashes === undefined ? {} : { nextKeyHashes: [...input.nextKeyHashes] }),
      ...(input.witness === undefined ? {} : { witness: witnessParameter(input.witness) })
    },
    state: input.document(placeholderDid)
  };
  const scid = multihashBase58(canonicalBytes(preliminary));
  const withScid = JSON.parse(JSON.stringify(preliminary).split(SCID_PLACEHOLDER).join(scid)) as Record<string, unknown>;
  const unsigned = { ...withScid, versionId: `1-${entryHash(withScid, scid)}` };
  const entry = await sign(unsigned, input.versionTime, signer);
  return { did: placeholderDid.replace(SCID_PLACEHOLDER, scid), scid, entry: Object.freeze(entry), line: JSON.stringify(entry) };
}

/** The next entry after a verified state, signed by an authorized update key (with pre-rotation on, one of the new updateKeys). */
export async function buildUpdateEntry(state: WebvhState, input: UpdateInput, signer: CredentialSigner): Promise<BuiltEntry> {
  const last = state.versions[state.versions.length - 1] as WebvhVersion;
  const draft = { versionId: last.versionId, versionTime: input.versionTime, parameters: { ...input.parameters }, state: input.document(state.did) };
  const unsigned = { ...draft, versionId: `${String(state.versions.length + 1)}-${entryHash(draft, last.versionId)}` };
  const entry = await sign(unsigned, input.versionTime, signer);
  return { did: state.did, scid: state.scid, entry: Object.freeze(entry), line: JSON.stringify(entry) };
}

/** A witness's approval of one entry: an eddsa-jcs-2022 proof over { versionId }, by the witness's did:key signer (the hosting hub's key). */
export async function buildWitnessProof(versionId: string, signer: CredentialSigner, created: string): Promise<{ readonly versionId: string; readonly proof: readonly DataIntegrityProof[] }> {
  const proof = await createProof({ versionId }, { proofPurpose: 'assertionMethod', created }, signer);
  return Object.freeze({ versionId, proof: Object.freeze([proof]) });
}

/** For tests and hosts: a base58btc multihash text decodes to SHA-256 (0x12 0x20 and 32 bytes). */
export function isSha256Multihash(text: string): boolean {
  try {
    const bytes = base58btcDecode(text);
    return bytes.length === 34 && bytes[0] === SHA256_MULTIHASH[0] && bytes[1] === SHA256_MULTIHASH[1];
  } catch (error) {
    if (error instanceof MultibaseError) return false;
    throw error;
  }
}
