// What a running TeamSession does about membership (Phase 61 plan 12, D-07, D-14, D-16, D-20, D-24, D-25): the owner's or a lead's window says who is
// waiting for confirmation (once per join event, even across reloads) and shows the pending count, a member's window installs the key it was sent,
// the removed member's window stops, cleans up once and stays stopped, and a clone with no device key is offered Join once. Everything runs on
// real git with the vscode stub installed for the whole file; the NEAR side is the fake server. Lazy requires keep every vscode import behind the stub.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { expectedJoinRole, joinProofBytes } from '../domain/team/invite';
import { teamMaterializer } from '../domain/team/materialize';
import { defaultTeamPolicy } from '../domain/team/policy';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { GenesisAnchor, MemberInvitedBody, MemberJoinedBody, Role, TeamFile, TeamState } from '../domain/team/types';
import { TeamLog, buildGenesisEvents } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { createDeviceIdentity, createSealIdentity, emailHash, newMemberId, newTeamId } from '../team/identity';
import type { DeviceIdentity, SealIdentity } from '../team/identity';
import { deriveInviteKey, generateInviteCode } from '../team/inviteCode';
import { NO_ORG_NOTICE } from '../team/join';
import { saveNearSession } from '../team/nearSession';
import { canonicalTeamFile } from '../team/teamFile';
import { startFakeNear } from './helpers/fakeNear';
import type { FakeNear } from './helpers/fakeNear';
import { MemorySecrets, createOwner, createTeamFixture } from './helpers/teamHarness';
import type { TeamFixture, TestOwner } from './helpers/teamHarness';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const sessionModule = require('../services/team/teamSession') as typeof import('../services/team/teamSession');
const barModule = require('../services/team/teamStatusBar') as typeof import('../services/team/teamStatusBar');
test.after(() => { uninstall(); });

const { TeamSession, MANAGE_MEMBERS_COMMAND, JOIN_COMMAND, NOTIFIED_FILE, projectAuditSink } = sessionModule;
const { REMOVED_TEXT, createTeamStatusBar, statusText } = barModule;
type Session = Awaited<ReturnType<typeof TeamSession.start>>;
type SessionDeps = Parameters<typeof TeamSession.start>[0];

const GIGA = 1_000_000_000;
const NEAR_LINK = { organizationId: 'org-1', workspaceId: 'ws-1' };
const TEAM_NAME = 'Alpha';
const fixedNow = (): Date => new Date('2026-02-03T04:05:06.000Z');

async function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => { setTimeout(resolve, 15); });
  }
}

// The clock never moves and timers fire by hand, so a test decides when a poll happens.
class FakeTimers {
  public readonly requests: Array<{ ms: number; callback: () => void; cleared: boolean; fired: boolean }> = [];
  public now(): number { return 0; }
  public set(callback: () => void, ms: number): unknown {
    const request = { ms, callback, cleared: false, fired: false };
    this.requests.push(request);
    return request;
  }
  public clear(handle: unknown): void { (handle as { cleared: boolean }).cleared = true; }
}

interface Client { transport: GitTransport<TeamState>; log: TeamLog }

function clientFor(fixture: TeamFixture, name: string, anchor: GenesisAnchor, signer?: TeamSigner): Client {
  const transport = new GitTransport<TeamState>({
    mirrorDir: path.join(fixture.storageDir(name), 'coordination.git'), projectRoot: fixture.clones[name] as string,
    remote: 'origin', ref: DEFAULT_COORDINATION_REF, materializer: teamMaterializer(anchor), baseDelayMs: 1
  });
  return { transport, log: new TeamLog({ anchor, transport, now: fixedNow, ...(signer === undefined ? {} : { signer }) }) };
}

// A person who joined from their own clone: device key, seal key and a client that signs as them.
interface Person { memberId: string; name: string; clone: string; identity: DeviceIdentity; seal: SealIdentity; secrets: MemorySecrets; client: Client; globalStorageDir: string }

interface World {
  fixture: TeamFixture;
  fake: FakeNear;
  teamId: string;
  teamFile: TeamFile;
  anchor: GenesisAnchor;
  owner: TestOwner;
  a: Client;
  ownerGlobal: string;
  sessions: Session[];
  fetches: { count: number };
  timers: FakeTimers;
}

interface WorldOptions { near?: boolean }

