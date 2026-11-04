// G-62-5 hash guard (62-15): adding item.assigned and item.unassigned must not move the state hash of any log that has neither event. The three
// hashes below were recorded at HEAD 64bbddd, before any source change of this plan, over fully deterministic logs: the Phase 60 fixture's fixed
// team, member and Ed25519 seed (helpers/teamPhase60Fixture.ts), fixed event ids and fixed times. Ed25519 signatures are deterministic, so the
// same bytes and the same hash come out on every run. If one of these literals ever has to change, an older log has changed meaning.
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize, eventPath } from '../domain/team/canonical';
import { STATE_HASH_VERSION, applyEntry, reduce, stateHash } from '../domain/team/materialize';
import type { CommittedEvent, GenesisAnchor, ImplementedEventBodies, ImplementedEventType, TeamEventBodyMap, TeamState } from '../domain/team/types';
import { deviceKeySecretName, loadDeviceIdentity, signEvent } from '../team/identity';
import type { DeviceIdentity } from '../team/identity';
import { MemorySecrets } from './helpers/teamHarness';
import { PHASE60_TEAM_ID, phase60Fixture } from './helpers/teamPhase60Fixture';

const OWNER_ID = 'mbr-0123456789abcdef';
const PKCS8_ED25519_PREFIX = '302e020100300506032b657004220420';
const BOARD_ID = 'item:01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER_BOARD_ID = 'item:01ARZ3NDEKTSV4RRFFQ69G5FAW';
const THIRD_BOARD_ID = 'item:01ARZ3NDEKTSV4RRFFQ69G5FAX';

const PHASE60_HASH = 'e41fe7cbcc4fc089a0f07a373835e3388a20d76e6fe235cc0121204863e14408';
const SNAPSHOT_WORLD_HASH = '4438d7c0401456fe638b3ef943efdc0d847f952d1000cf672aa7c2585acffc80';
const SEEDED_BOARD_HASH = 'd09bf893599ebc25b727a3d2c462f25b7f9e510cf228aa7200fc667018d7b898';

interface Pinned { anchor: GenesisAnchor; identity: DeviceIdentity; state: TeamState }

// The owner key of the Phase 60 fixture, loaded from the same public test seed, so events after genesis are signed by the bound device.
async function pinnedTeam(): Promise<Pinned> {
  const { entries, anchor } = await phase60Fixture();
  const secrets = new MemorySecrets();
  await secrets.store(deviceKeySecretName(PHASE60_TEAM_ID), Buffer.concat([Buffer.from(PKCS8_ED25519_PREFIX, 'hex'), Buffer.alloc(32, 7)]).toString('base64'));
  const identity = await loadDeviceIdentity(secrets, PHASE60_TEAM_ID);
  if (identity === undefined) throw new Error('The fixed fixture key did not load.');
  return { anchor, identity, state: reduce(entries, anchor) };
}

// Event ids count up from 3 after the two genesis events (Crockford digits, 26 of them), and each event is one second after the previous one.
function send<T extends ImplementedEventType>(pinned: Pinned, type: T, body: ImplementedEventBodies[T]): void {
  const lamport = pinned.state.highLamport + 1;
  const event = signEvent(pinned.identity, {
    v: 1, id: `evt-${String(lamport).padStart(26, '0')}`, teamId: PHASE60_TEAM_ID, type, lamport, at: `2026-03-01T10:00:${String(lamport).padStart(2, '0')}.000Z`,
    author: OWNER_ID, device: pinned.identity.fingerprint, prev: pinned.state.head.eventId, body: body as TeamEventBodyMap[T]
  });
  const text = canonicalize(event);
  const entry: CommittedEvent = { commit: 'c'.repeat(40), commitTime: 1, path: eventPath(event), blob: 'b'.repeat(40), size: Buffer.byteLength(text, 'utf8'), text, kind: 'event' };
  const verdict = applyEntry(pinned.state, entry);
  assert.equal(verdict.accepted, true, verdict.accepted ? '' : `${type}: ${verdict.rejection.reason}`);
}

const imported = (fields: Partial<ImplementedEventBodies['item.imported']> & Pick<ImplementedEventBodies['item.imported'], 'id' | 'kind'>): ImplementedEventBodies['item.imported'] => (
  { title: fields.id, state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [], ...fields }
);

test('the Phase 60 fixture keeps the state hash it had before assignment existed', async () => {
  const pinned = await pinnedTeam();
  assert.equal(stateHash(pinned.state), PHASE60_HASH);
});

