/**
 * The secret store as the browser sees it (D-04, D-18, D-36, D-43): the RPC path, which store the backend chose at start, and the words the
 * person reads when there is no durable store. A status carries the store kind and a plain reason only, never a secret, a token or an entity
 * id. Nothing here imports Theia, so the backend, the browser and the tests share it.
 */

export const SECRET_STORE_PATH = '/services/sterling-secret-store';
export const SecretStoreService = Symbol('SecretStoreService');

/** openbao: the person's own path in your organization's OpenBao; keyring: this computer's keyring; unavailable: saving a secret fails. */
export type SecretStoreKind = 'openbao' | 'keyring' | 'unavailable';

export interface SecretStoreStatus {
  readonly store: SecretStoreKind;
  /** Present only when the store is unavailable. */
  readonly reason?: string;
}

export interface SecretStoreService {
  status(): Promise<SecretStoreStatus>;
}

/** Every sentence a secret store refusal or notice shows (D-43): no em-dashes, "your organization", no secret and no credential request. */
export const SECRET_STORE_TEXT = {
  unavailable: 'Secrets are unavailable',
  noStore: "This workbench has no secret store, so saving a secret fails. Ask your administrator to connect your organization's secret store.",
  keyringFailed: "This computer's keyring could not be opened, so saving a secret fails.",
  notReady: 'Your sign-in is not ready, so secrets cannot be read or saved yet.',
  unreachable: "Your organization's secret store did not answer, so the secret was not read or saved. Try again, or ask your administrator.",
  refused: "Your organization's secret store refused this request. Ask your administrator.",
  badName: 'A secret name must be valid text.',
} as const;
