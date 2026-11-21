import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { importSource } from '../src/import/itsp-10-033-01.ts';
import { validateOscal } from '../src/validate.ts';

const en = readFileSync(new URL('./fixtures/import/itsp1003301/profile-en.html', import.meta.url), 'utf8');
const result = () => importSource({ offlinePages: { en } });

test('includes Selected rows in the Medium profile', async () => {
  const profile = (await result()).catalog.profile;
  assert.deepEqual(profile.imports[0]['include-controls'][0]['with-ids'], ['xa-01', 'xa-02']);
});

test('marks organization-wide rows as the organization responsibility suggestion', async () => {
  const profile = (await result()).catalog.profile;
  assert.deepEqual(profile.modify.alters[0], { 'control-id': 'xa-02', adds: [{ props: [{ name: 'profile-suggestion', ns: 'urn:near-ai-vscode:compliance', value: 'deployed-organization-wide' }] }] });
});

test('records every source row and value count in the import report', async () => {
  const report = (await result()).report;
  assert.equal(report.rows.length, 4);
  assert.deepEqual(report.counts, { Selected: 1, 'Not selected': 1, 'Deployed organization-wide. Not associated with baseline.': 1, NA: 1 });
});

test('returns an OSCAL 1.2.1 profile importing the ITSP catalogue', async () => {
  const profile = (await result()).catalog;
  assert.equal(profile.profile.metadata['oscal-version'], '1.2.1');
  assert.equal(profile.profile.imports[0].href, '../catalogs/itsp-10-033/catalog.json');
  assert.deepEqual(validateOscal(profile, 'profile', { ours: true }), { ok: true, errors: [] });
});
