// The work a hostile Yjs update can cause is bounded before Yjs sees it (D-05 as refined by D-43, WR-07): byte limits per kind, a strict skim that
// counts structs and delete ranges and refuses every content but GC, deleted and string, and heap ceilings measured with a forced collection.
// Probe bytes are built here with a small varuint writer; no large fixture is committed.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as v8 from 'node:v8';
import * as vm from 'node:vm';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as docModule from '../domain/replica/doc';
import {
  MAX_STRUCTS as DOC_MAX_STRUCTS, applyRemote, applyUpdate, attributionAtSnapshot, attributionRuns, buildFromCompaction, createFoldDoc, createLocalDoc, decodeSnapshot,
  docText, encodeFullState, inspectUpdate, localDelete, localInsert, rangesCovered, snapshotMissing, snapshotOf, snapshotReport, snapshotStateVector, stateVectorOf,
  textAtSnapshot
} from '../domain/replica/doc';
import type { AttributionRun, CrdtDoc } from '../domain/replica/doc';
import { SEALED_OVERHEAD, sealBlob } from '../domain/replica/entry';
import { MAX_STATE_BYTES, MAX_STRUCTS, MAX_UPDATE_BYTES } from '../domain/replica/kindSchemas/doc';
import { readVaruint, sealedBlobWithin, skimSnapshot, skimUpdate } from '../domain/replica/updateGuard';
import { rng } from './helpers/replicaWorld';
import { embedUpdate, foreignFullState, formatUpdate, mapUpdate, nestedArrayUpdate, nestedTypeUpdate, skipUpdate, testYjs } from './helpers/replicaYjs';

// A forced collection, so heap numbers are not dominated by garbage still waiting (the pattern in scripts/crdt-spike.mjs).
v8.setFlagsFromString('--expose-gc');
const forceGc = vm.runInNewContext('gc') as () => void;

// Heap growth in bytes while `run` runs, measured from a collected heap to just after it returns (garbage it made still counts).
function heapGrowth<T>(run: () => T): { value: T; grew: number } {
  forceGc();
  forceGc();
  const before = process.memoryUsage().heapUsed;
  const value = run();
  return { value, grew: process.memoryUsage().heapUsed - before };
}

const MB = 1024 * 1024;

// ---- Probe builders ------------------------------------------------------------------------------------------------------------------------------

function writeVaruint(out: Uint8Array, at: number, value: number): number {
  let rest = value;
  let next = at;
  while (rest > 127) {
    out[next] = 128 | (rest % 128);
    next += 1;
    rest = Math.floor(rest / 128);
  }
  out[next] = rest;
  return next + 1;
}

function varuintBytes(value: number): Uint8Array {
  const out = new Uint8Array(10);
  return out.slice(0, writeVaruint(out, 0, value));
}

// One client group of `count` GC structs of length 1, then an empty delete set: 2 bytes per struct.
function gcProbe(count: number, client = 31): Uint8Array {
  const out = new Uint8Array(32 + 2 * count);
  let at = writeVaruint(out, 0, 1);
  at = writeVaruint(out, at, count);
  at = writeVaruint(out, at, client);
  at = writeVaruint(out, at, 0);
  for (let index = 0; index < count; index += 1) {
    out[at] = 0;
    out[at + 1] = 1;
    at += 2;
  }
  at = writeVaruint(out, at, 0);
  return out.slice(0, at);
}

// A snapshot whose delete set holds `count` one-clock ranges of one client, and an empty state vector.
function rangesSnapshot(count: number, client = 31): Uint8Array {
  const out = new Uint8Array(32 + 16 * count);
  let at = writeVaruint(out, 0, 1);
  at = writeVaruint(out, at, client);
  at = writeVaruint(out, at, count);
  for (let index = 0; index < count; index += 1) {
    at = writeVaruint(out, at, 2 * index);
    at = writeVaruint(out, at, 1);
  }
  at = writeVaruint(out, at, 0);
  return out.slice(0, at);
}

// The struct and delete-range counts Yjs itself reads from an update.
function yjsCounts(bytes: Uint8Array): { structs: number; ranges: number } {
  const decoded = testYjs().decodeUpdate(bytes);
  let ranges = 0;
  for (const list of decoded.ds.clients.values()) ranges += list.length;
  return { structs: decoded.structs.length, ranges };
}

