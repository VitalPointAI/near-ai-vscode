// A three-clone rig for the whole Team Mode membership lifecycle (Phase 61 plan 14): clone a is the owner, b a developer, c a lead. Each step of
// the lifecycle is one function that calls the real flow module (enableTeamMode, linkNearOrganization, inviteMember, prepareJoin and joinTeam,
// confirmMember, installDeliveredKey, removeMember, handleOwnRemoval) over real git and the fake NEAR server, and returns what the step produced.
// Every sentence a flow hands back for the user is also recorded in rig.output, which stands in for the text a command would show.
// The file has no .test suffix on purpose so the test glob does not run it as a suite.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { DEFAULT_INVITE_TTL_SECONDS } from '../../domain/team/invite';
import { teamMaterializer } from '../../domain/team/materialize';
import type { GenesisAnchor, Role, TeamFile, TeamState } from '../../domain/team/types';
import { AuthService } from '../../services/auth';
import { ProfileStore } from '../../services/profileStore';
import type { FetchLike } from '../../services/reportingSignIn';
import { CleanupChecklist } from '../../team/cleanupChecklist';
import { enableTeamMode, pushCodeBranch } from '../../team/enable';
import type { EnableResult } from '../../team/enable';
import { TeamLog } from '../../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../../team/gitTransport';
import type { DeviceIdentity } from '../../team/identity';
import { loadDeviceIdentity } from '../../team/identity';
import { inviteMember } from '../../team/invite';
import type { InviteResult } from '../../team/invite';
import { parseInviteBundle } from '../../team/inviteBundle';
import type { JoinInput, JoinResult } from '../../team/join';
import { joinTeam, prepareJoin } from '../../team/join';
import { confirmMember, installDeliveredKey } from '../../team/keyDelivery';
import type { ConfirmResult, InstallDeliveredResult } from '../../team/keyDelivery';
import { linkChoices, linkNearOrganization } from '../../team/nearLink';
import type { LinkResult } from '../../team/nearLink';
import { NearOrgClient } from '../../team/nearOrg';
import type { NearAuth } from '../../team/nearOrg';
import { NearSession, saveNearSession } from '../../team/nearSession';
import { removeMember } from '../../team/remove';
import type { RemoveResult } from '../../team/remove';
import { handleOwnRemoval } from '../../team/removedClient';
import type { OwnRemovalResult } from '../../team/removedClient';
import { teamStorageDir } from '../../team/teamFile';
import { startFakeNear } from './fakeNear';
import type { FakeNear } from './fakeNear';
import { MemorySecrets, createTeamFixture, gitIn } from './teamHarness';
import type { TeamFixture } from './teamHarness';

export const GIGA = 1_000_000_000;
export const NEAR_LINK = { organizationId: 'org-1', workspaceId: 'ws-1' };
export const OWNER_EMAIL = 'owner.lead@example.invalid';
export const DEV_EMAIL = 'dana.dev@example.invalid';
export const LEAD_EMAIL = 'lena.lead@example.invalid';
export const PERSONAL_PROFILE = 'profile-personal';
const PUBLIC_URL = 'https://example.invalid/team.git';
const noSleep = async (): Promise<void> => undefined;

export interface Tokens { accessToken: string; refreshToken: string }

export interface RigOptions {
  /** True: the team is linked to the fake NEAR organization. False: no organization (D-04). */
  linked: boolean;
  /** Prefix of every key secret the fake makes. */
  keySecretPrefix?: string;
  /** The URL clone a's origin is configured with, mapped back to the real bare remote by an insteadOf rule. */
  remoteUrl?: string;
  /** Tokens the fake issues for the owner and the lead's NEAR logins, so a test can make them recognisable. */
  ownerTokens?: Tokens;
  leadTokens?: Tokens;
}

export type Who = 'dev' | 'lead';

export interface Participant {
  who: Who;
  name: string;
  email: string;
  role: Exclude<Role, 'owner'>;
  allocationNanoUsd: number;
  clone: 'b' | 'c';
  secrets: MemorySecrets;
  globalStorageDir: string;
  /** The invite bundle the owner handed over. */
  bundle?: string;
  memberId?: string;
  /** A key of the person's own, made in a separate NEAR organization, for a team with no organization. */
  ownKey?: string;
  /** The tokens of the person's NEAR login for the team's organization (the lead's sign-in returns these). */
  nearTokens?: Tokens;
}

