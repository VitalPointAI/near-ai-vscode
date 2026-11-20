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
import { IMPORTED_PRODUCTS_LEDGER, importedFile, ledgerLinesOf, projectLedgerReplay, scopedImportsOf } from '../staff/replica/projection';
import { admitJoinRequest, cellOrderHook, inviteToProject, joinFromInvite, openWelcome, updateMember } from '../staff/replica/membership';
import { cellLabelTexts } from '../staff/replica/labelCells';
import type { MembershipResult, SharedProjectHost } from '../staff/replica/membership';
import { ReplicaProject, isProjectRefused } from '../staff/replica/replicaProject';
import type { ProjectRefused } from '../staff/replica/replicaProject';
import { CONTESTED_AT_COPY_TEXT, COPY_REFUSALS, NOT_CLEARED_PARTS_TEXT, carriedApprovalName, makeSingleMachineCopy, setCopyProbe } from '../staff/replica/singleCopy';
import type { CopyDeps, CopyProbe, CopyRefused, CopyResult } from '../staff/replica/singleCopy';
import { LEDGER_DIR, LEDGER_FILE, StaffHost, WARGAME_DIR, WARGAME_FILE, productPath } from '../staff/staffHost';
import type { StaffTeamInfo } from '../staff/staffHost';
import { callLogistics, callTool, CLEAN_BODY, hashIn, J5_TEAM, memorySecrets, trusting, writeBody, writeFactors } from './helpers/staffFixtures';
import { fixedSigner } from './helpers/replicaWorld';
import { bringIn, orgClearance, syncTo } from './helpers/labelCellWorld';
import type { Seat as CellSeat } from './helpers/labelCellWorld';
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
  // Labelled org/Public: Make Multi-User puts it into the org/Public cell, which the lead's declared clearance (org/Internal) covers (D-15, D-19).
  const hash = hashIn(must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: CONOPS, kind: 'plan', label: 'org/Public' }, 'lead-planner'), 'propose'));
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
  const result = await makeMultiUser(env.root, env.deps, { name: NAME , leadClearance: { scale: 'org', level: 'Internal', compartments: [], releasability: [] } });
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

// ---- 32-03 (D-07): the head mark is stored before the copy is put in place -----------------------------------------------------------------------

/** The staging folders a copy left beside .planning/staff in a destination. */
function stagingFolders(destination: string): string[] {
  const planning = path.join(destination, '.planning');
  return existsSync(planning) ? readdirSync(planning).filter((name) => name.startsWith('staff.copy-')).sort() : [];
}

/** Secret storage that refuses to store under one key and is otherwise the env's own. */
function refusingStoreUnder(env: Env, key: string): CopyDeps {
  const secrets = {
    get: (name: string) => env.secrets.get(name),
    delete: (name: string) => env.secrets.delete(name),
    store: async (name: string, value: string) => {
      if (name === key) throw new Error('The secret storage is locked.');
      await env.secrets.store(name, value);
    }
  };
  return { ...env.deps, secrets };
}

test('mark store fails: the copy is not put in place, its files stay in one staging folder, and no mark is stored', async () => {
  const env = await migrated('mark-store-fails');
  const destination = path.join(env.base, 'copy');
  await assert.rejects(makeSingleMachineCopy(env.root, destination, refusingStoreUnder(env, ledgerHeadKey(destination))), /The secret storage is locked\./);
  assert.equal(existsSync(path.join(destination, '.planning', 'staff')), false, 'a copy without its mark is never in place');
  const staging = stagingFolders(destination);
  assert.equal(staging.length, 1, `one staging folder holds the files (${staging.join(', ')})`);
  assert.ok(existsSync(path.join(destination, '.planning', staging[0], 'ledger', LEDGER_FILE)), 'the staged product ledger is kept');
  assert.equal(env.secrets.values.has(ledgerHeadKey(destination)), false, 'no mark is stored');
});

