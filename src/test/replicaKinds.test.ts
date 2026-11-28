// The closed schemas of the project, roster, registers, watches, runs and obs families, the project reducer, and the kept families (plan 30-04, tasks 2 and 3).
// Hostile JSON for prototype keys comes from JSON.parse text, because an object literal would not make an own __proto__ key.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { REPLICA_KINDS, validateData } from '../domain/replica/kinds';
import { LEGACY_FILE_MAX_BYTES } from '../domain/replica/kindSchemas/project';
import { PROJECT_REFUSALS, projectReducer } from '../domain/replica/projectFold';
import type { ProjectOutput } from '../domain/replica/projectFold';
import type { FoldView } from '../domain/replica/reducers';
import { ROSTER_KIND_OWNER } from '../domain/replica/roster';
import { verifyEntry } from '../domain/replica/verify';
import type { VerifiedEntry } from '../domain/replica/verify';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { textReducer } from '../domain/replica/textFold';
import { signPayload } from '../domain/team/signedPayload';
import { WORLD_AT, createWorld, fixedSigner, streamId, updateData } from './helpers/replicaWorld';
import type { World } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';
const HASH = (letter: string): string => letter.repeat(64);
const PREV = HASH('1');

type Data = Record<string, unknown>;
interface Sample { kind: string; data: Data; required: readonly string[] }

function device(label: string): Data {
  const fixed = fixedSigner(label);
  return { writer: fixed.writer, publicKey: fixed.publicKey, x25519: Buffer.alloc(32, 7).toString('base64url'), x25519Sig: Buffer.alloc(64, 9).toString('base64url') };
}
const clearance = (): Data => ({ scale: 'org', level: 'Confidential', compartments: ['ALPHA', 'BRAVO'], releasability: ['CAN'] });
const withKey = (data: Data, key: string, value: unknown): Data => ({ ...data, [key]: value });
function without(data: Data, key: string): Data {
  const copy: Data = { ...data };
  delete copy[key];
  return copy;
}
// An own __proto__ key, which only JSON.parse can make.
function withPrototypeKey(data: Data): Data {
  return JSON.parse(`${JSON.stringify(data).slice(0, -1)},"__proto__":{"admin":true}}`) as Data;
}

const PROJECT_AND_ROSTER: Sample[] = [
  { kind: 'project.genesis', data: { project: streamId('project'), name: 'Operation Example', profile: 'staff-j2', labelMapHash: HASH('a'), lead: { member: 'mbr-lead', writer: HASH('b') } }, required: ['project', 'name', 'profile', 'labelMapHash', 'lead'] },
  { kind: 'project.import', data: { ledger: 'products', legacyHead: HASH('c'), count: 12 }, required: ['ledger', 'legacyHead', 'count'] },
  { kind: 'member.invite', data: { invite: 'inv-1', name: 'Bo Chen', seat: 'j2-chief', roles: ['member', 'decision_for:commander'], clearance: clearance(), expiresAt: '2026-11-26T12:00:00.000Z', secretHash: HASH('d'), rosterPrev: PREV }, required: ['invite', 'name', 'seat', 'roles', 'clearance', 'expiresAt', 'secretHash', 'rosterPrev'] },
  { kind: 'member.admit', data: { member: 'mbr-bo', invite: 'inv-1', name: 'Bo Chen', seat: 'j2-chief', roles: ['member'], clearance: clearance(), device: device('bo-1'), rosterPrev: PREV }, required: ['member', 'invite', 'name', 'seat', 'roles', 'clearance', 'device', 'rosterPrev'] },
  { kind: 'member.update', data: { member: 'mbr-bo', roles: ['member', 'section_lead:j2'], rosterPrev: PREV }, required: ['member', 'rosterPrev'] },
  { kind: 'member.remove', data: { member: 'mbr-bo', rosterPrev: PREV }, required: ['member', 'rosterPrev'] },
  { kind: 'device.add', data: { member: 'mbr-bo', device: device('bo-2'), rosterPrev: PREV }, required: ['member', 'device', 'rosterPrev'] },
  { kind: 'device.rotate', data: { member: 'mbr-bo', from: HASH('e'), device: device('bo-3'), rosterPrev: PREV }, required: ['member', 'from', 'device', 'rosterPrev'] },
  { kind: 'device.revoke', data: { member: 'mbr-bo', writer: HASH('e'), rosterPrev: PREV }, required: ['member', 'writer', 'rosterPrev'] },
  { kind: 'device.quarantine', data: { writer: HASH('e'), stream: streamId('main'), seq: 4, rosterPrev: PREV }, required: ['writer', 'stream', 'seq', 'rosterPrev'] },
  { kind: 'device.release', data: { writer: HASH('e'), stream: streamId('main'), seq: 4, branch: HASH('f'), rosterPrev: PREV }, required: ['writer', 'stream', 'seq', 'branch', 'rosterPrev'] },
  { kind: 'hub.admit', data: { hub: 'site-hub', device: device('hub-1'), certPin: HASH('9'), ceiling: clearance(), rosterPrev: PREV }, required: ['hub', 'device', 'certPin', 'ceiling', 'rosterPrev'] },
  { kind: 'hub.grant', data: { hub: 'site-hub', cell: streamId('cell-1'), rosterPrev: PREV }, required: ['hub', 'cell', 'rosterPrev'] },
  { kind: 'hub.revoke', data: { hub: 'site-hub', rosterPrev: PREV }, required: ['hub', 'rosterPrev'] },
  { kind: 'cell.create', data: { cell: streamId('cell-2'), rosterPrev: PREV }, required: ['cell', 'rosterPrev'] },
  { kind: 'cell.rekey', data: { cell: streamId('cell-2'), epoch: 1, reason: 'member-removed', rosterPrev: PREV }, required: ['cell', 'epoch', 'reason', 'rosterPrev'] },
  { kind: 'lead.handover', data: { to: 'mbr-deputy', reason: 'lead-lost', rosterPrev: PREV }, required: ['to', 'reason', 'rosterPrev'] },
  { kind: 'roster.choose', data: { chosen: HASH('8'), rosterPrev: PREV }, required: ['chosen', 'rosterPrev'] },
  { kind: 'deputy.name', data: { member: 'mbr-deputy', rosterPrev: PREV }, required: ['member', 'rosterPrev'] },
  { kind: 'invite.void', data: { invite: 'inv-1', rosterPrev: PREV }, required: ['invite', 'rosterPrev'] },
  { kind: 'roster.require', data: { features: ['positions@1', 'require@1'], rosterPrev: PREV }, required: ['features', 'rosterPrev'] },
  { kind: 'hub.readmit', data: { hub: 'hub-main', certPin: HASH('9'), fromCheckpoint: HASH('a'), rosterPrev: PREV }, required: ['hub', 'certPin', 'rosterPrev'] },
  { kind: 'cell.access.commit', data: { accessRevision: HASH('b'), accessRoot: HASH('c'), rosterPrev: PREV }, required: ['accessRevision', 'accessRoot', 'rosterPrev'] }
];

// The roster kinds Phase 33.1 adds, routed to the positions module.
const ROSTER_KIND_OWNER_33_1: ReadonlySet<string> = new Set(Object.keys(ROSTER_KIND_OWNER).filter((kind) => ROSTER_KIND_OWNER[kind] === 'positions'));

function reasonOf(kind: string, data: unknown): string {
  const check = validateData(kind, data);
  assert.equal(check.ok, false, `${kind} ${JSON.stringify(data).slice(0, 80)} should fail`);
  return check.ok ? '' : check.reason;
}

// ---- project and roster schemas ----

test('one valid sample per project and roster kind (23 kinds) passes, and a missing field, an extra field and a __proto__ key each fail with a reason naming the path', () => {
  assert.equal(PROJECT_AND_ROSTER.length, 23, 'roster.require (POST-01), hub.readmit (D-42), Phase 33; cell.access.commit');
  for (const sample of PROJECT_AND_ROSTER) {
    assert.deepEqual(validateData(sample.kind, sample.data), { ok: true }, sample.kind);
    for (const key of sample.required) {
      const reason = reasonOf(sample.kind, without(sample.data, key));
      assert.ok(reason.startsWith('bad-data:') && reason.includes(`data.${key}`), `${sample.kind} without ${key}: ${reason}`);
    }
    const extra = reasonOf(sample.kind, withKey(sample.data, 'extra', 1));
    assert.ok(extra.includes('data.extra'), `${sample.kind}: ${extra}`);
    const proto = reasonOf(sample.kind, withPrototypeKey(sample.data));
    assert.ok(proto.startsWith('bad-data:') && proto.includes('__proto__'), `${sample.kind}: ${proto}`);
    for (const wrong of [null, 5, 'text', [], [sample.data]]) assert.equal(validateData(sample.kind, wrong).ok, false, `${sample.kind} ${JSON.stringify(wrong)}`);
  }
});

