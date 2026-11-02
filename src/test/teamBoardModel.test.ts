// The Team Board model (D-07, D-08, D-12, D-13, D-15, D-16, D-18): one pure function of the log decides what the board shows and which moves it offers.
// The tracer builds a model from real signed events, plans a hold with planMove, applies it through the materialiser and shows the card leave
// Ready for Backlog. Lanes, filters, ordering, card faces and card detail follow in the same file.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBoardModel, planMove } from '../domain/team/board';
import type { BoardModel, BoardModelOptions } from '../domain/team/board';
import { BOARD_COLUMNS } from '../domain/team/work';
import { CHORE_ID, boardWorld, seedStandardBoard } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';

const NOW = Date.parse('2026-03-05T12:00:00.000Z');

function optionsFor(world: BoardWorld, viewerId: string | undefined, extra: Partial<BoardModelOptions> = {}): BoardModelOptions {
  return { nowMs: NOW, status: { kind: 'live', text: 'Live' }, canWrite: viewerId !== undefined, ...(viewerId === undefined ? {} : { viewerId }), ...extra };
}

function modelFor(world: BoardWorld, viewerId: string | undefined, extra: Partial<BoardModelOptions> = {}): BoardModel {
  return buildBoardModel(world.state, optionsFor(world, viewerId, extra));
}

function card(model: BoardModel, id: string): BoardModel['cards'][number] {
  const found = model.cards.find((entry) => entry.id === id);
  assert.ok(found, `card ${id} is on the board`);
  return found;
}

test('tracer: a model from real events, a hold planned with planMove and applied, and the card moving from Ready to Backlog', async () => {
  const world = await boardWorld();
  seedStandardBoard(world);
  const before = modelFor(world, world.owner.memberId);

  assert.deepEqual(before.columns.map((column) => column.key), [...BOARD_COLUMNS]);
  assert.deepEqual(before.columns.map((column) => column.label), ['Backlog', 'Ready', 'Claimed', 'In progress', 'In review', 'Integrating', 'Done', 'Cancelled']);
  assert.deepEqual(before.columns.map((column) => column.caption), [
    'Waiting, on hold or not ready.', 'Ready to be claimed.', 'Claiming arrives in a later update.', 'Starting work arrives with claims.',
    'Review arrives in a later update.', 'Merging arrives in a later update.', undefined, undefined
  ]);
  assert.deepEqual(before.cards.map((entry) => [entry.id, entry.column]), [['plan:90-02', 'backlog'], [CHORE_ID, 'backlog'], ['plan:90-01', 'ready']]);
  assert.equal(before.selectedMilestone, 'milestone:v0.9.0');

  const ready = card(before, 'plan:90-01');
  assert.deepEqual(ready.moves.map((move) => move.key), ['done', 'cancel', 'hold', 'block']);
  assert.deepEqual(ready.refusals, {
    claimed: 'Claiming a plan arrives in a later update. Nothing was moved.',
    'in-progress': 'Starting work from the board arrives with claims in a later update. Nothing was moved.',
    'in-review': 'Review arrives in a later update. Nothing was moved.',
    integrating: 'Merging arrives in a later update. Nothing was moved.'
  });

  const plan = planMove(world.state, world.owner.memberId, 'plan:90-01', 'hold');
  assert.deepEqual(plan, { ok: true, intent: { type: 'item.updated', body: { id: 'plan:90-01', changes: { hold: true } } } });
  if (!plan.ok) return;
  world.accept(world.owner, plan.intent.type, plan.intent.body as never);

  const after = modelFor(world, world.owner.memberId);
  const held = card(after, 'plan:90-01');
  assert.equal(held.column, 'backlog');
  assert.equal(held.held, true);
  assert.deepEqual(held.moves.map((move) => move.key), ['done', 'cancel', 'release', 'block']);
  assert.equal(card(before, 'plan:90-01').held, false, 'the earlier model is a snapshot and does not change');

  const refused = planMove(world.state, world.dev.memberId, 'plan:90-01', 'release');
  assert.deepEqual(refused, { ok: false, reason: 'Only the team owner or a lead can move cards. Nothing was moved.' });
});
