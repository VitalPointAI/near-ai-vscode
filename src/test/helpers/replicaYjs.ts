// Test-only access to the vendored Yjs bundle, so tests can build the hostile updates src/domain/replica/doc.ts deliberately cannot produce
// (embeds, formats, maps, nested types, Skip structs, oversized GC structs, deep nesting, a peer's whole document). D-17 governs src/domain/replica/:
// only doc.ts loads Yjs there, and this helper lives under src/test/ so the boundary test (plan 30-11) has nothing to flag.
import * as path from 'node:path';
import type * as YTypes from 'yjs';

type YjsApi = typeof YTypes;
let loaded: YjsApi | undefined;

// The same bundle the extension loads, found from the compiled test folder (dist/test/helpers) up to the repository root.
export function testYjs(): YjsApi {
  if (loaded === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require(path.join(__dirname, '..', '..', '..', 'vendor', 'yjs', 'yjs.cjs')) as YjsApi;
  }
  return loaded;
}

function docFor(clientId: number): YTypes.Doc {
  const doc = new (testYjs().Doc)();
  doc.clientID = clientId;
  return doc;
}

function updateOf(doc: YTypes.Doc, run: () => void): Uint8Array {
  const produced: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => { produced.push(update); });
  doc.transact(run);
  return testYjs().mergeUpdates(produced);
}

// An update that puts an embedded object into the text.
export function embedUpdate(clientId: number): Uint8Array {
  const doc = docFor(clientId);
  return updateOf(doc, () => { doc.getText('body').insertEmbed(0, { picture: 'x' }); });
}

// An update that sets a value in a map under another root.
export function mapUpdate(clientId: number): Uint8Array {
  const doc = docFor(clientId);
  return updateOf(doc, () => { doc.getMap('other').set('key', 'value'); });
}

// An update that formats text (bold), which adds format structs next to the string.
export function formatUpdate(clientId: number): Uint8Array {
  const doc = docFor(clientId);
  return updateOf(doc, () => { doc.getText('body').insert(0, 'bold', { bold: true }); });
}

// An update that nests a Yjs type inside another.
export function nestedTypeUpdate(clientId: number): Uint8Array {
  const doc = docFor(clientId);
  const Y = testYjs();
  return updateOf(doc, () => { doc.getArray('list').push([new Y.Map()]); });
}

function varUint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 127) {
    bytes.push(128 | (rest % 128));
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return bytes;
}

function varString(text: string): number[] {
  const encoded = Buffer.from(text, 'utf8');
  return [...varUint(encoded.length), ...encoded];
}

// A hand-built update of one client group. Yjs's own writer cannot make a Skip struct or a GC struct of this length, so the bytes are written here.
function groupUpdate(clientId: number, clock: number, structs: number[]): Uint8Array {
  return Uint8Array.from([...varUint(1), ...varUint(1), ...varUint(clientId), ...varUint(clock), ...structs, ...varUint(0)]);
}

// A struct that skips a range of a client's clocks: Yjs accepts it on the wire and the fold must refuse it.
export function skipUpdate(clientId: number, clock: number, length: number): Uint8Array {
  return groupUpdate(clientId, clock, [10, ...varUint(length)]);
}

// A GC struct (deleted and collected text) that claims the given number of clock positions.
export function gcUpdate(clientId: number, clock: number, length: number): Uint8Array {
  return groupUpdate(clientId, clock, [0, ...varUint(length)]);
}

// An update with one map value that holds `depth` nested arrays. Around 20 000 levels overflow the decoder's stack, as a 40 KB update; Yjs's
// own encoder would overflow building it, so the bytes are written level by level here.
export function nestedArrayUpdate(depth: number, clientId = 9): Uint8Array {
  const levels: number[] = [];
  for (let level = 0; level < depth; level += 1) levels.push(117, 1);
  const item = [8 | 32, ...varUint(1), ...varString('other'), ...varString('key'), ...varUint(1), ...levels, 126];
  return groupUpdate(clientId, 0, item);
}

// A peer's whole document re-encoded after it received other people's text. It contains structs of every client in it, so a writer that sends it
// as a doc.update is claiming text it did not type.
export function foreignFullState(updates: readonly Uint8Array[]): Uint8Array {
  const Y = testYjs();
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  return Y.encodeStateAsUpdate(doc);
}
