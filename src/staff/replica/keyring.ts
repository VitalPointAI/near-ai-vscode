// This device's keys for multi-user staff projects (D-14, D-19, D-24): the X25519 encryption key that cell grants are wrapped to, the ring of cell
// epoch keys opened from those grants, and the join secrets of open invitations. Node only; never imports vscode (SecretStorage is reached through
// SecretStorageLike).
//
// Where each secret lives, and nowhere else:
// - The X25519 private key: one per person per install, in SecretStorage under ENCRYPTION_KEY_SECRET beside the Ed25519 device key
//   (DEVICE_KEY_SECRET), stored the same way (PKCS8 DER as base64). It is made inside the same identity-create lock as the device key, with the same
//   read-back check, so two windows never make two keys. Its public half is bound to the device by an Ed25519 signature over x25519BindingBytes,
//   which the roster entry that admits the device carries (D-19).
// - The post-quantum keys (33.2 D-03): the 32-byte P-256 scalar and the 64-byte ML-KEM-768 seed, one pair per install, in SecretStorage under
//   KEM_KEY_SECRET as base64url, made inside the same identity-create lock with the same read-back check. Only the seeds are kept (BoringSSL in
//   VS Code's Electron imports no other ML-KEM form); the key objects are made from them in memory.
// - Epoch keys: in memory, written through to one SecretStorage value per project (EPOCH_KEY_SECRET_PREFIX + project): the keys the roster settled
//   and the keys this device made, each with the hash of the grant that carries it. For a grant on disk the value is only a cache: the grants are
//   ciphertext wrapped to this device, so a lost value is rebuilt by opening them again once the roster places them (D-24). Only a grant the roster
//   placed, or a key this device made for a grant the roster committed to, ever becomes the key of an epoch (DeviceKeyRing.settle, CR-01).
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
import { EPOCH_KEY_BYTES, readGrant, x25519BindingBytes, x25519PublicRaw } from '../../domain/replica/cellKeys';
import type { CellGrant } from '../../domain/replica/cellKeys';
import { HASH_PATTERN, STREAM_ID_PATTERN, writerIdOf } from '../../domain/replica/entry';
import { SLUG_PATTERN } from '../../domain/replica/kindSchemas/shared';
import type { CellRecord, CellsState, EpochRecord } from '../../domain/replica/rosterCells';
import type { KeyRing } from '../../domain/replica/rosterView';
import { isRecord } from '../../domain/team/validate';
import { MLKEM_SEED_BYTES, P256_SCALAR_BYTES, kemPrivateFromSeeds, kemPublicFromSeeds, newKemSeeds, unwrapForDevice } from '../../domain/replica/cellWrapV2';
import type { KemPrivateKeys, KemPublicKeys, KemSeeds } from '../../domain/replica/cellWrapV2';

/** The SecretStorage name of this install's X25519 private key, beside nearAi.identity.deviceKey (D-19). */
export const ENCRYPTION_KEY_SECRET = 'nearAi.identity.encryptionKey';
/** The SecretStorage name of this install's post-quantum key seeds (33.2 D-03), beside the encryption key. */
export const KEM_KEY_SECRET = 'nearAi.identity.kemKey';
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

/** This install's post-quantum keys: the public keys to publish and the private key objects (never exported). */
export interface DeviceKemKeys { readonly publicKeys: KemPublicKeys; readonly privateKeys: KemPrivateKeys }

function kemSeedsFromStored(stored: string): KemSeeds {
  try {
    const value = JSON.parse(stored) as unknown;
    if (!isRecord(value) || typeof value.p256 !== 'string' || typeof value.mlkem768 !== 'string') throw new Error('shape');
    const seeds = { p256: Buffer.from(value.p256, 'base64url'), mlkem768: Buffer.from(value.mlkem768, 'base64url') };
    if (seeds.p256.length !== P256_SCALAR_BYTES || seeds.mlkem768.length !== MLKEM_SEED_BYTES) throw new Error('size');
    kemPrivateFromSeeds(seeds);
    return seeds;
  } catch (error) {
    throw new Error('The stored post-quantum keys could not be read.', { cause: error });
  }
}

async function loadStoredKemSeeds(secrets: SecretStorageLike): Promise<KemSeeds | undefined> {
  const stored = await secrets.get(KEM_KEY_SECRET);
  return stored ? kemSeedsFromStored(stored) : undefined;
}

