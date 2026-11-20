// The work a hostile Yjs update can cause is bounded before Yjs sees it (D-05 as refined by D-43, WR-07): byte limits per kind, a strict skim that
// counts structs and delete ranges and refuses every content but GC, deleted and string, and heap ceilings measured with a forced collection.
// Probe bytes are built here with a small varuint writer; no large fixture is committed.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as v8 from 'node:v8';
import * as vm from 'node:vm';
import { MAX_STRUCTS as DOC_MAX_STRUCTS, createLocalDoc, inspectUpdate, localDelete, localInsert } from '../domain/replica/doc';
import { MAX_STATE_BYTES, MAX_STRUCTS, MAX_UPDATE_BYTES } from '../domain/replica/kindSchemas/doc';
import { readVaruint, skimUpdate } from '../domain/replica/updateGuard';
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
