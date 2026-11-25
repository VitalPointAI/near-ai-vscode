// The classification proposal record v1 and its log copy (Phase 70.1 plan 01 Task 2; D-03, D-06, D-21, T-70.1-02, T-70.1-03). Fictional content only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import {
  BASIS_KINDS, PERSON_ATTRIBUTE_KEYS, PROPOSAL_LOG_COPY_KEYS, PROPOSAL_RECORD_KEYS, parseProposalLogCopy, parseProposalRecord, proposalRecordHash, recordForLog
} from '../domain/classify/record';
import type { ProposalRecord } from '../domain/classify/record';
import { canonicalize } from '../domain/team/canonical';

type Loose = Record<string, any>;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function label(scale: string, level: string, extra: Partial<Label> = {}): Label {
  return { scale, level, compartments: [], releasability: [], handling: [], ...extra };
}

const RATIONALE = 'It names a unit of Exercise NORTHERN EXAMPLE, a location and a future move date.';

/** A model-assisted record: Confidential raised to Secret by a judgement and a marking. */
function modelRecord(): Loose {
  const secret = label('ca-classified', 'Secret');
  return {
    v: 1, item: 'item-northern-example-notes', contentHash: 'a'.repeat(64), revision: 3,
    start: [label('ca-classified', 'Confidential')],
    proposal: [{ label: secret, level: 'up', compartments: 'same', releasability: 'same', handling: 'same' }],
    bases: [{ kind: 'marking', ref: 'banner-secret' }, { kind: 'judgement', ref: sha256(RATIONALE) }],
    facts: [{ type: 'unit', subject: 'subj-7f3a' }, { type: 'location', subject: 'subj-91c2' }, { type: 'future-date' }],
    confidence: { levels: { 'ca-classified/Secret': 4000, 'ca-classified/Top Secret': 120 }, calibration: 'cal-gpt-oss-20b-2026-11', sampleAgreement: 10000, secondFamilyAgreement: 9000 },
    model: { passport: 'openai/gpt-oss', passportHash: 'b'.repeat(64), artifactHash: 'c'.repeat(64), endpointClass: 'local', useTier: 'T3' },
    prompt: { bundleHash: 'd'.repeat(64), templateHash: 'e'.repeat(64), decodingHash: 'f'.repeat(64) },
    rationale: { label: secret, text: RATIONALE },
    outcome: 'auto-raised',
    applied: [secret],
    suggestions: [
      { label: label('ca-classified', 'Secret', { handling: ['no-agent-tools'] }), reason: 'judgement-only' },
      { label: label('ca-classified', 'Secret', { releasability: ['CAN', 'GBR'] }), reason: 'wider-release', decidedBy: 'release-authority' }
    ],
    exceptions: [{ kind: 'large-raise' }],
    actor: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
  };
}

/** A rules-only record: no model, no confidence, no rationale. */
function rulesRecord(): Loose {
  const secret = label('ca-classified', 'Secret');
  return {
    v: 1, item: 'item-northern-example-notes', contentHash: 'a'.repeat(64), revision: 3,
    start: [label('ca-classified', 'Confidential')],
    proposal: [{ label: secret, level: 'up', compartments: 'same', releasability: 'same', handling: 'same' }],
    bases: [{ kind: 'marking', ref: 'banner-secret' }], facts: [], confidence: null, model: 'none', prompt: { bundleHash: 'd'.repeat(64) }, rationale: null,
    outcome: 'auto-raised', applied: [secret], suggestions: [], exceptions: [], actor: 'rules'
  };
}

function reasonOf(value: unknown): string {
  const parsed = parseProposalRecord(value, SCALE_PRESETS);
  return parsed.ok ? 'ok' : `${parsed.reason} ${parsed.path}`;
}

function edited(edit: (record: Loose) => void, base: () => Loose = modelRecord): Loose {
  const record = base();
  edit(record);
  return record;
}

