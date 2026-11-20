// Make a Single-Machine Copy (plan 31-22; owner decision 6, D-35, D-37, D-47; MUS-06). A shared staff project is folded back into today's
// single-machine files in a new folder, signed by this device. The tests check that today's own host and verifiers trust the copy, that the shared
// project is untouched byte for byte, that other people's steps are carried under the copier and a contested decision is never carried as decided,
// and that a destination in the shared project or one with staff files is refused with nothing written.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test, { after } from 'node:test';
import { canonicalBytes } from '../domain/team/canonical';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, localInsert, snapshotOf } from '../domain/replica/doc';
import { sealBlob } from '../domain/replica/entry';
import type { Actor, SealedBlob } from '../domain/replica/entry';
import { epochAt } from '../domain/replica/rosterCells';
import { deviceAt } from '../domain/replica/rosterMembers';
import { replicaVersionHash } from '../domain/replica/versions';
import type { ProductVersions } from '../domain/replica/versions';
import { LEDGER_PROBLEMS, parseLedgerHeadMark } from '../domain/staff/ledger';
import { CALC_LEDGER_FILE, replayCalcLedger } from '../domain/staff/logistics';
import type { PlanningFactor } from '../domain/staff/logistics';
import { DECISION_LOG_FILE, replayPersonDecisions } from '../domain/staff/personDecisions';
import type { ProductState } from '../domain/staff/ledger';
import { REPLICA_DIR, multiUserNoticeLines } from '../domain/staff/multiUser';
import type { PersonActor } from '../domain/staff/release';
import { verifyPayload } from '../domain/team/signedPayload';
import type { DeviceIdentity } from '../team/identity';
import { isMigrationRefused, ledgerHeadKey, makeMultiUser, projectionInputOf } from '../staff/replica/migrate';
import type { MigrationDeps } from '../staff/replica/migrate';
import { ledgerLinesOf, projectLedgerReplay } from '../staff/replica/projection';
import { admitJoinRequest, inviteToProject, joinFromInvite, openWelcome, updateMember } from '../staff/replica/membership';
import type { MembershipResult, SharedProjectHost } from '../staff/replica/membership';
import { ReplicaProject, isProjectRefused } from '../staff/replica/replicaProject';
import type { ProjectRefused } from '../staff/replica/replicaProject';
import { CONTESTED_AT_COPY_TEXT, COPY_REFUSALS, carriedApprovalName, makeSingleMachineCopy } from '../staff/replica/singleCopy';
import type { CopyDeps, CopyRefused, CopyResult } from '../staff/replica/singleCopy';
import { LEDGER_DIR, LEDGER_FILE, StaffHost, WARGAME_DIR, WARGAME_FILE, productPath } from '../staff/staffHost';
import type { StaffTeamInfo } from '../staff/staffHost';
import { callLogistics, callTool, CLEAN_BODY, hashIn, J5_TEAM, memorySecrets, trusting, writeBody, writeFactors } from './helpers/staffFixtures';
import { fixedSigner } from './helpers/replicaWorld';
import type { StaffWorld } from './helpers/staffFixtures';

const NOW = '2026-11-20T10:00:00.000Z';
const NAME = 'Exercise Northwind';
const CONOPS = 'concept-of-operations';
const DECISION_ROLE = 'commander';
const COPIER = { name: 'C. Copier', role: 'Plans officer' };

type Secrets = ReturnType<typeof memorySecrets>;

/** One install with a staff project: the project folder, the extension's global storage, its secret storage, and the device that signs. */
interface Env {
  readonly base: string;
  readonly root: string;
  readonly global: string;
  readonly secrets: Secrets;
  readonly signer: DeviceIdentity;
  readonly deps: MigrationDeps & CopyDeps;
}

async function freshEnv(label: string): Promise<Env> {
  const base = mkdtempSync(path.join(tmpdir(), `near-ai-copy-${label}-`));
  const root = path.join(base, 'project');
  await mkdir(root, { recursive: true });
  const global = path.join(base, 'global');
  const secrets = memorySecrets();
  const device = await ReplicaProject.localDevice({ secrets, globalStorageDir: global, now: () => new Date(NOW) });
  const signer = device.signer;
  return { base, root, global, secrets, signer, deps: { secrets, globalStorageDir: global, now: () => new Date(NOW), staffKeyStatus: async () => trusting(signer), copier: COPIER } };
}

