// Keys and the sealed envelope for project state that is pushed to a remote (D-02, D-09, D-18). Symmetric cryptography only (AES-256-GCM,
// HKDF-SHA256, scrypt over a generated recovery code), so no public-key step can be broken later by harvesting the ciphertext.
//
//   recovery code (256 bits) --scrypt(salt)--> key-encryption key --wraps--> project data key --HKDF--> one key per purpose or object
//
// Pure: no vscode, no files, no git. Every refusal is one StateRefusedError with a plain sentence that never carries a key, the code or a file name.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scrypt } from 'node:crypto';

export type StateRefusalReason = 'wrong-code-or-damaged' | 'tampered' | 'truncated' | 'rolled-back' | 'missing-object' | 'unsupported-format';

const REFUSAL_MESSAGES: Readonly<Record<StateRefusalReason, string>> = {
  'wrong-code-or-damaged': 'That recovery code is not right, or the saved state is damaged. Nothing was changed.',
  tampered: 'The saved state was changed or is damaged, so it was not opened. Nothing was changed.',
  truncated: 'Part of the saved state is cut short, so it was not opened. Nothing was changed.',
  'rolled-back': 'The saved state is older than one this computer has already seen, so it was not used. Nothing was changed.',
  'missing-object': 'Part of the saved state is missing, so it was not opened. Nothing was changed.',
  'unsupported-format': 'The saved state is in a format this version cannot read. Nothing was changed.'
};

export class StateRefusedError extends Error {
  public readonly reason: StateRefusalReason;
  public constructor(reason: StateRefusalReason) {
    super(REFUSAL_MESSAGES[reason]);
    this.name = 'StateRefusedError';
    this.reason = reason;
  }
}

export interface KdfParams { name: 'scrypt'; N: number; r: number; p: number }
/** What the manifest stores so the cost can be raised later without a format break. `salt` is base64. */
export interface KdfRecord extends KdfParams { salt: string }

export const KDF_PARAMS = { name: 'scrypt', N: 2 ** 17, r: 8, p: 1, keyLength: 32 } as const;
/** Node's default (32 MiB) rejects N=2^17, which needs 128 MiB. */
export const SCRYPT_MAXMEM = 256 * 1024 * 1024;
export const KEY_BYTES = 32;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
const FORMAT_PREFIX = 'near-ai/state/v1';

/** base64 fields, as stored in the manifest. */
export interface SealedBlob { iv: string; tag: string; data: string }
export type StateKeyPurpose = 'transcripts' | 'object' | 'manifest';

export function newDataKey(): Buffer { return randomBytes(KEY_BYTES); }
export function newSalt(): Buffer { return randomBytes(SALT_BYTES); }
/** Random and unrelated to the path, the name or any id: 32 lowercase hex characters. */
export function newStateId(): string { return randomBytes(16).toString('hex'); }

/** Refuses cost parameters a hostile manifest could use to exhaust memory or time, before any scrypt call. */
export function assertKdfParams(kdf: unknown): KdfParams {
  const value = kdf as Partial<KdfParams> | null;
  if (typeof value !== 'object' || value === null || value.name !== 'scrypt') throw new StateRefusedError('unsupported-format');
  const { N, r, p } = value;
  if (typeof N !== 'number' || typeof r !== 'number' || typeof p !== 'number') throw new StateRefusedError('unsupported-format');
  const inBounds = Number.isInteger(N) && N >= 2 ** 14 && N <= 2 ** 20 && (N & (N - 1)) === 0
    && Number.isInteger(r) && r >= 1 && r <= 32
    && Number.isInteger(p) && p >= 1 && p <= 16
    && 128 * N * r <= SCRYPT_MAXMEM;
  if (!inBounds) throw new StateRefusedError('unsupported-format');
  return { name: 'scrypt', N, r, p };
}

/** The key that wraps the data key. The callback form keeps the extension host free for the ~0.3 s a derivation takes. Every refusal is a rejection. */
export function deriveKek(code: Buffer, salt: Buffer, kdf: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const params = assertKdfParams(kdf);
      if (code.length === 0 || salt.length < 8 || salt.length > 64) throw new StateRefusedError('wrong-code-or-damaged');
      scrypt(code, salt, KDF_PARAMS.keyLength, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM }, (error, key) => {
        if (error) reject(new StateRefusedError('unsupported-format'));
        else resolve(key);
      });
    } catch (error) {
      reject(error);
    }
  });
}

/** One key per purpose, or per object when a random salt is given, so no key ever encrypts two messages under one IV space. */
export function subKey(dataKey: Buffer, purpose: StateKeyPurpose, salt?: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', dataKey, salt ?? Buffer.alloc(0), `${FORMAT_PREFIX}/${purpose}`, KEY_BYTES));
}

/** Binds a ciphertext to its project and purpose, so it cannot be moved to another project, class or position. */
export function aadFor(stateId: string, ...parts: Array<string | number>): Buffer {
  return Buffer.from([FORMAT_PREFIX, stateId, ...parts.map(String)].join('|'), 'utf8');
}

function requireKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error('A 32-byte key is required.');
}

export interface RawSealed { iv: Buffer; tag: Buffer; data: Buffer }

export function sealRaw(key: Buffer, plaintext: Buffer, aad: Buffer): RawSealed {
  requireKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), data };
}

/** A wrong key, a changed byte, a different AAD, a short IV or a short tag all end the same way: StateRefusedError('tampered'). */
export function openRaw(key: Buffer, sealed: RawSealed, aad: Buffer): Buffer {
  requireKey(key);
  if (sealed.iv.length !== IV_BYTES || sealed.tag.length !== TAG_BYTES) throw new StateRefusedError('tampered');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.data), decipher.final()]);
  } catch {
    throw new StateRefusedError('tampered');
  }
}

export function seal(key: Buffer, plaintext: Buffer, aad: Buffer): SealedBlob {
  const sealed = sealRaw(key, plaintext, aad);
  return { iv: sealed.iv.toString('base64'), tag: sealed.tag.toString('base64'), data: sealed.data.toString('base64') };
}

/** Only canonical base64 is accepted, so two spellings of one blob cannot both be valid. */
function decodeBase64(text: unknown): Buffer {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new StateRefusedError('tampered');
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text) throw new StateRefusedError('tampered');
  return bytes;
}

export function open(key: Buffer, blob: SealedBlob, aad: Buffer): Buffer {
  return openRaw(key, { iv: decodeBase64(blob?.iv), tag: decodeBase64(blob?.tag), data: decodeBase64(blob?.data) }, aad);
}

export function wrapDataKey(kek: Buffer, dataKey: Buffer, stateId: string): SealedBlob {
  requireKey(dataKey);
  return seal(kek, dataKey, aadFor(stateId, 'wrap'));
}

/** A wrong code and a damaged wrap cannot be told apart cryptographically, so both are one refusal. */
export function unwrapDataKey(kek: Buffer, wrapped: SealedBlob, stateId: string): Buffer {
  let dataKey: Buffer;
  try {
    dataKey = open(kek, wrapped, aadFor(stateId, 'wrap'));
  } catch {
    throw new StateRefusedError('wrong-code-or-damaged');
  }
  if (dataKey.length !== KEY_BYTES) throw new StateRefusedError('wrong-code-or-damaged');
  return dataKey;
}