test('every one of the 21 roster kinds requires rosterPrev as a 64-hex hash (DESIGN 7.1)', () => {
  const roster = PROJECT_AND_ROSTER.filter((sample) => !sample.kind.startsWith('project.'));
  assert.equal(roster.length, 21, 'roster.require (POST-01), hub.readmit (D-42), Phase 33; cell.access.commit');
  for (const sample of roster) {
    assert.ok(sample.required.includes('rosterPrev'), sample.kind);
    for (const bad of ['1'.repeat(63), '1'.repeat(65), 'G'.repeat(64), 5, null, '', HASH('A')]) {
      const reason = reasonOf(sample.kind, withKey(sample.data, 'rosterPrev', bad));
      assert.ok(reason.includes('data.rosterPrev'), `${sample.kind}: ${reason}`);
    }
  }
  // The first roster entry follows nothing: 64 zeros are a valid rosterPrev.
  assert.deepEqual(validateData('deputy.name', { member: 'mbr-deputy', rosterPrev: '0'.repeat(64) }), { ok: true });
});

test('deputy.name names a member slug and nothing else', () => {
  assert.deepEqual(validateData('deputy.name', { member: 'mbr-deputy', rosterPrev: PREV }), { ok: true });
  for (const bad of ['', 'Mbr Deputy', 'mbr/deputy', 'x'.repeat(65), 7, null]) {
    assert.ok(reasonOf('deputy.name', { member: bad, rosterPrev: PREV }).includes('data.member'));
  }
});

test('roster field limits: roles, clearances, devices, names, times, counts and reasons each refuse the wrong value at their own path', () => {
  const invite = PROJECT_AND_ROSTER.find((sample) => sample.kind === 'member.invite')?.data as Data;
  const admit = PROJECT_AND_ROSTER.find((sample) => sample.kind === 'member.admit')?.data as Data;
  const hub = PROJECT_AND_ROSTER.find((sample) => sample.kind === 'hub.admit')?.data as Data;
  const refusals: Array<[string, Data, string]> = [
    ['member.invite', withKey(invite, 'roles', ['admin']), 'data.roles[0]'],
    ['member.invite', withKey(invite, 'roles', ['member', 'member']), 'data.roles[1]'],
    ['member.invite', withKey(invite, 'roles', Array.from({ length: 17 }, (_, index) => `section_lead:s${index}`)), 'data.roles'],
    ['member.invite', withKey(invite, 'roles', 'member'), 'data.roles'],
    ['member.invite', withKey(invite, 'name', 'Bo\nChen'), 'data.name'],
    ['member.invite', withKey(invite, 'name', ' Bo'), 'data.name'],
    ['member.invite', withKey(invite, 'name', 'x'.repeat(121)), 'data.name'],
    ['member.invite', withKey(invite, 'expiresAt', '2026-13-40T00:00:00.000Z'), 'data.expiresAt'],
    ['member.invite', withKey(invite, 'secretHash', 'abc'), 'data.secretHash'],
    ['member.invite', withKey(invite, 'clearance', { ...clearance(), extra: 1 }), 'data.clearance.extra'],
    ['member.invite', withKey(invite, 'clearance', without(clearance(), 'level')), 'data.clearance.level'],
    ['member.invite', withKey(invite, 'clearance', { ...clearance(), level: '<script>' }), 'data.clearance.level'],
    ['member.invite', withKey(invite, 'clearance', { ...clearance(), compartments: ['alpha'] }), 'data.clearance.compartments[0]'],
    ['member.invite', withKey(invite, 'clearance', { ...clearance(), compartments: ['ALPHA', 'ALPHA'] }), 'data.clearance.compartments[1]'],
    ['member.invite', withKey(invite, 'clearance', { ...clearance(), releasability: 'CAN' }), 'data.clearance.releasability'],
    ['member.invite', withKey(invite, 'clearance', { ...clearance(), handling: ['no-such-flag'] }), 'data.clearance.handling[0]'],
    ['member.invite', withKey(invite, 'clearance', { ...clearance(), expiresAt: 'soon' }), 'data.clearance.expiresAt'],
    ['member.admit', withKey(admit, 'device', { ...(admit.device as Data), publicKey: 'AAAA' }), 'data.device.publicKey'],
    ['member.admit', withKey(admit, 'device', { ...(admit.device as Data), x25519: Buffer.alloc(31, 1).toString('base64url') }), 'data.device.x25519'],
    ['member.admit', withKey(admit, 'device', { ...(admit.device as Data), x25519Sig: Buffer.alloc(63, 1).toString('base64url') }), 'data.device.x25519Sig'],
    ['member.admit', withKey(admit, 'device', { ...(admit.device as Data), writer: HASH('0') }), 'data.device.writer'],
    ['member.admit', withKey(admit, 'device', { ...(admit.device as Data), extra: 1 }), 'data.device.extra'],
    ['hub.admit', withKey(hub, 'ceiling', 'secret'), 'data.ceiling'],
    ['device.quarantine', { writer: HASH('e'), stream: streamId('main'), seq: -1, rosterPrev: PREV }, 'data.seq'],
    ['device.quarantine', { writer: HASH('e'), stream: 'short', seq: 1, rosterPrev: PREV }, 'data.stream'],
    ['device.release', { writer: HASH('e'), stream: streamId('main'), seq: 1.5, branch: HASH('f'), rosterPrev: PREV }, 'data.seq'],
    ['cell.rekey', { cell: streamId('c'), epoch: 0, reason: 'scheduled', rosterPrev: PREV }, 'data.epoch'],
    ['cell.rekey', { cell: streamId('c'), epoch: 2, reason: 'because', rosterPrev: PREV }, 'data.reason'],
    ['lead.handover', { to: 'mbr-deputy', reason: 'retired', rosterPrev: PREV }, 'data.reason'],
    ['member.update', { member: 'mbr-bo', rosterPrev: PREV }, 'data'],
    ['member.update', { member: 'mbr-bo', roles: ['member', 'owner'], rosterPrev: PREV }, 'data.roles[1]'],
    ['member.remove', { member: 'mbr-bo', reason: 'a\tb', rosterPrev: PREV }, 'data.reason'],
    ['device.revoke', { member: 'mbr-bo', writer: HASH('e'), reason: 'x'.repeat(201), rosterPrev: PREV }, 'data.reason'],
    ['roster.choose', { chosen: 'nope', rosterPrev: PREV }, 'data.chosen'],
    ['cell.create', { cell: HASH('a'), rosterPrev: PREV }, 'data.cell']
  ];
  for (const [kind, data, path] of refusals) {
    const reason = reasonOf(kind, data);
    assert.ok(reason.startsWith('bad-data:') && reason.includes(path), `${kind} should name ${path}: ${reason}`);
  }
});

test('optional roster fields, every role word and the clearance extras are accepted when valid', () => {
  const invite = PROJECT_AND_ROSTER.find((sample) => sample.kind === 'member.invite')?.data as Data;
  const allRoles = ['staff_lead', 'deputy_lead', 'member', 'section_lead:j2', 'answers_for:j2', 'decision_for:commander'];
  assert.deepEqual(validateData('member.invite', withKey(invite, 'roles', allRoles)), { ok: true });
  assert.deepEqual(validateData('member.invite', withKey(invite, 'roles', [])), { ok: true });
  assert.deepEqual(validateData('member.invite', withKey(invite, 'clearance', { ...clearance(), handling: ['local-only', 'no-agent-tools'], expiresAt: '2027-01-01T00:00:00.000Z' })), { ok: true });
  for (const update of [{ name: 'New Name' }, { seat: 'j3-chief' }, { clearance: clearance() }, { roles: ['member'] }, { name: 'A', seat: 'b', roles: [], clearance: clearance() }]) {
    assert.deepEqual(validateData('member.update', { member: 'mbr-bo', rosterPrev: PREV, ...update }), { ok: true }, JSON.stringify(update));
  }
  assert.deepEqual(validateData('member.remove', { member: 'mbr-bo', reason: 'left the project', rosterPrev: PREV }), { ok: true });
  assert.deepEqual(validateData('device.revoke', { member: 'mbr-bo', writer: HASH('e'), reason: 'lost laptop', rosterPrev: PREV }), { ok: true });
  assert.deepEqual(validateData('hub.revoke', { hub: 'site-hub', reason: 'key lost', rosterPrev: PREV }), { ok: true });
  for (const reason of ['member-removed', 'device-revoked', 'clearance-lowered', 'hub-revoked', 'scheduled']) {
    assert.deepEqual(validateData('cell.rekey', { cell: streamId('c'), epoch: 3, reason, rosterPrev: PREV }), { ok: true }, reason);
  }
  const genesis = PROJECT_AND_ROSTER[0].data;
  assert.deepEqual(validateData('project.genesis', { ...genesis, hub: { writer: HASH('2'), certPin: HASH('3') } }), { ok: true });
  assert.ok(reasonOf('project.genesis', { ...genesis, hub: { writer: HASH('2') } }).includes('data.hub'));
  assert.ok(reasonOf('project.genesis', { ...genesis, name: '' }).includes('data.name'));
  assert.ok(reasonOf('project.genesis', { ...genesis, project: HASH('a') }).includes('data.project'));
  assert.ok(reasonOf('project.genesis', { ...genesis, lead: { member: 'mbr-lead' } }).includes('data.lead'));
  assert.ok(reasonOf('project.import', { ledger: 'products', legacyHead: HASH('c'), count: -1 }).includes('data.count'));
  assert.ok(reasonOf('project.import', { ledger: 'Products File', legacyHead: HASH('c'), count: 1 }).includes('data.ledger'));
});

