// The hub in the roster (D-22, D-40, D-41, D-64; DESIGN 10.2): the lead admits your organization's hub from the operator's hub file and gives it the
// base cell, can give it more cells after confirming the trade-off, and can revoke it, which moves every cell it held to a new key. Each transition
// and each refusal has a test. The hub's keys come from a label (rosterDevice), the address is fictional and every person is fictional.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import test, { mock } from 'node:test';
import { createHash } from 'node:crypto';
import { REKEY_KEEP_TEXT, openLabel, readGrant } from '../domain/replica/cellKeys';
import { kemPrivateFromSeeds, kemPublicFromSeeds, unwrapForDevice } from '../domain/replica/cellWrapV2';
import type { KemSeeds } from '../domain/replica/cellWrapV2';
import { signKemBinding } from '../domain/replica/deviceKem';
import { signCheckpoint, verifyCheckpoint } from '../domain/replica/checkpoint';
import type { Checkpoint } from '../domain/replica/checkpoint';
import { HUB_FILE_REFUSALS, buildHubFile, certPinOf, enrolmentMac } from '../domain/replica/hubFile';
import { entryHash } from '../domain/replica/entry';
import type { SealedEntry } from '../domain/replica/entry';
import { checkHubJoinMac, hubJoinCheckKey, joinSecretHash, readHubJoin, readInvite } from '../domain/replica/invite';
import { PREVIEW_WAY_FORWARD_TEXT, baseCellHeldProducts } from '../domain/replica/productCells';
import { rosterView } from '../domain/replica/roster';
import type { RosterState } from '../domain/replica/roster';
import { epochsAt } from '../domain/replica/rosterCells';
import { hubAt, hubCellsAt, hubSignerAt } from '../domain/replica/rosterMembers';
import { admitJoinRequest, finishRekeys, inviteToProject, joinFromInvite, nameDeputy, removeFromProject, reviewJoinRequest, updateMember } from '../staff/replica/membership';
import type { MembershipResult } from '../staff/replica/membership';
import { signPayload } from '../domain/team/signedPayload';
import { term } from '../domain/org/terms';
import { HUB_GRANT_TRADE_OFF, HUB_MEMBERSHIP_REFUSALS, HUB_NOT_TOLD_TEXT, admitHub, connectProjectToHub, fetchJoinRequests, grantCellToHub, hubStanding, inviteThroughHub, revokeHub, sendJoinRequestThroughHub } from '../staff/replica/hubMembership';
import { HubTransport, enrolmentRequest } from '../staff/replica/hubTransport';
import type { HubTransportOptions } from '../staff/replica/hubTransport';
import { FIXTURE_CERT, FakeHubServer } from './helpers/fakeHubServer';
import type { FakeAnswer, FakeRequest } from './helpers/fakeHubServer';
import { appendProductEntry, ensureLabelCell, ensureLegacyCell } from '../staff/replica/labelCells';
import { ReplicaProjectError } from '../staff/replica/replicaProject';
import { STORE_REFUSALS } from '../staff/replica/store';
import { WORLD_NOW, bringIn, grantsOn, install, leadWith, ok, orgClearance, streamEntries, syncTo } from './helpers/labelCellWorld';
import type { Install, Seat } from './helpers/labelCellWorld';
import { rosterDevice } from './helpers/replicaRosterWorld';
import type { RosterDevice } from './helpers/replicaRosterWorld';

const HUB_ADDRESS = 'hub.example.test:8443';
const CERT_PIN = 'b'.repeat(64);
const DAY_MS = 24 * 60 * 60 * 1000;
const PRODUCT_ROLES = { owner: 'j4-planner', sectionLead: 'j4-lead', releaseGuard: 'j4-guard' };

interface TestHub { device: RosterDevice; text: string; enrolmentSecret: string; certPin: string }

// The hub's post-quantum keys (33.2 D-03), fixed by its label like its other keys: a hub made with --generate-key kem carries them in its hub file.
const hubKemSeeds = (device: RosterDevice): KemSeeds => ({ p256: createHash('sha256').update(`hub kem p256/${device.label}`).digest(), mlkem768: createHash('sha512').update(`hub kem mlkem/${device.label}`).digest() });
const hubKem = (device: RosterDevice) => signKemBinding(kemPublicFromSeeds(hubKemSeeds(device)), device.writer, (bytes) => device.signer.sign(bytes));

/** A hub file signed by the hub's own key (labels give fixed keys), as the operator prints it, valid for a week from WORLD_NOW unless told. */
function hubFile(label = 'HUB-NORTH', options: { certPin?: string; now?: Date; expiresAt?: string; legacy?: boolean } = {}): TestHub {
  const device = rosterDevice(label, 'hub');
  const now = options.now ?? WORLD_NOW;
  const enrolmentSecret = Buffer.alloc(32, 7).toString('base64url');
  const certPin = options.certPin ?? CERT_PIN;
  const signed = buildHubFile(device.signer, {
    address: HUB_ADDRESS, certPin, x25519: device.x25519, x25519Sig: device.x25519Sig, enrolment: 'enr-00112233aabbccdd', enrolmentSecret,
    expiresAt: options.expiresAt ?? new Date(now.getTime() + 7 * DAY_MS).toISOString(), now,
    ...(options.legacy ? {} : { kem: hubKem(device) })
  });
  return { device, text: JSON.stringify(signed), enrolmentSecret, certPin };
}

const hubIdOfDevice = (device: RosterDevice): string => `hub-${device.writer.slice(0, 16)}`;
const head = (roster: RosterState): { hash: string; position: number } => ({ hash: roster.positions[roster.positions.length - 1], position: roster.positions.length - 1 });

