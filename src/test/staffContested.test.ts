import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductVersions, VersionAct, VersionView } from '../domain/replica/versions';
import { changesSinceRows, contestedCards, pendingConfirmation } from '../staff/replica/contested';

const roles = { owner: 'planner', sectionLead: 'section-lead', releaseGuard: 'guard' };
const approve: VersionAct = {
  kind: 'version.decide', entry: 'approved', position: 0, writer: 'device-a', member: 'member-a', actor: { kind: 'person' },
  roster: 'old-roster', data: { outcome: 'approve', reasons: ['The allocation is ready.'] }
};
const reject: VersionAct = {
  ...approve, entry: 'rejected', position: 1, writer: 'device-b', member: 'member-b', roster: 'new-roster',
  data: { outcome: 'reject', reasons: ['Support is unavailable.', 'Check the next rotation.'] }
};

function version(overrides: Partial<VersionView> = {}): VersionView {
  return {
    number: 5, hash: 'version-hash', entry: 'proposal', state: 'awaiting-decision', proposedAtSameTimeAs: [], changesSince: 37,
    othersChangesSince: 20, ownerPromptDue: true, pins: [], header: {}, attribution: [], sourceChanged: [],
    decision: { status: 'none', names: [], contested: [], effective: [], pending: [], held: [], finalBeforeDispute: false },
    decisionsSinceCheckpoint: [], ...overrides
  };
}

function product(view: VersionView, acts: VersionAct[] = []): ProductVersions {
  return {
    stream: 'product-stream', product: 'estimate', section: 'j4', title: 'Logistics estimate', roles, versions: [view],
    records: [{ number: view.number, hash: view.hash, entry: view.entry, roles, acts,
      release: { product: 'estimate', section: 'j4', roles, state: view.state, version: view.number, hash: view.hash } }],
    refusals: [], working: view.state === 'withdrawn' ? 'withdrawn' : 'open'
  };
}

function contested(acts = [approve, reject]): ProductVersions {
  const view = version();
  view.decision = { ...view.decision, status: 'contested', contested: [approve.entry, reject.entry] };
  return product(view, acts);
}

test('contested cards show both people, reasons and decision actions', () => {
  const [card] = contestedCards([contested()], (member, roster) =>
    member === 'member-a' && roster === 'old-roster' ? 'Morgan' : member === 'member-b' && roster === 'new-roster' ? 'Taylor' : undefined);
  assert.equal(card.text, 'Contested: Morgan approved v5 and Taylor rejected it at the same time. Neither applies. A new decision is needed.');
  assert.deepEqual(card.decisions, [
    { name: 'Morgan', outcome: 'approve', reasons: ['The allocation is ready.'] },
    { name: 'Taylor', outcome: 'reject', reasons: ['Support is unavailable.', 'Check the next rotation.'] }
  ]);
  assert.deepEqual(card.actions, [{ outcome: 'approve', label: 'Approve v5' }, { outcome: 'reject', label: 'Reject v5' }]);
});

test('an earlier obsolete decision does not appear in the contested card', () => {
  const obsolete = { ...approve, entry: 'obsolete', data: { outcome: 'approve', reasons: ['Earlier reason.'] } };
  const [card] = contestedCards([contested([obsolete, reject, approve])], () => undefined);
  assert.equal(card.decisions.length, 2);
  assert.ok(card.decisions.every((decision) => decision.name === 'A decision maker'));
  assert.ok(card.decisions.every((decision) => !decision.reasons.includes('Earlier reason.')));
});

test('settled decisions no longer have a contested card', () => {
  const view = version({ state: 'approved' });
  view.decision = { ...view.decision, status: 'effective', effective: [approve.entry] };
  assert.deepEqual(contestedCards([product(view, [approve, reject])], () => undefined), []);
});

test('pending confirmation is scoped to the supplied checkpoint evidence', () => {
  const view = version({ decisionsSinceCheckpoint: [reject.entry] });
  assert.deepEqual(pendingConfirmation([product(view, [approve, reject])]), [
    { product: 'estimate', hash: 'version-hash', number: 5, decisions: [reject.entry] }
  ]);
  assert.deepEqual(pendingConfirmation([product(version(), [approve, reject])]), []);
});

test('a version awaiting decision shows its change count and owner prompt at 20 changes', () => {
  const [row] = changesSinceRows([product(version())]);
  assert.equal(row.text, 'v5 awaiting decision, 37 changes since');
  assert.equal(row.ownerPromptDue, true);
  assert.equal(changesSinceRows([product(version({ changesSince: 1, othersChangesSince: 1, ownerPromptDue: false }))])[0].text,
    'v5 awaiting decision, 1 change since');
});

test('a withdrawn version keeps its change count without prompting the owner', () => {
  const [row] = changesSinceRows([product(version({ state: 'withdrawn' }))]);
  assert.equal(row.text, 'v5 withdrawn, 37 changes since');
  assert.equal(row.ownerPromptDue, false);
});

test('a dispute after a confirmed decision uses checkpoint wording', () => {
  const row = contested();
  row.versions[0].decision.finalBeforeDispute = true;
  assert.match(contestedCards([row], () => 'Reviewer')[0].text, /previously confirmed by your organization's server is now disputed/);
});

test('the card keeps the dispute visible without actions while another decision is held', () => {
  const row = contested();
  row.versions[0].decision.held = [{ id: 'held-decision', reason: 'unknown-decision-seen' }];
  const [card] = contestedCards([row], () => 'Reviewer');
  assert.equal(card.decisions.length, 2);
  assert.deepEqual(card.actions, []);
});

test('an earlier format of agent withdrawal is credited to an agent rather than the signing device’s owner', () => {
  const withdrawal: VersionAct = {
    ...reject, kind: 'version.withdraw', actor: { kind: 'agent', member: 'planner', run: 'run-one' },
    data: { reason: 'The draft is obsolete.' }
  };
  const row = contested([approve, withdrawal]);
  const [card] = contestedCards([row], () => 'Morgan');
  assert.deepEqual(card.decisions[1], { name: 'A project agent', outcome: 'withdraw', reasons: ['The draft is obsolete.'] });
});