// ---- D-49: the genesis and roster additions Phase 31 writes (D-07, D-17, D-18, D-41, D-44) ----

test('D-49 genesis: lead.device (with its slot), level and first cells validate, and a Phase 30 genesis still does', () => {
  const genesis = PROJECT_AND_ROSTER[0].data;
  const leadDevice = device('lead-1');
  const lead = { member: 'mbr-lead', writer: leadDevice.writer as string, device: { ...leadDevice, slot: 1 } };
  const cells = [{ cell: streamId('cell-base'), epoch: 1, grant: HASH('5') }, { cell: streamId('cell-j2'), epoch: 3, grant: HASH('6') }];
  const full: Data = { ...genesis, lead, level: 'brigade', cells };
  assert.deepEqual(validateData('project.genesis', full), { ok: true });
  assert.deepEqual(validateData('project.genesis', genesis), { ok: true });
  assert.deepEqual(validateData('project.genesis', { ...genesis, lead: { ...lead, device: leadDevice } }), { ok: true });
  assert.deepEqual(validateData('project.genesis', { ...genesis, level: 'division' }), { ok: true });
  assert.deepEqual(validateData('project.genesis', { ...genesis, cells: [] }), { ok: true });
  assert.deepEqual(validateData('project.genesis', { ...full, hub: { writer: HASH('2'), certPin: HASH('3') } }), { ok: true });
  assert.deepEqual(validateData('project.genesis', { ...genesis, lead: { ...lead, device: { ...leadDevice, slot: 4095 } } }), { ok: true });
  assert.deepEqual(validateData('project.genesis', { ...genesis, cells: Array.from({ length: 64 }, (_, index) => ({ cell: streamId(`cell-${index}`), epoch: 1, grant: HASH('7') })) }), { ok: true });
  const other = device('lead-2');
  const refusals: Array<[Data, string]> = [
    // The lead's device must be the device the genesis names as the lead's writer.
    [{ ...full, lead: { ...lead, device: { ...other, slot: 1 } } }, 'data.lead.device.writer'],
    [{ ...full, lead: { ...lead, writer: HASH('b') } }, 'data.lead.device.writer'],
    [{ ...full, lead: { ...lead, device: { ...leadDevice, slot: 0 } } }, 'data.lead.device.slot'],
    [{ ...full, lead: { ...lead, device: { ...leadDevice, slot: 4096 } } }, 'data.lead.device.slot'],
    [{ ...full, lead: { ...lead, device: { ...leadDevice, slot: 1.5 } } }, 'data.lead.device.slot'],
    [{ ...full, lead: { ...lead, device: { ...leadDevice, slot: '1' } } }, 'data.lead.device.slot'],
    [{ ...full, lead: { ...lead, device: { ...leadDevice, extra: 1 } } }, 'data.lead.device.extra'],
    [{ ...full, lead: { ...lead, device: { ...leadDevice, publicKey: 'AAAA' } } }, 'data.lead.device.publicKey'],
    [{ ...full, lead: { ...lead, device: 'device' } }, 'data.lead.device'],
    [{ ...full, lead: { ...lead, extra: 1 } }, 'data.lead'],
    [{ ...full, level: 'Brigade HQ' }, 'data.level'],
    [{ ...full, level: 3 }, 'data.level'],
    [{ ...full, cells: 'cell' }, 'data.cells'],
    [{ ...full, cells: Array.from({ length: 65 }, (_, index) => ({ cell: streamId(`cell-${index}`), epoch: 1, grant: HASH('7') })) }, 'data.cells'],
    [{ ...full, cells: [{ ...cells[0], epoch: 0 }] }, 'data.cells[0].epoch'],
    [{ ...full, cells: [{ ...cells[0], epoch: 1.5 }] }, 'data.cells[0].epoch'],
    [{ ...full, cells: [cells[0], { ...cells[1], grant: 'abc' }] }, 'data.cells[1].grant'],
    [{ ...full, cells: [{ ...cells[0], cell: HASH('a') }] }, 'data.cells[0].cell'],
    [{ ...full, cells: [{ ...cells[0], extra: 1 }] }, 'data.cells[0].extra'],
    [{ ...full, cells: [{ cell: cells[0].cell, epoch: 1 }] }, 'data.cells[0].grant'],
    [{ ...full, cells: [cells[0], { ...cells[0], epoch: 2 }] }, 'data.cells[1].cell'],
    [{ ...full, cells: ['cell'] }, 'data.cells[0]']
  ];
  for (const [data, path] of refusals) {
    const reason = reasonOf('project.genesis', data);
    assert.ok(reason.startsWith('bad-data:') && reason.includes(path), `should name ${path}: ${reason}`);
  }
});

test('D-49 roster: forMember, agentSeats, device slots, the device.add invite, cell epochs and grants, and invite.void validate', () => {
  const admit = PROJECT_AND_ROSTER.find((sample) => sample.kind === 'member.admit')?.data as Data;
  const invite = PROJECT_AND_ROSTER.find((sample) => sample.kind === 'member.invite')?.data as Data;
  const valid: Array<[string, Data]> = [
    ['member.invite', { ...invite, forMember: 'mbr-bo' }],
    ['member.admit', { ...admit, agentSeats: ['release-guard'], device: { ...(admit.device as Data), slot: 2 } }],
    ['member.admit', { ...admit, agentSeats: [] }],
    ['member.admit', { ...admit, agentSeats: Array.from({ length: 16 }, (_, index) => `seat-${index}`) }],
    ['member.update', { member: 'mbr-bo', agentSeats: ['release-guard'], rosterPrev: PREV }],
    ['member.update', { member: 'mbr-bo', agentSeats: [], rosterPrev: PREV }],
    ['member.update', { member: 'mbr-bo', roles: ['member'], agentSeats: ['tradecraft', 'release-guard'], rosterPrev: PREV }],
    ['device.add', { member: 'mbr-bo', device: { ...device('bo-2'), slot: 3 }, invite: 'inv-2', rosterPrev: PREV }],
    ['device.add', { member: 'mbr-bo', device: device('bo-2'), invite: 'inv-2', rosterPrev: PREV }],
    ['device.rotate', { member: 'mbr-bo', from: HASH('e'), device: { ...device('bo-3'), slot: 4095 }, rosterPrev: PREV }],
    ['hub.admit', { hub: 'site-hub', device: { ...device('hub-1'), slot: 9 }, certPin: HASH('9'), ceiling: clearance(), rosterPrev: PREV }],
    ['cell.create', { cell: streamId('cell-2'), epoch: 1, grant: HASH('6'), rosterPrev: PREV }],
    ['cell.rekey', { cell: streamId('cell-2'), epoch: 2, reason: 'member-removed', grant: HASH('7'), rosterPrev: PREV }],
    ['invite.void', { invite: 'inv-1', rosterPrev: PREV }]
  ];
  for (const [kind, data] of valid) assert.deepEqual(validateData(kind, data), { ok: true }, `${kind} ${JSON.stringify(data).slice(0, 120)}`);
  const refusals: Array<[string, Data, string]> = [
    ['member.invite', { ...invite, forMember: 'Mbr Bo' }, 'data.forMember'],
    ['member.admit', { ...admit, agentSeats: Array.from({ length: 17 }, (_, index) => `seat-${index}`) }, 'data.agentSeats'],
    ['member.admit', { ...admit, agentSeats: ['Release Guard'] }, 'data.agentSeats[0]'],
    ['member.admit', { ...admit, agentSeats: ['release-guard', 'release-guard'] }, 'data.agentSeats[1]'],
    ['member.admit', { ...admit, agentSeats: 'release-guard' }, 'data.agentSeats'],
    ['member.admit', { ...admit, device: { ...(admit.device as Data), slot: 0 } }, 'data.device.slot'],
    ['member.admit', { ...admit, device: { ...(admit.device as Data), slot: 4096 } }, 'data.device.slot'],
    ['member.update', { member: 'mbr-bo', agentSeats: Array.from({ length: 17 }, (_, index) => `seat-${index}`), rosterPrev: PREV }, 'data.agentSeats'],
    ['member.update', { member: 'mbr-bo', agentSeats: [7], rosterPrev: PREV }, 'data.agentSeats[0]'],
    ['device.add', { member: 'mbr-bo', device: device('bo-2'), invite: 'inv 2', rosterPrev: PREV }, 'data.invite'],
    ['device.add', { member: 'mbr-bo', device: { ...device('bo-2'), slot: -1 }, rosterPrev: PREV }, 'data.device.slot'],
    ['device.rotate', { member: 'mbr-bo', from: HASH('e'), device: { ...device('bo-3'), slot: 4096 }, rosterPrev: PREV }, 'data.device.slot'],
    ['hub.admit', { hub: 'site-hub', device: { ...device('hub-1'), slot: null }, certPin: HASH('9'), ceiling: clearance(), rosterPrev: PREV }, 'data.device.slot'],
    ['cell.create', { cell: streamId('cell-2'), epoch: 0, grant: HASH('6'), rosterPrev: PREV }, 'data.epoch'],
    ['cell.create', { cell: streamId('cell-2'), epoch: 1, grant: 'abc', rosterPrev: PREV }, 'data.grant'],
    ['cell.create', { cell: streamId('cell-2'), epoch: 1, grant: HASH('G'), rosterPrev: PREV }, 'data.grant'],
    ['cell.rekey', { cell: streamId('cell-2'), epoch: 2, reason: 'scheduled', grant: 'nope', rosterPrev: PREV }, 'data.grant'],
    ['invite.void', { invite: 'Inv 1', rosterPrev: PREV }, 'data.invite'],
    ['invite.void', { invite: 'inv-1', reason: 'not needed', rosterPrev: PREV }, 'data.reason']
  ];
  for (const [kind, data, path] of refusals) {
    const reason = reasonOf(kind, data);
    assert.ok(reason.startsWith('bad-data:') && reason.includes(path), `${kind} should name ${path}: ${reason}`);
  }
});

