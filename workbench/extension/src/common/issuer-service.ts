/**
 * The credential issuer's browser-facing shape (Phase 71, 71-12; D-14, D-15, D-22, O4, O7): an officer issues, revokes and suspends credentials in
 * their own session, and sees the revocation requests about the people they issued to. Plain data only: never a key, a token, an entity id, a
 * status index or a credential body. The card (browser/issue-credential-widget.ts) renders it; issuing needs a fresh step-up, which OpenBao
 * itself enforces. Nothing here imports Theia.
 */
import type { ServiceResult } from './service-result.js';

export const ISSUER_SERVICE_PATH = '/services/sterling-issuer';
export const IssuerServiceRpc = Symbol('IssuerServiceRpc');

/** One field of an issue form, as issueForm.ts (src/domain/credentials) gives it: a plain label and, for a choice, its options. */
export interface IssueFormField {
  readonly name: string;
  readonly label: string;
  readonly kind: 'person' | 'choice' | 'text' | 'date';
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly hint?: string;
}

/** A credential type the officer may issue now, with its form. `ceiling` is the plain words of the highest level, when the type has levels. */
export interface IssuableType {
  readonly type: string;
  readonly label: string;
  readonly ceiling?: string;
  /** The officer's own role ends then (ISO); nothing they issue may last longer. */
  readonly roleValidUntil: string;
  readonly fields: readonly IssueFormField[];
}

export interface IssueRequest {
  readonly type: string;
  /** The person's did:webvh, as they copy it from their own identity. */
  readonly subject: string;
  /** The person's name as the officer knows them: shown in the review sentence and the officer's lists, never signed. */
  readonly personName: string;
  /** The type's own claims (for a clearance: scale and atLeast). */
  readonly claims: Readonly<Record<string, string>>;
  /** The last day, YYYY-MM-DD; the credential holds through that day, UTC. */
  readonly until: string;
  /** inbox: the person's wallet inbox in your organization's secret store; file: a .near-vc file for a single computer. */
  readonly delivery: 'inbox' | 'file';
}

/** What the review step shows before the step-up: exactly what will be signed, in one sentence. */
export interface IssueReview {
  readonly sentence: string;
}

export interface IssuedCredentialFile {
  /** Ends in .near-vc, never confused with ~/.near-credentials (NEAR account keys). */
  readonly fileName: string;
  readonly text: string;
}

export interface IssueResult {
  /** The credential hash (D-05): how the officer's lists and the person's wallet name it. */
  readonly hash: string;
  readonly delivered: 'inbox' | 'file';
  readonly file?: IssuedCredentialFile;
  readonly sentence: string;
}

/** A credential the officer issued, as their lists show it. */
export interface IssuedCredentialView {
  readonly hash: string;
  readonly type: string;
  readonly label: string;
  readonly personName: string;
  readonly validUntil: string;
  /** Unknown when your organization's server could not be asked. */
  readonly state: 'active' | 'suspended' | 'revoked' | 'unknown';
  /** The review sentence of each action, read before the step-up. */
  readonly reviews: { readonly revoke: string; readonly suspend: string; readonly lift: string };
}

export type RevocationReason = 'disabled' | 'removed' | 'guest-ended';

/** One open revocation request (D-22), with only the credentials this officer issued to that person. */
export type RevocationRequestView =
  | {
    readonly id: string;
    readonly current: true;
    readonly personName: string;
    readonly reason: string;
    readonly reasonText: string;
    readonly seenAt: string;
    readonly credentials: readonly IssuedCredentialView[];
  }
  | { readonly id: string; readonly current: false; readonly message: string };

