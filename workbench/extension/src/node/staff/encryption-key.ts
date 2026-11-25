/**
 * The person's X25519 encryption key in a hosted session (Phase 33 D-61; T-33-N8). OpenBao Transit has no X25519, so cell grants stay wrapped to
 * an X25519 key whose private part is protected by the person's Transit KEK:
 *
 *   first session   a new X25519 key, sealed with AES-256-GCM under a new data key from KeyService.generateWrappedDataKey; only the envelope
 *                   { v: 1, wrappedKey, iv, ciphertext, tag } is stored, under ENCRYPTION_ENVELOPE_SECRET in the person's key store
 *   later sessions  the envelope is read, its data key unwrapped by KeyService.unwrapDataKey (backend only, 46-07), and the key opened
 *   stopping        drop() releases the key; the caller hands the handle to SessionKeys.hold so stop drops it with the session key
 *
 * The key lives in backend memory only between those points. Nothing is written to the workspace volume, and nothing plain to the key store.
 * An envelope that does not open is refused and left as it is: a key is never replaced. The data key and the sealed plaintext are zeroed after
 * use. Refusals are values with KeyService's or the key store's own sentence. Nothing here imports Theia or logs.
 *
 * The sealed content is versioned JSON. { v: 1, x25519 } (the PKCS8 private key, base64url) is what 33-23 wrote; { v: 2, x25519, p256, mlkem768 }
 * adds the person's post-quantum private parts (33.2 D-03): the 32-byte P-256 scalar and the 64-byte ML-KEM-768 seed, base64url, sealed with the
 * same data key under the same Transit KEK. With the engine's post-quantum functions given and the runtime passing the cell-wrap/v2 probe, a v1
 * envelope is opened and sealed again as v2 at the next session start (same wrapped data key, read back before use); without them, or where the
 * probe fails, the envelope is opened as it is and nothing is added. Both forms open.
 */
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { KEY_SERVICE_TEXT } from '../../common/key-service.js';
import { SECRET_STORE_TEXT } from '../../common/secret-store.js';
import { ok, refused, type ServiceResult } from '../../common/service-result.js';
import type { KeyService } from '../key-service.js';
import type { KemPrivateKeys, KemPublicKeys, KemSeeds, StaffEngine } from './staff-engine.js';
import type { SecretStorageLike } from './keystore-secrets.js';

/** Where the envelope is kept in the person's key store, beside keyring.ts's epoch keys and join secrets. */
export const ENCRYPTION_ENVELOPE_SECRET = 'nearAi.identity.encryptionKeyEnvelope';

export const ENCRYPTION_KEY_TEXT = {
  unreadable: 'Your stored encryption key could not be opened, so it was left as it is. Ask your administrator.',
  notKept: "Your new encryption key could not be read back from your organization's secret store, so it was not used. Try again.",
} as const;

