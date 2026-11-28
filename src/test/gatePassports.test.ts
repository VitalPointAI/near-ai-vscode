// The `models` section of policy bundle v2 (models@1, FND-08, Phase 41 D-42, D-59): the passport schema of the model provenance design (5.1 to 5.3)
// with every WP-0 refusal, anchored model matching where the stricter of two passports wins, the passport hash, the shipped passports (5.5) and the
// use tier of a request (6.1). Report mode only: nothing here refuses a request. Fictional passports only; hashes are made at test time.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { bundleHash } from '../domain/gate/bundle';
import { MAX_PASSPORTS, effectiveMaxTier, matchesModelPattern, parseModelsSection, passportCovers, passportHash, resolvePassport } from '../domain/gate/models';
import type { ModelsSection, Passport } from '../domain/gate/models';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { parsePolicyDocument } from '../domain/gate/policyDocument';
import { SHIPPED_PASSPORTS, SHIPPED_TIER_BY_LEVEL, SHIPPED_TIER_BY_PROJECT } from '../domain/gate/shippedPassports';
import { USE_TIER_WORDS, raiseUseTier, useTierFor } from '../domain/gate/useTier';
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
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Task 2: every WP-0 refusal, the stricter of two passports, and the cross-checks inside the section

const ARTIFACT = (): Loose => ({ format: 'safetensors', sha256: digest('weights'), quantization: 'none', remoteCode: false });
const EVALUATION = (): Loose => ({ report: 'doc-eval-0042', sha256: digest('evaluation'), at: '2026-11-19T00:00:00.000Z' });

function passportNamed(id: string, overrides: Record<string, unknown> = {}): Loose {
  return examplePassport({ id, match: [`example/${id.split('/')[1] ?? id}-*`], ...overrides });
}

test('an unknown key is refused at the section and in a passport', () => {
  assert.equal(refusalOf(section(undefined, { invented: true })), 'unknown-field models.invented');
  assert.equal(refusalOf(section([examplePassport({ invented: 1 })])), 'unknown-field models.passports[0].invented');
  // A hostile prototype key read from JSON is an own key like any other, and is refused.
  const hostile = JSON.parse('{"v":1,"passports":[],"__proto__":{"mode":"enforce"}}') as unknown;
  assert.equal(refusalOf(hostile), 'unknown-field models.__proto__');
});

test('an unknown key is refused in every nested object of a passport', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['lineage', { lineage: { ...examplePassport().lineage, extra: 1 } }],
    ['lineage.teachers[0]', { lineage: { ...examplePassport().lineage, teachers: [{ model: 'Teacher 1', origin: 'US', method: 'distillation', extra: 1 }] } }],
    ['licence', { licence: { ...examplePassport().licence, extra: 1 } }],
    ['legal', { legal: { ...examplePassport().legal, extra: 1 } }],
    ['artifact', { artifact: { ...ARTIFACT(), extra: 1 } }],
    ['evaluation', { evaluation: { ...EVALUATION(), extra: 1 } }]
  ];
  for (const [where, overrides] of cases) assert.equal(refusalOf(section([examplePassport(overrides)])), `unknown-field models.passports[0].${where}.extra`, where);
});

test('a bare wildcard match is refused; a pattern with a wildcard and text is allowed', () => {
  for (const bare of ['*', '**', '***']) assert.equal(refusalOf(section([examplePassport({ match: [bare] })])), 'not-allowed-here models.passports[0].match[0]', bare);
  assert.equal(refusalOf(section([examplePassport({ match: ['*', 'example/a'] })])), 'not-allowed-here models.passports[0].match[0]');
  assert.equal(refusalOf(section([examplePassport({ match: ['*-8B'] })])), 'ok');
  assert.equal(refusalOf(section([examplePassport({ match: ['example/Western Chat'] })])), 'wrong-type models.passports[0].match[0]');
});

test('a passport needs one to eight match patterns, sorted and unique', () => {
  assert.equal(refusalOf(section([examplePassport({ match: [] })])), 'empty-list models.passports[0].match');
  const nine = Array.from({ length: 9 }, (_, index) => `example/m${String(index)}`);
  assert.equal(refusalOf(section([examplePassport({ match: nine })])), 'not-allowed-here models.passports[0].match');
  assert.equal(refusalOf(section([examplePassport({ match: nine.slice(0, 8) })])), 'ok');
  assert.equal(refusalOf(section([examplePassport({ match: ['example/b', 'example/a'] })])), 'not-sorted models.passports[0].match[1]');
  assert.equal(refusalOf(section([examplePassport({ match: ['example/a', 'example/a'] })])), 'duplicate models.passports[0].match[1]');
});

test('remote code is refused (T-41-51); remoteCode false is allowed', () => {
  assert.equal(refusalOf(section([examplePassport({ artifact: { ...ARTIFACT(), remoteCode: true } })])), 'not-allowed-here models.passports[0].artifact.remoteCode');
  assert.equal(refusalOf(section([examplePassport({ artifact: { ...ARTIFACT(), remoteCode: 'false' } })])), 'wrong-type models.passports[0].artifact.remoteCode');
  assert.equal(refusalOf(section([examplePassport({ artifact: ARTIFACT() })])), 'ok');
});

test('pickle weights are refused (T-41-51); safetensors and gguf are allowed', () => {
  for (const format of ['pickle', 'bin', 'pt', 'Safetensors']) {
    assert.equal(refusalOf(section([examplePassport({ artifact: { ...ARTIFACT(), format } })])), 'not-allowed-here models.passports[0].artifact.format', format);
  }
  for (const format of ['safetensors', 'gguf']) assert.equal(refusalOf(section([examplePassport({ artifact: { ...ARTIFACT(), format } })])), 'ok', format);
});

test('maxTier T3 needs your organization\'s evaluation; with one it is allowed', () => {
  assert.equal(refusalOf(section([examplePassport({ maxTier: 'T3' })])), 'not-allowed-here models.passports[0].maxTier');
  assert.equal(refusalOf(section([examplePassport({ maxTier: 'T3', evaluation: EVALUATION() })])), 'ok');
  assert.equal(refusalOf(section([examplePassport({ maxTier: 'T2' })])), 'ok', 'T2 without an evaluation is allowed');
  assert.equal(refusalOf(section([examplePassport({ maxTier: 'T4' })])), 'not-allowed-here models.passports[0].maxTier');
});

