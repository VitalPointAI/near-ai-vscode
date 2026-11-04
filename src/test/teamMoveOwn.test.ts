// G-62-5, owner decision 2026-11-04 (62-27): "developers should be able to move cards they have been assigned." Any confirmed member who is not an
// observer and is the card's current assignee (a lead gave it to them or they took it themselves) may mark it done, block and unblock it, hold and
// release it, and reopen it from Done. Cancelling a card, and bringing back a cancelled one, stay with the owner and leads. The owner and leads move
// any card as before. actionForEvent decides this from the state before the event, and both the writer and the reader ask it, so every clone
// agrees. The signed events are unchanged, so no body, hash version or pinned hash moves.
// The first test is the tracer over real git: a lead gives the developer a plan, the developer blocks, unblocks, finishes and reopens it from their
// own clone, and the lead's clone accepts each; the developer's moves on a card that is not theirs, and their cancel, are refused by their own
// client and, forged straight into the remote, rejected by both clones. Reasons are asserted from TEAM_REJECTION_REASONS.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { canonicalize, eventPath } from '../domain/team/canonical';
import { checkCandidate, cloneState, serialiseState } from '../domain/team/materialize';
import { actionForEvent } from '../domain/team/permissions';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { CommittedEvent, ImplementedTeamEvent, TeamEvent, TeamState } from '../domain/team/types';
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
const DEVELOPER_MAY_NOT = `${R.notPermitted}: the developer role does not allow moving items`;
const REVIEWER_MAY_NOT = `${R.notPermitted}: the reviewer role does not allow moving items`;
const OBSERVER_MAY_NOT = `${R.notPermitted}: the observer role does not allow moving items`;

// The move intents, built loosely so this file states the wire shape itself rather than borrowing it from the types under test.
type Move = 'done' | 'hold' | 'release' | 'block' | 'unblock' | 'cancel' | 'reopen';
function moveIntent(id: string, move: Move): EventIntent {
  switch (move) {
    case 'done': return { type: 'item.updated', body: { id, changes: { state: 'done' } } } as unknown as EventIntent;
    case 'hold': return { type: 'item.updated', body: { id, changes: { hold: true } } } as unknown as EventIntent;
    case 'release': return { type: 'item.updated', body: { id, changes: { hold: false } } } as unknown as EventIntent;
    case 'block': return { type: 'item.blocked', body: { id, reason: 'Waiting on the design review' } } as unknown as EventIntent;
    case 'unblock': return { type: 'item.unblocked', body: { id } } as unknown as EventIntent;
    case 'cancel': return { type: 'item.cancelled', body: { id, reason: 'No longer needed' } } as unknown as EventIntent;
    case 'reopen': return { type: 'item.reopened', body: { id } } as unknown as EventIntent;
  }
}
function assignIntent(id: string, memberId: string): EventIntent {
  return { type: 'item.assigned', body: { id, memberId } } as unknown as EventIntent;
}

