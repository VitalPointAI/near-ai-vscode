// The label leak test on real installs (plan 32-13; 32-CONTEXT D-15, D-16, D-23, D-24). Two compartments of one level: cell A {org, Confidential,
// [KESTREL]} and cell B {org, Confidential, [OSPREY]}. The lead is declared cleared for both; member X for A only (admitted before the cells exist)
// and member Y for B only (admitted after). Cells and products are made through ensureLabelCell, appendProductEntry and proposeVersion, the paths
// the real flows use. Canaries (a product name, its title, a phrase of its text, its label token and a decision reason) are searched byte for byte,
// as UTF-8 and as base64 and base64url at each of the three byte offsets, everywhere a member below a cell can look; positive controls show the same
// search finds them where they belong. Fictional exercise data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readGrant } from '../domain/replica/cellKeys';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, docText, localInsert, snapshotOf } from '../domain/replica/doc';
import type { Label } from '../domain/gate/labels';
import { rosterView } from '../domain/replica/roster';
import { epochsAt } from '../domain/replica/rosterCells';
import { appendProductEntry, ensureLabelCell, proposeVersion } from '../staff/replica/labelCells';
import { bringIn, grantsOn, leadWith, syncTo } from './helpers/labelCellWorld';
import type { Seat } from './helpers/labelCellWorld';

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