export interface OpenLog { log: TeamLog; transport: GitTransport<TeamState>; identity: DeviceIdentity | undefined; memberId: string | undefined }

/** One NEAR call as the lead's client sent it, with how many events the coordination branch on the remote held at that moment. */
export interface SpiedCall { method: string; path: string; remoteEvents: number }

export interface Rig {
  options: RigOptions;
  fixture: TeamFixture;
  fake: FakeNear;
  /** Every sentence a flow produced for the user, in order. */
  output: string[];
  owner: { secrets: MemorySecrets; globalStorageDir: string; tokens: Tokens; org?: NearOrgClient; memberId?: string };
  dev: Participant;
  lead: Participant;
  teamFile?: TeamFile;
  /** NEAR calls made through the lead's kept session, in order. */
  leadCalls: SpiedCall[];
}

export const rootOf = (rig: Rig, clone: 'a' | 'b' | 'c'): string => rig.fixture.clones[clone] as string;
export const storageOf = (rig: Rig, p: Participant | 'owner'): string => teamStorageDir(p === 'owner' ? rig.owner.globalStorageDir : p.globalStorageDir, teamIdOf(rig));

export function teamIdOf(rig: Rig): string {
  assert.ok(rig.teamFile !== undefined, 'Team Mode has been enabled');
  return (rig.teamFile as TeamFile).teamId;
}

function teamFileOf(rig: Rig): TeamFile {
  assert.ok(rig.teamFile !== undefined, 'Team Mode has been enabled');
  return rig.teamFile as TeamFile;
}

export function staticAuth(token: string): NearAuth {
  return { accessToken: async () => token, refreshAfterUnauthorized: async () => undefined };
}

function say(rig: Rig, ...texts: Array<string | undefined>): void {
  for (const text of texts) if (text !== undefined && text !== '') rig.output.push(text);
}

export async function createRig(options: RigOptions): Promise<Rig> {
  const fixture = await createTeamFixture({ clones: ['a', 'b', 'c'], initialised: true });
  const fake = await startFakeNear(options.keySecretPrefix === undefined ? {} : { keySecretPrefix: options.keySecretPrefix });
  const owner = fake.addUser({ id: 'user-owner', username: 'owner', email: OWNER_EMAIL, ...(options.ownerTokens ?? {}) });
  const leadIssued = fake.addUser({ id: 'user-lead', username: 'lena', email: LEAD_EMAIL, ...(options.leadTokens ?? {}) });
  fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-owner', role: 'owner' }] });
  fake.addWorkspace({ id: 'ws-1', organizationId: 'org-1', name: 'Team workspace' });

  // Clone a's origin is a public-looking address and git is told where it really is, so the invite bundle carries the public one.
  const url = options.remoteUrl ?? PUBLIC_URL;
  const cloneA = fixture.clones['a'] as string;
  gitIn(cloneA, ['config', `url.${fixture.remote}.insteadOf`, url]);
  gitIn(cloneA, ['remote', 'set-url', 'origin', url]);

  const participant = (who: Who, name: string, email: string, role: Participant['role'], allocationNanoUsd: number, clone: Participant['clone']): Participant => ({
    who, name, email, role, allocationNanoUsd, clone, secrets: new MemorySecrets(), globalStorageDir: fixture.storageDir(clone)
  });
  const rig: Rig = {
    options, fixture, fake, output: [], leadCalls: [],
    owner: { secrets: new MemorySecrets(), globalStorageDir: fixture.storageDir('a'), tokens: owner },
    dev: participant('dev', 'Dana Developer', DEV_EMAIL, 'developer', 5 * GIGA, 'b'),
    lead: participant('lead', 'Lena Lead', LEAD_EMAIL, 'lead', 20 * GIGA, 'c')
  };
  rig.lead.nearTokens = leadIssued;

  if (!options.linked) {
    // Each person has a NEAR login and a key of their own in an organization that is not the team's; the team never sees that organization.
    fake.addOrganization({ id: 'org-own', name: 'Own Org', members: [{ userId: 'user-own-dev', role: 'owner' }, { userId: 'user-own-lead', role: 'owner' }] });
    fake.addWorkspace({ id: 'ws-own', organizationId: 'org-own', name: 'Own workspace' });
    for (const [person, userId] of [[rig.dev, 'user-own-dev'], [rig.lead, 'user-own-lead']] as const) {
      const tokens = fake.addUser({ id: userId, username: userId, email: `${userId}@example.invalid` });
      const created = await new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth(tokens.accessToken), sleep: noSleep }).createKey('ws-own', `own-${person.who}`, 50 * GIGA);
      person.ownKey = created.secret.toString('utf8');
      created.secret.fill(0);
    }
  }
  return rig;
}

