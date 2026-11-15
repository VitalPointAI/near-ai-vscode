// Ed25519 device identity for Team Mode (D-14). The private key lives only in SecretStorage and, while in use, in a closure-held KeyObject.
// This module never imports vscode: SecretStorage is reached through the type-only SecretStorageLike interface.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretStorageLike } from '../services/auth';
import { withFileLock } from '../services/stateMirrorLock';
import { MAX_EVENT_BYTES, canonicalBytes, fingerprintOf, signingInput } from '../domain/team/canonical';
import type { TeamEvent, TeamEventType, UnsignedTeamEvent } from '../domain/team/types';

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
  // The folder that holds identity-create.lock, normally identityDir(globalStorage).
  identityDir: string;
}

// First-need creation (Pitfall 4): SecretStorage is last write wins, so two windows could each create a key. The lock covers check, create, store and
// read back, so two windows end with one key. The folder is created here with mode 0o700 (it only holds the lock file, never key material).
export async function loadOrCreateDeviceIdentity(
  secrets: SecretStorageLike, options: IdentityLockOptions
): Promise<{ identity: DeviceIdentity; created: boolean }> {
  await mkdir(options.identityDir, { recursive: true, mode: 0o700 });
  return withFileLock(options.identityDir, IDENTITY_CREATE_LOCK_FILE, async () => {
    const existing = await loadDeviceIdentity(secrets);
    if (existing) return { identity: existing, created: false };
    const made = await createDeviceIdentity(secrets);
    const readBack = await loadDeviceIdentity(secrets);
    if (!readBack || readBack.fingerprint !== made.fingerprint) {
      throw new Error('The new identity key could not be read back from this computer\'s secret storage, so it was not used.');
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

// Members carry salted hashes of their emails, never the addresses themselves (D-31).
export function emailHash(teamId: string, email: string): string {
  return createHash('sha256').update(`${teamId}:${email.trim().toLowerCase()}`).digest('hex');
}
