// Shared contracts the wave-3 plans build on (plan 30-02, tasks 2 and 3): the schema dispatch, the causal relations, the static roster view and
// the Yjs snapshot functions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCausalGraph } from '../domain/replica/causal';
import type { GraphEntry } from '../domain/replica/causal';
import { applyUpdate, createFoldDoc, createLocalDoc, decodeSnapshot, docText, localDelete, localInsert, snapshotMissing, snapshotOf, snapshotStateVector, stateVectorOf, textAtSnapshot } from '../domain/replica/doc';
import { GENESIS_PREV } from '../domain/replica/entry';
import type { EntryBody, EntryHeader } from '../domain/replica/entry';
import { MAX_UPDATE_BYTES } from '../domain/replica/kindSchemas/doc';
import { REPLICA_KINDS, SCHEMA_PENDING, kindFamily, validateData } from '../domain/replica/kinds';
import { ROSTER_ROLE_PATTERNS, staticRosterView } from '../domain/replica/rosterView';
import { verifyEntry } from '../domain/replica/verify';
import { createWorld, fixedSigner, updateData } from './helpers/replicaWorld';
import type { Written } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';

// The 30-02 stubs refused every non-doc kind with SCHEMA_PENDING. Wave 3 (30-04, 30-05, 30-06, 30-08) replaced every stub with its
// family schema, so the contract is now: an empty data object still fails closed for every non-doc kind, with a real schema reason.
test('every known kind except the doc kinds fails closed on empty data with its family schema reason, not the pending stub', () => {
  const others = REPLICA_KINDS.filter((kind) => !kind.startsWith('doc.'));
  assert.equal(others.length, 69, 'roster.require (POST-01), hub.readmit (D-42) and session.certify (D-62), Phase 33; device.kem, 33.2 D-03; 14 roster and 2 personnel kinds of Phase 33.1; cell.access.commit');
  for (const kind of others) {
    const check = validateData(kind, {});
    assert.equal(check.ok, false, kind);
    if (!check.ok) assert.ok(!check.reason.startsWith(SCHEMA_PENDING), `${kind}: ${check.reason}`);
  }
});

test('valid doc.client and doc.update samples still validate, and the invalid ones fail with a path in the reason', () => {
  const world = createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'] }] });
  const update = updateData(PRODUCT, world.editor('A', PRODUCT, 101).insertUpdate(0, 'Hello'));
  assert.deepEqual(validateData('doc.client', { product: PRODUCT, clientId: 101, actor: { kind: 'person' } }), { ok: true });
  assert.deepEqual(validateData('doc.update', update), { ok: true });
  const refusals: Array<[string, unknown, string]> = [
    ['doc.client', { product: PRODUCT, clientId: 101, actor: { kind: 'person' }, extra: 1 }, 'data'],
    ['doc.client', { product: PRODUCT, actor: { kind: 'person' } }, 'data'],
    ['doc.client', { product: PRODUCT, clientId: 0, actor: { kind: 'person' } }, 'data.clientId'],
    ['doc.client', { product: PRODUCT, clientId: 4294967296, actor: { kind: 'person' } }, 'data.clientId'],
    ['doc.client', { product: 'Bad Name', clientId: 5, actor: { kind: 'person' } }, 'data.product'],
    ['doc.update', { product: PRODUCT, update: update.update, extra: true }, 'data'],
    ['doc.update', { product: PRODUCT }, 'data'],
    ['doc.update', { product: PRODUCT, update: 'not base64url!' }, 'data.update'],
    ['doc.update', { product: PRODUCT, update: '' }, 'data.update'],
    ['doc.update', 'text', 'data']
  ];
  for (const [kind, data, path] of refusals) {
    const check = validateData(kind, data);
    assert.equal(check.ok, false, `${kind} ${JSON.stringify(data).slice(0, 60)}`);
    if (!check.ok) {
      assert.ok(check.reason.startsWith('bad-data:'), check.reason);
      assert.ok(check.reason.includes(path), `${check.reason} should name ${path}`);
    }
  }
  const huge = Buffer.alloc(MAX_UPDATE_BYTES + 1, 1).toString('base64url');
  assert.equal(validateData('doc.update', { product: PRODUCT, update: huge }).ok, false);
});

test('validateData dispatches each family to its own file: every sample kind belongs to its family and gets a real schema refusal', () => {
  const expected: Array<[string, string]> = [
    ['project.genesis', 'project'], ['member.admit', 'roster'], ['product.create', 'versions'], ['register.row', 'registers'],
    ['watch.define', 'watches'], ['run.start', 'runs'], ['obs.segment', 'obs'], ['digest.report', 'integrity']
  ];
  for (const [kind, family] of expected) {
    assert.equal(kindFamily(kind), family, kind);
    const check = validateData(kind, {});
    assert.equal(check.ok, false, kind);
    if (!check.ok) assert.ok(!check.reason.startsWith(SCHEMA_PENDING), `${kind}: ${check.reason}`);
  }
  assert.equal(validateData('no.such.kind', {}).ok, false);
});

