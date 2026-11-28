// Who is in a multi-user staff project (31-20; D-09, D-10, D-13 to D-18, D-22, D-23, D-37, D-45): two and more installs, each with its own project
// folder, extension storage and secret storage, invite, join, admit and welcome each other by file and six spoken words; every wrong invitation is
// refused in plain words; removing a member or a device, or lowering a clearance, moves the affected cells to new keys; and the lead and the deputy
// keep the roster whole through a split, a deputy and a handover.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test, { after, mock } from 'node:test';
import type { ScaleTable } from '../domain/gate/labels';
import { REKEY_KEEP_TEXT, buildGrant, grantHash, newEpochKey, readGrant, sealLabel, unwrapEpochKey, wrapEpochKey } from '../domain/replica/cellKeys';
import { clientIdOf } from '../domain/replica/clientIds';
import { entryHash, sealBlob, writerIdOf } from '../domain/replica/entry';
import { readGrantPages } from '../domain/replica/grantPages';
import { INVITE_FILE_EXTENSION, JOIN_REQUEST_FILE_EXTENSION, WELCOME_FILE_EXTENSION, buildInvite, buildJoinRequest, inviteSafetyCode, joinSecretHash, newJoinSecret, readInvite } from '../domain/replica/invite';
import { MEMBER_REFUSALS, deviceAt, inviteAt, memberAt, x25519At } from '../domain/replica/rosterMembers';
import { ROSTER_REFUSALS, ROSTER_SPLIT_TEXT, deputyAt, isRosterWriterAt, leadAt, managedWriteAllowed, rosterView } from '../domain/replica/roster';
import type { RosterState } from '../domain/replica/roster';
import { committedGrant, epochAt } from '../domain/replica/rosterCells';
import { accessPermitBytes, accessRevisionId, buildAccessCommitment } from '../domain/replica/rotationProof';
import { sessionCertifyData } from '../domain/replica/sessionKeys';
import type { SignOptions } from '../domain/team/signedPayload';
import { grantEvidenceHash, readGrantDelivery, storedAccessProofs } from '../domain/replica/rotationGrants';
import { verifyEntry } from '../domain/replica/verify';
import { clientReplicaFeatures } from '../staff/replica/requireGate';
import { REPLICA_DIR, multiUserNoticeLines } from '../domain/staff/multiUser';
import { canonicalBytes } from '../domain/team/canonical';
import type { SecretStorageLike } from '../services/auth';
import { ENCRYPTION_KEY_SECRET, JOIN_SECRET_PREFIX, loadOrCreateEncryptionKey, loadOrCreateKemKeys } from '../staff/replica/keyring';
import { unwrapForDevice } from '../domain/replica/cellWrapV2';
import { identityDir } from '../team/identity';
import {
  MEMBERSHIP_REFUSALS, addMyOtherMachine, admitJoinRequest, cellOrderHook, chooseRosterBranch, describeRosterBranches, finishRekeys, handOverLead, inviteToProject, joinFromInvite, nameDeputy,
  openWelcome, pendingInvitationsDir, remakeWelcome, removeFromProject, reviewJoinRequest, unfinishedRekeys, updateMember, voidInvite
} from '../staff/replica/membership';
import type { MembershipResult, SharedProjectHost } from '../staff/replica/membership';
import { ensureLabelCell } from '../staff/replica/labelCells';
import { exchangeManaged, fetchManaged } from '../staff/replica/managedSync';
import type { ManagedSyncHandoffs } from '../staff/replica/managedSync';
import { hubMemoryOf, syncOnce } from '../staff/replica/hubSync';
import type { SyncLocal, SyncTransport } from '../staff/replica/hubSync';
import { ReplicaProject, ReplicaProjectError, genesisPinFile, isProjectRefused, syncLocalOf } from '../staff/replica/replicaProject';
import { STORE_REFUSALS } from '../staff/replica/store';
import { newEpochPages } from '../staff/replica/wrapPlan';
import { managedIssuanceCurrent, prepareManagedIssuance, readManagedIssuance } from '../staff/replica/managedIssuance';
import { openManagedGrantDelivery, readManagedKeyFile, sealManagedContinuityDelivery, sealManagedGrantDelivery } from '../staff/replica/managedGrantDelivery';
import { setFolderSyncProbe } from '../staff/staffFiles';
import { fixedSigner } from './helpers/replicaWorld';
import { managedRecipients, prepareHostedFinish, selectedManagedAccess } from '../staff/replica/managedRecovery';
import { appendManagedAccess, appendManagedWithdrawal, managedAccessActionBytes } from '../staff/replica/managedWithdrawal';
import type { AppendOwnResult, ProjectRefused, ReplicaProjectDeps } from '../staff/replica/replicaProject';

class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

const NOW = new Date('2026-11-20T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const DEMO_SCALES: ScaleTable = { demo: { name: 'Demo', levels: ['OFFICIAL', 'SECRET'] } };
const OFFICIAL = { scale: 'demo', level: 'OFFICIAL', compartments: [], releasability: [] };
const CLEARED_X = { scale: 'demo', level: 'SECRET', compartments: ['KESTREL'], releasability: [] };
const LABEL_X = { scale: 'demo', level: 'SECRET', compartments: ['KESTREL'], releasability: [], handling: [] };
const LABEL_Z = { scale: 'demo', level: 'SECRET', compartments: ['OSPREY'], releasability: [], handling: [] };

interface Install { root: string; global: string; secrets: MemorySecrets; deps: ReplicaProjectDeps; clock: { now: Date } }

/** One install: its own project folder, extension storage and secret storage, and a clock the test can move. */
function install(label: string): Install {
  const base = mkdtempSync(path.join(tmpdir(), `near-ai-membership-${label}-`));
  const secrets = new MemorySecrets();
  const clock = { now: NOW };
  const global = path.join(base, 'global');
  return { root: path.join(base, 'project'), global, secrets, clock, deps: { secrets, globalStorageDir: global, now: () => clock.now } };
}

const opened: ReplicaProject[] = [];
after(async () => {
  for (const project of opened) await project.close();
});

function project(value: ReplicaProject | ProjectRefused | undefined): ReplicaProject {
  assert.ok(value instanceof ReplicaProject, `the project opens (${isProjectRefused(value) ? value.refused : String(value)})`);
  opened.push(value);
  return value;
}

interface Lead { at: Install; p: ReplicaProject; host: SharedProjectHost }

async function founded(label = 'lead'): Promise<Lead> {
  const at = install(label);
  const p = project(await ReplicaProject.createSharedProject(at.root, at.deps, { name: 'Exercise Northwind', profile: 'j2', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: 'mbr-lead' } }));
  return { at, p, host: { project: p, deps: at.deps, scales: DEMO_SCALES } };
}

const hostOf = (p: ReplicaProject, at: Install): SharedProjectHost => ({ project: p, deps: at.deps, scales: DEMO_SCALES });

function ok<T extends MembershipResult>(result: T, what: string): T {
  assert.equal(result.ok, true, `${what}: ${result.reason ?? ''} ${result.message}`);
  return result;
}

function file(result: MembershipResult): { name: string; text: string } {
  assert.ok(result.file !== undefined, 'the result carries a file');
  return result.file;
}

async function head(p: ReplicaProject): Promise<{ roster: RosterState; hash: string; position: number }> {
  const { roster } = await p.state();
  return { roster, hash: roster.positions[roster.positions.length - 1], position: roster.positions.length - 1 };
}

interface Person { at: Install; p: ReplicaProject; host: SharedProjectHost; member: string; writer: string; results: MembershipResult[] }

/** The whole flow for one person: the lead invites, the person answers, the lead admits with the words confirmed, the person opens the welcome. */
async function bringIn(lead: Lead, label: string, name: string, clearance: unknown, options: { agentSeats?: string[] } = {}): Promise<Person> {
  const at = install(label);
  const invited = ok(await inviteToProject(lead.host, { name, seat: 'j2-analyst', clearance }), 'invite');
  const joined = ok(await joinFromInvite(at.root, at.deps, file(invited).text, { name }), 'join');
  const admitted = ok(await admitJoinRequest(lead.host, file(joined).text, { codeMatched: true, ...(options.agentSeats === undefined ? {} : { agentSeats: options.agentSeats }) }), 'admit');
  const welcomed = ok(await openWelcome(at.root, at.deps, file(admitted).text), 'welcome');
  const p = project(welcomed.project);
  return { at, p, host: hostOf(p, at), member: admitted.member as string, writer: p.deviceWriter, results: [invited, joined, admitted, welcomed] };
}

/** Add My Other Machine: the lead makes the short invitation for the member, the member's other computer answers, the lead admits it as device.add. */
async function addMachine(lead: Lead, member: string, label: string, name: string): Promise<Person> {
  const at = install(label);
  const invited = ok(await addMyOtherMachine(lead.host, { member }), 'add my other machine');
  const joined = ok(await joinFromInvite(at.root, at.deps, file(invited).text, { name }), 'join as other machine');
  const admitted = ok(await admitJoinRequest(lead.host, file(joined).text, { codeMatched: true }), 'admit other machine');
  const welcomed = ok(await openWelcome(at.root, at.deps, file(admitted).text), 'welcome other machine');
  const p = project(welcomed.project);
  return { at, p, host: hostOf(p, at), member, writer: p.deviceWriter, results: [invited, joined, admitted, welcomed] };
}

/** Every signed grant in an install's store, read from disk. */
function grantsOn(at: Install): unknown[] {
  const dir = path.join(at.root, ...REPLICA_DIR.split('/'), 'grants');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((cell) => readdirSync(path.join(dir, cell)).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(path.join(dir, cell, name), 'utf8')) as unknown));
}

/** What a transport would carry, done by hand: the roster entries `from` holds and every grant on its disk, into `to`. */
async function sync(from: { at: Install; p: ReplicaProject }, to: { p: ReplicaProject }): Promise<void> {
  const welcome = await from.p.welcomeFor(to.p.deviceWriter, []);
  const result = await to.p.ingestForeign([welcome.genesis, ...welcome.roster], welcome.blobs);
  assert.ok(!isProjectRefused(result), 'the entries are taken');
  const stored = await to.p.putGrants(grantsOn(from.at));
  assert.ok(!isProjectRefused(stored), 'the grants are taken');
}

/** The lead makes a labelled cell at the head, with its founding grant wrapped to the given devices (cell.create; no command makes one in Phase 31). */
/** A new cell's founding grant as the product makes it (33.2-06): each wrap through the one entry point, in the format formatFor gives a new epoch. */
function foundingFor(lead: { p: ReplicaProject }, roster: RosterState, input: { cell: string; key: Buffer; to: readonly string[]; labelSealed: string }): ReturnType<typeof buildGrant> {
  const pages = newEpochPages(lead.p.signer, roster, { cell: input.cell, info: { base: false }, epoch: 1, key: input.key, recipients: input.to, labelSealed: input.labelSealed });
  assert.ok(pages !== 'switch-first' && pages.length === 1, 'one founding page');
  return pages[0];
}

async function createCell(lead: Lead, label: unknown, to: readonly string[], cell = randomBytes(16).toString('hex')): Promise<string> {
  const at = await head(lead.p);
  const key = newEpochKey();
  const founding = foundingFor(lead, at.roster, { cell, key, to, labelSealed: sealLabel(key, cell, 1, label) });
  await lead.p.keys.addOwn(cell, 1, key, grantHash(founding));
  assert.ok(!isProjectRefused(await lead.p.putGrants([founding])));
  const written = await lead.p.appendOwn('cell.create', { cell, epoch: 1, grant: grantHash(founding) }, { roster: at.hash });
  assert.ok('ok' in written);
  assert.equal((await head(lead.p)).hash, written.hash, 'the cell is created');
  return cell;
}

interface Team { lead: Lead; x: string; z: string; m: Person; n: Person }

/**
 * Cells base, X (SECRET KESTREL) and Z (SECRET OSPREY), made by the lead before anyone joins; M is cleared for X (SECRET with KESTREL), N for the base
 * cell only (OFFICIAL). Nobody but the lead is cleared for Z.
 */
async function team(options: { nClearance?: unknown } = {}): Promise<Team> {
  const lead = await founded();
  const x = await createCell(lead, LABEL_X, [lead.p.deviceWriter]);
  const z = await createCell(lead, LABEL_Z, [lead.p.deviceWriter]);
  const m = await bringIn(lead, 'm', 'Mo Analyst', CLEARED_X);
  const n = await bringIn(lead, 'n', 'Nell Planner', options.nClearance ?? OFFICIAL);
  return { lead, x, z, m, n };
}

/** Every value in an install's secret storage, and each epoch key inside the cached key ring values. */
function secretsOf(...installs: Install[]): string[] {
  const found: string[] = [];
  for (const at of installs) {
    for (const [name, value] of at.secrets.values) {
      found.push(value);
      if (!name.startsWith('nearAi.staff.epochKeys.')) continue;
      const ring = JSON.parse(value) as { keys: Array<[string, number, string]>; own: Array<[string, number, string, string]> };
      for (const item of ring.keys) found.push(item[2]);
      for (const item of ring.own) found.push(item[3]);
    }
  }
  return found;
}

/** The parts of a result that are never allowed to hold a secret, a key or a MAC: everything but an invitation's or join request's own file text. */
function visible(result: MembershipResult): string {
  const { file: carried, project: _project, ...rest } = result as MembershipResult & { project?: unknown };
  const keepText = carried !== undefined && carried.name.endsWith(WELCOME_FILE_EXTENSION);
  return JSON.stringify({ ...rest, ...(carried === undefined ? {} : { file: { name: carried.name, ...(keepText ? { text: carried.text } : {}) } }) });
}

// ---- Task 1: invite, join, admit, welcome ---------------------------------------------------------------------------------------------------------

test('invite by file: member.invite holds only the sha256 of a fresh secret, the secret is kept in the lead\'s secret storage, and the .near-staff-invite file carries it only inside its signed payload', async () => {
  const lead = await founded();
  const before = await head(lead.p);
  const invited = ok(await inviteToProject(lead.host, { name: 'Jo Analyst', seat: 'j2-chief', clearance: OFFICIAL }), 'invite');
  const id = invited.invite as string;
  assert.ok(file(invited).name.endsWith(INVITE_FILE_EXTENSION));
  assert.equal(file(invited).name, `${id}${INVITE_FILE_EXTENSION}`);
  const secret = lead.at.secrets.values.get(JOIN_SECRET_PREFIX + id) as string;
  assert.equal(typeof secret, 'string');
  assert.equal(Buffer.from(secret, 'base64url').length, 32);
  const text = file(invited).text;
  assert.equal(text.split(secret).length - 1, 1, 'the secret appears once in the file');
  const read = readInvite(text, NOW);
  assert.ok(read.ok);
  assert.equal(read.invite.secret, secret, 'inside the signed payload');
  // Open for the default seven days.
  assert.equal(read.invite.expiresAt, new Date(NOW.getTime() + 7 * DAY_MS).toISOString());
  const after = await head(lead.p);
  assert.equal(after.position, before.position + 1, 'member.invite applied');
  const record = after.roster.members.invites.get(id);
  assert.equal(record?.secretHash, joinSecretHash(secret));
  assert.ok(!JSON.stringify(record).includes(secret), 'the roster holds only the hash');
  assert.deepEqual(inviteAt(after.roster.members, id, after.position)?.state, 'open');
  assert.deepEqual(invited.notices, multiUserNoticeLines());
});

test('two installs: B joins from the invite file with its own keys and gets a .near-staff-join file and six words; A reviews the request and sees the same six words', async () => {
  const lead = await founded();
  const b = install('b');
  const invited = ok(await inviteToProject(lead.host, { name: 'Jo Analyst', seat: 'j2-chief', clearance: OFFICIAL }), 'invite');
  const joined = ok(await joinFromInvite(b.root, b.deps, file(invited).text, { name: 'Jo Analyst' }), 'join');
  assert.equal(file(joined).name, `join-${invited.invite as string}${JOIN_REQUEST_FILE_EXTENSION}`);
  assert.equal(joined.safetyWords?.length, 6);
  // Changed for MN-01: B used to pin the genesis here. It now keeps the invitation's anchor and inviter outside the project until the welcome arrives,
  // and pins nothing yet, so a bogus invitation can never block the real one.
  assert.equal(existsSync(genesisPinFile(b.global, lead.p.projectId)), false, 'nothing pinned before the welcome');
  const kept = readdirSync(pendingInvitationsDir(b.global, lead.p.projectId));
  assert.equal(kept.length, 1);
  const pending = JSON.parse(readFileSync(path.join(pendingInvitationsDir(b.global, lead.p.projectId), kept[0]), 'utf8')) as { anchor: { genesisHash: string }; inviter: { writer: string } };
  assert.equal(pending.anchor.genesisHash, lead.p.anchor.genesisHash);
  assert.equal(pending.inviter.writer, lead.p.deviceWriter);
  const reviewed = ok(await reviewJoinRequest(lead.host, file(joined).text), 'review');
  assert.deepEqual(reviewed.safetyWords, joined.safetyWords);
  // The words come from the invite and both devices' keys (31-16): computed independently on A's side.
  const read = readInvite(file(invited).text, NOW);
  assert.ok(read.ok);
  const request = JSON.parse(file(joined).text) as { payload: { publicKey: string; x25519: string; nonce: string } };
  assert.deepEqual(inviteSafetyCode(read.invite, request.payload), joined.safetyWords);
  // Reviewing writes nothing.
  assert.equal((await head(lead.p)).roster.members.members.size, 1);
  for (const result of [invited, joined, reviewed]) assert.deepEqual(result.notices, multiUserNoticeLines());
});

test('admit with the words confirmed: member.admit at slot 2 with the invitation\'s seat, roles and clearance, the base cell granted at the admission roster, the join secret forgotten while every other secret stays, and a .near-staff-welcome file', async () => {
  const lead = await founded();
  const b = install('b');
  const invited = ok(await inviteToProject(lead.host, { name: 'Jo Analyst', seat: 'j2-chief', clearance: OFFICIAL }), 'invite');
  const id = invited.invite as string;
  const joined = ok(await joinFromInvite(b.root, b.deps, file(invited).text, { name: 'Jo Analyst' }), 'join');
  const before = new Map(lead.at.secrets.values);
  assert.ok(before.has(JOIN_SECRET_PREFIX + id));
  const admitted = ok(await admitJoinRequest(lead.host, file(joined).text, { codeMatched: true, agentSeats: ['release-guard'] }), 'admit');
  assert.equal(file(admitted).name, `welcome-${id}${WELCOME_FILE_EXTENSION}`);
  assert.deepEqual(admitted.safetyWords, joined.safetyWords);
  const { roster, hash, position } = await head(lead.p);
  const member = memberAt(roster.members, admitted.member as string, position);
  assert.equal(member?.name, 'Jo Analyst');
  assert.equal(member?.seat, 'j2-chief');
  assert.deepEqual(member?.roles, ['member']);
  assert.deepEqual(member?.clearance, OFFICIAL);
  assert.deepEqual(member?.agentSeats, ['release-guard']);
  assert.equal(roster.members.devices.get(joined.writer as string)?.[0]?.slot, 2);
  assert.equal(inviteAt(roster.members, id, position)?.state, 'used');
  assert.deepEqual(rosterView(roster).cellGrantees?.(lead.p.projectId, hash), [lead.p.deviceWriter, joined.writer as string].sort());
  assert.deepEqual(admitted.granted, [lead.p.projectId]);
  // The join secret is gone; every other value is exactly as it was.
  assert.equal(lead.at.secrets.values.has(JOIN_SECRET_PREFIX + id), false);
  for (const name of before.keys()) if (name !== JOIN_SECRET_PREFIX + id) assert.ok(lead.at.secrets.values.has(name), name);
  for (const name of ['nearAi.identity.deviceKey', 'nearAi.identity.encryptionKey', `nearAi.staff.epochKeys.${lead.p.projectId}`]) assert.equal(lead.at.secrets.values.get(name), before.get(name), name);
  assert.deepEqual(admitted.notices, multiUserNoticeLines());
});

test('openWelcome: B\'s own ReplicaProject shows B admitted with its slot, the base cell key opened and the same roster head as A; every result carried the notices', async () => {
  const lead = await founded();
  const b = await bringIn(lead, 'b', 'Jo Analyst', OFFICIAL);
  const a = await head(lead.p);
  const mine = await head(b.p);
  assert.equal(mine.hash, a.hash);
  assert.deepEqual(mine.roster.positions, a.roster.positions);
  assert.equal(rosterView(mine.roster).isAdmitted(b.writer, mine.hash), true);
  assert.equal(mine.roster.members.devices.get(b.writer)?.[0]?.slot, 2);
  assert.deepEqual(b.p.keys.epochKey(b.p.projectId, 1), lead.p.keys.epochKey(lead.p.projectId, 1));
  for (const result of b.results) assert.deepEqual(result.notices, multiUserNoticeLines());
  // A third person gets the next slot.
  const c = await bringIn(lead, 'c', 'Cy Liaison', OFFICIAL);
  assert.equal((await head(lead.p)).roster.members.devices.get(c.writer)?.[0]?.slot, 3);
});

test('admission grants every epoch of the cells the declared clearance dominates and nothing else (D-22, D-45): M gets the base cell and X, N only the base cell, nobody but the lead Z', async () => {
  const t = await team();
  const { roster, hash } = await head(t.lead.p);
  const view = rosterView(roster);
  assert.deepEqual(view.cellGrantees?.(t.x, hash), [t.lead.p.deviceWriter, t.m.writer].sort());
  assert.deepEqual(view.cellGrantees?.(t.z, hash), [t.lead.p.deviceWriter]);
  assert.deepEqual(view.cellGrantees?.(t.lead.p.projectId, hash), [t.lead.p.deviceWriter, t.m.writer, t.n.writer].sort());
  assert.ok(t.m.p.keys.epochKey(t.x, 1) !== undefined, 'M opens X');
  assert.equal(t.n.p.keys.epochKey(t.x, 1), undefined, 'N does not');
  assert.equal(t.m.p.keys.epochKey(t.z, 1), undefined, 'M does not open Z');
  assert.deepEqual(t.m.results[2].granted, [t.lead.p.projectId, t.x].sort());
  assert.deepEqual(t.n.results[2].granted, [t.lead.p.projectId]);
  // A later person cleared for X gets it too.
  const cleared = await bringIn(t.lead, 'o', 'Ola Watch', CLEARED_X);
  assert.ok(cleared.p.keys.epochKey(t.x, 1) !== undefined);
});

test('cellOrderHook: a cell may cite the base cell and a cell its label dominates, never down or sideways, and a cell this device cannot read answers no', async () => {
  const t = await team();
  const order = cellOrderHook({ scales: DEMO_SCALES, now: () => NOW })((await t.lead.p.state()).roster, t.lead.p.keys);
  const base = t.lead.p.projectId;
  assert.equal(order(t.x, base), true);
  assert.equal(order(base, t.x), false);
  assert.equal(order(t.x, t.z), false);
  assert.equal(order(t.z, t.x), false);
  // N's computer cannot read X's or Z's label: every cell may still cite the base cell, and anything about X or Z answers no.
  const fromN = cellOrderHook({ scales: DEMO_SCALES, now: () => NOW })((await t.n.p.state()).roster, t.n.p.keys);
  assert.equal(fromN(t.x, base), true);
  assert.equal(fromN(base, t.x), false);
  assert.equal(fromN(t.z, t.x), false);
});

// ---- Task 2: refusals, Add My Other Machine, voiding ----------------------------------------------------------------------------------------------

async function invitedAndJoined(lead: Lead, label = 'b', options: { days?: number } = {}): Promise<{ at: Install; invited: MembershipResult; joined: MembershipResult }> {
  const at = install(label);
  const invited = ok(await inviteToProject(lead.host, { name: 'Jo Analyst', seat: 'j2-chief', clearance: OFFICIAL, ...options }), 'invite');
  const joined = ok(await joinFromInvite(at.root, at.deps, file(invited).text, { name: 'Jo Analyst' }), 'join');
  return { at, invited, joined };
}

test('code-not-confirmed: admitting without the lead\'s confirmation that the words matched is refused and writes nothing', async () => {
  const lead = await founded();
  const { invited, joined } = await invitedAndJoined(lead);
  const before = await head(lead.p);
  for (const codeMatched of [false, undefined, 'yes', 1] as unknown[]) {
    const result = await admitJoinRequest(lead.host, file(joined).text, { codeMatched: codeMatched as boolean });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'code-not-confirmed');
    assert.equal(result.message, MEMBERSHIP_REFUSALS['code-not-confirmed']);
    assert.equal(result.file, undefined);
  }
  const after = await head(lead.p);
  assert.equal(after.hash, before.hash, 'the roster did not move');
  assert.ok(lead.at.secrets.values.has(JOIN_SECRET_PREFIX + (invited.invite as string)), 'the secret is kept');
});

test('invite-expired: an invitation read after its expiry is refused on the joining side and nothing is pinned; a request admitted after the expiry is refused too', async () => {
  const lead = await founded();
  const late = install('late');
  const invited = ok(await inviteToProject(lead.host, { name: 'Jo Analyst', seat: 'j2-chief', clearance: OFFICIAL, days: 2 }), 'invite');
  late.clock.now = new Date(NOW.getTime() + 3 * DAY_MS);
  const refused = await joinFromInvite(late.root, late.deps, file(invited).text, { name: 'Jo Analyst' });
  assert.equal(refused.reason, 'invite-expired');
  assert.equal(refused.message, MEMBERSHIP_REFUSALS['invite-expired']);
  assert.equal(existsSync(genesisPinFile(late.global, lead.p.projectId)), false, 'nothing pinned');
  // Answered in time, admitted too late.
  const { joined } = await invitedAndJoined(lead, 'b', { days: 2 });
  lead.at.clock.now = new Date(NOW.getTime() + 3 * DAY_MS);
  const before = await head(lead.p);
  const admitted = await admitJoinRequest(lead.host, file(joined).text, { codeMatched: true });
  assert.equal(admitted.reason, 'invite-expired');
  assert.equal(admitted.message, MEMBERSHIP_REFUSALS['invite-expired']);
  assert.equal((await head(lead.p)).hash, before.hash);
});

