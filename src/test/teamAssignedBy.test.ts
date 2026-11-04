// G-62-5, owner decision 2026-11-04 (62-26): a member who is not the owner or a lead can take themselves off a card only when they assigned it to
// themselves. A card the owner or a lead assigned to them stays theirs until the owner or a lead changes it. Every client records who made a card's
// current assignment (assignedBy, the author of the item.assigned that set the assignee) and actionForEvent asks it on write and on read. The signed
// events stay as 62-15 made them (item.assigned { id, memberId }, item.unassigned { id }), so no body, hash version or pinned hash moves.
// The first test is the tracer over real git: a lead assigns the developer, the developer's own client refuses their unassign, and the same event
// forged straight into the remote is rejected by both clones; a card the developer took themselves they can still leave. Reasons are asserted from
// TEAM_REJECTION_REASONS.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { canonicalize, eventPath } from '../domain/team/canonical';
import { checkCandidate, cloneState, deserialiseState, serialiseState, stateHash } from '../domain/team/materialize';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { CommittedEvent, ItemAssignedBody, ItemUnassignedBody, JsonObject, TeamEvent, TeamState } from '../domain/team/types';
import { prepareEvents } from '../team/eventLog';
import type { EventIntent } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF } from '../team/gitTransport';
import { NEUTRAL_IDENTITY_ENV } from '../team/runGit';
import { closeRig, confirm, createRig, enable, invite, join, openLog, publishProject, rootOf } from './helpers/teamFlowRig';
import type { OpenLog, Rig } from './helpers/teamFlowRig';
import { CHORE_ID, boardWorld, seedStandardBoard } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';
import { signed } from './helpers/teamEvents';
import type { TestActor } from './helpers/teamEvents';
import type { MemorySecrets } from './helpers/teamHarness';

const R = TEAM_REJECTION_REASONS;
const DEVELOPER_MAY_NOT = `${R.notPermitted}: the developer role does not allow assigning items to others`;
const REVIEWER_MAY_NOT = `${R.notPermitted}: the reviewer role does not allow assigning items to others`;

// The two intents, built loosely so this file states the wire shape itself rather than borrowing it from the types under test.
function assignIntent(id: string, memberId: string): EventIntent {
  return { type: 'item.assigned', body: { id, memberId } } as unknown as EventIntent;
}
function unassignIntent(id: string): EventIntent {
  return { type: 'item.unassigned', body: { id } } as unknown as EventIntent;
}

