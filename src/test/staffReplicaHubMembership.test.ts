// The hub in the roster (D-22, D-40, D-41, D-64; DESIGN 10.2): the lead admits your organization's hub from the operator's hub file and gives it the
// base cell, can give it more cells after confirming the trade-off, and can revoke it, which moves every cell it held to a new key. Each transition
// and each refusal has a test. The hub's keys come from a label (rosterDevice), the address is fictional and every person is fictional.
import assert from 'node:assert/strict';
import test from 'node:test';
import { REKEY_KEEP_TEXT, openLabel, readGrant, unwrapEpochKey } from '../domain/replica/cellKeys';
import { signCheckpoint, verifyCheckpoint } from '../domain/replica/checkpoint';
import type { Checkpoint } from '../domain/replica/checkpoint';
import { buildHubFile } from '../domain/replica/hubFile';
import { rosterView } from '../domain/replica/roster';
import type { RosterState } from '../domain/replica/roster';
import { epochsAt } from '../domain/replica/rosterCells';
import { hubAt, hubCellsAt, hubSignerAt } from '../domain/replica/rosterMembers';
import { finishRekeys, nameDeputy, removeFromProject } from '../staff/replica/membership';
import { HUB_GRANT_TRADE_OFF, HUB_MEMBERSHIP_REFUSALS, admitHub, grantCellToHub, revokeHub } from '../staff/replica/hubMembership';
import { ensureLabelCell, ensureLegacyCell } from '../staff/replica/labelCells';
import { WORLD_NOW, bringIn, grantsOn, leadWith, ok, orgClearance, orgLabel, streamEntries, syncTo } from './helpers/labelCellWorld';
import type { Install, Seat } from './helpers/labelCellWorld';
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

/** What the store holds that a flow could write: the base stream's entries and every grant file. */
function storeCounts(at: Install, project: string): { entries: number; grants: number } {
  return { entries: streamEntries(at, project).length, grants: grantsOn(at).length };
}

/** A label cell made by the lead (org/Internal unless named). */
async function labelCell(lead: Seat, level: 'Public' | 'Internal' | 'Confidential' = 'Internal'): Promise<string> {
  const made = await ensureLabelCell(lead.host, `org/${level}`);
  assert.equal(made.ok, true, `the ${level} cell is made`);
  return (made as { cell: string }).cell;
}

/** A lead with the hub admitted (ceiling org/Internal unless named). */
async function leadAndHub(ceiling: 'Internal' | 'Confidential' = 'Internal'): Promise<{ lead: Seat; hub: TestHub; id: string }> {
  const lead = await leadWith();
  const hub = hubFile();
  ok(await admitHub(lead.host, hub.text, { ceiling: orgClearance(ceiling) }), 'admit the hub');
  return { lead, hub, id: hubIdOfDevice(hub.device) };
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

// ---- Task 2: giving the hub a cell, and revoking it ---------------------------------------------------------------------------------------------

test('the trade-off sentence is the one from DESIGN 10.2, word for word', () => {
  assert.equal(HUB_GRANT_TRADE_OFF, 'The hub will be able to read everything in this cell. Anyone who takes over the hub server can read it too. Grant only cells whose watches must run when nobody is at a computer.');
});

test('trade-off: without the lead confirming it, grantCellToHub is refused trade-off-not-confirmed and writes nothing', async () => {
  const { lead } = await leadAndHub();
  const cell = await labelCell(lead);
  const before = storeCounts(lead.at, lead.p.projectId);
  for (const confirmed of [false, undefined, 'yes', 1]) {
    const result = await grantCellToHub(lead.host, { cell, confirmed: confirmed as boolean });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'trade-off-not-confirmed');
    assert.equal(result.message, HUB_MEMBERSHIP_REFUSALS['trade-off-not-confirmed']);
  }
  assert.deepEqual(storeCounts(lead.at, lead.p.projectId), before);
});

