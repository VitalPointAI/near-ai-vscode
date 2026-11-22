import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run as runImport } from '../src/commands/import.ts';
import { importSource, ITAR_REQUIREMENTS, sectionRequestUrl } from '../src/import/itar.ts';
import { validateOscal } from '../src/validate.ts';

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

test('the itar command alias writes its catalogue and report', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'near-ai-itar-command-'));
  try {
    const offline = join(scratch, 'offline');
    const output = join(scratch, 'output');
    mkdirSync(offline);
    writeFileSync(join(offline, 'pages.json'), JSON.stringify(pages()));
    assert.equal(await runImport(['itar', '--offline', offline, '--out-root', output]), 0);
    assert.equal(JSON.parse(readFileSync(join(output, 'catalogs/itar/catalog.json'), 'utf8')).catalog.metadata.title, 'ITAR and EAR requirements');
    assert.deepEqual(JSON.parse(readFileSync(join(output, 'import-reports/itar.json'), 'utf8')).titleAsOf, { '15': '2026-11-19', '22': '2026-11-20' });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('reports a missing listed requirement rather than silently dropping it', async () => {
  const missingEar: Record<string, string> = pages(); delete missingEar[page15];
  await assert.rejects(() => importSource({ offlinePages: missingEar }), /EAR-734\.18-a5|ear-734\.18-a5/);
});

test('uses a separate ITAR and EAR group', async () => {
  const result = await importSource({ offlinePages: pages() });
  assert.deepEqual((result.catalog as { catalog: { groups: Array<{ id: string }> } }).catalog.groups.map((group) => group.id), ['itar', 'ear']);
});

test('emits OSCAL catalogue groups, controls and statement parts', async () => {
  const result = await importSource({ offlinePages: pages() });
  assert.deepEqual(validateOscal(result.catalog, 'catalog', { ours: true }), { ok: true, errors: [] });
  const controls = (result.catalog as { catalog: { groups: Array<{ controls: Array<{ id: string; parts: Array<{ id: string; name: string }> }> }> } }).catalog.groups.flatMap((group) => group.controls);
  assert.deepEqual(controls.flatMap((control) => control.parts.map(({ id, name }) => ({ id, name }))), controls.map(({ id }) => ({ id: `${id}_smt`, name: 'statement' })));
});

test('carries the catalogue output path', async () => assert.equal((await importSource({ offlinePages: pages() })).file, 'catalogs/itar/catalog.json'));

test('fetches live eCFR pages through the injected guarded fetcher once per URL', async () => {
  const supplied = pages();
  const fetched: string[] = [];
  const result = await importSource({
    fetcher: {
      get: async (url) => {
        fetched.push(url);
        const body = supplied[url];
        if (!body) throw new Error(`unexpected URL ${url}`);
        return { url, status: 200, body: Buffer.from(body) };
      }
    }
  });
  assert.equal((result.catalog as { catalog: { groups: unknown[] } }).catalog.groups.length, 2);
  assert.equal(fetched.length, new Set(fetched).size, 'each live URL is fetched once');
  assert.deepEqual(new Set(fetched), new Set(Object.keys(supplied)));
});

test('parses the current eCFR DIV section element by its semantic number and paragraph marker', async () => {
  const current12054 = '<DIV8 N="120.54" TYPE="SECTION"><HEAD>§ 120.54 Exemptions.</HEAD><P>(a) Current heading.</P><P>(5) <I>Current</I> eCFR paragraph only.</P></DIV8>';
  const supplied = { ...pages(), [page22]: current12054 };
  const result = await importSource({ offlinePages: supplied });
  const controls = (result.catalog as { catalog: { groups: Array<{ controls: Array<{ id: string; parts: Array<{ prose: string }> }> }> } }).catalog.groups.flatMap((group) => group.controls);
  assert.match(controls.find((control) => control.id === 'itar-120.54-a5')?.parts[0].prose ?? '', /^\(5\)CurrenteCFR paragraph only\.$/);
});

test('retains the current unnumbered section 120.55 requirement', async () => {
  const page12055 = sectionRequestUrl('2026-11-20', 22, '120', '120.55');
  const supplied = { ...pages(), [page12055]: '<DIV8 N="120.55" TYPE="SECTION"><P><I>Access information</I> current requirement.</P></DIV8>' };
  const result = await importSource({ offlinePages: supplied });
  const controls = (result.catalog as { catalog: { groups: Array<{ controls: Array<{ id: string; parts: Array<{ prose: string }> }> }> } }).catalog.groups.flatMap((group) => group.controls);
  assert.match(controls.find((control) => control.id === 'itar-120.55')?.parts[0].prose ?? '', /Access informationcurrent requirement\./);
});
