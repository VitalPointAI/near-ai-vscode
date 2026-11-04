// G-62-5 (62-15): a lead puts a person on a card with item.assigned { id, memberId } and takes them off with item.unassigned { id }. Both are signed,
// mapped to the item.assign row (owner and lead) and checked on write and on read like every other event. The first test is the tracer over real
// git: the lead's assignment on one computer shows on the developer's computer after one sync, and a developer taking a teammate's card is refused
// on write and rejected on read by both clones when it is forged straight into the remote. Reasons are asserted from TEAM_REJECTION_REASONS.
// Owner decision 2026-11-03 (62-25): a member's own assignment of an unassigned card, and taking themselves off their own card, is now allowed
// (item.assign-self, tested in teamSelfAssign.test.ts); the cases below that changed say so where they changed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { canonicalize, eventPath } from '../domain/team/canonical';
import { checkCandidate, cloneState, serialiseState } from '../domain/team/materialize';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { CommittedEvent, TeamEvent, TeamState } from '../domain/team/types';
import { prepareEvents } from '../team/eventLog';
import type { EventIntent } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF } from '../team/gitTransport';
import { NEUTRAL_IDENTITY_ENV } from '../team/runGit';
import { closeRig, confirm, createRig, enable, invite, join, openLog, publishProject, rootOf } from './helpers/teamFlowRig';
import type { OpenLog, Rig } from './helpers/teamFlowRig';
import { ItemHistory, MAX_HISTORY_PER_ITEM } from '../domain/team/itemHistory';
import { CHORE_ID, boardWorld, importedBody, seedStandardBoard } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';
import { addFixtureMember, makeActor, signed } from './helpers/teamEvents';
import type { TestActor } from './helpers/teamEvents';
import type { MemorySecrets } from './helpers/teamHarness';

const R = TEAM_REJECTION_REASONS;
const DEVELOPER_MAY_NOT = `${R.notPermitted}: the developer role does not allow assigning items to others`;

// The two intents, built loosely so this file states the wire shape itself rather than borrowing it from the types under test.
function assignIntent(id: string, memberId: string): EventIntent {
  return { type: 'item.assigned', body: { id, memberId } } as unknown as EventIntent;
}
function unassignIntent(id: string): EventIntent {
  return { type: 'item.unassigned', body: { id } } as unknown as EventIntent;
}

// The stored assignee of an item, read without leaning on the WorkItem type so the wire contract is stated here.
function assigneeOf(state: TeamState, itemId: string): string | undefined {
  const item = state.items.get(itemId) as { assignee?: string } | undefined;
  return item?.assignee;
}

