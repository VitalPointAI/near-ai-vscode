// The label leak test on real installs (plan 32-13; 32-CONTEXT D-15, D-16, D-23, D-24). Two compartments of one level: cell A {org, Confidential,
// [KESTREL]} and cell B {org, Confidential, [OSPREY]}. The lead is declared cleared for both; member X for A only (admitted before the cells exist)
// and member Y for B only (admitted after). Cells and products are made through ensureLabelCell, appendProductEntry and proposeVersion, the paths
// the real flows use. Canaries (a product name, its title, a phrase of its text, its label token and a decision reason) are searched byte for byte,
// as UTF-8 and as base64 and base64url at each of the three byte offsets, everywhere a member below a cell can look; positive controls show the same
// search finds them where they belong. Fictional exercise data only.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { readGrant } from '../domain/replica/cellKeys';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, docText, localInsert, snapshotOf } from '../domain/replica/doc';
import { entryHash, openBlob, openBody } from '../domain/replica/entry';
import type { SealedBlob, SealedEntry } from '../domain/replica/entry';
import type { Label } from '../domain/gate/labels';
import { baseCellAllows } from '../domain/replica/productCells';
import { rosterView } from '../domain/replica/roster';
import { epochsAt } from '../domain/replica/rosterCells';
import { REPLICA_DIR } from '../domain/staff/multiUser';
import { appendProductEntry, ensureLabelCell, proposeVersion } from '../staff/replica/labelCells';
import { isProjectRefused } from '../staff/replica/replicaProject';
import { makeSingleMachineCopy } from '../staff/replica/singleCopy';
import { StaffHost } from '../staff/staffHost';
import type { StaffCaller } from '../staff/staffHost';
import { bringIn, grantsOn, leadWith, streamEntries, syncTo } from './helpers/labelCellWorld';
import type { Seat } from './helpers/labelCellWorld';
import { J4_TEAM, trusting } from './helpers/staffFixtures';

// ---- the scene -------------------------------------------------------------------------------------------------------------------------------------

const ROLES = { owner: 'j4-planner', sectionLead: 'j4-lead', releaseGuard: 'j4-guard' };

const clearance = (level: 'Confidential' | 'Restricted', compartments: string[]): { scale: string; level: string; compartments: string[]; releasability: string[] } =>
  ({ scale: 'org', level, compartments, releasability: [] });
const labelOf = (compartment: string): Label => ({ scale: 'org', level: 'Confidential', compartments: [compartment], releasability: [], handling: [] });

/** What one cell holds, and the words that must never reach a device below it. */
interface CellPlan {
  readonly token: string;
  readonly product: string;
  readonly title: string;
  readonly text: string;
  readonly reason: string;
}

const PLAN_A: CellPlan = {
  token: 'KESTREL',
  product: 'kestrel-ridge-estimate',
  title: 'Kestrel ridge estimate',
  text: 'Watchers hold the northern ridge',
  reason: 'Kestrel sourcing is thin'
};
const PLAN_B: CellPlan = {
  token: 'OSPREY',
  product: 'osprey-harbour-plan',
  title: 'Osprey harbour plan',
  text: 'Small boats gather in the eastern harbour',
  reason: 'Osprey tide tables are stale'
};

interface Written { cell: string; plan: CellPlan; version: string }

interface Scene { lead: Seat; x: Seat; y: Seat; a: Written; b: Written }

