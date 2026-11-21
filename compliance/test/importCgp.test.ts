import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run as runImport } from '../src/commands/import.ts';
import { importSource } from '../src/import/cgp.ts';
import { validateOscal } from '../src/validate.ts';

const pageUrl = 'https://laws-lois.justice.gc.ca/eng/acts/D-1/section-37.html';
const fixture = readFileSync(new URL('./fixtures/import/cgp/dpa-part-2.html', import.meta.url), 'utf8');
const regulationsUrl = 'https://laws-lois.justice.gc.ca/eng/regulations/SOR-2001-32/FullText.html';
const regulations = readFileSync(new URL('./fixtures/import/cgp/cgr.html', import.meta.url), 'utf8');
const cgpPages = () => ({ [pageUrl]: fixture, [regulationsUrl]: regulations });

test('imports CGP-37-2 from the Act subsection selected by number', async () => {
  const result = await importSource({ offlinePages: cgpPages() });
  const controls = (result.catalog as { catalog: { groups: Array<{ controls: Array<{ id: string; title: string; parts: Array<{ prose: string }>; links: Array<{ href: string }> }> }> } }).catalog.groups.flatMap((group) => group.controls);
  const requirement = controls.find((control) => control.id === 'cgp-37-2');
  assert.ok(requirement, 'CGP-37-2 is a requirement, not a definition');
  assert.equal(requirement.title, 'CGP-37-2');
  assert.match(requirement.parts[0].prose, /designated official/i);
  assert.equal(requirement.links[0].href, pageUrl);
});

test('does not turn subsection 37(3) definitions into requirements', async () => {
  const result = await importSource({ offlinePages: cgpPages() });
  const serialized = JSON.stringify(result.catalog);
  assert.doesNotMatch(serialized, /cgp-37-3/);
});

test('stamps source provenance and an accurate-reproduction notice', async () => {
  const result = await importSource({ offlinePages: cgpPages() });
  const catalog = (result.catalog as unknown as { catalog: { metadata: { props: Array<{ name: string; value: string }>; 'last-modified': string } } }).catalog;
  assert.equal(catalog.metadata.props.find((prop) => prop.name === 'source-id')?.value, 'defence-production-act');
  assert.ok(catalog.metadata['last-modified']);
  assert.match(JSON.stringify(result), /Accurate reproduction, not the official version\./);
});

test('returns the excluded Act definition in the CGP import report contract', async () => {
  const result = await importSource({ offlinePages: cgpPages() }) as unknown as { reportFile: string; report: { excluded: Array<{ id: string; reason: string }>; sourceIds: string[] } };
  assert.equal(result.reportFile, 'import-reports/cgp.json');
  assert.deepEqual(result.report.excluded, [{ id: 'cgp-37-3', reason: 'definition' }]);
  assert.deepEqual(result.report.sourceIds, ['defence-production-act', 'controlled-goods-regulations']);
});

test('the cgp command alias writes its catalogue and report', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'near-ai-cgp-command-'));
  try {
    const offline = join(scratch, 'offline');
    const output = join(scratch, 'output');
    mkdirSync(offline);
    writeFileSync(join(offline, 'pages.json'), JSON.stringify(cgpPages()));
    assert.equal(await runImport(['cgp', '--offline', offline, '--out-root', output]), 0);
    assert.equal(JSON.parse(readFileSync(join(output, 'catalogs/cgp/catalog.json'), 'utf8')).catalog.metadata.title, 'Controlled Goods Program requirements');
    assert.deepEqual(JSON.parse(readFileSync(join(output, 'import-reports/cgp.json'), 'utf8')).sourceIds, ['defence-production-act', 'controlled-goods-regulations']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the Controlled goods profile imports every generated CGP requirement', () => {
  const profile = JSON.parse(readFileSync(new URL('../profiles/overlay-cgp.json', import.meta.url), 'utf8')) as { profile: { imports: Array<{ href: string; 'include-all': Record<string, never> }> } };
  assert.deepEqual(profile.profile.imports, [{ href: '../catalogs/cgp/catalog.json', 'include-all': {} }]);
});

test('imports every listed Regulation paragraph and errors if one is absent', async () => {
  const result = await importSource({ offlinePages: cgpPages() });
  const ids = (result.catalog as { catalog: { groups: Array<{ controls: Array<{ id: string }> }> } }).catalog.groups.flatMap((group) => group.controls.map((control) => control.id));
  assert.ok(ids.includes('cgp-10-h'));
  assert.ok(ids.includes('cgp-23'));
});

test('keeps Act and Regulation requirements in distinct catalogue groups', async () => {
  const result = await importSource({ offlinePages: cgpPages() });
  const groups = (result.catalog as { catalog: { groups: Array<{ id: string; controls: Array<{ id: string }> }> } }).catalog.groups;
  assert.deepEqual(groups.map((group) => group.id), ['dpa', 'cgr']);
  assert.ok(groups.find((group) => group.id === 'cgr')!.controls.some((control) => control.id === 'cgp-10-h'));
});

test('emits OSCAL catalogue groups, controls and statement parts', async () => {
  const result = await importSource({ offlinePages: cgpPages() });
  assert.deepEqual(validateOscal(result.catalog, 'catalog', { ours: true }), { ok: true, errors: [] });
  const part = (result.catalog as any).catalog.groups[0].controls[0].parts[0];
  assert.deepEqual(part.name, 'statement');
});

test('names the absent Regulation paragraph when an expected requirement is missing', async () => {
  const missing = regulations.replace('<p>(j) Provide a list on request.</p>', '');
  await assert.rejects(() => importSource({ offlinePages: { [pageUrl]: fixture, [regulationsUrl]: missing } }), /cgp-10-j/);
});

test('uses Justice Laws semantic labels for current Section 37 subsections', async () => {
  const currentAct = `<!doctype html><main><ul class="Section ProvisionList">
    <li><p class="Subsection"><strong><a class="sectionLabel" id="s-37"><span class="sectionLabel">37</span></a></strong> <span class="lawlabel">(1)</span> Current subsection one.</p></li>
    <li><p class="Subsection"><span class="lawlabel">(2)</span> Current subsection two.</p></li>
    <li><p class="Subsection"><span class="lawlabel">(3)</span> Definition only.</p></li>
  </ul></main>`;
  const result = await importSource({ offlinePages: { [pageUrl]: currentAct, [regulationsUrl]: regulations } });
  const controls = (result.catalog as { catalog: { groups: Array<{ controls: Array<{ id: string; parts: Array<{ prose: string }> }> }> } }).catalog.groups.flatMap((group) => group.controls);
  assert.match(controls.find((control) => control.id === 'cgp-37-1')?.parts[0].prose ?? '', /Current subsection one\./);
  assert.match(controls.find((control) => control.id === 'cgp-37-2')?.parts[0].prose ?? '', /Current subsection two\./);

  const missingSecond = currentAct.replace('<li><p class="Subsection"><span class="lawlabel">(2)</span> Current subsection two.</p></li>', '');
  await assert.rejects(() => importSource({ offlinePages: { [pageUrl]: missingSecond, [regulationsUrl]: regulations } }), /cgp-37-2/);
});
