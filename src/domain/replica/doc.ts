// The only file that loads Yjs (D-17, D-33). Yjs is bundled into vendor/yjs/yjs.cjs by scripts/vendor-libs.mjs; this file loads that one file lazily
// and takes its types from the dev dependency with `import type`, which is erased at compile time (the way src/mcp/client.ts loads the MCP bundle).
// Never use constructor.name or instanceof by class name here: the bundle is minified and renames classes.
//
// Everything below is a thin, plain-data surface (bytes, numbers, strings, arrays) so no other file needs a Yjs type.
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type * as YTypes from 'yjs';
import { MAX_UPDATE_BYTES } from './kindSchemas/doc';

type YjsApi = typeof YTypes;
export type CrdtDoc = YTypes.Doc;
const TEXT_NAME = 'body';
const REMOTE = 'remote';
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
