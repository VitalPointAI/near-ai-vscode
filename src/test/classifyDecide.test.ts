// The classification engine's floor path (Phase 70.1 plan 01 Task 1; D-05, D-06, D-09, D-15, D-16): a marking banner found in a text raises the label
// through the signed classification@1 section, the pure engine and a label.auto-raised decision record. Fictional content only (Exercise NORTHERN EXAMPLE).
import assert from 'node:assert/strict';
import test from 'node:test';
import { shapeReason } from '../domain/gate/bundle';
import { atLeast, markAtLeast } from '../domain/gate/dominance';
import type { Mark } from '../domain/gate/dominance';
import { FEATURE_IDS, featureForSection } from '../domain/gate/features';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import { parsePolicyDocument } from '../domain/gate/policyDocument';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import { buildDecisionRecord, validateDecisionRecord } from '../domain/gate/record';
import { DECIDE_REFUSALS, decide } from '../domain/classify/decide';
import type { DecideInput } from '../domain/classify/decide';
import { markingFloors } from '../domain/classify/markings';
import { deviceKey, policyDocumentFor } from './helpers/policyFixtures';

type Loose = Record<string, any>;

const H = 'a'.repeat(64);
const CURRENT = { item: 'item-northern-example-notes', contentHash: H, revision: 3 };

function label(scale: string, level: string, extra: Partial<Label> = {}): Label {
  return { scale, level, compartments: [], releasability: [], handling: [], ...extra };
}

const SECRET = label('ca-classified', 'Secret');
const CONFIDENTIAL = label('ca-classified', 'Confidential');

function classification(): Loose {
  return {
    v: 1,
    systemHigh: [SECRET],
    thresholds: { 'ca-classified/Secret': { costRatio: 19, recallTarget: 9800, secondFamily: true } },
    markings: [
      { id: 'banner-protected-b-fr', pattern: 'PROTÉGÉ B', label: label('ca-protected', 'Protected B') },
      { id: 'banner-secret', pattern: 'SECRET', label: SECRET }
    ]
  };
}

function documentWith(edit: (doc: Loose) => void = () => undefined): Loose {
  const doc = JSON.parse(JSON.stringify(policyDocumentFor({ key: deviceKey() }))) as Loose;
  doc.classification = classification();
  doc.requires = [...doc.requires, 'classification@1'].sort();
  edit(doc);
  return doc;
}

