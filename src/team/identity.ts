// Ed25519 device identity for Team Mode (D-14). The private key lives only in SecretStorage and, while in use, in a closure-held KeyObject.
// This module never imports vscode: SecretStorage is reached through the type-only SecretStorageLike interface.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretStorageLike } from '../services/auth';
import { withFileLock } from '../services/stateMirrorLock';
import { MAX_EVENT_BYTES, canonicalBytes, fingerprintOf, signingInput } from '../domain/team/canonical';
import type { TeamEvent, TeamEventType, UnsignedTeamEvent } from '../domain/team/types';
import { appendKeyRecord, archiveKeyHistory, readKeyHistory } from './keyHistory';

// One Ed25519 identity per person per install (D-06). Every team this install joins uses this key, so the secret name carries no team id.
export const DEVICE_KEY_SECRET = 'nearAi.identity.deviceKey';
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

export async function loadDeviceIdentity(secrets: SecretStorageLike): Promise<DeviceIdentity | undefined> {
  const stored = await secrets.get(DEVICE_KEY_SECRET);
  if (!stored) return undefined;
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: Buffer.from(stored, 'base64'), format: 'der', type: 'pkcs8' });
  } catch (error) {
    throw new Error('The stored team device key could not be read.', { cause: error });
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The stored team device key is not an Ed25519 key.');
  return identityFrom(privateKey);
}

export async function forgetDeviceIdentity(secrets: SecretStorageLike): Promise<void> {
  await secrets.delete(DEVICE_KEY_SECRET);
}

export interface IdentityLockOptions {
  // The folder that holds identity-create.lock and the key history, normally identityDir(globalStorage).
  identityDir: string;
  // The clock for the key history records; tests pass a fixed one.
  now?: () => Date;
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
  // An empty history accepts a first key as it is, and so does one whose last key was revoked when the key is brand new. Anything else is set aside first,
  // including a key that is stored but that a history with records does not make active.
  if (!history.ok || history.active !== undefined || (!freshKey && history.head !== undefined)) await archiveKeyHistory(options.identityDir, secrets, clock);
  await appendKeyRecord(
    options.identityDir, secrets, identity, { kind: 'created', key: { fingerprint: identity.fingerprint, publicKey: identity.publicKey } }, clock
  );
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

// Used by a failed Enable that created the key: it forgets that key only while it is still the stored one. A key that another window stored in the
// meantime, or one that existed before, is never deleted.
export async function forgetCreatedDeviceIdentity(
  secrets: SecretStorageLike, options: IdentityLockOptions & { fingerprint: string }
): Promise<boolean> {
  await mkdir(options.identityDir, { recursive: true, mode: 0o700 });
  return withFileLock(options.identityDir, IDENTITY_CREATE_LOCK_FILE, async () => {
    const stored = await loadDeviceIdentity(secrets);
    if (!stored || stored.fingerprint !== options.fingerprint) return false;
    await forgetDeviceIdentity(secrets);
    return true;
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

