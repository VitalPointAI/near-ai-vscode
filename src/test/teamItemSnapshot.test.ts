// Snapshots carry work items (D-11, T-62-11): a state with items serialises and deserialises to the same text and the same hash, a signed
// snapshot file of it loads, and every malformed item is refused as "invalid snapshot: items..." while the client still replays from genesis.
// A snapshot is untrusted input that only shortens replay, so the parser is as strict as the event validators were when the item was written.
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize } from '../domain/team/canonical';
import { SNAPSHOT_REASONS, applyEntry, deserialiseState, parseSnapshotFile, reduce, serialiseState, snapshotBody, stateHash } from '../domain/team/materialize';
import type { GenesisAnchor, ImplementedEventBodies, ImplementedEventType, JsonObject, TeamState } from '../domain/team/types';
import { newTeamId } from '../team/identity';
import { buildScenario, entryOf, genesisEntries, makeActor, mulberry32, signed, signedSnapshot } from './helpers/teamEvents';
import type { TestActor } from './helpers/teamEvents';
import { phase60Fixture } from './helpers/teamPhase60Fixture';

const INVALID_ITEMS = 'invalid snapshot: items';
const BOARD_ID = 'item:01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER_BOARD_ID = 'item:01ARZ3NDEKTSV4RRFFQ69G5FAW';
const THIRD_BOARD_ID = 'item:01ARZ3NDEKTSV4RRFFQ69G5FAX';

interface World { teamId: string; owner: TestActor; anchor: GenesisAnchor; entries: ReturnType<typeof genesisEntries>['entries']; state: TeamState }

function send<T extends ImplementedEventType>(world: World, type: T, body: ImplementedEventBodies[T], second: number): void {
  const event = signed(world.owner, {
    teamId: world.teamId, type, body, lamport: world.state.highLamport + 1, prev: world.state.head.eventId,
    at: `2026-03-01T10:00:${String(second).padStart(2, '0')}.000Z`
  });
  const entry = entryOf(event);
  const verdict = applyEntry(world.state, entry);
  assert.equal(verdict.accepted, true, verdict.accepted ? '' : verdict.rejection.reason);
  world.entries.push(entry);
}

const imported = (fields: Partial<ImplementedEventBodies['item.imported']> & Pick<ImplementedEventBodies['item.imported'], 'id' | 'kind'>): ImplementedEventBodies['item.imported'] => (
  { title: fields.id, state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [], ...fields }
);

// Every shape an item can have in this phase: imported at each level, done, held, blocked, cancelled, board-made, with the largest allowed text.
async function itemWorld(): Promise<World> {
  const teamId = newTeamId();
  const owner = await makeActor(teamId);
  const { entries, anchor } = genesisEntries(owner, teamId);
  const world: World = { teamId, owner, anchor, entries, state: reduce(entries, anchor) };
  const longMustHave = 'm'.repeat(600);
  send(world, 'item.imported', imported({ id: 'milestone:v0.9.0', kind: 'milestone', title: 'T'.repeat(200), active: true, source: 'a'.repeat(40) }), 1);
  send(world, 'item.imported', imported({ id: 'phase:90', kind: 'phase', parentId: 'milestone:v0.9.0' }), 2);
  send(world, 'item.imported', imported({ id: 'phase:91', kind: 'phase', parentId: 'milestone:v0.9.0', dependsOn: ['phase:90'] }), 3);
  send(world, 'item.imported', imported({
    id: 'plan:90-01', kind: 'plan', parentId: 'phase:90', state: 'done', summary: true, scope: ['src/a/**', 'docs/x.md'], requirements: ['BOARD-01', 'BOARD-02'],
    mustHaves: [longMustHave, 'Second must-have'], tags: ['gap-closure'], gsd: { phase: '90', plan: '01', wave: 1, file: '.planning/phases/90/90-01-PLAN.md' },
    estimate: { tokens: 30000, confidence: 'high' }
  }), 4);
  send(world, 'item.imported', imported({ id: 'plan:90-02', kind: 'plan', parentId: 'phase:90', dependsOn: ['plan:90-01'], scope: ['src/b/**'], estimate: { tokens: 10000 } }), 5);
  send(world, 'item.imported', imported({ id: 'task:90-01-1', kind: 'task', parentId: 'plan:90-01' }), 6);
  send(world, 'item.updated', { id: 'plan:90-02', changes: { hold: true } }, 7);
  send(world, 'item.created', {
    id: BOARD_ID, kind: 'chore', title: 'Wire the webhook', scope: ['src/services/**'], requirements: ['BOARD-03'], mustHaves: [longMustHave],
    description: 'd'.repeat(2000), estimate: { tokens: 48000, confidence: 'low' }, tags: ['ops']
  }, 8);
  send(world, 'item.blocked', { id: BOARD_ID, reason: 'waiting for the API key' }, 9);
  send(world, 'item.created', { id: OTHER_BOARD_ID, kind: 'bug', title: 'Redirect loop', scope: [], requirements: [], mustHaves: [] }, 10);
  send(world, 'item.cancelled', { id: OTHER_BOARD_ID, reason: 'cannot reproduce' }, 11);
  send(world, 'item.created', { id: THIRD_BOARD_ID, kind: 'spike', title: 'Try the new parser', scope: ['src/parser/**'], requirements: [], mustHaves: [] }, 12);
  send(world, 'item.updated', { id: THIRD_BOARD_ID, changes: { state: 'done' } }, 13);
  return world;
}

