// The component catalogue (scripts/build-component-catalogue.mjs) and the SSP inventory (compliance/src/oscalSsp.ts) are generated from one
// register, compliance/resources.json. These tests keep the published pages and the OSCAL inventory in step with it (CM-8 evidence).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CATALOGUE_DIR, checkCatalogue, main, md, renderCatalogue } from '../build-component-catalogue.mjs';
import { loadInventory, pinText } from '../../compliance/src/inventory.ts';
import { buildSsp } from '../../compliance/src/oscalSsp.ts';
import { NS } from '../../compliance/src/model.ts';
import { lintPage } from '../../compliance/src/wordLint.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const quiet = (fn) => {
  const out = process.stdout.write; const err = process.stderr.write; const said = [];
  process.stdout.write = () => true; process.stderr.write = (text) => { said.push(text); return true; };
  try { return { code: fn(), said: said.join('') }; } finally { process.stdout.write = out; process.stderr.write = err; }
};

test('the component catalogue pages are what the register renders, byte for byte', () => {
  assert.deepEqual(checkCatalogue(root), []);
});

test('the catalogue pages make no compliance claim and keep every register entry', () => {
  const pages = renderCatalogue(root);
  for (const [file, text] of pages) assert.deepEqual(lintPage(text, file), [], file);
  const all = [...pages.values()].join('\n');
  for (const entry of loadInventory(root).entries) assert.ok(all.includes(`## ${md(entry.id)}\n`), entry.id);
});

test("every level's SSP inventory lists each register entry of its components, linked to that component", () => {
  const { entries } = loadInventory(root);
  const { levels } = JSON.parse(readFileSync(path.join(root, 'compliance/levels.json'), 'utf8'));
  const prop = (item, name) => item.props.find((candidate) => candidate.name === name && candidate.ns === NS)?.value;
  for (const level of levels) {
    const rows = [{ level: level.id, control: 'cm-08', state: 'partly-met', reasonText: 'r', components: [] }];
    const system = buildSsp({ level, rows, components: [], inventory: entries })['system-security-plan']['system-implementation'];
    const componentIds = new Map(system.components.map((component) => [component.uuid, component.props?.find((item) => item.name === 'component-id')?.value]));
    const expected = entries.filter((entry) => level.components.includes(entry.component));
    const items = system['inventory-items'] ?? [];
    assert.deepEqual(items.map((item) => prop(item, 'resource-id')), expected.map((entry) => entry.id), level.id);
    items.forEach((item, index) => {
      const entry = expected[index];
      assert.equal(componentIds.get(item['implemented-components'][0]['component-uuid']), entry.component, entry.id);
      assert.equal(prop(item, 'pinned-version'), pinText(entry), entry.id);
      assert.equal(prop(item, 'deployed'), entry.scope === 'runtime' ? 'yes' : 'no', entry.id);
      assert.ok(item.description.includes(entry.role), entry.id);
    });
  }
});

test('the check finds a page that no longer matches the register, a missing page and a stray file', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'component-catalogue-'));
  const write = (file, value) => { mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true }); writeFileSync(path.join(fixture, file), typeof value === 'string' ? value : JSON.stringify(value)); };
  const entry = { id: 'npm:typescript', kind: 'npm', where: ['package.json'], component: 'release-pipeline', scope: 'build', purpose: 'Compiles.', role: 'Nothing builds without it.', architectureArea: 'build-and-test', licence: 'Apache-2.0', controls: ['cm-08.01'], evidence: 'none', crypto: 'none', cveResponse: 'audit', airGap: 'ok', fit: 'pass', reviewer: 'r', reviewedAt: '2026-11-24' };
  write('package.json', { repository: { url: 'https://github.com/example/repo.git' }, devDependencies: { typescript: '5.9.3' } });
  write('compliance/architecture-areas.json', { areas: [{ id: 'build-and-test', title: 'Build and test only', summary: 'Not shipped.' }] });
  write('compliance/resources.json', { resources: [entry] });
  assert.equal(quiet(() => main([], fixture)).code, 0);
  assert.deepEqual(checkCatalogue(fixture), []);
  const page = readFileSync(path.join(fixture, CATALOGUE_DIR, 'build-and-test.md'), 'utf8');
  assert.match(page, /`5\.9\.3`/);
  assert.match(page, /CM-8\(1\)/);
  write('compliance/resources.json', { resources: [{ ...entry, role: 'A changed reason.' }] });
  assert.match(checkCatalogue(fixture).join('\n'), /build-and-test\.md differs from compliance\/resources\.json/);
  write(`${CATALOGUE_DIR}/notes.md`, 'hand-written');
  write('compliance/architecture-areas.json', { areas: [{ id: 'build-and-test', title: 'Build and test only', summary: 'Not shipped.' }, { id: 'workbench', title: 'Workbench', summary: 'Used.' }] });
  write('compliance/resources.json', { resources: [entry, { ...entry, id: 'npm:yjs', architectureArea: 'workbench' }] });
  const { code, said } = quiet(() => main(['--check'], fixture));
  assert.equal(code, 1);
  assert.match(said, /workbench\.md is missing/);
  assert.match(said, /notes\.md is not a generated catalogue page/);
});
