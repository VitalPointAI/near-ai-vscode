// The board timeline layout (62.1-CONTEXT D-02, D-03, the UI-SPEC amendment's reading of D-03): every card of the board is one dot, placed at its
// dependency depth inside its milestone, parallel cards share a step in phase then plan order, and the edges join two cards on the board. Pure:
// the worlds here go through the real materialiser, and the layout reads only the state and the board model built from it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBoardModel } from '../domain/team/board';
import { reduce } from '../domain/team/materialize';
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

// ---- every layout rule (62.1-01 Task 2) ------------------------------------------------------------------------------------------------------

type Body = ReturnType<typeof importedBody>;
const milestone = (key: string, active = false): Body => importedBody({ id: `milestone:${key}`, kind: 'milestone', title: `Version ${key}`, ...(active ? { active: true as const } : {}) });
const phase = (number: string, key: string, dependsOn: string[] = []): Body => importedBody({ id: `phase:${number}`, kind: 'phase', title: `Work ${number}`, parentId: `milestone:${key}`, dependsOn });
const plan = (id: string, dependsOn: string[] = []): Body => importedBody({ id: `plan:${id}`, kind: 'plan', title: `Plan ${id}`, parentId: `phase:${id.slice(0, id.lastIndexOf('-'))}`, dependsOn });

async function worldOf(bodies: readonly Body[]): Promise<BoardWorld> {
  const world = await boardWorld();
  for (const body of bodies) world.accept(world.owner, 'item.imported', body);
  return world;
}

// A dependency the log may refuse or the importer leaves out (a loop, a dependency across milestones, one on a board item) is written straight into
// the state, after the items themselves went through the log.
function setDependencies(state: TeamState, id: string, dependsOn: string[]): void {
  const item = state.items.get(id);
  assert.ok(item, `${id} exists`);
  item.dependsOn = dependsOn;
}

const stepsOf = (timeline: BoardTimeline, ids: readonly string[]): number[] => ids.map((id) => dotOf(timeline, id).step);

// A small seeded generator, so the large graphs are the same on every run.
function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('determinism: five import orders the log accepts and a replay of the log give the same timeline', async () => {
  const parents = [milestone('v1', true), phase('1', 'v1'), phase('2', 'v1', ['phase:1']), phase('3', 'v1')];
  const plans = [plan('1-01'), plan('1-02', ['plan:1-01']), plan('1-03', ['plan:1-01']), plan('1-10', ['plan:1-02', 'plan:1-03']), plan('2-01'), plan('2-02', ['plan:2-01'])];
  const random = seeded(7);
  const orders: Body[][] = [];
  for (let round = 0; round < 5; round += 1) {
    const shuffled = [...parents.slice(1), ...plans].map((body) => ({ body, key: random() })).sort((a, b) => a.key - b.key).map((entry) => entry.body);
    // Parents first: the milestone, then the phases, then the plans, each group in its shuffled order.
    orders.push([parents[0] as Body, ...shuffled.filter((body) => body.kind === 'phase'), ...shuffled.filter((body) => body.kind === 'plan')]);
  }
  assert.notDeepEqual(orders[0]?.map((body) => body.id), orders[1]?.map((body) => body.id), 'the orders really differ');
  const timelines: BoardTimeline[] = [];
  for (const order of orders) timelines.push(timelineOf((await worldOf(order)).state, undefined));
  for (const timeline of timelines.slice(1)) assert.deepEqual(timeline, timelines[0]);

  const world = await worldOf(orders[2] as Body[]);
  const replayed = reduce(world.entries, world.anchor);
  assert.deepEqual(timelineOf(replayed, world.owner.memberId), timelineOf(world.state, world.owner.memberId), 'a replay of the log lays out the same way');
});

test('a diamond takes steps 0, 1, 1, 2 with the two middle plans in plan number order, and neededBy counts the edges out of each dot', async () => {
  const world = await worldOf([milestone('v1', true), phase('1', 'v1'), plan('1-04', ['plan:1-02', 'plan:1-03']), plan('1-03', ['plan:1-01']), plan('1-02', ['plan:1-01']), plan('1-01')]
    .sort((a, b) => ['milestone', 'phase', 'plan'].indexOf(a.kind) - ['milestone', 'phase', 'plan'].indexOf(b.kind)));
  const timeline = timelineOf(world.state, undefined);
  assert.deepEqual(['plan:1-01', 'plan:1-02', 'plan:1-03', 'plan:1-04'].map((id) => place(timeline, id)), [[0, 0], [1, 0], [1, 1], [2, 0]]);
  assert.deepEqual(['plan:1-01', 'plan:1-02', 'plan:1-03', 'plan:1-04'].map((id) => dotOf(timeline, id).neededBy), [2, 1, 1, 0]);
  assert.deepEqual(dotOf(timeline, 'plan:1-04').waitsFor, ['plan:1-02', 'plan:1-03']);
  assert.ok(!timeline.milestones.some((entry) => entry.id === 'board'), 'no board band without board items');
});