test('invite-used: a second join request for an invitation already used is refused, and nothing is written', async () => {
  const lead = await founded();
  const { invited, joined } = await invitedAndJoined(lead);
  ok(await admitJoinRequest(lead.host, file(joined).text, { codeMatched: true }), 'first admit');
  const other = install('other');
  const again = ok(await joinFromInvite(other.root, other.deps, file(invited).text, { name: 'Someone Else' }), 'a second answer');
  const before = await head(lead.p);
  for (const text of [file(again).text, file(joined).text]) {
    const result = await admitJoinRequest(lead.host, text, { codeMatched: true });
    assert.equal(result.reason, 'invite-used');
    assert.equal(result.message, MEMBERSHIP_REFUSALS['invite-used']);
  }
  assert.equal((await head(lead.p)).hash, before.hash);
});

test('invite-voided: voidInvite writes invite.void and forgets the join secret; a request for it is then refused, and voiding it twice is refused', async () => {
  const lead = await founded();
  const { invited, joined } = await invitedAndJoined(lead);
  const id = invited.invite as string;
  const others = new Map([...lead.at.secrets.values].filter(([name]) => name !== JOIN_SECRET_PREFIX + id));
  const voided = ok(await voidInvite(lead.host, id), 'void');
  assert.deepEqual(voided.notices, multiUserNoticeLines());
  const { roster, position } = await head(lead.p);
  assert.equal(inviteAt(roster.members, id, position)?.state, 'voided');
  assert.equal(lead.at.secrets.values.has(JOIN_SECRET_PREFIX + id), false);
  for (const name of others.keys()) assert.ok(lead.at.secrets.values.has(name), name);
  const result = await admitJoinRequest(lead.host, file(joined).text, { codeMatched: true });
  assert.equal(result.reason, 'invite-voided');
  assert.equal(result.message, MEMBERSHIP_REFUSALS['invite-voided']);
  assert.equal((await voidInvite(lead.host, id)).reason, 'invite-voided');
  assert.equal((await voidInvite(lead.host, 'inv-nothing')).reason, 'unknown-invite');
});

test('wrong-secret: a request made with another secret is refused, the secret is kept and the invitation still admits the right request', async () => {
  const lead = await founded();
  const { invited, joined } = await invitedAndJoined(lead);
  const id = invited.invite as string;
  const read = readInvite(file(invited).text, NOW);
  assert.ok(read.ok);
  const forger = install('forger');
  const device = await ReplicaProject.localDevice(forger.deps);
  const forged = JSON.stringify(buildJoinRequest(device.signer, { ...read.invite, secret: newJoinSecret() }, { name: 'Jo Analyst', x25519: device.x25519, now: NOW }));
  const result = await admitJoinRequest(lead.host, forged, { codeMatched: true });
  assert.equal(result.reason, 'wrong-secret');
  assert.equal(result.message, MEMBERSHIP_REFUSALS['wrong-secret']);
  assert.ok(lead.at.secrets.values.has(JOIN_SECRET_PREFIX + id));
  ok(await admitJoinRequest(lead.host, file(joined).text, { codeMatched: true }), 'the right request');
  // unknown-invite: a request for an invitation the project does not have.
  const unknown = JSON.stringify(buildJoinRequest(device.signer, { ...read.invite, invite: 'inv-unknown' }, { name: 'Jo Analyst', x25519: device.x25519, now: NOW }));
  assert.equal((await admitJoinRequest(lead.host, unknown, { codeMatched: true })).reason, 'unknown-invite');
});

test('folder-has-staff-project: joining into a folder that holds today\'s staff ledgers, or another shared project, is refused and changes nothing', async () => {
  const lead = await founded();
  const invited = ok(await inviteToProject(lead.host, { name: 'Jo Analyst', seat: 'j2-chief', clearance: OFFICIAL }), 'invite');
  const ledgers = install('ledgers');
  mkdirSync(path.join(ledgers.root, '.planning', 'staff', 'ledger'), { recursive: true });
  writeFileSync(path.join(ledgers.root, '.planning', 'staff', 'ledger', 'products.jsonl'), '');
  const refused = await joinFromInvite(ledgers.root, ledgers.deps, file(invited).text, { name: 'Jo Analyst' });
  assert.equal(refused.reason, 'folder-has-staff-project');
  assert.equal(refused.message, MEMBERSHIP_REFUSALS['folder-has-staff-project']);
  assert.equal(existsSync(genesisPinFile(ledgers.global, lead.p.projectId)), false);
  assert.deepEqual(readdirSync(path.join(ledgers.root, '.planning', 'staff')), ['ledger']);
  // A folder holding another shared project: the other lead's own folder.
  const other = await founded('other');
  const into = await joinFromInvite(other.at.root, other.at.deps, file(invited).text, { name: 'Jo Analyst' });
  assert.equal(into.reason, 'folder-has-staff-project');
  assert.equal(existsSync(genesisPinFile(other.at.global, lead.p.projectId)), false);
});

test('Add My Other Machine: a short invitation for an existing member, answered by that member\'s second install, is admitted as device.add with a new slot and the invitation is used', async () => {
  const t = await team();
  const before = await head(t.lead.p);
  const second = await addMachine(t.lead, t.m.member, 'm2', 'Mo Analyst');
  const { roster, position, hash } = await head(t.lead.p);
  assert.equal(position, before.position + 2, 'member.invite then device.add');
  const added = roster.members.devices.get(second.writer)?.[0];
  assert.equal(added?.member, t.m.member);
  assert.equal(added?.slot, 4, 'the next slot after the lead (1), M (2) and N (3)');
  const id = second.results[0].invite as string;
  assert.equal(inviteAt(roster.members, id, position)?.state, 'used');
  assert.equal(roster.members.invites.get(id)?.forMember, t.m.member);
  assert.equal(roster.members.members.get(t.m.member)?.length, 1, 'no second member record');
  // The other machine gets the cells its member is cleared for.
  assert.deepEqual(rosterView(roster).cellGrantees?.(t.x, hash), [t.lead.p.deviceWriter, t.m.writer, second.writer].sort());
  assert.ok(second.p.keys.epochKey(t.x, 1) !== undefined);
  // The lead's own other machine: the lead declares no clearance, so it gets the cells the lead's device holds.
  const leadTwo = await addMachine(t.lead, 'mbr-lead', 'a2', 'Lee Lead');
  for (const cell of [t.lead.p.projectId, t.x, t.z]) assert.ok(leadTwo.p.keys.epochKey(cell, 1) !== undefined, cell);
  // An unknown member cannot be given another machine.
  assert.equal((await addMyOtherMachine(t.lead.host, { member: 'mbr-nobody' })).reason, 'member-unknown');
});

test('no message, file name or result field contains a join secret, a key or the MAC', async () => {
  const lead = await founded();
  const results: MembershipResult[] = [];
  const b = await bringIn(lead, 'b', 'Jo Analyst', OFFICIAL);
  results.push(...b.results);
  const { invited, joined } = await invitedAndJoined(lead, 'c');
  results.push(invited, joined);
  const mac = (JSON.parse(file(joined).text) as { payload: { mac: string } }).payload.mac;
  const secret = (readInvite(file(invited).text, NOW) as { invite: { secret: string } }).invite.secret;
  results.push(await reviewJoinRequest(lead.host, file(joined).text));
  results.push(await admitJoinRequest(lead.host, file(joined).text, { codeMatched: false }));
  results.push(await voidInvite(lead.host, invited.invite as string));
  results.push(await admitJoinRequest(lead.host, file(joined).text, { codeMatched: true }));
  results.push(await removeFromProject(lead.host, { member: b.member }));
  const forbidden = [mac, secret, ...secretsOf(lead.at, b.at)].filter((value) => value.length >= 32);
  assert.ok(forbidden.length > 6);
  for (const result of results) {
    const text = visible(result);
    for (const value of forbidden) assert.ok(!text.includes(value), `a result field holds a secret: ${result.message}`);
    assert.ok(!/\u2014/.test(result.message), 'no em-dash');
  }
  for (const message of Object.values(MEMBERSHIP_REFUSALS)) assert.ok(!/\u2014/.test(message));
  // The two texts that carry a secret by design (D-08): the join secret only at the invitation's payload.secret, the MAC only at the join request's
  // payload.mac, and with that one field taken out, neither text holds any forbidden value.
  const pairs = [{ invite: b.results[0], join: b.results[1] }, { invite: invited, join: joined }];
  for (const pair of pairs) {
    const inviteText = file(pair.invite).text;
    const joinText = file(pair.join).text;
    const ownSecret = (readInvite(inviteText, NOW) as { invite: { secret: string } }).invite.secret;
    const inviteValue = JSON.parse(inviteText) as { payload: Record<string, unknown> };
    assert.equal(inviteValue.payload.secret, ownSecret, 'the invitation carries its join secret at payload.secret');
    delete inviteValue.payload.secret;
    const joinValue = JSON.parse(joinText) as { payload: Record<string, unknown> };
    const ownMac = joinValue.payload.mac;
    assert.equal(typeof ownMac, 'string');
    if (pair.join === joined) assert.equal(ownMac, mac);
    delete joinValue.payload.mac;
    const searched = [...forbidden, ownSecret, ownMac as string];
    const inviteRest = JSON.stringify(inviteValue);
    for (const value of searched) assert.ok(!inviteRest.includes(value), 'the invitation holds a secret outside payload.secret');
    assert.ok(!joinText.includes(ownSecret) && !joinText.includes(secret), 'the join request holds no join secret');
    const joinRest = JSON.stringify(joinValue);
    for (const value of searched) assert.ok(!joinRest.includes(value), 'the join request holds a secret outside payload.mac');
  }
});

test('only the lead or the deputy writes the roster: a member\'s invite, void, removal and update are refused not-a-roster-writer and change nothing', async () => {
  const t = await team();
  const before = await head(t.m.p);
  const attempts = [
    await inviteToProject(t.m.host, { name: 'Pat', seat: 'j2-chief', clearance: OFFICIAL }),
    await voidInvite(t.m.host, 'inv-anything'),
    await removeFromProject(t.m.host, { member: t.n.member }),
    await updateMember(t.m.host, { member: t.n.member, name: 'Nell P' }),
    await nameDeputy(t.m.host, t.n.member),
    await handOverLead(t.m.host, { to: t.m.member, reason: 'lead-lost' })
  ];
  for (const result of attempts) {
    assert.equal(result.reason, 'not-a-roster-writer');
    assert.equal(result.message, MEMBERSHIP_REFUSALS['not-a-roster-writer']);
  }
  assert.equal((await head(t.m.p)).hash, before.hash);
});

// ---- Task 3: remove, revoke, change clearance: rekey ----------------------------------------------------------------------------------------------

