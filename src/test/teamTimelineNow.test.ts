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

// ---- dot names, facts and notes (D-05, D-10) -------------------------------------------------------------------------------------------------

function setDependencies(state: TeamState, id: string, dependsOn: string[]): void {
  const item = state.items.get(id);
  assert.ok(item, `${id} exists`);
  item.dependsOn = dependsOn;
}

function cardLabelOf(model: BoardModel, id: string): string {
  const card = model.cards.find((entry) => entry.id === id);
  assert.ok(card, `${id} is a card`);
  return card.a11yLabel;
}

function viewOf(world: BoardWorld, viewerId: string): { model: BoardModel; timeline: BoardTimeline } {
  const model = modelFor(world.state, viewerId);
  return { model, timeline: buildTimeline(world.state, model, { viewerId }) };
}

const dot = (timeline: BoardTimeline, id: string): BoardTimeline['dots'][number] => {
  const found = timeline.dots.find((entry) => entry.cardId === id);
  assert.ok(found, `${id} is a dot`);
  return found;
};

const count = (text: string, part: string): number => text.split(part).length - 1;

// milestone:v0.6.0 "Team Mode" with phase 62: 62-01 and 62-02 done, 62-03 (Ready, assigned to Dana) waits for both, four plans wait for 62-03,
// and a chain of three more gives seven steps.
async function teamModeWorld(): Promise<BoardWorld> {
  const titled = (id: string, title: string, extra: Partial<Body> = {}): Body => plan(id, { title, ...extra });
  const world = await worldOf([
    milestone('v0.6.0', 'Team Mode', true), phase('62', 'v0.6.0', 'Work model'),
    titled('62-01', 'Work model', done), titled('62-02', 'Import', { ...done, dependsOn: ['plan:62-01'] }),
    titled('62-03', 'Board webview client', { ...ready, dependsOn: ['plan:62-01', 'plan:62-02'] }),
    titled('62-04', 'Columns', { dependsOn: ['plan:62-03'] }), titled('62-05', 'Menu', { dependsOn: ['plan:62-03'] }),
    titled('62-06', 'Drag', { dependsOn: ['plan:62-03'] }), titled('62-07', 'Detail', { dependsOn: ['plan:62-03'] }),
    titled('62-08', 'Form', { dependsOn: ['plan:62-04'] }), titled('62-09', 'Live', { dependsOn: ['plan:62-08'] }), titled('62-10', 'Polish', { dependsOn: ['plan:62-09'] })
  ]);
  world.accept(world.lead, 'item.assigned', { id: 'plan:62-03', memberId: world.dev.memberId });
  return world;
}

test('a dot\'s name is the card\'s own name, who it is assigned to exactly once, its step, what it waits for and how many cards need it', async () => {
  const world = await teamModeWorld();
  const lee = viewOf(world, world.lead.memberId);
  const own = cardLabelOf(lee.model, 'plan:62-03');
  assert.ok(own.includes('Assigned to Dana.'));
  const label = dot(lee.timeline, 'plan:62-03').label;
  assert.equal(label, `${own} Step 3 of 7 in Team Mode. Waits for 62-01 and 62-02. Needed by 4 cards.`);
  assert.equal(count(label, 'Assigned to'), 1, 'the assignee is said once');

  const dana = viewOf(world, world.dev.memberId);
  const danaLabel = dot(dana.timeline, 'plan:62-03').label;
  assert.equal(danaLabel, `${cardLabelOf(dana.model, 'plan:62-03').replace('Assigned to Dana.', 'Assigned to you.')} Step 3 of 7 in Team Mode. Waits for 62-01 and 62-02. Needed by 4 cards.`);
  assert.equal(count(danaLabel, 'Assigned to'), 1);
  assert.ok(!danaLabel.includes('Dana'), 'the viewer is "you", never their own name as well');

  assert.equal(dot(lee.timeline, 'plan:62-04').label, `${cardLabelOf(lee.model, 'plan:62-04')} Nobody is assigned. Step 4 of 7 in Team Mode. Waits for 62-03. Needed by 1 card.`);
  assert.equal(dot(lee.timeline, 'plan:62-10').label, `${cardLabelOf(lee.model, 'plan:62-10')} Nobody is assigned. Step 7 of 7 in Team Mode. Waits for 62-09.`, 'Needed by is left out at 0');
  assert.equal(dot(lee.timeline, 'plan:62-01').label, `${cardLabelOf(lee.model, 'plan:62-01')} Nobody is assigned. Step 1 of 7 in Team Mode. Waits for nothing. Needed by 2 cards.`);
});

