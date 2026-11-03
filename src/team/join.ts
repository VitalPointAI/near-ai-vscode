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
import { DEFAULT_BASE_URL } from '../domain/config';
import type { SecretStorageLike } from '../services/auth';
import { SignInError } from '../services/reportingSignIn';
import type { FetchLike, SessionTokens } from '../services/reportingSignIn';
import { SecretLeakError } from '../domain/team/secrets';
import { TeamLog } from './eventLog';
import { GitTransport } from './gitTransport';
import { createDeviceIdentity, createSealIdentity, forgetDeviceIdentity, loadDeviceIdentity, loadSealIdentity } from './identity';
import type { DeviceIdentity } from './identity';
import { InviteBundleError, parseInviteBundle } from './inviteBundle';
import type { InviteBundle } from './inviteBundle';
import { deriveInviteKey, inviteKeyMatches, parseInviteCode } from './inviteCode';
import { NearOrgClient, scrubNearText } from './nearOrg';
import type { NearAuth, NearInvitation } from './nearOrg';
import { saveNearSession } from './nearSession';
import { redactGitMessage } from './runGit';
import type { GitRunner } from './runGit';
import { TeamFileError, TrustPinError, checkNearPin, checkTrustPin, readTeamFile, teamStorageDir } from './teamFile';
import { installTeamKey } from './teamKeyProfile';

export const NO_ORG_NOTICE = 'No organization linked, so everyone uses their own key and spending is not capped.';

const R = TEAM_REJECTION_REASONS;

export type JoinPreparation =
  | { kind: 'ready'; bundle: InviteBundle; teamFile: TeamFile; near?: NearLink }
  | { kind: 'clone-needed'; repoUrl: string; teamId: string }
  | { kind: 'refused'; message: string };

function sameNear(left: NearLink, right: NearLink): boolean {
  return left.organizationId === right.organizationId && left.workspaceId === right.workspaceId;
}

// WR-03: the bundle is plain base64url JSON with no MAC, so anyone who handles it can change its link. team.json is the only source of the
// link; a bundle link that team.json does not have is refused, never used.
const BUNDLE_LINK_NOT_IN_PROJECT = 'This invite names an organization, but this project has no organization link yet. Ask your lead to share the organization link with the team (or get the latest version of the project if they already did), then run "NEAR AI: Join Team" again. Nothing was changed.';
const JOIN_UNREACHABLE = 'The team could not be reached, so your join did not start. Check your internet connection and try again.';
const JOIN_PAUSED = 'Something unexpected changed in the shared team record, so joining is paused to protect the team. Ask your lead.';
const JOIN_REFUSED = 'The shared team record failed a safety check, so this computer cannot join it. Ask your lead.';
const DIFFERENT_LINK = 'This invite names a different organization than this project does. Ask your lead to check the link and send a new invite.';

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
    return { kind: 'refused', message: 'This invite is for a different copy of this project than the one that is open. Ask your lead for a new invite.' };
  }
  if (bundle.near !== undefined && teamFile.near === undefined) return { kind: 'refused', message: BUNDLE_LINK_NOT_IN_PROJECT };
  if (teamFile.near !== undefined && bundle.near !== undefined && !sameNear(teamFile.near, bundle.near)) return { kind: 'refused', message: DIFFERENT_LINK };
  const near = teamFile.near;
  return { kind: 'ready', bundle, teamFile, ...(near === undefined ? {} : { near }) };
}

export interface JoinInput {
  projectRoot: string;
  globalStorageDir: string;
  teamFile: TeamFile;
  bundle: InviteBundle;
  /** The link the invite named, only ever compared with team.json, never used in its place (WR-03). */
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
  /** Says which step is running, so the caller can show it (UI review issue 1). */
  onStep?: (step: JoinStep) => void;
}

export type JoinStep = 'check' | 'keys' | 'log' | 'near' | 'key';

export type JoinResult =
  | {
    ok: true; memberId: string; role: Role; pendingRole?: Role; key: 'awaiting-lead' | 'installed' | 'skipped' | 'not-applicable';
    nearInvitation?: 'accepted' | 'already-member' | 'not-found' | 'failed' | 'skipped'; notices: string[];
  }
  | {
    ok: false;
    code: 'not-invited' | 'cancelled' | 'used' | 'expired' | 'wrong-code' | 'already-has-key' | 'team-file' | 'offline' | 'conflict' | 'invalid-name';
    message: string;
    /** The technical reason (git, remote), for the output channel only. */
    detail?: string;
  };