/** Runs a copy with the probe set, and always clears the probe again. */
async function withProbe<T>(probe: CopyProbe, run: () => Promise<T>): Promise<T> {
  setCopyProbe(probe);
  try {
    return await run();
  } finally {
    setCopyProbe(undefined);
  }
}

test('placing fails after the mark is stored: the copy fails with the folder-appeared error and the mark is taken back', async () => {
  const env = await migrated('place-fails');
  const destination = path.join(env.base, 'copy');
  let markAtProbe: string | undefined;
  await assert.rejects(withProbe(async (point, target) => {
    assert.equal(point, 'mark-stored');
    markAtProbe = env.secrets.values.get(ledgerHeadKey(target));
    // Another process makes .planning/staff between the mark and the rename.
    await mkdir(path.join(target, '.planning', 'staff'));
  }, () => makeSingleMachineCopy(env.root, destination, env.deps)), /a \.planning\/staff folder appeared in the destination/);
  assert.ok(markAtProbe !== undefined, 'the mark was stored before the copy was put in place');
  assert.equal(env.secrets.values.has(ledgerHeadKey(destination)), false, 'the mark names a copy that is not in place, so it is taken back');
  assert.equal(stagingFolders(destination).length, 1, 'the staging folder is kept');
});

test('compare before remove: a failed placing leaves a mark another run stored since in place', async () => {
  const env = await migrated('compare-remove');
  const destination = path.join(env.base, 'copy');
  const LATER = 'a later run\'s mark';
  await assert.rejects(withProbe(async (_point, target) => {
    await env.secrets.store(ledgerHeadKey(target), LATER);
    await mkdir(path.join(target, '.planning', 'staff'));
  }, () => makeSingleMachineCopy(env.root, destination, env.deps)), /a \.planning\/staff folder appeared in the destination/);
  assert.equal(env.secrets.values.get(ledgerHeadKey(destination)), LATER, 'the other run\'s mark is not removed');
});

test('the happy path stores the mark before the copy is in place: at the probe the mark is there and .planning/staff is not', async () => {
  const env = await migrated('order');
  const destination = path.join(env.base, 'copy');
  const seen: Array<{ point: string; placed: boolean; marked: boolean }> = [];
  const result = await withProbe((point, target) => {
    seen.push({ point, placed: existsSync(path.join(target, '.planning', 'staff')), marked: env.secrets.values.has(ledgerHeadKey(target)) });
  }, () => copied(env, destination));
  assert.deepEqual(seen, [{ point: 'mark-stored', placed: false, marked: true }]);
  assert.equal(result.destination, path.join(destination, '.planning', 'staff'));
  assert.deepEqual(stagingFolders(destination), [], 'the staging folder became .planning/staff');
  assert.equal((await hostAt(env, destination).replay()).broken, undefined);
});

/** The count and head a mark text names, when it verifies as this device's staff-ledger-head mark. */
function markOf(env: Env, text: string | undefined): unknown {
  assert.ok(text !== undefined, 'a mark is stored');
  const verdict = verifyPayload(JSON.parse(text) as unknown, { purpose: 'staff-ledger-head', status: trusting(env.signer) });
  assert.ok(verdict.ok, 'the mark verifies');
  return parseLedgerHeadMark(verdict.payload);
}