// The same events, in the same order, as itemWorld in teamItemSnapshot.test.ts: every item shape this phase can store, with the largest text.
test('the item state of the snapshot tests keeps the state hash it had before assignment existed', async () => {
  const pinned = await pinnedTeam();
  const longMustHave = 'm'.repeat(600);
  send(pinned, 'item.imported', imported({ id: 'milestone:v0.9.0', kind: 'milestone', title: 'T'.repeat(200), active: true, source: 'a'.repeat(40) }));
  send(pinned, 'item.imported', imported({ id: 'phase:90', kind: 'phase', parentId: 'milestone:v0.9.0' }));
  send(pinned, 'item.imported', imported({ id: 'phase:91', kind: 'phase', parentId: 'milestone:v0.9.0', dependsOn: ['phase:90'] }));
  send(pinned, 'item.imported', imported({
    id: 'plan:90-01', kind: 'plan', parentId: 'phase:90', state: 'done', summary: true, scope: ['src/a/**', 'docs/x.md'], requirements: ['BOARD-01', 'BOARD-02'],
    mustHaves: [longMustHave, 'Second must-have'], tags: ['gap-closure'], gsd: { phase: '90', plan: '01', wave: 1, file: '.planning/phases/90/90-01-PLAN.md' },
    estimate: { tokens: 30000, confidence: 'high' }
  }));
  send(pinned, 'item.imported', imported({ id: 'plan:90-02', kind: 'plan', parentId: 'phase:90', dependsOn: ['plan:90-01'], scope: ['src/b/**'], estimate: { tokens: 10000 } }));
  send(pinned, 'item.imported', imported({ id: 'task:90-01-1', kind: 'task', parentId: 'plan:90-01' }));
  send(pinned, 'item.updated', { id: 'plan:90-02', changes: { hold: true } });
  send(pinned, 'item.created', {
    id: BOARD_ID, kind: 'chore', title: 'Wire the webhook', scope: ['src/services/**'], requirements: ['BOARD-03'], mustHaves: [longMustHave],
    description: 'd'.repeat(2000), estimate: { tokens: 48000, confidence: 'low' }, tags: ['ops']
  });
  send(pinned, 'item.blocked', { id: BOARD_ID, reason: 'waiting for the API key' });
  send(pinned, 'item.created', { id: OTHER_BOARD_ID, kind: 'bug', title: 'Redirect loop', scope: [], requirements: [], mustHaves: [] });
  send(pinned, 'item.cancelled', { id: OTHER_BOARD_ID, reason: 'cannot reproduce' });
  send(pinned, 'item.created', { id: THIRD_BOARD_ID, kind: 'spike', title: 'Try the new parser', scope: ['src/parser/**'], requirements: [], mustHaves: [] });
  send(pinned, 'item.updated', { id: THIRD_BOARD_ID, changes: { state: 'done' } });
  assert.equal(pinned.state.items.size, 9);
  assert.equal(stateHash(pinned.state), SNAPSHOT_WORLD_HASH);
});

// A board as the importer and a lead leave it: imported plans in two phases, a board item, a block and an unblock, a hold and a release,
// a cancel and a reopen, a done plan and an estimate.
test('a seeded board with imported plans, a board item, a block, a hold and a cancel keeps its state hash', async () => {
  const pinned = await pinnedTeam();
  send(pinned, 'item.imported', imported({ id: 'milestone:v1.0.0', kind: 'milestone', title: 'Version 1.0.0' }));
  send(pinned, 'item.imported', imported({ id: 'phase:1', kind: 'phase', title: 'Foundations', parentId: 'milestone:v1.0.0' }));
  send(pinned, 'item.imported', imported({ id: 'phase:2', kind: 'phase', title: 'Board', parentId: 'milestone:v1.0.0', dependsOn: ['phase:1'] }));
  send(pinned, 'item.imported', imported({ id: 'plan:1-01', kind: 'plan', title: 'Signed log', parentId: 'phase:1', scope: ['src/log/**'], estimate: { tokens: 20000 }, state: 'done', summary: true }));
  send(pinned, 'item.imported', imported({ id: 'plan:1-02', kind: 'plan', title: 'Roster', parentId: 'phase:1', scope: ['src/roster/**'], dependsOn: ['plan:1-01'], estimate: { tokens: 15000 } }));
  send(pinned, 'item.imported', imported({ id: 'plan:2-01', kind: 'plan', title: 'Columns', parentId: 'phase:2', scope: ['media/board/**'], estimate: { tokens: 30000, confidence: 'medium' } }));
  send(pinned, 'item.created', { id: BOARD_ID, kind: 'chore', title: 'Tidy the config', scope: ['src/config/**'], requirements: [], mustHaves: [] });
  send(pinned, 'item.estimated', { id: BOARD_ID, estimate: { tokens: 4000 } });
  send(pinned, 'item.blocked', { id: 'plan:1-02', reason: 'waiting for review' });
  send(pinned, 'item.unblocked', { id: 'plan:1-02' });
  send(pinned, 'item.blocked', { id: BOARD_ID, reason: 'needs the new key' });
  send(pinned, 'item.updated', { id: 'plan:2-01', changes: { hold: true } });
  send(pinned, 'item.updated', { id: 'plan:2-01', changes: { hold: false } });
  send(pinned, 'item.updated', { id: 'phase:2', changes: { hold: true } });
  send(pinned, 'item.cancelled', { id: 'plan:1-02', reason: 'folded into 2-01' });
  send(pinned, 'item.reopened', { id: 'plan:1-02' });
  send(pinned, 'item.cancelled', { id: BOARD_ID, reason: 'not needed' });
  assert.equal(pinned.state.items.size, 7);
  assert.equal(stateHash(pinned.state), SEEDED_BOARD_HASH);
});

test('the hashed shape version is still 1', () => {
  assert.equal(STATE_HASH_VERSION, 1);
});
