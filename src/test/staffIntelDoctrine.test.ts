// The intelligence terms in doctrine.ts (design 10, 3.2 and 4.4; research note 02, tables 2, 6 and 10; WP-J2): the preparation steps per process, the
// intelligence process per profile, the ICD 203 likelihood scale and standards, and the two grading scales, kept apart.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ICD203_ANALYTIC_STANDARDS, ICD203_CONFIDENCE_LEVELS, ICD203_LIKELIHOOD, ICD203_TRADECRAFT_STANDARDS, INFORMATION_CREDIBILITY, INFORMATION_CREDIBILITY_GRADES, INTELLIGENCE_PREPARATION_STEPS,
  INTELLIGENCE_TERMS, SOURCE_RELIABILITY_GRADES, STAFF_PROCESSES, STAFF_PROFILE_IDS
} from '../domain/staff/doctrine';

test('every process names its preparation and steps: JIPOE (four US, three NATO), IPOE for the US Army, IPB for APP-28', () => {
  assert.deepEqual(Object.fromEntries(Object.values(STAFF_PROCESSES).map((process) => [process.id, process.intelligencePreparation])),
    { jpp: 'JIPOE', mdmp: 'IPOE', 'ajp-5': 'JIPOE', 'app-28': 'IPB' });
  for (const process of Object.values(STAFF_PROCESSES)) {
    const prep = INTELLIGENCE_PREPARATION_STEPS[process.id];
    assert.ok(prep, `${process.id} has preparation steps`);
    // The environment steps come first, then one step evaluating the other side and one for its courses of action.
    assert.equal(prep.steps.length, prep.environmentSteps + 2, process.id);
    assert.ok(prep.source.trim(), `${process.id} cites its source`);
  }
  assert.equal(INTELLIGENCE_PREPARATION_STEPS.jpp.steps.length, 4);
  assert.equal(INTELLIGENCE_PREPARATION_STEPS.jpp.actor, 'adversary');
  assert.equal(INTELLIGENCE_PREPARATION_STEPS.mdmp.actor, 'threat');
  assert.match(INTELLIGENCE_PREPARATION_STEPS.mdmp.steps[2], /threat/);
  assert.deepEqual(INTELLIGENCE_PREPARATION_STEPS.mdmp.steps, INTELLIGENCE_PREPARATION_STEPS['app-28'].steps, 'IPOE keeps the four IPB steps');
  // NATO JIPOE (AJP-10.1, 2023): three steps on the operating environment.
  assert.deepEqual(INTELLIGENCE_PREPARATION_STEPS['ajp-5'].steps, ['Describe and evaluate the operating environment', 'Evaluate actors in the operating environment', 'Determine actor courses of action']);
  assert.equal(INTELLIGENCE_PREPARATION_STEPS['ajp-5'].environment, 'operating environment');
});

test('the intelligence process follows the profile: six joint categories, the six Army steps with no continuing activities, the four-stage NATO cycle', () => {
  assert.equal(INTELLIGENCE_TERMS['us-joint'].process.stages.length, 6);
  assert.equal(INTELLIGENCE_TERMS['us-joint'].process.stages[5], 'Evaluation and feedback');
  assert.deepEqual(INTELLIGENCE_TERMS['nato-ca'].process.stages, ['Direction', 'Collection', 'Processing', 'Dissemination']);
  assert.deepEqual(INTELLIGENCE_TERMS['us-army'].process.stages,
    ['Plan and direct', 'Collect', 'Process and exploit', 'Analyze and produce', 'Disseminate and integrate', 'Evaluate and provide feedback']);
  assert.equal(INTELLIGENCE_TERMS['us-army'].process.continuing, undefined);
  assert.equal(INTELLIGENCE_TERMS['us-army'].collectionPlan, 'Information collection plan');
  assert.match(INTELLIGENCE_TERMS['nato-ca'].nationRequirementsManagement!.ca!, /^CCIRM/);
  assert.match(INTELLIGENCE_TERMS['us-joint'].estimatePlacement!, /Appendix 11 to Annex B/);
  for (const id of STAFF_PROFILE_IDS) assert.ok(INTELLIGENCE_TERMS[id].source.trim(), `${id} cites its sources`);
});

test('the ICD 203 likelihood scale runs from 1 to 99 percent with no gap, and the standards are five and nine', () => {
  assert.equal(ICD203_LIKELIHOOD.length, 7);
  assert.equal(ICD203_LIKELIHOOD[0].range[0], 1);
  assert.equal(ICD203_LIKELIHOOD[ICD203_LIKELIHOOD.length - 1].range[1], 99);
  for (let index = 1; index < ICD203_LIKELIHOOD.length; index += 1) assert.equal(ICD203_LIKELIHOOD[index].range[0], ICD203_LIKELIHOOD[index - 1].range[1], 'ranges meet');
  assert.deepEqual(ICD203_LIKELIHOOD.find((entry) => entry.term === 'likely'), { term: 'likely', alternative: 'probable', forms: ['probably'], range: [55, 80] });
  assert.equal(ICD203_ANALYTIC_STANDARDS.length, 5);
  assert.equal(ICD203_TRADECRAFT_STANDARDS.length, 9);
  assert.deepEqual(ICD203_CONFIDENCE_LEVELS, ['high', 'moderate', 'low']);
});

test('reliability (A to F) and credibility (1 to 6) are two scales, and grade 1 reads as the profile\'s grading table says', () => {
  assert.deepEqual([...SOURCE_RELIABILITY_GRADES], ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.deepEqual([...INFORMATION_CREDIBILITY_GRADES], [1, 2, 3, 4, 5, 6]);
  assert.equal(INTELLIGENCE_TERMS['nato-ca'].credibilityOne, 'Confirmed by other sources');
  assert.equal(INTELLIGENCE_TERMS['us-army'].credibilityOne, 'Confirmed');
  assert.equal(INTELLIGENCE_TERMS['us-joint'].credibilityOne, 'Confirmed by other sources');
  assert.equal(INFORMATION_CREDIBILITY[1], 'Confirmed by other sources', 'the NATO table reads grade 1 as confirmed, never "completely credible"');
});