/** The epochs of each cell the hub's keys open from the grants on the install's disk (v1 or v2 wraps), each checked against the key the lead holds. */
function hubOpens(seat: Seat, hub: RosterDevice): Map<string, number[]> {
  const opened = new Map<string, number[]>();
  for (const item of grantsOn(seat.at)) {
    const read = readGrant(item.signed);
    if (!read.ok) continue;
    for (const wrap of read.grant.wraps) {
      if (wrap.writer !== hub.writer) continue;
      const key = unwrapForDevice({ cell: read.grant.cell, epoch: read.grant.epoch, writer: hub.writer, x25519: hub.x25519Private, kem: kemPrivateFromSeeds(hubKemSeeds(hub)), wrap: wrap.wrap });
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

test('a hub without hybrid keys cannot be given a new post-quantum cell', async () => {
  const lead = await leadWith();
  const hub = hubFile('legacy', { legacy: true });
  ok(await admitHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }), 'admit the hub with the original base cell');
  const cell = await labelCell(lead);
  const before = storeCounts(lead.at, lead.p.projectId);
  const result = await grantCellToHub(lead.host, { cell, confirmed: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'hub-needs-post-quantum-keys');
  assert.deepEqual(storeCounts(lead.at, lead.p.projectId), before);
});

test('admitting a hub without hybrid keys fails before writing when the base cell has a post-quantum epoch', async () => {
  const lead = await leadWith();
  const member = await bringIn(lead, 'member', 'Nell Planner', orgClearance('Internal'));
  ok(await removeFromProject(lead.host, { member: member.member }), 'move the base cell to a new epoch');
  const hub = hubFile('legacy', { legacy: true });
  const before = storeCounts(lead.at, lead.p.projectId);
  const result = await admitHub(lead.host, hub.text, { ceiling: orgClearance('Internal') });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'hub-needs-post-quantum-keys');
  assert.deepEqual(storeCounts(lead.at, lead.p.projectId), before);
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
  assert.ok(result.message.includes('Devices excluded from the new keys cannot read work encrypted with those keys.'));
  assert.doesNotMatch(result.message, /anything new/);
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

for (const failure of ['pre-write', 'confirmation', 'recovery signature'] as const) {
  test(`hub revoke reports the verified stage when the project refuses ${failure}`, async () => {
    const { lead, id } = await leadAndHub();
    const { p } = lead;
    const before = head((await p.state()).roster);
    const refusal = new ReplicaProjectError({ refused: 'store-refused', message: STORE_REFUSALS.unreadable, store: 'unreadable' });
    const append = p.appendOwn.bind(p);
    const state = p.state.bind(p);
    const pages = p.signGrantPages.bind(p);
    const attempts: string[] = [];
    let saved: string | undefined;
    let readsAfterSave = 0;
    const appendMock = mock.method(p, 'appendOwn', async (...args: Parameters<typeof append>) => {
      attempts.push(args[0]);
      if (failure === 'pre-write') throw refusal;
      const result = await append(...args);
      if ('ok' in result && args[0] === 'hub.revoke') saved = result.hash;
      return result;
    });
    const stateMock = mock.method(p, 'state', async () => {
      if (saved !== undefined) readsAfterSave += 1;
      if (saved !== undefined && failure === 'confirmation') throw refusal;
      return state();
    });
    const signMock = mock.method(p, 'signGrantPages', async (...args: Parameters<typeof pages>) => {
      if (failure === 'recovery signature') throw refusal;
      return pages(...args);
    });
    const result = await revokeHub(lead.host, { hub: id }).finally(() => {
      appendMock.mock.restore();
      stateMock.mock.restore();
      signMock.mock.restore();
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'store-refused');
    assert.deepEqual(attempts, ['hub.revoke']);
    const { roster } = await p.state();
    const after = head(roster);
    if (failure === 'pre-write') {
      assert.equal(result.message, STORE_REFUSALS.unreadable);
      assert.ok(hubAt(roster.members, id, after.position));
      assert.equal(after.hash, before.hash);
      return;
    }
    assert.ok(saved);
    assert.equal(after.hash, saved);
    assert.equal(after.position, before.position + 1);
    assert.equal(hubAt(roster.members, id, after.position), undefined);
    assert.deepEqual(epochsAt(roster.cells, p.projectId, after.position).map(({ epoch }) => epoch), [1]);
    assert.match(result.message, /Check that the folder and its files can be read by your user account/);
    assert.doesNotMatch(result.message, /Nothing was changed|moved to a new key/);
    if (failure === 'confirmation') {
      assert.equal(readsAfterSave, 1);
      assert.match(result.message, /^The signed change was saved\. This computer could not confirm whether it applied to the roster\./);
      assert.doesNotMatch(result.message, /was removed|may still read|Devices excluded/);
    } else {
      assert.ok(result.message.includes(`The hub (${id}) was removed. This computer could not verify all the required new keys.`));
      assert.match(result.message, /may still read new work encrypted with them/);
    }
    assert.deepEqual(ok(await finishRekeys(lead.host), 'recover after the fault').rekeyed, [p.projectId]);
  });
}

test('revoke interrupted after hub.revoke is finished by finishRekeys with the reason hub-revoked', async () => {
  const { lead, hub, id } = await leadAndHub();
  const cell = await labelCell(lead);
  ok(await grantCellToHub(lead.host, { cell, confirmed: true }), 'grant the cell');
  const append = lead.p.appendOwn.bind(lead.p);
  lead.p.appendOwn = (kind, data, options) => kind === 'cell.rekey'
    ? Promise.resolve({ refused: 'store-refused', message: 'The test refused the hub key change.' }) : append(kind, data, options);
  const interrupted = await revokeHub(lead.host, { hub: id }).finally(() => { lead.p.appendOwn = append; });
  const afterRevoke = await lead.p.state();
  assert.equal(hubAt(afterRevoke.roster.members, id, head(afterRevoke.roster).position), undefined, 'only the revoke has applied');
  assert.equal(interrupted.reason, 'store-refused');
  assert.match(interrupted.message, /The test refused the hub key change/);
  assert.ok(interrupted.message.includes('Until the affected parts have verified new keys, devices that held the old keys may still read new work encrypted with them.'));
  assert.doesNotMatch(interrupted.message, /moved to a new key|anything new/);
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
  const beforeRecovery = storeCounts(lead.at, lead.p.projectId);
  const signature = mock.method(lead.p, 'signGrantPages', async () => {
    throw new ReplicaProjectError({ refused: 'signer-refused', message: 'The test refused the replacement key signature.' });
  });
  const failed = await revokeHub(lead.host, { hub: id }).finally(() => signature.mock.restore());
  assert.equal(failed.reason, 'signer-refused');
  assert.match(failed.message, /was already removed/);
  assert.match(failed.message, /may still read new work encrypted with them/);
  assert.match(failed.message, /The test refused the replacement key signature/);
  assert.deepEqual(storeCounts(lead.at, lead.p.projectId), beforeRecovery);
  const again = ok(await revokeHub(lead.host, { hub: id }), 'revoke again');
  assert.deepEqual(again.rekeyed, [lead.p.projectId]);
  assert.ok(again.message.endsWith(REKEY_KEEP_TEXT));
  assert.ok(again.message.includes('Devices excluded from the new keys cannot read work encrypted with those keys.'));
  const before = storeCounts(lead.at, lead.p.projectId);
  const third = await revokeHub(lead.host, { hub: id });
  assert.equal(third.reason, 'hub-revoked');
  assert.deepEqual(storeCounts(lead.at, lead.p.projectId), before);
});

test('retrying an already finished hub revoke does not claim a later unrelated recovery for the hub', async () => {
  const { lead, id } = await leadAndHub();
  const member = await bringIn(lead, 'later-removal', 'Nell Planner', orgClearance('Internal'));
  ok(await revokeHub(lead.host, { hub: id }), 'revoke the hub');
  assert.ok('ok' in await lead.p.appendOwn('member.remove', { member: member.member }));
  const retry = ok(await revokeHub(lead.host, { hub: id }), 'finish outstanding rotations');
  assert.deepEqual(retry.rekeyed, [lead.p.projectId]);
  assert.match(retry.message, /was already removed/);
  assert.doesNotMatch(retry.message, /moved to a new key|Devices excluded from the new keys/);
});

// ---- Task 3: refusals before any write, resumable admission, standing, no secrets ------------------------------------------------------------

/** Admission is refused with the reason, and the install's store is as it was (base stream entries and grant files). */
async function refusedUnchanged(seat: Seat, text: unknown, reason: string, ceiling: unknown = orgClearance('Internal')): Promise<MembershipResult> {
  const before = storeCounts(seat.at, seat.p.projectId);
  const result = await admitHub(seat.host, text, { ceiling });
  assert.equal(result.ok, false);
  assert.equal(result.reason, reason);
  assert.deepEqual(storeCounts(seat.at, seat.p.projectId), before, 'nothing was written');
  return result;
}

test('not-a-roster-writer: a member\'s device cannot admit the hub; nothing is written', async () => {
  const lead = await leadWith();
  const member = await bringIn(lead, 'member', 'Nell Planner', orgClearance('Internal'));
  await refusedUnchanged(member, hubFile().text, 'not-a-roster-writer');
});

test('roster-split: admission waits until a branch is chosen; nothing is written', async () => {
  const lead = await leadWith();
  const deputy = await bringIn(lead, 'deputy', 'Dana Deputy', orgClearance('Internal'));
  ok(await nameDeputy(lead.host, deputy.member), 'name the deputy');
  await syncTo(lead, deputy);
  ok(await updateMember(lead.host, { member: deputy.member, name: 'Dana One' }), 'the lead changes a name');
  ok(await updateMember(deputy.host, { member: deputy.member, name: 'Dana Two' }), 'the deputy changes it too');
  await syncTo(deputy, lead);
  assert.equal((await lead.p.state()).roster.pending.length, 1, 'the roster is split');
  await refusedUnchanged(lead, hubFile().text, 'roster-split');
});

test('an expired hub file is refused with the reader\'s sentence; nothing is written', async () => {
  const lead = await leadWith();
  const expired = hubFile('HUB-NORTH', { now: new Date(WORLD_NOW.getTime() - 8 * DAY_MS), expiresAt: new Date(WORLD_NOW.getTime() - DAY_MS).toISOString() });
  const result = await refusedUnchanged(lead, expired.text, 'expired');
  assert.equal(result.message, HUB_FILE_REFUSALS.expired);
});

test('a hub file with a changed byte is refused bad-signature; nothing is written', async () => {
  const lead = await leadWith();
  const parsed = JSON.parse(hubFile().text) as { payload: { certPin: string } };
  parsed.payload.certPin = `${parsed.payload.certPin.slice(0, -1)}c`;
  await refusedUnchanged(lead, JSON.stringify(parsed), 'bad-signature');
});

test('a hub file signed by another hub key than the one it names is refused bad-signature; nothing is written', async () => {
  const lead = await leadWith();
  const named = JSON.parse(hubFile('HUB-NORTH').text) as { payload: unknown };
  const other = rosterDevice('HUB-SOUTH', 'hub');
  const forged = signPayload(other.signer, 'staff-hub-file', named.payload, { now: () => WORLD_NOW });
  await refusedUnchanged(lead, JSON.stringify(forged), 'bad-signature');
});

test('a ceiling that is not a clearance is refused ceiling-invalid; nothing is written', async () => {
  const lead = await leadWith();
  await refusedUnchanged(lead, hubFile().text, 'ceiling-invalid', { scale: 'org', level: 'Topmost', compartments: [], releasability: [] });
  await refusedUnchanged(lead, hubFile().text, 'ceiling-invalid', 'org/Internal');
});

test('base-cell-held-products: a project made shared the 0.4.35 way, its products in the base stream, is refused with the D-22 sentence', async () => {
  const lead = await leadWith();
  // The 0.4.35 preview wrote products into the base cell; the host's appendOwn writes there when no stream is named.
  const written = await lead.p.appendOwn('product.create', { product: 'fuel-estimate', section: 'j4', roles: { ...PRODUCT_ROLES }, title: 'Fuel estimate' });
  assert.equal('ok' in written && written.ok, true);
  const { fold } = await lead.p.state();
  assert.equal(baseCellHeldProducts(fold, lead.p.projectId), true, 'the base stream holds a product');
  const result = await refusedUnchanged(lead, hubFile().text, 'base-cell-held-products');
  assert.equal(result.message, 'This project was made shared by an earlier preview, and its products sit in the part of the project the hub must read. Make a single-machine copy and make that copy multi-user again; the new shared project keeps each product in its own part.');
  assert.equal(result.message, PREVIEW_WAY_FORWARD_TEXT);
});

test('base-cell-held-products: a whole legacy import in the base stream is refused too; nothing is written', async () => {
  const lead = await leadWith();
  const written = await lead.p.appendOwn('project.import', { ledger: 'products', legacyHead: 'd'.repeat(64), count: 3 });
  assert.equal('ok' in written && written.ok, true);
  await refusedUnchanged(lead, hubFile().text, 'base-cell-held-products');
});

test('base-cell-held-products: the shared project made again from a single-machine copy, each product in its own cell, is admitted', async () => {
  const lead = await leadWith();
  const created = await appendProductEntry(lead.host, 'product.create', { product: 'fuel-estimate', section: 'j4', roles: { ...PRODUCT_ROLES }, title: 'Fuel estimate' }, { label: 'org/Internal' });
  assert.equal(created.ok, true, created.ok ? '' : created.message);
  const { fold } = await lead.p.state();
  assert.equal(baseCellHeldProducts(fold, lead.p.projectId), false);
  assert.equal(baseCellHeldProducts(fold, created.ok ? created.stream : ''), true, 'the product is in its own cell');
  ok(await admitHub(lead.host, hubFile().text, { ceiling: orgClearance('Internal') }), 'admit the hub');
});

test('a hub id already used by a member is refused member-exists; nothing is written', async () => {
  const lead = await leadWith();
  const hub = hubFile();
  const id = hubIdOfDevice(hub.device);
  const joiner = install('joiner');
  const invited = ok(await inviteToProject(lead.host, { name: 'Hal Planner', seat: 'j4-planner', clearance: orgClearance('Internal') }), 'invite');
  const joined = ok(await joinFromInvite(joiner.root, joiner.deps, (invited.file as { text: string }).text, { name: 'Hal Planner' }), 'join');
  ok(await admitJoinRequest(lead.host, (joined.file as { text: string }).text, { codeMatched: true, member: id }), 'admit a member under the hub\'s id');
  await refusedUnchanged(lead, hub.text, 'member-exists');
});

/** How many hub.admit and hub.grant entries this device wrote. */
async function hubEntries(seat: Seat): Promise<{ admits: number; grants: number }> {
  return { admits: (await seat.p.findOwnAll('hub.admit', () => true)).length, grants: (await seat.p.findOwnAll('hub.grant', () => true)).length };
}

test('resume: a stop after hub.admit is finished by a second admitHub with the same file, with no second hub.admit', async () => {
  const lead = await leadWith();
  const hub = hubFile();
  const original = lead.p.appendOwn.bind(lead.p);
  let failed = false;
  const stop = mock.method(lead.p, 'appendOwn', (kind: string, data: unknown, options?: Parameters<typeof original>[2]) => {
    if (kind === 'hub.grant' && !failed) {
      failed = true;
      return Promise.reject(new Error('the computer stopped'));
    }
    return original(kind, data, options);
  });
  try {
    await assert.rejects(admitHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }), /the computer stopped/);
  } finally {
    stop.mock.restore();
  }
  assert.deepEqual(await hubEntries(lead), { admits: 1, grants: 0 });
  ok(await admitHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }), 'admit again');
  assert.deepEqual(await hubEntries(lead), { admits: 1, grants: 1 });
  const { roster } = await lead.p.state();
  const epochs = epochsAt(roster.cells, lead.p.projectId, head(roster).position).map((item) => item.epoch);
  assert.deepEqual(hubOpens(lead, hub.device).get(lead.p.projectId), epochs);
});

