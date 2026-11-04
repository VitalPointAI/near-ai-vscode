// Work items in the signed log (D-04, D-10 to D-14): the two-clone tracer over real git, the write and read agreement on permissions,
// body validation and the Phase 60 hash parity. The move and permission tables and the frozen pins follow in the same file: every row is
// run through the reader (applyEntry) and through the writer (prepareEvents, then the transport's checkCandidate replay), and the two must agree.
// Reasons are asserted from TEAM_REJECTION_REASONS or by their fixed prefix, never by loosening a comparison.
import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import { canonicalize } from '../domain/team/canonical';
import { applyEntry, checkCandidate, cloneState, deserialiseState, reduce, serialiseState, stateHash, teamMaterializer } from '../domain/team/materialize';
import { defaultTeamPolicy } from '../domain/team/policy';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { Claim, GenesisAnchor, JsonObject, TeamEvent, TeamFile, TeamState, WorkItem } from '../domain/team/types';
import { validateBody } from '../domain/team/validate';
import { TeamLog, buildGenesisEvents, prepareEvents } from '../team/eventLog';
import type { EventIntent, TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { emailHash, newTeamId, ulid } from '../team/identity';
import { canonicalTeamFile } from '../team/teamFile';
import { createOwner, createTeamFixture } from './helpers/teamHarness';
import type { TeamFixture, TestOwner } from './helpers/teamHarness';
import { addFixtureMember, entryOf, genesisEntries, makeActor, signed } from './helpers/teamEvents';
import type { TestActor } from './helpers/teamEvents';
import { phase60Fixture } from './helpers/teamPhase60Fixture';

const R = TEAM_REJECTION_REASONS;
const INVALID = R.invalidBody;

// A clock that moves one second per call, so a stateSince that follows the wrong event shows up as a different time.
function tickingClock(): () => Date {
  let seconds = 0;
  return () => {
    seconds += 1;
    return new Date(Date.UTC(2026, 1, 3, 4, 5, seconds));
  };
}

interface Client { transport: GitTransport<TeamState>; log: TeamLog }

function clientFor(fixture: TeamFixture, name: string, anchor: GenesisAnchor, now: () => Date, signer?: TeamSigner): Client {
  const transport = new GitTransport<TeamState>({
    mirrorDir: path.join(fixture.storageDir(name), 'coordination.git'),
    projectRoot: fixture.clones[name] as string,
    remote: 'origin',
    ref: DEFAULT_COORDINATION_REF,
    materializer: teamMaterializer(anchor),
    baseDelayMs: 1
  });
  return { transport, log: new TeamLog({ anchor, transport, now, ...(signer === undefined ? {} : { signer }) }) };
}

async function withFixture(names: string[], run: (fixture: TeamFixture) => Promise<void>): Promise<void> {
  const fixture = await createTeamFixture({ clones: names });
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
}

async function seedTeam(fixture: TeamFixture, now: () => Date): Promise<{ owner: TestOwner; signer: TeamSigner; anchor: GenesisAnchor; a: Client }> {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const genesis = buildGenesisEvents({
    teamId, teamName: 'Work team', owner: { memberId: owner.memberId, name: 'Owner Test', emailHashes: [emailHash(teamId, 'owner@example.invalid')] },
    identity: owner.identity, policy: defaultTeamPolicy(), now
  });
  const teamFile: TeamFile = {
    version: 1, teamId, name: 'Work team', coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote: 'origin' },
    genesis: { eventId: genesis.anchor.eventId, ownerDevice: genesis.anchor.ownerDevice }, createdAt: '2026-02-03T04:05:06.000Z'
  };
  const signer: TeamSigner = { identity: owner.identity, memberId: owner.memberId };
  const a = clientFor(fixture, 'a', genesis.anchor, now, signer);
  const written = await a.transport.append(async () => genesis.events, { genesis: { teamFileText: canonicalTeamFile(teamFile) } });
  assert.equal(written.ok, true);
  return { owner, signer, anchor: genesis.anchor, a };
}

test('the owner creates and blocks a board item on clone A over real git and clone B materialises exactly the same item', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture, tickingClock());
    const itemId = `item:${ulid()}`;
    const created = await seed.a.log.append(() => [{
      type: 'item.created',
      body: { id: itemId, kind: 'chore', title: 'Wire the billing webhook', scope: ['src/services/**'], requirements: [], mustHaves: [], estimate: { tokens: 48000 } }
    }]);
    assert.equal(created.ok, true, created.ok ? '' : created.reason);
    const blocked = await seed.a.log.append(() => [{ type: 'item.blocked', body: { id: itemId, reason: 'waiting for the API key' } }]);
    assert.equal(blocked.ok, true, blocked.ok ? '' : blocked.reason);
    const createdEvent = created.ok ? (created.events[0] as TeamEvent) : undefined;
    const blockedEvent = blocked.ok ? (blocked.events[0] as TeamEvent) : undefined;

    const b = clientFor(fixture, 'b', seed.anchor, tickingClock());
    const synced = await b.log.sync();
    assert.deepEqual(synced.rejected, []);
    assert.equal(synced.status.state, 'ok');
    for (const state of [seed.a.log.state(), b.log.state()]) {
      assert.equal(state.items.size, 1);
      const item = state.items.get(itemId);
      assert.equal(item?.origin, 'board');
      assert.equal(item?.kind, 'chore');
      assert.equal(item?.createdBy, seed.owner.memberId);
      assert.equal(item?.state, 'backlog');
      assert.deepEqual(item?.estimate, { tokens: 48000 });
      assert.deepEqual(item?.scope, ['src/services/**']);
      assert.deepEqual(item?.blocked, { reason: 'waiting for the API key', by: seed.owner.memberId, since: blockedEvent?.at });
      assert.equal(item?.stateSince, createdEvent?.at, 'blocking does not move stateSince');
      assert.notEqual(createdEvent?.at, blockedEvent?.at, 'the two events carry different times');
    }
    assert.equal(serialiseState(b.log.state()), serialiseState(seed.a.log.state()));
    assert.deepEqual(b.log.state().rejected, []);
  });
});

