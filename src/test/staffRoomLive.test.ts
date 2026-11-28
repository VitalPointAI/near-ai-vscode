// Phase 33 plan 26 (D-06, D-12, D-21 to D-26, D-44, D-48, D-59, D-67): the Staff Room's live model. Pure: given what the engine knows about one
// shared work, it gives the people, the sync sentence and its one action, the offline banner, the cards and the product rows, in the glossary's
// words. Fictional exercise data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOIN_REQUEST_TEXT, JOIN_WAITING_TEXT, OFFLINE_BANNER_TEXT, ONLY_YOU_TEXT, EARLY_SHARE_COPY_TEXT, staffRoomLive, UNCONFIRMED_TEXT,
} from '../domain/staff/staffRoomLive';
import type { StaffRoomLiveInput, StaffRoomCard } from '../domain/staff/staffRoomLive';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { TrustFacts } from '../domain/gate/trust';

const AT_1402 = Date.parse('2026-11-24T14:02:00.000Z');

function input(extra: Partial<StaffRoomLiveInput> = {}): StaffRoomLiveInput {
  return {
    status: { state: 'live', findings: [] },
    isLeadDevice: false,
    people: [
      { member: 'mbr-blake', name: 'Blake Rivers', position: 'J4 Planner', live: false, lastSeen: AT_1402 },
      { member: 'mbr-avery', name: 'Avery Lead', position: 'J4 Lead', live: true, lastSeen: AT_1402 + 60_000 },
    ],
    products: [{ product: 'logistics-estimate', title: 'Logistics estimate', label: 'Internal', whoCanSee: ['Avery Lead', 'Blake Rivers'] }],
    versions: [],
    contested: [],
    unconfirmed: [],
    joins: [],
    splits: [],
    agents: [],
    ...extra,
  };
}

const kinds = (cards: readonly StaffRoomCard[]): string[] => cards.map((card) => card.kind);

test('two people, one live and one last seen at 14:02: the live person first, each with position and the words for the dot', () => {
  const view = staffRoomLive(input());
  assert.deepEqual(view.people.map((person) => [person.name, person.position, person.live, person.presence]), [
    ['Avery Lead', 'J4 Lead', true, 'Live'],
    ['Blake Rivers', 'J4 Planner', false, 'Last seen 14:02'],
  ]);
  assert.equal(view.people[1].accessibleName, 'Blake Rivers, J4 Planner, Last seen 14:02');
  assert.equal(view.peopleHeading, 'People');
});

test('the people heading takes the mode\'s word, and someone working on a product says so with the product\'s title', () => {
  const view = staffRoomLive(input({
    mode: 'military',
    people: [{ member: 'mbr-avery', name: 'Avery Lead', live: true, lastSeen: AT_1402, product: 'logistics-estimate', runs: 2 }],
  }));
  assert.equal(view.peopleHeading, 'Roster');
  assert.equal(view.people[0].presence, 'Working on Logistics estimate. Running 2 agents.');
});

test('live: the bar has the word, the sentence and one Sync Now action, and no banner', () => {
  const view = staffRoomLive(input());
  assert.deepEqual([view.bar.word, view.bar.sentence, view.bar.action.id, view.bar.action.label], ['Synced', 'Synced with your organization\'s server.', 'sync-now', 'Sync Now']);
  assert.equal(view.bar.accessibleName, 'Sync: Synced. Synced with your organization\'s server.');
  assert.equal(view.banner, undefined);
});

test('offline: the exact banner, and the bar still offers Sync Now', () => {
  const view = staffRoomLive(input({ status: { state: 'offline', findings: [], lastSyncedAt: AT_1402 } }));
  assert.equal(view.banner, OFFLINE_BANNER_TEXT);
  assert.equal(view.banner, 'You are offline. Your changes are kept here and will sync when your organization\'s server is back. Decisions you make now may become contested if someone else decides the same thing.');
  assert.equal(view.bar.action.id, 'sync-now');
  assert.match(view.bar.sentence, /Last synced at 14:02\.$/);
});

