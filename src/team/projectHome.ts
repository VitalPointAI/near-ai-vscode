// The project's online home (G-61-2, G-61-3): whether teammates can reach the team remote, and whether the team setup is on it.
// This module never imports vscode.
import type { TeamFile } from '../domain/team/types';
import type { GitRunner } from './runGit';

export type OnlineHome =
  | { kind: 'shareable'; remote: string }
  | { kind: 'no-remote'; remote: string }
  | { kind: 'local-only'; remote: string }
  | { kind: 'not-shareable'; remote: string; reason: string };

export interface ShareInput { projectRoot: string; teamFile: TeamFile; branch: string; git?: GitRunner }

export type SharedState =
  | { kind: 'shared' }
  | { kind: 'not-shared'; missing: 'branch' | 'team-file' | 'different-team-file' }
  | { kind: 'record-missing' }
  | { kind: 'not-reachable-by-teammates'; home: OnlineHome }
  | { kind: 'unknown'; detail: string };

export async function configuredRemoteUrl(_projectRoot: string, _remote: string, _git?: GitRunner): Promise<string> {
  throw new Error('not implemented');
}

export async function checkOnlineHome(_projectRoot: string, _remote: string, _git?: GitRunner): Promise<OnlineHome> {
  throw new Error('not implemented');
}

export async function teamSetupShared(_input: ShareInput): Promise<SharedState> {
  throw new Error('not implemented');
}