/** Today's host over a folder, signed by the env's device, its head kept in the env's secrets. */
function hostAt(env: Env, root: string, trust: KeyTrust = (signer) => trusting(signer)): StaffHost {
  const clock = { now: Date.parse('2026-11-18T12:00:00.000Z') };
  return new StaffHost({ root, signer: async () => env.signer, keyStatus: async () => trust(env.signer), headStore: env.secrets, now: () => { clock.now += 1000; return clock.now; } });
}
type KeyTrust = (signer: DeviceIdentity) => ReturnType<typeof trusting>;

function worldOf(env: Env): StaffWorld {
  const world: StaffWorld = {
    root: env.root, signer: env.signer, clock: { now: 0 }, host: hostAt(env, env.root), headStore: env.secrets,
    reload: () => { world.host = hostAt(env, env.root); return world.host; },
    person: (name = 'A. Demo', role = DECISION_ROLE): PersonActor => ({ kind: 'person', name, role, deviceFingerprint: env.signer.fingerprint })
  };
  return world;
}

function must(result: { ok: boolean; text: string }, what: string): string {
  assert.ok(result.ok, `${what}: ${result.text}`);
  return result.text;
}

/** A product proposed, guard-cleared, submitted, approved and released by today's host. */
async function releasedProduct(world: StaffWorld): Promise<void> {
  await writeBody(world.root, 'j5', CONOPS, CLEAN_BODY);
  const hash = hashIn(must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: CONOPS, kind: 'plan' }, 'lead-planner'), 'propose'));
  must(await callTool(world, J5_TEAM, 'mcp__staff-products__verdict', { product: CONOPS, gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard'), 'verdict');
  must(await callTool(world, J5_TEAM, 'mcp__staff-products__submit', { product: CONOPS, decisionFor: DECISION_ROLE }, 'lead-planner'), 'submit');
  const approved = await world.host.decide(world.person(), { product: CONOPS, action: 'approve', hash });
  assert.ok(approved.ok, approved.ok ? '' : approved.message);
  const released = await world.host.decide(world.person(), { product: CONOPS, action: 'release', hash });
  assert.ok(released.ok, released.ok ? '' : released.message);
}

async function migrated(label: string): Promise<Env> {
  const env = await freshEnv(label);
  await releasedProduct(worldOf(env));
  const result = await makeMultiUser(env.root, env.deps, { name: NAME });
  assert.ok(!isMigrationRefused(result), isMigrationRefused(result) ? result.message : '');
  return env;
}

/** The shared projection of an env's project, as today's host would show it. */
async function sharedReplay(env: Env) {
  const project = await ReplicaProject.open(env.root, env.deps);
  assert.ok(project instanceof ReplicaProject, `the shared project opens (${isProjectRefused(project) ? project.message : String(project)})`);
  try {
    return projectLedgerReplay(await projectionInputOf(project, env.deps));
  } finally {
    await project.close();
  }
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** Every file under a folder, by path, with the sha256 of its bytes (the replica store included). */
function tree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else out.set(path.relative(root, file).split(path.sep).join('/'), sha256(readFileSync(file)));
    }
  };
  walk(root);
  return out;
}

async function copied(env: Env, destination: string, deps: CopyDeps = env.deps): Promise<CopyResult> {
  const result = await makeSingleMachineCopy(env.root, destination, deps);
  assert.ok(result.ok, result.ok ? '' : `the copy is made: ${result.message}`);
  return result;
}

// ---- Task 1: the tracer -----------------------------------------------------------------------------------------------------------------------------

