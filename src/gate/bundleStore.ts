// The policy bundle on disk (OFFL-01, OFFL-02, OFFL-03, D-13, D-14, D-15, D-39): <globalStorage>/gate/policy-bundle.json, signed with the one signer
// (signPayload, purpose policy-bundle) and checked with the one verifier. Node I/O only: this module never imports vscode, and SecretStorage is reached
// through the type-only SecretStorageLike interface. Nothing here waits on the network.
//
// The rule that matters most (Pitfall 7, and the PR #70 second review): this store never signs a policy it did not itself write. It creates a first policy
// by itself only on a TRUE first install: no last-valid marker in SecretStorage, no policy file or kept-aside copy, no decision log that ever named a valid
// policy, and no key history left behind by a lost key (src/gate/installEvidence.ts). Anything else that is not a valid bundle fails closed with a plain
// sentence, whatever its content: a missing file, a changed file, and a file signed by a key this computer does not know (even one that carries the shipped
// default policy, because its signature proves nothing about who wrote it). Only resetPolicyToDefaults (the person's own command, recorded as policy.reset)
// signs a fresh one, keeping the old file beside it under a new name. The one automatic write besides the first is renewing a bundle (D-14), and only when
// this install's own key signed it AND its hash is the last-valid hash held in SecretStorage. A valid file whose hash is not the last-valid one (an older
// signed policy put back, say) is refused as `replaced`, so rolling the file back cannot widen a narrowed policy either.
//
// What a disk-only writer can and cannot do: the marker (time and last-valid hash), the device key and the end of the key history all live in
// SecretStorage, which a file write cannot reach. Deleting the policy file, replacing it, or deleting every file this store keeps gives a failed-closed
// state, never a self-signed one, unless the secret store itself was wiped AND the disk was cleaned of every trace listed above; that last case is
// indistinguishable from a new computer and is treated as one.
//
// Check, sign, write and read back all happen inside bundle.lock in the gate folder, so two windows starting together end with one identity and one
// bundle. Lock order wherever both are taken: bundle.lock first, then identity-create.lock (inside loadOrCreateDeviceIdentity), then key-history.lock.
import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretStorageLike } from '../services/auth';
import { withFileLock } from '../services/stateMirrorLock';
import {
  BUNDLE_FAILURES, SELF_SIGNED_LIFETIME_DAYS, UPDATE_REASONS, bundleHash, defaultBundlePayload, effectiveNow, failedClosed, inBundleOrder, parseBundle, renewalPayload, shapeReason,
  verifyBundleEnvelope
} from '../domain/gate/bundle';
import type { BundleState, PolicyBundle, PolicyEventId } from '../domain/gate/bundle';
import { ALWAYS_REQUIRED_FEATURES, POLICY_SECTIONS, featureForSection } from '../domain/gate/features';
import { wideningOf, widerThanOrganizationText } from '../domain/gate/layers';
import { bundleViewOf, documentFromBundle, parsePolicyDocument, verifyPolicyLayer } from '../domain/gate/policyDocument';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import { MAX_PAYLOAD_BYTES, PayloadError, signPayload, verifyPayload } from '../domain/team/signedPayload';
import type { SignedPayload } from '../domain/team/signedPayload';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { identityDir, loadDeviceIdentity, loadOrCreateDeviceIdentity } from '../team/identity';
import type { DeviceIdentity } from '../team/identity';
import { localKeyStatus } from '../team/keyHistory';
import { writeFileAtomic } from '../team/teamFile';
import { announceNextHash, readLastValid, withdrawNextHash, writeLastValid } from './clockMarker';
import type { LastValid } from './clockMarker';
import { earlierInstallEvidence } from './installEvidence';

export const GATE_DIR_NAME = 'gate';
export const POLICY_BUNDLE_FILE = 'policy-bundle.json';
export const BUNDLE_LOCK_FILE = 'bundle.lock';
/** The unsigned draft Edit Policy writes, in this extension's storage (never the project), and the hash of the policy it was made from beside it (D-41, D-53). */
export const POLICY_DRAFT_FILE = 'policy-draft.json';
export const POLICY_DRAFT_BASE_FILE = 'policy-draft.base';

