// How two copies of project state combine (SYNC-05, owner decision D-08): the same way on every machine whatever order they meet in, and never by dropping
// a person's saved work. The laws are checked on seeded random histories, not hand-picked cases.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRecords, forkId, liveRecords, mergeRecord, mergeRecordSets, unionLog } from '../domain/state/merge';
import * as mergeModule from '../domain/state/merge';
import { baseId, canonicalJson, makeRecord, MERGE_POLICY, parseRecord, revOf, type RecordKind, type StateRecord } from '../domain/state/records';
import * as recordsModule from '../domain/state/records';

/** A small seeded generator (xorshift32), so a failing run can be replayed from its seed. */
function rng(seed: number): { next(): number; int(n: number): number; chance(p: number): boolean; pick<T>(items: readonly T[]): T } {
  let state = (seed * 2654435761) >>> 0 || 1;
  const next = (): number => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), chance: (p) => next() < p, pick: (items) => items[Math.floor(next() * items.length)] };
}

const WRITERS = ['wr-aaaa', 'wr-bbbb', 'wr-cccc'];
const T0 = Date.UTC(2026, 10, 13, 9, 0, 0);
const iso = (offsetSeconds: number): string => new Date(T0 + offsetSeconds * 1000).toISOString();
const forkKinds: RecordKind[] = ['comparison', 'checkpoint'];
const lwwKinds: RecordKind[] = ['choice', 'profile'];

interface Pool { versions: StateRecord[]; stones: StateRecord[] }

/**
 * Every version that could exist for a few records. An edit is always written later than the record it edits (makeRecord's `base`), as the stores do.
 * Records of a 'fork' kind get edits one step deep (a replica never sees an edit while missing the record it edited and the step between);
 * 'lww' kinds get longer chains, because keeping the newest does not need the history between.
 */
function pool(random: ReturnType<typeof rng>, kinds: readonly RecordKind[], withStones: boolean): Pool {
  const versions: StateRecord[] = [];
  const stones: StateRecord[] = [];
  let counter = 0;
  for (const kind of kinds) {
    for (const id of ['one', 'two']) {
      const roots: StateRecord[] = [];
      const copies: StateRecord[] = [];
      for (let r = 1 + random.int(2); r > 0; r--) {
        const root = makeRecord(kind, id, { kind, id, n: counter++ }, { at: iso(random.int(40)), writer: random.pick(WRITERS) });
        copies.push(root);
        let latest = root;
        // Sometimes a second machine wrote the very same content at another time (a twin: equal revision, different time and writer).
        if (random.chance(0.15)) {
          const twin = makeRecord(kind, id, root.body, { at: iso(random.int(40)), writer: random.pick(WRITERS) });
          copies.push(twin);
          if (twin.at > latest.at) latest = twin;
        }
        // An edit is stamped later than every copy of what it edits, as clocks that respect causality would give.
        roots.push(latest);
      }
      versions.push(...copies);
      const deep = lwwKinds.includes(kind) ? 2 : 1;
      let level = roots;
      for (let depth = 0; depth < deep; depth++) {
        const next: StateRecord[] = [];
        for (const parent of level) {
          for (let c = random.int(3); c > 0; c--) next.push(makeRecord(kind, id, { kind, id, n: counter++ }, { at: iso(random.int(60)), writer: random.pick(WRITERS), base: parent }));
        }
        versions.push(...next);
        level = next;
      }
      if (withStones && random.chance(0.4)) stones.push(makeRecord('tombstone', id, { target: kind }, { at: iso(random.int(70)), writer: random.pick(WRITERS) }));
    }
  }
  return { versions, stones };
}

function replica(random: ReturnType<typeof rng>, source: Pool, density: number): StateRecord[] {
  const held = [...source.versions, ...source.stones].filter(() => random.chance(density));
  return mergeRecordSets(held, []);
}

const text = (records: readonly StateRecord[]): string => canonicalJson(records);