export async function closeRig(rig: Rig): Promise<void> {
  await rig.fake.close();
  await rig.fixture.cleanup();
}

// ---- opening a log for one computer ---------------------------------------------------------------------------------------------------------

function anchorOf(teamFile: TeamFile): GenesisAnchor {
  return { teamId: teamFile.teamId, eventId: teamFile.genesis.eventId, ownerDevice: { ...teamFile.genesis.ownerDevice } };
}

/** A synced log for one computer, signing as the device key in that computer's SecretStorage when it has one (read-only otherwise). */
export async function openLog(rig: Rig, who: 'owner' | Participant): Promise<OpenLog> {
  const teamFile = teamFileOf(rig);
  const clone = who === 'owner' ? 'a' : who.clone;
  const secrets = who === 'owner' ? rig.owner.secrets : who.secrets;
  const globalStorageDir = who === 'owner' ? rig.owner.globalStorageDir : who.globalStorageDir;
  const anchor = anchorOf(teamFile);
  const transport = new GitTransport<TeamState>({
    mirrorDir: path.join(teamStorageDir(globalStorageDir, teamFile.teamId), 'coordination.git'), projectRoot: rootOf(rig, clone),
    remote: teamFile.coordination.remote, ref: teamFile.coordination.ref, materializer: teamMaterializer(anchor), baseDelayMs: 1
  });
  const identity = await loadDeviceIdentity(secrets, teamFile.teamId);
  const reader = new TeamLog({ anchor, transport });
  await reader.sync();
  const memberId = identity === undefined ? undefined : reader.state().deviceIndex.get(identity.fingerprint);
  const log = identity === undefined || memberId === undefined ? reader : new TeamLog({ anchor, transport, signer: { identity, memberId } });
  await log.sync();
  return { log, transport, identity, memberId };
}

// ---- the lifecycle, one function per step ---------------------------------------------------------------------------------------------------

/** The owner enables Team Mode on clone a with a NEAR login for the NEAR organization when the team is linked. Nothing is pushed. */
export async function enable(rig: Rig): Promise<Extract<EnableResult, { ok: true }>> {
  const result = await enableTeamMode({
    projectRoot: rootOf(rig, 'a'), globalStorageDir: rig.owner.globalStorageDir, secrets: rig.owner.secrets,
    teamName: 'Flow team', ownerName: 'Owner Test', ownerEmail: OWNER_EMAIL, remote: 'origin', integrationBranch: 'main'
  });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  if (!result.ok) throw new Error('enable failed');
  rig.teamFile = result.teamFile;
  const opened = await openLog(rig, 'owner');
  rig.owner.memberId = opened.memberId;
  if (rig.options.linked) {
    // D-01, D-02: the owner signs in to NEAR once for this team; the session is kept in SecretStorage and renewed by its refresh token.
    const session = await saveNearSession(rig.owner.secrets, result.teamFile.teamId, rig.owner.tokens, 'owner', { baseUrl: rig.fake.baseUrl, sleep: noSleep });
    rig.owner.org = new NearOrgClient({ baseUrl: rig.fake.baseUrl, auth: session, sleep: noSleep });
  }
  return result;
}

/** The owner picks the organization and workspace from the lists NEAR gives and links the team to them (D-03). */
export async function link(rig: Rig): Promise<Extract<LinkResult, { ok: true }>> {
  const org = rig.owner.org;
  assert.ok(org !== undefined, 'the owner is signed in to NEAR');
  const choices = await linkChoices(org as NearOrgClient);
  const choice = choices.find((candidate) => candidate.organization.id === NEAR_LINK.organizationId);
  assert.ok(choice !== undefined && choice.workspaces.some((workspace) => workspace.id === NEAR_LINK.workspaceId), 'the organization and its workspace are offered');
  const result = await linkNearOrganization({ projectRoot: rootOf(rig, 'a'), globalStorageDir: rig.owner.globalStorageDir, teamId: teamIdOf(rig), near: NEAR_LINK });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  if (!result.ok) throw new Error('link failed');
  rig.teamFile = result.teamFile;
  return result;
}

