// What people read on the board timeline (62.1-CONTEXT D-13, D-14, D-05, D-10, the UI-SPEC amendment): the percent complete overall, per milestone
// and per phase with its exact count, the Now step with its counts and sentence, and each dot's accessible name and facts. Pure: the worlds go
// through the real materialiser, and a column the log cannot reach yet (claims arrive in Phase 63) is set on the stored item by hand.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBoardModel } from '../domain/team/board';
import type { BoardModel } from '../domain/team/board';
import { buildTimeline } from '../domain/team/timeline';
import type { BoardTimeline, TimelineMilestone, TimelinePhase } from '../domain/team/timeline';
import type { ItemState, TeamState } from '../domain/team/types';
import { boardWorld, importedBody } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';

const NOW = Date.parse('2026-03-05T12:00:00.000Z');

function modelFor(state: TeamState, viewerId: string | undefined): BoardModel {
  return buildBoardModel(state, { nowMs: NOW, status: { kind: 'live', text: 'Live' }, canWrite: viewerId !== undefined, ...(viewerId === undefined ? {} : { viewerId }) });
}

function timelineOf(state: TeamState, viewerId: string | undefined): BoardTimeline {
  return buildTimeline(state, modelFor(state, viewerId), viewerId === undefined ? {} : { viewerId });
}

function bandOf(timeline: BoardTimeline, id: string): TimelineMilestone {
  const found = timeline.milestones.find((entry) => entry.id === id);
  assert.ok(found, `${id} is a band`);
  return found;
}

function phaseOf(band: TimelineMilestone, id: string): TimelinePhase {
  const found = band.phases.find((entry) => entry.id === id);
  assert.ok(found, `${id} is a phase of ${band.id}`);
  return found;
}

type Body = ReturnType<typeof importedBody>;
const milestone = (key: string, title: string, active = false): Body => importedBody({ id: `milestone:${key}`, kind: 'milestone', title, ...(active ? { active: true as const } : {}) });
const phase = (number: string, key: string, title: string, extra: Partial<Body> = {}): Body =>
  importedBody({ id: `phase:${number}`, kind: 'phase', title, parentId: `milestone:${key}`, ...extra });
const plan = (id: string, extra: Partial<Body> = {}): Body =>
  importedBody({ id: `plan:${id}`, kind: 'plan', title: `Plan ${id}`, parentId: `phase:${id.slice(0, id.lastIndexOf('-'))}`, ...extra });
const done: Partial<Body> = { state: 'done' };

async function worldOf(bodies: readonly Body[]): Promise<BoardWorld> {
  const world = await boardWorld();
  for (const body of bodies) world.accept(world.owner, 'item.imported', body);
  return world;
}

function cancel(world: BoardWorld, id: string): void {
  world.accept(world.owner, 'item.cancelled', { id, reason: 'Not needed any more' });
}

// A column the log cannot reach yet (Claimed, In progress, In review, Shipping) is written on the stored item, the way the board model reads it.
function setState(state: TeamState, id: string, value: ItemState): void {
  const item = state.items.get(id);
  assert.ok(item, `${id} exists`);
  item.state = value;
}

const pad = (n: number): string => String(n).padStart(2, '0');

// ---- percent complete (D-14) -----------------------------------------------------------------------------------------------------------------