test('a chain of 200 plans takes steps 0 to 199', async () => {
  const ids = Array.from({ length: 200 }, (_, index) => `1-${String(index + 1).padStart(3, '0')}`);
  const world = await worldOf([milestone('v1', true), phase('1', 'v1'), ...ids.map((id, index) => plan(id, index === 0 ? [] : [`plan:${ids[index - 1]}`]))]);
  const timeline = timelineOf(world.state, undefined);
  assert.deepEqual(stepsOf(timeline, ids.map((id) => `plan:${id}`)), ids.map((_, index) => index));
  assert.equal(timeline.milestones[0]?.steps, 200);
});

test('a fan-out of 30 plans after one plan shares one step, slots 0 to 29 by phase then plan number, whatever the import order', async () => {
  const first = Array.from({ length: 15 }, (_, index) => `1-${String(index + 2).padStart(2, '0')}`);
  const second = Array.from({ length: 15 }, (_, index) => `2-${String(index + 1).padStart(2, '0')}`);
  const world = await worldOf([milestone('v1', true), phase('2', 'v1'), phase('1', 'v1'), plan('1-01'), ...[...second, ...first].reverse().map((id) => plan(id, ['plan:1-01']))]);
  const timeline = timelineOf(world.state, undefined);
  const fan = [...first, ...second].map((id) => `plan:${id}`);
  assert.deepEqual(fan.map((id) => place(timeline, id)), fan.map((_, index) => [1, index]), 'phase 1 first, 1-10 after 1-09, then phase 2');
  assert.deepEqual(place(timeline, 'plan:1-01'), [0, 0]);
});

test('phase dependencies: every card of a phase comes after every card of the phases it depends on, with no edge, and waitsFor names the phase', async () => {
  const world = await worldOf([
    milestone('v1', true), phase('1', 'v1'), phase('2', 'v1', ['phase:1']), phase('3', 'v1', ['phase:2']), phase('4', 'v1', ['phase:3']), phase('5', 'v1'),
    plan('1-01'), plan('1-02', ['plan:1-01']), plan('1-03', ['plan:1-02']), plan('2-01'), plan('2-02'), plan('5-01', ['phase:1'])
  ]);
  const timeline = timelineOf(world.state, undefined);
  assert.deepEqual(stepsOf(timeline, ['plan:1-01', 'plan:1-02', 'plan:1-03']), [0, 1, 2]);
  assert.deepEqual(stepsOf(timeline, ['plan:2-01', 'plan:2-02']), [3, 3], 'phase 2 starts after the last card of phase 1');
  assert.deepEqual(stepsOf(timeline, ['phase:3', 'phase:4']), [4, 5], 'the planless phases follow their own phase dependencies');
  assert.deepEqual(dotOf(timeline, 'plan:2-01').waitsFor, ['phase:1']);
  assert.deepEqual(dotOf(timeline, 'phase:4').waitsFor, ['phase:3']);
  assert.equal(dotOf(timeline, 'plan:5-01').step, 3, 'a plan that names a phase with plans comes after all of them');
  assert.deepEqual(dotOf(timeline, 'plan:5-01').waitsFor, ['phase:1']);
  assert.deepEqual(timeline.edges.map((edge) => `${edge.from} > ${edge.to}`), ['plan:1-01 > plan:1-02', 'plan:1-02 > plan:1-03'], 'no edge for a dependency on a whole phase');
  assert.ok(timeline.dots.every((dot) => dot.missing.length === 0));
});

test('dependencies across milestones are edges marked crossMilestone and never change a step', async () => {
  const world = await worldOf([milestone('v1'), milestone('v2', true), milestone('v3'), phase('1', 'v1'), phase('2', 'v2'), phase('3', 'v3'), plan('1-01'), plan('1-02'), plan('2-01'), plan('2-02'), plan('3-01')]);
  const before = timelineOf(world.state, undefined);
  setDependencies(world.state, 'plan:2-01', ['plan:1-02']);
  setDependencies(world.state, 'plan:2-02', ['plan:3-01']);
  const after = timelineOf(world.state, undefined);
  assert.deepEqual(after.dots.map((dot) => [dot.cardId, dot.step, dot.slot]), before.dots.map((dot) => [dot.cardId, dot.step, dot.slot]), 'no step or slot moved');
  assert.deepEqual(after.edges, [
    { from: 'plan:1-02', to: 'plan:2-01', waiting: true, crossMilestone: true },
    { from: 'plan:3-01', to: 'plan:2-02', waiting: true, crossMilestone: true }
  ]);
  assert.deepEqual(dotOf(after, 'plan:2-01').waitsFor, ['plan:1-02']);
  assert.equal(dotOf(after, 'plan:1-02').neededBy, 1);
});