// Read loosely, so the test states the stored shape rather than borrowing it from the type under test.
function cardState(state: TeamState, itemId: string): { state: string; blocked: boolean; hold: boolean; assignee?: string } {
  const item = state.items.get(itemId) as { state: string; blocked?: unknown; hold?: boolean; assignee?: string } | undefined;
  assert.ok(item !== undefined, `${itemId} is on the board`);
  return { state: item.state, blocked: item.blocked !== undefined, hold: item.hold === true, ...(item.assignee === undefined ? {} : { assignee: item.assignee }) };
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

test('a lead gives the developer a plan, the developer blocks, unblocks, finishes and reopens it on both clones; their moves on other cards and their cancel are refused and rejected', async () => {
  await withTeam(async (rig, teamId) => {
    const owner = await openLog(rig, 'owner');
    // Three Ready plans: one for the developer, one for the lead, one for nobody.
    const imported = await owner.log.append(() => [
      { type: 'item.imported', body: { ...common, id: 'milestone:v0.9.0', kind: 'milestone', title: 'Version 0.9.0' } },
      { type: 'item.imported', body: { ...common, id: 'phase:90', kind: 'phase', title: 'Alpha work', parentId: 'milestone:v0.9.0' } },
      { type: 'item.imported', body: { ...common, id: 'plan:90-01', kind: 'plan', title: 'Alpha slice', parentId: 'phase:90', scope: ['src/a/**'], estimate: { tokens: 1000 } } },
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

    // The lead gives plan:90-01 to the developer and keeps plan:90-02; plan:90-03 stays with nobody.
    const assigned = await lead.log.append(() => [assignIntent('plan:90-01', developerId), assignIntent('plan:90-02', leadId)]);
    assert.equal(assigned.ok, true, assigned.ok ? '' : assigned.reason);
    assert.deepEqual((await developer.log.sync()).rejected, []);

    // The developer blocks, unblocks and finishes their card from their own clone; each lands, and one sync shows the same card on the lead's.
    for (const move of ['block', 'unblock', 'done'] as const) {
      const moved = await developer.log.append(() => [moveIntent('plan:90-01', move)]);
      assert.equal(moved.ok, true, `${move}: ${moved.ok ? '' : moved.reason}`);
    }
    assert.deepEqual(cardState(developer.log.state(), 'plan:90-01'), { state: 'done', blocked: false, hold: false, assignee: developerId });
    const leadSees = await lead.log.sync();
    assert.deepEqual(leadSees.rejected, []);
    assert.equal(leadSees.accepted.length, 3);
    assert.deepEqual(cardState(lead.log.state(), 'plan:90-01'), { state: 'done', blocked: false, hold: false, assignee: developerId });

    // The developer reopens their finished card.
    const reopened = await developer.log.append(() => [moveIntent('plan:90-01', 'reopen')]);
    assert.equal(reopened.ok, true, reopened.ok ? '' : reopened.reason);
    assert.deepEqual((await lead.log.sync()).rejected, []);
    assert.deepEqual(cardState(lead.log.state(), 'plan:90-01'), { state: 'backlog', blocked: false, hold: false, assignee: developerId });

    // The developer's own client refuses a block of the lead's card, a mark-done of the free card and a cancel of their own card.
    let remoteHead = lead.log.state().head;
    const refusedMoves: Array<[string, Move]> = [['plan:90-02', 'block'], ['plan:90-03', 'done'], ['plan:90-01', 'cancel']];
    for (const [id, move] of refusedMoves) {
      const refused = await developer.log.append(() => [moveIntent(id, move)]);
      assert.equal(refused.ok, false, `the developer may not ${move} ${id}`);
      assert.equal(refused.ok ? '' : refused.reason, DEVELOPER_MAY_NOT, `${move} ${id}`);
    }
    await lead.log.sync();
    assert.deepEqual(lead.log.state().head, remoteHead, 'nothing reached the remote');

    // The same three events, validly signed by the developer's device and pushed straight to the coordination branch, are rejected by both clones.
    const before = withoutRejections(lead.log.state());
    const forgedIds: string[] = [];
    for (const [id, move] of refusedMoves) {
      const intent = moveIntent(id, move) as unknown as { type: never; body: never };
      const forged = signed(actorOf(developer, rig.dev.secrets), { teamId, lamport: remoteHead.lamport + 1, prev: remoteHead.eventId, type: intent.type, body: intent.body });
      rawPush(rootOf(rig, 'b'), forged, `raw: a developer tries to ${move} ${id}`);
      forgedIds.push(forged.id);
      remoteHead = { lamport: remoteHead.lamport + 1, eventId: forged.id } as typeof remoteHead;
    }
    for (const opened of [lead, developer]) {
      const result = await opened.log.sync();
      assert.deepEqual(result.accepted, []);
      assert.deepEqual(result.rejected.map((rejection) => rejection.eventId), forgedIds);
      for (const rejection of result.rejected) assert.equal(rejection.reason, DEVELOPER_MAY_NOT);
      assert.equal(withoutRejections(opened.log.state()), before, 'nothing changed');
    }

    // The lead cancels the developer's card; the developer cannot bring it back, on write or by forging; the lead can.
    const cancelled = await lead.log.append(() => [moveIntent('plan:90-01', 'cancel')]);
    assert.equal(cancelled.ok, true, cancelled.ok ? '' : cancelled.reason);
    assert.deepEqual((await developer.log.sync()).rejected, []);
    const refusedReopen = await developer.log.append(() => [moveIntent('plan:90-01', 'reopen')]);
    assert.equal(refusedReopen.ok ? '' : refusedReopen.reason, DEVELOPER_MAY_NOT, 'the developer may not reopen a cancelled card');
    const head = lead.log.state().head;
    const beforeReopen = withoutRejections(lead.log.state());
    const forgedReopen = signed(actorOf(developer, rig.dev.secrets), { teamId, lamport: head.lamport + 1, prev: head.eventId, type: 'item.reopened' as never, body: { id: 'plan:90-01' } as never });
    rawPush(rootOf(rig, 'b'), forgedReopen, 'raw: a developer brings back a cancelled card');
    for (const opened of [lead, developer]) {
      const result = await opened.log.sync();
      assert.deepEqual(result.rejected.map((rejection) => rejection.eventId), [forgedReopen.id]);
      assert.equal(result.rejected[0]?.reason, DEVELOPER_MAY_NOT);
      assert.equal(withoutRejections(opened.log.state()), beforeReopen, 'the card stays cancelled');
    }
    const leadReopens = await lead.log.append(() => [moveIntent('plan:90-01', 'reopen')]);
    assert.equal(leadReopens.ok, true, leadReopens.ok ? '' : leadReopens.reason);
    assert.deepEqual((await developer.log.sync()).rejected, []);
    assert.equal(withoutRejections(lead.log.state()), withoutRejections(developer.log.state()), 'both clones agree');
    assert.deepEqual(cardState(developer.log.state(), 'plan:90-01'), { state: 'backlog', blocked: false, hold: false, assignee: developerId });
  });
});

// ---- In memory: the case table, on the writer's check and on the reader's path ---------------------------------------------------------------
// boardWorld is an owner who really signs plus a lead (Lee), a developer (Dana), a reviewer (Rae) and an observer (Obi); seedStandardBoard adds
// milestone:v0.9.0, phase:90 with the Ready plan:90-01 and plan:90-02 (waiting on it), the planless phase:91 and the developer's board chore.

// What the person's own client says before anything is written: the permission check in prepareEvents, then the transport's replay of the
// candidate through the materialiser (checkCandidate). Undefined means the event would be written.
function writerSays(world: BoardWorld, actor: TestActor, intent: EventIntent): string | undefined {
  const prepared = prepareEvents(world.state, world.state.head, { identity: actor.identity, memberId: actor.memberId }, [intent], () => new Date('2026-03-02T00:00:00.000Z'));
  if (!Array.isArray(prepared)) return prepared.conflict;
  return checkCandidate(world.state, prepared)?.reason;
}

function readerSays(entry: CommittedEvent): string | undefined {
  const verdict = entry.verdict;
  assert.ok(verdict !== undefined, 'the entry was applied');
  return verdict.accepted ? undefined : verdict.rejection.reason;
}

// Asks the writer first, then signs the same event and applies it on the reader's path; both must give the same answer.
function attempt(world: BoardWorld, actor: TestActor, id: string, move: Move, expected: string | undefined, name: string): void {
  const intent = moveIntent(id, move) as unknown as { type: 'item.blocked'; body: never };
  assert.equal(writerSays(world, actor, intent as unknown as EventIntent), expected, `${name} (writer)`);
  assert.equal(readerSays(world.send(actor, intent.type, intent.body)), expected, `${name} (reader)`);
}

async function seededWorld(): Promise<BoardWorld> {
  const world = await boardWorld();
  seedStandardBoard(world);
  return world;
}

test('a developer a lead assigned holds and releases, blocks and unblocks, finishes and reopens their card, but cannot cancel it', async () => {
  const world = await seededWorld();
  const { lead, dev } = world;
  world.accept(lead, 'item.assigned', { id: 'plan:90-01', memberId: dev.memberId });
  attempt(world, dev, 'plan:90-01', 'hold', undefined, 'Dana holds her plan');
  attempt(world, dev, 'plan:90-01', 'release', undefined, 'Dana releases it');
  attempt(world, dev, 'plan:90-01', 'block', undefined, 'Dana blocks it');
  attempt(world, dev, 'plan:90-01', 'unblock', undefined, 'Dana unblocks it');
  attempt(world, dev, 'plan:90-01', 'cancel', DEVELOPER_MAY_NOT, 'Dana cancels it');
  attempt(world, dev, 'plan:90-01', 'done', undefined, 'Dana marks it done');
  attempt(world, dev, 'plan:90-01', 'reopen', undefined, 'Dana reopens it from Done');
  assert.deepEqual(cardState(world.state, 'plan:90-01'), { state: 'backlog', blocked: false, hold: false, assignee: dev.memberId });
});

test('a card the developer took themselves moves the same way as one a lead gave them', async () => {
  const world = await seededWorld();
  const { dev } = world;
  world.accept(dev, 'item.assigned', { id: CHORE_ID, memberId: dev.memberId });
  world.accept(dev, 'item.assigned', { id: 'plan:90-01', memberId: dev.memberId });
  attempt(world, dev, CHORE_ID, 'block', undefined, 'Dana blocks the chore she took');
  attempt(world, dev, CHORE_ID, 'unblock', undefined, 'Dana unblocks it');
  attempt(world, dev, CHORE_ID, 'cancel', DEVELOPER_MAY_NOT, 'Dana cancels it');
  attempt(world, dev, 'plan:90-01', 'hold', undefined, 'Dana holds the plan she took');
  attempt(world, dev, 'plan:90-01', 'release', undefined, 'Dana releases it');
  attempt(world, dev, 'plan:90-01', 'done', undefined, 'Dana marks it done');
  attempt(world, dev, 'plan:90-01', 'reopen', undefined, 'Dana reopens it');
});

test('a developer cannot move a teammate\'s card or a free card, and cannot bring back a cancelled card of their own', async () => {
  const world = await seededWorld();
  const { lead, dev, reviewer } = world;
  world.accept(lead, 'item.assigned', { id: CHORE_ID, memberId: reviewer.memberId });
  attempt(world, dev, CHORE_ID, 'block', DEVELOPER_MAY_NOT, 'Dana blocks Rae\'s chore');
  attempt(world, dev, 'plan:90-01', 'hold', DEVELOPER_MAY_NOT, 'Dana holds the free plan');
  attempt(world, dev, 'plan:90-01', 'done', DEVELOPER_MAY_NOT, 'Dana marks the free plan done');
  world.accept(lead, 'item.assigned', { id: 'plan:90-01', memberId: dev.memberId });
  world.accept(lead, 'item.cancelled', { id: 'plan:90-01', reason: 'Not needed' });
  attempt(world, dev, 'plan:90-01', 'reopen', DEVELOPER_MAY_NOT, 'Dana brings back her cancelled plan');
  attempt(world, lead, 'plan:90-01', 'reopen', undefined, 'Lee brings it back');
});

test('a reviewer assignee moves her card like a developer; an observer is never an assignee and never moves a card', async () => {
  const world = await seededWorld();
  const { lead, reviewer, observer } = world;
  world.accept(lead, 'item.assigned', { id: CHORE_ID, memberId: reviewer.memberId });
  attempt(world, reviewer, CHORE_ID, 'block', undefined, 'Rae blocks her chore');
  attempt(world, reviewer, CHORE_ID, 'unblock', undefined, 'Rae unblocks it');
  attempt(world, reviewer, CHORE_ID, 'cancel', REVIEWER_MAY_NOT, 'Rae cancels it');
  attempt(world, reviewer, 'plan:90-01', 'block', REVIEWER_MAY_NOT, 'Rae blocks the free plan');
  assert.equal(readerSays(world.send(lead, 'item.assigned', { id: 'plan:90-01', memberId: observer.memberId })), R.assigneeNotEligible, 'nobody can put Obi on a card');
  attempt(world, observer, 'plan:90-01', 'block', OBSERVER_MAY_NOT, 'Obi blocks the free plan');
  attempt(world, observer, CHORE_ID, 'block', OBSERVER_MAY_NOT, 'Obi blocks Rae\'s chore');
});

test('the owner and a lead still move any card, assigned or not, including cancel and reopen', async () => {
  const world = await seededWorld();
  const { owner, lead, dev } = world;
  world.accept(lead, 'item.assigned', { id: 'plan:90-01', memberId: dev.memberId });
  for (const manager of [lead, owner]) {
    attempt(world, manager, 'plan:90-01', 'block', undefined, `${manager.memberId} blocks Dana's plan`);
    attempt(world, manager, 'plan:90-01', 'unblock', undefined, `${manager.memberId} unblocks it`);
    attempt(world, manager, 'plan:90-01', 'hold', undefined, `${manager.memberId} holds it`);
    attempt(world, manager, 'plan:90-01', 'release', undefined, `${manager.memberId} releases it`);
    attempt(world, manager, CHORE_ID, 'cancel', undefined, `${manager.memberId} cancels the free chore`);
    attempt(world, manager, CHORE_ID, 'reopen', undefined, `${manager.memberId} brings it back`);
    attempt(world, manager, 'plan:90-01', 'done', undefined, `${manager.memberId} marks Dana's plan done`);
    attempt(world, manager, 'plan:90-01', 'reopen', undefined, `${manager.memberId} reopens it`);
  }
});

test('actionForEvent answers item.move for every move event without a state, and for a cancel even by the assignee', async () => {
  const world = await seededWorld();
  const { lead, dev } = world;
  world.accept(lead, 'item.assigned', { id: 'plan:90-01', memberId: dev.memberId });
  const probe = (move: Move): ImplementedTeamEvent => {
    const intent = moveIntent('plan:90-01', move) as unknown as { type: string; body: unknown };
    return { v: 1, id: 'evt-probe', teamId: world.teamId, type: intent.type, lamport: 0, at: '', author: dev.memberId, device: '', prev: '', body: intent.body, sig: '' } as unknown as ImplementedTeamEvent;
  };
  for (const move of ['done', 'hold', 'release', 'block', 'unblock', 'cancel', 'reopen'] as const) {
    assert.deepEqual(actionForEvent(probe(move)), { kind: 'item.move' }, `${move} without a state`);
  }
  for (const move of ['done', 'hold', 'release', 'block', 'unblock'] as const) {
    assert.deepEqual(actionForEvent(probe(move), world.state), { kind: 'item.move-own' }, `${move} by the assignee`);
  }
  assert.deepEqual(actionForEvent(probe('cancel'), world.state), { kind: 'item.move' }, 'cancel by the assignee');
  // A reopen counts as the assignee's own only from Done: the card above is in Ready, so the stricter answer stands.
  assert.deepEqual(actionForEvent(probe('reopen'), world.state), { kind: 'item.move' }, 'reopen of a card that is not done');
});
