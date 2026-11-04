// Assignment in the Team Board model (G-62-5, plan 62-19; owner decision 2026-11-03: "card shows the person; member lane uses the assignee").
// 62-15 made assignment a signed event and 62-25 let any member who is not an observer assign themselves; this file checks that the board shows
// it (the card's person, the member lanes, Mine and the sidebar summary) and decides it the same way the log does (planAssign, the person list,
// the offered actions, the refusals, the history sentences and the card detail). Every event goes through the real materialiser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { assignCandidates, availableAssignActions, boardSummary, buildBoardModel, buildCardDetail, planAssign } from '../domain/team/board';
import type { AssignAction, AssignResult, BoardModel, BoardModelOptions } from '../domain/team/board';
import { ASSIGN_LABELS, ASSIGN_REFUSALS, REFUSALS, historySentence, unassignLabel } from '../domain/team/boardText';
import { ItemHistory } from '../domain/team/itemHistory';
import { CHORE_ID, boardWorld, seedStandardBoard } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';
import { addFixtureMember, makeActor } from './helpers/teamEvents';
import type { TestActor } from './helpers/teamEvents';

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
  member(reviewer.memberId).name = '\u202Erae  van der\nberg';
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

// ---- deciding an assignment (Task 2) ---------------------------------------------------------------------------------------------------------

const refused = (reason: string): AssignResult => ({ ok: false, reason });
const assigned = (id: string, memberId: string): AssignResult => ({ ok: true, intent: { type: 'item.assigned', body: { id, memberId } } });
const unassigned = (id: string): AssignResult => ({ ok: true, intent: { type: 'item.unassigned', body: { id } } });

const NOT_ELIGIBLE = 'This person cannot take cards. Only confirmed team members who are not observers can be assigned. Nothing was changed.';
const FINISHED = 'This card is already done or cancelled, so nobody can be put on it. Nothing was changed.';
const NOT_ASSIGNABLE = 'Only plans, phases and items added on the board can be assigned to a person. Nothing was changed.';
const NOT_ASSIGNED = 'This card is not assigned to anyone. Nothing was changed.';
const MISSING = 'This card is no longer on the board. Nothing was changed.';
const SELF_ONLY = 'You can assign a card only to yourself. A lead can assign it to someone else. Nothing was changed.';
const SELF_OFF_ONLY = 'You can only take yourself off a card. Ask a lead to change it. Nothing was changed.';
const NOT_WORKER = 'Only team members who work on cards can take one. A lead can change your role. Nothing was changed.';

// A joined member still waiting for a lead to confirm the developer role they were invited into (an observer with a pending role, as in
// teamSelfAssign.test.ts) and a removed developer; both hold a device key, so only the rules can stop them.
async function withOutsiders(world: BoardWorld): Promise<{ waiting: TestActor; removed: TestActor }> {
  const [waiting, removed] = await Promise.all([makeActor(world.teamId), makeActor(world.teamId)]);
  addFixtureMember(world.state, waiting, 'observer', 'Wes');
  const member = world.state.members.get(waiting.memberId);
  assert.ok(member !== undefined);
  member.pendingRole = 'developer';
  addFixtureMember(world.state, removed, 'developer', 'Remy');
  world.accept(world.owner, 'member.removed', { memberId: removed.memberId });
  return { waiting, removed };
}

