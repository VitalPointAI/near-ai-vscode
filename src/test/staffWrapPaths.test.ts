// Every path that hands out a cell key, with wrap@2 required and without it (33.2-06 Task 1; 33.2-CONTEXT D-05, D-07, D-09). With wrap@2 required no
// path writes an X25519 wrap for an epoch founded after the switch, and a device without post-quantum keys gets no wrap and waits; without it the
// paths write what they wrote before, except that a Protected B cell is never shared the older way. Fictional people and keys.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readGrant } from '../domain/replica/cellKeys';
import { wrapFormatOf } from '../domain/replica/cellWrapV2';
import { clientIdOf } from '../domain/replica/clientIds';
import { deviceAt } from '../domain/replica/rosterMembers';
import { WRAP_V2_FEATURE, knownReplicaFeatures } from '../domain/replica/features';
import { ensureLabelCell } from '../staff/replica/labelCells';
import { admitJoinRequest, finishRekeys, inviteToProject, joinFromInvite, nameDeputy, removeFromProject, updateMember } from '../staff/replica/membership';
import { ensureDeviceKem } from '../staff/replica/kemPublish';
import { loadOrCreateKemKeys } from '../staff/replica/keyring';
import { switchToV2 } from '../staff/replica/wrapUpgrade';
import { identityDir } from '../team/identity';
import { ReplicaProject } from '../staff/replica/replicaProject';
import { SWITCH_FIRST_TEXT } from '../staff/replica/wrapPlan';
import { LEAD_MEMBER, bringIn, grantsOn, hostOf, install, leadWith, ok, orgClearance, orgLabel, project, syncTo } from './helpers/labelCellWorld';
import type { Install, Seat } from './helpers/labelCellWorld';

const PROTECTED_B = { scale: 'ca-protected', level: 'Protected B', compartments: [], releasability: [], handling: [] };
const PROTECTED_A = { scale: 'ca-protected', level: 'Protected A', compartments: [], releasability: [], handling: [] };
const PROTECTED_B_CLEARANCE = { scale: 'ca-protected', level: 'Protected B', compartments: [], releasability: [] };

interface WrapOnDisk { cell: string; epoch: number; writer: string; format: number }

/** Every wrap of every grant an install keeps, with the cell, epoch and format of each. */
function wrapsOn(at: Install): WrapOnDisk[] {
  return grantsOn(at).flatMap(({ signed }) => {
    const read = readGrant(signed);
    if (!read.ok) return [];
    return read.grant.wraps.map((item) => {
      const format = wrapFormatOf(item.wrap);
      return { cell: read.grant.cell, epoch: read.grant.epoch, writer: item.writer, format: format.ok ? format.format : 0 };
    });
  });
}

const formatsOf = (at: Install, cell: string, epoch?: number): number[] => [...new Set(wrapsOn(at).filter((item) => item.cell === cell && (epoch === undefined || item.epoch === epoch)).map((item) => item.format))].sort();
const switchedAt = async (seat: Seat): Promise<number | undefined> => (await seat.p.state()).roster.requiredFrom.get(WRAP_V2_FEATURE);

/** A lead whose project was made before the switch (wrapV2AtCreation false), with a declared clearance. */
async function unswitchedLead(clearance: unknown = orgClearance('Confidential')): Promise<Seat> {
  const at = install('unswitched-lead');
  at.deps.wrapV2AtCreation = false;
  const p = project(await ReplicaProject.createSharedProject(at.root, at.deps, { name: 'Exercise Northwind', profile: 'j4', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: LEAD_MEMBER } }));
  const host = hostOf(p, at);
  ok(await updateMember(host, { member: LEAD_MEMBER, roles: ['member', 'section_lead:j4'], clearance }), 'the lead declares a clearance');
  return { at, p, host, member: LEAD_MEMBER, writer: p.deviceWriter, results: [] };
}