test('resume: a stop after hub.grant and before the grants is finished by a second admitHub, writing only the grants', async () => {
  const lead = await leadWith();
  const hub = hubFile();
  const stop = mock.method(lead.p, 'putGrants', () => Promise.reject(new Error('the computer stopped')));
  try {
    await assert.rejects(admitHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }), /the computer stopped/);
  } finally {
    stop.mock.restore();
  }
  assert.deepEqual(await hubEntries(lead), { admits: 1, grants: 1 });
  assert.equal(hubOpens(lead, hub.device).size, 0, 'no grant was stored');
  const entries = streamEntries(lead.at, lead.p.projectId).length;
  ok(await admitHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }), 'admit again');
  assert.deepEqual(await hubEntries(lead), { admits: 1, grants: 1 });
  assert.equal(streamEntries(lead.at, lead.p.projectId).length, entries, 'no roster entry was written');
  assert.ok(hubOpens(lead, hub.device).has(lead.p.projectId));
});

test('resume: admitHub after a full admission is refused hub-already-admitted and writes nothing', async () => {
  const { lead, hub } = await leadAndHub();
  await refusedUnchanged(lead, hub.text, 'hub-already-admitted');
});

test('resume: a hub file for the admitted hub with another certificate pin is refused hub-file-differs; nothing is written', async () => {
  const lead = await leadWith();
  const hub = hubFile();
  const stop = mock.method(lead.p, 'putGrants', () => Promise.reject(new Error('the computer stopped')));
  try {
    await assert.rejects(admitHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }));
  } finally {
    stop.mock.restore();
  }
  await refusedUnchanged(lead, hubFile('HUB-NORTH', { certPin: 'e'.repeat(64) }).text, 'hub-file-differs');
});

