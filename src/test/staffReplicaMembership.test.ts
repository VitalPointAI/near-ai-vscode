// Who is in a multi-user staff project (31-20; D-09, D-10, D-13 to D-18, D-22, D-23, D-37, D-45): two and more installs, each with its own project
// folder, extension storage and secret storage, invite, join, admit and welcome each other by file and six spoken words; every wrong invitation is
// refused in plain words; removing a member or a device, or lowering a clearance, moves the affected cells to new keys; and the lead and the deputy
// keep the roster whole through a split, a deputy and a handover.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test, { after } from 'node:test';
import type { ScaleTable } from '../domain/gate/labels';
import { REKEY_KEEP_TEXT, buildGrant, grantHash, newEpochKey, sealLabel, wrapEpochKey } from '../domain/replica/cellKeys';
import { INVITE_FILE_EXTENSION, JOIN_REQUEST_FILE_EXTENSION, WELCOME_FILE_EXTENSION, buildJoinRequest, inviteSafetyCode, joinSecretHash, newJoinSecret, readInvite } from '../domain/replica/invite';
import { MEMBER_REFUSALS, inviteAt, memberAt, x25519At } from '../domain/replica/rosterMembers';
import { ROSTER_REFUSALS, ROSTER_SPLIT_TEXT, deputyAt, leadAt, rosterView } from '../domain/replica/roster';
import type { RosterState } from '../domain/replica/roster';
import { epochAt } from '../domain/replica/rosterCells';
import { REPLICA_DIR, multiUserNoticeLines } from '../domain/staff/multiUser';
import type { SecretStorageLike } from '../services/auth';
import { JOIN_SECRET_PREFIX } from '../staff/replica/keyring';
import {
  MEMBERSHIP_REFUSALS, addMyOtherMachine, admitJoinRequest, cellOrderHook, chooseRosterBranch, handOverLead, inviteToProject, joinFromInvite, nameDeputy,
  openWelcome, removeFromProject, reviewJoinRequest, updateMember, voidInvite
} from '../staff/replica/membership';
import type { MembershipResult, SharedProjectHost } from '../staff/replica/membership';
import { ReplicaProject, genesisPinFile, isProjectRefused } from '../staff/replica/replicaProject';
import type { ProjectRefused, ReplicaProjectDeps } from '../staff/replica/replicaProject';

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
async function createCell(lead: Lead, label: unknown, to: readonly string[]): Promise<string> {
  const at = await head(lead.p);
  const cell = randomBytes(16).toString('hex');
  const key = newEpochKey();
  const wraps = to.map((writer) => ({ writer, wrap: wrapEpochKey({ cell, epoch: 1, writer, recipient: x25519At(at.roster.members, writer, at.position) as string, epochKey: key }) }));
  const founding = buildGrant(lead.p.signer, { cell, epoch: 1, roster: at.hash, labelSealed: sealLabel(key, cell, 1, label), wraps });
  await lead.p.keys.addOwn(cell, 1, key);
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
      if (name.startsWith('nearAi.staff.epochKeys.')) for (const item of (JSON.parse(value) as { keys: Array<[string, number, string]> }).keys) found.push(item[2]);
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
  // B pinned the genesis the invite names.
  const pin = JSON.parse(readFileSync(genesisPinFile(b.global, lead.p.projectId), 'utf8')) as { anchor: { genesisHash: string } };
  assert.equal(pin.anchor.genesisHash, lead.p.anchor.genesisHash);
  const reviewed = ok(await reviewJoinRequest(lead.host, file(joined).text), 'review');
  assert.deepEqual(reviewed.safetyWords, joined.safetyWords);
  // The words come from the invite and both devices' keys (31-16): computed independently on A's side.
  const read = readInvite(file(invited).text, NOW);
  assert.ok(read.ok);
  const request = JSON.parse(file(joined).text) as { payload: { publicKey: string; x25519: string } };
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

test('removing a member writes member.remove and one cell.rekey for each cell it held, each wrapped only to the devices still cleared; it keeps epoch 1 of X and never opens epoch 2', async () => {
  const t = await team();
  const base = t.lead.p.projectId;
  const removed = ok(await removeFromProject(t.lead.host, { member: t.m.member }), 'remove');
  assert.ok(removed.message.includes(REKEY_KEEP_TEXT));
  assert.ok(removed.message.includes('They keep what they already received. They will not receive anything new.'));
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
  // Every grant reaches M's computer and N's: M opens nothing new, N opens the new base key and nothing of X.
  assert.ok(!isProjectRefused(await t.m.p.putGrants(grantsOn(t.lead.at))));
  assert.ok(!isProjectRefused(await t.n.p.putGrants(grantsOn(t.lead.at))));
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
  const { roster, hash, position } = await head(t.lead.p);
  assert.ok(memberAt(roster.members, t.m.member, position) !== undefined, 'M stays a member');
  assert.equal(rosterView(roster).isAdmitted(second.writer, hash), false);
  assert.equal(rosterView(roster).isAdmitted(t.m.writer, hash), true);
  assert.equal(epochAt(roster.cells, t.z, position), 1, 'Z not rekeyed');
  assert.deepEqual(rosterView(roster).cellGrantees?.(t.x, hash), [t.lead.p.deviceWriter, t.m.writer].sort());
  for (const at of [t.m, second]) assert.ok(!isProjectRefused(await at.p.putGrants(grantsOn(t.lead.at))));
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
  const { roster, hash, position } = await head(t.lead.p);
  assert.deepEqual(memberAt(roster.members, t.n.member, position)?.clearance, OFFICIAL);
  assert.deepEqual(rosterView(roster).cellGrantees?.(t.x, hash), [t.lead.p.deviceWriter, t.m.writer].sort());
  assert.equal(epochAt(roster.cells, base, position), 1);
  assert.ok(!isProjectRefused(await t.n.p.putGrants(grantsOn(t.lead.at))));
  assert.equal(t.n.p.keys.epochKey(t.x, 2), undefined);
  // A change that is not about clearance rekeys nothing, and a change of nothing is refused.
  const renamed = ok(await updateMember(t.lead.host, { member: t.n.member, name: 'Nell P' }), 'rename');
  assert.deepEqual(renamed.rekeyed, []);
  assert.ok(!renamed.message.includes(REKEY_KEEP_TEXT));
  assert.equal((await updateMember(t.lead.host, { member: t.n.member })).reason, 'nothing-to-change');
  assert.equal((await updateMember(t.lead.host, { member: 'mbr-nobody', name: 'X' })).reason, 'member-unknown');
});

test('raising a clearance writes grants for the newly cleared cells with every earlier epoch', async () => {
  const t = await team();
  // X gets a second epoch first: M is removed.
  ok(await removeFromProject(t.lead.host, { member: t.m.member }), 'remove M');
  const raised = ok(await updateMember(t.lead.host, { member: t.n.member, clearance: CLEARED_X }), 'raise');
  assert.deepEqual(raised.granted, [t.x]);
  assert.deepEqual(raised.rekeyed, []);
  const { roster, hash } = await head(t.lead.p);
  assert.deepEqual(rosterView(roster).cellGrantees?.(t.x, hash), [t.lead.p.deviceWriter, t.n.writer].sort());
  assert.ok(!isProjectRefused(await t.n.p.putGrants(grantsOn(t.lead.at))));
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
  const wraps = to.map((writer) => ({ writer, wrap: wrapEpochKey({ cell, epoch: 1, writer, recipient: x25519At(at.roster.members, writer, at.position) as string, epochKey: key }) }));
  const founding = buildGrant(lead.p.signer, { cell, epoch: 1, roster: at.hash, labelSealed: '', wraps });
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
  assert.ok(removed.message.includes('Nobody else is on one part of the project, so no new key was made for it.'));
  assert.ok(removed.message.includes(REKEY_KEEP_TEXT));
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
  // Removing N is still possible: Y keeps the devices that were granted it, without N.
  const removed = ok(await removeFromProject(t.lead.host, { member: t.n.member }), 'remove N');
  assert.ok((removed.rekeyed ?? []).includes(y));
  const { roster, hash } = await head(t.lead.p);
  assert.deepEqual(rosterView(roster).cellGrantees?.(y, hash), [t.lead.p.deviceWriter]);
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