test('a stop between the mark and the rename leaves the mark and the staging folder and no staff project; copying again into the same folder succeeds', async () => {
  const env = await migrated('stopped');
  const destination = path.join(env.base, 'copy');
  const key = ledgerHeadKey(destination);
  // The probe throwing is the state a process stop at that point leaves: nothing after it runs.
  await assert.rejects(withProbe(() => { throw new Error('The process stopped here.'); }, () => makeSingleMachineCopy(env.root, destination, env.deps)), /The process stopped here\./);
  const stale = env.secrets.values.get(key);
  assert.ok(stale !== undefined, 'the mark is stored');
  const first = stagingFolders(destination);
  assert.equal(first.length, 1, 'the staging folder holds the files');
  assert.ok(existsSync(path.join(destination, '.planning', first[0], 'ledger', LEDGER_FILE)));
  assert.equal(existsSync(path.join(destination, '.planning', 'staff')), false, 'the destination does not read as a staff project');

  // Copying again, an hour later, into the same folder: nothing refuses it, its own mark replaces the stale one, and the copy replays without a break.
  const later = { ...env.deps, now: () => new Date('2026-11-20T11:00:00.000Z') };
  const result = await copied(env, destination, later);
  assert.equal(result.destination, path.join(destination, '.planning', 'staff'));
  const fresh = env.secrets.values.get(key);
  assert.notEqual(fresh, stale, 'the second run\'s mark replaces the stale one');
  const replay = await hostAt(env, destination).replay();
  assert.equal(replay.broken, undefined, 'today\'s host replays the copy without a break');
  assert.deepEqual(markOf(env, fresh), { v: 1, count: replay.entries, head: replay.head });
  assert.equal(env.secrets.values.get(key), fresh, 'the replay found the mark as the copy wrote it');
  assert.deepEqual(stagingFolders(destination), first, 'the first run\'s staging folder is kept, and the second run leaves none');
});

test('an older version\'s copy left without a mark is refused unmarked-copy with nothing written, and the sentence asks for a new, empty folder', async () => {
  const env = await migrated('unmarked');
  const destination = path.join(env.base, 'copy');
  await copied(env, destination);
  // An older version renamed the copy into place and stopped before it stored the mark.
  await env.secrets.delete(ledgerHeadKey(destination));
  await refusedWithNothingWritten(env, destination, 'unmarked-copy');
  assert.match(COPY_REFUSALS['unmarked-copy'], /Make the copy again into a new, empty folder\.$/);
});

test('a destination with staff files is refused destination-has-staff-files when its product ledger has its mark, or when it has no product ledger', async () => {
  const env = await migrated('marked-or-none');
  // A finished copy with its mark: not left unfinished, but not empty either.
  const finished = path.join(env.base, 'copy');
  await copied(env, finished);
  assert.ok(env.secrets.values.has(ledgerHeadKey(finished)));
  await refusedWithNothingWritten(env, finished, 'destination-has-staff-files');
  // Staff files with a ledger folder but no product ledger, and no mark: nothing names it a copy.
  const other = path.join(env.base, 'other');
  await mkdir(path.join(other, ...LEDGER_DIR.split('/')), { recursive: true });
  writeFileSync(path.join(other, LEDGER_DIR, 'events.jsonl'), '');
  await refusedWithNothingWritten(env, other, 'destination-has-staff-files');
});