test('tracer: a migrated project with one released product copies to a new folder that today\'s host replays without a break', async () => {
  const env = await migrated('tracer');
  const shared = (await sharedReplay(env)).products.get(CONOPS) as ProductState;
  assert.equal(shared.record.state, 'released');
  const destination = path.join(env.base, 'copy');
  const result = await copied(env, destination);
  assert.ok(result.written.includes(`${LEDGER_DIR}/${LEDGER_FILE}`), 'the product ledger is written');
  assert.ok(result.written.includes(productPath('j5', CONOPS)), 'the product file is written');
  assert.equal(result.carried, 0, 'every step was taken by this device\'s own person, so nothing is carried under another name');
  assert.deepEqual(result.contested, []);
  assert.deepEqual(result.differs, []);

  // The head mark is kept, signed by this device, under the key today's host computes for the copy's folder, before any host has looked at the copy.
  const markText = env.secrets.values.get(ledgerHeadKey(destination));
  assert.ok(markText !== undefined, 'the copy writes its head mark under the copy\'s key');

  // Today's host, rooted at the copy as any single-machine project, replays it without a break and shows the product as the shared projection does.
  const host = hostAt(env, destination);
  const replay = await host.replay();
  assert.equal(replay.broken, undefined, 'the copy\'s product ledger verifies with today\'s verifier');
  const state = replay.products.get(CONOPS) as ProductState;
  assert.ok(state !== undefined);
  assert.equal(state.tampered, undefined);
  assert.equal(state.record.state, shared.record.state);
  assert.equal(state.record.version, shared.record.version);
  assert.equal(state.record.hash, shared.record.hash);
  assert.deepEqual(state.meta, shared.meta);
  assert.deepEqual(state.approvedVersions, shared.approvedVersions);
  // The product file agrees with the copy's ledger: today's status shows it released, not tampered.
  const status = await host.productState(CONOPS);
  assert.equal(status?.state, 'released');
  assert.equal(status?.tampered, undefined);

  // The mark names the ledger's own count and head, so today's replay did not need to move it; a copy cut short reads as truncated.
  assert.equal(env.secrets.values.get(ledgerHeadKey(destination)), markText, 'the replay left the copy\'s mark as the copy wrote it');
  const verdict = verifyPayload(JSON.parse(markText) as unknown, { purpose: 'staff-ledger-head', status: trusting(env.signer) });
  assert.ok(verdict.ok);
  assert.deepEqual(parseLedgerHeadMark(verdict.payload), { v: 1, count: replay.entries, head: replay.head });
  const ledgerFile = path.join(destination, LEDGER_DIR, LEDGER_FILE);
  const lines = readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean);
  writeFileSync(ledgerFile, `${lines.slice(0, -1).join('\n')}\n`);
  assert.equal((await hostAt(env, destination).replay()).broken?.reason, LEDGER_PROBLEMS.truncated, 'today\'s host found the copy\'s head mark');
});

test('the shared project is byte for byte untouched by a copy: every file under it and every secret but the copy\'s new head mark', async () => {
  const env = await migrated('untouched');
  const filesBefore = tree(env.base);
  const secretsBefore = new Map(env.secrets.values);
  const destination = path.join(env.base, 'copy');
  await copied(env, destination);
  const filesAfter = tree(env.base);
  for (const [file, hash] of filesBefore) assert.equal(filesAfter.get(file), hash, `${file} is unchanged`);
  const added = [...filesAfter.keys()].filter((file) => !filesBefore.has(file));
  assert.ok(added.length > 0 && added.every((file) => file.startsWith('copy/')), `only the copy's files are new (${added.filter((file) => !file.startsWith('copy/')).join(', ')})`);
  const secretsAfter = new Map(env.secrets.values);
  const markKey = ledgerHeadKey(destination);
  assert.ok(secretsAfter.has(markKey) && !secretsBefore.has(markKey));
  secretsAfter.delete(markKey);
  assert.deepEqual(secretsAfter, secretsBefore, 'no other secret changed');
});

// ---- Task 2: carried approvals, contested at copy time, and destination refusals ----------------------------------------------------------------

const LEAD_NAME = 'P. Planner';
const OFFICIAL = { scale: 'demo', level: 'OFFICIAL', compartments: [], releasability: [] };
const HEADER = { kind: 'plan', label: 'demo/Official', profile: 'nato-ca', level: 'tactical' };
const ROLES = { owner: 'lead-planner', sectionLead: 'j5-chief', releaseGuard: 'release-guard' };
const agent = (member: string): Actor => ({ kind: 'agent', member, run: 'run-1' });
const PERSON: Actor = { kind: 'person' };

const projects: ReplicaProject[] = [];
after(async () => {
  for (const item of projects) await item.close();
});

function kept(value: ReplicaProject | ProjectRefused | undefined): ReplicaProject {
  assert.ok(value instanceof ReplicaProject, `the project opens (${isProjectRefused(value) ? value.message : String(value)})`);
  projects.push(value);
  return value;
}