test('a board item the viewer added and nobody is assigned to says You added this; for anyone else it says Nobody is assigned', async () => {
  const world = await boardWorld();
  const id = `item:${'0'.repeat(22)}AAAA`;
  world.accept(world.dev, 'item.created', { id, kind: 'chore', title: 'Tidy settings', scope: [], requirements: [], mustHaves: [] });
  const dana = viewOf(world, world.dev.memberId);
  assert.equal(dot(dana.timeline, id).label, `${cardLabelOf(dana.model, id)} You added this. Step 1 of 1 in Added on the board. Waits for nothing.`);
  assert.equal(dot(dana.timeline, id).whoText, 'Nobody yet');
  const lee = viewOf(world, world.lead.memberId);
  assert.equal(dot(lee.timeline, id).label, `${cardLabelOf(lee.model, id)} Nobody is assigned. Step 1 of 1 in Added on the board. Waits for nothing.`);
});

test('Waits for names up to three then says how many more, writes a phase as Phase n, and Needed by is singular at one', async () => {
  const world = await worldOf([
    milestone('v1', 'Version 1', true), phase('60', 'v1', 'Core'), phase('61', 'v1', 'Next', { dependsOn: ['phase:60'] }),
    plan('60-01'), plan('60-02'), plan('60-03'), plan('60-04'), plan('60-05'),
    plan('61-01', { dependsOn: ['plan:60-01', 'plan:60-02', 'plan:60-03', 'plan:60-04', 'plan:60-05'] }), plan('61-02', { dependsOn: ['plan:61-01'] })
  ]);
  const { timeline } = viewOf(world, world.lead.memberId);
  const many = dot(timeline, 'plan:61-01');
  assert.ok(many.label.includes(' Waits for 60-01, 60-02, 60-03 and 2 more. Needed by 1 card.'), many.label);
  assert.equal(many.waitsText, 'Waits for 6 cards', 'five plans and the phase its own phase waits for');
  assert.ok(dot(timeline, 'plan:61-02').label.includes(' Waits for 61-01 and Phase 60.'), dot(timeline, 'plan:61-02').label);
  assert.equal(dot(timeline, 'plan:61-02').waitsText, 'Waits for 2 cards');
  const three = await worldOf([milestone('v1', 'Version 1', true), phase('1', 'v1', 'One'), plan('1-01'), plan('1-02'), plan('1-03'), plan('1-04', { dependsOn: ['plan:1-01', 'plan:1-02', 'plan:1-03'] })]);
  assert.ok(dot(viewOf(three, three.lead.memberId).timeline, 'plan:1-04').label.endsWith(' Waits for 1-01, 1-02 and 1-03.'));
  assert.equal(dot(viewOf(three, three.lead.memberId).timeline, 'plan:1-01').waitsText, 'Waits for nothing');
});

test('a dot\'s facts: step, who, waits for and needed by with links, and notes for a missing dependency and a loop', async () => {
  const world = await teamModeWorld();
  const lee = viewOf(world, world.lead.memberId).timeline;
  const target = dot(lee, 'plan:62-03');
  assert.equal(target.stepText, 'Step 3 of 7');
  assert.equal(target.stepFact, '3 of 7 in Team Mode');
  assert.equal(target.whoText, 'Assigned to Dana');
  assert.equal(target.waitsText, 'Waits for 2 cards');
  assert.deepEqual(target.waitsForLinks, [
    { id: 'plan:62-01', label: '62-01 Work model', onBoard: true }, { id: 'plan:62-02', label: '62-02 Import', onBoard: true }
  ]);
  assert.deepEqual(target.neededByLinks.map((link) => link.label), ['62-04 Columns', '62-05 Menu', '62-06 Drag', '62-07 Detail']);
  assert.deepEqual(target.notes, []);
  assert.equal(dot(viewOf(world, world.dev.memberId).timeline, 'plan:62-03').whoText, 'Assigned to you');
  assert.equal(dot(lee, 'plan:62-04').whoText, 'Nobody yet');
  assert.equal(dot(lee, 'plan:62-04').waitsText, 'Waits for 1 card');
  assert.deepEqual(dot(lee, 'plan:62-10').neededByLinks, []);

  setDependencies(world.state, 'plan:62-10', ['plan:62-09', 'plan:61-09']);
  const missing = dot(viewOf(world, world.lead.memberId).timeline, 'plan:62-10');
  assert.deepEqual(missing.notes, ['Waits for 61-09, which is not on the board.']);
  assert.deepEqual(missing.waitsForLinks, [{ id: 'plan:62-09', label: '62-09 Live', onBoard: true }, { id: 'plan:61-09', label: '61-09', onBoard: false }]);
  assert.ok(missing.label.includes(' Waits for 62-09 and 61-09.'), missing.label);

  const phased = await worldOf([milestone('v1', 'Version 1', true), phase('60', 'v1', 'Core'), phase('61', 'v1', 'Next', { dependsOn: ['phase:60'] }), plan('60-01'), plan('61-01')]);
  assert.deepEqual(dot(viewOf(phased, phased.lead.memberId).timeline, 'plan:61-01').waitsForLinks, [{ id: 'phase:60', label: 'Phase 60: Core', onBoard: true }]);

  const loop = await worldOf([milestone('v1', 'Version 1', true), phase('1', 'v1', 'One'), plan('1-01'), plan('1-02'), plan('1-03')]);
  setDependencies(loop.state, 'plan:1-01', ['plan:1-02']);
  setDependencies(loop.state, 'plan:1-02', ['plan:1-01']);
  const looped = viewOf(loop, loop.lead.memberId).timeline;
  const cycle = 'Some cards here wait for each other in a loop, so their order cannot be worked out. They are shown in plan number order.';
  assert.deepEqual(dot(looped, 'plan:1-01').notes, [cycle]);
  assert.deepEqual(dot(looped, 'plan:1-03').notes, []);
  assert.equal(bandOf(looped, 'milestone:v1').cycleNote, cycle);
  assert.equal(bandOf(timelineOf(world.state, world.lead.memberId), 'milestone:v0.6.0').cycleNote, undefined);
});

