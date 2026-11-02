// The invitee's side of joining a team (TEAM-02, D-07, D-09, D-21 to D-23, D-26). prepareJoin reads the pasted bundle and says whether the open
// project is the team's project or has to be cloned first. joinTeam then checks the invitation read-only, makes this device's two keys, and
// writes member.joined; the bundle and its code live only in the arguments of one call and are written nowhere. A developer, reviewer or
// observer never signs in to NEAR here (D-21): their team key is made and sent by the lead's client on confirmation. This module never imports vscode.
import * as path from 'node:path';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { Member, MemberInvite, NearLink, Role, TeamFile, TeamState } from '../domain/team/types';
import { expectedJoinRole, inviteExpired, joinProofBytes } from '../domain/team/invite';
import { teamMaterializer } from '../domain/team/materialize';
import { validateName } from '../domain/team/validate';
import type { SecretStorageLike } from '../services/auth';
import type { FetchLike, SessionTokens } from '../services/reportingSignIn';
import { TeamLog } from './eventLog';
import { GitTransport } from './gitTransport';
import { createDeviceIdentity, createSealIdentity, loadDeviceIdentity, loadSealIdentity } from './identity';
import { InviteBundleError, parseInviteBundle } from './inviteBundle';
import type { InviteBundle } from './inviteBundle';
import { deriveInviteKey, inviteKeyMatches, parseInviteCode } from './inviteCode';
import { redactGitMessage } from './runGit';
import type { GitRunner } from './runGit';
import { TeamFileError, TrustPinError, checkTrustPin, readTeamFile, teamStorageDir } from './teamFile';

export const NO_ORG_NOTICE = 'No NEAR organization linked: spend is not capped at the provider.';

const R = TEAM_REJECTION_REASONS;

export type JoinPreparation =
  | { kind: 'ready'; bundle: InviteBundle; teamFile: TeamFile; near?: NearLink }
  | { kind: 'clone-needed'; repoUrl: string; teamId: string }
  | { kind: 'refused'; message: string };

function sameNear(left: NearLink, right: NearLink): boolean {
  return left.organizationId === right.organizationId && left.workspaceId === right.workspaceId;
}

