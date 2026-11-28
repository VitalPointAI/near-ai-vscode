// Label cells on the host (plan 32-09; D-15 to D-20, D-23): a cell for a label is made on demand, its key goes only to the devices whose member's
// declared clearance covers the label, and products are written into the cell for their label, never into the base cell every member and the hub read.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { REKEY_KEEP_TEXT, readGrant } from '../domain/replica/cellKeys';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, docText, localInsert, snapshotOf } from '../domain/replica/doc';
import { entryHash, openBody } from '../domain/replica/entry';
import { REPLICA_KINDS, kindFamily } from '../domain/replica/kinds';
import { PRODUCT_CELL_REFUSALS, baseCellAllows, legacyCellLabel } from '../domain/replica/productCells';
import { rosterView } from '../domain/replica/roster';
import type { RosterState } from '../domain/replica/roster';
import { committedGrant, epochAt } from '../domain/replica/rosterCells';
import type { ProductVersions } from '../domain/replica/versions';
import { REPLICA_DIR } from '../domain/staff/multiUser';
import {
  LABEL_CELL_REFUSALS, NOT_CLEARED_TEXT, appendProductEntry, cellLabelTexts, ensureLabelCell, ensureLegacyCell, labelCellOf, productCellOf, proposeVersion
} from '../staff/replica/labelCells';
import { LEGACY_GIVEN_TEXT, MEMBERSHIP_REFUSALS, finishRekeys, handOverLead, nameDeputy } from '../staff/replica/membership';
import { isProjectRefused } from '../staff/replica/replicaProject';
import type { ReplicaProject } from '../staff/replica/replicaProject';
import { bringIn, grantsOn, leadWith, ok, orgClearance, orgLabel, streamEntries, syncTo } from './helpers/labelCellWorld';
import type { Seat } from './helpers/labelCellWorld';

async function head(p: ReplicaProject): Promise<{ roster: RosterState; hash: string; position: number }> {
  const { roster } = await p.state();
  return { roster, hash: roster.positions[roster.positions.length - 1], position: roster.positions.length - 1 };
}

interface World { lead: Seat; m: Seat; n: Seat }

/** The lead (declared org/Confidential), M declared org/Internal and N declared org/Public. */
async function world(): Promise<World> {
  const lead = await leadWith();
  const m = await bringIn(lead, 'm', 'Mo Analyst', orgClearance('Internal'));
  const n = await bringIn(lead, 'n', 'Nell Planner', orgClearance('Public'));
  return { lead, m, n };
}

