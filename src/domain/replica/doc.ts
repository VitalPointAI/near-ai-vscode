// The only file that loads Yjs (D-17, D-33). Yjs is bundled into vendor/yjs/yjs.cjs by scripts/vendor-libs.mjs; this file loads that one file lazily
// and takes its types from the dev dependency with `import type`, which is erased at compile time (the way src/mcp/client.ts loads the MCP bundle).
// Never recognise a Yjs struct or content by its class name here: the bundle is minified and renames classes. Use 'content' in struct and getRef().
//
// Everything below is a thin, plain-data surface (bytes, numbers, strings, arrays) so no other file needs a Yjs type.
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type * as YTypes from 'yjs';
import { MAX_STRUCTS, MAX_UPDATE_BYTES } from './kindSchemas/doc';
import { skimUpdate } from './updateGuard';

type YjsApi = typeof YTypes;
export type CrdtDoc = YTypes.Doc;
const TEXT_NAME = 'body';
const REMOTE = 'remote';
// Yjs content kinds (getRef) a product may carry: typed text and the tombstone of deleted text. Everything else widens the parser surface (D-35).
const REF_DELETED = 1;
const REF_STRING = 4;
const REF_GC = 0;
// Most clock positions one struct may claim (D-35). A GC struct is only a few bytes on the wire but moves a client's clock by its length, so the
// length needs a cap of its own. The struct and delete-range cap lives with the byte limits in kindSchemas/doc.ts and is re-exported here.
export const MAX_STRUCT_LENGTH = 1_000_000;
export { MAX_STRUCTS };
let yjs: YjsApi | undefined;

function loadYjs(): YjsApi {
  if (yjs === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      yjs = require(path.join(__dirname, '..', '..', '..', 'vendor', 'yjs', 'yjs.cjs')) as YjsApi;
    } catch (error) {
      throw new Error(`The shared text library is missing from this installation. Run npm run compile. (${(error as Error).message})`);
    }
  }
  return yjs;
}

// The fold's document for one product: garbage collection off so versions and "who deleted what" keep working, and never edited, so its client id
// is a fixed 0 and Yjs cannot swap it (doc.client refuses id 0).
export function createFoldDoc(): CrdtDoc {
  const Y = loadYjs();
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 0;
  return doc;
}

// False on any failure, including a size over the limit.
export function applyUpdate(doc: CrdtDoc, bytes: Uint8Array): boolean {
  try {
    if (bytes.length > MAX_UPDATE_BYTES) return false;
    loadYjs().applyUpdate(doc, bytes, REMOTE);
    return true;
  } catch {
    // A hostile update that Yjs cannot decode or apply is refused, never thrown.
    return false;
  }
}

export function docText(doc: CrdtDoc): string {
  return doc.getText(TEXT_NAME).toString();
}

export function textHashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Sorted [client, clock] pairs, built here so a change in how Yjs orders its own encoding cannot change a digest.
export function stateVectorOf(doc: CrdtDoc): Array<[number, number]> {
  const Y = loadYjs();
  return [...Y.decodeStateVector(Y.encodeStateVector(doc)).entries()].sort((a, b) => a[0] - b[0]);
}

// Client ids of the structs an update inserts, sorted; undefined when the update cannot be read or is over the size limit.
export function updateClients(bytes: Uint8Array): number[] | undefined {
  try {
    if (bytes.length > MAX_UPDATE_BYTES) return undefined;
    return [...loadYjs().parseUpdateMeta(bytes).from.keys()].sort((a, b) => a - b);
  } catch {
    // An update that cannot be read has no clients to name.
    return undefined;
  }
}

// A local editor document, as a person's editor or an agent run would hold it. Used by tests and, later, the editor binding.
export function createLocalDoc(clientId: number): CrdtDoc {
  const doc = new (loadYjs().Doc)();
  doc.clientID = clientId;
  return doc;
}

// Runs one local transaction and returns exactly the update it produced (empty when it changed nothing).
function localUpdate(doc: CrdtDoc, run: () => void): Uint8Array {
  const Y = loadYjs();
  const origin = { local: true };
  const produced: Uint8Array[] = [];
  const onUpdate = (update: Uint8Array, from: unknown): void => { if (from === origin) produced.push(update); };
  doc.on('update', onUpdate);
  try {
    doc.transact(run, origin);
  } finally {
    doc.off('update', onUpdate);
  }
  return produced.length === 0 ? new Uint8Array(0) : Y.mergeUpdates(produced);
}