type JoinFailure = Extract<JoinResult, { ok: false }>;

// `message` is what the person reads; `detail` is the technical reason, written only to the output channel (plain-language pass).
function fail(code: JoinFailure['code'], message: string, detail?: string): JoinFailure {
  return detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail };
}

const ALREADY_HAS_KEY = 'This computer already has a team key from an earlier Join, either one that worked or one that was interrupted. If you are not on the team list, ask your lead to re-issue your invitation and clear the old key before you join again.';

type Standing =
  | { ok: true; member: Member; invite: MemberInvite }
  | { ok: false; code: 'not-invited' | 'cancelled' | 'used'; message: string };

// D-10: an invitation is cancelled by removing its member, and used once the member has joined (status leaves invited).
function standingOf(state: TeamState, memberId: string): Standing {
  const member = state.members.get(memberId);
  if (member === undefined || member.invitedEvent === undefined) {
    return { ok: false, code: 'not-invited', message: 'This invitation is not on the team list. Ask your lead to send a new one.' };
  }
  if (member.status === 'invited' && member.removedEvent !== undefined) {
    return { ok: false, code: 'cancelled', message: 'This invitation was cancelled. Ask your lead to send a new one.' };
  }
  // A joined member keeps invitedEvent but drops the invite record, so "used" is read from the status before the record is needed.
  if (member.status !== 'invited') {
    return { ok: false, code: 'used', message: 'This invitation was already used. Ask your lead to send a new one if that was not you.' };
  }
  if (member.invite === undefined) {
    return { ok: false, code: 'not-invited', message: 'This invitation is not on the team list. Ask your lead to send a new one.' };
  }
  return { ok: true, member, invite: member.invite };
}

function describe(error: unknown): string {
  return redactGitMessage(error instanceof Error ? error.message : String(error));
}

// ---- undoing a join that did not happen ----------------------------------------------------------------------------------------------------

// Everything this call created before the write is the device key and the seal key; the NEAR session and the team key profile come only after a
// successful write, so a failed join has nothing else to undo. Every failure is returned as text, never dropped.
async function removeNewKeys(secrets: SecretStorageLike, teamId: string): Promise<string> {
  try {
    await forgetDeviceIdentity(secrets, teamId);
    return '';
  } catch (error) {
    return ` The new keys on this computer could not be removed: ${describe(error)}`;
  }
}

type Landing = 'landed' | 'absent' | 'unknown';

// A write whose answer was lost may still have landed. Only a successful read of the log settles it.
async function didJoinLand(log: TeamLog, identity: DeviceIdentity): Promise<Landing> {
  try {
    await log.sync();
    if (log.status().state !== 'ok') return 'unknown';
    return log.state().deviceIndex.has(identity.fingerprint) ? 'landed' : 'absent';
  } catch {
    // The check itself could not be made, which is the same as not knowing.
    return 'unknown';
  }
}

function failureOf(log: TeamLog, memberId: string, kind: string, reason: string): JoinFailure {
  const standing = standingOf(log.state(), memberId);
  if (!standing.ok) return fail(standing.code, standing.message);
  const text = redactGitMessage(reason);
  if (text.includes(R.inviteExpired)) return fail('expired', 'This invitation has expired. Ask your lead to send a new one.');
  if (text.includes(R.inviteProof)) return fail('wrong-code', 'The code in this invite does not match the team record. Paste the whole invite exactly as you were sent it, or ask for a new one.');
  if (kind === 'offline') return fail('offline', 'Your join could not be saved because the team could not be reached. Check your internet connection and try again.', `The team's repository could not be reached: ${text}`);
  if (kind === 'paused') return fail('team-file', text);
  if (kind === 'remote-rejected') return fail('conflict', 'The team did not accept your join. The NEAR AI Team output has the details.', `The team's repository did not accept your join: ${text}`);
  if (kind === 'busy') return fail('conflict', 'The team record changed too often while your join was being saved. Try again in a moment.');
  return fail('conflict', `Your join was not accepted: ${text}`);
}

