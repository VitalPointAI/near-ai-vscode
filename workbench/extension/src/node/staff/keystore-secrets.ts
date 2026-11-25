/**
 * The person's key store (Theia's KeyStoreService over the person's OpenBao KV path, 46-07) as the SecretStorageLike the engine's keyring.ts
 * takes (Phase 33 D-61). keyring.ts runs unchanged over it, so the person's epoch keys and join secrets are kept under their own OpenBao path and
 * follow them to every later session. The staff backend keeps its secrets under one service of its own, apart from any extension's.
 *
 * A hosted session keeps no plain private key at rest (D-61): the X25519 key is stored only as the sealed envelope of encryption-key.ts, and the
 * device key is the person key in Transit. So storing under the names the single-machine identity keeps its plain private keys in is refused,
 * which turns a wrong wiring into a visible failure instead of a long-term key in the store. Nothing here imports Theia or logs.
 */
import type { SecretStoreKind } from '../../common/secret-store.js';
import type { KeyStore } from '../key-stores.js';

/** The engine's SecretStorageLike (src/services/auth.ts), structurally. */
export interface SecretStorageLike {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The key store service the staff backend's secrets are kept under. */
export const STAFF_SECRET_SERVICE = 'sterling-staff';

export const KEY_STORE_SECRETS_TEXT = {
  plainPrivateKey: 'A hosted session keeps no plain private key in your organization\'s secret store, so this key was not saved.',
} as const;

/**
 * The names a single machine keeps plain private keys under: keyring.ts ENCRYPTION_KEY_SECRET and src/team/identity.ts DEVICE_KEY_SECRET,
 * PENDING_DEVICE_KEY_SECRET and PREVIOUS_DEVICE_KEY_SECRET.
 */
export const PLAIN_PRIVATE_KEY_SECRETS: readonly string[] = Object.freeze([
  'nearAi.identity.encryptionKey',
  'nearAi.identity.deviceKey',
  'nearAi.identity.pendingDeviceKey',
  'nearAi.identity.previousDeviceKey',
]);

/**
 * The key store as SecretStorageLike. `kind` is the store's (key-stores.ts): the plain private-key names are refused for your organization's OpenBao
 * store (a hosted session); this computer's keyring (a single machine) keeps the device key and the X25519 key as the extension does.
 */
export function keyStoreSecrets(
  keyStore: Pick<KeyStore, 'getPassword' | 'setPassword' | 'deletePassword'>, service: string, kind: SecretStoreKind = 'openbao',
): SecretStorageLike {
  return {
    get: (key) => keyStore.getPassword(service, key),
    store: async (key, value) => {
      if (kind !== 'keyring' && PLAIN_PRIVATE_KEY_SECRETS.includes(key)) throw new Error(KEY_STORE_SECRETS_TEXT.plainPrivateKey);
      await keyStore.setPassword(service, key, value);
    },
    delete: async (key) => {
      await keyStore.deletePassword(service, key);
    },
  };
}