/** Said when a draft was made from a policy that is no longer the one in force (D-53). */
export const STALE_DRAFT_TEXT = 'Your policy changed after this draft was made. Open SovAI: Policy and choose Edit my rules again to start from the policy in force.';
/** A draft that is not one JSON object. */
export const POLICY_DRAFT_SHAPE_TEXT = 'Nothing was changed: the draft must be one JSON object, the policy as Edit my rules in SovAI: Policy wrote it.';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A file larger than this is not read at all; the verifier's own limit applies to what is signed, this one protects memory. */
const MAX_BUNDLE_FILE_BYTES = MAX_PAYLOAD_BYTES * 2;
const MAX_ASIDE_ATTEMPTS = 50;

/** A failure that changed nothing, with a plain message. Thrown by resetPolicyToDefaults and by a disk write that failed on first creation. */
export class BundleStoreError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BundleStoreError';
  }
}

/** What happened to the file during a call, for the caller to record. Absent when nothing was written. One of POLICY_EVENT_IDS. */
export type BundleEvent = Exclude<PolicyEventId, 'policy.load'>;

export interface BundleResult {
  readonly state: BundleState;
  readonly event?: BundleEvent;
  /** The verified personal payload as signed (a v1 bundle or a v2 personal layer), when the state is valid. The layered load reads it (41-09). */
  readonly stored?: unknown;
}

export interface BundleStoreOptions {
  /** The clock; tests pass a fixed one. */
  readonly now?: () => Date;
  /** Where a plain warning from the key history goes. Never given key material. */
  readonly warn?: (message: string) => void;
}

export function gateDir(globalStorageDir: string): string {
  return path.join(globalStorageDir, GATE_DIR_NAME);
}

function bundleFile(globalStorageDir: string): string {
  return path.join(gateDir(globalStorageDir), POLICY_BUNDLE_FILE);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailable(error: unknown): BundleState {
  return failedClosed('identity-unavailable', messageOf(error));
}

function clockOf(options: BundleStoreOptions): () => Date {
  return options.now ?? ((): Date => new Date());
}

interface Disk {
  readonly state: BundleState;
  /** The parsed file, when there was one that parsed. */
  readonly envelope?: unknown;
  /** The verified payload, when the state is valid. */
  readonly stored?: unknown;
}

function payloadOf(envelope: unknown): unknown {
  return typeof envelope === 'object' && envelope !== null && !Array.isArray(envelope) && Object.prototype.hasOwnProperty.call(envelope, 'payload')
    ? (envelope as { payload: unknown }).payload
    : undefined;
}

/** True for an envelope whose payload says bundleVersion 2: a sectioned personal layer, read by verifyPolicyLayer (D-49). Anything else takes today's v1 reader. */
function isLayerEnvelope(envelope: unknown): boolean {
  const payload = payloadOf(envelope);
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload) && Object.prototype.hasOwnProperty.call(payload, 'bundleVersion')
    && (payload as { bundleVersion: unknown }).bundleVersion === 2;
}

/** The reasons a signed own-key v2 layer fails for that are not its content, so they carry no ownPolicy mark (as the v1 reader marks only content). */
const NOT_CONTENT: ReadonlySet<string> = new Set(['signer-mismatch', 'clock-behind', 'expired']);

// One envelope through the reader its wire version needs. v1: verifyBundleEnvelope, its sentences and the safety patch's ownPolicy mark unchanged. v2:
// verifyPolicyLayer under purpose policy-bundle with this install's key history, its valid state turned into today's view (D-04, D-49).
function verifyEnvelope(envelope: unknown, status: KeyStatusLookup, nowMs: number, lastValidAt: number | undefined, ownKeysOnly: boolean): { state: BundleState; stored?: unknown } {
  const times = { now: nowMs, ...(lastValidAt === undefined ? {} : { lastValidAt }) };
  if (!isLayerEnvelope(envelope)) {
    const state = verifyBundleEnvelope(envelope, { status, ...times, ...(ownKeysOnly ? { ownKeysOnly: true } : {}) });
    return state.state === 'valid' ? { state, stored: payloadOf(envelope) } : { state };
  }
  const layer = verifyPolicyLayer(envelope, { purpose: 'policy-bundle', status, ...times });
  if (layer.state !== 'valid') {
    const own = ownKeysOnly && !NOT_CONTENT.has(layer.reason) && verifyPayload(envelope, { purpose: 'policy-bundle', status }).ok;
    return { state: own ? { ...layer, ownPolicy: true } : layer };
  }
  return {
    state: { state: 'valid', bundle: bundleViewOf(layer.document), hash: layer.hash, signer: layer.signer, expiresAt: layer.expiresAt, renewDue: layer.renewDue },
    stored: payloadOf(envelope)
  };
}

