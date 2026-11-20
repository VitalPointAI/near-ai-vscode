// The `models` section of policy bundle v2 (models@1, FND-08, Phase 41 D-42, D-59): the passport schema of the model provenance design (5.1 to 5.3)
// with every WP-0 refusal, anchored model matching where the stricter of two passports wins, the passport hash, the shipped passports (5.5) and the
// use tier of a request (6.1). Report mode only: nothing here refuses a request. Fictional passports only; hashes are made at test time.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseModelsSection, resolvePassport } from '../domain/gate/models';
import type { ModelsSection } from '../domain/gate/models';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { parsePolicyDocument } from '../domain/gate/policyDocument';
import { DAY_MS, FIXED_NOW, deviceKey, policyDocumentFor } from './helpers/policyFixtures';

type Loose = any; // a section under edit: each test breaks one value on purpose

function plain<T>(value: T): Loose {
  return JSON.parse(JSON.stringify(value)) as Loose;
}

/** A 64 lowercase hex digest made at test time, never written in this file. */
function digest(label: string): string {
  return createHash('sha256').update(`gate-passports/${label}`, 'utf8').digest('hex');
}

/** One fictional passport, valid at FIXED_NOW, with fields replaced by `overrides`. */
function examplePassport(overrides: Record<string, unknown> = {}): Loose {
  return {
    id: 'example/western-chat',
    match: ['example/Western-Chat-*'],
    developer: 'Example Labs',
    origin: 'CA',
    lineage: { family: 'example', base: 'Western Chat 8B (pretrained by Example Labs)', teachers: [], method: 'pretrain+sft' },
    licence: { id: 'Apache-2.0', obligations: ['attribution'], inherited: [] },
    legal: { coveredByUsLaw: false, entityList: false, removalOrders: [] },
    hosting: ['nearai-tee'],
    maxTier: 'T2',
    issuedAt: '2026-11-20T00:00:00.000Z',
    expiresAt: '2027-06-01T00:00:00.000Z',
    reevaluateOn: ['artifact-change', 'fine-tune'],
    ...overrides
  };
}

function section(passports: unknown[] = [examplePassport()], extra: Record<string, unknown> = {}): Loose {
  return { v: 1, mode: 'report', unknownMaxTier: 'T0', passports, ...extra };
}

/** The starting rules as a plain v2 personal layer that requires models@1 and carries `models`. */
function documentWith(models: unknown): Loose {
  const doc = plain(policyDocumentFor({ key: deviceKey() }));
  doc.requires = [...(doc.requires as string[]), 'models@1'].sort();
  doc.models = models;
  return doc;
}

function parsed(value: unknown): ModelsSection {
  const result = parseModelsSection(value, SCALE_PRESETS);
  assert.ok(result.ok, result.ok ? '' : `${result.reason} ${result.path}`);
  return result.ok ? result.value : (undefined as never);
}

function refusalOf(value: unknown): string {
  const result = parseModelsSection(value, SCALE_PRESETS);
  return result.ok ? 'ok' : `${result.reason} ${result.path}`;
}

function deepFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every((child) => deepFrozen(child));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Task 1: one passport through a signed v2 policy to resolvePassport

test('a v2 policy that requires models@1 carries one passport, read strictly and frozen at every level', () => {
  const doc = documentWith(section());
  const result = parsePolicyDocument(doc);
  assert.ok(result.ok, result.ok ? '' : `${result.reason} ${result.path}`);
  if (!result.ok) return;
  const models = result.value.models;
  assert.ok(models !== undefined);
  assert.deepEqual(models?.passports?.[0], examplePassport());
  assert.ok(deepFrozen(models));
  doc.models.passports[0].maxTier = 'T3';
  assert.equal(models?.passports?.[0]?.maxTier, 'T2', 'the parsed passport is not the input object');
});

test('resolvePassport finds the passport by its anchored, case-sensitive pattern and gives its hash and tier', () => {
  const models = parsed(section());
  const resolved = resolvePassport(models, 'example/Western-Chat-8B', FIXED_NOW);
  assert.ok(resolved !== undefined);
  assert.equal(resolved?.passport.id, 'example/western-chat');
  assert.equal(resolved?.maxTier, 'T2');
  assert.equal(resolved?.source, 'policy');
  assert.match(resolved?.hash ?? '', /^[0-9a-f]{64}$/);
});

test('resolvePassport never matches a substring, a missing suffix or another case: those models have no passport', () => {
  const models = parsed(section());
  for (const id of ['example/Western-Chat', 'xexample/Western-Chat-8B', 'example/western-chat-8b', 'example/Western-Chat8B', 'other/example/Western-Chat-8B']) {
    assert.equal(resolvePassport(models, id, FIXED_NOW), undefined, id);
  }
});

test('a section without mode and unknownMaxTier is read as report mode with T0 for an unknown model', () => {
  const value = section();
  delete value.mode;
  delete value.unknownMaxTier;
  const doc = documentWith(value);
  const result = parsePolicyDocument(doc);
  assert.ok(result.ok, result.ok ? '' : `${result.reason} ${result.path}`);
  if (!result.ok) return;
  assert.equal(result.value.models?.mode, 'report');
  assert.equal(result.value.models?.unknownMaxTier, 'T0');
  assert.deepEqual(result.value.models?.passports, [examplePassport()]);
});

test('the empty section { v: 1 } stays exactly { v: 1 } (41-01 contract) and resolves no policy passport', () => {
  assert.deepEqual(parseModelsSection({ v: 1 }, SCALE_PRESETS), { ok: true, value: { v: 1 } });
  assert.equal(resolvePassport(parsed({ v: 1 }), 'example/Western-Chat-8B', FIXED_NOW), undefined);
  assert.equal(resolvePassport(undefined, 'example/Western-Chat-8B', FIXED_NOW), undefined);
  assert.equal(refusalOf(section([examplePassport({ issuedAt: '2026-11-20T00:00:00Z' })])), 'wrong-type models.passports[0].issuedAt');
  void DAY_MS;
});