// ---- causal relations (task 3) ----

function graphOf(world: ReturnType<typeof createWorld>, written: readonly Written[]): ReturnType<typeof buildCausalGraph> {
  const ctx = world.ctx();
  const entries: GraphEntry[] = written.map((item) => {
    const outcome = verifyEntry(item.entry, ctx);
    assert.equal(outcome.status, 'verified');
    if (outcome.status !== 'verified') throw new Error('unreachable');
    return outcome.entry;
  });
  return buildCausalGraph(entries);
}

function causalWorld(): { graph: ReturnType<typeof buildCausalGraph>; a0: Written; a1: Written; b0: Written; b1: Written; c0: Written } {
  const world = createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'] }, { member: 'mbr-bbbb', devices: ['B'] }, { member: 'mbr-cccc', devices: ['C'] }] });
  const note = { kind: 'doc.client', data: { product: PRODUCT, clientId: 1, actor: { kind: 'person' } } } as const;
  const a0 = world.write('A', note);
  const a1 = world.write('A', note);
  const b0 = world.write('B', note);
  const b1 = world.write('B', { ...note, deps: [a1] });
  const c0 = world.write('C', note);
  return { graph: graphOf(world, [a0, a1, b0, b1, c0]), a0, a1, b0, b1, c0 };
}

test('past gives the strict ancestors through prev and deps, and closure adds the heads themselves', () => {
  const { graph, a0, a1, b0, b1 } = causalWorld();
  assert.deepEqual([...graph.past(b1.hash)].sort(), [a0.hash, a1.hash, b0.hash].sort());
  assert.deepEqual([...graph.past(a0.hash)], []);
  assert.deepEqual([...graph.closure([b1.hash])].sort(), [a0.hash, a1.hash, b0.hash, b1.hash].sort());
  assert.deepEqual([...graph.past('f'.repeat(64))], []);
});

test('isBefore is the strict ancestor relation and never holds against itself', () => {
  const { graph, a0, a1, b0, b1 } = causalWorld();
  assert.equal(graph.isBefore(a0.hash, b1.hash), true);
  assert.equal(graph.isBefore(b0.hash, b1.hash), true);
  assert.equal(graph.isBefore(b1.hash, a0.hash), false);
  assert.equal(graph.isBefore(a1.hash, a1.hash), false);
});

test('concurrent holds for entries with no path between them in either direction, and not for an entry and itself', () => {
  const { graph, a0, a1, b0, b1, c0 } = causalWorld();
  assert.equal(graph.concurrent(a1.hash, b0.hash), true);
  assert.equal(graph.concurrent(c0.hash, b1.hash), true);
  assert.equal(graph.concurrent(a0.hash, b1.hash), false);
  assert.equal(graph.concurrent(b1.hash, a0.hash), false);
  assert.equal(graph.concurrent(a1.hash, a1.hash), false);
  assert.equal(graph.concurrent(a1.hash, 'f'.repeat(64)), false);
});

test('closure of several heads is their union with every ancestor, and heads outside the graph are left out', () => {
  const { graph, a0, a1, b0, c0 } = causalWorld();
  assert.deepEqual([...graph.closure([a1.hash, c0.hash, 'e'.repeat(64)])].sort(), [a0.hash, a1.hash, c0.hash].sort());
  assert.equal(graph.closure([b0.hash]).has(b0.hash), true);
  assert.equal(graph.closure([]).size, 0);
});

test('a chain of 5000 entries answers past and isBefore without a stack overflow', () => {
  const entries: GraphEntry[] = [];
  let prev = GENESIS_PREV;
  for (let index = 1; index <= 5000; index += 1) {
    const hash = index.toString(16).padStart(64, '0');
    entries.push({ hash, header: { prev } as EntryHeader, body: { deps: [] } as unknown as EntryBody });
    prev = hash;
  }
  const graph = buildCausalGraph(entries);
  assert.equal(graph.past(prev).size, 4999);
  assert.equal(graph.isBefore(entries[0].hash, prev), true);
  assert.equal(graph.isBefore(prev, entries[0].hash), false);
  assert.equal(graph.closure([prev]).size, 5000);
});

// ---- the static roster view (task 3) ----