test('trade-off confirmed: hub.grant and one grant per epoch of the cell with its label sealed; the notices carry the sentence and the hub opens the cell', async () => {
  const { lead, hub, id } = await leadAndHub();
  const member = await bringIn(lead, 'member', 'Nell Planner', orgClearance('Internal'));
  const cell = await labelCell(lead);
  // A second epoch of the cell, so every epoch is granted, not only the newest.
  ok(await removeFromProject(lead.host, { member: member.member }), 'remove a member');
  const result = ok(await grantCellToHub(lead.host, { cell, confirmed: true }), 'grant the cell');
  assert.ok(result.notices.includes(HUB_GRANT_TRADE_OFF), 'the result carries the trade-off sentence');
  assert.deepEqual(result.granted, [cell]);
  assert.equal(result.hub, id);
  const { roster } = await lead.p.state();
  const at = head(roster);
  assert.deepEqual(hubCellsAt(roster.members, id, at.position), [lead.p.projectId, cell]);
  const epochs = epochsAt(roster.cells, cell, at.position).map((item) => item.epoch);
  assert.ok(epochs.length >= 2);
  assert.deepEqual(hubOpens(lead, hub.device).get(cell), epochs, 'the hub opens every epoch of the cell');
  const toHub = roster.cells.cells.get(cell)?.grants.filter((grant) => grant.writers.includes(hub.device.writer)) ?? [];
  assert.equal(toHub.length, epochs.length);
  for (const grant of toHub) {
    const key = lead.p.keys.epochKey(cell, grant.epoch) as Buffer;
    assert.deepEqual(openLabel(key, cell, grant.epoch, grant.grant.labelSealed), { scale: 'org', level: 'Internal', compartments: [], releasability: [], handling: [] }, 'the label is sealed');
  }
});

test('above-hub-ceiling: a cell whose label the hub\'s ceiling does not dominate is refused and nothing is written', async () => {
  const { lead } = await leadAndHub('Internal');
  const cell = await labelCell(lead, 'Confidential');
  const before = storeCounts(lead.at, lead.p.projectId);
  const result = await grantCellToHub(lead.host, { cell, confirmed: true });
  assert.equal(result.reason, 'above-hub-ceiling');
  assert.equal(result.message, HUB_MEMBERSHIP_REFUSALS['above-hub-ceiling']);
  assert.deepEqual(storeCounts(lead.at, lead.p.projectId), before);
});

test('no-grant-key: the deputy, below a cell, cannot give the hub that cell; nothing is written', async () => {
  const lead = await leadWith();
  const deputy = await bringIn(lead, 'deputy', 'Dana Deputy', orgClearance('Internal'));
  ok(await nameDeputy(lead.host, deputy.member), 'name the deputy');
  const hub = hubFile();
  ok(await admitHub(lead.host, hub.text, { ceiling: orgClearance('Confidential') }), 'admit the hub');
  const cell = await labelCell(lead, 'Confidential');
  await syncTo(lead, deputy);
  const before = storeCounts(deputy.at, deputy.p.projectId);
  const result = await grantCellToHub(deputy.host, { cell, confirmed: true });
  assert.equal(result.reason, 'no-grant-key');
  assert.deepEqual(storeCounts(deputy.at, deputy.p.projectId), before);
});

test('legacy-cell: the lead-only legacy cell is never given to the hub, even with the trade-off confirmed; nothing is written', async () => {
  const { lead, hub } = await leadAndHub('Confidential');
  const legacy = await ensureLegacyCell(lead.host, ['org/Internal']);
  assert.equal(legacy.ok, true);
  const cell = (legacy as { cell: string }).cell;
  const before = storeCounts(lead.at, lead.p.projectId);
  for (const confirmed of [true, false]) {
    const result = await grantCellToHub(lead.host, { cell, confirmed });
    assert.equal(result.reason, 'legacy-cell', 'refused as the legacy cell before any other check');
    assert.match(result.message, /stays with the staff lead and the deputy lead/);
  }
  assert.deepEqual(storeCounts(lead.at, lead.p.projectId), before);
  assert.equal(hubOpens(lead, hub.device).has(cell), false);
});

test('the base cell is refused as already held by the hub; nothing is written', async () => {
  const { lead } = await leadAndHub();
  const before = storeCounts(lead.at, lead.p.projectId);
  const result = await grantCellToHub(lead.host, { cell: lead.p.projectId, confirmed: true });
  assert.equal(result.reason, 'hub-holds-cell');
  assert.deepEqual(storeCounts(lead.at, lead.p.projectId), before);
});