/** One product in a cell: product.create, the person's client id, the text, a version whose header carries the cell's label, and a withdraw with a reason. */
async function writeCell(lead: Seat, cell: string, plan: CellPlan, counter: number): Promise<Written> {
  const label = labelOf(plan.token);
  const created = await appendProductEntry(lead.host, 'product.create', { product: plan.product, section: 'j4', roles: { ...ROLES }, title: plan.title }, { label });
  assert.ok(created.ok, created.ok ? '' : created.message);
  assert.equal(created.stream, cell, `${plan.product} is written into the cell for its label`);
  const { roster } = await lead.p.state();
  const slot = roster.members.devices.get(lead.p.deviceWriter)?.[0]?.slot ?? 1;
  const clientId = clientIdOf(slot, counter);
  const client = await appendProductEntry(lead.host, 'doc.client', { product: plan.product, clientId, actor: { kind: 'person' } });
  assert.ok(client.ok, client.ok ? '' : client.message);
  const doc = createLocalDoc(clientId);
  const update = Buffer.from(localInsert(doc, 0, `${plan.text}.`)).toString('base64url');
  const text = await appendProductEntry(lead.host, 'doc.update', { product: plan.product, update });
  assert.ok(text.ok, text.ok ? '' : text.message);
  const proposed = await proposeVersion(lead.host, {
    product: plan.product, text: docText(doc), pins: [], snapshot: snapshotOf(doc),
    header: { kind: 'estimate', label: `org/Confidential//${plan.token}`, profile: 'j4', level: 'official' }
  });
  assert.ok(proposed.ok, proposed.ok ? '' : proposed.message);
  assert.equal(proposed.stream, cell);
  const withdrawn = await appendProductEntry(lead.host, 'version.withdraw', { product: plan.product, hash: proposed.version, reason: plan.reason, decisionsSeen: [] }, { deps: [proposed.hash] });
  assert.ok(withdrawn.ok, withdrawn.ok ? '' : withdrawn.message);
  return { cell, plan, version: proposed.version };
}

/**
 * The lead declares {org, Restricted, [KESTREL, OSPREY]}; X ({org, Confidential, [KESTREL]}) is admitted; the lead makes A and B; Y ({org,
 * Confidential, [OSPREY]}) is admitted after; then each cell gets its product.
 */
async function buildScene(): Promise<Scene> {
  const lead = await leadWith({ clearance: clearance('Restricted', ['KESTREL', 'OSPREY']) });
  const x = await bringIn(lead, 'x', 'Xan Analyst', clearance('Confidential', ['KESTREL']));
  const a = await ensureLabelCell(lead.host, labelOf('KESTREL'));
  assert.ok(a.ok, a.ok ? '' : a.message);
  assert.deepEqual(a.granted, [x.writer], 'X, cleared for KESTREL, is given A when it is made');
  const b = await ensureLabelCell(lead.host, labelOf('OSPREY'));
  assert.ok(b.ok, b.ok ? '' : b.message);
  assert.deepEqual(b.granted, [], 'nobody but the lead is cleared for OSPREY when B is made');
  const y = await bringIn(lead, 'y', 'Yan Planner', clearance('Confidential', ['OSPREY']));
  const writtenA = await writeCell(lead, a.cell, PLAN_A, 1);
  const writtenB = await writeCell(lead, b.cell, PLAN_B, 2);
  return { lead, x, y, a: writtenA, b: writtenB };
}

let built: Promise<Scene> | undefined;
const scene = (): Promise<Scene> => (built ??= buildScene());

// ---- reading grants and welcome files --------------------------------------------------------------------------------------------------------------

interface ReadGrant { cell: string; epoch: number; writers: string[]; signed: unknown }

function readGrants(signed: readonly unknown[]): ReadGrant[] {
  return signed.map((item) => {
    const read = readGrant(item);
    assert.ok(read.ok, 'the grant reads');
    return { cell: read.grant.cell, epoch: read.grant.epoch, writers: read.grant.wraps.map((wrap) => wrap.writer), signed: item };
  });
}

/** The grants on an install's disk, read. */
const diskGrants = (seat: Seat): ReadGrant[] => readGrants(grantsOn(seat.at).map((item) => item.signed));

/** The grants in the welcome file the lead returned when it admitted the seat. */
function welcomeGrants(seat: Seat): ReadGrant[] {
  const file = seat.results[2]?.file;
  assert.ok(file !== undefined, 'the admission carries the welcome file');
  const welcome = JSON.parse(file.text) as { grants?: unknown[] };
  return readGrants(welcome.grants ?? []);
}

/** Every epoch of a cell at the head of a seat's roster (the lead's, which knows every epoch). */
async function epochsOf(seat: Seat, cell: string): Promise<number[]> {
  const { roster } = await seat.p.state();
  return epochsAt(roster.cells, cell, roster.positions.length - 1).map((item) => item.epoch);
}