test('tracer: a project made shared requires wrap@2 from creation, and the base cell\'s first key is wrapped with cell-wrap/v2', async () => {
  const lead = await leadWith({ label: 'tracer' });
  assert.ok((await switchedAt(lead)) !== undefined);
  assert.deepEqual(formatsOf(lead.at, lead.p.projectId, 1), [2]);
});

test('first grant: a new label cell in a switched project is founded with v2 wraps only', async () => {
  const lead = await leadWith({ label: 'first-grant' });
  const made = await ensureLabelCell(lead.host, orgLabel('Internal'));
  assert.ok(made.ok);
  if (!made.ok) return;
  assert.deepEqual(formatsOf(lead.at, made.cell), [2]);
});

test('admission: a person joining a switched project sends post-quantum keys, and every grant they are given is v2', async () => {
  const lead = await leadWith({ label: 'admission' });
  const made = await ensureLabelCell(lead.host, orgLabel('Internal'));
  assert.ok(made.ok);
  const pat = await bringIn(lead, 'admission-pat', 'Pat Analyst', orgClearance('Internal'));
  const given = wrapsOn(lead.at).filter((item) => item.writer === pat.writer);
  assert.ok(given.length >= 2, 'the base cell and the label cell');
  assert.deepEqual([...new Set(given.map((item) => item.format))], [2]);
});

test('earlier epochs: a person admitted after a rekey gets every epoch, each as v2', async () => {
  const lead = await leadWith({ label: 'earlier' });
  const pat = await bringIn(lead, 'earlier-pat', 'Pat Analyst', orgClearance('Internal'));
  ok(await removeFromProject(lead.host, { member: pat.member }), 'remove Pat');
  const quinn = await bringIn(lead, 'earlier-quinn', 'Quinn Planner', orgClearance('Internal'));
  const epochs = wrapsOn(lead.at).filter((item) => item.writer === quinn.writer && item.cell === lead.p.projectId);
  assert.deepEqual(epochs.map((item) => item.epoch).sort(), [1, 2]);
  assert.deepEqual([...new Set(epochs.map((item) => item.format))], [2]);
});

test('member removal: the rekey of every cell the member held is v2 only, and the removed device is on none of them', async () => {
  const lead = await leadWith({ label: 'removal' });
  const made = await ensureLabelCell(lead.host, orgLabel('Internal'));
  assert.ok(made.ok);
  const pat = await bringIn(lead, 'removal-pat', 'Pat Analyst', orgClearance('Internal'));
  ok(await removeFromProject(lead.host, { member: pat.member }), 'remove Pat');
  for (const cell of [lead.p.projectId, made.ok ? made.cell : '']) {
    const rekeyed = wrapsOn(lead.at).filter((item) => item.cell === cell && item.epoch === 2);
    assert.ok(rekeyed.length > 0, `cell ${cell} moved to epoch 2`);
    assert.deepEqual([...new Set(rekeyed.map((item) => item.format))], [2]);
    assert.equal(rekeyed.some((item) => item.writer === pat.writer), false);
  }
});