function done<T extends MembershipResult>(result: T, what: string): T {
  assert.equal(result.ok, true, `${what}: ${result.reason ?? ''} ${result.message}`);
  return result;
}

/** One install of a shared project: its folder, storage and secrets, and its open project. */
interface Seat { readonly env: Env; readonly p: ReplicaProject; readonly host: SharedProjectHost }

/** What a transport would carry from one install to another: every entry and blob it wrote. */
interface Sent { entries: unknown[]; blobs: SealedBlob[] }

async function write(seat: Seat, sent: Sent, kind: string, data: Record<string, unknown>, options: { actor?: Actor; deps?: readonly string[] } = {}): Promise<string> {
  const result = await seat.p.appendOwn(kind, data, { actor: options.actor ?? PERSON, ...(options.deps === undefined ? {} : { deps: options.deps }) });
  assert.ok(!isProjectRefused(result), `${kind}: ${isProjectRefused(result) ? result.message : ''}`);
  sent.entries.push(result.built.entry);
  sent.blobs.push(...result.built.blobs);
  return result.hash;
}

/** The staff lead P founds a shared project (not migrated) and takes the section and decision roles a product needs. */
async function founded(label: string): Promise<Seat> {
  const env = await freshEnv(`${label}-lead`);
  const p = kept(await ReplicaProject.createSharedProject(env.root, env.deps, { name: NAME, profile: 'nato-ca', level: 'tactical', labelMapHash: 'c'.repeat(64), lead: { member: 'mbr-lead', name: LEAD_NAME } }));
  const host: SharedProjectHost = { project: p, deps: env.deps };
  done(await updateMember(host, { member: 'mbr-lead', name: LEAD_NAME, roles: ['member', 'section_lead:j5', `decision_for:${DECISION_ROLE}`], agentSeats: ['lead-planner', 'release-guard'] }), 'lead roles');
  return { env, p, host };
}

/** P writes the concept of operations as a live text, proposes it, the guard clears it and its owner submits it for the commander. */
async function submitted(lead: Seat, sent: Sent): Promise<{ hash: string; submit: string }> {
  const { roster } = await lead.p.state();
  const position = roster.positions.length - 1;
  const stream = lead.p.projectId;
  const epoch = epochAt(roster.cells, stream, position) as number;
  const key = lead.p.keys.epochKey(stream, epoch) as Buffer;
  const clientId = clientIdOf(deviceAt(roster.members, lead.p.deviceWriter, position)?.slot ?? 1, 0);
  await write(lead, sent, 'product.create', { product: CONOPS, section: 'j5', roles: { ...ROLES }, title: CONOPS });
  await write(lead, sent, 'doc.client', { product: CONOPS, clientId, actor: { kind: 'person' } });
  const doc = createLocalDoc(clientId);
  await write(lead, sent, 'doc.update', { product: CONOPS, update: Buffer.from(localInsert(doc, 0, CLEAN_BODY)).toString('base64url') });
  const hash = replicaVersionHash(CLEAN_BODY, []);
  const blob = sealBlob(key, stream, epoch, canonicalBytes({ text: CLEAN_BODY, header: HEADER }));
  assert.ok(!isProjectRefused(await lead.p.ingestForeign([], [blob])));
  sent.blobs.push(blob);
  await write(lead, sent, 'version.propose', { product: CONOPS, hash, textBlob: blob.hash, snapshot: Buffer.from(snapshotOf(doc)).toString('base64url'), pins: [] });
  await write(lead, sent, 'version.verdict', { product: CONOPS, hash, gate: 'guard', verdict: 'CLEARED', reasons: [] }, { actor: agent('release-guard') });
  const submit = await write(lead, sent, 'version.submit', { product: CONOPS, hash, decisionFor: DECISION_ROLE }, { actor: agent('lead-planner') });
  return { hash, submit };
}

/** The copier C joins P's project by invitation (holding the commander's decision role) and is given everything P wrote. */
async function joined(lead: Seat, label: string): Promise<Seat> {
  const env = await freshEnv(`${label}-copier`);
  const invited = done(await inviteToProject(lead.host, { name: COPIER.name, seat: 'j5-plans', roles: ['member', `decision_for:${DECISION_ROLE}`], clearance: OFFICIAL }), 'invite');
  const asked = done(await joinFromInvite(env.root, env.deps, invited.file?.text, { name: COPIER.name }), 'join');
  const admitted = done(await admitJoinRequest(lead.host, asked.file?.text, { codeMatched: true }), 'admit');
  const welcomed = done(await openWelcome(env.root, env.deps, admitted.file?.text), 'welcome');
  const p = kept(welcomed.project);
  return { env, p, host: { project: p, deps: env.deps } };
}

