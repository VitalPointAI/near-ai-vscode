// The permanent shapes of Phase 33.1 (plan 01 task 3; D-10, D-16, D-19, D-21, D-25, D-39, D-40, D-43). One table-driven test over every new kind (a
// valid record, each required field missing, an unknown key, a wrong type), then the named cases the owner's answer at the checkpoint settled.
// Fictional data only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { isActorShape } from '../domain/replica/entry';
import { KIND_FAMILIES, REPLICA_KINDS, validateBody, validateData } from '../domain/replica/kinds';
import { UNABLE_REASONS, unableReasonProblem } from '../domain/replica/kindSchemas/personnel';
import { SERVES_IDS } from '../domain/replica/kindSchemas/roster';
import { BASE_CELL_KINDS } from '../domain/replica/productCells';
import { ROSTER_KIND_OWNER } from '../domain/replica/roster';
import { grantHash } from '../domain/replica/cellKeys';
import { epochAt } from '../domain/replica/rosterCells';
import { createRosterWorld } from './helpers/replicaRosterWorld';

const HASH = (label: string): string => createHash('sha256').update(label, 'utf8').digest('hex');
const B64 = (bytes: number, fill = 7): string => Buffer.alloc(bytes, fill).toString('base64url');
const PREV = HASH('roster/prev');
const STREAM = HASH('cell/night').slice(0, 32);
const LABEL = { scale: 'org', level: 'Internal', compartments: [], releasability: ['CAN'] };
const EVIDENCE = [HASH('credential/clearance'), HASH('credential/service')].sort();
const STATUS = [{ list: 'urn:example:status:hq-1', hash: HASH('status/hq-1'), validFrom: '2026-11-24T00:00:00.000Z' }];
const DID = 'did:webvh:QmExampleScid0000000000001:people.example.org:watch-officer';
const DEVICE_KEY = B64(32, 9);
// A device's writer id is the hash of its signing key.
const DEVICE = { writer: createHash('sha256').update(Buffer.from(DEVICE_KEY, 'base64url')).digest('hex'), publicKey: DEVICE_KEY, x25519: B64(32), x25519Sig: B64(64), slot: 9 };
const REPORT = { v: 1, purpose: 'staff-posting-unable', signer: { fingerprint: 'SHA256:example-person-key', publicKey: B64(32) }, signedAt: '2026-12-01T07:00:00.000Z', payload: { posting: 'pst-night-1' }, sig: B64(64) };

interface Sample { kind: string; data: Record<string, unknown>; required: string[] }

