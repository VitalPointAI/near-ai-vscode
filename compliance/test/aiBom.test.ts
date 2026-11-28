// The AI bill of materials against the official CycloneDX 1.6 JSON schema (74.1-15 Task 1, D-24): the sample the extension's aiBomFor writes validates
// with the package's ajv (the schema's SPDX and JSF schemas loaded beside it), a planted invalid copy fails, and the vendored files are the ones recorded.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMAS = path.join(PACKAGE_ROOT, 'schemas');
const read = (file: string): any => JSON.parse(readFileSync(file, 'utf8'));
// ajv-formats is CommonJS; its plugin is both module.exports and module.exports.default.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv) => Ajv;

function validator() {
  const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false });
  addFormats(ajv);
  ajv.addSchema(read(path.join(SCHEMAS, 'cyclonedx-spdx.schema.json')));
  ajv.addSchema(read(path.join(SCHEMAS, 'cyclonedx-jsf-0.82.schema.json')));
  return ajv.compile(read(path.join(SCHEMAS, 'cyclonedx-bom-1.6.schema.json')));
}

test('the AI bill of materials sample validates against the official CycloneDX 1.6 schema', () => {
  const validate = validator();
  const sample = read(path.join(PACKAGE_ROOT, 'test', 'fixtures', 'ai-bom.sample.json'));
  const ok = validate(sample);
  assert.equal(ok, true, JSON.stringify(validate.errors));
  assert.equal(sample.specVersion, '1.6');
  assert.ok(sample.components.every((component: { type: string }) => component.type === 'machine-learning-model'));
});

test('a planted invalid copy fails: an unknown component type, and a licence id that is not an SPDX id', () => {
  const validate = validator();
  const sample = read(path.join(PACKAGE_ROOT, 'test', 'fixtures', 'ai-bom.sample.json'));
  const badType = structuredClone(sample);
  badType.components[0].type = 'large-language-thing';
  assert.equal(validate(badType), false);
  const badLicence = structuredClone(sample);
  badLicence.components.find((component: { licenses?: unknown[] }) => component.licenses !== undefined).licenses = [{ license: { id: 'Not-An-SPDX-Id' } }];
  assert.equal(validate(badLicence), false);
});

test('the vendored CycloneDX schemas are unmodified: their SHA-256 is the one recorded in SOURCES.json with the 1.6 URL', () => {
  const sources = read(path.join(SCHEMAS, 'SOURCES.json')) as Array<{ file: string; url: string; version: string; sha256: string; licence: string }>;
  for (const file of ['cyclonedx-bom-1.6.schema.json', 'cyclonedx-spdx.schema.json', 'cyclonedx-jsf-0.82.schema.json']) {
    const entry = sources.find((source) => source.file === file);
    assert.ok(entry, `${file} is listed`);
    assert.match(entry.url, /^https:\/\/raw\.githubusercontent\.com\/CycloneDX\/specification\/1\.6\/schema\//);
    assert.equal(entry.version, '1.6');
    assert.match(entry.licence, /Apache-2\.0/);
    assert.equal(createHash('sha256').update(readFileSync(path.join(SCHEMAS, file))).digest('hex'), entry.sha256);
  }
});