test('tracer: percent complete overall, per milestone and per phase leaves cancelled cards out, counts the planless phase as unfinished and says the exact count', async () => {
  const world = await worldOf([
    milestone('v1', 'Version 1', true), phase('1', 'v1', 'First work'), phase('2', 'v1', 'Second work'),
    plan('1-01', done), plan('1-02', done), plan('1-03'), plan('1-04')
  ]);
  cancel(world, 'plan:1-04');
  const timeline = timelineOf(world.state, world.lead.memberId);

  assert.deepEqual(timeline.percent, { finished: 2, counted: 4, percent: 50, text: '50% done', label: '2 of 4 cards finished, 50%' }, 'the cancelled plan is left out, the planless phase 2 counts');
  const band = bandOf(timeline, 'milestone:v1');
  assert.deepEqual(band.percent, { finished: 2, counted: 4, percent: 50, text: '50% done', label: '2 of 4 cards finished, 50%' });
  assert.equal(band.percentText, '50%');
  assert.equal(band.progressText, '2 of 4 cards finished');
  assert.equal(band.heading, 'Version 1, current milestone, 50% done');

  const first = phaseOf(band, 'phase:1');
  assert.deepEqual(first.percent, { finished: 2, counted: 3, percent: 66, text: '66% done', label: '2 of 3 cards finished, 66%' }, '2 of 3 is 66, rounded down');
  assert.deepEqual(first.labels, ['Phase 1: First work · 66%', 'Phase 1 · 66%', '1 · 66%']);
  assert.equal(first.heading, 'Phase 1: First work, 66% done, 2 of 3 cards finished');

  const second = phaseOf(band, 'phase:2');
  assert.deepEqual(second.percent, { finished: 0, counted: 1, percent: 0, text: '0% done', label: '0 of 1 card finished, 0%' }, 'a planless phase is one unfinished card');
  assert.deepEqual(second.labels, ['Phase 2: Second work · 0%', 'Phase 2 · 0%', '2 · 0%']);
});

test('the percent is rounded down: 199 of 200 is 99, never 100; 200 of 200 is 100', async () => {
  const bodies: Body[] = [milestone('v1', 'Version 1', true), phase('1', 'v1', 'Big work')];
  for (let i = 1; i <= 200; i += 1) bodies.push(plan(`1-${String(i).padStart(3, '0')}`, i < 200 ? done : {}));
  const world = await worldOf(bodies);
  const before = timelineOf(world.state, world.lead.memberId);
  assert.equal(before.percent?.percent, 99);
  assert.equal(before.percent?.text, '99% done');
  assert.equal(before.percent?.label, '199 of 200 cards finished, 99%');
  assert.equal(bandOf(before, 'milestone:v1').percentText, '99%');

  world.accept(world.owner, 'item.updated', { id: 'plan:1-200', changes: { state: 'done' } });
  const after = timelineOf(world.state, world.lead.memberId);
  assert.equal(after.percent?.percent, 100);
  assert.equal(after.percent?.text, '100% done');
  assert.equal(after.percent?.label, '200 of 200 cards finished, 100%');
});

test('no cards gives No cards yet and only cancelled cards give Every card here was cancelled, both with no percent', async () => {
  const empty = await boardWorld();
  const none = timelineOf(empty.state, empty.lead.memberId);
  assert.equal(none.percent?.percent, undefined);
  assert.equal(none.percent?.text, 'No cards yet');
  assert.equal(none.percent?.label, 'No cards yet');
  assert.equal(none.percent?.counted, 0);

  const world = await worldOf([milestone('v1', 'Version 1', true), milestone('v2', 'Version 2'), phase('1', 'v1', 'First work'), plan('1-01'), plan('1-02')]);
  cancel(world, 'plan:1-01');
  cancel(world, 'plan:1-02');
  const timeline = timelineOf(world.state, world.lead.memberId);
  const band = bandOf(timeline, 'milestone:v1');
  assert.equal(band.percent?.percent, undefined, 'nothing is counted when every card is cancelled');
  assert.equal(band.percent?.text, 'Every card here was cancelled');
  assert.equal(band.percentText, '');
  assert.equal(band.progressText, 'Every card here was cancelled');
  assert.equal(band.heading, 'Version 1, current milestone, every card here was cancelled');
  assert.equal(timeline.percent?.text, 'Every card here was cancelled');
  const empty2 = bandOf(timeline, 'milestone:v2');
  assert.equal(empty2.percent?.text, 'No cards yet');
  assert.equal(empty2.heading, 'Version 2, no cards yet');
});