async function stateWithRoles(): Promise<{ state: TeamState; owner: Awaited<ReturnType<typeof makeActor>>; developer: Awaited<ReturnType<typeof makeActor>>; teamId: string; itemId: string }> {
  const teamId = newTeamId();
  const owner = await makeActor(teamId);
  const developer = await makeActor(teamId);
  const { entries, anchor } = genesisEntries(owner, teamId);
  const state = reduce(entries, anchor);
  addFixtureMember(state, developer, 'developer', 'Developer');
  const itemId = `item:${ulid()}`;
  const created = signed(owner, {
    teamId, type: 'item.created', lamport: state.highLamport + 1, prev: state.head.eventId,
    body: { id: itemId, kind: 'bug', title: 'Fix the login redirect', scope: [], requirements: [], mustHaves: [] }
  });
  assert.equal(applyEntry(state, entryOf(created)).accepted, true);
  return { state, owner, developer, teamId, itemId };
}

test('a developer item.blocked is rejected on read as not permitted and prepareEvents returns the same text', async () => {
  const { state, developer, teamId, itemId } = await stateWithRoles();
  const blocked = signed(developer, {
    teamId, type: 'item.blocked', lamport: state.highLamport + 1, prev: state.head.eventId, body: { id: itemId, reason: 'not mine to block' }
  });
  const verdict = applyEntry(state, entryOf(blocked));
  assert.equal(verdict.accepted, false);
  const readReason = verdict.accepted ? '' : verdict.rejection.reason;
  assert.ok(readReason.startsWith(`${R.notPermitted}: `), readReason);

  const prepared = prepareEvents(state, state.head, { identity: developer.identity, memberId: developer.memberId }, [
    { type: 'item.blocked', body: { id: itemId, reason: 'not mine to block' } }
  ], () => new Date('2026-02-03T04:05:06.000Z'));
  assert.deepEqual(prepared, { conflict: readReason });
});

test('body validation: an extra key names the key, and an id whose prefix does not match the kind is invalid', () => {
  const body = { id: `item:${ulid()}`, kind: 'chore', title: 'Tidy the config', scope: [], requirements: [], mustHaves: [] };
  assert.equal(validateBody('item.created', body), undefined);
  assert.equal(validateBody('item.created', { ...body, surprise: 1 }), `${INVALID}: body.surprise`);
  assert.equal(validateBody('item.created', { ...body, id: 'plan:90-01' }), `${INVALID}: body.id`);
  assert.equal(validateBody('item.created', { ...body, kind: 'plan' }), `${INVALID}: body.kind`);
});

test('a log with no item events keeps the Phase 60 serialised state and state hash', async () => {
  const { entries, anchor } = await phase60Fixture();
  const state = reduce(entries, anchor);
  assert.equal(state.items.size, 0);
  // Taken from the Phase 60 code over the deterministic log in helpers/teamPhase60Fixture.ts (also pinned in teamKeySealedEvent.test.ts).
  assert.equal(stateHash(state), 'e41fe7cbcc4fc089a0f07a373835e3388a20d76e6fe235cc0121204863e14408');
  const text = serialiseState(state);
  assert.ok(text.includes('"items":[]'));
  assert.equal(serialiseState(deserialiseState(JSON.parse(text) as JsonObject, anchor)), text);
});

// ---- The move and permission tables (D-11 to D-14) --------------------------------------------------------------------------------

const NOW = (): Date => new Date('2026-03-04T05:06:07.000Z');
const MILESTONE = 'milestone:v1.0';
const PHASE = 'phase:1';
const PLAN = 'plan:1-01';
const TASK = 'task:1-01-1';
const NEW_PLAN = 'plan:1-02';
const BOARD = 'item:01ARZ3NDEKTSV4RRFFQ69G5FAV';
const NEW_BOARD = 'item:01ARZ3NDEKTSV4RRFFQ69G5FAW';
const ROLE_ORDER = ['owner', 'lead', 'developer', 'other', 'reviewer', 'observer'] as const;
type RoleName = typeof ROLE_ORDER[number];

interface Cast extends Record<RoleName, TestActor> { teamId: string; claimant: TestActor; seed: TeamState }

function signFor(state: TeamState, actor: TestActor, intent: EventIntent): TeamEvent {
  return signed(actor, { teamId: state.team.id, type: intent.type, body: intent.body, lamport: state.highLamport + 1, prev: state.head.eventId });
}

function accept(state: TeamState, actor: TestActor, intent: EventIntent): void {
  const verdict = applyEntry(state, entryOf(signFor(state, actor, intent)));
  assert.equal(verdict.accepted, true, `${intent.type} setup was rejected: ${verdict.accepted ? '' : verdict.rejection.reason}`);
}

// Genesis, the five roles as fixture members, then an imported milestone, phase, plan and task and a board item the developer created.
let castPromise: Promise<Cast> | undefined;
function theCast(): Promise<Cast> {
  castPromise ??= (async (): Promise<Cast> => {
    const teamId = newTeamId();
    const [owner, lead, developer, other, reviewer, observer, claimant] = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => makeActor(teamId))) as [TestActor, TestActor, TestActor, TestActor, TestActor, TestActor, TestActor];
    const { entries, anchor } = genesisEntries(owner, teamId);
    const seed = reduce(entries, anchor);
    addFixtureMember(seed, lead, 'lead', 'Lead');
    addFixtureMember(seed, developer, 'developer', 'Developer');
    addFixtureMember(seed, other, 'developer', 'Other developer');
    addFixtureMember(seed, reviewer, 'reviewer', 'Reviewer');
    addFixtureMember(seed, observer, 'observer', 'Observer');
    const imported = (id: string, kind: 'milestone' | 'phase' | 'plan' | 'task', parentId?: string): EventIntent => ({
      type: 'item.imported',
      body: { id, kind, title: `Item ${id}`, state: 'backlog', dependsOn: [], scope: ['src/**'], requirements: [], mustHaves: [], tags: [], ...(parentId === undefined ? {} : { parentId }) }
    });
    accept(seed, owner, imported(MILESTONE, 'milestone'));
    accept(seed, owner, imported(PHASE, 'phase', MILESTONE));
    accept(seed, owner, imported(PLAN, 'plan', PHASE));
    accept(seed, owner, imported(TASK, 'task', PLAN));
    accept(seed, developer, { type: 'item.created', body: { id: BOARD, kind: 'bug', title: 'Fix the login redirect', scope: ['src/auth/**'], requirements: [], mustHaves: [] } });
    return { teamId, owner, lead, developer, other, reviewer, observer, claimant, seed };
  })();
  return castPromise;
}

