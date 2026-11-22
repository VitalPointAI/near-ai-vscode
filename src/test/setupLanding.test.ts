import assert from 'node:assert/strict';
import test from 'node:test';
import { KIND_OF_WORK_ANSWERS, fillSlots } from '../domain/setup/answers';
import { EXERCISE_REASON_TEXT, exerciseFor, NO_SECTION_TEMPLATE_TEXT, resolveLanding } from '../domain/setup/landing';
import { STAFF_TEAM_SECTIONS } from '../domain/staff/profiles';

const ready = { isAdmin: false, proposalsOpened: false, hasTeam: false, firstRun: { allowedModel: true } };

test('GUIDE 10: software', () => {
  const landing = resolveLanding({ ...ready, kind: 'software' });
  assert.deepEqual(landing, {
    target: 'chat', runFirst: 'software-team',
    checklist: ['spending-limit', 'secure-workflow', 'web-search', 'my-computers', 'share-with-people']
  });
  assert.deepEqual(resolveLanding({ ...ready, kind: 'software', hasTeam: true }), {
    target: 'chat', checklist: landing.checklist
  });
});

test('SC6 (data): staff J2', () => {
  for (const section of STAFF_TEAM_SECTIONS) {
    assert.deepEqual(resolveLanding({ ...ready, kind: 'staff', staffSection: section }), {
      target: 'staff-room', runFirst: 'staff-team', section, checklist: ['share-with-people', 'my-computers']
    });
  }
});

test('staff section without a template', () => {
  const landing = resolveLanding({ ...ready, kind: 'staff', staffSection: 'j6' });
  assert.deepEqual(landing, {
    target: 'staff-room', checklist: ['share-with-people', 'my-computers'],
    note: fillSlots(NO_SECTION_TEMPLATE_TEXT, { section: 'J6' })
  });
  assert.deepEqual(resolveLanding({ ...ready, kind: 'staff' }), {
    target: 'staff-room', checklist: landing.checklist
  });
});

test('analysis, capital projects, writing, something else', () => {
  for (const [kind, checklist] of [
    ['analysis', ['data-connections']],
    ['capital-projects', ['share-with-people']],
    ['writing', ['spending-limit', 'my-computers']],
    ['something-else', ['spending-limit', 'my-computers']],
    [undefined, ['spending-limit', 'my-computers']]
  ] as const) {
    assert.deepEqual(resolveLanding({ ...ready, kind }), { target: 'chat', checklist });
  }
});

test('administrator with proposals', () => {
  assert.deepEqual(resolveLanding({ ...ready, kind: 'staff', isAdmin: true, proposalsOpened: true }), {
    target: 'policy-editor', checklist: ['policy']
  });
  assert.equal(resolveLanding({ ...ready, kind: 'staff', isAdmin: true }).target, 'staff-room');
  assert.equal(resolveLanding({ ...ready, kind: 'staff', proposalsOpened: true }).target, 'staff-room');
});

test('D-22: first-run guarantee', () => {
  for (const kind of [...KIND_OF_WORK_ANSWERS, undefined]) {
    assert.deepEqual(resolveLanding({
      ...ready, kind, staffSection: 'j2', isAdmin: true, proposalsOpened: true, firstRun: { allowedModel: false }
    }), { target: 'get-started-options', checklist: [] });
  }
});

test('D-22: exercise', () => {
  assert.deepEqual(exerciseFor({ kind: 'staff', operationalApproved: false }), {
    exercise: true, reason: EXERCISE_REASON_TEXT
  });
  assert.deepEqual(exerciseFor({ kind: 'staff', operationalApproved: true }), { exercise: false });
  for (const kind of [...KIND_OF_WORK_ANSWERS.filter((kind) => kind !== 'staff'), undefined]) {
    assert.deepEqual(exerciseFor({ kind, operationalApproved: false }), { exercise: false });
  }
});