test('a revoked hub\'s file is refused hub-revoked; nothing is written', async () => {
  const { lead, hub, id } = await leadAndHub();
  ok(await revokeHub(lead.host, { hub: id }), 'revoke');
  await refusedUnchanged(lead, hub.text, 'hub-revoked');
});

test('hubStanding lists each hub with its id, pin, ceiling, cells and standing, and writes nothing', async () => {
  const { lead, hub, id } = await leadAndHub();
  const cell = await labelCell(lead);
  ok(await grantCellToHub(lead.host, { cell, confirmed: true }), 'grant the cell');
  const before = storeCounts(lead.at, lead.p.projectId);
  assert.deepEqual(await hubStanding(lead.host), [{ hub: id, writer: hub.device.writer, certPin: hub.certPin, ceiling: orgClearance('Internal'), cells: [lead.p.projectId, cell], standing: 'admitted' }]);
  assert.deepEqual(storeCounts(lead.at, lead.p.projectId), before, 'reads only');
  ok(await revokeHub(lead.host, { hub: id }), 'revoke');
  const after = await hubStanding(lead.host);
  assert.equal(after.length, 1);
  assert.equal(after[0]?.standing, 'revoked');
  assert.deepEqual(after[0]?.cells, [lead.p.projectId, cell], 'the cells it held when revoked');
});

/** Every file under a folder, read as text. */
function filesUnder(dir: string): string[] {
  const found: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    const stat = statSync(file);
    if (stat.isDirectory()) found.push(...filesUnder(file));
    else if (stat.isFile()) found.push(readFileSync(file).toString('latin1'));
  }
  return found;
}

test('no secret: no message, notice, reason or result field holds the enrolment secret, a private key, the binding signature or a full key, and no file keeps the secret', async () => {
  const lead = await leadWith();
  const hub = hubFile();
  const results: unknown[] = [];
  results.push(await admitHub(lead.host, hub.text, { ceiling: { scale: 'org' } }));
  results.push(await admitHub(lead.host, JSON.stringify({ ...JSON.parse(hub.text) as object, sig: 'A'.repeat(86) }), { ceiling: orgClearance('Internal') }));
  results.push(await admitHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }));
  results.push(await admitHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }));
  const cell = await labelCell(lead);
  results.push(await grantCellToHub(lead.host, { cell, confirmed: false }));
  results.push(await grantCellToHub(lead.host, { cell, confirmed: true }));
  results.push(await hubStanding(lead.host));
  results.push(await revokeHub(lead.host, { hub: hubIdOfDevice(hub.device) }));
  const privateKey = hub.device.x25519Private.export({ format: 'der', type: 'pkcs8' });
  const { roster } = await lead.p.state();
  const epochKeys = [...roster.cells.cells.keys()].flatMap((id) => epochsAt(roster.cells, id, head(roster).position).map((item) => lead.p.keys.epochKey(id, item.epoch)))
    .filter((key): key is Buffer => key !== undefined);
  assert.ok(epochKeys.length >= 4, 'the base and label cell keys, before and after the revoke');
  const secrets = [
    hub.enrolmentSecret, hub.device.x25519Sig, hub.device.publicKey, hub.device.x25519, privateKey.toString('base64url'), privateKey.toString('base64'),
    ...epochKeys.flatMap((key) => [key.toString('base64url'), key.toString('base64'), key.toString('hex')])
  ];
  const text = JSON.stringify(results);
  for (const secret of secrets) assert.equal(text.includes(secret), false, 'a result holds a secret or a key');
  const files = [...filesUnder(lead.at.root), ...filesUnder(lead.at.global), ...lead.at.secrets.values.values()];
  assert.ok(files.length > 0);
  for (const file of files) assert.equal(file.includes(hub.enrolmentSecret), false, 'the enrolment secret is not kept');
});

