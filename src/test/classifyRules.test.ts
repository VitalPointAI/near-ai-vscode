// Guide and compilation rules over typed facts, the session's running fact set and code words (Phase 70.1 plan 03 Task 2; D-06, D-16, D-18).
// Fictional content only: NORTHERNEXAMPLE is an invented code word, Exercise NORTHERN EXAMPLE an invented exercise.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClassificationSection } from '../domain/gate/classificationSection';
import type { ClassificationSection } from '../domain/gate/classificationSection';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import { BASE_FACT_TYPES, SESSION_FACT_CAP, addFacts, factTypesOf } from '../domain/classify/facts';
import type { SessionFact } from '../domain/classify/facts';
import { markingFloors } from '../domain/classify/markings';
import { RULE_SCOPES, evaluateRules, ruleFires } from '../domain/classify/rules';

function label(scale: string, level: string): Label {
  return { scale, level, compartments: [], releasability: [], handling: [] };
}

const SECRET = label('ca-classified', 'Secret');

function section(): ClassificationSection {
  const rule = {
    id: 'scg-4.2', guideRef: 'SCG 4.2', label: label('ca-classified', 'Confidential'), description: 'A unit with its location and a future move date',
    when: { allOf: ['future-date', 'location', 'unit'], sameSubject: true }, then: SECRET
  };
  const parsed = parseClassificationSection({
    v: 1,
    guideRules: [rule],
    compilationRules: [{ ...rule, id: 'comp-9.1', guideRef: 'SCG 9.1', description: 'A unit, a location and a future date, together', when: { allOf: ['future-date', 'location', 'unit'] } }],
    codeWords: { listLabel: SECRET, entries: [{ id: 'cw-1', token: 'NORTHERNEXAMPLE', label: SECRET }] },
    factTypes: ['convoy-route']
  }, SCALE_PRESETS);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.value;
}

const guideOnly = (value: ClassificationSection): Pick<ClassificationSection, 'guideRules' | 'compilationRules'> => ({ guideRules: value.guideRules, compilationRules: [] });

test('the base fact types are re-exported from the section module, and a section adds its own', () => {
  assert.equal(BASE_FACT_TYPES.length, 11);
  assert.deepEqual(factTypesOf(section()).slice(-1), ['convoy-route']);
  assert.deepEqual([...RULE_SCOPES], ['item', 'session']);
});

test('a guide rule with sameSubject fires when unit, location and future-date name one subject, with a guide basis naming the rule id', () => {
  const facts = [{ type: 'unit', subject: 's1' }, { type: 'location', subject: 's1' }, { type: 'future-date', subject: 's1' }];
  assert.deepEqual(evaluateRules(facts, guideOnly(section()), 'item'), [{ label: SECRET, basis: { kind: 'guide', ref: 'scg-4.2' } }]);
});

test('the same rule does not fire when the location names another subject', () => {
  const facts = [{ type: 'unit', subject: 's1' }, { type: 'location', subject: 's2' }, { type: 'future-date', subject: 's1' }];
  assert.deepEqual(evaluateRules(facts, guideOnly(section()), 'item'), []);
});

test('a rule without sameSubject fires on the types alone; a missing type stops it', () => {
  const rule = section().compilationRules[0]!;
  assert.equal(ruleFires(rule, [{ type: 'unit', subject: 's1' }, { type: 'location', subject: 's2' }, { type: 'future-date' }]), true);
  assert.equal(ruleFires(rule, [{ type: 'unit' }, { type: 'location' }]), false);
});

test('in the session scope only compilation rules run, with a compilation basis', () => {
  const facts = [{ type: 'unit', subject: 's1' }, { type: 'location', subject: 's1' }, { type: 'future-date', subject: 's1' }];
  assert.deepEqual(evaluateRules(facts, section(), 'session'), [{ label: SECRET, basis: { kind: 'compilation', ref: 'comp-9.1' } }]);
  assert.deepEqual(evaluateRules(facts, section(), 'item').map((floor) => floor.basis.kind), ['guide', 'compilation']);
});