/** The owner's Push button, then the two teammates pull the project, which is how team.json (and its NEAR link) reaches them. */
export function publishProject(rig: Rig): Promise<void> {
  return pushAndPull(rig);
}

async function pushAndPull(rig: Rig): Promise<void> {
  const pushed = await pushCodeBranch(rootOf(rig, 'a'), 'origin', 'main');
  assert.equal(pushed.ok, true, pushed.ok ? '' : pushed.message);
  for (const clone of ['b', 'c'] as const) gitIn(rootOf(rig, clone), ['pull', '-q', '--ff-only', 'origin', 'main']);
}

/** The owner invites one person and gets the bundle to hand over. */
export async function invite(rig: Rig, person: Participant): Promise<Extract<InviteResult, { ok: true }>> {
  const opened = await openLog(rig, 'owner');
  const result = await inviteMember({
    projectRoot: rootOf(rig, 'a'), globalStorageDir: rig.owner.globalStorageDir, teamFile: teamFileOf(rig), log: opened.log,
    name: person.name, email: person.email, role: person.role, allocationNanoUsd: person.allocationNanoUsd, ttlSeconds: DEFAULT_INVITE_TTL_SECONDS,
    ...(rig.owner.org === undefined ? {} : { org: rig.owner.org })
  });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  if (!result.ok) throw new Error('invite failed');
  person.bundle = result.bundle;
  person.memberId = result.memberId;
  say(rig, result.notice);
  return result;
}

/** The code text inside a bundle, for the privacy test to turn into every rendering it could be written as. */
export function codeOf(bundle: string): string {
  return parseInviteBundle(bundle).code;
}

/** The invitee pastes the bundle on their own clone and joins. A lead signs in to NEAR; anyone in an unlinked team pastes their own key. */
export async function join(rig: Rig, person: Participant, overrides: Partial<JoinInput> = {}): Promise<Extract<JoinResult, { ok: true }>> {
  assert.ok(person.bundle !== undefined, 'the person was invited');
  const projectRoot = rootOf(rig, person.clone);
  const prepared = await prepareJoin({ projectRoot, bundleText: person.bundle as string });
  assert.equal(prepared.kind, 'ready', prepared.kind === 'refused' ? prepared.message : prepared.kind);
  if (prepared.kind !== 'ready') throw new Error('join was not ready');
  const input: JoinInput = {
    projectRoot, globalStorageDir: person.globalStorageDir, teamFile: prepared.teamFile, bundle: prepared.bundle,
    ...(prepared.near === undefined ? {} : { near: prepared.near }), secrets: person.secrets, displayName: person.name, nearBaseUrl: rig.fake.baseUrl,
    ...(rig.options.linked && person.nearTokens !== undefined ? { signIn: async () => ({ ...person.nearTokens as Tokens }) } : {}),
    ...(!rig.options.linked && person.ownKey !== undefined ? { pasteOwnKey: async () => person.ownKey } : {}),
    ...overrides
  };
  const result = await joinTeam(input);
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  if (!result.ok) throw new Error('join failed');
  say(rig, ...result.notices);
  return result;
}

/** The owner confirms one person (and, in a linked team, their key is made, sealed and recorded). */
export async function confirm(rig: Rig, person: Participant): Promise<Extract<ConfirmResult, { ok: true }>> {
  assert.ok(person.memberId !== undefined, 'the person was invited');
  const opened = await openLog(rig, 'owner');
  const result = await confirmMember({
    log: opened.log, teamFile: teamFileOf(rig), memberId: person.memberId as string, checklist: new CleanupChecklist(storageOf(rig, 'owner')),
    ...(rig.owner.org === undefined ? {} : { org: rig.owner.org })
  });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  if (!result.ok) throw new Error('confirm failed');
  say(rig, result.message);
  return result;
}

