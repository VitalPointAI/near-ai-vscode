import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GUIDE_COMMANDS, hostKindForEnvironment, MAX_CHECKLIST_ROWS, parseChecklistRows, parseGuideEnvironment, WORK_AREA_PAGE_FOR_KIND, WORK_AREA_PAGES
} from '../domain/setup/bridge';

test('D-46: one frozen list names every command between the extension and the Sterling workbench', () => {
  assert.deepEqual(GUIDE_COMMANDS, {
    open: 'nearAi.setup', message: 'nearAi.setup.message', closed: 'nearAi.setup.closed', checklist: 'nearAi.setup.checklist',
    show: 'sterling.setupGuide.show', post: 'sterling.setupGuide.post', environment: 'sterling.setupGuide.environment'
  });
  assert.ok(Object.isFrozen(GUIDE_COMMANDS));
});

test('D-49: the environment answer parses strictly', () => {
  assert.deepEqual(parseGuideEnvironment({ hosting: 'local', edition: 'ca-defence' }), { hosting: 'local', edition: 'ca-defence' });
  assert.deepEqual(parseGuideEnvironment({ hosting: 'hosted' }), { hosting: 'hosted' });
  for (const value of [
    { hosting: 'cloud' }, { hosting: 'local', edition: 'other' }, { hosting: 'local', extra: true }, {}, null, 'hosted', ['hosted'],
    { hosting: 'local', edition: 'x'.repeat(41) }, { hosting: 'h'.repeat(41) }, Object.create({ hosting: 'local' })
  ]) assert.equal(parseGuideEnvironment(value), 'invalid', JSON.stringify(value));
});

test('owner D7, D-49: a hosted, malformed or failed answer is hosted; no workbench keeps the host kind', () => {
  assert.equal(hostKindForEnvironment('invalid', 'desktop'), 'hosted');
  assert.equal(hostKindForEnvironment({ hosting: 'hosted' }, 'container'), 'hosted');
  assert.equal(hostKindForEnvironment(undefined, 'container'), 'container');
  assert.equal(hostKindForEnvironment({ hosting: 'local', edition: 'ca-defence' }, 'desktop'), 'desktop');
});

test('D-48: checklist rows parse with known shapes only', () => {
  const row = { id: 'share-with-people', title: 'Share with people', shown: true, done: false };
  assert.deepEqual(parseChecklistRows([row]), [row]);
  assert.deepEqual(parseChecklistRows(Array.from({ length: MAX_CHECKLIST_ROWS }, () => row)).length, MAX_CHECKLIST_ROWS);
  for (const value of [
    Array.from({ length: MAX_CHECKLIST_ROWS + 1 }, () => row), [{ ...row, id: 'Share' }], [{ ...row, id: 'a'.repeat(41) }],
    [{ ...row, title: 't'.repeat(81) }], [{ ...row, title: '' }], [{ ...row, shown: 'yes' }], [{ ...row, done: 1 }],
    [{ ...row, extra: true }], [{ id: row.id, title: row.title, shown: true }], { rows: [row] }, 'rows', null
  ]) assert.equal(parseChecklistRows(value), 'invalid', JSON.stringify(value));
});

test('D-50: each work-area kind names one workbench page', () => {
  assert.deepEqual(WORK_AREA_PAGES, ['capability-development', 'planning', 'resources', 'training']);
  assert.deepEqual(WORK_AREA_PAGE_FOR_KIND, {
    'capability-development': 'capability-development', planning: 'planning', 'resource-management': 'resources', 'exercises-training': 'training'
  });
});