// ---- the project reducer and kept roster entries ----

function projectWorld(): World {
  return createWorld({ members: [
    { member: 'mbr-lead', name: 'Lead', roles: ['staff_lead', 'member'], devices: ['L1', 'L2'] },
    { member: 'mbr-ada', name: 'Ada', roles: ['member'], devices: ['A'] }
  ] });
}
function genesisData(world: World, overrides: Data = {}): Data {
  return { project: streamId('project'), name: 'Operation Example', profile: 'staff-j2', labelMapHash: HASH('a'), lead: { member: 'mbr-lead', writer: world.writerOf('L1') }, ...overrides };
}
const REDUCERS = { reducers: [textReducer, projectReducer] };
const projectOf = (result: FoldResult): ProjectOutput => result.families.project as ProjectOutput;

test('project.genesis by a staff lead is applied and the fold shows project id, name, profile, label map hash and lead device', () => {
  const world = projectWorld();
  const genesis = world.write('L1', { kind: 'project.genesis', data: genesisData(world) });
  const result = foldEntries([genesis.entry], world.ctx(), REDUCERS);
  assert.deepEqual(result.applied, [genesis.hash]);
  assert.deepEqual([result.refused, result.held, result.rejected, result.kept], [[], [], [], []]);
  assert.deepEqual(projectOf(result), [{
    stream: world.stream,
    genesis: genesis.hash,
    project: streamId('project'),
    name: 'Operation Example',
    profile: 'staff-j2',
    labelMapHash: HASH('a'),
    lead: { member: 'mbr-lead', writer: world.writerOf('L1') },
    hub: null,
    imports: []
  }]);
});

test('the same genesis from a member without staff_lead is refused not-staff-lead and leaves no project', () => {
  const world = projectWorld();
  const forged = world.write('A', { kind: 'project.genesis', data: genesisData(world, { lead: { member: 'mbr-ada', writer: world.writerOf('A') } }) });
  const result = foldEntries([forged.entry], world.ctx(), REDUCERS);
  assert.deepEqual(result.refused, [{ hash: forged.hash, reason: 'not-staff-lead', family: 'project' }]);
  assert.deepEqual(projectOf(result), []);
  assert.deepEqual(result.applied, []);
  // A real genesis next to the forged one still wins, in either delivery order.
  const real = world.write('L1', { kind: 'project.genesis', data: genesisData(world) });
  for (const entries of [[forged.entry, real.entry], [real.entry, forged.entry]]) {
    const both = foldEntries(entries, world.ctx(), REDUCERS);
    assert.equal(projectOf(both)[0].genesis, real.hash);
    assert.deepEqual(both.refused.map((item) => item.reason), ['not-staff-lead']);
  }
});

test('a second, different genesis is refused second-genesis whatever the delivery order, and a repeat of the same genesis is not', () => {
  const world = projectWorld();
  const first = world.write('L1', { kind: 'project.genesis', data: genesisData(world) });
  const other = world.write('L2', { kind: 'project.genesis', data: genesisData(world, { name: 'A different project', lead: { member: 'mbr-lead', writer: world.writerOf('L2') } }) });
  const forward = foldEntries([first.entry, other.entry], world.ctx(), REDUCERS);
  const backward = foldEntries([other.entry, first.entry], world.ctx(), REDUCERS);
  assert.deepEqual(forward.refused, backward.refused);
  assert.deepEqual(forward.refused.map((item) => item.reason), ['second-genesis']);
  assert.deepEqual(forward.families.project, backward.families.project);
  assert.deepEqual(forward.digests, backward.digests);
  assert.equal(forward.applied.length, 1);
  assert.equal(forward.applied[0], projectOf(forward)[0].genesis);

  // The same writer's own second genesis with the same content is a repeat, not a second project.
  const repeat = world.write('L1', { kind: 'project.genesis', data: genesisData(world) });
  const again = foldEntries([first.entry, repeat.entry], world.ctx(), REDUCERS);
  assert.deepEqual(again.refused, []);
  assert.equal(projectOf(again)[0].genesis, first.hash);
  const changed = world.write('L1', { kind: 'project.genesis', data: genesisData(world, { profile: 'staff-j3' }) });
  assert.deepEqual(foldEntries([first.entry, repeat.entry, changed.entry], world.ctx(), REDUCERS).refused.map((item) => item.reason), ['second-genesis']);
});

test('project.import is applied and listed with ledger, legacy head and count, once however often it is repeated, and only from a staff lead', () => {
  const world = projectWorld();
  const genesis = world.write('L1', { kind: 'project.genesis', data: genesisData(world) });
  const products = world.write('L1', { kind: 'project.import', data: { ledger: 'products', legacyHead: HASH('c'), count: 12 } });
  const decisions = world.write('L1', { kind: 'project.import', data: { ledger: 'decisions', legacyHead: HASH('d'), count: 3 } });
  const again = world.write('L1', { kind: 'project.import', data: { ledger: 'products', legacyHead: HASH('c'), count: 12 } });
  const foreign = world.write('A', { kind: 'project.import', data: { ledger: 'calculator', legacyHead: HASH('e'), count: 1 } });
  const result = foldEntries([genesis, products, decisions, again, foreign].map((item) => item.entry), world.ctx(), REDUCERS);
  assert.deepEqual(projectOf(result)[0].imports.map((item) => [item.ledger, item.legacyHead, item.count]), [['decisions', HASH('d'), 3], ['products', HASH('c'), 12]]);
  assert.deepEqual(result.refused, [{ hash: foreign.hash, reason: 'not-staff-lead', family: 'project' }]);
  assert.equal(result.applied.length, 4);
});

// ---- D-31, D-49: a project.import carries the whole legacy file and the product ledger's signed head mark ----

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

// A fictional products ledger: the same JSON line repeated and cut to the size asked for.
function legacyLedgerBytes(size: number): Buffer {
  const line = '{"seq":1,"kind":"propose","product":"intel-estimate","note":"A fictional ledger line for the import tests."}\n';
  return Buffer.from(line.repeat(Math.ceil(size / line.length)).slice(0, size), 'utf8');
}
// The product ledger's head mark as today's host keeps it: one line of JSON, a staff-ledger-head envelope.
function headMark(count: number, head: string): string {
  return JSON.stringify(signPayload(fixedSigner('lead-mark').signer, 'staff-ledger-head', { v: 1, count, head }, { now: () => new Date(WORLD_AT) }));
}