test('a member removed from a cell the hub holds: the rekey still wraps the new epoch to the hub', async () => {
  const { lead, hub } = await leadAndHub();
  const member = await bringIn(lead, 'member', 'Nell Planner', orgClearance('Internal'));
  const cell = await labelCell(lead);
  ok(await grantCellToHub(lead.host, { cell, confirmed: true }), 'grant the cell');
  const removed = ok(await removeFromProject(lead.host, { member: member.member }), 'remove the member');
  assert.ok(removed.rekeyed?.includes(cell));
  const { roster } = await lead.p.state();
  const epochs = epochsAt(roster.cells, cell, head(roster).position).map((item) => item.epoch);
  assert.deepEqual(hubOpens(lead, hub.device).get(cell), epochs, 'the hub opens the new epoch');
});

test('revoke: hub.revoke, then the base cell and every granted cell move to a new key without the hub; its checkpoints are refused after', async () => {
  const { lead, hub, id } = await leadAndHub();
  const cell = await labelCell(lead);
  ok(await grantCellToHub(lead.host, { cell, confirmed: true }), 'grant the cell');
  const opened = hubOpens(lead, hub.device);
  const result = ok(await revokeHub(lead.host, { hub: id }), 'revoke the hub');
  assert.deepEqual([...(result.rekeyed ?? [])].sort(), [lead.p.projectId, cell].sort());
  assert.ok(result.message.endsWith(REKEY_KEEP_TEXT), 'says they keep what they already received');
  assert.ok(result.message.includes(id));
  assert.equal(result.hub, id);
  const { roster } = await lead.p.state();
  const at = head(roster);
  assert.equal(hubAt(roster.members, id, at.position), undefined, 'the hub is no longer in force');
  assert.deepEqual(hubOpens(lead, hub.device), opened, 'the hub opens nothing new');
  const verdict = verifyCheckpoint(hubCheckpoint(hub.device, lead.p.projectId, at.hash), rosterView(roster));
  assert.equal(verdict.ok, false);
  assert.equal((verdict as { reason: string }).reason, 'not-a-checkpoint-signer');
  const reasons = (await lead.p.findOwnAll('cell.rekey', () => true)).map((item) => (item.data as { reason: string }).reason);
  assert.deepEqual(reasons, ['hub-revoked', 'hub-revoked']);
});

test('revoke interrupted after hub.revoke is finished by finishRekeys with the reason hub-revoked', async () => {
  const { lead, hub, id } = await leadAndHub();
  const cell = await labelCell(lead);
  ok(await grantCellToHub(lead.host, { cell, confirmed: true }), 'grant the cell');
  const written = await lead.p.appendOwn('hub.revoke', { hub: id });
  assert.equal('ok' in written && written.ok, true, 'the revoke alone is written, as if the computer stopped before the rekeys');
  const finished = ok(await finishRekeys(lead.host), 'the next roster flow finishes it');
  assert.deepEqual([...(finished.rekeyed ?? [])].sort(), [lead.p.projectId, cell].sort());
  const reasons = (await lead.p.findOwnAll('cell.rekey', () => true)).map((item) => (item.data as { reason: string }).reason);
  assert.deepEqual(reasons, ['hub-revoked', 'hub-revoked']);
  const { roster } = await lead.p.state();
  const epochs = epochsAt(roster.cells, cell, head(roster).position).map((item) => item.epoch);
  assert.equal(hubOpens(lead, hub.device).get(cell)?.includes(epochs[epochs.length - 1] as number), false);
});

test('revoke again after an interrupted revoke finishes the rekeys; a revoke with nothing left is refused hub-revoked', async () => {
  const { lead, id } = await leadAndHub();
  const written = await lead.p.appendOwn('hub.revoke', { hub: id });
  assert.equal('ok' in written && written.ok, true, 'the revoke alone is written');
  const again = ok(await revokeHub(lead.host, { hub: id }), 'revoke again');
  assert.deepEqual(again.rekeyed, [lead.p.projectId]);
  assert.ok(again.message.endsWith(REKEY_KEEP_TEXT));
  const before = storeCounts(lead.at, lead.p.projectId);
  const third = await revokeHub(lead.host, { hub: id });
  assert.equal(third.reason, 'hub-revoked');
  assert.deepEqual(storeCounts(lead.at, lead.p.projectId), before);
});
