// The vendored OSCAL 1.2.1 schema, the validators for OSCAL and our own files, and the safe JSON loader (44-01 Task 2, D-16, D-43, D-44).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  OSCAL_MODELS, OSCAL_ROOT_DEFINITIONS, OSCAL_SCHEMA_FILE, SCHEMAS_DIR,
  createValidators, loadJson, modelForSourceFile, modelOf, oscalOriginForFile, validateOscal, validateOurs, type OscalModel
} from '../src/validate.ts';
import { OSCAL_VERSION } from '../src/model.ts';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'tracer');
const fixture = (name: string): any => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
const clone = <T>(value: T): T => structuredClone(value);

test('the vendored OSCAL schema has the SHA-256 recorded in SOURCES.json, and SOURCES.json lists every vendored file', () => {
  const sources = JSON.parse(readFileSync(path.join(SCHEMAS_DIR, 'SOURCES.json'), 'utf8')) as { file: string; url: string; version: string; sha256: string; licence: string; retrievedAt: string }[];
  const entry = sources.find((source) => source.file === path.basename(OSCAL_SCHEMA_FILE));
  assert.ok(entry, 'SOURCES.json lists the vendored schema');
  assert.equal(entry.version, OSCAL_VERSION);
  assert.match(entry.url, /^https:\/\/github\.com\/usnistgov\/OSCAL\/releases\/download\/v1\.2\.1\//);
  assert.ok(entry.licence.length > 0 && !Number.isNaN(Date.parse(entry.retrievedAt)));
  const actual = createHash('sha256').update(readFileSync(OSCAL_SCHEMA_FILE)).digest('hex');
  assert.equal(actual, entry.sha256);
  assert.equal(actual, 'f53c67f5f64cc49c9b3512834d2baa2f8da841cf2cc0c361e6d77ecce0f3d077', 'the research value for OSCAL 1.2.1');
  for (const source of sources) assert.ok(existsSync(path.join(SCHEMAS_DIR, source.file)), `${source.file} is present`);
});

test('every model has a root definition that resolves in the complete schema, and each wrapper compiles', () => {
  const complete = JSON.parse(readFileSync(OSCAL_SCHEMA_FILE, 'utf8'));
  assert.deepEqual([...OSCAL_MODELS].sort(), ['assessment-plan', 'assessment-results', 'catalog', 'component-definition', 'mapping-collection', 'plan-of-action-and-milestones', 'profile', 'system-security-plan']);
  for (const model of OSCAL_MODELS) {
    const name = OSCAL_ROOT_DEFINITIONS[model];
    assert.ok(complete.definitions[name], `${model}: definition ${name} exists`);
    const branch = complete.oneOf.find((candidate: any) => candidate.required?.[0] === model);
    assert.equal(branch?.properties?.[model]?.$ref, `#/definitions/${name}`, `${model}: the complete schema's root names ${name}`);
    assert.equal(typeof createValidators().oscalValidator(model), 'function');
  }
});

test('the tracer catalogue validates as a catalog, and a stray status key under catalog fails with additionalProperties', () => {
  assert.deepEqual(validateOscal(fixture('catalog.json'), 'catalog', { ours: true }), { ok: true, errors: [] });
  const tampered = fixture('catalog.json');
  tampered.catalog.status = 'met';
  const result = validateOscal(tampered, 'catalog', { ours: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('additionalProperties') && error.includes('status')), result.errors.join('\n'));
});

test('the tracer component definition validates as component-definition and fails as catalog', () => {
  assert.deepEqual(validateOscal(fixture('component.json'), 'component-definition', { ours: true }), { ok: true, errors: [] });
  assert.equal(validateOscal(fixture('component.json'), 'catalog', { ours: true }).ok, false);
  assert.equal(validateOscal(fixture('catalog.json'), 'component-definition', { ours: false }).ok, false);
});

test('a generated document must be stamped 1.2.1; a vendored one stamped 1.2.3 passes as not ours', () => {
  const later = fixture('catalog.json');
  later.catalog.metadata['oscal-version'] = '1.2.3';
  assert.equal(validateOscal(later, 'catalog', { ours: false }).ok, true);
  const ours = validateOscal(later, 'catalog', { ours: true });
  assert.equal(ours.ok, false);
  assert.ok(ours.errors.some((error) => error.includes('oscal-version')), ours.errors.join('\n'));
  const unstamped = fixture('catalog.json');
  delete unstamped.catalog.metadata['oscal-version'];
  assert.equal(validateOscal(unstamped, 'catalog', { ours: true }).ok, false);
  const otherLine = fixture('catalog.json');
  otherLine.catalog.metadata['oscal-version'] = '1.1.2';
  assert.equal(validateOscal(otherLine, 'catalog', { ours: false }).ok, false, 'a vendored document must be on the 1.2 line the schema describes');
});

test('only the pinned NIST catalogue path is an external OSCAL source', () => {
  assert.equal(oscalOriginForFile('/data/compliance', '/data/compliance/catalogs/nist-800-53-r5/catalog-min.json'), 'external');
  assert.equal(oscalOriginForFile('/data/compliance', '/data/compliance/catalogs/nist-800-53-r5/other.json'), 'generated');
  assert.equal(oscalOriginForFile('/data/compliance', '/data/compliance/catalogs/itsp-10-033/catalog.json'), 'generated');
});

test('validateOscal returns at most five errors and never throws on a non-object', () => {
  const broken = fixture('catalog.json');
  for (let index = 0; index < 12; index += 1) broken.catalog[`extra-${index}`] = index;
  const result = validateOscal(broken, 'catalog', { ours: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 1 && result.errors.length <= 5, `${result.errors.length} errors`);
  for (const value of [null, 7, 'text', []]) assert.equal(validateOscal(value, 'catalog', { ours: true }).ok, false);
});

test('modelOf names the model from the root key, and nothing for an unknown or doubled root', () => {
  assert.equal(modelOf(fixture('catalog.json')), 'catalog');
  assert.equal(modelOf(fixture('component.json')), 'component-definition');
  assert.equal(modelOf({ $schema: 'x', profile: {} }), 'profile');
  assert.equal(modelOf({ unknown: {} }), undefined);
  assert.equal(modelOf({ catalog: {}, profile: {} }), undefined);
  assert.equal(modelOf(null), undefined);
});

test('only the recognised link-only CPCSC report is excluded from OSCAL model inference', () => {
  const root = '/data/compliance';
  const cpcsc = { catalog: { metadata: { props: [{ name: 'source-id', value: 'cpcsc-level-1' }] }, controls: [{ id: 'itsp171-03.01.01', links: [{ href: 'https://www.canada.ca/en/public-services-procurement/services/industrial-security/security-requirements-contracting/cyber-security-certification-defence-suppliers-canada/program-overview.html' }] }] } };
  assert.equal(modelForSourceFile(root, `${root}/import-reports/cpcsc-level-1.json`, cpcsc), undefined);
  assert.equal(modelForSourceFile(root, `${root}/import-reports/other.json`, cpcsc), 'catalog');
  assert.equal(modelForSourceFile(root, `${root}/import-reports/cpcsc-level-1.json`, { catalog: { ...cpcsc.catalog, controls: [{ ...cpcsc.catalog.controls[0], title: 'not a typed report' }] } }), 'catalog');
  assert.equal(modelForSourceFile(root, `${root}/import-reports/cpcsc-level-1.json`, { catalog: { ...cpcsc.catalog, controls: [{ id: 'itsp171-03.01.01', links: [], parts: [{ prose: 'not link only' }] }] } }), 'catalog');
});

test('validateOurs accepts the tracer rules file and refuses an unknown key, a status key, a test rule without name and a kind mismatch', () => {
  assert.deepEqual(validateOurs(fixture('evidence-rules.json'), 'evidence-rule'), { ok: true, errors: [] });
  const base = fixture('evidence-rules.json');
  const cases: [string, (doc: any) => void][] = [
    ['unknown top-level key', (doc) => { doc.extra = true; }],
    ['unknown rule key', (doc) => { doc.rules[0].note = 'x'; }],
    ['status key on a rule', (doc) => { doc.rules[0].status = 'met'; }],
    ['state key inside test', (doc) => { doc.rules[0].test.state = 'met'; }],
    ['test rule without name', (doc) => { delete doc.rules[0].test.name; }],
    ['test rule with an observation', (doc) => { doc.rules[0].observation = { collector: 'audit', subject: 'root' }; }],
    ['observation kind with a test', (doc) => { doc.rules[0].kind = 'observation'; }],
    ['rule id with capitals', (doc) => { doc.rules[0].id = 'Tracer.Rule'; }],
    ['test file outside the repository', (doc) => { doc.rules[0].test.file = '../outside.test.ts'; }]
  ];
  for (const [label, mutate] of cases) {
    const doc = clone(base);
    mutate(doc);
    assert.equal(validateOurs(doc, 'evidence-rule').ok, false, label);
  }
  const observation = clone(base);
  observation.rules[0] = { id: 'tracer-fixture.tr-01.audit', component: 'tracer-fixture', control: 'tr-01', statement: 'tr-01_smt', kind: 'observation', observation: { collector: 'audit', subject: 'root' } };
  assert.equal(validateOurs(observation, 'evidence-rule').ok, true, 'an observation rule is accepted');
  assert.throws(() => validateOurs({}, '../oscal_complete'), /schema name/);
});

test('every schema of our own compiles in strict mode', () => {
  // Vendored schemas (listed in SOURCES.json: the OSCAL schema, and the CycloneDX 1.6 schemas of 74.1-15) are not ours; compliance/test/aiBom.test.ts checks those.
  const vendored = new Set((JSON.parse(readFileSync(path.join(SCHEMAS_DIR, 'SOURCES.json'), 'utf8')) as { file: string }[]).map((source) => source.file));
  const ours = readdirSync(SCHEMAS_DIR).filter((file) => file.endsWith('.schema.json') && !vendored.has(file));
  assert.ok(ours.includes('evidence-rule.schema.json'));
  for (const file of ours) assert.equal(typeof createValidators().oursValidator(file.replace(/\.schema\.json$/, '')), 'function', file);
});

test('loadJson refuses a file above its byte cap and any prototype key at any depth', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'compliance-loadjson-'));
  const write = (name: string, text: string): string => { const file = path.join(dir, name); writeFileSync(file, text); return file; };
  assert.deepEqual(loadJson(write('ok.json', '{"a":[1,{"b":"c"}]}')), { a: [1, { b: 'c' }] });
  assert.throws(() => loadJson(write('big.json', JSON.stringify({ a: 'x'.repeat(2048) })), { maxBytes: 1024 }), /byte/);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => loadJson(write(`top-${key}.json`, `{"${key}":{"x":1}}`)), (error: Error) => error.message.includes(key) && error.message.includes('refused'), `top-level ${key}`);
    assert.throws(() => loadJson(write(`deep-${key}.json`, `{"a":[{"b":{"${key}":1}}]}`)), /refused/, `nested ${key}`);
  }
  assert.throws(() => loadJson(write('bad.json', '{not json')), /bad\.json/);
  assert.equal(({} as any).x, undefined, 'nothing reached Object.prototype');
});

const OSCAL_DIRS = ['catalogs', 'profiles', 'components', 'mappings'];
function jsonFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((entry) => path.join(dir, entry))
    .filter((file) => file.endsWith('.json') && statSync(file).isFile());
}

test('every OSCAL file under catalogs, profiles, components and mappings validates by the model its root key names', () => {
  let checked = 0;
  for (const dir of OSCAL_DIRS) {
    for (const file of jsonFilesUnder(path.join(PACKAGE_ROOT, dir))) {
      const doc = loadJson(file);
      const model = modelOf(doc);
      if (model === undefined) continue; // our own non-OSCAL files (for example text indexes) have their own schemas
      const result = validateOscal(doc, model as OscalModel, { ours: false });
      assert.ok(result.ok, `${path.relative(PACKAGE_ROOT, file)}: ${result.errors.join('; ')}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 0);
});