test('D-31 tracer: a project.import carrying a 300 KB legacy file and its signed head mark moves into a sealed blob, folds, and lists the file hash', () => {
  const world = projectWorld();
  const genesis = world.write('L1', { kind: 'project.genesis', data: genesisData(world) });
  const file = legacyLedgerBytes(300 * 1024);
  const mark = headMark(12, HASH('c'));
  assert.equal(mark.includes('\n'), false);
  const data = { ledger: 'products', legacyHead: HASH('c'), count: 12, file: file.toString('base64url'), mark };
  assert.deepEqual(validateData('project.import', data), { ok: true });
  const blobsBefore = world.blobs.size;
  const imported = world.write('L1', { kind: 'project.import', data });
  // The body is far over the inline limit, so buildEntry moved the data into one sealed blob.
  assert.equal(world.blobs.size, blobsBefore + 1);
  const result = foldEntries([genesis.entry, imported.entry], world.ctx(), REDUCERS);
  assert.deepEqual([...result.applied].sort(), [genesis.hash, imported.hash].sort());
  assert.deepEqual([result.refused, result.held, result.rejected], [[], [], []]);
  assert.deepEqual(projectOf(result)[0].imports, [{
    ledger: 'products', legacyHead: HASH('c'), count: 12, entry: imported.hash, member: 'mbr-lead', writer: world.writerOf('L1'), fileHash: sha256Hex(file), marked: true, scope: 'whole'
  }]);
  // Without the blob the import waits for it and lists nothing.
  const withoutBlob = foldEntries([genesis.entry, imported.entry], world.ctx({ blobs: () => undefined }), REDUCERS);
  assert.deepEqual(withoutBlob.held.map((held) => [held.hash, held.reason]), [[imported.hash, 'missing-blob']]);
  assert.deepEqual(projectOf(withoutBlob)[0].imports, []);
});

test('D-31: an import file over 2 MiB decoded, a file that is not strict base64url and a mark that is not one line are each refused at their path', () => {
  const base = { ledger: 'products', legacyHead: HASH('c'), count: 12 };
  const atLimit = Buffer.alloc(LEGACY_FILE_MAX_BYTES, 0x61);
  const overLimit = Buffer.alloc(LEGACY_FILE_MAX_BYTES + 1, 0x61);
  assert.equal(LEGACY_FILE_MAX_BYTES, 2 * 1024 * 1024);
  assert.deepEqual(validateData('project.import', { ...base, file: atLimit.toString('base64url') }), { ok: true });
  const mark = headMark(12, HASH('c'));
  const refusals: Array<[Data, string]> = [
    [{ ...base, file: overLimit.toString('base64url') }, 'data.file'],
    [{ ...base, file: 'not base64url!' }, 'data.file'],
    [{ ...base, file: Buffer.from('ledger line').toString('base64') + '=' }, 'data.file'],
    [{ ...base, file: 'QQ+/' }, 'data.file'],
    // A tail that is not the canonical encoding of its bytes.
    [{ ...base, file: 'QR' }, 'data.file'],
    [{ ...base, file: 7 }, 'data.file'],
    [{ ...base, file: null }, 'data.file'],
    [{ ...base, mark: `${mark}\n` }, 'data.mark'],
    [{ ...base, mark: mark.replace('{', '{\n') }, 'data.mark'],
    [{ ...base, mark: '' }, 'data.mark'],
    [{ ...base, mark: 'x'.repeat(4097) }, 'data.mark'],
    [{ ...base, mark: { signed: true } }, 'data.mark'],
    [{ ...base, file: 'QQ', mark, extra: 1 }, 'data.extra']
  ];
  for (const [data, path] of refusals) {
    const reason = reasonOf('project.import', data);
    assert.ok(reason.startsWith('bad-data:') && reason.includes(path), `should name ${path}: ${reason}`);
  }
  assert.deepEqual(validateData('project.import', { ...base, mark: 'x'.repeat(4096) }), { ok: true });
  assert.deepEqual(validateData('project.import', { ...base, file: 'QQ', mark }), { ok: true });
  // An empty legacy file is still a whole file: its encoding is the empty text.
  assert.deepEqual(validateData('project.import', { ...base, count: 0, file: '' }), { ok: true });
});

test('D-31: a Phase 30 import (no file, no mark) folds with no file hash and marked false, and a repeat with a file is still listed once', () => {
  const world = projectWorld();
  const genesis = world.write('L1', { kind: 'project.genesis', data: genesisData(world) });
  const plain = world.write('L1', { kind: 'project.import', data: { ledger: 'products', legacyHead: HASH('c'), count: 12 } });
  const file = legacyLedgerBytes(1000);
  const withFile = world.write('L1', { kind: 'project.import', data: { ledger: 'products', legacyHead: HASH('c'), count: 12, file: file.toString('base64url'), mark: headMark(12, HASH('c')) } });
  const empty = world.write('L1', { kind: 'project.import', data: { ledger: 'wargame', legacyHead: sha256Hex(Buffer.alloc(0)), count: 0, file: '' } });
  const markOnly = world.write('L1', { kind: 'project.import', data: { ledger: 'decisions', legacyHead: HASH('d'), count: 3, mark: headMark(3, HASH('d')) } });
  const result = foldEntries([genesis, plain, withFile, empty, markOnly].map((item) => item.entry), world.ctx(), REDUCERS);
  assert.equal(result.applied.length, 5);
  const imports = projectOf(result)[0].imports;
  assert.deepEqual(imports.map((item) => [item.ledger, item.entry, item.fileHash, item.marked]), [
    ['decisions', markOnly.hash, undefined, true],
    // The first of the two same imports in fold order is the one listed; the repeat with a file adds nothing.
    ['products', plain.hash, undefined, false],
    ['wargame', empty.hash, sha256Hex(Buffer.alloc(0)), false]
  ]);
  const listed = imports.find((item) => item.ledger === 'products');
  assert.equal(Object.prototype.hasOwnProperty.call(listed, 'fileHash'), false);
  // In the other delivery order the fold order is the same, so the output is too.
  const reversed = foldEntries([genesis, plain, withFile, empty, markOnly].reverse().map((item) => item.entry), world.ctx(), REDUCERS);
  assert.deepEqual(reversed.families.project, result.families.project);
  assert.deepEqual(reversed.digests, result.digests);
  // The same import with its file written alone (on the lead's other device, whose chain does not follow the plain import) is listed with its hash.
  const withFileAlone = world.write('L2', { kind: 'project.import', data: { ledger: 'products', legacyHead: HASH('c'), count: 12, file: file.toString('base64url'), mark: headMark(12, HASH('c')) } });
  const alone = foldEntries([genesis, withFileAlone].map((item) => item.entry), world.ctx(), REDUCERS);
  assert.deepEqual(projectOf(alone)[0].imports.map((item) => [item.entry, item.fileHash, item.marked]), [[withFileAlone.hash, sha256Hex(file), true]]);
  // The project digest keeps its Phase 30 form: the listed tuple is ledger, legacy head, count and entry, and the entry hash already commits to the file.
  assert.deepEqual(projectReducer.canonical(projectOf(alone), world.stream), {
    genesis: genesis.hash, project: streamId('project'), name: 'Operation Example', profile: 'staff-j2', labelMapHash: HASH('a'),
    lead: { member: 'mbr-lead', writer: world.writerOf('L1') }, hub: null, imports: [['products', HASH('c'), 12, withFileAlone.hash]]
  });
});

test('D-31: the import list survives clone, so an incremental fold and a fresh fold list the same file hash and mark', () => {
  const world = projectWorld();
  const view = { ctx: { ...world.ctx(), roster: { ...world.ctx().roster, hasRole: () => true } } } as unknown as FoldView;
  const file = legacyLedgerBytes(500);
  const written = world.write('L1', { kind: 'project.import', data: { ledger: 'products', legacyHead: HASH('c'), count: 2, file: file.toString('base64url'), mark: headMark(2, HASH('c')) } });
  const outcome = verifyEntry(written.entry, world.ctx());
  assert.equal(outcome.status, 'verified');
  const state = projectReducer.init();
  assert.deepEqual(projectReducer.apply(state, (outcome as { entry: VerifiedEntry }).entry, view), { status: 'applied' });
  const copy = projectReducer.clone(state);
  assert.deepEqual(projectReducer.finish(copy, view), projectReducer.finish(state, view));
  assert.deepEqual(projectReducer.finish(copy, view)[0].imports[0].fileHash, sha256Hex(file));
  assert.equal(projectReducer.finish(copy, view)[0].imports[0].marked, true);
});

// WR-02 project part (D-12): an agent acts under a person's device and is never a roster member, so it cannot set the project's name, lead or hub pin.
const AGENT = { kind: 'agent', member: 'j2-chief', run: 'r-1' } as const;

