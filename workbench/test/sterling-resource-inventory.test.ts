import test from 'node:test';
import assert from 'node:assert/strict';
import type URI from '@theia/core/lib/common/uri.js';
import { saveResourceCatalogue } from '../extension/src/browser/sterling-resource-catalogue.ts';
import { parseInfrastructureReport, parseInventorySnapshot, readInventoryOnce } from '../extension/src/common/sterling-resource-inventory.ts';

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

const infrastructureRow = {
  id: 'compute-1', name: 'Example workstation', category: 'standalone-compute',
  owner: 'Example lab', capability: 'AMD accelerator', capacity: 0, capacityUnit: 'devices', asOf: generatedAt
};
const infrastructure = (resources: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ schemaVersion: 2, kind: 'infrastructure', sourceId: 'example-infrastructure',
    source: 'Example planning file', generatedAt, resources, ...extra });
test('infrastructure reports distinguish zero reported capacity from absent capacity and keep legacy formats separate', () => {
  const cluster = { id: 'cluster-1', name: 'Example cluster', category: 'cluster-compute', capability: 'NVIDIA accelerator' };
  const others = ['inference', 'storage', 'registry'].map(category => ({ id: category, name: category, category }));
  const raw = infrastructure([infrastructureRow, cluster, ...others]);
  assert.deepEqual(parseInfrastructureReport(raw)?.resources, [infrastructureRow, cluster, ...others]);
  assert.equal(parseInventorySnapshot(raw), undefined);
  assert.equal(parseInfrastructureReport(reported([{ id: 'compute-1', name: 'Example workstation', category: 'Stores' }])), undefined);
  assert.equal(parseInfrastructureReport(catalogue([entry])), undefined);
});

test('infrastructure reports reject partial capacity and text fields or identities outside the closed format', () => {
  for (const [why, resources, extra] of [
    ['missing unit', [{ ...infrastructureRow, capacityUnit: undefined }], {}],
    ['missing capacity', [{ ...infrastructureRow, capacity: undefined }], {}],
    ['negative capacity', [{ ...infrastructureRow, capacity: -1 }], {}],
    ['noninteger capacity', [{ ...infrastructureRow, capacity: 0.5 }], {}],
    ['unknown category', [{ ...infrastructureRow, category: 'queue' }], {}],
    ['legacy status', [{ ...infrastructureRow, status: 'available' }], {}],
    ['operational field', [{ ...infrastructureRow, endpoint: 'https://example.invalid/' }], {}],
    ['repeated IDs', [infrastructureRow, infrastructureRow], {}],
    ['invalid observation time', [{ ...infrastructureRow, asOf: '2026-11-31T00:00:00Z' }], {}],
    ['unknown envelope key', [infrastructureRow], { missionId: 'fictional' }]
  ] as const) {
    assert.equal(parseInfrastructureReport(infrastructure([...resources], extra)), undefined, why);
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

test('a fresh link check waits for a stale stock poll and rereads before any callback', async () => {
  const v1 = reported([{ id: infrastructureRow.id, name: infrastructureRow.name, category: 'Stores' }]);
  const v2 = infrastructure([infrastructureRow], { sourceId: 'example-stock' });
  const slot = {};
  const pendingPoll = deferred<string>();
  let visible = v1;
  let linkReads = 0;
  let links = 0;
  const poll = readInventoryOnce(slot, () => true, () => pendingPoll.promise, text => { visible = text; });
  const link = readInventoryOnce(slot, () => true, async () => { linkReads++; return v2; }, text => { visible = text; }, true)
    .then(() => { if (parseInventorySnapshot(visible)) links++; });
  assert.equal(linkReads, 0, 'fresh read must wait for the pending poll');
  pendingPoll.resolve(v1);
  await Promise.all([poll, link]);
  assert.equal(linkReads, 1);
  assert.equal(parseInfrastructureReport(visible)?.resources[0]?.id, infrastructureRow.id);
  assert.equal(links, 0);
});

test('a pending inventory read cannot present rows after the workspace loses trust', async () => {
  const pending = deferred<string>();
  const published: string[] = [];
  let trusted = true;
  const result = readInventoryOnce({}, () => trusted, () => pending.promise, text => { published.push(text); });
  trusted = false;
  pending.resolve(infrastructure([infrastructureRow]));
  await result;
  assert.deepEqual(published, []);
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
