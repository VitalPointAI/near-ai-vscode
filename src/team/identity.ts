// Ed25519 device identity for Team Mode (D-14). The private key lives only in SecretStorage and, while in use, in a closure-held KeyObject.
// This module never imports vscode: SecretStorage is reached through the type-only SecretStorageLike interface.
//
// Rotating or revoking the person's own key (D-09, D-21, TMR-05) is done here as signed records in the person's key history, and nothing more: a rotation
// through these helpers is local only. The new key is bound in no team roster and this phase signs no device.rotated event for it, because no caller ships
// yet (the later Replace my device flow signs one per team with the kept previous key, using the signed-event type from plan 09). Until that event is in a
// team's log, the person's session in that team is read-only, because the new key is not bound there. Teams on main hold only their owner (D-13), so revoking
// the kept previous key before then leaves no key able to sign that event, and the team stays read-only. Rotation does not stop a copied key; only revoking it does.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretStorageLike } from '../services/auth';
import { withFileLock } from '../services/stateMirrorLock';
import { MAX_EVENT_BYTES, canonicalBytes, fingerprintOf, signingInput } from '../domain/team/canonical';
import type { DeviceRef, TeamEvent, TeamEventType, UnsignedTeamEvent } from '../domain/team/types';
import { appendKeyRecord, archiveKeyHistory, readKeyHistory } from './keyHistory';
import type { AppendKeyRecordOptions } from './keyHistory';
import type { KeyHistoryReplay } from '../domain/team/keyRecords';

// One Ed25519 identity per person per install (D-06). Every team this install joins uses this key, so the secret name carries no team id.
export const DEVICE_KEY_SECRET = 'nearAi.identity.deviceKey';
// A rotation keeps the new key aside under the pending name until it is recorded, and keeps the replaced key under the previous name so the team flows
// that come later can still sign with it. Both hold the same kind of private key as the device key and live only in SecretStorage (D-07).
export const PENDING_DEVICE_KEY_SECRET = 'nearAi.identity.pendingDeviceKey';
export const PREVIOUS_DEVICE_KEY_SECRET = 'nearAi.identity.previousDeviceKey';
export const IDENTITY_DIR_NAME = 'identity';
export const IDENTITY_CREATE_LOCK_FILE = 'identity-create.lock';

export function identityDir(globalStorageDir: string): string {
  return path.join(globalStorageDir, IDENTITY_DIR_NAME);
}

// Structurally a payload signer: a later plan signs payloads other than team events with the same identity.
export interface DeviceIdentity {
  readonly fingerprint: string;
  readonly publicKey: string;
  sign(bytes: Buffer): string;
}

function publicKeyRawOf(privateKey: KeyObject): Buffer {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('The device key has no public half.');
  return Buffer.from(jwk.x, 'base64url');
}

function identityFrom(privateKey: KeyObject): DeviceIdentity {
  const raw = publicKeyRawOf(privateKey);
  const fingerprint = fingerprintOf(raw);
  const publicKey = raw.toString('base64url');
  return {
    fingerprint,
    publicKey,
    sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url')
  };
}

export async function createDeviceIdentity(secrets: SecretStorageLike): Promise<DeviceIdentity> {
  if (await secrets.get(DEVICE_KEY_SECRET)) throw new Error('This computer already has an identity key. Remove the old key before creating a new one.');
  const { privateKey } = generateKeyPairSync('ed25519');
  const stored = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  await secrets.store(DEVICE_KEY_SECRET, stored);
  return identityFrom(privateKey);
}

async function loadStoredKey(secrets: SecretStorageLike, name: string, what: string): Promise<DeviceIdentity | undefined> {
  const stored = await secrets.get(name);
  if (!stored) return undefined;
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: Buffer.from(stored, 'base64'), format: 'der', type: 'pkcs8' });
  } catch (error) {
    throw new Error(`The stored ${what} could not be read.`, { cause: error });
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`The stored ${what} is not an Ed25519 key.`);
  return identityFrom(privateKey);
}