test('a passport expires at most 365 days after issue, and after it is issued', () => {
  const issued = Date.parse('2026-11-20T00:00:00.000Z');
  const at = (days: number): string => new Date(issued + days * DAY_MS).toISOString();
  assert.equal(refusalOf(section([examplePassport({ expiresAt: at(366) })])), 'not-allowed-here models.passports[0].expiresAt');
  assert.equal(refusalOf(section([examplePassport({ expiresAt: new Date(issued + 365 * DAY_MS + 1).toISOString() })])), 'not-allowed-here models.passports[0].expiresAt');
  assert.equal(refusalOf(section([examplePassport({ expiresAt: at(365) })])), 'ok');
  assert.equal(refusalOf(section([examplePassport({ expiresAt: at(0) })])), 'not-allowed-here models.passports[0].expiresAt');
  assert.equal(refusalOf(section([examplePassport({ expiresAt: at(-1) })])), 'not-allowed-here models.passports[0].expiresAt');
});

test('an unknown origin (XX) is refused above T0; at T0 it is allowed', () => {
  for (const maxTier of ['T1', 'T2']) assert.equal(refusalOf(section([examplePassport({ origin: 'XX', maxTier })])), 'not-allowed-here models.passports[0].maxTier', maxTier);
  assert.equal(refusalOf(section([examplePassport({ origin: 'XX', maxTier: 'T0' })])), 'ok');
  assert.equal(refusalOf(section([examplePassport({ origin: 'ca' })])), 'wrong-type models.passports[0].origin');
});

test('unknownMaxTier accepts only T0, and mode only report or enforce', () => {
  assert.equal(refusalOf(section(undefined, { unknownMaxTier: 'T1' })), 'not-allowed-here models.unknownMaxTier');
  assert.equal(refusalOf(section(undefined, { unknownMaxTier: 'T3' })), 'not-allowed-here models.unknownMaxTier');
  assert.equal(refusalOf(section(undefined, { unknownMaxTier: 0 })), 'wrong-type models.unknownMaxTier');
  assert.equal(refusalOf(section(undefined, { mode: 'off' })), 'not-allowed-here models.mode');
  assert.equal(refusalOf(section(undefined, { mode: 'enforce' })), 'ok');
  assert.equal(parsed(section(undefined, { mode: 'enforce' })).mode, 'enforce');
});

test('at most 256 passports (T-41-53)', () => {
  const many = Array.from({ length: MAX_PASSPORTS + 1 }, (_, index) => passportNamed(`example/p${String(index).padStart(3, '0')}`));
  assert.equal(MAX_PASSPORTS, 256);
  assert.equal(refusalOf(section(many)), 'not-allowed-here models.passports');
  assert.equal(refusalOf(section(many.slice(0, MAX_PASSPORTS))), 'ok');
});

test('passports are sorted by id and unique', () => {
  const a = passportNamed('example/alpha');
  const b = passportNamed('example/bravo');
  assert.equal(refusalOf(section([b, a])), 'not-sorted models.passports[1]');
  assert.equal(refusalOf(section([a, a])), 'duplicate models.passports[1]');
  assert.equal(refusalOf(section([a, b])), 'ok');
  assert.equal(refusalOf(section([examplePassport({ id: 'Example/Upper' })])), 'wrong-type models.passports[0].id');
});

test('hosting is a non-empty, sorted, unique list of endpoint classes', () => {
  assert.equal(refusalOf(section([examplePassport({ hosting: ['nearai-cloud'] })])), 'not-allowed-here models.passports[0].hosting[0]');
  assert.equal(refusalOf(section([examplePassport({ hosting: [] })])), 'empty-list models.passports[0].hosting');
  assert.equal(refusalOf(section([examplePassport({ hosting: ['nearai-tee', 'closed-api'] })])), 'not-sorted models.passports[0].hosting[1]');
  assert.equal(refusalOf(section([examplePassport({ hosting: ['closed-api', 'nearai-tee'] })])), 'ok');
});

test('your organization\'s own hosting (org-tee, org-plain, local) at T2 or above needs the artifact; at T1 or with the artifact it is allowed', () => {
  for (const hosting of [['org-tee'], ['org-plain'], ['local'], ['local', 'nearai-tee']]) {
    for (const maxTier of ['T2', 'T3']) {
      const extra = maxTier === 'T3' ? { evaluation: EVALUATION() } : {};
      const path = `not-allowed-here models.passports[0].hosting[${String(hosting.indexOf(hosting[0] as string))}]`;
      assert.equal(refusalOf(section([examplePassport({ hosting, maxTier, ...extra })])), path, `${hosting.join(',')} ${maxTier}`);
      assert.equal(refusalOf(section([examplePassport({ hosting, maxTier, artifact: ARTIFACT(), ...extra })])), 'ok', `${hosting.join(',')} ${maxTier} with artifact`);
    }
    assert.equal(refusalOf(section([examplePassport({ hosting, maxTier: 'T1' })])), 'ok', `${hosting.join(',')} T1`);
  }
  assert.equal(refusalOf(section([examplePassport({ hosting: ['nearai-tee', 'org-tee'] })])), 'not-allowed-here models.passports[0].hosting[1]');
});

test('a hash in capitals is refused', () => {
  assert.equal(refusalOf(section([examplePassport({ artifact: { ...ARTIFACT(), sha256: digest('weights').toUpperCase() } })])), 'wrong-type models.passports[0].artifact.sha256');
  assert.equal(refusalOf(section([examplePassport({ maxTier: 'T3', evaluation: { ...EVALUATION(), sha256: digest('evaluation').toUpperCase() } })])), 'wrong-type models.passports[0].evaluation.sha256');
});

