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
export type IdentityStatus =
  | { readonly state: 'not-configured' }
  | { readonly state: 'pending'; readonly message: string; readonly action: string }
  | { readonly state: 'ready'; readonly did: string; readonly published: boolean };

export interface BoundComputerFile {
  /** A file name ending in .near-vc, never confused with ~/.near-credentials (NEAR account keys). */
  readonly fileName: string;
  /** The signed DeviceBindingCredential, JSON. Not secret, but it is the person's. */
  readonly text: string;
}

export interface IdentityServiceRpc {
  status(): Promise<IdentityStatus>;
  retry(): Promise<IdentityStatus>;
  bindComputer(didKey: string, words: string, deviceClass: DeviceClass): Promise<ServiceResult<BoundComputerFile>>;
}

/** Every sentence the identity service shows (D-21): plain, "your organization", nothing that asks for a credential. */
export const IDENTITY_TEXT = {
  notSetUp: 'Your identity is not set up yet.',
  retry: 'Retry',
  wordsDiffer: 'The six words do not match the ones the computer shows. Check that you are binding the right computer.',
  notADevice: 'This is not a computer\'s identity. Copy it again from the Show This Computer\'s Identity command.',
  noStatusLists: 'Binding a computer needs your organization\'s status lists, which are not set up yet. Ask your organization\'s security officer.',
  notPublished: 'Your organization\'s server did not take your identity. It is sent again at your next session.',
} as const;