function made(result: Awaited<ReturnType<typeof ensureLabelCell>>, what: string): { cell: string; created: boolean; granted: string[] } {
  assert.equal(result.ok, true, `${what}: ${result.ok ? '' : `${result.reason} ${result.message}`}`);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

/** The grants for one cell on an install's disk, read. */
function cellGrants(seat: Seat, cell: string): Array<{ hash: string; roster: string; writers: string[]; labelSealed: string }> {
  return grantsOn(seat.at).filter((item) => item.cell === cell).map((item) => {
    const read = readGrant(item.signed);
    assert.ok(read.ok, 'the grant reads');
    return { hash: read.hash, roster: read.grant.roster, writers: read.grant.wraps.map((wrap) => wrap.writer), labelSealed: read.grant.labelSealed };
  });
}

const PRODUCT = 'logistics-estimate';
const ROLES = { owner: 'j4-planner', sectionLead: 'j4-lead', releaseGuard: 'j4-guard' };

/** product.create, doc.client and doc.update for one product, through appendProductEntry. Returns the doc and the client id used. */
async function writeProduct(seat: Seat, product: string, label: unknown, text: string, counter = 0): Promise<{ stream: string; doc: ReturnType<typeof createLocalDoc> }> {
  const created = await appendProductEntry(seat.host, 'product.create', { product, section: 'j4', roles: { ...ROLES }, title: `Estimate ${product}` }, { label });
  assert.equal(created.ok, true, `product.create: ${created.ok ? '' : created.message}`);
  if (!created.ok) throw new Error('unreachable');
  const { roster } = await seat.p.state();
  const slot = roster.members.devices.get(seat.p.deviceWriter)?.[0]?.slot ?? 1;
  const clientId = clientIdOf(slot, counter);
  const client = await appendProductEntry(seat.host, 'doc.client', { product, clientId, actor: { kind: 'person' } });
  assert.equal(client.ok, true, `doc.client: ${client.ok ? '' : client.message}`);
  const doc = createLocalDoc(clientId);
  const update = Buffer.from(localInsert(doc, docText(doc).length, text)).toString('base64url');
  const written = await appendProductEntry(seat.host, 'doc.update', { product, update });
  assert.equal(written.ok, true, `doc.update: ${written.ok ? '' : written.message}`);
  return { stream: created.stream, doc };
}

const versionsOf = async (p: ReplicaProject): Promise<ProductVersions[]> => ((await p.state()).fold.families.versions as ProductVersions[] | undefined) ?? [];

// ---- Task 1: the tracer ----------------------------------------------------------------------------------------------------------------------------

test('ensureLabelCell makes an org/Internal cell: the founding grant wraps only the lead\'s device, M (cleared) gets its own grant at the cell.create roster, N (below) gets nothing, and no hub is wrapped', async () => {
  const w = await world();
  const result = made(await ensureLabelCell(w.lead.host, orgLabel('Internal')), 'ensure');
  assert.equal(result.created, true);
  assert.deepEqual(result.granted, [w.m.writer]);
  const { roster } = await head(w.lead.p);
  const record = roster.cells.cells.get(result.cell);
  assert.ok(record !== undefined, 'the roster has the cell');
  const createdAt = roster.positions[record.from];
  const founding = committedGrant(roster.cells, result.cell, 1);
  const grants = cellGrants(w.lead, result.cell);
  assert.equal(grants.length, 2, 'one founding grant and one grant for M');
  const first = grants.find((grant) => grant.hash === founding);
  assert.ok(first !== undefined, 'the founding grant is stored');
  assert.deepEqual(first.writers, [w.lead.writer], 'the founding grant wraps the lead\'s device only');
  assert.notEqual(first.labelSealed, '', 'the label is sealed in the founding grant');
  const forM = grants.find((grant) => grant.hash !== founding);
  assert.ok(forM !== undefined);
  assert.deepEqual(forM.writers, [w.m.writer], 'M has a grant of its own');
  assert.equal(forM.roster, createdAt, 'M\'s grant is at the cell.create roster');
  for (const grant of grants) assert.ok(!grant.writers.includes(w.n.writer), 'N is never wrapped');
  const view = rosterView(roster);
  assert.deepEqual(view.cellGrantees?.(result.cell, roster.positions[roster.positions.length - 1]), [w.lead.writer, w.m.writer].sort());
});

test('after syncTo, M\'s ring holds the label cell\'s epoch 1 key and N\'s does not; N\'s roster view answers cellGrantees undefined for the cell', async () => {
  const w = await world();
  const { cell } = made(await ensureLabelCell(w.lead.host, orgLabel('Internal')), 'ensure');
  await syncTo(w.lead, w.m, [cell]);
  await syncTo(w.lead, w.n, []);
  assert.ok(w.m.p.keys.epochKey(cell, 1) !== undefined, 'M opens the cell');
  assert.equal(w.n.p.keys.epochKey(cell, 1), undefined, 'N does not');
  const { roster, hash } = await head(w.n.p);
  assert.ok(roster.cells.cells.has(cell), 'N\'s roster knows a cell id exists');
  assert.equal(rosterView(roster).cellGrantees?.(cell, hash), undefined, 'and nothing about who holds it');
  assert.equal(await labelCellOf(w.n.host, orgLabel('Internal')), undefined, 'N holds no cell for the label');
  assert.equal(await labelCellOf(w.m.host, orgLabel('Internal')), cell, 'M finds the cell by its label');
});

test('appendProductEntry writes product.create, doc.client and doc.update into the cell for the label; the fold lists the product there and no product-family entry is in the base stream', async () => {
  const w = await world();
  const { stream } = await writeProduct(w.lead, PRODUCT, 'org/Internal', 'Fuel for three days at the forward point.');
  const cell = await labelCellOf(w.lead.host, orgLabel('Internal'));
  assert.equal(stream, cell, 'the product went into the org/Internal cell');
  const products = await versionsOf(w.lead.p);
  assert.deepEqual(products.map((item) => [item.product, item.stream]), [[PRODUCT, cell]]);
  const { fold } = await w.lead.p.state();
  const doc = fold.families.doc as Array<{ stream: string; product: string; text: string }>;
  assert.deepEqual(doc.map((item) => [item.stream, item.product, item.text]), [[cell, PRODUCT, 'Fuel for three days at the forward point.']]);
  // Every entry of the base stream, opened with the lead's keys, is a kind the base cell may carry: the genesis, the roster and integrity kinds.
  const base = streamEntries(w.lead.at, w.lead.p.projectId);
  assert.ok(base.length > 0);
  for (const entry of base) {
    const key = w.lead.p.keys.epochKey(entry.header.stream, entry.header.epoch);
    assert.ok(key !== undefined);
    const plain = openBody(key, entry.header, Buffer.from(entry.body, 'base64url'));
    assert.ok(plain !== undefined);
    const kind = (JSON.parse(plain.toString('utf8')) as { kind: string }).kind;
    assert.ok(baseCellAllows(kind), `${kind} may be in the base cell`);
  }
  const kinds = await w.lead.p.findOwnAll('product.create', () => true);
  assert.deepEqual(kinds.map((item) => item.stream), [cell]);
  for (const family of ['versions', 'doc']) {
    for (const kind of family === 'versions' ? ['product.create', 'version.propose'] : ['doc.client', 'doc.update']) {
      assert.equal(kindFamily(kind), family);
      const own = await w.lead.p.findOwnAll(kind, () => true);
      assert.ok(own.every((item) => item.stream !== w.lead.p.projectId), `${kind} is never in the base stream`);
    }
  }
});

test('ensureLabelCell again for the same label returns the same cell with created false, and the roster gains no entry', async () => {
  const w = await world();
  const first = made(await ensureLabelCell(w.lead.host, orgLabel('Internal')), 'first');
  const before = (await head(w.lead.p)).position;
  const again = made(await ensureLabelCell(w.lead.host, 'org/Internal'), 'again');
  assert.equal(again.cell, first.cell);
  assert.equal(again.created, false);
  assert.deepEqual(again.granted, []);
  assert.equal((await head(w.lead.p)).position, before, 'no roster entry was written');
});

// ---- Task 2: every refusal before anything is written ------------------------------------------------------------------------------------------

/** Everything an install's store holds that a write would change: every entry of every stream and every grant on disk. */
function storeSnapshot(seat: Seat): string {
  const dir = path.join(seat.at.root, ...REPLICA_DIR.split('/'), 'streams');
  const streams = existsSync(dir) ? readdirSync(dir).sort() : [];
  const entries = streams.flatMap((stream) => streamEntries(seat.at, stream).map((entry) => `${stream}:${entryHash(entry.header)}`)).sort();
  const grants = grantsOn(seat.at).map((item) => `${item.cell}:${readGrant(item.signed).ok ? (readGrant(item.signed) as { hash: string }).hash : 'bad'}`).sort();
  return JSON.stringify({ entries, grants });
}

function refusedWith(result: { ok: boolean; reason?: string; message?: string }, reason: string): string {
  assert.equal(result.ok, false, `refused ${reason}`);
  assert.equal(result.reason, reason);
  assert.equal(typeof result.message, 'string');
  assert.ok(!(result.message as string).includes(String.fromCharCode(0x2014)), 'no em-dash');
  return result.message as string;
}

/** A version of one product proposed from its document, with the header naming the label given. */
async function propose(seat: Seat, product: string, doc: ReturnType<typeof createLocalDoc>, label: string, pins: Array<{ product: string; hash: string }> = []): ReturnType<typeof proposeVersion> {
  return proposeVersion(seat.host, { product, text: docText(doc), header: { kind: 'estimate', label, profile: 'j4', level: 'official' }, pins, snapshot: snapshotOf(doc) });
}

test('not-cleared-for-label: a lead declared org/Internal asking for an org/Confidential cell is refused with the D-19 sentence naming the label, and nothing is written', async () => {
  const lead = await leadWith({ clearance: orgClearance('Internal') });
  const before = storeSnapshot(lead);
  const keys = lead.p.keys.size;
  const message = refusedWith(await ensureLabelCell(lead.host, orgLabel('Confidential')), 'not-cleared-for-label');
  assert.equal(message, 'You are not declared cleared for org/Confidential, so this computer cannot hold that part of the project. Ask the staff lead to declare a clearance that covers it, or keep this project on one machine.');
  assert.equal(message, NOT_CLEARED_TEXT('org/Confidential'));
  refusedWith(await appendProductEntry(lead.host, 'product.create', { product: PRODUCT, section: 'j4', roles: { ...ROLES }, title: 'Estimate' }, { label: 'org/Confidential' }), 'not-cleared-for-label');
  assert.equal(storeSnapshot(lead), before, 'no entry and no grant was written');
  assert.equal(lead.p.keys.size, keys, 'no key was kept');
  assert.equal(LABEL_CELL_REFUSALS['not-cleared-for-label'], NOT_CLEARED_TEXT('that label'));
});

test('not-cleared-for-label: a lead with no declared clearance may make only the org/Public cell (D-68) and is refused any other', async () => {
  const lead = await leadWith({ clearance: null });
  const before = storeSnapshot(lead);
  refusedWith(await ensureLabelCell(lead.host, orgLabel('Internal')), 'not-cleared-for-label');
  assert.equal(storeSnapshot(lead), before);
  const made1 = made(await ensureLabelCell(lead.host, orgLabel('Public')), 'org/Public');
  assert.equal(made1.created, true);
  assert.equal(await labelCellOf(lead.host, 'org/Public'), made1.cell);
});

test('not-a-roster-writer: M\'s device asking for a cell is refused with the membership sentence, and M writes nothing', async () => {
  const w = await world();
  const before = storeSnapshot(w.m);
  const message = refusedWith(await ensureLabelCell(w.m.host, orgLabel('Public')), 'not-a-roster-writer');
  assert.equal(message, MEMBERSHIP_REFUSALS['not-a-roster-writer']);
  assert.equal(storeSnapshot(w.m), before);
});

test('base-cell-products: every versions and doc kind for a product a preview project keeps in the base cell is refused, nothing is written, and an org/Public product goes into its own cell', async () => {
  const lead = await leadWith();
  // A 0.4.35 preview project wrote its products straight into the base cell.
  const preview = await lead.p.appendOwn('product.create', { product: 'preview-plan', section: 'j4', roles: { ...ROLES }, title: 'Preview plan' });
  assert.ok('ok' in preview);
  assert.deepEqual(await productCellOf(lead.host, 'preview-plan'), { stream: lead.p.projectId, base: true });
  const before = storeSnapshot(lead);
  for (const kind of REPLICA_KINDS.filter((item) => kindFamily(item) === 'versions' || kindFamily(item) === 'doc')) {
    if (kind === 'product.create') continue;
    const message = refusedWith(await appendProductEntry(lead.host, kind, { product: 'preview-plan' }), 'base-cell-products');
    assert.equal(message, LABEL_CELL_REFUSALS['base-cell-products']);
  }
  const doc = createLocalDoc(clientIdOf(1, 9));
  localInsert(doc, 0, 'Preview text.');
  refusedWith(await propose(lead, 'preview-plan', doc, 'org/Internal'), 'base-cell-products');
  assert.equal(storeSnapshot(lead), before, 'nothing was written');
  const notice = await appendProductEntry(lead.host, 'product.create', { product: 'public-notice', section: 'j4', roles: { ...ROLES }, title: 'Public notice' }, { label: 'org/Public' });
  assert.ok(notice.ok);
  assert.notEqual(notice.stream, lead.p.projectId, 'an org/Public product is not kept in the base cell');
  assert.equal(notice.stream, await labelCellOf(lead.host, orgLabel('Public')));
});

test('label-change: product.create of a name kept in another cell is refused, and a version whose header names another label is refused; nothing is written', async () => {
  const lead = await leadWith();
  const { doc } = await writeProduct(lead, PRODUCT, 'org/Internal', 'Water for two days.');
  const before = storeSnapshot(lead);
  const message = refusedWith(await appendProductEntry(lead.host, 'product.create', { product: PRODUCT, section: 'j4', roles: { ...ROLES }, title: 'Again' }, { label: 'org/Confidential' }), 'label-change');
  assert.equal(message, LABEL_CELL_REFUSALS['label-change']);
  refusedWith(await propose(lead, PRODUCT, doc, 'org/Public'), 'label-change');
  assert.equal(storeSnapshot(lead), before);
  // The same label is no change: the version applies.
  const proposed = await propose(lead, PRODUCT, doc, 'org/Internal');
  assert.ok(proposed.ok, proposed.ok ? '' : proposed.message);
  const product = (await versionsOf(lead.p)).find((item) => item.product === PRODUCT);
  assert.equal(product?.versions.length, 1);
});

test('a proposal awaiting rotation stores neither its entry nor its text blob', async () => {
  const w = await world();
  const { doc } = await writeProduct(w.lead, PRODUCT, 'org/Internal', 'The next estimate.');
  assert.ok('ok' in await w.lead.p.appendOwn('member.remove', { member: w.m.member }));
  const blobs = path.join(w.lead.at.root, ...REPLICA_DIR.split('/'), 'blobs');
  const blobFiles = () => existsSync(blobs) ? readdirSync(blobs).sort() : [];
  const beforeFiles = blobFiles();
  const beforeStore = storeSnapshot(w.lead);
  refusedWith(await propose(w.lead, PRODUCT, doc, 'org/Internal'), 'rekey-pending');
  assert.deepEqual(blobFiles(), beforeFiles);
  assert.equal(storeSnapshot(w.lead), beforeStore);
  ok(await finishRekeys(w.lead.host), 'finish rotation');
  assert.ok((await propose(w.lead, PRODUCT, doc, 'org/Internal')).ok);
  assert.ok(readdirSync(blobs).length > beforeFiles.length);
});

test('label-change (WR-01): a version header whose compartments or releasability are not its cell\'s is refused, though scale and level match; the header that names the cell\'s whole label applies', async () => {
  const lead = await leadWith({ clearance: { scale: 'org', level: 'Confidential', compartments: ['KESTREL'], releasability: ['CAN'] } });
  const plain = await writeProduct(lead, PRODUCT, 'org/Confidential', 'Water for two days.');
  const kestrel = { scale: 'org', level: 'Confidential', compartments: ['KESTREL'], releasability: [], handling: [] };
  const marked = await writeProduct(lead, 'kestrel-estimate', kestrel, 'Watchers on the ridge.', 1);
  assert.notEqual(marked.stream, plain.stream, 'the compartment has its own cell');
  const before = storeSnapshot(lead);
  // A plain org/Confidential cell: a caveat the cell does not carry would seal caveated text under a key devices without the caveat hold.
  refusedWith(await propose(lead, PRODUCT, plain.doc, 'org/Confidential//REL CAN'), 'label-change');
  refusedWith(await propose(lead, PRODUCT, plain.doc, 'org/Confidential//KESTREL'), 'label-change');
  // The KESTREL cell: a header that drops the compartment, or one that does not read as a label, is refused too.
  refusedWith(await propose(lead, 'kestrel-estimate', marked.doc, 'org/Confidential'), 'label-change');
  refusedWith(await propose(lead, 'kestrel-estimate', marked.doc, 'org/Confidential//'), 'label-change');
  refusedWith(await propose(lead, 'kestrel-estimate', marked.doc, 'org/Confidential//KESTREL//REL CAN'), 'label-change');
  assert.equal(storeSnapshot(lead), before, 'nothing was written');
  const plainVersion = await propose(lead, PRODUCT, plain.doc, 'org/Confidential');
  assert.ok(plainVersion.ok, plainVersion.ok ? '' : plainVersion.message);
  const markedVersion = await propose(lead, 'kestrel-estimate', marked.doc, 'org/Confidential//KESTREL');
  assert.ok(markedVersion.ok, markedVersion.ok ? '' : markedVersion.message);
  assert.equal(markedVersion.stream, marked.stream);
});

test('pin-above-cell: a version of an org/Internal product pinning an org/Confidential product is refused with the fold\'s sentence; pinning an org/Public product applies and cites the pinned version', async () => {
  const lead = await leadWith();
  const notice = await writeProduct(lead, 'public-notice', 'org/Public', 'Roads open at dawn.', 1);
  const route = await writeProduct(lead, 'route-secret', 'org/Confidential', 'Convoy leaves by the north road.', 2);
  const estimate = await writeProduct(lead, PRODUCT, 'org/Internal', 'Fuel for three days.', 3);
  const noticeVersion = await propose(lead, 'public-notice', notice.doc, 'org/Public');
  const routeVersion = await propose(lead, 'route-secret', route.doc, 'org/Confidential');
  assert.ok(noticeVersion.ok && routeVersion.ok);
  const before = storeSnapshot(lead);
  const message = refusedWith(await propose(lead, PRODUCT, estimate.doc, 'org/Internal', [{ product: 'route-secret', hash: routeVersion.version }]), 'pin-above-cell');
  assert.equal(message, PRODUCT_CELL_REFUSALS['pin-above-cell']);
  assert.equal(storeSnapshot(lead), before);
  const pinned = await propose(lead, PRODUCT, estimate.doc, 'org/Internal', [{ product: 'public-notice', hash: noticeVersion.version }]);
  assert.ok(pinned.ok, pinned.ok ? '' : pinned.message);
  assert.ok(pinned.deps.includes(noticeVersion.hash), 'the proposal cites the pinned version entry');
  const product = (await versionsOf(lead.p)).find((item) => item.product === PRODUCT);
  assert.equal(product?.versions.length, 1, 'the fold applied the pinned version');
  assert.deepEqual(product?.versions[0].pins, [{ product: 'public-notice', hash: noticeVersion.version }]);
});

test('product-unknown: a write or a version for a name no held cell has is refused, and nothing is written', async () => {
  const lead = await leadWith();
  await writeProduct(lead, PRODUCT, 'org/Internal', 'Rations.');
  const before = storeSnapshot(lead);
  refusedWith(await appendProductEntry(lead.host, 'doc.update', { product: 'no-such-product', update: 'AA' }), 'product-unknown');
  const doc = createLocalDoc(clientIdOf(1, 5));
  localInsert(doc, 0, 'Nothing.');
  refusedWith(await propose(lead, 'no-such-product', doc, 'org/Internal'), 'product-unknown');
  assert.equal(storeSnapshot(lead), before);
});

test('one cell.create: a run stopped after the key, or after the founding grant is stored, and run again makes exactly one cell.create for the label; the first grant stays stored and unplaced', async () => {
  const w = await world();
  await assert.rejects(ensureLabelCell(w.lead.host, orgLabel('Internal'), { stopAfter: 'key' }), /stopped/);
  await assert.rejects(ensureLabelCell(w.lead.host, orgLabel('Internal'), { stopAfter: 'grant' }), /stopped/);
  const stray = grantsOn(w.lead.at).map((item) => item.cell).filter((cell) => cell !== w.lead.p.projectId);
  assert.equal(stray.length, 1, 'the grant of the stopped run is stored');
  const again = made(await ensureLabelCell(w.lead.host, orgLabel('Internal')), 'again');
  assert.equal(again.created, true);
  assert.deepEqual(again.granted, [w.m.writer]);
  const creates = await w.lead.p.findOwnAll('cell.create', () => true);
  assert.equal(creates.length, 1, 'exactly one cell.create');
  const { roster } = await head(w.lead.p);
  assert.ok(!roster.cells.cells.has(stray[0]), 'the stopped run\'s grant is never placed');
  assert.ok(grantsOn(w.lead.at).some((item) => item.cell === stray[0]), 'and it stays stored');
  made(await ensureLabelCell(w.lead.host, orgLabel('Internal')), 'a third time');
  assert.equal((await w.lead.p.findOwnAll('cell.create', () => true)).length, 1);
});

test('a run stopped after cell.create gives the cleared devices their grants on the next ensureLabelCell, so no cleared member is left without the cell', async () => {
  const w = await world();
  await assert.rejects(ensureLabelCell(w.lead.host, orgLabel('Internal'), { stopAfter: 'create' }), /stopped/);
  const cell = await labelCellOf(w.lead.host, orgLabel('Internal'));
  assert.ok(cell !== undefined);
  const { roster, hash } = await head(w.lead.p);
  assert.deepEqual(rosterView(roster).cellGrantees?.(cell, hash), [w.lead.writer], 'only the lead holds it after the stop');
  const again = made(await ensureLabelCell(w.lead.host, orgLabel('Internal')), 'again');
  assert.equal(again.created, false);
  assert.deepEqual(again.granted, [w.m.writer]);
  const after = await head(w.lead.p);
  assert.deepEqual(rosterView(after.roster).cellGrantees?.(cell, after.hash), [w.lead.writer, w.m.writer].sort());
  assert.equal((await w.lead.p.findOwnAll('cell.create', () => true)).length, 1);
});

// ---- Task 3: the legacy cell and a member below a cell ----------------------------------------------------------------------------------------

const LEGACY_LABELS = [orgLabel('Internal'), orgLabel('Confidential')];

test('legacy: ensureLegacyCell seals the legacy label form; only the lead\'s device holds it and heldCells lists it with that label', async () => {
  const w = await world();
  const legacy = made(await ensureLegacyCell(w.lead.host, LEGACY_LABELS), 'legacy');
  assert.equal(legacy.created, true);
  assert.deepEqual(legacy.granted, [], 'no ordinary member is cleared for the legacy cell');
  const held = await w.lead.p.heldCells();
  const listed = held.find((item) => item.cell === legacy.cell);
  assert.deepEqual(listed?.label, legacyCellLabel(LEGACY_LABELS));
  const { roster, hash } = await head(w.lead.p);
  assert.deepEqual(rosterView(roster).cellGrantees?.(legacy.cell, hash), [w.lead.writer]);
  assert.equal(await labelCellOf(w.lead.host, orgLabel('Internal')), undefined, 'the legacy cell is never an ordinary label cell');
  const again = made(await ensureLegacyCell(w.lead.host, [orgLabel('Confidential'), orgLabel('Internal')]), 'again');
  assert.equal(again.cell, legacy.cell);
  assert.equal(again.created, false);
});

test('legacy: a member admitted with org/Restricted gets every org cell but not the legacy cell; admission never grants it', async () => {
  const lead = await leadWith();
  const internal = made(await ensureLabelCell(lead.host, orgLabel('Internal')), 'internal').cell;
  const confidential = made(await ensureLabelCell(lead.host, orgLabel('Confidential')), 'confidential').cell;
  const legacy = made(await ensureLegacyCell(lead.host, LEGACY_LABELS), 'legacy').cell;
  const p = await bringIn(lead, 'p', 'Pat Officer', orgClearance('Restricted'));
  assert.deepEqual(p.results[2].granted, [lead.p.projectId, internal, confidential].sort());
  assert.ok(p.p.keys.epochKey(internal, 1) !== undefined && p.p.keys.epochKey(confidential, 1) !== undefined);
  assert.equal(p.p.keys.epochKey(legacy, 1), undefined, 'P does not hold the legacy cell');
});

test('legacy: naming a cleared deputy gives their device the legacy cell and says so; naming a deputy below gives nothing, and the next finishRekeys moves the legacy cell to a new key without the former deputy', async () => {
  const lead = await leadWith();
  const legacy = made(await ensureLegacyCell(lead.host, LEGACY_LABELS), 'legacy').cell;
  const p = await bringIn(lead, 'p', 'Pat Officer', orgClearance('Restricted'));
  const named = ok(await nameDeputy(lead.host, p.member), 'name P');
  assert.ok(named.message.includes(LEGACY_GIVEN_TEXT), named.message);
  assert.deepEqual(named.granted, [legacy]);
  await syncTo(lead, p, [legacy]);
  assert.ok(p.p.keys.epochKey(legacy, 1) !== undefined, 'P holds the legacy cell');
  const q = await bringIn(lead, 'q', 'Quinn Clerk', orgClearance('Internal'));
  const namedQ = ok(await nameDeputy(lead.host, q.member), 'name Q');
  assert.ok(!namedQ.message.includes(LEGACY_GIVEN_TEXT));
  assert.deepEqual(namedQ.granted ?? [], []);
  assert.equal(q.p.keys.epochKey(legacy, 1), undefined);
  const finished = ok(await finishRekeys(lead.host), 'finish');
  assert.deepEqual(finished.rekeyed, [legacy]);
  assert.ok(finished.message.endsWith(REKEY_KEEP_TEXT));
  assert.ok(finished.message.includes('Devices excluded from the new keys cannot read work encrypted with those keys.'));
  assert.doesNotMatch(finished.message, /anything new/);
  const { roster, hash, position } = await head(lead.p);
  assert.equal(epochAt(roster.cells, legacy, position), 2);
  assert.deepEqual(rosterView(roster).cellGrantees?.(legacy, hash), [lead.writer], 'the new key went to the lead only');
  const held = (await lead.p.heldCells()).find((item) => item.cell === legacy);
  assert.deepEqual(held?.epochs, [1, 2]);
  assert.deepEqual(held?.label, legacyCellLabel(LEGACY_LABELS), 'the new epoch keeps the legacy label');
});

test('legacy: handing the lead to a cleared member gives their device the legacy cell when it does not hold it', async () => {
  const lead = await leadWith();
  const legacy = made(await ensureLegacyCell(lead.host, LEGACY_LABELS), 'legacy').cell;
  const p = await bringIn(lead, 'p', 'Pat Officer', orgClearance('Restricted'));
  const handed = ok(await handOverLead(lead.host, { to: p.member, reason: 'planned' }), 'hand over');
  assert.ok(handed.message.includes(LEGACY_GIVEN_TEXT), handed.message);
  assert.deepEqual(handed.granted, [legacy]);
  const { roster, hash } = await head(lead.p);
  assert.ok(rosterView(roster).cellGrantees?.(legacy, hash)?.includes(p.writer));
});

test('legacy: ensureLegacyCell with no declared clearance is allowed only for an all org/Public set or an empty one, and a member is refused not-a-roster-writer', async () => {
  const lead = await leadWith({ clearance: null });
  refusedWith(await ensureLegacyCell(lead.host, LEGACY_LABELS), 'not-cleared-for-label');
  made(await ensureLegacyCell(lead.host, [orgLabel('Public')]), 'all public');
  made(await ensureLegacyCell(lead.host, []), 'empty');
  const cleared = await leadWith({ label: 'lead2' });
  const m = await bringIn(cleared, 'm', 'Mo Analyst', orgClearance('Restricted'));
  refusedWith(await ensureLegacyCell(m.host, LEGACY_LABELS), 'not-a-roster-writer');
});

test('heldCells on M (org/Internal) lists the base cell and the org/Internal cell only; findOwnAll returns one entry per matching own entry with its stream; cellLabelTexts names each label cell', async () => {
  const lead = await leadWith();
  const internal = made(await ensureLabelCell(lead.host, orgLabel('Internal')), 'internal').cell;
  const confidential = made(await ensureLabelCell(lead.host, orgLabel('Confidential')), 'confidential').cell;
  const legacy = made(await ensureLegacyCell(lead.host, LEGACY_LABELS), 'legacy').cell;
  const m = await bringIn(lead, 'm', 'Mo Analyst', orgClearance('Internal'));
  const held = await m.p.heldCells();
  assert.deepEqual(held.map((item) => [item.cell, item.base, item.epochs]), [[lead.p.projectId, true, [1]], [internal, false, [1]]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  assert.deepEqual(held.find((item) => item.cell === internal)?.label, orgLabel('Internal'));
  await writeProduct(lead, 'first-estimate', 'org/Internal', 'One.', 1);
  await writeProduct(lead, 'second-estimate', 'org/Internal', 'Two.', 2);
  await writeProduct(lead, 'route-secret', 'org/Confidential', 'Three.', 3);
  const all = await lead.p.findOwnAll('product.create', () => true);
  assert.deepEqual(all.map((item) => [(item.data as { product: string }).product, item.stream]), [['first-estimate', internal], ['second-estimate', internal], ['route-secret', confidential]]);
  const one = await lead.p.findOwnAll('product.create', (data) => (data as { product: string }).product === 'route-secret');
  assert.equal(one.length, 1);
  const texts = await cellLabelTexts(lead.p);
  assert.deepEqual([...texts.entries()].sort(), [[internal, 'org/Internal'], [confidential, 'org/Confidential']].sort());
  assert.ok(!texts.has(lead.p.projectId) && !texts.has(legacy));
});

/** Every hash, name and word a fold result holds, as text (Maps and byte arrays included). */
function foldText(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Map) return [...item.entries()];
    if (item instanceof Set) return [...item.values()];
    if (item instanceof Uint8Array) return Buffer.from(item).toString('base64url');
    return item;
  });
}