test('a compilation spread over three items fires only when the third item\'s fact joins the session set', () => {
  const value = section();
  let session: readonly SessionFact[] = [];
  const items = [['item-1', 'unit'], ['item-2', 'location'], ['item-3', 'future-date']] as const;
  const fired: number[] = [];
  items.forEach(([item, type], index) => {
    const itemFacts = [{ type, subject: 's1' }];
    assert.deepEqual(evaluateRules(itemFacts, value, 'item'), [], 'no one item fires anything');
    const added = addFacts(session, itemFacts, item);
    assert.ok(added.ok);
    if (!added.ok) return;
    session = added.value.facts;
    if (evaluateRules(session, value, 'session').length > 0) fired.push(index);
  });
  assert.deepEqual(fired, [2]);
  assert.deepEqual(session, [{ type: 'unit', subject: 's1', item: 'item-1' }, { type: 'location', subject: 's1', item: 'item-2' }, { type: 'future-date', subject: 's1', item: 'item-3' }]);
});

test('addFacts never stores a value: any key other than type, subject and item is refused', () => {
  for (const extra of [{ value: '1 Example Brigade' }, { text: 'x' }, { clearance: 'Secret' }]) {
    const result = addFacts([], [{ type: 'unit', subject: 's1', ...extra }]);
    assert.equal(result.ok, false, Object.keys(extra)[0]);
  }
  const spaced = addFacts([], [{ type: 'unit', subject: '1 Example Brigade' }]);
  assert.equal(spaced.ok ? '' : spaced.reason, 'wrong-type', 'a subject is an opaque key, never the value');
});

test('addFacts keeps one copy of a repeated fact and returns a new set', () => {
  const first = addFacts([], [{ type: 'unit', subject: 's1' }, { type: 'unit', subject: 's1' }], 'item-1');
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.equal(first.value.facts.length, 1);
  const again = addFacts(first.value.facts, [{ type: 'unit', subject: 's1' }], 'item-1');
  assert.ok(again.ok);
  if (again.ok) assert.equal(again.value.facts.length, 1);
  assert.ok(Object.isFrozen(first.value.facts));
});

test('at 4,096 facts addFacts returns the set unchanged with an aggregate-cap exception, never dropping a fact', () => {
  assert.equal(SESSION_FACT_CAP, 4096);
  const full = Array.from({ length: SESSION_FACT_CAP }, (_, index) => ({ type: 'unit', subject: `s${String(index)}` }));
  const result = addFacts(full, [{ type: 'location', subject: 'new' }]);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.exception, 'aggregate-cap');
  assert.equal(result.value.facts, full);
  const nothingNew = addFacts(full, [{ type: 'unit', subject: 's0' }]);
  assert.ok(nothingNew.ok && nothingNew.value.exception === undefined, 'a repeat adds nothing, so no cap');
});

test('markingFloors finds the code word NORTHERNEXAMPLE as a detector floor whose ref is the entry id, never the word', () => {
  const floors = markingFloors('Notes for Exercise NORTHERNEXAMPLE, phase two', section());
  assert.deepEqual(floors, [{ label: SECRET, basis: { kind: 'detector', ref: 'cw-1' } }]);
  assert.ok(!JSON.stringify(floors).includes('NORTHERNEXAMPLE'));
  assert.equal(markingFloors('northernexample in lower case', section()).length, 1, 'any case');
});

test('a near-miss code word does not match: a longer token, a token joined by an underscore, or a split word', () => {
  for (const text of ['NORTHERNEXAMPLES', 'NORTHERNEXAMPLE_2', 'XNORTHERNEXAMPLE', 'NORTHERN EXAMPLE']) assert.equal(markingFloors(text, section()).length, 0, text);
  assert.equal(markingFloors('(NORTHERNEXAMPLE)', section()).length, 1, 'punctuation is a boundary');
});

test('evaluateRules gives no floor for facts of types no rule names, and none at all with no rules', () => {
  assert.deepEqual(evaluateRules([{ type: 'capability' }, { type: 'convoy-route' }], section(), 'item'), []);
  assert.deepEqual(evaluateRules([{ type: 'unit' }], { guideRules: [], compilationRules: [] }, 'item'), []);
});