// Read loosely, so the test states the stored shape rather than borrowing it from the type under test.
function stored(state: TeamState, itemId: string): { assignee?: string; assignedBy?: string } {
  const item = state.items.get(itemId) as { assignee?: string; assignedBy?: string } | undefined;
  assert.ok(item !== undefined, `${itemId} is on the board`);
  return { ...(item.assignee === undefined ? {} : { assignee: item.assignee }), ...(item.assignedBy === undefined ? {} : { assignedBy: item.assignedBy }) };
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

test('a lead assigns the developer and the developer cannot take themselves off, on write or by forging; a card the developer took they can leave', async () => {
  await withTeam(async (rig, teamId) => {
    const owner = await openLog(rig, 'owner');
    const imported = await owner.log.append(() => [
      { type: 'item.imported', body: { ...common, id: 'milestone:v0.9.0', kind: 'milestone', title: 'Version 0.9.0' } },
      { type: 'item.imported', body: { ...common, id: 'phase:90', kind: 'phase', title: 'Alpha work', parentId: 'milestone:v0.9.0' } },
      { type: 'item.imported', body: { ...common, id: 'plan:90-02', kind: 'plan', title: 'Beta slice', parentId: 'phase:90', scope: ['src/b/**'], estimate: { tokens: 2000 } } },
      { type: 'item.imported', body: { ...common, id: 'plan:90-03', kind: 'plan', title: 'Gamma slice', parentId: 'phase:90', scope: ['src/c/**'], estimate: { tokens: 3000 } } }
    ]);
    assert.equal(imported.ok, true, imported.ok ? '' : imported.reason);
    const lead = await openLog(rig, rig.lead);
    const developer = await openLog(rig, rig.dev);
    const developerId = developer.memberId as string;
    const leadId = lead.memberId as string;
    assert.equal(developer.log.state().members.get(developerId)?.role, 'developer');
    assert.equal(lead.log.state().members.get(leadId)?.role, 'lead');

    // The lead, on clone c, puts the developer on plan:90-02; one sync on the developer's computer (clone b) shows who did it.
    const assigned = await lead.log.append(() => [assignIntent('plan:90-02', developerId)]);
    assert.equal(assigned.ok, true, assigned.ok ? '' : assigned.reason);
    assert.deepEqual(stored(lead.log.state(), 'plan:90-02'), { assignee: developerId, assignedBy: leadId });
    const synced = await developer.log.sync();
    assert.deepEqual(synced.rejected, []);
    assert.deepEqual(stored(developer.log.state(), 'plan:90-02'), { assignee: developerId, assignedBy: leadId });

    // The developer's own client refuses to take them off a card the lead gave them, before anything is written.
    const remoteHead = lead.log.state().head;
    const refused = await developer.log.append(() => [unassignIntent('plan:90-02')]);
    assert.equal(refused.ok, false, 'the developer may not leave a card the lead assigned');
    assert.equal(refused.ok ? '' : refused.reason, DEVELOPER_MAY_NOT);
    await lead.log.sync();
    assert.deepEqual(lead.log.state().head, remoteHead, 'nothing reached the remote');

    // The same event, validly signed by the developer's device and pushed straight to the coordination branch, is rejected by both clones.
    const before = withoutRejections(lead.log.state());
    const position = { teamId, lamport: remoteHead.lamport + 1, prev: remoteHead.eventId };
    const forged = signed(actorOf(developer, rig.dev.secrets), { ...position, type: 'item.unassigned' as never, body: { id: 'plan:90-02' } as never });
    rawPush(rootOf(rig, 'b'), forged, 'raw: a developer leaves the card the lead gave them');
    const syncedLead = await lead.log.sync();
    const syncedDeveloper = await developer.log.sync();
    for (const result of [syncedLead, syncedDeveloper]) {
      assert.deepEqual(result.accepted, []);
      assert.deepEqual(result.rejected.map((rejection) => rejection.eventId), [forged.id]);
      assert.equal(result.rejected[0]?.reason, DEVELOPER_MAY_NOT);
    }
    assert.equal(withoutRejections(lead.log.state()), before, 'nothing changed on the lead clone');
    assert.equal(withoutRejections(developer.log.state()), before, 'nothing changed on the developer clone either');
    for (const opened of [lead, developer]) assert.deepEqual(stored(opened.log.state(), 'plan:90-02'), { assignee: developerId, assignedBy: leadId }, 'the card keeps the developer');

    // A card the developer took themselves they can still leave, and both clones agree.
    const took = await developer.log.append(() => [assignIntent('plan:90-03', developerId)]);
    assert.equal(took.ok, true, took.ok ? '' : took.reason);
    assert.deepEqual(stored(developer.log.state(), 'plan:90-03'), { assignee: developerId, assignedBy: developerId });
    const left = await developer.log.append(() => [unassignIntent('plan:90-03')]);
    assert.equal(left.ok, true, left.ok ? '' : left.reason);
    assert.deepEqual(stored(developer.log.state(), 'plan:90-03'), {});
    const leadSees = await lead.log.sync();
    assert.deepEqual(leadSees.rejected, []);
    assert.equal(leadSees.accepted.length, 2);
    assert.deepEqual(stored(lead.log.state(), 'plan:90-03'), {});

    // The lead still takes the developer off the card the lead gave them; assignee and assigner go together.
    const cleared = await lead.log.append(() => [unassignIntent('plan:90-02')]);
    assert.equal(cleared.ok, true, cleared.ok ? '' : cleared.reason);
    const developerSees = await developer.log.sync();
    assert.deepEqual(developerSees.rejected, []);
    for (const opened of [lead, developer]) assert.deepEqual(stored(opened.log.state(), 'plan:90-02'), {});
    assert.equal(withoutRejections(lead.log.state()), withoutRejections(developer.log.state()), 'both clones agree');
  });
});

// ---- In memory: the case table, on the writer's check and on the reader's path ---------------------------------------------------------------
// boardWorld is an owner who really signs plus a lead (Lee), a developer (Dana), a reviewer (Rae) and an observer (Obi); seedStandardBoard adds
// milestone:v0.9.0, phase:90 with plan:90-01 and plan:90-02, the planless phase:91 and the developer's board chore.

type AssignType = 'item.assigned' | 'item.unassigned';
type AssignBody = ItemAssignedBody | ItemUnassignedBody;

// What the person's own client says before anything is written: the permission check in prepareEvents, then the transport's replay of the
// candidate through the materialiser (checkCandidate). Undefined means the event would be written.
function writerSays(world: BoardWorld, actor: TestActor, type: AssignType, body: AssignBody): string | undefined {
  const prepared = prepareEvents(world.state, world.state.head, { identity: actor.identity, memberId: actor.memberId }, [{ type, body } as EventIntent], () => new Date('2026-03-02T00:00:00.000Z'));
  if (!Array.isArray(prepared)) return prepared.conflict;
  return checkCandidate(world.state, prepared)?.reason;
}

function readerSays(entry: CommittedEvent): string | undefined {
  const verdict = entry.verdict;
  assert.ok(verdict !== undefined, 'the entry was applied');
  return verdict.accepted ? undefined : verdict.rejection.reason;
}

// Asks the writer first, then signs the same event and applies it on the reader's path; both must give the same answer.
function attempt(world: BoardWorld, actor: TestActor, type: AssignType, body: AssignBody, expected: string | undefined, name: string): void {
  assert.equal(writerSays(world, actor, type, body), expected, `${name} (writer)`);
  assert.equal(readerSays(world.send(actor, type, body as never)), expected, `${name} (reader)`);
}

async function seededWorld(): Promise<BoardWorld> {
  const world = await boardWorld();
  seedStandardBoard(world);
  return world;
}

test('a lead\'s assignment replacing a self-assignment makes the lead the assigner, and the developer can no longer leave the card', async () => {
  const world = await seededWorld();
  const { lead, dev, reviewer } = world;
  attempt(world, dev, 'item.assigned', { id: 'plan:90-02', memberId: dev.memberId }, undefined, 'Dana takes the free plan');
  assert.deepEqual(stored(world.state, 'plan:90-02'), { assignee: dev.memberId, assignedBy: dev.memberId });
  attempt(world, lead, 'item.assigned', { id: 'plan:90-02', memberId: reviewer.memberId }, undefined, 'Lee gives Dana\'s plan to Rae');
  assert.deepEqual(stored(world.state, 'plan:90-02'), { assignee: reviewer.memberId, assignedBy: lead.memberId });
  attempt(world, reviewer, 'item.unassigned', { id: 'plan:90-02' }, REVIEWER_MAY_NOT, 'Rae leaves the plan Lee gave her');
  attempt(world, lead, 'item.assigned', { id: 'plan:90-02', memberId: dev.memberId }, undefined, 'Lee gives the plan back to Dana');
  assert.deepEqual(stored(world.state, 'plan:90-02'), { assignee: dev.memberId, assignedBy: lead.memberId });
  attempt(world, dev, 'item.unassigned', { id: 'plan:90-02' }, DEVELOPER_MAY_NOT, 'Dana leaves the plan Lee gave her');
  assert.deepEqual(stored(world.state, 'plan:90-02'), { assignee: dev.memberId, assignedBy: lead.memberId }, 'the card keeps Dana');
});

test('a reviewer a lead assigned behaves like the developer, and a reviewer who took a card can leave it', async () => {
  const world = await seededWorld();
  const { lead, reviewer } = world;
  attempt(world, lead, 'item.assigned', { id: CHORE_ID, memberId: reviewer.memberId }, undefined, 'Lee assigns Rae the chore');
  attempt(world, reviewer, 'item.unassigned', { id: CHORE_ID }, REVIEWER_MAY_NOT, 'Rae leaves the chore Lee gave her');
  assert.deepEqual(stored(world.state, CHORE_ID), { assignee: reviewer.memberId, assignedBy: lead.memberId });
  attempt(world, reviewer, 'item.assigned', { id: 'phase:91', memberId: reviewer.memberId }, undefined, 'Rae takes the planless phase');
  attempt(world, reviewer, 'item.unassigned', { id: 'phase:91' }, undefined, 'Rae leaves the phase she took');
  assert.deepEqual(stored(world.state, 'phase:91'), {});
});

test('the owner and a lead still take anyone off, whoever assigned the card, and a lead leaves a card the owner gave them', async () => {
  const world = await seededWorld();
  const { owner, lead, dev, reviewer } = world;
  for (const manager of [lead, owner]) {
    attempt(world, dev, 'item.assigned', { id: CHORE_ID, memberId: dev.memberId }, undefined, 'Dana takes her chore');
    attempt(world, manager, 'item.unassigned', { id: CHORE_ID }, undefined, `${manager.memberId} takes Dana off the chore she took`);
    for (const assigner of [lead, owner]) {
      attempt(world, assigner, 'item.assigned', { id: 'plan:90-02', memberId: reviewer.memberId }, undefined, `${assigner.memberId} assigns Rae`);
      attempt(world, manager, 'item.unassigned', { id: 'plan:90-02' }, undefined, `${manager.memberId} takes Rae off`);
      assert.deepEqual(stored(world.state, 'plan:90-02'), {});
    }
  }
  attempt(world, owner, 'item.assigned', { id: 'plan:90-01', memberId: lead.memberId }, undefined, 'the owner assigns Lee');
  attempt(world, lead, 'item.unassigned', { id: 'plan:90-01' }, undefined, 'Lee leaves the card the owner gave him');
  assert.deepEqual(stored(world.state, 'plan:90-01'), {});
});

test('removing the assignee clears the assignee and the assigner; removing the assigner keeps the assigner and the rule', async () => {
  const world = await seededWorld();
  const { owner, lead, dev, reviewer } = world;
  world.accept(lead, 'item.assigned', { id: 'plan:90-01', memberId: reviewer.memberId });
  world.accept(owner, 'member.removed', { memberId: reviewer.memberId });
  const plan = world.state.items.get('plan:90-01');
  assert.ok(plan !== undefined);
  assert.ok(!Object.keys(plan).includes('assignee') && !Object.keys(plan).includes('assignedBy'), 'neither key is left behind');

  world.accept(lead, 'item.assigned', { id: 'plan:90-02', memberId: dev.memberId });
  world.accept(owner, 'member.removed', { memberId: lead.memberId });
  assert.deepEqual(stored(world.state, 'plan:90-02'), { assignee: dev.memberId, assignedBy: lead.memberId }, 'the card still needs a lead');
  attempt(world, dev, 'item.unassigned', { id: 'plan:90-02' }, DEVELOPER_MAY_NOT, 'Dana leaves the card a removed lead gave her');
  // A removed assigner is still on the roster, so the state with it round-trips through a snapshot with the same text and hash.
  const text = serialiseState(world.state);
  const restored = deserialiseState(JSON.parse(text) as JsonObject, world.anchor);
  assert.equal(serialiseState(restored), text);
  assert.equal(stateHash(restored), stateHash(world.state));
  attempt(world, owner, 'item.unassigned', { id: 'plan:90-02' }, undefined, 'the owner takes Dana off');
  assert.deepEqual(stored(world.state, 'plan:90-02'), {});
});

test('a 0.6.3-style log where a developer left a card a lead gave them replays with the unassign rejected and the developer still on the card', async () => {
  const world = await seededWorld();
  const { lead, dev } = world;
  world.accept(lead, 'item.assigned', { id: 'plan:90-01', memberId: dev.memberId });
  // 0.6.3 wrote this event: signed by the developer's device, with no writer check that knows the assigner. Every reader now rejects it.
  const old = world.send(dev, 'item.unassigned', { id: 'plan:90-01' });
  assert.equal(readerSays(old), DEVELOPER_MAY_NOT);
  assert.deepEqual(stored(world.state, 'plan:90-01'), { assignee: dev.memberId, assignedBy: lead.memberId });
});

test('a state with assignees and assigners round-trips with the same hash, and an item without an assignee carries no assigner', async () => {
  const world = await seededWorld();
  const { owner, lead, dev, reviewer } = world;
  const shapeBefore = Object.keys(world.state.items.get('plan:90-02') ?? {}).sort();
  world.accept(lead, 'item.assigned', { id: 'plan:90-01', memberId: dev.memberId });
  world.accept(dev, 'item.assigned', { id: CHORE_ID, memberId: dev.memberId });
  world.accept(owner, 'item.assigned', { id: 'phase:91', memberId: reviewer.memberId });
  world.accept(reviewer, 'item.assigned', { id: 'plan:90-02', memberId: reviewer.memberId });
  world.accept(reviewer, 'item.unassigned', { id: 'plan:90-02' });
  assert.deepEqual(Object.keys(world.state.items.get('plan:90-02') ?? {}).sort(), shapeBefore, 'an unassigned card has exactly the shape it had before');
  const text = serialiseState(world.state);
  assert.ok(!text.includes('"assignedBy":""'), 'an empty assigner is never written');
  const restored = deserialiseState(JSON.parse(text) as JsonObject, world.anchor);
  assert.equal(serialiseState(restored), text);
  assert.equal(stateHash(restored), stateHash(world.state));
  assert.deepEqual(stored(restored, 'plan:90-01'), { assignee: dev.memberId, assignedBy: lead.memberId });
  assert.deepEqual(stored(restored, CHORE_ID), { assignee: dev.memberId, assignedBy: dev.memberId });
  assert.deepEqual(stored(restored, 'phase:91'), { assignee: reviewer.memberId, assignedBy: owner.memberId });
  assert.deepEqual(stored(restored, 'plan:90-02'), {});
});