test('a server being restored is offline-like with its own sentence and no banner', () => {
  const view = staffRoomLive(input({ status: { state: 'offline', reason: 'restoring', findings: [] } }));
  assert.equal(view.banner, undefined);
  assert.equal(view.bar.sentence, 'Your organization\'s server is being restored. Your changes are kept here.');
});

test('a contested version shows one card with both names, both reasons and the two actions, each named for what it acts on', () => {
  const view = staffRoomLive(input({
    contested: [{
      product: 'logistics-estimate', hash: 'h'.repeat(64), number: 5,
      text: 'Contested: Avery Lead approved v5 and Blake Rivers rejected it at the same time. Neither applies. A new decision is needed.',
      decisions: [{ name: 'Avery Lead', outcome: 'approve', reasons: ['Fuel figures check out.'] }, { name: 'Blake Rivers', outcome: 'reject', reasons: ['Water is missing.'] }],
      actions: [{ outcome: 'approve', label: 'Approve v5' }, { outcome: 'reject', label: 'Reject v5' }],
    }],
  }));
  assert.deepEqual(kinds(view.cards), ['contested']);
  const card = view.cards[0];
  assert.ok(card.kind === 'contested');
  assert.deepEqual(card.decisions.map((item) => [item.name, item.reasons[0]]), [['Avery Lead', 'Fuel figures check out.'], ['Blake Rivers', 'Water is missing.']]);
  assert.deepEqual(card.actions.map((item) => [item.id, item.accessibleName, item.hash]), [
    ['approve', 'Approve v5: v5 of Logistics estimate', 'h'.repeat(64)],
    ['reject', 'Reject v5: v5 of Logistics estimate', 'h'.repeat(64)],
  ]);
});

test('product rows read "v5 awaiting decision, 37 changes since" with the label and Who can see this, and no withdraw action exists', () => {
  const view = staffRoomLive(input({
    versions: [
      { product: 'logistics-estimate', hash: 'a'.repeat(64), number: 4, text: 'v4 superseded, 80 changes since', changesSince: 80, ownerPromptDue: false },
      { product: 'logistics-estimate', hash: 'b'.repeat(64), number: 5, text: 'v5 awaiting decision, 37 changes since', changesSince: 37, ownerPromptDue: true },
    ],
  }));
  assert.deepEqual(view.rows.map((row) => [row.title, row.version, row.label, row.whoCanSee]), [
    ['Logistics estimate', 'v5 awaiting decision, 37 changes since', 'Internal', 'Who can see this: Avery Lead, Blake Rivers'],
  ]);
  assert.equal(view.cards.length, 0, 'the prompt is for the owner only');
  assert.equal(JSON.stringify(view).includes('withdraw'), false);
});

test('the owner is prompted after 20 changes, with Propose and Not Now; put away, the prompt does not come back for that version', () => {
  const versions = [{ product: 'logistics-estimate', hash: 'b'.repeat(64), number: 5, text: 'v5 awaiting decision, 21 changes since', changesSince: 21, ownerPromptDue: true }];
  const products = [{ product: 'logistics-estimate', title: 'Logistics estimate', whoCanSee: [], owned: true }];
  const view = staffRoomLive(input({ versions, products }));
  assert.deepEqual(kinds(view.cards), ['owner-prompt']);
  assert.equal(view.cards[0].text, 'v5 of Logistics estimate has 21 changes since. Propose a new version when the text is ready.');
  assert.deepEqual(view.cards[0].actions.map((item) => item.id), ['propose', 'dismiss']);
  assert.equal(view.rows[0].whoCanSee, `Who can see this: ${ONLY_YOU_TEXT}`);
  assert.deepEqual(kinds(staffRoomLive(input({ versions, products, dismissed: [`logistics-estimate:${'b'.repeat(64)}`] })).cards), []);
});

test('a join request shows the name, the compare code, Admit and Decline in a lead or deputy view only', () => {
  const joins = [{ invite: 'inv-casey', name: 'Casey Morgan', code: 'river lantern seven copper north field' }, { invite: 'inv-drew' }];
  const lead = staffRoomLive(input({ isLeadDevice: true, joins }));
  assert.deepEqual(lead.cards.map((card) => card.text), [
    'Casey Morgan wants to join. Compare this code with them: river lantern seven copper north field',
    JOIN_WAITING_TEXT,
  ]);
  assert.equal(JOIN_REQUEST_TEXT.startsWith('{name} wants to join.'), true);
  assert.deepEqual(lead.cards[0].actions.map((item) => [item.id, item.invite, item.accessibleName]), [['admit', 'inv-casey', 'Admit: Casey Morgan'], ['decline', 'inv-casey', 'Decline: Casey Morgan']]);
  assert.deepEqual(staffRoomLive(input({ joins })).cards, [], 'a member never sees who asked to join');
});