function threeRosters(): ReturnType<typeof staticRosterView> {
  const ada = fixedSigner('roster-ada');
  const bo = fixedSigner('roster-bo');
  const ada2 = fixedSigner('roster-ada-2');
  return staticRosterView({
    rosters: [
      { hash: 'a'.repeat(64), members: [{ member: 'mbr-aaaa', name: 'Ada', roles: ['staff_lead', 'member'], devices: [{ writer: ada.writer, publicKey: ada.publicKey }] }] },
      {
        hash: 'b'.repeat(64),
        members: [
          { member: 'mbr-aaaa', name: 'Ada', roles: ['staff_lead', 'member'], devices: [{ writer: ada.writer, publicKey: ada.publicKey }, { writer: ada2.writer, publicKey: ada2.publicKey }] },
          { member: 'mbr-bbbb', name: 'Bo', roles: ['member', 'deputy_lead', 'section_lead:j2'], devices: [{ writer: bo.writer, publicKey: bo.publicKey }] }
        ],
        checkpointSigners: [ada.writer]
      },
      { hash: 'c'.repeat(64), members: [{ member: 'mbr-aaaa', name: 'Ada', roles: ['staff_lead', 'member'], devices: [{ writer: ada.writer, publicKey: ada.publicKey }] }, { member: 'mbr-bbbb', name: 'Bo B.', roles: ['member'], devices: [] }] }
    ],
    chosenBranches: [{ writer: ada.writer, stream: 's'.repeat(32), seq: 4, hash: 'd'.repeat(64) }]
  });
}

test('the static roster view numbers rosters by array position and knows which hashes exist', () => {
  const view = threeRosters();
  assert.deepEqual(['a', 'b', 'c'].map((letter) => view.rosterPosition(letter.repeat(64))), [0, 1, 2]);
  assert.equal(view.hasRoster('b'.repeat(64)), true);
  assert.equal(view.hasRoster('z'.repeat(64)), false);
  assert.equal(view.rosterPosition('z'.repeat(64)), undefined);
});

test('a device admitted only at position 1 has a key at once but is admitted only from that roster on, and removal ends admission', () => {
  const view = threeRosters();
  const ada2 = fixedSigner('roster-ada-2');
  const bo = fixedSigner('roster-bo');
  assert.deepEqual(view.deviceKey(ada2.writer), { publicKey: ada2.publicKey, member: 'mbr-aaaa' });
  assert.equal(view.deviceKey('0'.repeat(64)), undefined);
  assert.equal(view.isAdmitted(ada2.writer, 'a'.repeat(64)), false);
  assert.equal(view.isAdmitted(ada2.writer, 'b'.repeat(64)), true);
  assert.equal(view.isAdmitted(ada2.writer, 'c'.repeat(64)), false);
  assert.equal(view.isAdmitted(bo.writer, 'c'.repeat(64)), false);
  assert.equal(view.isAdmitted(bo.writer, 'z'.repeat(64)), false);
});

test('memberName follows the roster position, and hasRole answers for each role pattern including deputy_lead', () => {
  const view = threeRosters();
  assert.equal(view.memberName('mbr-bbbb', 'b'.repeat(64)), 'Bo');
  assert.equal(view.memberName('mbr-bbbb', 'c'.repeat(64)), 'Bo B.');
  assert.equal(view.memberName('mbr-bbbb', 'a'.repeat(64)), undefined);
  assert.equal(view.hasRole('mbr-aaaa', 'staff_lead', 'a'.repeat(64)), true);
  assert.equal(view.hasRole('mbr-bbbb', 'deputy_lead', 'b'.repeat(64)), true);
  assert.equal(view.hasRole('mbr-bbbb', 'deputy_lead', 'c'.repeat(64)), false);
  assert.equal(view.hasRole('mbr-bbbb', 'section_lead:j2', 'b'.repeat(64)), true);
  assert.equal(view.hasRole('mbr-bbbb', 'answers_for:j2', 'b'.repeat(64)), false);
  assert.equal(view.hasRole('mbr-bbbb', 'member', 'z'.repeat(64)), false);
  for (const sample of ['staff_lead', 'deputy_lead', 'member', 'section_lead:j2', 'answers_for:j2', 'decision_for:lead']) {
    assert.ok(ROSTER_ROLE_PATTERNS.some((entry) => entry.pattern.test(sample)), sample);
  }
  assert.equal(ROSTER_ROLE_PATTERNS.some((entry) => entry.pattern.test('root')), false);
});