test('planless phase cards count as unfinished, and a phase stored done counts as finished', async () => {
  const world = await worldOf([
    milestone('v1', 'Version 1', true), phase('1', 'v1', 'Planned'), phase('2', 'v1', 'Later'), phase('3', 'v1', 'Later still'), phase('4', 'v1', 'Last'), plan('1-01', done)
  ]);
  const timeline = timelineOf(world.state, world.lead.memberId);
  assert.equal(timeline.percent?.label, '1 of 4 cards finished, 25%', 'three planless phases and one done plan');
  assert.equal(bandOf(timeline, 'milestone:v1').percent?.percent, 25);

  const recorded = await worldOf([milestone('v1', 'Version 1', true), phase('1', 'v1', 'Planned'), phase('2', 'v1', 'Shipped earlier', done), plan('1-01')]);
  const second = timelineOf(recorded.state, recorded.lead.memberId);
  assert.equal(second.percent?.label, '1 of 2 cards finished, 50%', 'the phase the roadmap records as done is finished');
  assert.equal(phaseOf(bandOf(second, 'milestone:v1'), 'phase:2').percent?.percent, 100);
});

test('cards added on the board count in the overall percent and in the board band', async () => {
  const world = await worldOf([milestone('v1', 'Version 1', true), phase('1', 'v1', 'First work'), plan('1-01', done)]);
  world.accept(world.dev, 'item.created', { id: `item:${'0'.repeat(22)}AAAA`, kind: 'chore', title: 'Tidy', scope: [], requirements: [], mustHaves: [] });
  const timeline = timelineOf(world.state, world.lead.memberId);
  assert.equal(timeline.percent?.label, '1 of 2 cards finished, 50%');
  const board = bandOf(timeline, 'board');
  assert.deepEqual(board.percent, { finished: 0, counted: 1, percent: 0, text: '0% done', label: '0 of 1 card finished, 0%' });
  assert.equal(board.heading, 'Added on the board, 0% done');
  assert.equal(board.progressText, '0 of 1 card finished');
});

test('a finished milestone\'s folded tile says how many are done and cancelled, and its name counts every card', async () => {
  const bodies: Body[] = [milestone('v0.4', 'Version 0.4 line'), phase('4', 'v0.4', 'Old work'), milestone('v1', 'Version 1', true), phase('10', 'v1', 'New work'), plan('10-01')];
  for (let i = 1; i <= 32; i += 1) bodies.push(plan(`4-${pad(i)}`, i <= 30 ? done : {}));
  const world = await worldOf(bodies);
  const plain = await worldOf(bodies.filter((body) => !/^plan:4-3[12]$/.test(body.id)));
  cancel(world, 'plan:4-31');
  cancel(world, 'plan:4-32');

  const folded = bandOf(timelineOf(world.state, world.lead.memberId), 'milestone:v0.4');
  assert.equal(folded.finished, true);
  assert.equal(folded.tileText, 'Finished: 30 done, 2 cancelled');
  assert.equal(folded.tileName, 'Show Version 0.4 line, finished, 32 cards');
  assert.equal(folded.percentText, '100%');
  assert.equal(folded.heading, 'Version 0.4 line, 100% done');

  const clean = bandOf(timelineOf(plain.state, plain.lead.memberId), 'milestone:v0.4');
  assert.equal(clean.tileText, 'Finished: 30 done');
  assert.equal(clean.tileName, 'Show Version 0.4 line, finished, 30 cards');
});

// ---- the Now step (D-13) ---------------------------------------------------------------------------------------------------------------------

const ready: Partial<Body> = { scope: ['src/a/**'], estimate: { tokens: 1000 } };