// Five structs: client 31 types four letters, client 32 splits them once, client 33 splits the first half again.
function fiveStructState(): Uint8Array {
  const a = createLocalDoc(31);
  const first = localInsert(a, 0, 'aaaa');
  const b = createLocalDoc(32);
  testYjs().applyUpdate(b, first);
  const second = localInsert(b, 2, 'b');
  const c = createLocalDoc(33);
  testYjs().applyUpdate(c, first);
  testYjs().applyUpdate(c, second);
  const third = localInsert(c, 1, 'c');
  return foreignFullState([first, second, third]);
}

// ---- Task 1: skim before decode on the inspectUpdate path ----------------------------------------------------------------------------------------

test('the limits are the D-43 values: 256 KiB per update, 2 MiB per state, 100 000 structs, and doc.ts re-exports the same struct cap', () => {
  assert.equal(MAX_UPDATE_BYTES, 256 * 1024);
  assert.equal(MAX_STATE_BYTES, 2 * 1024 * 1024);
  assert.equal(MAX_STRUCTS, 100_000);
  assert.equal(DOC_MAX_STRUCTS, MAX_STRUCTS);
});

test('readVaruint reads Yjs varuints, stops after 8 bytes, checks every advance against the end and refuses values above the safe integer range', () => {
  for (const value of [0, 1, 127, 128, 300, 16_383, 16_384, 4_294_967_295, Number.MAX_SAFE_INTEGER]) {
    const bytes = varuintBytes(value);
    assert.deepEqual(readVaruint(bytes, 0), [value, bytes.length], `value ${value}`);
  }
  assert.deepEqual(readVaruint(Uint8Array.from([9, 9, 0x80, 0x01, 7]), 2), [128, 4]);
  assert.equal(readVaruint(Uint8Array.from([0x80]), 0), undefined);
  assert.equal(readVaruint(Uint8Array.from([5]), 1), undefined);
  assert.equal(readVaruint(new Uint8Array(0), 0), undefined);
  // Nine bytes is longer than any varuint the reader accepts, even when the value would be small.
  assert.equal(readVaruint(Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]), 0), undefined);
  // Eight bytes holding 2^56 - 1 is beyond Number.MAX_SAFE_INTEGER.
  assert.equal(readVaruint(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]), 0), undefined);
});

test('skimUpdate counts the same structs and delete ranges as Yjs on honest updates: a typed character, a paste, a deletion and a five-struct state', () => {
  const doc = createLocalDoc(31);
  const typed = localInsert(doc, 0, 'a');
  const paste = localInsert(doc, 1, 'A pasted paragraph of plain text. '.repeat(60));
  const deletion = localDelete(doc, 3, 40);
  const five = fiveStructState();
  const cases: Array<[string, Uint8Array]> = [['typed', typed], ['paste', paste], ['deletion', deletion], ['five structs', five]];
  for (const [name, bytes] of cases) {
    const skim = skimUpdate(bytes);
    const counted = yjsCounts(bytes);
    assert.deepEqual(skim, { ok: true, structs: counted.structs, ranges: counted.ranges }, name);
  }
  assert.deepEqual(yjsCounts(typed), { structs: 1, ranges: 0 });
  assert.deepEqual(yjsCounts(deletion), { structs: 0, ranges: 1 });
  assert.equal(yjsCounts(five).structs, 5);
});

test('skimUpdate refuses one struct over the cap as too-large and passes exactly the cap, and a caller may lower the cap', () => {
  assert.deepEqual(skimUpdate(gcProbe(MAX_STRUCTS + 1)), { ok: false, error: 'too-large' });
  assert.deepEqual(skimUpdate(gcProbe(MAX_STRUCTS)), { ok: true, structs: MAX_STRUCTS, ranges: 0 });
  assert.deepEqual(skimUpdate(gcProbe(5), 4), { ok: false, error: 'too-large' });
  assert.deepEqual(skimUpdate(gcProbe(5), 5), { ok: true, structs: 5, ranges: 0 });
});

test('skimUpdate refuses every content but GC, deleted and string as forbidden-content: an embed, a format, a map value, a nested type, a Skip and nested arrays', () => {
  const hostile: Array<[string, Uint8Array]> = [
    ['embed', embedUpdate(31)], ['format', formatUpdate(31)], ['map', mapUpdate(31)], ['nested type', nestedTypeUpdate(31)],
    ['skip', skipUpdate(31, 0, 4)], ['nested arrays', nestedArrayUpdate(20_000, 31)]
  ];
  for (const [name, bytes] of hostile) {
    assert.deepEqual(skimUpdate(bytes), { ok: false, error: 'forbidden-content' }, name);
    assert.deepEqual(inspectUpdate(bytes), { error: 'forbidden-content' }, name);
  }
});

