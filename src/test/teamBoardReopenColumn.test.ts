// RED for the 0.6.4 re-test (owner, 2026-11-05, board steps 12 and 16; debug session board-reopen-lands-in-ready): a finished plan dropped on
// Backlog, or moved with Move to... -> "Backlog (reopen)", must be drawn in Backlog afterwards. Today the reopen is written and accepted, but a
// reopened plan that has its files, an estimate and finished dependencies is drawn in Ready (work.ts columnOf derives Ready from readiness), so the
// card leaves Done and never shows where it was dropped. The scratch project's imported plans are all like that: every reopen there lands in Ready.
import assert from 'node:assert/strict';
import test from 'node:test';
import { availableMoves, columnMove, planMove } from '../domain/team/board';
import { applyEntry } from '../domain/team/materialize';
import { effectiveColumn } from '../domain/team/work';
import { entryOf, signed } from './helpers/teamEvents';
import { boardWorld, importedBody, seedStandardBoard } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';

const READY_SHAPED = 'plan:91-01';
const NO_ESTIMATE = 'plan:91-02';

// Two imported plans that GSD finished (state done, summary), like the scratch project's: one with files and an estimate (ready-shaped once it is
// open again), one without an estimate (not ready once open again).
async function doneWorld(): Promise<BoardWorld> {
  const world = await boardWorld();
  seedStandardBoard(world);
  const { owner } = world;
  world.accept(owner, 'item.imported', importedBody({ id: READY_SHAPED, kind: 'plan', title: 'Finished slice', parentId: 'phase:91', state: 'done', summary: true, scope: ['src/c/**'], estimate: { tokens: 5000 } }));
  world.accept(owner, 'item.imported', importedBody({ id: NO_ESTIMATE, kind: 'plan', title: 'Finished, no size', parentId: 'phase:91', state: 'done', summary: true, scope: ['src/d/**'] }));
  return world;
}

// A finished plan that is assigned to the developer: the assignment happens while it is open (a done card takes no new assignee), then the plan is
// marked done, so the developer is its assignee and holds the move (owner decision 2026-11-04, 62-27).
async function doneWorldAssignedToDev(): Promise<BoardWorld> {
  const world = await boardWorld();
  seedStandardBoard(world);
  world.accept(world.owner, 'item.imported', importedBody({ id: READY_SHAPED, kind: 'plan', title: 'Finished slice', parentId: 'phase:91', scope: ['src/c/**'], estimate: { tokens: 5000 } }));
  world.accept(world.owner, 'item.imported', importedBody({ id: NO_ESTIMATE, kind: 'plan', title: 'Finished, no size', parentId: 'phase:91', scope: ['src/d/**'] }));
  world.accept(world.lead, 'item.assigned', { id: READY_SHAPED, memberId: world.dev.memberId });
  world.accept(world.owner, 'item.updated', { id: READY_SHAPED, changes: { state: 'done' } });
  world.accept(world.owner, 'item.updated', { id: NO_ESTIMATE, changes: { state: 'done' } });
  return world;
}

function columnOf(world: BoardWorld, id: string): string {
  const item = world.state.items.get(id);
  assert.ok(item !== undefined, `${id} exists`);
  return effectiveColumn(world.state.items, item);
}

// The owner drops the card on a column: the drop's move is planned and written exactly as the host writes it, every intent in order (owner decision
// 2026-11-05: a reopen is item.reopened then item.updated { hold: true } in one append, not the first intent alone).
function drop(world: BoardWorld, id: string, column: 'backlog'): void {
  const owner = world.owner.memberId;
  const verdict = columnMove(world.state, owner, id, column);
  assert.ok(verdict.ok && verdict.move !== undefined, `the drop on ${column} is a move: ${JSON.stringify(verdict)}`);
  const planned = planMove(world.state, owner, id, verdict.move);
  assert.ok(planned.ok, planned.ok ? '' : planned.reason);
  for (const intent of planned.intents) world.accept(world.owner, intent.type, intent.body as never);
}

test('the owner drops a finished, ready-shaped plan on Backlog: it is drawn in Backlog afterwards', async () => {
  const world = await doneWorld();
  assert.equal(columnOf(world, READY_SHAPED), 'done', 'starts in Done');
  drop(world, READY_SHAPED, 'backlog');
  assert.equal(columnOf(world, READY_SHAPED), 'backlog', 'the card is where it was dropped');
});