test('clearance and removal handle an affected cell awaiting compatible hybrid keys', async () => {
  const lead = await unswitchedLead();
  const labelled = await ensureLabelCell(lead.host, orgLabel('Internal'));
  assert.ok(labelled.ok);
  const deputy = await bringIn(lead, 'removed-deputy', 'Quinn Planner', orgClearance('Internal'));
  assert.ok(wrapsOn(lead.at).some(({ cell, writer, format }) => cell === labelled.cell && writer === deputy.writer && format === 1));
  ok(await nameDeputy(lead.host, deputy.member), 'name deputy');
  await syncTo(lead, deputy);
  const publish = (seat: Seat) => ensureDeviceKem(seat.p, {
    loadKeys: () => loadOrCreateKemKeys(seat.at.secrets, { identityDir: identityDir(seat.at.global) })
  });
  const publication = await publish(deputy);
  assert.ok(publication === 'published' || publication === 'present');
  const switched = await switchToV2(deputy.host);
  assert.ok('hash' in switched, JSON.stringify(switched));
  await syncTo(deputy, lead);
  const base = lead.p.projectId;
  const initial = (await lead.p.state()).roster;
  const lowered = await updateMember(lead.host, { member: deputy.member, clearance: orgClearance('Public') });
  assert.equal(lowered.ok, false);
  assert.equal(lowered.reason, 'rekey-awaiting-keys');
  assert.deepEqual((await lead.p.state()).roster.positions, initial.positions);
  assert.deepEqual(formatsOf(lead.at, labelled.cell, 2), []);
  const slot = deviceAt(initial.members, lead.writer, initial.positions.length - 1)?.slot;
  assert.ok(slot !== undefined, 'the lead has a device slot');
  const data = { product: 'estimate', clientId: clientIdOf(slot, 0), actor: { kind: 'person' } };
  const removed = await removeFromProject(lead.host, { member: deputy.member });
  assert.equal(removed.ok, false);
  assert.equal(removed.reason, 'rekey-awaiting-keys');
  assert.equal((await finishRekeys(lead.host)).reason, 'rekey-awaiting-keys');
  const refused = await lead.p.appendOwn('doc.client', data);
  assert.equal('refused' in refused && refused.refused, 'rekey-pending');
  assert.deepEqual(formatsOf(lead.at, base, 2), []);

  assert.equal(await publish(lead), 'published');
  ok(await finishRekeys(lead.host), 'finish after the lead publishes hybrid keys');
  const written = await lead.p.appendOwn('doc.client', data);
  assert.ok('ok' in written);
  assert.equal(written.built.entry.header.epoch, 2);
  assert.deepEqual(formatsOf(lead.at, base, 2), [2]);
  assert.deepEqual(formatsOf(lead.at, labelled.cell, 2), [2]);
});

test('device revocation: the rekey without the revoked device is v2 only', async () => {
  const lead = await leadWith({ label: 'revoke' });
  const pat = await bringIn(lead, 'revoke-pat', 'Pat Analyst', orgClearance('Internal'));
  ok(await removeFromProject(lead.host, { member: pat.member, writer: pat.writer }), 'revoke Pat\'s computer');
  const rekeyed = wrapsOn(lead.at).filter((item) => item.cell === lead.p.projectId && item.epoch === 2);
  assert.ok(rekeyed.length > 0);
  assert.deepEqual([...new Set(rekeyed.map((item) => item.format))], [2]);
});

test('marking narrowing: a lowered clearance moves the cell to a v2 epoch without the member; a raised one gives v2 grants', async () => {
  const lead = await leadWith({ label: 'narrowing' });
  const made = await ensureLabelCell(lead.host, orgLabel('Confidential'));
  assert.ok(made.ok);
  if (!made.ok) return;
  const pat = await bringIn(lead, 'narrowing-pat', 'Pat Analyst', orgClearance('Confidential'));
  ok(await updateMember(lead.host, { member: pat.member, clearance: orgClearance('Internal') }), 'lower');
  const rekeyed = wrapsOn(lead.at).filter((item) => item.cell === made.cell && item.epoch === 2);
  assert.deepEqual([...new Set(rekeyed.map((item) => item.format))], [2]);
  assert.equal(rekeyed.some((item) => item.writer === pat.writer), false);
  ok(await updateMember(lead.host, { member: pat.member, clearance: orgClearance('Confidential') }), 'raise');
  const given = wrapsOn(lead.at).filter((item) => item.cell === made.cell && item.writer === pat.writer);
  assert.deepEqual([...new Set(given.map((item) => item.format))], [2]);
});