/** The grant path for one member: base and own cell by syncTo, then every grant on the lead's disk that wraps the member's device. */
async function deliverOwn(lead: Seat, member: Seat, own: string): Promise<void> {
  await syncTo(lead, member, [own]);
  const forMember = diskGrants(lead).filter((grant) => grant.writers.includes(member.writer)).map((grant) => grant.signed);
  await member.p.putGrants(forMember);
}

async function assertBelow(s: Scene, member: Seat, below: Written, own: Written): Promise<void> {
  const name = below.plan.token;
  for (const grant of welcomeGrants(member)) assert.notEqual(grant.cell, below.cell, `the welcome file holds no grant of the ${name} cell`);
  const ofBelow = diskGrants(s.lead).filter((grant) => grant.cell === below.cell);
  assert.ok(ofBelow.length > 0, `the lead's disk holds the ${name} cell's grants`);
  for (const grant of ofBelow) assert.ok(!grant.writers.includes(member.writer), `no grant of the ${name} cell wraps the member's device`);
  await deliverOwn(s.lead, member, own.cell);
  const epochs = await epochsOf(s.lead, below.cell);
  assert.ok(epochs.length > 0);
  for (const epoch of epochs) assert.equal(member.p.keys.epochKey(below.cell, epoch), undefined, `no key of the ${name} cell, epoch ${epoch}`);
  for (const epoch of await epochsOf(s.lead, own.cell)) assert.ok(member.p.keys.epochKey(own.cell, epoch) !== undefined, `the member holds its own cell, epoch ${epoch}`);
  const { roster } = await member.p.state();
  const head = roster.positions[roster.positions.length - 1];
  assert.equal(rosterView(roster).cellGrantees?.(below.cell, head), undefined, `the member's roster says nothing of who holds the ${name} cell`);
  for (const grant of diskGrants(member)) assert.notEqual(grant.cell, below.cell, `the member's disk holds no grant of the ${name} cell`);
}

// ---- Task 1: the grant path ------------------------------------------------------------------------------------------------------------------------

test('Y never receives cell A: no grant, wrap or welcome file of A reaches Y, and after the grant path Y holds B\'s key and no key of A', async () => {
  const s = await scene();
  await assertBelow(s, s.y, s.a, s.b);
});

test('X never receives cell B: no grant, wrap or welcome file of B reaches X, and after the grant path X holds A\'s key and no key of B', async () => {
  const s = await scene();
  await assertBelow(s, s.x, s.b, s.a);
});

// ---- the byte search -------------------------------------------------------------------------------------------------------------------------------

/** The canaries of a cell, by what they are. */
function canariesOf(plan: CellPlan, kinds: readonly string[] = ['name', 'title', 'text', 'token', 'reason']): Array<{ what: string; value: string }> {
  const all: Record<string, string> = { name: plan.product, title: plan.title, text: plan.text, token: plan.token, reason: plan.reason };
  return kinds.map((what) => ({ what: `${plan.token} ${what}`, value: all[what] }));
}

/**
 * The forms a canary takes in bytes: its UTF-8, and its base64 and base64url encodings at each of the three byte offsets it can start at inside a
 * longer encoded value (only the characters fully decided by the canary's own bytes are kept, so the form matches wherever the canary sits).
 */
function formsOf(value: string): Buffer[] {
  const bytes = Buffer.from(value, 'utf8');
  const forms = [bytes];
  for (const encoding of ['base64', 'base64url'] as const) {
    for (let offset = 0; offset < 3; offset += 1) {
      const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString(encoding).replace(/=+$/, '');
      const first = Math.ceil((8 * offset) / 6);
      const last = Math.floor((8 * (offset + bytes.length) - 6) / 6);
      forms.push(Buffer.from(encoded.slice(first, last + 1), 'ascii'));
    }
  }
  return forms;
}

/** The canaries found in some bytes, by what they are. */
function found(bytes: Buffer, canaries: ReadonlyArray<{ what: string; value: string }>): string[] {
  return canaries.filter((canary) => formsOf(canary.value).some((form) => bytes.includes(form))).map((canary) => canary.what);
}

