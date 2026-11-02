// The removed member's own machine (TEAM-03, D-20). Placeholder for the failing-test commit; the real cleanup follows.
import type { SecretStorageLike } from '../services/auth';
import type { FetchLike } from '../services/reportingSignIn';
import type { TeamFile } from '../domain/team/types';

export const REMOVED_FILE = 'removed.json';

export function removedText(teamName: string): string {
  return `You were removed from ${teamName}.`;
}

export interface OwnRemovalInput { projectRoot: string; globalStorageDir: string; teamFile: TeamFile; memberId: string; removedEvent: string; secrets: SecretStorageLike; nearBaseUrl?: string; fetch?: FetchLike }

export async function handleOwnRemoval(_input: OwnRemovalInput): Promise<{ restoredProfileId?: string; removedSecrets: string[] }> {
  return { removedSecrets: [] };
}

export async function readRemovedMarker(_globalStorageDir: string, _teamId: string): Promise<{ memberId: string; removedEvent: string } | undefined> {
  return undefined;
}
