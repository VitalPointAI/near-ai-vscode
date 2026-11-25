// The shared project on the host (31-18, D-07, D-19, D-24, D-44, D-46): created on disk, reopened, folded with the real roster and this device's key
// ring through one long-lived context; joined from a welcome file on a second install; entries from outside checked by the decode worker first.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { MAX_GRANT_WRAPS, WRAP_BYTES, buildGrant, grantHash, newEpochKey, wrapEpochKey } from '../domain/replica/cellKeys';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, localInsert } from '../domain/replica/doc';
import { MAX_STRUCTS } from '../domain/replica/kindSchemas/doc';
import { buildInvite, buildJoinRequest, checkJoinRequest, inviteAnchor, joinSecretHash, newJoinSecret, readInvite } from '../domain/replica/invite';
import type { InvitePayload } from '../domain/replica/invite';
import { ORIGIN_ROSTER, rosterView } from '../domain/replica/roster';
import type { ProjectOutput } from '../domain/replica/projectFold';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { CLEARANCE_SELF_ASSERTED_TEXT, LABELS_NOT_ACCREDITATION_TEXT } from '../domain/gate/labels';
import { MULTI_USER_DECLARED_TEXT, REPLICA_DIR, REPLICA_PROJECT_FILE, SHARED_PROJECT_REFUSAL, multiUserNoticeLines } from '../domain/staff/multiUser';
import type { SecretStorageLike } from '../services/auth';
import { DEVICE_KEY_SECRET } from '../team/identity';
import { DecodeHost } from '../staff/replica/decodeHost';
import { ENCRYPTION_KEY_SECRET, EPOCH_KEY_SECRET_PREFIX } from '../staff/replica/keyring';
import { PROJECT_REFUSALS_HOST, ReplicaProject, genesisPinFile, isProjectRefused } from '../staff/replica/replicaProject';
import type { ProjectRefused, ReplicaProjectDeps } from '../staff/replica/replicaProject';
import { DEMO_CLEARANCE, INVITE_EXPIRES } from './helpers/replicaRosterWorld';
import { fixedSigner, updateData } from './helpers/replicaWorld';
import { buildEntry } from '../domain/replica/entry';
import { buildGrantPages, wrapsFor } from '../domain/replica/grantPages';
import { formatFor, wrapDeviceAt } from '../staff/replica/wrapPlan';

class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

const NOW = '2026-11-20T10:00:00.000Z';
const PRODUCT = 'intel-estimate';
const LABEL_MAP_HASH = 'c'.repeat(64);

interface Install { root: string; global: string; secrets: MemorySecrets; deps: ReplicaProjectDeps }

/** One install: its own project folder, global storage folder and secret storage. */
function install(label: string): Install {
  const base = mkdtempSync(path.join(tmpdir(), `near-ai-replica-project-${label}-`));
  const secrets = new MemorySecrets();
  const global = path.join(base, 'global');
  return { root: path.join(base, 'project'), global, secrets, deps: { secrets, globalStorageDir: global, now: () => new Date(NOW) } };
}

function project(value: ReplicaProject | ProjectRefused | undefined): ReplicaProject {
  assert.ok(value instanceof ReplicaProject, `the project opens (${isProjectRefused(value) ? value.refused : String(value)})`);
  return value;
}

async function created(at: Install): Promise<ReplicaProject> {
  return project(await ReplicaProject.createSharedProject(at.root, at.deps, {
    name: 'Exercise Northwind', profile: 'j2', level: 'official', labelMapHash: LABEL_MAP_HASH, lead: { member: 'mbr-lead', name: 'Lee Lead' }
  }));
}

function projectOutput(fold: { families: Record<string, unknown> }, stream: string): ProjectOutput[number] | undefined {
  return (fold.families.project as ProjectOutput).find((item) => item.stream === stream);
}

function productOf(fold: { families: Record<string, unknown> }): ProductTextOutput | undefined {
  return (fold.families.doc as ProductTextOutput[] | undefined)?.find((item) => item.product === PRODUCT);
}

// ---- Task 1: create, reopen, fold ------------------------------------------------------------------------------------------------------------------

/** The one roster.require the project wrote right after its genesis (Phase 33 D-08), so the roster line is origin, genesis, then it. */
async function armedHash(shared: ReplicaProject): Promise<string> {
  const armed = await shared.findOwnAll('roster.require', () => true);
  assert.equal(armed.length, 1, 'one roster.require, written right after the genesis (Phase 33 D-08)');
  return armed[0].hash;
}