type Prior = 'backlog' | 'ready' | 'done' | 'cancelled' | 'blocked' | 'held' | 'claimed';

function claimRecord(itemId: string, memberId: string): Claim {
  return {
    id: 'clm-1', itemId, memberId, branch: 'near-ai/branch', base: 'main', leaseIds: [], startedAt: '2026-01-01T00:00:00.000Z', lastHeartbeatAt: '2026-01-01T00:00:00.000Z', status: 'active',
    spend: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, confirmedNanoUsd: 0, pendingNanoUsd: 0, estimatedNanoUsd: 0, requests: 0 }
  };
}

// The prior stored state of one item, reached by signed events wherever an event can reach it. ready has no event (it is computed), so it is
// reached the one way Phase 61 stores it: the claimant holding the item is removed and the release returns the item to ready.
function priorState(c: Cast, itemId: string, prior: Prior): TeamState {
  const state = cloneState(c.seed);
  const item = state.items.get(itemId) as WorkItem;
  switch (prior) {
    case 'backlog': break;
    case 'ready':
    case 'claimed':
      addFixtureMember(state, c.claimant, 'developer', 'Claimant');
      item.state = 'claimed';
      item.claimId = 'clm-1';
      state.claims.set('clm-1', claimRecord(itemId, c.claimant.memberId));
      if (prior === 'ready') {
        accept(state, c.owner, { type: 'member.removed', body: { memberId: c.claimant.memberId } });
        assert.equal(state.items.get(itemId)?.state, 'ready');
      }
      break;
    case 'done': accept(state, c.owner, { type: 'item.updated', body: { id: itemId, changes: { state: 'done' } } }); break;
    case 'cancelled': accept(state, c.owner, { type: 'item.cancelled', body: { id: itemId, reason: 'dropped' } }); break;
    case 'blocked': accept(state, c.owner, { type: 'item.blocked', body: { id: itemId, reason: 'waiting' } }); break;
    case 'held': accept(state, c.owner, { type: 'item.updated', body: { id: itemId, changes: { hold: true } } }); break;
  }
  return state;
}

function signerOf(actor: TestActor): TeamSigner {
  return { identity: actor.identity, memberId: actor.memberId };
}

function update(id: string, changes: Extract<EventIntent, { type: 'item.updated' }>['body']['changes']): EventIntent {
  return { type: 'item.updated', body: { id, changes } };
}

interface MoveRow { name: string; target: string; prior: Prior; intent: EventIntent; expect: string | undefined; check?: (item: WorkItem) => void }

const NOT_STORED_CLAIM_STATES = ['claimed', 'in-progress', 'in-review', 'integrating'];
const imports = (id: string, kind: 'milestone' | 'phase' | 'plan' | 'task', parentId?: string): EventIntent => ({
  type: 'item.imported',
  body: { id, kind, title: 'New item', state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [], ...(parentId === undefined ? {} : { parentId }) }
});