test('WR-02: a project.genesis labelled as an agent on the staff lead\'s own device is refused agent-cannot-decide and leaves no project', () => {
  const world = projectWorld();
  const agentGenesis = world.write('L1', { kind: 'project.genesis', data: genesisData(world, { name: 'Renamed by an agent' }), actor: AGENT });
  const result = foldEntries([agentGenesis.entry], world.ctx(), REDUCERS);
  assert.deepEqual(result.refused, [{ hash: agentGenesis.hash, reason: 'agent-cannot-decide', family: 'project' }]);
  assert.deepEqual(projectOf(result), []);
  assert.deepEqual(result.applied, []);
  assert.ok(PROJECT_REFUSALS['agent-cannot-decide'].length > 0);
  // The person's own genesis next to it still wins, in either delivery order.
  const real = world.write('L1', { kind: 'project.genesis', data: genesisData(world) });
  for (const entries of [[agentGenesis.entry, real.entry], [real.entry, agentGenesis.entry]]) {
    const both = foldEntries(entries, world.ctx(), REDUCERS);
    assert.equal(projectOf(both)[0].genesis, real.hash);
    assert.equal(projectOf(both)[0].name, 'Operation Example');
    assert.deepEqual(both.refused.map((item) => item.reason), ['agent-cannot-decide']);
  }
});

test('WR-02: a project.import labelled as an agent on the staff lead\'s device is refused agent-cannot-decide and is not listed', () => {
  const world = projectWorld();
  const genesis = world.write('L1', { kind: 'project.genesis', data: genesisData(world) });
  const byAgent = world.write('L1', { kind: 'project.import', data: { ledger: 'products', legacyHead: HASH('c'), count: 12 }, actor: AGENT });
  const result = foldEntries([genesis.entry, byAgent.entry], world.ctx(), REDUCERS);
  assert.deepEqual(result.refused, [{ hash: byAgent.hash, reason: 'agent-cannot-decide', family: 'project' }]);
  assert.deepEqual(projectOf(result)[0].imports, []);
  assert.deepEqual(result.applied, [genesis.hash]);
});

test('WR-02: the project reducer itself refuses a hub actor for genesis and import before the role check, even when the fold did not keep it first', () => {
  const world = projectWorld();
  const ctx = world.ctx();
  const hub = { kind: 'hub', watch: 'bridge-watch' } as const;
  const asVerified = (written: { entry: unknown }): VerifiedEntry => {
    const outcome = verifyEntry(written.entry, ctx);
    assert.equal(outcome.status, 'verified');
    return (outcome as { entry: VerifiedEntry }).entry;
  };
  // A view whose roster says yes to every role: the actor check alone must refuse.
  const view = { ctx: { ...ctx, roster: { ...ctx.roster, hasRole: () => true } } } as unknown as FoldView;
  for (const actor of [hub, AGENT]) {
    const state = projectReducer.init();
    const genesis = asVerified(world.write('L1', { kind: 'project.genesis', data: genesisData(world), actor }));
    const imported = asVerified(world.write('L1', { kind: 'project.import', data: { ledger: 'products', legacyHead: HASH('c'), count: 12 }, actor }));
    assert.deepEqual(projectReducer.apply(state, genesis, view), { status: 'refused', reason: 'agent-cannot-decide' });
    assert.deepEqual(projectReducer.apply(state, imported, view), { status: 'refused', reason: 'agent-cannot-decide' });
    assert.deepEqual(projectReducer.finish(state, view), []);
  }
  // A person on the same view is applied, so the refusal above is the actor check and not the view.
  const state = projectReducer.init();
  assert.deepEqual(projectReducer.apply(state, asVerified(world.write('L1', { kind: 'project.genesis', data: genesisData(world) })), view), { status: 'applied' });
});

test('roster entries are kept folded-in-later-phase and change no state, yet stay chain nodes: a doc.update written after one is still applied', () => {
  const world = projectWorld();
  const lead = world.editor('L1', PRODUCT, 101);
  const register = lead.register();
  const first = lead.insert(0, 'Hello');
  const baseline = foldEntries([register.entry, first.entry], world.ctx(), REDUCERS);
  const rosterEntries = PROJECT_AND_ROSTER.filter((sample) => !sample.kind.startsWith('project.')).map((sample) => world.write('L1', { kind: sample.kind, data: sample.data }));
  const after = lead.insert(5, ' world');
  const result = foldEntries([register, first, ...rosterEntries, after].map((item) => item.entry), world.ctx(), REDUCERS);
  assert.deepEqual(result.kept.map((item) => [item.hash, item.reason, item.family]).sort(), rosterEntries.map((item) => [item.hash, 'folded-in-later-phase', 'roster']).sort());
  assert.deepEqual([result.refused, result.held, result.rejected], [[], [], []]);
  assert.equal((result.families.doc as ProductTextOutput[])[0].text, 'Hello world');
  assert.deepEqual(result.applied, [...baseline.applied, after.hash].sort());
  // The kept entries add nothing to the state or the digest: the fold without the later insert has the baseline's digest.
  const keptOnly = foldEntries([register, first, ...rosterEntries].map((item) => item.entry), world.ctx(), REDUCERS);
  assert.deepEqual(keptOnly.digests, baseline.digests);
  assert.deepEqual(keptOnly.families, baseline.families);
});

test('the closed kind list has 72 kinds and the 23 project and roster samples are all of them', () => {
  assert.equal(REPLICA_KINDS.length, 72, 'roster.require (POST-01), hub.readmit (D-42) and session.certify (D-62), Phase 33; device.kem, 33.2 D-03; 14 roster and 2 personnel kinds of Phase 33.1; cell.access.commit');
  assert.equal(new Set(REPLICA_KINDS).size, 72, 'roster.require (POST-01), hub.readmit (D-42) and session.certify (D-62), Phase 33; device.kem, 33.2 D-03; 14 roster and 2 personnel kinds of Phase 33.1; cell.access.commit');
  // device.kem is the device family's (33.2 D-03), not a roster kind, though its name starts with device. Phase 33.1's roster kinds have their
  // samples in replicaPositionSchemas.test.ts.
  const owned = REPLICA_KINDS.filter((kind) => kind !== 'device.kem' && !ROSTER_KIND_OWNER_33_1.has(kind) && (kind.startsWith('project.') || /^(member|device|hub|cell|lead|roster|deputy|invite)\./.test(kind)));
  assert.equal(owned.length, 23, 'roster.require (POST-01), hub.readmit (D-42), Phase 33; cell.access.commit');
  assert.deepEqual([...owned].sort(), PROJECT_AND_ROSTER.map((sample) => sample.kind).sort());
});

// ---- registers, watches, runs and observations ----

// Microdegrees: whole numbers only, because canonical JSON in a signed body has no fractions.
const AREA = { west: -75_900_000, south: 44_900_000, east: -75_400_000, north: 45_500_000 };

const LATER_PHASE: Sample[] = [
  { kind: 'register.row', data: { register: 'rfi', row: 'RFI-014', fields: { title: 'Bridge status', priority: 2, urgent: true } }, required: ['register', 'row', 'fields'] },
  { kind: 'pir.decide', data: { pir: 'PIR-3', outcome: 'accepted', reasons: ['Collection is possible'], decisionsSeen: [HASH('1')] }, required: ['pir', 'outcome', 'reasons', 'decisionsSeen'] },
  { kind: 'watch.decide', data: { watch: 'bridge-watch', outcome: 'armed' }, required: ['watch', 'outcome'] },
  { kind: 'watch.define', data: { watch: 'bridge-watch', title: 'Bridge activity', criteria: 'Any vehicle track within 2 km of the bridge', feeds: ['adsb', 'ais'] }, required: ['watch', 'title', 'criteria', 'feeds'] },
  { kind: 'watch.assign', data: { watch: 'bridge-watch', runner: 'hub' }, required: ['watch', 'runner'] },
  { kind: 'watch.match', data: { watch: 'bridge-watch', matchId: HASH('2'), observations: ['obs-1', 'obs-2'], window: { from: '2026-11-19T10:00:00.000Z', to: '2026-11-19T11:00:00.000Z' } }, required: ['watch', 'matchId', 'observations', 'window'] },
  { kind: 'watch.state', data: { watch: 'bridge-watch', state: 'awaiting-review' }, required: ['watch', 'state'] },
  { kind: 'watch.killSwitch', data: { scope: 'project', on: true, reason: 'Drill: all hub watches off' }, required: ['scope', 'on', 'reason'] },
  { kind: 'run.start', data: { run: 'run-1', team: 'j2', section: 'enemy-coas', startedBy: 'mbr-ada', target: 'Adversary courses of action' }, required: ['run', 'team', 'section', 'startedBy', 'target'] },
  { kind: 'run.lane', data: { run: 'run-1', member: 'analyst', state: 'working' }, required: ['run', 'member', 'state'] },
  { kind: 'run.claim', data: { run: 'run-1', member: 'analyst', target: 'Enemy courses of action', purpose: 'Draft the section', leaseSeconds: 1200 }, required: ['run', 'member', 'target', 'purpose', 'leaseSeconds'] },
  { kind: 'run.release', data: { run: 'run-1', target: 'Enemy courses of action' }, required: ['run', 'target'] },
  { kind: 'run.summary', data: { run: 'run-1', proposals: 2, verdicts: 1, registerRows: 4, spendMicros: 125000, durationSeconds: 900 }, required: ['run', 'proposals', 'verdicts', 'registerRows', 'spendMicros', 'durationSeconds'] },
  { kind: 'run.end', data: { run: 'run-1', outcome: 'done' }, required: ['run', 'outcome'] },
  { kind: 'obs.segment', data: { cell: streamId('cell-1'), feed: 'adsb', area: AREA, from: '2026-11-19T10:00:00.000Z', to: '2026-11-19T11:00:00.000Z', rows: 1200, blob: HASH('3') }, required: ['cell', 'feed', 'area', 'from', 'to', 'rows', 'blob'] },
  { kind: 'obs.coalesced', data: { cell: streamId('cell-1'), feed: 'adsb', area: AREA, from: '2026-11-19T10:00:00.000Z', to: '2026-11-19T10:05:00.000Z', tracks: 40, points: 400, blob: HASH('4') }, required: ['cell', 'feed', 'area', 'from', 'to', 'tracks', 'points', 'blob'] },
  { kind: 'obs.pruned', data: { cell: streamId('cell-1'), feed: 'adsb', from: '2026-11-18T00:00:00.000Z', to: '2026-11-18T06:00:00.000Z', segments: 6, reason: 'window' }, required: ['cell', 'feed', 'from', 'to', 'segments', 'reason'] }
];