// ---- NEAR for a lead invitee (D-22) ---------------------------------------------------------------------------------------------------------

type NearStep = { nearInvitation: NonNullable<Extract<JoinResult, { ok: true }>['nearInvitation']>; notice?: string };

const NO_MATCHING_INVITATION = 'NEAR AI found no invitation to your organization for the NEAR AI account you signed in with. Sign in with the email address you were invited with, or ask the lead to invite your NEAR AI email address.';

function bearer(tokens: SessionTokens): NearAuth {
  return { accessToken: async () => tokens.accessToken, refreshAfterUnauthorized: async () => undefined };
}

// The emailed link can be the address of the invitation page or the bare token. Only the token is passed on, and nothing of it is ever shown.
function tokenFromLink(text: string): string {
  const trimmed = text.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const queried = url.searchParams.get('token');
    if (queried !== null && queried !== '') return queried;
    const segments = url.pathname.split('/').filter((segment) => segment !== '');
    const marker = segments.lastIndexOf('invitations');
    const next = marker >= 0 ? segments[marker + 1] : undefined;
    return next ?? segments[segments.length - 1] ?? '';
  } catch {
    // The text looked like an address but is not one; the caller treats an empty token as a link that did not work.
    return '';
  }
}

async function acceptAsLead(input: JoinInput, near: NearLink, teamId: string): Promise<NearStep> {
  if (input.signIn === undefined) return { nearInvitation: 'skipped', notice: 'You were not signed in to NEAR AI, so the invitation to your organization was not accepted. Sign in to NEAR AI for this team to accept it.' };
  const baseUrl = input.nearBaseUrl ?? DEFAULT_BASE_URL;
  let tokens: SessionTokens | undefined;
  try {
    tokens = await input.signIn();
  } catch (error) {
    if (error instanceof SignInError && error.code === 'cancelled') {
      return { nearInvitation: 'skipped', notice: 'The NEAR AI sign-in was cancelled, so the invitation to your organization was not accepted. Sign in to NEAR AI for this team to accept it.' };
    }
    return { nearInvitation: 'failed', notice: `NEAR AI sign-in did not finish, so the invitation to your organization was not accepted: ${scrubNearText(error instanceof Error ? error.message : String(error))}` };
  }
  if (tokens === undefined) return { nearInvitation: 'skipped', notice: 'You were not signed in to NEAR AI, so the invitation to your organization was not accepted. Sign in to NEAR AI for this team to accept it.' };

  try {
    const options = { baseUrl, ...(input.fetch === undefined ? {} : { fetch: input.fetch }) };
    const me = await new NearOrgClient({ ...options, auth: bearer(tokens) }).currentUser();
    // D-02: the lead's session is kept for this team, under the NEAR login's name.
    const session = await saveNearSession(input.secrets, teamId, tokens, me.username, { ...options, ...(input.now === undefined ? {} : { now: input.now }) });
    const org = new NearOrgClient({ ...options, auth: session });
    // T-61-39: only this team's organization counts, whatever other invitations the login has.
    // A list that cannot be read is not proof that there is no invitation, so the emailed link is still offered.
    let listProblem: string | undefined;
    let waiting: NearInvitation[] = [];
    try {
      waiting = await org.myInvitations();
    } catch (error) {
      listProblem = scrubNearText(error instanceof Error ? error.message : String(error), [tokens.accessToken, tokens.refreshToken]);
    }
    const found = waiting.find((invitation) => invitation.organizationId === near.organizationId);
    if (found !== undefined) return { nearInvitation: await org.acceptInvitation(found.id) };
    if (me.organizationIds.includes(near.organizationId)) return { nearInvitation: 'already-member' };
    const link = input.askInvitationLink === undefined ? undefined : await input.askInvitationLink();
    const token = link === undefined ? '' : tokenFromLink(link);
    if (token === '') {
      return listProblem === undefined
        ? { nearInvitation: 'not-found', notice: NO_MATCHING_INVITATION }
        : { nearInvitation: 'failed', notice: `NEAR AI could not list your invitations: ${listProblem} You are on the team; try accepting the invitation to your organization again later.` };
    }
    return { nearInvitation: await org.acceptInvitationToken(token) };
  } catch (error) {
    return { nearInvitation: 'failed', notice: `The invitation to your organization could not be accepted: ${scrubNearText(error instanceof Error ? error.message : String(error), [tokens.accessToken, tokens.refreshToken])} You are on the team; try accepting it again from Manage Team Members.` };
  }
}