test('every copy refusal is a plain sentence that ends by saying what to do next', () => {
  const NEXT = /^(Choose|Make|Open)\b/;
  for (const [reason, text] of Object.entries(COPY_REFUSALS)) {
    assert.equal(text.includes('\u2014'), false, `${reason}: no em-dash`);
    assert.match(text, /^The copy was not made, because /, reason);
    assert.ok(text.includes('Nothing was written.'), `${reason}: says nothing was written`);
    const sentences = text.split(/(?<=\.)\s+/);
    assert.match(sentences[sentences.length - 1], NEXT, `${reason}: ends with what to do next (${text})`);
  }
  assert.ok('unmarked-copy' in COPY_REFUSALS);
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
    const result = await makeMultiUser(env.root, deps, { name: NAME , leadClearance: { scale: 'org', level: 'Internal', compartments: [], releasability: [] } });
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

// ---- 32-11 (D-20, D-22, D-23): the copy carries every cell this device holds, and says plainly when parts were not copied ----------------------------

const ESTIMATE = 'estimate';
// A canary phrase only the org/Internal product's text holds: it must never reach a device below that cell.
const CANARY = 'Northwind ford crossing';
const ESTIMATE_BODY = `# Estimate\n\nThe ${CANARY} takes one battalion at a time.\n`;
const INTERNAL_CLEARANCE = orgClearance('Internal');

/** A labelled project made multi-user into label cells, its lead's open project as a label cell seat, and the cells by label. */
interface Labelled {
  readonly env: Env;
  readonly lead: CellSeat;
  readonly cells: { readonly base: string; readonly public: string; readonly internal: string };
}

/**
 * The lead converts a project with the concept of operations (org/Public, released), an estimate (org/Internal, draft, its text holding the canary),
 * a watch decision and a calculator record, the lead's declared clearance org/Internal (32-10).
 */
async function labelledProject(label: string): Promise<Labelled> {
  const env = await freshEnv(label);
  const world = worldOf(env);
  await releasedProduct(world);
  await writeBody(world.root, 'j5', ESTIMATE, ESTIMATE_BODY);
  must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: ESTIMATE, kind: 'estimate', label: 'org/Internal' }, 'lead-planner'), 'propose estimate');
  const watch = await world.host.signWatchDecision(world.person(), { watch: 'watch-bridge', decision: 'approved', wording: wording('watch the bridge'), reasons: [] });
  assert.ok(watch.ok, watch.ok ? '' : watch.message);
  await writeFactors(env.root, [FUEL]);
  must(await callLogistics(world, J4_TEAM, 'calc_run', FUEL_CALC, 'log-plans-officer'), 'calc_run');
  const result = await makeMultiUser(env.root, env.deps, { name: NAME, leadClearance: INTERNAL_CLEARANCE });
  assert.ok(!isMigrationRefused(result), isMigrationRefused(result) ? result.message : '');
  const now = env.deps.now as () => Date;
  const deps = { ...env.deps, cellOrder: cellOrderHook({ now }) };
  const p = kept(await ReplicaProject.open(env.root, deps));
  const lead: CellSeat = { at: { root: env.root, global: env.global, secrets: env.secrets as CellSeat['at']['secrets'], deps, clock: { now: now() } }, p, host: { project: p, deps }, member: `mbr-${p.deviceWriter.slice(0, 16)}`, writer: p.deviceWriter, results: [] };
  const byLabel = new Map([...(await cellLabelTexts(p))].map(([cell, text]) => [text, cell]));
  const cells = { base: p.projectId, public: byLabel.get('org/Public') as string, internal: byLabel.get('org/Internal') as string };
  assert.ok(cells.public !== undefined && cells.internal !== undefined, `the lead holds both label cells (${[...byLabel.keys()].join(', ')})`);
  return { env, lead, cells };
}

let labelledTemplate: Promise<Labelled> | undefined;
const labelled = (): Promise<Labelled> => (labelledTemplate ??= labelledProject('labelled'));

/** A member brought in with a declared clearance and given the base stream and the named cells' streams, and every grant of them on the lead's disk. */
async function member(world: Labelled, label: string, level: 'Public' | 'Internal', streams: readonly string[]): Promise<CellSeat> {
  const seat = await bringIn(world.lead, label, `M. Member ${label}`, orgClearance(level));
  await syncTo(world.lead, seat, [world.cells.base, ...streams]);
  return seat;
}

/** A copy made on a member's install, and today's host over it, signed by that member's device. */
async function memberCopy(seat: CellSeat): Promise<{ destination: string; result: CopyResult; host: StaffHost; signer: DeviceIdentity }> {
  const destination = path.join(path.dirname(seat.at.root), 'copy');
  const result = await makeSingleMachineCopy(seat.at.root, destination, { ...seat.at.deps, copier: COPIER });
  assert.ok(result.ok, result.ok ? '' : `the copy is made: ${result.message}`);
  const { signer } = await ReplicaProject.localDevice(seat.at.deps);
  const host = new StaffHost({ root: destination, signer: async () => signer, keyStatus: async () => trusting(signer), headStore: seat.at.secrets });
  return { destination, result, host, signer };
}

