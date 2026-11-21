import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { importSource } from '../src/import/itsp-10-033-01.ts';
import { validateOscal } from '../src/validate.ts';

const en = readFileSync(new URL('./fixtures/import/itsp1003301/profile-en.html', import.meta.url), 'utf8');
const fr = readFileSync(new URL('./fixtures/import/itsp1003301/profile-fr.html', import.meta.url), 'utf8');
const result = () => importSource({ offlinePages: { en, fr } });

test('includes Selected rows in the Medium profile', async () => {
  const profile = (await result()).catalog.profile;
  assert.deepEqual(profile.imports[0]['include-controls'][0]['with-ids'], ['xa-01', 'xa-02']);
});

test('marks organization-wide rows as the organization responsibility suggestion', async () => {
  const profile = (await result()).catalog.profile;
  assert.equal(profile.modify.alters[0]['control-id'], 'xa-02');
  assert.deepEqual(profile.modify.alters[0].adds[0].props[0], { name: 'profile-suggestion', ns: 'urn:near-ai-vscode:compliance', value: 'deployed-organization-wide' });
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

test('records the French page rows that differ from the English selections', async () => {
  assert.deepEqual((await result()).report.differences, [
    { control: 'xa-01', en: 'Selected', fr: 'Not selected' },
    { control: 'xa-02', en: 'Deployed organization-wide. Not associated with baseline.', fr: 'Not selected' }
  ]);
});

test('maps French selection labels before recording a disagreement', async () => {
  const differences = (await result()).report.differences;
  assert.equal(differences[0]?.fr, 'Not selected');
  assert.equal(differences.every((difference) => !difference.fr.includes('sélectionné')), true);
});

test('puts non-empty source placeholders and notes into OSCAL alteration props', async () => {
  const profile = (await result()).catalog.profile;
  assert.deepEqual(profile.modify.alters.find((alter: any) => alter['control-id'] === 'xa-02').adds[0].props.map((prop: any) => prop.name), ['profile-suggestion', 'suggested-placeholder', 'profile-note']);
});

test('refuses an unknown selection value and names its control row', async () => {
  await assert.rejects(importSource({ offlinePages: { en: en.replace('<td>Selected</td><td></td><td></td>', '<td>Maybe</td><td></td><td></td>') } }), /xa-01.*unknown selection/i);
});

test('keeps all five official English selection values as report-only or included values', async () => {
  const every = en.replace('</tbody>', '<tr><td>XA</td><td>04</td><td>x</td><td>x</td><td>x</td><td>Not allocated to baseline.</td><td></td><td></td></tr></tbody>');
  const report = await importSource({ offlinePages: { en: every } });
  assert.equal(report.report.counts['Not allocated to baseline.'], 1);
  assert.equal(report.catalog.profile.imports[0]['include-controls'][0]['with-ids'].includes('xa-04'), false);
});