test('roleWithdrawnBy gives the first later roster without the role, and undefined when the role is never withdrawn', () => {
  const view = threeRosters();
  assert.equal(view.roleWithdrawnBy('mbr-bbbb', 'deputy_lead', 'b'.repeat(64)), 'c'.repeat(64));
  assert.equal(view.roleWithdrawnBy('mbr-bbbb', 'section_lead:j2', 'b'.repeat(64)), 'c'.repeat(64));
  assert.equal(view.roleWithdrawnBy('mbr-aaaa', 'staff_lead', 'a'.repeat(64)), undefined);
  assert.equal(view.roleWithdrawnBy('mbr-bbbb', 'deputy_lead', 'c'.repeat(64)), undefined);
  assert.equal(view.roleWithdrawnBy('mbr-bbbb', 'deputy_lead', 'z'.repeat(64)), undefined);
});

test('chosenBranch and checkpointSigner answer from the spec', () => {
  const view = threeRosters();
  const ada = fixedSigner('roster-ada');
  assert.equal(view.chosenBranch(ada.writer, 's'.repeat(32), 4), 'd'.repeat(64));
  assert.equal(view.chosenBranch(ada.writer, 's'.repeat(32), 5), undefined);
  assert.equal(view.checkpointSigner(ada.writer, 'b'.repeat(64)), true);
  assert.equal(view.checkpointSigner(ada.writer, 'a'.repeat(64)), false);
  assert.equal(view.checkpointSigner(ada.writer, 'z'.repeat(64)), false);
});

// ---- Yjs snapshots (task 3) ----

function editedText(): { updates: Uint8Array[]; before: Uint8Array; after: Uint8Array; vectorBefore: Array<[number, number]>; vectorAfter: Array<[number, number]> } {
  const local = createLocalDoc(101);
  const insert = localInsert(local, 0, 'Hello world');
  const before = snapshotOf(local);
  const vectorBefore = stateVectorOf(local);
  const remove = localDelete(local, 0, 6);
  return { updates: [insert, remove], before, after: snapshotOf(local), vectorBefore, vectorAfter: stateVectorOf(local) };
}

test('a delete-only edit leaves the state vector alone but changes the snapshot and the text', () => {
  const edited = editedText();
  assert.deepEqual(edited.vectorAfter, edited.vectorBefore);
  assert.notDeepEqual(Buffer.from(edited.after), Buffer.from(edited.before));
  const fold = createFoldDoc();
  for (const update of edited.updates) assert.equal(applyUpdate(fold, update), true);
  assert.equal(docText(fold), 'world');
});

test('textAtSnapshot rebuilds the text a snapshot names on a scratch document and leaves the fold document alone', () => {
  const edited = editedText();
  const fold = createFoldDoc();
  for (const update of edited.updates) applyUpdate(fold, update);
  const vectorBefore = stateVectorOf(fold);
  assert.equal(textAtSnapshot(edited.updates, edited.before), 'Hello world');
  assert.equal(textAtSnapshot(edited.updates, edited.after), 'world');
  assert.equal(docText(fold), 'world');
  assert.deepEqual(stateVectorOf(fold), vectorBefore);
});

test('snapshotMissing is true when the supplied updates do not reach the clocks or the deletions the snapshot names', () => {
  const edited = editedText();
  const [insert, remove] = edited.updates;
  assert.equal(snapshotMissing(edited.updates, edited.after), false);
  assert.equal(snapshotMissing([insert], edited.before), false);
  assert.equal(snapshotMissing([insert], edited.after), true);
  assert.equal(snapshotMissing([remove], edited.before), true);
  assert.equal(snapshotMissing([], edited.before), true);
  assert.equal(textAtSnapshot([insert], edited.after), undefined);
  const local = createLocalDoc(7);
  const first = localInsert(local, 0, 'one');
  const second = localInsert(local, 3, ' two');
  assert.equal(snapshotMissing([first], snapshotOf(local)), true);
  assert.equal(snapshotMissing([first, second], snapshotOf(local)), false);
});

test('decodeSnapshot gives undefined for garbage, for trailing bytes and for an oversized input, and a round trip for a real snapshot', () => {
  const edited = editedText();
  assert.equal(decodeSnapshot(new Uint8Array([255, 255, 255, 255, 255, 255])), undefined);
  assert.equal(decodeSnapshot(new Uint8Array(0)), undefined);
  assert.equal(decodeSnapshot(Buffer.concat([edited.after, Buffer.from([1, 2, 3])])), undefined);
  assert.equal(decodeSnapshot(new Uint8Array(MAX_UPDATE_BYTES + 1)), undefined);
  const decoded = decodeSnapshot(edited.before);
  assert.notEqual(decoded, undefined);
  if (decoded !== undefined) assert.deepEqual(snapshotStateVector(decoded), [[101, 11]]);
  assert.equal(textAtSnapshot(edited.updates, new Uint8Array([9, 9, 9])), undefined);
  assert.equal(snapshotMissing(edited.updates, new Uint8Array([9, 9, 9])), false);
});