test('the record v1 has exactly the keys of D-21, in order, and the six basis kinds of 33.1 D-40', () => {
  assert.deepEqual([...PROPOSAL_RECORD_KEYS], [
    'v', 'item', 'contentHash', 'revision', 'start', 'proposal', 'bases', 'facts', 'confidence', 'model', 'prompt', 'rationale', 'outcome', 'applied',
    'suggestions', 'exceptions', 'actor'
  ]);
  assert.deepEqual([...BASIS_KINDS], ['source', 'marking', 'guide', 'detector', 'compilation', 'judgement']);
  assert.deepEqual([...PROPOSAL_LOG_COPY_KEYS], [...PROPOSAL_RECORD_KEYS, 'recordHash']);
  for (const key of PERSON_ATTRIBUTE_KEYS) assert.ok(!(PROPOSAL_RECORD_KEYS as readonly string[]).includes(key), key);
});

test('a model record and a rules-only record parse, frozen, and each is its own wire form', () => {
  for (const make of [modelRecord, rulesRecord]) {
    const parsed = parseProposalRecord(make(), SCALE_PRESETS);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
    if (!parsed.ok) continue;
    assert.deepEqual(Object.keys(parsed.value).sort(), [...PROPOSAL_RECORD_KEYS].sort());
    assert.ok(Object.isFrozen(parsed.value) && Object.isFrozen(parsed.value.bases));
    assert.equal(canonicalize(parsed.value), canonicalize(make()));
  }
});

test('an extra key is refused at every level', () => {
  assert.equal(reasonOf(edited((r) => { r.signature = 'x'; })), 'unknown-field signature');
  assert.equal(reasonOf(edited((r) => { r.model.served = 'gpt-oss-20b'; })), 'unknown-field model.served');
  assert.equal(reasonOf(edited((r) => { r.bases[0].text = 'SECRET'; })), 'unknown-field bases[0].text');
  assert.equal(reasonOf(edited((r) => { delete r.actor; })), 'missing-field actor');
});

test('D-03: a person-attribute key is refused by name, at the top and inside any object of the record', () => {
  for (const key of ['clearance', 'nationality', 'organization', 'serves', 'compartmentHoldings', 'exportEligibility', 'agreements', 'roleAuthority']) {
    assert.equal(reasonOf(edited((r) => { r[key] = 'x'; })), `not-allowed-here ${key}`, key);
    assert.equal(reasonOf(edited((r) => { r.facts[0][key] = 'x'; })), `not-allowed-here facts[0].${key}`, key);
    assert.equal(reasonOf(edited((r) => { r.suggestions[0][key] = 'x'; })), `not-allowed-here suggestions[0].${key}`, key);
  }
});

test('a basis kind outside BASIS_KINDS, and a ref that is empty, over 128 characters or has a line break, are refused', () => {
  assert.equal(reasonOf(edited((r) => { r.bases[0].kind = 'hunch'; })), 'not-allowed-here bases[0].kind');
  for (const ref of ['', 'r'.repeat(129), 'banner\nsecret', 'banner\rsecret', 'banner\u2028secret', 7]) {
    assert.equal(reasonOf(edited((r) => { r.bases[0].ref = ref; })), 'wrong-type bases[0].ref', JSON.stringify(ref));
  }
  assert.equal(reasonOf(edited((r) => { r.bases[0].ref = 'r'.repeat(128); })), 'ok');
});

test('a judgement basis without a ref is refused, and so is a judgement on a rules-only record', () => {
  assert.equal(reasonOf(edited((r) => { delete r.bases[1].ref; })), 'missing-field bases[1].ref');
  assert.equal(reasonOf(edited((r) => { r.bases.push({ kind: 'judgement', ref: 'a'.repeat(64) }); }, rulesRecord)), 'not-allowed-here bases');
});

test('an outcome outside the six is refused; affirmed, lowered and reverted-by-request are later events, never an outcome', () => {
  for (const outcome of ['auto-raised', 'suggested', 'kept', 'none', 'stale', 'possible-spill']) assert.equal(reasonOf(edited((r) => { r.outcome = outcome; })), 'ok', outcome);
  for (const outcome of ['affirmed', 'lowered', 'reverted-by-request', 'raised']) assert.equal(reasonOf(edited((r) => { r.outcome = outcome; })), 'not-allowed-here outcome', outcome);
});