for (const [label, kinds, withStones] of [['fork kinds', forkKinds, false], ['lww kinds', lwwKinds, false], ['all kinds with tombstones', [...forkKinds, ...lwwKinds], true]] as const) {
  test(`merging record sets is commutative, associative and idempotent over 500 seeded histories (${label})`, () => {
    for (let seed = 1; seed <= 500; seed++) {
      const random = rng(seed + (withStones ? 7000 : 0));
      const source = pool(random, kinds, withStones);
      const [a, b, c] = [replica(random, source, 0.45), replica(random, source, 0.45), replica(random, source, 0.45)];
      const at = `seed ${seed}`;
      assert.equal(text(mergeRecordSets(a, b)), text(mergeRecordSets(b, a)), `commutative, ${at}`);
      assert.equal(text(mergeRecordSets(mergeRecordSets(a, b), c)), text(mergeRecordSets(a, mergeRecordSets(b, c))), `associative, ${at}`);
      assert.equal(text(mergeRecordSets(a, a)), text(a), `idempotent, ${at}`);
      assert.equal(text(mergeRecordSets(mergeRecordSets(a, b), b)), text(mergeRecordSets(a, b)), `re-delivery changes nothing, ${at}`);
    }
  });
}

test('a divergent edit of a saved comparison is never lost: every version no later edit was built on survives, whatever the order', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const random = rng(seed + 9000);
    const source = pool(random, ['comparison'], false);
    const merged = mergeRecordSets(replica(random, source, 0.5), replica(random, source, 0.5));
    const everything = mergeRecordSets(source.versions, []);
    const allRevs = new Set(everything.map((record) => record.rev));
    const sourceRevs = new Set(source.versions.map((record) => record.rev));
    assert.ok(merged.every((record) => sourceRevs.has(record.rev)), `no invented revision, seed ${seed}`);
    // Merging with everything leaves the full set: no version that mattered was dropped on the way.
    assert.equal(text(mergeRecordSets(merged, source.versions)), text(everything), `seed ${seed}`);
    const built = new Set(source.versions.flatMap((record) => (record.basedOn ? [record.basedOn] : [])));
    for (const version of source.versions) {
      if (built.has(version.rev)) continue;
      assert.ok(allRevs.has(version.rev), `a version nothing was built on stays: seed ${seed}`);
    }
  }
});

test('merging whole sets gives the same answer as merging two copies of one record', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const random = rng(seed + 12000);
    const source = pool(random, [...forkKinds, ...lwwKinds], false);
    const slot = random.pick(source.versions);
    const same = source.versions.filter((record) => record.kind === slot.kind && record.id === slot.id);
    const [left, right] = [random.pick(same), random.pick(same)];
    const pair = mergeRecord(left, right);
    const expected = [pair.keep, ...(pair.fork ? [pair.fork] : [])].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    const actual = mergeRecordSets([left], [right]);
    assert.equal(canonicalJson(actual), canonicalJson(expected), `seed ${seed}`);
    assert.equal(canonicalJson(mergeRecord(right, left)), canonicalJson(pair), `mergeRecord is commutative, seed ${seed}`);
  }
});

test('an edit built on another record wins whatever the clocks say, a divergent comparison keeps both, a divergent choice keeps only the newer', () => {
  const base = makeRecord('comparison', 'cmp-1', { rows: 1 }, { at: iso(100), writer: 'wr-aaaa' });
  // The descendant carries an earlier time than its base (a skewed clock): it still wins, as the edit of that record.
  const edit = { ...makeRecord('comparison', 'cmp-1', { rows: 2 }, { at: iso(10), writer: 'wr-bbbb', basedOn: base.rev }) };
  assert.deepEqual(mergeRecord(base, edit), { keep: edit });
  assert.deepEqual(mergeRecord(edit, base), { keep: edit });

  const left = makeRecord('comparison', 'cmp-2', { rows: 'left' }, { at: iso(50), writer: 'wr-aaaa' });
  const right = makeRecord('comparison', 'cmp-2', { rows: 'right' }, { at: iso(60), writer: 'wr-bbbb' });
  const merged = mergeRecord(left, right);
  assert.equal(merged.keep, right);
  assert.deepEqual(merged.fork, { ...left, id: forkId('cmp-2', left.rev) });
  assert.match(merged.fork!.id, /^cmp-2~[0-9a-f]{12}$/);
  assert.equal(merged.fork!.rev, left.rev, 'the fork keeps the older content untouched');
  assert.equal(canonicalJson(mergeRecord(right, left)), canonicalJson(merged));
  assert.deepEqual(mergeRecordSets([left], [right]).map((record) => record.id), ['cmp-2', merged.fork!.id].sort());

  const older = makeRecord('choice', 'model', { id: 'a' }, { at: iso(50), writer: 'wr-aaaa' });
  const newer = makeRecord('choice', 'model', { id: 'b' }, { at: iso(60), writer: 'wr-bbbb' });
  assert.deepEqual(mergeRecord(older, newer), { keep: newer });
  assert.deepEqual(mergeRecordSets([older], [newer]), [newer]);
  // Equal times order by writer, then rev, so both sides keep the same one.
  const tieA = makeRecord('choice', 'model', { id: 'a' }, { at: iso(5), writer: 'wr-aaaa' });
  const tieB = makeRecord('choice', 'model', { id: 'b' }, { at: iso(5), writer: 'wr-bbbb' });
  assert.equal(mergeRecord(tieA, tieB).keep, tieB);
  assert.equal(mergeRecord(tieB, tieA).keep, tieB);
  assert.ok(compareRecords(tieA, tieB) < 0);
});