async function startWorld(fixture: TeamFixture, options: WorldOptions): Promise<World> {
  const fake = await startFakeNear();
  const lead = fake.addUser({ id: 'user-owner', username: 'owner', email: 'owner@example.invalid' });
  fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-owner', role: 'owner' }] });
  fake.addWorkspace({ id: 'ws-1', organizationId: 'org-1', name: 'Team workspace' });
  void lead;
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const near = options.near === false ? undefined : NEAR_LINK;
  const genesis = buildGenesisEvents({
    teamId, teamName: TEAM_NAME, owner: { memberId: owner.memberId, name: 'Owner Test', emailHashes: [emailHash(teamId, 'owner@example.invalid')] },
    identity: owner.identity, policy: defaultTeamPolicy(), ...(near === undefined ? {} : { near }), now: fixedNow
  });
  const teamFile: TeamFile = {
    version: 1, teamId, name: TEAM_NAME, coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote: 'origin' },
    genesis: { eventId: genesis.anchor.eventId, ownerDevice: genesis.anchor.ownerDevice }, ...(near === undefined ? {} : { near }), createdAt: '2026-02-03T04:05:06.000Z'
  };
  const a = clientFor(fixture, 'a', genesis.anchor, { identity: owner.identity, memberId: owner.memberId });
  const written = await a.transport.append(async () => genesis.events, { genesis: { teamFileText: canonicalTeamFile(teamFile) } });
  assert.equal(written.ok, true);
  return {
    fixture, fake, teamId, teamFile, anchor: genesis.anchor, owner, a, ownerGlobal: path.join(fixture.root, 'global-a'), sessions: [],
    fetches: { count: 0 }, timers: new FakeTimers()
  };
}

async function inWorld(options: WorldOptions, run: (world: World) => Promise<void>): Promise<void> {
  stub.statusBarItems.length = 0;
  stub.notifications.length = 0;
  stub.notificationActions.length = 0;
  stub.messageAnswers.length = 0;
  const fixture = await createTeamFixture({ clones: ['a', 'b'] });
  let world: World | undefined;
  try {
    world = await startWorld(fixture, options);
    await run(world);
  } finally {
    for (const session of world?.sessions ?? []) session.dispose();
    await world?.fake.close();
    await fixture.cleanup();
  }
}

function inviteBody(w: World, memberId: string, name: string, email: string, role: MemberInvitedBody['role'], codeBytes: Buffer): MemberInvitedBody {
  return {
    memberId, name, emailHashes: [emailHash(w.teamId, email)], role, allocationNanoUsd: 5 * GIGA,
    ttlSeconds: 604_800, invite: { publicKey: deriveInviteKey(codeBytes, w.teamId, memberId).publicKey }
  };
}

function joinBody(state: TeamState, teamId: string, memberId: string, codeBytes: Buffer, identity: DeviceIdentity, sealKey: string): MemberJoinedBody | { conflict: string } {
  const member = state.members.get(memberId);
  if (member === undefined || member.invite === undefined) return { conflict: TEAM_REJECTION_REASONS.notInvited };
  const device = { fingerprint: identity.fingerprint, publicKey: identity.publicKey };
  const role: Role = expectedJoinRole(member.pendingRole ?? 'observer', state.team.policy);
  const sig = deriveInviteKey(codeBytes, teamId, memberId).sign(joinProofBytes(teamId, memberId, member.invite.eventId, device, sealKey));
  return { memberId, name: member.name, emailHashes: [...member.emailHashes], role, device, invite: { sig }, sealKey: { publicKey: sealKey } };
}

// The owner invites, and the person joins from `clone` with the code. They stay unconfirmed (an observer waiting for a lead).
async function joinPerson(w: World, clone: string, name: string, email: string, role: MemberInvitedBody['role'] = 'developer'): Promise<Person> {
  const memberId = newMemberId();
  const code = generateInviteCode();
  const invited = await w.a.log.append(() => [{ type: 'member.invited', body: inviteBody(w, memberId, name, email, role, code.bytes) }]);
  assert.equal(invited.ok, true, invited.ok ? '' : invited.reason);
  const secrets = new MemorySecrets();
  const identity = await createDeviceIdentity(secrets, w.teamId);
  const seal = await createSealIdentity(secrets, w.teamId);
  const client = clientFor(w.fixture, clone, w.anchor, { identity, memberId });
  await client.log.sync();
  const joined = await client.log.appendJoin(identity, (state) => joinBody(state, w.teamId, memberId, code.bytes, identity, seal.publicKey));
  assert.equal(joined.ok, true, joined.ok ? '' : joined.reason);
  await w.a.log.sync();
  return { memberId, name, clone, identity, seal, secrets, client, globalStorageDir: path.join(w.fixture.root, `global-${clone}`) };
}

