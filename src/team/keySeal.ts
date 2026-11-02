// Sealed key delivery (D-23): a NEAR API key encrypted to one device so it can sit in the public coordination log.
// Scheme: ephemeral X25519 key, ECDH, HKDF-SHA256 and AES-256-GCM. The associated data binds team, member, device and key id.
// node:crypto only, no vscode. A failed open is a verdict (undefined), the same style as verifySignature in canonical.ts.
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { canonicalBytes, isStrictBase64url } from '../domain/team/canonical';
import { findSecrets } from '../domain/team/secrets';

export const SEAL_SCHEME = 'x25519-hkdf-sha256-aes-256-gcm-v1';

const HKDF_INFO = 'near-ai/team-key-seal/v1';
const SEAL_PURPOSE = 'near-ai.team.key-seal';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
// The detector exempts ciphertext of 22 to 700 characters, which is 16 to 525 bytes of plaintext.
const MIN_PLAINTEXT_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 512;
const MAX_ATTEMPTS = 8;
const TOKEN_PREFIXES = ['sk-', 'sk_', 'rpt-', 'rt_', 'adm_', 'oc_', 'eyJ'];

export interface SealedEntry {
  device: string;
  ephemeral: { publicKey: string };
  nonce: string;
  tag: string;
  ciphertext: string;
}

export interface SealContext {
  teamId: string;
  memberId: string;
  device: string;
  keyId: string;
}

// Where the ephemeral key pair and the nonce come from. Only tests replace this, to force a re-roll.
export interface SealRandomness {
  ephemeral(): { publicKey: KeyObject; privateKey: KeyObject };
  nonce(): Buffer;
}

const SYSTEM_RANDOMNESS: SealRandomness = {
  ephemeral: () => generateKeyPairSync('x25519'),
  nonce: () => randomBytes(NONCE_BYTES)
};

export function sealContextBytes(context: SealContext): Buffer {
  return canonicalBytes({ v: 1, purpose: SEAL_PURPOSE, teamId: context.teamId, memberId: context.memberId, device: context.device, keyId: context.keyId });
}

export function wipe(buffer: Buffer): void {
  buffer.fill(0);
}

function rawPublicKeyOf(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('The X25519 key has no public half.');
  return Buffer.from(jwk.x, 'base64url');
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' });
}

// The key is derived from the shared secret with the two public keys as salt, so it is tied to this one exchange.
function deriveKey(shared: Buffer, ephemeralRaw: Buffer, recipientRaw: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeralRaw, recipientRaw]), HKDF_INFO, KEY_BYTES));
}

function isStrictCiphertext(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  return Buffer.from(value, 'base64url').toString('base64url') === value;
}

// A sealed entry must hold neither the clear key nor anything the write-side detector would flag, so a bad draw is rolled again.
function leaksClearKey(entry: SealedEntry, plaintext: Buffer): boolean {
  if (TOKEN_PREFIXES.some((prefix) => entry.ciphertext.startsWith(prefix))) return true;
  if (Buffer.from(entry.ciphertext, 'base64url').includes(plaintext)) return true;
  const text = JSON.stringify(entry);
  if (text.includes(plaintext.toString('utf8')) || text.includes(plaintext.toString('base64url')) || text.includes(plaintext.toString('base64'))) return true;
  return findSecrets({ sealed: [entry] }).length > 0;
}

export function sealTo(plaintext: Buffer, recipientPublicKey: string, context: SealContext, randomness: SealRandomness = SYSTEM_RANDOMNESS): SealedEntry {
  if (plaintext.length < MIN_PLAINTEXT_BYTES || plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error(`A sealed key must be between ${MIN_PLAINTEXT_BYTES} and ${MAX_PLAINTEXT_BYTES} bytes.`);
  }
  if (!isStrictBase64url(recipientPublicKey, KEY_BYTES)) throw new Error('The recipient seal key is not a valid X25519 public key.');
  const recipientRaw = Buffer.from(recipientPublicKey, 'base64url');
  const recipient = publicKeyFromRaw(recipientRaw);
  const aad = sealContextBytes(context);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const ephemeral = randomness.ephemeral();
    const ephemeralRaw = rawPublicKeyOf(ephemeral.publicKey);
    const nonce = randomness.nonce();
    if (nonce.length !== NONCE_BYTES) throw new Error('The seal nonce must be 12 bytes.');
    const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
    const key = deriveKey(shared, ephemeralRaw, recipientRaw);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const entry: SealedEntry = {
        device: context.device,
        ephemeral: { publicKey: ephemeralRaw.toString('base64url') },
        nonce: nonce.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url')
      };
      if (!leaksClearKey(entry, plaintext)) return entry;
    } finally {
      wipe(shared);
      wipe(key);
    }
  }
  throw new Error('A sealed entry that is safe to write could not be produced.');
}

export function openSealed(entry: SealedEntry, recipientPrivateKey: KeyObject, recipientPublicKey: string, context: SealContext): Buffer | undefined {
  try {
    if (entry.device !== context.device) return undefined;
    if (!isStrictBase64url(entry.ephemeral.publicKey, KEY_BYTES) || !isStrictBase64url(entry.nonce, NONCE_BYTES) || !isStrictBase64url(entry.tag, TAG_BYTES)) return undefined;
    if (!isStrictBase64url(recipientPublicKey, KEY_BYTES) || !isStrictCiphertext(entry.ciphertext)) return undefined;
    const ephemeralRaw = Buffer.from(entry.ephemeral.publicKey, 'base64url');
    const recipientRaw = Buffer.from(recipientPublicKey, 'base64url');
    const shared = diffieHellman({ privateKey: recipientPrivateKey, publicKey: publicKeyFromRaw(ephemeralRaw) });
    const key = deriveKey(shared, ephemeralRaw, recipientRaw);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.nonce, 'base64url'), { authTagLength: TAG_BYTES });
      decipher.setAAD(sealContextBytes(context));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, 'base64url')), decipher.final()]);
    } finally {
      wipe(shared);
      wipe(key);
    }
  } catch {
    // A bad point, a failed tag or malformed input all mean the entry cannot be opened; the verdict is the undefined return, not a thrown error.
    return undefined;
  }
}
