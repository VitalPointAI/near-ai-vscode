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

type SecretStoreRefusal = 'noStore' | 'keyringFailed';
export type SecretStoreGuideChoice = SecretStoreKind | SecretStoreRefusal | 'unknown';

export interface SecretStoreGuidance {
  readonly confirmed?: SecretStoreStatus;
  readonly choice: SecretStoreGuideChoice;
  readonly stale: boolean;
  readonly automaticallyOpen: boolean;
}

function confirmedStatus(value: unknown): SecretStoreStatus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { store, reason } = value as Partial<SecretStoreStatus>;
  if (store === 'openbao' || store === 'keyring') return { store };
  if (store !== 'unavailable') return undefined;
  if (reason === SECRET_STORE_TEXT.noStore || reason === SECRET_STORE_TEXT.keyringFailed) return { store, reason };
  return { store };
}

/** Only the latest recognized choice can replace a confirmation or prompt automatic guidance. */
export function secretStoreGuidance(status: unknown, previous?: SecretStoreStatus): SecretStoreGuidance {
  const current = confirmedStatus(status);
  const confirmed = current ?? confirmedStatus(previous);
  const reason = confirmed?.reason;
  const choice = reason === SECRET_STORE_TEXT.noStore ? 'noStore'
    : reason === SECRET_STORE_TEXT.keyringFailed ? 'keyringFailed'
      : confirmed?.store ?? 'unknown';
  return {
    confirmed,
    choice,
    stale: !current && !!confirmed,
    automaticallyOpen: current?.store === 'unavailable'
  };
}

/** Tracks whether this frontend session has shown its confirmed unavailable state. */
export class SecretStoreGuideSession {
  private current = secretStoreGuidance(undefined);
  private unavailableShown = false;

  get guidance(): SecretStoreGuidance { return this.current; }

  get automaticallyOpen(): boolean { return this.current.automaticallyOpen && !this.unavailableShown; }

  accept(status: unknown): void {
    this.current = secretStoreGuidance(status, this.current.confirmed);
  }

  markVisible(): void {
    if (this.current.confirmed?.store === 'unavailable') this.unavailableShown = true;
  }
}

/** The backend caches its choice. Bound the wait and disregard a reply after timeout or shutdown. */
export function readSecretStoreStatus(
  service: SecretStoreService, signal: AbortSignal, timeoutMs = 5_000
): Promise<unknown> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise(resolve => {
    const cancel = (): void => finish(undefined);
    const timer = setTimeout(cancel, timeoutMs);
    function finish(status: unknown): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      resolve(status);
    }
    signal.addEventListener('abort', cancel, { once: true });
    try {
      void service.status().then(finish, cancel);
    } catch {
      cancel();
    }
  });
}
