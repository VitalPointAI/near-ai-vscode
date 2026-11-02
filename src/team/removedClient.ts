// The removed member's own machine (TEAM-03, D-20). When this computer's client sees its own member.removed it forgets exactly this team's
// secrets in VS Code SecretStorage (the device key, the seal key, the NEAR session and the team API key profile), selects the member's
// personal profile again when one is left, and writes removed.json so a restart shows "removed" instead of retrying. Nothing else is touched:
// not the project's code, branches, stash or working tree, not another team's entries, and nothing outside SecretStorage and the team's own
// storage folder. A failed step is reported by name and never stops the others, because a removed member's machine must end up cleaned.
// This module never imports vscode.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EVENT_ID_PATTERN, MEMBER_ID_PATTERN } from '../domain/team/validate';
import type { TeamFile } from '../domain/team/types';
import { AuthService } from '../services/auth';
import type { SecretStorageLike } from '../services/auth';
import { ProfileStore } from '../services/profileStore';
import type { FetchLike } from '../services/reportingSignIn';
import { deviceKeySecretName, forgetDeviceIdentity, sealKeySecretName } from './identity';
import { NearSession, nearSessionSecretName } from './nearSession';
import { runSerialised, teamStorageDir, writeFileAtomic } from './teamFile';
import { removeTeamKey, teamProfileId } from './teamKeyProfile';

export const REMOVED_FILE = 'removed.json';

export function removedText(teamName: string): string {
  // eslint-disable-next-line no-control-regex
  const name = teamName.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || 'the team';
  return `You were removed from ${name}. Team sync has stopped; your code and branches are unchanged.`;
}

export interface OwnRemovalInput {
  projectRoot: string;
  globalStorageDir: string;
  teamFile: TeamFile;
  memberId: string;
  /** The id of the member.removed event this client saw. */
  removedEvent: string;
  secrets: SecretStorageLike;
  /** NEAR AI Cloud's address, so a kept NEAR session can be ended there; without it the session is only forgotten here. */
  nearBaseUrl?: string;
  fetch?: FetchLike;
}

export interface OwnRemovalResult {
  restoredProfileId?: string;
  /** What was deleted from SecretStorage: secret names, and the team key profile by its profile id. */
  removedSecrets: string[];
  /** Cleanup steps that failed (named, never with a value); present only when something failed. */
  failed?: string[];
}

export interface RemovedMarker { memberId: string; removedEvent: string }

// What a damaged marker reads as: still removed. The values match no member or event, so nothing is ever mistaken for the real removal.
const UNREADABLE_MARKER: RemovedMarker = { memberId: 'unreadable', removedEvent: 'unreadable' };

function markerPath(globalStorageDir: string, teamId: string): string {
  return path.resolve(teamStorageDir(globalStorageDir, teamId), REMOVED_FILE);
}

/**
 * The marker this computer wrote when it saw its own removal, or undefined when it has none. A marker that is there but cannot be read exactly
 * as written still means removed (the machine fails closed rather than syncing again).
 */
export async function readRemovedMarker(globalStorageDir: string, teamId: string): Promise<RemovedMarker | undefined> {
  let text: string;
  try {
    text = await fs.readFile(markerPath(globalStorageDir, teamId), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : UNREADABLE_MARKER;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return UNREADABLE_MARKER;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return UNREADABLE_MARKER;
  const fields = parsed as Record<string, unknown>;
  const { memberId, removedEvent } = fields;
  if (Object.keys(fields).length !== 2 || typeof memberId !== 'string' || typeof removedEvent !== 'string') return UNREADABLE_MARKER;
  if (!MEMBER_ID_PATTERN.test(memberId) || !EVENT_ID_PATTERN.test(removedEvent)) return UNREADABLE_MARKER;
  return { memberId, removedEvent };
}

// Ends the session at NEAR when there is an address to ask; whether NEAR heard it does not matter here, the caller deletes the secret anyway.
async function endSession(input: OwnRemovalInput): Promise<boolean> {
  if (input.nearBaseUrl === undefined) return false;
  try {
    const session = new NearSession({ teamId: input.teamFile.teamId, secrets: input.secrets, baseUrl: input.nearBaseUrl, ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
    return (await session.signOut()).serverConfirmed;
  } catch {
    return false;
  }
}

/**
 * Cleans this computer after the member's own removal. Safe to run again: a second run finds nothing to delete and writes the same marker.
 */
export async function handleOwnRemoval(input: OwnRemovalInput): Promise<OwnRemovalResult> {
  if (!MEMBER_ID_PATTERN.test(input.memberId) || !EVENT_ID_PATTERN.test(input.removedEvent)) {
    throw new RangeError('The removal names a member or event id that is not valid, so nothing was changed on this computer.');
  }
  const teamId = input.teamFile.teamId;
  const removedSecrets: string[] = [];
  const failed: string[] = [];
  let restoredProfileId: string | undefined;
  const present = async (name: string): Promise<boolean> => (await input.secrets.get(name)) !== undefined;

  // The NEAR session: ended at NEAR if possible, and its secret is deleted whatever NEAR answered.
  const sessionName = nearSessionSecretName(teamId);
  try {
    if (await present(sessionName)) {
      await endSession(input);
      await input.secrets.delete(sessionName);
      removedSecrets.push(sessionName);
    }
  } catch {
    failed.push('NEAR session');
  }

  // The team API key profile: the personal profile is selected again first, then the team profile and its key are removed.
  const profileId = teamProfileId(teamId);
  try {
    const store = new ProfileStore(input.projectRoot, new AuthService(input.secrets));
    const hadProfile = (await store.get(profileId)) !== undefined;
    const restored = await removeTeamKey({ projectRoot: input.projectRoot, globalStorageDir: input.globalStorageDir, teamId, secrets: input.secrets });
    restoredProfileId = restored.restoredProfileId;
    if (hadProfile) removedSecrets.push(`team API key profile ${profileId}`);
  } catch {
    failed.push('team API key profile');
  }

  // The device key and the seal key, each named only if it was there.
  try {
    const names = [deviceKeySecretName(teamId), sealKeySecretName(teamId)];
    const there: string[] = [];
    for (const name of names) if (await present(name)) there.push(name);
    await forgetDeviceIdentity(input.secrets, teamId);
    removedSecrets.push(...there);
  } catch {
    failed.push('device and seal keys');
  }

  // The marker comes last and is written whatever failed above, so the removed state survives a restart.
  const file = markerPath(input.globalStorageDir, teamId);
  const marker: RemovedMarker = { memberId: input.memberId, removedEvent: input.removedEvent };
  await runSerialised(file, () => writeFileAtomic(file, `${JSON.stringify(marker, null, 2)}\n`));

  return { ...(restoredProfileId === undefined ? {} : { restoredProfileId }), removedSecrets, ...(failed.length === 0 ? {} : { failed }) };
}