function plainOf(state: TeamState): JsonObject {
  return JSON.parse(serialiseState(state)) as JsonObject;
}

test('a state with items serialises and deserialises to the same text and the same hash', async () => {
  const world = await itemWorld();
  assert.equal(world.state.items.size, 9);
  const text = serialiseState(world.state);
  const restored = deserialiseState(JSON.parse(text) as JsonObject, world.anchor);
  assert.equal(serialiseState(restored), text);
  assert.equal(stateHash(restored), stateHash(world.state));
  assert.deepEqual([...restored.items.keys()].sort(), [...world.state.items.keys()].sort());
  const plan = restored.items.get('plan:90-01');
  assert.equal(plan?.mustHaves[0]?.length, 600);
  assert.equal(restored.items.get(BOARD_ID)?.description?.length, 2000);
  assert.equal(restored.items.get('milestone:v0.9.0')?.title.length, 200);
  assert.equal(restored.items.get(BOARD_ID)?.blocked?.reason, 'waiting for the API key');
  assert.equal(restored.items.get('plan:90-02')?.hold, true);
  assert.equal(restored.items.get(OTHER_BOARD_ID)?.state, 'cancelled');
});

test('a signed snapshot file of a state with items loads, and applying the tail after it matches the full replay', async () => {
  const world = await itemWorld();
  const cut = reduce(world.entries, world.anchor);
  const file = parseSnapshotFile(canonicalize(signedSnapshot(world.owner, cut)), world.anchor);
  assert.equal(file.ok, true, file.ok ? '' : file.reason);
  if (file.ok) {
    assert.equal(file.provisional, true);
    assert.equal(serialiseState(file.state), serialiseState(world.state));
  }
});

test('the Phase 60 fixture keeps its recorded state hash and a Phase 60 snapshot still loads', async () => {
  const { entries, anchor } = await phase60Fixture();
  const state = reduce(entries, anchor);
  assert.equal(stateHash(state), 'e41fe7cbcc4fc089a0f07a373835e3388a20d76e6fe235cc0121204863e14408');
  assert.equal(serialiseState(deserialiseState(snapshotBody(state).state, anchor)), serialiseState(state));
});

// ---- hostile items -----------------------------------------------------------------------------------------------------------------------

type PlainItem = Record<string, unknown>;
interface Hostile { name: string; change(items: Array<[string, PlainItem]>): void }

function pair(items: Array<[string, PlainItem]>, id: string): PlainItem {
  const found = items.find(([key]) => key === id);
  assert.ok(found !== undefined, id);
  return (found as [string, PlainItem])[1];
}

