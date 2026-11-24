// base58btc, the multibase `z` prefix and Multikey public keys for verified credentials (Phase 71, D-05). Pure and dependency free: no import at all,
// so the encoder can never pick up a package (71-01 guard). Keys are Uint8Array; nothing here touches a private key.
//
// Multikey (W3C Controlled Identifiers 1.0, section 2.2.2): `z` + base58btc(multicodec header as an unsigned varint + raw public key).
// Ed25519 is multicodec 0xed (varint 0xed 0x01) with a 32-byte key; P-256 is multicodec 0x1200 (varint 0x80 0x24) with a 33-byte compressed key.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// The decoder is quadratic in its input, and every value we read is a key or a signature, so a longer text is refused before any work.
const MAX_ENCODED_LENGTH = 512;

export class MultibaseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MultibaseError';
  }
}

export function base58btcEncode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  // Base-58 digits, least significant first.
  const digits: number[] = [];
  for (let index = zeros; index < bytes.length; index += 1) {
    let carry = bytes[index];
    for (let digit = 0; digit < digits.length; digit += 1) {
      carry += digits[digit] * 256;
      digits[digit] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let text = '1'.repeat(zeros);
  for (let digit = digits.length - 1; digit >= 0; digit -= 1) text += ALPHABET[digits[digit]];
  return text;
}

export function base58btcDecode(text: string): Uint8Array {
  if (typeof text !== 'string' || text.length > MAX_ENCODED_LENGTH) throw new MultibaseError(`base58btc text must be at most ${MAX_ENCODED_LENGTH} characters.`);
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;
  // Bytes, least significant first.
  const bytes: number[] = [];
  for (let index = zeros; index < text.length; index += 1) {
    const value = ALPHABET.indexOf(text[index]);
    if (value < 0) throw new MultibaseError(`base58btc text has a character outside the alphabet at position ${index}.`);
    let carry = value;
    for (let position = 0; position < bytes.length; position += 1) {
      carry += bytes[position] * 58;
      bytes[position] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let index = 0; index < bytes.length; index += 1) out[zeros + index] = bytes[bytes.length - 1 - index];
  return out;
}

// Multibase with the base58btc prefix `z`, the only base the profile reads or writes.
export function multibaseEncode(bytes: Uint8Array): string {
  return `z${base58btcEncode(bytes)}`;
}

export function multibaseDecode(text: string): Uint8Array {
  if (typeof text !== 'string' || !text.startsWith('z')) throw new MultibaseError('Only base58btc multibase values (starting with z) are read.');
  return base58btcDecode(text.slice(1));
}

export type MultikeyType = 'Ed25519' | 'P-256';
export const MULTIKEY_HEADERS: Readonly<Record<MultikeyType, readonly [number, number]>> = { Ed25519: [0xed, 0x01], 'P-256': [0x80, 0x24] };
const KEY_LENGTHS: Readonly<Record<MultikeyType, number>> = { Ed25519: 32, 'P-256': 33 };
const MULTIKEY_TYPES: readonly MultikeyType[] = ['Ed25519', 'P-256'];

export interface MultikeyPublicKey { type: MultikeyType; key: Uint8Array }

function checkKey(type: MultikeyType, key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_LENGTHS[type]) throw new MultibaseError(`A ${type} Multikey public key must be ${KEY_LENGTHS[type]} bytes.`);
  if (type === 'P-256' && key[0] !== 0x02 && key[0] !== 0x03) throw new MultibaseError('A P-256 Multikey public key must be compressed (first byte 2 or 3).');
}

export function encodePublicKeyMultibase(type: MultikeyType, key: Uint8Array): string {
  checkKey(type, key);
  const header = MULTIKEY_HEADERS[type];
  const bytes = new Uint8Array(header.length + key.length);
  bytes.set(header, 0);
  bytes.set(key, header.length);
  return multibaseEncode(bytes);
}

export function decodePublicKeyMultibase(text: string): MultikeyPublicKey {
  const bytes = multibaseDecode(text);
  for (const type of MULTIKEY_TYPES) {
    const [first, second] = MULTIKEY_HEADERS[type];
    if (bytes.length >= 2 && bytes[0] === first && bytes[1] === second) {
      const key = bytes.slice(2);
      checkKey(type, key);
      return { type, key };
    }
  }
  throw new MultibaseError('This Multikey has a key type that is not read here (only Ed25519 and P-256).');
}