function parsed(value: unknown): PolicyDocument {
  const result = parsePolicyDocument(value);
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

function inputFor(doc: PolicyDocument, start: Mark, text: string): DecideInput {
  const section = doc.classification;
  assert.ok(section);
  return { start, current: CURRENT, floors: markingFloors(text, section), judgement: undefined, section, scales: doc.labels.scales, modes: {} };
}

test('tracer: a v2 document carries the classification section under classification@1, appended after every earlier feature', () => {
  const doc = parsed(documentWith());
  assert.ok(doc.classification);
  assert.ok(doc.requires.includes('classification@1'));
  assert.equal(featureForSection('classification'), 'classification@1');
  assert.equal(FEATURE_IDS.indexOf('classification@1'), FEATURE_IDS.indexOf('agreements@1') + 1, 'after Phase 71 (core)');
  assert.deepEqual(doc.classification.markings.map((marking) => marking.id), ['banner-protected-b-fr', 'banner-secret']);
  assert.ok(Object.isFrozen(doc.classification) && Object.isFrozen(doc.classification.markings));
  assert.deepEqual(parsed(JSON.parse(JSON.stringify(doc))), doc, 'a parsed document is its own wire form');
});

test('a document with the classification section that does not name classification@1 in requires is malformed, as for every section', () => {
  const result = parsePolicyDocument(documentWith((doc) => { doc.requires = doc.requires.filter((entry: string) => entry !== 'classification@1'); }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(shapeReason(result), 'malformed');
  const newer = parsePolicyDocument(documentWith((doc) => { doc.requires = [...doc.requires, 'classification@2'].sort(); }));
  assert.equal(newer.ok ? 'ok' : shapeReason(newer), 'needs-update');
});

test('markingFloors finds the SECRET banner as one floor with a marking basis naming the pattern id, and the French PROTÉGÉ B banner', () => {
  const doc = parsed(documentWith());
  const section = doc.classification!;
  assert.deepEqual(markingFloors('SECRET\nExercise NORTHERN EXAMPLE notes', section), [{ label: SECRET, basis: { kind: 'marking', ref: 'banner-secret' } }]);
  const french = markingFloors('PROTÉGÉ B\nNotes de l\'exercice NORTHERN EXAMPLE', section);
  assert.deepEqual(french.map((floor) => floor.basis.ref), ['banner-protected-b-fr']);
  // Decomposed accents, a zero-width space and a non-breaking space still match; the word inside another word and other cases do not.
  assert.equal(markingFloors('PROTÉGÉ B', section).length, 1);
  assert.equal(markingFloors('SE​CRET', section).length, 1);
  for (const text of ['SECRETARY of the exercise', 'a secret meeting place', 'TOPSECRET', 'Secret']) assert.equal(markingFloors(text, section).length, 0, text);
});

test('decide raises Confidential to Secret on the SECRET banner: auto-raised, one marking basis and one label.auto-raised event', () => {
  const doc = parsed(documentWith());
  const result = decide(inputFor(doc, [CONFIDENTIAL], 'SECRET\nExercise NORTHERN EXAMPLE notes'));
  assert.ok(result.ok);
  assert.equal(result.outcome, 'auto-raised');
  assert.deepEqual(result.applied, [SECRET]);
  assert.deepEqual(result.bases, [{ kind: 'marking', ref: 'banner-secret' }]);
  assert.deepEqual(result.events.map((event) => event.event), ['label.auto-raised']);
  assert.equal(result.notify, true);
  assert.deepEqual(result.proposal.map((part) => [part.label.level, part.level]), [['Secret', 'up']]);
  assert.ok(markAtLeast(result.applied, result.start, doc.labels.scales), 'never below the start');
});

test('a contradicting banner never lowers: "This document is UNCLASSIFIED. SECRET" gives Secret, and a start above the marking is kept', () => {
  const doc = parsed(documentWith());
  const result = decide(inputFor(doc, [CONFIDENTIAL], 'This document is UNCLASSIFIED. SECRET'));
  assert.ok(result.ok);
  assert.ok(result.applied.every((held) => held.scale !== 'ca-classified' || atLeast(held, SECRET, SCALE_PRESETS)));
  const topSecret = label('ca-classified', 'Top Secret', { compartments: ['EXAMPLE-CW'] });
  const kept = decide(inputFor(doc, [topSecret], 'SECRET. This document is UNCLASSIFIED and may be lowered.'));
  assert.ok(kept.ok);
  assert.equal(kept.outcome, 'kept');
  assert.deepEqual(kept.applied, [topSecret], 'the compartment and the level stay');
  assert.deepEqual(kept.events, []);
  assert.deepEqual(kept.proposal.map((part) => part.level), ['down'], 'the direction is recorded; nothing is applied down');
  const nothing = decide(inputFor(doc, [CONFIDENTIAL], 'This document is unclassified.'));
  assert.ok(nothing.ok);
  assert.equal(nothing.outcome, 'none');
  assert.deepEqual(nothing.applied, [CONFIDENTIAL]);
});

test('decide refuses an empty start with no-start rather than assuming the lowest level, and a level its scale does not have', () => {
  const doc = parsed(documentWith());
  const empty = decide(inputFor(doc, [], 'SECRET'));
  assert.deepEqual(empty, { ok: false, refusal: 'no-start', message: DECIDE_REFUSALS['no-start'] });
  const unknown = decide(inputFor(doc, [label('ca-classified', 'Ultra')], 'SECRET'));
  assert.equal(unknown.ok ? '' : unknown.refusal, 'unknown-label');
});

test('a banner on another scale is kept beside the start, never merged into it', () => {
  const doc = parsed(documentWith());
  const result = decide(inputFor(doc, [CONFIDENTIAL], 'PROTÉGÉ B'));
  assert.ok(result.ok);
  assert.equal(result.outcome, 'auto-raised');
  assert.deepEqual(result.applied.map((held) => `${held.scale}/${held.level}`), ['ca-classified/Confidential', 'ca-protected/Protected B']);
});

test('the event goes through buildDecisionRecord, and validateDecisionRecord accepts it with operation label.auto-raised', () => {
  const doc = parsed(documentWith());
  const result = decide(inputFor(doc, [CONFIDENTIAL], 'SECRET\nExercise NORTHERN EXAMPLE notes'));
  assert.ok(result.ok);
  const [event] = result.events;
  assert.ok(event);
  const record = buildDecisionRecord({
    recordId: 'r-auto-raised-1', sequence: 0, time: 1_700_000_000_000, productVersion: '0.0.0-test',
    actor: { kind: 'agent', deviceFingerprint: 'device-example', sessionId: 'session-example' },
    callId: 'label.auto-raised-1', capability: { verb: 'plan' },
    // The decision record names the item and the proposal record's hash, never the content (D-21).
    resource: { name: CURRENT.item, type: 'label', uid: 'b'.repeat(64) },
    outcome: 'allowed', rule: event.event, bundleHash: 'c'.repeat(64), policyVersion: 'bundle-2',
    label: SECRET, mark: event.to, from: event.from
  });
  const shaped = { ...record, api: { ...record.api, operation: event.event } };
  const valid = validateDecisionRecord(shaped);
  assert.equal(valid.ok, true, valid.ok ? '' : valid.message);
  assert.equal(shaped.api.operation, 'label.auto-raised');
  assert.equal(shaped.authorizations[0]?.policy.name, 'label.auto-raised');
  assert.ok(!JSON.stringify(shaped).includes('NORTHERN'), 'no content in the record');
});
