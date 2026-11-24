import { createHash } from 'node:crypto';
import { SAFETY_WORDS } from './safetyWords';

export const SERVER_WORDS_DOMAIN = 'near-ai/server-pin/v1';
export const SERVER_WORD_COUNT = 12;
const BITS_PER_WORD = 11;
const WORD_HASH_BYTES = 17;

/** The certificate pin as twelve safety words for a staff lead and operator to compare. */
export function serverPinWords(certPin: string): string[] {
  if (typeof certPin !== 'string' || !/^[0-9a-f]{64}$/i.test(certPin)) {
    throw new TypeError('The server certificate pin must be 64 hexadecimal characters.');
  }
  const pin = Buffer.from(certPin, 'hex');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(pin.length);
  const digest = createHash('sha256').update(`${SERVER_WORDS_DOMAIN}\0`).update(length).update(pin).digest();

  // Read the most significant 132 bits as twelve 11-bit indices into the shared word list.
  let bits = 0n;
  for (const byte of digest.subarray(0, WORD_HASH_BYTES)) bits = (bits << 8n) | BigInt(byte);
  const words: string[] = [];
  for (let word = 0; word < SERVER_WORD_COUNT; word += 1) {
    const shift = BigInt(WORD_HASH_BYTES * 8 - BITS_PER_WORD * (word + 1));
    words.push(SAFETY_WORDS[Number((bits >> shift) & 2047n)]);
  }
  return words;
}