function rawGit(cwd: string, args: string[], options: { env?: Record<string, string>; input?: string } = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...options.env }, input: options.input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// What a hostile member's git access allows: add any event file to the coordination branch and push it as an ordinary fast-forward.
function rawPush(dir: string, event: TeamEvent, message: string): void {
  rawGit(dir, ['fetch', '-q', 'origin', `+${DEFAULT_COORDINATION_REF}:refs/raw/coordination`]);
  const parent = rawGit(dir, ['rev-parse', 'refs/raw/coordination']);
  const indexFile = path.join(dir, '.git', `raw-index-${randomBytes(4).toString('hex')}`);
  const env = { GIT_INDEX_FILE: indexFile, ...NEUTRAL_IDENTITY_ENV };
  try {
    rawGit(dir, ['read-tree', parent], { env });
    const blob = rawGit(dir, ['hash-object', '-w', '--stdin'], { env, input: canonicalize(event) });
    rawGit(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${eventPath(event)}`], { env });
    const tree = rawGit(dir, ['write-tree'], { env });
    const commit = rawGit(dir, ['commit-tree', tree, '-p', parent, '-m', message], { env });
    rawGit(dir, ['push', '-q', 'origin', `${commit}:${DEFAULT_COORDINATION_REF}`]);
  } finally {
    rmSync(indexFile, { force: true });
  }
}

function withoutRejections(state: TeamState): string {
  const copy = cloneState(state);
  copy.rejected = [];
  return serialiseState(copy);
}

const actorOf = (opened: OpenLog, secrets: MemorySecrets): TestActor => {
  assert.ok(opened.identity !== undefined && opened.memberId !== undefined, 'the person has a device key and a member id');
  return { memberId: opened.memberId as string, identity: opened.identity as TestActor['identity'], secrets };
};

// The real membership lifecycle on three clones: the owner on a, the developer on b and the lead on c, both joined and confirmed.
async function withTeam(run: (rig: Rig, teamId: string) => Promise<void>): Promise<void> {
  const rig = await createRig({ linked: false });
  try {
    const enabled = await enable(rig);
    await publishProject(rig);
    await invite(rig, rig.dev);
    await invite(rig, rig.lead);
    await join(rig, rig.dev);
    await join(rig, rig.lead);
    await confirm(rig, rig.lead);
    await confirm(rig, rig.dev);
    await run(rig, enabled.teamFile.teamId);
  } finally {
    await closeRig(rig);
  }
}

const common = { state: 'backlog' as const, dependsOn: [] as string[], scope: [] as string[], requirements: [] as string[], mustHaves: [] as string[], tags: [] as string[] };

test('a lead assigns a plan to a developer on one computer, the developer sees it after one sync, and a developer cannot assign on write or by forging', async () => {
  await withTeam(async (rig, teamId) => {
    const owner = await openLog(rig, 'owner');
    const imported = await owner.log.append(() => [
      { type: 'item.imported', body: { ...common, id: 'milestone:v0.9.0', kind: 'milestone', title: 'Version 0.9.0' } },
      { type: 'item.imported', body: { ...common, id: 'phase:90', kind: 'phase', title: 'Alpha work', parentId: 'milestone:v0.9.0' } },
      { type: 'item.imported', body: { ...common, id: 'plan:90-01', kind: 'plan', title: 'Alpha slice', parentId: 'phase:90', scope: ['src/a/**'], estimate: { tokens: 1000 } } },
      { type: 'item.imported', body: { ...common, id: 'plan:90-02', kind: 'plan', title: 'Beta slice', parentId: 'phase:90', scope: ['src/b/**'], estimate: { tokens: 2000 } } }
    ]);
    assert.equal(imported.ok, true, imported.ok ? '' : imported.reason);
    const lead = await openLog(rig, rig.lead);
    const developer = await openLog(rig, rig.dev);
    const developerId = developer.memberId as string;
    assert.equal(developer.log.state().members.get(developerId)?.role, 'developer');
    assert.equal(lead.log.state().members.get(lead.memberId as string)?.role, 'lead');
    assert.equal(assigneeOf(developer.log.state(), 'plan:90-02'), undefined);

    // The lead, on clone c, assigns the plan to the developer.
    const assigned = await lead.log.append(() => [assignIntent('plan:90-02', developerId)]);
    assert.equal(assigned.ok, true, assigned.ok ? '' : assigned.reason);
    assert.equal(assigneeOf(lead.log.state(), 'plan:90-02'), developerId);

    // One sync on the developer's computer (clone b) is all it takes.
    const synced = await developer.log.sync();
    assert.deepEqual(synced.rejected, []);
    assert.equal(synced.accepted.length, 1);
    assert.equal(assigneeOf(developer.log.state(), 'plan:90-02'), developerId);
    await owner.log.sync();
    assert.equal(assigneeOf(owner.log.state(), 'plan:90-02'), developerId);
    assert.equal(serialiseState(developer.log.state()), serialiseState(owner.log.state()));

    // Owner decision 2026-11-03 (62-25): a developer may now take an unassigned card and leave their own, so the refused and forged cases here
    // are the ones the rule still forbids. The lead takes plan:90-01 first, so it is a teammate's card for the developer.
    const leadTakes = await lead.log.append(() => [assignIntent('plan:90-01', lead.memberId as string)]);
    assert.equal(leadTakes.ok, true, leadTakes.ok ? '' : leadTakes.reason);
    assert.equal((await developer.log.sync()).accepted.length, 1);
    await owner.log.sync();
    assert.equal(assigneeOf(owner.log.state(), 'plan:90-01'), lead.memberId);

    // The developer's own client refuses taking the lead's card before anything is written.
    const remoteHead = owner.log.state().head;
    const own = await developer.log.append(() => [assignIntent('plan:90-01', developerId)]);
    assert.equal(own.ok, false);
    assert.equal(own.ok ? '' : own.reason, DEVELOPER_MAY_NOT);
    await owner.log.sync();
    assert.deepEqual(owner.log.state().head, remoteHead, 'nothing reached the remote');

    // The same events, validly signed by the developer's device, pushed straight to the coordination branch: the developer takes the lead's
    // card, and the developer takes the lead off it.
    const before = withoutRejections(owner.log.state());
    const position = { teamId, lamport: remoteHead.lamport + 1, prev: remoteHead.eventId };
    const developerActor = actorOf(developer, rig.dev.secrets);
    const forgedAssign = signed(developerActor, { ...position, type: 'item.assigned' as never, body: { id: 'plan:90-01', memberId: developerId } as never });
    const forgedUnassign = signed(developerActor, { ...position, type: 'item.unassigned' as never, body: { id: 'plan:90-01' } as never });
    rawPush(rootOf(rig, 'b'), forgedAssign, 'raw: a developer takes the lead\'s card');
    rawPush(rootOf(rig, 'b'), forgedUnassign, 'raw: a developer takes the lead off their card');

    const syncedOwner = await owner.log.sync();
    const syncedDeveloper = await developer.log.sync();
    for (const result of [syncedOwner, syncedDeveloper]) {
      assert.deepEqual(result.accepted, []);
      assert.deepEqual(result.rejected.map((rejection) => rejection.eventId), [forgedAssign.id, forgedUnassign.id]);
      for (const rejection of result.rejected) assert.equal(rejection.reason, DEVELOPER_MAY_NOT);
    }
    assert.deepEqual(syncedOwner.rejected, syncedDeveloper.rejected, 'both clients record the very same rejections');
    assert.equal(withoutRejections(owner.log.state()), before, 'nothing changed');
    assert.equal(withoutRejections(developer.log.state()), before, 'nothing changed on the developer clone either');
    assert.equal(assigneeOf(owner.log.state(), 'plan:90-01'), lead.memberId);
    assert.equal(assigneeOf(owner.log.state(), 'plan:90-02'), developerId);

    // The forged files did not block the log: the lead unassigns with the next lamport and every clone follows.
    const cleared = await lead.log.append(() => [unassignIntent('plan:90-02')]);
    assert.equal(cleared.ok, true, cleared.ok ? '' : cleared.reason);
    if (cleared.ok) assert.equal((cleared.events[0] as TeamEvent).lamport, remoteHead.lamport + 1);
    const after = await developer.log.sync();
    assert.equal(after.accepted.length, 1);
    assert.deepEqual(after.rejected, []);
    assert.equal(assigneeOf(developer.log.state(), 'plan:90-02'), undefined);
  });
});

// ---- In memory: the rules, removal, state independence and history (Task 3) ------------------------------------------------------------------
// boardWorld is an owner who really signs plus a lead (Lee), a developer (Dana), a reviewer (Rae) and an observer (Obi); seedStandardBoard adds
// milestone:v0.9.0, phase:90 with plan:90-01 and plan:90-02 (and two tasks), the planless phase:91 and the developer's board chore.

// The person a history entry names, read loosely so this file states the shape it expects.
function memberIdOf(entry: object | undefined): string | undefined {
  return (entry as { memberId?: string } | undefined)?.memberId;
}

function verdictOf(entry: CommittedEvent): string | undefined {
  const verdict = entry.verdict;
  assert.ok(verdict !== undefined, 'the entry was applied');
  return verdict.accepted ? undefined : verdict.rejection.reason;
}

async function seededWorld(): Promise<BoardWorld> {
  const world = await boardWorld();
  seedStandardBoard(world);
  return world;
}

// An unused invitation (a real member.invited), a removed developer (a real member.removed) and a joined member who still waits for a lead to
// confirm the developer role they were invited into (observer with a pending role, the shape a confirmed-join policy leaves).
async function withOutsiders(world: BoardWorld): Promise<{ invited: string; removed: string; waiting: string }> {
  const [invitee, leaver, waiter] = await Promise.all([makeActor(world.teamId), makeActor(world.teamId), makeActor(world.teamId)]);
  world.accept(world.owner, 'member.invited', {
    memberId: invitee.memberId, name: 'Ivy', emailHashes: ['cd'.repeat(32)], role: 'developer', allocationNanoUsd: 0, ttlSeconds: 604_800, invite: { publicKey: invitee.identity.publicKey }
  });
  addFixtureMember(world.state, leaver, 'developer', 'Remy');
  world.accept(world.owner, 'member.removed', { memberId: leaver.memberId });
  addFixtureMember(world.state, waiter, 'observer', 'Wes');
  const waiting = world.state.members.get(waiter.memberId);
  assert.ok(waiting !== undefined);
  waiting.pendingRole = 'developer';
  return { invited: invitee.memberId, removed: leaver.memberId, waiting: waiter.memberId };
}

test('each assignment the rules refuse is rejected with its own reason, and nothing changes', async () => {
  const world = await seededWorld();
  const { lead, dev, reviewer, observer } = world;
  const outsiders = await withOutsiders(world);
  const cancelled = `item:${'0'.repeat(22)}9ZZZ`;
  world.accept(lead, 'item.updated', { id: 'plan:90-01', changes: { state: 'done' } });
  world.accept(lead, 'item.created', { id: cancelled, kind: 'bug', title: 'Gone', scope: [], requirements: [], mustHaves: [] });
  world.accept(lead, 'item.cancelled', { id: cancelled, reason: 'duplicate' });
  world.accept(lead, 'item.assigned', { id: 'plan:90-02', memberId: dev.memberId });
  const before = serialiseState(world.state);
  const rows: Array<[string, () => CommittedEvent, string]> = [
    ['a milestone', () => world.send(lead, 'item.assigned', { id: 'milestone:v0.9.0', memberId: dev.memberId }), R.itemNotAssignable],
    ['a task', () => world.send(lead, 'item.assigned', { id: 'task:90-01-1', memberId: dev.memberId }), R.itemNotAssignable],
    ['a done plan', () => world.send(lead, 'item.assigned', { id: 'plan:90-01', memberId: dev.memberId }), R.itemTerminal],
    ['a cancelled board item', () => world.send(lead, 'item.assigned', { id: cancelled, memberId: dev.memberId }), R.itemTerminal],
    ['an item that is not on the board', () => world.send(lead, 'item.assigned', { id: 'plan:90-77', memberId: dev.memberId }), R.itemMissing],
    ['an observer', () => world.send(lead, 'item.assigned', { id: CHORE_ID, memberId: observer.memberId }), R.assigneeNotEligible],
    ['a removed member', () => world.send(lead, 'item.assigned', { id: CHORE_ID, memberId: outsiders.removed }), R.assigneeNotEligible],
    ['an unused invitation', () => world.send(lead, 'item.assigned', { id: CHORE_ID, memberId: outsiders.invited }), R.assigneeNotEligible],
    ['a joined member waiting for confirmation', () => world.send(lead, 'item.assigned', { id: CHORE_ID, memberId: outsiders.waiting }), R.assigneeNotEligible],
    ['someone who is not on the roster', () => world.send(lead, 'item.assigned', { id: CHORE_ID, memberId: 'mbr-0000000000000000' }), R.assigneeNotEligible],
    ['the same member twice in a row', () => world.send(lead, 'item.assigned', { id: 'plan:90-02', memberId: dev.memberId }), R.itemAlreadyAssigned],
    ['unassign a card nobody is on', () => world.send(lead, 'item.unassigned', { id: CHORE_ID }), R.itemNotAssigned],
    ['unassign an item that is not on the board', () => world.send(lead, 'item.unassigned', { id: 'plan:90-77' }), R.itemMissing]
  ];
  for (const [name, attempt, reason] of rows) assert.equal(verdictOf(attempt()), reason, name);
  // The rejections are recorded in the rejected list; everything else is exactly as it was.
  const after = cloneState(world.state);
  after.rejected = after.rejected.slice(0, after.rejected.length - rows.length);
  assert.equal(serialiseState(after), before);
  // Owner decision 2026-11-03 (62-25): reviewers can now hold an assignment, so this row moved from not eligible to accepted.
  world.accept(lead, 'item.assigned', { id: CHORE_ID, memberId: reviewer.memberId });
  assert.equal(world.state.items.get(CHORE_ID)?.assignee, reviewer.memberId);
});

test('only the owner and a lead may assign or unassign, on read', async () => {
  const world = await seededWorld();
  const { owner, lead, dev, reviewer, observer } = world;
  // Owner decision 2026-11-03 (62-25): a developer or reviewer may now assign and unassign themselves (teamSelfAssign.test.ts), so their rows
  // put the lead on the card and take the lead off it instead; the observer row is unchanged.
  for (const [actor, role, target] of [[dev, 'developer', lead], [reviewer, 'reviewer', lead], [observer, 'observer', dev]] as const) {
    assert.equal(verdictOf(world.send(actor, 'item.assigned', { id: CHORE_ID, memberId: target.memberId })), `${R.notPermitted}: the ${role} role does not allow assigning items to others`, role);
  }
  world.accept(owner, 'item.assigned', { id: CHORE_ID, memberId: lead.memberId });
  for (const [actor, role] of [[dev, 'developer'], [reviewer, 'reviewer'], [observer, 'observer']] as const) {
    assert.equal(verdictOf(world.send(actor, 'item.unassigned', { id: CHORE_ID })), `${R.notPermitted}: the ${role} role does not allow assigning items to others`, role);
  }
  world.accept(lead, 'item.unassigned', { id: CHORE_ID });
  world.accept(lead, 'item.assigned', { id: CHORE_ID, memberId: owner.memberId });
  assert.equal(world.state.items.get(CHORE_ID)?.assignee, owner.memberId);
});

test('a planless phase, a backlog plan and a board chore take the owner, a lead and a developer in turn, each replacing the last', async () => {
  const world = await seededWorld();
  const { owner, lead, dev } = world;
  for (const id of ['phase:91', 'plan:90-02', CHORE_ID]) {
    for (const person of [owner, lead, dev]) {
      world.accept(lead, 'item.assigned', { id, memberId: person.memberId });
      assert.equal(world.state.items.get(id)?.assignee, person.memberId, `${id} to ${person.memberId}`);
    }
  }
  // The lead replaces the developer on plan:90-02 with themselves, then takes the card off.
  world.accept(lead, 'item.assigned', { id: 'plan:90-02', memberId: lead.memberId });
  assert.equal(world.state.items.get('plan:90-02')?.assignee, lead.memberId);
  world.accept(owner, 'item.unassigned', { id: 'plan:90-02' });
  assert.equal(world.state.items.get('plan:90-02')?.assignee, undefined);
  assert.ok(!('assignee' in (world.state.items.get('plan:90-02') ?? {})), 'the key is left out, not stored empty');
  // A card assigned before it was finished can still be cleared once it is done.
  world.accept(lead, 'item.assigned', { id: 'plan:90-01', memberId: dev.memberId });
  world.accept(lead, 'item.updated', { id: 'plan:90-01', changes: { state: 'done' } });
  assert.equal(world.state.items.get('plan:90-01')?.assignee, dev.memberId);
  world.accept(lead, 'item.unassigned', { id: 'plan:90-01' });
  assert.equal(world.state.items.get('plan:90-01')?.assignee, undefined);
});

test('blocking, holding, releasing, marking done, reopening and cancelling never change the assignee, and assignment never moves stateSince', async () => {
  const world = await seededWorld();
  const { lead, dev } = world;
  const plan = (): NonNullable<ReturnType<TeamState['items']['get']>> => {
    const item = world.state.items.get('plan:90-02');
    assert.ok(item !== undefined);
    return item;
  };
  const since = plan().stateSince;
  world.accept(lead, 'item.assigned', { id: 'plan:90-02', memberId: dev.memberId });
  assert.equal(plan().stateSince, since, 'assigning is not a state change');
  // Each step, and whether it moves stateSince (the stored state or the hold flag changed).
  const steps: Array<[string, () => CommittedEvent, boolean]> = [
    ['block', () => world.accept(lead, 'item.blocked', { id: 'plan:90-02', reason: 'waiting on design' }), false],
    ['hold', () => world.accept(lead, 'item.updated', { id: 'plan:90-02', changes: { hold: true } }), true],
    ['release', () => world.accept(lead, 'item.updated', { id: 'plan:90-02', changes: { hold: false } }), true],
    ['unblock', () => world.accept(lead, 'item.unblocked', { id: 'plan:90-02' }), false],
    ['mark done', () => world.accept(lead, 'item.updated', { id: 'plan:90-02', changes: { state: 'done' } }), true],
    ['reopen', () => world.accept(lead, 'item.reopened', { id: 'plan:90-02' }), true],
    ['cancel', () => world.accept(lead, 'item.cancelled', { id: 'plan:90-02', reason: 'folded in' }), true],
    ['reopen again', () => world.accept(lead, 'item.reopened', { id: 'plan:90-02' }), true]
  ];
  let expected = since;
  for (const [name, step, moves] of steps) {
    const entry = step();
    if (moves) expected = (JSON.parse(entry.text) as { at: string }).at;
    assert.equal(plan().assignee, dev.memberId, `${name} keeps the assignee`);
    assert.equal(plan().stateSince, expected, `${name} stateSince`);
  }
  world.accept(lead, 'item.unassigned', { id: 'plan:90-02' });
  assert.equal(plan().stateSince, expected, 'unassigning is not a state change');
});

test('removing a member clears every card assigned to them in the same step and leaves the others alone', async () => {
  const world = await seededWorld();
  const { owner, lead, dev } = world;
  world.accept(lead, 'item.assigned', { id: 'plan:90-02', memberId: dev.memberId });
  world.accept(lead, 'item.assigned', { id: CHORE_ID, memberId: dev.memberId });
  world.accept(lead, 'item.assigned', { id: 'phase:91', memberId: lead.memberId });
  world.accept(lead, 'item.assigned', { id: 'plan:90-01', memberId: owner.memberId });
  const accepted = world.state.accepted;
  world.accept(owner, 'member.removed', { memberId: dev.memberId });
  assert.equal(world.state.accepted, accepted + 1, 'one event did it all');
  assert.equal(world.state.items.get('plan:90-02')?.assignee, undefined);
  assert.equal(world.state.items.get(CHORE_ID)?.assignee, undefined);
  assert.equal(world.state.items.get('phase:91')?.assignee, lead.memberId);
  assert.equal(world.state.items.get('plan:90-01')?.assignee, owner.memberId);
  const holders = [...world.state.items.values()].filter((item) => item.assignee !== undefined).map((item) => item.id).sort();
  assert.deepEqual(holders, ['phase:91', 'plan:90-01']);
  // The removed developer cannot be put back on a card.
  assert.equal(verdictOf(world.send(lead, 'item.assigned', { id: 'plan:90-02', memberId: dev.memberId })), R.assigneeNotEligible);
});

test('the board planner and the reader give the same answer, because both ask transitionProblem', async () => {
  const world = await seededWorld();
  // Owner decision 2026-11-03 (62-25): a reviewer can now be assigned, so the person nobody may assign is the observer.
  const { lead, dev, observer } = world;
  world.accept(lead, 'item.assigned', { id: CHORE_ID, memberId: dev.memberId });
  const head = world.state.head;
  const prepared = prepareEvents(world.state, head, { identity: lead.identity, memberId: lead.memberId }, [{ type: 'item.assigned', body: { id: CHORE_ID, memberId: observer.memberId } }], () => new Date('2026-03-02T00:00:00.000Z'));
  assert.ok(Array.isArray(prepared), 'the permission check passes for a lead');
  const rejection = checkCandidate(world.state, prepared as TeamEvent[]);
  assert.equal(rejection?.reason, R.assigneeNotEligible);
  assert.equal(verdictOf(world.send(lead, 'item.assigned', { id: CHORE_ID, memberId: observer.memberId })), R.assigneeNotEligible);
});

test('card history records who was assigned and who was taken off, in log order, within the 50-entry cap', async () => {
  const world = await seededWorld();
  const { owner, lead, dev } = world;
  world.accept(lead, 'item.assigned', { id: 'plan:90-02', memberId: dev.memberId });
  world.accept(lead, 'item.assigned', { id: 'plan:90-02', memberId: lead.memberId });
  world.accept(owner, 'item.unassigned', { id: 'plan:90-02' });
  // Owner decision 2026-11-03 (62-25): the developer may now take this free card themselves, so the refused attempt puts the lead on it instead.
  assert.equal(verdictOf(world.send(dev, 'item.assigned', { id: 'plan:90-02', memberId: lead.memberId })), DEVELOPER_MAY_NOT);
  world.accept(lead, 'item.assigned', { id: CHORE_ID, memberId: dev.memberId });
  world.accept(owner, 'member.removed', { memberId: dev.memberId });
  world.accept(lead, 'item.assigned', { id: CHORE_ID, memberId: lead.memberId });
  world.accept(lead, 'item.unassigned', { id: CHORE_ID });
  const history = new ItemHistory();
  history.record(world.entries);
  const plan = history.forItem('plan:90-02').filter((entry) => entry.type.startsWith('item.') && entry.type.includes('assign'));
  assert.deepEqual(plan.map((entry) => [entry.type, entry.author, memberIdOf(entry)]), [
    ['item.unassigned', owner.memberId, lead.memberId],
    ['item.assigned', lead.memberId, lead.memberId],
    ['item.assigned', lead.memberId, dev.memberId]
  ], 'newest first; the rejected developer attempt left nothing');
  // After the removal cleared the chore, the next unassign names only the person it really took off.
  const chore = history.forItem(CHORE_ID).filter((entry) => entry.type.includes('assign'));
  assert.deepEqual(chore.map((entry) => [entry.type, memberIdOf(entry)]), [['item.unassigned', lead.memberId], ['item.assigned', lead.memberId], ['item.assigned', dev.memberId]]);
  // The cap still holds: 60 more assignments keep only the newest 50.
  const capWorld = await seededWorld();
  for (let index = 0; index < 30; index += 1) {
    capWorld.accept(capWorld.lead, 'item.assigned', { id: CHORE_ID, memberId: capWorld.dev.memberId });
    capWorld.accept(capWorld.lead, 'item.assigned', { id: CHORE_ID, memberId: capWorld.lead.memberId });
  }
  const capped = new ItemHistory();
  capped.record(capWorld.entries);
  const kept = capped.forItem(CHORE_ID);
  assert.equal(kept.length, MAX_HISTORY_PER_ITEM);
  assert.equal(memberIdOf(kept[0]), capWorld.lead.memberId);
  assert.equal(memberIdOf(kept[1]), capWorld.dev.memberId);
});

test('a board item added by the developer can be assigned like an imported plan', async () => {
  const world = await seededWorld();
  const { lead, dev } = world;
  world.accept(lead, 'item.imported', importedBody({ id: 'plan:91-01', kind: 'plan', title: 'Gamma', parentId: 'phase:91' }));
  world.accept(lead, 'item.assigned', { id: 'plan:91-01', memberId: dev.memberId });
  world.accept(lead, 'item.assigned', { id: CHORE_ID, memberId: dev.memberId });
  assert.equal(world.state.items.get('plan:91-01')?.assignee, dev.memberId);
  assert.equal(world.state.items.get(CHORE_ID)?.assignee, dev.memberId);
});