export function localInsert(doc: CrdtDoc, index: number, text: string): Uint8Array {
  return localUpdate(doc, () => { doc.getText(TEXT_NAME).insert(index, text); });
}

export function localDelete(doc: CrdtDoc, index: number, length: number): Uint8Array {
  return localUpdate(doc, () => { doc.getText(TEXT_NAME).delete(index, length); });
}

// Applies another writer's update to a local document; the remote origin keeps it out of the local update capture.
export function applyRemote(doc: CrdtDoc, bytes: Uint8Array): boolean {
  try {
    loadYjs().applyUpdate(doc, bytes, REMOTE);
    return true;
  } catch {
    // Same answer as applyUpdate: a bad update is false, not an exception.
    return false;
  }
}

// A new fold-style document (garbage collection off, client id 0) holding the same state.
export function cloneDoc(doc: CrdtDoc): CrdtDoc {
  const Y = loadYjs();
  const copy = createFoldDoc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc), REMOTE);
  return copy;
}

// A decoded snapshot: a state vector plus a delete set. It names the text as it was at one moment (D-34).
export type CrdtSnapshot = YTypes.Snapshot;

// The bytes of a snapshot of the document as it is now. Deleting text changes the delete set and not the state vector, so two snapshots can differ
// while the state vector is the same.
export function snapshotOf(doc: CrdtDoc): Uint8Array {
  const Y = loadYjs();
  return Y.encodeSnapshot(Y.snapshot(doc));
}

// undefined for anything that is not exactly one snapshot: unreadable bytes, bytes over the size limit, or trailing bytes after the snapshot.
export function decodeSnapshot(bytes: Uint8Array): CrdtSnapshot | undefined {
  try {
    if (bytes.length === 0 || bytes.length > MAX_UPDATE_BYTES) return undefined;
    const Y = loadYjs();
    const decoded = Y.decodeSnapshot(bytes);
    // Re-encoding must give the same bytes: a snapshot that does not round-trip is not one this code would have made.
    return Buffer.from(Y.encodeSnapshot(decoded)).equals(Buffer.from(bytes)) ? decoded : undefined;
  } catch {
    // Hostile or damaged bytes have no snapshot to give.
    return undefined;
  }
}

// Sorted [client, clock] pairs of the snapshot's state vector, clocks of zero left out.
export function snapshotStateVector(snapshot: CrdtSnapshot): Array<[number, number]> {
  return [...snapshot.sv.entries()].filter((pair) => pair[1] > 0).sort((a, b) => a[0] - b[0]);
}

// A scratch document with garbage collection off holding the given updates. createDocFromSnapshot needs garbage collection off and writes to the
// document it reads, so it is only ever called on a scratch document and never on a fold document.
function scratchDocWith(updates: readonly Uint8Array[]): CrdtDoc | undefined {
  const scratch = createFoldDoc();
  for (const update of updates) if (!applyUpdate(scratch, update)) return undefined;
  return scratch;
}

// Is every deleted range of the snapshot also deleted in the scratch document?
function deletesCovered(snapshot: CrdtSnapshot, scratch: CrdtDoc): boolean {
  const have = loadYjs().snapshot(scratch).ds.clients;
  for (const [client, wanted] of snapshot.ds.clients) {
    const held = have.get(client) ?? [];
    for (const range of wanted) {
      if (!held.some((candidate) => candidate.clock <= range.clock && candidate.clock + candidate.len >= range.clock + range.len)) return false;
    }
  }
  return true;
}

// The decoded snapshot and the scratch document, and whether the updates fall short of the snapshot: a client clock above theirs, or a deletion
// they do not carry. undefined when the snapshot cannot be decoded or an update cannot be applied.
function inspectSnapshot(updates: readonly Uint8Array[], snapshotBytes: Uint8Array): { snapshot: CrdtSnapshot; scratch: CrdtDoc; missing: boolean } | undefined {
  const snapshot = decodeSnapshot(snapshotBytes);
  if (snapshot === undefined) return undefined;
  const scratch = scratchDocWith(updates);
  if (scratch === undefined) return undefined;
  const reached = new Map(stateVectorOf(scratch));
  const short = snapshotStateVector(snapshot).some(([client, clock]) => (reached.get(client) ?? 0) < clock);
  return { snapshot, scratch, missing: short || !deletesCovered(snapshot, scratch) };
}

