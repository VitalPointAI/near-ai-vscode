// The `models` section of policy bundle v2 (models@1, FND-08, Phase 41 D-42, D-59): the passport schema of the model provenance design (5.1 to 5.3)
// with every WP-0 refusal, anchored model matching where the stricter of two passports wins, the passport hash, the shipped passports (5.5) and the
// use tier of a request (6.1). Report mode only: nothing here refuses a request. Fictional passports only; hashes are made at test time.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { bundleHash } from '../domain/gate/bundle';
import { MAX_PASSPORTS, effectiveMaxTier, matchesModelPattern, parseModelsSection, passportHash, resolvePassport } from '../domain/gate/models';
import type { ModelsSection, Passport } from '../domain/gate/models';
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