// ---- 32-25: invitations and join requests through the hub, and connecting a project (enrolment) --------------------------------------------------

const FAKE_PIN = certPinOf(FIXTURE_CERT);
const ENROLMENT = 'enr-00112233aabbccdd';

/** A hub file for the scripted hub on 127.0.0.1: its address and the fixture certificate's pin. */
function fakeHubFile(address: string, options: { expiresAt?: string; label?: string } = {}): TestHub & { address: string } {
  const device = rosterDevice(options.label ?? 'HUB-NORTH', 'hub');
  const enrolmentSecret = Buffer.alloc(32, 9).toString('base64url');
  const signed = buildHubFile(device.signer, {
    address, certPin: FAKE_PIN, x25519: device.x25519, x25519Sig: device.x25519Sig, enrolment: ENROLMENT, enrolmentSecret,
    expiresAt: options.expiresAt ?? new Date(WORLD_NOW.getTime() + 7 * DAY_MS).toISOString(), now: WORLD_NOW, kem: hubKem(device)
  });
  return { device, text: JSON.stringify(signed), enrolmentSecret, certPin: FAKE_PIN, address };
}

interface JoinHub {
  fake: FakeHubServer;
  /** Registrations by invite id: the exact body the lead's device sent. */
  registered: Map<string, Record<string, unknown>>;
  /** Join posts the scripted hub accepted, as the hub keeps them. */
  kept: Array<{ invite: string; request: string }>;
  enrols: unknown[];
  /** A scripted refusal of the next join posts, or of enrolment. */
  joinRefusal?: { status: number; error: string };
  enrolRefusal?: { status: number; error: string };
}

/** A scripted hub that checks join posts as the real hub does (readHubJoin and checkHubJoinMac with the registered check key). */
async function startJoinHub(project: string, hubWriter: string): Promise<JoinHub> {
  const state: Omit<JoinHub, 'fake'> & { fake?: FakeHubServer } = { registered: new Map(), kept: [], enrols: [] };
  const base = `/v1/projects/${project}`;
  const join = (req: FakeRequest): FakeAnswer => {
    if (state.joinRefusal !== undefined) return { status: state.joinRefusal.status, json: { error: state.joinRefusal.error, message: 'Refused.' } };
    const body = req.json() as { join: unknown; request: unknown };
    const read = readHubJoin(body.join, body.request);
    if (!read.ok) return { status: 403, json: { error: read.reason, message: 'Refused.' } };
    const record = state.registered.get(read.join.invite);
    if (record === undefined) return { status: 404, json: { error: 'unknown-invite', message: 'Unknown.' } };
    if (read.join.hub !== hubWriter || read.join.project !== project) return { status: 403, json: { error: 'wrong-hub', message: 'Refused.' } };
    if (!checkHubJoinMac(record.checkKey as string, { hub: hubWriter, project, invite: read.join.invite, request: read.join.request }, read.join.hubMac)) {
      return { status: 403, json: { error: 'wrong-secret', message: 'Refused.' } };
    }
    state.kept.push({ invite: read.join.invite, request: JSON.stringify(body.request) });
    return { status: 202, json: { project, invite: read.join.invite, held: false } };
  };
  const fake = await FakeHubServer.start({
    project,
    hub: hubWriter,
    tokenCheck: (req) => (req.path === '/v1/join' && req.method === 'POST' ? join(req) : undefined),
    handle: (req) => {
      if (req.path === '/v1/enrol') {
        state.enrols.push(req.json());
        if (state.enrolRefusal !== undefined) return { status: state.enrolRefusal.status, json: { error: state.enrolRefusal.error, message: 'Refused.' } };
        const body = req.json() as { rosterHead: string };
        return { status: 201, json: { project, rosterHead: body.rosterHead, hub: `hub-${hubWriter.slice(0, 16)}` } };
      }
      if (req.method === 'POST' && req.path === `${base}/invites`) {
        const body = req.json() as Record<string, unknown>;
        const held = state.registered.has(body.invite as string);
        state.registered.set(body.invite as string, body);
        return { status: held ? 200 : 201, json: { project, invite: body.invite, held } };
      }
      if (req.method === 'GET' && req.path === `${base}/join-requests`) {
        return { json: { project, requests: state.kept.map((item) => ({ invite: item.invite, request: item.request, receivedAt: WORLD_NOW.toISOString() })) } };
      }
      return { status: 404, json: { error: 'not-found', message: 'Nothing here.' } };
    }
  });
  state.fake = fake;
  return state as JoinHub;
}

/** Transports to the scripted hub, with a short connect limit. */
const openFake = (options: HubTransportOptions): HubTransport => new HubTransport({ ...options, connectTimeoutMs: 2_000 });

/** An address nothing listens on. */
async function closedAddress(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `127.0.0.1:${port}`;
}
const openUnreachable = (address: string) => (options: HubTransportOptions): HubTransport => new HubTransport({ ...options, address, connectTimeoutMs: 1_000 });

/** A lead with the scripted hub admitted (the hub file names the scripted hub's address and pin). */
async function leadOnHub(): Promise<{ lead: Seat; hub: TestHub & { address: string }; joinHub: JoinHub }> {
  const lead = await leadWith();
  const device = rosterDevice('HUB-NORTH', 'hub');
  const joinHub = await startJoinHub(lead.p.projectId, device.writer);
  const hub = fakeHubFile(joinHub.fake.address);
  ok(await admitHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }), 'admit the hub');
  return { lead, hub, joinHub };
}

const PERSON = { name: 'Rowan Analyst', seat: 'j4-planner', clearance: orgClearance('Internal') };
const SEND_FILE_END = 'Send your join request file to the staff lead any way you like.';

