// Assignment in the Team Board model (G-62-5, plan 62-19; owner decision 2026-11-03: "card shows the person; member lane uses the assignee").
// 62-15 made assignment a signed event and 62-25 let any member who is not an observer assign themselves; this file checks that the board shows
// it (the card's person, the member lanes, Mine and the sidebar summary) and decides it the same way the log does (planAssign, the person list,
// the offered actions, the refusals, the history sentences and the card detail). Every event goes through the real materialiser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { boardSummary, buildBoardModel } from '../domain/team/board';
import type { BoardModel, BoardModelOptions } from '../domain/team/board';
import { CHORE_ID, boardWorld, seedStandardBoard } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';

const NOW = Date.parse('2026-03-05T12:00:00.000Z');
// In the standard board plan:90-02 waits in Backlog for plan:90-01, which is Ready; the chore is Dana's own and nobody is assigned.
const PLAN = 'plan:90-02';

function optionsFor(viewerId: string | undefined, extra: Partial<BoardModelOptions> = {}): BoardModelOptions {
  return { nowMs: NOW, status: { kind: 'live', text: 'Live' }, canWrite: viewerId !== undefined, ...(viewerId === undefined ? {} : { viewerId }), ...extra };
}

function modelFor(world: BoardWorld, viewerId: string | undefined, extra: Partial<BoardModelOptions> = {}): BoardModel {
  return buildBoardModel(world.state, optionsFor(viewerId, extra));
}

function card(model: BoardModel, id: string): BoardModel['cards'][number] {
  const found = model.cards.find((entry) => entry.id === id);
  assert.ok(found, `card ${id} is on the board`);
  return found;
}

async function standard(): Promise<BoardWorld> {
  const world = await boardWorld();
  seedStandardBoard(world);
  return world;
}

test('tracer: a lead assigns a plan to Dana, and the model puts it in her lane with her name and initials, marks it hers and counts it in her summary', async () => {
  const world = await standard();
  const { lead, dev } = world;
  const before = boardSummary(world.state, dev.memberId);
  assert.equal(card(modelFor(world, lead.memberId), PLAN).assignee, undefined, 'nobody is on the card yet');

  world.accept(lead, 'item.assigned', { id: PLAN, memberId: dev.memberId });

  const forLead = modelFor(world, lead.memberId);
  const assigned = card(forLead, PLAN);
  assert.deepEqual(assigned.assignee, { id: dev.memberId, name: 'Dana', initials: 'D' });
  assert.equal(assigned.lane.member, dev.memberId);
  assert.ok(assigned.a11yLabel.includes('Assigned to Dana.'), assigned.a11yLabel);
  assert.equal(assigned.mine, false, 'the plan is not the lead\'s');
  assert.deepEqual(forLead.lanes.member.map((lane) => [lane.key, lane.label]), [[dev.memberId, 'Dana'], ['unassigned', 'Unassigned']]);
  assert.equal(forLead.lanes.member[0]?.count, 1);

  const forDana = modelFor(world, dev.memberId);
  assert.equal(card(forDana, PLAN).mine, true);
  assert.equal(forDana.lanes.member[0]?.label, 'Dana (you)');

  const after = boardSummary(world.state, dev.memberId);
  assert.equal(after.mine, before.mine + 1, 'the sidebar summary counts the assigned plan as hers');
  world.accept(lead, 'item.unassigned', { id: PLAN });
  assert.equal(boardSummary(world.state, dev.memberId).mine, before.mine, 'and stops counting it once she is taken off');
  assert.equal(card(modelFor(world, dev.memberId), PLAN).lane.member, 'unassigned');
});

test('initials come from the first letters of up to two words of the flattened name', async () => {
  const world = await standard();
  const { lead, dev, reviewer } = world;
  const member = (id: string) => {
    const found = world.state.members.get(id);
    assert.ok(found);
    return found;
  };
  member(dev.memberId).name = 'E2E Owner';
  member(reviewer.memberId).name = '‮rae  van der\nberg';
  world.accept(lead, 'item.assigned', { id: PLAN, memberId: dev.memberId });
  world.accept(lead, 'item.assigned', { id: 'plan:90-01', memberId: reviewer.memberId });
  const model = modelFor(world, lead.memberId);
  assert.deepEqual(card(model, PLAN).assignee, { id: dev.memberId, name: 'E2E Owner', initials: 'EO' });
  assert.deepEqual(card(model, 'plan:90-01').assignee, { id: reviewer.memberId, name: 'rae van der berg', initials: 'RV' });
});

test('member lanes: one per person with a shown card, sorted by name, the viewer marked, Unassigned always last', async () => {
  const world = await standard();
  const { owner, lead, dev, reviewer } = world;
  const empty = modelFor(world, lead.memberId);
  assert.deepEqual(empty.lanes.member.map((lane) => lane.key), ['unassigned'], 'nobody is assigned, so there is only the Unassigned lane');

  world.accept(lead, 'item.assigned', { id: PLAN, memberId: reviewer.memberId });
  world.accept(lead, 'item.assigned', { id: 'plan:90-01', memberId: dev.memberId });
  const model = modelFor(world, reviewer.memberId);
  assert.deepEqual(model.lanes.member.map((lane) => [lane.key, lane.label, lane.count]), [
    [dev.memberId, 'Dana', 1], [reviewer.memberId, 'Rae (you)', 1], ['unassigned', 'Unassigned', model.cards.filter((entry) => entry.assignee === undefined).length]
  ]);
  for (const entry of model.cards) assert.equal(entry.lane.member, entry.assignee?.id ?? 'unassigned', entry.id);

  // Lee has no card, so Lee has no lane; once the owner takes the last open card, the Unassigned lane stays even with nothing in it.
  assert.equal(model.lanes.member.some((lane) => lane.key === lead.memberId), false);
  world.accept(owner, 'item.assigned', { id: CHORE_ID, memberId: owner.memberId });
  const all = modelFor(world, owner.memberId);
  const unassigned = all.lanes.member.at(-1);
  assert.equal(unassigned?.key, 'unassigned');
  assert.equal(unassigned?.count, all.cards.filter((entry) => entry.assignee === undefined).length);
});

test('Mine: cards assigned to me, or cards I added that nobody is assigned to', async () => {
  const world = await standard();
  const { lead, dev } = world;
  const mine = (viewerId: string): string[] => modelFor(world, viewerId).cards.filter((entry) => entry.mine).map((entry) => entry.id);
  assert.deepEqual(mine(dev.memberId), [CHORE_ID], 'Dana added the chore and nobody is assigned');
  assert.deepEqual(mine(lead.memberId), []);

  world.accept(lead, 'item.assigned', { id: CHORE_ID, memberId: lead.memberId });
  assert.deepEqual(mine(dev.memberId), [], 'once Lee is assigned the chore it is no longer Dana\'s');
  assert.deepEqual(mine(lead.memberId), [CHORE_ID]);
  assert.equal(boardSummary(world.state, lead.memberId).mine, 1);
  assert.equal(boardSummary(world.state, dev.memberId).mine, 0);
  assert.deepEqual(modelFor(world, undefined).cards.filter((entry) => entry.mine), [], 'a window without a device key has nothing of its own');
});