async function deliver(to: Seat, sent: Sent): Promise<void> {
  const result = await to.p.ingestForeign(sent.entries, sent.blobs);
  assert.ok(!isProjectRefused(result), isProjectRefused(result) ? result.message : '');
  assert.deepEqual(to.p.heldForCheck(), [], 'nothing is held by the decode check');
}

async function productOf(seat: Seat): Promise<ProductVersions> {
  const { fold } = await seat.p.state();
  const product = (fold.families.versions as ProductVersions[]).find((item) => item.product === CONOPS);
  assert.ok(product !== undefined, 'the product is in the fold');
  return product;
}

/** Every envelope of a ledger file in the copy: who signed each one. */
function signersOf(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { signer: { fingerprint: string } }).signer.fingerprint);
}

test('carried: P approved and released in the shared project; C\'s copy records both under C\'s key with the carried wording, and nothing is signed as P', async () => {
  const lead = await founded('carried');
  const sent: Sent = { entries: [], blobs: [] };
  const { hash } = await submitted(lead, sent);
  const approve = await write(lead, sent, 'version.decide', { product: CONOPS, hash, outcome: 'approve', reasons: [], decisionsSeen: [] });
  await write(lead, sent, 'version.release', { product: CONOPS, hash, decisionsSeen: [approve] });
  const copier = await joined(lead, 'carried');
  await deliver(copier, sent);
  const folded = await productOf(copier);
  assert.deepEqual(folded.refusals, [], 'the fold accepts every step');
  assert.equal(folded.records[0].release.state, 'released');

  const destination = path.join(copier.env.base, 'copy');
  const result = await copied(copier.env, destination);
  assert.equal(result.carried, 2, 'the approval and the release are carried');
  const replay = await hostAt(copier.env, destination).replay();
  assert.equal(replay.broken, undefined, 'the copy verifies with today\'s verifier and C\'s key alone');
  const state = replay.products.get(CONOPS) as ProductState;
  assert.equal(state.record.state, 'released');
  assert.deepEqual(state.approvedVersions, [1]);
  const people = state.history.filter((item) => item.actor.kind === 'person').map((item) => ({ event: item.event, actor: item.actor as PersonActor }));
  assert.deepEqual(people.map((item) => item.event), ['approve', 'release']);
  assert.equal(people[0].actor.name, carriedApprovalName(LEAD_NAME, COPIER.name));
  assert.equal(people[0].actor.name, 'P. Planner (approved in the shared project, carried by C. Copier)');
  assert.equal(people[1].actor.name, carriedApprovalName(LEAD_NAME, COPIER.name, 'released'));
  for (const item of people) {
    assert.equal(item.actor.deviceFingerprint, copier.env.signer.fingerprint, 'a carried step names the copier\'s device');
    assert.equal(item.actor.role, DECISION_ROLE);
  }
  assert.equal(state.record.approval?.by.kind, 'person');
  const signers = new Set(signersOf(path.join(destination, LEDGER_DIR, LEDGER_FILE)));
  assert.deepEqual([...signers], [copier.env.signer.fingerprint], 'every entry is signed by C, none by P');
  assert.notEqual(lead.env.signer.fingerprint, copier.env.signer.fingerprint);
});

