// Ask to join (G-61-9): an invite in reverse. Declared only; the behaviour lands with the tracer's GREEN step.
import type { TeamFile, TeamState } from '../domain/team/types';
import type { SecretStorageLike } from '../services/auth';
import type { InviteInput } from './invite';
import type { JoinInput, JoinResult } from './join';

export const JOIN_REQUEST_PREFIX = 'near-ai-join-request-v1.';

export interface JoinRequest { v: 1; team: string; ref: string; member: string; name: string; email?: string; key: string; sig: string }

export class JoinRequestError extends Error {}

export function parseJoinRequest(_text: string): JoinRequest {
  throw new JoinRequestError('not yet');
}

export function requestCheckCode(_request: JoinRequest): string {
  return '';
}

export async function createJoinRequest(_input: { secrets: SecretStorageLike; teamFile: TeamFile; name: string; email?: string }): Promise<{ text: string; checkCode: string; memberId: string }> {
  return { text: '', checkCode: '', memberId: '' };
}

export async function readPendingRequest(_secrets: SecretStorageLike, _teamId: string): Promise<{ text: string; checkCode: string; memberId: string; name: string } | undefined> {
  return undefined;
}

export async function cancelJoinRequest(_secrets: SecretStorageLike, _teamId: string): Promise<void> {
  return undefined;
}

export type AcceptResult =
  | { ok: true; memberId: string; nearInvitation: 'sent' | 'already-member' | 'queued' | 'not-applicable'; notice?: string }
  | { ok: false; code: 'refused' | 'conflict' | 'offline'; message: string };

export async function acceptJoinRequest(_input: Omit<InviteInput, 'name' | 'email'> & { request: JoinRequest; email: string }): Promise<AcceptResult> {
  return { ok: false, code: 'refused', message: 'not yet' };
}

export async function wasAcceptedHere(_storageDir: string, _memberId: string): Promise<boolean> {
  return false;
}

export type CompleteOutcome =
  | { kind: 'none' }
  | { kind: 'not-yet' }
  | { kind: 'joined'; result: Extract<JoinResult, { ok: true }> }
  | { kind: 'expired' | 'cancelled' | 'used' | 'failed'; message: string };

export async function completeJoinRequest(_input: Omit<JoinInput, 'bundle' | 'displayName'> & { state: TeamState }): Promise<CompleteOutcome> {
  return { kind: 'none' };
}