/** Every file of a copy's staff folder: its path from the destination and its text. */
function filesOf(destination: string): Array<[string, string]> {
  const root = path.join(destination, '.planning', 'staff');
  const out: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else out.push([path.relative(destination, file).split(path.sep).join('/'), readFileSync(file, 'utf8')]);
    }
  };
  walk(root);
  return out;
}

/** No file name or byte of the copy holds any of the words. */
function holdsNone(destination: string, words: readonly string[]): void {
  for (const [file, text] of filesOf(destination)) {
    for (const word of words) {
      assert.equal(file.includes(word), false, `the file name ${file} holds "${word}"`);
      assert.equal(text.includes(word), false, `${file} holds "${word}"`);
    }
  }
}

test('not cleared: a member cleared only for org/Public copies only the org/Public product, the copy says parts were not copied, and nothing of the other cell is in it', async () => {
  const world = await labelled();
  const m = await member(world, 'copy-public', 'Public', [world.cells.public]);
  const { destination, result, host } = await memberCopy(m);
  // Only the concept of operations, from the org/Public cell's import, with its history as the lead's projection shows it.
  const replay = await host.replay();
  assert.equal(replay.broken, undefined, 'the copy\'s product ledger verifies with today\'s verifier');
  assert.deepEqual([...replay.products.keys()], [CONOPS]);
  const lead = (await sharedReplay(world.env)).products.get(CONOPS) as ProductState;
  const state = replay.products.get(CONOPS) as ProductState;
  assert.equal(state.record.state, 'released');
  assert.equal(state.record.hash, lead.record.hash);
  assert.deepEqual(state.approvedVersions, lead.approvedVersions);
  assert.deepEqual(state.history.map((item) => item.event), lead.history.map((item) => item.event));
  assert.equal(result.carried, 2, 'the lead\'s approval and release are carried under the copier');
  assert.deepEqual(result.written, [`${LEDGER_DIR}/${LEDGER_FILE}`, productPath('j5', CONOPS)].sort(), 'no decision log, calculator or wargame ledger: their imports are in cells this member does not hold');
  assert.deepEqual(result.left, [], 'a ledger in a cell this member does not hold is not listed');
  // One fixed sentence after the D-13 lines: nothing about which parts, or how many.
  assert.deepEqual(result.notices, [...multiUserNoticeLines(), NOT_CLEARED_PARTS_TEXT]);
  assert.equal(NOT_CLEARED_PARTS_TEXT, 'Parts of this project you are not cleared for were not copied.');
  holdsNone(destination, [ESTIMATE, CANARY, 'org/Internal']);
  assert.ok(!JSON.stringify(result).includes(ESTIMATE) && !JSON.stringify(result).includes('org/Internal'), 'the result names nothing of the other cell');
});

test('not cleared: the lead holds every cell, so the lead\'s copy carries both products, the decision log and the calculator ledger, with no not-cleared notice', async () => {
  const world = await labelled();
  const destination = path.join(world.env.base, 'lead-copy');
  const result = await copied(world.env, destination);
  assert.deepEqual(result.notices, multiUserNoticeLines(), 'the lead\'s copy has no not-cleared notice');
  assert.ok(!result.notices.includes(NOT_CLEARED_PARTS_TEXT));
  assert.deepEqual(result.left, []);
  assert.deepEqual(result.written, [
    `${LEDGER_DIR}/${CALC_LEDGER_FILE}`, `${LEDGER_DIR}/${DECISION_LOG_FILE}`, `${LEDGER_DIR}/${LEDGER_FILE}`, productPath('j5', CONOPS), productPath('j5', ESTIMATE)
  ].sort());
  const replay = await hostAt(world.env, destination).replay();
  assert.equal(replay.broken, undefined);
  assert.deepEqual([...replay.products.keys()].sort(), [CONOPS, ESTIMATE].sort());
  assert.equal(replay.products.get(ESTIMATE)?.record.state, 'draft');
  assert.equal(replay.products.get(ESTIMATE)?.meta.label, 'org/Internal');
  assert.ok(readFileSync(path.join(destination, productPath('j5', ESTIMATE)), 'utf8').includes(CANARY), 'the lead\'s copy holds the estimate\'s text');
});

