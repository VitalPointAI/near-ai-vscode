// The single-use invite code (D-09). 160 random bits, shown as 32 Crockford base32 characters. Only a key derived from the code is ever
// logged: the invite records the derived public key and the join is countersigned by the derived private key, so the code proves possession
// without appearing on the coordination branch. The private key stays in a closure and is never exported or stored. Never imports vscode.
import { createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign as edSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export const INVITE_CODE_BYTES = 20;
const CODE_CHARACTERS = 32;
const GROUP_SIZE = 4;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// PKCS#8 wrapper for a raw 32-byte Ed25519 seed.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const HKDF_INFO_PREFIX = 'near-ai/team-invite/v1|';

function encode(bytes: Buffer): string {
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let text = '';
  for (let index = 0; index < CODE_CHARACTERS; index += 1) {
    text = ALPHABET.charAt(Number(bits & 31n)) + text;
    bits >>= 5n;
  }
  return text;
}

export function generateInviteCode(): { bytes: Buffer; text: string } {
  const bytes = randomBytes(INVITE_CODE_BYTES);
  return { bytes, text: encode(bytes) };
}

// XXXX-XXXX-... so a person can read it out or copy it by eye.
export function formatInviteCode(text: string): string {
  const groups: string[] = [];
  for (let index = 0; index < text.length; index += GROUP_SIZE) groups.push(text.slice(index, index + GROUP_SIZE));
  return groups.join('-');
}

// Accepts what a person pastes: groups, spaces and either case. I and L read as 1 and O as 0. Anything else is not a code.
export function parseInviteCode(input: string): Buffer | undefined {
  const cleaned = input.replace(/[\s-]/g, '').toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
  if (cleaned.length !== CODE_CHARACTERS) return undefined;
  let bits = 0n;
  for (const character of cleaned) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) return undefined;
    bits = (bits << 5n) | BigInt(value);
  }
  const bytes = Buffer.alloc(INVITE_CODE_BYTES);
  for (let index = INVITE_CODE_BYTES - 1; index >= 0; index -= 1) {
    bytes[index] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  return bytes;
}

export interface InviteKey { publicKey: string; sign(bytes: Buffer): string }

function privateKeyFor(codeBytes: Buffer, teamId: string, memberId: string): KeyObject {
  const seed = Buffer.from(hkdfSync('sha256', codeBytes, Buffer.from(teamId, 'utf8'), Buffer.from(`${HKDF_INFO_PREFIX}${memberId}`, 'utf8'), 32));
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

// Salt is the team id and info is the member id, so one code never derives the same key in two teams or for two invitations.
export function deriveInviteKey(codeBytes: Buffer, teamId: string, memberId: string): InviteKey {
  const privateKey = privateKeyFor(codeBytes, teamId, memberId);
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('The invite key has no public half.');
  const publicKey = jwk.x;
  return { publicKey, sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url') };
}

export function inviteKeyMatches(codeBytes: Buffer, teamId: string, memberId: string, publicKey: string): boolean {
  return deriveInviteKey(codeBytes, teamId, memberId).publicKey === publicKey;
}