/** Every file under a folder (recursing), by path from the folder, with its bytes. A folder that does not exist has none. */
function filesUnder(dir: string): Array<{ name: string; bytes: Buffer }> {
  const out: Array<{ name: string; bytes: Buffer }> = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const file = path.join(at, name);
      if (statSync(file).isDirectory()) walk(file);
      else out.push({ name: path.relative(dir, file), bytes: readFileSync(file) });
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** The canaries found in every file name and every byte under a folder, each with the file it was found in. */
function foundInTree(dir: string, canaries: ReadonlyArray<{ what: string; value: string }>): string[] {
  const files = filesUnder(dir);
  assert.ok(files.length > 0, `${dir} holds files to search`);
  return files.flatMap((file) => found(Buffer.concat([Buffer.from(file.name, 'utf8'), Buffer.from('\n'), file.bytes]), canaries).map((what) => `${what} in ${file.name}`));
}

/** A value as text, Maps, Sets and byte arrays included. */
function asText(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Map) return [...item.entries()];
    if (item instanceof Set) return [...item.values()];
    if (item instanceof Uint8Array) return Buffer.from(item).toString('base64url');
    return item;
  });
}

// ---- what a member can look at ---------------------------------------------------------------------------------------------------------------------

const storeDir = (seat: Seat): string => path.join(seat.at.root, ...REPLICA_DIR.split('/'));

/** Every blob in an install's store, read from disk. */
function blobsOn(seat: Seat): SealedBlob[] {
  const dir = path.join(storeDir(seat), 'blobs');
  return existsSync(dir) ? readdirSync(dir).sort().map((hash) => ({ hash, bytes: readFileSync(path.join(dir, hash)).toString('base64url') })) : [];
}