test('planAssign for a lead: the intent to write, or one plain refusal for each rule the log would apply', async () => {
  const world = await standard();
  const { owner, lead, dev, reviewer, observer } = world;
  const { waiting, removed } = await withOutsiders(world);
  const plan = (memberId: string | undefined, itemId = PLAN): AssignResult => planAssign(world.state, lead.memberId, itemId, memberId);

  assert.deepEqual(plan(dev.memberId), assigned(PLAN, dev.memberId));
  assert.deepEqual(plan(reviewer.memberId), assigned(PLAN, reviewer.memberId), 'reviewers can hold an assignment (62-25)');
  assert.deepEqual(plan(lead.memberId), assigned(PLAN, lead.memberId), 'a lead can take a card too');
  for (const person of [observer, waiting, removed]) assert.deepEqual(plan(person.memberId), refused(NOT_ELIGIBLE), person.memberId);
  assert.deepEqual(plan('mbr-0123456789abcdef'), refused(NOT_ELIGIBLE), 'nobody on the roster');
  assert.deepEqual(plan(undefined), refused(NOT_ASSIGNED));

  const planned = plan(dev.memberId);
  assert.ok(planned.ok);
  world.accept(lead, planned.intent.type, planned.intent.body as never);
  assert.deepEqual(plan(dev.memberId), refused('This card is already assigned to Dana. Nothing was changed.'));
  assert.deepEqual(plan(reviewer.memberId), assigned(PLAN, reviewer.memberId), 'a lead can hand the card to someone else');
  assert.deepEqual(plan(undefined), unassigned(PLAN));

  world.accept(owner, 'item.updated', { id: 'plan:90-01', changes: { state: 'done' } });
  assert.deepEqual(plan(dev.memberId, 'plan:90-01'), refused(FINISHED));
  assert.deepEqual(plan(dev.memberId, 'task:90-01-1'), refused(NOT_ASSIGNABLE));
  assert.deepEqual(plan(dev.memberId, 'milestone:v0.9.0'), refused(NOT_ASSIGNABLE));
  assert.deepEqual(plan(dev.memberId, 'plan:99-99'), refused(MISSING));
  assert.deepEqual(planAssign(world.state, owner.memberId, CHORE_ID, dev.memberId), assigned(CHORE_ID, dev.memberId), 'the owner assigns a board item');
});

test('planAssign for a member assigning themselves (62-25): their own free card yes, anyone else or a teammate\'s card no', async () => {
  const world = await standard();
  const { lead, dev, reviewer, observer } = world;
  const { waiting } = await withOutsiders(world);
  for (const person of [dev, reviewer]) {
    const own = planAssign(world.state, person.memberId, PLAN, person.memberId);
    assert.deepEqual(own, assigned(PLAN, person.memberId));
    assert.ok(own.ok);
    world.accept(person, own.intent.type, own.intent.body as never);
    const off = planAssign(world.state, person.memberId, PLAN, undefined);
    assert.deepEqual(off, unassigned(PLAN));
    assert.ok(off.ok);
    world.accept(person, off.intent.type, off.intent.body as never);
  }

  assert.deepEqual(planAssign(world.state, dev.memberId, PLAN, lead.memberId), refused(SELF_ONLY));
  world.accept(lead, 'item.assigned', { id: PLAN, memberId: lead.memberId });
  assert.deepEqual(planAssign(world.state, dev.memberId, PLAN, dev.memberId), refused('This card is assigned to Lee. Lee or a lead can change that. Nothing was changed.'));
  assert.deepEqual(planAssign(world.state, dev.memberId, PLAN, undefined), refused(SELF_OFF_ONLY));
  assert.deepEqual(planAssign(world.state, reviewer.memberId, PLAN, reviewer.memberId), refused('This card is assigned to Lee. Lee or a lead can change that. Nothing was changed.'));
  assert.deepEqual(planAssign(world.state, dev.memberId, CHORE_ID, dev.memberId), assigned(CHORE_ID, dev.memberId), 'her own chore, nobody on it');

  // Observers and a joined member still waiting for a lead hear that first, whatever they ask for.
  for (const person of [observer, waiting]) {
    for (const target of [person.memberId, lead.memberId, undefined]) assert.deepEqual(planAssign(world.state, person.memberId, PLAN, target), refused(NOT_WORKER), `${person.memberId} ${target}`);
    assert.deepEqual(planAssign(world.state, person.memberId, 'plan:99-99', person.memberId), refused(NOT_WORKER), 'before any rule about the card');
  }
  assert.deepEqual(planAssign(world.state, undefined, PLAN, dev.memberId), refused(REFUSALS.noDeviceKey));
  world.accept(world.owner, 'member.removed', { memberId: reviewer.memberId });
  assert.deepEqual(planAssign(world.state, reviewer.memberId, CHORE_ID, reviewer.memberId), refused(REFUSALS.removed));
});