export async function loadDeviceIdentity(secrets: SecretStorageLike): Promise<DeviceIdentity | undefined> {
  return loadStoredKey(secrets, DEVICE_KEY_SECRET, 'team device key');
}

export async function forgetDeviceIdentity(secrets: SecretStorageLike): Promise<void> {
  await secrets.delete(DEVICE_KEY_SECRET);
}

export interface IdentityLockOptions {
  // The folder that holds identity-create.lock and the key history, normally identityDir(globalStorage).
  identityDir: string;
  // The clock for the key history records; tests pass a fixed one.
  now?: () => Date;
  // Where a plain warning from the key history goes (the Team Mode output channel). Never given key material.
  warn?: (message: string) => void;
}

// The options every key history append in this module passes on.
function historyOptions(options: IdentityLockOptions): AppendKeyRecordOptions {
  return { ...(options.now === undefined ? {} : { now: options.now }), ...(options.warn === undefined ? {} : { warn: options.warn }) };
}

// The key history (D-09) is the person's own signed record that this key is theirs. Called inside identity-create.lock with the key that is stored, it
// makes sure the history names that key as its active key: nothing to do when it already does, a first `created` record when the history is empty (a key
// stored before any history existed), and otherwise (the history is broken, or its active key is another one) the old history is archived, never
// deleted, and a fresh one starts with this key. Keys only the archived history knew then read as unknown, which fails closed (D-09).
// Lock order: identity-create.lock is held by the caller, key-history.lock is taken inside the history calls.
async function ensureCreatedRecord(
  secrets: SecretStorageLike, identity: DeviceIdentity, options: IdentityLockOptions, freshKey: boolean
): Promise<void> {
  const clock = options.now === undefined ? {} : { now: options.now };
  const history = await readKeyHistory(options.identityDir, secrets);
  if (history.ok && history.active?.fingerprint === identity.fingerprint) return;
  // 0.4.25 (PR #61 review): a key the trusted history shows as replaced or withdrawn is never given a fresh `created` record, which would make it active
  // again. repairKeyState sets such a key aside when it safely can; when it could not, this refuses rather than bringing the key back.
  if (history.ok) {
    const state = history.lookup({ fingerprint: identity.fingerprint, publicKey: identity.publicKey }).state;
    if (state === 'rotated' || state === 'revoked') {
      throw new Error('The identity key on this computer was replaced or withdrawn in your key history, so it is not used again. Forget the kept previous key, then try again.');
    }
  }
  // An empty history accepts a first key as it is, and so does one whose last key was revoked when the key is brand new. Anything else is set aside first,
  // including a key that is stored but that a history with records does not make active.
  if (!history.ok || history.active !== undefined || (!freshKey && history.head !== undefined)) await archiveKeyHistory(options.identityDir, secrets, clock);
  await appendKeyRecord(
    options.identityDir, secrets, identity, { kind: 'created', key: { fingerprint: identity.fingerprint, publicKey: identity.publicKey } }, historyOptions(options)
  );
}

async function readStoredKeySafely(secrets: SecretStorageLike, name: string): Promise<DeviceIdentity | undefined> {
  try {
    const what = name === PENDING_DEVICE_KEY_SECRET ? 'pending team device key' : name === PREVIOUS_DEVICE_KEY_SECRET ? 'previous team device key' : 'team device key';
    return await loadStoredKey(secrets, name, what);
  } catch {
    return undefined;
  }
}