// One valid record of each kind this phase adds; required lists the fields a record must carry.
const SAMPLES: Sample[] = [
  { kind: 'position.create', data: { position: 'watch-officer-night', title: 'Watch Officer, night', section: 'j3', decides: ['decision_for:watch'], clearance: LABEL, keyGroups: [STREAM], acting: true, dualHat: false, shift: 'Night', observer: true, eligibleServes: ['public-servant', 'regular-force'], establishment: 'EST-J3-014', rosterPrev: PREV }, required: ['position', 'title', 'section', 'decides', 'clearance', 'keyGroups', 'acting', 'dualHat', 'rosterPrev'] },
  { kind: 'position.update', data: { position: 'watch-officer-night', title: 'Watch Officer, nights', rosterPrev: PREV }, required: ['position', 'rosterPrev'] },
  { kind: 'position.disestablish', data: { position: 'watch-officer-night', reason: 'Exercise finished.', rosterPrev: PREV }, required: ['position', 'reason', 'rosterPrev'] },
  { kind: 'authority.delegate', data: { grant: 'grt-j1-1', member: 'mbr-j1', scope: { section: 'j3' }, kinds: ['acting', 'substantive'], expiresAt: '2027-01-01T00:00:00.000Z', depth: 0, evidence: EVIDENCE, status: STATUS, rosterPrev: PREV }, required: ['grant', 'member', 'scope', 'kinds', 'expiresAt', 'depth', 'rosterPrev'] },
  { kind: 'authority.revoke', data: { grant: 'grt-j1-1', rosterPrev: PREV }, required: ['grant', 'rosterPrev'] },
  { kind: 'posting.order', data: { posting: 'pst-night-1', position: 'watch-officer-night', person: { member: 'mbr-pat' }, evidence: EVIDENCE, status: STATUS, kind: 'temporary', start: '2026-12-01T00:00:00.000Z', end: '2026-12-15T00:00:00.000Z', policy: HASH('policy'), stages: ['stg-1'], instrument: 'ORD-2026-114', grant: 'grt-j1-1', rosterPrev: PREV }, required: ['posting', 'position', 'person', 'evidence', 'status', 'kind', 'start', 'policy', 'stages', 'rosterPrev'] },
  { kind: 'posting.enrol', data: { posting: 'pst-night-1', device: DEVICE, request: HASH('device-request'), member: 'mbr-new', rosterPrev: PREV }, required: ['posting', 'device', 'request', 'rosterPrev'] },
  { kind: 'posting.report', data: { posting: 'pst-night-1', evidence: EVIDENCE, status: STATUS, rosterPrev: PREV }, required: ['posting', 'rosterPrev'] },
  { kind: 'posting.decide', data: { posting: 'pst-night-1', decision: 'defer', unable: HASH('unable-report'), start: '2026-12-08T00:00:00.000Z', rosterPrev: PREV }, required: ['posting', 'decision', 'unable', 'rosterPrev'] },
  { kind: 'posting.return', data: { posting: 'pst-night-1', rosterPrev: PREV }, required: ['posting', 'rosterPrev'] },
  { kind: 'posting.end', data: { posting: 'pst-night-1', reason: 'Relieved at the end of the exercise.', rosterPrev: PREV }, required: ['posting', 'reason', 'rosterPrev'] },
  { kind: 'posting.cancel', data: { posting: 'pst-night-1', reason: 'Ordered in error.', rosterPrev: PREV }, required: ['posting', 'reason', 'rosterPrev'] },
  { kind: 'cell.rekey.staged', data: { cell: STREAM, epoch: 3, reason: 'member-removed', stage: 'stg-1', posting: 'pst-night-1', replaces: 2, grant: HASH('grant'), basis: { kind: 'guide', ref: 'scg-12.4' }, rosterPrev: PREV }, required: ['cell', 'epoch', 'reason', 'stage', 'posting', 'replaces', 'rosterPrev'] },
  { kind: 'project.mode', data: { mode: 'military', settings: { overdueDays: 3, maxDelegationDepth: 1, acting: false, mayDecline: false }, policy: HASH('policy'), reason: 'Set up for the exercise.', rosterPrev: PREV }, required: ['mode', 'settings', 'policy', 'reason', 'rosterPrev'] },
  { kind: 'posting.unable', data: { posting: 'pst-night-1', report: REPORT, sealed: B64(300) }, required: ['posting', 'report', 'sealed'] },
  { kind: 'posting.reference', data: { posting: 'pst-night-1', sealed: B64(120) }, required: ['posting', 'sealed'] }
];

const without = (data: Record<string, unknown>, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(data).filter(([name]) => name !== key));
const reasonOf = (kind: string, data: unknown): string => {
  const check = validateData(kind, data);
  assert.equal(check.ok, false, `${kind} ${JSON.stringify(data).slice(0, 100)} should fail`);
  return check.ok ? '' : check.reason;
};
const valid = (kind: string, data: unknown): void => assert.deepEqual(validateData(kind, data), { ok: true }, `${kind} ${JSON.stringify(data).slice(0, 100)}`);
const sample = (kind: string): Record<string, unknown> => (SAMPLES.find((item) => item.kind === kind) as Sample).data;