test('lineage: method tokens from the list, joined once each; teacher methods from the list; at most 16 teachers', () => {
  const lineage = examplePassport().lineage;
  assert.equal(refusalOf(section([examplePassport({ lineage: { ...lineage, method: 'pretrain+magic' } })])), 'wrong-type models.passports[0].lineage.method');
  assert.equal(refusalOf(section([examplePassport({ lineage: { ...lineage, method: 'sft+sft' } })])), 'wrong-type models.passports[0].lineage.method');
  assert.equal(refusalOf(section([examplePassport({ lineage: { ...lineage, method: 'pretrain+sft+rl+abliteration' } })])), 'ok');
  const teacher = { model: 'Teacher 1', origin: 'CN', method: 'synthetic-data' };
  assert.equal(refusalOf(section([examplePassport({ lineage: { ...lineage, teachers: [{ ...teacher, method: 'copying' }] } })])), 'not-allowed-here models.passports[0].lineage.teachers[0].method');
  assert.equal(refusalOf(section([examplePassport({ lineage: { ...lineage, teachers: Array.from({ length: 17 }, () => teacher) } })])), 'not-allowed-here models.passports[0].lineage.teachers');
  assert.equal(refusalOf(section([examplePassport({ lineage: { ...lineage, teachers: [teacher] } })])), 'ok');
  assert.equal(refusalOf(section([examplePassport({ lineage: { ...lineage, family: 'Nemotron' } })])), 'wrong-type models.passports[0].lineage.family');
});

test('text lists hold at most 16 entries of at most 128 characters, without control characters', () => {
  const licence = examplePassport().licence;
  assert.equal(refusalOf(section([examplePassport({ licence: { ...licence, inherited: Array.from({ length: 17 }, () => 'check') } })])), 'not-allowed-here models.passports[0].licence.inherited');
  assert.equal(refusalOf(section([examplePassport({ licence: { ...licence, obligations: ['x'.repeat(129)] } })])), 'wrong-type models.passports[0].licence.obligations[0]');
  assert.equal(refusalOf(section([examplePassport({ legal: { ...examplePassport().legal, removalOrders: ['line\nbreak'] } })])), 'wrong-type models.passports[0].legal.removalOrders[0]');
  assert.equal(refusalOf(section([examplePassport({ developer: 'x'.repeat(65) })])), 'wrong-type models.passports[0].developer');
});

const T1_PASSPORT = (): Loose => passportNamed('example/chat-one', { maxTier: 'T1' });
const T0_PASSPORT = (): Loose => passportNamed('example/research', { maxTier: 'T0', origin: 'XX' });

test('defaults must name a passport in the section that reaches its job\'s tier', () => {
  const passports = [T1_PASSPORT(), T0_PASSPORT(), examplePassport()];
  assert.equal(refusalOf(section(passports, { defaults: { standard: 'example/missing' } })), 'not-allowed-here models.defaults.standard');
  assert.equal(refusalOf(section(passports, { defaults: { standard: 'example/chat-one' } })), 'not-allowed-here models.defaults.standard');
  for (const job of ['deep', 'fast', 'backup', 'safety']) {
    assert.equal(refusalOf(section(passports, { defaults: { [job]: 'example/chat-one' } })), `not-allowed-here models.defaults.${job}`, job);
  }
  for (const job of ['embed', 'rerank', 'vision', 'transcription', 'image']) {
    assert.equal(refusalOf(section(passports, { defaults: { [job]: 'example/research' } })), `not-allowed-here models.defaults.${job}`, job);
    assert.equal(refusalOf(section(passports, { defaults: { [job]: 'example/chat-one' } })), 'ok', job);
  }
  assert.equal(refusalOf(section(passports, { defaults: { t0: 'example/research', standard: 'example/western-chat' } })), 'ok');
  assert.equal(refusalOf(section(passports, { defaults: { chat: 'example/western-chat' } })), 'unknown-field models.defaults.chat');
});

test('a default is measured by the passport\'s tier after its legal caps', () => {
  const flagged = examplePassport({ legal: { coveredByUsLaw: false, entityList: true, removalOrders: [] } });
  assert.equal(refusalOf(section([flagged], { defaults: { standard: 'example/western-chat' } })), 'not-allowed-here models.defaults.standard');
});

test('order names passports in the section, each once', () => {
  const passports = [passportNamed('example/alpha'), passportNamed('example/bravo')];
  assert.equal(refusalOf(section(passports, { order: ['example/charlie'] })), 'not-allowed-here models.order[0]');
  assert.equal(refusalOf(section(passports, { order: ['example/bravo', 'example/bravo'] })), 'duplicate models.order[1]');
  assert.equal(refusalOf(section(passports, { order: ['example/bravo', 'example/alpha'] })), 'ok', 'order is a preference, not sorted');
  assert.deepEqual(parsed(section(passports, { order: ['example/bravo', 'example/alpha'] })).order, ['example/bravo', 'example/alpha']);
});

function catalogueEntry(overrides: Record<string, unknown> = {}): Loose {
  return {
    passport: 'example/western-chat',
    artifacts: [{ format: 'gguf', quantization: 'Q4_K_M', source: 'https://models.example.org/western-chat-8b.gguf', sha256: digest('gguf'), sizeBytes: 4_920_000_000, licence: { id: 'Apache-2.0', url: 'https://models.example.org/licence' } }],
    minFitBand: 'mid',
    ...overrides
  };
}

test('localCatalogue entries name a passport in the section and never pickle weights', () => {
  assert.equal(refusalOf(section(undefined, { localCatalogue: [catalogueEntry()] })), 'ok');
  assert.equal(refusalOf(section(undefined, { localCatalogue: [catalogueEntry({ passport: 'example/missing' })] })), 'not-allowed-here models.localCatalogue[0].passport');
  const pickle = catalogueEntry();
  pickle.artifacts[0].format = 'pickle';
  assert.equal(refusalOf(section(undefined, { localCatalogue: [pickle] })), 'not-allowed-here models.localCatalogue[0].artifacts[0].format');
  const fraction = catalogueEntry();
  fraction.artifacts[0].sizeBytes = 1.5;
  assert.equal(refusalOf(section(undefined, { localCatalogue: [fraction] })), 'wrong-type models.localCatalogue[0].artifacts[0].sizeBytes');
  assert.equal(refusalOf(section(undefined, { localCatalogue: [catalogueEntry({ artifacts: [] })] })), 'empty-list models.localCatalogue[0].artifacts');
  assert.equal(refusalOf(section(undefined, { localCatalogue: [catalogueEntry({ extra: 1 })] })), 'unknown-field models.localCatalogue[0].extra');
  assert.equal(refusalOf(section(undefined, { localCatalogue: [catalogueEntry(), catalogueEntry()] })), 'duplicate models.localCatalogue[1]');
});