// Called inside identity-create.lock before a key is used (first need, revoking). Two things a crash can leave behind are put right when the key history
// can be trusted: a rotation whose record was written but whose key moves were not finished is finished, and a stored key (current, pending or previous)
// that the history already shows as revoked is deleted, so a revoked key is never left stored and never made active again by the backfill (D-09, D-21).
async function repairKeyState(secrets: SecretStorageLike, options: IdentityLockOptions): Promise<void> {
  const history = await readKeyHistory(options.identityDir, secrets);
  if (!history.ok) return;
  const pending = await readStoredKeySafely(secrets, PENDING_DEVICE_KEY_SECRET);
  if (pending && history.active?.fingerprint === pending.fingerprint) await finishRotationMoves(secrets);
  for (const name of [DEVICE_KEY_SECRET, PENDING_DEVICE_KEY_SECRET, PREVIOUS_DEVICE_KEY_SECRET]) {
    const key = await readStoredKeySafely(secrets, name);
    if (key && history.lookup({ fingerprint: key.fingerprint, publicKey: key.publicKey }).state === 'revoked') await secrets.delete(name);
  }
  await setAsideReplacedKey(secrets, history);
}

// 0.4.25 (PR #61 review): a rotation whose record was written but whose new key was lost (a crash before the key moves, then the pending entry gone)
// leaves the replaced key as the device key, and no key on this computer is the history's active key, so the history can never be extended again.
// The replaced key is moved to the previous slot, as a finished rotation would have kept it, and the device slot is emptied; the next first need then
// makes a fresh key, and ensureCreatedRecord archives the old history (never deletes it) before the fresh key's `created` record. The replaced key is
// never made active again. When the previous slot already holds another key (an earlier rotation's), nothing is moved, because that key would be
// dropped silently; ensureCreatedRecord then refuses the replaced key instead.
async function setAsideReplacedKey(secrets: SecretStorageLike, history: KeyHistoryReplay): Promise<void> {
  if (!history.ok || history.active === undefined) return;
  const current = await readStoredKeySafely(secrets, DEVICE_KEY_SECRET);
  if (!current || history.lookup({ fingerprint: current.fingerprint, publicKey: current.publicKey }).state !== 'rotated') return;
  for (const name of [PENDING_DEVICE_KEY_SECRET, PREVIOUS_DEVICE_KEY_SECRET]) {
    if ((await readStoredKeySafely(secrets, name))?.fingerprint === history.active.fingerprint) return;
  }
  const currentText = await secrets.get(DEVICE_KEY_SECRET);
  const kept = await secrets.get(PREVIOUS_DEVICE_KEY_SECRET);
  if (!present(currentText) || (present(kept) && kept !== currentText)) return;
  if (kept !== currentText) await secrets.store(PREVIOUS_DEVICE_KEY_SECRET, currentText);
  await secrets.delete(DEVICE_KEY_SECRET);
}

// First-need creation (Pitfall 4): SecretStorage is last write wins, so two windows could each create a key. The lock covers check, create, store,
// read back and the key's `created` history record, so two windows end with one key and one record, and a fresh install can sign and verify its first
// payload with nothing else to set up (D-09). A key found without a history record (for example one made by an earlier release) gets its record here.
// The folder is created here with mode 0o700 (it holds the lock file and the public key history, never key material).
export async function loadOrCreateDeviceIdentity(
  secrets: SecretStorageLike, options: IdentityLockOptions
): Promise<{ identity: DeviceIdentity; created: boolean }> {
  await mkdir(options.identityDir, { recursive: true, mode: 0o700 });
  return withFileLock(options.identityDir, IDENTITY_CREATE_LOCK_FILE, async () => {
    await repairKeyState(secrets, options);
    const existing = await loadDeviceIdentity(secrets);
    if (existing) {
      await ensureCreatedRecord(secrets, existing, options, false);
      return { identity: existing, created: false };
    }
    const made = await createDeviceIdentity(secrets);
    const readBack = await loadDeviceIdentity(secrets);
    if (!readBack || readBack.fingerprint !== made.fingerprint) {
      throw new Error('The new identity key could not be read back from this computer\'s secret storage, so it was not used.');
    }
    try {
      await ensureCreatedRecord(secrets, readBack, options, true);
    } catch (error) {
      // This call made the key and it has signed nothing but this attempt, so it is forgotten rather than left without a history record.
      await forgetDeviceIdentity(secrets).catch(() => undefined);
      throw error;
    }
    return { identity: readBack, created: true };
  });
}

