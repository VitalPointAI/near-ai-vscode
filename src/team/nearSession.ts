// Stub for the RED commit: the interface exists, the behaviour does not yet.
import type { SecretStorageLike } from '../services/auth';
import type { FetchLike, SessionTokens } from '../services/reportingSignIn';
import type { NearAuth } from './nearOrg';

export const NEAR_SESSION_SECRET_PREFIX = 'nearAi.team.nearSession.';
export function nearSessionSecretName(teamId: string): string { return `${NEAR_SESSION_SECRET_PREFIX}${teamId}`; }
export class NearSessionError extends Error { public constructor(public readonly code: 'signed-out' | 'expired' | 'unavailable', message: string) { super(message); } }
export interface NearSessionOptions { teamId: string; secrets: SecretStorageLike; baseUrl: string; fetch?: FetchLike; now?: () => number; initialAccessToken?: string }
export class NearSession implements NearAuth {
  public constructor(_options: NearSessionOptions) { /* not implemented */ }
  public async signedIn(): Promise<{ label: string } | undefined> { throw new Error('not implemented'); }
  public async accessToken(): Promise<string> { throw new Error('not implemented'); }
  public async refreshAfterUnauthorized(): Promise<string | undefined> { throw new Error('not implemented'); }
  public async signOut(): Promise<{ serverConfirmed: boolean }> { throw new Error('not implemented'); }
}
export async function saveNearSession(_secrets: SecretStorageLike, _teamId: string, _tokens: SessionTokens, _label: string, _extra: Partial<NearSessionOptions> = {}): Promise<NearSession> { throw new Error('not implemented'); }