test('skimUpdate refuses a truncated update, an over-long varuint, trailing bytes, random bytes and no bytes as malformed', () => {
  const real = localInsert(createLocalDoc(31), 0, 'a longer piece of text to cut');
  assert.equal(skimUpdate(real).ok, true);
  const withTrailing = new Uint8Array(real.length + 1);
  withTrailing.set(real);
  const malformed: Array<[string, Uint8Array]> = [
    ['truncated', real.slice(0, real.length - 6)],
    ['cut in the delete set', real.slice(0, real.length - 1)],
    ['over-long varuint', Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01, 0, 0])],
    ['trailing bytes', withTrailing],
    ['random bytes', Uint8Array.from(Array.from({ length: 24 }, () => 255))],
    ['no bytes', new Uint8Array(0)]
  ];
  for (const [name, bytes] of malformed) assert.deepEqual(skimUpdate(bytes), { ok: false, error: 'malformed' }, name);
});

test('inspectUpdate refuses bytes over MAX_UPDATE_BYTES as too-large without reading them, and the 120 000-struct probe under the byte limit as too-large with heap growth under 8 MB', (t) => {
  assert.deepEqual(inspectUpdate(new Uint8Array(MAX_UPDATE_BYTES + 1)), { error: 'too-large' });
  const probe = gcProbe(120_000);
  assert.ok(probe.length < MAX_UPDATE_BYTES, `probe is ${probe.length} bytes`);
  const measured = heapGrowth(() => inspectUpdate(probe));
  assert.deepEqual(measured.value, { error: 'too-large' });
  t.diagnostic(`120000-struct probe (${probe.length} bytes) through inspectUpdate: heap growth ${(measured.grew / MB).toFixed(2)} MB`);
  assert.ok(measured.grew < 8 * MB, `heap grew ${(measured.grew / MB).toFixed(1)} MB`);
});

// ---- Task 2: the same gates on applyUpdate, snapshots and states -----------------------------------------------------------------------------

test('applyUpdate refuses, before decoding, every probe inspectUpdate refuses, and the fold document is left as it was', (t) => {
  const doc = createFoldDoc();
  assert.equal(applyUpdate(doc, localInsert(createLocalDoc(31), 0, 'kept')), true);
  const vector = stateVectorOf(doc);
  const probes: Array<[string, Uint8Array]> = [
    ['over the byte limit', new Uint8Array(MAX_UPDATE_BYTES + 1)], ['one struct over the cap', gcProbe(MAX_STRUCTS + 1)],
    ['embed', embedUpdate(32)], ['skip', skipUpdate(32, 0, 4)], ['random bytes', Uint8Array.from(Array.from({ length: 24 }, () => 255))]
  ];
  for (const [name, bytes] of probes) {
    assert.equal(applyUpdate(doc, bytes), false, name);
    assert.deepEqual(stateVectorOf(doc), vector, name);
  }
  assert.equal(docText(doc), 'kept');
  const probe = gcProbe(120_000);
  const measured = heapGrowth(() => applyUpdate(doc, probe));
  assert.equal(measured.value, false);
  t.diagnostic(`120000-struct probe through applyUpdate: heap growth ${(measured.grew / MB).toFixed(2)} MB`);
  assert.ok(measured.grew < 8 * MB, `heap grew ${(measured.grew / MB).toFixed(1)} MB`);
});

test('skimSnapshot counts the delete ranges Yjs reads, refuses one range over the cap as too-large, and refuses a short or overlong snapshot as malformed', () => {
  const doc = createLocalDoc(101);
  localInsert(doc, 0, 'one two three four five six');
  localDelete(doc, 4, 4);
  localDelete(doc, 0, 2);
  const honest = snapshotOf(doc);
  const decoded = testYjs().decodeSnapshot(honest);
  let ranges = 0;
  for (const list of decoded.ds.clients.values()) ranges += list.length;
  assert.equal(ranges, 2);
  assert.deepEqual(skimSnapshot(honest), { ok: true, structs: 0, ranges });
  assert.deepEqual(skimSnapshot(rangesSnapshot(MAX_STRUCTS)), { ok: true, structs: 0, ranges: MAX_STRUCTS });
  assert.deepEqual(skimSnapshot(rangesSnapshot(MAX_STRUCTS + 1)), { ok: false, error: 'too-large' });
  assert.deepEqual(skimSnapshot(rangesSnapshot(5), 4), { ok: false, error: 'too-large' });
  const withTrailing = new Uint8Array(honest.length + 1);
  withTrailing.set(honest);
  assert.deepEqual(skimSnapshot(withTrailing), { ok: false, error: 'malformed' });
  assert.deepEqual(skimSnapshot(honest.slice(0, honest.length - 1)), { ok: false, error: 'malformed' });
  assert.deepEqual(skimSnapshot(new Uint8Array(0)), { ok: false, error: 'malformed' });
});