test('inviteThroughHub: member.invite as inviteToProject writes it, a file whose hub field names the hub, and the hub told the check key only', async () => {
  const { lead, hub, joinHub } = await leadOnHub();
  try {
    const result = ok(await inviteThroughHub(lead.host, PERSON, { address: joinHub.fake.address }, openFake), 'invite through the hub');
    assert.equal(result.registered, true);
    assert.match(result.message, /your organization's hub knows it/i);
    const file = result.file as { name: string; text: string };
    const read = readInvite(file.text, WORLD_NOW);
    assert.ok(read.ok, 'the file reads as an invitation');
    assert.deepEqual(read.invite.hub, { address: joinHub.fake.address, certPin: FAKE_PIN, writer: hub.device.writer });
    const { roster } = await lead.p.state();
    const record = roster.members.invites.get(read.invite.invite);
    assert.ok(record !== undefined, 'the roster has member.invite');
    assert.equal(record.secretHash, joinSecretHash(read.invite.secret));
    assert.equal(record.name, PERSON.name);
    const sent = joinHub.registered.get(read.invite.invite);
    assert.deepEqual(sent, { invite: read.invite.invite, expiresAt: read.invite.expiresAt, checkKey: hubJoinCheckKey(read.invite.secret, read.invite.invite) });
    assert.equal(JSON.stringify(joinHub.fake.requests.map((req) => req.body.toString('utf8'))).includes(read.invite.secret), false, 'the join secret never went to the hub');
  } finally {
    await joinHub.fake.close();
  }
});

test('inviteThroughHub unreachable: the invitation is made and works by file only, and the result says the hub was not told', async () => {
  const { lead, joinHub } = await leadOnHub();
  await joinHub.fake.close();
  const result = ok(await inviteThroughHub(lead.host, PERSON, { address: joinHub.fake.address }, openUnreachable(await closedAddress())), 'invite with the hub unreachable');
  assert.equal(result.registered, false);
  assert.ok(result.message.includes(HUB_NOT_TOLD_TEXT), result.message);
  const read = readInvite((result.file as { text: string }).text, WORLD_NOW);
  assert.ok(read.ok);
  assert.equal(read.invite.hub, undefined, 'a file the hub does not know names no hub, so the person sends their request by file');
  assert.ok((await lead.p.state()).roster.members.invites.has(read.invite.invite), 'the invitation is in the roster all the same');
});

test('inviteThroughHub: with no hub admitted it is refused no-hub and writes nothing', async () => {
  const lead = await leadWith();
  const before = storeCounts(lead.at, lead.p.projectId);
  const result = await inviteThroughHub(lead.host, PERSON, { address: '127.0.0.1:9' }, openFake);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-hub');
  assert.deepEqual(storeCounts(lead.at, lead.p.projectId), before);
});

test('sendJoinRequestThroughHub: no-hub-in-invitation for an invitation without a hub field, and nothing is sent', async () => {
  const { lead, joinHub } = await leadOnHub();
  try {
    const invited = ok(await inviteToProject(lead.host, PERSON), 'invite by file');
    const joiner = install('joiner');
    const joined = ok(await joinFromInvite(joiner.root, joiner.deps, (invited.file as { text: string }).text, { name: PERSON.name }), 'join by file');
    const before = joinHub.fake.connections;
    const result = await sendJoinRequestThroughHub((invited.file as { text: string }).text, (joined.file as { text: string }).text, joiner.deps, openFake);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-hub-in-invitation');
    assert.equal(result.message, HUB_MEMBERSHIP_REFUSALS['no-hub-in-invitation']);
    assert.equal(joinHub.fake.connections, before, 'no connection was made');
  } finally {
    await joinHub.fake.close();
  }
});

test('sendJoinRequestThroughHub: the request reaches the hub, which checks the hub MAC, and the person is told to read the six words to the staff lead', async () => {
  const { lead, joinHub } = await leadOnHub();
  try {
    const invited = ok(await inviteThroughHub(lead.host, PERSON, { address: joinHub.fake.address }, openFake), 'invite through the hub');
    const inviteText = (invited.file as { text: string }).text;
    const joiner = install('joiner');
    const joined = ok(await joinFromInvite(joiner.root, joiner.deps, inviteText, { name: PERSON.name }), 'make the join request');
    const sent = ok(await sendJoinRequestThroughHub(inviteText, (joined.file as { text: string }).text, joiner.deps, openFake), 'send through the hub');
    assert.match(sent.message, /reached your organization's hub/);
    assert.deepEqual(sent.safetyWords, joined.safetyWords, 'the same six words');
    assert.ok(sent.message.includes((joined.safetyWords as string[]).join(' ')));
    assert.match(sent.message, /staff lead/);
    assert.equal(joinHub.kept.length, 1, 'the scripted hub kept the request after checking the hub MAC');
  } finally {
    await joinHub.fake.close();
  }
});

test('sendJoinRequestThroughHub: each hub refusal (unknown, expired, used, voided, locked) is a plain sentence that ends with sending the join request file', async () => {
  const { lead, joinHub } = await leadOnHub();
  try {
    const invited = ok(await inviteThroughHub(lead.host, PERSON, { address: joinHub.fake.address }, openFake), 'invite through the hub');
    const inviteText = (invited.file as { text: string }).text;
    const joiner = install('joiner');
    const requestText = (ok(await joinFromInvite(joiner.root, joiner.deps, inviteText, { name: PERSON.name }), 'join').file as { text: string }).text;
    const cases: Array<[string, number, string]> = [
      ['unknown-invite', 404, 'hub-unknown-invite'], ['invite-expired', 403, 'hub-invite-expired'], ['invite-used', 403, 'hub-invite-used'],
      ['invite-voided', 403, 'hub-invite-voided'], ['invite-locked', 403, 'hub-invite-locked'], ['wrong-secret', 403, 'hub-join-refused'], ['rate-limited', 429, 'hub-busy']
    ];
    const messages = new Set<string>();
    for (const [error, status, reason] of cases) {
      joinHub.joinRefusal = { status, error };
      const result = await sendJoinRequestThroughHub(inviteText, requestText, joiner.deps, openFake);
      assert.equal(result.ok, false);
      assert.equal(result.reason, reason, error);
      assert.equal(result.message, HUB_MEMBERSHIP_REFUSALS[reason as keyof typeof HUB_MEMBERSHIP_REFUSALS]);
      assert.ok(result.message.endsWith(SEND_FILE_END), result.message);
      messages.add(result.message);
    }
    assert.equal(messages.size, cases.length, 'each refusal has its own sentence');
    assert.equal(joinHub.kept.length, 0);
  } finally {
    await joinHub.fake.close();
  }
});

test('sendJoinRequestThroughHub invite-full (D-30): too many people waiting is its own plain sentence naming the lead word from term(), with the send-the-file way out', async () => {
  const { lead, joinHub } = await leadOnHub();
  try {
    const invited = ok(await inviteThroughHub(lead.host, PERSON, { address: joinHub.fake.address }, openFake), 'invite through the hub');
    const inviteText = (invited.file as { text: string }).text;
    const joiner = install('joiner');
    const requestText = (ok(await joinFromInvite(joiner.root, joiner.deps, inviteText, { name: PERSON.name }), 'join').file as { text: string }).text;
    joinHub.joinRefusal = { status: 403, error: 'invite-full' };
    const result = await sendJoinRequestThroughHub(inviteText, requestText, joiner.deps, openFake);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'hub-invite-full');
    const leadWord = term('lead').toLowerCase();
    assert.equal(result.message, `This invitation has too many people waiting. Ask the ${leadWord} for a new one. ${SEND_FILE_END}`);
    assert.equal(result.message, HUB_MEMBERSHIP_REFUSALS['hub-invite-full']);
    assert.ok(result.message.endsWith(SEND_FILE_END), result.message);
    assert.ok(!result.message.includes('\u2014'), 'no em-dash');
    assert.equal(joinHub.kept.length, 0, 'nothing kept');
    // The allowed side: once the hub takes requests again the same request goes through.
    joinHub.joinRefusal = undefined;
    ok(await sendJoinRequestThroughHub(inviteText, requestText, joiner.deps, openFake), 'sent once the hub takes it');
  } finally {
    await joinHub.fake.close();
  }
});

test('sendJoinRequestThroughHub unreachable: the person is told the hub could not be reached and to send the join request file', async () => {
  const { lead, joinHub } = await leadOnHub();
  const invited = ok(await inviteThroughHub(lead.host, PERSON, { address: joinHub.fake.address }, openFake), 'invite through the hub');
  await joinHub.fake.close();
  const inviteText = (invited.file as { text: string }).text;
  const joiner = install('joiner');
  const requestText = (ok(await joinFromInvite(joiner.root, joiner.deps, inviteText, { name: PERSON.name }), 'join').file as { text: string }).text;
  const result = await sendJoinRequestThroughHub(inviteText, requestText, joiner.deps, openUnreachable(await closedAddress()));
  assert.equal(result.reason, 'hub-join-unreachable');
  assert.ok(result.message.endsWith(SEND_FILE_END));
});

test('sendJoinRequestThroughHub: a join request made from another invitation is refused before anything is sent', async () => {
  const { lead, joinHub } = await leadOnHub();
  try {
    const first = ok(await inviteThroughHub(lead.host, PERSON, { address: joinHub.fake.address }, openFake), 'first invitation');
    const second = ok(await inviteThroughHub(lead.host, { ...PERSON, name: 'Sasha Analyst' }, { address: joinHub.fake.address }, openFake), 'second invitation');
    const joiner = install('joiner');
    const requestText = (ok(await joinFromInvite(joiner.root, joiner.deps, (first.file as { text: string }).text, { name: PERSON.name }), 'join').file as { text: string }).text;
    const before = joinHub.fake.connections;
    const result = await sendJoinRequestThroughHub((second.file as { text: string }).text, requestText, joiner.deps, openFake);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unknown-invite');
    assert.equal(joinHub.fake.connections, before);
  } finally {
    await joinHub.fake.close();
  }
});

test('fetchJoinRequests: the lead gets the request texts; the hub\'s acceptance admits nobody, and review and admit work as in Phase 31', async () => {
  const { lead, joinHub } = await leadOnHub();
  try {
    const invited = ok(await inviteThroughHub(lead.host, PERSON, { address: joinHub.fake.address }, openFake), 'invite through the hub');
    const inviteText = (invited.file as { text: string }).text;
    const joiner = install('joiner');
    const joined = ok(await joinFromInvite(joiner.root, joiner.deps, inviteText, { name: PERSON.name }), 'join');
    ok(await sendJoinRequestThroughHub(inviteText, (joined.file as { text: string }).text, joiner.deps, openFake), 'send through the hub');
    const membersBefore = [...(await lead.p.state()).roster.members.members.keys()];

    const fetched = ok(await fetchJoinRequests(lead.host, { address: joinHub.fake.address }, openFake), 'fetch');
    assert.equal(fetched.requests?.length, 1);
    assert.match(fetched.message, /One join request is waiting/);
    assert.deepEqual([...(await lead.p.state()).roster.members.members.keys()], membersBefore, 'the hub\'s acceptance admitted nobody');
    const text = (fetched.requests as Array<{ text: string }>)[0]?.text as string;

    const reviewed = ok(await reviewJoinRequest(lead.host, text), 'review');
    assert.deepEqual(reviewed.safetyWords, joined.safetyWords, 'the lead sees the same six words');
    assert.equal((await admitJoinRequest(lead.host, text, { codeMatched: false })).reason, 'code-not-confirmed');
    const admitted = ok(await admitJoinRequest(lead.host, text, { codeMatched: true }), 'admit');
    assert.equal((await lead.p.state()).roster.members.members.has(admitted.member as string), true);
    // A request whose Phase 31 MAC is wrong is refused by the lead's own check, whatever the hub said.
    const forged = JSON.parse(text) as { payload: { mac: string } };
    forged.payload.mac = Buffer.alloc(32, 3).toString('base64url');
    assert.notEqual((await reviewJoinRequest(lead.host, JSON.stringify(forged))).ok, true);
  } finally {
    await joinHub.fake.close();
  }
});

test('fetchJoinRequests: a member\'s device is refused not-a-roster-writer and asks the hub nothing; an unreachable hub is said plainly', async () => {
  const { lead, joinHub } = await leadOnHub();
  try {
    const member = await bringIn(lead, 'member', 'Nell Planner', orgClearance('Internal'));
    await syncTo(lead, member);
    const before = joinHub.fake.connections;
    const refused = await fetchJoinRequests(member.host, { address: joinHub.fake.address }, openFake);
    assert.equal(refused.reason, 'not-a-roster-writer');
    assert.equal(joinHub.fake.connections, before);
  } finally {
    await joinHub.fake.close();
  }
  const unreachable = await fetchJoinRequests(lead.host, { address: joinHub.fake.address }, openUnreachable(await closedAddress()));
  assert.equal(unreachable.reason, 'hub-unreachable');
  assert.equal(unreachable.message, HUB_MEMBERSHIP_REFUSALS['hub-unreachable']);
});

test('enrol: connectProjectToHub admits the hub and enrols in one call; the hub gets the genesis, every roster entry, the grants and the enrolment MAC', async () => {
  const lead = await leadWith();
  const device = rosterDevice('HUB-NORTH', 'hub');
  const joinHub = await startJoinHub(lead.p.projectId, device.writer);
  try {
    const hub = fakeHubFile(joinHub.fake.address);
    const result = ok(await connectProjectToHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }, openFake), 'connect');
    assert.equal(result.hub, hubIdOfDevice(device));
    assert.match(result.message, /now holds the project/);
    assert.equal(joinHub.enrols.length, 1);
    const body = joinHub.enrols[0] as { enrolment: string; project: string; entries: SealedEntry[]; grants: unknown[]; blobs: unknown[]; rosterHead: string; mac: string };
    const { roster } = await lead.p.state();
    const rosterHead = head(roster).hash;
    assert.deepEqual(Object.keys(body).sort(), ['blobs', 'enrolment', 'entries', 'grants', 'mac', 'project', 'rosterHead']);
    assert.equal(body.enrolment, ENROLMENT);
    assert.equal(body.project, lead.p.projectId);
    assert.equal(body.rosterHead, rosterHead);
    const hashes = body.entries.map((entry) => entryHash(entry.header));
    assert.ok(hashes.includes(lead.p.anchor.genesisHash), 'the genesis is sent');
    assert.deepEqual(new Set(hashes), new Set(streamEntries(lead.at, lead.p.projectId).map((entry) => entryHash(entry.header))), 'every roster entry is sent');
    assert.ok(roster.positions.slice(1).every((hash) => hashes.includes(hash)), 'every applied roster entry is among them (position 0 is the origin)');
    assert.equal(body.grants.length, grantsOn(lead.at).length, 'every grant this device holds');
    assert.deepEqual(body.blobs, [], 'the roster entries here cite no blob');
    assert.equal(body.mac, enrolmentMac(hub.enrolmentSecret, { enrolment: ENROLMENT, hub: hubIdOfDevice(device), project: lead.p.projectId, genesisHash: lead.p.anchor.genesisHash, rosterHead }));
    assert.equal(JSON.stringify(body).includes(hub.enrolmentSecret), false, 'the enrolment secret is in the MAC only');
    assert.ok(hubAt(roster.members, hubIdOfDevice(device), head(roster).position) !== undefined, 'the hub is admitted');
  } finally {
    await joinHub.fake.close();
  }
});