test('one valid sample per registers, watches, runs and obs kind (17 kinds) passes, and a missing field, an extra field and a __proto__ key each fail', () => {
  assert.equal(LATER_PHASE.length, 17);
  for (const sample of LATER_PHASE) {
    assert.deepEqual(validateData(sample.kind, sample.data), { ok: true }, sample.kind);
    for (const key of sample.required) {
      const reason = reasonOf(sample.kind, without(sample.data, key));
      assert.ok(reason.startsWith('bad-data:') && reason.includes(`data.${key}`), `${sample.kind} without ${key}: ${reason}`);
    }
    assert.ok(reasonOf(sample.kind, withKey(sample.data, 'extra', 1)).includes('data.extra'), sample.kind);
    const proto = reasonOf(sample.kind, withPrototypeKey(sample.data));
    assert.ok(proto.startsWith('bad-data:') && proto.includes('__proto__'), `${sample.kind}: ${proto}`);
    for (const wrong of [null, 5, 'text', [], [sample.data]]) assert.equal(validateData(sample.kind, wrong).ok, false, `${sample.kind} ${JSON.stringify(wrong)}`);
  }
  const owned = REPLICA_KINDS.filter((kind) => /^(register|pir|watch|run|obs)\./.test(kind));
  assert.deepEqual([...owned].sort(), LATER_PHASE.map((sample) => sample.kind).sort());
});