test('decodeSnapshot refuses bytes over MAX_STATE_BYTES and a snapshot of more than MAX_STRUCTS ranges before decoding, and still decodes an honest snapshot', (t) => {
  assert.equal(decodeSnapshot(new Uint8Array(MAX_STATE_BYTES + 1)), undefined);
  const hostile = rangesSnapshot(MAX_STRUCTS + 1);
  assert.ok(hostile.length < MAX_STATE_BYTES);
  const measured = heapGrowth(() => decodeSnapshot(hostile));
  assert.equal(measured.value, undefined);
  t.diagnostic(`${MAX_STRUCTS + 1}-range snapshot (${hostile.length} bytes) through decodeSnapshot: heap growth ${(measured.grew / MB).toFixed(2)} MB`);
  assert.ok(measured.grew < 8 * MB, `heap grew ${(measured.grew / MB).toFixed(1)} MB`);
  const doc = createLocalDoc(101);
  localInsert(doc, 0, 'typed text that stays');
  localDelete(doc, 0, 6);
  const honest = decodeSnapshot(snapshotOf(doc));
  assert.notEqual(honest, undefined);
  if (honest !== undefined) assert.deepEqual(snapshotStateVector(honest), [[101, 21]]);
});

test('a whole state uses MAX_STATE_BYTES: an honest 500 KB state loads through buildFromCompaction but is refused as one update, and states over the limits are refused', () => {
  const author = createLocalDoc(31);
  const fold = createFoldDoc();
  for (let chunk = 0; chunk < 10; chunk += 1) {
    const update = localInsert(author, chunk * 50_000, String.fromCharCode(97 + chunk).repeat(50_000));
    assert.equal(applyUpdate(fold, update), true);
  }
  const state = encodeFullState(fold);
  assert.ok(state.length > 500_000 && state.length > MAX_UPDATE_BYTES && state.length < MAX_STATE_BYTES, `state is ${state.length} bytes`);
  const loaded = buildFromCompaction(state, []);
  assert.notEqual(loaded, undefined);
  if (loaded !== undefined) assert.equal(docText(loaded), docText(fold));
  assert.equal(applyUpdate(createFoldDoc(), state), false);
  assert.equal(buildFromCompaction(new Uint8Array(MAX_STATE_BYTES + 1), []), undefined);
  assert.equal(buildFromCompaction(gcProbe(MAX_STRUCTS + 1), []), undefined);
  assert.equal(buildFromCompaction(state, [embedUpdate(32)]), undefined);
});

test('sealedBlobWithin answers from the base64url length alone: a real sealed blob of n bytes is within n, one byte more is not', () => {
  const key = Buffer.alloc(32, 7);
  const stream = 'a'.repeat(32);
  for (const size of [0, 1, 2, 3, 1000, 65_536]) {
    const blob = sealBlob(key, stream, 1, Buffer.alloc(size, 1));
    assert.equal(Buffer.from(blob.bytes, 'base64url').length, size + SEALED_OVERHEAD);
    assert.equal(sealedBlobWithin(blob, size), true, `size ${size}`);
    if (size > 0) assert.equal(sealedBlobWithin(blob, size - 1), false, `size ${size} against ${size - 1}`);
  }
  const oversized = { hash: '0'.repeat(64), bytes: 'A'.repeat(Math.ceil(((MAX_STATE_BYTES + SEALED_OVERHEAD + 1) * 4) / 3)) };
  assert.equal(sealedBlobWithin(oversized, MAX_STATE_BYTES), false);
  assert.equal(sealedBlobWithin({ hash: '0'.repeat(64), bytes: 42 as unknown as string }, MAX_STATE_BYTES), false);
  assert.equal(sealedBlobWithin({ hash: '0'.repeat(64), bytes: '' }, -1), false);
});