test('enrol: enrolmentRequest sends the blobs the roster entries cite, read from the replica', async () => {
  const blob = { hash: 'e'.repeat(64), bytes: Buffer.from('sealed bytes').toString('base64url') };
  const genesis = { header: { stream: 'p'.repeat(32), writer: 'a'.repeat(64), seq: 0 }, body: '' } as unknown as SealedEntry;
  const source = {
    project: 'p'.repeat(32),
    heads: async () => [{ stream: 'p'.repeat(32), heads: [{ writer: 'a'.repeat(64), seq: 0, hash: 'f'.repeat(64) }] }],
    entriesAfter: async () => [genesis],
    blobsCitedBy: async () => [{ entry: 'f'.repeat(64), blob: blob.hash }],
    blob: async (hash: string) => (hash === blob.hash ? blob : undefined),
    grants: async () => [{ hash: '1'.repeat(64), signed: { granted: true } }]
  };
  const body = await enrolmentRequest(source, { enrolment: ENROLMENT, enrolmentSecret: Buffer.alloc(32, 9).toString('base64url'), hub: 'hub-0011223344556677' }, { genesisHash: 'f'.repeat(64), rosterHead: 'f'.repeat(64) });
  assert.deepEqual(body.blobs, [blob]);
  assert.deepEqual(body.grants, [{ granted: true }]);
  assert.equal(body.entries.length, 1);
});

