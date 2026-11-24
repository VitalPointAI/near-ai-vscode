import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCALE_PRESETS, type Label } from '../domain/gate/labels';
import { changeList, remainingAfter, rerunDiff, type ChangeInput, type ChangeItem } from '../domain/setup/changes';
import { EXERCISE_REASON_TEXT, exerciseFor } from '../domain/setup/landing';
import { raiseOnly } from '../domain/setup/map';
import { modeRowOf } from '../domain/setup/modes';
import { KEPT_HIGHER_TEXT, LOWERING_SEPARATE_TEXT } from '../domain/setup/words';

const internal: Label = { scale: 'org', level: 'Internal', compartments: [], releasability: [], handling: [] };
const protectedB: Label = { ...internal, scale: 'ca-protected', level: 'Protected B' };
const output = (proposed: Label) => ({ proposed, column: 'ca' as const, notSure: false, allowedWhileStopped: [] });
const input: ChangeInput = {
  current: { label: internal, mode: 'corporate' }, proposal: raiseOnly(internal, output(protectedB), SCALE_PRESETS),
  chosen: ['near-private'], mode: { mode: 'corporate', source: 'suggested', changeable: true, choices: ['corporate'] },
  exercise: { exercise: false }, canada: 'no', residencyBySetting: 'project',
  clearances: [protectedB], dominance: { scales: SCALE_PRESETS, mappings: [], now: 0 },
  shared: false, proposals: [], scales: SCALE_PRESETS,
};

function find(items: readonly ChangeItem[], id: string): ChangeItem {
  const item = items.find((entry) => entry.id === id);
  assert.ok(item, `Expected change ${id}`);
  return item;
}

test('D-18: groups', () => {
  const items = changeList(input);
  assert.equal(find(items, 'label').text, 'Project label: raised from Organization: Internal to Canada, Protected: Protected B.');
  assert.equal(find(items, 'label').group, 'changed');
  assert.equal(find(items, 'connection:near-private').group, 'added');
  assert.ok(items.every((row) => row.group !== 'removed'));
});

test('GUIDE 8.4: never lower', () => {
  const lower = { ...input, current: { ...input.current, label: protectedB }, chosen: [],
    proposal: raiseOnly(protectedB, output(internal), SCALE_PRESETS) };
  const kept = find(changeList(lower), 'label');
  assert.equal(kept.effect, 'kept');
  assert.equal(kept.text, KEPT_HIGHER_TEXT.replace('{label}', 'Canada, Protected: Protected B'));
  const separate = find(changeList({ ...lower, requestedLabel: internal }), 'label');
  assert.equal(separate.effect, 'waits');
  assert.equal(separate.waitsFor, 'lower-label-flow');
  assert.equal(separate.text, LOWERING_SEPARATE_TEXT);
  const forgedRaise = { ...lower, proposal: { ...lower.proposal, proposed: internal, outcome: 'raise' as const } };
  assert.equal(find(changeList(forgedRaise), 'label').waitsFor, 'lower-label-flow');
});

test('D-33, F5: clearance gap', () => {
  const items = changeList({ ...input, clearances: [{ ...internal, level: 'Restricted' }] });
  const proposal = find(items, 'your-rules:clearance');
  assert.equal(proposal.text, 'Your rules: add your clearance for Canada, Protected: Protected B (declared by you)');
  assert.equal(proposal.effect, 'proposal');
  assert.equal(find(items, 'label').waitsFor, 'rules-change');
  assert.equal(find(items, 'label').effect, 'waits');
  assert.equal(find(changeList(input), 'label').effect, 'apply');
});

test('F5, 32.1-11: under your organization a clearance gap names the contact and opens no proposal', () => {
  const items = changeList({ ...input, clearances: [{ ...internal, level: 'Restricted' }], clearanceContact: 'Security desk {label}' });
  assert.ok(!items.some(({ id }) => id === 'your-rules:clearance'));
  const ask = find(items, 'your-rules:clearance-contact');
  assert.equal(ask.text, "Your organization's rules: ask Security desk {label} to add your clearance for Canada, Protected: Protected B.");
  assert.equal(ask.effect, 'waits');
  assert.equal(ask.waitsFor, 'rules-change');
  assert.equal(find(items, 'label').effect, 'waits');
  // A clearance that covers the label needs no contact.
  assert.ok(!changeList({ ...input, clearanceContact: 'Security desk' }).some(({ area }) => area === 'your-rules'));
});

