// Bounds the work a hostile Yjs update can cause before Yjs sees it (D-05 as refined by D-43, WR-07). Pure and hub-side: it never loads Yjs, so the
// hub (Phase 32) runs the same check with the same numbers. The skim walks the Yjs v1 layout, reads only the fields it must step over, counts structs
// and delete ranges, and allocates nothing per struct. Yjs's own decoder makes an object per struct and an array sized by the struct count it reads,
// so a few megabytes of tiny GC structs cost hundreds of megabytes of heap there; here they cost a counter.
//
// The v1 layout (yjs/src/utils/encoding.js readClientsStructRefs, UpdateDecoder.js, DeleteSet.js readDeleteSet, Snapshot.js):
//   update     varuint groups; each group: varuint structs, varuint client, varuint first clock, then the structs; then a delete set
//   struct     one info byte, whose low 5 bits are the content ref
//              ref 0 (GC): varuint length
//              any other ref is an item: info & 0x80 an origin id, info & 0x40 a right origin id (an id is varuint client, varuint clock);
//              with neither bit set, varuint parent info, then a string key when it is 1 or an id otherwise, and a string parent key when
//              info & 0x20; then the content: ref 1 (deleted) is a varuint length, ref 4 (string) is a string
//   string     varuint byte length, then that many bytes
//   delete set varuint clients; each: varuint client, varuint ranges, each range varuint clock and varuint length
//   snapshot   a delete set, then a state vector: varuint clients; each: varuint client, varuint clock
// Every other content ref, including Skip (10), is refused: the fold refuses it after decoding anyway (D-35), so refusing it first costs nothing.
import { SEALED_OVERHEAD } from './entry';
import type { SealedBlob } from './entry';
import { MAX_STRUCTS } from './kindSchemas/doc';

export type SkimError = 'malformed' | 'too-large' | 'forbidden-content';
// structs and ranges are what the bytes declare; a snapshot has no structs, so its structs is 0.
export type SkimResult = { ok: true; structs: number; ranges: number } | { ok: false; error: SkimError };

// lib0 writes 7 bits per byte; 8 bytes hold 56 bits, more than any safe integer, so a longer varuint is never one Yjs wrote.
const MAX_VARUINT_BYTES = 8;
const REF_GC = 0;
const REF_DELETED = 1;
const REF_STRING = 4;
const REF_MASK = 0x1f;
const HAS_ORIGIN = 0x80;
const HAS_RIGHT_ORIGIN = 0x40;
const HAS_PARENT_SUB = 0x20;
const PARENT_IS_KEY = 1;

// The value of the varuint at `at` and the offset after it; undefined when it runs past the end, is longer than 8 bytes, or is not a safe integer.
export function readVaruint(bytes: Uint8Array, at: number): [number, number] | undefined {
  const cursor = new Cursor(bytes, at);
  return cursor.uint() ? [cursor.value, cursor.at] : undefined;
}

// One cursor per skim: the walk reads into `value` instead of returning a pair, so nothing is allocated per struct.
class Cursor {
  value = 0;
  constructor(readonly bytes: Uint8Array, public at: number) {}

  uint(): boolean {
    let value = 0;
    let scale = 1;
    for (let used = 0; used < MAX_VARUINT_BYTES; used += 1) {
      const index = this.at + used;
      if (index >= this.bytes.length) return false;
      const byte = this.bytes[index];
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) {
        if (!Number.isSafeInteger(value)) return false;
        this.value = value;
        this.at = index + 1;
        return true;
      }
      scale *= 128;
    }
    return false;
  }

  uints(count: number): boolean {
    for (let index = 0; index < count; index += 1) if (!this.uint()) return false;
    return true;
  }

  // A varuint byte length, then that many bytes stepped over without decoding them.
  string(): boolean {
    if (!this.uint() || this.value > this.bytes.length - this.at) return false;
    this.at += this.value;
    return true;
  }

  byte(): number | undefined {
    if (this.at >= this.bytes.length) return undefined;
    const value = this.bytes[this.at];
    this.at += 1;
    return value;
  }

  done(): boolean {
    return this.at === this.bytes.length;
  }
}