// Used by a failed Enable that created the key: it forgets that key only while it is still the stored one AND the key history holds nothing but that key's
// own `created` record (D-22, D-09). It first appends a `revoked` record signed by the key, so the history stays a valid chain that ends with the key
// withdrawn, and then deletes the key. A key that another window stored in the meantime, one that existed before, or one that has any other history
// record (or a history that cannot be trusted) is never deleted: the call returns false.
export async function forgetCreatedDeviceIdentity(
  secrets: SecretStorageLike, options: IdentityLockOptions & { fingerprint: string }
): Promise<boolean> {
  await mkdir(options.identityDir, { recursive: true, mode: 0o700 });
  return withFileLock(options.identityDir, IDENTITY_CREATE_LOCK_FILE, async () => {
    const stored = await loadDeviceIdentity(secrets);
    if (!stored || stored.fingerprint !== options.fingerprint) return false;
    const history = await readKeyHistory(options.identityDir, secrets);
    // One record whose key is the active one can only be that key's own `created` record.
    if (!history.ok || history.active?.fingerprint !== stored.fingerprint || history.head?.seq !== 1) return false;
    await appendKeyRecord(
      options.identityDir, secrets, stored, { kind: 'revoked', key: { fingerprint: stored.fingerprint, publicKey: stored.publicKey } },
      historyOptions(options)
    );
    await forgetDeviceIdentity(secrets);
    return true;
  });
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

// The key moves of a rotation, safe to repeat: the replaced key is stored as the previous key, the pending key becomes the device key, and the pending
// entry goes. Each step checks what is already there, so a crash after any step is finished by running this again. Called only once the key history
// already names the pending key as active. Whatever the previous entry holds when it differs from the key being replaced is an earlier rotation's key,
// which is never dropped silently.
async function finishRotationMoves(secrets: SecretStorageLike): Promise<void> {
  const pending = await secrets.get(PENDING_DEVICE_KEY_SECRET);
  if (!present(pending)) return;
  const current = await secrets.get(DEVICE_KEY_SECRET);
  if (present(current) && current !== pending) {
    const kept = await secrets.get(PREVIOUS_DEVICE_KEY_SECRET);
    if (present(kept) && kept !== current) {
      throw new Error('A key from an earlier rotation is still kept, so this rotation cannot be finished. Forget the kept previous key first.');
    }
    if (kept !== current) await secrets.store(PREVIOUS_DEVICE_KEY_SECRET, current);
  }
  if (current !== pending) await secrets.store(DEVICE_KEY_SECRET, pending);
  await secrets.delete(PENDING_DEVICE_KEY_SECRET);
}

export async function loadPreviousDeviceIdentity(secrets: SecretStorageLike): Promise<DeviceIdentity | undefined> {
  return loadStoredKey(secrets, PREVIOUS_DEVICE_KEY_SECRET, 'previous team device key');
}

export async function forgetPreviousDeviceIdentity(secrets: SecretStorageLike): Promise<void> {
  await secrets.delete(PREVIOUS_DEVICE_KEY_SECRET);
}

// Step one of rotating the person's own key (D-09): a new key is made and kept aside under the pending name, and nothing else changes, so the person
// keeps signing with the current key and a crash here loses nothing. Refused, with nothing changed, when there is no current key, a rotation is already
// prepared, or a previous key from an earlier rotation is still kept (it would be dropped silently by the next commit). The current key gets its history
// record first if it has none, as at first need. Rotating does not stop a copy of the old key from signing; only revoking it does.
export async function prepareDeviceRotation(
  secrets: SecretStorageLike, options: IdentityLockOptions
): Promise<{ current: DeviceIdentity; next: DeviceIdentity }> {
  await mkdir(options.identityDir, { recursive: true, mode: 0o700 });
  return withFileLock(options.identityDir, IDENTITY_CREATE_LOCK_FILE, async () => {
    // Every path that can write a created record repairs first (first need, revoking, here), so a revoked key a crash left stored is deleted and never
    // made active again by the backfill below.
    await repairKeyState(secrets, options);
    const current = await loadDeviceIdentity(secrets);
    if (!current) throw new Error('This computer has no identity key to rotate yet.');
    if (present(await secrets.get(PENDING_DEVICE_KEY_SECRET))) {
      throw new Error('A key rotation is already prepared. Finish it before preparing another.');
    }
    if (present(await secrets.get(PREVIOUS_DEVICE_KEY_SECRET))) {
      throw new Error('The key from an earlier rotation is still kept. Forget it before rotating again, so it is not dropped by mistake.');
    }
    await ensureCreatedRecord(secrets, current, options, false);
    const { privateKey } = generateKeyPairSync('ed25519');
    await secrets.store(PENDING_DEVICE_KEY_SECRET, privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
    const readBack = await loadStoredKey(secrets, PENDING_DEVICE_KEY_SECRET, 'pending team device key');
    if (!readBack || readBack.fingerprint !== identityFrom(privateKey).fingerprint) {
      try { await secrets.delete(PENDING_DEVICE_KEY_SECRET); } catch { /* the failure below is the one to report */ }
      throw new Error('The new identity key could not be read back from this computer\'s secret storage, so it was not used.');
    }
    return { current, next: readBack };
  });
}

// Step two (D-09): records the rotation in the person's key history, signed by the current key, then swaps the keys: the current key becomes the previous
// key (kept so a team's device.rotated event can later be signed with it), the pending key becomes the device key and the pending entry is deleted. When
// the history already names the pending key as active (a crash after the record was written) only the key moves are finished, and no second record is
// written. A failure before the record leaves the current key active and the pending key in place, so the same call can be repeated.
// This rotation is local only. The new key is in no team roster until a device.rotated event signed with the kept previous key is in that team's log.
export async function commitDeviceRotation(
  secrets: SecretStorageLike, options: IdentityLockOptions
): Promise<{ previous: DeviceIdentity; current: DeviceIdentity }> {
  await mkdir(options.identityDir, { recursive: true, mode: 0o700 });
  return withFileLock(options.identityDir, IDENTITY_CREATE_LOCK_FILE, async () => {
    const pending = await loadStoredKey(secrets, PENDING_DEVICE_KEY_SECRET, 'pending team device key');
    if (!pending) throw new Error('No key rotation is prepared, so there is nothing to finish.');
    const history = await readKeyHistory(options.identityDir, secrets);
    if (!history.ok) throw new Error(`The key was not rotated: ${history.reason}`);
    if (history.active?.fingerprint !== pending.fingerprint) {
      const current = await loadDeviceIdentity(secrets);
      if (!current || history.active?.fingerprint !== current.fingerprint) {
        throw new Error('The key was not rotated: the key history does not name the key this computer holds as its active key.');
      }
      await appendKeyRecord(
        options.identityDir, secrets, current,
        { kind: 'rotated', key: { fingerprint: current.fingerprint, publicKey: current.publicKey }, next: { fingerprint: pending.fingerprint, publicKey: pending.publicKey } },
        historyOptions(options)
      );
    }
    await finishRotationMoves(secrets);
    const [previous, current] = await Promise.all([loadPreviousDeviceIdentity(secrets), loadDeviceIdentity(secrets)]);
    if (!previous || !current || current.fingerprint !== pending.fingerprint) {
      throw new Error('The key rotation was recorded but the keys on this computer could not be read back. Run it again to finish.');
    }
    return { previous, current };
  });
}

// Withdraws one of the person's own keys for good (D-09, D-21): a revoked record is written to the key history and the key's private half is deleted from
// SecretStorage in the same locked step, so a revoked key is never left stored (and if a crash separates the two, the next first need deletes it, see
// repairKeyState). A payload signed by a revoked key is refused whatever time it claims. The record is signed by the key itself when it is the stored
// current key, otherwise by the active key, otherwise by the key itself if its private half is still here. Revoking the current key makes the next first need
// create a fresh key with its own created record; a rotation that was only prepared is cancelled with it, since that key was never recorded anywhere.
// Refused with a plain message, changing nothing, for a key the history does not know or one already revoked. No command ships for this yet.
export async function revokeDeviceKey(secrets: SecretStorageLike, options: IdentityLockOptions & { key: DeviceRef }): Promise<void> {
  await mkdir(options.identityDir, { recursive: true, mode: 0o700 });
  await withFileLock(options.identityDir, IDENTITY_CREATE_LOCK_FILE, async () => {
    await repairKeyState(secrets, options);
    const history = await readKeyHistory(options.identityDir, secrets);
    if (!history.ok) throw new Error(`The key was not revoked: ${history.reason}`);
    const target = { fingerprint: options.key.fingerprint, publicKey: options.key.publicKey };
    const state = history.lookup(target).state;
    if (state === 'unknown') throw new Error('The key was not revoked: your key history does not know that key.');
    if (state === 'revoked') throw new Error('The key was not revoked: it is already revoked.');
    const names = [DEVICE_KEY_SECRET, PENDING_DEVICE_KEY_SECRET, PREVIOUS_DEVICE_KEY_SECRET] as const;
    const stored = new Map<string, DeviceIdentity>();
    for (const name of names) {
      const key = await readStoredKeySafely(secrets, name);
      if (key) stored.set(name, key);
    }
    const matches = (key: DeviceIdentity | undefined): key is DeviceIdentity => key !== undefined && key.fingerprint === target.fingerprint && key.publicKey === target.publicKey;
    const current = stored.get(DEVICE_KEY_SECRET);
    const activeStored = [...stored.values()].find((key) => key.fingerprint === history.active?.fingerprint);
    const signer = (matches(current) ? current : undefined) ?? activeStored ?? [...stored.values()].find(matches);
    if (!signer) throw new Error('The key was not revoked: no key on this computer can sign the revocation.');
    await appendKeyRecord(options.identityDir, secrets, signer, { kind: 'revoked', key: target }, historyOptions(options));
    for (const name of names) if (matches(stored.get(name))) await secrets.delete(name);
    // A prepared rotation that was never recorded is dropped with the current key it was meant to replace.
    if (matches(current)) await secrets.delete(PENDING_DEVICE_KEY_SECRET);
  });
}

export function signEvent<T extends TeamEventType>(identity: DeviceIdentity, unsigned: UnsignedTeamEvent<T>): TeamEvent<T> {
  if (unsigned.device !== identity.fingerprint) throw new Error('The event names a different device than the one signing it.');
  const sig = identity.sign(signingInput(unsigned));
  const signed: TeamEvent<T> = { ...unsigned, sig };
  const size = canonicalBytes(signed).length;
  if (size > MAX_EVENT_BYTES) throw new Error(`The event is ${size} bytes, which is over the ${MAX_EVENT_BYTES} byte limit.`);
  return signed;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// 26 character ULID. The time prefix only helps uniqueness and sorting by eye; it is never used to order events.
export function ulid(now: number = Date.now()): string {
  let remaining = now;
  let time = '';
  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD.charAt(remaining % 32) + time;
    remaining = Math.floor(remaining / 32);
  }
  let bits = 0n;
  for (const byte of randomBytes(10)) bits = (bits << 8n) | BigInt(byte);
  let random = '';
  for (let index = 0; index < 16; index += 1) {
    random = CROCKFORD.charAt(Number(bits & 31n)) + random;
    bits >>= 5n;
  }
  return time + random;
}

export function newEventId(): string {
  return `evt-${ulid()}`;
}

export function newMemberId(): string {
  return `mbr-${randomBytes(8).toString('hex')}`;
}

export function newTeamId(): string {
  return `team-${randomBytes(16).toString('hex')}`;
}

