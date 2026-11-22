import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { importSource } from '../src/import/itsp-10-033-01.ts';
import type { Fetcher } from '../src/import/lib/fetch.ts';
import { validateOscal } from '../src/validate.ts';

const en = readFileSync(new URL('./fixtures/import/itsp1003301/profile-en.html', import.meta.url), 'utf8');
const fr = readFileSync(new URL('./fixtures/import/itsp1003301/profile-fr.html', import.meta.url), 'utf8');
const result = () => importSource({ offlinePages: { en, fr } });
const anotherTable = (page: string, number: number, rows: string) => page
  .match(/<table>[\s\S]*<\/table>/)![0]
  .replace('4.1', `4.${number}`)
  .replace(/<tbody>[\s\S]*<\/tbody>/, `<tbody>${rows}</tbody>`);
const row = (family: string, id: string, selection: string, description = 'Fixture description') =>
  `<tr><td>${family}</td><td>${id}</td><td>x</td><td>${description}</td><td>x</td><td>${selection}</td><td></td><td></td></tr>`;

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

test('live mode uses the injected guarded fetcher and declares profile/report destinations', async () => {
  const calls: string[] = [];
  const fetcher: Fetcher = { get: async (url) => { calls.push(url); return { url, body: Buffer.from(calls.length === 1 ? en : fr), status: 200 }; } };
  const live = await importSource({ fetcher, lang: 'both' });
  assert.equal(live.file, 'profiles/itsp-10-033-01-medium.json');
  assert.equal(live.reportFile, 'import-reports/itsp-10-033-01.json');
  assert.equal(calls.length, 2);
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

test('compares the public French headings and selection labels without changing the English profile', async () => {
  const publishedFrench = fr
    .replace('Valeurs de remplacement suggérées', 'Valeurs suggérées de paramètres substituables')
    .replace('Notes propres au profil', 'Remarques concernant le profil')
    .replace('>ND<', '>s.o.<')
    .replace('</tbody>', '<tr><td>XA</td><td>04</td><td>x</td><td>x</td><td>x</td><td>Non attribué à la base de référence.</td><td></td><td></td></tr></tbody>');
  const english = en.replace('</tbody>', '<tr><td>XA</td><td>04</td><td>x</td><td>x</td><td>x</td><td>Not allocated to baseline.</td><td></td><td></td></tr></tbody>');
  const compared = await importSource({ offlinePages: { en: english, fr: publishedFrench } });
  assert.deepEqual(compared.report.frenchFailures, []);
  assert.deepEqual(compared.report.differences, (await result()).report.differences);
  assert.deepEqual(compared.catalog, (await importSource({ offlinePages: { en: english } })).catalog);
});

test('imports later tables and compares the same controls in French', async () => {
  const english = en.replace('</main>', anotherTable(en, 2, row('XB', '02', 'Selected')) + '</main>');
  const french = fr.replace('</main>', anotherTable(fr, 2, row('XB', '02', 'Non sélectionné')) + '</main>');
  const { catalog, report } = await importSource({ offlinePages: { en: english, fr: french } });
  assert.deepEqual(catalog.profile.imports[0]['include-controls'][0]['with-ids'], ['xa-01', 'xa-02', 'xb-02']);
  assert.deepEqual(report.differences.at(-1), { control: 'xb-02', en: 'Selected', fr: 'Not selected' });
});

test('records the English PDF correction without treating the duplicate as a second selection', async () => {
  const intervening = [2, 3, 4].map((number) => anotherTable(en, number, row('XB', `0${number}`, 'NA'))).join('');
  const rows = row('CM', '11(02)', 'Selected') + row('CM', '11(02)', 'Not selected', 'User-installed software: Automated enforcement and monitoring');
  const english = en.replace('</main>', intervening + anotherTable(en, 5, rows) + '</main>');
  const { catalog, report } = await importSource({ offlinePages: { en: english } });
  assert.deepEqual(report.rows.slice(-2).map(({ control, value }) => [control, value]), [['cm-11.02', 'Selected'], ['cm-11.03', 'Not selected']]);
  assert.deepEqual(catalog.profile.imports[0]['include-controls'][0]['with-ids'], ['xa-01', 'xa-02', 'cm-11.02']);
  assert.deepEqual(report.sourceCorrections, [{ table: 5, publishedControl: 'cm-11.02', control: 'cm-11.03', verifiedAgainst: 'https://www.cyber.gc.ca/sites/default/files/itsp.10.033-01-e.pdf' }]);
  await assert.rejects(importSource({ offlinePages: { en: english.replace('User-installed software: Automated enforcement and monitoring', 'Unrecognized duplicate') } }), /duplicates control cm-11.02/);
});

test('reports an incomplete French comparison while retaining the authoritative English output', async () => {
  const english = en.replace('</main>', anotherTable(en, 2, row('XB', '02', 'Selected')) + '</main>');
  const { catalog, report } = await importSource({ offlinePages: { en: english, fr } });
  assert.deepEqual(catalog.profile.imports[0]['include-controls'][0]['with-ids'], ['xa-01', 'xa-02', 'xb-02']);
  assert.match(report.frenchFailures[0]?.reason ?? '', /French profile lacks xb-02/);
  assert.deepEqual(report.differences, []);
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