interface Started { session: Session; lines: string[]; commands: Array<{ id: string; args: unknown }> }

async function startSession(w: World, who: 'owner' | Person, overrides: Partial<SessionDeps> = {}): Promise<Started> {
  const v = stub.vscode as {
    window: {
      showInformationMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
      showWarningMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
    };
  };
  const lines: string[] = [];
  const commands: Started['commands'] = [];
  const person = who === 'owner' ? undefined : who;
  const clone = person === undefined ? 'a' : person.clone;
  const session = await TeamSession.start({
    projectRoot: w.fixture.clones[clone] as string, globalStorageDir: person === undefined ? w.ownerGlobal : person.globalStorageDir, teamFile: w.teamFile,
    secrets: person === undefined ? w.owner.secrets : person.secrets,
    output: { appendLine: (line) => { lines.push(line); }, show: () => undefined },
    statusBar: createTeamStatusBar(), audit: projectAuditSink(w.fixture.clones[clone] as string),
    notify: { info: (message, ...actions) => v.window.showInformationMessage(message, ...actions), warn: (message, ...actions) => v.window.showWarningMessage(message, ...actions) },
    pollSeconds: () => 15, focused: () => true, timers: w.timers, nearBaseUrl: w.fake.baseUrl,
    runCommand: async (id, args) => { commands.push({ id, args }); },
    ...overrides
  });
  w.sessions.push(session);
  return { session, lines, commands };
}

const lastBar = (): { text: string; tooltip: string } => {
  const item = stub.statusBarItems[stub.statusBarItems.length - 1];
  assert.ok(item !== undefined, 'a status bar item exists');
  return { text: item.text, tooltip: item.tooltip };
};

const infoMessages = (): string[] => stub.notifications.filter((entry) => entry.level === 'info').map((entry) => entry.message);

test('tracer: a developer joins from another clone; the owner window says who is waiting, can act from the notification and shows the pending count', async () => {
  await inWorld({}, async (w) => {
    const dana = await joinPerson(w, 'b', 'Dana Developer', 'dana@example.invalid');
    stub.messageAnswers.push('Confirm');
    const owner = await startSession(w, 'owner');

    assert.deepEqual(infoMessages(), ['Dana Developer joined Alpha and is waiting for confirmation']);
    assert.deepEqual(stub.notificationActions[0], ['Confirm', 'Remove']);
    await until(() => owner.commands.length > 0, 'the Confirm action to run its command');
    assert.deepEqual(owner.commands, [{ id: MANAGE_MEMBERS_COMMAND, args: { memberId: dana.memberId, action: 'confirm' } }]);
    assert.equal(lastBar().text, 'Team: Alpha (1 pending)');
  });
});

test('the same join is announced once: not on the next sync and not after a reload; notified.json holds ids only', async () => {
  await inWorld({}, async (w) => {
    const dana = await joinPerson(w, 'b', 'Dana Developer', 'dana@example.invalid');
    const first = await startSession(w, 'owner');
    assert.equal(infoMessages().length, 1);
    await first.session.sync();
    await first.session.sync();
    assert.equal(infoMessages().length, 1, 'the next syncs stay quiet');

    // A reload: a new session for the same storage folder.
    const second = await startSession(w, 'owner');
    await second.session.sync();
    assert.equal(infoMessages().length, 1, 'a reload does not repeat it');
    assert.equal(lastBar().text, 'Team: Alpha (1 pending)', 'the count is still shown after the reload');

    const text = await fs.readFile(path.join(first.session.storageDir(), NOTIFIED_FILE), 'utf8');
    const joinedEvent = first.session.state().members.get(dana.memberId)?.joinedEvent;
    assert.ok(joinedEvent !== undefined);
    assert.ok(text.includes(joinedEvent), 'the join event id is remembered');
    assert.equal(text.includes('Dana'), false, 'no name is kept');
    assert.equal(text.includes('example.invalid'), false, 'no email is kept');
  });
});

test('a developer own window shows no pending count and no confirmation notification', async () => {
  await inWorld({}, async (w) => {
    const dana = await joinPerson(w, 'b', 'Dana Developer', 'dana@example.invalid');
    await joinPerson(w, 'b', 'Erin Engineer', 'erin@example.invalid');
    stub.notifications.length = 0;
    stub.notificationActions.length = 0;
    const own = await startSession(w, dana);
    await own.session.sync();
    assert.deepEqual(infoMessages().filter((message) => message.includes('waiting for confirmation')), []);
    assert.equal(lastBar().text, 'Team: Alpha');
  });
});