test('heap ceiling (D-43): the 2 000 000-GC-struct 4 000 007-byte probe grows the heap by under 64 MB through inspectUpdate and through the skim itself', (t) => {
  const probe = gcProbe(2_000_000);
  assert.equal(probe.length, 4_000_007);
  const inspected = heapGrowth(() => inspectUpdate(probe));
  assert.deepEqual(inspected.value, { error: 'too-large' });
  const skimmed = heapGrowth(() => skimUpdate(probe));
  assert.deepEqual(skimmed.value, { ok: false, error: 'too-large' });
  t.diagnostic(`2000000-struct probe: heap growth ${(inspected.grew / MB).toFixed(2)} MB through inspectUpdate, ${(skimmed.grew / MB).toFixed(2)} MB through skimUpdate (old code +191 MB)`);
  assert.ok(inspected.grew < 64 * MB, `inspectUpdate grew the heap ${(inspected.grew / MB).toFixed(1)} MB`);
  assert.ok(skimmed.grew < 64 * MB, `skimUpdate grew the heap ${(skimmed.grew / MB).toFixed(1)} MB`);
});

// ---- Task 3: linear delete check, one shared snapshot inspection, the unused export removed ------------------------------------------------

interface Range { clock: number; len: number }

// The check as Phase 30 wrote it: every wanted range inside one held range of the same client, found by scanning all held ranges.
function naiveCovered(wanted: ReadonlyMap<number, readonly Range[]>, held: ReadonlyMap<number, readonly Range[]>): boolean {
  for (const [client, ranges] of wanted) {
    const have = held.get(client) ?? [];
    for (const range of ranges) if (!have.some((h) => h.clock <= range.clock && h.clock + h.len >= range.clock + range.len)) return false;
  }
  return true;
}

// What the three questions should answer, computed independently with the bundle and the naive delete check.
function referenceReport(updates: readonly Uint8Array[], snapshotBytes: Uint8Array): { missing: boolean; text: string | undefined; runs: AttributionRun[] | undefined } | undefined {
  const Y = testYjs();
  if (decodeSnapshot(snapshotBytes) === undefined) return undefined;
  const snapshot = Y.decodeSnapshot(snapshotBytes);
  const scratch = new Y.Doc({ gc: false });
  for (const update of updates) Y.applyUpdate(scratch, update);
  const reached = Y.decodeStateVector(Y.encodeStateVector(scratch));
  const short = [...snapshot.sv.entries()].some(([client, clock]) => (reached.get(client) ?? 0) < clock);
  if (short || !naiveCovered(snapshot.ds.clients, Y.snapshot(scratch).ds.clients)) return { missing: true, text: undefined, runs: undefined };
  const at: CrdtDoc = Y.createDocFromSnapshot(scratch, snapshot);
  return { missing: false, text: at.getText('body').toString(), runs: attributionRuns(at) };
}

// A seeded document of three authors who each see every edit, with snapshots taken along the way, and an update list that is sometimes complete,
// sometimes a prefix and sometimes missing one update.
function randomCase(seed: number): { updates: Uint8Array[]; snapshot: Uint8Array } {
  const random = rng(seed);
  const authors = [createLocalDoc(201), createLocalDoc(202), createLocalDoc(203)];
  const updates: Uint8Array[] = [];
  const snapshots: Uint8Array[] = [];
  const steps = 10 + random.int(30);
  for (let step = 0; step < steps; step += 1) {
    const doc = random.pick(authors);
    const length = docText(doc).length;
    let update: Uint8Array;
    if (length > 0 && random.chance(0.35)) {
      const at = random.int(length);
      update = localDelete(doc, at, 1 + random.int(Math.min(6, length - at)));
    } else {
      update = localInsert(doc, random.int(length + 1), random.pick(['a', 'bc', 'def ', 'ghij', 'k l']).repeat(1 + random.int(3)));
    }
    updates.push(update);
    for (const other of authors) if (other !== doc) assert.equal(applyRemote(other, update), true);
    if (random.chance(0.25)) snapshots.push(snapshotOf(doc));
  }
  snapshots.push(snapshotOf(random.pick(authors)));
  const snapshot = random.pick(snapshots);
  const shape = random.int(3);
  if (shape === 0) return { updates, snapshot };
  if (shape === 1) return { updates: updates.slice(0, random.int(updates.length + 1)), snapshot };
  const dropped = random.int(updates.length);
  return { updates: updates.filter((_, index) => index !== dropped), snapshot };
}