test('D-34: project rules', () => {
  const add = find(changeList({ ...input, canada: 'yes' }), 'project-rules');
  assert.equal(add.text, 'This project: work must stay in Canada.');
  assert.equal(add.effect, 'apply');
  const kept = find(changeList({ ...input, canada: 'yes', residencyBySetting: 'already' }), 'project-rules');
  assert.equal(kept.effect, 'kept');
  assert.match(kept.text, /your organization/);
  assert.equal(changeList({ ...input, canada: 'no', current: { ...input.current, residency: ['CA'] } })
    .some(({ id, group }) => id === 'project-rules' && group === 'removed'), false);
});

test('D-28, D-22: mode and exercise', () => {
  const mode = { ...input.mode, mode: 'military' as const };
  const items = changeList({ ...input, mode, exercise: exerciseFor({ kind: 'staff', operationalApproved: false }) });
  assert.match(find(items, 'mode').text, new RegExp(modeRowOf(mode).join));
  assert.equal(find(items, 'exercise').text, EXERCISE_REASON_TEXT);
  const retained = find(changeList({ ...input, current: { ...input.current, exercise: true } }), 'exercise');
  assert.equal(retained.effect, 'kept');
});

test('D-21: shared', () => {
  const items = changeList({ ...input, shared: true, canada: 'yes',
    mode: { ...input.mode, mode: 'military' }, exercise: { exercise: true } });
  for (const id of ['label', 'mode', 'exercise', 'project-rules', 'answers']) {
    assert.equal(find(items, id).effect, 'waits');
    assert.equal(find(items, id).waitsFor, 'shared-project');
  }
  assert.equal(find(items, 'connection:near-private').effect, 'apply');
});

test('re-run differences', () => {
  const items = changeList({ ...input, canada: 'yes', current: { label: protectedB, mode: 'corporate', residency: ['CA'], connection: 'near-private' },
    proposal: raiseOnly(protectedB, output(protectedB), SCALE_PRESETS) });
  const previous = { v: 1 as const, answers: { data: [], canada: 'yes' as const }, chosen: ['near-private'], pending: [], appliedAt: 'prior' };
  assert.deepEqual(rerunDiff(previous, items), []);
  const changed = changeList(input);
  assert.deepEqual(rerunDiff(previous, changed).map(({ id }) => id), ['label', 'connection:near-private', 'answers']);
});

test('partly applied', () => {
  const items = changeList({ ...input, canada: 'yes' });
  const remaining = remainingAfter({ state: 'partly-applied', steps: [
    { id: 'label', outcome: 'failed' }, { id: 'connection:near-private', outcome: 'done' },
    { id: 'project-rules', outcome: 'waiting' }, { id: 'answers', outcome: 'already-done' },
  ] }, items);
  assert.deepEqual(remaining.map(({ id }) => id), ['label', 'project-rules']);
});

test('owner D13: an earlier answer', () => {
  const earlier = find(changeList({ ...input, earlierLocality: 'local' }), 'earlier-locality');
  assert.equal(earlier.area, 'answers');
  assert.equal(earlier.effect, 'kept');
  assert.equal(earlier.text, 'Your earlier answer: local AI only. It no longer decides where requests go.');
  assert.equal(changeList(input).some(({ id }) => id === 'earlier-locality'), false);
});

test('removed providers ask first', () => {
  const item = find(changeList({ ...input, current: { ...input.current, connection: 'this-computer' } }), 'connection:this-computer');
  assert.equal(item.group, 'removed');
  assert.match(item.text, /this computer/);
  assert.match(item.text, /stop working/);
});

test('rule requests are proposals and cannot become project writes', () => {
  const item = find(changeList({ ...input, shared: true, proposals: [{ id: 'server', text: 'Ask to add the server.' }] }), 'your-rules:server');
  assert.equal(item.area, 'your-rules');
  assert.equal(item.effect, 'proposal');
});