test('a tombstone wins only when strictly newer than the record; a newer edit resurrects it; forks of a deleted record go with it', () => {
  const record = makeRecord('comparison', 'cmp-9', { rows: 1 }, { at: iso(50), writer: 'wr-aaaa' });
  const olderStone = makeRecord('tombstone', 'cmp-9', { target: 'comparison' }, { at: iso(40), writer: 'wr-bbbb' });
  const newerStone = makeRecord('tombstone', 'cmp-9', { target: 'comparison' }, { at: iso(60), writer: 'wr-bbbb' });
  const sameInstant = makeRecord('tombstone', 'cmp-9', { target: 'comparison' }, { at: iso(50), writer: 'wr-bbbb' });
  assert.equal(mergeRecord(record, olderStone).keep, record);
  assert.equal(mergeRecord(olderStone, record).keep, record);
  assert.equal(mergeRecord(record, newerStone).keep, newerStone);
  assert.equal(mergeRecord(newerStone, record).keep, newerStone);
  assert.equal(mergeRecord(record, sameInstant).keep, record);
  assert.deepEqual(liveRecords(mergeRecordSets([record], [olderStone])), [record]);
  assert.deepEqual(liveRecords(mergeRecordSets([record], [newerStone])), []);
  // A tombstone is kept even when an edit is newer, so a copy of the record that arrives later is still removed.
  assert.equal(mergeRecordSets([record], [olderStone]).length, 2);

  const other = makeRecord('comparison', 'cmp-9', { rows: 'other' }, { at: iso(45), writer: 'wr-cccc' });
  const both = mergeRecordSets([record], [other]);
  assert.equal(both.length, 2, 'the divergent older copy is kept as a fork');
  assert.deepEqual(liveRecords(mergeRecordSets(both, [newerStone])), [], 'both copies are older than the tombstone');
  assert.equal(liveRecords(mergeRecordSets(both, [makeRecord('tombstone', 'cmp-9', { target: 'comparison' }, { at: iso(47), writer: 'wr-bbbb' })])).length, 1, 'only the copy newer than the tombstone survives');
  // A tombstone for one kind does not touch a record of the same id in another kind.
  const choice = makeRecord('choice', 'cmp-9', { id: 'x' }, { at: iso(10), writer: 'wr-aaaa' });
  assert.deepEqual(liveRecords(mergeRecordSets([choice], [newerStone])), [choice]);
  assert.equal(baseId(forkId('cmp-9', record.rev)), 'cmp-9');
});

test('unionLog keeps every line of both logs and the highest version of a line both have, in an order that does not depend on the inputs', () => {
  const a = [{ t: 'e', id: 'e1', v: 1, in: 10 }, { t: 'e', id: 'e2', v: 3, in: 5 }, { t: 'a', rid: 'r1', nano: 7 }];
  const b = [{ t: 'e', id: 'e1', v: 2, in: 12 }, { t: 'e', id: 'e2', v: 1, in: 1 }, { t: 'e', id: 'e3', v: 1, in: 2 }, { t: 'a', rid: 'r1', nano: 7 }];
  const merged = unionLog(a, b);
  assert.equal(merged.length, 4);
  assert.equal((merged.find((line) => line.id === 'e1') as { in: number }).in, 12);
  assert.equal((merged.find((line) => line.id === 'e2') as { in: number }).in, 5);
  assert.equal(canonicalJson(unionLog(b, a)), canonicalJson(merged));
  assert.equal(canonicalJson(unionLog(merged, merged)), canonicalJson(merged));
  // Same version, different content: the greater canonical text wins on both sides.
  const x = [{ t: 'e', id: 'tie', v: 1, in: 1 }];
  const y = [{ t: 'e', id: 'tie', v: 1, in: 2 }];
  assert.equal(canonicalJson(unionLog(x, y)), canonicalJson(unionLog(y, x)));
});

