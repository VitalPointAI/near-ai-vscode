// The board timeline layout (62.1-CONTEXT D-02, D-03, the UI-SPEC amendment's reading of D-03): every card of the board is one dot, placed at its
// dependency depth inside its milestone, parallel cards share a step in phase then plan order, and the edges join two cards on the board. Pure:
// the worlds here go through the real materialiser, and the layout reads only the state and the board model built from it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBoardModel } from '../domain/team/board';
import type { BoardModel } from '../domain/team/board';
import { buildTimeline } from '../domain/team/timeline';
import type { BoardTimeline, TimelineDot } from '../domain/team/timeline';
import type { TeamState } from '../domain/team/types';
import { boardWorld, importedBody } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';

const NOW = Date.parse('2026-03-05T12:00:00.000Z');

function modelFor(state: TeamState, viewerId: string | undefined): BoardModel {
  return buildBoardModel(state, { nowMs: NOW, status: { kind: 'live', text: 'Live' }, canWrite: viewerId !== undefined, ...(viewerId === undefined ? {} : { viewerId }) });
}

function timelineOf(state: TeamState, viewerId: string | undefined): BoardTimeline {
  return buildTimeline(state, modelFor(state, viewerId), viewerId === undefined ? {} : { viewerId });
}

function dotOf(timeline: BoardTimeline, id: string): TimelineDot {
  const found = timeline.dots.find((dot) => dot.cardId === id);
  assert.ok(found, `${id} is a dot`);
  return found;
}

const place = (timeline: BoardTimeline, id: string): [number, number] => {
  const dot = dotOf(timeline, id);
  return [dot.step, dot.slot];
};

// milestone:v1 (active) with phase:1 and four plans: 1-02 and 1-04 wait for 1-01, and 1-03 waits for 1-02.
function seedFourPlans(world: BoardWorld): void {
  const { lead } = world;
  world.accept(lead, 'item.imported', importedBody({ id: 'milestone:v1', kind: 'milestone', title: 'Version 1', active: true }));
  world.accept(lead, 'item.imported', importedBody({ id: 'phase:1', kind: 'phase', title: 'First work', parentId: 'milestone:v1' }));
  world.accept(lead, 'item.imported', importedBody({ id: 'plan:1-01', kind: 'plan', title: 'Start', parentId: 'phase:1', scope: ['src/a/**'], estimate: { tokens: 1000 } }));
  world.accept(lead, 'item.imported', importedBody({ id: 'plan:1-02', kind: 'plan', title: 'Middle', parentId: 'phase:1', dependsOn: ['plan:1-01'] }));
  world.accept(lead, 'item.imported', importedBody({ id: 'plan:1-03', kind: 'plan', title: 'End', parentId: 'phase:1', dependsOn: ['plan:1-02'] }));
  world.accept(lead, 'item.imported', importedBody({ id: 'plan:1-04', kind: 'plan', title: 'Side', parentId: 'phase:1', dependsOn: ['plan:1-01'] }));
}

test('tracer: a lead imports a four-plan phase and each plan sits at its dependency step, parallel plans stacked by number; marking done moves no step', async () => {
  const world = await boardWorld();
  seedFourPlans(world);
  const lead = world.lead.memberId;
  const before = timelineOf(world.state, lead);

  assert.deepEqual(before.milestones.map((milestone) => [milestone.id, milestone.steps]), [['milestone:v1', 3]], 'one milestone, three steps');
  assert.deepEqual(place(before, 'plan:1-01'), [0, 0]);
  assert.deepEqual(place(before, 'plan:1-02'), [1, 0]);
  assert.deepEqual(place(before, 'plan:1-04'), [1, 1], 'parallel with 1-02, after it by plan number');
  assert.deepEqual(place(before, 'plan:1-03'), [2, 0]);
  assert.equal(before.dots.length, 4, 'one dot per card');
  assert.ok(before.dots.every((dot) => dot.milestoneId === 'milestone:v1' && dot.phaseId === 'phase:1'));
  assert.deepEqual(before.edges, [
    { from: 'plan:1-01', to: 'plan:1-02', waiting: true, crossMilestone: false },
    { from: 'plan:1-01', to: 'plan:1-04', waiting: true, crossMilestone: false },
    { from: 'plan:1-02', to: 'plan:1-03', waiting: true, crossMilestone: false }
  ]);

  world.accept(world.lead, 'item.updated', { id: 'plan:1-01', changes: { state: 'done' } });
  const after = timelineOf(world.state, lead);
  assert.deepEqual(after.edges, [
    { from: 'plan:1-01', to: 'plan:1-02', waiting: false, crossMilestone: false },
    { from: 'plan:1-01', to: 'plan:1-04', waiting: false, crossMilestone: false },
    { from: 'plan:1-02', to: 'plan:1-03', waiting: true, crossMilestone: false }
  ], 'the finished plan no longer keeps its two dependents waiting');
  for (const id of ['plan:1-01', 'plan:1-02', 'plan:1-03', 'plan:1-04']) assert.deepEqual(place(after, id), place(before, id), `${id} keeps its place once 1-01 is done`);
  assert.equal(after.milestones[0]?.steps, 3);
});
