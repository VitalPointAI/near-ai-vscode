import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { importSource, parseItsp171 } from '../src/import/itsp-10-171.ts';
import { validateOscal } from '../src/validate.ts';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(path.join(root, 'fixtures', 'import', 'itsp10171', name), 'utf8');
const pages = { requirements: fixture('requirements.html'), assessment: fixture('assessment.html') };

test('imports an ITSP.10.171 requirement into its section group with a statement and guidance', () => {
  const result = parseItsp171(pages);
  const control: any = result.catalog.catalog.groups[0].controls[0];
  assert.equal(control.id, 'itsp171-03.01.01');
  assert.equal(control.props[0].value, '03.01.01');
  assert.equal(control.parts.find((part: any) => part.name === 'statement').prose, 'The contractor manages accounts and access approvals.');
  assert.match(control.parts.find((part: any) => part.name === 'guidance').prose, /least privilege/);
});

test('attaches assessment determinations as assessment-objective parts', () => {
  const control: any = parseItsp171(pages).catalog.catalog.groups[0].controls[0];
  assert.equal(control.parts.find((part: any) => part.name === 'assessment-objective').prose, 'Determine whether account reviews occur at the required interval.');
});

test('reports a determination whose requirement is absent rather than attaching it', () => {
  const result = parseItsp171(pages);
  assert.deepEqual(result.unmatchedAssessmentIds, ['03.99.99']);
  assert.equal(JSON.stringify(result.catalog).includes('unmatched requirement'), false);
});

test('produces a valid ITSP.10.171 catalogue through the importer entry point', async () => {
  const result = await importSource({ offlinePages: pages });
  assert.equal(result.sourceId, 'itsp-10-171');
  assert.equal(result.file, 'catalogs/itsp-10-171/catalog.json');
  assert.deepEqual(validateOscal(result.catalog, 'catalog', { ours: true }), { ok: true, errors: [] });
});

test('the contractor overlay imports the catalogue with include-all and validates', () => {
  const profile = JSON.parse(readFileSync(path.join(root, '..', 'profiles', 'itsp-10-171-overlay.json'), 'utf8'));
  assert.deepEqual(profile.profile.imports, [{ href: '../catalogs/itsp-10-171/catalog.json', 'include-all': {} }]);
  assert.deepEqual(validateOscal(profile, 'profile', { ours: true }), { ok: true, errors: [] });
});
