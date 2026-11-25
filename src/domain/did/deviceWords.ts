// Six safety words for a computer's did:key (Phase 71, 71-10; VCRD-06), so a person binding a computer to themselves can check, by eye, that the
// did:key they are about to vouch for is the one this computer shows. Pure: node:crypto and the existing safety word list only (no new list).
//
// h = sha256('near-ai/device-identity/v1' NUL did); the first 66 bits of h, read as six 11-bit numbers from the most significant bit, pick the
// six words, the way the join safety code does (safetyCode.ts). The device fingerprint a DeviceBindingCredential names is 'dev-' and the first
// 16 bytes of the same hash, hex.
import { createHash } from 'node:crypto';
import { SAFETY_WORDS } from '../replica/safetyWords';

export const DEVICE_WORDS_DOMAIN = 'near-ai/device-identity/v1';
export const DEVICE_WORDS = 6;

const digestOf = (did: string): Buffer => createHash('sha256').update(Buffer.from(`${DEVICE_WORDS_DOMAIN}\0${did}`, 'utf8')).digest();

/** The six lower-case words for a did:key. The same did gives the same words on every computer. */
export function deviceIdentityWords(did: string): string[] {
  if (typeof did !== 'string' || !did.startsWith('did:key:')) throw new Error('Only a did:key has device words.');
  const digest = digestOf(did);
  let bits = 0n;
  for (let index = 0; index < 9; index += 1) bits = bits * 256n + BigInt(digest[index] as number);
  const words: string[] = [];
  for (let word = 0; word < DEVICE_WORDS; word += 1) {
    const shift = BigInt(72 - 11 * (word + 1));
    words.push((SAFETY_WORDS[Number((bits / 2n ** shift) % 2048n)] as string).toLowerCase());
  }
  return words;
}

/** The words as both screens show them: one space between words. */
export function deviceIdentityWordsText(did: string): string {
  return deviceIdentityWords(did).join(' ');
}

/** The device fingerprint a DeviceBindingCredential names for this did:key: 'dev-' and 32 hex characters. */
export function deviceFingerprint(did: string): string {
  return `dev-${digestOf(did).subarray(0, 16).toString('hex')}`;
}
