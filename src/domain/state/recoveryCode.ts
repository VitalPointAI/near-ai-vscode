// The recovery code that unlocks a project's synced state (D-02, D-18). 256 random bits shown as 52 Crockford base32 characters in 13 groups of 4.
// It is always generated, never chosen, shortened or weakened by the person. Nothing here stores or logs a code.
// 52 characters carry 260 bits, so the 4 leading bits are padding: they are zero when a code is made and a code whose padding is not zero is refused.
// Never imports vscode. This is the Team invite code's shape (feat/team-fix-pass, src/team/inviteCode.ts) at a larger size without its Ed25519 half;
// deduplicate the two when that branch merges.
import { randomBytes } from 'node:crypto';

export const RECOVERY_CODE_BYTES = 32;
export const RECOVERY_CODE_CHARACTERS = 52;
const GROUP_SIZE = 4;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DATA_BITS = BigInt(RECOVERY_CODE_BYTES * 8);

function encode(bytes: Buffer): string {
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let text = '';
  for (let index = 0; index < RECOVERY_CODE_CHARACTERS; index += 1) {
    text = ALPHABET.charAt(Number(bits & 31n)) + text;
    bits >>= 5n;
  }
  return text;
}

/** XXXX-XXXX-... so a person can read the code out or copy it by eye. */
export function formatRecoveryCode(bytes: Buffer): string {
  if (bytes.length !== RECOVERY_CODE_BYTES) throw new Error('A recovery code is exactly 32 bytes.');
  const text = encode(bytes);
  const groups: string[] = [];
  for (let index = 0; index < text.length; index += GROUP_SIZE) groups.push(text.slice(index, index + GROUP_SIZE));
  return groups.join('-');
}

/** A fresh code: the shown text and the 32 bytes it stands for. */
export function generateRecoveryCode(): { code: string; bytes: Buffer } {
  const bytes = randomBytes(RECOVERY_CODE_BYTES);
  return { code: formatRecoveryCode(bytes), bytes };
}

/**
 * Accepts what a person types or pastes: groups, spaces, hyphens and either case. I and L read as 1 and O as 0. Anything else, a wrong length or
 * a code whose 4 leading padding bits are not zero is not a code and gives undefined (the caller refuses it like any wrong code).
 */
export function parseRecoveryCode(input: string): Buffer | undefined {
  const cleaned = input.replace(/[\s-]/g, '').toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
  if (cleaned.length !== RECOVERY_CODE_CHARACTERS) return undefined;
  let bits = 0n;
  for (const character of cleaned) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) return undefined;
    bits = (bits << 5n) | BigInt(value);
  }
  if (bits >> DATA_BITS !== 0n) return undefined;
  const bytes = Buffer.alloc(RECOVERY_CODE_BYTES);
  for (let index = RECOVERY_CODE_BYTES - 1; index >= 0; index -= 1) {
    bytes[index] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  return bytes;
}