for (const { kind, failure } of [
  { kind: 'member.remove', failure: 'pre-write' },
  { kind: 'member.remove', failure: 'confirmation' },
  { kind: 'device.revoke', failure: 'confirmation' },
  { kind: 'member.update', failure: 'confirmation' },
  { kind: 'member.remove', failure: 'rotation refresh' },
  { kind: 'member.remove', failure: 'rotation signature' },
  { kind: 'member.remove', failure: 'rotation confirmation' }
] as const) {
  test(`${kind} reports the verified stage when the project refuses ${failure}`, async () => {
    const { lead, n, x } = await team({ nClearance: CLEARED_X });
    const { p } = lead;
    const before = await head(p);
    const refusal = new ReplicaProjectError({ refused: 'store-refused', message: STORE_REFUSALS.unreadable, store: 'unreadable' });
    const append = p.appendOwn.bind(p);
    const state = p.state.bind(p);
    const signGrantPages = p.signGrantPages.bind(p);
    const writes: string[] = [];
    let saved: string | undefined;
    let rekeySaved: string | undefined;
    let readsAfterSave = 0;
    const appendMock = mock.method(p, 'appendOwn', async (...args: Parameters<typeof append>) => {
      writes.push(args[0]);
      if (failure === 'pre-write') throw refusal;
      const result = await append(...args);
      if ('ok' in result && args[0] === kind) saved = result.hash;
      if ('ok' in result && args[0] === 'cell.rekey') rekeySaved = result.hash;
      return result;
    });
    const stateMock = mock.method(p, 'state', async () => {
      if (saved !== undefined) readsAfterSave += 1;
      if ((failure === 'confirmation' && readsAfterSave === 1) ||
        (failure === 'rotation refresh' && readsAfterSave === 2) ||
        (failure === 'rotation confirmation' && rekeySaved !== undefined)) throw refusal;
      return state();
    });
    const signMock = mock.method(p, 'signGrantPages', async (...args: Parameters<typeof signGrantPages>) => {
      if (failure === 'rotation signature') throw refusal;
      return signGrantPages(...args);
    });
    const result = await (kind === 'member.update'
      ? updateMember(lead.host, { member: n.member, clearance: OFFICIAL })
      : removeFromProject(lead.host, kind === 'device.revoke' ? { member: n.member, writer: n.writer } : { member: n.member })
    ).finally(() => {
      appendMock.mock.restore();
      stateMock.mock.restore();
      signMock.mock.restore();
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'store-refused');
    assert.deepEqual(writes, failure === 'rotation confirmation' ? [kind, 'cell.rekey'] : [kind]);
    const after = await head(p);
    if (failure === 'pre-write') {
      assert.equal(saved, undefined);
      assert.equal(after.hash, before.hash);
      assert.equal(result.message, STORE_REFUSALS.unreadable);
      return;
    }
    assert.ok(saved);
    assert.equal(after.roster.positions[before.position + 1], saved);
    if (kind === 'member.update') assert.deepEqual(memberAt(after.roster.members, n.member, after.position)?.clearance, OFFICIAL);
    else if (kind === 'device.revoke') assert.equal(deviceAt(after.roster.members, n.writer, after.position), undefined);
    else assert.equal(memberAt(after.roster.members, n.member, after.position), undefined);
    assert.match(result.message, /Part of the shared history in this project folder could not be read/);
    assert.match(result.message, /Check that the folder and its files can be read by your user account/);
    assert.doesNotMatch(result.message, /Nothing was changed|moved to a new key|will stay read only/);
    if (failure === 'confirmation') {
      assert.equal(readsAfterSave, 1);
      assert.match(result.message, /^The signed change was saved\. This computer could not confirm whether it applied to the roster\./);
      assert.doesNotMatch(result.message, /was recorded|is still unfinished|may still read|Devices excluded/);
    } else {
      assert.match(result.message, /^The removal was recorded\. This computer could not verify all the required new keys\./);
      assert.match(result.message, /may still read new work encrypted with them/);
    }
    if (failure === 'rotation confirmation') {
      assert.ok(rekeySaved);
      assert.equal(after.hash, rekeySaved);
      assert.equal(after.position, before.position + 2);
    } else {
      assert.equal(after.hash, saved);
      assert.equal(epochAt(after.roster.cells, x, after.position), 1);
    }
  });
}

test('removing a member writes member.remove and one cell.rekey for each cell it held, each wrapped only to the devices still cleared; it keeps epoch 1 of X and never opens epoch 2', async () => {
  const t = await team();
  const base = t.lead.p.projectId;
  const removed = ok(await removeFromProject(t.lead.host, { member: t.m.member }), 'remove');
  assert.equal(removed.ok, true);
  assert.ok(removed.message.endsWith(REKEY_KEEP_TEXT));
  assert.ok(removed.message.includes('Devices excluded from the new keys cannot read work encrypted with those keys.'));
  assert.doesNotMatch(removed.message, /anything new/);
  assert.match(removed.message, /\b2 parts\b/);
  assert.match(removed.message, /moved to a new key/);
  assert.deepEqual([...(removed.rekeyed ?? [])].sort(), [base, t.x].sort());
  assert.deepEqual(removed.notices, multiUserNoticeLines());
  const { roster, hash, position } = await head(t.lead.p);
  assert.equal(memberAt(roster.members, t.m.member, position), undefined);
  assert.equal(epochAt(roster.cells, base, position), 2);
  assert.equal(epochAt(roster.cells, t.x, position), 2);
  assert.equal(epochAt(roster.cells, t.z, position), 1, 'Z was never M\'s');
  const view = rosterView(roster);
  assert.deepEqual(view.cellGrantees?.(t.x, hash), [t.lead.p.deviceWriter]);
  assert.deepEqual(view.cellGrantees?.(base, hash), [t.lead.p.deviceWriter, t.n.writer].sort());
  // The roster and every grant reach M's computer and N's: M opens nothing new, N opens the new base key and nothing of X. A grant opens only once
  // the roster entry that commits to it has arrived too (CR-01), so this carries both, as a transport does.
  await sync(t.lead, t.m);
  await sync(t.lead, t.n);
  assert.ok(t.m.p.keys.epochKey(t.x, 1) !== undefined);
  assert.equal(t.m.p.keys.epochKey(t.x, 2), undefined);
  assert.equal(t.m.p.keys.epochKey(base, 2), undefined);
  assert.deepEqual(t.n.p.keys.epochKey(base, 2), t.lead.p.keys.epochKey(base, 2));
  assert.equal(t.n.p.keys.epochKey(t.x, 2), undefined);
  // The roster refused nothing.
  assert.deepEqual(roster.refused, []);
});

test('revoking one device rekeys only that device\'s cells; the member\'s other device keeps access through the new grants', async () => {
  const t = await team();
  const second = await addMachine(t.lead, t.m.member, 'm2', 'Mo Analyst');
  const base = t.lead.p.projectId;
  const revoked = ok(await removeFromProject(t.lead.host, { member: t.m.member, writer: second.writer }), 'revoke');
  assert.deepEqual([...(revoked.rekeyed ?? [])].sort(), [base, t.x].sort());
  assert.ok(revoked.message.includes(REKEY_KEEP_TEXT));
  assert.ok(revoked.message.includes('Devices excluded from the new keys cannot read work encrypted with those keys.'));
  assert.doesNotMatch(revoked.message, /anything new/);
  const { roster, hash, position } = await head(t.lead.p);
  assert.ok(memberAt(roster.members, t.m.member, position) !== undefined, 'M stays a member');
  assert.equal(rosterView(roster).isAdmitted(second.writer, hash), false);
  assert.equal(rosterView(roster).isAdmitted(t.m.writer, hash), true);
  assert.equal(epochAt(roster.cells, t.z, position), 1, 'Z not rekeyed');
  assert.deepEqual(rosterView(roster).cellGrantees?.(t.x, hash), [t.lead.p.deviceWriter, t.m.writer].sort());
  for (const at of [t.m, second]) await sync(t.lead, at);
  assert.ok(t.m.p.keys.epochKey(t.x, 2) !== undefined, 'M\'s first device opens the new key');
  assert.equal(second.p.keys.epochKey(t.x, 2), undefined, 'the revoked device does not');
  assert.equal(second.p.keys.epochKey(base, 2), undefined);
  // A device the member does not have is refused.
  assert.equal((await removeFromProject(t.lead.host, { member: t.n.member, writer: t.m.writer })).reason, 'device-unknown');
});

test('lowering N\'s clearance below X\'s label rekeys X without N, and leaves the base cell alone', async () => {
  const t = await team({ nClearance: CLEARED_X });
  const base = t.lead.p.projectId;
  assert.ok(t.n.p.keys.epochKey(t.x, 1) !== undefined, 'N had been granted X');
  const lowered = ok(await updateMember(t.lead.host, { member: t.n.member, clearance: OFFICIAL }), 'lower');
  assert.deepEqual(lowered.rekeyed, [t.x]);
  assert.ok(lowered.message.includes(REKEY_KEEP_TEXT));
  assert.ok(lowered.message.includes('Devices excluded from the new keys cannot read work encrypted with those keys.'));
  assert.doesNotMatch(lowered.message, /anything new/);
  const { roster, hash, position } = await head(t.lead.p);
  assert.deepEqual(memberAt(roster.members, t.n.member, position)?.clearance, OFFICIAL);
  assert.deepEqual(rosterView(roster).cellGrantees?.(t.x, hash), [t.lead.p.deviceWriter, t.m.writer].sort());
  assert.equal(epochAt(roster.cells, base, position), 1);
  await sync(t.lead, t.n);
  assert.equal(t.n.p.keys.epochKey(t.x, 2), undefined);
  // A change that is not about clearance rekeys nothing, and a change of nothing is refused.
  const renamed = ok(await updateMember(t.lead.host, { member: t.n.member, name: 'Nell P' }), 'rename');
  assert.deepEqual(renamed.rekeyed, []);
  assert.ok(!renamed.message.includes(REKEY_KEEP_TEXT));
  assert.equal((await updateMember(t.lead.host, { member: t.n.member })).reason, 'nothing-to-change');
  assert.equal((await updateMember(t.lead.host, { member: 'mbr-nobody', name: 'X' })).reason, 'member-unknown');
});

for (const failure of ['planning', 'storage', 'thrown storage'] as const) {
  test(`a clearance update reports pending rotation if its later grant ${failure} fails`, async () => {
    const t = await team({ nClearance: CLEARED_X });
    const { p } = t.lead;
    const target = { ...CLEARED_X, compartments: ['OSPREY'] };
    const before = await head(p);
    const key = newEpochKey();
    const pages = newEpochPages(p.signer, before.roster, {
      cell: t.z, epoch: 2, key, recipients: [p.deviceWriter], info: { base: false }, labelSealed: sealLabel(key, t.z, 2, LABEL_Z)
    });
    assert.ok(pages !== 'switch-first' && pages.length === 1);
    const founding = grantHash(pages[0]);
    await p.keys.addOwn(t.z, 2, key, founding);
    assert.ok(!isProjectRefused(await p.putGrants(pages)));
    assert.ok('ok' in await p.appendOwn('cell.rekey', { cell: t.z, epoch: 2, reason: 'scheduled', grant: founding }, { roster: before.hash }));

    const append = p.appendOwn.bind(p);
    const epochKey = p.keys.epochKey.bind(p.keys);
    const putGrants = p.putGrants.bind(p);
    let changed = false;
    let grantStorageTried = false;
    const appendMock = mock.method(p, 'appendOwn', async (...args: Parameters<typeof append>) => {
      const result = await append(...args);
      if (args[0] === 'member.update' && 'ok' in result) changed = true;
      return result;
    });
    const keysMock = mock.method(p.keys, 'epochKey', (cell: string, epoch: number) =>
      failure === 'planning' && changed && cell === t.z && epoch === 1 ? undefined : epochKey(cell, epoch));
    const storageMock = mock.method(p, 'putGrants', async (...args: Parameters<typeof putGrants>) => {
      if (!changed) return putGrants(...args);
      grantStorageTried = true;
      const refusal = { refused: 'store-refused', message: 'The test refused the newly granted key. Nothing was changed.' } as const;
      if (failure === 'thrown storage') throw new ReplicaProjectError(refusal);
      return refusal;
    });
    const result = await updateMember(t.lead.host, { member: t.n.member, clearance: target }).finally(() => {
      appendMock.mock.restore();
      keysMock.mock.restore();
      storageMock.mock.restore();
    });
    assert.equal(changed, true);
    assert.equal(grantStorageTried, failure !== 'planning');
    const after = await head(p);
    assert.deepEqual(memberAt(after.roster.members, t.n.member, after.position)?.clearance, target);
    assert.equal(epochAt(after.roster.cells, t.x, after.position), 1);
    assert.equal(await unfinishedRekeys(t.lead.host), 1);
    assert.equal(result.ok, false);
    assert.equal(result.reason, failure === 'planning' ? 'no-grant-key' : 'store-refused');
    assert.ok(result.message.includes(failure === 'planning' ? 'This computer does not hold every key needed to finish.' : 'The test refused the newly granted key.'));
    assert.match(result.message, /The clearance change was recorded/);
    assert.ok(result.message.includes('Until the affected parts have verified new keys, devices that held the old keys may still read new work encrypted with them.'));
    assert.doesNotMatch(result.message, /moved to a new key|anything new|nothing was changed/i);
  });
}

test('a grant refusal after a clearance gain reports the recorded change and unfinished grant', async () => {
  const t = await team();
  const before = await head(t.lead.p);
  const grants = grantsOn(t.lead.at);
  const refusal = { refused: 'store-refused', message: STORE_REFUSALS.unreadable, store: 'unreadable' } as const;
  const storage = mock.method(t.lead.p, 'putGrants', async () => { throw new ReplicaProjectError(refusal); });
  const result = await updateMember(t.lead.host, { member: t.n.member, clearance: CLEARED_X }).finally(() => storage.mock.restore());
  assert.equal(result.ok, false);
  assert.equal(result.reason, refusal.refused);
  assert.equal(result.message, 'The clearance change was recorded. This computer could not finish giving keys for the newly cleared parts. ' +
    'Part of the shared history in this project folder could not be read, so it was not opened. Check that the folder and its files can be read by your user account.');
  assert.equal(result.granted, undefined);
  assert.equal(result.rekeyed, undefined);
  assert.equal(storage.mock.callCount(), 1);
  const after = await head(t.lead.p);
  assert.equal(after.position, before.position + 1);
  assert.deepEqual(memberAt(after.roster.members, t.n.member, after.position)?.clearance, CLEARED_X);
  assert.equal(await unfinishedRekeys(t.lead.host), 0);
  assert.deepEqual(grantsOn(t.lead.at), grants);
});

test('retrying an absent member reports other completed key changes separately', async () => {
  const t = await team();
  ok(await removeFromProject(t.lead.host, { member: t.n.member }), 'remove N');
  assert.ok('ok' in await t.lead.p.appendOwn('member.remove', { member: t.m.member }));
  const originalRemovals = await t.lead.p.findOwnAll('member.remove', () => true);
  const result = ok(await removeFromProject(t.lead.host, { member: t.n.member }), 'recover separately');
  assert.deepEqual([...(result.rekeyed ?? [])].sort(), [t.lead.p.projectId, t.x].sort());
  assert.match(result.message, /requested member is already absent/);
  assert.match(result.message, /key change left unfinished is now finished/);
  assert.doesNotMatch(result.message, /moved to a new key|Devices excluded|was removed/);
  assert.deepEqual(await t.lead.p.findOwnAll('member.remove', () => true), originalRemovals);
});

test('removing a member who holds no keys does not claim earlier recovered rotations for that removal', async () => {
  const t = await team();
  const { p, host } = t.lead;
  const name = 'Uma No Key';
  const pending = install('no-key-member');
  const invited = ok(await inviteToProject(host, { name, seat: 'j2-analyst', clearance: OFFICIAL }), 'invite');
  const joined = ok(await joinFromInvite(pending.root, pending.deps, file(invited).text, { name }), 'join');
  const blockedGrant = mock.method(p, 'putGrants', async () => ({ refused: 'store-refused', message: 'Fixture refused grant storage.' } as const));
  const admission = await admitJoinRequest(host, file(joined).text, { codeMatched: true }).finally(() => blockedGrant.mock.restore());
  assert.equal(admission.reason, 'store-refused');
  const admitted = await head(p);
  const member = [...admitted.roster.members.members.keys()].find((id) => memberAt(admitted.roster.members, id, admitted.position)?.name === name);
  assert.ok(member);
  assert.ok('ok' in await p.appendOwn('member.remove', { member: t.m.member }));
  assert.equal(await unfinishedRekeys(host), 2);

  const removed = ok(await removeFromProject(host, { member }), 'remove');
  assert.deepEqual([...(removed.rekeyed ?? [])].sort(), [p.projectId, t.x].sort());
  assert.match(removed.message, /left unfinished was finished first/);
  const current = removed.message.slice(removed.message.indexOf(name));
  assert.equal(current, `${name} was removed from the project. They keep what they already received.`);
});

test('raising a clearance writes grants for the newly cleared cells with every earlier epoch', async () => {
  const t = await team();
  // X gets a second epoch first: M is removed.
  ok(await removeFromProject(t.lead.host, { member: t.m.member }), 'remove M');
  const raised = ok(await updateMember(t.lead.host, { member: t.n.member, clearance: CLEARED_X }), 'raise');
  assert.doesNotMatch(raised.message, /verified new keys|Devices excluded from the new keys/);
  assert.deepEqual(raised.granted, [t.x]);
  assert.deepEqual(raised.rekeyed, []);
  const { roster, hash } = await head(t.lead.p);
  assert.deepEqual(rosterView(roster).cellGrantees?.(t.x, hash), [t.lead.p.deviceWriter, t.n.writer].sort());
  await sync(t.lead, t.n);
  assert.deepEqual(t.n.p.keys.epochKey(t.x, 1), t.lead.p.keys.epochKey(t.x, 1));
  assert.deepEqual(t.n.p.keys.epochKey(t.x, 2), t.lead.p.keys.epochKey(t.x, 2));
  assert.equal(t.n.p.keys.epochKey(t.z, 1), undefined, 'Z stays out of reach');
  assert.deepEqual(roster.refused, []);
});

test('the lead cannot be removed, and the lead\'s last device cannot be revoked by the lead: both refused with the roster\'s sentence; the lead\'s second device can be revoked', async () => {
  const lead = await founded();
  const before = await head(lead.p);
  const removed = await removeFromProject(lead.host, { member: 'mbr-lead' });
  assert.equal(removed.reason, 'lead-not-removable');
  assert.equal(removed.message, MEMBER_REFUSALS['lead-not-removable']);
  const last = await removeFromProject(lead.host, { member: 'mbr-lead', writer: lead.p.deviceWriter });
  assert.equal(last.reason, 'last-lead-device');
  assert.equal(last.message, MEMBER_REFUSALS['last-lead-device']);
  assert.equal((await head(lead.p)).hash, before.hash);
  // With a second device, the lead revokes it; the remaining one is the last again.
  const second = await addMachine(lead, 'mbr-lead', 'a2', 'Lee Lead');
  ok(await removeFromProject(lead.host, { member: 'mbr-lead', writer: second.writer }), 'revoke the second lead device');
  assert.equal((await removeFromProject(lead.host, { member: 'mbr-lead', writer: lead.p.deviceWriter })).reason, 'last-lead-device');
});

/** The lead makes a cell with no label it can read (labelSealed empty), founded with wraps to the given devices only. */
async function unlabelledCell(lead: Lead, to: readonly string[]): Promise<string> {
  const at = await head(lead.p);
  const cell = randomBytes(16).toString('hex');
  const key = newEpochKey();
  const founding = foundingFor(lead, at.roster, { cell, key, to, labelSealed: '' });
  assert.ok(!isProjectRefused(await lead.p.putGrants([founding])));
  assert.ok('ok' in await lead.p.appendOwn('cell.create', { cell, epoch: 1, grant: grantHash(founding) }, { roster: at.hash }));
  return cell;
}

test('a cell nobody else is left on gets no rekey: the plan with no recipients is not written, and the result says so', async () => {
  const t = await team();
  // Y is held by M alone: the lead wraps it only to M and keeps no key for it.
  const y = await unlabelledCell(t.lead, [t.m.writer]);
  const removed = ok(await removeFromProject(t.lead.host, { member: t.m.member }), 'remove');
  assert.ok(!(removed.rekeyed ?? []).includes(y));
  assert.deepEqual([...(removed.rekeyed ?? [])].sort(), [t.lead.p.projectId, t.x].sort());
  assert.equal(removed.ok, true);
  assert.match(removed.message, /Nobody else is on one part/);
  assert.match(removed.message, /no new key/);
  assert.ok(removed.message.endsWith(REKEY_KEEP_TEXT));
  assert.ok(removed.message.includes('Devices excluded from the new keys cannot read work encrypted with those keys.'));
  assert.doesNotMatch(removed.message, /anything new/);
  const { roster, position } = await head(t.lead.p);
  assert.equal(epochAt(roster.cells, y, position), 1, 'no cell.rekey was written for Y');
  assert.deepEqual(roster.refused, []);
});

test('no-grant-key: changing the clearance of a member who holds a cell whose label this computer cannot read is refused before anything is written', async () => {
  const t = await team();
  const y = await unlabelledCell(t.lead, [t.lead.p.deviceWriter, t.n.writer]);
  const before = await head(t.lead.p);
  assert.ok(epochAt(before.roster.cells, y, before.position) === 1);
  const blocked = await updateMember(t.lead.host, { member: t.n.member, clearance: CLEARED_X });
  assert.equal(blocked.reason, 'no-grant-key');
  assert.equal(blocked.message, MEMBERSHIP_REFUSALS['no-grant-key']);
  assert.equal((await head(t.lead.p)).hash, before.hash);
  // MN-05: removing N would move Y to a new epoch this computer cannot label (the lead is still on it), so it is refused the same way, before
  // anything is written; before MN-05 the new epoch was written with no label and nobody admitted later could be cleared for Y.
  const removal = await removeFromProject(t.lead.host, { member: t.n.member });
  assert.equal(removal.reason, 'no-grant-key');
  assert.equal(removal.message, MEMBERSHIP_REFUSALS['no-grant-key']);
  const after = await head(t.lead.p);
  assert.equal(after.hash, before.hash, 'nothing written');
  assert.equal(epochAt(after.roster.cells, y, after.position), 1);
  assert.ok(memberAt(after.roster.members, t.n.member, after.position) !== undefined, 'N is still a member');
  assert.equal(await unfinishedRekeys(t.lead.host), 0);
});

// ---- Task 4: split and choose, deputy, handover --------------------------------------------------------------------------------------------------

test('two lead devices each change the roster offline: the state reports a split with ROSTER_SPLIT_TEXT, a member\'s choice is refused not-a-roster-writer, the lead\'s choice resolves it', async () => {
  const t = await team();
  const second = await addMachine(t.lead, 'mbr-lead', 'a2', 'Lee Lead');
  const point = await head(t.lead.p);
  assert.equal((await head(second.p)).hash, point.hash);
  // Offline: each lead device writes one roster change on the same head.
  const one = ok(await updateMember(t.lead.host, { member: t.n.member, name: 'Nell One' }), 'first device');
  const two = ok(await updateMember(second.host, { member: t.n.member, name: 'Nell Two' }), 'second device');
  assert.ok(one.ok && two.ok);
  const branchTwo = (await head(second.p)).hash;
  await sync(second, t.lead);
  const split = await head(t.lead.p);
  assert.equal(split.hash, point.hash, 'nothing on either branch applies');
  assert.equal(split.roster.pending.length, 1);
  assert.equal(split.roster.pending[0].text, ROSTER_SPLIT_TEXT);
  assert.ok(split.roster.pending[0].branches.includes(branchTwo));
  // Any other change is refused while the roster is split.
  const blocked = await updateMember(t.lead.host, { member: t.n.member, name: 'Nell Three' });
  assert.equal(blocked.reason, 'roster-split');
  assert.ok(blocked.message.startsWith(ROSTER_SPLIT_TEXT));
  // A member sees the split and cannot choose.
  await sync(t.lead, t.m);
  assert.equal((await head(t.m.p)).roster.pending.length, 1);
  const byMember = await chooseRosterBranch(t.m.host, branchTwo);
  assert.equal(byMember.reason, 'not-a-roster-writer');
  // The lead chooses the second device's branch.
  assert.equal((await chooseRosterBranch(t.lead.host, 'f'.repeat(64))).reason, 'not-a-branch');
  const chosen = ok(await chooseRosterBranch(t.lead.host, branchTwo), 'choose');
  assert.deepEqual(chosen.notices, multiUserNoticeLines());
  const resolved = await head(t.lead.p);
  assert.deepEqual(resolved.roster.pending, []);
  assert.equal(resolved.hash, branchTwo);
  assert.equal(memberAt(resolved.roster.members, t.n.member, resolved.position)?.name, 'Nell Two');
  assert.equal((await chooseRosterBranch(t.lead.host, branchTwo)).reason, 'no-split');
});

test('with a deputy named, the deputy revokes the lead\'s only device (the lead\'s own attempt is refused), then chooses a roster split between the deputy\'s two devices', async () => {
  const t = await team();
  const d = await bringIn(t.lead, 'd', 'Dee Deputy', CLEARED_X);
  ok(await nameDeputy(t.lead.host, d.member), 'name the deputy');
  const d2 = await addMachine(t.lead, d.member, 'd2', 'Dee Deputy');
  await sync(t.lead, d);
  await sync(t.lead, d2);
  const named = await head(d.p);
  assert.equal(deputyAt(named.roster, named.position), d.member);
  assert.equal((await removeFromProject(t.lead.host, { member: 'mbr-lead', writer: t.lead.p.deviceWriter })).reason, 'last-lead-device');
  // The deputy cuts off the lead's only device; the cells it held move to new keys without it.
  const revoked = ok(await removeFromProject(d.host, { member: 'mbr-lead', writer: t.lead.p.deviceWriter }), 'deputy revokes');
  assert.ok(revoked.message.includes(REKEY_KEEP_TEXT));
  assert.ok(revoked.message.includes('Devices excluded from the new keys cannot read work encrypted with those keys.'));
  assert.doesNotMatch(revoked.message, /anything new/);
  assert.ok((revoked.rekeyed ?? []).includes(t.lead.p.projectId));
  const cut = await head(d.p);
  assert.equal(rosterView(cut.roster).isAdmitted(t.lead.p.deviceWriter, cut.hash), false);
  assert.equal(leadAt(cut.roster, cut.position), 'mbr-lead', 'still the lead, with no device');
  // The deputy's two devices each change the roster offline.
  await sync(d, d2);
  assert.equal((await head(d2.p)).hash, cut.hash);
  ok(await updateMember(d.host, { member: t.n.member, name: 'Nell One' }), 'deputy device one');
  ok(await updateMember(d2.host, { member: t.n.member, name: 'Nell Two' }), 'deputy device two');
  const branchTwo = (await head(d2.p)).hash;
  await sync(d2, d);
  assert.equal((await head(d.p)).roster.pending.length, 1);
  ok(await chooseRosterBranch(d.host, branchTwo), 'the deputy chooses');
  const resolved = await head(d.p);
  assert.deepEqual(resolved.roster.pending, []);
  assert.equal(resolved.hash, branchTwo);
  assert.deepEqual(resolved.roster.refused.filter((item) => item.kind !== 'grant'), []);
});

test('nameDeputy writes deputy.name; the deputy cannot name a deputy; a planned handover from the deputy is refused; the deputy\'s lead-lost handover makes it the lead', async () => {
  const t = await team();
  const named = ok(await nameDeputy(t.lead.host, t.m.member), 'name');
  assert.deepEqual(named.notices, multiUserNoticeLines());
  await sync(t.lead, t.m);
  const atM = await head(t.m.p);
  assert.equal(deputyAt(atM.roster, atM.position), t.m.member);
  const byDeputy = await nameDeputy(t.m.host, t.n.member);
  assert.equal(byDeputy.reason, 'deputy-cannot-name-deputy');
  assert.equal(byDeputy.message, ROSTER_REFUSALS['deputy-cannot-name-deputy']);
  const planned = await handOverLead(t.m.host, { to: t.m.member, reason: 'planned' });
  assert.equal(planned.reason, 'handover-not-allowed');
  assert.equal(planned.message, ROSTER_REFUSALS['handover-not-allowed']);
  assert.equal((await head(t.m.p)).hash, atM.hash, 'nothing written');
  ok(await handOverLead(t.m.host, { to: t.m.member, reason: 'lead-lost' }), 'lead-lost handover');
  const after = await head(t.m.p);
  assert.equal(leadAt(after.roster, after.position), t.m.member);
  assert.equal(deputyAt(after.roster, after.position), undefined, 'the deputy role ended');
  // The lead can hand over for any reason; naming the lead or an unknown member is refused.
  assert.equal((await handOverLead(t.lead.host, { to: 'mbr-lead', reason: 'planned' })).reason, 'names-the-lead');
  assert.equal((await nameDeputy(t.lead.host, 'mbr-nobody')).reason, 'member-unknown');
});

// ---- which key a device writes with (CR-01, MJ-04) -------------------------------------------------------------------------------------------------

/** A doc.client of the device's own slot in the base cell: an entry any admitted device may write, sealed under the base cell's current key. */
async function writeInBase(p: ReplicaProject): Promise<{ hash: string; entry: unknown; blobs: Array<{ hash: string; bytes: string }>; epoch: number }> {
  const { roster, position } = await head(p);
  const slot = deviceAt(roster.members, p.deviceWriter, position)?.slot as number;
  const written = await p.appendOwn('doc.client', { product: 'intel-estimate', clientId: clientIdOf(slot, 0), actor: { kind: 'person' } });
  assert.ok('ok' in written, 'the entry is written');
  return { hash: written.hash, entry: written.built.entry, blobs: written.built.blobs, epoch: written.built.entry.header.epoch };
}

test('managed access pauses ordinary writes and prepared blobs until there is verified cell authority', async () => {
  const at = install('managed-missing-proof');
  at.deps.knownFeatures = [...clientReplicaFeatures(), 'cell-access@1'];
  const p = project(await ReplicaProject.createSharedProject(at.root, at.deps, {
    name: 'Exercise Northwind', profile: 'j2', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: 'mbr-lead' }
  }));
  const ordinary = await writeInBase(p);
  assert.equal(ordinary.epoch, 1);
  const armed = await p.appendOwn('roster.require', { features: ['cell-access@1'] });
  assert.ok('ok' in armed);
  const { roster, position } = await head(p);
  const key = p.keys.epochKey(p.projectId, 1);
  const slot = deviceAt(roster.members, p.deviceWriter, position)?.slot;
  assert.ok(key !== undefined && slot !== undefined);
  const contentBlob = sealBlob(key, p.projectId, 1, Buffer.from('fictional draft'));
  const result = await p.appendOwn('doc.client',
    { product: 'intel-estimate', clientId: clientIdOf(slot, 0), actor: { kind: 'person' } }, { contentBlob });
  assert.equal(isProjectRefused(result) && result.refused, 'rekey-pending');
  assert.equal(existsSync(path.join(at.root, REPLICA_DIR, 'blobs', contentBlob.hash)), false);
});

test('a signed clearance transition pauses the affected cell and its verified unaffected cell still writes', async () => {
  const at = install('managed-continuity');
  at.deps.knownFeatures = [...clientReplicaFeatures(), 'cell-access@1'];
  const p = project(await ReplicaProject.createSharedProject(at.root, at.deps, {
    name: 'Exercise Northwind', profile: 'j2', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: 'mbr-lead' }
  }));
  const lead = { at, p, host: hostOf(p, at) };
  const affected = await createCell(lead, LABEL_X, [p.deviceWriter]);
  const secondUnaffected = await createCell(lead, LABEL_Z, [p.deviceWriter]);
  const member = await bringIn(lead, 'managed-analyst', 'Mo Analyst', CLEARED_X);
  assert.ok('ok' in await p.appendOwn('roster.require', { features: ['cell-access@1'] }));
  const { hash: predecessor } = await head(p);
  const operation = { member: member.member, clearance: OFFICIAL };
  const invalid = await p.appendOwn('member.update', operation);
  assert.ok('ok' in invalid);
  const unchanged = await head(p);
  assert.equal(unchanged.hash, predecessor);
  assert.equal(unchanged.roster.refused.find((item) => item.hash === invalid.hash)?.reason, 'cell-access-revision-invalid');
  const revision = accessRevisionId(p.projectId, null, predecessor, 'member.update', operation);
  const permit = { project: p.projectId, cell: p.projectId, epoch: 1, revision, predecessor,
    device: p.deviceWriter, writer: p.deviceWriter, authority: p.deviceWriter, certificate: null };
  const commitment = buildAccessCommitment(revision, [affected, p.projectId, secondUnaffected].sort().map((cell) => ({
    cell, previousEpoch: 1, epoch: 1, decision: cell === affected ? 'pending' : 'continues',
    salt: randomBytes(32).toString('hex'), evidence: randomBytes(32).toString('hex')
  })), [{ permit, signature: p.signer.sign(accessPermitBytes(permit)) }]);
  assert.ok(commitment);
  const transition = await p.appendOwn('member.update', { ...operation, accessRevision: revision, accessRoot: commitment.root });
  assert.ok('ok' in transition);
  const current = await head(p);
  assert.equal(current.hash, transition.hash);
  assert.equal(current.roster.accessRevision?.entry, transition.hash);
  assert.deepEqual(memberAt(current.roster.members, member.member, current.position)?.clearance, OFFICIAL);
  const accessProof = commitment.proof(p.projectId, p.deviceWriter);
  assert.ok(accessProof);
  const slot = deviceAt(current.roster.members, p.deviceWriter, current.position)?.slot;
  assert.ok(slot !== undefined);
  const data = { product: 'intel-estimate', clientId: clientIdOf(slot, 0), actor: { kind: 'person' } };
  const key = p.keys.epochKey(affected, 1);
  assert.ok(key);
  const contentBlob = sealBlob(key, affected, 1, Buffer.from('fictional pending draft'));
  const blocked = await p.appendOwn('doc.client', data, { stream: affected, accessProof, contentBlob });
  assert.equal(isProjectRefused(blocked) && blocked.refused, 'rekey-pending');
  assert.equal(existsSync(path.join(at.root, REPLICA_DIR, 'blobs', contentBlob.hash)), false);
  assert.ok('ok' in await p.putGrants([], [accessProof]));
  const written = await p.appendOwn('doc.client', data);
  assert.ok('ok' in written);
  assert.equal(written.built.entry.header.epoch, 1);
  const reopened = project(await ReplicaProject.open(at.root, at.deps));
  assert.ok('ok' in await reopened.appendOwn('doc.client', data));
  const rename = await reopened.appendOwn('member.update', { member: member.member, name: 'Morgan Analyst' });
  assert.ok('ok' in rename);
  assert.equal((await head(reopened)).hash, rename.hash);
  assert.ok('ok' in await reopened.appendOwn('doc.client', data), 'an ordinary roster edit leaves the permit current');

  const afterNote = await head(reopened);
  const nextId = accessRevisionId(p.projectId, revision, afterNote.hash, 'cell.access.commit', {});
  const carried = { ...permit, revision: nextId, predecessor: afterNote.hash };
  const transportPermits = [carried, { ...carried, cell: secondUnaffected }];
  const next = buildAccessCommitment(nextId, [affected, p.projectId, secondUnaffected].sort().map((cell) => ({
    cell, previousEpoch: 1, epoch: 1, decision: cell === affected ? 'pending' : 'continues',
    salt: randomBytes(32).toString('hex'), evidence: randomBytes(32).toString('hex')
  })), transportPermits.map((item) => ({ permit: item, signature: p.signer.sign(accessPermitBytes(item)) })));
  assert.ok(next);
  const promoted = await reopened.appendOwn('cell.access.commit', { accessRevision: nextId, accessRoot: next.root });
  assert.ok('ok' in promoted);
  const blockedByRevision = await reopened.appendOwn('doc.client', data);
  assert.equal(isProjectRefused(blockedByRevision) && blockedByRevision.refused, 'rekey-pending');
  const continuity = next.proof(p.projectId, p.deviceWriter);
  const secondContinuity = next.proof(secondUnaffected, p.deviceWriter);
  assert.ok(continuity && secondContinuity);
  const receipt = { entry: promoted.hash, accessProofs: [continuity, secondContinuity] };
  const selected = (await head(reopened)).roster;
  assert.equal(sealManagedContinuityDelivery(selected, p.deviceWriter, { ...receipt, entry: afterNote.hash }, NOW, { authority: p.deviceWriter, signer: p.signer }) === undefined, true);
  assert.equal(sealManagedContinuityDelivery(selected, p.deviceWriter, { ...receipt, accessProofs: [continuity, continuity] }, NOW, { authority: p.deviceWriter, signer: p.signer }) === undefined, true);
  assert.equal(sealManagedContinuityDelivery(selected, member.writer, receipt, NOW, { authority: p.deviceWriter, signer: p.signer }) === undefined, true);
  const delivery = sealManagedContinuityDelivery(selected, p.deviceWriter, receipt, NOW, { authority: p.deviceWriter, signer: p.signer });
  assert.ok(delivery);
  assert.equal(JSON.stringify(delivery).includes(secondContinuity.signed.signature), false);
  assert.ok('ok' in await reopened.ingestManagedGrantDelivery(delivery));
  assert.ok('ok' in await reopened.appendOwn('doc.client', data));
  assert.ok('ok' in await reopened.appendOwn('doc.client', data, { stream: secondUnaffected }));
  const restored = project(await ReplicaProject.open(at.root, at.deps));
  assert.ok('ok' in await restored.appendOwn('doc.client', data, { stream: secondUnaffected }));
  const stillPending = await reopened.appendOwn('doc.client', data, { stream: affected });
  assert.equal(isProjectRefused(stillPending) && stillPending.refused, 'rekey-pending');
});

async function seedManagedAccess(lead: Lead, cells: readonly string[], permitRecipient?: string) {
  const { p, at } = lead;
  at.deps.knownFeatures = [...clientReplicaFeatures(), 'cell-access@1'];
  assert.ok('ok' in await p.appendOwn('roster.require', { features: ['cell-access@1'] }));
  const before = await head(p);
  const id = accessRevisionId(p.projectId, null, before.hash, 'cell.access.commit', {});
  const manifests = [...cells].sort().map((cell) => ({
    project: p.projectId, cell, epoch: 1, policy: null, excluded: [],
    grants: (before.roster.cells.cells.get(cell)?.grants ?? []).map((grant) => ({
      hash: grant.hash, pages: grant.grant.pages ?? [], recipients: [...grant.writers].sort()
    })).sort((a, b) => a.hash < b.hash ? -1 : 1)
  }));
  const permits = permitRecipient === undefined ? [] : manifests.filter(({ grants }) => grants.some(({ recipients }) => recipients.includes(permitRecipient)))
    .map(({ cell }) => {
      const permit = { project: p.projectId, cell, epoch: 1, revision: id, predecessor: before.hash,
        device: permitRecipient, writer: permitRecipient, authority: p.deviceWriter, certificate: null };
      return { permit, signature: p.signer.sign(accessPermitBytes(permit)) };
    });
  const commitment = buildAccessCommitment(id, manifests.map((manifest) => {
    const evidence = grantEvidenceHash(manifest);
    assert.ok(evidence);
    return { cell: manifest.cell, previousEpoch: 1, epoch: 1, decision: 'continues', salt: randomBytes(32).toString('hex'), evidence };
  }), permits);
  assert.ok(commitment);
  const seed = await p.appendOwn('cell.access.commit', { accessRevision: id, accessRoot: commitment.root });
  assert.ok('ok' in seed);
  const receipts = manifests.map((evidence) => ({ ...commitment.cellProof(evidence.cell), entry: seed.hash, evidence }));
  return { seed, receipts, commitment };
}