// Reads the file and verifies it. Every cause the person can fix is its own reason; nothing is guessed and nothing is written.
async function verifyDisk(globalStorageDir: string, secrets: SecretStorageLike, nowMs: number, marker: LastValid, pinnedStatus?: KeyStatusLookup): Promise<Disk> {
  const file = bundleFile(globalStorageDir);
  let text: string;
  try {
    const size = (await stat(file)).size;
    if (size > MAX_BUNDLE_FILE_BYTES) return { state: failedClosed('too-large') };
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { state: failedClosed('missing') };
    return { state: failedClosed('unparseable', `The policy file could not be read (${errorCode(error) ?? 'error'}).`) };
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { state: failedClosed('unparseable') };
  }
  const status = pinnedStatus ?? await localKeyStatus(identityDir(globalStorageDir), secrets);
  const lastValidAt = marker.present ? marker.at : undefined;
  // The status is this install's own key history, so a policy that verifies but cannot be read is the person's own (Show Policy may offer Reset for it).
  const read = verifyEnvelope(envelope, status, nowMs, lastValidAt, true);
  const state = read.state;
  // A file that verifies but is not the one this install last accepted (or is writing right now) was put there from outside: refused, never adopted.
  // The rule is the same for both wire versions.
  if (state.state === 'valid' && marker.present && marker.hash !== undefined && state.hash !== marker.hash && state.hash !== marker.pending) {
    return { state: failedClosed('replaced'), envelope };
  }
  return read.stored === undefined ? { state, envelope } : { state, envelope, stored: read.stored };
}

/** Reads the exact committed V2 personal envelope. The frontier host holds the bundle and key-history locks. */
export async function readCommittedFrontierPersonal(
  globalStorageDir: string, secrets: SecretStorageLike, instant: number, marker: LastValid, historyStatus: KeyStatusLookup
) {
  if (!marker.present || marker.at === undefined || marker.hash === undefined || marker.pending !== undefined) return undefined;
  const disk = await verifyDisk(globalStorageDir, secrets, instant, marker, historyStatus);
  if (disk.state.state !== 'valid' || disk.state.hash !== marker.hash || !isLayerEnvelope(disk.envelope)) return undefined;
  const document = parsePolicyDocument(disk.stored);
  if (!document.ok) return undefined;
  return { envelope: disk.envelope, document: document.value, signer: disk.state.signer, status: historyStatus(disk.state.signer) };
}

function lastValidAtOf(marker: LastValid): number | undefined {
  return marker.present ? marker.at : undefined;
}

function sign<T>(identity: DeviceIdentity, payload: T, at: Date): SignedPayload<T> {
  try {
    return signPayload(identity, 'policy-bundle', payload, { now: () => at });
  } catch (error) {
    if (error instanceof PayloadError) throw new BundleStoreError(error.message, { cause: error });
    throw error;
  }
}