test('a handling flag outside labels v1 is refused wherever a label sits', () => {
  assert.equal(reasonOf(edited((r) => { r.applied = [label('ca-classified', 'Secret', { handling: ['no-train'] })]; })), 'not-allowed-here applied[0].handling[0]');
  assert.equal(reasonOf(edited((r) => { r.suggestions[0].label.handling = ['relaxed']; })), 'not-allowed-here suggestions[0].label.handling[0]');
  assert.equal(reasonOf(edited((r) => { r.start = []; })), 'empty-list start', 'never classified from the bottom');
});

test('numbers are whole basis points, confidence goes with a model, and a lowering suggestion names who may decide it', () => {
  assert.equal(reasonOf(edited((r) => { r.confidence.levels['ca-classified/Secret'] = 0.4; })), 'wrong-type confidence.levels.ca-classified?Secret');
  assert.equal(reasonOf(edited((r) => { r.confidence.sampleAgreement = 10001; })), 'wrong-type confidence.sampleAgreement');
  assert.equal(reasonOf(edited((r) => { r.confidence = null; })), 'missing-field confidence');
  assert.equal(reasonOf(edited((r) => { r.confidence = modelRecord().confidence; }, rulesRecord)), 'not-allowed-here confidence');
  assert.equal(reasonOf(edited((r) => { delete r.suggestions[1].decidedBy; })), 'missing-field suggestions[1].decidedBy');
  assert.equal(reasonOf(edited((r) => { r.suggestions[0].decidedBy = 'steward'; })), 'not-allowed-here suggestions[0].decidedBy');
  assert.equal(reasonOf(edited((r) => { r.model.endpointClass = 'somewhere'; })), 'not-allowed-here model.endpointClass');
  assert.equal(reasonOf(edited((r) => { r.actor = 'rules'; })), 'not-allowed-here actor', 'a model took part');
  assert.equal(reasonOf(edited((r) => { r.facts[0].subject = 'Example Brigade HQ'; })), 'wrong-type facts[0].subject', 'a subject is an opaque key, never a value');
});

test('recordForLog keeps ids, hashes, kinds, labels and the outcome, and replaces the rationale and fact subjects with their hashes', () => {
  const parsed = parseProposalRecord(modelRecord(), SCALE_PRESETS);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const record: ProposalRecord = parsed.value;
  const copy = recordForLog(record, sha256);
  const text = JSON.stringify(copy);
  assert.ok(!text.includes(RATIONALE) && !text.includes('NORTHERN'), 'no rationale text');
  assert.ok(!text.includes('subj-7f3a') && !text.includes('subj-91c2'), 'no fact subject');
  assert.deepEqual(copy.rationale, { label: record.rationale!.label, textHash: sha256(RATIONALE) });
  assert.deepEqual(copy.facts, [{ type: 'unit', subjectHash: sha256('subj-7f3a') }, { type: 'location', subjectHash: sha256('subj-91c2') }, { type: 'future-date' }]);
  assert.equal(copy.recordHash, sha256(canonicalize(record)));
  assert.equal(copy.recordHash, proposalRecordHash(record, sha256));
  for (const key of ['item', 'contentHash', 'revision', 'start', 'proposal', 'bases', 'confidence', 'model', 'prompt', 'outcome', 'applied', 'suggestions', 'exceptions', 'actor'] as const) {
    assert.deepEqual(copy[key], record[key], key);
  }
  const again = parseProposalLogCopy(JSON.parse(text), SCALE_PRESETS);
  assert.ok(again.ok, again.ok ? '' : again.message);
  assert.equal(parseProposalLogCopy(modelRecord(), SCALE_PRESETS).ok, false, 'a full record is not a log copy');
  assert.equal(parseProposalRecord(JSON.parse(text), SCALE_PRESETS).ok, false, 'a log copy is not a full record');
  const rules = parseProposalRecord(rulesRecord(), SCALE_PRESETS);
  assert.ok(rules.ok);
  if (rules.ok) assert.equal(parseProposalLogCopy(JSON.parse(JSON.stringify(recordForLog(rules.value, sha256))), SCALE_PRESETS).ok, true);
});

test('the record hash changes with any field, so a cell entry\'s basis ref names exactly one record', () => {
  const a = parseProposalRecord(modelRecord(), SCALE_PRESETS);
  const b = parseProposalRecord(edited((r) => { r.revision = 4; }), SCALE_PRESETS);
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) assert.notEqual(proposalRecordHash(a.value, sha256), proposalRecordHash(b.value, sha256));
});