test('managed removal stages continuity and Finish recovers the affected cell after reopening', async () => {
  const at = install('managed-removal');
  at.deps.knownFeatures = [...clientReplicaFeatures(), 'cell-access@1'];
  const p = project(await ReplicaProject.createSharedProject(at.root, at.deps, {
    name: 'Exercise Northwind', profile: 'j2', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: 'mbr-lead' }
  }));
  const lead = { at, p, host: hostOf(p, at) };
  const unaffected = await createCell(lead, LABEL_Z, [p.deviceWriter]);
  const peer = await bringIn(lead, 'managed-removed-peer', 'Mo Analyst', OFFICIAL);
  const { seed, receipts } = await seedManagedAccess(lead, [p.projectId, unaffected]);
  assert.ok('ok' in await p.putGrants([], receipts.slice(0, 1)));
  const waiting = await removeFromProject(lead.host, { member: peer.member });
  assert.equal(waiting.ok, false);
  assert.equal((await head(p)).hash, seed.hash);
  assert.ok('ok' in await p.putGrants([], receipts.slice(1)));
  const prepared = await head(p);
  const amended = await p.appendOwn('member.update', { member: peer.member, name: 'Morgan Analyst' });
  assert.ok('ok' in amended);
  const evidenceFolder = path.join(at.root, REPLICA_DIR, 'access-evidence');
  const beforeStale = readdirSync(evidenceFolder).sort();
  const stale = await appendManagedWithdrawal(p, prepared.roster, { member: peer.member }, NOW);
  assert.deepEqual(stale, { ok: false, reason: 'change-not-applied' });
  assert.deepEqual(readdirSync(evidenceFolder).sort(), beforeStale);
  assert.equal((await head(p)).hash, amended.hash);
  const removed = await removeFromProject(lead.host, { member: peer.member });
  assert.equal(removed.ok, true, removed.message);
  const reopened = project(await ReplicaProject.open(at.root, at.deps));
  const after = await head(reopened);
  assert.equal(memberAt(after.roster.members, peer.member, after.position), undefined);
  assert.equal(after.roster.accessRevision?.predecessor, amended.hash);
  assert.equal(after.roster.accessGrants.get(p.projectId)?.decision, 'pending');
  assert.deepEqual(after.roster.accessGrants.get(p.projectId)?.evidence.excluded, [peer.writer]);
  assert.equal(after.roster.accessGrants.get(unaffected)?.decision, 'continues');
  const slot = deviceAt(after.roster.members, p.deviceWriter, after.position)?.slot;
  assert.ok(slot !== undefined);
  const data = { product: 'intel-estimate', clientId: clientIdOf(slot, 0), actor: { kind: 'person' } };
  const blocked = await reopened.appendOwn('doc.client', data);
  assert.equal(isProjectRefused(blocked) && blocked.refused, 'rekey-pending');
  assert.ok('ok' in await reopened.appendOwn('doc.client', data, { stream: unaffected }));
  assert.equal(await unfinishedRekeys(hostOf(reopened, at)), 1);
  const finished = await finishRekeys(hostOf(reopened, at));
  assert.equal(finished.ok, true, finished.message);
  assert.deepEqual(finished.rekeyed, [p.projectId]);

  const recovered = project(await ReplicaProject.open(at.root, at.deps));
  const current = await head(recovered);
  const base = current.roster.accessGrants.get(p.projectId);
  assert.equal(base?.decision, 'continues');
  assert.equal(base.evidence.epoch, 2);
  assert.deepEqual(base.evidence.excluded, [peer.writer]);
  assert.deepEqual(base.evidence.grants[0]?.recipients, [p.deviceWriter]);
  assert.equal(current.roster.cells.cells.get(p.projectId)?.grants.some((grant) => grant.founding && grant.hash === base.evidence.grants[0]?.hash), true);
  assert.equal(current.roster.accessGrants.get(unaffected)?.evidence.epoch, 1);
  assert.ok('ok' in await recovered.appendOwn('doc.client', data));
  assert.ok('ok' in await recovered.appendOwn('doc.client', data, { stream: unaffected }));
  assert.equal(await unfinishedRekeys(hostOf(recovered, at)), 0);
  assert.equal((await finishRekeys(hostOf(recovered, at))).reason, 'nothing-to-finish');
  assert.equal((await head(recovered)).hash, current.hash);
});

test('hosted managed withdrawal and Finish retain exact authority at the locked commit boundary', async () => {
  const lead = await founded('hosted-access-expiry');
  const peer = await bringIn(lead, 'hosted-removed-peer', 'Mo Analyst', CLEARED_X);
  assert.ok('ok' in await lead.p.appendOwn('roster.require', { features: ['wrap@2'] }));
  const protectedCell = await createCell(lead, LABEL_X, [lead.p.deviceWriter, peer.writer]);
  const unaffected = await createCell(lead, LABEL_Z, [lead.p.deviceWriter]);
  const session = fixedSigner('managed-withdrawal-session');
  const initial = await head(lead.p);
  const slot = deviceAt(initial.roster.members, lead.p.deviceWriter, initial.position)?.slot;
  assert.ok(slot !== undefined);
  const cert = sessionCertifyData({ project: lead.p.projectId, member: 'mbr-lead', device: lead.p.deviceWriter,
    sessionKey: session.publicKey, slot, notAfter: new Date(NOW.getTime() + DAY_MS).toISOString() }, (bytes) => session.signer.sign(bytes));
  assert.ok('ok' in await lead.p.appendOwn('session.certify', cert));
  const { seed, receipts } = await seedManagedAccess(lead, [lead.p.projectId, protectedCell, unaffected]);
  assert.ok('ok' in await lead.p.putGrants([], receipts));
  const encoding = await loadOrCreateEncryptionKey(lead.at.secrets, { identityDir: identityDir(lead.at.global), identity: lead.p.signer });
  const kem = await loadOrCreateKemKeys(lead.at.secrets, { identityDir: identityDir(lead.at.global) });
  let expires = NOW.getTime() + 1000;
  let confirmed = 'fictional-confirmed-managed-action';
  let approvedPayload: Buffer | undefined;
  const authorized = (id: string) => id === confirmed && lead.at.clock.now.getTime() < expires;
  const signedActions: string[] = [];
  let whileSigning: (() => Promise<void>) | undefined;
  const signer = {
    fingerprint: lead.p.signer.fingerprint, publicKey: lead.p.signer.publicKey,
    canSignAction: (id: string, payload: Uint8Array) => authorized(id) && approvedPayload?.equals(payload) === true,
    async sign(bytes: Buffer, options?: SignOptions) {
      if (options?.action === undefined || !authorized(options.action)) return { refused: 'Confirm this test action first.' };
      signedActions.push(options.action);
      const race = whileSigning;
      whileSigning = undefined;
      await race?.();
      return lead.p.signer.sign(bytes);
    }
  };
  const deps: ReplicaProjectDeps = { ...lead.at.deps, secrets: new MemorySecrets(), sessionSigner: session.signer, personSigner: signer,
    keyStatus: async () => () => ({ state: 'active' }), hosted: { personPublicKey: signer.publicKey, encryption: encoding, kem } };
  const hosted = project(await ReplicaProject.open(lead.at.root, deps));
  const before = await head(hosted);
  assert.equal(before.hash, seed.hash);
  assert.ok(before.roster.sessions.has(writerIdOf(session.publicKey)));
  approvedPayload = managedAccessActionBytes(before.roster, hosted.deviceWriter, 'member.remove', { member: peer.member });
  assert.ok(approvedPayload);
  const host = { ...lead.host, project: hosted, deps };
  const mismatched = await removeFromProject(host, { member: peer.member, writer: peer.writer }, confirmed);
  assert.equal(mismatched.reason, 'action-required');
  assert.deepEqual(signedActions, [], 'a confirmation for membership removal cannot sign a device revocation');
  const unchecked = await hosted.appendOwn('cell.rekey', { cell: unaffected, epoch: 2, reason: 'clearance-lowered', grant: 'a'.repeat(64) }, { action: confirmed });
  assert.equal(isProjectRefused(unchecked) && unchecked.refused, 'action-required');
  assert.deepEqual(signedActions, [], 'ordinary append cannot send managed Finish signing bytes');
  let syncedStage = false;
  setFolderSyncProbe((dir) => {
    if (path.basename(dir) !== 'access-evidence') return;
    syncedStage = true;
    lead.at.clock.now = new Date(expires);
  });
  let result: MembershipResult;
  try {
    result = await removeFromProject(host, { member: peer.member }, confirmed);
  } finally {
    setFolderSyncProbe(undefined);
  }
  assert.equal(syncedStage, true);
  assert.equal(result.reason, 'action-required');
  const unchanged = await head(hosted);
  assert.equal(unchanged.hash, seed.hash);
  assert.ok(memberAt(unchanged.roster.members, peer.member, unchanged.position));
  assert.ok(signedActions.length > 1 && signedActions.every((action) => action === confirmed));
  const signedBeforeRetry = signedActions.length;
  assert.equal((await removeFromProject(host, { member: peer.member }, confirmed)).reason, 'action-required');
  assert.equal(signedActions.length, signedBeforeRetry, 'the expired action cannot sign again');

  confirmed = 'fictional-new-managed-action';
  expires += 1000;
  assert.equal((await removeFromProject(host, { member: peer.member }, confirmed)).ok, true);
  const committed = await head(hosted);
  assert.equal(committed.roster.accessRevision?.predecessor, seed.hash);
  assert.equal(memberAt(committed.roster.members, peer.member, committed.position), undefined);
  assert.equal(committed.roster.accessGrants.get(lead.p.projectId)?.decision, 'pending');
  const beforeDraft = signedActions.length;
  const headsBeforeDraft = await hosted.heads();
  const part = { cell: protectedCell, base: false, known: true, label: LABEL_X, raw: LABEL_X };
  const draft = prepareHostedFinish(hosted, committed.roster, part, undefined, lead.at.clock.now);
  assert.ok(draft);
  const unsigned = draft.intent.unsignedGrant();
  assert.equal(unsigned.roster, committed.hash);
  assert.equal(unsigned.epoch, 2);
  assert.deepEqual(unsigned.wraps.map(({ writer }) => writer), [hosted.deviceWriter]);
  assert.equal(draft.matches(committed.roster, part, undefined, lead.at.clock.now), true);
  assert.equal(draft.matches(committed.roster, part, undefined, new Date(cert.notAfter)), false, 'the reviewed session no longer qualifies for a permit');
  assert.deepEqual(await hosted.heads(), headsBeforeDraft);
  assert.equal(signedActions.length, beforeDraft, 'drafting the exact grant does not sign anything');
  assert.equal(hosted.keys.holds(part.cell, 2), false);
  const snapshot = selectedManagedAccess(committed.roster, hosted.deviceWriter);
  assert.ok(snapshot);
  const operation = { cell: part.cell, epoch: 2, reason: 'member-removed', grant: 'a'.repeat(64) };
  approvedPayload = managedAccessActionBytes(committed.roster, hosted.deviceWriter, 'cell.rekey', operation);
  const uncheckedFinish = await appendManagedAccess(hosted, committed.roster, {
    ...snapshot, kind: 'cell.rekey', operation, revision: 'b'.repeat(64),
    cells: snapshot.cells.map((item) => ({ ...item, recipients: managedRecipients(committed.roster, item) }))
  }, lead.at.clock.now, (fresh) => selectedManagedAccess(fresh, hosted.deviceWriter), confirmed);
  assert.deepEqual(uncheckedFinish, { ok: false, reason: 'action-required' });
  assert.equal(signedActions.length, beforeDraft, 'an approval of the final grant hash cannot sign a permit');


  const written = await hosted.appendOwn('doc.client', {
    product: 'intel-estimate', clientId: clientIdOf(slot, 0), actor: { kind: 'person' }
  }, { stream: unaffected });
  assert.ok('ok' in written);
  assert.equal(written.built.entry.header.writer, writerIdOf(session.publicKey));

  const runFinish = (pending: NonNullable<typeof draft>, action: string): Promise<AppendOwnResult> =>
    hosted.finishHostedCell(pending, action, (_roster, cell) => cell === part.cell ? part : undefined);
  confirmed = 'fictional-reviewed-finish';
  const countBeforeFinish = signedActions.length;
  const wrongReview = await runFinish(draft, confirmed);
  assert.equal(isProjectRefused(wrongReview) && wrongReview.refused, 'action-required');
  assert.equal(signedActions.length, countBeforeFinish);
  approvedPayload = draft.intent.actionBytes();
  let finishSynced = false;
  setFolderSyncProbe((dir) => {
    if (path.basename(dir) !== 'access-evidence') return;
    finishSynced = true;
    lead.at.clock.now = new Date(expires);
  });
  try {
    const ended = await runFinish(draft, confirmed);
    assert.equal(isProjectRefused(ended) && ended.refused, 'action-required');
  } finally {
    setFolderSyncProbe(undefined);
  }
  assert.equal(finishSynced, true, 'the reviewed Finish reaches the checked access sidecar');
  assert.equal((await head(hosted)).hash, committed.hash);
  assert.equal(hosted.keys.holds(part.cell, 2), false);
  assert.ok(signedActions.slice(countBeforeFinish).length >= 3);
  assert.ok(signedActions.slice(countBeforeFinish).every((id) => id === confirmed));

  expires += 1000;
  confirmed = 'fictional-racing-finish';
  const racing = prepareHostedFinish(hosted, (await head(hosted)).roster, part, undefined, lead.at.clock.now);
  assert.ok(racing);
  approvedPayload = racing.intent.actionBytes();
  const beforeRace = signedActions.length;
  whileSigning = async () => {
    const side = await lead.p.appendOwn('doc.client', {
      product: 'intel-estimate', clientId: clientIdOf(slot, 2), actor: { kind: 'person' }
    }, { stream: unaffected });
    assert.ok('ok' in side);
  };
  const lost = await runFinish(racing, confirmed);
  assert.equal(isProjectRefused(lost) && lost.refused, 'action-required');
  assert.equal(signedActions.length, beforeRace + 1, 'the checked snapshot stops the signing sequence after a cross-window change');
  assert.equal((await head(hosted)).hash, committed.hash);

  confirmed = 'fictional-second-reviewed-finish';
  const fresh = await head(hosted);
  const nextDraft = prepareHostedFinish(hosted, fresh.roster, part, undefined, lead.at.clock.now);
  assert.ok(nextDraft);
  approvedPayload = nextDraft.intent.actionBytes();
  const ended = await runFinish(nextDraft, confirmed);
  assert.ok('ok' in ended, 'one exact authorized cell commits');
  const atCommit = signedActions.length;
  const replay = await runFinish(nextDraft, confirmed);
  assert.equal(isProjectRefused(replay) && replay.refused, 'action-required');
  assert.equal(signedActions.length, atCommit);
  const reopened = project(await ReplicaProject.open(lead.at.root, deps));
  const recovered = await head(reopened);
  assert.equal(recovered.hash, ended.hash);
  assert.equal(recovered.roster.accessGrants.get(part.cell)?.decision, 'continues');
  assert.deepEqual(reopened.keys.epochKey(part.cell, 2), nextDraft.epochKey());
  assert.equal(recovered.roster.accessGrants.get(lead.p.projectId)?.decision, 'pending', 'a second cell still needs its own approval');
  assert.equal(reopened.keys.holds(lead.p.projectId, 2), false);
  assert.ok('ok' in await reopened.appendOwn('doc.client', {
    product: 'intel-estimate', clientId: clientIdOf(slot, 1), actor: { kind: 'person' }
  }, { stream: unaffected }));

});

test('managed clearance reduction commits decisions using the lead’s custom scale mapping', async () => {
  const lead = await founded('managed-clearance');
  lead.host.scales = { ...DEMO_SCALES, allied: { name: 'Allied', levels: ['LOW', 'HIGH'] } };
  lead.host.mappings = [{ from: { scale: 'allied', level: 'HIGH' }, covers: { scale: 'demo', level: 'SECRET' } }];
  const clearance = { ...CLEARED_X, scale: 'allied', level: 'HIGH', compartments: ['KESTREL', 'OSPREY'] };
  const downgraded = { ...clearance, level: 'LOW' };
  const reduced = await bringIn(lead, 'mapped-reduced', 'Nell Planner', clearance);
  const peer = await bringIn(lead, 'mapped-peer', 'Mo Analyst', clearance);
  const participants = [lead.p.deviceWriter, peer.writer, reduced.writer].sort();
  const affected = [{ label: LABEL_X, id: '0'.repeat(32) }, { label: LABEL_Z, id: '1'.repeat(32) }];
  for (const { label, id } of affected) await createCell(lead, label, participants, id);
  const base = lead.p.projectId;
  const { seed, receipts, commitment } = await seedManagedAccess(lead, [base, ...affected.map(({ id }) => id)], peer.writer);
  assert.ok('ok' in await lead.p.putGrants([], receipts));
  const initial = await head(lead.p);
  const root = await stageManagedPredecessors(lead, peer, seed.hash);
  assert.ok('ok' in await peer.p.ingestForeign([root], []));
  const issuer = { authority: lead.p.deviceWriter, signer: lead.p.signer };
  for (const { label, id } of affected) {
    const opening = receipts.find(({ evidence }) => evidence.cell === id);
    const founding = grantsOn(lead.at).find((signed) => grantHash(signed) === committedGrant(initial.roster.cells, id, 1));
    assert.ok(opening && founding);
    assert.ok(opening.evidence.grants.some(({ recipients }) => recipients.includes(reduced.writer)));
    const delivery = sealManagedGrantDelivery(initial.roster, {
      recipient: peer.writer, opening, grant: founding, pages: [], accessProof: commitment.proof(id, peer.writer),
      info: { base: false, label }, now: NOW
    }, issuer);
    assert.ok(delivery);
    assert.ok('ok' in await peer.p.ingestManagedGrantDelivery(delivery));
  }

  const before = await head(peer.p);
  assert.equal(before.hash, seed.hash);
  assert.equal(peer.host.scales?.allied, undefined);
  const slot = deviceAt(before.roster.members, peer.writer, before.position)?.slot;
  assert.ok(slot !== undefined);
  const data = { product: 'intel-estimate', clientId: clientIdOf(slot, 0), actor: { kind: 'person' } };
  const writeControl = async (replica: ReplicaProject) => {
    const written = await replica.appendOwn('doc.client', data, { stream: base });
    assert.ok('ok' in written);
    assert.equal(written.built.entry.header.epoch, 1);
  };
  const baseProof = commitment.proof(base, peer.writer);
  assert.ok(baseProof);
  assert.ok('ok' in await peer.p.putGrants([], [baseProof]));
  await writeControl(peer.p);

  type Baseline = { id: string; proof: NonNullable<ReturnType<typeof commitment.proof>>; key: Buffer; entries: [string, number][] };
  const baselines: Baseline[] = [];
  for (const { id } of affected) {
    const proof = commitment.proof(id, peer.writer);
    const key = peer.p.keys.epochKey(id, 1);
    assert.ok(proof && key);
    assert.equal(managedWriteAllowed(before.roster, id, 1, peer.writer, before.position, NOW, proof), true);
    const written = await peer.p.appendOwn('doc.client', data, { stream: id });
    assert.ok('ok' in written);
    assert.equal(written.built.entry.header.epoch, 1);
    baselines.push({ id, proof, key, entries: [[written.hash, 1]] });
  }

  const wrongPolicy = await updateMember({ project: lead.p, deps: lead.at.deps }, { member: reduced.member, clearance: downgraded });
  assert.equal(wrongPolicy.ok, false);
  assert.equal((await head(lead.p)).hash, seed.hash);
  const changed = await updateMember(lead.host, { member: reduced.member, clearance: downgraded });
  assert.equal(changed.ok, true, changed.message);
  assert.deepEqual(changed.rekeyed, []);
  const pending = await head(lead.p);
  const pendingEntry = (await lead.p.entriesAfter(base, lead.p.deviceWriter, -1)).find(({ header }) => entryHash(header) === pending.hash);
  const signedPending = verifyEntry(pendingEntry, lead.p.context());
  assert.ok(signedPending.status === 'verified');
  assert.equal(signedPending.entry.body.kind, 'member.update');
  assert.equal(pending.roster.accessRevision?.entry, pending.hash);
  assert.deepEqual(memberAt(pending.roster.members, reduced.member, pending.position)?.clearance, downgraded);
  assert.ok(deviceAt(pending.roster.members, reduced.writer, pending.position));
  for (const { id } of affected) {
    const evidence = pending.roster.accessGrants.get(id);
    assert.equal(evidence?.decision, 'pending');
    assert.deepEqual(evidence.evidence.excluded, [reduced.writer]);
    assert.match(evidence.evidence.policy ?? '', /^[0-9a-f]{64}$/);
    assert.equal(epochAt(pending.roster.cells, id, pending.position), 1);
  }
  assert.equal(pending.roster.accessGrants.get(base)?.decision, 'continues');

  const routeAt = async (sender: Lead, revision: string) => {
    const { transport, reveal } = await managedPeerRoute(sender, peer, revision);
    const route = transport.managedRoute;
    assert.ok(route);
    const continuity = await sender.p.sealManagedHandoff({ recipient: peer.writer, continuity: [base] });
    assert.ok(continuity);
    assert.equal(await route.put(continuity.handle, continuity.packet), true);
    const offered = [continuity.handle];
    const accepted: string[] = [];
    const memory = hubMemoryOf(new MemorySecrets());
    reveal();
    return {
      route, offered, accepted,
      exchange: (replica: ReplicaProject) => syncOnce(transport, syncLocalOf(replica), memory, { now: () => NOW, managed: {
        offers: async () => [],
        pending: async () => offered.filter((handle) => !accepted.includes(handle)),
        published: async () => { throw new Error('The retained replica has no outgoing handoff.'); },
        accepted: async (handle) => { accepted.push(handle); }
      } })
    };
  };
  const assertHistory = async (replica: ReplicaProject, baseline: Baseline) => {
    const entries = await replica.entriesAfter(baseline.id, peer.writer, -1);
    assert.deepEqual(entries.map(({ header }) => [entryHash(header), header.epoch]), baseline.entries);
  };
  const assertPending = async (replica: ReplicaProject) => {
    const at = await head(replica);
    assert.equal(at.hash, pending.hash);
    assert.deepEqual(memberAt(at.roster.members, reduced.member, at.position)?.clearance, downgraded);
    assert.ok(deviceAt(at.roster.members, reduced.writer, at.position));
    const evidenceDir = path.join(peer.at.root, REPLICA_DIR, 'access-evidence');
    const priorProofs = readdirSync(evidenceDir).flatMap((name) => {
      const stored: unknown = JSON.parse(readFileSync(path.join(evidenceDir, name), 'utf8'));
      return storedAccessProofs(stored, seed.hash);
    });
    for (const baseline of baselines) {
      const { id, key, proof } = baseline;
      assert.equal(epochAt(at.roster.cells, id, at.position), 1);
      assert.ok(replica.keys.epochKey(id, 1)?.equals(key));
      assert.ok(priorProofs.some((candidate) => canonicalBytes(candidate).equals(canonicalBytes(proof))));
      assert.equal(managedWriteAllowed(at.roster, id, 1, peer.writer, at.position, NOW, proof), false);
      const contentBlob = sealBlob(key, id, 1, Buffer.from('fictional pending draft'));
      const refused = await replica.appendOwn('doc.client', data, { stream: id, contentBlob });
      assert.equal(isProjectRefused(refused) && refused.refused, 'rekey-pending');
      assert.equal(existsSync(path.join(peer.at.root, REPLICA_DIR, 'blobs', contentBlob.hash)), false);
      await assertHistory(replica, baseline);
    }
    await writeControl(replica);
  };
  const pendingRoute = await routeAt(lead, pending.hash);
  assert.equal((await pendingRoute.exchange(peer.p)).managed, 'complete');
  assert.deepEqual(pendingRoute.accepted, pendingRoute.offered);
  await assertPending(peer.p);

  const viewer = project(await ReplicaProject.open(lead.at.root, lead.at.deps));
  const receiver = project(await ReplicaProject.open(peer.at.root, peer.at.deps));
  assert.equal((await head(viewer)).hash, pending.hash);
  await assertPending(receiver);
  const reopenedLead = { ...lead, p: viewer, host: { ...lead.host, project: viewer } };
  const finished = await finishRekeys(reopenedLead.host);
  assert.equal(finished.ok, true, finished.message);
  assert.deepEqual(finished.rekeyed, affected.map(({ id }) => id));
  const recovered = await head(viewer);
  for (const { id } of affected) {
    const selected = recovered.roster.accessGrants.get(id);
    const foundingHash = committedGrant(recovered.roster.cells, id, 2);
    assert.ok(selected && foundingHash);
    assert.equal(epochAt(recovered.roster.cells, id, recovered.position), 2);
    assert.equal(selected.evidence.policy, pending.roster.accessGrants.get(id)?.evidence.policy);
    assert.deepEqual(selected.evidence.grants.find(({ hash }) => hash === foundingHash)?.recipients,
      [viewer.deviceWriter, peer.writer].sort());
  }
  assert.ok(deviceAt(recovered.roster.members, reduced.writer, recovered.position));
  const expanded = await updateMember(reopenedLead.host, { member: reduced.member, clearance });
  assert.equal(expanded.reason, 'clearance-grants-pending');
  assert.equal((await head(viewer)).hash, recovered.hash);

  const recoveryRoute = await routeAt(reopenedLead, recovered.hash);
  const deliveries = [];
  for (const { id, label } of affected) {
    const delivery = await viewer.sealManagedHandoff({ cell: id, recipient: peer.writer, info: { base: false, label } });
    assert.ok(delivery);
    deliveries.push(delivery);
    recoveryRoute.offered.push(delivery.handle);
  }
  const [first, second] = deliveries;
  assert.equal(await recoveryRoute.route.put(first.handle, first.packet), true);
  assert.equal((await recoveryRoute.exchange(receiver)).managed, 'waiting');
  assert.equal((await head(receiver)).hash, recovered.hash);
  const [firstCell, secondCell] = baselines;
  const assertRecoveredWrite = async (replica: ReplicaProject, baseline: Baseline) => {
    const { id, key, entries } = baseline;
    const next = replica.keys.epochKey(id, 2);
    assert.ok(next && !next.equals(key));
    const write = await replica.appendOwn('doc.client', data, { stream: id });
    assert.ok('ok' in write);
    assert.equal(write.built.entry.header.epoch, 2);
    entries.push([write.hash, 2]);
    await assertHistory(replica, baseline);
  };
  await assertRecoveredWrite(receiver, firstCell);
  const waiting = project(await ReplicaProject.open(peer.at.root, peer.at.deps));
  assert.equal((await head(waiting)).hash, recovered.hash);
  assert.equal(waiting.keys.holds(secondCell.id, 2), false);
  assert.ok(waiting.keys.epochKey(secondCell.id, 1)?.equals(secondCell.key));
  const refused = await waiting.appendOwn('doc.client', data, { stream: secondCell.id });
  assert.equal(isProjectRefused(refused) && refused.refused, 'no-key');
  await assertHistory(waiting, secondCell);
  await writeControl(waiting);

  assert.equal(await recoveryRoute.route.put(second.handle, second.packet), true);
  assert.equal((await recoveryRoute.exchange(waiting)).managed, 'complete');
  assert.deepEqual(recoveryRoute.accepted.sort(), [...recoveryRoute.offered].sort());
  for (const baseline of baselines) await assertRecoveredWrite(waiting, baseline);
  await writeControl(waiting);
});