// Checks a freshly signed envelope in memory, writes it through a temp file and a rename, reads it back from disk and verifies it again. Throws
// BundleStoreError when it does not verify (before anything is written) or cannot be written.
//
// Whatever happens after the marker names the new hash as `pending`, a failure leaves the marker and the file as they were: the pending hash is withdrawn, and
// the file that was there is put back when this call replaced it. A pending hash left behind names a policy this install signed but never kept, so a copy of
// that file put back later would be accepted as the next policy, widening a narrowed one (PR #70 third review).
async function install(globalStorageDir: string, secrets: SecretStorageLike, envelope: SignedPayload<unknown>, nowMs: number, marker: LastValid): Promise<Disk> {
  const lastValidAt = lastValidAtOf(marker);
  const status = await localKeyStatus(identityDir(globalStorageDir), secrets);
  const before = verifyEnvelope(envelope, status, nowMs, lastValidAt, false).state;
  if (before.state !== 'valid') throw new BundleStoreError(`Nothing was written: the new policy did not verify. ${before.sentence}`);
  const file = bundleFile(globalStorageDir);
  const previous = await readFile(file, 'utf8').catch(() => undefined);
  // The marker names the hash about to be written first, so a crash between the file and the marker leaves a file the next start still accepts.
  try {
    await announceNextHash(secrets, before.hash);
  } catch (error) {
    await withdrawNextHash(secrets).catch(() => undefined);
    throw new BundleStoreError('Nothing was written: SovAI could not update its record of your policy in this computer\'s secret storage.', { cause: error });
  }
  try {
    await writeFileAtomic(file, `${JSON.stringify(envelope, null, 2)}\n`);
  } catch (error) {
    await withdrawNextHash(secrets).catch(() => undefined);
    throw new BundleStoreError('Nothing was written: the policy file could not be saved in this extension\'s storage folder.', { cause: error });
  }
  const after = await verifyDisk(globalStorageDir, secrets, nowMs, marker.present ? { ...marker, pending: before.hash } : marker);
  if (after.state.state !== 'valid' || after.state.hash !== before.hash) {
    if (previous !== undefined) await writeFileAtomic(file, previous).catch(() => undefined);
    await withdrawNextHash(secrets).catch(() => undefined);
    throw new BundleStoreError('The new policy file was saved but did not read back as written, so it was not used.');
  }
  return after;
}

// Stores the marker for a valid state. A store or read-back failure is the identity-unavailable state (A2): the bundle is not trusted when the install
// cannot remember that it had one.
async function remember(secrets: SecretStorageLike, state: BundleState & { state: 'valid' }, effective: number): Promise<BundleState> {
  try {
    await writeLastValid(secrets, { at: effective, hash: state.hash });
  } catch (error) {
    return unavailable(error);
  }
  return state;
}

async function identityFor(globalStorageDir: string, secrets: SecretStorageLike, options: BundleStoreOptions): Promise<DeviceIdentity> {
  const { identity } = await loadOrCreateDeviceIdentity(secrets, {
    identityDir: identityDir(globalStorageDir),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.warn === undefined ? {} : { warn: options.warn })
  });
  return identity;
}

// The default bundle, signed by this install's identity (created here when it does not exist yet), written, read back and remembered.
async function installDefault(
  globalStorageDir: string, secrets: SecretStorageLike, options: BundleStoreOptions, nowMs: number, marker: LastValid, event: BundleEvent
): Promise<BundleResult> {
  let identity: DeviceIdentity;
  try {
    identity = await identityFor(globalStorageDir, secrets, options);
  } catch (error) {
    return { state: unavailable(error) };
  }
  const effective = effectiveNow(nowMs, lastValidAtOf(marker));
  const payload = defaultBundlePayload({ issuer: { fingerprint: identity.fingerprint, publicKey: identity.publicKey }, now: effective });
  const written = await install(globalStorageDir, secrets, sign(identity, payload, new Date(effective)), nowMs, marker);
  if (written.state.state !== 'valid') return { state: written.state };
  const kept = await remember(secrets, written.state, effective);
  return kept.state === 'valid' ? { state: kept, event, stored: written.stored } : { state: kept };
}

// Re-signs the stored payload with fresh dates when this install's own key signed it (D-14, D-62): renewalPayload gives unedited starting rules the
// current starting rules and any other payload back unchanged, so a v1 bundle stays v1 and a v2 personal layer stays v2 with all its sections. The stored
// payload is signed, never the view (41-01 contract choice 1). Any failure leaves the file as it was and the caller on the valid state it already has: a
// renewal that did not happen is not a reason to fail closed.
async function tryRenew(
  globalStorageDir: string, secrets: SecretStorageLike, current: BundleState & { state: 'valid' }, stored: unknown, nowMs: number, marker: LastValid
): Promise<Disk | undefined> {
  try {
    // Only this install's own key, and only the policy this install last accepted: a bundle that merely verifies is never carried forward.
    if (!marker.present || marker.hash === undefined || marker.hash !== current.hash || stored === undefined) return undefined;
    const identity = await loadDeviceIdentity(secrets);
    if (identity === undefined || identity.fingerprint !== current.signer.fingerprint || identity.publicKey !== current.signer.publicKey) return undefined;
    const effective = effectiveNow(nowMs, lastValidAtOf(marker));
    const payload = renewalPayload(stored as PolicyBundle, effective);
    return await install(globalStorageDir, secrets, sign(identity, payload, new Date(effective)), nowMs, marker);
  } catch {
    return undefined;
  }
}