/**
 * This install's post-quantum keys, made on first need (33.2 D-03), like loadOrCreateEncryptionKey: the check, the creation, the store and the
 * read-back run inside identity-create.lock, and a stored value that cannot be read is refused and never replaced. Call it only where the runtime
 * passed probeWrapV2.
 */
export async function loadOrCreateKemKeys(secrets: SecretStorageLike, options: { identityDir: string }): Promise<DeviceKemKeys> {
  await mkdir(options.identityDir, { recursive: true, mode: 0o700 });
  const seeds = await withFileLock(options.identityDir, IDENTITY_CREATE_LOCK_FILE, async () => {
    const existing = await loadStoredKemSeeds(secrets);
    if (existing) return existing;
    const made = newKemSeeds();
    await secrets.store(KEM_KEY_SECRET, JSON.stringify({ p256: made.p256.toString('base64url'), mlkem768: made.mlkem768.toString('base64url') }));
    const readBack = await loadStoredKemSeeds(secrets);
    if (!readBack || !readBack.p256.equals(made.p256) || !readBack.mlkem768.equals(made.mlkem768)) {
      throw new Error('The new post-quantum keys could not be read back from this computer\'s secret storage, so they were not used.');
    }
    return readBack;
  });
  return { publicKeys: kemPublicFromSeeds(seeds), privateKeys: kemPrivateFromSeeds(seeds) };
}

// ---- the key ring (D-24, D-44) -------------------------------------------------------------------------------------------------------------------

/** The device a key ring opens grants for: its writer id and its X25519 private key. */
/** The device a key ring opens grants for: its writer id, its X25519 private key and, where it has them, its post-quantum keys (33.2 D-03). */
export interface KeyRingDevice { writer: string; privateKey: KeyObject; kem?: KemPrivateKeys }

/** A key this device made for a new cell or a new epoch, with the hash of the founding grant that carries it (addOwn). */
export interface OwnEpochKey { cell: string; epoch: number; grant: string; key: Buffer }

/** A key this device could read a roster entry with while it catches up (readingCandidates): never a key it writes with. */
export interface ReadingCandidate { epoch: number; key: Buffer; own: boolean; grant: string }

const ringId = (cell: string, epoch: number): string => `${cell}/${epoch}`;
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface CachedRing { keys: Map<string, Buffer>; own: Map<string, OwnEpochKey> }

function epochKeyBytes(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === EPOCH_KEY_BYTES ? bytes : undefined;
}

function cachedRing(text: string | undefined): CachedRing {
  const ring: CachedRing = { keys: new Map(), own: new Map() };
  if (!text) return ring;
  try {
    const value = JSON.parse(text) as unknown;
    // Version 1 cached every key opened from any grant addressed to this device, before the roster had placed the grant, so it is not trusted: those
    // keys are opened again from the grants the roster places (CR-01).
    if (!isRecord(value) || value.v !== 2 || !Array.isArray(value.keys) || !Array.isArray(value.own)) return ring;
    for (const item of value.keys as unknown[]) {
      if (!Array.isArray(item) || item.length !== 3) continue;
      const [cell, epoch, key] = item as unknown[];
      const bytes = epochKeyBytes(key);
      if (typeof cell !== 'string' || !STREAM_ID_PATTERN.test(cell) || !Number.isSafeInteger(epoch) || (epoch as number) < 1 || bytes === undefined) continue;
      ring.keys.set(ringId(cell, epoch as number), bytes);
    }
    for (const item of value.own as unknown[]) {
      if (!Array.isArray(item) || item.length !== 4) continue;
      const [cell, epoch, grant, key] = item as unknown[];
      const bytes = epochKeyBytes(key);
      if (typeof cell !== 'string' || !STREAM_ID_PATTERN.test(cell) || !Number.isSafeInteger(epoch) || (epoch as number) < 1) continue;
      if (typeof grant !== 'string' || !HASH_PATTERN.test(grant) || bytes === undefined) continue;
      ring.own.set(grant, { cell, epoch: epoch as number, grant, key: bytes });
    }
  } catch {
    // A cache that does not read is the same as no cache: every key in it can be opened again from the grants.
  }
  return ring;
}

/** The cell id a signed grant names, read without checking anything else, so a grant for another cell is skipped before its signature is checked. */
function grantCell(signed: unknown): string | undefined {
  if (!isRecord(signed) || !isRecord(signed.payload)) return undefined;
  return typeof signed.payload.cell === 'string' ? signed.payload.cell : undefined;
}