async function supplementalFixture() {
  const lead = await founded('managed-give');
  ok(await updateMember(lead.host, { member: 'mbr-lead', clearance: CLEARED_X }), 'declare lead clearance');
  const peer = await bringIn(lead, 'new-cell-recipient', 'Mo Analyst', CLEARED_X);
  assert.ok('ok' in await lead.p.appendOwn('roster.require', { features: ['wrap@2'] }));
  const cell = await createCell(lead, LABEL_X, [lead.p.deviceWriter]);
  const { seed, receipts } = await seedManagedAccess(lead, [lead.p.projectId, cell]);
  assert.ok('ok' in await lead.p.putGrants([], receipts));
  assert.equal(peer.p.keys.holds(cell, 1), false);

  return { lead, peer, cell, seed };
}

test('managed Give keys authorizes the current epoch before a private file handoff', async () => {
  const { lead, peer, cell, seed } = await supplementalFixture();
  const request = { cell, recipient: peer.writer, info: { base: false, label: LABEL_X } };
  assert.equal(await lead.p.sealManagedHandoff(request), undefined);
  const ensured = await ensureLabelCell(lead.host, LABEL_X);
  assert.equal(ensured.ok, true, ensured.ok ? undefined : ensured.message);
  assert.equal(ensured.cell, cell);
  const after = await head(lead.p);
  assert.notEqual(after.hash, seed.hash, 'Give keys must select a new signed access commitment');
  assert.equal(after.roster.accessRevision?.predecessor, seed.hash);
  const manifest = after.roster.accessGrants.get(cell);
  const issued = manifest?.evidence.grants.find((grant) => grant.recipients.includes(peer.writer));
  assert.ok(issued);
  assert.deepEqual(issued.recipients, [peer.writer]);
  assert.equal(manifest?.evidence.epoch, 1);
  assert.equal((await lead.p.signedGrants()).some((grant) => grant.hash === issued.hash), false);
  assert.equal(grantsOn(lead.at).some((grant) => grantHash(grant) === issued.hash), false);
  assert.equal((await writeInBase(lead.p)).epoch, 1);
  const reopened = project(await ReplicaProject.open(lead.at.root, lead.at.deps));
  const repeated = await ensureLabelCell({ ...lead.host, project: reopened }, LABEL_X);
  assert.ok(repeated.ok);
  assert.deepEqual(repeated.granted, []);
  assert.equal((await head(reopened)).hash, after.hash);
  assert.equal(await reopened.sealManagedHandoff({ ...request, recipient: lead.p.deviceWriter }), undefined);
  const delivery = await reopened.sealManagedHandoff(request);
  assert.ok(delivery);
  const wire = JSON.stringify(delivery);
  for (const value of [cell, peer.writer, issued.hash]) assert.equal(wire.includes(value), false);
  peer.at.deps.knownFeatures = [...clientReplicaFeatures(), 'cell-access@1'];
  assert.ok('ok' in await peer.p.ingestManagedGrantDelivery(delivery));
  const update = await reopened.welcomeFor(peer.writer, []);
  const committed = update.roster.find((entry) => entryHash(entry.header) === after.hash);
  assert.ok(committed);
  assert.ok('ok' in await peer.p.ingestForeign([update.genesis, ...update.roster.filter((entry) => entry !== committed)], update.blobs));
  assert.equal(peer.p.keys.holds(cell, 1), false, 'a private package waits for its selected access root');
  assert.ok('ok' in await peer.p.ingestForeign([committed], []));
  const receiving = await head(peer.p);
  assert.ok(lead.p.keys.epochKey(cell, 1) !== undefined);
  assert.deepEqual(peer.p.keys.epochKey(cell, 1), lead.p.keys.epochKey(cell, 1));
  const slot = deviceAt(receiving.roster.members, peer.writer, receiving.position)?.slot;
  assert.ok(slot !== undefined);
  assert.ok('ok' in await peer.p.appendOwn('doc.client',
    { product: 'intel-estimate', clientId: clientIdOf(slot, 0), actor: { kind: 'person' } }, { stream: cell }));

});

async function stageManagedPredecessors(lead: Lead, peer: Person, revision: string) {
  const welcome = await lead.p.welcomeFor(peer.writer, []);
  const root = welcome.roster.find((entry) => entryHash(entry.header) === revision);
  assert.ok(root);
  peer.at.deps.knownFeatures = [...clientReplicaFeatures(), 'cell-access@1'];
  assert.ok('ok' in await peer.p.ingestForeign([welcome.genesis, ...welcome.roster.filter((entry) => entry !== root)], welcome.blobs));

  return root;
}

async function managedPeerRoute(lead: Lead, peer: Person, revision: string) {
  const root = await stageManagedPredecessors(lead, peer, revision);
  const stored = new Map<string, unknown>();
  let revealRoot = false;
  const delayed = new Set<string>();
  const attempts = new Map<string, number>();
  const project = lead.p.projectId;
  const tip = { writer: root.header.writer, seq: root.header.seq, hash: revision };
  const transport: SyncTransport = {
    project, hub: lead.p.deviceWriter,
    hubHeads: async () => ({ project, rosterHead: revealRoot ? revision : (await head(peer.p)).hash,
      streams: revealRoot ? [{ stream: project, heads: [tip] }] : [], grants: [] }),
    entries: async (stream, writer, from) => {
      assert.deepEqual([stream, writer, from], [project, tip.writer, tip.seq]);
      return { project, stream, writer, entries: [root], more: false, head: tip };
    },
    append: async (batch) => ({ project, accepted: batch.entries.map((entry) => entryHash(entry.header)),
      refused: [], grantsRefused: [], rosterHead: revision, blobsPut: false }),
    getBlob: async (hash) => ({ kind: 'missing', hash }),
    grant: async () => { throw new Error('Managed packets must never use the public grants route.'); },
    askCheckpoint: async () => ({ project, kept: 0 }),
    managedRoute: {
      put: async (handle, packet) => { stored.set(handle, packet); return true; },
      get: async (handle) => {
        attempts.set(handle, (attempts.get(handle) ?? 0) + 1);
        return delayed.has(handle) ? undefined : stored.get(handle);
      }
    }
  };
  return { transport, delayed, attempts, reveal: () => { revealRoot = true; } };
}

test('normal managed peer sync adopts the recipient package only after pulling its signed commitment', async () => {
  const { lead, peer, cell } = await supplementalFixture();
  const placed = await ensureLabelCell(lead.host, LABEL_X);
  assert.ok(placed.ok && placed.granted.includes(peer.writer));
  const selected = await head(lead.p);
  const { transport, reveal } = await managedPeerRoute(lead, peer, selected.hash);
  const offer = { cell, recipient: peer.writer, info: { base: false, label: LABEL_X } };
  const sharedHandles: string[] = [];
  let accepted = 0;
  const away = hubMemoryOf(new MemorySecrets());
  const sent = await syncOnce(transport, syncLocalOf(lead.p), away, { now: () => NOW, managed: {
    offers: async () => [offer], pending: async () => [],
    published: async (_offer, handle) => { sharedHandles.push(handle); },
    accepted: async () => { throw new Error('The sending replica has no incoming delivery.'); }
  } });
  assert.equal(sent.managed, 'complete');
  assert.equal(sharedHandles.length, 1);
  const receiver = { now: () => NOW, managed: {
    offers: async () => [], pending: async () => sharedHandles,
    published: async () => { throw new Error('The receiving replica has no outgoing delivery.'); },
    accepted: async () => { accepted += 1; }
  } };
  const memory = hubMemoryOf(new MemorySecrets());
  const before = await syncOnce(transport, syncLocalOf(peer.p), memory, receiver);
  assert.equal(before.managed, 'waiting');
  assert.equal(accepted, 0);
  assert.equal(peer.p.keys.holds(cell, 1), false);
  reveal();
  const after = await syncOnce(transport, syncLocalOf(peer.p), memory, receiver);
  assert.equal(after.managed, 'complete');
  assert.equal(after.pulled, 1);
  assert.equal(accepted, 1);
  assert.deepEqual(peer.p.keys.epochKey(cell, 1), lead.p.keys.epochKey(cell, 1));
});

async function foundingHandoffFixture() {
  const lead = await founded('managed-founding-handoff');
  const peer = await bringIn(lead, 'late-founding-recipient', 'Mo Analyst', CLEARED_X);
  const withdrawn = await bringIn(lead, 'founding-excluded-recipient', 'Nell Planner', CLEARED_X);
  assert.ok('ok' in await lead.p.appendOwn('roster.require', { features: ['wrap@2'] }));
  const cell = await createCell(lead, LABEL_X, [lead.p.deviceWriter, peer.writer, withdrawn.writer]);
  const { receipts } = await seedManagedAccess(lead, [lead.p.projectId, cell]);
  assert.ok('ok' in await lead.p.putGrants([], receipts));
  assert.equal(peer.p.keys.holds(cell, 1), false, 'the late device has no earlier private cell key');
  ok(await updateMember(lead.host, { member: withdrawn.member, clearance: OFFICIAL }), 'record clearance withdrawal');
  const pending = await head(lead.p);
  assert.equal(pending.roster.accessGrants.get(cell)?.decision, 'pending');
  assert.deepEqual(ok(await finishRekeys(lead.host), 'finish').rekeyed, [cell]);
  const selected = await head(lead.p);
  assert.equal(selected.roster.accessRevision?.predecessor, pending.hash);
  return { lead, peer, withdrawn, cell, pending, selected };
}

test('normal managed peer delivery offers the exact founding epoch committed by Finish', async () => {
  const { lead, peer, withdrawn, cell, pending, selected } = await foundingHandoffFixture();
  const request = { cell, recipient: peer.writer, info: { base: false, label: LABEL_X } };
  const sender = syncLocalOf(project(await ReplicaProject.open(lead.at.root, lead.at.deps))).managed;
  assert.ok(sender);
  assert.equal(await sender.seal({ ...request, recipient: withdrawn.writer }), undefined);
  const offered = await sender.seal(request);
  assert.ok(offered, 'the normal sync sender can offer the committed founding grant');
  const keys = await loadOrCreateKemKeys(peer.at.secrets, { identityDir: identityDir(peer.at.global) });
  const artifact = openManagedGrantDelivery(lead.p.projectId, { writer: peer.writer, kem: keys.privateKeys }, offered.handle, offered.packet, NOW);
  assert.ok(artifact && artifact.accessProof);
  const [founding, ...pages] = artifact.grants;
  const verified = readGrant(founding);
  assert.ok(verified.ok);
  const manifest = selected.roster.accessGrants.get(cell)?.evidence.grants.find(({ hash }) => hash === verified.hash);
  assert.ok(manifest);
  assert.deepEqual(pages.map(grantHash).sort(), [...manifest.pages].sort());
  assert.deepEqual(manifest.recipients, [lead.p.deviceWriter, peer.writer].sort());
  assert.equal(verified.grant.roster, pending.hash);
  assert.equal(artifact.accessProof.signed.permit.writer, peer.writer);
  assert.equal(artifact.accessProof.signed.permit.epoch, 2);

  const { transport, reveal, delayed, attempts } = await managedPeerRoute(lead, peer, selected.hash);
  const handles: string[] = [];
  const accepted = new Set<string>();
  const sent = await syncOnce(transport, syncLocalOf(lead.p), hubMemoryOf(new MemorySecrets()), { now: () => NOW, managed: {
    offers: async () => [request, { recipient: peer.writer, continuity: [lead.p.projectId] }],
    pending: async () => [],
    published: async (offer, handle) => {
      handles.push(handle);
      if ('cell' in offer) delayed.add(handle);
    },
    accepted: async () => { throw new Error('The sender has no incoming packet.'); }
  } });
  assert.equal(sent.managed, 'complete');
  assert.equal(handles.length, 2);
  const [foundingHandle, continuityHandle] = handles;
  const options = { now: () => NOW, managed: {
    offers: async () => [],
    pending: async () => handles.filter((handle) => !accepted.has(handle)),
    published: async () => { throw new Error('The recipient has no outgoing packet.'); },
    accepted: async (handle: string) => { accepted.add(handle); }
  } };
  const memory = hubMemoryOf(new MemorySecrets());
  const before = await syncOnce(transport, syncLocalOf(peer.p), memory, options);
  assert.equal(before.managed, 'waiting');
  assert.equal(accepted.size, 0);
  reveal();
  const partial = await syncOnce(transport, syncLocalOf(peer.p), memory, options);
  assert.equal(partial.managed, 'waiting');
  assert.equal(partial.pulled, 1);
  assert.deepEqual([...accepted], [continuityHandle]);
  assert.equal(attempts.get(foundingHandle), 2, 'only one attempt per exchange while the founding grant waits');
  assert.equal((await writeInBase(peer.p)).epoch, 1);
  const receiving = await head(peer.p);
  const slot = deviceAt(receiving.roster.members, peer.writer, receiving.position)?.slot;
  assert.ok(slot !== undefined);
  const data = { product: 'intel-estimate', clientId: clientIdOf(slot, 0), actor: { kind: 'person' } };
  const waiting = await peer.p.appendOwn('doc.client', data, { stream: cell });
  assert.equal(isProjectRefused(waiting) && waiting.refused, 'no-key');
  assert.equal(peer.p.keys.holds(cell, 2), false);

  delayed.clear();
  const complete = await syncOnce(transport, syncLocalOf(peer.p), memory, options);
  assert.equal(complete.managed, 'complete');
  assert.ok(accepted.has(foundingHandle));
  assert.equal(attempts.get(foundingHandle), 3);
  const reopened = project(await ReplicaProject.open(peer.at.root, peer.at.deps));
  const remote = await head(reopened);
  assert.equal(committedGrant(remote.roster.cells, cell, 2), verified.hash);
  assert.equal(reopened.keys.holds(cell, 1), false);
  assert.deepEqual(reopened.keys.epochKey(cell, 2), lead.p.keys.epochKey(cell, 2));
  const written = await reopened.appendOwn('doc.client', data, { stream: cell });
  assert.ok('ok' in written);
  assert.equal(written.built.entry.header.epoch, 2);

});

test('Keep the unaffected cell writable while the selected founding grant waits for a signed child', async () => {
  const lead = await founded('managed-partial-sync');
  const clearance = { ...CLEARED_X, compartments: ['KESTREL', 'OSPREY'] };
  ok(await updateMember(lead.host, { member: 'mbr-lead', clearance }), 'declare lead clearance');
  const peer = await bringIn(lead, 'partial-sync-survivor', 'Mo Analyst', clearance);
  const withdrawn = await bringIn(lead, 'partial-sync-withdrawn', 'Nell Planner', CLEARED_X);
  const base = lead.p.projectId;
  const target = '0'.repeat(32);
  assert.ok(target < base, 'Finish must rotate the labelled cell before the base cell');
  const survivors = [lead.p.deviceWriter, peer.writer].sort();
  assert.ok('ok' in await lead.p.appendOwn('roster.require', { features: ['wrap@2'] }));
  await createCell(lead, LABEL_X, survivors, target);
  const control = await createCell(lead, LABEL_Z, survivors);

  const { seed, receipts, commitment } = await seedManagedAccess(lead, [base, target, control], peer.writer);
  assert.ok('ok' in await lead.p.putGrants([], receipts));
  const initial = await head(lead.p);
  assert.ok(initial.roster.accessGrants.get(base)?.evidence.grants.some(({ recipients }) => recipients.includes(withdrawn.writer)));
  const oldRoot = await stageManagedPredecessors(lead, peer, seed.hash);
  assert.ok('ok' in await peer.p.ingestForeign([oldRoot], []));
  const issuer = { authority: lead.p.deviceWriter, signer: lead.p.signer };
  for (const [cell, label] of [[target, LABEL_X], [control, LABEL_Z]] as const) {
    const hash = committedGrant(initial.roster.cells, cell, 1);
    const founding = grantsOn(lead.at).find((grant) => grantHash(grant) === hash);
    const opening = receipts.find(({ evidence }) => evidence.cell === cell);
    assert.ok(founding && opening && !peer.p.keys.holds(cell, 1));
    const delivery = sealManagedGrantDelivery(initial.roster, {
      recipient: peer.writer, opening, grant: founding, pages: [], accessProof: commitment.proof(cell, peer.writer),
      info: { base: false, label }, now: NOW
    }, issuer);
    assert.ok(delivery);
    assert.ok('ok' in await peer.p.ingestManagedGrantDelivery(delivery));
  }
  const old = await head(peer.p);
  assert.equal(old.hash, seed.hash);
  const oldKey = peer.p.keys.epochKey(target, 1);
  const oldProof = commitment.proof(target, peer.writer);
  const slot = deviceAt(old.roster.members, peer.writer, old.position)?.slot;
  assert.ok(oldKey && oldProof && slot !== undefined);
  assert.deepEqual(oldKey, lead.p.keys.epochKey(target, 1));
  assert.equal(managedWriteAllowed(old.roster, target, 1, peer.writer, old.position, NOW, oldProof), true);
  const data = { product: 'intel-estimate', clientId: clientIdOf(slot, 0), actor: { kind: 'person' } };
  const formerWrite = await peer.p.appendOwn('doc.client', data, { stream: target });
  assert.ok('ok' in formerWrite);
  assert.equal(formerWrite.built.entry.header.epoch, 1);

  const placed = await ensureLabelCell(lead.host, LABEL_X);
  assert.ok(placed.ok && placed.cell === target);
  assert.deepEqual(placed.granted, [withdrawn.writer]);
  const before = await head(lead.p);
  const supplemental = before.roster.accessGrants.get(target)?.evidence.grants.find(({ recipients }) => recipients.includes(withdrawn.writer));
  assert.ok(supplemental);
  assert.deepEqual(supplemental.recipients, [withdrawn.writer]);
  assert.equal(before.roster.accessGrants.get(target)?.evidence.epoch, 1);
  const evidenceOnDisk = (at = peer.at): unknown[] => {
    const evidenceDir = path.join(at.root, REPLICA_DIR, 'access-evidence');
    return readdirSync(evidenceDir).map((name) => JSON.parse(readFileSync(path.join(evidenceDir, name), 'utf8')) as unknown);
  };
  const noSupplementalGrant = () => {
    assert.equal(grantsOn(peer.at).some((grant) => grantHash(grant) === supplemental.hash), false);
    assert.equal(evidenceOnDisk().some((item) => readGrantDelivery(item)?.grants.some((grant) => grantHash(grant) === supplemental.hash)), false);
  };
  noSupplementalGrant();
  ok(await removeFromProject(lead.host, { member: withdrawn.member, writer: withdrawn.writer }), 'record device revocation');
  const pending = await head(lead.p);
  assert.equal(deviceAt(pending.roster.members, withdrawn.writer, pending.position), undefined);
  for (const cell of [target, base]) {
    assert.equal(pending.roster.accessGrants.get(cell)?.decision, 'pending');
    assert.deepEqual(pending.roster.accessGrants.get(cell)?.evidence.excluded, [withdrawn.writer]);
  }
  assert.equal(pending.roster.accessGrants.get(control)?.decision, 'continues');


  const revokedRoute = await managedPeerRoute(lead, peer, pending.hash);
  const pendingContinuity = await lead.p.sealManagedHandoff({ recipient: peer.writer, continuity: [control] });
  assert.ok(pendingContinuity && revokedRoute.transport.managedRoute);
  assert.equal(await revokedRoute.transport.managedRoute.put(pendingContinuity.handle, pendingContinuity.packet), true);
  revokedRoute.reveal();
  const pendingAccepted: string[] = [];
  const revoked = await syncOnce(revokedRoute.transport, syncLocalOf(peer.p), hubMemoryOf(new MemorySecrets()), { now: () => NOW, managed: {
    offers: async () => [],
    pending: async () => [pendingContinuity.handle],
    published: async () => { throw new Error('The survivor has no outgoing handoff.'); },
    accepted: async (handle) => { pendingAccepted.push(handle); }
  } });
  assert.equal(revoked.pulled, 1);
  assert.equal(revoked.managed, 'complete');
  assert.deepEqual(pendingAccepted, [pendingContinuity.handle]);
  const paused = await head(peer.p);
  assert.equal(paused.hash, pending.hash);
  assert.equal(epochAt(paused.roster.cells, target, paused.position), 1);
  assert.deepEqual(peer.p.keys.epochKey(target, 1), oldKey);
  assert.ok(evidenceOnDisk().some((item) => storedAccessProofs(item, seed.hash)
    .some((proof) => canonicalBytes(proof).equals(canonicalBytes(oldProof)))));
  const preFinishWrite = await peer.p.appendOwn('doc.client', data, { stream: target });
  assert.equal(isProjectRefused(preFinishWrite) && preFinishWrite.refused, 'rekey-pending');
  const controlDuringRevocation = await peer.p.appendOwn('doc.client', data, { stream: control });
  assert.ok('ok' in controlDuringRevocation);
  assert.equal(controlDuringRevocation.built.entry.header.epoch, 1);
  assert.deepEqual((await peer.p.entriesAfter(target, peer.writer, -1)).map(({ header }) => entryHash(header)), [formerWrite.hash]);
  noSupplementalGrant();

  const signPages = lead.p.signGrantPages.bind(lead.p);
  const partition = mock.method(lead.p, 'signGrantPages', async (grant: Parameters<typeof signPages>[0]) => {
    if (grant.cell !== target || grant.epoch !== 2) return signPages(grant);
    assert.equal(grant.wraps.length, 2);
    assert.ok(lead.p.keys.epochKey(target, 1)?.equals(oldKey));
    assert.equal(lead.p.keys.holds(target, 2), false);
    const leadWrap = grant.wraps.find(({ writer }) => writer === lead.p.deviceWriter);
    const peerWrap = grant.wraps.find(({ writer }) => writer === peer.writer);
    assert.ok(leadWrap && peerWrap);
    const child = await lead.p.signGrant({ ...grant, labelSealed: '', wraps: [leadWrap], pages: [] });
    return [await lead.p.signGrant({ ...grant, wraps: [peerWrap], pages: [grantHash(child)] }), child];
  });
  const finished = await finishRekeys(lead.host).finally(() => partition.mock.restore());
  const liveLeadKey = lead.p.keys.epochKey(target, 2);
  assert.deepEqual(ok(finished, 'finish the affected cells').rekeyed, [target, base]);
  const selected = await head(lead.p);
  const changes = selected.roster.positions.slice(before.position + 1);
  const entries = await lead.p.entriesAfter(base, lead.p.deviceWriter, -1);
  const verified = changes.map((hash) => {
    const checked = verifyEntry(entries.find(({ header }) => entryHash(header) === hash), lead.p.context());
    assert.ok(checked.status === 'verified');
    return checked.entry;
  });
  assert.deepEqual(verified.map(({ body: { kind } }) => kind), ['device.revoke', 'cell.rekey', 'cell.rekey']);
  assert.equal((verified[0].data as { writer: string }).writer, withdrawn.writer);
  assert.deepEqual(verified.slice(1).map(({ data }) => (data as { cell: string }).cell), [target, base]);
  const targetGrant = selected.roster.accessGrants.get(target);
  assert.ok(targetGrant && targetGrant.entry === selected.hash && targetGrant.evidence.epoch === 2);
  assert.deepEqual(targetGrant.evidence.excluded, [withdrawn.writer]);
  assert.equal(selected.roster.accessGrants.get(control)?.evidence.epoch, 1);

  const request = { cell: target, recipient: peer.writer, info: { base: false, label: LABEL_X } };
  const offered = await lead.p.sealManagedHandoff(request);
  const continuity = await lead.p.sealManagedHandoff({ recipient: peer.writer, continuity: [control] });
  assert.ok(offered && continuity);
  const receiverKeys = await loadOrCreateKemKeys(peer.at.secrets, { identityDir: identityDir(peer.at.global) });
  const openedGrant = openManagedGrantDelivery(base, { writer: peer.writer, kem: receiverKeys.privateKeys }, offered.handle, offered.packet, NOW);
  assert.ok(openedGrant?.accessProof);
  const [founding, ...pages] = openedGrant.grants;
  const completePages = readGrantPages(founding, pages);
  assert.ok(completePages.ok && pages.length === 1);
  assert.deepEqual(completePages.pageHashes, pages.map(grantHash));
  assert.deepEqual(targetGrant.evidence.grants, [{ hash: completePages.hash, pages: completePages.pageHashes, recipients: survivors }]);
  assert.deepEqual(completePages.grant.wraps.map(({ writer }) => writer).sort(), survivors);
  const foundingPage = readGrant(founding);
  const childPage = readGrant(pages[0]);
  assert.ok(foundingPage.ok && childPage.ok);
  assert.deepEqual(foundingPage.grant.wraps.map(({ writer }) => writer), [peer.writer]);
  const [leadWrap] = childPage.grant.wraps;
  assert.equal(leadWrap?.writer, lead.p.deviceWriter);
  const leadKeys = await loadOrCreateKemKeys(lead.at.secrets, { identityDir: identityDir(lead.at.global) });
  const expectedLeadKey = unwrapForDevice({ cell: target, epoch: 2, writer: lead.p.deviceWriter, kem: leadKeys.privateKeys, wrap: leadWrap.wrap });
  assert.ok(expectedLeadKey && !expectedLeadKey.equals(oldKey));
  assert.ok(liveLeadKey?.equals(expectedLeadKey), 'ordinary managed Finish settles the signed child wrap in the live lead ring');
  const recipientWrap = completePages.grant.wraps.find(({ writer }) => writer === peer.writer);
  assert.ok(recipientWrap);
  const expectedKey = unwrapForDevice({ cell: target, epoch: 2, writer: peer.writer, kem: receiverKeys.privateKeys, wrap: recipientWrap.wrap });
  assert.ok(expectedKey && !expectedKey.equals(oldKey), 'the selected signed pages wrap a distinct new key for the survivor');
  assert.equal(openedGrant.accessProof.signed.permit.revision, selected.roster.accessRevision?.id);
  assert.equal(openedGrant.accessProof.signed.permit.epoch, 2);
  assert.equal(sealManagedGrantDelivery(selected.roster, {
    ...request, now: NOW, opening: openedGrant.opening, accessProof: openedGrant.accessProof, grant: founding, pages: []
  }, issuer), undefined, 'the sender refuses the exact selected founding grant without its signed child');

  const { transport, reveal, attempts } = await managedPeerRoute(lead, peer, selected.hash);
  const route = transport.managedRoute;
  assert.ok(route);
  assert.equal(await route.put(continuity.handle, continuity.packet), true);
  reveal();
  const accepted: string[] = [];
  const memory = hubMemoryOf(new MemorySecrets());
  const exchange = (replica: ReplicaProject) => syncOnce(transport, syncLocalOf(replica), memory, { now: () => NOW, managed: {
    offers: async () => [],
    pending: async () => [offered.handle, continuity.handle].filter((handle) => !accepted.includes(handle)),
    published: async () => { throw new Error('The survivor has no outgoing handoff.'); },
    accepted: async (handle) => { accepted.push(handle); }
  } });
  const assertPending = async (replica: ReplicaProject) => {
    const current = await head(replica);
    assert.equal(current.hash, selected.hash);
    assert.equal(replica.keys.holds(target, 2), false);
    assert.deepEqual(replica.keys.epochKey(target, 1), oldKey);
    assert.ok(evidenceOnDisk().some((item) => storedAccessProofs(item, seed.hash)
      .some((proof) => canonicalBytes(proof).equals(canonicalBytes(oldProof)))));
    assert.equal(managedWriteAllowed(current.roster, target, 1, peer.writer, current.position, NOW, oldProof), false);
    assert.equal(current.roster.cells.cells.get(target)?.grants.some(({ hash }) => hash === completePages.hash), false);
    const blocked = await replica.appendOwn('doc.client', data, { stream: target });
    assert.equal(isProjectRefused(blocked) && blocked.refused, 'no-key');
    const write = await replica.appendOwn('doc.client', data, { stream: control });
    assert.ok('ok' in write);
    assert.equal(write.built.entry.header.epoch, 1);
    assert.deepEqual((await replica.entriesAfter(target, peer.writer, -1)).map(({ header }) => [entryHash(header), header.epoch]),
      [[formerWrite.hash, 1]]);
    assert.deepEqual(accepted, [continuity.handle]);
    noSupplementalGrant();
  };
  const partial = await exchange(peer.p);
  assert.equal(partial.pulled, 1);
  assert.equal(partial.grants, 0);
  assert.equal(partial.managed, 'waiting');
  assert.equal(attempts.get(offered.handle), 1);
  await assertPending(peer.p);
  const waiting = project(await ReplicaProject.open(peer.at.root, peer.at.deps));
  assert.equal((await exchange(waiting)).managed, 'waiting');
  assert.equal(attempts.get(offered.handle), 2);
  await assertPending(waiting);

  assert.equal(await route.put(offered.handle, offered.packet), true);
  assert.equal((await exchange(waiting)).managed, 'complete');
  assert.deepEqual(accepted, [continuity.handle, offered.handle]);
  assert.equal(attempts.get(offered.handle), 3);
  const assertRecovered = async (replica: ReplicaProject) => {
    const current = await head(replica);
    assert.equal(current.hash, selected.hash);
    assert.equal(committedGrant(current.roster.cells, target, 2), completePages.hash);
    assert.ok(evidenceOnDisk().some((item) => {
      const delivery = readGrantDelivery(item);
      return delivery !== undefined && delivery.grants.map(grantHash).join() === [completePages.hash, ...completePages.pageHashes].join();
    }));
    assert.ok(replica.keys.epochKey(target, 2)?.equals(expectedKey), 'the stored key matches the survivor’s exact signed wrap');
    noSupplementalGrant();
  };
  await assertRecovered(waiting);
  const resumed = await waiting.appendOwn('doc.client', data, { stream: target });
  assert.ok('ok' in resumed);
  assert.equal(resumed.built.entry.header.epoch, 2);
  const reopened = project(await ReplicaProject.open(peer.at.root, peer.at.deps));
  await assertRecovered(reopened);
  assert.equal((await exchange(reopened)).managed, 'complete');
  assert.equal(attempts.get(offered.handle), 3);
  assert.deepEqual(accepted, [continuity.handle, offered.handle]);
  assert.deepEqual((await reopened.entriesAfter(target, peer.writer, -1)).map(({ header }) => [entryHash(header), header.epoch]),
    [[formerWrite.hash, 1], [resumed.hash, 2]]);

  const leadProofs = evidenceOnDisk(lead.at).flatMap((item) => storedAccessProofs(item, selected.hash));
  assert.equal(managedWriteAllowed(selected.roster, target, 2, lead.p.deviceWriter, selected.position, NOW, undefined, leadProofs), true);
  const leadWrite = await lead.p.appendOwn('doc.client', data, { stream: target });
  assert.ok('ok' in leadWrite);
  assert.equal(leadWrite.built.entry.header.epoch, 2);
  const reopenedLead = project(await ReplicaProject.open(lead.at.root, lead.at.deps));
  assert.equal((await head(reopenedLead)).hash, selected.hash);
  assert.ok(reopenedLead.keys.epochKey(target, 2)?.equals(expectedLeadKey));
});

