/**
 * The person's long-term keys as the browser may use them (D-15, D-16, D-20, D-21, D-25, D-43). The keys stay in your organization's OpenBao
 * Transit: the browser can ask for a signature or a new wrapped data key and gets plain data back, a refusal with its reason included. The
 * RPC has no unwrap method, so a plaintext data key never reaches the browser (T-46-29). Nothing here imports Theia.
 */
import type { ServiceResult } from './service-result.js';

export const KEY_SERVICE_PATH = '/services/sterling-key-service';
export const KeyServiceRpc = Symbol('KeyServiceRpc');

export interface Signature {
  /** The ed25519 signature, base64 (the vault:vN: prefix removed). */
  readonly signature: string;
  /** The Transit key version that signed. */
  readonly keyVersion: number;
}

export interface WrappedDataKey {
  /** The data key wrapped by the person's key, as Transit returns it (vault:vN:...); it can only be unwrapped in the backend. */
  readonly ciphertext: string;
}

/** What crosses to the browser: two methods, and no way to unwrap a data key. */
export interface KeyServiceRpc {
  sign(messageBase64: string): Promise<ServiceResult<Signature>>;
  generateWrappedDataKey(): Promise<ServiceResult<WrappedDataKey>>;
}

/** Every sentence the key service refuses with (D-43): no em-dashes, "your organization", no key, token or entity id. */
export const KEY_SERVICE_TEXT = {
  stepUpNeeded: 'Signing needs a fresh confirmation with your passkey or security key.',
  confirm: 'Confirm with your passkey or security key',
  notSetUp: 'Signing is not set up on this site. Ask your administrator.',
  signingKeyMissing: 'Your signing key is not set up yet. Ask your administrator.',
  dataKeyMissing: 'Your data key is not set up yet. Ask your administrator.',
  local: 'Long-term keys are not available on this computer.',
  notReady: 'Your sign-in is not ready, so your keys cannot be used yet.',
  badMessage: 'The message to sign must be base64 text of at most 64 KiB.',
  badCiphertext: 'This is not a wrapped data key.',
  unreachable: "Your organization's secret store did not answer. Try again, or ask your administrator.",
  refused: "Your organization's secret store refused this request. Ask your administrator.",
} as const;