// True when the snapshot covers something the supplied updates do not reach, so some update the snapshot covers is absent. False when the snapshot
// cannot be decoded (it names nothing) and when an update cannot be applied.
export function snapshotMissing(updates: readonly Uint8Array[], snapshotBytes: Uint8Array): boolean {
  return inspectSnapshot(updates, snapshotBytes)?.missing === true;
}

// The text the snapshot names, rebuilt on a scratch document from the supplied updates. undefined when the snapshot cannot be decoded, an update
// cannot be applied, or the updates do not cover the snapshot (snapshotMissing tells the last case apart).
export function textAtSnapshot(updates: readonly Uint8Array[], snapshotBytes: Uint8Array): string | undefined {
  try {
    const found = inspectSnapshot(updates, snapshotBytes);
    if (found === undefined || found.missing) return undefined;
    return docText(loadYjs().createDocFromSnapshot(found.scratch, found.snapshot));
  } catch {
    // createDocFromSnapshot throws on a snapshot it cannot honour; that is "no text", not a crash.
    return undefined;
  }
}


// ---- Update inspection (D-19, D-35) ---------------------------------------------------------------------------------------------------------
// The fold decides ownership from what an update says, before applying it. Nothing here applies anything.

export type StructKind = 'string' | 'deleted' | 'gc';
// parentOk: an item names no parent or the text root 'body' and no map key; false for a nested type, another root or a map value.
export interface InspectedStruct { client: number; clock: number; length: number; kind: StructKind; parentOk: boolean }
export interface DeleteRange { client: number; clock: number; length: number }
// The clocks one client's structs cover in this update: start is the first clock, end is one past the last.
export interface ClientSpan { client: number; start: number; end: number }
export interface UpdateInspection { structs: InspectedStruct[]; deletes: DeleteRange[]; clients: ClientSpan[] }
export type InspectError = 'malformed' | 'too-large' | 'forbidden-content';

const sameNumber = (a: number, b: number): number => a - b;

// The ref byte a non-item struct writes: 0 for a GC struct, 10 for a Skip. Asked of the struct itself because the bundle is minified, so class names
// cannot be trusted, and neither struct exposes its kind as a property.
function nonItemRef(struct: YTypes.AbstractStruct): number | undefined {
  const encoder = new (loadYjs().UpdateEncoderV1)();
  struct.write(encoder, 0, 0);
  return encoder.toUint8Array()[0];
}

function inspectDecoded(bytes: Uint8Array): UpdateInspection | { error: InspectError } {
  const decoded = loadYjs().decodeUpdate(bytes);
  if (decoded.structs.length > MAX_STRUCTS) return { error: 'too-large' };
  const structs: InspectedStruct[] = [];
  const spans = new Map<number, ClientSpan>();
  for (const struct of decoded.structs) {
    const { client, clock } = struct.id;
    const length = struct.length;
    if (!Number.isSafeInteger(client) || !Number.isSafeInteger(clock) || !Number.isSafeInteger(length) || length < 1 || clock + length > Number.MAX_SAFE_INTEGER) {
      return { error: 'malformed' };
    }
    if (length > MAX_STRUCT_LENGTH) return { error: 'too-large' };
    let kind: StructKind;
    let parentOk = true;
    if ('content' in struct) {
      const item = struct as YTypes.Item;
      const ref = item.content.getRef();
      if (ref === REF_STRING) kind = 'string';
      else if (ref === REF_DELETED) kind = 'deleted';
      else return { error: 'forbidden-content' };
      const parent: unknown = item.parent;
      parentOk = (typeof parent === 'string' ? parent === TEXT_NAME : parent === null) && item.parentSub === null;
    } else if (nonItemRef(struct) === REF_GC) {
      kind = 'gc';
    } else {
      // A Skip struct, or anything else that is neither an item nor a GC struct.
      return { error: 'forbidden-content' };
    }
    structs.push({ client, clock, length, kind, parentOk });
    const span = spans.get(client);
    if (span === undefined) spans.set(client, { client, start: clock, end: clock + length });
    else if (clock !== span.end) return { error: 'malformed' };
    else span.end = clock + length;
  }
  const deletes: DeleteRange[] = [];
  for (const [client, ranges] of decoded.ds.clients) {
    for (const range of ranges) {
      if (!Number.isSafeInteger(client) || !Number.isSafeInteger(range.clock) || !Number.isSafeInteger(range.len) || range.len < 1) return { error: 'malformed' };
      deletes.push({ client, clock: range.clock, length: range.len });
    }
    if (deletes.length > MAX_STRUCTS) return { error: 'too-large' };
  }
  deletes.sort((a, b) => sameNumber(a.client, b.client) || sameNumber(a.clock, b.clock) || sameNumber(a.length, b.length));
  return { structs, deletes, clients: [...spans.values()].sort((a, b) => sameNumber(a.client, b.client)) };
}