// ---- a team with no NEAR organization (D-04, D-21) --------------------------------------------------------------------------------------------

const KEY_SHAPE = /^[\x21-\x7e]{8,512}$/;

async function installPastedKey(input: JoinInput, teamId: string): Promise<{ key: 'installed' | 'skipped'; notices: string[] }> {
  const notices = [NO_ORG_NOTICE];
  if (input.pasteOwnKey === undefined) return { key: 'skipped', notices: [...notices, 'No API key was added. Add your own NEAR AI API key from the NEAR AI settings to start working.'] };
  let pasted: string | undefined;
  try {
    pasted = await input.pasteOwnKey();
  } catch (error) {
    return { key: 'skipped', notices: [...notices, `Your API key could not be read: ${describe(error)}`] };
  }
  const trimmed = pasted?.trim() ?? '';
  if (trimmed === '') return { key: 'skipped', notices: [...notices, 'No API key was added. Add your own NEAR AI API key from the NEAR AI settings to start working.'] };
  if (!KEY_SHAPE.test(trimmed)) return { key: 'skipped', notices: [...notices, 'That does not look like an API key, so it was not used. Add your own NEAR AI API key from the NEAR AI settings.'] };
  // D-12 as amended by D-21: check_api_key only, no organization or workspace check, one try because a key that already exists needs no activation wait.
  const installed = await installTeamKey({
    projectRoot: input.projectRoot, globalStorageDir: input.globalStorageDir, teamId, teamName: input.teamFile.name, secrets: input.secrets,
    apiKey: Buffer.from(trimmed, 'utf8'), baseUrl: input.nearBaseUrl ?? DEFAULT_BASE_URL, attempts: 1,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch })
  });
  if (!installed.ok) return { key: 'skipped', notices: [...notices, `${installed.message} You are on the team; add your own NEAR AI API key from the NEAR AI settings.`] };
  if (installed.capped) notices.push('NEAR AI says this key has already reached its spend limit.');
  return { key: 'installed', notices };
}

// ---- joining ----------------------------------------------------------------------------------------------------------------------------------

const AWAITING_LEAD = 'The lead sends your team key from their NEAR AI window once you are confirmed. You do not sign in to NEAR AI.';