test('cell import: a member holding the org/Public and org/Internal cells but not the legacy cell carries both products from the two cell imports and the calculator ledger, not the decision log', async () => {
  const world = await labelled();
  const m = await member(world, 'copy-internal', 'Internal', [world.cells.public, world.cells.internal]);
  const { destination, result, host, signer } = await memberCopy(m);
  const replay = await host.replay();
  assert.equal(replay.broken, undefined, 'the copy verifies with today\'s verifier');
  assert.deepEqual([...replay.products.keys()].sort(), [CONOPS, ESTIMATE].sort());
  const lead = (await sharedReplay(world.env)).products;
  for (const name of [CONOPS, ESTIMATE]) {
    const state = replay.products.get(name) as ProductState;
    const shared = lead.get(name) as ProductState;
    assert.equal(state.record.state, shared.record.state, name);
    assert.equal(state.record.hash, shared.record.hash, name);
    assert.deepEqual(state.meta, shared.meta, name);
    assert.deepEqual(state.history.map((item) => [item.event, item.version]), shared.history.map((item) => [item.event, item.version]), `${name}: its imported history`);
  }
  // The approvals came from the lead's device: carried under the copier's name, as today.
  const people = (replay.products.get(CONOPS) as ProductState).history.filter((item) => item.actor.kind === 'person').map((item) => (item.actor as PersonActor).name);
  assert.deepEqual(people, [carriedApprovalName('A. Demo', COPIER.name), carriedApprovalName('A. Demo', COPIER.name, 'released')]);
  assert.equal(result.carried, 2);
  assert.deepEqual(result.written, [`${LEDGER_DIR}/${CALC_LEDGER_FILE}`, `${LEDGER_DIR}/${LEDGER_FILE}`, productPath('j5', CONOPS), productPath('j5', ESTIMATE)].sort(), 'the calculator ledger (org/Internal cell), not the decision log (legacy cell)');
  assert.deepEqual(result.left, [], 'the decision log, in a cell this member does not hold, is not listed as left');
  assert.deepEqual(result.notices, [...multiUserNoticeLines(), NOT_CLEARED_PARTS_TEXT], 'the legacy cell is not held');
  const calc = replayCalcLedger(ledgerLinesOf(readFileSync(path.join(destination, LEDGER_DIR, CALC_LEDGER_FILE))), (envelope) => verifyPayload(envelope, { purpose: 'staff-ledger', status: trusting(signer) }));
  assert.equal(calc.broken, undefined);
  assert.ok(readFileSync(path.join(destination, productPath('j5', ESTIMATE)), 'utf8').includes(CANARY));
});