/**
 * Reads and verifies the stored bundle, and changes nothing. Never throws: a secret store that cannot be read is the identity-unavailable state.
 */
export async function loadPolicyBundle(globalStorageDir: string, secrets: SecretStorageLike, options: BundleStoreOptions = {}): Promise<BundleState> {
  const nowMs = clockOf(options)().getTime();
  let marker: LastValid;
  try {
    marker = await readLastValid(secrets);
  } catch (error) {
    return unavailable(error);
  }
  return (await verifyDisk(globalStorageDir, secrets, nowMs, marker)).state;
}

/**
 * The personal layer as loadPolicyBundle reads it, with the verified payload as signed (`stored`) beside a valid state, for the layered load to compose
 * (41-09). Changes nothing and never throws.
 */
export async function loadPersonalLayer(globalStorageDir: string, secrets: SecretStorageLike, options: BundleStoreOptions = {}): Promise<BundleResult> {
  const nowMs = clockOf(options)().getTime();
  let marker: LastValid;
  try {
    marker = await readLastValid(secrets);
  } catch (error) {
    return { state: unavailable(error) };
  }
  try {
    const disk = await verifyDisk(globalStorageDir, secrets, nowMs, marker);
    return disk.state.state === 'valid' && disk.stored !== undefined ? { state: disk.state, stored: disk.stored } : { state: disk.state };
  } catch (error) {
    return { state: unavailable(error) };
  }
}

/**
 * The activation check (OFFL-02). Runs once when the extension starts and never per decision.
 * - True first install (no marker, no file, and no earlier-install evidence on disk): creates the identity if needed, signs the default bundle, writes
 *   and reads it back, remembers it.
 * - A bundle that verifies and whose hash is the last-valid one: remembered, and re-signed with fresh dates in its last 30 days when this install's own
 *   key signed it. A valid bundle with another hash is refused as `replaced`.
 * - Anything else, including a bundle signed by a key this computer does not know whatever it contains: the failed-closed state with its sentence, and
 *   the file is left exactly as it was. Nothing here ever signs a policy it did not write itself (D-39 as amended by the PR #70 second review).
 * Throws BundleStoreError only when a first bundle could not be written to disk.
 */