test('contested: an approve and a reject made at the same time are never carried; the version stays awaiting decision with the contested note', async () => {
  const lead = await founded('contested');
  const sent: Sent = { entries: [], blobs: [] };
  const { hash, submit } = await submitted(lead, sent);
  const copier = await joined(lead, 'contested');
  await deliver(copier, sent);
  // C rejects having seen the submit; P approves without having seen C's reject: the two decisions are concurrent.
  const own: Sent = { entries: [], blobs: [] };
  await write(copier, own, 'version.decide', { product: CONOPS, hash, outcome: 'reject', reasons: ['The flank is not covered.'], decisionsSeen: [] }, { deps: [submit] });
  const later: Sent = { entries: [], blobs: [] };
  await write(lead, later, 'version.decide', { product: CONOPS, hash, outcome: 'approve', reasons: [], decisionsSeen: [] });
  await deliver(copier, later);
  const folded = await productOf(copier);
  assert.equal(folded.versions[0].decision.status, 'contested', 'the shared project holds a contested decision');

  const destination = path.join(copier.env.base, 'copy');
  const result = await copied(copier.env, destination);
  assert.deepEqual(result.contested, [`${CONOPS}@1`]);
  assert.equal(result.carried, 0, 'no decision is carried');
  const host = hostAt(copier.env, destination);
  const replay = await host.replay();
  assert.equal(replay.broken, undefined);
  const state = replay.products.get(CONOPS) as ProductState;
  assert.equal(state.record.state, 'awaiting-decision', 'the version stays undecided in the copy');
  assert.equal(state.record.approval, undefined);
  assert.deepEqual(state.approvedVersions, []);
  assert.ok(!state.history.some((item) => item.event === 'approve' || item.event === 'reject'), 'no decision is in the copy\'s history');
  assert.ok(state.request?.dissent[0]?.startsWith(`${CONTESTED_AT_COPY_TEXT}:`), `the open request carries the note (${state.request?.dissent.join(' | ')})`);
  assert.equal(CONTESTED_AT_COPY_TEXT, 'contested at copy time');
  assert.equal((await host.productState(CONOPS))?.state, 'awaiting-decision', 'the product file agrees with the copy\'s ledger');
});

test('a very long name is shortened so the carried name stays within 120 characters and still ends with the copier', () => {
  const long = carriedApprovalName('A'.repeat(300), 'C');
  assert.ok(long.length <= 120, `${long.length} characters`);
  assert.ok(long.endsWith(', carried by C)'));
  assert.ok(long.startsWith('AAAA'));
  assert.equal(carriedApprovalName('P', 'C'), 'P (approved in the shared project, carried by C)');
  // A copier with a very long name still leaves the carried name in front, and the whole fits.
  const both = carriedApprovalName('P. Planner', 'B'.repeat(300));
  assert.ok(both.length <= 120 && both.startsWith('P') && both.endsWith('B)'), both);
  // Line breaks and control characters never reach the one-line name field; a surrogate pair is never cut in half.
  assert.equal(carriedApprovalName('P.\nPlanner', 'C'), 'P. Planner (approved in the shared project, carried by C)');
  const emoji = carriedApprovalName('\u{1F600}'.repeat(100), 'C');
  assert.ok(emoji.length <= 120 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji));
});

/** A refusal that wrote nothing anywhere: every file under the env's base and every secret are as they were. */
async function refusedWithNothingWritten(env: Env, destination: string, expected: keyof typeof COPY_REFUSALS, root = env.root): Promise<void> {
  const filesBefore = tree(env.base);
  const secretsBefore = new Map(env.secrets.values);
  const result = await makeSingleMachineCopy(root, destination, env.deps) as CopyRefused;
  assert.equal(result.ok, false);
  assert.equal(result.refused, expected);
  assert.equal(result.message, COPY_REFUSALS[expected]);
  assert.ok(!/\u2014/.test(result.message), 'plain sentence, no em-dash');
  assert.deepEqual(tree(env.base), filesBefore, 'no file was written or changed');
  assert.deepEqual(new Map(env.secrets.values), secretsBefore, 'no secret was written');
}

test('a destination inside the shared project\'s replica folder, or anywhere in the shared project, is refused destination-inside-shared with nothing written', async () => {
  const env = await migrated('inside');
  await refusedWithNothingWritten(env, path.join(env.root, ...REPLICA_DIR.split('/'), 'copy'), 'destination-inside-shared');
  await refusedWithNothingWritten(env, path.join(env.root, 'copy'), 'destination-inside-shared');
  await refusedWithNothingWritten(env, env.root, 'destination-inside-shared');
});

test('a destination that already holds staff files is refused destination-has-staff-files with nothing written', async () => {
  const env = await migrated('has-staff');
  const destination = path.join(env.base, 'other');
  await mkdir(path.join(destination, '.planning', 'staff'), { recursive: true });
  writeFileSync(path.join(destination, '.planning', 'staff', 'note.md'), '# Someone else\'s staff file\n');
  await refusedWithNothingWritten(env, destination, 'destination-has-staff-files');
});

