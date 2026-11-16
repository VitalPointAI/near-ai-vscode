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
import { SELF_SIGNED_LIFETIME_DAYS, defaultBundlePayload, effectiveNow, failedClosed, verifyBundleEnvelope } from '../domain/gate/bundle';
import type { BundleState, PolicyBundle } from '../domain/gate/bundle';
import { MAX_PAYLOAD_BYTES, PayloadError, signPayload } from '../domain/team/signedPayload';
import type { SignedPayload } from '../domain/team/signedPayload';
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

/** What happened to the file during a call, for the caller to record. Absent when nothing was written. */
export type BundleEvent = 'policy.created' | 'policy.renewed' | 'policy.reset';

export interface BundleResult {
  readonly state: BundleState;
  readonly event?: BundleEvent;
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
}

// Reads the file and verifies it. Every cause the person can fix is its own reason; nothing is guessed and nothing is written.
async function verifyDisk(globalStorageDir: string, secrets: SecretStorageLike, nowMs: number, marker: LastValid): Promise<Disk> {
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
  const status = await localKeyStatus(identityDir(globalStorageDir), secrets);
  const lastValidAt = marker.present ? marker.at : undefined;
  const state = verifyBundleEnvelope(envelope, { status, now: nowMs, ...(lastValidAt === undefined ? {} : { lastValidAt }) });
  // A file that verifies but is not the one this install last accepted (or is writing right now) was put there from outside: refused, never adopted.
  if (state.state === 'valid' && marker.present && marker.hash !== undefined && state.hash !== marker.hash && state.hash !== marker.pending) {
    return { state: failedClosed('replaced'), envelope };
  }
  return { state, envelope };
}

function lastValidAtOf(marker: LastValid): number | undefined {
  return marker.present ? marker.at : undefined;
}

function sign(identity: DeviceIdentity, payload: PolicyBundle, at: Date): SignedPayload<PolicyBundle> {
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
async function install(globalStorageDir: string, secrets: SecretStorageLike, envelope: SignedPayload<PolicyBundle>, nowMs: number, marker: LastValid): Promise<BundleState> {
  const lastValidAt = lastValidAtOf(marker);
  const status = await localKeyStatus(identityDir(globalStorageDir), secrets);
  const before = verifyBundleEnvelope(envelope, { status, now: nowMs, ...(lastValidAt === undefined ? {} : { lastValidAt }) });
  if (before.state !== 'valid') throw new BundleStoreError(`Nothing was written: the new policy did not verify. ${before.sentence}`);
  const file = bundleFile(globalStorageDir);
  const previous = await readFile(file, 'utf8').catch(() => undefined);
  // The marker names the hash about to be written first, so a crash between the file and the marker leaves a file the next start still accepts.
  try {
    await announceNextHash(secrets, before.hash);
  } catch (error) {
    await withdrawNextHash(secrets).catch(() => undefined);
    throw new BundleStoreError('Nothing was written: NEAR AI could not update its record of your policy in this computer\'s secret storage.', { cause: error });
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
  return after.state;
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
  const state = await install(globalStorageDir, secrets, sign(identity, payload, new Date(effective)), nowMs, marker);
  if (state.state !== 'valid') return { state };
  const kept = await remember(secrets, state, effective);
  return kept.state === 'valid' ? { state: kept, event } : { state: kept };
}

// Re-signs the same payload with fresh dates when this install's own key signed it. Any failure leaves the file as it was and the caller on the valid
// state it already has: a renewal that did not happen is not a reason to fail closed.
async function tryRenew(
  globalStorageDir: string, secrets: SecretStorageLike, current: BundleState & { state: 'valid' }, nowMs: number, marker: LastValid
): Promise<BundleState | undefined> {
  try {
    // Only this install's own key, and only the policy this install last accepted: a bundle that merely verifies is never carried forward.
    if (!marker.present || marker.hash === undefined || marker.hash !== current.hash) return undefined;
    const identity = await loadDeviceIdentity(secrets);
    if (identity === undefined || identity.fingerprint !== current.signer.fingerprint || identity.publicKey !== current.signer.publicKey) return undefined;
    const effective = effectiveNow(nowMs, lastValidAtOf(marker));
    const payload: PolicyBundle = {
      ...current.bundle,
      issuedAt: new Date(effective).toISOString(),
      expiresAt: new Date(effective + SELF_SIGNED_LIFETIME_DAYS * DAY_MS).toISOString()
    };
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
      let event: BundleEvent | undefined;
      if (state.renewDue) {
        const renewed = await tryRenew(globalStorageDir, secrets, state, nowMs, marker);
        if (renewed !== undefined && renewed.state === 'valid') {
          current = renewed;
          event = 'policy.renewed';
        }
      }
      const kept = await remember(secrets, current, effectiveNow(nowMs, lastValidAtOf(marker)));
      return kept.state === 'valid' && event !== undefined ? { state: kept, event } : { state: kept };
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
 * The person's own command (NEAR AI: Reset Policy to Defaults): signs a fresh default bundle and keeps the old file beside it as
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
      throw new BundleStoreError('Nothing was changed: NEAR AI could not use its signing key on this computer, so the policy was not reset.', { cause: error });
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
    let state: BundleState;
    try {
      state = await install(globalStorageDir, secrets, envelope, nowMs, marker);
    } catch (error) {
      // The old file goes back where it was, so a reset that failed leaves the policy as it was. Install has withdrawn the pending hash on every failure after
      // naming it; this is the same withdrawal again, for the case where it could not (the secret store failing twice), and it is harmless when there is none.
      if (aside !== undefined) await rename(aside, file).catch(() => undefined);
      await withdrawNextHash(secrets).catch(() => undefined);
      throw error;
    }
    if (state.state !== 'valid') return { state };
    const kept = await remember(secrets, state, effective);
    return kept.state === 'valid' ? { state: kept, event: 'policy.reset' } : { state: kept };
  });
}