// The owner is the author in every row, so permission never decides these; the stored state does. expect undefined means accepted.
const moves: MoveRow[] = [
  // mark done
  { name: 'mark done from backlog', target: PLAN, prior: 'backlog', intent: update(PLAN, { state: 'done' }), expect: undefined, check: (item) => { assert.equal(item.state, 'done'); } },
  { name: 'mark done from stored ready', target: PLAN, prior: 'ready', intent: update(PLAN, { state: 'done' }), expect: undefined, check: (item) => { assert.equal(item.state, 'done'); assert.equal(item.claimId, undefined); } },
  { name: 'mark done of a held plan also ends the hold', target: PLAN, prior: 'held', intent: update(PLAN, { state: 'done' }), expect: undefined, check: (item) => { assert.equal(item.state, 'done'); assert.equal(item.hold, undefined); } },
  { name: 'mark done of a board item from backlog', target: BOARD, prior: 'backlog', intent: update(BOARD, { state: 'done' }), expect: undefined },
  { name: 'mark done while blocked', target: PLAN, prior: 'blocked', intent: update(PLAN, { state: 'done' }), expect: TEAM_REJECTION_REASONS.itemBlocked },
  { name: 'mark done of a done plan', target: PLAN, prior: 'done', intent: update(PLAN, { state: 'done' }), expect: TEAM_REJECTION_REASONS.itemTerminal },
  { name: 'mark done of a cancelled plan', target: PLAN, prior: 'cancelled', intent: update(PLAN, { state: 'done' }), expect: TEAM_REJECTION_REASONS.itemTerminal },
  { name: 'mark done of a phase', target: PHASE, prior: 'backlog', intent: update(PHASE, { state: 'done' }), expect: TEAM_REJECTION_REASONS.itemState },
  { name: 'mark done of a task', target: TASK, prior: 'backlog', intent: update(TASK, { state: 'done' }), expect: TEAM_REJECTION_REASONS.itemState },
  // hold and release
  { name: 'hold a backlog plan', target: PLAN, prior: 'backlog', intent: update(PLAN, { hold: true }), expect: undefined, check: (item) => { assert.equal(item.hold, true); assert.equal(item.state, 'backlog'); } },
  { name: 'hold a stored ready plan', target: PLAN, prior: 'ready', intent: update(PLAN, { hold: true }), expect: undefined },
  { name: 'hold a blocked plan', target: PLAN, prior: 'blocked', intent: update(PLAN, { hold: true }), expect: undefined },
  { name: 'hold a board item', target: BOARD, prior: 'backlog', intent: update(BOARD, { hold: true }), expect: undefined },
  { name: 'hold a phase freezes it', target: PHASE, prior: 'backlog', intent: update(PHASE, { hold: true }), expect: undefined, check: (item) => { assert.equal(item.hold, true); } },
  { name: 'hold a plan that is already held', target: PLAN, prior: 'held', intent: update(PLAN, { hold: true }), expect: TEAM_REJECTION_REASONS.itemState },
  { name: 'hold a claimed plan', target: PLAN, prior: 'claimed', intent: update(PLAN, { hold: true }), expect: TEAM_REJECTION_REASONS.itemState },
  { name: 'hold a done plan', target: PLAN, prior: 'done', intent: update(PLAN, { hold: true }), expect: TEAM_REJECTION_REASONS.itemTerminal },
  { name: 'hold a cancelled plan', target: PLAN, prior: 'cancelled', intent: update(PLAN, { hold: true }), expect: TEAM_REJECTION_REASONS.itemTerminal },
  { name: 'hold a milestone', target: MILESTONE, prior: 'backlog', intent: update(MILESTONE, { hold: true }), expect: TEAM_REJECTION_REASONS.itemState },
  { name: 'hold a task', target: TASK, prior: 'backlog', intent: update(TASK, { hold: true }), expect: TEAM_REJECTION_REASONS.itemState },
  { name: 'release a held plan', target: PLAN, prior: 'held', intent: update(PLAN, { hold: false }), expect: undefined, check: (item) => { assert.equal(item.hold, undefined, 'a false hold is an absent key'); } },
  { name: 'release a plan that is not held', target: PLAN, prior: 'backlog', intent: update(PLAN, { hold: false }), expect: TEAM_REJECTION_REASONS.itemState },
  // block and unblock
  { name: 'block a backlog plan', target: PLAN, prior: 'backlog', intent: { type: 'item.blocked', body: { id: PLAN, reason: 'waiting' } }, expect: undefined, check: (item) => { assert.equal(item.blocked?.reason, 'waiting'); } },
  { name: 'block a stored ready plan', target: PLAN, prior: 'ready', intent: { type: 'item.blocked', body: { id: PLAN, reason: 'waiting' } }, expect: undefined },
  { name: 'block a held plan', target: PLAN, prior: 'held', intent: { type: 'item.blocked', body: { id: PLAN, reason: 'waiting' } }, expect: undefined },
  { name: 'block a board item', target: BOARD, prior: 'backlog', intent: { type: 'item.blocked', body: { id: BOARD, reason: 'waiting' } }, expect: undefined },
  { name: 'block an already blocked plan', target: PLAN, prior: 'blocked', intent: { type: 'item.blocked', body: { id: PLAN, reason: 'again' } }, expect: TEAM_REJECTION_REASONS.itemBlocked },
  { name: 'block a done plan', target: PLAN, prior: 'done', intent: { type: 'item.blocked', body: { id: PLAN, reason: 'late' } }, expect: TEAM_REJECTION_REASONS.itemTerminal },
  { name: 'block a cancelled plan', target: PLAN, prior: 'cancelled', intent: { type: 'item.blocked', body: { id: PLAN, reason: 'late' } }, expect: TEAM_REJECTION_REASONS.itemTerminal },
  { name: 'block a phase', target: PHASE, prior: 'backlog', intent: { type: 'item.blocked', body: { id: PHASE, reason: 'no' } }, expect: TEAM_REJECTION_REASONS.itemState },
  { name: 'unblock a blocked plan', target: PLAN, prior: 'blocked', intent: { type: 'item.unblocked', body: { id: PLAN } }, expect: undefined, check: (item) => { assert.equal(item.blocked, undefined); } },
  { name: 'unblock a plan that is not blocked', target: PLAN, prior: 'backlog', intent: { type: 'item.unblocked', body: { id: PLAN } }, expect: TEAM_REJECTION_REASONS.itemNotBlocked },
  // cancel and reopen
  { name: 'cancel a backlog plan', target: PLAN, prior: 'backlog', intent: { type: 'item.cancelled', body: { id: PLAN, reason: 'no longer in the roadmap' } }, expect: undefined, check: (item) => { assert.equal(item.state, 'cancelled'); } },
  { name: 'cancel a stored ready plan', target: PLAN, prior: 'ready', intent: { type: 'item.cancelled', body: { id: PLAN, reason: 'dropped' } }, expect: undefined },
  { name: 'cancel a blocked plan clears the block', target: PLAN, prior: 'blocked', intent: { type: 'item.cancelled', body: { id: PLAN, reason: 'dropped' } }, expect: undefined, check: (item) => { assert.equal(item.blocked, undefined); assert.equal(item.state, 'cancelled'); } },
  { name: 'cancel a held plan clears the hold', target: PLAN, prior: 'held', intent: { type: 'item.cancelled', body: { id: PLAN, reason: 'dropped' } }, expect: undefined, check: (item) => { assert.equal(item.hold, undefined); } },
  { name: 'cancel a board item', target: BOARD, prior: 'backlog', intent: { type: 'item.cancelled', body: { id: BOARD, reason: 'dropped' } }, expect: undefined },
  { name: 'cancel a phase', target: PHASE, prior: 'backlog', intent: { type: 'item.cancelled', body: { id: PHASE, reason: 'dropped' } }, expect: undefined },
  { name: 'cancel a done plan', target: PLAN, prior: 'done', intent: { type: 'item.cancelled', body: { id: PLAN, reason: 'late' } }, expect: TEAM_REJECTION_REASONS.itemTerminal },
  { name: 'cancel a cancelled plan', target: PLAN, prior: 'cancelled', intent: { type: 'item.cancelled', body: { id: PLAN, reason: 'again' } }, expect: TEAM_REJECTION_REASONS.itemTerminal },
  { name: 'reopen a cancelled plan into backlog', target: PLAN, prior: 'cancelled', intent: { type: 'item.reopened', body: { id: PLAN } }, expect: undefined, check: (item) => { assert.equal(item.state, 'backlog'); } },
  { name: 'reopen a done plan into backlog', target: PLAN, prior: 'done', intent: { type: 'item.reopened', body: { id: PLAN } }, expect: undefined, check: (item) => { assert.equal(item.state, 'backlog'); assert.equal(item.blocked, undefined); assert.equal(item.hold, undefined); } },
  { name: 'reopen a backlog plan', target: PLAN, prior: 'backlog', intent: { type: 'item.reopened', body: { id: PLAN } }, expect: TEAM_REJECTION_REASONS.itemState },
  { name: 'reopen a stored ready plan', target: PLAN, prior: 'ready', intent: { type: 'item.reopened', body: { id: PLAN } }, expect: TEAM_REJECTION_REASONS.itemState },
  { name: 'reopen a blocked plan', target: PLAN, prior: 'blocked', intent: { type: 'item.reopened', body: { id: PLAN } }, expect: TEAM_REJECTION_REASONS.itemState },
  // estimates
  { name: 'estimate a board item', target: BOARD, prior: 'backlog', intent: { type: 'item.estimated', body: { id: BOARD, estimate: { tokens: 9000, confidence: 'low' } } }, expect: undefined, check: (item) => { assert.deepEqual(item.estimate, { tokens: 9000, confidence: 'low' }); } },
  { name: 'estimate a done board item', target: BOARD, prior: 'done', intent: { type: 'item.estimated', body: { id: BOARD, estimate: { tokens: 9000 } } }, expect: TEAM_REJECTION_REASONS.itemTerminal },
  { name: 'estimate a cancelled board item', target: BOARD, prior: 'cancelled', intent: { type: 'item.estimated', body: { id: BOARD, estimate: { tokens: 9000 } } }, expect: TEAM_REJECTION_REASONS.itemTerminal },
  { name: 'estimate an imported plan', target: PLAN, prior: 'backlog', intent: { type: 'item.estimated', body: { id: PLAN, estimate: { tokens: 9000 } } }, expect: TEAM_REJECTION_REASONS.itemField },
  // content changes by origin
  { name: 'retitle an imported plan', target: PLAN, prior: 'backlog', intent: update(PLAN, { title: 'Renamed' }), expect: undefined, check: (item) => { assert.equal(item.title, 'Renamed');  } },
  { name: 'retitle a done imported plan', target: PLAN, prior: 'done', intent: update(PLAN, { title: 'Renamed' }), expect: undefined },
  { name: 'set the estimate of an imported plan', target: PLAN, prior: 'backlog', intent: update(PLAN, { estimate: { tokens: 1234 } }), expect: undefined },
  { name: 'flag a plan as done in GSD', target: PLAN, prior: 'backlog', intent: update(PLAN, { summary: true }), expect: undefined, check: (item) => { assert.equal(item.summary, true); } },
  { name: 'flag a phase as done in GSD', target: PHASE, prior: 'backlog', intent: update(PHASE, { summary: true }), expect: TEAM_REJECTION_REASONS.itemField },
  { name: 'mark a plan active', target: PLAN, prior: 'backlog', intent: update(PLAN, { active: true }), expect: TEAM_REJECTION_REASONS.itemField },
  { name: 'mark a milestone active', target: MILESTONE, prior: 'backlog', intent: update(MILESTONE, { active: true }), expect: undefined, check: (item) => { assert.equal(item.active, true); } },
  { name: 'record the source commit of a milestone', target: MILESTONE, prior: 'backlog', intent: update(MILESTONE, { source: 'a'.repeat(40) }), expect: undefined },
  { name: 'record a source commit on a plan', target: PLAN, prior: 'backlog', intent: update(PLAN, { source: 'a'.repeat(40) }), expect: TEAM_REJECTION_REASONS.itemField },
  { name: 'give an imported plan a description', target: PLAN, prior: 'backlog', intent: update(PLAN, { description: 'text' }), expect: TEAM_REJECTION_REASONS.itemField },
  { name: 'retitle a board item', target: BOARD, prior: 'backlog', intent: update(BOARD, { title: 'Renamed' }), expect: undefined },
  { name: 'describe a board item', target: BOARD, prior: 'backlog', intent: update(BOARD, { description: 'More detail.' }), expect: undefined, check: (item) => { assert.equal(item.description, 'More detail.'); } },
  { name: 'change the requirements of a board item', target: BOARD, prior: 'backlog', intent: update(BOARD, { requirements: ['BOARD-01'] }), expect: TEAM_REJECTION_REASONS.itemField },
  { name: 'change the dependencies of a board item', target: BOARD, prior: 'backlog', intent: update(BOARD, { dependsOn: [PLAN] }), expect: TEAM_REJECTION_REASONS.itemField },
  { name: 'change the estimate of a board item through item.updated', target: BOARD, prior: 'backlog', intent: update(BOARD, { estimate: { tokens: 5 } }), expect: TEAM_REJECTION_REASONS.itemField },
  // import and create
  { name: 'import a new plan under its phase', target: NEW_PLAN, prior: 'backlog', intent: imports(NEW_PLAN, 'plan', PHASE), expect: undefined, check: (item) => { assert.equal(item.origin, 'import'); assert.equal(item.parentId, PHASE); } },
  { name: 'import a task under a plan', target: 'task:1-01-2', prior: 'backlog', intent: imports('task:1-01-2', 'task', PLAN), expect: undefined },
  { name: 'import a second milestone', target: 'milestone:v2.0', prior: 'backlog', intent: imports('milestone:v2.0', 'milestone'), expect: undefined },
  { name: 'import an id that exists', target: PLAN, prior: 'backlog', intent: imports(PLAN, 'plan', PHASE), expect: TEAM_REJECTION_REASONS.itemExists },
  { name: 'import a plan under a missing phase', target: NEW_PLAN, prior: 'backlog', intent: imports(NEW_PLAN, 'plan', 'phase:9'), expect: TEAM_REJECTION_REASONS.itemParent },
  { name: 'import a plan under a milestone', target: NEW_PLAN, prior: 'backlog', intent: imports(NEW_PLAN, 'plan', MILESTONE), expect: TEAM_REJECTION_REASONS.itemParent },
  { name: 'import a task under a phase', target: 'task:1-01-2', prior: 'backlog', intent: imports('task:1-01-2', 'task', PHASE), expect: TEAM_REJECTION_REASONS.itemParent },
  { name: 'create a board item', target: NEW_BOARD, prior: 'backlog', intent: { type: 'item.created', body: { id: NEW_BOARD, kind: 'spike', title: 'Try the new parser', scope: [], requirements: [], mustHaves: [] } }, expect: undefined, check: (item) => { assert.equal(item.state, 'backlog'); assert.equal(item.origin, 'board'); } },
  { name: 'create a board item with an id that exists', target: BOARD, prior: 'backlog', intent: { type: 'item.created', body: { id: BOARD, kind: 'spike', title: 'Again', scope: [], requirements: [], mustHaves: [] } }, expect: TEAM_REJECTION_REASONS.itemExists },
  // events that name an item nobody created
  ...(['item.updated', 'item.estimated', 'item.blocked', 'item.unblocked', 'item.cancelled', 'item.reopened'] as const).map((type): MoveRow => {
    const id = 'plan:9-09';
    const intents: Record<typeof type, EventIntent> = {
      'item.updated': update(id, { title: 'x' }),
      'item.estimated': { type: 'item.estimated', body: { id, estimate: { tokens: 1 } } },
      'item.blocked': { type: 'item.blocked', body: { id, reason: 'x' } },
      'item.unblocked': { type: 'item.unblocked', body: { id } },
      'item.cancelled': { type: 'item.cancelled', body: { id, reason: 'x' } },
      'item.reopened': { type: 'item.reopened', body: { id } }
    };
    return { name: `${type} of an item that does not exist`, target: PLAN, prior: 'backlog', intent: intents[type], expect: TEAM_REJECTION_REASONS.itemMissing };
  })
];

