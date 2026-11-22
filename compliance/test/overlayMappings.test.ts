import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CGP_REQUIREMENTS } from '../src/import/cgp.ts';
import { ITAR_REQUIREMENTS } from '../src/import/itar.ts';
import { NS, UNSETTLED_QUESTIONS } from '../src/model.ts';
import { validateOscal } from '../src/validate.ts';

type MapRow = { sources: Array<{ 'id-ref': string }>; targets: Array<{ 'id-ref': string }>; relationship: string; props: Array<{ name: string; value: string; ns?: string }> };
type Mapping = { 'mapping-collection': { mappings: Array<{ maps: MapRow[] }> } };
const mapping = (name: string): Mapping => JSON.parse(readFileSync(new URL(`../mappings/${name}`, import.meta.url), 'utf8')) as Mapping;
const rows = (doc: Mapping) => doc['mapping-collection'].mappings.flatMap((entry) => entry.maps);
const prop = (row: MapRow, name: string) => row.props.find((candidate) => candidate.ns === NS && candidate.name === name)?.value;

test('each CGP, ITAR and EAR requirement has an authored mapping row', () => {
  const cgp = rows(mapping('cgp-to-itsp10033.json'));
  const itar = rows(mapping('itar-to-sp80053.json'));
  assert.deepEqual(new Set(cgp.map((row) => row.sources[0]['id-ref'])), new Set(CGP_REQUIREMENTS.map((requirement) => requirement.id)));
  assert.deepEqual(new Set(itar.map((row) => row.sources[0]['id-ref'])), new Set(ITAR_REQUIREMENTS.map(([id]) => id)));
});

test('every mapping is ours and names a product-addressable relationship', () => {
  for (const row of [...rows(mapping('cgp-to-itsp10033.json')), ...rows(mapping('itar-to-sp80053.json'))]) {
    assert.equal(prop(row, 'ours'), 'true');
    assert.equal(row.relationship, 'intersects-with');
  }
});

test('only the four open export-control questions carry an allowed unsettled code', () => {
  const unsettled = [...rows(mapping('cgp-to-itsp10033.json')), ...rows(mapping('itar-to-sp80053.json'))]
    .flatMap((row) => { const code = prop(row, 'unsettled'); return code ? [[row.sources[0]['id-ref'], code]] : []; });
  assert.deepEqual(unsettled.sort(), [['cgp-37-1', 'third-party-encrypted-storage'], ['cgp-37-2', 'tee-question'], ['itar-120.54-a5', 'tee-question'], ['itar-120.54-a5', 'third-party-encrypted-storage']].sort());
  for (const [, code] of unsettled) assert.ok(Object.hasOwn(UNSETTLED_QUESTIONS, code));
});

test('only official person and endpoint decisions require an official signature', () => {
  const signed = [...rows(mapping('cgp-to-itsp10033.json')), ...rows(mapping('itar-to-sp80053.json'))]
    .filter((row) => prop(row, 'requires-official-signature') === 'true').map((row) => row.sources[0]['id-ref']).sort();
  assert.deepEqual(signed, ['cgp-13', 'cgp-37-2', 'itar-120.56-a', 'itar-126.18', 'itar-126.5']);
});

test('CGP targets use ITSP ids while ITAR and EAR targets use NIST ids', () => {
  for (const row of rows(mapping('cgp-to-itsp10033.json'))) assert.match(row.targets[0]['id-ref'], /^[a-z]{2}-\d{2}/);
  for (const row of rows(mapping('itar-to-sp80053.json'))) assert.match(row.targets[0]['id-ref'], /^[a-z]{2}-\d/);
});

test('both mapping collections and the ITAR include-all profile validate', () => {
  for (const name of ['cgp-to-itsp10033.json', 'itar-to-sp80053.json']) assert.equal(validateOscal(mapping(name), 'mapping-collection', { ours: true }).ok, true, name);
  const profile = JSON.parse(readFileSync(new URL('../profiles/overlay-itar.json', import.meta.url), 'utf8'));
  assert.equal(validateOscal(profile, 'profile', { ours: true }).ok, true);
  assert.deepEqual(profile.profile.imports, [{ href: '../catalogs/itar/catalog.json', 'include-all': {} }]);
});
