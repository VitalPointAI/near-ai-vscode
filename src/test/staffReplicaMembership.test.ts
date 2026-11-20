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
