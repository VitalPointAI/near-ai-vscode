import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALLOWED_TEXT_LICENCES, checkCatalogTextLicence, mayStoreText } from '../src/import/lib/licence.ts';
import { SOURCE_REGISTRY } from '../src/import/lib/sourceRegistry.ts';
import { writeImportResult } from '../src/import/lib/write.ts';
import { run } from '../src/commands/licence-check.ts';

const ckanOk = JSON.parse(readFileSync(new URL('./fixtures/import/ckan-ok.json', import.meta.url), 'utf8'));
const ckanChanged = JSON.parse(readFileSync(new URL('./fixtures/import/ckan-changed.json', import.meta.url), 'utf8'));
const entry = (id: string) => { const found = SOURCE_REGISTRY.find((candidate) => candidate.id === id); assert.ok(found, `registry has ${id}`); return found; };

test('the explicit allow-list contains only reuse grants that permit stored text', () => {
  assert.deepEqual(ALLOWED_TEXT_LICENCES, ['ca-ogl-lgo', 'us-public-domain', 'us-government-work', 'reproduction-of-federal-law-order']);
  assert.equal(mayStoreText(entry('itsp-10-033')), true);
  assert.equal(mayStoreText(entry('can-dgsi-104')), false);
  assert.equal(mayStoreText(entry('cpcsc-level-1')), false);
});

test('the registry carries the CKAN record and licence for every Cyber Centre publication', () => {
  assert.equal(entry('itsp-10-033').licenceEvidence.kind, 'ckan');
  assert.equal((entry('itsp-10-033').licenceEvidence as { recordId: string }).recordId, 'ddad8760-bf9b-47aa-890d-67da202aca6a');
  assert.equal(entry('baseline-controls-v1-2').licence, 'ca-ogl-lgo');
  assert.equal(entry('itsg-33').pages[0].url, 'https://cyber.gc.ca/en/guidance/overview-itsg-33');
  assert.ok(entry('itsg-33').pages.some((page) => page.url === 'https://www.cyber.gc.ca/en/guidance/annex-3a-security-control-catalogue-itsg-33'));
  assert.ok(entry('itsg-33').pages.some((page) => page.url === 'https://www.cyber.gc.ca/en/guidance/annex-4a-profile-3-secret-medium-integrity-medium-availability-itsg-33'));
});

test('licence-check accepts the recorded CKAN licence and writes an ok row for each record', async () => {
  const rows: string[] = [];
  const code = await run([], { fetchJson: async () => ckanOk, write: (text) => rows.push(text) });
  assert.equal(code, 0);
  assert.equal(rows.filter((row) => row.includes('"ok":true')).length, SOURCE_REGISTRY.filter((source) => source.licenceEvidence.kind === 'ckan').length);
});

test('licence-check refuses a changed CKAN licence and names its record', async () => {
  const rows: string[] = [];
  const code = await run([], { fetchJson: async (url) => url.includes('ddad8760') ? ckanChanged : ckanOk, write: (text) => rows.push(text) });
  assert.equal(code, 3);
  assert.match(rows.join(''), /ddad8760-bf9b-47aa-890d-67da202aca6a/);
});

test('a permitted source writes prose while ids-and-links-only sources can write only links', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'licence-gate-'));
  const allowed = writeImportResult(root, { sourceId: 'itsp-10-033', catalog: { catalog: { metadata: { title: 'x' }, props: [{ name: 'source-id', value: 'itsp-10-033' }], controls: [{ id: 'x', parts: [{ prose: 'invented test prose' }] }] } } }, SOURCE_REGISTRY);
  assert.equal(JSON.parse(readFileSync(allowed, 'utf8')).catalog.controls[0].parts[0].prose, 'invented test prose');
  assert.throws(() => writeImportResult(root, { sourceId: 'can-dgsi-104', catalog: { catalog: { props: [{ name: 'source-id', value: 'can-dgsi-104' }], controls: [{ id: 'x', parts: [{ prose: 'must be refused' }] }] } } }, SOURCE_REGISTRY), /can-dgsi-104/);
  const linkOnly = writeImportResult(root, { sourceId: 'cpcsc-level-1', catalog: { catalog: { props: [{ name: 'source-id', value: 'cpcsc-level-1' }], controls: [{ id: 'x', links: [{ href: 'https://example.invalid' }] }] } } }, SOURCE_REGISTRY);
  assert.equal(JSON.parse(readFileSync(linkOnly, 'utf8')).catalog.controls[0].links[0].href, 'https://example.invalid');
});

test('the licence gate finds a source-id in valid OSCAL catalog metadata props', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'licence-metadata-props-'));
  const file = writeImportResult(root, { sourceId: 'itsp-10-033', catalog: { catalog: { metadata: { props: [{ name: 'source-id', value: 'itsp-10-033' }] }, controls: [{ id: 'x', parts: [{ prose: 'permitted test prose' }] }] } } }, SOURCE_REGISTRY);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).catalog.controls[0].id, 'x');
});

test('the catalogue scan reports external prose with its file and control', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'licence-catalog-'));
  const file = path.join(root, 'catalog.json');
  writeFileSync(file, JSON.stringify({ catalog: { props: [{ name: 'source-id', value: 'can-dgsi-104' }], controls: [{ id: 'dg-01', parts: [{ prose: 'outside-licence prose' }] }] } }));
  assert.throws(() => checkCatalogTextLicence(root, SOURCE_REGISTRY), /catalog\.json.*dg-01/);
});

test('the licence gate refuses prose inside a grouped control', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'licence-grouped-control-'));
  assert.throws(
    () => writeImportResult(root, { sourceId: 'can-dgsi-104', catalog: { catalog: { metadata: { props: [{ name: 'source-id', value: 'can-dgsi-104' }] }, groups: [{ id: 'group', title: 'group', controls: [{ id: 'dg-01', parts: [{ prose: 'prose must not bypass the licence gate' }] }] }] } } }, SOURCE_REGISTRY),
    /can-dgsi-104/
  );
});