// The board never offers what the log would refuse, and never refuses what the log would accept: every viewer, every target and two starting
// points, each in a fresh world, planned and then signed and applied through the real materialiser.
test('planAssign and the log agree for every role, every target and both starting points', async () => {
  const roles = ['owner', 'lead', 'dev', 'reviewer', 'observer'] as const;
  let checked = 0;
  for (const start of ['free', 'lead\'s'] as const) {
    for (const viewer of roles) {
      for (const target of [undefined, ...roles]) {
        const world = await standard();
        if (start === 'lead\'s') world.accept(world.lead, 'item.assigned', { id: PLAN, memberId: world.lead.memberId });
        const memberId = target === undefined ? undefined : world[target].memberId;
        const result = planAssign(world.state, world[viewer].memberId, PLAN, memberId);
        const entry = memberId === undefined ? world.send(world[viewer], 'item.unassigned', { id: PLAN }) : world.send(world[viewer], 'item.assigned', { id: PLAN, memberId });
        assert.equal(entry.verdict?.accepted, result.ok, `${viewer} on the ${start} card, target ${target ?? 'none'}: ${result.ok ? 'planned' : result.reason}`);
        if (result.ok) assert.deepEqual(result.intent.body, (JSON.parse(entry.text) as { body: unknown }).body, 'the planned intent is exactly the event the log took');
        checked += 1;
      }
    }
  }
  assert.equal(checked, 60);
});

test('the offered actions: Assign to... and Unassign for the owner and leads, Assign to me and Unassign me for other members, nothing for observers', async () => {
  const world = await standard();
  const { owner, lead, dev, reviewer, observer } = world;
  const actions = (viewerId: string, itemId: string): AssignAction[] => card(modelFor(world, viewerId), itemId).assignActions;
  const DONE = 'plan:90-01';
  world.accept(owner, 'item.updated', { id: DONE, changes: { state: 'done' } });

  assert.deepEqual(actions(lead.memberId, PLAN), ['assign'], 'unassigned open card');
  assert.deepEqual(actions(owner.memberId, PLAN), ['assign']);
  assert.deepEqual(actions(lead.memberId, DONE), [], 'unassigned done card');
  for (const person of [dev, reviewer]) {
    assert.deepEqual(actions(person.memberId, PLAN), ['assign-me'], person.memberId);
    assert.deepEqual(actions(person.memberId, DONE), [], 'nobody takes a finished card');
  }
  assert.deepEqual(actions(observer.memberId, PLAN), []);

  world.accept(lead, 'item.assigned', { id: PLAN, memberId: dev.memberId });
  assert.deepEqual(actions(lead.memberId, PLAN), ['assign', 'unassign'], 'assigned open card');
  assert.deepEqual(actions(dev.memberId, PLAN), ['unassign-me'], 'her own card');
  assert.deepEqual(actions(reviewer.memberId, PLAN), [], 'a teammate\'s card');
  assert.deepEqual(actions(observer.memberId, PLAN), []);

  world.accept(owner, 'item.updated', { id: PLAN, changes: { state: 'done' } });
  assert.deepEqual(actions(lead.memberId, PLAN), ['unassign'], 'assigned done card');
  assert.deepEqual(actions(dev.memberId, PLAN), ['unassign-me'], 'her own done card');
  assert.deepEqual(actions(reviewer.memberId, PLAN), []);

  for (const id of ['milestone:v0.9.0', 'task:90-01-1', 'plan:99-99']) {
    for (const person of [owner, lead, dev, reviewer, observer]) assert.deepEqual(availableAssignActions(world.state, person.memberId, id), [], `${id} for ${person.memberId}`);
  }
  assert.deepEqual(availableAssignActions(world.state, undefined, CHORE_ID), []);
  assert.deepEqual(card(modelFor(world, lead.memberId, { canWrite: false }), CHORE_ID).assignActions, [], 'nothing is offered while the team cannot be reached');
  assert.deepEqual(card(modelFor(world, lead.memberId), CHORE_ID).assignActions, ['assign']);
});

test('the person list: exactly the members who may take the card, by name, with role and the current assignee marked; empty for everyone else', async () => {
  const world = await standard();
  const { owner, lead, dev, reviewer, observer } = world;
  await withOutsiders(world);
  const roster = (viewerId: string | undefined, itemId = PLAN) => assignCandidates(world.state, viewerId, itemId);
  const expected = (current?: string) => [
    { memberId: dev.memberId, name: 'Dana', roleLabel: 'Developer', current: current === dev.memberId },
    { memberId: lead.memberId, name: 'Lee', roleLabel: 'Lead', current: current === lead.memberId },
    { memberId: owner.memberId, name: 'Owner Test', roleLabel: 'Owner', current: current === owner.memberId },
    { memberId: reviewer.memberId, name: 'Rae', roleLabel: 'Reviewer', current: current === reviewer.memberId }
  ];
  assert.deepEqual(roster(lead.memberId), expected());
  assert.deepEqual(roster(owner.memberId), expected());
  world.accept(lead, 'item.assigned', { id: PLAN, memberId: dev.memberId });
  assert.deepEqual(roster(lead.memberId), expected(dev.memberId), 'Dana stays in the list, marked as the one on the card');
  for (const viewer of [dev, reviewer, observer]) assert.deepEqual(roster(viewer.memberId), [], `${viewer.memberId} never gets the person list`);
  assert.deepEqual(roster(undefined), []);
  world.accept(owner, 'item.updated', { id: PLAN, changes: { state: 'done' } });
  assert.deepEqual(roster(lead.memberId), [], 'a finished card takes nobody new');
  assert.deepEqual(roster(lead.memberId, 'task:90-01-1'), []);
});