test('canonical JSON sorts keys at every depth and refuses values that have no single text; revisions follow the content', () => {
  assert.equal(canonicalJson({ b: [3, { y: 1, x: 2 }], a: 'é' }), '{"a":"é","b":[3,{"x":2,"y":1}]}');
  for (const bad of [undefined, () => 1, Symbol('s'), Number.NaN, Number.POSITIVE_INFINITY, BigInt(1), new Date(0), { a: undefined }, [undefined]]) {
    assert.throws(() => canonicalJson(bad), TypeError);
  }
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assert.throws(() => canonicalJson(loop), TypeError);
  assert.equal(revOf({ a: 1, b: 2 }), revOf({ b: 2, a: 1 }));
  assert.notEqual(revOf({ a: 1 }), revOf({ a: 2 }));
  assert.match(revOf({}), /^[0-9a-f]{16}$/);
});

test('parseRecord rejects ids that could be used as paths and anything malformed; makeRecord stamps an edit after its base', () => {
  const good = makeRecord('profile', 'profile-1', { name: 'x' }, { at: iso(0), writer: 'wr-aaaa' });
  assert.deepEqual(parseRecord(JSON.parse(JSON.stringify(good))), good);
  const broken: unknown[] = [
    { ...good, id: '../escape' }, { ...good, id: 'a/b' }, { ...good, id: 'a\\b' }, { ...good, id: 'a\u0000b' }, { ...good, id: '..' }, { ...good, id: '' },
    { ...good, id: 'x'.repeat(201) }, { ...good, kind: 'transcript' }, { ...good, rev: 'xyz' }, { ...good, rev: good.rev.toUpperCase() }, { ...good, basedOn: 'nope' },
    { ...good, at: '2026-11-13' }, { ...good, at: '2026-11-13T09:00:00Z' }, { ...good, writer: 'A' }, { ...good, writer: 'x'.repeat(81) }, { kind: 'profile' }, null, 'text', [],
    makeRecordUnchecked('tombstone', { target: 'tombstone' }), makeRecordUnchecked('tombstone', {}), { ...good, body: { n: Number.NaN } }
  ];
  for (const value of broken) assert.equal(parseRecord(value), undefined, canonicalJsonSafe(value));
  assert.ok(parseRecord({ ...good, id: 'x'.repeat(200) }));
  assert.ok(parseRecord({ ...good, id: `${'x'.repeat(200)}~0123456789ab` }), 'a fork of the longest id still parses');
  assert.throws(() => makeRecord('profile', '../x', {}, { at: iso(0), writer: 'wr-aaaa' }));

  const base = makeRecord('profile', 'profile-1', { name: 'x' }, { at: iso(100), writer: 'wr-aaaa' });
  const early = makeRecord('profile', 'profile-1', { name: 'y' }, { at: iso(1), writer: 'wr-bbbb', base });
  assert.equal(early.basedOn, base.rev);
  assert.ok(early.at > base.at, 'an edit is never ordered before what it edits');
  const later = makeRecord('profile', 'profile-1', { name: 'z' }, { at: iso(500), writer: 'wr-bbbb', base });
  assert.equal(later.at, iso(500));
  assert.ok(!('basedOn' in good), 'no undefined fields are left on a record');
});

function makeRecordUnchecked(kind: string, body: unknown): unknown {
  return { kind, id: 'x1', rev: '0123456789abcdef', at: iso(0), writer: 'wr-aaaa', body };
}

function canonicalJsonSafe(value: unknown): string {
  try { return canonicalJson(value); } catch { return String(value); }
}

test('every kind has a merge policy, the saved-work kinds fork, and no function in the merge modules removes a record', () => {
  for (const kind of ['marker', 'checkpoint', 'comparison', 'choice', 'profile', 'secret', 'spend', 'pickup', 'thread-meta', 'thread-context'] as const) assert.ok(MERGE_POLICY[kind], kind);
  assert.equal(MERGE_POLICY.comparison, 'fork');
  assert.equal(MERGE_POLICY.checkpoint, 'fork');
  assert.equal(MERGE_POLICY.spend, 'union');
  assert.equal(MERGE_POLICY.choice, 'lww');
  const exported = [...Object.keys(recordsModule), ...Object.keys(mergeModule)];
  assert.deepEqual(exported.filter((name) => /remove|delete|drop|prune|purge|clear/i.test(name)), []);
});