export async function ensurePolicyBundle(globalStorageDir: string, secrets: SecretStorageLike, options: BundleStoreOptions = {}): Promise<BundleResult> {
  const nowMs = clockOf(options)().getTime();
  if (Number.isNaN(nowMs)) return { state: failedClosed('clock-behind', 'The clock gave no valid time.') };
  const dir = gateDir(globalStorageDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return withFileLock(dir, BUNDLE_LOCK_FILE, async (): Promise<BundleResult> => {
    let marker: LastValid;
    try {
      marker = await readLastValid(secrets);
    } catch (error) {
      return { state: unavailable(error) };
    }
    const found = await verifyDisk(globalStorageDir, secrets, nowMs, marker);
    const state = found.state;
    if (state.state === 'valid') {
      let current: BundleState & { state: 'valid' } = state;
      let stored = found.stored;
      let event: BundleEvent | undefined;
      if (state.renewDue) {
        const renewed = await tryRenew(globalStorageDir, secrets, state, found.stored, nowMs, marker);
        if (renewed !== undefined && renewed.state.state === 'valid') {
          current = renewed.state;
          stored = renewed.stored;
          event = 'policy.renewed';
        }
      }
      const kept = await remember(secrets, current, effectiveNow(nowMs, lastValidAtOf(marker)));
      if (kept.state !== 'valid') return { state: kept };
      return event !== undefined ? { state: kept, event, stored } : { state: kept, stored };
    }
    if (state.reason === 'missing') {
      // The only silent creation: this install has never had a valid bundle. With a marker, a missing file is a changed policy, never a fresh start; with
      // no marker, anything on disk that says a policy existed before (a wiped secret store, say) is the same.
      if (marker.present) return { state };
      const earlier = await earlierInstallEvidence(dir, identityDir(globalStorageDir), secrets);
      if (earlier !== undefined) return { state: failedClosed('missing', earlier) };
      return installDefault(globalStorageDir, secrets, options, nowMs, marker, 'policy.created');
    }
    return { state };
  });
}

// A file name beside the policy file that nothing else uses, so the old file is kept and never overwritten.
async function asideName(file: string, nowMs: number): Promise<string> {
  for (let attempt = 0; attempt < MAX_ASIDE_ATTEMPTS; attempt += 1) {
    const target = `${file}.replaced-${nowMs}${attempt === 0 ? '' : `-${attempt + 1}`}`;
    try {
      await stat(target);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return target;
      throw error;
    }
  }
  throw new BundleStoreError('Nothing was changed: the old policy file could not be kept under a new name.');
}

/**
 * The person's own command (SovAI: Reset Policy to Defaults): signs a fresh default bundle and keeps the old file beside it as
 * policy-bundle.json.replaced-<epoch ms>, never deleted. Returns the event policy.reset for the caller to record. Throws BundleStoreError with a plain
 * message, with the old file still in place, when the identity or the disk fails.
 */
export async function resetPolicyToDefaults(globalStorageDir: string, secrets: SecretStorageLike, options: BundleStoreOptions = {}): Promise<BundleResult> {
  const nowMs = clockOf(options)().getTime();
  if (Number.isNaN(nowMs)) throw new BundleStoreError('Nothing was changed: the clock gave no valid time.');
  const dir = gateDir(globalStorageDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return withFileLock(dir, BUNDLE_LOCK_FILE, async (): Promise<BundleResult> => {
    let marker: LastValid;
    let identity: DeviceIdentity;
    try {
      marker = await readLastValid(secrets);
      identity = await identityFor(globalStorageDir, secrets, options);
    } catch (error) {
      throw new BundleStoreError('Nothing was changed: SovAI could not use its signing key on this computer, so the policy was not reset.', { cause: error });
    }
    const effective = effectiveNow(nowMs, lastValidAtOf(marker));
    const payload = defaultBundlePayload({ issuer: { fingerprint: identity.fingerprint, publicKey: identity.publicKey }, now: effective });
    const envelope = sign(identity, payload, new Date(effective));
    const file = bundleFile(globalStorageDir);
    let aside: string | undefined;
    try {
      await stat(file);
      aside = await asideName(file, nowMs);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error instanceof BundleStoreError ? error : new BundleStoreError('Nothing was changed: the old policy file could not be kept under a new name.', { cause: error });
    }
    if (aside !== undefined) {
      try {
        await rename(file, aside);
      } catch (error) {
        throw new BundleStoreError('Nothing was changed: the old policy file could not be kept under a new name.', { cause: error });
      }
    }
    let written: Disk;
    try {
      written = await install(globalStorageDir, secrets, envelope, nowMs, marker);
    } catch (error) {
      // The old file goes back where it was, so a reset that failed leaves the policy as it was. Install has withdrawn the pending hash on every failure after
      // naming it; this is the same withdrawal again, for the case where it could not (the secret store failing twice), and it is harmless when there is none.
      if (aside !== undefined) await rename(aside, file).catch(() => undefined);
      await withdrawNextHash(secrets).catch(() => undefined);
      throw error;
    }
    if (written.state.state !== 'valid') return { state: written.state };
    const kept = await remember(secrets, written.state, effective);
    return kept.state === 'valid' ? { state: kept, event: 'policy.reset', stored: written.stored } : { state: kept };
  });
}

export interface PolicyEditResult extends BundleResult {
  readonly oldHash: string;
  readonly newHash: string;
}

/** The extension's own fields of a draft: this install's key and fresh dates (D-12). A draft never sets them. */
export interface OwnedDraftFields {
  readonly issuer: { readonly fingerprint: string; readonly publicKey: string };
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** Added to a v2 draft refusal whose cause is a newer format (an unknown section or feature), so the person updates instead of guessing (D-07). */
export const DRAFT_UPDATE_TEXT = 'If a newer version of SovAI wrote this draft, update the extension first.';

/**
 * Reads a draft as a personal layer document (FND-02, D-04). JSON and object checks with today's messages; a draft with `bundleVersion` 1 or none takes
 * today's path word for word (inBundleOrder, the extension's issuer and dates, parseBundle) and is then read as v2 with documentFromBundle; a draft with
 * `bundleVersion` 2 goes through parsePolicyDocument with the same owned fields and layer `personal` (a `parent` in the draft is never trusted). Throws
 * BundleStoreError with a plain message; never signs anything.
 */
export function parsePolicyDraft(draftText: string, owned: OwnedDraftFields): PolicyDocument {
  let draft: unknown;
  try {
    draft = JSON.parse(draftText);
  } catch (error) {
    throw new BundleStoreError(`Nothing was changed: the draft is not valid JSON (${error instanceof Error ? error.message.slice(0, 160) : 'parse error'}).`);
  }
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) throw new BundleStoreError(POLICY_DRAFT_SHAPE_TEXT);
  const record = draft as Record<string, unknown>;
  const version = Object.prototype.hasOwnProperty.call(record, 'bundleVersion') ? record['bundleVersion'] : undefined;
  if (version !== 2) {
    const parsed = parseBundle({ ...(inBundleOrder(draft) as Record<string, unknown>), ...owned });
    if (!parsed.ok) throw new BundleStoreError(`Nothing was changed: the draft is not a policy this version can use. ${parsed.message}`);
    return documentFromBundle(parsed.value);
  }
  const candidate: Record<string, unknown> = { ...record, ...owned, layer: 'personal' };
  delete candidate['parent'];
  candidate['requires'] = requiresFor(candidate, Array.isArray(record['requires']) ? record['requires'] : []);
  const parsed = parsePolicyDocument(candidate);
  if (!parsed.ok) {
    const newer = UPDATE_REASONS.has(shapeReason(parsed)) || shapeReason(parsed) === 'unknown-field';
    throw new BundleStoreError(`Nothing was changed: the draft is not a policy this version can use. ${parsed.message}${newer ? ` ${DRAFT_UPDATE_TEXT}` : ''}`);
  }
  return parsed.value;
}

// The features a personal layer names: the ones it already names, layers@1, labels@1, agents@1 and the feature of each section present, sorted and unique.
function requiresFor(document: Record<string, unknown>, named: readonly unknown[]): string[] {
  const features = new Set<string>([...named.filter((item): item is string => typeof item === 'string'), ...ALWAYS_REQUIRED_FEATURES]);
  for (const section of POLICY_SECTIONS) {
    const feature = featureForSection(section);
    if (feature !== undefined && Object.prototype.hasOwnProperty.call(document, section) && document[section] !== undefined) features.add(feature);
  }
  return [...features].sort();
}

/** Your organization's layer an Apply is checked against (D-20): its document, its hash and its issuer's fingerprint, for the personal layer's parent. */
export interface ApplyOrganizationLayer {
  readonly document: PolicyDocument;
  readonly hash: string;
  readonly issuerFingerprint: string;
}

// The personal layer that is signed: the draft's document with layer personal, the parent when your organization's layer is in force, and `requires`
// complete. Refused when parsePolicyDocument does not accept that exact payload or when its view differs from the draft's: the rewrite never changes the
// effect.
function personalLayerPayload(document: PolicyDocument, organization: ApplyOrganizationLayer | undefined): PolicyDocument {
  const payload = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
  payload['layer'] = 'personal';
  delete payload['parent'];
  if (organization !== undefined) payload['parent'] = { hash: organization.hash, issuer: organization.issuerFingerprint };
  payload['requires'] = requiresFor(payload, document.requires);
  const parsed = parsePolicyDocument(payload);
  if (!parsed.ok) throw new BundleStoreError(`Nothing was changed: the draft could not be written as a policy this version can read. ${parsed.message}`);
  if (bundleHash(bundleViewOf(parsed.value)) !== bundleHash(bundleViewOf(document))) {
    throw new BundleStoreError('Nothing was changed: the draft could not be written without changing what it does.');
  }
  return parsed.value;
}

export interface ApplyPolicyDraftInput {
  /** The hash of the personal layer the draft was made from. */
  readonly baseHash: string;
  /** Your organization's layer in force, when there is one: a draft that widens past it is refused before signing (D-20). */
  readonly organization?: ApplyOrganizationLayer;
}

/**
 * SovAI: Apply Policy Draft (D-41, D-53, FND-02). Under bundle.lock: the personal layer stored now must be valid and its hash must equal `baseHash` (the
 * hash of the layer the draft was made from), so an old draft never undoes another window's edit or a reset; the draft is read by parsePolicyDraft, with
 * this extension setting the issuer (this install's key) and the dates itself, so a draft cannot sign a policy in another device's name or with a past or
 * far-future date (D-12). Under your organization's layer, an edit that widens past it is refused with the key named (D-20), and a value already clamped
 * at load never blocks an unrelated edit. The draft is then signed as a v2 personal layer (only Edit or Apply writes v2, D-04), written, read back,
 * verified and remembered. Every refusal is a BundleStoreError with a plain message, and nothing is written then. Returns policy.edit with the old and
 * new hashes.
 */
export async function applyPolicyDraft(globalStorageDir: string, secrets: SecretStorageLike, draftText: string, input: ApplyPolicyDraftInput, options: BundleStoreOptions = {}): Promise<PolicyEditResult> {
  const nowMs = clockOf(options)().getTime();
  if (Number.isNaN(nowMs)) throw new BundleStoreError('Nothing was changed: the clock gave no valid time.');
  const dir = gateDir(globalStorageDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return withFileLock(dir, BUNDLE_LOCK_FILE, async (): Promise<PolicyEditResult> => {
    let marker: LastValid;
    try {
      marker = await readLastValid(secrets);
    } catch (error) {
      throw new BundleStoreError('Nothing was changed: SovAI could not read its record of your policy in this computer\'s secret storage.', { cause: error });
    }
    const disk = await verifyDisk(globalStorageDir, secrets, nowMs, marker);
    const stored = disk.state;
    if (stored.state !== 'valid') throw new BundleStoreError(`Nothing was changed: your policy cannot be trusted right now, so it cannot be edited. ${stored.sentence}`);
    if (stored.hash !== input.baseHash) throw new BundleStoreError(`Nothing was changed. ${STALE_DRAFT_TEXT}`);
    let identity: DeviceIdentity;
    try {
      identity = await identityFor(globalStorageDir, secrets, options);
    } catch (error) {
      throw new BundleStoreError('Nothing was changed: SovAI could not use its signing key on this computer.', { cause: error });
    }
    const effective = effectiveNow(nowMs, lastValidAtOf(marker));
    const next = parsePolicyDraft(draftText, {
      issuer: { fingerprint: identity.fingerprint, publicKey: identity.publicKey },
      issuedAt: new Date(effective).toISOString(),
      expiresAt: new Date(effective + SELF_SIGNED_LIFETIME_DAYS * DAY_MS).toISOString()
    });
    if (input.organization !== undefined) {
      const base = parsePolicyDocument(disk.stored);
      if (!base.ok) throw new BundleStoreError(`Nothing was changed: your policy cannot be trusted right now, so it cannot be edited. ${BUNDLE_FAILURES.malformed}`);
      const wider = wideningOf(input.organization.document, base.value, next);
      if (wider !== undefined) throw new BundleStoreError(`Nothing was changed. ${widerThanOrganizationText(wider)}`);
    }
    const written = await install(globalStorageDir, secrets, sign(identity, personalLayerPayload(next, input.organization), new Date(effective)), nowMs, marker);
    const state = written.state;
    if (state.state !== 'valid') throw new BundleStoreError(`Nothing was changed: the new policy did not verify. ${state.sentence}`);
    const kept = await remember(secrets, state, effective);
    if (kept.state !== 'valid') return { state: kept, oldHash: stored.hash, newHash: state.hash };
    return { state: kept, event: 'policy.edit', oldHash: stored.hash, newHash: state.hash, stored: written.stored };
  });
}