test('a device without post-quantum keys gets no wrap of a new epoch and is listed as waiting; it never gets the older format instead', async () => {
  const lead = await leadWith({ label: 'waiting' });
  const at = install('waiting-old');
  at.deps.knownFeatures = knownReplicaFeatures(false);
  const invited = ok(await inviteToProject(lead.host, { name: 'Old Computer', seat: 'j4-planner', clearance: orgClearance('Internal') }), 'invite');
  const joined = ok(await joinFromInvite(at.root, at.deps, invited.file?.text, { name: 'Old Computer' }), 'join');
  const admitted = ok(await admitJoinRequest(lead.host, joined.file?.text, { codeMatched: true }), 'admit');
  const writer = joined.writer as string;
  assert.ok(admitted.ok);
  const made = await ensureLabelCell(lead.host, orgLabel('Internal'));
  assert.ok(made.ok);
  if (!made.ok) return;
  assert.deepEqual(made.waiting, [writer]);
  assert.equal(wrapsOn(lead.at).some((item) => item.cell === made.cell && item.writer === writer), false);
  // The base cell's first epoch is from before the switch, so the older computer may still read the roster.
  assert.deepEqual(formatsOf(lead.at, lead.p.projectId, 1).includes(1), true);
});

test('without wrap@2 a label cell is founded and given with v1 wraps, as before', async () => {
  const lead = await unswitchedLead();
  assert.equal(await switchedAt(lead), undefined);
  const made = await ensureLabelCell(lead.host, orgLabel('Internal'));
  assert.ok(made.ok);
  if (!made.ok) return;
  assert.deepEqual(formatsOf(lead.at, made.cell), [1]);
  assert.deepEqual(formatsOf(lead.at, lead.p.projectId), [1]);
});

test('without wrap@2 a Protected B cell is refused with the switch sentence and nothing is written; a Protected A cell is wrapped v1', async () => {
  const lead = await unswitchedLead(PROTECTED_B_CLEARANCE);
  const before = wrapsOn(lead.at).length;
  const refusedB = await ensureLabelCell(lead.host, PROTECTED_B);
  assert.deepEqual(refusedB, { ok: false, reason: 'switch-first', message: SWITCH_FIRST_TEXT });
  assert.equal(SWITCH_FIRST_TEXT, 'Switch this shared work to post-quantum keys before sharing Protected B work.');
  assert.equal(wrapsOn(lead.at).length, before);
  const madeA = await ensureLabelCell(lead.host, PROTECTED_A);
  assert.ok(madeA.ok);
  if (madeA.ok) assert.deepEqual(formatsOf(lead.at, madeA.cell), [1]);
});

test('with wrap@2 a Protected B cell is shared, with v2 wraps only', async () => {
  const lead = await leadWith({ label: 'protected-switched', clearance: PROTECTED_B_CLEARANCE });
  const made = await ensureLabelCell(lead.host, PROTECTED_B);
  assert.ok(made.ok);
  if (made.ok) assert.deepEqual(formatsOf(lead.at, made.cell), [2]);
});

test('across every path above in one switched project, no grant holds an X25519 wrap for an epoch founded after the switch', async () => {
  const lead = await leadWith({ label: 'all-paths' });
  const made = await ensureLabelCell(lead.host, orgLabel('Internal'));
  assert.ok(made.ok);
  const pat = await bringIn(lead, 'all-pat', 'Pat Analyst', orgClearance('Internal'));
  const quinn = await bringIn(lead, 'all-quinn', 'Quinn Planner', orgClearance('Internal'));
  ok(await removeFromProject(lead.host, { member: pat.member }), 'remove');
  ok(await updateMember(lead.host, { member: quinn.member, clearance: orgClearance('Public') }), 'lower');
  const { roster } = await lead.p.state();
  const switched = roster.requiredFrom.get(WRAP_V2_FEATURE) as number;
  for (const item of wrapsOn(lead.at)) {
    const founded = roster.cells.cells.get(item.cell)?.epochs.find((epoch) => epoch.epoch === item.epoch)?.from as number;
    if (founded > switched) assert.equal(item.format, 2, `cell ${item.cell} epoch ${item.epoch}`);
  }
});