/** Every stream in an install's store. */
function streamsOn(seat: Seat): string[] {
  const dir = path.join(storeDir(seat), 'streams');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

interface Relayed { waiting: Array<{ hash: string; reason: string }>; handed: Map<string, SealedEntry[]> }

/** A mistaken relay: every entry of every stream, every blob and every grant on the lead's disk, handed to the member. */
async function relayEverything(lead: Seat, member: Seat): Promise<Relayed> {
  const handed = new Map(streamsOn(lead).map((stream) => [stream, streamEntries(lead.at, stream)] as const));
  const stored = await member.p.putGrants(grantsOn(lead.at).map((item) => item.signed));
  assert.ok(!isProjectRefused(stored), 'the grants are taken');
  const result = await member.p.ingestForeign([...handed.values()].flat(), blobsOn(lead));
  assert.ok(!isProjectRefused(result), 'the entries are taken');
  return { waiting: result.waiting, handed };
}

const caller = (seat: Seat): StaffCaller => ({ member: 'j4-director', run: 'run-label-leak', root: seat.at.root, team: J4_TEAM });

/** Every text a staff host over the member's folder gives: the replay, the snapshot, the list, and the status of each product it lists. */
async function hostTexts(seat: Seat): Promise<string> {
  let clock = Date.parse('2026-11-21T08:00:00.000Z');
  const host = new StaffHost({
    root: seat.at.root, signer: async () => seat.p.signer, keyStatus: async () => trusting(seat.p.signer), headStore: seat.at.secrets,
    now: () => { clock += 1000; return clock; }, replica: { globalStorageDir: seat.at.global }
  });
  try {
    const replay = await host.replay();
    const texts = [asText(replay), asText(await host.snapshot()), asText(await host.list(caller(seat), { all: true }))];
    for (const product of replay.products.keys()) texts.push(asText(await host.status(caller(seat), product)), asText(await host.productState(product)));
    return texts.join('\n');
  } finally {
    await host.close();
  }
}

/** A single-machine copy made by the member into a new folder: the result and the folder. */
async function copyOf(seat: Seat, name: string): Promise<{ result: string; folder: string }> {
  const folder = path.join(mkdtempSync(path.join(tmpdir(), `near-ai-label-leak-copy-${name}-`)), 'copy');
  const result = await makeSingleMachineCopy(seat.at.root, folder, { ...seat.at.deps, copier: { name, role: 'j4-planner' } });
  assert.ok(result.ok, result.ok ? '' : result.message);
  return { result: asText(result), folder };
}

/** Every secret name and value of an install. */
const secretsText = (seat: Seat): Buffer => Buffer.from([...seat.at.secrets.values.entries()].map(([name, value]) => `${name}\n${value}`).join('\n'), 'utf8');

const foldFamilies = async (seat: Seat): Promise<Buffer> => Buffer.from(asText((await seat.p.state()).fold.families), 'utf8');

/** The relayed scene: the grant path for both members, then everything on the lead's disk handed to each. Made once. */
interface RelayedScene extends Scene { toY: Relayed; toX: Relayed }
let relayedOnce: Promise<RelayedScene> | undefined;
function relayed(): Promise<RelayedScene> {
  relayedOnce ??= (async () => {
    const s = await scene();
    await deliverOwn(s.lead, s.y, s.b.cell);
    await deliverOwn(s.lead, s.x, s.a.cell);
    return { ...s, toY: await relayEverything(s.lead, s.y), toX: await relayEverything(s.lead, s.x) };
  })();
  return relayedOnce;
}

/** The member's key ring, awaiting-key list and fold lists after the relay, for the cell it is below. */
async function assertWaits(member: Seat, below: Written, handed: Relayed, epochs: readonly number[]): Promise<void> {
  const name = below.plan.token;
  for (const epoch of epochs) assert.equal(member.p.keys.epochKey(below.cell, epoch), undefined, `still no key of the ${name} cell, epoch ${epoch}`);
  const entries = handed.handed.get(below.cell) ?? [];
  assert.ok(entries.length >= 5, `the ${name} cell's entries were handed over (${entries.length})`);
  const hashes = entries.map((entry) => entryHash(entry.header));
  const waiting = new Map(handed.waiting.map((item) => [item.hash, item.reason]));
  for (const hash of hashes) assert.equal(waiting.get(hash), 'awaiting-key', `${hash} waits for a key`);
  const { fold } = await member.p.state();
  const lists = asText({ held: fold.held, refused: fold.refused, kept: fold.kept, rejected: fold.rejected, quarantined: fold.quarantined });
  for (const hash of hashes) {
    assert.ok(!fold.order.includes(hash), 'not in the fold order');
    assert.ok(!fold.applied.includes(hash), 'not applied');
    assert.ok(!lists.includes(hash), 'not held, refused, kept, rejected or quarantined');
  }
  assert.equal(fold.digests[below.cell], undefined, `the fold has no digest of the ${name} cell`);
}

// ---- Task 2: a mistaken relay hands the member everything --------------------------------------------------------------------------------------

test('mistaken relay: with every entry, blob and grant of the lead handed to Y, Y holds no key of A, every A entry waits awaiting-key, and Y\'s fold lists name none', async () => {
  const s = await relayed();
  await assertWaits(s.y, s.a, s.toY, await epochsOf(s.lead, s.a.cell));
});

test('mistaken relay: with everything of the lead handed to X, X holds no key of B, every B entry waits awaiting-key, and X\'s fold lists name none', async () => {
  const s = await relayed();
  await assertWaits(s.x, s.b, s.toX, await epochsOf(s.lead, s.b.cell));
});

/** No canary of the cell below in the member's fold output, staff host texts, project folder (the store included), global storage or secrets. */
async function assertNothingOf(member: Seat, below: Written): Promise<void> {
  const canaries = canariesOf(below.plan);
  assert.deepEqual(found(await foldFamilies(member), canaries), [], 'fold families');
  assert.deepEqual(found(Buffer.from(await hostTexts(member), 'utf8'), canaries), [], 'staff host texts');
  assert.deepEqual(foundInTree(member.at.root, canaries), [], 'the project folder, the store included');
  assert.deepEqual(foundInTree(member.at.global, canaries), [], 'global storage');
  assert.deepEqual(found(secretsText(member), canaries), [], 'secret names and values');
}

test('mistaken relay: no A canary (name, title, text, label token, reason) is in Y\'s fold output, staff host texts, project folder, store, global storage or secrets', async () => {
  const s = await relayed();
  await assertNothingOf(s.y, s.a);
});

test('mistaken relay: no B canary is in X\'s fold output, staff host texts, project folder, store, global storage or secrets', async () => {
  const s = await relayed();
  await assertNothingOf(s.x, s.b);
});

test('single-machine copy: Y\'s copy, every file name and byte and its result, holds no A canary; X\'s holds no B canary', async () => {
  const s = await relayed();
  for (const [member, below, name] of [[s.y, s.a, 'Yan Planner'], [s.x, s.b, 'Xan Analyst']] as const) {
    const copy = await copyOf(member, name);
    const canaries = canariesOf(below.plan);
    assert.deepEqual(foundInTree(copy.folder, canaries), [], `${name}'s copy folder`);
    assert.deepEqual(found(Buffer.from(copy.result, 'utf8'), canaries), [], `${name}'s copy result`);
  }
});

test('positive control: the same searches find B\'s canaries in Y\'s fold output, host texts and copy, and A\'s in X\'s; and A\'s and B\'s in the lead\'s fold', async () => {
  const s = await relayed();
  const all = ['name', 'title', 'text', 'token', 'reason'];
  for (const [member, own, name] of [[s.y, s.b, 'Yan Planner'], [s.x, s.a, 'Xan Analyst']] as const) {
    assert.deepEqual(found(await foldFamilies(member), canariesOf(own.plan)), canariesOf(own.plan, all).map((item) => item.what), `${name}'s fold names every canary of its own cell`);
    assert.ok(found(Buffer.from(await hostTexts(member), 'utf8'), canariesOf(own.plan, ['name'])).length === 1, `${name}'s host texts name its own cell's product`);
    const copy = await copyOf(member, `${name} again`);
    const inCopy = new Set(foundInTree(copy.folder, canariesOf(own.plan, ['name', 'text'])).map((item) => item.split(' in ')[0]));
    assert.deepEqual([...inCopy].sort(), canariesOf(own.plan, ['name', 'text']).map((item) => item.what).sort(), `${name}'s copy carries its own cell's product and text`);
  }
  const lead = await foldFamilies(s.lead);
  for (const plan of [PLAN_A, PLAN_B]) assert.deepEqual(found(lead, canariesOf(plan)), canariesOf(plan, all).map((item) => item.what), `the lead's fold names every canary of ${plan.token}`);
});

test('base cell: opened with the base key on the lead, every base entry is the genesis or a kind the base cell allows, and no name, title, text or reason of A or B is in any base body or blob', async () => {
  const s = await relayed();
  const base = s.lead.p.projectId;
  const entries = streamEntries(s.lead.at, base);
  assert.ok(entries.length > 0);
  // Label tokens are not searched here: declared clearances are roster data every member reads by design (the D-13 notice).
  const canaries = [...canariesOf(PLAN_A, ['name', 'title', 'text', 'reason']), ...canariesOf(PLAN_B, ['name', 'title', 'text', 'reason'])];
  const blobs = new Map(blobsOn(s.lead).map((blob) => [blob.hash, blob]));
  const plain: Buffer[] = [];
  for (const entry of entries) {
    const key = s.lead.p.keys.epochKey(base, entry.header.epoch);
    assert.ok(key !== undefined, 'the lead holds the base key');
    const opened = openBody(key, entry.header, Buffer.from(entry.body, 'base64url'));
    assert.ok(opened !== undefined, 'the base entry opens');
    plain.push(opened);
    const body = JSON.parse(opened.toString('utf8')) as { kind: string; blob?: string; data?: Record<string, unknown> };
    assert.ok(baseCellAllows(body.kind), `${body.kind} may be in the base cell`);
    for (const hash of [body.blob, body.data?.textBlob, body.data?.stateBlob]) {
      if (typeof hash !== 'string') continue;
      const blob = blobs.get(hash);
      assert.ok(blob !== undefined, 'a blob a base entry names is on the lead\'s disk');
      const inner = openBlob(key, base, entry.header.epoch, blob);
      assert.ok(inner !== undefined, 'the blob opens with the base key');
      plain.push(inner);
    }
  }
  assert.deepEqual(found(Buffer.concat(plain), canaries), [], 'no product canary in the base cell');
  // The control: the same search over cell A and cell B, opened with their keys, finds their canaries.
  for (const written of [s.a, s.b]) {
    const inCell = streamEntries(s.lead.at, written.cell).map((entry) => openBody(s.lead.p.keys.epochKey(written.cell, entry.header.epoch) as Buffer, entry.header, Buffer.from(entry.body, 'base64url')) as Buffer);
    assert.ok(found(Buffer.concat(inCell), canariesOf(written.plan, ['name', 'title', 'reason'])).length === 3, `the search finds ${written.plan.token}'s canaries in its own cell`);
  }
});