/** The lead's name, written as the lead's first member.update right after roster.require (33-14), since the genesis names only the member id. */
async function namedHash(shared: ReplicaProject): Promise<string> {
  const named = await shared.findOwnAll('member.update', () => true);
  assert.equal(named.length, 1, 'one member.update naming the lead');
  return named[0].hash;
}

test('createSharedProject makes the device key, the encryption key, a base cell key, the founding grant and the genesis; pins it outside the project; project.json names the same genesis', async () => {
  const lead = install('create');
  const shared = await created(lead);
  assert.ok(lead.secrets.values.has(DEVICE_KEY_SECRET));
  assert.ok(lead.secrets.values.has(ENCRYPTION_KEY_SECRET));
  assert.ok(lead.secrets.values.has(EPOCH_KEY_SECRET_PREFIX + shared.projectId));
  // The pin is in global storage, outside the project folder.
  const pinFile = genesisPinFile(lead.global, shared.projectId);
  assert.ok(path.relative(lead.root, pinFile).startsWith('..'), 'the pin is outside the project');
  const pin = JSON.parse(readFileSync(pinFile, 'utf8')) as { v: number; anchor: { genesisHash: string; project: string } };
  assert.equal(pin.v, 1);
  assert.equal(pin.anchor.project, shared.projectId);
  assert.equal(pin.anchor.genesisHash, shared.anchor.genesisHash);
  const copy = JSON.parse(readFileSync(path.join(lead.root, ...REPLICA_PROJECT_FILE.split('/')), 'utf8')) as { anchor: { genesisHash: string } };
  assert.equal(copy.anchor.genesisHash, shared.anchor.genesisHash);
  // The store holds the genesis, in the base cell's stream, written by this device.
  assert.ok(existsSync(path.join(lead.root, ...REPLICA_DIR.split('/'), 'streams', shared.projectId, `${shared.deviceWriter}.jsonl`)));
  const { roster, fold } = await shared.state();
  assert.deepEqual(roster.positions, [ORIGIN_ROSTER, shared.anchor.genesisHash, await armedHash(shared), await namedHash(shared)], 'roster.require follows the genesis (Phase 33 D-08), then the lead\'s name (33-14)');
  assert.ok(fold.applied.includes(shared.anchor.genesisHash));
  assert.deepEqual(roster.refused, []);
});

test('open on the same folder folds origin then genesis, and the fold shows the project name and its lead', async () => {
  const lead = install('reopen');
  const first = await created(lead);
  const again = project(await ReplicaProject.open(lead.root, lead.deps));
  assert.equal(again.projectId, first.projectId);
  const { roster, fold } = await again.state();
  // The name the lead gave is the lead's first member.update (33-14): the genesis names only the member id.
  const [named] = await again.findOwnAll('member.update', () => true);
  assert.deepEqual(named?.data, { member: 'mbr-lead', name: 'Lee Lead', rosterPrev: await armedHash(again) });
  assert.deepEqual(roster.positions, [ORIGIN_ROSTER, first.anchor.genesisHash, await armedHash(again), await namedHash(again)], 'roster.require follows the genesis (Phase 33 D-08), then the lead\'s name');
  assert.equal(rosterView(roster).memberName('mbr-lead', await namedHash(again)), 'Lee Lead', 'everyone sees the lead by the name the lead gave');
  const output = projectOutput(fold, first.projectId);
  assert.equal(output?.name, 'Exercise Northwind');
  assert.equal(output?.profile, 'j2');
  assert.deepEqual(output?.lead, { member: 'mbr-lead', writer: first.deviceWriter });
  // The base cell's key came back from the cache in secret storage.
  assert.equal(again.keys.epochKey(first.projectId, 1)?.length, 32);
});

test('appendOwn doc.client then doc.update in the base cell: the fold shows the text attributed to this device and its member', async () => {
  const lead = install('append');
  const shared = await created(lead);
  const clientId = clientIdOf(1, 0);
  const client = await shared.appendOwn('doc.client', { product: PRODUCT, clientId, actor: { kind: 'person' } });
  assert.ok('ok' in client, 'doc.client is written');
  const update = await shared.appendOwn('doc.update', updateData(PRODUCT, localInsert(createLocalDoc(clientId), 0, 'Enemy holds the ridge.')));
  assert.ok('ok' in update, 'doc.update is written');
  const reopened = project(await ReplicaProject.open(lead.root, lead.deps));
  for (const view of [shared, reopened]) {
    const { fold } = await view.state();
    assert.deepEqual(fold.refused, []);
    assert.deepEqual(fold.held, []);
    assert.deepEqual(fold.rejected, []);
    const product = productOf(fold);
    assert.equal(product?.text, 'Enemy holds the ridge.');
    assert.deepEqual(product?.attribution.map((span) => [span.writer, span.member, span.clientId]), [[shared.deviceWriter, 'mbr-lead', clientId]]);
  }
});

