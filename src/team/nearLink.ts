// Linking a team to a NEAR organization and workspace (D-03): the lead picks from lists, the choice is written to team.json as
// near: {organizationId, workspaceId}, and only that file is committed, through the same helper Enable uses. Nothing here pushes;
// the caller offers Push. team.json is untrusted input for every other client, so this module only ever offers organizations where the
// signed-in lead is owner or admin, and writes ids, never a name, token or key. This module never imports vscode.
import { SecretLeakError } from '../domain/team/secrets';
import type { NearLink, TeamFile } from '../domain/team/types';
import { commitTeamFileOnly } from './enable';
import type { NearOrgClient, NearOrganization, NearWorkspace } from './nearOrg';
import { runGit } from './runGit';
import type { GitRunner } from './runGit';
import { TEAM_FILE_REL, TeamFileError, TrustPinError, checkTrustPin, readTeamFile, teamStorageDir, writeTeamFile } from './teamFile';

const LOCAL_TIMEOUT_MS = 30_000;

export const LINK_COMMIT_MESSAGE = 'chore(team): link NEAR organization';

export type LinkResult =
  | { ok: true; status: 'linked' | 'unchanged'; teamFile: TeamFile; branch?: string; commit?: string }
  | { ok: false; code: 'different-link' | 'team-file' | 'commit-failed'; message: string };

export interface LinkChoice { organization: NearOrganization; workspaces: NearWorkspace[] }

// Only an owner or admin can invite people and create keys in an organization, so only those organizations are worth linking.
export async function linkChoices(org: NearOrgClient): Promise<LinkChoice[]> {
  const organizations = await org.listOrganizations();
  const choices: LinkChoice[] = [];
  for (const organization of organizations) {
    if (organization.role !== 'owner' && organization.role !== 'admin') continue;
    choices.push({ organization, workspaces: await org.listWorkspaces(organization.id) });
  }
  return choices;
}

function fail(code: 'different-link' | 'team-file' | 'commit-failed', message: string): { ok: false; code: 'different-link' | 'team-file' | 'commit-failed'; message: string } {
  return { ok: false, code, message };
}

function sameLink(a: NearLink | undefined, b: NearLink): boolean {
  return a !== undefined && a.organizationId === b.organizationId && a.workspaceId === b.workspaceId;
}

export async function linkNearOrganization(input: { projectRoot: string; globalStorageDir: string; teamId: string; near: NearLink; replace?: boolean; git?: GitRunner }): Promise<LinkResult> {
  const git = input.git ?? runGit;
  let existing: TeamFile | undefined;
  try {
    existing = await readTeamFile(input.projectRoot);
  } catch (error) {
    if (error instanceof TeamFileError) return fail('team-file', `${error.message} Nothing was changed.`);
    throw error;
  }
  if (existing === undefined) return fail('team-file', `This project has no ${TEAM_FILE_REL}, so there is no team to link. Nothing was changed.`);
  if (existing.teamId !== input.teamId) return fail('team-file', `${TEAM_FILE_REL} names a different team than the one you chose to link. Nothing was changed.`);
  if (sameLink(existing.near, input.near)) return { ok: true, status: 'unchanged', teamFile: existing };
  if (existing.near !== undefined && input.replace !== true) {
    return fail('different-link', 'This team is already linked to a different NEAR organization or workspace. Nothing was changed. Replace the link only if your team agrees.');
  }

  const linked: TeamFile = { ...existing, near: { organizationId: input.near.organizationId, workspaceId: input.near.workspaceId } };
  try {
    // The pin is checked before the file changes, so a file that names a different team or owner key is never overwritten.
    await checkTrustPin(teamStorageDir(input.globalStorageDir, existing.teamId), linked);
    await writeTeamFile(input.projectRoot, linked);
  } catch (error) {
    if (error instanceof TeamFileError || error instanceof TrustPinError || error instanceof SecretLeakError) return fail('team-file', `${error.message} Nothing was changed.`);
    throw error;
  }

  const committed = await commitTeamFileOnly(input.projectRoot, LINK_COMMIT_MESSAGE, git);
  if (!committed.ok) return fail('commit-failed', `The NEAR link was saved in ${TEAM_FILE_REL}, but ${committed.message}`);
  const result: LinkResult = { ok: true, status: 'linked', teamFile: linked, commit: committed.commit };
  if (committed.branch !== undefined) result.branch = committed.branch;
  return result;
}

// Does the committed team.json differ from the upstream branch? An invitee who clones now would not see a NEAR link that is still only
// local (research Pitfall 11), so the invite command warns on true. 'unknown' when there is no upstream or git cannot answer.
export async function teamFileUnpushed(projectRoot: string, git: GitRunner = runGit): Promise<boolean | 'unknown'> {
  const upstream = await git(['rev-parse', '--verify', '-q', '@{u}'], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  if (upstream.code !== 0) return 'unknown';
  const diff = await git(['diff', '--quiet', '@{u}', 'HEAD', '--', TEAM_FILE_REL], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  if (diff.code === 0) return false;
  return diff.code === 1 ? true : 'unknown';
}