for (const row of moves) {
  test(`move: ${row.name}`, async () => {
    const c = await theCast();
    const state = priorState(c, row.target, row.prior);
    const live = cloneState(state);
    const verdict = applyEntry(live, entryOf(signFor(live, c.owner, row.intent)));
    if (row.expect === undefined) {
      assert.equal(verdict.accepted, true, verdict.accepted ? '' : verdict.rejection.reason);
      const item = live.items.get(row.target) as WorkItem;
      assert.ok(item, 'the target item exists after the move');
      row.check?.(item);
      for (const stored of live.items.values()) assert.equal(NOT_STORED_CLAIM_STATES.includes(stored.state) && stored.state !== state.items.get(stored.id)?.state, false, `${stored.id} must not enter a claim or integration state`);
    } else {
      assert.equal(verdict.accepted, false);
      assert.equal(verdict.accepted ? '' : verdict.rejection.reason, row.expect);
    }
    // The writer asks the same question: permission passes for the owner, and the transport's replay of the batch returns the reader's reason.
    const prepared = prepareEvents(state, state.head, signerOf(c.owner), [row.intent], NOW);
    assert.ok(Array.isArray(prepared), 'the owner passes the write-side permission check');
    const candidate = checkCandidate(state, prepared as TeamEvent[]);
    assert.equal(candidate?.reason, row.expect, 'write and read agree');
  });
}