test('a roster split shows its sentence with one Choose per change, to a lead or deputy only', () => {
  const splits = [{ at: 'r'.repeat(64), text: 'The roster was changed in two places at once. The lead or the deputy must choose.', branches: [{ hash: 'x'.repeat(64), text: 'Avery Lead added Casey Morgan.' }, { hash: 'y'.repeat(64), text: 'Blake Rivers removed Drew Park.' }] }];
  const view = staffRoomLive(input({ isLeadDevice: true, splits }));
  const card = view.cards[0];
  assert.ok(card.kind === 'roster-split');
  assert.equal(card.text, 'The roster was changed in two places at once. The lead or the deputy must choose.');
  assert.deepEqual(card.branches.map((branch) => [branch.action.id, branch.action.branch, branch.action.accessibleName]), [
    ['choose', 'x'.repeat(64), 'Choose This Change: Avery Lead added Casey Morgan.'],
    ['choose', 'y'.repeat(64), 'Choose This Change: Blake Rivers removed Drew Park.'],
  ]);
  assert.deepEqual(staffRoomLive(input({ splits })).cards, []);
});

test('a shared work that needs a newer Sterling shows the D-67 sentence; shared work made shared by 0.4.35 with base-cell products says to make a copy', () => {
  const update = staffRoomLive(input({ status: { state: 'needs-update', reason: 'needs-update', findings: [] } }));
  assert.deepEqual(update.cards.map((card) => [card.kind, card.text]), [['update', 'This shared work needs a newer version of Sterling. Ask your administrator to update it.']]);
  const early = staffRoomLive(input({ earlyShareCopyNeeded: true }));
  assert.deepEqual(early.cards.map((card) => [card.kind, card.text, card.actions[0]?.id]), [['early-share-copy', EARLY_SHARE_COPY_TEXT, 'make-copy']]);
});

test('agent cards carry the one trust line only where TrustFacts exist', () => {
  const trust: TrustFacts = { place: { class: 'local', region: 'CA' }, verification: 'not-checked', allowedBy: [], wouldRefuse: [] };
  const view = staffRoomLive(input({ agents: [{ run: 'run-1', name: 'Logistics drafter', trust }, { run: 'run-2', name: 'Fuel checker' }], scales: SCALE_PRESETS }));
  const [withTrust, without] = view.cards;
  assert.ok(withTrust.kind === 'agent' && without.kind === 'agent');
  assert.match(withTrust.trustLine ?? '', /^Runs on /);
  assert.equal(without.trustLine, undefined);
});

test('a decision after the newest checkpoint says it is not yet confirmed by your organization\'s server', () => {
  const view = staffRoomLive(input({
    versions: [{ product: 'logistics-estimate', hash: 'b'.repeat(64), number: 5, text: 'v5 approved, 0 changes since', changesSince: 0, ownerPromptDue: false }],
    unconfirmed: [{ product: 'logistics-estimate', hash: 'b'.repeat(64) }],
  }));
  assert.equal(view.rows[0].unconfirmed, UNCONFIRMED_TEXT);
  assert.equal(UNCONFIRMED_TEXT, 'not yet confirmed by your organization\'s server');
  assert.match(view.rows[0].accessibleName, /not yet confirmed by your organization's server$/);
});

test('no sentence of the model says hub, entries or project', () => {
  const view = staffRoomLive(input({ isLeadDevice: true, earlyShareCopyNeeded: true, status: { state: 'offline', findings: [] }, joins: [{ invite: 'inv-drew' }] }));
  const text = JSON.stringify(view);
  for (const word of [/\bhub\b/i, /\bentries\b/i, /\bproject\b/i]) assert.doesNotMatch(text, word);
});
