// This device's keys for multi-user staff projects (D-14, D-19, D-24): the X25519 encryption key that cell grants are wrapped to, the ring of cell
// epoch keys opened from those grants, and the join secrets of open invitations. Node only; never imports vscode (SecretStorage is reached through
// SecretStorageLike).
//
// Where each secret lives, and nowhere else:
// - The X25519 private key: one per person per install, in SecretStorage under ENCRYPTION_KEY_SECRET beside the Ed25519 device key
//   (DEVICE_KEY_SECRET), stored the same way (PKCS8 DER as base64). It is made inside the same identity-create lock as the device key, with the same
//   read-back check, so two windows never make two keys. Its public half is bound to the device by an Ed25519 signature over x25519BindingBytes,
//   which the roster entry that admits the device carries (D-19).
// - Opened epoch keys: in memory, written through to one SecretStorage value per project (EPOCH_KEY_SECRET_PREFIX + project). That value is only a
//   cache: the grants on disk are ciphertext wrapped to this device, so a lost value is rebuilt by opening them again (D-24).
// - Join secrets: in SecretStorage keyed by invite id (JOIN_SECRET_PREFIX + invite) until a roster entry records what happened to the invitation
//   (used or voided). forgetJoinSecret is the only SecretStorage delete in this module (Pitfall 7): keys are only ever added (P-31-24).
//
// Nothing here writes a private key, an opened epoch key or a join secret to the project folder, a log, an error message or any file (P-31-23).
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { SecretStorageLike } from '../../services/auth';
import { withFileLock } from '../../services/stateMirrorLock';
import { IDENTITY_CREATE_LOCK_FILE } from '../../team/identity';
import type { DeviceIdentity } from '../../team/identity';
import { EPOCH_KEY_BYTES, readGrant, unwrapEpochKey, x25519BindingBytes, x25519PublicRaw } from '../../domain/replica/cellKeys';
import { STREAM_ID_PATTERN, writerIdOf } from '../../domain/replica/entry';
import { SLUG_PATTERN } from '../../domain/replica/kindSchemas/shared';
import type { KeyRing } from '../../domain/replica/rosterView';
import { isRecord } from '../../domain/team/validate';

/** The SecretStorage name of this install's X25519 private key, beside nearAi.identity.deviceKey (D-19). */
export const ENCRYPTION_KEY_SECRET = 'nearAi.identity.encryptionKey';
/** The SecretStorage name prefix of the opened epoch keys of one project; the project id follows. */
export const EPOCH_KEY_SECRET_PREFIX = 'nearAi.staff.epochKeys.';
/** The SecretStorage name prefix of a join secret; the invite id follows. */
export const JOIN_SECRET_PREFIX = 'nearAi.staff.joinSecret.';

/** This install's encryption key: the raw public key as base64url, the private key object (never exported), and the device's binding signature. */
export interface DeviceEncryptionKey {
  readonly publicKey: string;
  readonly privateKey: KeyObject;
  readonly binding: string;
}

export interface EncryptionKeyOptions {
  /** The folder that holds identity-create.lock, normally identityDir(globalStorage). */
  identityDir: string;
  /** The device identity that binds the key (its writer id is in the bound bytes). */
  identity: DeviceIdentity;
}

function keyFromStored(stored: string): KeyObject {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: Buffer.from(stored, 'base64'), format: 'der', type: 'pkcs8' });
  } catch (error) {
    throw new Error('The stored encryption key could not be read.', { cause: error });
  }
  if (privateKey.asymmetricKeyType !== 'x25519') throw new Error('The stored encryption key is not an X25519 key.');
  return privateKey;
}

async function loadStoredEncryptionKey(secrets: SecretStorageLike): Promise<KeyObject | undefined> {
  const stored = await secrets.get(ENCRYPTION_KEY_SECRET);
  return stored ? keyFromStored(stored) : undefined;
}

/**
 * This install's X25519 key, made on first need (D-19). The check, the creation, the store and the read-back run inside identity-create.lock, the lock
 * loadOrCreateDeviceIdentity holds, so two windows end with one key. A stored value that cannot be read is refused with a plain error and never
 * replaced: a key is only ever added (P-31-24). The binding is the device's signature over x25519BindingBytes(public key, writer id).
 */