// Reads an update without applying it. The byte size and then the skim (updateGuard.ts: struct and range counts, allowed content) are checked
// before anything is decoded, so a hostile update is refused by counting before Yjs allocates for it (WR-07); any failure to decode is
// { error: 'malformed' } and never an exception.
export function inspectUpdate(bytes: Uint8Array): UpdateInspection | { error: InspectError } {
  if (bytes.length > MAX_UPDATE_BYTES) return { error: 'too-large' };
  const skim = skimUpdate(bytes);
  if (!skim.ok) return { error: skim.error };
  try {
    return inspectDecoded(bytes);
  } catch {
    // RangeError from a nested update, or any decoder error: the update is refused, not thrown.
    return { error: 'malformed' };
  }
}

// What a peer is missing: the structs and deletions the document has beyond the given state vector (sorted [client, clock] pairs).
export function encodeDiff(doc: CrdtDoc, stateVector: ReadonlyArray<readonly [number, number]>): Uint8Array {
  const Y = loadYjs();
  return Y.encodeStateAsUpdate(doc, Y.encodeStateVector(new Map(stateVector.map((pair): [number, number] => [pair[0], pair[1]]))));
}

// The whole document as one update. Called on a fold document (garbage collection off), so deleted text is kept for versions and attribution.
export function encodeFullState(doc: CrdtDoc): Uint8Array {
  return loadYjs().encodeStateAsUpdate(doc);
}

// A fold-style document holding a compaction's full state and then the updates after it; undefined when any of them cannot be applied.
export function buildFromCompaction(state: Uint8Array, laterUpdates: readonly Uint8Array[]): CrdtDoc | undefined {
  return scratchDocWith([state, ...laterUpdates]);
}

// True while the document holds structs or deletions it cannot place yet because something they refer to is missing (a gap in a client's clock).
export function pendingState(doc: CrdtDoc): boolean {
  return doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
}

// ---- Attribution (D-20) ----------------------------------------------------------------------------------------------------------------------

// A stretch of visible text typed under one client id, in document order. Adjacent stretches of one client with consecutive clocks are joined, so
// two documents holding the same structs split differently give the same runs.
export interface AttributionRun { client: number; clock: number; length: number; text: string }

function runsOf(doc: CrdtDoc): AttributionRun[] {
  const runs: AttributionRun[] = [];
  let item = doc.getText(TEXT_NAME)._start;
  while (item !== null) {
    if (!item.deleted && item.content.getRef() === REF_STRING) {
      const text = (item.content as YTypes.ContentString).str;
      const last = runs[runs.length - 1];
      if (last !== undefined && last.client === item.id.client && last.clock + last.length === item.id.clock) {
        last.length += text.length;
        last.text += text;
      } else {
        runs.push({ client: item.id.client, clock: item.id.clock, length: text.length, text });
      }
    }
    item = item.right;
  }
  return runs;
}

export function attributionRuns(doc: CrdtDoc): AttributionRun[] {
  return runsOf(doc);
}

// The runs of the text as it was at a snapshot, rebuilt on a scratch document like textAtSnapshot; undefined where textAtSnapshot gives undefined.
export function attributionAtSnapshot(updates: readonly Uint8Array[], snapshotBytes: Uint8Array): AttributionRun[] | undefined {
  try {
    const found = inspectSnapshot(updates, snapshotBytes);
    if (found === undefined || found.missing) return undefined;
    return runsOf(loadYjs().createDocFromSnapshot(found.scratch, found.snapshot));
  } catch {
    // Same answer as textAtSnapshot: a snapshot that cannot be honoured has no runs.
    return undefined;
  }
}
