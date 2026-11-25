// Site evidence: its formats and when it counts (48.2-06, D-13, D-14, D-17, D-18, D-20, D-21, D-23). Pure engine code the session (48.2-08)
// and the site collector (48.2-09) share; it imports no loader and no validator.
//
// The root is your organization's site key (ECDSA P-256, cosign key mode). It signs the site trust document `sterling-evidence-trust/1`, which
// names the site's evidence signers: the collector's OpenBao Transit key, one entry per allowed key version, and the operators' keys, each with
// its purposes and validity dates, and the site's freshness policy (which may only tighten the release defaults). Every site file is the
// extension's signed-payload envelope (signed.ts, Ed25519), verified for the purpose its role gives it, never the purpose it claims:
//   live        sterling-site-evidence/1, purpose site-evidence-live, signed by the collector at a listed key version (the version is signed)
//   export      the deployment export (48-02), purpose site-evidence-export, parsed and checked by the deployment collector's own functions
//   rescan      sterling-site-rescan/1, purpose site-rescan: the offline rescan, dated by its database's build date
//   agreements  sterling-site-agreements/1, purpose site-agreements: each exchange's agreement reference and review date
// Each verified file becomes observations dated at its own evidence time. Nothing dated more than FUTURE_TOLERANCE_MS ahead is used.
import { CHECKS, parseExportPayload, SITE_EXPORT_PURPOSE, SITE_ID } from './collectors/deploymentChecks.ts';
import { checkLiveGroups, liveObservations } from './collectors/siteLive.ts';
import { effectivePolicy } from './judgement.ts';
import type { Observation } from './model.ts';
import { fingerprintOf, isStrictBase64url, MAX_PAYLOAD_BYTES, PAYLOAD_VERSION, signingInput, verifyEnvelope, type EnvelopeFailure } from './signed.ts';
import { verifySigstoreBundle } from './sigstoreBundle.ts';
import { FUTURE_TOLERANCE_MS } from './status.ts';

export const TRUST_FORMAT = 'sterling-evidence-trust/1' as const;
export const SITE_EVIDENCE_FORMAT = 'sterling-site-evidence/1' as const;
export const SITE_RESCAN_FORMAT = 'sterling-site-rescan/1' as const;
export const SITE_AGREEMENTS_FORMAT = 'sterling-site-agreements/1' as const;
export const SITE_LIVE_PURPOSE = 'site-evidence-live';
export const SITE_RESCAN_PURPOSE = 'site-rescan';
export const SITE_AGREEMENTS_PURPOSE = 'site-agreements';
/** Every purpose a site signer may hold. */
export const SITE_PURPOSES: readonly string[] = Object.freeze([SITE_LIVE_PURPOSE, SITE_EXPORT_PURPOSE, SITE_RESCAN_PURPOSE, SITE_AGREEMENTS_PURPOSE]);
/** The longest a trust document or signer entry may be valid. */
export const MAX_VALIDITY_DAYS = 400;

const DAY_MS = 86_400_000;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SIGNER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9 ._/:#-]{0,127}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && ISO_TIME.test(value) && new Date(value).toISOString() === value;
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

// ---- The trust document ----

export interface CollectorKeyVersion { readonly version: number; readonly publicKey: string }
export interface TrustSigner {
  readonly id: string;
  readonly role: 'collector' | 'operator';
  readonly purposes: readonly string[];
  readonly notBefore: string;
  readonly notAfter: string;
  /** An operator's raw Ed25519 public key, base64url. */
  readonly publicKey?: string;
  /** The collector's allowed Transit key versions, each with its raw Ed25519 public key. */
  readonly versions?: readonly CollectorKeyVersion[];
}
export interface TrustDocument {
  readonly format: typeof TRUST_FORMAT;
  readonly site: string;
  readonly issuedAt: string;
  readonly signers: readonly TrustSigner[];
  readonly freshness?: unknown;
}