export interface IssuerServiceRpc {
  /** The types the officer's role credentials and your organization's rules allow now, each with its form. */
  issuableTypes(): Promise<ServiceResult<readonly IssuableType[]>>;
  /** The review sentence, or the form's first refusal; signs nothing. */
  review(request: IssueRequest): Promise<ServiceResult<IssueReview>>;
  issue(request: IssueRequest): Promise<ServiceResult<IssueResult>>;
  /** The credentials this officer issued. */
  listIssued(): Promise<ServiceResult<readonly IssuedCredentialView[]>>;
  revoke(hash: string): Promise<ServiceResult<IssuedCredentialView>>;
  suspend(hash: string): Promise<ServiceResult<IssuedCredentialView>>;
  clearSuspension(hash: string): Promise<ServiceResult<IssuedCredentialView>>;
  listRevocationRequests(): Promise<ServiceResult<readonly RevocationRequestView[]>>;
  /** Removes a request once every credential issued to that person, by any officer, is revoked or suspended. */
  resolveRequest(id: string): Promise<ServiceResult<{ readonly removed: boolean; readonly remaining: number }>>;
}

/** Every sentence the issuer service answers with (D-21): plain, "your organization", none quotes a DID, a key, an index or a token. */
export const ISSUER_TEXT = {
  notSetUp: 'Issuing credentials is not set up in this session yet. Ask your organization\'s security officer.',
  noRules: 'Your organization\'s credential rules are not available in this session yet, so nothing can be issued or revoked.',
  noServer: 'Your organization\'s server cannot be reached from this session, so status lists cannot be read or changed. Try again later.',
  noIdentity: 'Your own identity is not set up yet, so you cannot issue credentials.',
  personOnly: 'Credentials are issued by a person in their own session. An agent or an unattended run cannot issue, revoke or suspend them.',
  stepUp: 'Issuing, revoking and suspending need a fresh confirmation with your passkey or security key.',
  confirm: 'Confirm with your passkey or security key',
  notOfficer: 'Your organization has not named you as a credential officer, so you cannot sign status lists.',
  notAPerson: 'Credentials are issued to a person\'s identity only, never to a computer or an agent.',
  unknownPerson: 'This person is not in your organization\'s people directory yet. They appear after their first sign-in, or you can deliver a file.',
  badRequest: 'This form is not complete. Check each field and try again.',
  noRole: 'You do not hold a current role that allows issuing this credential.',
  noIndex: 'A status list place could not be reserved for this credential. Try again.',
  listChanged: 'Another officer changed the status list at the same moment. Nothing was changed; try again.',
  listRefused: 'Your organization\'s server did not accept the new status list. Nothing was changed.',
  unknownCredential: 'This credential is not in your organization\'s register of issued credentials.',
  revocationFinal: 'This credential is revoked. A revocation can never be undone.',
  notSuspended: 'This credential is not suspended.',
  storeDown: 'Your organization\'s secret store did not answer. Try again, or ask your administrator.',
  newerRequest: 'This request was written by a newer version.',
  issuedInbox: 'Issued. It reaches the person\'s wallet at their next sign-in.',
  issuedFile: 'Issued. Give the person the file for their computer.',
  noRequest: 'This revocation request is no longer open.',
} as const;

/** The reasons 47-20 and 47-31 write, in plain words. */
export const REVOCATION_REASON_TEXT: Readonly<Record<RevocationReason, string>> = {
  disabled: 'disabled in sign-in',
  removed: 'removed',
  'guest-ended': 'guest access ended early',
};

/** The inbox pickup at session start (D-15): one sentence, or none when nothing arrived. */
export const INBOX_TEXT = {
  arrived: (labels: readonly string[]): string => `Your wallet received ${labels.length === 1 ? 'a credential' : `${String(labels.length)} credentials`}: ${labels.join(', ')}.`,
  refused: (count: number): string => `${count === 1 ? 'A credential' : `${String(count)} credentials`} sent to you did not check, so ${count === 1 ? 'it was' : 'they were'} not added to your wallet. Tell your organization's security officer.`,
  unchecked: 'Credentials sent to you cannot be checked in this session yet, so they wait until they can.',
} as const;