test('an empty milestone says No plans yet and the next step for the viewer\'s role', async () => {
  const world = await worldOf([milestone('v1', 'Version 1', true), phase('1', 'v1', 'One'), plan('1-01'), milestone('v2', 'Version 2')]);
  const lead = bandOf(timelineOf(world.state, world.lead.memberId), 'milestone:v2');
  assert.equal(lead.emptyText, 'No plans yet');
  assert.equal(lead.emptyNext, 'Plan this milestone\'s phases, then choose Import plans to see them here.');
  assert.equal(bandOf(timelineOf(world.state, world.owner.memberId), 'milestone:v2').emptyNext, lead.emptyNext);
  const dev = bandOf(timelineOf(world.state, world.dev.memberId), 'milestone:v2');
  assert.equal(dev.emptyText, 'No plans yet');
  assert.equal(dev.emptyNext, 'Cards show up here when a lead imports the plans for this milestone.');
  const full = bandOf(timelineOf(world.state, world.lead.memberId), 'milestone:v1');
  assert.equal(full.emptyText, undefined);
  assert.equal(full.emptyNext, undefined);
});

// Every string anywhere in the timeline, with the path it was found at.
function stringsOf(value: unknown, at = 'timeline', found: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof value === 'string') found.push([at, value]);
  else if (Array.isArray(value)) value.forEach((entry, index) => stringsOf(entry, `${at}[${index}]`, found));
  else if (value !== null && typeof value === 'object') for (const [key, entry] of Object.entries(value)) stringsOf(entry, `${at}.${key}`, found);
  return found;
}

test('hostile titles and names are flattened in every sentence they reach, and no authored text adds a dash', async () => {
  const hostile = 'Fix <b onclick="x()">it</b>\u202E\u2066 now \u2014 later\nsecond line';
  const flat = 'Fix <b onclick="x()">it</b> now \u2014 later second line';
  const world = await worldOf([
    milestone('v1', 'Team Mode', true), phase('1', 'v1', 'One'), phase('2', 'v1', 'Two', { dependsOn: ['phase:1'] }), plan('1-01', ready), plan('1-02', { dependsOn: ['plan:1-01'] })
  ]);
  // The log refuses most of this text; it is written into the state by hand so the timeline is tested on its own (defence in depth, T-62.1-04).
  const retitle = (id: string, title: string): void => {
    const item = world.state.items.get(id);
    assert.ok(item, `${id} exists`);
    item.title = title;
  };
  retitle('milestone:v1', `Team <i>Mode</i>\u200B \u2013 ${hostile}`);
  for (const id of ['phase:1', 'phase:2', 'plan:1-01', 'plan:1-02']) retitle(id, hostile);
  setDependencies(world.state, 'plan:1-02', ['plan:1-01', 'plan:1-99']);
  const member = world.state.members.get(world.dev.memberId);
  assert.ok(member);
  member.name = `Dana\u202E <script>x</script> \u2014 the\tgreat`;
  world.accept(world.lead, 'item.assigned', { id: 'plan:1-01', memberId: world.dev.memberId });
  const timeline = timelineOf(world.state, world.lead.memberId);
  const strings = stringsOf(timeline);
  assert.ok(strings.length > 40);
  const controls = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
  for (const [at, text] of strings) assert.ok(!controls.test(text), `${at} holds a control or format character: ${JSON.stringify(text)}`);
  // Remove what teammates wrote; whatever is left was authored and must not hold a dash.
  const teammate = [flat, 'Team <i>Mode</i> \u2013 ', 'Dana <script>x</script> \u2014 the great'];
  for (const [at, text] of strings) {
    const authored = teammate.reduce((rest, part) => rest.split(part).join(''), text);
    assert.ok(!/[\u2013\u2014]/.test(authored), `${at} adds a dash: ${JSON.stringify(text)}`);
  }
  assert.ok(dot(timeline, 'plan:1-02').waitsForLinks.some((link) => link.label === `1-01 ${flat}`), 'the title is flattened in the link');
  assert.ok(dot(timeline, 'plan:1-01').whoText.startsWith('Assigned to Dana <script>x</script>'), dot(timeline, 'plan:1-01').whoText);
  assert.ok(bandOf(timeline, 'milestone:v1').heading.includes(flat));
});
