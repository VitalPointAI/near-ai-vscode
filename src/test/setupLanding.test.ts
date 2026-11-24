import assert from 'node:assert/strict';
import test from 'node:test';
import { KIND_OF_WORK_ANSWERS, fillSlots } from '../domain/setup/answers';
import { EXERCISE_REASON_TEXT, exerciseFor, isLanding, LANDING_TARGETS, NO_SECTION_TEMPLATE_TEXT, resolveLanding } from '../domain/setup/landing';
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

test('D-50: each work-area kind lands on its own workbench page with its checklist', () => {
  for (const [kind, workArea, checklist] of [
    ['planning', 'planning', ['share-with-people', 'my-computers']],
    ['capability-development', 'capability-development', ['share-with-people']],
    ['resource-management', 'resources', ['share-with-people']],
    ['exercises-training', 'training', ['share-with-people']]
  ] as const) {
    const landing = resolveLanding({ ...ready, kind });
    assert.deepEqual(landing, { target: 'work-area', workArea, checklist });
    assert.ok(isLanding(landing));
    // The first-run and administrator rules still come first.
    assert.equal(resolveLanding({ ...ready, kind, firstRun: { allowedModel: false } }).target, 'get-started-options');
    assert.equal(resolveLanding({ ...ready, kind, isAdmin: true, proposalsOpened: true }).target, 'policy-editor');
  }
});

test('D-50: Get Started and work areas are landing targets, and a work-area landing must name its page', () => {
  assert.ok(LANDING_TARGETS.includes('get-started'));
  assert.ok(LANDING_TARGETS.includes('work-area'));
  assert.equal(isLanding({ target: 'work-area', checklist: [] }), false);
  assert.equal(isLanding({ target: 'work-area', workArea: 'operations', checklist: [] }), false);
  assert.equal(isLanding({ target: 'work-area', workArea: 'planning', checklist: ['my-computers'] }), true);
  assert.equal(isLanding({ target: 'chat', checklist: ['spending-limit'] }), true);
  assert.equal(isLanding({ target: 'chat', workArea: 'planning', checklist: [] }), false);
  assert.equal(isLanding({ target: 'get-started', checklist: [] }), true);
  for (const value of [
    null, 'chat', { target: 'nowhere', checklist: [] }, { target: 'chat' }, { target: 'chat', checklist: ['not-a-step'] },
    { target: 'chat', checklist: [], extra: true }
  ]) assert.equal(isLanding(value), false, JSON.stringify(value));
  for (const kind of [...KIND_OF_WORK_ANSWERS, undefined]) {
    for (const staffSection of [undefined, 'j2', 'j6']) assert.ok(isLanding(resolveLanding({ ...ready, kind, staffSection })), String(kind));
  }
});

test('D-22, D-50: planning follows the staff exercise rule; capability development does not', () => {
  assert.deepEqual(exerciseFor({ kind: 'planning', operationalApproved: false }), { exercise: true, reason: EXERCISE_REASON_TEXT });
  assert.deepEqual(exerciseFor({ kind: 'planning', operationalApproved: true }), { exercise: false });
  assert.deepEqual(exerciseFor({ kind: 'capability-development', operationalApproved: false }), { exercise: false });
});

test('D-22: exercise', () => {
  assert.deepEqual(exerciseFor({ kind: 'staff', operationalApproved: false }), {
    exercise: true, reason: EXERCISE_REASON_TEXT
  });
  assert.deepEqual(exerciseFor({ kind: 'staff', operationalApproved: true }), { exercise: false });
  // D-50 extends the rule to planning (tested above); every other kind stays outside it.
  for (const kind of [...KIND_OF_WORK_ANSWERS.filter((kind) => kind !== 'staff' && kind !== 'planning'), undefined]) {
    assert.deepEqual(exerciseFor({ kind, operationalApproved: false }), { exercise: false });
  }
});
