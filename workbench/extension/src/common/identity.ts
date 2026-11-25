/**
 * The identity service's browser-facing shape (Phase 71, 71-10; D-13, VCRD-06): the person's own did:webvh and binding a single computer to
 * them. Plain data only: never a key, a token, an entity id or a DID log. Nothing here imports Theia.
 */
import type { ServiceResult } from './service-result.js';

export const IDENTITY_SERVICE_PATH = '/services/sterling-identity';
export const IdentityServiceRpc = Symbol('IdentityServiceRpc');

export type DeviceClass = 'personal' | 'managed';

/**
 * - not-configured: this session has no identity setting (a single computer, or a site without STERLING_DID_DOMAIN); nothing is made.
 * - pending: the identity could not be made yet (no fresh sign-in, or your organization's secret store did not answer); Retry.
 * - ready: the person's DID exists. `published` says whether your organization's server has it yet; it is posted at the person's first
 *   session with that server (owner decision A, 2026-11-24).
 */
export type IdentityStatus = (
  | { readonly state: 'not-configured' }
  | { readonly state: 'pending'; readonly message: string; readonly action: string }
  | { readonly state: 'ready'; readonly did: string; readonly published: boolean }
) & {
  /** The session's credential check (71-13, D-18), present while your organization's rules carry credentials@1. */
  readonly credentials?: CredentialCheckStatus;
};

/**
 * The session's credential check (Phase 71, D-18): fresh; stale (past the time to live: protected actions are refused until Retry); unavailable (a
 * needed log or list cannot be read: connect to your organization's server, then Retry). `action` is the button word when there is one.
 */
export interface CredentialCheckStatus {
  readonly state: 'fresh' | 'stale' | 'unavailable';
  readonly message: string;
  readonly action?: string;
}

export interface BoundComputerFile {
  /** A file name ending in .near-vc, never confused with ~/.near-credentials (NEAR account keys). */
  readonly fileName: string;
  /** The signed DeviceBindingCredential, JSON. Not secret, but it is the person's. */
  readonly text: string;
}

/** A computer bound to the person (D-25): its slot (1 to 5), its fingerprint (dev-…), and when its slot was claimed. */
export interface BoundComputer {
  readonly slot: number;
  readonly device: string;
  readonly claimedAt: string;
}

export interface IdentityServiceRpc {
  status(): Promise<IdentityStatus>;
  retry(): Promise<IdentityStatus>;
  bindComputer(didKey: string, words: string, deviceClass: DeviceClass): Promise<ServiceResult<BoundComputerFile>>;
  /** What arrived in the person's wallet at this session's start (71-12): sentences to show once; empty when nothing did. */
  inboxNews(): Promise<readonly string[]>;
  /** The person's bound computers (D-25): each slot with the computer's fingerprint and when it was bound. */
  computers(): Promise<ServiceResult<readonly BoundComputer[]>>;
  /** Files a lost-computer request in your organization's revocation inbox; an officer revokes that binding. */
  reportLostComputer(slot: number): Promise<ServiceResult<{ readonly filed: boolean }>>;
}

/** Every sentence the identity service shows (D-21): plain, "your organization", nothing that asks for a credential. */
export const IDENTITY_TEXT = {
  notSetUp: 'Your identity is not set up yet.',
  retry: 'Retry',
  wordsDiffer: 'The six words do not match the ones the computer shows. Check that you are binding the right computer.',
  notADevice: 'This is not a computer\'s identity. Copy it again from the Show This Computer\'s Identity command.',
  noStatusLists: 'Binding a computer needs your organization\'s status lists, which are not set up yet. Ask your organization\'s security officer.',
  tooManyComputers: 'You already have 5 computers bound. Report one as lost, and once your organization\'s security officer revokes it you can bind another.',
  noComputer: 'There is no computer bound in that place.',
  lostFiled: 'Reported. Your organization\'s security officer revokes that computer\'s binding; until then it can still open what it holds offline.',
  lostAlready: 'That computer is already reported as lost.',
  notPublished: 'Your organization\'s server did not take your identity. It is sent again at your next session.',
  checkStale: 'Your access needs a fresh check',
  checkUnavailable: 'Your access cannot be checked',
  checkAgain: 'Check My Access Again',
} as const;
