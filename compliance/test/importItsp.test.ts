import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import { importSource } from '../src/import/itsp-10-033.ts';
import { run } from '../src/commands/import.ts';
import { validateOscal } from '../src/validate.ts';

const fixtures = new URL('./fixtures/import/itsp10033/', import.meta.url);
const pages = JSON.parse(readFileSync(new URL('pages.json', fixtures), 'utf8')) as Record<string, string>;

async function imported() {
  return importSource({ offlinePages: pages });
}

test('imports the English fixture family into a labelled OSCAL control', async () => {
  const result: any = await imported();
  const control = result.catalog.catalog.groups[0].controls[0];
  assert.equal(result.sourceId, 'itsp-10-033');
  assert.equal(result.file, 'catalogs/itsp-10-033/catalog.json');
  assert.equal(control.id, 'xa-01');
  assert.equal(control.title, 'Access management');
  assert.deepEqual(control.props, [{ name: 'label', value: 'XA-01' }]);
  assert.equal(control.class, 'control');
  assert.deepEqual(control.parts.find((part: any) => part.name === 'statement').prose.split('\n'), ['The organization assigns {{ insert: xa-01_param_1 }}.', 'The organization reviews accounts.']);
  assert.equal(control.params[0].id, 'xa-01_param_1');
  assert.equal(control.parts.find((part: any) => part.name === 'guidance').prose, 'Discuss access management.');
});

test('the imported catalogue is an OSCAL 1.2.1 document with source provenance', async () => {
  const result: any = await imported();
  assert.deepEqual(validateOscal(result.catalog, 'catalog', { ours: true }), { ok: true, errors: [] });
  assert.equal(result.catalog.catalog.metadata.version, '2026-11-20');
  assert.equal(result.catalog.catalog.metadata['oscal-version'], '1.2.1');
  assert.deepEqual(result.catalog.catalog.metadata.props, [{ name: 'source-id', ns: 'urn:near-ai-vscode:compliance', value: 'itsp-10-033' }]);
});

test('the CLI writes the licence-gated result under the requested root', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'itsp-import-'));
  const code = await run(['itsp-10-033', '--lang', 'en', '--offline', fileURLToPath(fixtures), '--out-root', root]);
  assert.equal(code, 0);
  const output = JSON.parse(readFileSync(path.join(root, 'catalogs/itsp-10-033/catalog.json'), 'utf8'));
  assert.equal(output.catalog.groups[0].controls[0].id, 'xa-01');
});

test('the same offline pages produce byte-identical output', async () => {
  const first: any = await imported();
  const second: any = await imported();
  assert.equal(JSON.stringify(first.catalog), JSON.stringify(second.catalog));
});