// D-07 and D-26: nothing is kept between this call and the next. After a clone the invitee pastes the bundle again, so the answer here depends on
// the folder that is open right now and on the bundle in this call only. Nothing in a refusal repeats the pasted text.
export async function prepareJoin(input: { projectRoot: string | undefined; bundleText: string }): Promise<JoinPreparation> {
  let bundle: InviteBundle;
  try {
    bundle = parseInviteBundle(input.bundleText);
  } catch (error) {
    if (error instanceof InviteBundleError) return { kind: 'refused', message: error.message };
    throw error;
  }
  let teamFile: TeamFile | undefined;
  if (input.projectRoot !== undefined) {
    try {
      teamFile = await readTeamFile(input.projectRoot);
    } catch (error) {
      if (error instanceof TeamFileError) return { kind: 'refused', message: `${error.message} Nothing was changed.` };
      throw error;
    }
  }
  if (teamFile === undefined || teamFile.teamId !== bundle.team) return { kind: 'clone-needed', repoUrl: bundle.repo, teamId: bundle.team };
  if (teamFile.coordination.ref !== bundle.ref) {
    return { kind: 'refused', message: 'This invite names a different coordination branch than this project does. Ask your lead for a new invite.' };
  }
  if (teamFile.near !== undefined && bundle.near !== undefined && !sameNear(teamFile.near, bundle.near)) {
    return { kind: 'refused', message: 'This invite names a different NEAR organization than this project does. Ask your lead to check the link and send a new invite.' };
  }
  const near = teamFile.near ?? bundle.near;
  return { kind: 'ready', bundle, teamFile, ...(near === undefined ? {} : { near }) };
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
  // Used only when the invited role is lead and the team has a NEAR organization (D-22).
  signIn?: () => Promise<SessionTokens | undefined>;
  // The emailed link or token, asked only when the signed-in NEAR login has no matching invitation.
  askInvitationLink?: () => Promise<string | undefined>;
  // Used only when the team has no NEAR organization (D-04, D-21).
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

type JoinFailure = Extract<JoinResult, { ok: false }>;

function fail(code: JoinFailure['code'], message: string): JoinFailure {
  return { ok: false, code, message };
}

const ALREADY_HAS_KEY = 'This computer already has a team key from an earlier Join, either one that worked or one that was interrupted. If you are not on the team list, ask your lead to re-issue your invitation and clear the old key before you join again.';

type Standing =
  | { ok: true; member: Member; invite: MemberInvite }
  | { ok: false; code: 'not-invited' | 'cancelled' | 'used'; message: string };

// D-10: an invitation is cancelled by removing its member, and used once the member has joined (status leaves invited).
function standingOf(state: TeamState, memberId: string): Standing {
  const member = state.members.get(memberId);
  if (member === undefined || member.invitedEvent === undefined || member.invite === undefined) {
    return { ok: false, code: 'not-invited', message: 'This invitation is not on the team list. Ask your lead to send a new one.' };
  }
  if (member.status === 'invited' && member.removedEvent !== undefined) {
    return { ok: false, code: 'cancelled', message: 'This invitation was cancelled. Ask your lead to send a new one.' };
  }
  if (member.status !== 'invited') {
    return { ok: false, code: 'used', message: 'This invitation was already used. Ask your lead to send a new one if that was not you.' };
  }
  return { ok: true, member, invite: member.invite };
}

function describe(error: unknown): string {
  return redactGitMessage(error instanceof Error ? error.message : String(error));
}

const AWAITING_LEAD = 'The lead sends your team key from their NEAR AI window once you are confirmed. You do not sign in to NEAR.';

export async function joinTeam(input: JoinInput): Promise<JoinResult> {
  const { teamFile, bundle, secrets } = input;
  const teamId = teamFile.teamId;
  const now = input.now ?? ((): number => Date.now());
  if (bundle.team !== teamId) return fail('team-file', 'This invite is for a different team than the one open in this project.');
  const displayName = input.displayName.trim();
  if (validateName(displayName, 'displayName') !== undefined) return fail('invalid-name', 'Your display name must be 1 to 80 characters with no line breaks.');

  let storageDir: string;
  try {
    storageDir = teamStorageDir(input.globalStorageDir, teamId);
    await checkTrustPin(storageDir, teamFile);
  } catch (error) {
    if (error instanceof TrustPinError || error instanceof TeamFileError) return fail('team-file', error.message);
    throw error;
  }

  let hasKey: boolean;
  try {
    hasKey = (await loadDeviceIdentity(secrets, teamId)) !== undefined || (await loadSealIdentity(secrets, teamId)) !== undefined;
  } catch {
    // A stored key that cannot be read is still a key this computer holds for the team.
    hasKey = true;
  }
  if (hasKey) return fail('already-has-key', ALREADY_HAS_KEY);

  const anchor = { teamId, eventId: teamFile.genesis.eventId, ownerDevice: { ...teamFile.genesis.ownerDevice } };
  const transport = new GitTransport<TeamState>({
    mirrorDir: path.join(storageDir, 'coordination.git'), projectRoot: input.projectRoot, remote: teamFile.coordination.remote, ref: teamFile.coordination.ref,
    materializer: teamMaterializer(anchor), now, ...(input.git === undefined ? {} : { git: input.git })
  });
  // No signer: this device has no key yet, so the log can be read and the one join event written, nothing else.
  const log = new TeamLog({ anchor, transport });
  try {
    await log.sync();
  } catch (error) {
    return fail('offline', `The team log could not be read: ${describe(error)}`);
  }
  const status = log.status();
  if (status.state === 'offline') return fail('offline', `The team log could not be reached: ${redactGitMessage(status.reason ?? 'the remote did not answer')}`);
  if (status.state === 'paused') return fail('team-file', redactGitMessage(status.reason ?? R.logRewritten));
  if (log.state().refused !== undefined) return fail('team-file', redactGitMessage(log.state().refused ?? R.logRefused));

  const standing = standingOf(log.state(), bundle.member);
  if (!standing.ok) return fail(standing.code, standing.message);
  const { invite } = standing;

  const codeBytes = parseInviteCode(bundle.code);
  if (codeBytes === undefined) return fail('wrong-code', 'The code in this invite is not valid. Paste the whole invite exactly as you were sent it.');
  try {
    if (!inviteKeyMatches(codeBytes, teamId, bundle.member, invite.publicKey)) {
      return fail('wrong-code', 'The code in this invite does not match the team record. Paste the whole invite exactly as you were sent it, or ask for a new one.');
    }
    // Only an early answer for the person at the keyboard: the materialiser decides from commit times when the join is read.
    if (inviteExpired(invite.commitTime, invite.ttlSeconds, Math.floor(now() / 1000))) return fail('expired', 'This invitation has expired. Ask your lead to send a new one.');

    const identity = await createDeviceIdentity(secrets, teamId);
    const seal = await createSealIdentity(secrets, teamId);
    const device = { fingerprint: identity.fingerprint, publicKey: identity.publicKey };
    const proofKey = deriveInviteKey(codeBytes, teamId, bundle.member);
    const appended = await log.appendJoin(identity, (state) => {
      // Read again from the freshest state: a lost race, a cancel or a second device shows up here.
      const fresh = standingOf(state, bundle.member);
      if (!fresh.ok) return { conflict: R.notInvited };
      const pending = fresh.member.pendingRole ?? 'observer';
      const role = expectedJoinRole(pending, state.team.policy);
      const sig = proofKey.sign(joinProofBytes(teamId, bundle.member, fresh.invite.eventId, device, seal.publicKey));
      return { memberId: bundle.member, name: displayName, emailHashes: [...fresh.member.emailHashes], role, device, invite: { sig }, sealKey: { publicKey: seal.publicKey } };
    });
    if (!appended.ok) return fail('conflict', redactGitMessage(appended.reason));
  } finally {
    // The clear code is not needed again once the proof is signed.
    codeBytes.fill(0);
  }

  const member = log.state().members.get(bundle.member);
  const role: Role = member?.role ?? 'observer';
  const pendingRole = member?.pendingRole;
  const notices: string[] = [];
  const near = input.near ?? teamFile.near;
  if (near !== undefined) notices.push(AWAITING_LEAD);
  return { ok: true, memberId: bundle.member, role, ...(pendingRole === undefined ? {} : { pendingRole }), key: near === undefined ? 'skipped' : 'awaiting-lead', notices };
}
