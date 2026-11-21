// No source file under compliance/ carries a status (D-17, D-44), and none of compliance/ or docs/security/ can reach the extension (D-48).
// The walk is the same function 44-14's `validate` command calls; it needs no change when later plans add source files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findStatusFields, oscalOriginForFile, validateOscal } from '../src/validate.ts';
import { SOURCE_DIRS, SOURCE_FILES } from '../src/model.ts';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..');

function plant(files: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'compliance-nostatus-'));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

const control = (props: unknown[]) => ({ catalog: { uuid: 'u', metadata: { title: 't' }, groups: [{ id: 'ac', controls: [{ id: 'ac-1', props }] }] } });

test('the repository compliance folder has no status, state or met key or prop in any source file', () => {
  assert.deepEqual(findStatusFields(PACKAGE_ROOT, { skipFile: (file) => oscalOriginForFile(PACKAGE_ROOT, file) === 'external' }), []);
});

test('a planted status key at any depth fails with the file and JSON path named', () => {
  const root = plant({ 'components/extension.json': { 'component-definition': { components: [{ 'control-implementations': [{ notes: { status: 'met' } }] }] } } });
  assert.deepEqual(findStatusFields(root), [
    { file: 'components/extension.json', path: '$["component-definition"].components[0]["control-implementations"][0].notes.status', name: 'status', kind: 'key' }
  ]);
});

test('a state key inside an array element and a met key fail, wherever in the source folders and files they sit', () => {
  const root = plant({
    'evidence-rules/nested/rules.json': { rules: [{ id: 'r', state: 'met' }] },
    'tailoring/protected-b.json': { level: 'protected-b', notApplicable: [{ control: 'pe-03', met: true }] },
    'gaps.json': { gaps: [{ id: 'g1', State: 'open' }] }
  });
  const found = findStatusFields(root);
  assert.deepEqual(found.map((finding) => `${finding.file} ${finding.path}`).sort(), [
    'evidence-rules/nested/rules.json $.rules[0].state',
    'gaps.json $.gaps[0].State',
    'tailoring/protected-b.json $.notApplicable[0].met'
  ]);
});

test('a prop named met, state or status fails with the prop named', () => {
  const root = plant({
    'components/relay.json': { 'component-definition': { components: [{ props: [{ name: 'met', value: 'true' }, { name: 'responsibility', ns: 'x', value: 'product' }] }] } },
    'profiles/p.json': { profile: { modify: { alters: [{ adds: [{ props: [{ name: 'state', value: 'met' }] }] }] } } }
  });
  assert.deepEqual(findStatusFields(root).sort((a, b) => a.file.localeCompare(b.file)), [
    { file: 'components/relay.json', path: '$["component-definition"].components[0].props[0]', name: 'met', kind: 'prop' },
    { file: 'profiles/p.json', path: '$.profile.modify.alters[0].adds[0].props[0]', name: 'state', kind: 'prop' }
  ]);
});

test('the publisher withdrawal marker on a control under catalogs passes; another value, another place or another folder fails', () => {
  const withdrawn = { name: 'status', value: 'withdrawn' };
  assert.deepEqual(findStatusFields(plant({ 'catalogs/nist/catalog.json': control([withdrawn]) })), []);
  const nested = { catalog: { uuid: 'u', controls: [{ id: 'ac-2', controls: [{ id: 'ac-2.1', props: [withdrawn] }] }] } };
  assert.deepEqual(findStatusFields(plant({ 'catalogs/nist/nested.json': nested })), [], 'an enhancement is a control too');
  const cases: [string, Record<string, unknown>][] = [
    ['another value', { 'catalogs/nist/catalog.json': control([{ name: 'status', value: 'met' }]) }],
    ['under components', { 'components/c.json': control([withdrawn]) }],
    ['on a part, not a control', { 'catalogs/c.json': { catalog: { controls: [{ id: 'ac-1', parts: [{ id: 'ac-1_smt', props: [withdrawn] }] }] } } }],
    ['on catalog metadata', { 'catalogs/c.json': { catalog: { metadata: { props: [withdrawn] } } } }],
    ['under our own namespace', { 'catalogs/c.json': control([{ ...withdrawn, ns: 'urn:near-ai-vscode:compliance' }]) }]
  ];
  for (const [label, files] of cases) assert.equal(findStatusFields(plant(files)).length, 1, label);
});

