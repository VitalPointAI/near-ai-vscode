// The closed schemas of the project, roster, registers, watches, runs and obs families, the project reducer, and the kept families (plan 30-04, tasks 2 and 3).
// Hostile JSON for prototype keys comes from JSON.parse text, because an object literal would not make an own __proto__ key.
import assert from 'node:assert/strict';
import test from 'node:test';
import { foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { REPLICA_KINDS, validateData } from '../domain/replica/kinds';
import { projectReducer } from '../domain/replica/projectFold';
import type { ProjectOutput } from '../domain/replica/projectFold';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { textReducer } from '../domain/replica/textFold';
import { createWorld, fixedSigner, streamId } from './helpers/replicaWorld';
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
  { kind: 'deputy.name', data: { member: 'mbr-deputy', rosterPrev: PREV }, required: ['member', 'rosterPrev'] }
];

function reasonOf(kind: string, data: unknown): string {
  const check = validateData(kind, data);
  assert.equal(check.ok, false, `${kind} ${JSON.stringify(data).slice(0, 80)} should fail`);
  return check.ok ? '' : check.reason;
}

// ---- project and roster schemas ----

test('one valid sample per project and roster kind (19 kinds) passes, and a missing field, an extra field and a __proto__ key each fail with a reason naming the path', () => {
  assert.equal(PROJECT_AND_ROSTER.length, 19);
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

test('every one of the 17 roster kinds requires rosterPrev as a 64-hex hash (DESIGN 7.1)', () => {
  const roster = PROJECT_AND_ROSTER.filter((sample) => !sample.kind.startsWith('project.'));
  assert.equal(roster.length, 17);
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

test('the closed kind list still has 50 kinds and the 19 project and roster samples are all of them', () => {
  const owned = REPLICA_KINDS.filter((kind) => kind.startsWith('project.') || /^(member|device|hub|cell|lead|roster|deputy)\./.test(kind));
  assert.deepEqual([...owned].sort(), PROJECT_AND_ROSTER.map((sample) => sample.kind).sort());
});