test('the words: labels for the actions, and every assignment refusal ends "Nothing was changed."', () => {
  assert.deepEqual(ASSIGN_LABELS, { assign: 'Assign to...', unassign: 'Unassign', 'assign-me': 'Assign to me', 'unassign-me': 'Unassign me' });
  assert.equal(unassignLabel('Dana\n Smith'), 'Unassign Dana Smith');
  const sentences = Object.values(ASSIGN_REFUSALS).map((value) => (typeof value === 'function' ? value('Lee\u202E\nx') : value));
  assert.ok(sentences.length >= 10);
  for (const sentence of sentences) {
    assert.match(sentence, /Nothing was changed\.$/, sentence);
    assert.doesNotMatch(sentence, /[\u0000-\u001F\u2013\u2014\u202E]/, sentence);
  }
  assert.equal(ASSIGN_REFUSALS.alreadyAssigned('Dana'), 'This card is already assigned to Dana. Nothing was changed.');
});

test('the card detail names the person, offers the same actions, and its history says who assigned whom', async () => {
  const world = await standard();
  const { lead, dev } = world;
  const history = new ItemHistory();
  world.accept(lead, 'item.assigned', { id: PLAN, memberId: dev.memberId });
  world.accept(lead, 'item.unassigned', { id: PLAN });
  world.accept(dev, 'item.assigned', { id: PLAN, memberId: dev.memberId });
  world.accept(dev, 'item.unassigned', { id: PLAN });
  world.accept(lead, 'item.assigned', { id: PLAN, memberId: dev.memberId });
  history.record(world.entries);
  const detail = (viewerId: string) => {
    const built = buildCardDetail(world.state, PLAN, { viewerId, nowMs: NOW, history: history.forItem(PLAN) });
    assert.ok(built);
    return built;
  };
  const forLead = detail(lead.memberId);
  // 62-20: the detail's assignee carries the role word for 'Assigned to Dana (Developer)'.
  assert.deepEqual(forLead.assignee, { id: dev.memberId, name: 'Dana', roleLabel: 'Developer' });
  assert.deepEqual(forLead.assignActions, ['assign', 'unassign']);
  assert.deepEqual(detail(dev.memberId).assignActions, ['unassign-me']);
  assert.deepEqual(forLead.history.map((row) => row.text).slice(0, 5), [
    'Lee assigned this to Dana.', 'Dana unassigned themselves.', 'Dana assigned this to themselves.', 'Lee unassigned Dana.', 'Lee assigned this to Dana.'
  ]);
  const chore = buildCardDetail(world.state, CHORE_ID, { viewerId: lead.memberId, nowMs: NOW, history: [] });
  assert.equal(chore?.assignee, undefined);
  assert.deepEqual(chore?.assignActions, ['assign']);

  // Names are flattened, and a person who is no longer on the roster is "Someone".
  const member = world.state.members.get(dev.memberId);
  assert.ok(member);
  member.name = 'Dana\n\u202Eevil';
  assert.equal(detail(lead.memberId).history[0]?.text, 'Lee assigned this to Dana evil.');
  const entry = { eventId: 'e', type: 'item.assigned', author: lead.memberId, at: 'x', memberId: 'mbr-0123456789abcdef' };
  assert.equal(historySentence(entry, 'Lee', { origin: 'import' }), 'Lee assigned this to Someone.');
  assert.equal(historySentence({ ...entry, type: 'item.unassigned' }, 'Lee', { origin: 'import', assigneeName: '' }), 'Lee unassigned Someone.');
});
