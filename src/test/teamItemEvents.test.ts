// Work items in the signed log (D-04, D-10 to D-14): the two-clone tracer over real git, the write and read agreement on permissions,
// body validation and the Phase 60 hash parity. The move and permission table and the frozen pins follow in the same file.
// Reasons are asserted from TEAM_REJECTION_REASONS or by their fixed prefix, never by loosening a comparison.
import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import { deserialiseState, reduce, serialiseState, stateHash, applyEntry, teamMaterializer } from '../domain/team/materialize';
import { defaultTeamPolicy } from '../domain/team/policy';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { GenesisAnchor, JsonObject, TeamEvent, TeamFile, TeamState } from '../domain/team/types';
import { validateBody } from '../domain/team/validate';
import { TeamLog, buildGenesisEvents, prepareEvents } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { emailHash, newTeamId, ulid } from '../team/identity';
import { canonicalTeamFile } from '../team/teamFile';
import { createOwner, createTeamFixture } from './helpers/teamHarness';
import type { TeamFixture, TestOwner } from './helpers/teamHarness';
import { addFixtureMember, entryOf, genesisEntries, makeActor, signed } from './helpers/teamEvents';
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
