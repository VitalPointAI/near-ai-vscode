import test from 'node:test';
import assert from 'node:assert/strict';
import type URI from '@theia/core/lib/common/uri.js';
import { saveResourceCatalogue } from '../extension/src/browser/sterling-resource-catalogue.ts';
import { parseInventorySnapshot } from '../extension/src/common/sterling-resource-inventory.ts';

const generatedAt = '2026-11-24T00:00:00Z';
const entry = {
  id: 'aircraft-example', name: 'Example aircraft', category: 'Aircraft', lifecycle: 'Publicly listed',
  sourceRef: 'https://www.example.gc.ca/aircraft', imageDigest: 'a'.repeat(64)
};
const catalogue = (resources: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ schemaVersion: 1, sourceId: 'example-catalogue', source: 'Example public sources', generatedAt, catalogueOnly: true, resources, ...extra });
const reported = (resources: unknown[]): string =>
  JSON.stringify({ schemaVersion: 1, sourceId: 'example-stock', source: 'Example stock export', generatedAt, resources });

test('a catalogue keeps its evidence fields and archived entries, and says it is a catalogue', () => {
  const parsed = parseInventorySnapshot(catalogue([entry, { ...entry, id: 'aircraft-retired', reviewNote: 'Retired in 2024.', archived: true }]));
  assert.equal(parsed?.catalogueOnly, true);
  assert.deepEqual(parsed?.resources.map(({ id, sourceRef, lifecycle, imageDigest, reviewNote, archived }) =>
    ({ id, sourceRef, lifecycle, imageDigest, reviewNote, archived })), [
    { id: 'aircraft-example', sourceRef: entry.sourceRef, lifecycle: 'Publicly listed', imageDigest: entry.imageDigest, reviewNote: undefined, archived: undefined },
    { id: 'aircraft-retired', sourceRef: entry.sourceRef, lifecycle: 'Publicly listed', imageDigest: entry.imageDigest, reviewNote: 'Retired in 2024.', archived: true }
  ]);
  assert.equal(parseInventorySnapshot(reported([{ id: 'item-1', name: 'Example item', category: 'Stores', quantity: 2 }]))?.catalogueOnly, undefined);
});

test('a catalogue entry cites its evidence and claims no holding: no quantity, status, asset DID or usage policy', () => {
  for (const [why, item] of Object.entries({
    'no evidence source': { ...entry, sourceRef: undefined },
    'no lifecycle': { ...entry, lifecycle: undefined },
    quantity: { ...entry, quantity: 1 },
    status: { ...entry, status: 'available' },
    'asset DID': { ...entry, assetDid: 'did:example:aircraft' },
    'usage policy': { ...entry, usagePolicyRef: 'policy-1' }
  })) {
    assert.equal(parseInventorySnapshot(catalogue([item])), undefined, why);
  }
  assert.equal(parseInventorySnapshot(catalogue([entry], { catalogueOnly: false })), undefined, 'catalogueOnly other than true');
});

test('only a catalogue may hold archived entries, and stored image digests are SHA-256 hex', () => {
  assert.equal(parseInventorySnapshot(reported([{ id: 'item-1', name: 'Example item', category: 'Stores', archived: true }])), undefined);
  assert.equal(parseInventorySnapshot(catalogue([{ ...entry, archived: false }])), undefined, 'archived must be true when present');
  for (const digest of ['A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}g`, '../escape']) {
    assert.equal(parseInventorySnapshot(catalogue([{ ...entry, imageDigest: digest }])), undefined, digest);
  }
});

const originalCatalogue = catalogue([{ ...entry, externalNote: 'unrelated entry data' }], { publisher: 'external source' });
const replacedCatalogue = originalCatalogue.replace('Example aircraft', 'Changed aircraft');
const unchangedMetadata = { etag: 'same-etag', mtime: 123, size: Buffer.byteLength(originalCatalogue), isFile: true, isSymbolicLink: false };
const textFile = (value: string) => ({ ...unchangedMetadata, value, encoding: 'utf8' });

function catalogueFile(value: string, replaceDuringSave = false) {
  const writes: unknown[] = [];
  let resolutions = 0;
  const files = {
    resolve: async () => {
      if (++resolutions === 2 && replaceDuringSave) value = replacedCatalogue;
      return unchangedMetadata;
    },
    read: async () => textFile(value),
    write: async (_file: URI, output: string, options: unknown) => { writes.push({ output: JSON.parse(output), options }); }
  } as unknown as Parameters<typeof saveResourceCatalogue>[0];
  return { files, writes };
}

for (const when of ['after display', 'during save preparation'] as const) {
  test(`a catalogue edit refuses an equal-size replacement ${when} with the same ETag`, async () => {
    assert.equal(Buffer.byteLength(replacedCatalogue), unchangedMetadata.size);
    const { files, writes } = catalogueFile(when === 'after display' ? replacedCatalogue : originalCatalogue, when === 'during save preparation');
    await assert.rejects(saveResourceCatalogue(files, {} as URI, textFile(originalCatalogue), async () => true,
      () => true, { ...entry, name: 'Edited aircraft' }, entry), /catalogue changed/i);
    assert.deepEqual(writes, []);
  });
}

test('a catalogue edit preserves unrecognized fields and passes the original file guard', async () => {
  const { files, writes } = catalogueFile(originalCatalogue);
  const updated = { ...entry, name: 'Edited aircraft' };
  await saveResourceCatalogue(files, {} as URI, textFile(originalCatalogue), async () => true, () => true, updated, entry);
  assert.deepEqual(writes, [{
    output: JSON.parse(catalogue([{ ...updated, externalNote: 'unrelated entry data' }], { publisher: 'external source' })),
    options: { etag: unchangedMetadata.etag, mtime: unchangedMetadata.mtime }
  }]);
});
