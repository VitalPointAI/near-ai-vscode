// Key status tests (D-09): the team roster as a status source and how sources combine.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { applyEntry, reduce } from '../domain/team/materialize';
import { NO_KNOWN_KEYS, REMOVED_FROM_TEAM, combineKeyStatus, teamKeyStatus } from '../domain/team/keyStatus';
import type { KeyStatus, KeyStatusLookup } from '../domain/team/keyStatus';
import type { ImplementedEventBodies, ImplementedEventType, TeamEvent, TeamState } from '../domain/team/types';
import { newTeamId } from '../team/identity';
import { addFixtureMember, entryOf, genesisEntries, makeActor, makeDevice, rotationBody, signed } from './helpers/teamEvents';
import type { TestActor } from './helpers/teamEvents';

const ROTATED_AT = '2026-03-01T00:00:00.000Z';

function randomKey(): { fingerprint: string; publicKey: string } {
  const jwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  return { fingerprint: `dev-${'f'.repeat(32)}`, publicKey: jwk.x as string };
}

function refOf(actor: TestActor): { fingerprint: string; publicKey: string } {
  return { fingerprint: actor.identity.fingerprint, publicKey: actor.identity.publicKey };
}

interface World { teamId: string; owner: TestActor; state: TeamState }

async function world(): Promise<World> {
  const teamId = newTeamId();
  const owner = await makeActor(teamId);
  const { entries, anchor } = genesisEntries(owner, teamId);
  return { teamId, owner, state: reduce(entries, anchor) };
}

function accept<T extends ImplementedEventType>(w: World, actor: TestActor, type: T, body: ImplementedEventBodies[T], at?: string): TeamEvent<T> {
  const event = signed(actor, { teamId: w.teamId, type, body, lamport: w.state.head.lamport + 1, prev: w.state.head.eventId, ...(at === undefined ? {} : { at }) });
  const verdict = applyEntry(w.state, entryOf(event));
  assert.deepEqual(verdict.accepted ? undefined : verdict.rejection, undefined, 'event should be accepted');
  return event;
}

test('a key bound to a member in the roster is active', async () => {
  const w = await world();
  assert.deepEqual(teamKeyStatus(w.state)(refOf(w.owner)), { state: 'active' });
});

test('a key the roster does not hold, or holds with a different public key, is unknown', async () => {
  const w = await world();
  const lookup = teamKeyStatus(w.state);
  assert.deepEqual(lookup(randomKey()), { state: 'unknown' });
  assert.deepEqual(lookup({ fingerprint: w.owner.identity.fingerprint, publicKey: randomKey().publicKey }), { state: 'unknown' });
  assert.deepEqual(NO_KNOWN_KEYS(randomKey()), { state: 'unknown' });
});

test('a rotated key is rotated since the rotation event, names its replacement, and the new key is active', async () => {
  const w = await world();
  const next = await makeDevice(w.owner);
  accept(w, w.owner, 'device.rotated', rotationBody(w.owner.memberId, w.owner, next), ROTATED_AT);
  const lookup = teamKeyStatus(w.state);
  assert.deepEqual(lookup(refOf(w.owner)), { state: 'rotated', since: ROTATED_AT, replacedBy: next.identity.fingerprint });
  assert.deepEqual(lookup(refOf(next)), { state: 'active' });
});

test('a revoked key is revoked, and a rotated key that is revoked afterwards is revoked', async () => {
  const w = await world();
  const second = await makeDevice(w.owner);
  const third = await makeDevice(w.owner);
  accept(w, w.owner, 'device.added', { memberId: w.owner.memberId, device: refOf(second) });
  accept(w, w.owner, 'device.revoked', { memberId: w.owner.memberId, fingerprint: second.identity.fingerprint });
  assert.equal(teamKeyStatus(w.state)(refOf(second)).state, 'revoked');
  accept(w, w.owner, 'device.rotated', rotationBody(w.owner.memberId, w.owner, third), ROTATED_AT);
  assert.equal(teamKeyStatus(w.state)(refOf(w.owner)).state, 'rotated');
  accept(w, third, 'device.revoked', { memberId: w.owner.memberId, fingerprint: w.owner.identity.fingerprint });
  assert.equal(teamKeyStatus(w.state)(refOf(w.owner)).state, 'revoked');
  assert.equal(teamKeyStatus(w.state)(refOf(third)).state, 'active');
});

test('every key of a removed member is revoked with the reason "removed from the team"', async () => {
  const w = await world();
  const developer = await makeActor(w.teamId);
  addFixtureMember(w.state, developer, 'developer');
  assert.equal(teamKeyStatus(w.state)(refOf(developer)).state, 'active');
  accept(w, w.owner, 'member.removed', { memberId: developer.memberId }, ROTATED_AT);
  const status = teamKeyStatus(w.state)(refOf(developer));
  assert.equal(status.state, 'revoked');
  assert.equal(status.reason, REMOVED_FROM_TEAM);
  assert.equal(REMOVED_FROM_TEAM, 'removed from the team');
  assert.equal(status.since, ROTATED_AT);
});

function fixed(status: KeyStatus): KeyStatusLookup {
  return () => status;
}

test('combineKeyStatus: revoked beats rotated beats active beats unknown, in any order', () => {
  const key = randomKey();
  const answers: KeyStatus[] = [{ state: 'unknown' }, { state: 'active' }, { state: 'rotated', since: ROTATED_AT }, { state: 'revoked', reason: 'x' }];
  for (let i = 0; i < answers.length; i += 1) {
    for (let j = 0; j < answers.length; j += 1) {
      const worse = (answers[Math.max(i, j)] as KeyStatus).state;
      assert.equal(combineKeyStatus(fixed(answers[i] as KeyStatus), fixed(answers[j] as KeyStatus))(key).state, worse);
    }
  }
  assert.deepEqual(combineKeyStatus()(key), { state: 'unknown' });
  assert.deepEqual(combineKeyStatus(NO_KNOWN_KEYS, fixed({ state: 'active' }))(key), { state: 'active' });
});

test('combineKeyStatus: for two rotated answers the earlier since wins, and an unreadable time never beats a readable one', () => {
  const key = randomKey();
  const early: KeyStatus = { state: 'rotated', since: '2026-01-01T00:00:00.000Z', replacedBy: 'dev-a' };
  const late: KeyStatus = { state: 'rotated', since: '2026-06-01T00:00:00.000Z', replacedBy: 'dev-b' };
  assert.deepEqual(combineKeyStatus(fixed(late), fixed(early))(key), early);
  assert.deepEqual(combineKeyStatus(fixed(early), fixed(late))(key), early);
  const unreadable: KeyStatus = { state: 'rotated', since: 'not a time' };
  assert.deepEqual(combineKeyStatus(fixed(unreadable), fixed(late))(key), late);
  assert.deepEqual(combineKeyStatus(fixed(late), fixed(unreadable))(key), late);
});

test('a team that never rotated gives a status with no rotation fields, so nothing extra appears', async () => {
  const w = await world();
  const status = teamKeyStatus(w.state)(refOf(w.owner));
  assert.deepEqual(Object.keys(status), ['state']);
});