test('managed sender retries the exact staged opaque packet across restart and remembers upload and publication', async () => {
  const { lead, peer, withdrawn, cell } = await foundingHandoffFixture();
  const request = { cell, recipient: peer.writer, info: { base: false, label: LABEL_X } };
  const sent: { handle: string; bytes: Buffer }[] = [];
  const notifications: string[] = [];
  let putSucceeds = false;
  let notifySucceeds = false;
  let stagedBeforeUpload = 0;
  const route = {
    get: async () => undefined,
    put: async (...args: [string, unknown]) => {
      assert.equal(args.length, 2);
      const [handle, packet] = args;
      sent.push({ handle, bytes: Buffer.from(JSON.stringify(packet)) });
      const folder = path.join(lead.at.root, REPLICA_DIR, 'managed-handoffs');
      if (existsSync(folder)) {
        const [sidecar] = readdirSync(folder);
        const file = path.join(folder, sidecar);
        const contents = readFileSync(file, 'utf8');
        if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
        const stored = JSON.parse(contents) as { rows: { handle: string; packet: unknown }[] };
        assert.equal(JSON.stringify(stored.rows.find((row) => row.handle === handle)?.packet), JSON.stringify(packet));
        const metadata = JSON.stringify(stored.rows.map(({ packet: _packet, ...row }) => row));
        for (const value of [lead.p.projectId, cell, peer.writer, LABEL_X.level]) assert.equal(metadata.includes(value), false);
        stagedBeforeUpload += 1;
      }
      return putSucceeds;
    }
  };
  let offers = [request];
  const exchange = async () => {
    const reopened = project(await ReplicaProject.open(lead.at.root, lead.at.deps));
    return exchangeManaged({
      offers: async () => offers, pending: async () => [], accepted: async () => undefined,
      published: async (_offer, handle, expiresAt) => {
        assert.equal(expiresAt, NOW.getTime() + DAY_MS);
        notifications.push(handle);
        if (!notifySucceeds) throw new Error('Fictional confidential handoff failed');
      }
    }, syncLocalOf(reopened).managed, route, { packets: [], waiting: false }, new Set());
  };
  assert.equal(await exchange(), 'waiting');
  assert.equal(sent.length, 1);
  assert.deepEqual(notifications, []);
  putSucceeds = true;
  lead.at.clock.now = new Date(NOW.getTime() + 180_000);
  assert.equal(await exchange(), 'waiting');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].handle, sent[0].handle, 'a restart uses the exact staged address');
  assert.equal(sent[1].bytes.equals(sent[0].bytes), true, 'a restart uses the exact staged ciphertext');
  assert.equal(stagedBeforeUpload, 2, 'the exact opaque packet is durable before each route call');
  assert.deepEqual(notifications, [sent[0].handle]);

  notifySucceeds = true;
  lead.at.clock.now = new Date(NOW.getTime() + 360_000);
  assert.equal(await exchange(), 'complete');
  assert.equal(sent.length, 2, 'a persisted successful upload needs only confidential publication');
  assert.deepEqual(notifications, [sent[0].handle, sent[0].handle]);
  assert.equal(await exchange(), 'complete');
  assert.equal(sent.length, 2);
  assert.equal(notifications.length, 2);

  lead.at.clock.now = new Date(NOW.getTime() + DAY_MS);
  assert.equal(await exchange(), 'waiting');
  assert.equal(sent.length, 2, 'an expired offer is not silently resealed');
  offers = [{ ...request, recipient: withdrawn.writer }];
  assert.equal(await exchange(), 'waiting');
  assert.equal(sent.length, 2, 'the configured route receives no offer for an unauthorized recipient');
});

test('private founding file waits through reopening for the matching signed roster', async () => {
  const { lead, peer, cell, selected } = await foundingHandoffFixture();
  const request = { cell, recipient: peer.writer, info: { base: false, label: LABEL_X } };
  const file = await lead.p.sealManagedHandoff(request);
  assert.ok(file);
  const root = await stageManagedPredecessors(lead, peer, selected.hash);
  assert.ok('ok' in await peer.p.ingestManagedGrantDelivery(file));
  const reopened = project(await ReplicaProject.open(peer.at.root, peer.at.deps));
  assert.equal(reopened.keys.holds(cell, 2), false);
  assert.ok('ok' in await reopened.ingestForeign([root], []));
  const received = await head(reopened);
  assert.equal(committedGrant(received.roster.cells, cell, 2), committedGrant(selected.roster.cells, cell, 2));
  assert.deepEqual(reopened.keys.epochKey(cell, 2), lead.p.keys.epochKey(cell, 2));
  assert.equal(reopened.keys.holds(cell, 1), false);
});

test('a managed file repeats identical private bytes across reopening and refuses a stale repeat', async () => {
  const { lead, peer, withdrawn, cell, selected } = await foundingHandoffFixture();
  const request = { cell, recipient: peer.writer, info: { base: false, label: LABEL_X } };
  const save = (p: ReplicaProject, offer: typeof request, repeat?: string) => p.sealManagedHandoff(offer, 'file', repeat);
  const first = await save(lead.p, request);
  assert.ok(first);
  assert.equal(first.name, 'shared-keys.near-staff-keys');
  const sender = project(await ReplicaProject.open(lead.at.root, lead.at.deps));
  const repeated = await save(sender, request, first.repeat);
  assert.ok(repeated);
  assert.equal(repeated.text === first.text, true, 'reopening can save the exact original private file');
  assert.equal(await save(sender, { ...request, recipient: withdrawn.writer }, first.repeat), undefined);
  assert.equal(await save(sender, request, '0'.repeat(64)), undefined);
  const cacheRoot = path.join(lead.at.root, REPLICA_DIR, 'managed-handoffs');
  const [cache] = readdirSync(cacheRoot);
  const cachePath = path.join(cacheRoot, cache);
  const state = readFileSync(cachePath, 'utf8');
  const tampered = JSON.parse(state) as { rows: { text: string }[] };
  tampered.rows[0].text = first.text.replace(first.repeat, 'f'.repeat(64));
  writeFileSync(cachePath, JSON.stringify(tampered));
  try {
    await assert.rejects(save(sender, request, first.repeat), /handoff state is unreadable/);
  } finally {
    writeFileSync(cachePath, state);
  }
  const automatic = await sender.sealManagedHandoff(request, true);
  assert.ok(automatic?.state === 'queued');
  assert.notEqual(automatic.handle, first.repeat);
  const root = await stageManagedPredecessors(lead, peer, selected.hash);
  assert.ok('ok' in await peer.p.ingestForeign([root], []));
  const receivedFile = readManagedKeyFile(first.text);
  const copy = readManagedKeyFile(repeated.text);
  assert.ok(receivedFile && copy);
  assert.equal(readManagedKeyFile(JSON.stringify({ ...copy, expectedExpiry: NOW.getTime() + DAY_MS })), undefined);
  assert.equal(isProjectRefused(await peer.p.ingestManagedGrantDelivery({ ...receivedFile, handle: automatic.handle })), true);
  assert.ok('ok' in await peer.p.ingestManagedGrantDelivery(receivedFile));
  const beforeCopy = await peer.p.heads();
  assert.ok('ok' in await peer.p.ingestManagedGrantDelivery(copy));
  assert.deepEqual(await peer.p.heads(), beforeCopy);
  assert.equal(peer.p.keys.holds(cell, 2), true);

  lead.at.clock.now = new Date(NOW.getTime() + DAY_MS);
  assert.equal(await save(sender, request, first.repeat), undefined);
  const fresh = await save(sender, request);
  assert.ok(fresh && fresh.repeat !== first.repeat, 'an explicit fresh export may issue after the original expired');
  assert.ok('ok' in await removeFromProject(lead.host, { member: peer.member }));
  assert.equal(await save(sender, request, fresh.repeat), undefined);
  assert.equal(await save(sender, request), undefined);
});

test('an admitted recipient cannot promote a staged signed delivery after its sealed deadline', async () => {
  const { lead, peer, cell, selected } = await foundingHandoffFixture();
  const request = { cell, recipient: peer.writer, info: { base: false, label: LABEL_X } };
  const file = await lead.p.sealManagedHandoff(request);
  assert.ok(file);
  const root = await stageManagedPredecessors(lead, peer, selected.hash);
  assert.ok('ok' in await peer.p.ingestManagedGrantDelivery(file));
  peer.at.clock.now = new Date(NOW.getTime() + DAY_MS);
  const reopened = project(await ReplicaProject.open(peer.at.root, peer.at.deps));
  assert.ok('ok' in await reopened.ingestForeign([root], []));
  const received = await head(reopened);
  assert.equal(received.hash, selected.hash);
  assert.equal(reopened.keys.holds(cell, 2), false, 'the selected roster cannot revive a delivery whose deadline passed');
  assert.equal(isProjectRefused(await reopened.ingestManagedGrantDelivery(file)), true);
});

test('a local managed inbox resumes only distinct unexpired handles across restart and bounded retries', async () => {
  const lead = await founded('managed-durable-inbox');
  assert.equal(lead.p.managedHandoffInbox(), undefined);
  lead.at.deps.knownFeatures = [...clientReplicaFeatures(), 'cell-access@1'];
  type Inbox = NonNullable<ReturnType<ReplicaProject['managedHandoffInbox']>>;
  const inboxOf = (p: ReplicaProject): Inbox => {
    const inbox = p.managedHandoffInbox();
    assert.ok(inbox);
    return inbox;
  };
  const enqueue = inboxOf(lead.p);
  const [ready, obsolete, waiting, expired] = Array.from({ length: 4 }, () => randomBytes(32).toString('hex'));
  const expiresAt = NOW.getTime() + 60 * 60 * 1000;
  for (const handle of [waiting, ready, obsolete]) assert.equal(await enqueue.enqueue(handle, expiresAt), true);
  assert.equal(await enqueue.enqueue(expired, NOW.getTime() + 500), true);
  const folder = path.join(lead.at.root, REPLICA_DIR, 'managed-handoffs');
  const [sidecar] = readdirSync(folder);
  const file = path.join(folder, sidecar);
  const contents = readFileSync(file, 'utf8');
  assert.match(sidecar, /^[0-9a-f]{64}\.json$/);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(contents.includes(lead.p.projectId), false);
  assert.equal(contents.includes(lead.p.deviceWriter), false);
  lead.at.clock.now = new Date(NOW.getTime() + 1000);
  const reopen = async () => inboxOf(project(await ReplicaProject.open(lead.at.root, lead.at.deps)));
  const handoffs = (inbox: Inbox): ManagedSyncHandoffs => ({ ...inbox, offers: async () => [], published: async () => undefined });
  const requests: string[] = [];
  const route = {
    put: async () => false,
    get: async (...handles: string[]) => {
      assert.equal(handles.length, 1);
      requests.push(handles[0]);
      if (handles[0] === waiting) throw new Error('Fictional route unavailable for this packet');
      return 'fictional ciphertext';
    }
  };
  const restored = handoffs(await reopen());
  const fetched = await fetchManaged(restored, route);
  assert.deepEqual(fetched.packets.map(({ expectedExpiry }) => expectedExpiry), [expiresAt, expiresAt]);
  assert.deepEqual([...requests].sort(), [ready, obsolete, waiting].sort(), 'the reopened inbox asks for live opaque handles only');
  const local = {
    seal: async () => undefined,
    stage: async (value: unknown) => (value as { handle: string }).handle === ready,
    superseded: async (value: unknown) => (value as { handle: string }).handle === obsolete
  };
  assert.equal(await exchangeManaged(restored, local, route, fetched, new Set()), 'waiting');

  const again = await reopen();
  for (const handle of [ready, obsolete]) assert.equal(await again.enqueue(handle, expiresAt), true);
  assert.equal(await again.enqueue(ready, expiresAt + 1000), false, 'an acknowledgment cannot be revived with a longer expiry');
  const delayed = await fetchManaged(handoffs(again), route);
  assert.equal(delayed.waiting, true);
  assert.equal(requests.length, 3, 'backoff survives a reopen');

  lead.at.clock.now = new Date(lead.at.clock.now.getTime() + 180_000);
  const other = handoffs(await reopen());
  await Promise.all([fetchManaged(handoffs(again), route), fetchManaged(other, route)]);
  assert.equal(requests.filter((handle) => handle === waiting).length, 2, 'two windows reserve one due retry');
  for (let retry = 0; retry < 8; retry += 1) {
    lead.at.clock.now = new Date(lead.at.clock.now.getTime() + 180_000);
    await fetchManaged(other, route);
  }
  assert.equal(requests.filter((handle) => handle === waiting).length, 6);
  assert.equal(requests.includes(expired), false);
  assert.equal(requests.filter((handle) => handle === ready || handle === obsolete).length, 2);
});

test('normal managed catch-up keeps an unaffected cell writable with matching proofs and resumes after a delay', async () => {
  const lead = await founded('managed-catchup');
  const compartments = ['KESTREL', 'OSPREY', 'RAVEN', 'LARK', 'TERN', 'WREN'];
  const clearance = { ...CLEARED_X, compartments: [...compartments].sort() };
  ok(await updateMember(lead.host, { member: 'mbr-lead', clearance }), 'declare lead clearance');
  const peer = await bringIn(lead, 'continuity-peer', 'Mo Analyst', clearance);
  assert.ok('ok' in await lead.p.appendOwn('roster.require', { features: ['wrap@2'] }));
  const labels = compartments.map((compartment) => ({ ...LABEL_X, compartments: [compartment] }));
  const cells = [];
  for (const label of labels) cells.push(await createCell(lead, label, [lead.p.deviceWriter]));
  const base = lead.p.projectId;
  const { receipts } = await seedManagedAccess(lead, [base, ...cells]);
  assert.ok('ok' in await lead.p.putGrants([], receipts));
  peer.at.deps.knownFeatures = [...clientReplicaFeatures(), 'cell-access@1'];

  const offer = { recipient: peer.writer, continuity: [base] };
  const revise = async (label: typeof LABEL_X) => {
    const placed = await ensureLabelCell(lead.host, label);
    assert.ok(placed.ok && placed.granted.includes(peer.writer), JSON.stringify(placed));
    const authorization = await head(lead.p);
    const selected = (await lead.p.welcomeFor(peer.writer, [])).roster.find((entry) => entryHash(entry.header) === authorization.hash);
    const packet = await lead.p.sealManagedHandoff(offer);
    assert.ok(selected && packet);
    return { entry: selected, hash: authorization.hash, ...packet };
  };
  const before = await revise(labels[0]);
  const setup = await lead.p.welcomeFor(peer.writer, []);
  assert.ok('ok' in await peer.p.ingestForeign([setup.genesis, ...setup.roster], setup.blobs));
  assert.ok('ok' in await peer.p.ingestManagedGrantDelivery({ handle: before.handle, packet: before.packet }));
  assert.equal((await writeInBase(peer.p)).epoch, 1);

  const first = await revise(labels[1]);
  const second = await revise(labels[2]);
  const served = [first, second];
  const packets = new Map([[first.handle, first.packet], [second.handle, second.packet]]);
  const attempted = new Map<string, number>();
  const taken = new Set<string>();
  const retired = new Set<string>();
  let coalesced = false;
  const handles = [first.handle, second.handle];
  const transport: SyncTransport = {
    project: base, hub: lead.p.deviceWriter,
    hubHeads: async () => {
      const last = served[served.length - 1];
      return { project: base, rosterHead: last.hash, grants: [], streams: [{ stream: base, heads: [
        { writer: lead.p.deviceWriter, seq: last.entry.header.seq, hash: last.hash }
      ] }] };
    },
    entries: async (stream, writer, from) => {
      const index = served.findIndex(({ entry }) => entry.header.seq === from);
      assert.ok(index >= 0);
      const page = coalesced ? served.slice(index) : [served[index]];
      const last = page[page.length - 1];
      return { project: base, stream, writer, entries: page.map(({ entry }) => entry), more: last !== served[served.length - 1],
        head: { writer, seq: last.entry.header.seq, hash: last.hash } };
    },
    append: async (batch) => ({ project: base, accepted: batch.entries.map(({ header }) => entryHash(header)), refused: [],
      grantsRefused: [], rosterHead: served[served.length - 1].hash, blobsPut: false }),
    getBlob: async (hash) => ({ kind: 'missing', hash }),
    grant: async () => { throw new Error('Private continuity must never use the raw grants route.'); },
    askCheckpoint: async () => ({ project: base, kept: 0 }),
    managedRoute: {
      put: async () => false,
      get: async (handle) => { attempted.set(handle, (attempted.get(handle) ?? 0) + 1); return packets.get(handle); }
    }
  };
  const options = { now: () => NOW, managed: {
    offers: async () => [], pending: async () => handles.filter((handle) => !taken.has(handle) && !retired.has(handle)),
    published: async () => { throw new Error('The recipient has no outgoing offer.'); },
    accepted: async (handle: string) => { taken.add(handle); },
    superseded: async (handle: string) => { retired.add(handle); }
  } };
  const memory = hubMemoryOf(new MemorySecrets());
  const local = syncLocalOf(peer.p);
  const acceptedAt: string[] = [];
  const observed: Array<boolean | string> = [];
  const probe: SyncLocal = { ...local, async ingest(...args) {
    const result = await local.ingest(...args);
    const current = await head(peer.p);
    const slot = deviceAt(current.roster.members, peer.writer, current.position)?.slot;
    assert.ok(slot !== undefined);
    const write = await peer.p.appendOwn('doc.client',
      { product: 'intel-estimate', clientId: clientIdOf(slot, 0), actor: { kind: 'person' } });
    acceptedAt.push(current.hash);
    observed.push(isProjectRefused(write) ? write.refused : write.ok);
    return result;
  } };
  const healthy = await syncOnce(transport, probe, memory, options);
  assert.equal(healthy.pulled, 2);
  assert.deepEqual(acceptedAt, [first.hash, second.hash]);
  assert.deepEqual(observed, [true, true], 'a base write is possible as soon as each selected root becomes visible');
  assert.equal(healthy.managed, 'complete');

  const later = await revise(labels[3]);
  served.push(later);
  handles.push(later.handle);
  const delayed = await syncOnce(transport, probe, memory, options);
  assert.equal(delayed.managed, 'waiting');
  assert.equal(observed.at(-1), 'rekey-pending');
  assert.equal(attempted.get(later.handle), 1);
  assert.ok(local.managed);
  assert.equal(await local.managed.stage({ handle: second.handle, packet: second.packet }), false);
  packets.set(later.handle, later.packet);
  assert.equal((await syncOnce(transport, probe, memory, options)).managed, 'complete');
  assert.equal(attempted.get(later.handle), 2);
  const reopened = project(await ReplicaProject.open(peer.at.root, peer.at.deps));
  assert.equal((await writeInBase(reopened)).epoch, 1);

  const superseded = await revise(labels[4]);
  const latest = await revise(labels[5]);
  for (const item of [superseded, latest]) {
    served.push(item);
    handles.push(item.handle);
    packets.set(item.handle, item.packet);
  }
  coalesced = true;
  const caughtUp = await syncOnce(transport, probe, memory, options);
  assert.equal(caughtUp.pulled, 2);
  assert.equal(caughtUp.managed, 'complete', 'the authentic superseded receipt does not keep a healthy exchange waiting');
  assert.equal(acceptedAt.at(-1), latest.hash);
  assert.equal(observed.at(-1), true);
  assert.deepEqual([...retired], [superseded.handle]);
  assert.equal(taken.has(superseded.handle), false);
  assert.equal(taken.has(latest.handle), true);
  assert.equal(await local.managed.superseded?.({ handle: latest.handle, packet: latest.packet }), false);
  assert.equal(await local.managed.superseded?.({ handle: latest.handle, packet: superseded.packet }), false);
  const directory = path.join(peer.at.root, REPLICA_DIR, 'access-evidence');
  const entries = readdirSync(directory).map((name) => JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as { entry?: string });
  assert.equal(entries.some(({ entry }) => entry === superseded.hash), false, 'retirement must not store an obsolete proof');
  await syncOnce(transport, probe, memory, options);
  assert.equal(attempted.get(superseded.handle), 1, 'the confidential callback retires the old handle without another fetch');
});