test('Move to... on a finished plan: the column the menu names is the column the card is drawn in afterwards', async () => {
  const world = await doneWorld();
  const owner = world.owner.memberId;
  const offered = availableMoves(world.state, owner, READY_SHAPED);
  const reopen = offered.find((move) => move.key === 'reopen');
  assert.ok(reopen !== undefined, `Reopen is offered: ${JSON.stringify(offered)}`);
  assert.equal(reopen.column, 'backlog', 'the menu names Backlog');
  const planned = planMove(world.state, owner, READY_SHAPED, 'reopen');
  assert.ok(planned.ok, planned.ok ? '' : planned.reason);
  for (const intent of planned.intents) world.accept(world.owner, intent.type, intent.body as never);
  assert.equal(columnOf(world, READY_SHAPED), reopen.column, `the menu said ${reopen.column}`);
});

// Boundary neighbour: a finished plan that is not ready once open again already lands in Backlog (GREEN today, kept so a fix does not break it).
test('a finished plan without an estimate dropped on Backlog is drawn in Backlog', async () => {
  const world = await doneWorld();
  drop(world, NO_ESTIMATE, 'backlog');
  assert.equal(columnOf(world, NO_ESTIMATE), 'backlog');
});

// ---- The reopen is one append of two events (62-28, Task 2) --------------------------------------------------------------------------------
// Owner decision 2026-11-05: every reopen lands in Backlog and is held there. The reopen alone clears the hold in the materialiser, so the move is
// written as item.reopened then item.updated { hold: true } in a single append, and every clone agrees on both events.

test('planMove plans the reopen as item.reopened then item.updated { hold: true }, and every other move as one intent', async () => {
  const world = await doneWorld();
  const owner = world.owner.memberId;
  for (const id of [READY_SHAPED, NO_ESTIMATE]) {
    const planned = planMove(world.state, owner, id, 'reopen');
    assert.ok(planned.ok, planned.ok ? '' : planned.reason);
    assert.deepEqual(planned.intents, [
      { type: 'item.reopened', body: { id } },
      { type: 'item.updated', body: { id, changes: { hold: true } } }
    ], `${id}: the reopen and its hold, in that order`);
    assert.equal(planned.intent, planned.intents[0], 'intent is the first of the pair');
  }
  // Every other move is still one intent.
  const hold = planMove(world.state, owner, 'plan:90-01', 'hold');
  assert.ok(hold.ok, hold.ok ? '' : hold.reason);
  assert.deepEqual(hold.intents, [{ type: 'item.updated', body: { id: 'plan:90-01', changes: { hold: true } } }]);
  assert.equal(hold.intents.length, 1);
});

test('a reopened card is held and in Backlog on a replay of the log, and Release moves it on when its plan is ready to start', async () => {
  const world = await doneWorld();
  const owner = world.owner.memberId;
  const reopen = planMove(world.state, owner, READY_SHAPED, 'reopen');
  assert.ok(reopen.ok, reopen.ok ? '' : reopen.reason);
  for (const intent of reopen.intents) world.accept(world.owner, intent.type, intent.body as never);
  assert.equal(columnOf(world, READY_SHAPED), 'backlog', 'a ready-shaped plan reopened is drawn in Backlog');
  assert.equal(world.state.items.get(READY_SHAPED)?.hold, true, 'and it is held');

  // Nothing is released on the way in: the card stays in Backlog for a second move.
  assert.deepEqual(availableMoves(world.state, owner, READY_SHAPED).map((move) => move.key).includes('release'), true, 'Release is offered');

  const release = planMove(world.state, owner, READY_SHAPED, 'release');
  assert.ok(release.ok, release.ok ? '' : release.reason);
  assert.equal(release.intents.length, 1, 'a release is one event');
  world.accept(world.owner, release.intent.type, release.intent.body as never);
  assert.equal(columnOf(world, READY_SHAPED), 'ready', 'and then it is in Ready, because its plan is ready to start');
});

test('a reopened plan with no estimate stays in Backlog with its not-ready reason, and Release leaves it there', async () => {
  const world = await doneWorld();
  const owner = world.owner.memberId;
  const reopen = planMove(world.state, owner, NO_ESTIMATE, 'reopen');
  assert.ok(reopen.ok, reopen.ok ? '' : reopen.reason);
  for (const intent of reopen.intents) world.accept(world.owner, intent.type, intent.body as never);
  assert.equal(columnOf(world, NO_ESTIMATE), 'backlog');
  assert.equal(world.state.items.get(NO_ESTIMATE)?.hold, true);
  const release = planMove(world.state, owner, NO_ESTIMATE, 'release');
  assert.ok(release.ok, release.ok ? '' : release.reason);
  world.accept(world.owner, release.intent.type, release.intent.body as never);
  // Released, but still not ready: the column is computed from readiness, so it stays in Backlog and names what is missing.
  assert.equal(columnOf(world, NO_ESTIMATE), 'backlog');
  const { readiness } = require('../domain/team/work') as typeof import('../domain/team/work');
  assert.deepEqual(readiness(world.state.items, NO_ESTIMATE).reasons, ['no-estimate']);
});