test('every new kind: a valid record passes; each missing required field, an unknown key and a wrong type are refused naming the path', () => {
  const added = REPLICA_KINDS.filter((kind) => ROSTER_KIND_OWNER[kind] === 'positions' || KIND_FAMILIES.get(kind) === 'personnel');
  assert.deepEqual(SAMPLES.map((item) => item.kind).sort(), [...added].sort(), 'one sample per kind this phase adds');
  for (const { kind, data, required } of SAMPLES) {
    valid(kind, data);
    for (const key of required) assert.ok(reasonOf(kind, without(data, key)).includes(`data.${key}`), `${kind} without ${key}`);
    assert.ok(reasonOf(kind, { ...data, extra: 1 }).includes('data.extra'), kind);
    for (const key of required) {
      const wrong = typeof data[key] === 'boolean' ? 'yes' : true;
      assert.ok(reasonOf(kind, { ...data, [key]: wrong }).includes(`data.${key}`), `${kind} ${key} of the wrong type`);
    }
  }
});

test('posting.unable: the six reasons open, other with 501 characters is refused, and the sealed payload is opaque to the validator', () => {
  assert.deepEqual([...UNABLE_REASONS], ['medical', 'compassionate', 'conflicting-tasking', 'not-qualified', 'not-cleared', 'other']);
  for (const reason of UNABLE_REASONS) assert.equal(unableReasonProblem({ reason }), undefined, reason);
  assert.equal(unableReasonProblem({ reason: 'other', text: 'x'.repeat(500) }), undefined);
  assert.ok(unableReasonProblem({ reason: 'other', text: 'x'.repeat(501) })?.includes('text'));
  assert.ok(unableReasonProblem({ reason: 'tired' })?.includes('reason'));
  assert.ok(unableReasonProblem({ reason: 'medical', note: 'x' })?.includes('note'));
  // Any sealed bytes validate: the reason inside is read only after the tasker opens it.
  valid('posting.unable', { ...sample('posting.unable'), sealed: B64(16, 1) });
  assert.ok(reasonOf('posting.unable', { ...sample('posting.unable'), sealed: 'not base64url!' }).includes('data.sealed'));
  assert.ok(reasonOf('posting.unable', { ...sample('posting.unable'), report: { ...REPORT, purpose: 'staff-decision' } }).includes('data.report.purpose'));
  assert.ok(reasonOf('posting.unable', { ...sample('posting.unable'), report: { ...REPORT, payload: { posting: 'pst-night-1', reason: 'medical' } } }).includes('data.report.payload'));
});

test('the person actor may carry a position id; a position of the wrong shape, or a position on an agent or hub actor, is refused', () => {
  assert.equal(isActorShape({ kind: 'person' }), true);
  assert.equal(isActorShape({ kind: 'person', position: 'watch-officer-night' }), true);
  for (const position of ['Watch Officer', '', 'x'.repeat(65), 5, null, '-leading']) assert.equal(isActorShape({ kind: 'person', position }), false, JSON.stringify(position));
  assert.equal(isActorShape({ kind: 'agent', member: 'mbr-pat', run: 'run-1', position: 'watch-officer-night' }), false);
  assert.equal(isActorShape({ kind: 'hub', watch: 'night-watch', position: 'watch-officer-night' }), false);
  const body = { deps: [], roster: PREV, lamport: 3, at: '2026-12-01T08:00:00.000Z', actor: { kind: 'person', position: 'watch-officer-night' }, kind: 'version.decide', data: {} };
  const checked = validateBody(body);
  assert.ok(checked.ok);
  assert.deepEqual(checked.body.actor, { kind: 'person', position: 'watch-officer-night' }, 'the position survives the copy');
});

