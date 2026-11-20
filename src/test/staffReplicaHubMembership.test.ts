// The hub in the roster (D-22, D-40, D-41, D-64; DESIGN 10.2): the lead admits your organization's hub from the operator's hub file and gives it the
// base cell, can give it more cells after confirming the trade-off, and can revoke it, which moves every cell it held to a new key. Each transition
// and each refusal has a test. The hub's keys come from a label (rosterDevice), the address is fictional and every person is fictional.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readGrant, unwrapEpochKey } from '../domain/replica/cellKeys';
import { signCheckpoint, verifyCheckpoint } from '../domain/replica/checkpoint';
import type { Checkpoint } from '../domain/replica/checkpoint';
import { buildHubFile } from '../domain/replica/hubFile';
import { rosterView } from '../domain/replica/roster';
import type { RosterState } from '../domain/replica/roster';
import { epochsAt } from '../domain/replica/rosterCells';
import { hubAt, hubCellsAt, hubSignerAt } from '../domain/replica/rosterMembers';
import { removeFromProject } from '../staff/replica/membership';
import { admitHub } from '../staff/replica/hubMembership';
import { WORLD_NOW, bringIn, grantsOn, leadWith, ok, orgClearance } from './helpers/labelCellWorld';
import type { Seat } from './helpers/labelCellWorld';
import { rosterDevice } from './helpers/replicaRosterWorld';
import type { RosterDevice } from './helpers/replicaRosterWorld';

const HUB_ADDRESS = 'hub.example.test:8443';
const CERT_PIN = 'b'.repeat(64);
const DAY_MS = 24 * 60 * 60 * 1000;

interface TestHub { device: RosterDevice; text: string; enrolmentSecret: string; certPin: string }

/** A hub file signed by the hub's own key (labels give fixed keys), as the operator prints it, valid for a week from WORLD_NOW unless told. */
function hubFile(label = 'HUB-NORTH', options: { certPin?: string; now?: Date; expiresAt?: string } = {}): TestHub {
  const device = rosterDevice(label, 'hub');
  const now = options.now ?? WORLD_NOW;
  const enrolmentSecret = Buffer.alloc(32, 7).toString('base64url');
  const certPin = options.certPin ?? CERT_PIN;
  const signed = buildHubFile(device.signer, {
    address: HUB_ADDRESS, certPin, x25519: device.x25519, x25519Sig: device.x25519Sig, enrolment: 'enr-00112233aabbccdd', enrolmentSecret,
    expiresAt: options.expiresAt ?? new Date(now.getTime() + 7 * DAY_MS).toISOString(), now
  });
  return { device, text: JSON.stringify(signed), enrolmentSecret, certPin };
}

const hubIdOfDevice = (device: RosterDevice): string => `hub-${device.writer.slice(0, 16)}`;
const head = (roster: RosterState): { hash: string; position: number } => ({ hash: roster.positions[roster.positions.length - 1], position: roster.positions.length - 1 });

/** The epochs of each cell the hub's X25519 private key opens from the grants on the install's disk, each checked against the key the lead holds. */
function hubOpens(seat: Seat, hub: RosterDevice): Map<string, number[]> {
  const opened = new Map<string, number[]>();
  for (const item of grantsOn(seat.at)) {
    const read = readGrant(item.signed);
    if (!read.ok) continue;
    for (const wrap of read.grant.wraps) {
      if (wrap.writer !== hub.writer) continue;
      const key = unwrapEpochKey({ cell: read.grant.cell, epoch: read.grant.epoch, writer: hub.writer, privateKey: hub.x25519Private, wrap: wrap.wrap });
      if (key === undefined) continue;
      const held = seat.p.keys.epochKey(read.grant.cell, read.grant.epoch);
      if (held !== undefined) assert.ok(key.equals(held), 'the hub opens the same key the lead holds');
      const list = opened.get(read.grant.cell) ?? [];
      if (!list.includes(read.grant.epoch)) list.push(read.grant.epoch);
      opened.set(read.grant.cell, list.sort((a, b) => a - b));
    }
  }
  return opened;
}

/** A checkpoint over the project signed by the hub's key, citing the roster head. */
function hubCheckpoint(hub: RosterDevice, project: string, rosterHead: string): ReturnType<typeof signCheckpoint> {
  const checkpoint: Checkpoint = { type: 'checkpoint', v: 2, project, signer: hub.writer, rosterHead, streams: [] };
  return signCheckpoint(hub.signer, checkpoint);
}

// ---- Task 1: admission ----------------------------------------------------------------------------------------------------------------------------

test('tracer: the lead admits the hub from its hub file; the result names the hub and holds no secret', async () => {
  const lead = await leadWith();
  const hub = hubFile();
  const result = ok(await admitHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }), 'admit the hub');
  const id = hubIdOfDevice(hub.device);
  assert.ok(result.message.includes(id), 'the message names the hub');
  assert.ok(result.message.includes(HUB_ADDRESS), 'the message names its address');
  assert.equal(result.hub, id);
  assert.equal(result.writer, hub.device.writer);
  const text = JSON.stringify(result);
  for (const secret of [hub.enrolmentSecret, hub.device.x25519Sig, hub.device.publicKey, hub.device.x25519]) assert.equal(text.includes(secret), false, 'no key or secret in the result');
});