test('a folder that holds no shared project is refused not-shared with nothing written', async () => {
  const env = await freshEnv('not-shared');
  await releasedProduct(worldOf(env));
  await refusedWithNothingWritten(env, path.join(env.base, 'copy'), 'not-shared');
});

// ---- Task 3: the decision log, the calculator ledger and the wargame ledger -------------------------------------------------------------------------

const J4_TEAM: StaffTeamInfo = { slug: 'j4-logistics', section: 'j4', sectionLead: 'j4-director', members: ['j4-director', 'log-plans-officer', 'jloc-chief', 'release-guard'] };
const FUEL: PlanningFactor = { id: 'fuel-cargo-truck', what: 'Fuel for one cargo truck', rate: 250, unit: 'litres', per: 'vehicle per day', enteredBy: 'A. Demo' };
const FUEL_CALC = { id: 'fuel-phase-1', title: 'Class III (bulk) for phase 1', lines: [{ factor: 'fuel-cargo-truck', count: 40, item: 'cargo trucks' }], days: 3, onHand: 21000 };
const TURN = { coa: 'coa-a', enemyCoa: 'mlcoa', turn: 1, phase: 'action', hHourOffsetMinutes: 0, moves: [], results: [], decisionPoints: [] };
const OTHER_NAME = 'B. Other';
const wording = (text: string): string => createHash('sha256').update(text).digest('hex');

interface FourLedgers { readonly env: Env; readonly other: ReturnType<typeof fixedSigner>['signer'] }

/**
 * A single-machine project with all four ledgers made multi-user. The decision log holds a decision of this device's person and, after it, one of
 * another person signed on their own device (the log came to this computer with the project, and today's key status trusts both devices).
 */
let fourTemplate: Promise<FourLedgers> | undefined;
function fourLedgers(): Promise<FourLedgers> {
  fourTemplate ??= (async () => {
    const env = await freshEnv('four');
    const other = fixedSigner('copy-other-device').signer;
    const both: KeyTrust = (signer) => trusting(signer, other);
    const world = worldOf(env);
    world.host = hostAt(env, env.root, both);
    await releasedProduct(world);
    const mine = await world.host.signWatchDecision(world.person(), { watch: 'watch-bridge', decision: 'approved', wording: wording('watch the bridge'), reasons: [] });
    assert.ok(mine.ok, mine.ok ? '' : mine.message);
    const otherHost = new StaffHost({ root: env.root, signer: async () => other, keyStatus: async () => trusting(env.signer, other), now: () => Date.parse('2026-11-18T13:00:00.000Z') });
    const theirs = await otherHost.signWatchDecision({ kind: 'person', name: OTHER_NAME, role: DECISION_ROLE, deviceFingerprint: other.fingerprint }, { watch: 'watch-ford', decision: 'rejected', wording: wording('watch the ford'), reasons: ['The ford is out of range.'] });
    assert.ok(theirs.ok, theirs.ok ? '' : theirs.message);
    await writeFactors(env.root, [FUEL]);
    must(await callLogistics(world, J4_TEAM, 'calc_run', FUEL_CALC, 'log-plans-officer'), 'calc_run');
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__wargame', { action: 'record', phase: TURN }, 'plans-writer'), 'wargame');
    const deps = { ...env.deps, staffKeyStatus: async () => both(env.signer) };
    const result = await makeMultiUser(env.root, deps, { name: NAME });
    assert.ok(!isMigrationRefused(result), isMigrationRefused(result) ? result.message : '');
    return { env: { ...env, deps }, other };
  })();
  return fourTemplate;
}

let copyCounter = 0;
async function fourCopy(): Promise<{ four: FourLedgers; destination: string; result: CopyResult }> {
  const four = await fourLedgers();
  copyCounter += 1;
  const destination = path.join(four.env.base, `copy-${copyCounter}`);
  return { four, destination, result: await copied(four.env, destination) };
}

const signerOnly = (env: Env) => trusting(env.signer);