/** The envelope as stored: the Transit-wrapped data key as Transit gives it, and the AES-256-GCM parts as base64url. */
export interface EncryptionKeyEnvelope {
  readonly v: 1;
  readonly wrappedKey: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

/** The person's post-quantum keys: the public keys to publish, and the private keys until drop(). */
export interface OpenedKemKeys {
  readonly publicKeys: KemPublicKeys;
  readonly privateKeys: KemPrivateKeys | undefined;
}

/** The opened key: its raw public key (base64url), the private key until drop(), and the post-quantum keys when the envelope holds them. */
export interface OpenedEncryptionKey {
  readonly publicKey: string;
  readonly privateKey: KeyObject | undefined;
  readonly kem: OpenedKemKeys | undefined;
  drop(): void;
}

/** The engine's post-quantum functions (staff-engine.ts); given, the envelope holds the person's v2 keys too. */
export type KemEngine = Pick<StaffEngine, 'newKemSeeds' | 'kemPublicFromSeeds' | 'kemPrivateFromSeeds' | 'probeWrapV2'>;

const ENVELOPE_AAD = 'near-ai/encryption-key-envelope/v1';
const TRANSIT_TEXT = /^vault:v[1-9][0-9]{0,8}:[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_ENVELOPE_CHARS = 8192;

type Refusal = { readonly kind: 'refused'; readonly reason: string; readonly fix?: string };
const isRefusal = (value: unknown): value is Refusal => typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'refused';
const refusal = (reason: string): Refusal => ({ kind: 'refused', reason });

/** A key store failure as a refusal with the store's own sentence; anything else is "did not answer". */
function storeRefusal(error: unknown): Refusal {
  const message = error instanceof Error ? error.message : '';
  return refusal((Object.values(SECRET_STORE_TEXT) as string[]).includes(message) ? message : SECRET_STORE_TEXT.unreachable);
}

async function readEnvelope(secrets: SecretStorageLike): Promise<string | undefined | Refusal> {
  try {
    return await secrets.get(ENCRYPTION_ENVELOPE_SECRET);
  } catch (error) {
    return storeRefusal(error);
  }
}

const aad = (wrappedKey: string): Buffer => Buffer.from(`${ENVELOPE_AAD}\n${wrappedKey}`, 'utf8');

function parseEnvelope(text: string): EncryptionKeyEnvelope | undefined {
  if (text.length > MAX_ENVELOPE_CHARS) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'ciphertext,iv,tag,v,wrappedKey' || record.v !== 1) return undefined;
  const { wrappedKey, iv, ciphertext, tag } = record;
  if (typeof wrappedKey !== 'string' || !TRANSIT_TEXT.test(wrappedKey)) return undefined;
  for (const [part, bytes] of [[iv, 12], [tag, 16], [ciphertext, 0]] as const) {
    if (typeof part !== 'string' || !BASE64URL.test(part)) return undefined;
    if (bytes > 0 && Buffer.from(part, 'base64url').length !== bytes) return undefined;
  }
  return { v: 1, wrappedKey, iv: iv as string, ciphertext: ciphertext as string, tag: tag as string };
}

async function dataKey(keyService: Pick<KeyService, 'unwrapDataKey'>, wrappedKey: string): Promise<Buffer | Refusal> {
  const unwrapped = await keyService.unwrapDataKey(wrappedKey);
  if (unwrapped.kind === 'refused') return unwrapped;
  const key = Buffer.from(unwrapped.value.plaintext, 'base64');
  if (key.length !== 32) {
    key.fill(0);
    return refusal(ENCRYPTION_KEY_TEXT.unreadable);
  }
  return key;
}

/** What an envelope holds once opened. seeds are present only in a v2 envelope; the caller zeroes them. */
interface Sealed {
  readonly x25519: KeyObject;
  readonly seeds: KemSeeds | undefined;
}

function handle(sealed: Sealed, kem: KemEngine | undefined): OpenedEncryptionKey {
  let held: KeyObject | undefined = sealed.x25519;
  let heldKem: KemPrivateKeys | undefined;
  let publicKeys: KemPublicKeys | undefined;
  if (sealed.seeds !== undefined && kem !== undefined) {
    publicKeys = kem.kemPublicFromSeeds(sealed.seeds);
    heldKem = kem.kemPrivateFromSeeds(sealed.seeds);
  }
  sealed.seeds?.p256.fill(0);
  sealed.seeds?.mlkem768.fill(0);
  const publicKey = Buffer.from(createPublicKey(sealed.x25519).export({ format: 'jwk' }).x as string, 'base64url').toString('base64url');
  const kemKeys: OpenedKemKeys | undefined = publicKeys === undefined ? undefined : {
    publicKeys,
    get privateKeys() {
      return heldKem;
    },
  };
  return {
    publicKey,
    get privateKey() {
      return held;
    },
    kem: kemKeys,
    drop() {
      held = undefined;
      heldKem = undefined;
    },
  };
}

function seal(privateKey: KeyObject, seeds: KemSeeds | undefined, key: Buffer, wrappedKey: string): EncryptionKeyEnvelope {
  const x25519 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const content = seeds === undefined ? { v: 1, x25519 } : { v: 2, x25519, p256: seeds.p256.toString('base64url'), mlkem768: seeds.mlkem768.toString('base64url') };
  const plain = Buffer.from(JSON.stringify(content), 'utf8');
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(wrappedKey));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { v: 1, wrappedKey, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
  } finally {
    plain.fill(0);
  }
}

const P256_SCALAR_BYTES = 32;
const MLKEM_SEED_BYTES = 64;

/** The keys an envelope holds (v1 or v2 content), or a refusal. The envelope is never changed here. */
async function open(keyService: Pick<KeyService, 'unwrapDataKey'>, text: string): Promise<Sealed | Refusal> {
  const envelope = parseEnvelope(text);
  if (envelope === undefined) return refusal(ENCRYPTION_KEY_TEXT.unreadable);
  const key = await dataKey(keyService, envelope.wrappedKey);
  if (isRefusal(key)) return key;
  let plain: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(aad(envelope.wrappedKey));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]);
    const sealed = JSON.parse(plain.toString('utf8')) as { v?: unknown; x25519?: unknown; p256?: unknown; mlkem768?: unknown };
    if ((sealed.v !== 1 && sealed.v !== 2) || typeof sealed.x25519 !== 'string') return refusal(ENCRYPTION_KEY_TEXT.unreadable);
    const privateKey = createPrivateKey({ key: Buffer.from(sealed.x25519, 'base64url'), format: 'der', type: 'pkcs8' });
    if (privateKey.asymmetricKeyType !== 'x25519') return refusal(ENCRYPTION_KEY_TEXT.unreadable);
    if (sealed.v === 1) return { x25519: privateKey, seeds: undefined };
    if (typeof sealed.p256 !== 'string' || typeof sealed.mlkem768 !== 'string') return refusal(ENCRYPTION_KEY_TEXT.unreadable);
    const seeds = { p256: Buffer.from(sealed.p256, 'base64url'), mlkem768: Buffer.from(sealed.mlkem768, 'base64url') };
    if (seeds.p256.length !== P256_SCALAR_BYTES || seeds.mlkem768.length !== MLKEM_SEED_BYTES) return refusal(ENCRYPTION_KEY_TEXT.unreadable);
    return { x25519: privateKey, seeds };
  } catch {
    return refusal(ENCRYPTION_KEY_TEXT.unreadable);
  } finally {
    key.fill(0);
    plain?.fill(0);
  }
}