test('no item event can store a claim or integration state, and the validators refuse to name one', () => {
  for (const state of NOT_STORED_CLAIM_STATES) {
    assert.equal(validateBody('item.updated', { id: PLAN, changes: { state } }), `${INVALID}: body.changes.state`, state);
    assert.equal(validateBody('item.imported', { id: PLAN, kind: 'plan', title: 'T', state, dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [], parentId: PHASE }), `${INVALID}: body.state`, state);
  }
  assert.equal(validateBody('item.updated', { id: PLAN, changes: { claimId: 'clm-1' } }), `${INVALID}: body.changes.claimId`);
  assert.equal(validateBody('item.updated', { id: PLAN, changes: { state: 'done', hold: false } }), `${INVALID}: body.changes`, 'a mark done travels alone');
  assert.equal(validateBody('item.updated', { id: PLAN, changes: { hold: true, title: 'x' } }), `${INVALID}: body.changes`, 'a hold travels alone');
  assert.equal(validateBody('item.updated', { id: PLAN, changes: {} }), `${INVALID}: body.changes`);
});

test('imported bodies check the parent shape and keep summary, active and source on their own kinds', () => {
  const base = { title: 'T', state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [] };
  assert.equal(validateBody('item.imported', { ...base, id: MILESTONE, kind: 'milestone', parentId: 'x' }), `${INVALID}: body.parentId`);
  assert.equal(validateBody('item.imported', { ...base, id: MILESTONE, kind: 'milestone', active: true, source: 'a'.repeat(40) }), undefined);
  assert.equal(validateBody('item.imported', { ...base, id: PHASE, kind: 'phase' }), `${INVALID}: body.parentId`);
  assert.equal(validateBody('item.imported', { ...base, id: PHASE, kind: 'phase', parentId: BOARD }), `${INVALID}: body.parentId`, 'a board id is never a parent');
  assert.equal(validateBody('item.imported', { ...base, id: PHASE, kind: 'phase', parentId: PLAN }), undefined, 'the kind of the parent is a state question, answered by itemParent');
  assert.equal(validateBody('item.imported', { ...base, id: PHASE, kind: 'phase', parentId: MILESTONE, summary: true }), `${INVALID}: body.summary`);
  assert.equal(validateBody('item.imported', { ...base, id: PLAN, kind: 'plan', parentId: PHASE, summary: true }), undefined);
  assert.equal(validateBody('item.imported', { ...base, id: PLAN, kind: 'plan', parentId: PHASE, summary: false }), `${INVALID}: body.summary`);
  assert.equal(validateBody('item.imported', { ...base, id: PLAN, kind: 'plan', parentId: PHASE, active: true }), `${INVALID}: body.active`);
  assert.equal(validateBody('item.imported', { ...base, id: PLAN, kind: 'plan', parentId: PHASE, source: 'a'.repeat(40) }), `${INVALID}: body.source`);
  assert.equal(validateBody('item.imported', { ...base, id: PLAN, kind: 'task', parentId: PLAN }), `${INVALID}: body.id`, 'the prefix must equal the kind');
  assert.equal(validateBody('item.imported', { ...base, id: BOARD, kind: 'plan', parentId: PHASE }), `${INVALID}: body.id`, 'a board id is never imported');
});