test('awaiting-key (D-23): an entry of the org/Confidential cell handed to M waits awaiting-key, and M\'s fold never names it, its product or its text', async () => {
  const w = await world();
  const route = await writeProduct(w.lead, 'route-kestrel', 'org/Confidential', 'Convoy leaves by the north road at first light.');
  const entries = streamEntries(w.lead.at, route.stream);
  assert.ok(entries.length >= 3);
  await syncTo(w.lead, w.m, []);
  const result = await w.m.p.ingestForeign(entries, []);
  assert.ok(!isProjectRefused(result));
  assert.deepEqual(result.waiting.map((item) => item.reason), entries.map(() => 'awaiting-key'));
  const hashes = entries.map((entry) => entryHash(entry.header));
  assert.deepEqual(result.waiting.map((item) => item.hash).sort(), [...hashes].sort());
  const { fold } = await w.m.p.state();
  for (const hash of hashes) {
    assert.ok(!fold.order.includes(hash), 'not in the order');
    assert.ok(!foldText(fold.held).includes(hash), 'not held');
    assert.ok(!foldText(fold.refused).includes(hash), 'not refused');
    assert.ok(!foldText(fold.kept).includes(hash), 'not kept');
  }
  const families = foldText(fold.families);
  for (const word of ['route-kestrel', 'Estimate route-kestrel', 'north road', route.stream]) assert.ok(!families.includes(word), `the fold names nothing of it (${word})`);
  assert.ok(!w.m.p.heldForCheck().some((item) => hashes.includes(item.hash)));
});
