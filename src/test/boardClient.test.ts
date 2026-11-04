// The Team Board client core (Phase 62 plan 09): media/board/board.js run in node:vm against the fake DOM. Every model comes from the real
// buildBoardModel over a signed in-memory log, so the client and the model contract cannot drift. The text-only rule is checked twice: the fake
// elements throw on markup, and the script is searched for markup sinks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { buildBoardModel } from '../domain/team/board';
import type { BoardCard, BoardModel } from '../domain/team/board';
import { CHORE_ID, boardWorld, seedStandardBoard } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';
import { createBoardHarness } from './helpers/fakeDom';
import type { BoardHarness, FakeNode } from './helpers/fakeDom';

const NOW = Date.parse('2026-03-05T12:00:00.000Z');
const MEDIA = path.resolve(__dirname, '../../media/board');
const BOARD_JS = readFileSync(path.join(MEDIA, 'board.js'), 'utf8');

function modelOf(world: BoardWorld, viewerId: string | undefined, extra: Partial<BoardModel['status']> = {}): BoardModel {
  return buildBoardModel(world.state, { nowMs: NOW, status: { kind: 'live', text: 'Live', ...extra }, canWrite: viewerId !== undefined, ...(viewerId === undefined ? {} : { viewerId }) });
}

async function standard(): Promise<BoardWorld> {
  const world = await boardWorld();
  seedStandardBoard(world);
  return world;
}

function start(options: { width?: number; state?: unknown; reducedMotion?: boolean } = {}): BoardHarness {
  const h = createBoardHarness({ width: 800, ...options });
  h.load(['board.js']);
  return h;
}

const api = (h: BoardHarness): Record<string, any> => h.window.NearAiBoard;
const card = (h: BoardHarness, id: string): FakeNode => {
  const found = h.$(`.card[data-id="${id}"]`);
  assert.ok(found, `card ${id} is drawn`);
  return found;
};
const main = (h: BoardHarness, id: string): FakeNode => card(h, id).querySelector('.card-main')!;
const buttonNamed = (h: BoardHarness, text: string): FakeNode | undefined => h.$$('button').find((b) => b.textContent === text && !b.hidden);
const withCards = (model: BoardModel, edit: (cards: BoardCard[]) => void): BoardModel => {
  const copy = JSON.parse(JSON.stringify(model)) as BoardModel;
  edit(copy.cards);
  return copy;
};

// ---- Task 1: the tracer ----------------------------------------------------------------------------------------------------------------------

test('tracer: a real model draws as the kanban at 800 px, the list at 400 px, and a click and a host request reach the host', async () => {
  const world = await standard();
  const model = modelOf(world, world.owner.memberId);
  const h = start();
  assert.deepEqual(h.posts, [{ type: 'ready' }]);

  h.deliver({ type: 'state', model });
  assert.deepEqual(h.$$('.column[data-column]').map((c) => c.getAttribute('data-column')), ['backlog', 'ready', 'claimed', 'in-progress', 'in-review', 'integrating', 'done', 'cancelled']);
  const ready = h.$('.cell[data-column="ready"][data-lane="unassigned"]')!;
  assert.ok(ready.contains(card(h, 'plan:90-01')), 'plan 90-01 sits in the Ready cell of the Unassigned lane');
  const readyCard = model.cards.find((c) => c.id === 'plan:90-01')!;
  assert.equal(main(h, 'plan:90-01').getAttribute('aria-label'), readyCard.a11yLabel);
  assert.equal(card(h, 'plan:90-01').querySelector('.card-title')!.textContent, 'Alpha slice');
  assert.equal(h.$$('.group[data-column]').length, 0, 'the kanban draws no list groups');

  h.setWidth(400);
  assert.deepEqual(h.$$('.group[data-column]').map((g) => g.getAttribute('data-column')), ['backlog', 'ready', 'claimed', 'in-progress', 'in-review', 'integrating', 'done', 'cancelled']);
  const open = h.$$('.group[data-column]').filter((g) => g.querySelector('.group-head')!.getAttribute('aria-expanded') === 'true').map((g) => g.getAttribute('data-column'));
  assert.deepEqual(open, ['backlog', 'ready']);
  assert.ok(h.$('.group[data-column="ready"]')!.contains(card(h, 'plan:90-01')));
  assert.equal(h.$$('.column[data-column]').length, 0);
  assert.equal(h.$$('*').filter((n) => n.draggable).length, 0, 'the list has nothing draggable');

  h.setWidth(800);
  buttonNamed(h, 'Import plans')!.click();
  assert.deepEqual(h.posts.at(-1), { type: 'import-plans' });
  // host-request is a test seam: a page the host did not mark for the extension-host tests ignores it (IN-05).
  const count = h.posts.length;
  h.deliver({ type: 'host-request', payload: { type: 'retry' } });
  assert.equal(h.posts.length, count, 'an unmarked page does not re-post');
  const marked = createBoardHarness({ width: 800 });
  marked.document.body.setAttribute('data-e2e', '1');
  marked.load(['board.js']);
  marked.deliver({ type: 'host-request', payload: { type: 'retry' } });
  assert.deepEqual(marked.posts.at(-1), { type: 'retry' });
});

test('the e2e probe answers only on a page the host marked for the extension-host tests, and reports the drawn cards and no page error', async () => {
  const world = await standard();
  const model = modelOf(world, world.owner.memberId);
  const plain = start();
  plain.deliver({ type: 'state', model });
  plain.deliver({ type: 'e2e-probe', id: 1, action: 'facts' });
  assert.equal(plain.posts.filter((p) => p.type === 'e2e-facts').length, 0, 'an unmarked page ignores the probe');

  const h = createBoardHarness({ width: 800 });
  h.document.body.setAttribute('data-e2e', '1');
  h.load(['board.js', 'menu.js']);
  h.deliver({ type: 'state', model });
  h.deliver({ type: 'e2e-probe', id: 7, action: 'focus', itemId: 'plan:90-01' });
  const facts = h.posts.filter((p) => p.type === 'e2e-facts');
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.id, 7);
  assert.deepEqual([...facts[0]!.cardIds].sort(), model.cards.filter((c) => c.milestoneId === undefined || c.milestoneId === model.selectedMilestone).map((c) => c.id).sort());
  assert.equal(facts[0]!.focusedCard, 'plan:90-01');
  assert.equal(facts[0]!.menuOpen, false);
  assert.deepEqual(facts[0]!.errors, []);
});

test('the e2e probe opens a card\'s detail and picks a Group by choice as a person\'s click would, and reports both (62-22)', async () => {
  const world = await standard();
  const model = modelOf(world, world.owner.memberId);
  const h = createBoardHarness({ width: 1400 });
  h.document.body.setAttribute('data-e2e', '1');
  h.load(['board.js', 'menu.js', 'detail.js']);
  h.deliver({ type: 'state', model });
  const facts = (): Array<Record<string, unknown>> => h.posts.filter((p) => p.type === 'e2e-facts') as Array<Record<string, unknown>>;
  h.deliver({ type: 'e2e-probe', id: 1, action: 'facts' });
  assert.equal(facts().at(-1)!.detailOpen, false, 'no detail before the click');
  assert.equal(facts().at(-1)!.groupBy, 'member', 'grouped by member at first');
  h.deliver({ type: 'e2e-probe', id: 2, action: 'open', itemId: 'plan:90-01' });
  assert.ok(h.posts.some((p) => p.type === 'detail' && p.itemId === 'plan:90-01'), 'the page asks for the card\'s detail');
  assert.equal(facts().at(-1)!.id, 2);
  assert.equal(facts().at(-1)!.detailOpen, true, 'the detail is open');
  h.deliver({ type: 'e2e-probe', id: 3, action: 'group', group: 'phase' });
  assert.equal(facts().at(-1)!.groupBy, 'phase', 'grouped by phase after the click');
  h.deliver({ type: 'e2e-probe', id: 4, action: 'group', group: '<img src=x>' });
  assert.equal(facts().at(-1)!.groupBy, 'phase', 'an unknown choice presses nothing');
  h.deliver({ type: 'e2e-probe', id: 5, action: 'open', itemId: 'plan:does-not-exist' });
  assert.deepEqual(facts().at(-1)!.errors, [], 'an unknown card presses nothing and throws nothing');
});

test('the e2e probe lets go of a card\'s focus as a click on empty space would, so a later scroll measures no stale focus (62-22)', async () => {
  const world = await standard();
  const model = modelOf(world, world.owner.memberId);
  const h = createBoardHarness({ width: 1400 });
  h.document.body.setAttribute('data-e2e', '1');
  h.load(['board.js', 'menu.js']);
  h.deliver({ type: 'state', model });
  const last = (): Record<string, unknown> => h.posts.filter((p) => p.type === 'e2e-facts').at(-1) as Record<string, unknown>;
  h.deliver({ type: 'e2e-probe', id: 1, action: 'focus', itemId: 'plan:90-01' });
  assert.equal(last().focusedCard, 'plan:90-01', 'the card has focus');
  h.deliver({ type: 'e2e-probe', id: 2, action: 'blur' });
  assert.equal(last().id, 2);
  assert.equal(last().focusedCard, '', 'no card has focus after the blur');
  assert.deepEqual(last().errors, []);
  h.deliver({ type: 'e2e-probe', id: 3, action: 'blur' });
  assert.deepEqual(last().errors, [], 'a blur with nothing focused throws nothing');
});