// Permission is decided by the role (and, for a developer, by who made the draft) and nothing else. Each row is a fresh state where the owner may
// make the move; the columns are owner, lead, the developer who created the board item, another developer, a reviewer, an observer.
interface PermRow { name: string; target: string; prior: Prior; intent: (actor: TestActor) => EventIntent; expect: readonly [boolean, boolean, boolean, boolean, boolean, boolean] }
const T = true;
const F = false;
const permissions: PermRow[] = [
  { name: 'import a plan', target: NEW_PLAN, prior: 'backlog', intent: () => imports(NEW_PLAN, 'plan', PHASE), expect: [T, T, F, F, F, F] },
  { name: 'create a board item', target: NEW_BOARD, prior: 'backlog', intent: () => ({ type: 'item.created', body: { id: NEW_BOARD, kind: 'chore', title: 'New', scope: [], requirements: [], mustHaves: [] } }), expect: [T, T, T, T, F, F] },
  { name: 'edit the title of an unclaimed board item', target: BOARD, prior: 'backlog', intent: () => update(BOARD, { title: 'Renamed' }), expect: [T, T, T, F, F, F] },
  { name: 'edit the title of a board item once it is claimed', target: BOARD, prior: 'claimed', intent: () => update(BOARD, { title: 'Renamed' }), expect: [T, T, F, F, F, F] },
  { name: 'edit the title of an imported plan', target: PLAN, prior: 'backlog', intent: () => update(PLAN, { title: 'Renamed' }), expect: [T, T, F, F, F, F] },
  { name: 'estimate an unclaimed board item', target: BOARD, prior: 'backlog', intent: () => ({ type: 'item.estimated', body: { id: BOARD, estimate: { tokens: 100 } } }), expect: [T, T, T, F, F, F] },
  { name: 'estimate a board item once it is claimed', target: BOARD, prior: 'claimed', intent: () => ({ type: 'item.estimated', body: { id: BOARD, estimate: { tokens: 100 } } }), expect: [T, T, F, F, F, F] },
  { name: 'hold a board item', target: BOARD, prior: 'backlog', intent: () => update(BOARD, { hold: true }), expect: [T, T, F, F, F, F] },
  { name: 'release a held board item', target: BOARD, prior: 'held', intent: () => update(BOARD, { hold: false }), expect: [T, T, F, F, F, F] },
  { name: 'mark a board item done', target: BOARD, prior: 'backlog', intent: () => update(BOARD, { state: 'done' }), expect: [T, T, F, F, F, F] },
  { name: 'block a board item', target: BOARD, prior: 'backlog', intent: () => ({ type: 'item.blocked', body: { id: BOARD, reason: 'waiting' } }), expect: [T, T, F, F, F, F] },
  { name: 'unblock a board item', target: BOARD, prior: 'blocked', intent: () => ({ type: 'item.unblocked', body: { id: BOARD } }), expect: [T, T, F, F, F, F] },
  { name: 'cancel a board item', target: BOARD, prior: 'backlog', intent: () => ({ type: 'item.cancelled', body: { id: BOARD, reason: 'dropped' } }), expect: [T, T, F, F, F, F] },
  { name: 'reopen a cancelled board item', target: BOARD, prior: 'cancelled', intent: () => ({ type: 'item.reopened', body: { id: BOARD } }), expect: [T, T, F, F, F, F] }
];

for (const row of permissions) {
  test(`permission: ${row.name}`, async () => {
    const c = await theCast();
    const state = priorState(c, row.target, row.prior);
    for (const [index, role] of ROLE_ORDER.entries()) {
      const actor = c[role];
      const intent = row.intent(actor);
      const live = cloneState(state);
      const verdict = applyEntry(live, entryOf(signFor(live, actor, intent)));
      const written = prepareEvents(state, state.head, signerOf(actor), [intent], NOW);
      if (row.expect[index]) {
        assert.equal(verdict.accepted, true, `${role}: ${verdict.accepted ? '' : verdict.rejection.reason}`);
        assert.ok(Array.isArray(written), `${role} may write it`);
        assert.equal(checkCandidate(state, written as TeamEvent[]), undefined, `${role} replay`);
      } else {
        assert.equal(verdict.accepted, false, `${role} must be refused`);
        const reason = verdict.accepted ? '' : verdict.rejection.reason;
        assert.ok(reason.startsWith(`${TEAM_REJECTION_REASONS.notPermitted}: `), `${role}: ${reason}`);
        assert.deepEqual(written, { conflict: reason }, `${role}: the writer refuses with the reader's text`);
      }
    }
  });
}

test('refusals say which role, which action and, for a developer, that only their own draft is open', async () => {
  const c = await theCast();
  const state = priorState(c, BOARD, 'backlog');
  const reasonFor = (actor: TestActor, intent: EventIntent): string => {
    const verdict = applyEntry(cloneState(state), entryOf(signFor(state, actor, intent)));
    return verdict.accepted ? '' : verdict.rejection.reason;
  };
  assert.equal(reasonFor(c.developer, { type: 'item.blocked', body: { id: BOARD, reason: 'x' } }), 'not permitted: the developer role does not allow moving items');
  assert.equal(reasonFor(c.other, update(BOARD, { title: 'x' })), 'not permitted: the developer role does not allow editing items unless it is your own draft');
  assert.equal(reasonFor(c.reviewer, imports(NEW_PLAN, 'plan', PHASE)), 'not permitted: the reviewer role does not allow creating items');
  assert.equal(reasonFor(c.observer, { type: 'item.unblocked', body: { id: BOARD } }), 'not permitted: the observer role does not allow moving items');
});

// ---- Frozen shapes ----------------------------------------------------------------------------------------------------------------
// These change only with an owner-approved format change: the bodies are signed into the log for good, and the stored WorkItem keys enter the
// state hash once items exist.