test('the exact pinned external NIST path may retain publisher lifecycle fields without exempting generated files', () => {
  const root = plant({
    'catalogs/nist-800-53-r5/catalog-min.json': { catalog: { metadata: { state: 'publisher lifecycle' } } },
    'catalogs/ours/catalog.json': { catalog: { metadata: { state: 'not allowed' } } }
  });
  const fields = findStatusFields(root, { skipFile: (file) => oscalOriginForFile(root, file) === 'external' });
  assert.deepEqual(fields.map((field) => field.file), ['catalogs/ours/catalog.json']);
});

test('only OSCAL mapping provenance may carry its required lifecycle status, whose value the OSCAL schema validates', () => {
  const mapping = { 'mapping-collection': { provenance: { status: 'draft' } } };
  assert.deepEqual(findStatusFields(plant({ 'mappings/ours.json': mapping })), []);
  const misplaced = { 'mapping-collection': { status: 'draft', provenance: { status: 'draft' } } };
  assert.equal(findStatusFields(plant({ 'mappings/ours.json': misplaced })).length, 1);
  const invalid = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'mappings', 'cgp-to-itsp10033.json'), 'utf8'));
  invalid['mapping-collection'].provenance.status = 'assessment-met';
  assert.equal(validateOscal(invalid, 'mapping-collection', { ours: true }).ok, false);
});

test('missing source folders and files are skipped by name, and files outside the source folders are not sources', () => {
  assert.deepEqual(findStatusFields(plant({ 'unrelated.txt': 'x' })), []);
  const root = plant({
    'test/fixtures/x.json': { status: 'passed' },
    'out/dashboard.json': { rows: [{ state: 'met' }] },
    'schemas/x.schema.json': { properties: { status: {} } },
    'catalogs/NOTICE': 'status: not json',
    'other.json': { state: 'x' }
  });
  assert.deepEqual(findStatusFields(root), []);
  assert.ok(SOURCE_DIRS.length === 10 && SOURCE_FILES.length === 3);
});

test('the newline-delimited licence-check audit record is excluded from source JSON validation', () => {
  assert.deepEqual(findStatusFields(plant({ 'import-reports/licence-check.json': '{"id":"source","ok":true}\n{"id":"source-2","ok":true}\n' })), []);
});

test('a source file that is not valid JSON is an error naming the file, never a silent pass', () => {
  assert.throws(() => findStatusFields(plant({ 'poam/g02.json': '{broken' })), /g02\.json/);
});

/** The forbidden patterns of scripts/verify-release-content.mjs, read from its text so the test checks the real list. */
function forbiddenPatterns(): RegExp[] {
  const text = readFileSync(path.join(REPO_ROOT, 'scripts', 'verify-release-content.mjs'), 'utf8');
  const block = /const forbiddenPatterns = \[\n([\s\S]*?)\n\];/.exec(text);
  assert.ok(block, 'verify-release-content.mjs has a forbiddenPatterns list');
  return block[1].split('\n').map((line) => line.trim().replace(/,$/, '')).filter((line) => line.startsWith('/') && !line.startsWith('//')).map((literal) => {
    const match = /^\/(.+)\/([a-z]*)$/.exec(literal);
    assert.ok(match, `pattern literal ${literal}`);
    return new RegExp(match[1], match[2]);
  });
}

test('verify-release-content refuses a VSIX entry under extension/compliance/ or extension/docs/security/, and .vscodeignore excludes both', () => {
  const patterns = forbiddenPatterns();
  const refused = (entry: string): boolean => patterns.some((pattern) => pattern.test(entry));
  for (const entry of ['extension/compliance/catalogs/nist/catalog.json', 'extension/compliance', 'extension/docs/security/threat-model.md', 'extension/docs/security']) {
    assert.ok(refused(entry), `${entry} is refused`);
  }
  for (const entry of ['extension/docs/marketplace/near-ai-chat.png', 'extension/media/compliance-icon.svg', 'extension/docs/securityx.md']) {
    assert.ok(!refused(entry), `${entry} is not refused`);
  }
  const ignore = readFileSync(path.join(REPO_ROOT, '.vscodeignore'), 'utf8').split('\n').map((line) => line.trim());
  assert.ok(ignore.includes('compliance/**'));
  assert.ok(ignore.includes('docs/security/**'));
  const gitignore = readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8').split('\n').map((line) => line.trim());
  assert.ok(gitignore.includes('compliance/out/'), 'generated bundle, dashboard and package are never committed (D-15)');
});