/**
 * The epoch keys this device holds for one project. Keys live in memory and are written through to one SecretStorage value per project, never to a
 * file. The cache can be lost without losing anything a grant on disk carries: settle opens the same keys again once the roster places the grants.
 * A cell's stream id is its cell id, and the roster stream is the base cell (the project id), so keyRing() answers (stream, epoch) directly.
 *
 * Only the roster decides which key an epoch has (CR-01, D-44). A key enters the answers of epochKey and keyRing only through settle: from a grant
 * the roster fold placed (its signer could change the roster at the roster it names and every device it wraps to was admitted there, or it is the
 * founding grant the roster committed to by hash), or from a key this device made for the founding grant the roster committed to. A grant from
 * anyone else, or for an epoch the roster has not founded, never decides which key this device writes with.
 */
export class DeviceKeyRing {
  private readonly keys: Map<string, Buffer>;
  private readonly own: Map<string, OwnEpochKey>;
  // Memoized unwraps by grant hash, including failed unwraps. A page without the device's wrap does not populate this cache.
  private readonly unwrapped = new Map<string, Buffer | null>();
  private changes = 0;

  private constructor(private readonly secrets: SecretStorageLike, public readonly project: string, private readonly device: KeyRingDevice, cached: CachedRing) {
    this.keys = cached.keys;
    this.own = cached.own;
  }

  /** The ring of a project for a device, starting from the SecretStorage cache (or empty when there is none or it does not read). */
  public static async load(secrets: SecretStorageLike, project: string, device: KeyRingDevice): Promise<DeviceKeyRing> {
    if (!STREAM_ID_PATTERN.test(project)) throw new Error('A project id is 32 lowercase hex characters.');
    return new DeviceKeyRing(secrets, project, device, cachedRing(await secrets.get(EPOCH_KEY_SECRET_PREFIX + project)));
  }

  /** Counts every time the ring changed, so a host can tell that the ring answers differently than it did (and replace its fold context). */
  public get version(): number {
    return this.changes;
  }

  /** How many epoch keys the ring answers for. */
  public get size(): number {
    return this.keys.size;
  }

  /**
   * Takes the keys the roster settles. For every epoch the roster founded, the key is the one this device made for the founding grant the roster
   * committed to (addOwn); else what this device's wrap opens to in the founding grant the roster placed; else in another grant the roster placed for
   * that epoch (the grants of a device admitted later, D-45), smallest hash first. A held key that differs is replaced: the key of an epoch is the one
   * its committed grant carries. Returns how many keys were added or replaced; a change is written through to SecretStorage.
   */
  public async settle(cells: CellsState): Promise<number> {
    let changed = 0;
    for (const record of cells.cells.values()) {
      for (const founded of record.epochs) {
        const key = this.settledKey(record, founded);
        if (key === undefined) continue;
        const id = ringId(record.cell, founded.epoch);
        const held = this.keys.get(id);
        if (held !== undefined && held.equals(key)) continue;
        this.keys.set(id, key);
        changed += 1;
      }
    }
    if (changed > 0) {
      this.changes += 1;
      await this.persist();
    }
    return changed;
  }

  /**
   * Keeps a key this device made for a new cell or a new epoch, with the hash of the founding grant that carries it, before the roster entry that
   * commits to that grant is written, so a crash never leaves an epoch nobody can open. The key answers epochKey only once settle finds the roster
   * committed to that grant. A key made for a rekey whose entry was never written stays unused beside the key of the next rekey of the same epoch,
   * which is the one the roster then commits to (MJ-04). The same grant with another key is refused.
   */
  public async addOwn(cell: string, epoch: number, key: Buffer, grant: string): Promise<void> {
    if (!STREAM_ID_PATTERN.test(cell) || !Number.isSafeInteger(epoch) || epoch < 1) throw new Error('A cell key needs a cell id and an epoch of 1 or more.');
    if (key.length !== EPOCH_KEY_BYTES) throw new Error('An epoch key must be 32 bytes.');
    if (typeof grant !== 'string' || !HASH_PATTERN.test(grant)) throw new Error('A cell key this device made is kept with the hash of the grant that carries it.');
    const held = this.own.get(grant);
    if (held !== undefined) {
      if (held.cell === cell && held.epoch === epoch && held.key.equals(key)) return;
      throw new Error('This computer already holds another key for that grant, so the key was not replaced.');
    }
    this.own.set(grant, { cell, epoch, grant, key: Buffer.from(key) });
    this.changes += 1;
    await this.persist();
  }