test('a title with markup and icon syntax is drawn as that exact text and creates no element', async () => {
  const world = await standard();
  const hostile = '<img src=x onerror=alert(1)> $(alert) <b>bold</b>';
  world.accept(world.dev, 'item.created', { id: `item:${'0'.repeat(22)}AB12`, kind: 'bug', title: hostile, scope: [], requirements: [], mustHaves: [] });
  const model = modelOf(world, world.owner.memberId);
  const id = model.cards.find((c) => c.title.includes('onerror'))!.id;
  const h = start();
  h.deliver({ type: 'state', model });
  assert.equal(card(h, id).querySelector('.card-title')!.textContent, hostile);
  assert.equal(card(h, id).querySelector('.card-title')!.children.length, 0);
  assert.equal(h.$$('img').length + h.$$('b').length, 0);
  assert.throws(() => { (h.root as any).innerHTML = '<p>x</p>'; }, /markup/);
});

test('the script has no markup sink, no remote address and no em or en dash in it', () => {
  assert.doesNotMatch(BOARD_JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(BOARD_JS, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  assert.doesNotMatch(BOARD_JS, /[—–]/);
  assert.match(BOARD_JS, /acquireVsCodeApi/);
  void CHORE_ID;
});

// ---- Task 2: lanes, filters, states, overflow and announcements -------------------------------------------------------------------------------

const text = (n: FakeNode | null | undefined): string => n?.textContent ?? '';
const chip = (h: BoardHarness, label: string): FakeNode => h.$$('.chip').find((c) => text(c) === label)!;
const cardIds = (h: BoardHarness): string[] => h.$$('.card').map((c) => c.getAttribute('data-id') as string).sort();
const radio = (h: BoardHarness, label: string): FakeNode => h.$$('[role="radio"]').find((r) => text(r) === label)!;

async function secondMilestone(): Promise<BoardWorld> {
  const world = await standard();
  const { importedBody } = await import('./helpers/teamBoardWorld');
  world.accept(world.owner, 'item.imported', importedBody({ id: 'milestone:v0.8.0', kind: 'milestone', title: 'Version 0.8.0' }));
  world.accept(world.owner, 'item.imported', importedBody({ id: 'phase:80', kind: 'phase', title: 'Old work', parentId: 'milestone:v0.8.0' }));
  world.accept(world.owner, 'item.imported', importedBody({ id: 'plan:80-01', kind: 'plan', title: 'Old slice', parentId: 'phase:80', scope: ['src/o/**'], estimate: { tokens: 1000 } }));
  return world;
}

test('group by switches the lanes; a phase lane shows its progress, a phase lane with nothing open starts collapsed, and the choice survives a reload', async () => {
  const world = await standard();
  world.accept(world.owner, 'item.updated', { id: 'plan:90-01', changes: { state: 'done' } });
  // Owner decision 2026-11-03 (G-62-3, plan 62-19): the standard board's planless phase:91 is now a Backlog card, and a lane starts collapsed only when it holds nothing outside
  // Done and Cancelled. Cancelling the phase leaves its lane with only a cancelled card, so the lane still starts collapsed here.
  world.accept(world.owner, 'item.cancelled', { id: 'phase:91', reason: 'not this time' });
  const model = modelOf(world, world.owner.memberId);
  const h = start();
  h.deliver({ type: 'state', model });
  assert.deepEqual(h.$$('.lane').map((l) => l.getAttribute('data-lane')), ['unassigned']);
  assert.equal(radio(h, 'Member').getAttribute('aria-checked'), 'true');
  assert.equal(h.$('[role="radiogroup"]')!.getAttribute('aria-label'), 'Group by');

  radio(h, 'Phase').click();
  assert.equal(radio(h, 'Phase').getAttribute('aria-checked'), 'true');
  assert.equal(radio(h, 'Member').getAttribute('aria-checked'), 'false');
  const lanes = h.$$('.lane');
  assert.deepEqual(lanes.map((l) => l.getAttribute('data-lane')), ['phase:90', 'phase:91', 'board']);
  const alpha = model.lanes.phase[0];
  assert.match(text(lanes[0].querySelector('.lane-label')), /^Phase 90: Alpha work$/);
  const bar = lanes[0].querySelector('[role="progressbar"]')!;
  assert.equal(bar.getAttribute('aria-valuenow'), String(alpha.progress!.percent));
  assert.equal(bar.getAttribute('aria-label'), 'Phase 90: Alpha work progress');
  assert.equal(text(lanes[0].querySelector('.progress-text')), alpha.progress!.text);
  assert.match(alpha.progress!.text, /^\d+%, 1 of 2 plans done$/);
  assert.equal(text(lanes[1].querySelector('.progress-text')), 'No plans yet');
  assert.equal(lanes[1].querySelector('.lane-head')!.getAttribute('aria-expanded'), 'false');
  assert.equal(lanes[0].querySelector('.lane-head')!.getAttribute('aria-expanded'), 'true');
  lanes[1].querySelector('.lane-head')!.click();
  assert.equal(h.$$('.lane')[1].querySelector('.lane-head')!.getAttribute('aria-expanded'), 'true');

  radio(h, 'None').click();
  assert.equal(h.$$('.lane-head').length, 0, 'group by None draws one row with no lane header');
  assert.equal(h.$$('.lane').length, 1);

  const again = start({ state: h.state });
  again.deliver({ type: 'state', model });
  assert.equal(radio(again, 'None').getAttribute('aria-checked'), 'true');
});

test('filters combine, apply locally, announce the result after 500 ms and survive a reload', async () => {
  const world = await standard();
  world.accept(world.lead, 'item.blocked', { id: 'plan:90-02', reason: 'waiting for the API key' });
  const model = modelOf(world, world.dev.memberId);
  const h = start();
  h.deliver({ type: 'state', model });
  const sent = h.posts.length;
  // Owner decision 2026-11-03 (G-62-3, plan 62-19): the standard board's planless phase:91 is now a Backlog card, so the board draws four cards.
  assert.equal(h.$$('.card').length, 4);

  chip(h, 'Mine').click();
  assert.deepEqual(cardIds(h), [CHORE_ID], 'Mine shows the board items the viewer created');
  assert.equal(chip(h, 'Mine').getAttribute('aria-pressed'), 'true');
  h.advance(400);
  assert.ok(!h.announcements.includes('Showing 1 of 4 cards.'), 'not before 500 ms');
  h.advance(300);
  assert.equal(h.live(), 'Showing 1 of 4 cards.');
  chip(h, 'Mine').click();
  chip(h, 'Ready').click();
  assert.deepEqual(cardIds(h), ['plan:90-01']);
  chip(h, 'Ready').click();
  chip(h, 'Blocked').click();
  assert.deepEqual(cardIds(h), ['plan:90-02'], 'Blocked matches blocked cards in any column');
  chip(h, 'Blocked').click();

  h.setValue(h.$('#req-input')!, '  board-01 ');
  assert.deepEqual(cardIds(h), ['plan:90-01'], 'the requirement matches case insensitively and trimmed');
  h.setValue(h.$('#req-input')!, 'NOPE-9');
  assert.equal(text(h.$('.state-head')), 'No cards match these filters');
  assert.equal(h.$$('.card').length, 0);
  h.setValue(h.$('#req-input')!, '');
  h.setValue(h.$('#phase-select')!, 'phase:90', 'change');
  assert.deepEqual(cardIds(h), ['plan:90-01', 'plan:90-02']);
  chip(h, 'Ready').click();
  assert.deepEqual(cardIds(h), ['plan:90-01'], 'filters combine with AND');
  assert.equal(h.posts.length, sent, 'no filter change reaches the host');

  const again = start({ state: h.state });
  again.deliver({ type: 'state', model });
  assert.deepEqual(cardIds(again), ['plan:90-01']);
  const clear = buttonNamed(again, 'Clear filters')!;
  assert.ok(clear, 'Clear filters shows while a filter is on');
  clear.click();
  assert.equal(again.$$('.card').length, 4);
  assert.equal(buttonNamed(again, 'Clear filters'), undefined, 'and is gone when none is on');
});

test('the Mine filter has its own empty body and a filtered-out board shows Clear filters', async () => {
  const world = await standard();
  const h = start();
  h.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  chip(h, 'Mine').click();
  assert.equal(text(h.$('.state-head')), 'No cards match these filters');
  // Owner decision 2026-11-03 (G-62-5, 62-20): Mine is the cards assigned to you or that you added, so its words say so.
  assert.equal(text(h.$('.state-body')), 'Nothing is yours yet. Cards assigned to you or that you add show up here.');
  assert.equal(chip(h, 'Mine').getAttribute('title'), 'Cards assigned to you or that you added');
  buttonNamed(h, 'Clear filters')!.click();
  // Owner decision 2026-11-03 (G-62-3, plan 62-19): the standard board's planless phase:91 is now a Backlog card.
  assert.equal(h.$$('.card').length, 4);
  h.setValue(h.$('#req-input')!, 'zzz');
  assert.equal(text(h.$('.state-body')), 'Clear the filters to see every card.');
});

test('the milestone picker lists the active milestone first, then the others, then All milestones; board items show under every milestone', async () => {
  const world = await secondMilestone();
  const model = modelOf(world, world.owner.memberId);
  const h = start();
  h.deliver({ type: 'state', model });
  const select = h.$('#ms-select')!;
  assert.deepEqual(Array.from(select.children).map((o) => o.getAttribute('value')), ['milestone:v0.9.0', 'milestone:v0.8.0', 'all']);
  assert.deepEqual(Array.from(select.children).map((o) => text(o)), ['Version 0.9.0', 'Version 0.8.0', 'All milestones']);
  assert.equal(select.value, 'milestone:v0.9.0');
  // Owner decision 2026-11-03 (G-62-3, plan 62-19): the standard board's planless phase:91 is now a Backlog card of milestone v0.9.0.
  assert.deepEqual(cardIds(h), [CHORE_ID, 'phase:91', 'plan:90-01', 'plan:90-02'], 'the old milestone is hidden and the board item shows');
  h.setValue(select, 'milestone:v0.8.0', 'change');
  assert.deepEqual(cardIds(h), [CHORE_ID, 'plan:80-01']);
  h.setValue(select, 'all', 'change');
  assert.equal(h.$$('.card').length, 5);
  assert.match(text(h.$('.summary-line')), /^5 cards · 2 ready · 0 blocked$/);
});

test('the empty board names the next step for each role and offers one primary button', async () => {
  const world = await boardWorld();
  const cases: Array<[string, string, string | undefined]> = [
    [world.owner.memberId, 'Import your plans from the project roadmap, or add an item yourself.', 'Import plans'],
    [world.dev.memberId, 'A lead has not imported the plans yet. You can add a bug, chore or experiment yourself.', 'New item'],
    [world.observer.memberId, 'A lead has not imported the plans yet. Cards show up here when they do.', undefined]
  ];
  for (const [viewer, body, primary] of cases) {
    const h = start();
    h.deliver({ type: 'state', model: modelOf(world, viewer) });
    assert.equal(text(h.$('.state-head')), 'No work on the board yet');
    assert.equal(text(h.$('.state-body')), body);
    const primaries = h.$$('button.primary').filter((b) => !b.hidden && !b.closest('[hidden]'));
    assert.deepEqual(primaries.map((b) => text(b)), primary === undefined ? [] : [primary]);
    assert.equal(h.$$('.card').length, 0);
  }
  const owner = start();
  owner.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  buttonNamed(owner, 'Import plans')!.click();
  assert.deepEqual(owner.posts.at(-1), { type: 'import-plans' });
});

test('loading, the slow message after 10 seconds, the error state and Try again', async () => {
  const h = start();
  assert.equal(text(h.$('.state-head')), 'Loading the Team Board...');
  assert.equal(h.$('.state-box')!.getAttribute('role'), 'status');
  h.advance(9000);
  assert.equal(text(h.$('.state-head')), 'Loading the Team Board...');
  h.advance(1500);
  assert.equal(text(h.$('.state-head')), 'This is taking longer than usual. The connection to your team may be slow.');
  buttonNamed(h, 'Try again')!.click();
  assert.deepEqual(h.posts.at(-1), { type: 'retry' });

  const failed = start();
  failed.deliver({ type: 'state', error: 'The team log could not be read.' });
  assert.equal(text(failed.$('.state-head')), 'The Team Board could not be loaded');
  assert.equal(text(failed.$('.state-body')), 'The team log could not be read. Nothing was changed. Try again, or show details in the NEAR AI Team output.');
  buttonNamed(failed, 'Show details')!.click();
  assert.deepEqual(failed.posts.at(-1), { type: 'show-details' });
  buttonNamed(failed, 'Try again')!.click();
  assert.deepEqual(failed.posts.at(-1), { type: 'retry' });
});

test('offline, paused, removed and read-only models show the right banner and take away what the viewer cannot do', async () => {
  const world = await standard();
  const live = modelOf(world, world.owner.memberId);
  const offline = start();
  offline.deliver({ type: 'state', model: { ...live, status: { kind: 'offline', text: 'Offline', lastUpdated: '2026-03-05T11:55:00.000Z' } } });
  assert.match(text(offline.$('.banner-offline')), /^You are offline\. The board shows the last update at .+\. Cards cannot be moved or added until the connection returns\.Try again$/);
  assert.equal(offline.$('.banner-offline')!.getAttribute('role'), 'status');
  assert.equal(text(offline.$('.status-chip')), 'Offline');
  assert.ok(offline.$$('.move-btn').filter((b) => !b.hidden).length > 0);
  assert.ok(offline.$$('.move-btn').filter((b) => !b.hidden).every((b) => b.getAttribute('aria-disabled') === 'true'));
  assert.equal(buttonNamed(offline, 'New item')!.getAttribute('aria-disabled'), 'true');
  buttonNamed(offline, 'New item')!.click();

  const paused = start();
  paused.deliver({ type: 'state', model: { ...live, status: { kind: 'paused', text: 'Paused' } } });
  assert.equal(paused.$('.banner-paused')!.getAttribute('role'), 'alert');
  assert.equal(text(paused.$('.banner-paused .banner-text')), 'Something unexpected changed in the shared team record, so the board is paused to protect your work. Choose "Check the team" to see what happened, or ask your lead.');
  assert.equal(text(paused.$('.status-chip')), 'Paused');
  // UI review warning 2: the paused banner offers the check itself, so nobody has to find a command.
  const check = Array.from(paused.$('.banner-paused')!.querySelectorAll('button')).find((b) => text(b) === 'Check the team');
  assert.ok(check, 'the paused banner has a Check the team button');
  check.click();
  assert.deepEqual(paused.posts.at(-1), { type: 'check-team' });
  const untrusted = start();
  untrusted.deliver({ type: 'state', model: { ...live, status: { kind: 'paused', text: "Paused: This coordination log does not belong to this project's team" } } });
  assert.equal(text(untrusted.$('.banner-paused .banner-text')), 'The shared team record failed a safety check, so the board is paused. Choose "Check the team" to see what happened, or ask your lead.');

  const removed = start();
  removed.deliver({ type: 'state', model: { ...live, status: { kind: 'removed', text: 'Removed' } } });
  assert.equal(text(removed.$('.banner-removed')), 'You were removed from this team. You can still look at the board but not change it.');

  const observer = modelOf(world, world.observer.memberId);
  const looking = start();
  looking.deliver({ type: 'state', model: observer });
  assert.equal(text(looking.$('.banner-readonly')), 'You can look at the board but not change it. A lead can change your role.');
  assert.ok(looking.$$('.move-btn').every((b) => b.hidden), 'no Move to... for a viewer who cannot move');
  assert.equal(buttonNamed(looking, 'New item'), undefined);
  assert.equal(text(looking.$('.status-chip')), 'Read only');

  const tampered = start();
  tampered.deliver({ type: 'state', model: { ...observer, cards: observer.cards.map((c) => ({ ...c, moves: live.cards[0].moves })) } });
  assert.ok(tampered.$$('.move-btn').every((b) => b.hidden), 'a read-only viewer never sees a move control, whatever the model says');
});

test('a notice is a status banner announced once', async () => {
  const world = await standard();
  const h = start();
  h.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  h.deliver({ type: 'notice', text: 'Imported 4 items to the Team Board.' });
  assert.equal(h.$('.banner-notice')!.getAttribute('role'), 'status');
  assert.equal(text(h.$('.banner-notice .banner-text')), 'Imported 4 items to the Team Board.');
  h.advance(200);
  assert.equal(h.announcements.filter((a) => a === 'Imported 4 items to the Team Board.').length, 1);
});

test('a cell with more than 30 cards shows the first 30 and Show all N; counts read one and many correctly', async () => {
  const world = await standard();
  const base = modelOf(world, world.owner.memberId);
  const model = withCards(base, (cards) => {
    const ready = cards.find((c) => c.id === 'plan:90-01')!;
    for (let i = 0; i < 30; i += 1) cards.push({ ...ready, id: `plan:95-${i}`, displayId: `95-${i}`, title: `Extra ${i}` });
  });
  const h = start();
  h.deliver({ type: 'state', model });
  const cell = h.$('.cell[data-column="ready"]')!;
  assert.equal(cell.querySelectorAll('.card').length, 30);
  const more = buttonNamed(h, 'Show all 31')!;
  assert.ok(more, 'a Show all 31 button follows the first 30');
  more.click();
  assert.equal(h.$('.cell[data-column="ready"]')!.querySelectorAll('.card').length, 31);
  assert.equal(buttonNamed(h, 'Show all 31'), undefined);

  const small = start();
  small.deliver({ type: 'state', model: base });
  assert.equal(small.$('.column[data-column="ready"] .col-btn')!.getAttribute('aria-label'), 'Ready column, 1 card, expanded. Press to collapse.');
  // Owner decision 2026-11-03 (G-62-3, plan 62-19): the standard board's planless phase:91 is now a Backlog card.
  assert.equal(small.$('.column[data-column="backlog"] .col-btn')!.getAttribute('aria-label'), 'Backlog column, 3 cards, expanded. Press to collapse.');
  assert.match(text(card(small, 'plan:90-02').querySelector('.card-meta')), /1 dependency/);
});

test('all eight columns and groups always show, with the captions of the columns later phases own, and an empty cell reads No cards', async () => {
  const world = await standard();
  const model = modelOf(world, world.owner.memberId);
  const h = start();
  h.deliver({ type: 'state', model });
  const captions = h.$$('.column').map((c) => text(c.querySelector('.caption')));
  assert.deepEqual(captions, ['Waiting, on hold or not ready.', 'Ready to be claimed.', 'Claiming arrives in a later update.', 'Starting work arrives with claims.', 'Review arrives in a later update.', 'Adding finished work to the project arrives in a later update.', '', '']);
  // UI review warning 5: the four columns later updates fill start folded, with one plain note that says why. Owner decision 2026-11-03 (G-62-3, plan
  // 62-21): Done and Cancelled start folded too, and the note says so.
  const later = ['claimed', 'in-progress', 'in-review', 'integrating'];
  assert.deepEqual(h.$$('.column').filter((c) => c.className.includes('collapsed')).map((c) => c.getAttribute('data-column')), [...later, 'done', 'cancelled']);
  assert.deepEqual(later.map((key) => h.$(`.column[data-column="${key}"] .col-btn`)!.getAttribute('aria-expanded')), ['false', 'false', 'false', 'false']);
  assert.equal(text(h.$('.later-note')), 'Claimed, In progress, In review and Shipping are folded for now. They fill in when those steps arrive in a later update. Done and Cancelled are folded to keep finished work out of the way.');
  assert.equal(h.$('.later-note')!.hidden, false);
  // G-62-7 (62-21): a folded cell holds only its count, hidden for screen readers.
  assert.equal(text(h.$('.cell[data-column="claimed"][data-lane="unassigned"] .sr-only')), '0 cards, column folded');
  assert.equal(h.$('.column[data-column="integrating"] svg path')!.getAttribute('d'), 'M6 3.5L10.5 8L6 12.5', 'a folded column shows the closed chevron');
  assert.deepEqual(Array.from(h.$('.column[data-column="integrating"] .col-btn')!.querySelectorAll('svg')[1]!.querySelectorAll('path')).map((p) => p.getAttribute('d')), ['M1.5 8.5L4.5 11.5L10.5 4.5', 'M7.5 11.5L13.5 4.5'], 'Shipping has the check-all icon, not a git icon');
  h.$('.column[data-column="claimed"] .col-btn')!.click();
  assert.equal(h.$('.column[data-column="claimed"] .col-btn')!.getAttribute('aria-expanded'), 'true', 'a folded column opens on request');
  assert.equal(text(h.$('.cell[data-column="claimed"][data-lane="unassigned"]')), 'No cards');
  for (const key of later.slice(1)) h.$(`.column[data-column="${key}"] .col-btn`)!.click();
  assert.equal(text(h.$('.later-note')), 'Done and Cancelled are folded to keep finished work out of the way.', 'once none of the four is folded the note speaks only of finished work');
  h.$('.column[data-column="cancelled"] .col-btn')!.click();
  assert.equal(h.$('.column[data-column="cancelled"] .col-btn')!.getAttribute('aria-expanded'), 'true');
  assert.equal(text(h.$('.later-note')), 'Done is folded to keep finished work out of the way.');
  h.$('.column[data-column="done"] .col-btn')!.click();
  assert.equal(h.$('.later-note')!.hidden, true, 'the note goes once nothing it speaks of is folded');
  h.$('.column[data-column="cancelled"] .col-btn')!.click();
  assert.equal(h.$('.column[data-column="cancelled"] .col-btn')!.getAttribute('aria-expanded'), 'false');
  assert.ok(h.$('.column[data-column="cancelled"]')!.className.includes('collapsed'));
  h.setWidth(300);
  const claimed = h.$('.group[data-column="claimed"]')!;
  assert.equal(claimed.querySelector('.group-head')!.getAttribute('aria-expanded'), 'false');
  claimed.querySelector('.group-head')!.click();
  assert.equal(text(h.$('.group[data-column="claimed"] .empty-line')), 'No cards here.');
  assert.equal(text(h.$('.group[data-column="claimed"] .caption')), 'Claiming arrives in a later update.');
});

test('the first state announces the board; a teammate change gets a static outline and one batched announcement; a burst gives one', async () => {
  const world = await standard();
  const h = start();
  h.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  h.advance(150);
  // Owner decision 2026-11-03 (G-62-3, plan 62-19): the standard board's planless phase:91 is now a Backlog card, counted as a card but never as ready.
  assert.equal(h.live(), 'Team Board loaded. 4 cards, 1 ready.');

  world.accept(world.lead, 'item.blocked', { id: 'plan:90-02', reason: 'waiting for the API key' });
  h.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  assert.ok(card(h, 'plan:90-02').className.includes('changed'), 'the changed card carries the outline class');
  assert.ok(!card(h, 'plan:90-01').className.includes('changed'));
  h.advance(700);
  assert.equal(h.live(), '1 change from your team: Lee blocked 90-02.');
  h.advance(3000);
  assert.ok(!card(h, 'plan:90-02').className.includes('changed'), 'the outline ends after 3 seconds');

  h.advance(6000);
  const before = h.announcements.length;
  world.accept(world.owner, 'item.updated', { id: 'plan:90-01', changes: { hold: true } });
  h.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  world.accept(world.lead, 'item.unblocked', { id: 'plan:90-02' });
  h.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  world.accept(world.owner, 'item.updated', { id: 'plan:90-01', changes: { hold: false } });
  h.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  h.advance(8000);
  const batch = h.announcements.slice(before);
  assert.equal(batch.length, 1, 'three states inside 5 seconds make one announcement');
  assert.equal(batch[0], '3 changes from your team: 90-01 was put on hold, 90-02 was unblocked and the hold on 90-01 was released.');
});

test('your own confirmed move announces once and keeps focus on that card', async () => {
  const world = await standard();
  const h = start();
  h.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  // Owner decision 2026-11-03 (G-62-3, plan 62-21): Done starts folded, so this person has opened it to watch the card land there.
  h.$('.column[data-column="done"] .col-btn')!.click();
  h.advance(150);
  api(h).setPending('plan:90-01', 'Moving to Done...');
  assert.equal(card(h, 'plan:90-01').getAttribute('aria-busy'), 'true');
  assert.equal(text(card(h, 'plan:90-01').querySelector('.pending-line')), 'Moving to Done...');
  world.accept(world.owner, 'item.updated', { id: 'plan:90-01', changes: { state: 'done' } });
  h.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  h.advance(150);
  assert.equal(h.live(), 'Moved plan 90-01 to Done.');
  h.advance(1000);
  assert.equal(h.announcements.filter((a) => a.startsWith('Moved plan')).length, 1);
  // Finishing 90-01 made 90-02 ready; that is a teammate-visible change, and the move itself never joins the summary.
  assert.deepEqual(h.announcements.filter((a) => /change from your team/.test(a)), ['1 change from your team: 90-02 moved to Ready.']);
  assert.ok(h.$('.cell[data-column="done"]')!.contains(card(h, 'plan:90-01')));
  assert.equal(h.focused(), main(h, 'plan:90-01'));
  assert.equal(card(h, 'plan:90-01').getAttribute('aria-busy'), null);
  assert.equal(card(h, 'plan:90-01').querySelector('.pending-line'), null);
});

test('a dismissed prompt (refused with an empty reason) clears the pending line silently', async () => {
  const world = await standard();
  const h = start();
  h.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  h.advance(150);
  const spoken = h.announcements.length;
  api(h).setPending('plan:90-01', 'Moving to Done...');
  h.deliver({ type: 'refused', itemId: 'plan:90-01', reason: '' });
  assert.equal(card(h, 'plan:90-01').querySelector('.pending-line'), null);
  h.advance(500);
  assert.equal(h.announcements.length, spoken);
});

// ---- Task 3: keyboard, the client API, icons and the stylesheet --------------------------------------------------------------------------------

const BOARD_CSS = readFileSync(path.join(MEDIA, 'board.css'), 'utf8');
const focusedId = (h: BoardHarness): string | null => h.focused().closest('.card')?.getAttribute('data-id') ?? null;

async function drawn(width = 800, viewer: 'owner' | 'dev' = 'owner'): Promise<{ h: BoardHarness; world: BoardWorld }> {
  const world = await standard();
  const h = start({ width });
  h.deliver({ type: 'state', model: modelOf(world, viewer === 'owner' ? world.owner.memberId : world.dev.memberId) });
  return { h, world };
}

test('kanban: one tab stop per lane, arrows move inside and across columns, Home and End and the Ctrl forms reach the ends', async () => {
  const { h } = await drawn();
  const stops = h.$$('.card-main').filter((b) => b.getAttribute('tabindex') === '0');
  assert.equal(stops.length, 1, 'one card per lane takes the tab stop');
  // Owner decision 2026-11-03 (G-62-3, plan 62-19): the standard board's planless phase:91 is now a Backlog card between plan:90-02 and the chore.
  assert.equal(h.$$('.card-main').filter((b) => b.getAttribute('tabindex') === '-1').length, 3);

  main(h, 'plan:90-02').focus();
  h.press(h.focused(), 'ArrowDown');
  assert.equal(focusedId(h), 'phase:91');
  assert.equal(main(h, 'phase:91').getAttribute('tabindex'), '0', 'the stop follows the focus');
  assert.equal(main(h, 'plan:90-02').getAttribute('tabindex'), '-1');
  h.press(h.focused(), 'ArrowDown');
  assert.equal(focusedId(h), CHORE_ID);
  h.press(h.focused(), 'ArrowDown');
  assert.equal(focusedId(h), CHORE_ID, 'nothing happens at the end of a cell');
  h.press(h.focused(), 'ArrowRight');
  assert.equal(focusedId(h), 'plan:90-01', 'Right lands on the last card when the row index does not exist');
  h.press(h.focused(), 'ArrowLeft');
  assert.equal(focusedId(h), 'plan:90-02');
  h.press(h.focused(), 'End');
  assert.equal(focusedId(h), CHORE_ID);
  h.press(h.focused(), 'Home');
  assert.equal(focusedId(h), 'plan:90-02');
  h.press(h.focused(), 'End', { ctrlKey: true });
  assert.equal(focusedId(h), 'plan:90-01');
  h.press(h.focused(), 'Home', { ctrlKey: true });
  assert.equal(focusedId(h), 'plan:90-02');
  const before = h.focused();
  assert.equal(h.press(before, 'Delete').defaultPrevented, false);
  assert.equal(h.focused(), before, 'there is no delete');
});

test('the column header row is one stop; Left, Right, Home and End move between columns and Enter collapses', async () => {
  const { h } = await drawn();
  const heads = h.$$('.col-btn');
  assert.equal(h.$('.colheads')!.getAttribute('role'), 'toolbar');
  assert.deepEqual(heads.map((b) => b.getAttribute('tabindex')), ['0', '-1', '-1', '-1', '-1', '-1', '-1', '-1']);
  heads[0].focus();
  h.press(heads[0], 'ArrowRight');
  assert.equal(h.focused(), heads[1]);
  h.press(heads[1], 'End');
  assert.equal(h.focused(), heads[7]);
  h.press(heads[7], 'Home');
  assert.equal(h.focused(), heads[0]);
  h.press(heads[0], 'Enter');
  assert.equal(h.$('.col-btn')!.getAttribute('aria-expanded'), 'false');
  assert.equal(h.focused(), h.$('.col-btn'), 'focus stays on the header button');
});

test('list: rows of an open group are one roving stop with Up, Down, Home and End', async () => {
  const { h } = await drawn(400);
  main(h, 'plan:90-02').focus();
  h.press(h.focused(), 'ArrowDown');
  // Owner decision 2026-11-03 (G-62-3, plan 62-19): the standard board's planless phase:91 is now a Backlog card between plan:90-02 and the chore.
  assert.equal(focusedId(h), 'phase:91');
  h.press(h.focused(), 'ArrowDown');
  assert.equal(focusedId(h), CHORE_ID);
  h.press(h.focused(), 'ArrowDown');
  assert.equal(focusedId(h), CHORE_ID);
  h.press(h.focused(), 'Home');
  assert.equal(focusedId(h), 'plan:90-02');
  h.press(h.focused(), 'End');
  assert.equal(focusedId(h), CHORE_ID);
  assert.equal(h.$$('.group[data-column="backlog"] .card-main').filter((b) => b.getAttribute('tabindex') === '0').length, 1);
  assert.equal(h.$$('.group[data-column="ready"] .card-main').filter((b) => b.getAttribute('tabindex') === '0').length, 1, 'each open group has its own stop');
});

test('M, Shift+F10 and the ContextMenu key open the menu through the client API; Enter opens the detail; nothing registered is safe', async () => {
  const { h } = await drawn();
  const target = main(h, 'plan:90-01');
  target.focus();
  h.press(target, 'M');
  h.press(target, 'Enter');
  h.press(target, 'F10', { shiftKey: true });
  h.press(target, 'ContextMenu');
  assert.equal(h.$$('[role="menu"]').length, 0, 'with nothing registered nothing is built and nothing throws');

  const menu: Array<[string, FakeNode]> = [];
  const detail: Array<[string, FakeNode]> = [];
  api(h).registerMenu((id: string, opener: FakeNode) => menu.push([id, opener]));
  api(h).registerDetail((id: string, opener: FakeNode) => detail.push([id, opener]));
  const moveButton = card(h, 'plan:90-01').querySelector('.move-btn')!;
  h.press(target, 'M');
  h.press(target, 'F10', { shiftKey: true });
  h.press(target, 'ContextMenu');
  h.press(target, 'F10');
  assert.deepEqual(menu.map(([id]) => id), ['plan:90-01', 'plan:90-01', 'plan:90-01']);
  assert.ok(menu.every(([, opener]) => opener === moveButton), 'focus returns to the Move to... button');
  moveButton.click();
  assert.equal(menu.length, 4);
  h.press(target, 'Enter');
  assert.deepEqual(detail, [['plan:90-01', target]]);
  assert.equal(target.getAttribute('aria-current'), 'true', 'the opened card is the selected one');

  const { h: dev, world } = await drawn(800, 'dev');
  const calls: string[] = [];
  api(dev).registerMenu((id: string) => calls.push(id));
  main(dev, 'plan:90-01').focus();
  dev.press(main(dev, 'plan:90-01'), 'M');
  // Owner decision 2026-11-03 (62-20, 62-25): a developer has no moves but may assign themselves a free card, so M opens the menu with Assign to me.
  assert.deepEqual(calls, ['plan:90-01'], 'Assign to me alone opens the menu');
  const nothing = withCards(modelOf(world, world.dev.memberId), (cards) => { cards.find((c) => c.id === 'plan:90-01')!.assignActions = []; });
  dev.deliver({ type: 'state', model: nothing });
  main(dev, 'plan:90-01').focus();
  dev.press(main(dev, 'plan:90-01'), 'M');
  assert.deepEqual(calls, ['plan:90-01'], 'a card with no offered move and no assignment opens nothing');
});

test('the selected card, the layout switch and a hidden view', async () => {
  const { h, world } = await drawn();
  api(h).registerDetail(() => undefined);
  main(h, 'plan:90-02').click();
  chip(h, 'Ready').click();
  chip(h, 'Ready').click();
  h.setWidth(300);
  assert.equal(main(h, 'plan:90-02').getAttribute('aria-current'), 'true', 'the selection is kept across the layout switch');
  assert.equal(h.root.getAttribute('data-layout'), 'list');
  h.setWidth(900);
  assert.equal(h.root.getAttribute('data-layout'), 'kanban');
  assert.equal(h.live(), h.live(), 'a layout change announces nothing');
  h.setVisible(false);
  assert.deepEqual(h.posts.at(-1), { type: 'visible', value: false });
  const drawnBefore = h.$$('.card').length;
  world.accept(world.lead, 'item.blocked', { id: 'plan:90-02', reason: 'waiting' });
  h.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  assert.equal(card(h, 'plan:90-02').querySelector('.badge-blocked'), null, 'nothing is drawn while the view is hidden');
  h.setVisible(true);
  assert.deepEqual(h.posts.at(-1), { type: 'visible', value: true });
  assert.ok(card(h, 'plan:90-02').querySelector('.badge-blocked'), 'the cached model is drawn when the view shows again');
  assert.equal(h.$$('.card').length, drawnBefore);
});

test('NearAiBoard exposes the whole API; refusals and pending lines render, announce and clear', async () => {
  const { h, world } = await drawn();
  const board = api(h);
  for (const name of ['post', 'announce', 'icon', 'layout', 'model', 'cardData', 'cardElement', 'focusCard', 'setPending', 'showRefusal', 'clearRefusal', 'setFilter', 'onRender', 'onMessage', 'registerMenu', 'openMenu', 'registerDetail', 'openDetail', 'registerForm', 'openForm']) {
    assert.equal(typeof board[name], 'function', name);
  }
  assert.equal(board.layout(), 'kanban');
  assert.equal(board.cardData('plan:90-01').displayId, '90-01');
  assert.equal(board.cardElement('plan:90-01'), card(h, 'plan:90-01'));
  assert.equal(board.focusCard('plan:90-01'), true);
  assert.equal(focusedId(h), 'plan:90-01');
  board.post({ type: 'retry' });
  assert.deepEqual(h.posts.at(-1), { type: 'retry' });

  const reason = 'Claiming a plan arrives in a later update. Nothing was moved.';
  board.setPending('plan:90-01', 'Moving to Claimed...');
  board.showRefusal('plan:90-01', 'Claimed', reason);
  assert.equal(card(h, 'plan:90-01').querySelector('.pending-line'), null, 'a refusal ends the pending line');
  assert.equal(text(card(h, 'plan:90-01').querySelector('.refusal-line')), reason);
  assert.ok(card(h, 'plan:90-01').querySelector('.card-msg svg'), 'the refusal carries the error icon');
  const dismiss = card(h, 'plan:90-01').querySelector('.dismiss')!;
  assert.equal(dismiss.getAttribute('aria-label'), 'Dismiss message');
  h.advance(150);
  assert.equal(h.live(), `Can't move plan 90-01 to Claimed. ${reason}`);
  dismiss.click();
  assert.equal(card(h, 'plan:90-01').querySelector('.refusal-line'), null);

  board.showRefusal('plan:90-01', 'Claimed', reason);
  board.clearRefusal('plan:90-01');
  assert.equal(card(h, 'plan:90-01').querySelector('.refusal-line'), null);

  board.showRefusal('plan:90-01', 'Claimed', reason);
  world.accept(world.owner, 'item.updated', { id: 'plan:90-01', changes: { hold: true } });
  h.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  assert.equal(card(h, 'plan:90-01').querySelector('.refusal-line'), null, 'the refusal goes when the card changes');

  let renders = 0;
  const messages: string[] = [];
  board.onRender(() => { renders += 1; });
  board.onMessage('detail', (m: { itemId: string }) => messages.push(m.itemId));
  board.setFilter('ready', true);
  assert.ok(renders >= 1);
  h.deliver({ type: 'detail', itemId: 'plan:90-01', title: 'Alpha slice' });
  assert.deepEqual(messages, ['plan:90-01']);
});

test('icon(name) draws an aria-hidden inline svg for every meaning in the table and an empty svg for an unknown name', async () => {
  const { h } = await drawn();
  const names = ['circle-outline', 'play-circle', 'person', 'sync', 'eye', 'check-all', 'pass', 'circle-slash', 'lock', 'debug-pause', 'info', 'link', 'clock', 'arrow-swap', 'chevron-right', 'chevron-down', 'error', 'warning', 'filter', 'add', 'link-external', 'close', 'arrow-left', 'organization'];
  for (const name of names) {
    const svg = api(h).icon(name);
    assert.equal(svg.localName, 'svg', name);
    assert.equal(svg.getAttribute('aria-hidden'), 'true', name);
    assert.equal(svg.getAttribute('stroke'), 'currentColor', name);
    assert.ok(svg.children.length > 0, `${name} has a shape`);
  }
  const unknown = api(h).icon('no-such-icon');
  assert.equal(unknown.children.length, 0);
  assert.equal(unknown.getAttribute('aria-hidden'), 'true');
});

test('WR-04: the card state chip and the page state box have their own classes, so the chip lays out its icon beside its word', async () => {
  // Every rule that reaches the chip (class "state") lays it out in a row; only the box (class "state-box") is a centred column.
  const rules = [...BOARD_CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selector: (m[1] ?? '').trim(), body: m[2] ?? '' }));
  const reachesChip = rules.filter((rule) => rule.selector.split(',').some((part) => /\.state(?![\w-])/.test(part)));
  assert.ok(reachesChip.length > 0);
  assert.equal(reachesChip.some((rule) => /flex-direction:\s*column|text-align:\s*center/.test(rule.body)), false, reachesChip.map((rule) => rule.selector).join(' | '));
  assert.ok(rules.some((rule) => /^\.state-box$/.test(rule.selector) && /flex-direction:\s*column/.test(rule.body)), 'the box is still a column');
  const world = await standard();
  const h = start();
  h.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  const chip = card(h, 'plan:90-01').querySelector('.card-top')!.firstElementChild!;
  assert.equal(chip.className, 'state');
  assert.equal(h.$$('.state-box').length, 0, 'no box while cards are shown');
});

