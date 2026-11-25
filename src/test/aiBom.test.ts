// The AI bill of materials, pure (74.1-15 Task 1, D-24, MPRV-10): one machine-learning-model component per model the project used, with supplier,
// licence, pedigree and the record's facts; deterministic; no prompt or answer text; and the checked-in sample is exactly aiBomFor of the fixture.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AI_BOM_SPEC_VERSION, aiBomFor, aiBomSummary } from '../domain/provenance/aiBom';
import { AI_BOM_PROJECT, aiBomRecords, fixtureResolve } from './helpers/aiBomFixture';

const REPO = path.resolve(__dirname, '..', '..');
type Component = { name: string; supplier?: { name: string }; licenses?: unknown[]; pedigree?: { ancestors: Array<{ name: string; properties: Array<{ name: string; value: string }> }> }; properties: Array<{ name: string; value: string }> };
const bom = () => aiBomFor(aiBomRecords(), { project: AI_BOM_PROJECT, resolve: fixtureResolve });
const components = () => bom()['components'] as Component[];
const prop = (entry: Component | undefined, name: string) => entry?.properties.find((property) => property.name === `sovai:${name}`)?.value;

test('D-24: one machine-learning-model component per model used, sorted, in a CycloneDX 1.6 document', () => {
  const document = bom();
  assert.equal(document['bomFormat'], 'CycloneDX');
  assert.equal(document['specVersion'], AI_BOM_SPEC_VERSION);
  assert.deepEqual(components().map((entry) => entry.name), ['nvidia/NVIDIA-Nemotron-3-Super-120B', 'openai/gpt-oss-120b', 'z-ai/glm-5.3']);
  for (const entry of components()) assert.equal((entry as unknown as { type: string }).type, 'machine-learning-model');
});

test('D-24: gpt-oss names its supplier, licence, origin, approval and hash, uses served and place class', () => {
  const gpt = components().find((entry) => entry.name === 'openai/gpt-oss-120b');
  assert.equal(gpt?.supplier?.name, 'OpenAI');
  assert.deepEqual(gpt?.licenses, [{ license: { id: 'Apache-2.0' } }]);
  assert.equal(prop(gpt, 'origin'), 'US');
  assert.equal(prop(gpt, 'passport'), 'openai/gpt-oss');
  assert.equal(prop(gpt, 'passportHash'), fixtureResolve('openai/gpt-oss-120b')?.hash);
  assert.equal(prop(gpt, 'usesServed'), 'T2');
  assert.equal(prop(gpt, 'endpointClass'), 'nearai-tee');
  assert.equal(prop(gpt, 'lane'), undefined);
  assert.equal(prop(gpt, 'firstUse'), '2026-11-25T10:00:00Z');
  assert.equal(prop(gpt, 'lastUse'), '2026-11-25T12:00:00Z');
});

test('D-17, D-24: GLM used in the research workspace says lane t0 and uses served T0', () => {
  const glm = components().find((entry) => entry.name === 'z-ai/glm-5.3');
  assert.equal(prop(glm, 'lane'), 't0');
  assert.equal(prop(glm, 'usesServed'), 'T0');
  assert.equal(prop(glm, 'origin'), 'CN');
});

test('D-24: a Nemotron 3 component lists its base and each teacher as pedigree ancestors with origin', () => {
  const nemotron = components().find((entry) => entry.name === 'nvidia/NVIDIA-Nemotron-3-Super-120B');
  const ancestors = nemotron?.pedigree?.ancestors ?? [];
  assert.ok(ancestors.length >= 2);
  assert.equal(ancestors[0]?.properties.find((property) => property.name === 'sovai:relation')?.value, 'base');
  const teachers = ancestors.slice(1);
  assert.ok(teachers.length > 0);
  for (const teacher of teachers) assert.match(teacher.properties.find((property) => property.name === 'sovai:origin')?.value ?? '', /^[A-Z]{2}$/);
  assert.ok(teachers.some((teacher) => teacher.properties.some((property) => property.name === 'sovai:origin' && property.value === 'CN')), 'a teacher from the People\'s Republic of China is named');
});

test('D-24: deterministic (the same records give the same bytes, whatever their order), and no prompt or answer text', () => {
  const once = JSON.stringify(bom());
  assert.equal(JSON.stringify(aiBomFor([...aiBomRecords()].reverse(), { project: AI_BOM_PROJECT, resolve: fixtureResolve })), once);
  assert.doesNotMatch(once, /prompt|answer|content":/i);
  assert.deepEqual(aiBomSummary(bom()), { models: 3, first: '2026-11-25T09:00:00Z', last: '2026-11-25T12:00:00Z' });
});

test('a refused request used no model and is not listed; no records give a valid empty bill', () => {
  const refused = aiBomRecords().map((record) => ({ ...record, action_id: 2 }));
  assert.deepEqual(aiBomFor(refused, { project: AI_BOM_PROJECT, resolve: fixtureResolve })['components'], []);
  assert.deepEqual(aiBomSummary(aiBomFor([], { project: AI_BOM_PROJECT, resolve: fixtureResolve })), { models: 0 });
});

test('drift: compliance/test/fixtures/ai-bom.sample.json is exactly aiBomFor of the fixture records (this test writes nothing)', () => {
  const sample = JSON.parse(readFileSync(path.join(REPO, 'compliance', 'test', 'fixtures', 'ai-bom.sample.json'), 'utf8')) as unknown;
  assert.deepEqual(sample, bom());
});