export async function joinTeam(input: JoinInput): Promise<JoinResult> {
  const { teamFile, bundle, secrets } = input;
  const teamId = teamFile.teamId;
  const now = input.now ?? ((): number => Date.now());
  if (bundle.team !== teamId) return fail('team-file', 'This invite is for a different team than the one open in this project.');
  // WR-03: only team.json decides the link; a link given with the invite is only ever compared with it.
  for (const offered of [input.near, bundle.near]) {
    if (offered === undefined) continue;
    if (teamFile.near === undefined) return fail('team-file', BUNDLE_LINK_NOT_IN_PROJECT);
    if (!sameNear(offered, teamFile.near)) return fail('team-file', DIFFERENT_LINK);
  }
  const near = teamFile.near;
  const displayName = input.displayName.trim();
  if (validateName(displayName, 'displayName') !== undefined) return fail('invalid-name', 'Your display name must be 1 to 80 characters with no line breaks.');

  let storageDir: string;
  try {
    storageDir = teamStorageDir(input.globalStorageDir, teamId);
    await checkTrustPin(storageDir, teamFile);
    // CR-01: the NEAR link this computer joins under is the one a delivered key must belong to later; a NearPinError is a TrustPinError.
    await checkNearPin(storageDir, teamFile);
  } catch (error) {
    if (error instanceof TrustPinError || error instanceof TeamFileError) return fail('team-file', error.message);
    throw error;
  }

  // Keys this call did not make are never touched: a device that already has a key is refused before anything is created.
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
  input.onStep?.('check');
  try {
    await log.sync();
  } catch (error) {
    return fail('offline', JOIN_UNREACHABLE, `The team log could not be read: ${describe(error)}`);
  }
  const status = log.status();
  if (status.state === 'offline') return fail('offline', JOIN_UNREACHABLE, `The team log could not be reached: ${redactGitMessage(status.reason ?? 'the remote did not answer')}`);
  if (status.state === 'paused') return fail('team-file', JOIN_PAUSED, redactGitMessage(status.reason ?? R.logRewritten));
  if (log.state().refused !== undefined) return fail('team-file', JOIN_REFUSED, redactGitMessage(log.state().refused ?? R.logRefused));

  const standing = standingOf(log.state(), bundle.member);
  if (!standing.ok) return fail(standing.code, standing.message);

  const codeBytes = parseInviteCode(bundle.code);
  if (codeBytes === undefined) return fail('wrong-code', 'The code in this invite is not valid. Paste the whole invite exactly as you were sent it.');
  try {
    if (!inviteKeyMatches(codeBytes, teamId, bundle.member, standing.invite.publicKey)) {
      return fail('wrong-code', 'The code in this invite does not match the team record. Paste the whole invite exactly as you were sent it, or ask for a new one.');
    }
    // Only an early answer for the person at the keyboard: the materialiser decides from commit times when the join is read.
    if (inviteExpired(standing.invite.commitTime, standing.invite.ttlSeconds, Math.floor(now() / 1000))) {
      return fail('expired', 'This invitation has expired. Ask your lead to send a new one.');
    }

    input.onStep?.('keys');
    const identity = await createDeviceIdentity(secrets, teamId);
    let failure: JoinFailure | undefined;
    try {
      const seal = await createSealIdentity(secrets, teamId);
      input.onStep?.('log');
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
      if (!appended.ok) {
        failure = failureOf(log, bundle.member, appended.kind, appended.reason);
        if (appended.kind === 'offline') {
          // The push may have landed with its answer lost: only a read of the log settles it.
          const landing = await didJoinLand(log, identity);
          if (landing === 'landed') failure = undefined;
          else if (landing === 'unknown') {
            return fail('offline', `Your join may or may not have been saved, because the team could not be reached to check. The keys made for this join were kept on this computer. Check the team list when you are online; if you are not on it, ask your lead to re-issue your invitation.`);
          }
        }
      }
    } catch (error) {
      const message = error instanceof SecretLeakError ? error.message : undefined;
      const landing = message === undefined ? await didJoinLand(log, identity) : 'absent';
      if (landing === 'unknown') throw error;
      if (landing === 'absent') {
        const left = await removeNewKeys(secrets, teamId);
        if (message !== undefined) return fail('invalid-name', `${message}${left}`);
        throw error;
      }
    }
    if (failure !== undefined) {
      const left = await removeNewKeys(secrets, teamId);
      return left === '' ? failure : fail(failure.code, `${failure.message}${left}`);
    }
  } finally {
    // The clear code is not needed again once the proof is signed.
    codeBytes.fill(0);
  }

  const member = log.state().members.get(bundle.member);
  const role: Role = member?.role ?? 'observer';
  const pendingRole = member?.pendingRole;
  const invitedRole: Role = pendingRole ?? role;
  const notices: string[] = [];
  let keyOutcome: 'awaiting-lead' | 'installed' | 'skipped' = 'awaiting-lead';
  let nearInvitation: NearStep['nearInvitation'] | undefined;
  if (near !== undefined) {
    // D-21: only a lead invitee ever signs in to NEAR here. Everyone else waits for the lead's client to make and send their capped key.
    notices.push(AWAITING_LEAD);
    if (invitedRole === 'lead') {
      input.onStep?.('near');
      const step = await acceptAsLead(input, near, teamId);
      nearInvitation = step.nearInvitation;
      if (step.notice !== undefined) notices.push(step.notice);
    }
  } else {
    input.onStep?.('key');
    const pasted = await installPastedKey(input, teamId);
    keyOutcome = pasted.key;
    notices.push(...pasted.notices);
  }
  return {
    ok: true, memberId: bundle.member, role, ...(pendingRole === undefined ? {} : { pendingRole }), key: keyOutcome,
    ...(nearInvitation === undefined ? {} : { nearInvitation }), notices
  };
}