test('tierByLevel names levels of the document\'s scales with use tiers; tierByProject names project kinds', () => {
  assert.equal(refusalOf(section(undefined, { tierByLevel: { 'ca-protected/Protected B': 'T2', 'ca-classified/Secret': 'T3' } })), 'ok');
  assert.equal(refusalOf(section(undefined, { tierByLevel: { 'ca-protected/Protected B': 'T4' } })), 'not-allowed-here models.tierByLevel.ca-protected?Protected?B');
  assert.equal(refusalOf(section(undefined, { tierByLevel: { Secret: 'T3' } })), 'not-allowed-here models.tierByLevel.Secret');
  assert.equal(refusalOf(section(undefined, { tierByLevel: { 'org/Secret': 'T3' } })), 'not-allowed-here models.tierByLevel.org?Secret');
  assert.equal(refusalOf(section(undefined, { tierByLevel: { 'invented/Secret': 'T3' } })), 'not-allowed-here models.tierByLevel.invented?Secret');
  assert.equal(refusalOf(section(undefined, { tierByProject: { staff: 'T3', 'staff-exercise': 'T2' } })), 'ok');
  assert.equal(refusalOf(section(undefined, { tierByProject: { Staff: 'T3' } })), 'not-allowed-here models.tierByProject.Staff');
  assert.equal(refusalOf(section(undefined, { tierByProject: { staff: 'T9' } })), 'not-allowed-here models.tierByProject.staff');
});

test('overlapping passports: the stricter wins, lower tier first, then the earlier expiry (T-41-50)', () => {
  const broad = examplePassport({ id: 'example/broad', match: ['example/*'], maxTier: 'T2', expiresAt: '2027-10-01T00:00:00.000Z' });
  const narrow = examplePassport({ id: 'example/narrow', match: ['example/Western-Chat-*'], maxTier: 'T1', expiresAt: '2027-06-01T00:00:00.000Z' });
  assert.equal(resolvePassport(parsed(section([broad, narrow])), 'example/Western-Chat-8B', FIXED_NOW)?.passport.id, 'example/narrow');
  assert.equal(resolvePassport(parsed(section([broad, narrow])), 'example/Other-8B', FIXED_NOW)?.passport.id, 'example/broad');
  const earlier = { ...broad, maxTier: 'T1', expiresAt: '2027-03-01T00:00:00.000Z' };
  assert.equal(resolvePassport(parsed(section([earlier, narrow])), 'example/Western-Chat-8B', FIXED_NOW)?.passport.id, 'example/broad');
});

test('effectiveMaxTier: expired, not yet issued, legally flagged or with a removal order counts as T0', () => {
  const p = (overrides: Record<string, unknown> = {}): Passport => (parsed(section([examplePassport(overrides)])).passports ?? [])[0] as Passport;
  assert.equal(effectiveMaxTier(p(), FIXED_NOW), 'T2');
  assert.equal(effectiveMaxTier(p(), Date.parse('2027-06-01T00:00:00.000Z')), 'T0', 'at the expiry instant');
  assert.equal(effectiveMaxTier(p(), FIXED_NOW - 1), 'T0', 'before issue');
  const legal = examplePassport().legal;
  assert.equal(effectiveMaxTier(p({ legal: { ...legal, entityList: true } }), FIXED_NOW), 'T0');
  assert.equal(effectiveMaxTier(p({ legal: { ...legal, coveredByUsLaw: true } }), FIXED_NOW), 'T0');
  assert.equal(effectiveMaxTier(p({ legal: { ...legal, removalOrders: ['notice 1'] } }), FIXED_NOW), 'T0');
  const expired = resolvePassport(parsed(section()), 'example/Western-Chat-8B', Date.parse('2027-07-01T00:00:00.000Z'));
  assert.equal(expired?.maxTier, 'T0');
});

test('passportHash is bundleHash over the passport, for three fictional passports', () => {
  const passports = parsed(section([passportNamed('example/alpha'), passportNamed('example/bravo', { artifact: ARTIFACT() }), passportNamed('example/charlie', { maxTier: 'T3', evaluation: EVALUATION() })])).passports ?? [];
  assert.equal(passports.length, 3);
  for (const passport of passports) assert.equal(passportHash(passport), bundleHash(passport), passport.id);
  assert.notEqual(passportHash(passports[0] as Passport), passportHash(passports[1] as Passport));
});