export async function loadOrCreateEncryptionKey(secrets: SecretStorageLike, options: EncryptionKeyOptions): Promise<DeviceEncryptionKey> {
  await mkdir(options.identityDir, { recursive: true, mode: 0o700 });
  const privateKey = await withFileLock(options.identityDir, IDENTITY_CREATE_LOCK_FILE, async () => {
    const existing = await loadStoredEncryptionKey(secrets);
    if (existing) return existing;
    const made = generateKeyPairSync('x25519').privateKey;
    const madePublic = x25519PublicRaw(made).toString('base64url');
    await secrets.store(ENCRYPTION_KEY_SECRET, made.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
    const readBack = await loadStoredEncryptionKey(secrets);
    if (!readBack || x25519PublicRaw(readBack).toString('base64url') !== madePublic) {
      throw new Error('The new encryption key could not be read back from this computer\'s secret storage, so it was not used.');
    }
    return readBack;
  });
  const publicKey = x25519PublicRaw(privateKey).toString('base64url');
  const binding = options.identity.sign(x25519BindingBytes(publicKey, writerIdOf(options.identity.publicKey)));
  return { publicKey, privateKey, binding };
}

// ---- the key ring (D-24) -------------------------------------------------------------------------------------------------------------------------

/** The device a key ring opens grants for: its writer id and its X25519 private key. */
export interface KeyRingDevice { writer: string; privateKey: KeyObject }

const ringId = (cell: string, epoch: number): string => `${cell}/${epoch}`;

function cachedKeys(text: string | undefined): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  if (!text) return keys;
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.keys)) return keys;
    for (const item of value.keys as unknown[]) {
      if (!Array.isArray(item) || item.length !== 3) continue;
      const [cell, epoch, key] = item as unknown[];
      if (typeof cell !== 'string' || !STREAM_ID_PATTERN.test(cell) || !Number.isSafeInteger(epoch) || (epoch as number) < 1 || typeof key !== 'string') continue;
      const bytes = Buffer.from(key, 'base64url');
      if (bytes.length === EPOCH_KEY_BYTES) keys.set(ringId(cell, epoch as number), bytes);
    }
  } catch {
    // A cache that does not read is the same as no cache: every key in it can be opened again from the grants.
  }
  return keys;
}

/**
 * The epoch keys this device holds for one project. Opened keys live in memory and are written through to one SecretStorage value per project, never
 * to a file. The cache can be lost without losing anything: openGrants opens the same keys again from the grants on disk.
 * A cell's stream id is its cell id, and the roster stream is the base cell (the project id), so keyRing() answers (stream, epoch) directly.
 */
export class DeviceKeyRing {
  private readonly keys: Map<string, Buffer>;
  private changes = 0;

  private constructor(private readonly secrets: SecretStorageLike, public readonly project: string, private readonly device: KeyRingDevice, keys: Map<string, Buffer>) {
    this.keys = keys;
  }

  /** The ring of a project for a device, starting from the SecretStorage cache (or empty when there is none or it does not read). */
  public static async load(secrets: SecretStorageLike, project: string, device: KeyRingDevice): Promise<DeviceKeyRing> {
    if (!STREAM_ID_PATTERN.test(project)) throw new Error('A project id is 32 lowercase hex characters.');
    return new DeviceKeyRing(secrets, project, device, cachedKeys(await secrets.get(EPOCH_KEY_SECRET_PREFIX + project)));
  }

  /** Counts every time a key was added, so a host can tell that the ring answers more than it did (and replace its fold context). */
  public get version(): number {
    return this.changes;
  }

  /** How many epoch keys the ring holds. */
  public get size(): number {
    return this.keys.size;
  }