/**
 * The person's encryption key for this session: opened from the envelope in the person's key store, or made and sealed there on first use. A new
 * envelope is read back before its key is used, and when the store then holds another one (a second session of the same person wrote at the same
 * moment), the key of the envelope the store keeps is opened instead. One backend serves one person (Phase 46 D-03) and opens the key once, at
 * session start.
 */
export async function openEncryptionKey(
  keyService: Pick<KeyService, 'generateWrappedDataKey' | 'unwrapDataKey'>, secrets: SecretStorageLike, kem?: KemEngine,
): Promise<ServiceResult<OpenedEncryptionKey>> {
  // The post-quantum keys are made and kept only where this runtime can use them (33.2 D-05: the probe decides the feature).
  const withKem = kem !== undefined && kem.probeWrapV2() ? kem : undefined;
  const stored = await readEnvelope(secrets);
  if (isRefusal(stored)) return stored;
  if (stored !== undefined) {
    const opened = await open(keyService, stored);
    if (isRefusal(opened)) return opened;
    if (opened.seeds !== undefined || withKem === undefined) return ok(handle(opened, withKem));
    return upgrade(keyService, secrets, stored, opened.x25519, withKem);
  }

  const wrapped = await keyService.generateWrappedDataKey();
  if (wrapped.kind === 'refused') return wrapped;
  const key = await dataKey(keyService, wrapped.value.ciphertext);
  if (isRefusal(key)) return key;
  const made = generateKeyPairSync('x25519').privateKey;
  const seeds = withKem?.newKemSeeds();
  let text: string;
  try {
    text = JSON.stringify(seal(made, seeds, key, wrapped.value.ciphertext));
  } finally {
    key.fill(0);
  }
  try {
    await secrets.store(ENCRYPTION_ENVELOPE_SECRET, text);
  } catch (error) {
    return storeRefusal(error);
  }
  return keptOrOpened(keyService, secrets, text, { x25519: made, seeds }, withKem);
}

/** After a store: the key just sealed when the store holds that envelope, the key of the envelope it holds instead, or a refusal. */
async function keptOrOpened(
  keyService: Pick<KeyService, 'unwrapDataKey'>, secrets: SecretStorageLike, text: string, sealed: Sealed, kem: KemEngine | undefined,
): Promise<ServiceResult<OpenedEncryptionKey>> {
  const kept = await readEnvelope(secrets);
  if (isRefusal(kept)) return kept;
  if (kept === text) return ok(handle(sealed, kem));
  sealed.seeds?.p256.fill(0);
  sealed.seeds?.mlkem768.fill(0);
  if (kept === undefined) return refused(ENCRYPTION_KEY_TEXT.notKept);
  const opened = await open(keyService, kept);
  return isRefusal(opened) ? opened : ok(handle(opened, kem));
}

/** A v1 envelope sealed again as v2 with new post-quantum keys, under the same wrapped data key; the X25519 key is unchanged. */
async function upgrade(
  keyService: Pick<KeyService, 'unwrapDataKey'>, secrets: SecretStorageLike, stored: string, x25519: KeyObject, kem: KemEngine,
): Promise<ServiceResult<OpenedEncryptionKey>> {
  const envelope = parseEnvelope(stored) as EncryptionKeyEnvelope;
  const key = await dataKey(keyService, envelope.wrappedKey);
  if (isRefusal(key)) return key;
  const seeds = kem.newKemSeeds();
  let text: string;
  try {
    text = JSON.stringify(seal(x25519, seeds, key, envelope.wrappedKey));
  } finally {
    key.fill(0);
  }
  try {
    await secrets.store(ENCRYPTION_ENVELOPE_SECRET, text);
  } catch (error) {
    return storeRefusal(error);
  }
  return keptOrOpened(keyService, secrets, text, { x25519, seeds }, kem);
}