const HOSTILE: Hostile[] = [
  { name: 'an extra key on an item', change: (items) => { pair(items, 'plan:90-02').extra = 1; } },
  { name: 'a claim id, which only a claim phase may store', change: (items) => { pair(items, 'plan:90-02').claimId = 'clm-1'; } },
  { name: 'a missing required key', change: (items) => { delete pair(items, 'plan:90-02').scope; } },
  { name: 'an imported plan that says it came from the board', change: (items) => { pair(items, 'plan:90-02').origin = 'board'; } },
  { name: 'an origin outside import and board', change: (items) => { pair(items, 'plan:90-02').origin = 'elsewhere'; } },
  { name: 'a board item that says it was imported', change: (items) => { pair(items, BOARD_ID).origin = 'import'; } },
  { name: 'a kind that disagrees with an imported id', change: (items) => { pair(items, 'plan:90-02').kind = 'phase'; } },
  { name: 'a board kind on a board id that imports use', change: (items) => { pair(items, BOARD_ID).kind = 'plan'; } },
  { name: 'a kind outside the item kinds', change: (items) => { pair(items, 'plan:90-02').kind = 'epic'; } },
  { name: 'a title over 200 characters', change: (items) => { pair(items, 'plan:90-02').title = 'x'.repeat(201); } },
  { name: 'an empty title', change: (items) => { pair(items, 'plan:90-02').title = '  '; } },
  { name: 'a title with a control character', change: (items) => { pair(items, 'plan:90-02').title = 'bad\u0007title'; } },
  { name: 'a must-have over 600 characters', change: (items) => { pair(items, 'plan:90-01').mustHaves = ['m'.repeat(601)]; } },
  { name: 'more than 16 must-haves', change: (items) => { pair(items, 'plan:90-01').mustHaves = Array.from({ length: 17 }, () => 'one'); } },
  { name: 'a description over 2000 characters', change: (items) => { pair(items, BOARD_ID).description = 'd'.repeat(2001); } },
  { name: 'a description on an imported item', change: (items) => { pair(items, 'plan:90-02').description = 'imports have none'; } },
  { name: 'a scope entry that escapes the project', change: (items) => { pair(items, 'plan:90-02').scope = ['../outside']; } },
  { name: 'more than 64 scope entries', change: (items) => { pair(items, 'plan:90-02').scope = Array.from({ length: 65 }, (_unused, index) => `src/${index}`); } },
  { name: 'a requirement id of the wrong shape', change: (items) => { pair(items, 'plan:90-01').requirements = ['not a requirement']; } },
  { name: 'a dependency on a task', change: (items) => { pair(items, 'plan:90-02').dependsOn = ['task:90-01-1']; } },
  { name: 'a dependency on a board item', change: (items) => { pair(items, 'plan:90-02').dependsOn = [BOARD_ID]; } },
  { name: 'dependencies on a board item', change: (items) => { pair(items, BOARD_ID).dependsOn = ['plan:90-01']; } },
  { name: 'a tag of the wrong shape', change: (items) => { pair(items, 'plan:90-01').tags = ['Not A Tag']; } },
  { name: 'a state outside the item states', change: (items) => { pair(items, 'plan:90-02').state = 'finished'; } },
  { name: 'an estimate of zero tokens', change: (items) => { pair(items, 'plan:90-02').estimate = { tokens: 0 }; } },
  { name: 'an estimate with an extra key', change: (items) => { pair(items, 'plan:90-02').estimate = { tokens: 5, nanoUsd: 1 }; } },
  { name: 'a blocked record with a missing since', change: (items) => { pair(items, BOARD_ID).blocked = { reason: 'r', by: 'mbr-0123456789abcdef' }; } },
  { name: 'a blocked record by a non-member id', change: (items) => { pair(items, BOARD_ID).blocked = { reason: 'r', by: 'anyone', since: '2026-03-01T10:00:09.000Z' }; } },
  { name: 'a state time that is not a time', change: (items) => { pair(items, 'plan:90-02').stateSince = 'yesterday'; } },
  { name: 'a hold flag stored as false', change: (items) => { pair(items, 'plan:90-02').hold = false; } },
  { name: 'a summary flag on a phase', change: (items) => { pair(items, 'phase:90').summary = true; } },
  { name: 'an active flag on a plan', change: (items) => { pair(items, 'plan:90-02').active = true; } },
  { name: 'a source commit on a plan', change: (items) => { pair(items, 'plan:90-02').source = 'a'.repeat(40); } },
  { name: 'a source that is not a commit', change: (items) => { pair(items, 'milestone:v0.9.0').source = 'main'; } },
  { name: 'a parent on a milestone', change: (items) => { pair(items, 'milestone:v0.9.0').parentId = 'phase:90'; } },
  { name: 'a plan without a parent', change: (items) => { delete pair(items, 'plan:90-02').parentId; } },
  { name: 'a plan whose parent is not on the board', change: (items) => { pair(items, 'plan:90-02').parentId = 'phase:77'; } },
  { name: 'a plan whose parent has the wrong kind', change: (items) => { pair(items, 'plan:90-02').parentId = 'milestone:v0.9.0'; } },
  { name: 'a parent on a board item', change: (items) => { pair(items, BOARD_ID).parentId = 'phase:90'; } },
  { name: 'a board item without its author', change: (items) => { delete pair(items, BOARD_ID).createdBy; } },
  { name: 'an author on an imported item', change: (items) => { pair(items, 'plan:90-02').createdBy = 'mbr-0123456789abcdef'; } },
  { name: 'a gsd reference of the wrong shape', change: (items) => { pair(items, 'plan:90-01').gsd = { phase: 'ninety' }; } },
  { name: 'a pair whose key is not the item id', change: (items) => { (items.find(([key]) => key === 'plan:90-02') as [string, PlainItem])[0] = 'plan:90-03'; } },
  { name: 'the same item twice', change: (items) => { items.push(['plan:90-02', { ...pair(items, 'plan:90-02') }]); } },
  { name: 'items out of their canonical order', change: (items) => { items.reverse(); } }
];