test('a member name with $( in it is shown escaped in the notification and the status bar', async () => {
  await inWorld({}, async (w) => {
    await joinPerson(w, 'b', 'Zed $(zap) Zero', 'zed@example.invalid');
    await startSession(w, 'owner');
    assert.deepEqual(infoMessages(), ['Zed \\$(zap) Zero joined Alpha and is waiting for confirmation']);
    assert.equal(lastBar().text, 'Team: Alpha (1 pending)');
  });
});

test('status text: the pending count, the removed state, the NEAR tooltip lines, and one flat bounded line for any label', () => {
  const ok = { state: 'ok' as const };
  assert.equal(statusText(ok, 'Alpha', { pending: 2 }).text, 'Team: Alpha (2 pending)');
  assert.equal(statusText(ok, 'Alpha', { pending: 0 }).text, 'Team: Alpha');
  assert.equal(statusText(ok, 'Alpha').text, 'Team: Alpha');
  assert.match(statusText(ok, 'Alpha', { nearLabel: 'lead@example.invalid' }).tooltip, /NEAR: signed in as lead@example\.invalid/);
  assert.match(statusText(ok, 'Alpha', { nearLinked: false }).tooltip, new RegExp(NO_ORG_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(statusText(ok, 'Alpha', { nearLinked: true }).tooltip.includes('NEAR'), false, 'a linked team with no sign-in on this computer says nothing about NEAR');
  const removed = statusText(ok, 'Alpha', { removed: true });
  assert.equal(removed.text, REMOVED_TEXT);
  assert.match(removed.tooltip, /You were removed from Alpha/);
  const hostile = statusText(ok, 'Alpha', { nearLabel: `line one\nline $(two) ${'x'.repeat(500)}` }).tooltip;
  assert.equal(/[\r\n]/.test(hostile.replace(/\.\s/g, ' ')), false, 'no line break from a label');
  assert.equal(hostile.includes('$(two)'), false, 'the icon syntax is escaped');
  assert.ok(hostile.length < 400, 'a long label is bounded');
});

test('the NEAR line of the tooltip names the signed-in account, or says no organization is linked', async () => {
  await inWorld({}, async (w) => {
    await saveNearSession(w.owner.secrets, w.teamId, { accessToken: 'at_test', refreshToken: 'rt_test' }, 'lead@example.invalid', { baseUrl: w.fake.baseUrl });
    await startSession(w, 'owner');
    assert.match(lastBar().tooltip, /NEAR: signed in as lead@example\.invalid/);
  });
  await inWorld({ near: false }, async (w) => {
    await startSession(w, 'owner');
    assert.match(lastBar().tooltip, /No NEAR organization linked: spend is not capped at the provider\./);
  });
});

test('a confirmed member with no key yet is announced once with Send key, in a team linked to NEAR only', async () => {
  await inWorld({}, async (w) => {
    const dana = await joinPerson(w, 'b', 'Dana Developer', 'dana@example.invalid');
    const confirmed = await w.a.log.append(() => [{ type: 'member.role-changed', body: { memberId: dana.memberId, role: 'developer' } }]);
    assert.equal(confirmed.ok, true, confirmed.ok ? '' : confirmed.reason);
    stub.messageAnswers.push('Send key');
    const owner = await startSession(w, 'owner');
    assert.deepEqual(infoMessages(), ['Dana Developer is confirmed and still needs a NEAR key']);
    assert.deepEqual(stub.notificationActions[0], ['Send key']);
    await until(() => owner.commands.length > 0, 'the Send key command');
    assert.deepEqual(owner.commands, [{ id: MANAGE_MEMBERS_COMMAND, args: { memberId: dana.memberId, action: 'deliver-key' } }]);
    await owner.session.sync();
    assert.equal(infoMessages().length, 1, 'once');
  });
  await inWorld({ near: false }, async (w) => {
    const dana = await joinPerson(w, 'b', 'Dana Developer', 'dana@example.invalid');
    const confirmed = await w.a.log.append(() => [{ type: 'member.role-changed', body: { memberId: dana.memberId, role: 'developer' } }]);
    assert.equal(confirmed.ok, true, confirmed.ok ? '' : confirmed.reason);
    await startSession(w, 'owner');
    assert.deepEqual(infoMessages(), [], 'without a NEAR organization there is no key to send');
  });
});

void JOIN_COMMAND;