test('member.admit and member.update carry the member\'s own did and credential evidence, never serves, nationality, organization, or a declared clearance beside them', () => {
  const update = { member: 'mbr-pat', rosterPrev: PREV };
  valid('member.update', { ...update, did: DID });
  valid('member.update', { ...update, evidence: EVIDENCE, status: STATUS });
  valid('member.update', { ...update, clearance: LABEL });
  for (const bad of ['did:web:people.example.org', 'did:webvh:short:people.example.org', `did:webvh:QmExampleScid0000000000001:${'a'.repeat(250)}.org`, 'did:webvh:QmExampleScid0000000000001:People.Example.org']) {
    assert.ok(reasonOf('member.update', { ...update, did: bad }).includes('data.did'), bad);
  }
  assert.ok(reasonOf('member.update', { ...update, evidence: ['f'.repeat(63)], status: STATUS }).includes('data.evidence'));
  assert.ok(reasonOf('member.update', { ...update, evidence: [...EVIDENCE].reverse(), status: STATUS }).includes('data.evidence'), 'unsorted');
  assert.ok(reasonOf('member.update', { ...update, evidence: [EVIDENCE[0], EVIDENCE[0]], status: STATUS }).includes('data.evidence'), 'repeated');
  for (const key of ['list', 'hash', 'validFrom']) {
    const status = [Object.fromEntries(Object.entries(STATUS[0] as Record<string, unknown>).filter(([name]) => name !== key))];
    assert.ok(reasonOf('member.update', { ...update, evidence: EVIDENCE, status }).includes(`data.status[0].${key}`), key);
  }
  assert.ok(reasonOf('member.update', { ...update, evidence: EVIDENCE }).includes('data.status'), 'evidence without status');
  for (const key of ['serves', 'nationality', 'organization']) assert.ok(reasonOf('member.update', { ...update, did: DID, [key]: 'x' }).includes(`data.${key}`), key);
  assert.ok(reasonOf('member.update', { ...update, did: DID, clearance: LABEL }).includes('data.clearance'), 'a declaration beside a credential slot');
  // member.admit carries either the Phase 31 declared clearance or the member's own did (Q6).
  const admit = { member: 'mbr-pat', invite: 'inv-1', name: 'Pat Example', seat: 'j3-watch', roles: ['member'], device: DEVICE, rosterPrev: PREV };
  valid('member.admit', { ...admit, clearance: LABEL });
  valid('member.admit', { ...admit, did: DID, evidence: EVIDENCE, status: STATUS });
  assert.ok(reasonOf('member.admit', admit).includes('data'), 'neither');
  assert.ok(reasonOf('member.admit', { ...admit, clearance: LABEL, did: DID }).includes('data.clearance'), 'both');
  assert.ok(reasonOf('member.admit', { ...admit, clearance: LABEL, evidence: EVIDENCE, status: STATUS }).includes('data.clearance'));
});

test('a position may be an Observer position and lists eligibleServes from SERVES_IDS; project.mode has no signers', () => {
  assert.deepEqual([...SERVES_IDS], ['regular-force', 'reserve-force', 'public-servant', 'contractor', 'allied-military', 'industry']);
  valid('position.create', { ...sample('position.create'), eligibleServes: ['allied-military', 'industry'] });
  for (const serves of [['navy'], [], ['industry', 'allied-military'], ['industry', 'industry']]) {
    assert.ok(reasonOf('position.create', { ...sample('position.create'), eligibleServes: serves }).includes('data.eligibleServes'), JSON.stringify(serves));
  }
  assert.ok(reasonOf('position.create', { ...sample('position.create'), observer: false }).includes('data.observer'));
  assert.ok(reasonOf('position.update', { ...sample('position.update'), observer: true }).includes('data.observer'), 'fixed at create (Q9)');
  assert.ok(reasonOf('project.mode', { ...sample('project.mode'), signers: ['mbr-lead'] }).includes('data.signers'));
  for (const settings of [{ overdueDays: 0 }, { overdueDays: 31 }, { maxDelegationDepth: 3 }, { guests: 'yes' }, { approvers: 2 }]) {
    assert.ok(reasonOf('project.mode', { ...sample('project.mode'), settings }).includes('data.settings'), JSON.stringify(settings));
  }
  // Q5: a temporary posting has an end; an acting one may leave it out; the end follows the start.
  const order = sample('posting.order');
  assert.ok(reasonOf('posting.order', without(order, 'end')).includes('data.end'));
  valid('posting.order', { ...without(order, 'end'), kind: 'acting' });
  assert.ok(reasonOf('posting.order', { ...order, end: order.start }).includes('data.end'));
  valid('posting.order', { ...order, person: { name: 'Sam Example', did: DID } });
  assert.ok(reasonOf('posting.order', { ...order, person: { member: 'mbr-pat', did: DID } }).includes('data.person'));
  // posting.decide: a new start with defer only, a position with reassign only.
  const decide = sample('posting.decide');
  valid('posting.decide', { ...without(decide, 'start'), decision: 'confirm' });
  valid('posting.decide', { ...without(decide, 'start'), decision: 'reassign', position: 'watch-officer-day' });
  assert.ok(reasonOf('posting.decide', { ...decide, decision: 'confirm' }).includes('data.start'));
});