test('matchesModelPattern: anchored pieces in order, never overlapping, case-sensitive', () => {
  assert.equal(matchesModelPattern('nvidia/Llama-*Nemotron*', 'nvidia/Llama-3.3-Nemotron-Super-49B'), true);
  assert.equal(matchesModelPattern('nvidia/Llama-*Nemotron*', 'nvidia/OpenReasoning-Nemotron-7B'), false);
  assert.equal(matchesModelPattern('ab*ba', 'aba'), false, 'the prefix and suffix may not share characters');
  assert.equal(matchesModelPattern('ab*ba', 'abba'), true);
  assert.equal(matchesModelPattern('a*b*c', 'acb'), false);
  assert.equal(matchesModelPattern('a*b*c', 'axbxc'), true);
  assert.equal(matchesModelPattern('example/a', 'example/a'), true);
  assert.equal(matchesModelPattern('example/a', 'example/ab'), false);
  assert.equal(matchesModelPattern(`${'a*'.repeat(60)}b`, 'a'.repeat(5000)), false, 'a hostile pattern ends quickly');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Task 3: shipped passports, useTierFor and passportCovers

test('the shipped passports pass the same parser, sorted by id, and come back unchanged', () => {
  const result = parseModelsSection({ v: 1, mode: 'report', unknownMaxTier: 'T0', passports: SHIPPED_PASSPORTS }, SCALE_PRESETS);
  assert.ok(result.ok, result.ok ? '' : `${result.reason} ${result.path}`);
  if (!result.ok) return;
  assert.deepEqual(result.value.passports, SHIPPED_PASSPORTS);
  assert.ok(deepFrozen(SHIPPED_PASSPORTS));
  assert.ok(SHIPPED_PASSPORTS.length >= 15);
});

test('no shipped passport claims T3 or carries an evaluation; every PRC-origin row is T0; each lives at most 365 days', () => {
  for (const passport of SHIPPED_PASSPORTS) {
    assert.notEqual(passport.maxTier, 'T3', passport.id);
    assert.equal(passport.evaluation, undefined, passport.id);
    if (passport.origin === 'CN') assert.equal(passport.maxTier, 'T0', passport.id);
    assert.ok(Date.parse(passport.expiresAt) - Date.parse(passport.issuedAt) <= 365 * DAY_MS, passport.id);
    assert.equal(passport.artifact, undefined, `${passport.id}: only your organization's own passport names exact weights`);
    assert.ok(!passport.hosting.some((endpointClass) => endpointClass === 'org-tee' || endpointClass === 'org-plain' || endpointClass === 'local'), passport.id);
  }
  const origins = new Set(SHIPPED_PASSPORTS.map((passport) => passport.origin));
  assert.ok(origins.has('CN') && origins.has('US') && origins.has('CA') && origins.has('DE'));
});

test('resolvePassport without a section uses the shipped rows: PRC models at T0, Whisper at T2, OpenReasoning-Nemotron by origin', () => {
  const cases: Array<[string, string, string]> = [
    ['deepseek-ai/DeepSeek-V3.2', 'deepseek-ai/deepseek', 'T0'],
    ['Qwen/Qwen3.6-35B-A3B-FP8', 'qwen/qwen', 'T0'],
    ['Qwen/Qwen3-Embedding-0.6B', 'qwen/qwen', 'T0'],
    ['moonshotai/kimi-k3', 'moonshotai/kimi', 'T0'],
    ['z-ai/glm-5.3', 'z-ai/glm', 'T0'],
    ['zai-org/GLM-4.6', 'z-ai/glm', 'T0'],
    ['openai/whisper-large-v3', 'openai/whisper-large-v3', 'T2'],
    ['black-forest-labs/FLUX.2-klein-4B', 'black-forest-labs/flux.2-klein-4b', 'T2'],
    ['nvidia/OpenReasoning-Nemotron-7B', 'nvidia/openreasoning-nemotron', 'T0'],
    ['nvidia/Llama-3.3-Nemotron-Super-49B-v1', 'nvidia/llama-nemotron', 'T2'],
    ['nvidia/NVIDIA-Nemotron-3-Super-120B', 'nvidia/nemotron-3-super', 'T2'],
    ['openai/gpt-oss-120b', 'openai/gpt-oss', 'T2'],
    ['openai/gpt-6.1-sol', 'openai/gpt', 'T2'],
    ['anthropic/claude-sonnet-5-5', 'anthropic/claude', 'T2'],
    ['command-a-plus-05-2026', 'cohere/command-a-plus', 'T2']
  ];
  for (const [model, id, tier] of cases) {
    const resolved = resolvePassport(undefined, model, FIXED_NOW);
    assert.equal(resolved?.passport.id, id, model);
    assert.equal(resolved?.maxTier, tier, model);
    assert.equal(resolved?.source, 'shipped', model);
  }
  assert.equal(resolvePassport(undefined, 'nvidia/OpenReasoning-Nemotron-7B', FIXED_NOW)?.passport.origin, 'CN', 'the name says Nemotron; the origin is the base');
  for (const model of ['somevendor/unknown-model', 'cohere/command-a-plus', 'cohere/command-a-plus-08', 'openai/whisper-large-v3-turbo', 'deepseek-ai', 'qwen/qwen3-8b']) {
    assert.equal(resolvePassport(undefined, model, FIXED_NOW), undefined, model);
  }
  assert.ok(resolvePassport(undefined, 'openai/gpt-oss-20b', FIXED_NOW)?.passport.hosting.includes('nearai-tee'), 'gpt-oss is never read as the closed API');
});

test('your organization\'s passport replaces a shipped one by id; shipped rows still serve other models', () => {
  const whisper = examplePassport({ id: 'openai/whisper-large-v3', match: ['openai/whisper-large-v3'], developer: 'OpenAI', origin: 'US', maxTier: 'T1' });
  const models = parsed(section([whisper]));
  const resolved = resolvePassport(models, 'openai/whisper-large-v3', FIXED_NOW);
  assert.equal(resolved?.source, 'policy');
  assert.equal(resolved?.maxTier, 'T1');
  assert.equal(resolvePassport(models, 'deepseek-ai/DeepSeek-V3.2', FIXED_NOW)?.source, 'shipped');
  assert.equal(resolvePassport(models, 'example/Western-Chat-8B', FIXED_NOW), undefined, 'the replaced passport is the policy one, matching only its own pattern');
});

test('a policy passport overlapping a shipped one: the stricter of the two still wins', () => {
  const broad = examplePassport({ id: 'example/any-qwen', match: ['Qwen/*'], developer: 'Example Labs', origin: 'CA', maxTier: 'T2' });
  assert.equal(resolvePassport(parsed(section([broad])), 'Qwen/Qwen3.6-35B-A3B-FP8', FIXED_NOW)?.passport.id, 'qwen/qwen', 'a broader policy row cannot lift a shipped T0 row');
});

test('the shipped tier tables name levels of the shipped scales and parse as a section\'s own tables', () => {
  assert.equal(refusalOf(section(undefined, { tierByLevel: plain(SHIPPED_TIER_BY_LEVEL), tierByProject: plain(SHIPPED_TIER_BY_PROJECT) })), 'ok');
  assert.equal(SHIPPED_TIER_BY_LEVEL['ca-protected/Protected B'], 'T2');
  assert.equal(SHIPPED_TIER_BY_LEVEL['nato/NATO Confidential'], 'T3');
  assert.equal(SHIPPED_TIER_BY_PROJECT['staff'], 'T3');
  assert.equal(SHIPPED_TIER_BY_PROJECT['staff-exercise'], 'T2');
});

test('useTierFor: plain chat is T1; tools, an unattended, relay, routine or sub-agent context, writing to files and a checking job are T2', () => {
  assert.equal(useTierFor({}), 'T1');
  assert.equal(useTierFor({ context: 'interactive' }), 'T1');
  assert.equal(useTierFor({ tools: true }), 'T2');
  assert.equal(useTierFor({ tools: false }), 'T1');
  for (const context of ['unattended', 'relay', 'routine', 'sub-agent'] as const) assert.equal(useTierFor({ context }), 'T2', context);
  assert.equal(useTierFor({ writesFiles: true }), 'T2');
  assert.equal(useTierFor({ checkingJob: true }), 'T2');
});

test('useTierFor: the label raises by the shipped table', () => {
  const at = (scale: string, level: string): string => useTierFor({ mark: [{ scale, level }] });
  assert.equal(at('org', 'Public'), 'T1');
  assert.equal(at('org', 'Internal'), 'T1');
  assert.equal(at('org', 'Restricted'), 'T2');
  assert.equal(at('ca-protected', 'Protected A'), 'T1');
  assert.equal(at('ca-protected', 'Protected B'), 'T2');
  assert.equal(at('ca-protected', 'Protected C'), 'T2');
  assert.equal(at('ca-classified', 'Confidential'), 'T3');
  assert.equal(at('ca-classified', 'Secret'), 'T3');
  assert.equal(at('nato', 'NATO Restricted'), 'T1');
  assert.equal(at('nato', 'NATO Confidential'), 'T3');
  assert.equal(useTierFor({ mark: [{ scale: 'org', level: 'Internal' }, { scale: 'ca-classified', level: 'Secret' }] }), 'T3', 'the highest mark wins');
  assert.equal(useTierFor({ mark: [{ scale: '__proto__', level: 'x' }, { scale: 'constructor', level: '' }] }), 'T1');
});

test('useTierFor: a staff project is T3, and T2 with the signed exercise attribute', () => {
  assert.equal(useTierFor({ project: { kind: 'staff' } }), 'T3');
  assert.equal(useTierFor({ project: { kind: 'staff', exercise: true } }), 'T2');
  assert.equal(useTierFor({ project: { kind: 'staff', exercise: false } }), 'T3');
  assert.equal(useTierFor({ project: { kind: 'software' } }), 'T1');
  assert.equal(useTierFor({ project: { kind: 'staff', exercise: true }, mark: [{ scale: 'ca-classified', level: 'Secret' }] }), 'T3', 'the label still raises an exercise');
});

test('useTierFor: the research lane, cyber and a synthetic comparison are T0 whatever else is set', () => {
  const everything = { tools: true, context: 'unattended' as const, writesFiles: true, checkingJob: true, mark: [{ scale: 'ca-classified', level: 'Secret' }], project: { kind: 'staff' }, inherited: 'T3' as const };
  assert.equal(useTierFor({ lane: 'research', ...everything }), 'T0');
  assert.equal(useTierFor({ cyber: true, ...everything }), 'T0');
  assert.equal(useTierFor({ compare: 'synthetic', ...everything }), 'T0');
  assert.equal(useTierFor({ cyber: false }), 'T1');
});

test('useTierFor: Compare Models on project tasks is T2; vision keeps the inherited tier; embedding and reranking are at least T1', () => {
  assert.equal(useTierFor({ compare: 'project' }), 'T2');
  assert.equal(useTierFor({ inherited: 'T2' }), 'T2');
  assert.equal(useTierFor({ inherited: 'T3' }), 'T3');
  assert.equal(useTierFor({ feature: 'embedding' }), 'T1');
  assert.equal(useTierFor({ feature: 'rerank', inherited: 'T0' }), 'T1');
  assert.equal(useTierFor({ feature: 'embedding', inherited: 'T2' }), 'T2');
});

test('useTierFor: a policy tierByLevel and tierByProject only raise the shipped values', () => {
  const models = parsed(section(undefined, { tierByLevel: { 'ca-protected/Protected B': 'T1', 'org/Internal': 'T2' }, tierByProject: { staff: 'T1', software: 'T2' } }));
  assert.equal(useTierFor({ mark: [{ scale: 'ca-protected', level: 'Protected B' }] }, models), 'T2', 'a lower policy value never lowers');
  assert.equal(useTierFor({ mark: [{ scale: 'org', level: 'Internal' }] }, models), 'T2');
  assert.equal(useTierFor({ project: { kind: 'staff' } }, models), 'T3');
  assert.equal(useTierFor({ project: { kind: 'software' } }, models), 'T2');
  assert.equal(useTierFor({ mark: [{ scale: 'ca-protected', level: 'Protected B' }] }, parsed({ v: 1 })), 'T2', 'the empty section keeps the shipped table');
});

test('raiseUseTier never lowers, and the use words follow the glossary', () => {
  assert.equal(raiseUseTier('T2', 'T1'), 'T2');
  assert.equal(raiseUseTier('T1', 'T3'), 'T3');
  assert.equal(raiseUseTier('T0', 'T0'), 'T0');
  assert.deepEqual({ ...USE_TIER_WORDS }, { T0: 'research only (in the research workspace)', T1: 'chat you review', T2: 'agent work', T3: 'operational work' });
});

test('passportCovers: a T2 passport covers T2 on a class it lists; T3 exceeds it; an unlisted class is a hosting mismatch', () => {
  const resolved = resolvePassport(parsed(section()), 'example/Western-Chat-8B', FIXED_NOW);
  const covers = (use: 'T0' | 'T1' | 'T2' | 'T3', endpointClass: 'nearai-tee' | 'closed-api', now = FIXED_NOW): unknown => passportCovers({ resolved, use, endpointClass, t1RiskCovers: false, now });
  assert.deepEqual(covers('T2', 'nearai-tee'), { covers: true });
  assert.deepEqual(covers('T1', 'nearai-tee'), { covers: true });
  assert.deepEqual(covers('T3', 'nearai-tee'), { covers: false, why: 'tier-exceeded' });
  assert.deepEqual(covers('T2', 'closed-api'), { covers: false, why: 'hosting-mismatch' });
  assert.deepEqual(covers('T0', 'closed-api'), { covers: false, why: 'hosting-mismatch' });
});

test('passportCovers: no passport and an expired one allow only T0', () => {
  const none = (use: 'T0' | 'T1' | 'T2'): unknown => passportCovers({ resolved: undefined, use, endpointClass: 'nearai-tee', t1RiskCovers: true, now: FIXED_NOW });
  assert.deepEqual(none('T2'), { covers: false, why: 'unknown' });
  assert.deepEqual(none('T1'), { covers: false, why: 'unknown' }, 'a t1-risk authorization needs a passport to name');
  assert.deepEqual(none('T0'), { covers: true });
  const later = Date.parse('2027-07-01T00:00:00.000Z');
  const resolved = resolvePassport(parsed(section()), 'example/Western-Chat-8B', FIXED_NOW);
  assert.deepEqual(passportCovers({ resolved, use: 'T2', endpointClass: 'nearai-tee', t1RiskCovers: false, now: later }), { covers: false, why: 'expired' });
  assert.deepEqual(passportCovers({ resolved, use: 'T1', endpointClass: 'nearai-tee', t1RiskCovers: true, now: later }), { covers: false, why: 'expired' });
  assert.deepEqual(passportCovers({ resolved, use: 'T0', endpointClass: 'nearai-tee', t1RiskCovers: false, now: later }), { covers: true });
});

test('passportCovers: a T0 passport reaches T1 only with a t1-risk authorization in scope, and never T2', () => {
  const resolved = resolvePassport(undefined, 'z-ai/glm-5.3', FIXED_NOW);
  assert.equal(resolved?.maxTier, 'T0');
  const covers = (use: 'T0' | 'T1' | 'T2', t1RiskCovers: boolean): unknown => passportCovers({ resolved, use, endpointClass: 'nearai-tee', t1RiskCovers, now: FIXED_NOW });
  assert.deepEqual(covers('T1', true), { covers: true });
  assert.deepEqual(covers('T1', false), { covers: false, why: 'acceptance-missing' });
  assert.deepEqual(covers('T2', true), { covers: false, why: 'tier-exceeded' });
  assert.deepEqual(covers('T0', false), { covers: true });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Phase 74.1-01: the licences checked at each publisher, Command A+ on the vault classes, the Granite rows

function shipped(id: string): Passport {
  const found = SHIPPED_PASSPORTS.find((passport) => passport.id === id);
  assert.ok(found, id);
  return found as Passport;
}

function rowText(passport: Passport): string {
  return JSON.stringify(passport);
}

test('74.1-01: Command A+ is Apache-2.0 with Cohere\'s Usage Policy and your organization\'s rule, and nothing in its row says non-commercial', () => {
  const command = shipped('cohere/command-a-plus');
  assert.equal(command.licence.id, 'Apache-2.0');
  assert.ok(command.licence.obligations.some((text) => /Cohere's Usage Policy/.test(text)), 'Cohere-hosted use');
  assert.ok(command.licence.obligations.some((text) => /your organization's passport with its artifact hash/.test(text)), 'your organization\'s own copy');
  assert.doesNotMatch(rowText(command), /non-commercial/i);
  assert.equal(command.origin, 'CA');
  assert.match(command.lineage.base, /218B total/);
  assert.match(command.lineage.base, /25B active/);
  assert.match(command.lineage.base, /text and image input/);
});

test('74.1-01: Command A+ matches the publisher\'s ids only', () => {
  for (const model of ['CohereLabs/command-a-plus-05-2026-w4a4', 'CohereLabs/command-a-plus-05-2026-bf16', 'command-a-plus-05-2026']) {
    assert.equal(resolvePassport(undefined, model, FIXED_NOW)?.passport.id, 'cohere/command-a-plus', model);
  }
  for (const model of ['cohere/command-a-plus-08', 'RedHatAI/command-a-plus-05-2026-fp8', 'CohereLabs/c4ai-command-a-03-2025', 'CohereLabs/command-a-vision-07-2025']) {
    assert.equal(resolvePassport(undefined, model, FIXED_NOW), undefined, model);
  }
});

test('74.1-01: the shipped Command A+ row covers the Model Vault classes and never NEAR AI\'s private hardware or your organization\'s own hosting', () => {
  const resolved = resolvePassport(undefined, 'command-a-plus-05-2026', FIXED_NOW);
  assert.deepEqual([...(resolved?.passport.hosting ?? [])], ['vendor-region', 'vendor-tee']);
  const at = (endpointClass: 'vendor-region' | 'vendor-tee' | 'nearai-tee' | 'org-tee' | 'org-plain' | 'local'): unknown =>
    passportCovers({ resolved, use: 'T2', endpointClass, t1RiskCovers: false, now: FIXED_NOW });
  assert.deepEqual(at('vendor-region'), { covers: true });
  assert.deepEqual(at('vendor-tee'), { covers: true });
  for (const endpointClass of ['nearai-tee', 'org-tee', 'org-plain', 'local'] as const) assert.deepEqual(at(endpointClass), { covers: false, why: 'hosting-mismatch' }, endpointClass);
});

test('74.1-01: your organization\'s Command A+ passport with its artifact hash replaces the shipped row and covers T2 on org-tee; without the hash it is refused', () => {
  const own = examplePassport({
    id: 'cohere/command-a-plus',
    match: ['CohereLabs/command-a-plus-05-2026-*', 'command-a-plus-05-2026'],
    developer: 'Cohere',
    origin: 'CA',
    hosting: ['org-tee', 'vendor-region', 'vendor-tee'],
    artifact: { format: 'safetensors', sha256: digest('command-a-plus-w4a4'), quantization: 'nvfp4', remoteCode: false }
  });
  const models = parsed(section([own]));
  const resolved = resolvePassport(models, 'CohereLabs/command-a-plus-05-2026-w4a4', FIXED_NOW);
  assert.equal(resolved?.source, 'policy');
  assert.deepEqual(passportCovers({ resolved, use: 'T2', endpointClass: 'org-tee', t1RiskCovers: false, now: FIXED_NOW }), { covers: true });
  const { artifact: _artifact, ...withoutHash } = own as Record<string, unknown>;
  assert.equal(refusalOf(section([withoutHash])), 'not-allowed-here models.passports[0].hosting[0]');
});

test('74.1-01: Nemotron 3 Nano and Super name the NVIDIA Nemotron Open Model License; Ultra names OpenMDW-1.1', () => {
  assert.equal(shipped('nvidia/nemotron-3-nano').licence.id, 'NVIDIA Nemotron Open Model License');
  assert.equal(shipped('nvidia/nemotron-3-super').licence.id, 'NVIDIA Nemotron Open Model License');
  assert.equal(shipped('nvidia/nemotron-3-ultra').licence.id, 'OpenMDW-1.1');
});

test('74.1-01: every Nemotron 3 row lists gpt-oss-120b (US) beside its PRC teachers', () => {
  for (const id of ['nvidia/nemotron-3-nano', 'nvidia/nemotron-3-super', 'nvidia/nemotron-3-ultra']) {
    const teachers = shipped(id).lineage.teachers;
    assert.ok(teachers.some((teacher) => teacher.model === 'gpt-oss-120b' && teacher.origin === 'US'), id);
    assert.ok(teachers.some((teacher) => teacher.origin === 'CN'), id);
  }
});

test('74.1-01: FLUX.2 klein 4B is Apache-2.0; OpenReasoning-Nemotron inherits Apache-2.0 from Qwen2.5; Whisper stays MIT with the card\'s apache-2.0 recorded', () => {
  assert.equal(shipped('black-forest-labs/flux.2-klein-4b').licence.id, 'Apache-2.0');
  assert.ok(shipped('nvidia/openreasoning-nemotron').licence.inherited.some((text) => /Apache-2\.0/.test(text) && /Qwen2\.5/.test(text)));
  const whisper = shipped('openai/whisper-large-v3');
  assert.equal(whisper.licence.id, 'MIT');
  assert.ok(whisper.licence.inherited.some((text) => /apache-2\.0/.test(text)));
});

test('74.1-01: Kimi names the Kimi K3 License and GLM the GLM-5.3 License, each still "confirm per model" and research only', () => {
  const kimi = shipped('moonshotai/kimi');
  const glm = shipped('z-ai/glm');
  assert.equal(kimi.licence.id, 'Kimi K3 License');
  assert.equal(glm.licence.id, 'GLM-5.3 License');
  assert.ok(kimi.licence.inherited.includes('confirm per model'));
  assert.ok(glm.licence.inherited.includes('confirm per model'));
  assert.equal(resolvePassport(undefined, 'moonshotai/kimi-k3', FIXED_NOW)?.maxTier, 'T0');
  assert.equal(resolvePassport(undefined, 'z-ai/glm-5.3', FIXED_NOW)?.maxTier, 'T0');
});

test('74.1-01: IBM Granite resolves to family granite, origin US, Apache-2.0, T2, on NEAR AI\'s private hardware only', () => {
  const resolved = resolvePassport(undefined, 'ibm-granite/granite-4.2-8b', FIXED_NOW);
  assert.equal(resolved?.passport.id, 'ibm-granite/granite');
  assert.equal(resolved?.passport.lineage.family, 'granite');
  assert.equal(resolved?.passport.origin, 'US');
  assert.equal(resolved?.passport.licence.id, 'Apache-2.0');
  assert.equal(resolved?.maxTier, 'T2');
  assert.deepEqual([...(resolved?.passport.hosting ?? [])], ['nearai-tee']);
});

test('74.1-01: Granite Guardian has its own passport, and the plain Granite row does not match it', () => {
  const resolved = resolvePassport(undefined, 'ibm-granite/granite-guardian-4.1-8b', FIXED_NOW);
  assert.equal(resolved?.passport.id, 'ibm-granite/granite-guardian');
  assert.equal(resolved?.passport.lineage.family, 'granite');
  assert.equal(resolved?.passport.licence.id, 'Apache-2.0');
  assert.equal(resolved?.maxTier, 'T2');
  assert.ok(!shipped('ibm-granite/granite').match.some((pattern) => matchesModelPattern(pattern, 'ibm-granite/granite-guardian-4.1-8b')));
});

test('74.1-01: corrected rows keep their ids, and the source has one literal id line per row', () => {
  const ids = SHIPPED_PASSPORTS.map((passport) => passport.id);
  for (const id of ['cohere/command-a-plus', 'nvidia/nemotron-3-nano', 'nvidia/nemotron-3-super', 'nvidia/nemotron-3-ultra', 'moonshotai/kimi', 'z-ai/glm', 'black-forest-labs/flux.2-klein-4b', 'nvidia/openreasoning-nemotron', 'openai/whisper-large-v3']) {
    assert.ok(ids.includes(id), id);
  }
  assert.deepEqual(ids, [...ids].sort(), 'sorted by id');
  const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'domain', 'gate', 'shippedPassports.ts'), 'utf8');
  const literal = [...source.matchAll(/^\s*id: '([^']+)',/gm)].map((found) => found[1]);
  assert.deepEqual(literal, ids);
});

test('74.1-01: every licence text fits the parser\'s list text limit', () => {
  for (const passport of SHIPPED_PASSPORTS) {
    for (const text of [passport.licence.id, ...passport.licence.obligations, ...passport.licence.inherited]) assert.ok(text.length <= 128, `${passport.id}: ${text}`);
  }
});
