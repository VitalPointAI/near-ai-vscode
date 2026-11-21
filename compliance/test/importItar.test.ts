import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { importSource, ITAR_REQUIREMENTS, sectionRequestUrl } from '../src/import/itar.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/import/itar/${name}`, import.meta.url), 'utf8');
const titleUrl = 'https://www.ecfr.gov/api/versioner/v1/titles.json';
const page22 = 'https://www.ecfr.gov/api/versioner/v1/full/2026-11-20/title-22.xml?part=120&section=120.54';
const page15 = 'https://www.ecfr.gov/api/versioner/v1/full/2026-11-19/title-15.xml?part=734&section=734.18';
const pages = () => Object.fromEntries([
  [titleUrl, fixture('titles.json')],
  ...ITAR_REQUIREMENTS.map(([, title, part, section]) => [sectionRequestUrl(title === 22 ? '2026-11-20' : '2026-11-19', title, part, section), fixture(title === 22 ? 'section-120.54.xml' : 'section-734.18.xml')])
]);

test('imports the selected ITAR and EAR paragraph using each title as-of date', async () => {
  const result = await importSource({ offlinePages: pages() });
  const controls = (result.catalog as { catalog: { groups: Array<{ controls: Array<{ id: string; parts: Array<{ prose: string }> }> }> } }).catalog.groups.flatMap((group) => group.controls);
  assert.match(controls.find((control) => control.id === 'itar-120.54-a5')!.parts[0].prose, /^\(a\)\(5\)/);
  assert.match(controls.find((control) => control.id === 'ear-734.18-a5')!.parts[0].prose, /^\(a\)\(5\)/);
});

test('records the eCFR title dates and unofficial editorial notice', async () => {
  const result = await importSource({ offlinePages: pages() });
  assert.match(JSON.stringify(result), /2026-11-20/);
  assert.match(JSON.stringify(result), /2026-11-19/);
  assert.match(JSON.stringify(result), /official CFR governs/i);
});

test('returns the eCFR dates in the ITAR import report contract', async () => {
  const result = await importSource({ offlinePages: pages() }) as unknown as { reportFile: string; report: { titleAsOf: Record<string, string> } };
  assert.equal(result.reportFile, 'import-reports/itar.json');
  assert.deepEqual(result.report.titleAsOf, { '15': '2026-11-19', '22': '2026-11-20' });
});

test('reports a missing listed requirement rather than silently dropping it', async () => {
  const missingEar: Record<string, string> = pages(); delete missingEar[page15];
  await assert.rejects(() => importSource({ offlinePages: missingEar }), /EAR-734\.18-a5|ear-734\.18-a5/);
});

test('uses a separate ITAR and EAR group', async () => {
  const result = await importSource({ offlinePages: pages() });
  assert.deepEqual((result.catalog as { catalog: { groups: Array<{ id: string }> } }).catalog.groups.map((group) => group.id), ['itar', 'ear']);
});

test('carries the catalogue output path', async () => assert.equal((await importSource({ offlinePages: pages() })).file, 'catalogs/itar/catalog.json'));