test('a managed supplemental wrap stays staged and outside grant delivery before authorization', async () => {
  const at = install('managed-grant-staging');
  at.deps.knownFeatures = [...clientReplicaFeatures(), 'cell-access@1'];
  const p = project(await ReplicaProject.createSharedProject(at.root, at.deps, {
    name: 'Exercise Northwind', profile: 'j2', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: 'mbr-lead' }
  }));
  const peer = await bringIn({ at, p, host: hostOf(p, at) }, 'file-receiver', 'Mo Analyst', OFFICIAL);
  assert.ok((await p.signedGrants()).length > 0);
  assert.ok('ok' in await p.appendOwn('roster.require', { features: ['cell-access@1'] }));
  const { roster } = await head(p);
  const key = p.keys.epochKey(p.projectId, 1);
  assert.ok(key);
  const staged = foundingFor({ p }, roster, { cell: p.projectId, key, to: [peer.writer], labelSealed: '' });
  const hash = grantHash(staged);
  assert.ok('ok' in await p.putGrants([staged]));
  const after = await head(p);
  assert.equal(after.roster.cells.cells.get(p.projectId)?.grants.some((grant) => grant.hash === hash), false);
  assert.ok(after.roster.held.some((item) => item.hash === hash && item.reason === 'cell-access-grant-pending'));
  assert.equal((await p.signedGrants()).some((grant) => grant.hash === hash), false);
  const welcome = await p.welcomeFor(peer.writer, [p.projectId]);
  assert.equal(welcome.grants.some((grant) => grantHash(grant) === hash), false);
  const predecessor = after.hash;
  const id = accessRevisionId(p.projectId, null, predecessor, 'cell.access.commit', {});
  const evidence = { project: p.projectId, cell: p.projectId, epoch: 1, policy: null,
    grants: [{ hash, pages: [], recipients: [peer.writer] }], excluded: [] };
  const digest = grantEvidenceHash(evidence);
  assert.ok(digest);
  const permit = { project: p.projectId, cell: p.projectId, epoch: 1, revision: id, predecessor,
    device: peer.writer, writer: peer.writer, authority: p.deviceWriter, certificate: null };
  const differentWriter = { ...permit, device: p.deviceWriter, writer: p.deviceWriter };
  const committed = buildAccessCommitment(id, [{
    cell: p.projectId, epoch: 1, previousEpoch: 1, decision: 'continues', salt: randomBytes(32).toString('hex'), evidence: digest
  }], [permit, differentWriter].map((item) => ({ permit: item, signature: p.signer.sign(accessPermitBytes(item)) })));
  assert.ok(committed);
  const proof = committed.cellProof(p.projectId);
  assert.ok(proof);
  const bound = await p.appendOwn('cell.access.commit', { accessRevision: id, accessRoot: committed.root });
  assert.ok('ok' in bound);
  const opening = { ...proof, entry: bound.hash, evidence };
  const accessProof = committed.proof(p.projectId, peer.writer);
  const wrongWriter = committed.proof(p.projectId, p.deviceWriter);
  assert.ok(accessProof && wrongWriter);
  const handoff = {
    recipient: peer.writer, opening, grant: staged, pages: [], info: { base: true }, now: NOW
  };
  const prepare = (roster: RosterState, candidate: unknown = accessProof) => {
    const options = { ...handoff, accessProof: candidate };
    return sealManagedGrantDelivery(roster, options, { authority: p.deviceWriter, signer: p.signer });
  };
  assert.equal(prepare((await head(p)).roster), undefined, 'delivery waits for the grant and proof to be placed');
  assert.ok('ok' in await p.putGrants([], [opening]));
  assert.ok((await head(p)).roster.cells.cells.get(p.projectId)?.grants.some((grant) => grant.hash === hash));
  assert.equal(prepare((await head(p)).roster, wrongWriter) === undefined, true);
  const sealed = prepare((await head(p)).roster);
  assert.ok(sealed);
  const rival = prepare((await head(p)).roster);
  assert.ok(rival);
  assert.notEqual(rival.handle, sealed.handle);
  const relayView = JSON.stringify(sealed);
  for (const privateValue of [p.projectId, peer.writer, accessProof.signed.signature, evidence.grants[0].hash, proof.cell.decision.salt, proof.cell.decision.evidence]) {
    assert.equal(relayView.includes(privateValue), false);
  }
  const keys = await loadOrCreateKemKeys(peer.at.secrets, { identityDir: identityDir(peer.at.global) });
  const device = { writer: peer.writer, kem: keys.privateKeys };
  assert.equal(openManagedGrantDelivery(p.projectId, device, rival.handle, sealed.packet, NOW), undefined);
  const changedHandle = sealed.handle.slice(0, -1) + (sealed.handle.endsWith('0') ? '1' : '0');
  assert.equal(openManagedGrantDelivery(p.projectId, device, changedHandle, sealed.packet, NOW), undefined);
  assert.equal(openManagedGrantDelivery('f'.repeat(32), device, sealed.handle, sealed.packet, NOW), undefined);
  assert.equal(openManagedGrantDelivery(p.projectId, { ...device, writer: 'f'.repeat(64) }, sealed.handle, sealed.packet, NOW), undefined);
  assert.equal(openManagedGrantDelivery(p.projectId, device, sealed.handle, sealed.packet, new Date(NOW.getTime() + 2 * DAY_MS)), undefined);
  const delivered = openManagedGrantDelivery(p.projectId, device, sealed.handle, sealed.packet, NOW);
  assert.ok(delivered);
  assert.deepEqual(delivered.grants.map(grantHash), [hash]);
  assert.deepEqual(delivered.opening, opening);
  assert.deepEqual('accessProof' in delivered && delivered.accessProof, accessProof);
  const selectedRoster = (await head(p)).roster;
  const nowMs = NOW.getTime();
  const localIssuer = { authority: p.deviceWriter, signer: p.signer };
  const issuance = prepareManagedIssuance(selectedRoster, localIssuer, peer.writer, nowMs, delivered)?.issue(sealed.handle);
  assert.ok(issuance);
  const scope = { project: p.projectId, recipient: peer.writer, handle: sealed.handle, now: nowMs, expectedExpiry: nowMs + DAY_MS };
  assert.ok(readManagedIssuance(issuance, scope));
  assert.equal(managedIssuanceCurrent(selectedRoster, issuance, NOW), true);
  const history = new Map(selectedRoster.accessHistory);
  history.set(issuance.issuance.entry, { ...history.get(issuance.issuance.entry)!, root: 'e'.repeat(64) });
  assert.equal(managedIssuanceCurrent({ ...selectedRoster, accessHistory: history }, issuance, NOW), false);
  for (const altered of [{ ...scope, handle: rival.handle }, { ...scope, expectedExpiry: nowMs + DAY_MS - 1 }, { ...scope, now: nowMs + DAY_MS }]) {
    assert.equal(readManagedIssuance(issuance, altered), undefined);
  }
  assert.equal(readManagedIssuance({ artifact: delivered }, scope), undefined);
  for (const change of [{ root: 'e'.repeat(64) }, { recipient: p.deviceWriter }, { authority: peer.writer }, { expiresAt: scope.expectedExpiry - 1 }]) {
    assert.equal(readManagedIssuance({ ...issuance, issuance: { ...issuance.issuance, ...change } }, { ...scope, expectedExpiry: undefined }), undefined);
  }
  assert.equal(readManagedIssuance({ ...issuance, artifact: { ...delivered, grants: [] } }, scope), undefined);
  const outsider = fixedSigner('fictional-unadmitted-issuer');
  assert.equal(prepareManagedIssuance(selectedRoster, { authority: p.deviceWriter, signer: outsider.signer }, peer.writer, nowMs, delivered), undefined);

  const session = fixedSigner('fictional-managed-delivery-session');
  const slot = deviceAt(selectedRoster.members, p.deviceWriter, selectedRoster.positions.length - 1)?.slot;
  assert.ok(slot !== undefined);
  const stop = nowMs + 10_000;
  const cert = sessionCertifyData({ project: p.projectId, member: 'mbr-lead', device: p.deviceWriter,
    sessionKey: session.publicKey, slot, notAfter: new Date(stop).toISOString() }, (bytes) => session.signer.sign(bytes));
  assert.ok('ok' in await p.appendOwn('session.certify', cert));
  const certified = (await head(p)).roster;
  const sessionPlan = prepareManagedIssuance(certified, { authority: p.deviceWriter, signer: session.signer }, peer.writer, nowMs, delivered);
  assert.ok(sessionPlan && sessionPlan.binding.certificate);
  assert.equal(sessionPlan.expiresAt, stop);
  const sessionIssue = sessionPlan.issue(sealed.handle);
  assert.ok(sessionIssue);
  assert.equal(managedIssuanceCurrent(certified, sessionIssue, NOW), true);
  assert.equal(managedIssuanceCurrent(certified, sessionIssue, new Date(stop)), false);
  assert.equal(managedIssuanceCurrent(selectedRoster, sessionIssue, NOW), false);

  const grantOnly = sealManagedGrantDelivery((await head(p)).roster, handoff, { authority: p.deviceWriter, signer: p.signer });
  assert.ok(grantOnly);
  const oldShape = openManagedGrantDelivery(p.projectId, device, grantOnly.handle, grantOnly.packet, NOW);
  assert.ok(oldShape && !('accessProof' in oldShape));
  const unsupported = await peer.p.ingestManagedGrantDelivery(sealed);
  assert.equal(isProjectRefused(unsupported) && unsupported.refused, 'needs-update');
  peer.at.deps.knownFeatures = [...clientReplicaFeatures(), 'cell-access@1'];
  assert.ok('ok' in await peer.p.ingestManagedGrantDelivery(sealed));
  assert.equal((await peer.p.signedGrants()).some((grant) => grant.hash === hash), false);
  assert.equal((await head(peer.p)).roster.cells.cells.get(p.projectId)?.grants.some((grant) => grant.hash === hash), false);
  const update = await p.welcomeFor(peer.writer, []);
  const root = update.roster.find((entry) => entryHash(entry.header) === bound.hash);
  assert.ok(root);
  assert.ok('ok' in await peer.p.ingestForeign([update.genesis, ...update.roster.filter((entry) => entry !== root)], update.blobs));
  const stagedAt = await head(peer.p);
  const receiverSlot = deviceAt(stagedAt.roster.members, peer.writer, stagedAt.position)?.slot;
  assert.ok(receiverSlot !== undefined);
  const pending = await peer.p.appendOwn('doc.client',
    { product: 'intel-estimate', clientId: clientIdOf(receiverSlot, 0), actor: { kind: 'person' } });
  assert.equal(isProjectRefused(pending) && pending.refused, 'rekey-pending');
  assert.ok('ok' in await peer.p.ingestForeign([root], []));
  assert.ok((await head(peer.p)).roster.cells.cells.get(p.projectId)?.grants.some((grant) => grant.hash === hash));
  assert.equal((await writeInBase(peer.p)).epoch, 1);
  assert.equal(grantsOn(peer.at).some((grant) => grantHash(grant) === hash), false);
  const reopened = project(await ReplicaProject.open(peer.at.root, peer.at.deps));
  assert.equal((await reopened.signedGrants()).some((grant) => grant.hash === hash), false);
  assert.ok((await head(reopened)).roster.cells.cells.get(p.projectId)?.grants.some((grant) => grant.hash === hash));
  assert.equal((await writeInBase(reopened)).epoch, 1);
  assert.ok(grantsOn(at).some((grant) => grantHash(grant) === hash));
});

test('a committed new-epoch permit waits for its authenticated founding grant before local writes resume', async () => {
  const at = install('managed-founding-resume');
  at.deps.knownFeatures = [...clientReplicaFeatures(), 'cell-access@1'];
  const p = project(await ReplicaProject.createSharedProject(at.root, at.deps, {
    name: 'Exercise Northwind', profile: 'j2', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: 'mbr-lead' }
  }));
  assert.ok('ok' in await p.appendOwn('roster.require', { features: ['cell-access@1'] }));
  const { roster, hash: predecessor } = await head(p);
  const cell = p.projectId;
  const key = newEpochKey();
  const pages = newEpochPages(p.signer, roster, {
    cell, info: { base: true }, epoch: 2, key, recipients: [p.deviceWriter], labelSealed: ''
  });
  assert.ok(Array.isArray(pages) && pages.length === 1);
  const hash = grantHash(pages[0]);
  await p.keys.addOwn(cell, 2, key, hash);
  assert.ok('ok' in await p.putGrants(pages));

  const operation = { cell, epoch: 2, grant: hash, reason: 'scheduled' };
  const id = accessRevisionId(p.projectId, null, predecessor, 'cell.rekey', operation);
  const evidence = { project: p.projectId, cell, epoch: 2, policy: null, grants: [{ hash, pages: [], recipients: [p.deviceWriter] }], excluded: [] };
  const digest = grantEvidenceHash(evidence);
  assert.ok(digest);
  const permit = { project: p.projectId, cell, epoch: 2, revision: id, predecessor,
    device: p.deviceWriter, writer: p.deviceWriter, authority: p.deviceWriter, certificate: null };
  const commitment = buildAccessCommitment(id, [{
    cell, epoch: 2, previousEpoch: 1, decision: 'continues', salt: randomBytes(32).toString('hex'), evidence: digest
  }], [{ permit, signature: p.signer.sign(accessPermitBytes(permit)) }]);
  assert.ok(commitment);
  const transitioned = await p.appendOwn('cell.rekey', { ...operation, accessRevision: id, accessRoot: commitment.root });
  assert.ok('ok' in transitioned);
  const current = await head(p);
  assert.equal(current.hash, transitioned.hash);
  const slot = deviceAt(current.roster.members, p.deviceWriter, current.position)?.slot;
  assert.ok(slot !== undefined);
  const accessProof = commitment.proof(cell, p.deviceWriter);
  const opening = commitment.cellProof(cell);
  assert.ok(accessProof && opening);
  const data = { product: 'intel-estimate', clientId: clientIdOf(slot, 0), actor: { kind: 'person' } };
  const contentBlob = sealBlob(key, cell, 2, Buffer.from('fictional resumed draft'));
  const paused = await p.appendOwn('doc.client', data, { accessProof, contentBlob });
  assert.equal(isProjectRefused(paused) && paused.refused, 'rekey-pending');
  assert.equal(existsSync(path.join(at.root, REPLICA_DIR, 'blobs', contentBlob.hash)), false);
  assert.ok('ok' in await p.putGrants([], [{ ...opening, entry: transitioned.hash, evidence }]));
  const resumed = await p.appendOwn('doc.client', data, { accessProof, contentBlob });
  assert.ok('ok' in resumed);
  assert.equal(resumed.built.entry.header.epoch, 2);
});

/** Whether `reader` applies the entry once it has it: it opened the body with its own key for that epoch. */
async function reads(reader: ReplicaProject, written: { hash: string; entry: unknown; blobs: Array<{ hash: string; bytes: string }> }): Promise<boolean> {
  assert.ok(!isProjectRefused(await reader.ingestForeign([written.entry], written.blobs)));
  return (await reader.state()).fold.applied.includes(written.hash);
}

test('CR-01: a grant planted by a member who may not change the roster, for the next epoch of the base cell, is never opened; after the real rekey this device writes with the committed key and the lead reads it', async () => {
  const t = await team();
  const base = t.lead.p.projectId;
  // M is a member, not a roster writer. Before being removed, M plants a grant of the base cell's next epoch on N's computer, wrapping a key M knows.
  const at = await head(t.n.p);
  const planted = newEpochKey();
  const recipient = x25519At(at.roster.members, t.n.writer, at.position) as string;
  const forged = buildGrant(t.m.p.signer, { cell: base, epoch: 2, roster: at.hash, labelSealed: '', wraps: [{ writer: t.n.writer, wrap: wrapEpochKey({ cell: base, epoch: 2, writer: t.n.writer, recipient, epochKey: planted }) }] });
  const stored = await t.n.p.putGrants([forged]);
  assert.ok(!isProjectRefused(stored));
  assert.equal(stored.opened, 0, 'the planted grant is stored, never opened');
  assert.equal(t.n.p.keys.epochKey(base, 2), undefined);
  // The lead removes M, which moves the base cell to epoch 2, and N receives the roster and the grants.
  ok(await removeFromProject(t.lead.host, { member: t.m.member }), 'remove M');
  await sync(t.lead, t.n);
  const real = t.lead.p.keys.epochKey(base, 2);
  assert.ok(real !== undefined);
  assert.deepEqual(t.n.p.keys.epochKey(base, 2), real, 'N holds the key of the grant the roster committed to');
  assert.equal(real.equals(planted), false);
  assert.ok((await t.n.p.state()).roster.refused.some((item) => item.hash === grantHash(forged) && item.kind === 'grant'), 'the roster refuses the planted grant');
  // N writes in the base cell at the new epoch, with the committed key: the lead reads it, and M (who knows the planted key) never could.
  const written = await writeInBase(t.n.p);
  assert.equal(written.epoch, 2);
  assert.equal(await reads(t.lead.p, written), true, 'the lead reads what N wrote');
});

test('MJ-04: a rekey whose entry is not written leaves its key unused; the next rekey of the cell commits a new key, the lead writes with it and a remaining member reads it', async () => {
  const lead = await founded();
  const a = await bringIn(lead, 'a', 'Ari Analyst', OFFICIAL);
  const b = await bringIn(lead, 'b', 'Bo Planner', OFFICIAL);
  const c = await bringIn(lead, 'c', 'Cy Liaison', OFFICIAL);
  const base = lead.p.projectId;
  // The first removal writes member.remove, then the cell.rekey write fails (another window, a full disk): its new key and grant are already kept.
  const appendOwn = lead.p.appendOwn.bind(lead.p);
  const refusal: ProjectRefused = { refused: 'store-refused', message: 'The test refused this write.' };
  lead.p.appendOwn = (kind, data, options) => (kind === 'cell.rekey' ? Promise.resolve(refusal) : appendOwn(kind, data, options));
  let failed: MembershipResult;
  try {
    failed = await removeFromProject(lead.host, { member: a.member });
  } finally {
    lead.p.appendOwn = appendOwn;
  }
  assert.equal(failed.ok, false, 'the removal reports the failed rekey');
  assert.equal(failed.reason, 'store-refused');
  assert.match(failed.message, /The test refused this write/);
  assert.ok(failed.message.includes('Until the affected parts have verified new keys, devices that held the old keys may still read new work encrypted with them.'));
  assert.doesNotMatch(failed.message, /moved to a new key|anything new/);
  const between = await head(lead.p);
  assert.equal(epochAt(between.roster.cells, base, between.position), 1, 'the base cell was not rekeyed');
  const staleGrants = grantsOn(lead.at).filter((signed) => { const read = readGrant(signed); return read.ok && read.grant.cell === base && read.grant.epoch === 2; });
  assert.equal(staleGrants.length, 1, 'the failed rekey left its grant on disk');
  // The next removal first finishes A's (MJ-03): it rekeys the base cell to the same epoch 2 with a new key, then removes B and rekeys it to epoch 3.
  const removedB = ok(await removeFromProject(lead.host, { member: b.member }), 'remove B');
  assert.equal(removedB.ok, true);
  assert.deepEqual(removedB.rekeyed, [base, base], 'the base cell finished first, then moved again for B');
  assert.match(removedB.message, /left unfinished/);
  assert.match(removedB.message, /finished first: one part/);
  const { roster, position } = await head(lead.p);
  assert.equal(epochAt(roster.cells, base, position), 3);
  const cPrivate = createPrivateKey({ key: Buffer.from(c.at.secrets.values.get(ENCRYPTION_KEY_SECRET) as string, 'base64'), format: 'der', type: 'pkcs8' });
  // C opens a wrap with its own keys: X25519 for an older wrap, its post-quantum keys for a cell-wrap/v2 one (33.2: the project started switched).
  const cKem = (await loadOrCreateKemKeys(c.at.secrets, { identityDir: identityDir(c.at.global) })).privateKeys;
  const keyFor = (signed: unknown, epoch: number): Buffer | undefined => {
    const read = readGrant(signed);
    assert.ok(read.ok, 'the grant reads');
    const wrap = read.grant.wraps.find((item) => item.writer === c.writer);
    assert.ok(wrap !== undefined, `C is on epoch ${epoch}`);
    return unwrapForDevice({ cell: base, epoch, writer: c.writer, x25519: cPrivate, kem: cKem, wrap: wrap.wrap });
  };
  const committed2 = grantsOn(lead.at).find((signed) => grantHash(signed) === committedGrant(roster.cells, base, 2));
  assert.ok(committed2 !== undefined, 'the committed grant of epoch 2 is on disk');
  assert.notEqual(grantHash(committed2), grantHash(staleGrants[0]), 'epoch 2 commits to a new grant, not the one the failed rekey left');
  const committedKey = keyFor(committed2, 2);
  const staleKey = keyFor(staleGrants[0], 2);
  assert.ok(committedKey !== undefined && staleKey !== undefined);
  assert.notDeepEqual(committedKey, staleKey);
  assert.deepEqual(lead.p.keys.epochKey(base, 2), committedKey, 'the lead holds the committed key, not the key of the failed rekey');
  const committed3 = grantsOn(lead.at).find((signed) => grantHash(signed) === committedGrant(roster.cells, base, 3));
  assert.ok(committed3 !== undefined, 'the committed grant of epoch 3 is on disk');
  const latestKey = keyFor(committed3, 3);
  await sync(lead, c);
  assert.deepEqual(c.p.keys.epochKey(base, 2), committedKey);
  assert.deepEqual(c.p.keys.epochKey(base, 3), latestKey);
  // The lead writes in the base cell at epoch 3 and C reads it.
  const written = await writeInBase(lead.p);
  assert.equal(written.epoch, 3);
  assert.equal(await reads(c.p, written), true, 'C reads what the lead wrote after the rekey');
});

test('a person admitted after the base cell was rekeyed reads the roster through every epoch from the grants placed at their admission, and a planted grant does not change which key they hold, even with the cache gone', async () => {
  const t = await team();
  const base = t.lead.p.projectId;
  ok(await removeFromProject(t.lead.host, { member: t.m.member }), 'remove M');
  const p = await bringIn(t.lead, 'p', 'Pat Late', OFFICIAL);
  const lead = await head(t.lead.p);
  const mine = await head(p.p);
  assert.deepEqual(mine.roster.positions, lead.roster.positions, 'the late joiner reaches the lead\'s roster head');
  for (const epoch of [1, 2]) assert.deepEqual(p.p.keys.epochKey(base, epoch), t.lead.p.keys.epochKey(base, epoch), `base epoch ${epoch}`);
  // M, removed, plants grants of both base epochs wrapped to the late joiner, and the joiner's cached keys are lost.
  const planted = newEpochKey();
  const recipient = x25519At(mine.roster.members, p.writer, mine.position) as string;
  const forged = [1, 2].map((epoch) => buildGrant(t.m.p.signer, { cell: base, epoch, roster: mine.hash, labelSealed: '', wraps: [{ writer: p.writer, wrap: wrapEpochKey({ cell: base, epoch, writer: p.writer, recipient, epochKey: planted }) }] }));
  assert.ok(!isProjectRefused(await p.p.putGrants(forged)));
  p.at.secrets.values.delete(`nearAi.staff.epochKeys.${base}`);
  const reopened = project(await ReplicaProject.open(p.at.root, p.at.deps));
  assert.equal(reopened.keys.size, 0);
  const again = await head(reopened);
  assert.deepEqual(again.roster.positions, lead.roster.positions);
  for (const epoch of [1, 2]) assert.deepEqual(reopened.keys.epochKey(base, epoch), t.lead.p.keys.epochKey(base, epoch), `base epoch ${epoch} after the cache was lost`);
  // What the late joiner writes, the lead reads.
  const written = await writeInBase(reopened);
  assert.equal(written.epoch, 2);
  assert.equal(await reads(t.lead.p, written), true);
});

// ---- review fixes: who may invite (MJ-05), the safety code (MJ-01), the pin (MN-01), the lost welcome (MJ-02), unfinished rekeys (MJ-03) ----------

test('MJ-05: the lead\'s second computer invites and admits a new person, who joins; the invitation names the founding lead as the anchor and that computer as the inviter', async () => {
  const lead = await founded();
  const second = await addMachine(lead, 'mbr-lead', 'a2', 'Lee Lead');
  const p = await bringIn(second, 'p', 'Pat Planner', OFFICIAL);
  const [invited, joined, admitted] = p.results;
  const read = readInvite(file(invited).text, NOW);
  assert.ok(read.ok);
  assert.equal(read.invite.lead.writer, lead.p.deviceWriter, 'the anchor is the founding device');
  assert.equal(read.invite.inviter.writer, second.writer, 'the inviter is the second computer');
  // Both screens show the same words, and they cover the inviter's keys: the same request under an invitation naming the founding device as inviter
  // would give other words.
  assert.deepEqual(admitted.safetyWords, joined.safetyWords);
  const request = (JSON.parse(file(joined).text) as { payload: { publicKey: string; x25519: string; nonce: string } }).payload;
  assert.notDeepEqual(inviteSafetyCode({ ...read.invite, inviter: read.invite.lead }, request), joined.safetyWords);
  const atP = await head(p.p);
  assert.ok(rosterView(atP.roster).isAdmitted(p.writer, atP.hash));
  assert.equal(atP.roster.anchor.lead.writer, lead.p.deviceWriter, 'the new person pinned the founding anchor');
});

