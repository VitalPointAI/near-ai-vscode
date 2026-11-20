// The six-word safety code a lead and a joining person compare by voice or in person before Admit (D-16, D-49). Pure: node:crypto only.
//
// The code is derived from the invite id, the genesis hash, and both devices' Ed25519 signing keys and X25519 keys. Anyone holding the invite file
// knows the one-time join value inside it, so that value is never an input: the code exists to catch a key swapped in transit, and only the keys and
// the fresh invite id can do that. Six words of the 2048-word list are 66 bits, so an attacker who must choose keys after seeing the invite id needs
// about 2^66 tries to match the code.
//
// h = sha256(SAFETY_CODE_DOMAIN NUL, then each field as a 4-byte big-endian length and its UTF-8 bytes, in this order: invite id, genesis hash, lead
// signing key, lead X25519 key, joining signing key, joining X25519 key). The first 66 bits of h, read as six 11-bit numbers from the most significant
// bit, pick the six words.
import { createHash } from 'node:crypto';
import { SAFETY_WORDS } from './safetyWords';

export const SAFETY_CODE_DOMAIN = 'near-ai/safety-code/v1';
export const SAFETY_CODE_WORDS = 6;
const BITS_PER_WORD = 11;

export interface SafetyCodeDevice { publicKey: string; x25519: string }
export interface SafetyCodeInput { invite: string; genesisHash: string; lead: SafetyCodeDevice; joiner: SafetyCodeDevice }

function field(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

// Six lower-case words. The same input gives the same words on every machine; a change to any field gives other words (with overwhelming odds).
export function safetyCode(input: SafetyCodeInput): string[] {
  const fields = [input.invite, input.genesisHash, input.lead.publicKey, input.lead.x25519, input.joiner.publicKey, input.joiner.x25519];
  for (const value of fields) if (typeof value !== 'string') throw new Error('Every safety code input is text.');
  const hash = createHash('sha256').update(Buffer.from(`${SAFETY_CODE_DOMAIN}\0`, 'utf8'));
  for (const value of fields) hash.update(field(value));
  const digest = hash.digest();
  // The first 72 bits as one number; the top 66 of them are the six indices.
  let bits = 0n;
  for (let index = 0; index < 9; index += 1) bits = bits * 256n + BigInt(digest[index]);
  const words: string[] = [];
  for (let word = 0; word < SAFETY_CODE_WORDS; word += 1) {
    const shift = BigInt(72 - BITS_PER_WORD * (word + 1));
    const value = Number((bits / 2n ** shift) % 2048n);
    words.push(SAFETY_WORDS[value]);
  }
  return words;
}

// The words as both screens show them: lower case, one space between words.
export function safetyCodeText(words: readonly string[]): string {
  return words.map((word) => word.toLowerCase()).join(' ');
}