test('mid-way: Now is the earliest step with an unfinished card, names its phase, counts the band and says it in one sentence', async () => {
  // Steps 0 and 1 done; step 2 holds a Ready plan and a held one; steps 3 and 4 wait. Five steps, six cards, two finished.
  const world = await worldOf([
    milestone('v1', 'Version 1', true), phase('1', 'v1', 'First work'),
    plan('1-01', done), plan('1-02', { ...done, dependsOn: ['plan:1-01'] }), plan('1-03', { ...ready, dependsOn: ['plan:1-02'] }),
    plan('1-04', { ...ready, dependsOn: ['plan:1-02'] }), plan('1-05', { dependsOn: ['plan:1-03'] }), plan('1-06', { dependsOn: ['plan:1-05'] })
  ]);
  world.accept(world.owner, 'item.updated', { id: 'plan:1-04', changes: { hold: true } });
  const timeline = timelineOf(world.state, world.lead.memberId);
  assert.equal(bandOf(timeline, 'milestone:v1').steps, 5);
  assert.deepEqual(timeline.now, {
    milestoneId: 'milestone:v1', step: 2, stepCount: 5, phaseId: 'phase:1', allDone: false, inProgress: 0, ready: 1, percent: 33,
    title: 'Now: Phase 1, step 3 of 5', detail: '0 in progress, 1 ready · 33% of this milestone done',
    sentence: 'Now: Phase 1, step 3 of 5. 0 in progress, 1 ready. 33% of this milestone done.'
  });
});

test('in progress counts Claimed, In progress, In review and Shipping across the band; nothing finished puts Now at step 1', async () => {
  const world = await worldOf([
    milestone('v1', 'Version 1', true), phase('1', 'v1', 'First work'),
    plan('1-01', ready), plan('1-02', ready), plan('1-03', ready), plan('1-04', ready), plan('1-05', ready), plan('1-06', { dependsOn: ['plan:1-01'] })
  ]);
  const start = timelineOf(world.state, world.lead.memberId);
  assert.equal(start.now?.step, 0);
  assert.equal(start.now?.title, 'Now: Phase 1, step 1 of 2');
  assert.equal(start.now?.inProgress, 0);
  assert.equal(start.now?.ready, 5);
  assert.equal(start.now?.detail, '0 in progress, 5 ready · 0% of this milestone done');

  setState(world.state, 'plan:1-01', 'claimed');
  setState(world.state, 'plan:1-02', 'in-progress');
  setState(world.state, 'plan:1-03', 'in-review');
  setState(world.state, 'plan:1-04', 'integrating');
  const started = timelineOf(world.state, world.lead.memberId);
  assert.equal(started.now?.inProgress, 4);
  assert.equal(started.now?.ready, 1);
  assert.equal(started.now?.step, 0, 'started is not finished');
  assert.equal(started.now?.sentence, 'Now: Phase 1, step 1 of 2. 4 in progress, 1 ready. 0% of this milestone done.');
});

test('work running ahead of an unfinished earlier step does not move Now, and its counts include the cards ahead', async () => {
  const world = await worldOf([
    milestone('v1', 'Version 1', true), phase('1', 'v1', 'First work'),
    plan('1-01', done), plan('1-02', { dependsOn: ['plan:1-01'] }), plan('1-03', { ...done, dependsOn: ['plan:1-02'] }), plan('1-04', { dependsOn: ['plan:1-03'] })
  ]);
  setState(world.state, 'plan:1-04', 'in-progress');
  const timeline = timelineOf(world.state, world.lead.memberId);
  assert.equal(timeline.now?.step, 1, 'Now stays at the unfinished step 2 of 4');
  assert.equal(timeline.now?.stepCount, 4);
  assert.equal(timeline.now?.inProgress, 1, 'the card ahead is counted');
  assert.equal(timeline.now?.percent, 50);
  assert.equal(timeline.now?.title, 'Now: Phase 1, step 2 of 4');
});

test('several phases at the Now step: the phase named is that of the first unfinished dot in slot order', async () => {
  const world = await worldOf([
    milestone('v1', 'Version 1', true), phase('1', 'v1', 'One'), phase('2', 'v1', 'Two'), phase('3', 'v1', 'Three'),
    plan('1-01', done), plan('2-01'), plan('3-01')
  ]);
  const timeline = timelineOf(world.state, world.lead.memberId);
  assert.equal(timeline.now?.step, 0);
  assert.equal(timeline.now?.phaseId, 'phase:2');
  assert.equal(timeline.now?.title, 'Now: Phase 2, step 1 of 1');
});