/** The person's own window opens the key the lead sent it and installs it as the project's active credential. */
export async function installKey(rig: Rig, person: Participant): Promise<InstallDeliveredResult> {
  const opened = await openLog(rig, person);
  assert.ok(opened.identity !== undefined, 'the person has a device key');
  const result = await installDeliveredKey({
    projectRoot: rootOf(rig, person.clone), globalStorageDir: person.globalStorageDir, teamFile: teamFileOf(rig), log: opened.log,
    deviceFingerprint: (opened.identity as DeviceIdentity).fingerprint, secrets: person.secrets, baseUrl: rig.fake.baseUrl, sleep: noSleep
  });
  if (result.status === 'failed') say(rig, result.message);
  return result;
}

/** A personal profile the person had before joining, so removal has something to give back. */
export async function givePersonalProfile(rig: Rig, person: Participant): Promise<void> {
  const store = new ProfileStore(rootOf(rig, person.clone), new AuthService(person.secrets), { validator: async () => undefined });
  await store.configure({ profileId: PERSONAL_PROFILE, displayName: 'Personal', organization: 'Me', baseUrl: rig.fake.baseUrl, authMode: 'apiKey' }, `sk-personal-${randomBytes(12).toString('hex')}`);
  await store.select(PERSONAL_PROFILE);
}

export async function activeProfileOf(rig: Rig, person: Participant): Promise<string | undefined> {
  return (await new ProfileStore(rootOf(rig, person.clone), new AuthService(person.secrets)).getActiveSelection())?.profileId;
}

/** How many event files the coordination branch on the shared remote holds. */
export function remoteEventCount(rig: Rig): number {
  const names = gitIn(rig.fixture.remote, ['ls-tree', '-r', '--name-only', DEFAULT_COORDINATION_REF]).split('\n');
  return names.filter((name) => name.startsWith('events/')).length;
}

/** The NEAR client the lead's kept session gives: every call is noted with the state of the remote's log at that moment. */
export function leadOrgClient(rig: Rig, lead: Participant): NearOrgClient {
  const spy: FetchLike = (url, init) => {
    rig.leadCalls.push({ method: init.method, path: new URL(url).pathname, remoteEvents: remoteEventCount(rig) });
    return (fetch as unknown as FetchLike)(url, init);
  };
  const session = new NearSession({ teamId: teamIdOf(rig), secrets: lead.secrets, baseUrl: rig.fake.baseUrl, fetch: spy, sleep: noSleep });
  return new NearOrgClient({ baseUrl: rig.fake.baseUrl, auth: session, fetch: spy, sleep: noSleep });
}

/** A lead or the owner removes a member. A lead goes through their own computer and their kept NEAR session. */
export async function remove(rig: Rig, by: 'owner' | Participant, target: Participant): Promise<Extract<RemoveResult, { ok: true }>> {
  assert.ok(target.memberId !== undefined, 'the person was invited');
  const opened = await openLog(rig, by);
  const org = !rig.options.linked ? undefined : by === 'owner' ? rig.owner.org : leadOrgClient(rig, by);
  const result = await removeMember({
    log: opened.log, teamFile: teamFileOf(rig), memberId: target.memberId as string, checklist: new CleanupChecklist(storageOf(rig, by)),
    ...(org === undefined ? {} : { org })
  });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  if (!result.ok) throw new Error('remove failed');
  say(rig, result.message, ...result.checklist.map((item) => `${item.step}:${item.status}${item.lastError === undefined ? '' : ` ${item.lastError}`}`));
  return result;
}

/** The removed person's computer syncs, sees its own removal and cleans up. */
export async function ownRemoval(rig: Rig, person: Participant): Promise<OwnRemovalResult> {
  const opened = await openLog(rig, person);
  const member = person.memberId === undefined ? undefined : opened.log.state().members.get(person.memberId);
  assert.ok(member?.removedEvent !== undefined, 'the person sees their own removal');
  return handleOwnRemoval({
    projectRoot: rootOf(rig, person.clone), globalStorageDir: person.globalStorageDir, teamFile: teamFileOf(rig), memberId: person.memberId as string,
    removedEvent: member?.removedEvent as string, secrets: person.secrets, nearBaseUrl: rig.fake.baseUrl
  });
}
