/**
 * Session identity as the browser sees it (D-21 to D-25, D-38, D-43): the RPC path, the status the backend reports, the words the person
 * reads, and the step-up link. A status carries the state and a reason code only, never a token or an entity id (T-46-06). Nothing here
 * imports Theia, so the backend and the tests share it.
 */

export const SESSION_IDENTITY_PATH = '/services/sterling-session-identity';
export const SessionIdentityService = Symbol('SessionIdentityService');

/** Why the identity check failed. State names and reasons are read by 46-07 and Phase 47's runbooks: never rename them. */
export type FailureReason = 'token-missing' | 'person-mismatch' | 'store-unreachable' | 'store-refused';

export type IdentityState = 'identity' | 'active' | 'failed' | 'stopping' | 'stopped';

export type SessionIdentityStatus =
  | { readonly mode: 'local' }
  | {
    readonly mode: 'hosted';
    readonly state: IdentityState;
    readonly reason?: FailureReason;
    /** Present when your organization configured a step-up sign-in (STERLING_STEPUP_ACR). */
    readonly stepUp?: { readonly acr: string };
  };

export interface SessionIdentityService {
  status(): Promise<SessionIdentityStatus>;
  /** Starts the identity check again from `failed` (the same path as start); does nothing in any other state. */
  retry(): Promise<SessionIdentityStatus>;
}

/** Every string the person reads about session identity (D-43): no em-dashes, "your organization", and nothing that asks for a credential (D-05). */
export const SESSION_IDENTITY_TEXT = {
  checking: 'Checking your sign-in',
  failed: 'Sign-in check failed',
  retry: 'Retry',
  retryCommand: 'Retry the sign-in check',
  reasons: {
    'token-missing': 'No sign-in reached this session. Sign in again, then choose Retry.',
    'person-mismatch': 'This session was started for someone else. Sign in as that person, then choose Retry.',
    'store-unreachable': "Your organization's secret store did not answer. Choose Retry, or ask your administrator.",
    'store-refused': "Your organization's secret store refused this sign-in. Ask your administrator.",
  } satisfies Record<FailureReason, string>,
  confirm: 'Confirm with your passkey or security key',
} as const;

/**
 * The same-origin step-up link (D-24, D-38): oauth2-proxy's /oauth2/start with the page to return to, the step-up acr and max_age=0, so the
 * identity provider runs a fresh passkey or security key ceremony. The workbench never builds a relying-party ID or any other origin (D-09):
 * the return path must start with a single "/", and anything else is refused (T-46-09).
 */
export function stepUpUrl(currentPathAndQuery: string, acr: string): string {
  if (!/^\/(?![/\\])/.test(currentPathAndQuery) || currentPathAndQuery.includes('\\')) {
    throw new Error('The step-up sign-in can only return to a page of this workbench.');
  }
  return `/oauth2/start?rd=${encodeURIComponent(currentPathAndQuery)}&acr_values=${encodeURIComponent(acr)}&max_age=0`;
}