  /**
   * Keys this device could read the roster stream with while it catches up. The roster stream is sealed under the base cell's epoch keys, and the
   * grants that give a device admitted later those keys are placed only once the fold reaches its admission (D-45), so the host first tries these:
   * this device's own keys for the cell, then what its wraps open to in any grant for the cell that reads, for every epoch the ring does not answer.
   * They are never added to the ring, never cached and never written with; only the grants the fold then places settle a key.
   */
  public readingCandidates(cell: string, grants: readonly unknown[]): ReadingCandidate[] {
    const out: ReadingCandidate[] = [];
    const own = [...this.own.values()].filter((item) => item.cell === cell && !this.keys.has(ringId(cell, item.epoch))).sort((a, b) => byText(a.grant, b.grant));
    for (const item of own) out.push({ epoch: item.epoch, key: Buffer.from(item.key), own: true, grant: item.grant });
    for (const signed of grants) {
      if (grantCell(signed) !== cell) continue;
      const read = readGrant(signed);
      if (!read.ok || this.keys.has(ringId(cell, read.grant.epoch))) continue;
      const key = this.open(read.grant, read.hash);
      if (key !== undefined) out.push({ epoch: read.grant.epoch, key, own: false, grant: read.hash });
    }
    return out;
  }

  /** The epoch key of a cell, as a copy, or undefined when the roster has not settled one for this device. */
  public epochKey(cell: string, epoch: number): Buffer | undefined {
    const key = this.keys.get(ringId(cell, epoch));
    return key === undefined ? undefined : Buffer.from(key);
  }

  /** Whether the roster has settled a key of the cell's epoch for this device. */
  public holds(cell: string, epoch: number): boolean {
    return this.keys.has(ringId(cell, epoch));
  }

  /** The KeyRing the fold reads. It answers from the live ring, so a key settled later is answered by the same function. */
  public keyRing(): KeyRing {
    return (stream, epoch) => this.epochKey(stream, epoch);
  }

  private settledKey(record: CellRecord, founded: EpochRecord): Buffer | undefined {
    const own = this.own.get(founded.grant);
    if (own !== undefined && own.cell === record.cell && own.epoch === founded.epoch) return Buffer.from(own.key);
    const placed = record.grants
      .filter((grant) => grant.epoch === founded.epoch && grant.writers.includes(this.device.writer))
      .sort((a, b) => Number(b.founding) - Number(a.founding) || byText(a.hash, b.hash));
    for (const grant of placed) {
      const key = this.open(grant.grant, grant.hash);
      if (key !== undefined) return key;
    }
    return undefined;
  }

  /** What this device's wrap in a grant opens to, or undefined. */
  private open(grant: CellGrant, hash: string): Buffer | undefined {
    const mine = grant.wraps.find((wrap) => wrap.writer === this.device.writer);
    // A raw founding page and its assembled grant share a hash. A later page may carry this device's wrap.
    if (mine === undefined) return undefined;
    let key = this.unwrapped.get(hash);
    if (key === undefined) {
      key = unwrapForDevice({ cell: grant.cell, epoch: grant.epoch, writer: this.device.writer, x25519: this.device.privateKey, ...(this.device.kem === undefined ? {} : { kem: this.device.kem }), wrap: mine.wrap }) ?? null;
      this.unwrapped.set(hash, key);
    }
    return key === null ? undefined : Buffer.from(key);
  }

  /** Writes the ring through to SecretStorage, merged with what another window stored, so no window drops a key the other settled or made. */
  private async persist(): Promise<void> {
    const name = EPOCH_KEY_SECRET_PREFIX + this.project;
    const stored = cachedRing(await this.secrets.get(name));
    for (const [id, key] of stored.keys) if (!this.keys.has(id)) this.keys.set(id, key);
    for (const [grant, item] of stored.own) if (!this.own.has(grant)) this.own.set(grant, item);
    const keys = [...this.keys].sort(([a], [b]) => byText(a, b)).map(([id, key]) => {
      const [cell, epoch] = id.split('/');
      return [cell, Number(epoch), key.toString('base64url')];
    });
    const own = [...this.own.values()].sort((a, b) => byText(a.grant, b.grant)).map((item) => [item.cell, item.epoch, item.grant, item.key.toString('base64url')]);
    await this.secrets.store(name, JSON.stringify({ v: 2, keys, own }));
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
/** Compare candidate roster-reading keys without making either map authoritative. */
export function sameReadingKeys(a: ReadonlyMap<number, Buffer>, b: ReadonlyMap<number, Buffer>): boolean {
  if (a.size !== b.size) return false;
  for (const [epoch, key] of a) if (b.get(epoch)?.equals(key) !== true) return false;
  return true;
}