test('snapshotReport answers missing, text and runs as the three separate questions and an independent reference do, on 50 seeded documents', () => {
  let missing = 0;
  let present = 0;
  for (let seed = 1; seed <= 50; seed += 1) {
    const { updates, snapshot } = randomCase(seed);
    const report = snapshotReport(updates, snapshot);
    assert.deepEqual(report, referenceReport(updates, snapshot), `seed ${seed}`);
    assert.equal(report?.missing === true, snapshotMissing(updates, snapshot), `seed ${seed}`);
    assert.equal(report?.text, textAtSnapshot(updates, snapshot), `seed ${seed}`);
    assert.deepEqual(report?.runs, attributionAtSnapshot(updates, snapshot), `seed ${seed}`);
    if (report?.missing === true) missing += 1;
    else present += 1;
  }
  // Both answers occur, so the comparison exercised each branch.
  assert.ok(missing > 0 && present > 0, `missing ${missing}, present ${present}`);
  const garbage = Uint8Array.from([9, 9, 9]);
  assert.equal(snapshotReport([], garbage), undefined);
  assert.equal(snapshotMissing([], garbage), false);
  assert.equal(textAtSnapshot([], garbage), undefined);
  assert.equal(attributionAtSnapshot([], garbage), undefined);
  assert.equal(snapshotReport([embedUpdate(31)], snapshotOf(createLocalDoc(31))), undefined);
});

test('rangesCovered gives the same answer as the scan-everything check on random small inputs, including unsorted and overlapping ranges', () => {
  const random = rng(4242);
  const rangesOf = (count: number): Range[] => Array.from({ length: count }, () => ({ clock: random.int(40), len: random.int(8) }));
  let covered = 0;
  for (let round = 0; round < 400; round += 1) {
    const wanted = new Map<number, Range[]>();
    const held = new Map<number, Range[]>();
    for (const client of [1, 2]) {
      if (random.chance(0.8)) wanted.set(client, rangesOf(random.int(4)));
      if (random.chance(0.8)) held.set(client, rangesOf(random.int(8)));
    }
    // Wanted ranges copied from the held ones (and shrunk) make covered answers common.
    for (const [client, have] of held) if (have.length > 0 && random.chance(0.5)) wanted.set(client, have.map((h) => ({ clock: h.clock + (h.len > 1 ? 1 : 0), len: Math.max(0, h.len - 2) })));
    const expected = naiveCovered(wanted, held);
    assert.equal(rangesCovered(wanted, held), expected, JSON.stringify({ wanted: [...wanted], held: [...held] }));
    if (expected) covered += 1;
  }
  assert.ok(covered > 50 && covered < 350, `covered ${covered} of 400`);
});

test('the delete check is a linear merge walk: 20 000 snapshot ranges against 20 000 held ranges finish in under 1.5 seconds', (t) => {
  const count = 20_000;
  const held = new Map([[31, Array.from({ length: count }, (_, index) => ({ clock: 2 * index, len: 1 }))]]);
  const wanted = new Map([[31, Array.from({ length: count }, (_, index) => ({ clock: 2 * index, len: 1 }))]]);
  const reversed = new Map([[31, [...(wanted.get(31) as Range[])].reverse()]]);
  const uncovered = new Map([[31, [...(wanted.get(31) as Range[]), { clock: 2 * count, len: 1 }]]]);
  const started = performance.now();
  assert.equal(rangesCovered(wanted, held), true);
  assert.equal(rangesCovered(reversed, held), true);
  assert.equal(rangesCovered(uncovered, held), false);
  const took = performance.now() - started;
  t.diagnostic(`three checks of ${count} ranges against ${count}: ${took.toFixed(1)} ms`);
  assert.ok(took < 1500, `took ${took.toFixed(0)} ms`);
});

test('the unused update-clients export is gone from doc.ts and nothing under src names it (IN-02)', () => {
  const name = ['update', 'Clients'].join('');
  assert.equal(name in docModule, false);
  const src = path.resolve(__dirname, '..', '..', 'src');
  assert.ok(existsSync(src));
  const found: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && new RegExp(`\\b${name}\\b`).test(readFileSync(full, 'utf8'))) found.push(path.relative(src, full));
    }
  };
  walk(src);
  assert.deepEqual(found, []);
});
