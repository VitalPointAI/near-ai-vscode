// The J5 planning terms in the doctrine data (design 10, 2.6 and 3.3; WP-J5): every COA test a profile lists has a plain meaning, the operational
// design method has its eight 2025 steps, US Joint never says "military end state", MDO is offered only under US Army, every process has a design
// approach, and the red team is optional only under NATO/Canadian.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COA_TEST_MEANINGS, COG_TERMS, DESIGN_APPROACHES, DOCTRINE_PROFILES, END_STATE_TERMS, J5_PROFILE_GATES, MDO_TERMS, OPERATIONAL_DESIGN_ELEMENTS,
  OPERATIONAL_DESIGN_METHOD, RED_TEAM_NOTES, STAFF_PROCESS_IDS, STAFF_PROFILE_IDS
} from '../domain/staff/doctrine';

test('every COA test of every profile has a plain meaning, and the US Joint tests are the 2025 SFA-DC list', () => {
  for (const id of STAFF_PROFILE_IDS) {
    for (const name of DOCTRINE_PROFILES[id].coaTests) assert.ok(COA_TEST_MEANINGS[name]?.trim(), `${id}: ${name} has a meaning`);
  }
  assert.deepEqual(DOCTRINE_PROFILES['us-joint'].coaTests, ['Suitable', 'Feasible', 'Acceptable', 'Distinguishable', 'Complete']);
  assert.ok(!Object.keys(COA_TEST_MEANINGS).includes('Adequate'), 'the 2020 "adequate" test is gone');
});

test('operational design follows JP 5-0 (2025): eight method steps and five groups of elements, with no military end state element', () => {
  assert.equal(OPERATIONAL_DESIGN_METHOD.length, 8);
  assert.equal(OPERATIONAL_DESIGN_METHOD[3], 'Identify assumptions');
  assert.deepEqual(OPERATIONAL_DESIGN_ELEMENTS.map((group) => group.group), ['Overarching', 'Organizing the operation', 'Time', 'Forces and functions', 'Balancing']);
  assert.ok(!OPERATIONAL_DESIGN_ELEMENTS.flatMap((group) => group.elements).some((element) => /end state/i.test(element)));
  assert.equal(END_STATE_TERMS['us-joint'].usesMilitaryEndState, false);
  assert.doesNotMatch(END_STATE_TERMS['us-joint'].term, /end state/i);
  assert.equal(END_STATE_TERMS['us-army'].usesMilitaryEndState, true);
  assert.equal(END_STATE_TERMS['nato-ca'].usesMilitaryEndState, true);
});

test('every process has a design approach, every profile its COG spelling, gates and red team note', () => {
  for (const process of STAFF_PROCESS_IDS) assert.ok(DESIGN_APPROACHES[process].name && DESIGN_APPROACHES[process].source, process);
  assert.equal(COG_TERMS['nato-ca'].cog, 'Centre of gravity');
  assert.equal(COG_TERMS['us-joint'].cog, 'Center of gravity');
  for (const id of STAFF_PROFILE_IDS) {
    assert.ok(J5_PROFILE_GATES[id].afterCoaDevelopment);
    assert.ok(RED_TEAM_NOTES[id].note);
  }
  assert.ok(J5_PROFILE_GATES['nato-ca'].beforeFullPlan, 'NATO/Canadian approves the CONOPS before the full plan');
  assert.deepEqual(STAFF_PROFILE_IDS.filter((id) => RED_TEAM_NOTES[id].optional), ['nato-ca']);
  assert.deepEqual([...MDO_TERMS.profiles], ['us-army']);
});