test('one context object is reused: two state() calls with nothing new do not refold, and an own doc entry is appended without a refold', async () => {
  const lead = install('context');
  const shared = await created(lead);
  const first = await shared.state();
  const context = shared.context();
  const refolds = shared.refolds;
  const second = await shared.state();
  assert.equal(shared.context(), context, 'the same context object');
  assert.equal(shared.refolds, refolds, 'no refold');
  assert.equal(second.fold, first.fold, 'the same fold result');
  // A doc entry changes neither the roster, the key ring nor the blob set: the context stays and the fold appends.
  const clientId = clientIdOf(1, 0);
  assert.ok('ok' in await shared.appendOwn('doc.client', { product: PRODUCT, clientId, actor: { kind: 'person' } }));
  const third = await shared.state();
  assert.equal(shared.context(), context);
  assert.equal(shared.refolds, refolds);
  assert.equal(third.fold.applied.length, first.fold.applied.length + 1);
});

test('open returns undefined for a folder with no shared project and makes nothing; a project.json that disagrees with the pin is refused pin-mismatch, and one this computer never joined not-shared', async () => {
  const empty = install('empty');
  assert.equal(await ReplicaProject.open(empty.root, empty.deps), undefined);
  assert.equal(existsSync(empty.root), false, 'nothing was created');

  const lead = install('mismatch');
  const shared = await created(lead);
  const file = path.join(lead.root, ...REPLICA_PROJECT_FILE.split('/'));
  const original = readFileSync(file, 'utf8');
  const swapped = JSON.parse(original) as { v: 1; anchor: { genesisHash: string; project: string } };
  swapped.anchor.genesisHash = 'd'.repeat(64);
  writeFileSync(file, JSON.stringify(swapped));
  const refused = await ReplicaProject.open(lead.root, lead.deps);
  assert.deepEqual(refused, { refused: 'pin-mismatch', message: PROJECT_REFUSALS_HOST['pin-mismatch'] });

  // The same folder opened by another install that never joined: not-shared, and no pin is written for it.
  writeFileSync(file, original);
  const stranger = install('stranger');
  const notJoined = await ReplicaProject.open(lead.root, stranger.deps);
  assert.deepEqual(notJoined, { refused: 'not-shared', message: PROJECT_REFUSALS_HOST['not-shared'] });
  assert.equal(existsSync(genesisPinFile(stranger.global, shared.projectId)), false);
});

test('createSharedProject run again after a crash before project.json uses the genesis already stored instead of building a second (Pitfall 4)', async () => {
  const lead = install('retry');
  const first = await created(lead);
  rmSync(path.join(lead.root, ...REPLICA_PROJECT_FILE.split('/')));
  const second = await created(lead);
  assert.equal(second.projectId, first.projectId);
  assert.equal(second.anchor.genesisHash, first.anchor.genesisHash);
  const { roster, fold } = await second.state();
  assert.deepEqual(roster.positions, [ORIGIN_ROSTER, first.anchor.genesisHash, await armedHash(second), await namedHash(second)], 'roster.require follows the genesis once (Phase 33 D-08), then the lead\'s name (33-14)');
  assert.equal(fold.order.length, 3, 'one genesis, one roster.require (Phase 33 D-08) and one member.update naming the lead (33-14)');
  assert.equal((await second.findOwnAll('project.genesis', () => true)).length, 1, 'one genesis');
  // And once project.json is back, a third call returns the same project.
  const third = await created(lead);
  assert.equal(third.anchor.genesisHash, first.anchor.genesisHash);
});

// ---- Task 3: a second device joins from a welcome file; entries from outside pass the decode worker ---------------------------------------------

const INVITE = 'inv-jo';
const JOINER = 'mbr-jo';

interface Joined { lead: Install; joiner: Install; a: ReplicaProject; b: ReplicaProject; admit: string; invite: InvitePayload; welcomeText: string }

/**
 * The lead (install A) invites one person by file; the joining device (install B, its own folder, global storage and secrets) reads the invite, pins
 * its genesis and answers with a join request; A checks it, admits B's device at slot 2, grants B the base cell at the admission roster and builds a
 * welcome for B alone; B joins from the welcome text. Files travel as JSON text.
 */