test('enrol unreachable: the hub stays admitted, and a second call enrols without a second hub.admit', async () => {
  const lead = await leadWith();
  const device = rosterDevice('HUB-NORTH', 'hub');
  const joinHub = await startJoinHub(lead.p.projectId, device.writer);
  try {
    const hub = fakeHubFile(joinHub.fake.address);
    const first = await connectProjectToHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }, openUnreachable(await closedAddress()));
    assert.equal(first.ok, false);
    assert.equal(first.reason, 'enrol-unreachable');
    assert.equal(first.message, HUB_MEMBERSHIP_REFUSALS['enrol-unreachable']);
    const afterFirst = await lead.p.state();
    assert.ok(hubAt(afterFirst.roster.members, hubIdOfDevice(device), head(afterFirst.roster).position) !== undefined, 'the hub stays admitted');
    const admits = (): number => streamEntries(lead.at, lead.p.projectId).length;
    const entriesBefore = admits();
    ok(await connectProjectToHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }, openFake), 'connect again');
    assert.equal(admits(), entriesBefore, 'no second hub.admit, nor any other roster entry');
    assert.equal(joinHub.enrols.length, 1);
  } finally {
    await joinHub.fake.close();
  }
});

test('enrol: a used or expired enrolment is refused enrol-refused with the sentence asking the operator for a new hub file', async () => {
  const lead = await leadWith();
  const device = rosterDevice('HUB-NORTH', 'hub');
  const joinHub = await startJoinHub(lead.p.projectId, device.writer);
  try {
    const hub = fakeHubFile(joinHub.fake.address);
    for (const error of ['enrolment-used', 'enrolment-expired']) {
      joinHub.enrolRefusal = { status: 403, error };
      const result = await connectProjectToHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }, openFake);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'enrol-refused', error);
      assert.equal(result.message, HUB_MEMBERSHIP_REFUSALS['enrol-refused']);
      assert.match(result.message, /hub operator for a new hub file/);
    }
    joinHub.enrolRefusal = { status: 409, error: 'project-exists' };
    const held = ok(await connectProjectToHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }, openFake), 'a hub that already holds the project');
    assert.match(held.message, /already holds/);
  } finally {
    await joinHub.fake.close();
  }
});

test('no secret: no result, message, notice or file name of the hub join and enrol flows holds a join secret, a check key, a MAC or the enrolment secret', async () => {
  const { lead, hub, joinHub } = await leadOnHub();
  try {
    const results: unknown[] = [];
    const invited = ok(await inviteThroughHub(lead.host, PERSON, { address: joinHub.fake.address }, openFake), 'invite');
    const read = readInvite((invited.file as { text: string }).text, WORLD_NOW);
    assert.ok(read.ok);
    results.push({ ...invited, file: { name: invited.file?.name } });
    const joiner = install('joiner');
    const joined = ok(await joinFromInvite(joiner.root, joiner.deps, (invited.file as { text: string }).text, { name: PERSON.name }), 'join');
    results.push(await sendJoinRequestThroughHub((invited.file as { text: string }).text, (joined.file as { text: string }).text, joiner.deps, openFake));
    joinHub.joinRefusal = { status: 403, error: 'invite-locked' };
    results.push(await sendJoinRequestThroughHub((invited.file as { text: string }).text, (joined.file as { text: string }).text, joiner.deps, openFake));
    const fetched = await fetchJoinRequests(lead.host, { address: joinHub.fake.address }, openFake);
    results.push({ ...fetched, requests: fetched.requests?.map((item) => item.invite) });
    results.push(await connectProjectToHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }, openFake));
    joinHub.enrolRefusal = { status: 403, error: 'enrolment-used' };
    results.push(await connectProjectToHub(lead.host, hub.text, { ceiling: orgClearance('Internal') }, openFake));
    const secret = read.invite.secret;
    const checkKey = hubJoinCheckKey(secret, read.invite.invite);
    const request = JSON.parse((joined.file as { text: string }).text) as { payload: { mac: string } };
    const hubMacs = joinHub.fake.requests.filter((req) => req.path === '/v1/join').map((req) => (req.json() as { join: { payload: { hubMac: string } } }).join.payload.hubMac);
    const enrolMac = (joinHub.enrols[0] as { mac: string }).mac;
    const text = JSON.stringify(results);
    for (const value of [secret, Buffer.from(secret, 'base64url').toString('hex'), checkKey, request.payload.mac, ...hubMacs, enrolMac, hub.enrolmentSecret]) {
      assert.equal(text.includes(value), false, 'a result holds a secret, a key or a MAC');
    }
    assert.ok(hubMacs.length >= 2 && enrolMac.length > 0);
  } finally {
    await joinHub.fake.close();
  }
});