test('cell import that does not verify: it is listed in left with today\'s reason, nothing of it is carried, and the copy still verifies', async () => {
  const world = await labelledProject('bad-import');
  // The lead writes a second products import into the org/Internal cell: the estimate's lines with one byte changed under a signature.
  const { fold } = await world.lead.p.state();
  const input = await projectionInputOf(world.lead.p, world.lead.at.deps);
  const good = scopedImportsOf(fold, IMPORTED_PRODUCTS_LEDGER).find((item) => item.stream === world.cells.internal);
  assert.ok(good !== undefined, 'the org/Internal cell has its products import');
  const bytes = importedFile(good.record, input.entries) as Buffer;
  const lines = bytes.toString('utf8').split('\n').filter(Boolean);
  const first = JSON.parse(lines[0]) as { payload: { at: string } };
  first.payload.at = '2026-11-18T11:59:59.000Z';
  const changed = [JSON.stringify(first), ...lines.slice(1)];
  const file = Buffer.from(`${changed.join('\n')}\n`, 'utf8');
  const written = await world.lead.p.appendOwn('project.import', { ledger: IMPORTED_PRODUCTS_LEDGER, legacyHead: 'e'.repeat(64), count: good.record.count, file: file.toString('base64url'), scope: 'cell', lines: changed.length }, { stream: world.cells.internal, actor: PERSON });
  assert.ok(!isProjectRefused(written), isProjectRefused(written) ? written.message : '');
  // And a third that verifies (the estimate's first line alone, unchanged) but is not the import the projection shows the estimate from: not read.
  const part = Buffer.from(`${lines[0]}\n`, 'utf8');
  const partial = await world.lead.p.appendOwn('project.import', { ledger: IMPORTED_PRODUCTS_LEDGER, legacyHead: 'd'.repeat(64), count: good.record.count, file: part.toString('base64url'), scope: 'cell', lines: 1 }, { stream: world.cells.internal, actor: PERSON });
  assert.ok(!isProjectRefused(partial), isProjectRefused(partial) ? partial.message : '');
  const m = await member(world, 'bad-import-m', 'Internal', [world.cells.public, world.cells.internal]);
  const { destination, result, host } = await memberCopy(m);
  assert.deepEqual(result.left, [{ ledger: IMPORTED_PRODUCTS_LEDGER, reason: 'its imported entries do not verify, so it was not carried' }]);
  assert.deepEqual(result.differs, [], 'no line is carried twice');
  const replay = await host.replay();
  assert.equal(replay.broken, undefined, 'the copy verifies with today\'s verifier');
  assert.deepEqual([...replay.products.keys()].sort(), [CONOPS, ESTIMATE].sort(), 'both products are still carried, from the imports that verify');
  const shared = (await sharedReplay(world.env)).products.get(ESTIMATE) as ProductState;
  assert.deepEqual((replay.products.get(ESTIMATE) as ProductState).history.map((item) => [item.event, item.version]), shared.history.map((item) => [item.event, item.version]), 'the estimate\'s history comes from its own import alone');
  assert.ok(!readFileSync(path.join(destination, LEDGER_DIR, LEDGER_FILE), 'utf8').includes('2026-11-18T11:59:59.000Z'), 'nothing of the changed import is carried');
  // The lead holds the whole product ledger, so the lead's copy reads it and never the cell imports.
  const leadCopy = await copied(world.env, path.join(world.env.base, 'lead-copy'));
  assert.deepEqual(leadCopy.left, []);
});

test('preview: a project whose products sit in the base cell (a 0.4.35 preview) is copied as before, with no not-cleared notice', async () => {
  const lead = await founded('preview');
  const sent: Sent = { entries: [], blobs: [] };
  const { hash } = await submitted(lead, sent);
  const approve = await write(lead, sent, 'version.decide', { product: CONOPS, hash, outcome: 'approve', reasons: [], decisionsSeen: [] });
  await write(lead, sent, 'version.release', { product: CONOPS, hash, decisionsSeen: [approve] });
  const copier = await joined(lead, 'preview');
  await deliver(copier, sent);
  const destination = path.join(copier.env.base, 'copy');
  const result = await copied(copier.env, destination);
  assert.deepEqual(result.notices, multiUserNoticeLines(), 'every cell of the project is held here, so no part is said to be missing');
  assert.deepEqual(result.left, []);
  assert.deepEqual(result.differs, []);
  assert.equal(result.carried, 2);
  assert.deepEqual(result.written, [`${LEDGER_DIR}/${LEDGER_FILE}`, productPath('j5', CONOPS)].sort());
  const replay = await hostAt(copier.env, destination).replay();
  assert.equal(replay.broken, undefined);
  assert.equal(replay.products.get(CONOPS)?.record.state, 'released');
  // The lead's own copy of the preview project: the same products, the same notices.
  const own = await copied(lead.env, path.join(lead.env.base, 'copy'));
  assert.deepEqual(own.notices, multiUserNoticeLines());
  assert.deepEqual(own.written, result.written);
});