test('the decision log is re-signed by the copier, another person\'s decision carried under the copier\'s key, and replayPersonDecisions verifies it', async () => {
  const { four, destination, result } = await fourCopy();
  const file = path.join(destination, LEDGER_DIR, DECISION_LOG_FILE);
  assert.ok(result.written.includes(`${LEDGER_DIR}/${DECISION_LOG_FILE}`));
  const lines = ledgerLinesOf(readFileSync(file));
  const replay = replayPersonDecisions(lines, (envelope) => verifyPayload(envelope, { purpose: 'staff-decision', status: signerOnly(four.env) }));
  assert.equal(replay.broken, undefined, 'the copy\'s decision log verifies with the copier\'s key alone');
  assert.equal(replay.entries, 2);
  const bridge = replay.decisions.get('watch:watch-bridge');
  const ford = replay.decisions.get('watch:watch-ford');
  assert.equal(bridge?.person.name, 'A. Demo', 'this device\'s own person keeps their name');
  assert.equal(bridge?.decision, 'approved');
  assert.equal(ford?.person.name, carriedApprovalName(OTHER_NAME, COPIER.name, 'rejected'));
  assert.equal(ford?.person.name, 'B. Other (rejected in the shared project, carried by C. Copier)');
  assert.equal(ford?.person.deviceFingerprint, four.env.signer.fingerprint);
  assert.equal(ford?.decision, 'rejected');
  assert.deepEqual(ford?.reasons, ['The ford is out of range.']);
  assert.ok(signersOf(file).every((fingerprint) => fingerprint === four.env.signer.fingerprint), 'nothing in the copy is signed as the other person');
  assert.ok(!signersOf(file).includes(four.other.fingerprint));
  assert.equal(result.carried, 1, 'one decision is carried; every product step was this device\'s own');
});

test('the calculator ledger is re-signed by the copier and replayCalcLedger verifies it with the same records', async () => {
  const { four, destination } = await fourCopy();
  const shared = replayCalcLedger(ledgerLinesOf(readFileSync(path.join(four.env.root, LEDGER_DIR, CALC_LEDGER_FILE))), (envelope) => verifyPayload(envelope, { purpose: 'staff-ledger', status: signerOnly(four.env) }));
  assert.equal(shared.broken, undefined);
  const copy = replayCalcLedger(ledgerLinesOf(readFileSync(path.join(destination, LEDGER_DIR, CALC_LEDGER_FILE))), (envelope) => verifyPayload(envelope, { purpose: 'staff-ledger', status: signerOnly(four.env) }));
  assert.equal(copy.broken, undefined, 'the copy\'s calculator ledger verifies with today\'s function');
  assert.equal(copy.entries, shared.entries);
  const records = (replay: typeof copy) => [...replay.records.values()].map((entry) => ({ record: entry.record, kind: entry.kind, hash: entry.hash, member: entry.member, at: entry.at }));
  assert.deepEqual(records(copy), records(shared));
});

test('a host rooted at the copy gives the same PIR and watch decisions and wargame turns as the shared project, and the wargame lines are byte for byte the projection\'s', async () => {
  const { four, destination, result } = await fourCopy();
  const sharedHost = hostAt(four.env, four.env.root, (signer) => trusting(signer, four.other));
  const copyHost = hostAt(four.env, destination);
  const outcomes = (map: ReadonlyMap<string, { decision: string }>) => [...map.entries()].map(([key, entry]) => [key, entry.decision]).sort();
  const sharedDecisions = await sharedHost.pirDecisions();
  assert.equal(sharedDecisions.size, 2);
  assert.deepEqual(outcomes(await copyHost.pirDecisions()), outcomes(sharedDecisions));
  assert.deepEqual(await copyHost.wargameEntries(), await sharedHost.wargameEntries());
  assert.equal((await copyHost.wargameEntries()).length, 1);
  assert.deepEqual(readFileSync(path.join(destination, WARGAME_DIR, WARGAME_FILE)), readFileSync(path.join(four.env.root, WARGAME_DIR, WARGAME_FILE)));
  assert.equal((await copyHost.replay()).broken, undefined);
  assert.deepEqual(result.notices, multiUserNoticeLines());
  assert.deepEqual(result.left, []);
  assert.deepEqual(result.written, [
    `${LEDGER_DIR}/${CALC_LEDGER_FILE}`, `${LEDGER_DIR}/${DECISION_LOG_FILE}`, `${LEDGER_DIR}/${LEDGER_FILE}`, productPath('j5', CONOPS), `${WARGAME_DIR}/${WARGAME_FILE}`
  ].sort());
});