test('the roster at head has the hub with the file\'s pin and the ceiling, its device of kind hub in the next free slot, and it signs checkpoints', async () => {
  const lead = await leadWith();
  const before = (await lead.p.state()).roster;
  const usedSlots = [...before.members.slots.keys()];
  const hub = hubFile();
  ok(await admitHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }), 'admit the hub');
  const { roster } = await lead.p.state();
  const at = head(roster);
  const id = hubIdOfDevice(hub.device);
  const record = hubAt(roster.members, id, at.position);
  assert.ok(record !== undefined, 'the hub is in the roster at head');
  assert.equal(record.certPin, hub.certPin);
  assert.deepEqual(record.ceiling, orgClearance('Internal'));
  const device = roster.members.devices.get(hub.device.writer)?.at(-1);
  assert.equal(device?.kind, 'hub');
  assert.equal(device?.member, id);
  let expected = 1;
  while (usedSlots.includes(expected)) expected += 1;
  assert.equal(device?.slot, expected, 'the smallest slot never given');
  assert.equal(roster.members.slots.get(expected), hub.device.writer);
  assert.equal(hubSignerAt(roster.members, hub.device.writer, at.position), true);
  const verdict = verifyCheckpoint(hubCheckpoint(hub.device, lead.p.projectId, at.hash), rosterView(roster));
  assert.equal(verdict.ok, true, `the hub's checkpoint verifies: ${verdict.ok ? '' : verdict.reason}`);
});

test('the hub\'s key opens every base cell epoch from the stored grants and no other cell\'s key', async () => {
  const lead = await leadWith();
  const member = await bringIn(lead, 'member', 'Nell Planner', orgClearance('Internal'));
  // A removal before the hub arrives gives the base cell a second epoch, so admission must grant both.
  ok(await removeFromProject(lead.host, { member: member.member }), 'remove a member');
  const { ensureLabelCell } = await import('../staff/replica/labelCells');
  const made = await ensureLabelCell(lead.host, 'org/Internal');
  assert.equal(made.ok, true);
  const hub = hubFile();
  ok(await admitHub(lead.host, hub.text, { ceiling: orgClearance('Confidential') }), 'admit the hub');
  const { roster } = await lead.p.state();
  const base = lead.p.projectId;
  const epochs = epochsAt(roster.cells, base, head(roster).position).map((item) => item.epoch);
  assert.ok(epochs.length >= 2, 'the base cell has more than one epoch');
  assert.deepEqual([...hubOpens(lead, hub.device).entries()], [[base, epochs]], 'the base cell only, every epoch');
});

test('admission writes hub.admit, hub.grant for the base cell, then the base cell grants, in that order (D-64)', async () => {
  const lead = await leadWith();
  const hub = hubFile();
  ok(await admitHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }), 'admit the hub');
  const admits = await lead.p.findOwnAll('hub.admit', () => true);
  const grants = await lead.p.findOwnAll('hub.grant', () => true);
  assert.equal(admits.length, 1);
  assert.equal(grants.length, 1);
  assert.ok(admits[0].seq < grants[0].seq, 'hub.admit comes first');
  assert.equal((grants[0].data as { cell: string }).cell, lead.p.projectId);
  const { roster } = await lead.p.state();
  const grantPosition = roster.positionOf.get(grants[0].hash) as number;
  const base = roster.cells.cells.get(lead.p.projectId);
  const toHub = base?.grants.filter((grant) => grant.writers.includes(hub.device.writer)) ?? [];
  assert.ok(toHub.length > 0);
  for (const grant of toHub) assert.equal(grant.grant.roster, grants[0].hash, `the grant names the hub.grant roster (position ${grantPosition})`);
});

test('base cell rekey: hubCellsAt lists the base cell, and after a member is removed the new base epoch is wrapped to the hub too', async () => {
  const lead = await leadWith();
  const member = await bringIn(lead, 'member', 'Nell Planner', orgClearance('Internal'));
  const hub = hubFile();
  ok(await admitHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }), 'admit the hub');
  const before = (await lead.p.state()).roster;
  assert.deepEqual(hubCellsAt(before.members, hubIdOfDevice(hub.device), head(before).position), [lead.p.projectId]);
  const epochBefore = epochsAt(before.cells, lead.p.projectId, head(before).position).length;
  const removed = ok(await removeFromProject(lead.host, { member: member.member }), 'remove the member');
  assert.ok(removed.rekeyed?.includes(lead.p.projectId), 'the base cell moved to a new key');
  const { roster } = await lead.p.state();
  const epochs = epochsAt(roster.cells, lead.p.projectId, head(roster).position).map((item) => item.epoch);
  assert.equal(epochs.length, epochBefore + 1);
  assert.deepEqual(hubOpens(lead, hub.device).get(lead.p.projectId), epochs, 'the hub opens the new epoch too');
});
