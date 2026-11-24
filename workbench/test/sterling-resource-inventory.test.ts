import test from 'node:test';
import assert from 'node:assert/strict';
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
