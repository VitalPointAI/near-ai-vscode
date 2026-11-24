/**
 * The person signer (Phase 33 D-60): the engine's asynchronous signer over the person's long-term key in your organization's OpenBao Transit,
 * reached only through KeyService.sign (46-07). KeyService logs in to the step-up role with the latest sign-in for every signature, so a
 * signature needs a fresh passkey or security key confirmation and OpenBao enforces it. Every refusal comes back as a value carrying KeyService's
 * own sentence and, when there is one, its fix; sign never throws. Each signature is checked against the person's public key before it is
 * returned, so a key store that answers with another key's signature signs nothing. When the key's Transit version is known (the session read
 * it with the public key), a signature by any other version is refused too, so a key rotated during the session signs nothing here.
 *
 * The signer keeps nothing between calls: no token, no signature, no message. It never logs. Nothing here imports Theia.
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { KEY_SERVICE_TEXT } from '../../common/key-service.js';
import type { KeyService } from '../key-service.js';

/** A refusal the engine passes through to the person unchanged (`refused`), with KeyService's fix when it has one. */
export interface PersonSignRefused {
  readonly refused: string;
  readonly fix?: string;
}

/** The engine's AsyncPayloadSigner shape (src/domain/team/signedPayload.ts), typed here because the extension cannot import src/. */
export interface PersonSigner {
  readonly fingerprint: string;
  /** The raw Ed25519 public key, base64url. */
  readonly publicKey: string;
  sign(bytes: Buffer): Promise<string | PersonSignRefused>;
}

export const PERSON_SIGNER_TEXT = {
  mismatch: "Your organization's key store signed with a key that is not your person key, so nothing was signed. Ask your administrator.",
  rotated: 'Your person key was changed while this session was open, so nothing was signed. Sign in again.',
} as const;

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The engine's signer fingerprint of a raw Ed25519 public key (fingerprintOf in src/domain/team/canonical.ts). */
export function signerFingerprint(publicKey: string): string {
  return `dev-${createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex').slice(0, 32)}`;
}

/** True for a raw 32-byte Ed25519 public key written as strict base64url. */
export function isPublicKeyText(publicKey: unknown): publicKey is string {
  return typeof publicKey === 'string' && publicKey.length === 43 && BASE64URL.test(publicKey)
    && Buffer.from(publicKey, 'base64url').toString('base64url') === publicKey;
}

/**
 * The person signer for the key whose raw public key is `publicKey`, and, when given, whose Transit version is `keyVersion`. Throws only for a
 * public key that is not one (a programming error); every answer of sign is a signature (base64url, as the engine verifies) or a refusal value.
 */
export function personSigner(keyService: Pick<KeyService, 'sign'>, publicKey: string, keyVersion?: number): PersonSigner {
  if (!isPublicKeyText(publicKey)) throw new Error('The person key must be a 32-byte Ed25519 public key written as base64url.');
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKey, 'base64url')]), format: 'der', type: 'spki' });

  async function sign(bytes: Buffer): Promise<string | PersonSignRefused> {
    let answer: Awaited<ReturnType<KeyService['sign']>>;
    try {
      answer = await keyService.sign(Buffer.from(bytes).toString('base64'));
    } catch {
      return { refused: KEY_SERVICE_TEXT.unreachable };
    }
    if (answer.kind === 'refused') return answer.fix === undefined ? { refused: answer.reason } : { refused: answer.reason, fix: answer.fix };
    if (keyVersion !== undefined && answer.value.keyVersion !== keyVersion) return { refused: PERSON_SIGNER_TEXT.rotated };
    const signature = Buffer.from(answer.value.signature, 'base64');
    let matches = false;
    try {
      matches = signature.length === 64 && edVerify(null, bytes, key, signature);
    } catch {
      matches = false;
    }
    return matches ? signature.toString('base64url') : { refused: PERSON_SIGNER_TEXT.mismatch };
  }

  return { fingerprint: signerFingerprint(publicKey), publicKey, sign };
}