const FROZEN_BODIES: Array<[string, unknown, string]> = [
  ['item.imported', { id: 'plan:62-01', kind: 'plan', title: 'Work items in the signed log', state: 'backlog', dependsOn: ['plan:62-00'], scope: ['src/domain/team/**'], requirements: ['BOARD-01'], mustHaves: ['Items are validated'], tags: ['wave-1'], parentId: 'phase:62', gsd: { phase: '62', plan: '01', wave: 1, file: '.planning/phases/62/62-01-PLAN.md' }, estimate: { tokens: 98000, confidence: 'high' }, summary: true },
    '{"dependsOn":["plan:62-00"],"estimate":{"confidence":"high","tokens":98000},"gsd":{"file":".planning/phases/62/62-01-PLAN.md","phase":"62","plan":"01","wave":1},"id":"plan:62-01","kind":"plan","mustHaves":["Items are validated"],"parentId":"phase:62","requirements":["BOARD-01"],"scope":["src/domain/team/**"],"state":"backlog","summary":true,"tags":["wave-1"],"title":"Work items in the signed log"}'],
  ['item.created', { id: 'item:01ARZ3NDEKTSV4RRFFQ69G5FAV', kind: 'chore', title: 'Tidy the config', scope: ['src/**'], requirements: ['BOARD-03'], mustHaves: ['Config loads'], description: 'Remove the unused keys.', estimate: { tokens: 48000 }, tags: ['cleanup'] },
    '{"description":"Remove the unused keys.","estimate":{"tokens":48000},"id":"item:01ARZ3NDEKTSV4RRFFQ69G5FAV","kind":"chore","mustHaves":["Config loads"],"requirements":["BOARD-03"],"scope":["src/**"],"tags":["cleanup"],"title":"Tidy the config"}'],
  ['item.updated', { id: 'plan:62-01', changes: { title: 'A clearer title', estimate: { tokens: 50000, confidence: 'medium' } } },
    '{"changes":{"estimate":{"confidence":"medium","tokens":50000},"title":"A clearer title"},"id":"plan:62-01"}'],
  ['item.estimated', { id: 'item:01ARZ3NDEKTSV4RRFFQ69G5FAV', estimate: { tokens: 48000, confidence: 'low' } },
    '{"estimate":{"confidence":"low","tokens":48000},"id":"item:01ARZ3NDEKTSV4RRFFQ69G5FAV"}'],
  ['item.blocked', { id: 'item:01ARZ3NDEKTSV4RRFFQ69G5FAV', reason: 'waiting for the API key' },
    '{"id":"item:01ARZ3NDEKTSV4RRFFQ69G5FAV","reason":"waiting for the API key"}'],
  ['item.unblocked', { id: 'item:01ARZ3NDEKTSV4RRFFQ69G5FAV' }, '{"id":"item:01ARZ3NDEKTSV4RRFFQ69G5FAV"}'],
  ['item.cancelled', { id: 'plan:62-01', reason: 'no longer in the roadmap' }, '{"id":"plan:62-01","reason":"no longer in the roadmap"}'],
  ['item.reopened', { id: 'plan:62-01' }, '{"id":"plan:62-01"}'],
  // G-62-5 (62-15) added the two assignment events; their bodies are frozen here the same way.
  ['item.assigned', { id: 'plan:62-01', memberId: 'mbr-0123456789abcdef' }, '{"id":"plan:62-01","memberId":"mbr-0123456789abcdef"}'],
  ['item.unassigned', { id: 'plan:62-01' }, '{"id":"plan:62-01"}']
];

test('the canonical body of one recorded example per item event type is frozen', () => {
  // Ten since 62-15 (was eight): item.assigned and item.unassigned joined the work events.
  assert.equal(FROZEN_BODIES.length, 10);
  for (const [type, body, recorded] of FROZEN_BODIES) {
    assert.equal(validateBody(type, body), undefined, `${type} example is valid`);
    assert.equal(canonicalize(body), recorded, type);
  }
});

test('the stored WorkItem key set is frozen', () => {
  // Required<WorkItem> makes the compiler refuse this literal when a key is added to or dropped from the type, so the list below cannot drift silently.
  // 62-15 added assignee on purpose (G-62-5): it is optional and left out when empty, so no older state changes its hash (teamAssignHashes.test.ts).
  // 62-26 added assignedBy on purpose (owner decision 2026-11-04: a member leaves only a card they assigned themselves): it is present only while
  // assignee is, so a state without assignments hashes as before.
  const full: Required<WorkItem> = {
    id: 'plan:62-01', kind: 'plan', title: 'T', parentId: 'phase:62', gsd: { phase: '62' }, dependsOn: [], scope: [], requirements: [], mustHaves: [],
    estimate: { tokens: 1 }, state: 'backlog', blocked: { reason: 'r', by: 'mbr-0123456789abcdef', since: '2026-01-01T00:00:00.000Z' }, claimId: 'clm-1', tags: [],
    ringFenceNanoUsd: 0, origin: 'import', stateSince: '2026-01-01T00:00:00.000Z', createdBy: 'mbr-0123456789abcdef', description: 'd', hold: true, summary: true, active: true, source: 'a'.repeat(40),
    assignee: 'mbr-0123456789abcdef', assignedBy: 'mbr-0123456789abcdef'
  };
  assert.deepEqual(Object.keys(full).sort(), [
    'active', 'assignedBy', 'assignee', 'blocked', 'claimId', 'createdBy', 'dependsOn', 'description', 'estimate', 'gsd', 'hold', 'id', 'kind', 'mustHaves', 'origin', 'parentId',
    'requirements', 'ringFenceNanoUsd', 'scope', 'source', 'state', 'stateSince', 'summary', 'tags', 'title'
  ]);
});

test('an item stored from events carries only keys that were set, so a bare board item has the smallest shape', async () => {
  const c = await theCast();
  const item = c.seed.items.get(BOARD) as WorkItem;
  assert.deepEqual(Object.keys(item).sort(), ['createdBy', 'dependsOn', 'id', 'kind', 'mustHaves', 'origin', 'requirements', 'scope', 'state', 'stateSince', 'tags', 'title']);
  const plan = c.seed.items.get(PLAN) as WorkItem;
  assert.deepEqual(Object.keys(plan).sort(), ['dependsOn', 'id', 'kind', 'mustHaves', 'origin', 'parentId', 'requirements', 'scope', 'state', 'stateSince', 'tags', 'title']);
});