  /**
   * Opens the wraps addressed to this device in the given grants and adds the keys it did not hold yet. A grant that does not read, a wrap for another
   * device and a wrap that does not open are skipped. Returns how many keys were added; the new keys are written through to SecretStorage.
   */
  public async openGrants(grants: readonly unknown[]): Promise<number> {
    let added = 0;
    for (const signed of grants) {
      const read = readGrant(signed);
      if (!read.ok) continue;
      const mine = read.grant.wraps.find((wrap) => wrap.writer === this.device.writer);
      if (mine === undefined) continue;
      const id = ringId(read.grant.cell, read.grant.epoch);
      if (this.keys.has(id)) continue;
      const opened = unwrapEpochKey({ cell: read.grant.cell, epoch: read.grant.epoch, writer: this.device.writer, privateKey: this.device.privateKey, wrap: mine.wrap });
      if (opened === undefined) continue;
      this.keys.set(id, opened);
      added += 1;
    }
    if (added > 0) {
      this.changes += 1;
      await this.persist();
    }
    return added;
  }

  /** Adds a key this device made itself (a new cell or a new epoch, before its grant is stored). An epoch already held keeps its key. */
  public async addOwn(cell: string, epoch: number, key: Buffer): Promise<void> {
    if (!STREAM_ID_PATTERN.test(cell) || !Number.isSafeInteger(epoch) || epoch < 1) throw new Error('A cell key needs a cell id and an epoch of 1 or more.');
    if (key.length !== EPOCH_KEY_BYTES) throw new Error('An epoch key must be 32 bytes.');
    const id = ringId(cell, epoch);
    if (this.keys.has(id)) return;
    this.keys.set(id, Buffer.from(key));
    this.changes += 1;
    await this.persist();
  }

  /** The epoch key of a cell, as a copy, or undefined when this device does not hold it. */
  public epochKey(cell: string, epoch: number): Buffer | undefined {
    const key = this.keys.get(ringId(cell, epoch));
    return key === undefined ? undefined : Buffer.from(key);
  }

  /** The KeyRing the fold reads. It answers from the live ring, so a key added later is answered by the same function. */
  public keyRing(): KeyRing {
    return (stream, epoch) => this.epochKey(stream, epoch);
  }

  /** Writes the ring through to SecretStorage, merged with what another window stored, so no window drops a key the other opened. */
  private async persist(): Promise<void> {
    const name = EPOCH_KEY_SECRET_PREFIX + this.project;
    const merged = cachedKeys(await this.secrets.get(name));
    for (const [id, key] of this.keys) merged.set(id, key);
    for (const [id, key] of merged) if (!this.keys.has(id)) this.keys.set(id, key);
    const keys = [...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, key]) => {
      const [cell, epoch] = id.split('/');
      return [cell, Number(epoch), key.toString('base64url')];
    });
    await this.secrets.store(name, JSON.stringify({ v: 1, keys }));
  }
}

// ---- join secrets (D-14) -------------------------------------------------------------------------------------------------------------------------

function joinSecretName(invite: string): string {
  if (!SLUG_PATTERN.test(invite)) throw new Error('An invitation id is lowercase letters, digits and dashes.');
  return JOIN_SECRET_PREFIX + invite;
}

/** Keeps an invitation's join secret until the roster records what happened to the invitation. A different secret for the same invite is refused. */
export async function storeJoinSecret(secrets: SecretStorageLike, invite: string, secret: string): Promise<void> {
  const name = joinSecretName(invite);
  if (typeof secret !== 'string' || secret === '') throw new Error('A join secret cannot be empty.');
  const existing = await secrets.get(name);
  if (existing === secret) return;
  if (existing) throw new Error('This invitation already has a join secret on this computer, so it was not replaced.');
  await secrets.store(name, secret);
}

/** The join secret of an invitation this computer made, or undefined when it holds none. */
export async function joinSecret(secrets: SecretStorageLike, invite: string): Promise<string | undefined> {
  const value = await secrets.get(joinSecretName(invite));
  return value ? value : undefined;
}

/**
 * Forgets an invitation's join secret. Call it only after a roster entry records the invitation's outcome (member.admit, device.add or invite.void
 * is stored). This is the only SecretStorage value the host ever deletes (Pitfall 7).
 */
export async function forgetJoinSecret(secrets: SecretStorageLike, invite: string): Promise<void> {
  await secrets.delete(joinSecretName(invite));
}