test('basis on cell.rekey.staged and cell.rekey: guide, judgement with a hash, or none; a judgement without ref, an unknown kind, a long or broken ref, an unknown key are refused', () => {
  const cellRekey = { cell: STREAM, epoch: 2, reason: 'scheduled', rosterPrev: PREV };
  for (const kind of ['cell.rekey.staged', 'cell.rekey']) {
    const data = kind === 'cell.rekey' ? cellRekey : sample(kind);
    valid(kind, { ...data, basis: { kind: 'guide', ref: 'scg-12.4' } });
    valid(kind, { ...data, basis: { kind: 'judgement', ref: HASH('proposal') } });
    valid(kind, without(data, 'basis'));
    for (const basis of [{ kind: 'judgement' }, { kind: 'hunch', ref: 'x' }, { kind: 'guide', ref: 'x'.repeat(129) }, { kind: 'guide', ref: 'line one\nline two' }, { kind: 'source', ref: 'a', text: 'matched words' }]) {
      assert.ok(reasonOf(kind, { ...data, basis }).includes('data.basis'), `${kind} ${JSON.stringify(basis)}`);
    }
  }
});

test('basis changes no fold: a roster with a cell.rekey with and without basis folds to the same state', () => {
  const run = (basis?: Record<string, unknown>): string => {
    const world = createRosterWorld();
    const { entry: genesis } = world.genesis();
    const founding = world.grant(world.lead, { cell: STREAM, epoch: 1, roster: genesis.hash, to: [world.lead] });
    const created = world.rosterEntry(world.lead, 'cell.create', { cell: STREAM, epoch: 1, grant: grantHash(founding) }, genesis.hash);
    const next = world.grant(world.lead, { cell: STREAM, epoch: 2, roster: created.hash, to: [world.lead] });
    world.rosterEntry(world.lead, 'cell.rekey', { cell: STREAM, epoch: 2, reason: 'scheduled', grant: grantHash(next), ...(basis === undefined ? {} : { basis }) }, created.hash);
    const state = world.foldRoster({ keys: world.ringFor(world.lead) });
    const head = state.positions.length - 1;
    return JSON.stringify({ head, epoch: epochAt(state.cells, STREAM, head), refused: state.refused.map((item) => item.reason), held: state.held.map((item) => item.reason), grants: state.cells.cells.get(STREAM)?.grants.length });
  };
  assert.equal(run({ kind: 'judgement', ref: HASH('proposal') }), run());
});

test('BASE_CELL_KINDS holds every new roster kind and neither personnel kind', () => {
  for (const kind of Object.keys(ROSTER_KIND_OWNER).filter((item) => ROSTER_KIND_OWNER[item] === 'positions')) assert.ok(BASE_CELL_KINDS.includes(kind), kind);
  for (const kind of ['posting.unable', 'posting.reference']) {
    assert.equal(KIND_FAMILIES.get(kind), 'personnel');
    assert.equal(BASE_CELL_KINDS.includes(kind), false, kind);
  }
});