test('a dependency that is not on the board draws no edge and is listed as missing, and the dot is still placed', async () => {
  const world = await worldOf([milestone('v1', true), phase('1', 'v1'), plan('1-01'), plan('1-02', ['plan:9-99', 'plan:1-01'])]);
  const timeline = timelineOf(world.state, undefined);
  const dot = dotOf(timeline, 'plan:1-02');
  assert.deepEqual(dot.missing, ['plan:9-99']);
  assert.deepEqual(dot.waitsFor, ['plan:1-01']);
  assert.equal(dot.step, 1);
  assert.deepEqual(timeline.edges.map((edge) => `${edge.from} > ${edge.to}`), ['plan:1-01 > plan:1-02']);
});

test('loops of two and three cards and a card that names itself fall back to plan number order after their outside dependencies, flagged, and nothing throws', async () => {
  const world = await worldOf([
    milestone('v1', true), milestone('v2'), milestone('v3'), milestone('v4'), phase('1', 'v1'), phase('2', 'v2'), phase('3', 'v3'), phase('4', 'v4'),
    plan('1-01'), plan('1-02'), plan('1-03'), plan('1-04'), plan('1-05'), plan('1-06'),
    plan('2-01'), plan('2-02'), plan('2-03'), plan('2-04'), plan('2-05'), plan('2-06'),
    plan('3-01'), plan('3-02'), plan('4-01'), plan('4-02')
  ]);
  const { state } = world;
  // Two cards: 1-02 and 1-03 wait for each other, both after 1-01; 1-04 waits for 1-02; 1-05 and 1-06 are a separate chain.
  setDependencies(state, 'plan:1-02', ['plan:1-01', 'plan:1-03']);
  setDependencies(state, 'plan:1-03', ['plan:1-02']);
  setDependencies(state, 'plan:1-04', ['plan:1-02']);
  setDependencies(state, 'plan:1-06', ['plan:1-05']);
  // Three cards: 2-02 > 2-03 > 2-04 > 2-02, and 2-03 also waits for 2-05, which waits for 2-01, so the loop starts at step 2; 2-06 waits for 2-03.
  setDependencies(state, 'plan:2-03', ['plan:2-02', 'plan:2-05']);
  setDependencies(state, 'plan:2-04', ['plan:2-03']);
  setDependencies(state, 'plan:2-02', ['plan:2-04']);
  setDependencies(state, 'plan:2-05', ['plan:2-01']);
  setDependencies(state, 'plan:2-06', ['plan:2-03']);
  // A card that names itself, and one that waits for it.
  setDependencies(state, 'plan:3-01', ['plan:3-01']);
  setDependencies(state, 'plan:3-02', ['plan:3-01']);
  setDependencies(state, 'plan:4-02', ['plan:4-01']);
  const timeline = timelineOf(state, undefined);

  assert.deepEqual(timeline.milestones.map((entry) => [entry.id, entry.cycle]), [['milestone:v1', true], ['milestone:v2', true], ['milestone:v3', true], ['milestone:v4', false]]);
  assert.deepEqual(timeline.dots.filter((dot) => dot.inCycle).map((dot) => dot.cardId), ['plan:1-02', 'plan:1-03', 'plan:2-02', 'plan:2-03', 'plan:2-04', 'plan:3-01']);
  assert.deepEqual(stepsOf(timeline, ['plan:1-01', 'plan:1-02', 'plan:1-03', 'plan:1-04', 'plan:1-05', 'plan:1-06']), [0, 1, 2, 3, 0, 1]);
  assert.deepEqual(stepsOf(timeline, ['plan:2-01', 'plan:2-05', 'plan:2-02', 'plan:2-03', 'plan:2-04', 'plan:2-06']), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(stepsOf(timeline, ['plan:3-01', 'plan:3-02', 'plan:4-01', 'plan:4-02']), [0, 1, 0, 1]);
  assert.deepEqual(timeline.milestones.map((entry) => entry.steps), [4, 6, 2, 2]);
});

test('cards added on the board are a last band titled Added on the board, laid out by their own dependencies', async () => {
  const world = await worldOf([milestone('v1', true), phase('1', 'v1'), plan('1-01')]);
  const ids = ['item:01HZZZZZZZZZZZZZZZZZZZZZZA', 'item:01HZZZZZZZZZZZZZZZZZZZZZZB', 'item:01HZZZZZZZZZZZZZZZZZZZZZZC'];
  for (const id of [...ids].reverse()) world.accept(world.dev, 'item.created', { id, kind: 'chore', title: `Chore ${id.slice(-1)}`, scope: [], requirements: [], mustHaves: [] });
  setDependencies(world.state, ids[2] as string, [ids[0] as string]);
  const timeline = timelineOf(world.state, world.dev.memberId);
  assert.deepEqual(timeline.milestones.map((entry) => [entry.id, entry.title]), [['milestone:v1', 'Version v1'], ['board', 'Added on the board']]);
  assert.deepEqual(ids.map((id) => [dotOf(timeline, id).milestoneId, ...place(timeline, id)]), [['board', 0, 0], ['board', 0, 1], ['board', 1, 0]]);
  assert.equal(dotOf(timeline, ids[0] as string).phaseId, undefined);
  assert.deepEqual(timeline.milestones[1]?.phases, []);
  assert.deepEqual(timeline.edges.map((edge) => `${edge.from} > ${edge.to}`), [`${ids[0]} > ${ids[2]}`]);
});

test('milestones in version order with other keys after them by name; an empty milestone has no steps; finished needs a card and every card closed', async () => {
  const world = await worldOf([
    milestone('v0.10.0'), milestone('next'), milestone('v0.6.0', true), milestone('alpha'), milestone('v0.4.0'), milestone('v0.9.0'),
    phase('4', 'v0.4.0'), phase('9', 'v0.9.0'), phase('10', 'v0.10.0'), phase('20', 'alpha'),
    plan('4-01'), plan('4-02'), plan('9-01'), plan('10-01')
  ]);
  world.accept(world.lead, 'item.updated', { id: 'plan:4-01', changes: { state: 'done' } });
  world.accept(world.lead, 'item.cancelled', { id: 'plan:4-02', reason: 'Not needed' });
  world.accept(world.lead, 'item.updated', { id: 'plan:9-01', changes: { state: 'done' } });
  const timeline = timelineOf(world.state, world.lead.memberId);
  const view = timeline.milestones.map((entry) => ({ id: entry.id, active: entry.active, finished: entry.finished, folded: entry.foldedByDefault, steps: entry.steps, cards: entry.cardCount, cancelled: entry.cancelled, phases: entry.phases.length }));
  assert.deepEqual(view, [
    { id: 'milestone:v0.4.0', active: false, finished: true, folded: true, steps: 1, cards: 2, cancelled: 1, phases: 1 },
    { id: 'milestone:v0.6.0', active: true, finished: false, folded: false, steps: 0, cards: 0, cancelled: 0, phases: 0 },
    { id: 'milestone:v0.9.0', active: false, finished: true, folded: true, steps: 1, cards: 1, cancelled: 0, phases: 1 },
    { id: 'milestone:v0.10.0', active: false, finished: false, folded: false, steps: 1, cards: 1, cancelled: 0, phases: 1 },
    { id: 'milestone:alpha', active: false, finished: false, folded: false, steps: 1, cards: 1, cancelled: 0, phases: 1 },
    { id: 'milestone:next', active: false, finished: false, folded: false, steps: 0, cards: 0, cancelled: 0, phases: 0 }
  ]);
});

test('each phase with a dot has its label, number and step span, ordered by first step then phase number', async () => {
  const world = await worldOf([
    milestone('v1', true), phase('9', 'v1'), phase('10', 'v1'), phase('11', 'v1'), phase('12', 'v1', ['phase:11']),
    plan('10-01'), plan('9-01', ['plan:10-01']), plan('11-01'), plan('11-02', ['plan:9-01'])
  ]);
  const timeline = timelineOf(world.state, undefined);
  // The layout fields of each phase (62.1-02 adds the percent, labels and heading, asserted in teamTimelineNow.test.ts).
  const spans = timeline.milestones[0]?.phases.map(({ id, label, number, firstStep, lastStep }) => ({ id, label, number, firstStep, lastStep }));
  assert.deepEqual(spans, [
    { id: 'phase:10', label: 'Phase 10: Work 10', number: '10', firstStep: 0, lastStep: 0 },
    { id: 'phase:11', label: 'Phase 11: Work 11', number: '11', firstStep: 0, lastStep: 2 },
    { id: 'phase:9', label: 'Phase 9: Work 9', number: '9', firstStep: 1, lastStep: 1 },
    { id: 'phase:12', label: 'Phase 12: Work 12', number: '12', firstStep: 3, lastStep: 3 }
  ]);
  assert.equal(dotOf(timeline, 'phase:12').label, (modelFor(world.state, undefined).cards.find((card) => card.id === 'phase:12'))?.a11yLabel, 'the label is the card\'s own until 62.1-02');
});

// Large graphs are written straight into a state (the log is not what is measured): `phases` phases of `perPhase` plans, each plan waiting for up
// to two earlier plans of the milestone and some phases waiting for an earlier phase.
function largeState(base: TeamState, phases: number, perPhase: number, random: () => number): { state: TeamState; ids: string[] } {
  const items = new Map(base.items);
  const at = '2026-03-01T10:00:00.000Z';
  const make = (id: string, kind: 'milestone' | 'phase' | 'plan', parentId: string | undefined, dependsOn: string[]): void => {
    items.set(id, { id, kind, title: id, ...(parentId === undefined ? {} : { parentId }), dependsOn, scope: [], requirements: [], mustHaves: [], tags: [], state: 'backlog', origin: 'import', stateSince: at });
  };
  make('milestone:v9', 'milestone', undefined, []);
  const ids: string[] = [];
  for (let p = 1; p <= phases; p += 1) {
    const phaseDeps = p > 1 && random() < 0.3 ? [`phase:${1 + Math.floor(random() * (p - 1))}`] : [];
    make(`phase:${p}`, 'phase', 'milestone:v9', phaseDeps);
    for (let n = 1; n <= perPhase; n += 1) {
      const deps: string[] = [];
      for (let k = 0; k < 2 && ids.length > 0; k += 1) if (random() < 0.7) deps.push(ids[Math.floor(random() * ids.length)] as string);
      const id = `plan:${p}-${String(n).padStart(2, '0')}`;
      make(id, 'plan', `phase:${p}`, [...new Set(deps)]);
      ids.push(id);
    }
  }
  return { state: { ...base, items }, ids };
}

test('size: 2000 cards in 40 phases lay out in under 500 ms, and every dot is after each card it waits for in its milestone', async () => {
  const world = await boardWorld();
  const { state } = largeState(world.state, 40, 50, seeded(62));
  const model = buildBoardModel(state, { nowMs: NOW, status: { kind: 'live', text: 'Live' }, canWrite: false });
  const started = performance.now();
  const timeline = buildTimeline(state, model, {});
  const took = performance.now() - started;
  assert.ok(took < 500, `took ${Math.round(took)} ms`);
  assert.equal(timeline.dots.length, 2000);
  const step = new Map(timeline.dots.map((dot) => [dot.cardId, dot.step]));
  for (const edge of timeline.edges) assert.ok((step.get(edge.to) ?? 0) > (step.get(edge.from) ?? 0), `${edge.from} before ${edge.to}`);
  assert.equal(timeline.milestones[0]?.cycle, false);
});

test('size: a 5000-card chain with 50 loops completes without a stack overflow, each loop in number order', async () => {
  const world = await boardWorld();
  const { state, ids } = largeState(world.state, 1, 0, seeded(1));
  const items = state.items;
  const chain: string[] = [];
  for (let n = 1; n <= 5000; n += 1) {
    const id = `plan:1-${String(n).padStart(4, '0')}`;
    items.set(id, { id, kind: 'plan', title: id, parentId: 'phase:1', dependsOn: chain.length === 0 ? [] : [chain[chain.length - 1] as string], scope: [], requirements: [], mustHaves: [], tags: [], state: 'backlog', origin: 'import', stateSince: '2026-03-01T10:00:00.000Z' });
    chain.push(id);
  }
  assert.equal(ids.length, 0);
  // Every hundredth card also waits for the card ten places after it: 50 loops of eleven cards.
  for (let loop = 0; loop < 50; loop += 1) {
    const start = loop * 100 + 1;
    const item = items.get(chain[start] as string);
    item?.dependsOn.push(chain[start + 10] as string);
  }
  const timeline = buildTimeline(state, buildBoardModel(state, { nowMs: NOW, status: { kind: 'live', text: 'Live' }, canWrite: false }), {});
  assert.equal(timeline.dots.length, 5000);
  assert.equal(timeline.dots.filter((dot) => dot.inCycle).length, 50 * 11);
  assert.equal(timeline.milestones[0]?.cycle, true);
  assert.deepEqual(stepsOf(timeline, chain), chain.map((_, index) => index), 'a chain with loops still takes one step per card in number order');
});
