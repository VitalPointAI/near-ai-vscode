// The classification engine's decide() (Phase 70.1 plans 01 and 02; D-04 to D-16): a marking banner found in a text raises the label through the signed
// classification@1 section, the pure engine and a label.auto-raised decision record; judgements, shadow, review, stale results and the possible spill.
// Fictional content only (Exercise NORTHERN EXAMPLE). Probabilities are whole basis points (owner, 2026-11-25).
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
import { parseClassificationSection } from '../domain/gate/classificationSection';
import type { ClassificationSection } from '../domain/gate/classificationSection';
import { DECIDE_REFUSALS, FIELD_DIRECTIONS, decide, withinSystemHigh } from '../domain/classify/decide';
import type { DecideInput, Decision, Judgement } from '../domain/classify/decide';
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
  assert.equal(markingFloors('PROTE\u0301GE\u0301\u00a0B', section).length, 1);
  assert.equal(markingFloors('SE\u200bCRET', section).length, 1);
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

test('a banner on another scale is kept beside the start, never merged into it (with no system-high; 70.1-02 makes a scale the system-high lacks a possible spill)', () => {
  const doc = parsed(documentWith((value) => { delete value.classification.systemHigh; }));
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

// ---- 70.1-02: judgements, shadow, review, stale results and the possible spill ----

const PB = label('ca-protected', 'Protected B', { releasability: ['CAN', 'GBR'] });

function sectionWith(extra: Loose = {}): ClassificationSection {
  const parsed = parseClassificationSection({
    v: 1,
    thresholds: {
      'ca-protected/Protected A': { costRatio: 4, recallTarget: 9000, secondFamily: false },
      'ca-protected/Protected B': { costRatio: 9, recallTarget: 9500, secondFamily: false },
      'ca-protected/Protected C': { costRatio: 19, recallTarget: 9800, secondFamily: true },
      'ca-classified/Confidential': { costRatio: 9, recallTarget: 9500, secondFamily: false },
      'ca-classified/Secret': { costRatio: 19, recallTarget: 9800, secondFamily: true },
      'ca-classified/Top Secret': { costRatio: 49, recallTarget: 9900, secondFamily: true }
    },
    shadow: { defaultMode: 'enforce' },
    ...extra
  }, SCALE_PRESETS);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.value;
}

function judgement(proposal: Label[], probabilities: Record<string, number>, contentHash = H): Judgement {
  return {
    contentHash, proposal, probabilities, calibration: 'cal-example-1', sampleAgreement: 10000, facts: [], rationaleHash: 'f'.repeat(64),
    model: { servedModel: 'gpt-oss-20b', endpoint: 'example-org-classifier', passport: 'openai/gpt-oss', passportHash: 'b'.repeat(64), artifactHash: 'c'.repeat(64), endpointClass: 'local', useTier: 'T3' }
  };
}

function run(input: Partial<DecideInput> & Pick<DecideInput, 'start'>): Decision {
  const result = decide({ current: CURRENT, floors: [], section: sectionWith(), scales: SCALE_PRESETS, ...input });
  assert.ok(result.ok, result.ok ? '' : result.message);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

function guideFloor(target: Label, ref = 'scg-4.2'): { label: Label; basis: { kind: 'guide'; ref: string } } {
  return { label: target, basis: { kind: 'guide', ref } };
}

const reasons = (result: Decision): string[] => result.suggestions.map((entry) => `${entry.reason}${entry.decidedBy === undefined ? '' : `:${entry.decidedBy}`}`);

test('FIELD_DIRECTIONS names each field\'s directions (D-04)', () => {
  assert.deepEqual(FIELD_DIRECTIONS.level, ['up', 'same', 'down']);
  assert.deepEqual(FIELD_DIRECTIONS.releasability, ['narrowed', 'widened', 'both', 'same']);
});

test('a judgement above tau raises the level only, keeping the start\'s releasability, and asks the caller to notify', () => {
  const result = run({ start: [PB], judgement: judgement([label('ca-protected', 'Protected C', { releasability: ['CAN', 'GBR'] })], { 'ca-protected/Protected C': 1000 }) });
  assert.equal(result.outcome, 'auto-raised');
  assert.deepEqual(result.applied, [label('ca-protected', 'Protected C', { releasability: ['CAN', 'GBR'] })]);
  assert.equal(result.notify, true);
  assert.deepEqual(result.bases, [{ kind: 'judgement', ref: 'f'.repeat(64) }]);
  // Protected C is the top of its scale, so the raise also goes to review (D-11).
  assert.deepEqual(result.events.map((event) => event.event), ['label.auto-raised', 'label.exception-queued']);
  assert.equal(result.confidence?.calibration, 'cal-example-1');
});

test('in shadow mode the same judgement is a suggestion with reason shadow, and applied equals start (D-10)', () => {
  const answer = judgement([label('ca-protected', 'Protected C', { releasability: ['CAN', 'GBR'] })], { 'ca-protected/Protected C': 1000 });
  const shadow = run({ start: [PB], judgement: answer, section: sectionWith({ shadow: { defaultMode: 'shadow' } }) });
  assert.equal(shadow.outcome, 'suggested');
  assert.deepEqual(shadow.applied, [PB]);
  assert.deepEqual(reasons(shadow), ['shadow']);
  assert.deepEqual(shadow.events, []);
  const held = run({ start: [PB], judgement: answer, modes: { 'ca-protected/Protected C': 'shadow' } });
  assert.equal(held.outcome, 'suggested', 'the caller may hold a level in shadow');
  const listed = run({ start: [PB], judgement: answer, section: sectionWith({ shadow: { defaultMode: 'shadow', levels: ['ca-protected/Protected C'] } }), modes: { 'ca-protected/Protected C': 'enforce' } });
  assert.equal(listed.outcome, 'auto-raised', 'a level your organization moved to enforce raises');
  const notListed = run({ start: [PB], judgement: answer, section: sectionWith({ shadow: { defaultMode: 'shadow' } }), modes: { 'ca-protected/Protected C': 'enforce' } });
  assert.equal(notListed.outcome, 'suggested', 'the caller cannot enforce a level the signed section keeps in shadow');
});

test('a judgement of a lower level keeps the label and gives a could-be-lower suggestion for a classification authority', () => {
  const result = run({ start: [PB], judgement: judgement([label('ca-protected', 'Protected A', { releasability: ['CAN', 'GBR'] })], { 'ca-protected/Protected A': 9000 }) });
  assert.equal(result.outcome, 'kept');
  assert.deepEqual(result.applied, [PB]);
  assert.deepEqual(reasons(result), ['could-be-lower:classification-authority']);
  assert.equal(result.suggestions[0]?.label.level, 'Protected A');
  assert.deepEqual(result.events.map((event) => event.event), ['label.could-be-lower']);
});

test('releasability narrowed by a guide floor applies; narrowed by a judgement alone is a suggestion; widened is a release decision (D-09)', () => {
  const floor = run({ start: [PB], floors: [guideFloor(label('ca-protected', 'Protected B', { releasability: ['CAN'] }))] });
  assert.deepEqual(floor.applied[0]?.releasability, ['CAN']);
  const narrowed = run({ start: [PB], judgement: judgement([label('ca-protected', 'Protected B', { releasability: ['CAN'] })], {}) });
  assert.deepEqual(narrowed.applied, [PB]);
  assert.deepEqual(reasons(narrowed), ['judgement-only']);
  assert.deepEqual(narrowed.suggestions[0]?.label.releasability, ['CAN']);
  const widened = run({ start: [PB], judgement: judgement([label('ca-protected', 'Protected B', { releasability: ['CAN', 'GBR', 'USA'] })], {}) });
  assert.deepEqual(widened.applied, [PB]);
  assert.deepEqual(reasons(widened), ['wider-release:release-authority']);
  assert.equal(widened.outcome, 'kept');
});

test('a guide floor adding ITAR applies; a judgement removing a compartment is could-be-lower for the compartment owner', () => {
  const added = run({ start: [PB], floors: [guideFloor(label('ca-protected', 'Protected B', { compartments: ['ITAR'] }))] });
  assert.deepEqual(added.applied[0]?.compartments, ['ITAR']);
  assert.equal(added.outcome, 'auto-raised');
  const start = label('ca-protected', 'Protected B', { compartments: ['ITAR'], releasability: ['CAN', 'GBR'] });
  const removed = run({ start: [start], judgement: judgement([PB], {}) });
  assert.deepEqual(removed.applied, [start]);
  assert.deepEqual(reasons(removed), ['could-be-lower:compartment-owner']);
  const judged = run({ start: [PB], judgement: judgement([label('ca-protected', 'Protected B', { compartments: ['EAR'], releasability: ['CAN', 'GBR'] })], {}) });
  assert.deepEqual(reasons(judged), ['judgement-only'], 'a compartment from a judgement alone is only suggested');
});

test('a floor adding no-agent-tools applies; a judgement removing local-only is could-be-lower for the steward', () => {
  const added = run({ start: [PB], floors: [guideFloor(label('ca-protected', 'Protected B', { handling: ['no-agent-tools'] }))] });
  assert.deepEqual(added.applied[0]?.handling, ['no-agent-tools']);
  const start = label('ca-protected', 'Protected B', { releasability: ['CAN', 'GBR'], handling: ['local-only'] });
  const removed = run({ start: [start], judgement: judgement([PB], {}) });
  assert.deepEqual(removed.applied, [start]);
  assert.deepEqual(reasons(removed), ['could-be-lower:steward']);
});

test('D-11: Confidential to Top Secret queues large-raise; Confidential to Secret does not; Secret to Top Secret queues as the top level', () => {
  const twoLevels = run({ start: [CONFIDENTIAL], floors: [guideFloor(label('ca-classified', 'Top Secret'))] });
  assert.equal(twoLevels.outcome, 'auto-raised');
  assert.deepEqual(twoLevels.exceptions, [{ kind: 'large-raise' }]);
  assert.deepEqual(twoLevels.events.map((event) => event.event), ['label.auto-raised', 'label.exception-queued']);
  assert.equal(twoLevels.events[1]?.exception, 'large-raise');
  const oneLevel = run({ start: [CONFIDENTIAL], floors: [guideFloor(SECRET)] });
  assert.deepEqual(oneLevel.exceptions, []);
  const toTop = run({ start: [SECRET], floors: [guideFloor(label('ca-classified', 'Top Secret'))] });
  assert.deepEqual(toTop.exceptions, [{ kind: 'large-raise' }]);
  const noTop = run({ start: [SECRET], floors: [guideFloor(label('ca-classified', 'Top Secret'))], section: sectionWith({ review: { topLevel: false } }) });
  assert.deepEqual(noTop.exceptions, []);
});

test('D-14: a judgement for another content hash is stale: nothing applies, not even floors, and no event', () => {
  const result = run({ start: [CONFIDENTIAL], floors: [guideFloor(SECRET)], judgement: judgement([SECRET], { 'ca-classified/Secret': 9000 }, 'e'.repeat(64)) });
  assert.equal(result.outcome, 'stale');
  assert.deepEqual(result.applied, [CONFIDENTIAL]);
  assert.deepEqual(result.events, []);
  assert.equal(result.notify, false);
});

test('a level with no threshold is at most a no-threshold suggestion; a mid-band probability suggests', () => {
  const noEntry = sectionWith({ thresholds: { 'ca-classified/Confidential': { costRatio: 9, recallTarget: 9500, secondFamily: false } } });
  const result = run({ start: [CONFIDENTIAL], section: noEntry, judgement: judgement([label('ca-classified', 'Top Secret')], { 'ca-classified/Top Secret': 9900 }) });
  assert.deepEqual(result.applied, [CONFIDENTIAL]);
  assert.equal(result.outcome, 'suggested');
  assert.deepEqual(reasons(result), ['no-threshold']);
  const band = run({ start: [CONFIDENTIAL], judgement: judgement([SECRET], { 'ca-classified/Secret': 300 }) });
  assert.equal(band.outcome, 'suggested');
  assert.deepEqual(reasons(band), ['band']);
});

test('a probability that is not whole basis points is refused, never clamped', () => {
  const result = decide({ start: [CONFIDENTIAL], current: CURRENT, floors: [], section: sectionWith(), scales: SCALE_PRESETS, judgement: judgement([SECRET], { 'ca-classified/Secret': 0.4 }) });
  assert.equal(result.ok ? '' : result.refusal, 'bad-probability');
});

test('D-13: a marking floor above the system-high is a possible spill: raised to the system-high with both flags, frozen and queued', () => {
  const section = sectionWith({ systemHigh: [label('ca-protected', 'Protected B')] });
  const result = run({ start: [label('ca-protected', 'Protected A')], section, floors: [{ label: SECRET, basis: { kind: 'marking', ref: 'banner-secret' } }] });
  assert.equal(result.outcome, 'possible-spill');
  assert.deepEqual(result.applied, [label('ca-protected', 'Protected B', { handling: ['local-only', 'no-agent-tools'] })]);
  assert.equal(result.freeze, true);
  assert.deepEqual(result.exceptions.map((entry) => entry.kind), ['possible-spill']);
  assert.ok(result.proposal.some((part) => part.label.level === 'Secret'), 'the predicted label is kept in the record');
  assert.ok(result.events.some((event) => event.event === 'label.exception-queued' && event.exception === 'possible-spill'));
});

test('D-13: a judgement above tau for Protected C on a Protected B system is a possible spill, even in shadow mode', () => {
  const section = sectionWith({ systemHigh: [label('ca-protected', 'Protected B')], shadow: { defaultMode: 'shadow' } });
  const result = run({ start: [PB], section, judgement: judgement([label('ca-protected', 'Protected C', { releasability: ['CAN', 'GBR'] })], { 'ca-protected/Protected C': 2000 }) });
  assert.equal(result.outcome, 'possible-spill');
  assert.equal(result.freeze, true);
  assert.deepEqual(result.applied[0]?.handling, ['local-only', 'no-agent-tools']);
  assert.equal(result.applied[0]?.level, 'Protected B');
});

test('no systemHigh, no spill; an approved mapping covers a label on another scale', () => {
  const none = run({ start: [CONFIDENTIAL], floors: [guideFloor(label('ca-classified', 'Top Secret'))] });
  assert.equal(none.outcome, 'auto-raised');
  const section = sectionWith({ systemHigh: [label('ca-classified', 'Secret')] });
  const mappings = [{ from: { scale: 'ca-classified', level: 'Confidential' }, covers: { scale: 'ca-protected', level: 'Protected C' } }];
  assert.equal(withinSystemHigh(label('ca-protected', 'Protected B'), section, SCALE_PRESETS, mappings), true);
  assert.equal(withinSystemHigh(label('ca-protected', 'Protected B'), section, SCALE_PRESETS, []), false);
  const mapped = run({ start: [CONFIDENTIAL], section, mappings, floors: [guideFloor(label('ca-protected', 'Protected B'))] });
  assert.equal(mapped.outcome, 'auto-raised');
});
