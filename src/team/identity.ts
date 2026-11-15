// Ed25519 device identity for Team Mode (D-14). The private key lives only in SecretStorage and, while in use, in a closure-held KeyObject.
// This module never imports vscode: SecretStorage is reached through the type-only SecretStorageLike interface.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { SecretStorageLike } from '../services/auth';
import { MAX_EVENT_BYTES, canonicalBytes, fingerprintOf, signingInput } from '../domain/team/canonical';
import type { TeamEvent, TeamEventType, UnsignedTeamEvent } from '../domain/team/types';

export const DEVICE_KEY_SECRET_PREFIX = 'nearAi.team.deviceKey.';

export function deviceKeySecretName(teamId: string): string {
  return `${DEVICE_KEY_SECRET_PREFIX}${teamId}`;
}

export interface DeviceIdentity {
  readonly teamId: string;
  readonly fingerprint: string;
  readonly publicKey: string;
  sign(bytes: Buffer): string;
}

function publicKeyRawOf(privateKey: KeyObject): Buffer {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('The team device key has no public half.');
  return Buffer.from(jwk.x, 'base64url');
}

function identityFrom(teamId: string, privateKey: KeyObject): DeviceIdentity {
  const raw = publicKeyRawOf(privateKey);
  const fingerprint = fingerprintOf(raw);
  const publicKey = raw.toString('base64url');
  return {
    teamId,
    fingerprint,
    publicKey,
    sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url')
  };
}

export async function createDeviceIdentity(secrets: SecretStorageLike, teamId: string): Promise<DeviceIdentity> {
  const name = deviceKeySecretName(teamId);
  if (await secrets.get(name)) throw new Error('This device already has a key for this team. Remove the old key before creating a new one.');
  const { privateKey } = generateKeyPairSync('ed25519');
  const stored = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  await secrets.store(name, stored);
  return identityFrom(teamId, privateKey);
}

export async function loadDeviceIdentity(secrets: SecretStorageLike, teamId: string): Promise<DeviceIdentity | undefined> {
  const stored = await secrets.get(deviceKeySecretName(teamId));
  if (!stored) return undefined;
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: Buffer.from(stored, 'base64'), format: 'der', type: 'pkcs8' });
  } catch (error) {
    throw new Error('The stored team device key could not be read.', { cause: error });
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The stored team device key is not an Ed25519 key.');
  return identityFrom(teamId, privateKey);
}

export async function forgetDeviceIdentity(secrets: SecretStorageLike, teamId: string): Promise<void> {
  await secrets.delete(deviceKeySecretName(teamId));
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
