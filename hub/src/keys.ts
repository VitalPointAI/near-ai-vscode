// The hub's own keys (D-30). The operator makes each key once with `node /app/bin.mjs --generate-key signing|encryption`, which prints one key
// line on stdout, saves it as a secret file with mode 0400, and names it through HUB_SIGNING_KEY_FILE or HUB_ENCRYPTION_KEY_FILE. The hub never
// writes a key file of its own and keeps its keys outside the state volume.
//
// A key line is a fixed prefix and a 32-byte seed as base64url:
//   near-ai-hub-signing-key:v1:<seed>     an Ed25519 private key; its public key gives the hub's writer id and payload signer.
//   near-ai-hub-encryption-key:v1:<seed>  an X25519 private key; the base cell grants its epoch keys to it once the hub is admitted (D-64).
// The X25519 key is bound to the hub's writer id by a signature of the signing key over x25519BindingBytes, the same binding a device makes.
//
// Every refusal names the setting and what is wrong, never the key text.
import { createPrivateKey, createPublicKey, randomBytes, sign as edSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { x25519BindingBytes, x25519PrivateFromSeed, x25519PublicRaw } from '@ext/domain/replica/cellKeys';
import { writerIdOf } from '@ext/domain/replica/entry';
import { fingerprintOf, isStrictBase64url } from '@ext/domain/team/canonical';
import type { PayloadSigner } from '@ext/domain/team/signedPayload';

export type KeyKind = 'signing' | 'encryption';
export const KEY_KINDS: readonly KeyKind[] = ['signing', 'encryption'];

export const KEY_PREFIXES: Readonly<Record<KeyKind, string>> = {
  signing: 'near-ai-hub-signing-key:v1:',
  encryption: 'near-ai-hub-encryption-key:v1:',
};

const SETTING_OF: Readonly<Record<KeyKind, string>> = { signing: 'HUB_SIGNING_KEY', encryption: 'HUB_ENCRYPTION_KEY' };
const SEED_BYTES = 32;
// 16-byte PKCS8 prefix of an Ed25519 private key, followed by the 32-byte seed.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export class KeyFileError extends Error {
  readonly setting: string;
  constructor(setting: string, message: string) {
    super(message);
    this.name = 'KeyFileError';
    this.setting = setting;
  }
}

/** A new key line of this kind, from 32 fresh random bytes. The caller prints it; nothing is written to disk here. */
export function generateKeyFile(kind: KeyKind): string {
  return `${KEY_PREFIXES[kind]}${randomBytes(SEED_BYTES).toString('base64url')}`;
}

function seedOf(kind: KeyKind, text: string): Buffer {
  const setting = SETTING_OF[kind];
  const other: KeyKind = kind === 'signing' ? 'encryption' : 'signing';
  const line = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text;
  if (line.startsWith(KEY_PREFIXES[other])) {
    throw new KeyFileError(setting, `${setting} holds the hub's ${other} key, not its ${kind} key. Point ${setting}_FILE at the line from --generate-key ${kind}.`);
  }
  if (!line.startsWith(KEY_PREFIXES[kind])) {
    throw new KeyFileError(setting, `${setting} is not a hub ${kind} key line. Make one with --generate-key ${kind}.`);
  }
  const seed = line.slice(KEY_PREFIXES[kind].length);
  if (!isStrictBase64url(seed, SEED_BYTES)) {
    throw new KeyFileError(setting, `${setting} is damaged: the key part must be 32 bytes written as base64url. Make a new one with --generate-key ${kind}.`);
  }
  return Buffer.from(seed, 'base64url');
}

export interface HubSigningKey {
  signer: PayloadSigner;
  /** The raw 32-byte Ed25519 public key as base64url. */
  publicKey: string;
  /** sha256 of the public key: the hub's writer id in rosters and checkpoints. */
  writer: string;
}

export function readSigningKey(text: string): HubSigningKey {
  const seed = seedOf('signing', text);
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  seed.fill(0);
  der.fill(0);
  const raw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url');
  const publicKey = raw.toString('base64url');
  const signer: PayloadSigner = {
    fingerprint: fingerprintOf(raw),
    publicKey,
    sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url'),
  };
  return { signer, publicKey, writer: writerIdOf(publicKey) };
}

export interface HubEncryptionKey {
  privateKey: KeyObject;
  /** The raw 32-byte X25519 public key as base64url. */
  x25519: string;
  /** The signing key's signature over x25519BindingBytes(x25519, writer), as base64url. */
  x25519Sig: string;
}

export function readEncryptionKey(text: string, signing: HubSigningKey): HubEncryptionKey {
  const seed = seedOf('encryption', text);
  const privateKey = x25519PrivateFromSeed(seed);
  seed.fill(0);
  const raw = x25519PublicRaw(privateKey);
  return { privateKey, x25519: raw.toString('base64url'), x25519Sig: signing.signer.sign(x25519BindingBytes(raw, signing.writer)) };
}