function withItems(plain: JsonObject, change: (items: Array<[string, PlainItem]>) => void): JsonObject {
  const copy = JSON.parse(JSON.stringify(plain)) as JsonObject;
  const items = copy.items as unknown as Array<[string, PlainItem]>;
  change(items);
  return copy;
}

test('each malformed item is refused as an invalid snapshot, directly and inside a validly signed snapshot file', async () => {
  const world = await itemWorld();
  const plain = plainOf(world.state);
  for (const hostile of HOSTILE) {
    const tampered = withItems(plain, hostile.change);
    assert.throws(() => deserialiseState(tampered, world.anchor), (error: Error) => error.message.startsWith(INVALID_ITEMS) || (hostile.name === 'items out of their canonical order' && error.message === 'invalid snapshot: state'), hostile.name);
    const file = parseSnapshotFile(canonicalize(signedSnapshot(world.owner, world.state, { state: tampered })), world.anchor);
    assert.equal(file.ok, false, hostile.name);
    if (!file.ok) assert.ok(file.reason.startsWith('invalid snapshot: '), `${hostile.name}: ${file.reason}`);
  }
  // The client falls back to replaying the log from genesis, which the hostile snapshot cannot change.
  assert.equal(stateHash(reduce(world.entries, world.anchor)), stateHash(world.state));
});

test('claims, leases and the integration queue must still be empty in a snapshot that carries items', async () => {
  const world = await itemWorld();
  const plain = plainOf(world.state);
  for (const key of ['claims', 'leases', 'allocations', 'integrationQueue']) {
    const tampered = { ...plain, [key]: [['x', {}]] } as unknown as JsonObject;
    assert.throws(() => deserialiseState(tampered, world.anchor), new RegExp(`invalid snapshot: ${key}`), key);
  }
});

test('an item list that is not a list is refused', async () => {
  const world = await itemWorld();
  const plain = plainOf(world.state);
  for (const value of [null, {}, 'items', 7, [['plan:90-02']], [['plan:90-02', 'text']], [[1, {}]], ['plan:90-02']]) {
    assert.throws(() => deserialiseState({ ...plain, items: value } as unknown as JsonObject, world.anchor), new RegExp(INVALID_ITEMS), JSON.stringify(value));
  }
});

test('over seeded random logs with work items a snapshot at a random cut plus the tail equals the full replay, also through the signed file', async () => {
  for (let index = 0; index < 12; index += 1) {
    const seed = 4001 + index * 131;
    const scenario = await buildScenario(seed, 70, { items: true });
    const full = reduce(scenario.entries, scenario.anchor);
    assert.ok(full.items.size > 0, `seed ${seed}: the scenario carries items`);
    const random = mulberry32(seed ^ 0x51ed270b);
    const cut = 2 + Math.floor(random() * (scenario.entries.length - 2));
    const head = reduce(scenario.entries.slice(0, cut), scenario.anchor);
    const restored = deserialiseState(snapshotBody(head).state, scenario.anchor);
    assert.equal(stateHash(restored), stateHash(head), `seed ${seed}: hash at ${cut}`);
    for (const entry of scenario.entries.slice(cut)) applyEntry(restored, entry);
    assert.equal(serialiseState(restored), serialiseState(full), `seed ${seed}: snapshot at ${cut} plus tail`);
    const loaded = parseSnapshotFile(canonicalize(signedSnapshot(scenario.owner, head)), scenario.anchor);
    assert.equal(loaded.ok, true, `seed ${seed}: ${loaded.ok ? '' : loaded.reason}`);
  }
});

test('a snapshot of another team is still refused as such beside the item rules', async () => {
  const world = await itemWorld();
  const file = parseSnapshotFile(canonicalize(signedSnapshot(world.owner, world.state, { teamId: newTeamId() })), world.anchor);
  assert.deepEqual(file, { ok: false, reason: SNAPSHOT_REASONS.wrongTeam });
});