test('the whole pair is accepted by the materialiser for the owner, a lead and the assignee, and the assignee\'s own reopen of a cancelled card is refused', async () => {
  const world = await doneWorldAssignedToDev();
  const owner = world.owner.memberId;
  const lead = world.lead.memberId;
  for (const viewerId of [owner, lead, world.dev.memberId]) {
    const planned = planMove(world.state, viewerId, READY_SHAPED, 'reopen');
    assert.equal(planned.ok, true, `${viewerId}: ${planned.ok ? '' : planned.reason}`);
    if (!planned.ok) continue;
    for (const intent of planned.intents) {
      const actor = viewerId === owner ? world.owner : viewerId === lead ? world.lead : world.dev;
      const event = signed(actor, { teamId: world.teamId, type: intent.type as never, body: intent.body as never, lamport: world.state.highLamport + 1, prev: world.state.head.eventId });
      const verdict = applyEntry(world.state, entryOf(event));
      assert.equal(verdict.accepted, true, `${viewerId}: ${intent.type} ${verdict.accepted ? '' : verdict.rejection.reason}`);
    }
    assert.equal(columnOf(world, READY_SHAPED), 'backlog', `${viewerId}: the card lands in Backlog`);
    assert.equal(world.state.items.get(READY_SHAPED)?.hold, true, `${viewerId}: and it is held`);
    // Put it back for the next viewer.
    world.accept(world.owner, 'item.updated', { id: READY_SHAPED, changes: { state: 'done' } });
  }

  // A cancelled card the owner or a lead brings back: it is held in Backlog too (owner decision 2026-11-05).
  const cancelledCard = planMove(world.state, owner, READY_SHAPED, 'reopen');
  assert.ok(cancelledCard.ok, cancelledCard.ok ? '' : cancelledCard.reason);
  if (!cancelledCard.ok) return;
  for (const intent of cancelledCard.intents) world.accept(world.owner, intent.type, intent.body as never);
  const cancel = planMove(world.state, owner, READY_SHAPED, 'cancel', { reason: 'replaced' });
  assert.ok(cancel.ok, cancel.ok ? '' : cancel.reason);
  world.accept(world.owner, cancel.intent.type, cancel.intent.body as never);
  assert.equal(columnOf(world, READY_SHAPED), 'cancelled');
  // The developer may not bring it back: neither event is planned, and the sentence is the cancel one.
  const refused = planMove(world.state, world.dev.memberId, READY_SHAPED, 'reopen');
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? '' : refused.reason, 'Only the team owner or a lead can cancel a card or bring back a cancelled one. Nothing was moved.');
  // The owner may, and the pair is accepted.
  const byOwner = planMove(world.state, owner, READY_SHAPED, 'reopen');
  assert.equal(byOwner.ok, true, byOwner.ok ? '' : byOwner.reason);
  if (!byOwner.ok) return;
  assert.equal(byOwner.intents.length, 2);
  for (const intent of byOwner.intents) world.accept(world.owner, intent.type, intent.body as never);
  assert.equal(columnOf(world, READY_SHAPED), 'backlog');
  assert.equal(world.state.items.get(READY_SHAPED)?.hold, true, 'brought back from Cancelled, it is held in Backlog too');
});

test('both events of the pair answer the same permission row, so a pair that is planned is a pair the log takes', async () => {
  const world = await doneWorldAssignedToDev();
  const { actionForEvent } = require('../domain/team/permissions') as typeof import('../domain/team/permissions');
  for (const actor of [world.owner, world.lead, world.dev]) {
    const planned = planMove(world.state, actor.memberId, READY_SHAPED, 'reopen');
    assert.ok(planned.ok, planned.ok ? '' : planned.reason);
    if (!planned.ok) continue;
    const rows = planned.intents.map((intent, index) => {
      const event = signed(actor, { teamId: world.teamId, type: intent.type as never, body: intent.body as never, lamport: world.state.highLamport + 1 + index, prev: index === 0 ? world.state.head.eventId : 'evt-probe' });
      return actionForEvent(event as never, world.state)?.kind;
    });
    // The assignee's own move is item.move-own; the owner and the lead move it on item.move. Either way both events of a pair answer the same row,
    // which is what makes a planned pair a pair the log takes.
    const expectedRow = actor === world.dev ? 'item.move-own' : 'item.move';
    assert.deepEqual(rows, [expectedRow, expectedRow], `${actor.memberId}: both events answer ${expectedRow}`);
  }
});