// Steps over one struct; undefined when it is allowed and well formed.
function skipStruct(cursor: Cursor): SkimError | undefined {
  const info = cursor.byte();
  if (info === undefined) return 'malformed';
  const ref = info & REF_MASK;
  if (ref === REF_GC) return cursor.uint() ? undefined : 'malformed';
  if (ref !== REF_DELETED && ref !== REF_STRING) return 'forbidden-content';
  if ((info & HAS_ORIGIN) !== 0 && !cursor.uints(2)) return 'malformed';
  if ((info & HAS_RIGHT_ORIGIN) !== 0 && !cursor.uints(2)) return 'malformed';
  if ((info & (HAS_ORIGIN | HAS_RIGHT_ORIGIN)) === 0) {
    if (!cursor.uint()) return 'malformed';
    if (!(cursor.value === PARENT_IS_KEY ? cursor.string() : cursor.uints(2))) return 'malformed';
    if ((info & HAS_PARENT_SUB) !== 0 && !cursor.string()) return 'malformed';
  }
  if (ref === REF_DELETED) return cursor.uint() ? undefined : 'malformed';
  return cursor.string() ? undefined : 'malformed';
}

// The number of delete ranges, or the reason the delete set is refused. Counts are checked before the ranges are walked.
function skimDeleteSet(cursor: Cursor, maxRanges: number): number | SkimError {
  if (!cursor.uint()) return 'malformed';
  const clients = cursor.value;
  if (clients > maxRanges) return 'too-large';
  let ranges = 0;
  for (let index = 0; index < clients; index += 1) {
    if (!cursor.uint() || !cursor.uint()) return 'malformed';
    const count = cursor.value;
    if (count > maxRanges - ranges) return 'too-large';
    ranges += count;
    if (!cursor.uints(2 * count)) return 'malformed';
  }
  return ranges;
}

// Skims one v1 update. too-large as soon as the declared structs, client groups or delete ranges pass the cap, before any of them is walked;
// forbidden-content at the first struct whose content is not GC, deleted or string; malformed for anything short, over-long or followed by bytes.
export function skimUpdate(bytes: Uint8Array, maxStructs: number = MAX_STRUCTS): SkimResult {
  const cursor = new Cursor(bytes, 0);
  if (!cursor.uint()) return { ok: false, error: 'malformed' };
  const groups = cursor.value;
  // Yjs never writes a group without structs, so more groups than the struct cap is never honest.
  if (groups > maxStructs) return { ok: false, error: 'too-large' };
  let structs = 0;
  for (let group = 0; group < groups; group += 1) {
    if (!cursor.uint()) return { ok: false, error: 'malformed' };
    const count = cursor.value;
    if (count > maxStructs - structs) return { ok: false, error: 'too-large' };
    structs += count;
    // The client id and the first clock.
    if (!cursor.uints(2)) return { ok: false, error: 'malformed' };
    for (let index = 0; index < count; index += 1) {
      const error = skipStruct(cursor);
      if (error !== undefined) return { ok: false, error };
    }
  }
  const ranges = skimDeleteSet(cursor, maxStructs);
  if (typeof ranges !== 'number') return { ok: false, error: ranges };
  if (!cursor.done()) return { ok: false, error: 'malformed' };
  return { ok: true, structs, ranges };
}

// Skims one v1 snapshot: its delete ranges and its state vector clients are each capped at maxRanges, and nothing may follow the state vector.
export function skimSnapshot(bytes: Uint8Array, maxRanges: number = MAX_STRUCTS): SkimResult {
  const cursor = new Cursor(bytes, 0);
  const ranges = skimDeleteSet(cursor, maxRanges);
  if (typeof ranges !== 'number') return { ok: false, error: ranges };
  if (!cursor.uint()) return { ok: false, error: 'malformed' };
  const clients = cursor.value;
  if (clients > maxRanges) return { ok: false, error: 'too-large' };
  if (!cursor.uints(2 * clients)) return { ok: false, error: 'malformed' };
  if (!cursor.done()) return { ok: false, error: 'malformed' };
  return { ok: true, structs: 0, ranges };
}

// Could this sealed blob open to at most maxPlainBytes of plaintext? Arithmetic on the base64url length only: nothing is decoded or opened, so an
// oversized blob is refused before any buffer of its size exists (new defect 1 in 31-RESEARCH.md; used by the reducers from plan 31-07).
export function sealedBlobWithin(blob: SealedBlob, maxPlainBytes: number): boolean {
  if (typeof blob.bytes !== 'string' || !Number.isSafeInteger(maxPlainBytes) || maxPlainBytes < 0) return false;
  // Unpadded base64url: n characters decode to at most floor(3n / 4) bytes.
  return Math.floor((blob.bytes.length * 3) / 4) <= maxPlainBytes + SEALED_OVERHEAD;
}
