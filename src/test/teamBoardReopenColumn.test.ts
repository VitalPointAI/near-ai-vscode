// RED for the 0.6.4 re-test (owner, 2026-11-05, board steps 12 and 16; debug session board-reopen-lands-in-ready): a finished plan dropped on
// Backlog, or moved with Move to... -> "Backlog (reopen)", must be drawn in Backlog afterwards. Today the reopen is written and accepted, but a
// reopened plan that has its files, an estimate and finished dependencies is drawn in Ready (work.ts columnOf derives Ready from readiness), so the
// card leaves Done and never shows where it was dropped. The scratch project's imported plans are all like that: every reopen there lands in Ready.
import assert from 'node:assert/strict';
import test from 'node:test';
import { availableMoves, columnMove, planMove } from '../domain/team/board';
import { effectiveColumn } from '../domain/team/work';
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

function columnOf(world: BoardWorld, id: string): string {
  const item = world.state.items.get(id);
  assert.ok(item !== undefined, `${id} exists`);
  return effectiveColumn(world.state.items, item);
}

// The owner drops the card on a column: the drop's move is planned and written exactly as the host writes it.
function drop(world: BoardWorld, id: string, column: 'backlog'): void {
  const owner = world.owner.memberId;
  const verdict = columnMove(world.state, owner, id, column);
  assert.ok(verdict.ok && verdict.move !== undefined, `the drop on ${column} is a move: ${JSON.stringify(verdict)}`);
  const planned = planMove(world.state, owner, id, verdict.move);
  assert.ok(planned.ok, planned.ok ? '' : planned.reason);
  world.accept(world.owner, planned.intent.type, planned.intent.body as never);
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
  world.accept(world.owner, planned.intent.type, planned.intent.body as never);
  assert.equal(columnOf(world, READY_SHAPED), reopen.column, `the menu said ${reopen.column}`);
});

// Boundary neighbour: a finished plan that is not ready once open again already lands in Backlog (GREEN today, kept so a fix does not break it).
test('a finished plan without an estimate dropped on Backlog is drawn in Backlog', async () => {
  const world = await doneWorld();
  drop(world, NO_ESTIMATE, 'backlog');
  assert.equal(columnOf(world, NO_ESTIMATE), 'backlog');
});
