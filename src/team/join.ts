// The invitee's side of joining a team (TEAM-02, D-07, D-21 to D-23, D-26). RED stub: the signatures exist so the tests compile and fail on
// their assertions; the behaviour arrives with the next commit. This module never imports vscode.
import type { NearLink, Role, TeamFile } from '../domain/team/types';
import type { SecretStorageLike } from '../services/auth';
import type { FetchLike, SessionTokens } from '../services/reportingSignIn';
import type { GitRunner } from './runGit';
import type { InviteBundle } from './inviteBundle';

export const NO_ORG_NOTICE = 'No NEAR organization linked: spend is not capped at the provider.';

export type JoinPreparation =
  | { kind: 'ready'; bundle: InviteBundle; teamFile: TeamFile; near?: NearLink }
  | { kind: 'clone-needed'; repoUrl: string; teamId: string }
  | { kind: 'refused'; message: string };

export async function prepareJoin(_input: { projectRoot: string | undefined; bundleText: string }): Promise<JoinPreparation> {
  return { kind: 'refused', message: 'not implemented' };
}

export interface JoinInput {
  projectRoot: string;
  globalStorageDir: string;
  teamFile: TeamFile;
  bundle: InviteBundle;
  near?: NearLink;
  secrets: SecretStorageLike;
  displayName: string;
  nearBaseUrl?: string;
  fetch?: FetchLike;
  git?: GitRunner;
  now?: () => number;
  signIn?: () => Promise<SessionTokens | undefined>;
  askInvitationLink?: () => Promise<string | undefined>;
  pasteOwnKey?: () => Promise<string | undefined>;
}

export type JoinResult =
  | {
    ok: true; memberId: string; role: Role; pendingRole?: Role; key: 'awaiting-lead' | 'installed' | 'skipped' | 'not-applicable';
    nearInvitation?: 'accepted' | 'already-member' | 'not-found' | 'failed' | 'skipped'; notices: string[];
  }
  | {
    ok: false;
    code: 'not-invited' | 'cancelled' | 'used' | 'expired' | 'wrong-code' | 'already-has-key' | 'team-file' | 'offline' | 'conflict' | 'invalid-name';
    message: string;
  };

export async function joinTeam(_input: JoinInput): Promise<JoinResult> {
  return { ok: false, code: 'conflict', message: 'not implemented' };
}
