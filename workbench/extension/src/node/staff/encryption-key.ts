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
 * The sealed content is versioned JSON, { v: 1, x25519 } (the PKCS8 private key, base64url), so a later version can add keys beside it and
 * still open an envelope written now.
 */
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { KEY_SERVICE_TEXT } from '../../common/key-service.js';
import { SECRET_STORE_TEXT } from '../../common/secret-store.js';
import { ok, refused, type ServiceResult } from '../../common/service-result.js';
import type { KeyService } from '../key-service.js';
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

/** The opened key: its raw public key (base64url), and the private key until drop(). */
export interface OpenedEncryptionKey {
  readonly publicKey: string;
  readonly privateKey: KeyObject | undefined;
  drop(): void;
}

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

function handle(privateKey: KeyObject): OpenedEncryptionKey {
  let held: KeyObject | undefined = privateKey;
  const publicKey = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url').toString('base64url');
  return {
    publicKey,
    get privateKey() {
      return held;
    },
    drop() {
      held = undefined;
    },
  };
}

function seal(privateKey: KeyObject, key: Buffer, wrappedKey: string): EncryptionKeyEnvelope {
  const plain = Buffer.from(JSON.stringify({ v: 1, x25519: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') }), 'utf8');
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

/** The private key an envelope holds, or a refusal. The envelope is never changed. */
async function open(keyService: Pick<KeyService, 'unwrapDataKey'>, text: string): Promise<KeyObject | Refusal> {
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
    const sealed = JSON.parse(plain.toString('utf8')) as { v?: unknown; x25519?: unknown };
    if (sealed.v !== 1 || typeof sealed.x25519 !== 'string') return refusal(ENCRYPTION_KEY_TEXT.unreadable);
    const privateKey = createPrivateKey({ key: Buffer.from(sealed.x25519, 'base64url'), format: 'der', type: 'pkcs8' });
    return privateKey.asymmetricKeyType === 'x25519' ? privateKey : refusal(ENCRYPTION_KEY_TEXT.unreadable);
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
  keyService: Pick<KeyService, 'generateWrappedDataKey' | 'unwrapDataKey'>, secrets: SecretStorageLike,
): Promise<ServiceResult<OpenedEncryptionKey>> {
  const stored = await readEnvelope(secrets);
  if (isRefusal(stored)) return stored;
  if (stored !== undefined) {
    const opened = await open(keyService, stored);
    return isRefusal(opened) ? opened : ok(handle(opened));
  }

  const wrapped = await keyService.generateWrappedDataKey();
  if (wrapped.kind === 'refused') return wrapped;
  const key = await dataKey(keyService, wrapped.value.ciphertext);
  if (isRefusal(key)) return key;
  const made = generateKeyPairSync('x25519').privateKey;
  let text: string;
  try {
    text = JSON.stringify(seal(made, key, wrapped.value.ciphertext));
  } finally {
    key.fill(0);
  }
  try {
    await secrets.store(ENCRYPTION_ENVELOPE_SECRET, text);
  } catch (error) {
    return storeRefusal(error);
  }
  const kept = await readEnvelope(secrets);
  if (isRefusal(kept)) return kept;
  if (kept === text) return ok(handle(made));
  if (kept === undefined) return refused(ENCRYPTION_KEY_TEXT.notKept);
  const opened = await open(keyService, kept);
  return isRefusal(opened) ? opened : ok(handle(opened));
}