function refuseUnless(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Checks a trust document strictly and returns it typed; one plain line when it is not one. */
export function parseTrustDocument(value: unknown): TrustDocument {
  refuseUnless(isRecord(value) && value.format === TRUST_FORMAT, 'this is not a sterling-evidence-trust/1 document');
  refuseUnless(exactKeys(value, ['format', 'site', 'issuedAt', 'signers'], ['freshness']), 'the trust document holds a field outside its format');
  refuseUnless(typeof value.site === 'string' && SITE_ID.test(value.site), 'the trust document site id is not a plain id');
  refuseUnless(isTime(value.issuedAt), 'the trust document issue time is not an ISO time');
  refuseUnless(Array.isArray(value.signers) && value.signers.length > 0, 'the trust document names no signers');
  const keys = new Set<string>();
  const ids = new Set<string>();
  let collectors = 0;
  for (const signer of value.signers as unknown[]) {
    refuseUnless(isRecord(signer) && (signer.role === 'collector' || signer.role === 'operator'), 'a trust document signer has no known role');
    const collector = signer.role === 'collector';
    refuseUnless(exactKeys(signer, ['id', 'role', 'purposes', 'notBefore', 'notAfter', collector ? 'versions' : 'publicKey']), 'a trust document signer holds a field outside its format');
    refuseUnless(typeof signer.id === 'string' && SIGNER_ID.test(signer.id) && !ids.has(signer.id), 'a trust document signer id is not a plain, unique id');
    ids.add(signer.id);
    refuseUnless(isTime(signer.notBefore) && isTime(signer.notAfter) && Date.parse(signer.notBefore) < Date.parse(signer.notAfter), 'a trust document signer has invalid dates');
    refuseUnless(Array.isArray(signer.purposes) && signer.purposes.length > 0 && signer.purposes.every((purpose) => SITE_PURPOSES.includes(purpose as string)) && new Set(signer.purposes).size === signer.purposes.length, 'a trust document signer has an unknown purpose');
    const publicKeys: unknown[] = [];
    if (collector) {
      collectors += 1;
      refuseUnless(signer.purposes.length === 1 && signer.purposes[0] === SITE_LIVE_PURPOSE, 'the collector may sign only the live feed');
      refuseUnless(Array.isArray(signer.versions) && signer.versions.length > 0, 'the collector lists no key versions');
      const versions = new Set<number>();
      for (const entry of signer.versions as unknown[]) {
        refuseUnless(isRecord(entry) && exactKeys(entry, ['version', 'publicKey']) && Number.isSafeInteger(entry.version) && (entry.version as number) >= 1 && !versions.has(entry.version as number), 'a collector key version is not a unique positive whole number');
        versions.add(entry.version as number);
        publicKeys.push(entry.publicKey);
      }
    } else {
      publicKeys.push(signer.publicKey);
    }
    for (const key of publicKeys) {
      refuseUnless(isStrictBase64url(key, 32) && !keys.has(key as string), 'a trust document key is not a unique raw Ed25519 public key');
      keys.add(key as string);
    }
  }
  refuseUnless(collectors <= 1, 'the trust document names more than one collector');
  return value as unknown as TrustDocument;
}

export interface TrustDocumentInput {
  readonly site: string;
  readonly issuedAt?: string;
  readonly notBefore?: string;
  readonly notAfter: string;
  readonly now?: Date;
  readonly collectorKeys: readonly CollectorKeyVersion[];
  readonly operatorKeys: readonly { readonly publicKey: string; readonly purposes: readonly string[]; readonly notBefore?: string; readonly notAfter?: string }[];
  readonly freshness?: unknown;
}

/**
 * Makes a trust document for your site key to sign (48.2-12 signs it through 48.1-17's site-key path). Refused with one line: a duplicate key
 * or key version, an unknown purpose, a validity longer than MAX_VALIDITY_DAYS, or a freshness policy that would loosen a release default.
 */
export function makeTrustDocument(input: TrustDocumentInput): TrustDocument {
  const now = input.now ?? new Date();
  const issuedAt = input.issuedAt ?? now.toISOString();
  const notBefore = input.notBefore ?? issuedAt;
  const latest = now.getTime() + MAX_VALIDITY_DAYS * DAY_MS;
  for (const end of [input.notAfter, ...input.operatorKeys.map(({ notAfter }) => notAfter ?? input.notAfter)]) {
    refuseUnless(isTime(end), 'every validity end must be an ISO time');
    refuseUnless(Date.parse(end) <= latest, `a validity end is more than ${MAX_VALIDITY_DAYS} days ahead`);
  }
  const versions = new Set<number>();
  for (const { version } of input.collectorKeys) {
    refuseUnless(!versions.has(version), `collector key version ${version} is listed twice`);
    versions.add(version);
  }
  const keys = [...input.collectorKeys.map(({ publicKey }) => publicKey), ...input.operatorKeys.map(({ publicKey }) => publicKey)];
  refuseUnless(new Set(keys).size === keys.length, 'a public key is listed twice');
  for (const { purposes } of input.operatorKeys) {
    for (const purpose of purposes) refuseUnless(SITE_PURPOSES.includes(purpose) && purpose !== SITE_LIVE_PURPOSE, `unknown operator purpose ${purpose}`);
  }
  if (input.freshness !== undefined) {
    const policy = effectivePolicy(input.freshness);
    refuseUnless(!policy.refused, `the freshness policy is refused: ${policy.refused}`);
    refuseUnless(policy.clamped.length === 0, `the freshness policy may only tighten the release defaults (${policy.clamped.join(', ')} would loosen them)`);
  }
  const signers: TrustSigner[] = [];
  if (input.collectorKeys.length > 0) {
    signers.push({ id: 'collector', role: 'collector', purposes: [SITE_LIVE_PURPOSE], notBefore, notAfter: input.notAfter,
      versions: [...input.collectorKeys].sort((a, b) => a.version - b.version).map(({ version, publicKey }) => ({ version, publicKey })) });
  }
  input.operatorKeys.forEach((key, index) => signers.push({ id: `operator-${index + 1}`, role: 'operator', purposes: [...key.purposes],
    notBefore: key.notBefore ?? notBefore, notAfter: key.notAfter ?? input.notAfter, publicKey: key.publicKey }));
  return parseTrustDocument({ format: TRUST_FORMAT, site: input.site, issuedAt, signers, ...(input.freshness !== undefined ? { freshness: input.freshness } : {}) });
}

/** The newest collector key version the trust document lists: the one the collector signs with (D-20). */
export function collectorKeyVersion(trust: TrustDocument): number | undefined {
  const versions = trust.signers.find(({ role }) => role === 'collector')?.versions ?? [];
  return versions.length ? Math.max(...versions.map(({ version }) => version)) : undefined;
}

// ---- Site files: payloads ----

export interface LiveFeed {
  readonly format: typeof SITE_EVIDENCE_FORMAT;
  readonly site: string;
  readonly generatedAt: string;
  readonly keyVersion: number;
  readonly groups: Record<string, Record<string, unknown> & { collectedAt: string }>;
}

/** Checks a live feed payload strictly: no pass field, nothing outside the allow-list. */
export function parseLiveFeed(value: unknown): LiveFeed {
  refuseUnless(isRecord(value) && value.format === SITE_EVIDENCE_FORMAT && exactKeys(value, ['format', 'site', 'generatedAt', 'keyVersion', 'groups']), 'this is not a sterling-site-evidence/1 live feed');
  refuseUnless(typeof value.site === 'string' && SITE_ID.test(value.site), 'the live feed site id is not a plain id');
  refuseUnless(isTime(value.generatedAt), 'the live feed time is not an ISO time');
  refuseUnless(Number.isSafeInteger(value.keyVersion) && (value.keyVersion as number) >= 1, 'the live feed key version is not a positive whole number');
  checkLiveGroups(value.groups);
  return value as unknown as LiveFeed;
}

/** A live feed payload the collector signs (48.2-09); every group keeps the collectedAt it was given. */
export function buildLiveFeed(input: Omit<LiveFeed, 'format'>): LiveFeed {
  return parseLiveFeed({ format: SITE_EVIDENCE_FORMAT, site: input.site, generatedAt: input.generatedAt, keyVersion: input.keyVersion, groups: input.groups });
}

export interface RescanPayload {
  readonly format: typeof SITE_RESCAN_FORMAT;
  readonly site: string;
  readonly subject: string;
  readonly rescannedAt: string;
  readonly database: { readonly built: string; readonly schema: string; readonly checksum: string; readonly signatureVerified: boolean };
  readonly counts: Readonly<Record<'critical' | 'high' | 'medium' | 'low' | 'negligible' | 'unknown', number>>;
}
const RESCAN_SEVERITIES = ['critical', 'high', 'medium', 'low', 'negligible', 'unknown'] as const;

/** Checks the offline rescan summary (from 47-29's rescan.json) strictly. */
export function parseRescanPayload(value: unknown): RescanPayload {
  refuseUnless(isRecord(value) && value.format === SITE_RESCAN_FORMAT && exactKeys(value, ['format', 'site', 'subject', 'rescannedAt', 'database', 'counts']), 'this is not a sterling-site-rescan/1 summary');
  refuseUnless(typeof value.site === 'string' && SITE_ID.test(value.site), 'the rescan site id is not a plain id');
  refuseUnless(value.subject === 'sterling-image', 'the rescan subject must be sterling-image');
  refuseUnless(isTime(value.rescannedAt), 'the rescan time is not an ISO time');
  const database = value.database;
  refuseUnless(isRecord(database) && exactKeys(database, ['built', 'schema', 'checksum', 'signatureVerified']) && isTime(database.built)
    && typeof database.schema === 'string' && /^v?\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(database.schema) && typeof database.checksum === 'string' && /^[0-9a-f]{64}$/.test(database.checksum)
    && typeof database.signatureVerified === 'boolean', 'the rescan database facts are not in their format');
  refuseUnless(Date.parse(database.built as string) <= Date.parse(value.rescannedAt as string), 'the rescan database was built after the rescan');
  const counts = value.counts;
  refuseUnless(isRecord(counts) && exactKeys(counts, RESCAN_SEVERITIES) && RESCAN_SEVERITIES.every((key) => Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 0), 'the rescan counts are not in their format');
  return value as unknown as RescanPayload;
}

export interface AgreementsPayload {
  readonly format: typeof SITE_AGREEMENTS_FORMAT;
  readonly site: string;
  readonly agreements: readonly { readonly exchange: string; readonly reference: string; readonly reviewedAt: string }[];
}

/** Checks the exchange agreements strictly; every exchange must be one of the register's (compliance/hosted/exchanges.json). */
export function parseAgreementsPayload(value: unknown, exchangeIds: readonly string[]): AgreementsPayload {
  refuseUnless(isRecord(value) && value.format === SITE_AGREEMENTS_FORMAT && exactKeys(value, ['format', 'site', 'agreements']), 'this is not a sterling-site-agreements/1 list');
  refuseUnless(typeof value.site === 'string' && SITE_ID.test(value.site), 'the agreements site id is not a plain id');
  refuseUnless(Array.isArray(value.agreements) && value.agreements.length > 0, 'the agreements list is empty');
  const seen = new Set<string>();
  for (const entry of value.agreements as unknown[]) {
    refuseUnless(isRecord(entry) && exactKeys(entry, ['exchange', 'reference', 'reviewedAt']), 'an agreement holds a field outside its format');
    refuseUnless(typeof entry.exchange === 'string' && exchangeIds.includes(entry.exchange) && !seen.has(entry.exchange), 'an agreement names an exchange that is not in the register, or names it twice');
    seen.add(entry.exchange);
    refuseUnless(typeof entry.reference === 'string' && REFERENCE.test(entry.reference), 'an agreement reference is not a plain reference');
    refuseUnless(typeof entry.reviewedAt === 'string' && DATE.test(entry.reviewedAt) && !Number.isNaN(Date.parse(`${entry.reviewedAt}T00:00:00.000Z`)), 'an agreement review date is not a date');
  }
  return value as unknown as AgreementsPayload;
}

// ---- Envelopes: build, emit the signing input, attach ----

export interface UnsignedSiteFile {
  readonly v: typeof PAYLOAD_VERSION;
  readonly purpose: string;
  readonly signer: { readonly fingerprint: string; readonly publicKey: string };
  readonly signedAt: string;
  readonly payload: Record<string, unknown>;
}
export type SignedSiteFile = UnsignedSiteFile & { readonly sig: string };

/** The envelope without its signature, and the exact bytes the signer signs. */
export function siteSigningInput(purpose: string, payload: object, publicKey: string, signedAt: string): { readonly unsigned: UnsignedSiteFile; readonly bytes: Buffer } {
  refuseUnless(isStrictBase64url(publicKey, 32), 'the public key must be a raw Ed25519 key in base64url');
  refuseUnless(isTime(signedAt), 'the signing time must be an ISO time');
  const unsigned: UnsignedSiteFile = { v: PAYLOAD_VERSION, purpose, signer: { fingerprint: fingerprintOf(Buffer.from(publicKey, 'base64url')), publicKey }, signedAt, payload: payload as Record<string, unknown> };
  return { unsigned, bytes: signingInput(purpose, { ...unsigned }) };
}

/** Attaches a 64-byte Ed25519 signature and refuses one that does not verify with the key the envelope names. */
export function attachSiteSignature(unsigned: UnsignedSiteFile, signature: Buffer): SignedSiteFile {
  refuseUnless(signature.length === 64, 'an Ed25519 signature is 64 bytes');
  const envelope: SignedSiteFile = { ...unsigned, sig: signature.toString('base64url') };
  const verdict = verifyEnvelope(envelope, { purpose: unsigned.purpose, keys: [unsigned.signer], now: new Date(Date.parse(unsigned.signedAt)) });
  refuseUnless(verdict.ok, verdict.ok ? '' : `the signature does not verify: ${verdict.message}`);
  return envelope;
}

/** The live feed's signing input; the collector signs it with Transit at `payload.keyVersion` (48.2-09). */
export function liveSigningInput(payload: LiveFeed, publicKey: string): { readonly unsigned: UnsignedSiteFile; readonly bytes: Buffer } {
  return siteSigningInput(SITE_LIVE_PURPOSE, parseLiveFeed(payload), publicKey, payload.generatedAt);
}
export function attachLiveSignature(unsigned: UnsignedSiteFile, signature: Buffer): SignedSiteFile {
  refuseUnless(unsigned.purpose === SITE_LIVE_PURPOSE, 'this is not an unsigned live feed');
  parseLiveFeed(unsigned.payload);
  return attachSiteSignature(unsigned, signature);
}

// ---- Verification ----

export type SiteFileName = 'live' | 'export' | 'rescan' | 'agreements';
export interface SiteEvidenceFiles {
  /** The trust ConfigMap's document (its exact bytes) and your site key's Sigstore bundle over them. */
  readonly trust?: { readonly document: Buffer | string; readonly bundle: unknown };
  readonly live?: unknown;
  readonly export?: unknown;
  readonly rescan?: unknown;
  readonly agreements?: unknown;
}
export type SiteSource =
  | { readonly file: 'trust' | SiteFileName; readonly verification: 'verified'; readonly signedAt: string; readonly keyVersion?: number }
  | { readonly file: 'trust' | SiteFileName; readonly verification: 'not-verified'; readonly reason: string; readonly keyVersion?: number }
  | { readonly file: 'trust' | SiteFileName; readonly verification: 'did-not-verify'; readonly reason: string };
export interface SiteEvidence {
  readonly sources: readonly SiteSource[];
  /** Observations from verified files only, each dated at its own evidence time. */
  readonly observations: readonly Observation[];
  /** The verified trust document's freshness policy, for rejudge; absent otherwise. */
  readonly policy?: unknown;
  readonly notes: readonly string[];
}

const FILE_PURPOSES: Readonly<Record<SiteFileName, string>> = { live: SITE_LIVE_PURPOSE, export: SITE_EXPORT_PURPOSE, rescan: SITE_RESCAN_PURPOSE, agreements: SITE_AGREEMENTS_PURPOSE };
const FILE_ORDER: readonly SiteFileName[] = ['live', 'export', 'rescan', 'agreements'];
const ENVELOPE_REASONS: Partial<Record<EnvelopeFailure, string>> = { 'too-large': 'too-large', 'wrong-purpose': 'wrong-purpose', 'signed-in-future': 'future-dated', 'bad-signature': 'signature', 'unknown-key': 'unknown-signer', 'key-mismatch': 'signature' };
const isFuture = (at: string, now: Date): boolean => Date.parse(at) - now.getTime() > FUTURE_TOLERANCE_MS;

class Refusal extends Error {
  public readonly verification: 'not-verified' | 'did-not-verify';
  public readonly reason: string;
  public readonly keyVersion?: number;
  public constructor(verification: 'not-verified' | 'did-not-verify', reason: string, keyVersion?: number) {
    super(reason);
    this.verification = verification;
    this.reason = reason;
    if (keyVersion !== undefined) this.keyVersion = keyVersion;
  }
}

/** The envelope a file holds: an object, or the file's text read with its size checked before it is parsed. */
function envelopeOf(file: unknown): unknown {
  if (typeof file !== 'string' && !Buffer.isBuffer(file)) return file;
  if (Buffer.byteLength(file) > 2 * MAX_PAYLOAD_BYTES) throw new Refusal('did-not-verify', 'too-large');
  try {
    return JSON.parse(file.toString());
  } catch {
    throw new Refusal('did-not-verify', 'format');
  }
}

/** Verifies one site file against the trust document; returns its observations and signing time, or throws a Refusal. */
function verifyFile(name: SiteFileName, file: unknown, trust: TrustDocument, now: Date, exchangeIds: readonly string[]): { observations: Observation[]; signedAt: string; keyVersion?: number } {
  const envelope = envelopeOf(file);
  const purpose = FILE_PURPOSES[name];
  const claimed = isRecord(envelope) && isRecord(envelope.signer) && typeof envelope.signer.publicKey === 'string' ? envelope.signer.publicKey : undefined;
  let entry: TrustSigner | undefined;
  let publicKey: string | undefined;
  let keyVersion: number | undefined;
  if (name === 'live') {
    const version = isRecord(envelope) && isRecord(envelope.payload) ? envelope.payload.keyVersion : undefined;
    if (!Number.isSafeInteger(version)) throw new Refusal('did-not-verify', 'format');
    keyVersion = version as number;
    entry = trust.signers.find(({ role }) => role === 'collector');
    publicKey = entry?.versions?.find((listed) => listed.version === keyVersion)?.publicKey;
    if (!entry || !publicKey) throw new Refusal('not-verified', 'key-version-not-listed', keyVersion);
  } else {
    entry = trust.signers.find((signer) => signer.role === 'operator' && signer.publicKey === claimed);
    if (!entry) throw new Refusal('did-not-verify', 'unknown-signer');
    if (!entry.purposes.includes(purpose)) throw new Refusal('did-not-verify', 'wrong-purpose');
    publicKey = entry.publicKey!;
  }
  const verdict = verifyEnvelope(envelope, { purpose, keys: [{ fingerprint: fingerprintOf(Buffer.from(publicKey, 'base64url')), publicKey }], now });
  if (!verdict.ok) throw new Refusal('did-not-verify', ENVELOPE_REASONS[verdict.reason] ?? 'format');
  if (Date.parse(verdict.signedAt) < Date.parse(entry.notBefore) || now.getTime() < Date.parse(entry.notBefore)) throw new Refusal('not-verified', 'signer-not-yet-valid', keyVersion);
  if (Date.parse(verdict.signedAt) > Date.parse(entry.notAfter) || now.getTime() > Date.parse(entry.notAfter)) throw new Refusal('not-verified', 'signer-expired', keyVersion);
  const payload = verdict.payload;
  const site = isRecord(payload) ? payload.site : undefined;
  if (site !== trust.site) throw new Refusal('did-not-verify', 'format');
  let observations: Observation[];
  try {
    observations = toObservations(name, payload, verdict.signedAt, now, exchangeIds);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal('did-not-verify', 'format');
  }
  return { observations, signedAt: verdict.signedAt, ...(keyVersion !== undefined ? { keyVersion } : {}) };
}

/** A verified payload's observations, each dated at its own evidence time. */
function toObservations(name: SiteFileName, payload: unknown, signedAt: string, now: Date, exchangeIds: readonly string[]): Observation[] {
  if (name === 'live') {
    const feed = parseLiveFeed(payload);
    if (feed.generatedAt !== signedAt) throw new Refusal('did-not-verify', 'format');
    if (Object.values(feed.groups).some(({ collectedAt }) => isFuture(collectedAt, now))) throw new Refusal('did-not-verify', 'future-dated');
    return liveObservations(feed.groups);
  }
  if (name === 'export') {
    const exported = parseExportPayload(payload);
    if (exported.generatedAt !== signedAt) throw new Refusal('did-not-verify', 'format');
    return CHECKS.map((check) => {
      const outcome = check.derive(exported.facts);
      return { collector: 'deployment', subject: check.subject, passed: outcome.passed, collectedAt: signedAt, counts: { ...outcome.counts }, ...(outcome.hash ? { hash: outcome.hash } : {}) };
    });
  }
  if (name === 'rescan') {
    const rescan = parseRescanPayload(payload);
    if (Date.parse(rescan.rescannedAt) > Date.parse(signedAt)) throw new Refusal('did-not-verify', 'format');
    const counts: Record<string, number> = { ...rescan.counts, total: RESCAN_SEVERITIES.reduce((sum, key) => sum + rescan.counts[key], 0) };
    const major = /^v?(\d{1,3})\./.exec(rescan.database.schema)?.[1];
    if (major) counts['db-schema'] = Number(major);
    return [{ collector: 'image-scan', subject: rescan.subject, passed: rescan.database.signatureVerified, collectedAt: rescan.database.built, hash: rescan.database.checksum, counts }];
  }
  const agreements = parseAgreementsPayload(payload, exchangeIds);
  const dated = agreements.agreements.map((entry) => ({ entry, at: `${entry.reviewedAt}T00:00:00.000Z` }));
  if (dated.some(({ at }) => isFuture(at, now))) throw new Refusal('did-not-verify', 'future-dated');
  return dated.map(({ entry, at }) => ({ collector: 'site-agreements', subject: entry.exchange, passed: true, collectedAt: at }));
}

/**
 * Verifies a site's evidence files (D-17, D-18): the trust document first, against your organization's site key, then each file against the
 * key the document names for that file's purpose, within its dates, the live feed at its signed and listed key version. Returns each file's
 * outcome, the observations of the verified files, and the verified document's freshness policy. Never throws.
 */
export function verifySiteEvidence(input: { readonly files: SiteEvidenceFiles; readonly organizationKey?: string; readonly now: Date; readonly exchangeIds?: readonly string[] }): SiteEvidence {
  const { files, now } = input;
  const present = FILE_ORDER.filter((name) => files[name] !== undefined);
  const sources: SiteSource[] = [];
  const notes: string[] = [];
  const untrusted = (trustSource: SiteSource, reason: string, note: string): SiteEvidence => {
    notes.push(note);
    return { sources: [trustSource, ...present.map((file) => ({ file, verification: 'not-verified' as const, reason }))], observations: [], notes };
  };
  if (!files.trust) return untrusted({ file: 'trust', verification: 'not-verified', reason: 'no-trust-document' }, 'no-trust-document', 'No site trust document, so no site evidence counts and the release freshness defaults apply.');
  const document = Buffer.isBuffer(files.trust.document) ? files.trust.document : Buffer.from(files.trust.document);
  if (document.length > MAX_PAYLOAD_BYTES) return untrusted({ file: 'trust', verification: 'did-not-verify', reason: 'too-large' }, 'trust-did-not-verify', 'The site trust document is larger than allowed, so no site evidence counts.');
  if (!input.organizationKey) return untrusted({ file: 'trust', verification: 'not-verified', reason: 'no-site-key' }, 'trust-not-verified', 'This session has no site key to check the site trust document with, so no site evidence counts.');
  if (!verifySigstoreBundle(document, files.trust.bundle, input.organizationKey).ok) {
    return untrusted({ file: 'trust', verification: 'did-not-verify', reason: 'trust-signature' }, 'trust-did-not-verify', 'The site trust document did not verify with your organization’s site key, so no site evidence counts and the release freshness defaults apply.');
  }
  let trust: TrustDocument;
  try {
    trust = parseTrustDocument(JSON.parse(document.toString('utf8')));
  } catch {
    return untrusted({ file: 'trust', verification: 'did-not-verify', reason: 'format' }, 'trust-did-not-verify', 'The site trust document is not in a format this release reads, so no site evidence counts.');
  }
  if (isFuture(trust.issuedAt, now)) return untrusted({ file: 'trust', verification: 'did-not-verify', reason: 'future-dated' }, 'trust-did-not-verify', 'The site trust document is dated ahead of this computer’s clock, so no site evidence counts.');
  sources.push({ file: 'trust', verification: 'verified', signedAt: trust.issuedAt });
  const observations: Observation[] = [];
  for (const name of present) {
    try {
      const verified = verifyFile(name, files[name], trust, now, input.exchangeIds ?? []);
      sources.push({ file: name, verification: 'verified', signedAt: verified.signedAt, ...(verified.keyVersion !== undefined ? { keyVersion: verified.keyVersion } : {}) });
      observations.push(...verified.observations);
    } catch (error) {
      const refusal = error instanceof Refusal ? error : new Refusal('did-not-verify', 'format');
      sources.push(refusal.verification === 'not-verified'
        ? { file: name, verification: 'not-verified', reason: refusal.reason, ...(refusal.keyVersion !== undefined ? { keyVersion: refusal.keyVersion } : {}) }
        : { file: name, verification: 'did-not-verify', reason: refusal.reason });
    }
  }
  return { sources, observations, ...(trust.freshness !== undefined ? { policy: trust.freshness } : {}), notes };
}