async function joinScenario(decodeHost?: DecodeHost): Promise<Joined> {
  const lead = install('lead');
  const joiner = install('joiner');
  if (decodeHost !== undefined) joiner.deps.decodeHost = decodeHost;
  const a = await created(lead);
  const secret = newJoinSecret();
  const invited = await a.appendOwn('member.invite', { invite: INVITE, name: 'Jo Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(secret) });
  assert.ok('ok' in invited);
  const inviteText = JSON.stringify(buildInvite(a.signer, {
    genesisHash: a.anchor.genesisHash, project: a.projectId, name: 'Exercise Northwind', lead: { member: 'mbr-lead', x25519: a.anchor.lead.x25519 }, invite: INVITE, secret, expiresAt: INVITE_EXPIRES, now: new Date(NOW),
    // The project's required features, as the lead's invitation names them (33.2 D-03): the joining device then sends its post-quantum keys.
    requires: (await a.state()).roster.required
  }));
  // B's side: read the invite, pin its genesis, answer it.
  const read = readInvite(inviteText, new Date(NOW));
  assert.ok(read.ok);
  const pinned = await ReplicaProject.pinAnchor(joiner.deps, inviteAnchor(read.invite));
  assert.deepEqual(pinned, { ok: true, first: true });
  const device = await ReplicaProject.localDevice(joiner.deps);
  const requestText = JSON.stringify(buildJoinRequest(device.signer, read.invite, { name: 'Jo Analyst', x25519: device.x25519, now: new Date(NOW), ...(device.kem === undefined ? {} : { kem: device.kem }) }));
  // A's side: check the request, admit, grant, welcome.
  const checked = checkJoinRequest(requestText, { invite: read.invite, secret });
  assert.ok(checked.ok);
  const admitted = await a.appendOwn('member.admit', {
    member: JOINER, invite: INVITE, name: 'Jo Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, agentSeats: [],
    device: { writer: device.writer, publicKey: device.publicKey, x25519: checked.request.x25519, x25519Sig: checked.request.x25519Sig, slot: 2, ...(checked.request.kem === undefined ? {} : { kem: checked.request.kem }) }
  });
  assert.ok('ok' in admitted);
  const baseKey = a.keys.epochKey(a.projectId, 1) as Buffer;
  const grant = buildGrant(a.signer, {
    cell: a.projectId, epoch: 1, roster: admitted.hash, labelSealed: '',
    wraps: [{ writer: device.writer, wrap: wrapEpochKey({ cell: a.projectId, epoch: 1, writer: device.writer, recipient: device.x25519, epochKey: baseKey }) }]
  });
  assert.deepEqual(await a.putGrants([grant]), { ok: true, stored: 1, opened: 0 });
  const welcomeText = JSON.stringify(await a.welcomeFor(device.writer, [a.projectId]));
  const b = project(await ReplicaProject.joinFromWelcome(joiner.root, joiner.deps, welcomeText));
  return { lead, joiner, a, b, admit: admitted.hash, invite: read.invite, welcomeText };
}

test('a second device joins from a welcome file: its store holds the roster, its pin is the invite\'s genesis, its key ring opens the base cell, and it reaches the lead\'s roster head', async () => {
  const joined = await joinScenario();
  const { a, b, joiner } = joined;
  try {
    const leadState = await a.state();
    const joinerState = await b.state();
    assert.deepEqual(joinerState.roster.positions, leadState.roster.positions);
    assert.equal(joinerState.roster.positions[joinerState.roster.positions.length - 1], joined.admit);
    assert.deepEqual(joinerState.roster.refused, []);
    const view = rosterView(joinerState.roster);
    assert.equal(view.isAdmitted(b.deviceWriter, joined.admit), true);
    assert.equal(view.memberName(JOINER, joined.admit), 'Jo Analyst');
    assert.deepEqual(b.keys.epochKey(b.projectId, 1), a.keys.epochKey(a.projectId, 1));
    const pin = JSON.parse(readFileSync(genesisPinFile(joiner.global, b.projectId), 'utf8')) as { anchor: { genesisHash: string } };
    assert.equal(pin.anchor.genesisHash, joined.invite.genesisHash);
    const copy = JSON.parse(readFileSync(path.join(joiner.root, ...REPLICA_PROJECT_FILE.split('/')), 'utf8')) as { anchor: { genesisHash: string } };
    assert.equal(copy.anchor.genesisHash, joined.invite.genesisHash);
    // B's fold accepts the genesis too, and reopening B's folder gives the same line.
    assert.ok(joinerState.fold.applied.includes(joined.invite.genesisHash));
    const reopened = project(await ReplicaProject.open(joiner.root, joiner.deps));
    assert.deepEqual((await reopened.state()).roster.positions, leadState.roster.positions);
  } finally {
    await b.close();
  }
});

// One client group of `count` GC structs of length 1, then an empty delete set: an update Yjs would decode struct by struct.
function writeVaruint(out: Uint8Array, at: number, value: number): number {
  let rest = value;
  let next = at;
  while (rest > 127) { out[next] = 128 | (rest % 128); next += 1; rest = Math.floor(rest / 128); }
  out[next] = rest;
  return next + 1;
}
function gcProbe(count: number, client = 31): Uint8Array {
  const out = new Uint8Array(32 + 2 * count);
  let at = writeVaruint(out, 0, 1);
  at = writeVaruint(out, at, count);
  at = writeVaruint(out, at, client);
  at = writeVaruint(out, at, 0);
  for (let index = 0; index < count; index += 1) { out[at] = 0; out[at + 1] = 1; at += 2; }
  at = writeVaruint(out, at, 0);
  return out.slice(0, at);
}

test('entries from outside pass a real decode worker: an honest doc.update is applied, a hostile one over the struct limit is held, listed and kept out of the fold', async () => {
  const decodeHost = new DecodeHost();
  const joined = await joinScenario(decodeHost);
  const { a, b } = joined;
  try {
    const clientId = clientIdOf(1, 0);
    const client = await a.appendOwn('doc.client', { product: PRODUCT, clientId, actor: { kind: 'person' } });
    const update = await a.appendOwn('doc.update', updateData(PRODUCT, localInsert(createLocalDoc(clientId), 0, 'Enemy holds the ridge.')));
    assert.ok('ok' in client && 'ok' in update);
    assert.equal(decodeHost.starts, 0, 'joining from the welcome needed no decode (roster entries carry no update)');
    const honest = await b.ingestForeign([client.built.entry, update.built.entry], [...client.built.blobs, ...update.built.blobs]);
    assert.ok('ok' in honest, 'the honest entries are taken');
    assert.equal(honest.added, 2);
    assert.deepEqual(honest.held, []);
    assert.equal(decodeHost.starts, 1, 'the update went through the decode worker');
    const after = await b.state();
    assert.ok(after.fold.applied.includes(update.hash));
    assert.equal(productOf(after.fold)?.text, 'Enemy holds the ridge.');

    // A hostile update, sealed under the base key by an admitted writer: one struct over the cap. Its data moves to a sealed blob (it is larger
    // than an inline body), so the check opens the blob before asking the worker.
    const hostile = await a.appendOwn('doc.update', updateData(PRODUCT, gcProbe(MAX_STRUCTS + 1)));
    assert.ok('ok' in hostile);
    assert.equal(hostile.built.blobs.length, 1);
    const result = await b.ingestForeign([hostile.built.entry], hostile.built.blobs);
    assert.ok('ok' in result);
    assert.equal(result.added, 1);
    assert.equal(result.held.length, 1);
    assert.equal(result.held[0].hash, hostile.hash);
    assert.match(result.held[0].reason, /too-large/);
    assert.deepEqual(b.heldForCheck().map((item) => item.hash), [hostile.hash]);
    const folded = await b.state();
    assert.equal(folded.fold.order.includes(hostile.hash), false, 'the held entry never reaches the fold');
    assert.equal(folded.fold.held.some((item) => item.hash === hostile.hash), false);
    assert.equal(productOf(folded.fold)?.text, 'Enemy holds the ridge.');
    // Reopened, it is still held back.
    const reopened = project(await ReplicaProject.open(joined.joiner.root, joined.joiner.deps));
    assert.deepEqual(reopened.heldForCheck().map((item) => item.hash), [hostile.hash]);
    assert.equal((await reopened.state()).fold.order.includes(hostile.hash), false);
  } finally {
    await decodeHost.close();
  }
});

function treeHashes(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full); else out.set(full, createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

test('a welcome whose genesis differs from the pin is refused pin-mismatch and changes nothing on disk, before and after the join', async () => {
  // Another lead's project, with a welcome addressed to the same joining device.
  const joined = await joinScenario();
  const other = install('other-lead');
  const c = await created(other);
  const foreignWelcome = JSON.stringify(await c.welcomeFor(joined.b.deviceWriter, []));

  // Before the join: a fresh device that read the first project's invite, pinned it and made its keys (as answering the invite does).
  const fresh = install('fresh');
  await ReplicaProject.pinAnchor(fresh.deps, inviteAnchor(joined.invite));
  await ReplicaProject.localDevice(fresh.deps);
  const freshBefore = new Map([...treeHashes(fresh.root), ...treeHashes(fresh.global)]);
  const refused = await ReplicaProject.joinFromWelcome(fresh.root, fresh.deps, foreignWelcome, inviteAnchor(joined.invite));
  assert.equal(isProjectRefused(refused) ? refused.refused : 'opened', 'pin-mismatch');
  assert.deepEqual(new Map([...treeHashes(fresh.root), ...treeHashes(fresh.global)]), freshBefore);
  assert.equal(existsSync(fresh.root), false);
  // Without an anchor, the welcome names a project this computer never pinned: not-shared, and nothing written.
  const unpinned = await ReplicaProject.joinFromWelcome(fresh.root, fresh.deps, foreignWelcome);
  assert.equal(isProjectRefused(unpinned) ? unpinned.refused : 'opened', 'not-shared');
  assert.deepEqual(new Map([...treeHashes(fresh.root), ...treeHashes(fresh.global)]), freshBefore);

  // After the join: the joined device is offered the other project's welcome.
  const before = new Map([...treeHashes(joined.joiner.root), ...treeHashes(joined.joiner.global)]);
  const later = await joined.b.ingestWelcome(foreignWelcome);
  assert.equal(isProjectRefused(later) ? later.refused : 'taken', 'pin-mismatch');
  assert.deepEqual(new Map([...treeHashes(joined.joiner.root), ...treeHashes(joined.joiner.global)]), before);
  // The right welcome again is taken and adds nothing new.
  const again = await joined.b.ingestWelcome(joined.welcomeText);
  assert.ok(!isProjectRefused(again));
  assert.equal(again.added, 0);
  await joined.b.close();
});

test('MN-04: a grant to the most devices a project can hold is stored in the project folder and read back for the roster fold', async () => {
  const lead = install('big-grant');
  const a = await created(lead);
  const wraps = Array.from({ length: MAX_GRANT_WRAPS }, (_, index) => ({
    writer: createHash('sha256').update(`mn04/${index}`).digest('hex'),
    wrap: Buffer.concat([createHash('sha512').update(`mn04/wrap/${index}`).digest(), createHash('sha512').update(`mn04/more/${index}`).digest()]).subarray(0, WRAP_BYTES).toString('base64url')
  }));
  const big = buildGrant(a.signer, { cell: a.projectId, epoch: 1, roster: 'd'.repeat(64), labelSealed: '', wraps });
  const stored = await a.putGrants([big]);
  assert.ok(!isProjectRefused(stored));
  assert.equal(stored.stored, 1);
  const reopened = project(await ReplicaProject.open(lead.root, lead.deps));
  const { roster } = await reopened.state();
  assert.ok(roster.held.some((item) => item.hash === grantHash(big) && item.reason === 'missing-roster'), 'the store read the grant back and gave it to the roster fold');
  await reopened.close();
});

// ---- 31-REVIEW CR-02, MJ-07, MJ-08 --------------------------------------------------------------------------------------------------------------

test('CR-02: an entry claiming this device\'s writer id without its signature neither becomes its head nor blocks its next write', async () => {
  const lead = install('cr02');
  const shared = await created(lead);
  const intruder = fixedSigner('intruder');
  const fake = buildEntry({
    signer: intruder.signer, key: randomBytes(32), stream: shared.projectId, seq: 999, prev: shared.anchor.genesisHash, epoch: 1,
    body: { deps: [], roster: ORIGIN_ROSTER, lamport: 2, at: NOW, actor: { kind: 'person' }, kind: 'doc.update', data: {} }
  });
  const forged = { header: { ...fake.entry.header, writer: shared.deviceWriter }, body: fake.entry.body };
  const taken = await shared.ingestForeign([forged], []);
  assert.ok(!isProjectRefused(taken));
  assert.deepEqual([taken.added, taken.dropped], [0, 1], 'an unsigned entry naming this device is dropped');
  // Planted in this device's own file in the base cell, where the old store took it as the head.
  appendFileSync(path.join(lead.root, REPLICA_DIR, 'streams', shared.projectId, `${shared.deviceWriter}.jsonl`), `${JSON.stringify(forged)}\n`);
  const written = await shared.appendOwn('doc.client', { product: PRODUCT, clientId: clientIdOf(1, 0), actor: { kind: 'person' } });
  assert.ok('ok' in written, 'the next own entry is written');
  // seq 1 is the roster.require written right after the genesis (Phase 33 D-08) and seq 2 the lead's name (33-14); the forged entry at seq 999 is
  // not the head.
  assert.equal(written.built.entry.header.seq, 3);
  assert.equal(written.built.entry.header.prev, await namedHash(shared));
  const reopened = project(await ReplicaProject.open(lead.root, lead.deps));
  const { fold } = await reopened.state();
  assert.ok(fold.applied.includes(written.hash));
  await reopened.close();
});

test('MJ-07: an update whose key arrives later waits out of the fold, and the decode worker checks it when the key arrives', async () => {
  const decodeHost = new DecodeHost();
  const joined = await joinScenario(decodeHost);
  const { a, b } = joined;
  try {
    // The lead makes a cell whose founding grant is wrapped to itself and to B, the way a key really reaches B: B takes it only once the roster
    // entry that commits to the grant is folded (CR-01).
    const cell = randomBytes(16).toString('hex');
    const key = newEpochKey();
    // The wraps go through the one entry point in the format the project needs (33.2-06: it started switched, so a new cell's key is cell-wrap/v2),
    // to each device's keys as the roster names them.
    const { roster } = await a.state();
    const at = roster.positionOf.get(joined.admit) as number;
    const choice = formatFor(roster, { base: false }, undefined);
    assert.equal(choice, 2);
    const { wraps } = wrapsFor({ format: 2, cell, epoch: 1, epochKey: key, devices: [wrapDeviceAt(roster, a.deviceWriter, at), wrapDeviceAt(roster, b.deviceWriter, at)] });
    assert.equal(wraps.length, 2);
    const [founding] = buildGrantPages(a.signer, { cell, epoch: 1, roster: joined.admit, labelSealed: '', wraps });
    await a.keys.addOwn(cell, 1, key, grantHash(founding));
    assert.ok(!isProjectRefused(await a.putGrants([founding])));
    const create = await a.appendOwn('cell.create', { cell, epoch: 1, grant: grantHash(founding) }, { roster: joined.admit });
    assert.ok('ok' in create, 'the cell is created');
    const hostile = await a.appendOwn('doc.update', updateData(PRODUCT, gcProbe(MAX_STRUCTS + 1)), { stream: cell });
    assert.ok('ok' in hostile, 'the lead writes in the new cell');

    const result = await b.ingestForeign([hostile.built.entry], hostile.built.blobs);
    assert.ok(!isProjectRefused(result));
    assert.deepEqual(result.held, []);
    assert.deepEqual(result.waiting, [{ hash: hostile.hash, reason: 'awaiting-key' }]);
    assert.equal(decodeHost.starts, 0, 'nothing could be checked yet');
    assert.equal((await b.state()).fold.order.includes(hostile.hash), false);
    // The grant alone is not the key: the roster B holds has not committed to it, so the entry keeps waiting and nothing is decoded.
    const unplaced = await b.putGrants([founding]);
    assert.deepEqual(unplaced, { ok: true, stored: 1, opened: 0 });
    assert.equal(b.keys.holds(cell, 1), false);
    assert.deepEqual(b.heldForCheck(), []);
    assert.equal(decodeHost.starts, 0, 'a grant the roster did not place decides no key and runs no check');
    assert.equal((await b.state()).fold.order.includes(hostile.hash), false);
    // The roster entry that commits to the grant arrives: the roster fold places the grant, the ring settles its key, and the waiting entry is checked.
    const committed = await b.ingestForeign([create.built.entry], create.built.blobs);
    assert.ok(!isProjectRefused(committed));
    const after = await b.state();
    assert.deepEqual(b.keys.epochKey(cell, 1), key, 'the key the committed grant carries');
    assert.equal(decodeHost.starts, 1, 'the worker ran when the key arrived');
    assert.deepEqual(b.heldForCheck().map((item) => item.hash), [hostile.hash]);
    assert.match(b.heldForCheck()[0].reason, /too-large/);
    assert.equal(after.fold.order.includes(hostile.hash), false, 'the held entry never reaches the fold');
    assert.equal(after.fold.held.some((item) => item.hash === hostile.hash), false);
  } finally {
    await joined.b.close();
    await decodeHost.close();
  }
});

test('MJ-07: an update whose blob arrives later waits out of the fold, and the decode worker checks it when the blob arrives', async () => {
  const decodeHost = new DecodeHost();
  const joined = await joinScenario(decodeHost);
  const { a, b } = joined;
  try {
    const hostile = await a.appendOwn('doc.update', updateData(PRODUCT, gcProbe(MAX_STRUCTS + 1)));
    assert.ok('ok' in hostile);
    assert.equal(hostile.built.blobs.length, 1);
    const result = await b.ingestForeign([hostile.built.entry], []);
    assert.ok(!isProjectRefused(result));
    assert.deepEqual(result.waiting, [{ hash: hostile.hash, reason: 'awaiting-blob' }]);
    assert.equal((await b.state()).fold.order.includes(hostile.hash), false);
    assert.equal(decodeHost.starts, 0);
    const blob = await b.ingestForeign([], hostile.built.blobs);
    assert.ok(!isProjectRefused(blob));
    assert.equal(blob.blobsAdded, 1);
    const after = await b.state();
    assert.equal(decodeHost.starts, 1, 'the worker ran when the blob arrived');
    assert.deepEqual(b.heldForCheck().map((item) => item.hash), [hostile.hash]);
    assert.equal(after.fold.order.includes(hostile.hash), false);
  } finally {
    await joined.b.close();
    await decodeHost.close();
  }
});

test('MJ-08: startHistoryAgain sets a rolled-back store aside, keeps project.json so the folder stays shared, and the lead\'s project opens with its own history', async () => {
  const lead = install('start-again');
  const shared = await created(lead);
  const client = await shared.appendOwn('doc.client', { product: PRODUCT, clientId: clientIdOf(1, 0), actor: { kind: 'person' } });
  assert.ok('ok' in client);
  await shared.state();
  await shared.close();
  assert.equal(await ReplicaProject.startHistoryAgain(install('none').root, lead.deps), undefined, 'a folder with no shared project');
  const notNeeded = await ReplicaProject.startHistoryAgain(lead.root, lead.deps);
  assert.equal(isProjectRefused(notNeeded) ? notNeeded.store : 'started', 'not-needed');
  // The base cell file loses its last line: rolled back.
  const file = path.join(lead.root, REPLICA_DIR, 'streams', shared.projectId, `${shared.deviceWriter}.jsonl`);
  writeFileSync(file, `${readFileSync(file, 'utf8').split('\n')[0]}\n`);
  const refused = await ReplicaProject.open(lead.root, lead.deps);
  assert.equal(isProjectRefused(refused) ? refused.store : 'opened', 'rolled-back');
  const started = await ReplicaProject.startHistoryAgain(lead.root, lead.deps);
  assert.ok(started !== undefined && !isProjectRefused(started));
  assert.equal(started.carried, 1, 'the genesis line that is still there');
  assert.ok(started.setAside !== null, 'the store folder was there, so it was set aside');
  assert.ok(existsSync(path.join(lead.root, started.setAside, 'project.json')), 'the old folder is set aside whole');
  assert.ok(existsSync(path.join(lead.root, ...REPLICA_PROJECT_FILE.split('/'))), 'the folder is still a shared project');
  const reopened = project(await ReplicaProject.open(lead.root, lead.deps));
  const { roster } = await reopened.state();
  assert.deepEqual(roster.positions, [ORIGIN_ROSTER, shared.anchor.genesisHash]);
  await reopened.close();
});

// ---- Task 4: the notices every multi-user result shows ------------------------------------------------------------------------------------------

test('multiUserNoticeLines gives the two label notices and the declared-people sentence in that order, with no em-dash; the refusal texts are plain (the setting\'s name is checked in staffMultiUserManifest)', () => {
  assert.deepEqual(multiUserNoticeLines(), [CLEARANCE_SELF_ASSERTED_TEXT, LABELS_NOT_ACCREDITATION_TEXT, MULTI_USER_DECLARED_TEXT]);
  // The third line's load-bearing phrases: who declared the people, and that nobody checked them.
  assert.match(multiUserNoticeLines()[2], /declared by the staff lead/);
  assert.match(multiUserNoticeLines()[2], /not verified/);
  // A fresh array each time, so a caller cannot change what the next result shows.
  multiUserNoticeLines().push('changed');
  assert.equal(multiUserNoticeLines().length, 3);
  for (const text of [...multiUserNoticeLines(), SHARED_PROJECT_REFUSAL, ...Object.values(PROJECT_REFUSALS_HOST)]) assert.doesNotMatch(text, /\u2014/);
  assert.match(SHARED_PROJECT_REFUSAL, /Make a Single-Machine Copy/);
});