test('registers: unknown register, bad row ids, too many or ill-named fields, prototype field names and big values are refused at their path', () => {
  const row = LATER_PHASE[0].data;
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field${index}`, index]));
  const refusals: Array<[string, Data, string]> = [
    ['register.row', withKey(row, 'register', 'diary'), 'data.register'],
    ['register.row', withKey(row, 'row', 'bad id'), 'data.row'],
    ['register.row', withKey(row, 'fields', many), 'data.fields'],
    ['register.row', withKey(row, 'fields', { Title: 'x' }), 'data.fields.Title'],
    ['register.row', withKey(row, 'fields', JSON.parse('{"__proto__":"x"}')), 'data.fields.__proto__'],
    ['register.row', withKey(row, 'fields', { title: 'x'.repeat(2001) }), 'data.fields.title'],
    ['register.row', withKey(row, 'fields', { title: { nested: 1 } }), 'data.fields.title'],
    ['register.row', withKey(row, 'fields', { count: Number.POSITIVE_INFINITY }), 'data.fields.count'],
    ['register.row', withKey(row, 'fields', [1]), 'data.fields'],
    ['register.row', withKey(row, 'fields', { ratio: 0.5 }), 'data.fields.ratio'],
    ['register.row', withKey(row, 'basedOn', 'abc'), 'data.basedOn'],
    ['pir.decide', { pir: 'PIR-3', outcome: 'Accepted!', reasons: [], decisionsSeen: [] }, 'data.outcome'],
    ['pir.decide', { pir: 'PIR-3', outcome: 'accepted', reasons: Array.from({ length: 9 }, () => 'r'), decisionsSeen: [] }, 'data.reasons'],
    ['pir.decide', { pir: 'PIR-3', outcome: 'accepted', reasons: [], decisionsSeen: Array.from({ length: 17 }, () => HASH('1')) }, 'data.decisionsSeen'],
    ['pir.decide', { pir: 'PIR-3', outcome: 'accepted', reasons: [], decisionsSeen: ['nope'] }, 'data.decisionsSeen[0]'],
    ['watch.decide', { watch: 'bridge-watch', outcome: 'armed', runner: 'cloud' }, 'data.runner']
  ];
  for (const [kind, data, path] of refusals) {
    const reason = reasonOf(kind, data);
    assert.ok(reason.includes(path), `${kind} should name ${path}: ${reason}`);
  }
  assert.deepEqual(validateData('register.row', withKey(row, 'basedOn', HASH('5'))), { ok: true });
  assert.deepEqual(validateData('register.row', withKey(row, 'fields', {})), { ok: true });
  assert.deepEqual(validateData('watch.decide', { watch: 'bridge-watch', outcome: 'armed', runner: 'attended' }), { ok: true });
});

test('watches: states, runners, scopes, match windows and ids each refuse the wrong value, and the 15.6 states are all accepted', () => {
  const define = LATER_PHASE[3].data;
  const match = LATER_PHASE[5].data;
  const refusals: Array<[string, Data, string]> = [
    ['watch.define', withKey(define, 'feeds', Array.from({ length: 17 }, () => 'adsb')), 'data.feeds'],
    ['watch.define', withKey(define, 'criteria', 'two\nlines'), 'data.criteria'],
    ['watch.define', withKey(define, 'expiresAt', 'tomorrow'), 'data.expiresAt'],
    ['watch.assign', { watch: 'bridge-watch', runner: 'cloud' }, 'data.runner'],
    ['watch.assign', { watch: 'bridge-watch', runner: 'hub', fallback: 'hub' }, 'data.fallback'],
    ['watch.match', withKey(match, 'matchId', 'abc'), 'data.matchId'],
    ['watch.match', withKey(match, 'observations', ['bad id']), 'data.observations[0]'],
    ['watch.match', withKey(match, 'observations', Array.from({ length: 65 }, (_, index) => `obs-${index}`)), 'data.observations'],
    ['watch.match', withKey(match, 'window', { from: '2026-11-19T10:00:00.000Z' }), 'data.window'],
    ['watch.match', withKey(match, 'window', { from: 'x', to: 'y' }), 'data.window.from'],
    ['watch.state', { watch: 'bridge-watch', state: 'exploding' }, 'data.state'],
    ['watch.killSwitch', { scope: 'everything', on: true, reason: 'x' }, 'data.scope'],
    ['watch.killSwitch', { scope: 'project', on: 'yes', reason: 'x' }, 'data.on'],
    ['watch.killSwitch', { scope: 'project', on: true, reason: '' }, 'data.reason']
  ];
  for (const [kind, data, path] of refusals) {
    const reason = reasonOf(kind, data);
    assert.ok(reason.includes(path), `${kind} should name ${path}: ${reason}`);
  }
  for (const state of ['proposed', 'armed', 'rejected', 'matched', 'drafting', 'awaiting-review', 'paused', 'expired', 'disarmed']) {
    assert.deepEqual(validateData('watch.state', { watch: 'bridge-watch', state }), { ok: true }, state);
  }
  assert.deepEqual(validateData('watch.killSwitch', { scope: 'watch:bridge-watch', on: false, reason: 'Back on' }), { ok: true });
  assert.deepEqual(validateData('watch.assign', { watch: 'bridge-watch', runner: 'hub', fallback: 'attended' }), { ok: true });
});

test('runs: lease caps, lane and outcome words, counts and money (whole micro-dollars only) are checked', () => {
  const claim = LATER_PHASE[10].data;
  const summary = LATER_PHASE[12].data;
  const refusals: Array<[string, Data, string]> = [
    ['run.claim', withKey(claim, 'leaseSeconds', 59), 'data.leaseSeconds'],
    ['run.claim', withKey(claim, 'leaseSeconds', 86401), 'data.leaseSeconds'],
    ['run.claim', withKey(claim, 'leaseSeconds', 1200.5), 'data.leaseSeconds'],
    ['run.claim', withKey(claim, 'leaseSeconds', '1200'), 'data.leaseSeconds'],
    ['run.claim', withKey(claim, 'run', 'run 1'), 'data.run'],
    ['run.lane', { run: 'run-1', member: 'analyst', state: 'sleeping' }, 'data.state'],
    ['run.end', { run: 'run-1', outcome: 'lost' }, 'data.outcome'],
    ['run.summary', withKey(summary, 'spendMicros', 0.5), 'data.spendMicros'],
    ['run.summary', withKey(summary, 'spendMicros', -1), 'data.spendMicros'],
    ['run.summary', withKey(summary, 'proposals', 1e12), 'data.proposals'],
    ['run.summary', withKey(summary, 'durationSeconds', Number.NaN), 'data.durationSeconds'],
    ['run.start', { run: 'run-1', team: 'j2', section: 'enemy-coas', startedBy: 'mbr-ada', target: '' }, 'data.target'],
    ['run.release', { run: 'run-1', target: 'x', reason: 'a\nb' }, 'data.reason']
  ];
  for (const [kind, data, path] of refusals) {
    const reason = reasonOf(kind, data);
    assert.ok(reason.includes(path), `${kind} should name ${path}: ${reason}`);
  }
  for (const lease of [60, 1200, 86400]) assert.deepEqual(validateData('run.claim', withKey(claim, 'leaseSeconds', lease)), { ok: true }, String(lease));
  for (const state of ['working', 'waiting', 'done', 'failed']) assert.deepEqual(validateData('run.lane', { run: 'run-1', member: 'analyst', state, target: 'Key terrain' }), { ok: true }, state);
  for (const outcome of ['done', 'failed', 'cancelled']) assert.deepEqual(validateData('run.end', { run: 'run-1', outcome, reason: 'ok' }), { ok: true }, outcome);
});

test('observations: slices need a real area and window, and large payloads are blob hashes, never inline points', () => {
  const segment = LATER_PHASE[14].data;
  const area = segment.area as Data;
  const refusals: Array<[string, Data, string]> = [
    ['obs.segment', withKey(segment, 'area', { ...area, west: -181_000_000 }), 'data.area.west'],
    ['obs.segment', withKey(segment, 'area', { ...area, north: 91_000_000 }), 'data.area.north'],
    ['obs.segment', withKey(segment, 'area', { ...area, south: 46_000_000, north: 45_000_000 }), 'data.area'],
    ['obs.segment', withKey(segment, 'area', { ...area, east: 1.5 }), 'data.area.east'],
    ['obs.segment', withKey(segment, 'area', { ...area, extra: 1 }), 'data.area'],
    ['obs.segment', withKey(segment, 'area', [1, 2, 3, 4]), 'data.area'],
    ['obs.segment', withKey(segment, 'from', '2026-11-19'), 'data.from'],
    ['obs.segment', withKey(segment, 'to', '2026-11-19T09:00:00.000Z'), 'data.to'],
    ['obs.segment', withKey(segment, 'blob', 'abc'), 'data.blob'],
    ['obs.segment', withKey(segment, 'cell', HASH('a')), 'data.cell'],
    ['obs.segment', withKey(segment, 'points', [[1, 2]]), 'data.points'],
    ['obs.segment', withKey(segment, 'rows', -1), 'data.rows'],
    ['obs.pruned', { cell: streamId('c'), feed: 'adsb', from: '2026-11-18T00:00:00.000Z', to: '2026-11-18T06:00:00.000Z', segments: 6, reason: 'whim' }, 'data.reason']
  ];
  for (const [kind, data, path] of refusals) {
    const reason = reasonOf(kind, data);
    assert.ok(reason.includes(path), `${kind} should name ${path}: ${reason}`);
  }
  // A box that crosses the antimeridian (east below west) is allowed, and so is a fraction-free time next to one with milliseconds.
  assert.deepEqual(validateData('obs.segment', withKey(segment, 'area', { west: 170_000_000, south: -10_000_000, east: -170_000_000, north: 10_000_000 })), { ok: true });
  assert.deepEqual(validateData('obs.segment', { ...segment, from: '2026-11-19T10:00:00Z', to: '2026-11-19T10:00:00.500Z', channel: 'primary' }), { ok: true });
});

// ---- kept families: later-phase kinds, unknown kinds, hub actors ----

test('registers, watches, runs and obs entries are kept folded-in-later-phase, change no families output and no digest, and stay chain nodes', () => {
  const world = projectWorld();
  const ada = world.editor('A', PRODUCT, 101);
  const register = ada.register();
  const first = ada.insert(0, 'Hello');
  const baseline = foldEntries([register.entry, first.entry], world.ctx(), REDUCERS);
  const keptEntries = LATER_PHASE.map((sample) => world.write('A', { kind: sample.kind, data: sample.data }));
  const after = ada.insert(5, ' world');
  const result = foldEntries([register, first, ...keptEntries, after].map((item) => item.entry), world.ctx(), REDUCERS);
  assert.deepEqual(result.kept.map((item) => [item.hash, item.reason, item.family]).sort(), keptEntries.map((item, index) => [item.hash, 'folded-in-later-phase', kindFamilyName(LATER_PHASE[index].kind)]).sort());
  assert.deepEqual([result.refused, result.held, result.rejected], [[], [], []]);
  assert.equal((result.families.doc as ProductTextOutput[])[0].text, 'Hello world');
  const keptOnly = foldEntries([register, first, ...keptEntries].map((item) => item.entry), world.ctx(), REDUCERS);
  assert.deepEqual(keptOnly.digests, baseline.digests);
  assert.deepEqual(keptOnly.families, baseline.families);
  assert.deepEqual(keptOnly.applied, baseline.applied);
});

function kindFamilyName(kind: string): string {
  if (kind === 'register.row' || kind === 'pir.decide' || kind === 'watch.decide') return 'registers';
  const word = kind.split('.')[0];
  return word === 'watch' ? 'watches' : word === 'run' ? 'runs' : 'obs';
}

test('an entry of an unknown kind is kept newer-version, changes no state, and the same writer next entry is applied', () => {
  const world = projectWorld();
  const ada = world.editor('A', PRODUCT, 101);
  const register = ada.register();
  const first = ada.insert(0, 'Hello');
  const baseline = foldEntries([register.entry, first.entry], world.ctx(), REDUCERS);
  const future = world.write('A', { kind: 'staff.futureThing', data: { anything: [1, 2, { deep: true }], note: 'from a newer version' } });
  const huge = world.write('A', { kind: 'staff.anotherThing', data: 'plain text instead of an object' });
  const after = ada.insert(5, ' world');
  const result = foldEntries([register, first, future, huge, after].map((item) => item.entry), world.ctx(), REDUCERS);
  assert.deepEqual(result.kept.map((item) => [item.hash, item.reason]).sort(), [[future.hash, 'newer-version'], [huge.hash, 'newer-version']].sort());
  assert.deepEqual([result.refused, result.held, result.rejected], [[], [], []]);
  assert.equal((result.families.doc as ProductTextOutput[])[0].text, 'Hello world');
  assert.ok(result.applied.includes(after.hash));
  const without = foldEntries([register, first, future, huge].map((item) => item.entry), world.ctx(), REDUCERS);
  assert.deepEqual(without.digests, baseline.digests);
  assert.deepEqual(without.families, baseline.families);
});

test('a doc.update written by a hub actor is kept hub-actor and changes no text, and a hub actor on a roster kind is kept the same way', () => {
  const world = projectWorld();
  const ada = world.editor('A', PRODUCT, 101);
  const register = ada.register();
  const first = ada.insert(0, 'Hello');
  const baseline = foldEntries([register.entry, first.entry], world.ctx(), REDUCERS);
  const hubText = world.write('A', { kind: 'doc.update', data: updateData(PRODUCT, ada.insertUpdate(5, ' from the hub')), actor: { kind: 'hub', watch: 'bridge-watch' } });
  const hubGenesis = world.write('A', { kind: 'project.genesis', data: genesisData(world), actor: { kind: 'hub', watch: 'bridge-watch' } });
  const result = foldEntries([register, first, hubText, hubGenesis].map((item) => item.entry), world.ctx(), REDUCERS);
  assert.deepEqual(result.kept.map((item) => [item.hash, item.reason]).sort(), [[hubText.hash, 'hub-actor'], [hubGenesis.hash, 'hub-actor']].sort());
  assert.equal((result.families.doc as ProductTextOutput[])[0].text, 'Hello');
  assert.deepEqual(projectOf(result), []);
  assert.deepEqual(result.digests, baseline.digests);
  assert.deepEqual([result.refused, result.held, result.rejected], [[], [], []]);
});