test('MJ-05: after the deputy cuts off the founding device and takes over the lead, the new lead invites, admits and the person joins', async () => {
  const t = await team();
  const d = await bringIn(t.lead, 'd', 'Dee Deputy', CLEARED_X);
  ok(await nameDeputy(t.lead.host, d.member), 'name the deputy');
  await sync(t.lead, d);
  ok(await removeFromProject(d.host, { member: 'mbr-lead', writer: t.lead.p.deviceWriter }), 'the deputy revokes the founding device');
  ok(await handOverLead(d.host, { to: d.member, reason: 'lead-lost' }), 'the deputy takes over the lead');
  const p = await bringIn(d, 'p', 'Pat Planner', OFFICIAL);
  const atP = await head(p.p);
  assert.ok(rosterView(atP.roster).isAdmitted(p.writer, atP.hash));
  assert.equal(rosterView(atP.roster).isAdmitted(t.lead.p.deviceWriter, atP.hash), false, 'the founding device stays revoked');
  assert.equal(leadAt(atP.roster, atP.position), d.member);
  const base = t.lead.p.projectId;
  assert.ok(p.p.keys.epochKey(base, epochAt(atP.roster.cells, base, atP.position) as number) !== undefined, 'the person holds the current base key');
});

test('MJ-05: a welcome whose roster shows the invitation written by another device than the one the invitation names is refused, and nothing is kept; the real invitation then joins with the same welcome', async () => {
  const lead = await founded();
  const second = await addMachine(lead, 'mbr-lead', 'a2', 'Lee Lead');
  const b = install('b');
  const invited = ok(await inviteToProject(lead.host, { name: 'Jo Analyst', seat: 'j2-chief', clearance: OFFICIAL }), 'invite');
  const read = readInvite(file(invited).text, NOW);
  assert.ok(read.ok);
  // The same invitation and secret, re-signed by the second computer naming itself as the inviter: the founding device wrote the member.invite entry.
  const secondSelf = (await head(second.p)).roster.members.devices.get(second.writer)?.[0];
  assert.ok(secondSelf);
  const forged = buildInvite(second.p.signer, {
    genesisHash: read.invite.genesisHash, project: read.invite.project, name: read.invite.name,
    lead: { member: read.invite.lead.member, x25519: read.invite.lead.x25519, publicKey: read.invite.lead.publicKey }, inviter: { member: 'mbr-lead', x25519: secondSelf.x25519 },
    invite: read.invite.invite, secret: read.invite.secret, expiresAt: read.invite.expiresAt, now: NOW
  });
  const joined = ok(await joinFromInvite(b.root, b.deps, JSON.stringify(forged), { name: 'Jo Analyst' }), 'join from the re-signed invitation');
  // The six words catch it: the lead's screen covers the founding device as inviter, the joiner's the second computer.
  const reviewed = ok(await reviewJoinRequest(lead.host, file(joined).text), 'review');
  assert.notDeepEqual(reviewed.safetyWords, joined.safetyWords);
  // The lead admits anyway; the joining computer refuses the welcome and keeps no pin and no project.json.
  const admitted = ok(await admitJoinRequest(lead.host, file(joined).text, { codeMatched: true }), 'admit');
  const refusedWelcome = await openWelcome(b.root, b.deps, file(admitted).text);
  assert.equal(refusedWelcome.reason, 'welcome-not-for-invitation');
  assert.equal(refusedWelcome.message, MEMBERSHIP_REFUSALS['welcome-not-for-invitation']);
  assert.equal(refusedWelcome.project, undefined);
  assert.equal(existsSync(genesisPinFile(b.global, lead.p.projectId)), false, 'the pin was set aside');
  assert.equal(existsSync(path.join(b.root, ...REPLICA_DIR.split('/'), 'project.json')), false, 'project.json was set aside');
  // Opening the real invitation keeps its anchor and inviter; the same welcome then joins.
  ok(await joinFromInvite(b.root, b.deps, file(invited).text, { name: 'Jo Analyst' }), 'join from the real invitation');
  const welcomed = ok(await openWelcome(b.root, b.deps, file(admitted).text), 'welcome');
  const joinedProject = project(welcomed.project);
  const atB = await head(joinedProject);
  assert.ok(rosterView(atB.roster).isAdmitted(joinedProject.deviceWriter, atB.hash));
});

test('MN-01: opening a bogus invitation for a known project pins nothing, so the real invitation and its welcome still join', async () => {
  const lead = await founded();
  const b = install('b');
  const mallory = install('mallory');
  const fake = await ReplicaProject.localDevice(mallory.deps);
  const bogus = buildInvite(fake.signer, {
    genesisHash: lead.p.anchor.genesisHash, project: lead.p.projectId, name: 'Exercise Northwind', lead: { member: 'mbr-lead', x25519: fake.x25519 },
    invite: 'inv-bogus', secret: newJoinSecret(), expiresAt: new Date(NOW.getTime() + DAY_MS).toISOString(), now: NOW
  });
  ok(await joinFromInvite(b.root, b.deps, JSON.stringify(bogus), { name: 'Jo Analyst' }), 'the bogus invitation is answered');
  assert.equal(existsSync(genesisPinFile(b.global, lead.p.projectId)), false, 'nothing pinned');
  const invited = ok(await inviteToProject(lead.host, { name: 'Jo Analyst', seat: 'j2-chief', clearance: OFFICIAL }), 'the real invitation');
  const joined = ok(await joinFromInvite(b.root, b.deps, file(invited).text, { name: 'Jo Analyst' }), 'the real invitation is answered');
  assert.equal(readdirSync(pendingInvitationsDir(b.global, lead.p.projectId)).length, 2, 'both invitations are kept until a welcome arrives');
  const admitted = ok(await admitJoinRequest(lead.host, file(joined).text, { codeMatched: true }), 'admit');
  const welcomed = ok(await openWelcome(b.root, b.deps, file(admitted).text), 'welcome');
  const joinedProject = project(welcomed.project);
  assert.equal(joinedProject.anchor.lead.writer, lead.p.deviceWriter, 'the real anchor is pinned');
  const pin = JSON.parse(readFileSync(genesisPinFile(b.global, lead.p.projectId), 'utf8')) as { anchor: { lead: { writer: string } } };
  assert.equal(pin.anchor.lead.writer, lead.p.deviceWriter);
  // A welcome on a computer that opened no invitation for that project is refused plainly.
  const nobody = install('nobody');
  const lost = await openWelcome(nobody.root, nobody.deps, file(admitted).text);
  assert.equal(lost.reason, 'no-invitation-opened');
  assert.equal(existsSync(genesisPinFile(nobody.global, lead.p.projectId)), false);
});

test('MJ-02: a welcome file lost after admission is made again from the same join request, with nothing written and no join secret, and it opens', async () => {
  const lead = await founded();
  const { at: b, invited, joined } = await invitedAndJoined(lead);
  const id = invited.invite as string;
  const admitted = ok(await admitJoinRequest(lead.host, file(joined).text, { codeMatched: true }), 'admit');
  assert.equal(lead.at.secrets.values.has(JOIN_SECRET_PREFIX + id), false, 'the join secret is forgotten at admission');
  // The welcome file was never saved. Review the same request again: the person is already in, and only the welcome can be made again.
  const before = await head(lead.p);
  const reviewed = ok(await reviewJoinRequest(lead.host, file(joined).text), 'review again');
  assert.equal(reviewed.alreadyAdmitted, true);
  assert.equal(reviewed.safetyWords, undefined);
  const again = ok(await remakeWelcome(lead.host, file(joined).text), 'make the welcome again');
  assert.equal(file(again).name, `welcome-${id}${WELCOME_FILE_EXTENSION}`);
  assert.equal(again.member, admitted.member);
  assert.equal((await head(lead.p)).hash, before.hash, 'nothing written');
  assert.deepEqual(again.notices, multiUserNoticeLines());
  const welcomed = ok(await openWelcome(b.root, b.deps, file(again).text), 'the remade welcome opens');
  const bp = project(welcomed.project);
  const atB = await head(bp);
  assert.ok(rosterView(atB.roster).isAdmitted(bp.deviceWriter, atB.hash));
  assert.ok(bp.keys.epochKey(lead.p.projectId, 1) !== undefined);
  // Forbidden: admitting it again is still invite-used; another device's request for the used invitation is invite-used; a request whose
  // invitation admitted nobody yet is not-admitted-yet; a member's computer is not a roster writer.
  assert.equal((await admitJoinRequest(lead.host, file(joined).text, { codeMatched: true })).reason, 'invite-used');
  const other = install('other');
  const stranger = ok(await joinFromInvite(other.root, other.deps, file(invited).text, { name: 'Someone Else' }), 'a second answer');
  assert.equal((await remakeWelcome(lead.host, file(stranger).text)).reason, 'invite-used');
  const open = await invitedAndJoined(lead, 'c');
  const notYet = await remakeWelcome(lead.host, file(open.joined).text);
  assert.equal(notYet.reason, 'not-admitted-yet');
  assert.equal(notYet.message, MEMBERSHIP_REFUSALS['not-admitted-yet']);
  assert.equal((await remakeWelcome(hostOf(bp, b), file(joined).text)).reason, 'not-a-roster-writer');
});

test('MJ-02: a grant file that does not read, dropped in the lead\'s grants folder, does not stop the welcome', async () => {
  const lead = await founded();
  const junk = { not: 'a grant' };
  const name = `1-${createHash('sha256').update(canonicalBytes(junk)).digest('hex')}.json`;
  const dir = path.join(lead.at.root, ...REPLICA_DIR.split('/'), 'grants', lead.p.projectId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), JSON.stringify(junk));
  const b = await bringIn(lead, 'b', 'Jo Analyst', OFFICIAL);
  const admitted = b.results[2];
  assert.doesNotMatch(admitted.message, /could not be put in the welcome file/);
  assert.ok(b.p.keys.epochKey(lead.p.projectId, 1) !== undefined, 'the welcome carried the base cell');
});

test('MJ-03: a removal interrupted after member.remove is found from the roster and finished: each cell the member held moves to a new key without them; finishing again is nothing-to-finish', async () => {
  const t = await team();
  const base = t.lead.p.projectId;
  // The removal is written, then the window dies before any cell moves to a new key.
  const written = await t.lead.p.appendOwn('member.remove', { member: t.m.member });
  assert.ok('ok' in written);
  const cut = await head(t.lead.p);
  assert.equal(memberAt(cut.roster.members, t.m.member, cut.position), undefined, 'removed');
  assert.equal(epochAt(cut.roster.cells, base, cut.position), 1);
  assert.equal(epochAt(cut.roster.cells, t.x, cut.position), 1, 'the cells it held are still on the key it holds');
  assert.equal(await unfinishedRekeys(t.lead.host), 2);
  // Running Remove again cannot name the member any more; a member's computer can neither see nor finish it.
  await sync(t.lead, t.n);
  assert.equal(await unfinishedRekeys(t.n.host), 0);
  assert.equal((await finishRekeys(t.n.host)).reason, 'not-a-roster-writer');
  const finished = ok(await finishRekeys(t.lead.host), 'finish');
  assert.deepEqual([...(finished.rekeyed ?? [])].sort(), [base, t.x].sort());
  assert.ok(finished.message.includes(REKEY_KEEP_TEXT));
  assert.ok(finished.message.includes('Devices excluded from the new keys cannot read work encrypted with those keys.'));
  assert.doesNotMatch(finished.message, /anything new/);
  assert.deepEqual(finished.notices, multiUserNoticeLines());
  const after = await head(t.lead.p);
  assert.equal(epochAt(after.roster.cells, base, after.position), 2);
  assert.equal(epochAt(after.roster.cells, t.x, after.position), 2);
  const view = rosterView(after.roster);
  assert.deepEqual(view.cellGrantees?.(base, after.hash), [t.lead.p.deviceWriter, t.n.writer].sort());
  assert.deepEqual(view.cellGrantees?.(t.x, after.hash), [t.lead.p.deviceWriter]);
  assert.equal((await head(t.lead.p)).roster.cells.cells.get(t.z)?.epochs.length, 1, 'a cell the member never held is not touched');
  // Nothing left: refused, and nothing written.
  const again = await finishRekeys(t.lead.host);
  assert.equal(again.reason, 'nothing-to-finish');
  assert.equal(again.message, MEMBERSHIP_REFUSALS['nothing-to-finish']);
  assert.equal((await head(t.lead.p)).hash, after.hash);
  assert.equal(await unfinishedRekeys(t.lead.host), 0);
});

test('MJ-03: the next roster flow finishes an interrupted removal first: an admission rekeys before it grants, and removing the member again says it finished', async () => {
  const t = await team();
  const base = t.lead.p.projectId;
  assert.ok('ok' in (await t.lead.p.appendOwn('member.remove', { member: t.m.member })));
  const p = await bringIn(t.lead, 'p', 'Pat Planner', OFFICIAL);
  assert.equal(p.results[2].ok, true);
  assert.match(p.results[2].message, /left unfinished/);
  assert.match(p.results[2].message, /finished first: 2 parts/);
  const atLead = await head(t.lead.p);
  assert.equal(epochAt(atLead.roster.cells, base, atLead.position), 2);
  const grantees = rosterView(atLead.roster).cellGrantees?.(base, atLead.hash) ?? [];
  assert.ok(grantees.includes(p.writer) && !grantees.includes(t.m.writer));
  assert.ok(p.p.keys.epochKey(base, 2) !== undefined, 'the new person holds the new key');
  // Another interrupted removal, finished by running Remove for the same member again.
  const u = await team();
  assert.ok('ok' in (await u.lead.p.appendOwn('member.remove', { member: u.n.member })));
  const removedAgain = ok(await removeFromProject(u.lead.host, { member: u.n.member }), 'remove again');
  assert.deepEqual(removedAgain.rekeyed, [u.lead.p.projectId]);
  assert.match(removedAgain.message, /left unfinished is now finished/);
  assert.match(removedAgain.message, /requested member is already absent/);
  assert.doesNotMatch(removedAgain.message, /Devices excluded|was removed/);
  assert.equal((await removeFromProject(u.lead.host, { member: u.n.member })).reason, 'member-unknown', 'with nothing left, the member is unknown as before');
});

test('MJ-03: a clearance change interrupted after member.update is finished: the cell the member is no longer cleared for moves to a new key without them', async () => {
  const t = await team();
  assert.ok('ok' in (await t.lead.p.appendOwn('member.update', { member: t.m.member, clearance: OFFICIAL })));
  assert.equal(await unfinishedRekeys(t.lead.host), 1);
  const finished = ok(await finishRekeys(t.lead.host), 'finish');
  assert.deepEqual(finished.rekeyed, [t.x]);
  const after = await head(t.lead.p);
  assert.deepEqual(rosterView(after.roster).cellGrantees?.(t.x, after.hash), [t.lead.p.deviceWriter]);
  assert.deepEqual(rosterView(after.roster).cellGrantees?.(t.lead.p.projectId, after.hash), [t.lead.p.deviceWriter, t.m.writer, t.n.writer].sort(), 'the base cell is not touched');
  assert.equal((await finishRekeys(t.lead.host)).reason, 'nothing-to-finish');
});

test('SECURITY.md has the invitations subsection inside the multi-user section, with no em-dash', () => {
  const text = readFileSync(path.join(__dirname, '..', '..', 'SECURITY.md'), 'utf8');
  const section = text.indexOf('## Multi-user staff projects (preview)');
  const heading = text.indexOf('### Invitations, join secrets and the safety code');
  assert.ok(section >= 0 && heading > section);
  const next = text.indexOf('\n## ', section + 5);
  assert.ok(next === -1 || heading < next, 'inside the multi-user section');
  assert.equal(text.split('### Invitations, join secrets and the safety code').length - 1, 1);
  assert.ok(!/\u2014/.test(text));
});

test('MN-05: finishing an interrupted removal never writes a new epoch without its label: a cell this computer cannot label is refused no-grant-key and stays on its epoch', async () => {
  const t = await team();
  const y = await unlabelledCell(t.lead, [t.lead.p.deviceWriter, t.n.writer]);
  // The removal is written, then the window dies before any cell moves to a new key.
  assert.ok('ok' in (await t.lead.p.appendOwn('member.remove', { member: t.n.member })));
  const cut = await head(t.lead.p);
  const finished = await finishRekeys(t.lead.host);
  assert.equal(finished.reason, 'no-grant-key');
  assert.equal(finished.message, MEMBERSHIP_REFUSALS['no-grant-key']);
  const after = await head(t.lead.p);
  assert.equal(epochAt(after.roster.cells, y, after.position), 1, 'no label-less epoch was written for Y');
  assert.ok(after.roster.cells.cells.get(y)?.epochs.every((epoch) => epoch.epoch === 1));
  assert.ok(after.position >= cut.position);
});

// ---- 32-04 Task 1: a roster split is described from its branch entries alone (D-08) ---------------------------------------------------------------

interface LeadSplit { t: Team; one: string; two: string; secondWriter: string }

/** The two-lead-devices split: each lead device renames N offline on the same head, and the second device's change reaches the lead's computer. */
async function leadSplit(): Promise<LeadSplit> {
  const t = await team();
  const second = await addMachine(t.lead, 'mbr-lead', 'a2', 'Lee Lead');
  assert.equal((await head(second.p)).hash, (await head(t.lead.p)).hash);
  ok(await updateMember(t.lead.host, { member: t.n.member, name: 'Nell One' }), 'first device');
  const one = (await head(t.lead.p)).hash;
  ok(await updateMember(second.host, { member: t.n.member, name: 'Nell Two' }), 'second device');
  const two = (await head(second.p)).hash;
  await sync(second, t.lead);
  const split = await head(t.lead.p);
  assert.equal(split.roster.pending.length, 1);
  assert.deepEqual([...split.roster.pending[0].branches].sort(), [one, two].sort());
  return { t, one, two, secondWriter: second.writer };
}

const UNREADABLE_BRANCH = 'A roster change this computer cannot read';

/** Each branch's summary, by branch hash. */
const summaries = (views: ReadonlyArray<{ branch: string; summary: string }>): Map<string, string> => new Map(views.map((view) => [view.branch, view.summary]));

test('describeRosterBranches describes both branches of a split from the roster lines, without a welcome file', async () => {
  const { t, one, two } = await leadSplit();
  const welcome = mock.method(t.lead.p, 'welcomeFor', () => Promise.reject(new Error('no welcome file is built to describe a split')));
  try {
    const described = await describeRosterBranches(t.lead.host);
    assert.deepEqual(described.map((view) => view.branch).sort(), [one, two].sort());
    for (const view of described) {
      assert.equal(view.summary, 'Changes the details of Nell Planner', 'named as the roster had it at the split');
      assert.equal(view.by, 'mbr-lead', 'the member whose device wrote it');
      assert.equal(typeof view.at, 'string');
    }
    assert.equal(welcome.mock.callCount(), 0, 'no welcome file was built');
  } finally {
    welcome.mock.restore();
  }
});

test('describeRosterBranches skips damaged and overlong roster lines, and reads nothing through a symbolic link in place of the roster folder', async () => {
  const { t, one, two, secondWriter } = await leadSplit();
  // The fold is taken once; the store is not read again, so only describeRosterBranches reads the changed files below.
  const folded = await t.lead.p.state();
  const frozen = mock.method(t.lead.p, 'state', () => Promise.resolve(folded));
  try {
    const folder = path.join(t.lead.at.root, ...REPLICA_DIR.split('/'), 'streams', t.lead.p.projectId);
    // Damaged lines before the branch entries in every roster line file: not JSON, the wrong shape, an empty line.
    for (const name of readdirSync(folder).filter((item) => item.endsWith('.jsonl'))) {
      const lineFile = path.join(folder, name);
      writeFileSync(lineFile, `not json\n{"header":{},"body":""}\n\n${readFileSync(lineFile, 'utf8')}`);
    }
    const damaged = summaries(await describeRosterBranches(t.lead.host));
    assert.equal(damaged.get(one), 'Changes the details of Nell Planner');
    assert.equal(damaged.get(two), 'Changes the details of Nell Planner');
    // The second branch's only line, padded past the longest line the store writes, is skipped whole: that branch cannot be read, the other can.
    const twoFile = path.join(folder, `${secondWriter}.jsonl`);
    const lines = readFileSync(twoFile, 'utf8').split('\n');
    const index = lines.findIndex((line) => { try { return entryHash((JSON.parse(line) as { header: Parameters<typeof entryHash>[0] }).header) === two; } catch { return false; } });
    assert.ok(index >= 0, 'the second branch is on the second device\'s line file');
    lines[index] = `{${' '.repeat(40 * 1024)}${lines[index].slice(1)}`;
    writeFileSync(twoFile, lines.join('\n'));
    const overlong = summaries(await describeRosterBranches(t.lead.host));
    assert.equal(overlong.get(one), 'Changes the details of Nell Planner');
    assert.equal(overlong.get(two), UNREADABLE_BRANCH);
    // The roster folder replaced by a symbolic link to the same lines: nothing is read through it.
    const moved = `${folder}-moved`;
    renameSync(folder, moved);
    symlinkSync(moved, folder, 'dir');
    const linked = summaries(await describeRosterBranches(t.lead.host));
    assert.deepEqual([...linked.values()], [UNREADABLE_BRANCH, UNREADABLE_BRANCH]);
    assert.deepEqual([...linked.keys()].sort(), [one, two].sort());
  } finally {
    frozen.mock.restore();
  }
});

// ---- 32-04 Task 2: the lead role moves only by a handover or naming the deputy (D-08, D-66) -------------------------------------------------------

test('member.update cannot give the lead role: a direct append from the lead\'s device or the deputy\'s is refused lead-role-by-handover-only by the fold, and updateMember refuses it before anything is written', async () => {
  // Two separate teams, so the lead's write and the deputy's never cite one head.
  for (const by of ['lead', 'deputy'] as const) {
    const t = await team();
    ok(await nameDeputy(t.lead.host, t.m.member), 'name the deputy');
    await sync(t.lead, t.m);
    const writer = by === 'lead' ? t.lead : t.m;
    const other = by === 'lead' ? t.m : t.lead;
    const before = await head(writer.p);
    const written = await writer.p.appendOwn('member.update', { member: 'mbr-lead', roles: ['member', 'staff_lead'] });
    assert.ok('ok' in written, `${by}: the entry is written`);
    await sync(writer, other);
    for (const p of [writer.p, other.p]) {
      const after = await head(p);
      assert.deepEqual(after.roster.refused.filter((item) => item.hash === written.hash), [{ hash: written.hash, kind: 'member.update', reason: 'lead-role-by-handover-only' }], `${by}: refused by the fold`);
      assert.equal(after.hash, before.hash, `${by}: the roster head does not move`);
      assert.equal(leadAt(after.roster, after.position), 'mbr-lead');
      assert.equal(deputyAt(after.roster, after.position), t.m.member);
      assert.deepEqual(memberAt(after.roster.members, 'mbr-lead', after.position)?.roles, ['member']);
    }
    // The host refuses the same change, from either roster writer, before anything is written.
    for (const roles of [['member', 'staff_lead'], ['deputy_lead']]) {
      for (const host of [t.lead.host, t.m.host]) {
        const at = await head(host.project);
        const blocked = await updateMember(host, { member: t.n.member, roles });
        assert.equal(blocked.ok, false);
        assert.equal(blocked.reason, 'lead-role-by-handover-only');
        assert.equal(blocked.message, MEMBER_REFUSALS['lead-role-by-handover-only']);
        assert.equal((await head(host.project)).hash, at.hash, `${roles.join(' ')}: nothing written`);
      }
    }
  }
});

test('a member.update from the deputy that leaves staff_lead out of the lead\'s roles changes no leadership: the lead is still the lead and still writes the roster', async () => {
  const t = await team();
  ok(await nameDeputy(t.lead.host, t.m.member), 'name the deputy');
  await sync(t.lead, t.m);
  const changed = ok(await updateMember(t.m.host, { member: 'mbr-lead', roles: ['member'] }), 'the deputy updates the lead');
  assert.equal(changed.member, 'mbr-lead');
  await sync(t.m, t.lead);
  for (const p of [t.m.p, t.lead.p]) {
    const at = await head(p);
    assert.equal(at.hash, (await head(t.m.p)).hash, 'the update is applied on both computers');
    assert.equal(leadAt(at.roster, at.position), 'mbr-lead');
    assert.equal(deputyAt(at.roster, at.position), t.m.member);
    assert.equal(isRosterWriterAt(at.roster, t.lead.p.deviceWriter, at.position), true, 'the lead\'s device still writes the roster');
    const view = rosterView(at.roster);
    assert.equal(view.hasRole('mbr-lead', 'staff_lead', at.hash), true);
    assert.equal(view.hasRole(t.m.member, 'staff_lead', at.hash), false, 'the deputy is not the lead');
    assert.equal(view.hasRole(t.m.member, 'deputy_lead', at.hash), true);
  }
  ok(await updateMember(t.lead.host, { member: t.n.member, name: 'Nell Renamed' }), 'the lead changes another member');
  const after = await head(t.lead.p);
  assert.equal(memberAt(after.roster.members, t.n.member, after.position)?.name, 'Nell Renamed');
});