test('board.css: only theme variables for colour, borders kept in high contrast and forced colours, no motion when reduced, and the narrow rules', () => {
  assert.doesNotMatch(BOARD_CSS, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  assert.doesNotMatch(BOARD_CSS, /(?<![-\w])(?:white|black|red|green|blue|yellow|orange|purple|pink|brown|gr[ae]y|cyan|magenta|silver|gold|navy|teal|maroon|olive|lime|aqua|fuchsia)(?![-\w])/i);
  const variables = [...BOARD_CSS.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
  assert.ok(variables.length > 40);
  // 62-21: board.js writes two layout variables (the column widths and the header row height); they are sizes, never colours. Every colour is a theme variable.
  const LAYOUT_VARIABLES = ['--board-columns', '--board-head-height'];
  assert.ok(variables.every((name) => name.startsWith('--vscode-') || LAYOUT_VARIABLES.includes(name ?? '')), `non-theme variable: ${variables.find((name) => !name.startsWith('--vscode-'))}`);
  for (const declaration of BOARD_CSS.matchAll(/([\w-]+)\s*:[^;{}]*var\(\s*--board-/g)) {
    assert.match(declaration[1] ?? '', /^(grid-template-columns|scroll-padding-top)$/, `a layout variable is used only for sizes, not in ${declaration[1]}`);
  }
  assert.match(BOARD_CSS, /@media \(prefers-reduced-motion: reduce\)[^{]*\{[^}]*transition-duration: 0\.01ms[^}]*animation-duration: 0\.01ms/);
  assert.match(BOARD_CSS, /@media \(forced-colors: active\)[\s\S]*?\.card[\s\S]*?border: 1px solid/);
  assert.match(BOARD_CSS, /body\.vscode-high-contrast \.card[\s\S]*?var\(--vscode-contrastBorder\)/);
  assert.match(BOARD_CSS, /vscode-high-contrast-light/);
  assert.match(BOARD_CSS, /@media \(max-width: 520px\)/);
  assert.match(BOARD_CSS, /@media \(max-width: 280px\)/);
  assert.match(BOARD_CSS, /button\.link:hover, button\.link:focus-visible \{ text-decoration: underline/);
  assert.match(BOARD_CSS, /body\.vscode-high-contrast button\.link/);
  assert.doesNotMatch(BOARD_CSS, /@import|url\(|@font-face|https?:/);
  for (const selector of ['#toolbar', '#banner', '#detail', '#menu', '#item-form', '.column', '.lane', '.cell', '.card', '.card-main', '.move-btn', '.group-head', '.dragging', '.drop-ok', '.changed', '.pending', '.refusal-line']) {
    assert.ok(BOARD_CSS.includes(selector), `${selector} is styled`);
  }
  assert.doesNotMatch(BOARD_CSS, /[—–]/);
});

// Owner decisions 2026-11-03 (G-62-2, G-62-4, plan 62-21): the toolbar is a solid band, the board region below it is the one scroller, and the header row
// and every lane share one column layout that board.js writes as --board-columns.
const cssRule = (selector: string): string => {
  const css = BOARD_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = css.split('}').map((chunk) => chunk.split('{')).filter((pair) => pair.length === 2 && (pair[0] ?? '').trim() === selector).map((pair) => pair[1] ?? '');
  assert.ok(found.length > 0, `${selector} has a rule`);
  return found.join(';');
};

test('G-62-2 and G-62-4: the kanban writes one column layout for the header row and every lane, 256 px open and 40 px folded, and the header row height', async () => {
  const world = await standard();
  const h = start({ width: 1200 });
  h.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  const region = h.$('.board-scroll')!;
  const expected = (): string => h.$$('.column').map((c) => (c.className.includes('collapsed') ? '40px' : '256px')).join(' ');
  assert.equal(h.$$('.column').length, 8);
  assert.equal(region.style.getPropertyValue('--board-columns'), expected(), 'the widths follow the column order and folds');
  assert.match(region.style.getPropertyValue('--board-columns'), /^(?:(?:256|40)px ){7}(?:256|40)px$/);
  h.$('.column[data-column="backlog"] .col-btn')!.click();
  assert.match(region.style.getPropertyValue('--board-columns'), /^40px /, 'folding Backlog narrows the first column for the headers and every lane at once');
  assert.equal(region.style.getPropertyValue('--board-columns'), expected());
  assert.match(region.style.getPropertyValue('--board-head-height'), /^\d+px$/, 'the header row height is written for the scroll padding');
  // The order inside the board region: the later-columns note, then the header row, then the lanes.
  assert.deepEqual(Array.from(region.children).map((n) => n.className), ['later-note', 'colheads', 'lanes']);
});

test('G-62-2 and G-62-4: board.css gives a solid toolbar band, one board scroller with a sticky opaque header row, and a shared grid with full-height cells', () => {
  const toolbar = cssRule('#toolbar');
  assert.doesNotMatch(BOARD_CSS, /background:\s*inherit/, 'nothing inherits a see-through background');
  assert.doesNotMatch(toolbar, /position:\s*sticky/, 'the toolbar is a band, not a sticky layer over the cards');
  assert.match(toolbar, /background:\s*var\(--vscode-editor-background\)/, 'the toolbar has a solid fill');
  assert.match(cssRule('#root[data-layout="kanban"]'), /height:\s*100vh/, 'the kanban page fills the view and does not scroll itself');
  const scroller = cssRule('.board-scroll');
  assert.match(scroller, /overflow:\s*auto/, 'the board region scrolls both ways');
  assert.match(scroller, /scroll-padding-top:\s*var\(--board-head-height/, 'a focused card is never scrolled under the header row');
  const head = cssRule('.colheads');
  assert.match(head, /position:\s*sticky/);
  assert.match(head, /top:\s*0/);
  assert.match(head, /z-index:\s*[1-9]/);
  assert.match(head, /background:\s*var\(--vscode-editor-background\)/);
  assert.match(cssRule('.colheads, .lane-grid'), /grid-template-columns:\s*var\(--board-columns/);
  assert.match(cssRule('.colheads, .lane-grid'), /gap:\s*12px/);
  assert.match(cssRule('.cell'), /min-height:\s*64px/);
  assert.match(cssRule('.lane-grid'), /align-items:\s*stretch/, 'cells are as tall as their row');
  assert.match(cssRule('.lane-title'), /position:\s*sticky[\s\S]*left:\s*0/, 'lane titles stay on the left while the board scrolls sideways');
});

// Owner decision 2026-11-03 (G-62-7, plan 62-21): every card is readable. A folded column never holds a card, only its count for screen readers; titles
// wrap between words; the card's main button looks like the card, not like a button.
test('G-62-7: a folded column holds no card, only a hidden count in every lane; opening it brings the cards back and focus never lands in a folded cell', async () => {
  const world = await standard();
  const model = modelOf(world, world.owner.memberId);
  const h = start({ width: 1200 });
  h.deliver({ type: 'state', model });
  const inReady = model.cards.filter((c) => c.column === 'ready' && c.lane.member === 'unassigned' && (c.milestoneId === undefined || c.milestoneId === model.selectedMilestone));
  assert.ok(inReady.some((c) => c.id === 'plan:90-01'), 'the standard board has plan 90-01 in Ready');
  assert.ok(h.$('.cell[data-column="ready"][data-lane="unassigned"]')!.contains(card(h, 'plan:90-01')));

  h.$('.column[data-column="ready"] .col-btn')!.click();
  const folded = h.$$('.cell[data-column="ready"]');
  assert.ok(folded.length > 0, 'every lane still has a Ready cell');
  for (const cell of folded) {
    assert.equal(cell.querySelectorAll('.card').length, 0, 'no card inside a folded cell');
    assert.notEqual(cell.tagName.toLowerCase(), 'ul', 'no card list inside a folded cell');
    const hidden = cell.querySelectorAll('.sr-only');
    assert.equal(hidden.length, 1, 'one hidden count');
    assert.equal(cell.children.length, 1, 'and nothing else');
  }
  const count = inReady.length;
  assert.equal(text(h.$('.cell[data-column="ready"][data-lane="unassigned"] .sr-only')), `${count} ${count === 1 ? 'card' : 'cards'}, column folded`);
  assert.equal(h.$('.card[data-id="plan:90-01"]'), null, 'the card of a folded column is left out of the page, not hidden');
  assert.equal(api(h).focusCard('plan:90-01'), false, 'a card of a folded column cannot take focus');
  const active = h.document.activeElement as FakeNode | null;
  assert.ok(!active || !active.closest || !active.closest('.cell.collapsed'), 'focus is not inside a folded cell');

  h.$('.column[data-column="ready"] .col-btn')!.click();
  assert.ok(h.$('ul.cell[data-column="ready"][data-lane="unassigned"]')!.contains(card(h, 'plan:90-01')), 'opening the column puts the card back');
  h.$('.column[data-column="ready"] .col-btn')!.click();
  assert.equal(h.$('.card[data-id="plan:90-01"]'), null, 'folding it again removes the card');
  assert.equal(h.$$('.cell.collapsed .card').length, 0);
});

// 62-22 screenshot matrix: in the light theme the selected Group by choice showed its word in the caption grey on the button fill; in high contrast the
// button fill is see-through, so nothing marked the choice or a pressed filter; the detail's state line ran its parts together ("BacklogPhase 63").
test('62-22: the selected Group by choice and a pressed filter are readable in every theme, and the detail head spaces its parts', () => {
  assert.doesNotMatch(BOARD_CSS, /\.group-by \.label/, 'the caption colour does not reach the words inside the choices');
  assert.match(BOARD_CSS, /\.group-by > \.label/);
  for (const kind of ['high-contrast', 'high-contrast-light']) {
    for (const selector of ['\\.segmented button\\[aria-checked="true"\\]', 'button\\.chip\\[aria-pressed="true"\\]']) {
      assert.match(BOARD_CSS, new RegExp(`body\\.vscode-${kind} ${selector}[^{]*\\{[^}]*outline: 2px solid var\\(--vscode-contrastActiveBorder\\)`), `${kind}: ${selector} is marked`);
    }
  }
  assert.match(BOARD_CSS, /@media \(forced-colors: active\)[\s\S]*?\.segmented button\[aria-checked="true"\], button\.chip\[aria-pressed="true"\] \{[^}]*outline: 2px solid currentColor/);
  const rows = cssRule('#detail .detail-state, #detail .detail-badges, #detail .detail-actions');
  assert.match(rows, /display: flex/);
  assert.match(rows, /gap: 4px 8px/);
  assert.match(cssRule('#detail li.dep > .icon'), /margin-right: 4px/);
});

test('G-62-7: board.css wraps card text between words and resets the card button to the card\'s own look', () => {
  assert.doesNotMatch(BOARD_CSS, /overflow-wrap:\s*anywhere/, 'no mid-word breaks anywhere on the board');
  assert.doesNotMatch(BOARD_CSS, /font-size:\s*0\s*;/, 'nothing is hidden by a zero font size');
  const text = cssRule('.card-title, .card-meta, .card-rule, .pending-line, .refusal-line');
  assert.match(text, /overflow-wrap:\s*break-word/, 'a long unbroken path still wraps instead of overflowing');
  assert.match(text, /word-break:\s*normal/, 'words break only between words');
  const main = cssRule('.card-main');
  const property = (body: string): string[] => body.split(';').map((d) => (d.split(':')[0] ?? '').trim()).filter((name) => name !== '');
  // Every property the global button rule sets is set again on the card button, so nothing of the button look is left over.
  for (const name of property(cssRule('button'))) assert.ok(property(main).includes(name), `.card-main resets ${name}`);
  assert.match(main, /text-align:\s*left/);
  assert.match(main, /justify-content:\s*flex-start/);
  assert.match(main, /color:\s*inherit/);
  assert.match(main, /font-weight:\s*inherit/);
  assert.match(main, /background:\s*none/);
  assert.match(main, /border:\s*0/);
  assert.match(main, /white-space:\s*normal/);
});

// Owner decision 2026-11-03 (G-62-3, plan 62-21, refines D-13): the board opens on active work. The model says which columns start folded
// (foldedByDefault) and which lanes start collapsed (collapsedByDefault); the client follows it. Saved choices carry a version, so the older board's
// collapse and filter choices are dropped once.
test('G-62-3: with nothing saved the kanban folds exactly the columns the model folds, lanes follow the model, and the list opens Backlog and Ready', async () => {
  const world = await standard();
  const model = modelOf(world, world.owner.memberId);
  const h = start({ width: 1200 });
  h.deliver({ type: 'state', model });
  const folded = (harness: BoardHarness): string[] => harness.$$('.column').filter((c) => c.className.includes('collapsed')).map((c) => c.getAttribute('data-column') ?? '');
  assert.deepEqual(folded(h), model.columns.filter((c) => c.foldedByDefault).map((c) => c.key));
  assert.deepEqual(folded(h), ['claimed', 'in-progress', 'in-review', 'integrating', 'done', 'cancelled']);
  for (const lane of h.$$('.lane')) {
    const info = model.lanes.member.find((l) => l.key === lane.getAttribute('data-lane'))!;
    assert.equal(lane.querySelector('.lane-head')!.getAttribute('aria-expanded'), info.collapsedByDefault ? 'false' : 'true', `lane ${info.key}`);
  }
  assert.equal(text(h.$('.later-note')), 'Claimed, In progress, In review and Shipping are folded for now. They fill in when those steps arrive in a later update. Done and Cancelled are folded to keep finished work out of the way.');
  assert.doesNotMatch(text(h.$('.later-note')), /[—–]/);
  // The client takes the folds from the model, not from a list of its own.
  const changed = JSON.parse(JSON.stringify(model)) as BoardModel;
  for (const c of changed.columns) c.foldedByDefault = c.key === 'backlog';
  const other = start({ width: 1200 });
  other.deliver({ type: 'state', model: changed });
  assert.deepEqual(folded(other), ['backlog']);
  assert.equal(other.$('.later-note')!.hidden, true, 'no note when no later or finished column is folded');
  h.setWidth(400);
  assert.deepEqual(h.$$('.group[data-column]').filter((g) => g.querySelector('.group-head')!.getAttribute('aria-expanded') === 'true').map((g) => g.getAttribute('data-column')), ['backlog', 'ready']);
});

test('G-62-3: Done opened is kept across a reload; choices saved by the older board are dropped once, then new choices are kept', async () => {
  const world = await standard();
  const model = modelOf(world, world.owner.memberId);
  const h = start({ width: 1200 });
  h.deliver({ type: 'state', model });
  h.$('.column[data-column="done"] .col-btn')!.click();
  const saved = h.state as Record<string, unknown>;
  assert.equal(typeof saved.version, 'number', 'the saved state carries its version');
  const again = start({ width: 1200, state: h.state });
  again.deliver({ type: 'state', model });
  assert.equal(again.$('.column[data-column="done"] .col-btn')!.getAttribute('aria-expanded'), 'true', 'Done stays open after a reload');

  // The older board saved no version: its collapsed Unassigned lane, opened Done column and Mine filter are dropped; the grouping and a draft stay.
  const older = { groupBy: 'phase', filters: { mine: true, ready: false, blocked: false, requirement: '', phase: '' }, collapsedColumns: { done: false, backlog: true }, collapsedLanes: { 'member:unassigned': true }, openGroups: { done: true }, draft: { title: 'Half written' } };
  const o = start({ width: 1200, state: older });
  o.deliver({ type: 'state', model });
  assert.equal(radio(o, 'Phase').getAttribute('aria-checked'), 'true', 'the grouping is kept');
  radio(o, 'Member').click();
  assert.equal(o.$('.lane[data-lane="unassigned"] .lane-head')!.getAttribute('aria-expanded'), 'true', 'Unassigned is open again');
  assert.equal(o.$('.column[data-column="done"] .col-btn')!.getAttribute('aria-expanded'), 'false', 'Done is folded again');
  assert.equal(o.$('.column[data-column="backlog"] .col-btn')!.getAttribute('aria-expanded'), 'true', 'Backlog is open again');
  assert.equal(chip(o, 'Mine').getAttribute('aria-pressed'), 'false', 'the old Mine filter is dropped');
  assert.deepEqual(JSON.parse(JSON.stringify(api(o).getDraft())), { title: 'Half written' }, 'an unsent draft is never thrown away');
  // Dropped once: a choice made now is saved with the version and kept.
  o.$('.lane[data-lane="unassigned"] .lane-head')!.click();
  const third = start({ width: 1200, state: o.state });
  third.deliver({ type: 'state', model });
  assert.equal(third.$('.lane[data-lane="unassigned"] .lane-head')!.getAttribute('aria-expanded'), 'false', 'a new collapse is kept');
});

// Owner decision 2026-11-03 (G-62-1): the board lives only in its own editor tab, so the page has no button or message that opens the board.
test('G-62-1: the toolbar has Import plans and New item at 400 px and at 900 px, no button opens the board, and nothing posts a request for it', async () => {
  const toolbarButtons = (h: BoardHarness): string[] => h.$$('.actions button').filter((b) => !b.hidden).map((b) => b.textContent ?? '');
  for (const width of [400, 900]) {
    const { h } = await drawn(width, 'owner');
    assert.equal(h.root.getAttribute('data-layout'), width === 400 ? 'list' : 'kanban');
    assert.deepEqual(toolbarButtons(h), ['Import plans', 'New item'], `owner toolbar at ${width} px`);
    assert.equal(buttonNamed(h, 'Open Team Board'), undefined, `no Open Team Board button at ${width} px`);
    for (const b of h.$$('.actions button').filter((node) => !node.hidden && node.textContent !== 'New item')) b.click();
    assert.equal(h.posts.some((m) => (m as { type?: string }).type === 'open-board'), false, `no toolbar click asks to open the board at ${width} px`);
    const dev = (await drawn(width, 'dev')).h;
    assert.deepEqual(toolbarButtons(dev), ['New item'], `developer toolbar at ${width} px`);
  }
  for (const file of ['board.js', 'menu.js', 'drag.js', 'detail.js', 'form.js']) {
    assert.equal(readFileSync(path.join(MEDIA, file), 'utf8').includes('open-board'), false, `${file} never posts open-board`);
  }
});

test('G-62-1: the page takes the editor background in both layouts, has no surface rules, and the list layout still clamps titles to 2 lines', () => {
  const css = BOARD_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(css.includes('data-surface'), false, 'no rule depends on a surface mark');
  const body = [...css.matchAll(/(^|\})\s*body\s*\{([^}]*)\}/g)].map((m) => m[2] ?? '');
  assert.equal(body.length, 1, 'one plain body rule');
  assert.match(body[0] ?? '', /background:\s*var\(--vscode-editor-background\)\s*;/, 'the body takes the editor background');
  assert.doesNotMatch(body[0] ?? '', /sideBar/, 'no sidebar colour');
  assert.match(css, /#root\[data-layout="list"\] \.card-title\s*\{[^}]*-webkit-line-clamp:\s*2/, 'the list layout clamps titles to 2 lines');
});

test('J-02: the card face says the Backlog rule in normal text and the accessible name ends with it; other cards have no rule', async () => {
  const world = await standard();
  const model = modelOf(world, world.owner.memberId);
  const h = start();
  h.deliver({ type: 'state', model });
  const rule = 'Stays in Backlog until it says which parts of the project it covers and roughly how big it is.';
  const chore = model.cards.find((c) => c.id === CHORE_ID)!;
  assert.equal(text(main(h, CHORE_ID).querySelector('.card-rule')), rule);
  assert.equal(main(h, CHORE_ID).querySelector('.card-rule')!.className, 'card-rule');
  assert.equal(main(h, CHORE_ID).getAttribute('aria-label'), `${chore.a11yLabel} ${rule}`);
  const plan = model.cards.find((c) => c.id === 'plan:90-01')!;
  assert.equal(main(h, 'plan:90-01').querySelector('.card-rule'), null);
  assert.equal(main(h, 'plan:90-01').getAttribute('aria-label'), plan.a11yLabel);
});

// ---- 62-20: the person on the card face and Move to... for cards that can only be assigned (G-62-5, owner decision 2026-11-03) ----------------------

function startWith(files: string[]): BoardHarness {
  const h = createBoardHarness({ width: 800 });
  h.load(files);
  return h;
}

test('an assigned card shows the initials chip and the name first in its meta row; a card nobody has shows no chip', async () => {
  const world = await standard();
  world.accept(world.lead, 'item.assigned', { id: 'plan:90-01', memberId: world.dev.memberId });
  const model = modelOf(world, world.owner.memberId);
  const h = start();
  h.deliver({ type: 'state', model });
  const meta = main(h, 'plan:90-01').querySelector('.card-meta')!;
  const first = meta.children[0]!;
  assert.ok(first.classList.contains('assignee'), 'the chip comes first in the meta row');
  const initials = first.querySelector('.assignee-initials')!;
  assert.equal(text(initials), 'D');
  assert.equal(initials.getAttribute('aria-hidden'), 'true', 'the initials are not read out; the name is');
  assert.equal(text(first.querySelector('.assignee-name')), 'Dana');
  assert.match(main(h, 'plan:90-01').getAttribute('aria-label') ?? '', /Assigned to Dana\./);
  assert.equal(main(h, 'plan:90-02').querySelector('.assignee'), null, 'nobody has plan:90-02, so it has no chip');

  // The chip follows the card: taken off, it goes; a hostile name is drawn as text.
  world.accept(world.lead, 'item.unassigned', { id: 'plan:90-01' });
  h.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  assert.equal(main(h, 'plan:90-01').querySelector('.assignee'), null);
  const hostile = withCards(model, (cards) => { cards.find((c) => c.id === 'plan:90-01')!.assignee = { id: 'member:x', name: '<b>Eve</b>', initials: '<B' }; });
  h.deliver({ type: 'state', model: hostile });
  assert.equal(text(main(h, 'plan:90-01').querySelector('.assignee-name')), '<b>Eve</b>');
  assert.equal(main(h, 'plan:90-01').querySelectorAll('b').length, 0, 'no element was made from the name');
});

test('a phase card that can only be assigned shows Move to..., is not draggable, and M opens a menu with only the assignment item', async () => {
  const world = await standard();
  const model = modelOf(world, world.owner.memberId);
  const phase = model.cards.find((c) => c.id === 'phase:91')!;
  assert.deepEqual(phase.moves, [], 'a phase card has no moves');
  assert.deepEqual(phase.assignActions, ['assign']);
  const h = startWith(['board.js', 'menu.js', 'drag.js']);
  h.deliver({ type: 'state', model });
  const button = card(h, 'phase:91').querySelector('.move-btn')!;
  assert.equal(button.hidden, false, 'Move to... shows for a card that can only be assigned');
  assert.equal(card(h, 'phase:91').getAttribute('draggable'), null, 'only cards with moves are draggable');
  assert.equal(card(h, 'plan:90-01').getAttribute('draggable'), 'true', 'a card with moves still is');
  main(h, 'phase:91').focus();
  h.press(main(h, 'phase:91'), 'M');
  const items = Array.from(h.$('#menu')!.querySelectorAll('[role="menuitem"]')).map((i) => text(i));
  assert.deepEqual(items, ['Assign to...']);

  const dev = startWith(['board.js', 'menu.js', 'drag.js']);
  const devModel = modelOf(world, world.dev.memberId);
  assert.deepEqual(devModel.cards.find((c) => c.id === 'phase:91')!.assignActions, ['assign-me']);
  dev.deliver({ type: 'state', model: devModel });
  assert.equal(card(dev, 'phase:91').querySelector('.move-btn')!.hidden, false);
  assert.equal(card(dev, 'phase:91').getAttribute('draggable'), null);
  main(dev, 'phase:91').focus();
  dev.press(main(dev, 'phase:91'), 'M');
  assert.deepEqual(Array.from(dev.$('#menu')!.querySelectorAll('[role="menuitem"]')).map((i) => text(i)), ['Assign to me']);

  const none = withCards(model, (cards) => { cards.find((c) => c.id === 'phase:91')!.assignActions = []; });
  const empty = startWith(['board.js', 'menu.js', 'drag.js']);
  empty.deliver({ type: 'state', model: none });
  assert.equal(card(empty, 'phase:91').querySelector('.move-btn')!.hidden, true, 'neither moves nor assignment: no Move to...');
});

test('board.css: the assignee chip is round and small, uses only theme variables and keeps a 1px border in high contrast and forced colours', () => {
  const css = readFileSync(path.join(MEDIA, 'board.css'), 'utf8');
  assert.match(css, /\.assignee-initials \{[^}]*border: 1px solid currentColor/);
  assert.match(css, /\.assignee-initials \{[^}]*border-radius: 50%/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/, 'no colour literal');
  const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
  assert.match(forced, /\.assignee-initials/, 'the chip keeps its border in forced colours');
  assert.match(css, /body\.vscode-high-contrast \.assignee-initials[^{]*\{[^}]*border: 1px solid var\(--vscode-contrastBorder\)/, 'and in high contrast');
});