test('Now is in the first band with unfinished work, in milestone order and then the cards added on the board', async () => {
  const world = await worldOf([
    milestone('v1', 'Version 1'), phase('1', 'v1', 'Old'), plan('1-01', done), plan('1-02'),
    milestone('v2', 'Version 2', true), phase('2', 'v2', 'New'), plan('2-01', done), plan('2-02', { dependsOn: ['plan:2-01'] })
  ]);
  cancel(world, 'plan:1-02');
  const second = timelineOf(world.state, world.lead.memberId);
  assert.equal(second.now?.milestoneId, 'milestone:v2', 'v1 is finished (done and cancelled), so Now is in v2');
  assert.equal(second.now?.step, 1);
  assert.equal(second.now?.title, 'Now: Phase 2, step 2 of 2');

  world.accept(world.owner, 'item.updated', { id: 'plan:2-02', changes: { state: 'done' } });
  world.accept(world.dev, 'item.created', { id: `item:${'0'.repeat(22)}AAAA`, kind: 'chore', title: 'Tidy', scope: [], requirements: [], mustHaves: [] });
  const board = timelineOf(world.state, world.lead.memberId);
  assert.equal(board.now?.milestoneId, 'board');
  assert.equal(board.now?.phaseId, undefined);
  assert.equal(board.now?.title, 'Now: Added on the board, step 1 of 1');
  assert.equal(board.now?.detail, '0 in progress, 0 ready · 0% of the cards added on the board done');
});

test('all done: Now stands after the last step of the last band with cards and says so with the exact count', async () => {
  const world = await worldOf([
    milestone('v1', 'Version 1'), phase('1', 'v1', 'Old'), plan('1-01', done),
    milestone('v2', 'Version 2', true), phase('2', 'v2', 'New'), plan('2-01', done), plan('2-02', { ...done, dependsOn: ['plan:2-01'] }),
    milestone('v3', 'Version 3')
  ]);
  const timeline = timelineOf(world.state, world.lead.memberId);
  assert.deepEqual(timeline.now, {
    milestoneId: 'milestone:v2', step: 2, stepCount: 2, phaseId: 'phase:2', allDone: true, inProgress: 0, ready: 0, percent: 100,
    title: 'Now: all the planned work is done', detail: '3 of 3 cards finished, 100%', sentence: 'Now: all the planned work is done. 3 of 3 cards finished, 100%.'
  });
});

test('no cards at all: there is no Now, also when milestones exist', async () => {
  const empty = await boardWorld();
  assert.equal(timelineOf(empty.state, empty.lead.memberId).now, undefined);
  const world = await worldOf([milestone('v1', 'Version 1', true), milestone('v2', 'Version 2')]);
  assert.equal(timelineOf(world.state, world.lead.memberId).now, undefined);
});

test('determinism: the same items imported in different orders give the same Now', async () => {
  const parents = [milestone('v1', 'Version 1', true), phase('1', 'v1', 'One'), phase('2', 'v1', 'Two')];
  const plans = [plan('1-01', done), plan('1-02', { dependsOn: ['plan:1-01'] }), plan('2-01', ready), plan('2-02', { ...ready, dependsOn: ['plan:2-01'] }), plan('1-03', ready)];
  const orders = [plans, [...plans].reverse(), [plans[2], plans[0], plans[4], plans[1], plans[3]] as Body[]];
  const nows = [];
  for (const order of orders) {
    const world = await worldOf([...parents, ...order]);
    nows.push(timelineOf(world.state, world.lead.memberId).now);
  }
  assert.ok(nows[0] !== undefined);
  assert.deepEqual(nows[1], nows[0]);
  assert.deepEqual(nows[2], nows[0]);
});
