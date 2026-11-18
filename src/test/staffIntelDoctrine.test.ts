// The intelligence terms in doctrine.ts (design 10, 3.2 and 4.4; research note 02, tables 2, 6 and 10; WP-J2): the preparation steps per process, the
// intelligence process per profile, the ICD 203 likelihood scale and standards, and the two grading scales, kept apart.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ICD203_ANALYTIC_STANDARDS, ICD203_CONFIDENCE_LEVELS, ICD203_LIKELIHOOD, ICD203_TRADECRAFT_STANDARDS, INFORMATION_CREDIBILITY_GRADES, INTELLIGENCE_PREPARATION_STEPS,
  INTELLIGENCE_TERMS, SOURCE_RELIABILITY_GRADES, STAFF_PROCESSES, STAFF_PROFILE_IDS
} from '../domain/staff/doctrine';

test('every process names a preparation with four steps: JIPOE at joint levels evaluates the adversary, IPB at tactical level the threat', () => {
  for (const process of Object.values(STAFF_PROCESSES)) {
    const prep = INTELLIGENCE_PREPARATION_STEPS[process.intelligencePreparation as 'JIPOE' | 'IPB'];
    assert.ok(prep, `${process.id} names a known preparation`);
    assert.equal(prep.steps.length, 4);
  }
  assert.equal(INTELLIGENCE_PREPARATION_STEPS.JIPOE.actor, 'adversary');
  assert.equal(INTELLIGENCE_PREPARATION_STEPS.IPB.actor, 'threat');
  assert.match(INTELLIGENCE_PREPARATION_STEPS.IPB.steps[2], /threat/);
});

test('the intelligence process follows the profile: six joint categories, the Army process, the four-stage NATO cycle', () => {
  assert.equal(INTELLIGENCE_TERMS['us-joint'].process.stages.length, 6);
  assert.equal(INTELLIGENCE_TERMS['us-joint'].process.stages[5], 'Evaluation and feedback');
  assert.deepEqual(INTELLIGENCE_TERMS['nato-ca'].process.stages, ['Direction', 'Collection', 'Processing', 'Dissemination']);
  assert.deepEqual(INTELLIGENCE_TERMS['us-army'].process.continuing, ['Analyze', 'Assess']);
  assert.equal(INTELLIGENCE_TERMS['us-army'].collectionPlan, 'Information collection plan');
  assert.match(INTELLIGENCE_TERMS['nato-ca'].nationRequirementsManagement!.ca!, /^CCIRM/);
  assert.match(INTELLIGENCE_TERMS['us-joint'].estimatePlacement!, /Appendix 11 to Annex B/);
  for (const id of STAFF_PROFILE_IDS) assert.ok(INTELLIGENCE_TERMS[id].source.trim(), `${id} cites its sources`);
});

test('the ICD 203 likelihood scale runs from 1 to 99 percent with no gap, and the standards are five and nine', () => {
  assert.equal(ICD203_LIKELIHOOD.length, 7);
  assert.equal(ICD203_LIKELIHOOD[0].low, 1);
  assert.equal(ICD203_LIKELIHOOD[ICD203_LIKELIHOOD.length - 1].high, 99);
  for (let index = 1; index < ICD203_LIKELIHOOD.length; index += 1) assert.equal(ICD203_LIKELIHOOD[index].low, ICD203_LIKELIHOOD[index - 1].high, 'ranges meet');
  assert.deepEqual(ICD203_LIKELIHOOD.find((entry) => entry.term === 'likely'), { term: 'likely', alternative: 'probable', low: 55, high: 80 });
  assert.equal(ICD203_ANALYTIC_STANDARDS.length, 5);
  assert.equal(ICD203_TRADECRAFT_STANDARDS.length, 9);
  assert.deepEqual(ICD203_CONFIDENCE_LEVELS, ['high', 'moderate', 'low']);
});

test('reliability (A to F) and credibility (1 to 6) are two scales, and grade 1 reads as the profile\'s grading table says', () => {
  assert.deepEqual(SOURCE_RELIABILITY_GRADES.map((entry) => entry.grade), ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.deepEqual(INFORMATION_CREDIBILITY_GRADES.map((entry) => entry.grade), ['2', '3', '4', '5', '6']);
  assert.equal(INTELLIGENCE_TERMS['nato-ca'].credibilityOne, 'Completely credible');
  assert.equal(INTELLIGENCE_TERMS['us-joint'].credibilityOne, 'Confirmed by other sources');
});
