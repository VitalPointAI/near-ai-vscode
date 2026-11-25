// The hub's own keys (D-30). The operator makes each key once with `node /app/bin.mjs --generate-key signing|encryption`, which prints one key
// line on stdout, saves it as a secret file with mode 0400, and names it through HUB_SIGNING_KEY_FILE or HUB_ENCRYPTION_KEY_FILE. The hub never
// writes a key file of its own and keeps its keys outside the state volume.
//
// A key line is a fixed prefix and a 32-byte seed as base64url:
//   near-ai-hub-signing-key:v1:<seed>     an Ed25519 private key; its public key gives the hub's writer id and payload signer.
//   near-ai-hub-encryption-key:v1:<seed>  an X25519 private key; the base cell grants its epoch keys to it once the hub is admitted (D-64).
//   near-ai-hub-kem-key:v2:<seeds>         the hub's post-quantum keys (33.2 D-03): the 32-byte P-256 scalar then the 64-byte ML-KEM-768 seed, 96
//                                          bytes; optional (HUB_KEM_KEY), so a hub without it works as before and receives v1 wraps only.
// The X25519 key is bound to the hub's writer id by a signature of the signing key over x25519BindingBytes, the same binding a device makes; the
// post-quantum keys are bound the same way over kemBindingBytes.
//
// Every refusal names the setting and what is wrong, never the key text.
import { createPrivateKey, createPublicKey, randomBytes, sign as edSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { x25519BindingBytes, x25519PrivateFromSeed, x25519PublicRaw } from '@ext/domain/replica/cellKeys';
import { MLKEM_SEED_BYTES, P256_SCALAR_BYTES, kemPrivateFromSeeds, kemPublicFromSeeds, newKemSeeds } from '@ext/domain/replica/cellWrapV2';
import type { KemPrivateKeys, KemPublicKeys } from '@ext/domain/replica/cellWrapV2';
import { signKemBinding } from '@ext/domain/replica/deviceKem';
import { writerIdOf } from '@ext/domain/replica/entry';
import { fingerprintOf, isStrictBase64url } from '@ext/domain/team/canonical';
import type { PayloadSigner } from '@ext/domain/team/signedPayload';

export type KeyKind = 'signing' | 'encryption' | 'kem';
export const KEY_KINDS: readonly KeyKind[] = ['signing', 'encryption', 'kem'];

export const KEY_PREFIXES: Readonly<Record<KeyKind, string>> = {
  signing: 'near-ai-hub-signing-key:v1:',
  encryption: 'near-ai-hub-encryption-key:v1:',
  kem: 'near-ai-hub-kem-key:v2:',
};

const SETTING_OF: Readonly<Record<KeyKind, string>> = { signing: 'HUB_SIGNING_KEY', encryption: 'HUB_ENCRYPTION_KEY', kem: 'HUB_KEM_KEY' };
const SEED_BYTES_OF: Readonly<Record<KeyKind, number>> = { signing: 32, encryption: 32, kem: P256_SCALAR_BYTES + MLKEM_SEED_BYTES };
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
  if (kind === 'kem') {
    const seeds = newKemSeeds();
    return `${KEY_PREFIXES.kem}${Buffer.concat([seeds.p256, seeds.mlkem768]).toString('base64url')}`;
  }
  return `${KEY_PREFIXES[kind]}${randomBytes(SEED_BYTES_OF[kind]).toString('base64url')}`;
}

function seedOf(kind: KeyKind, text: string): Buffer {
  const setting = SETTING_OF[kind];
  const line = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text;
  for (const other of KEY_KINDS) {
    if (other !== kind && line.startsWith(KEY_PREFIXES[other])) {
      throw new KeyFileError(setting, `${setting} holds the hub's ${other} key, not its ${kind} key. Point ${setting}_FILE at the line from --generate-key ${kind}.`);
    }
  }
  if (!line.startsWith(KEY_PREFIXES[kind])) {
    throw new KeyFileError(setting, `${setting} is not a hub ${kind} key line. Make one with --generate-key ${kind}.`);
  }
  const seed = line.slice(KEY_PREFIXES[kind].length);
  if (!isStrictBase64url(seed, SEED_BYTES_OF[kind])) {
    throw new KeyFileError(setting, `${setting} is damaged: the key part must be ${SEED_BYTES_OF[kind]} bytes written as base64url. Make a new one with --generate-key ${kind}.`);
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

export interface HubKemKey {
  privateKeys: KemPrivateKeys;
  publicKeys: KemPublicKeys;
  /** The signing key's signature over kemBindingBytes(publicKeys, writer), as base64url. */
  sig: string;
}

/** The hub's post-quantum keys (33.2 D-03) from their key line, bound to the hub's writer id by its signing key. */
export function readKemKey(text: string, signing: HubSigningKey): HubKemKey {
  const both = seedOf('kem', text);
  const seeds = { p256: Buffer.from(both.subarray(0, P256_SCALAR_BYTES)), mlkem768: Buffer.from(both.subarray(P256_SCALAR_BYTES)) };
  both.fill(0);
  let privateKeys: KemPrivateKeys;
  try {
    privateKeys = kemPrivateFromSeeds(seeds);
  } catch {
    throw new KeyFileError(SETTING_OF.kem, `${SETTING_OF.kem} is damaged: its P-256 part is not a usable key. Make a new one with --generate-key kem.`);
  }
  const publicKeys = kemPublicFromSeeds(seeds);
  seeds.p256.fill(0);
  seeds.mlkem768.fill(0);
  return { privateKeys, publicKeys, sig: signKemBinding(publicKeys, signing.writer, (bytes) => signing.signer.sign(bytes)).sig };
}
