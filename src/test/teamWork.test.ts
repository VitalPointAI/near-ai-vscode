// Computed ready, columns, lane progress and the ready count (D-08, D-10, D-11, D-17): the two-clone tracer over real git, the truth table of
// every reason a card is not ready, and progress arithmetic. Everything here is derived from the log, so two clients that replay the same log
// must show the same board. The item history and seeded determinism tests follow in the same file.
import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import { defaultTeamPolicy } from '../domain/team/policy';
import { applyEntry, cloneState, reduce, stateHash, teamMaterializer } from '../domain/team/materialize';
import { ItemHistory, MAX_HISTORY_PER_ITEM } from '../domain/team/itemHistory';
import type { CommittedEvent, GenesisAnchor, ImplementedEventBodies, ImplementedEventType, ItemState, TeamFile, TeamState, WorkItem } from '../domain/team/types';
import { BOARD_COLUMNS, countReady, effectiveColumn, isCard, progressOf, readiness } from '../domain/team/work';
import type { NotReadyReason } from '../domain/team/work';
import { TeamLog, buildGenesisEvents } from '../team/eventLog';
import type { EventIntent, TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { emailHash, newTeamId } from '../team/identity';
import { canonicalTeamFile } from '../team/teamFile';
import { buildScenario, entryOf, genesisEntries, makeActor, mulberry32, signed } from './helpers/teamEvents';
import { createOwner, createTeamFixture } from './helpers/teamHarness';
import type { TeamFixture } from './helpers/teamHarness';

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

async function seedTeam(fixture: TeamFixture, now: () => Date): Promise<{ anchor: GenesisAnchor; a: Client }> {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const genesis = buildGenesisEvents({
    teamId, teamName: 'Ready team', owner: { memberId: owner.memberId, name: 'Owner Test', emailHashes: [emailHash(teamId, 'owner@example.invalid')] },
    identity: owner.identity, policy: defaultTeamPolicy(), now
  });
  const teamFile: TeamFile = {
    version: 1, teamId, name: 'Ready team', coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote: 'origin' },
    genesis: { eventId: genesis.anchor.eventId, ownerDevice: genesis.anchor.ownerDevice }, createdAt: '2026-02-03T04:05:06.000Z'
  };
  const signer: TeamSigner = { identity: owner.identity, memberId: owner.memberId };
  const a = clientFor(fixture, 'a', genesis.anchor, now, signer);
  const written = await a.transport.append(async () => genesis.events, { genesis: { teamFileText: canonicalTeamFile(teamFile) } });
  assert.equal(written.ok, true);
  return { anchor: genesis.anchor, a };
}

type ImportedBody = Extract<EventIntent, { type: 'item.imported' }>['body'];

function importedBody(fields: Partial<ImportedBody> & Pick<ImportedBody, 'id' | 'kind'>): ImportedBody {
  return { title: fields.id, state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [], ...fields };
}

test('two clones derive the same ready column and the same ready count as a dependency is marked done', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture, tickingClock());
    const imported = await seed.a.log.append(() => [
      { type: 'item.imported', body: importedBody({ id: 'milestone:v0.9.0', kind: 'milestone', title: 'Version 0.9.0' }) },
      { type: 'item.imported', body: importedBody({ id: 'phase:90', kind: 'phase', title: 'Phase 90', parentId: 'milestone:v0.9.0' }) },
      { type: 'item.imported', body: importedBody({ id: 'plan:90-01', kind: 'plan', title: 'First plan', parentId: 'phase:90', scope: ['src/a/**'], estimate: { tokens: 30000 } }) },
      { type: 'item.imported', body: importedBody({ id: 'plan:90-02', kind: 'plan', title: 'Second plan', parentId: 'phase:90', scope: ['src/b/**'], estimate: { tokens: 10000 }, dependsOn: ['plan:90-01'] }) }
    ]);
    assert.equal(imported.ok, true, imported.ok ? '' : imported.reason);
    const b = clientFor(fixture, 'b', seed.anchor, tickingClock());
    assert.deepEqual((await b.log.sync()).rejected, []);

    const columnsOf = (state: TeamState): Record<string, string> => Object.fromEntries(['plan:90-01', 'plan:90-02'].map((id) => [id, effectiveColumn(state.items, state.items.get(id) as WorkItem)]));
    for (const state of [seed.a.log.state(), b.log.state()]) {
      assert.deepEqual(columnsOf(state), { 'plan:90-01': 'ready', 'plan:90-02': 'backlog' });
      assert.deepEqual(readiness(state.items, 'plan:90-02'), { ready: false, reasons: ['dependency-open'] });
      assert.deepEqual(readiness(state.items, 'plan:90-01'), { ready: true, reasons: [] });
      assert.equal(countReady(state.items), 1);
    }

    const done = await seed.a.log.append(() => [{ type: 'item.updated', body: { id: 'plan:90-01', changes: { state: 'done' } } }]);
    assert.equal(done.ok, true, done.ok ? '' : done.reason);
    assert.deepEqual((await b.log.sync()).rejected, []);
    for (const state of [seed.a.log.state(), b.log.state()]) {
      assert.deepEqual(columnsOf(state), { 'plan:90-01': 'done', 'plan:90-02': 'ready' });
      assert.equal(countReady(state.items), 1);
      assert.deepEqual(progressOf(state.items, 'phase:90'), { percent: 75, done: 1, total: 2 });
      assert.deepEqual(progressOf(state.items, 'milestone:v0.9.0'), { percent: 75, done: 1, total: 2 });
    }
  });
});

// ---- truth table -------------------------------------------------------------------------------------------------------------------------

const SINCE = '2026-02-03T04:05:06.000Z';

function item(fields: Partial<WorkItem> & Pick<WorkItem, 'id' | 'kind'>): WorkItem {
  return { title: fields.id, dependsOn: [], scope: [], requirements: [], mustHaves: [], state: 'backlog', tags: [], origin: 'import', stateSince: SINCE, ...fields };
}

function board(...entries: WorkItem[]): Map<string, WorkItem> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

function readyPlan(fields: Partial<WorkItem> & Pick<WorkItem, 'id'>): WorkItem {
  return item({ kind: 'plan', parentId: 'phase:90', scope: ['src/**'], estimate: { tokens: 1000 }, ...fields });
}

const MILESTONE = item({ id: 'milestone:v0.9.0', kind: 'milestone' });
const PHASE_90 = item({ id: 'phase:90', kind: 'phase', parentId: 'milestone:v0.9.0' });

function reasonsOf(items: Map<string, WorkItem>, id: string): NotReadyReason[] {
  return readiness(items, id).reasons;
}

test('an unclaimed plan with an estimate, a scope and nothing in the way is ready', () => {
  const items = board(MILESTONE, PHASE_90, readyPlan({ id: 'plan:90-01' }));
  assert.deepEqual(readiness(items, 'plan:90-01'), { ready: true, reasons: [] });
  assert.equal(effectiveColumn(items, items.get('plan:90-01') as WorkItem), 'ready');
});

test('each reason is produced alone', () => {
  const cases: Array<[NotReadyReason, WorkItem, WorkItem[]]> = [
    ['not-unclaimed', readyPlan({ id: 'plan:90-01', state: 'claimed' }), []],
    ['held', readyPlan({ id: 'plan:90-01', hold: true }), []],
    ['blocked', readyPlan({ id: 'plan:90-01', blocked: { reason: 'waiting', by: 'mbr-0123456789abcdef', since: SINCE } }), []],
    ['no-estimate', (() => { const { estimate: _unused, ...rest } = readyPlan({ id: 'plan:90-01' }); return rest as WorkItem; })(), []],
    ['no-scope', readyPlan({ id: 'plan:90-01', scope: [] }), []],
    ['dependency-open', readyPlan({ id: 'plan:90-01', dependsOn: ['plan:90-00'] }), [readyPlan({ id: 'plan:90-00' })]],
    ['dependency-missing', readyPlan({ id: 'plan:90-01', dependsOn: ['plan:90-00'] }), []],
    ['phase-held', readyPlan({ id: 'plan:90-01' }), [{ ...PHASE_90, hold: true }]]
  ];
  for (const [reason, target, extras] of cases) {
    const items = board(MILESTONE, ...(extras.some((extra) => extra.id === 'phase:90') ? [] : [PHASE_90]), ...extras, target);
    assert.deepEqual(readiness(items, 'plan:90-01'), { ready: false, reasons: [reason] }, reason);
  }
});

test('phase-dependency-open comes from an open plan in a phase the item phase depends on', () => {
  const phase91 = item({ id: 'phase:91', kind: 'phase', parentId: 'milestone:v0.9.0', dependsOn: ['phase:90'] });
  const items = board(MILESTONE, PHASE_90, phase91, readyPlan({ id: 'plan:90-01' }), readyPlan({ id: 'plan:91-01', parentId: 'phase:91' }));
  assert.deepEqual(readiness(items, 'plan:91-01'), { ready: false, reasons: ['phase-dependency-open'] });

  const finished = board(MILESTONE, PHASE_90, phase91, readyPlan({ id: 'plan:90-01', state: 'done' }), readyPlan({ id: 'plan:91-01', parentId: 'phase:91' }));
  assert.deepEqual(readiness(finished, 'plan:91-01'), { ready: true, reasons: [] });

  const cancelledOnly = board(MILESTONE, PHASE_90, phase91, readyPlan({ id: 'plan:90-01', state: 'done' }), readyPlan({ id: 'plan:90-02', state: 'cancelled' }), readyPlan({ id: 'plan:91-01', parentId: 'phase:91' }));
  assert.deepEqual(readiness(cancelledOnly, 'plan:91-01'), { ready: true, reasons: [] }, 'a cancelled plan does not hold the next phase back');

  const absent = board(MILESTONE, phase91, readyPlan({ id: 'plan:91-01', parentId: 'phase:91' }));
  assert.deepEqual(readiness(absent, 'plan:91-01'), { ready: false, reasons: ['dependency-missing'] }, 'a phase that is not on the board cannot be proven complete');
});

test('reasons combine, are sorted and carry no duplicates', () => {
  const stuck = readyPlan({
    id: 'plan:90-02', state: 'in-progress', hold: true, scope: [], dependsOn: ['plan:90-00', 'plan:90-09', 'plan:90-10'],
    blocked: { reason: 'waiting', by: 'mbr-0123456789abcdef', since: SINCE }
  });
  const { estimate: _unused, ...withoutEstimate } = stuck;
  const items = board(MILESTONE, { ...PHASE_90, hold: true }, readyPlan({ id: 'plan:90-00' }), readyPlan({ id: 'plan:90-09', state: 'cancelled' }), withoutEstimate as WorkItem);
  const result = readiness(items, 'plan:90-02');
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ['blocked', 'dependency-missing', 'dependency-open', 'held', 'no-estimate', 'no-scope', 'not-unclaimed', 'phase-held']);
  assert.deepEqual([...result.reasons].sort(), result.reasons);
});

test('a cancelled dependency keeps the dependent open, and a dependency that is a phase must have every plan done', () => {
  const cancelled = board(MILESTONE, PHASE_90, readyPlan({ id: 'plan:90-00', state: 'cancelled' }), readyPlan({ id: 'plan:90-01', dependsOn: ['plan:90-00'] }));
  assert.deepEqual(reasonsOf(cancelled, 'plan:90-01'), ['dependency-open']);

  const phase89 = item({ id: 'phase:89', kind: 'phase', parentId: 'milestone:v0.9.0' });
  const open = board(MILESTONE, phase89, PHASE_90, readyPlan({ id: 'plan:89-01', parentId: 'phase:89' }), readyPlan({ id: 'plan:90-01', dependsOn: ['phase:89'] }));
  assert.deepEqual(reasonsOf(open, 'plan:90-01'), ['dependency-open']);
  const closed = board(MILESTONE, phase89, PHASE_90, readyPlan({ id: 'plan:89-01', parentId: 'phase:89', state: 'done' }), readyPlan({ id: 'plan:90-01', dependsOn: ['phase:89'] }));
  assert.deepEqual(reasonsOf(closed, 'plan:90-01'), []);
});

test('a stored ready item that is held goes to the backlog column, and blocked is never a column', () => {
  const held = readyPlan({ id: 'plan:90-01', state: 'ready', hold: true });
  const blocked = readyPlan({ id: 'plan:90-02', blocked: { reason: 'waiting', by: 'mbr-0123456789abcdef', since: SINCE } });
  const items = board(MILESTONE, PHASE_90, held, blocked);
  assert.equal(effectiveColumn(items, held), 'backlog');
  assert.equal(effectiveColumn(items, blocked), 'backlog');
  assert.ok(!BOARD_COLUMNS.includes('blocked' as never));
  assert.deepEqual(BOARD_COLUMNS, ['backlog', 'ready', 'claimed', 'in-progress', 'in-review', 'integrating', 'done', 'cancelled']);
});

test('the column of a settled or claimed item is its own state', () => {
  const states: ItemState[] = ['claimed', 'in-progress', 'in-review', 'integrating', 'done', 'cancelled'];
  for (const state of states) {
    const entry = readyPlan({ id: 'plan:90-01', state });
    assert.equal(effectiveColumn(board(MILESTONE, PHASE_90, entry), entry), state);
  }
  const stored = readyPlan({ id: 'plan:90-01', state: 'ready' });
  assert.equal(effectiveColumn(board(MILESTONE, PHASE_90, stored), stored), 'ready');
});

test('only plans and board items are cards; milestones, phases and tasks are not', () => {
  const task = item({ id: 'task:90-01-1', kind: 'task', parentId: 'plan:90-01' });
  const created = item({ id: 'item:01ARZ3NDEKTSV4RRFFQ69G5FAV', kind: 'bug', origin: 'board', createdBy: 'mbr-0123456789abcdef' });
  assert.deepEqual([MILESTONE, PHASE_90, task, readyPlan({ id: 'plan:90-01' }), created].map(isCard), [false, false, false, true, true]);
  const items = board(MILESTONE, PHASE_90, task, created);
  assert.deepEqual(readiness(items, 'phase:90'), { ready: false, reasons: [] });
  assert.deepEqual(readiness(items, 'item:01ARZ3NDEKTSV4RRFFQ69G5FAW'), { ready: false, reasons: [] }, 'an unknown id is not ready and has no reasons');
  assert.deepEqual(reasonsOf(items, created.id), ['no-estimate', 'no-scope']);
});

test('countReady counts plans and board items in the ready column', () => {
  const created = item({ id: 'item:01ARZ3NDEKTSV4RRFFQ69G5FAV', kind: 'chore', origin: 'board', createdBy: 'mbr-0123456789abcdef', scope: ['docs/**'], estimate: { tokens: 500 } });
  const items = board(MILESTONE, PHASE_90, readyPlan({ id: 'plan:90-01' }), readyPlan({ id: 'plan:90-02', hold: true }), readyPlan({ id: 'plan:90-03', state: 'done' }), created);
  assert.equal(countReady(items), 2);
  assert.equal(countReady(new Map()), 0);
});

test('progress is the done share of estimate tokens, floored, with cancelled plans left out of both sides', () => {
  const items = board(
    MILESTONE, PHASE_90,
    readyPlan({ id: 'plan:90-01', estimate: { tokens: 30000 }, state: 'done' }),
    readyPlan({ id: 'plan:90-02', estimate: { tokens: 10000 } }),
    readyPlan({ id: 'plan:90-03', estimate: { tokens: 99999 }, state: 'cancelled' })
  );
  assert.deepEqual(progressOf(items, 'phase:90'), { percent: 75, done: 1, total: 2 });
  const thirds = board(
    MILESTONE, PHASE_90,
    readyPlan({ id: 'plan:90-01', estimate: { tokens: 1 }, state: 'done' }), readyPlan({ id: 'plan:90-02', estimate: { tokens: 2 } })
  );
  assert.equal(progressOf(thirds, 'phase:90').percent, 33, 'floor, not round');
});

test('progress falls back to plan counts when no plan has an estimate, and an empty group is zero', () => {
  const bare = (id: string, state: ItemState): WorkItem => { const { estimate: _unused, ...rest } = readyPlan({ id, state }); return rest as WorkItem; };
  const items = board(MILESTONE, PHASE_90, bare('plan:90-01', 'done'), bare('plan:90-02', 'backlog'), bare('plan:90-03', 'backlog'), bare('plan:90-04', 'cancelled'));
  assert.deepEqual(progressOf(items, 'phase:90'), { percent: 33, done: 1, total: 3 });
  assert.deepEqual(progressOf(board(MILESTONE, PHASE_90), 'phase:90'), { percent: 0, done: 0, total: 0 });
  assert.deepEqual(progressOf(board(MILESTONE), 'phase:404'), { percent: 0, done: 0, total: 0 });
});

test('a milestone aggregates the plans of every phase under it and ignores other milestones', () => {
  const other = item({ id: 'milestone:v0.8.0', kind: 'milestone' });
  const phase80 = item({ id: 'phase:80', kind: 'phase', parentId: 'milestone:v0.8.0' });
  const phase91 = item({ id: 'phase:91', kind: 'phase', parentId: 'milestone:v0.9.0' });
  const items = board(
    MILESTONE, other, PHASE_90, phase91, phase80,
    readyPlan({ id: 'plan:90-01', estimate: { tokens: 10000 }, state: 'done' }),
    readyPlan({ id: 'plan:91-01', parentId: 'phase:91', estimate: { tokens: 30000 } }),
    readyPlan({ id: 'plan:80-01', parentId: 'phase:80', estimate: { tokens: 500000 }, state: 'done' })
  );
  assert.deepEqual(progressOf(items, 'milestone:v0.9.0'), { percent: 25, done: 1, total: 2 });
  assert.deepEqual(progressOf(items, 'milestone:v0.8.0'), { percent: 100, done: 1, total: 1 });
});

test('progress cannot overflow on very large estimates', () => {
  const huge = 1_000_000_000_000;
  const entries = Array.from({ length: 200 }, (_, index) => readyPlan({ id: `plan:90-${String(index + 1).padStart(2, '0')}`, estimate: { tokens: huge }, ...(index < 100 ? { state: 'done' as ItemState } : {}) }));
  assert.deepEqual(progressOf(board(MILESTONE, PHASE_90, ...entries), 'phase:90'), { percent: 50, done: 100, total: 200 });
});

// ---- item history (A9, D-18) -------------------------------------------------------------------------------------------------------------

interface HistoryWorld { state: TeamState; entries: CommittedEvent[]; send<T extends ImplementedEventType>(type: T, body: ImplementedEventBodies[T], second?: number): CommittedEvent }

async function historyWorld(): Promise<HistoryWorld> {
  const teamId = newTeamId();
  const owner = await makeActor(teamId);
  const { entries: genesis, anchor } = genesisEntries(owner, teamId);
  const state = reduce(genesis, anchor);
  const entries: CommittedEvent[] = [...genesis.map((entry) => ({ ...entry, verdict: { accepted: true as const } }))];
  let tick = 0;
  const send = <T extends ImplementedEventType>(type: T, body: ImplementedEventBodies[T], second?: number): CommittedEvent => {
    tick += 1;
    const event = signed(owner, { teamId, type, body, lamport: state.highLamport + 1, prev: state.head.eventId, at: `2026-03-01T10:${String(Math.floor((second ?? tick) / 60)).padStart(2, '0')}:${String((second ?? tick) % 60).padStart(2, '0')}.000Z` });
    const entry = entryOf(event);
    entry.verdict = applyEntry(state, entry);
    entries.push(entry);
    return entry;
  };
  return { state, entries, send };
}

const PLAN_BODY = (id: string, parentId: string): ImplementedEventBodies['item.imported'] => ({
  id, kind: 'plan', title: id, state: 'backlog', dependsOn: [], scope: ['src/**'], requirements: [], mustHaves: [], tags: [], parentId, estimate: { tokens: 1000 }
});

test('history keeps accepted item events newest first with reason or changed keys, and ignores everything else', async () => {
  const world = await historyWorld();
  world.send('item.imported', { id: 'milestone:v1.0.0', kind: 'milestone', title: 'M', state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [] });
  world.send('item.imported', { id: 'phase:1', kind: 'phase', title: 'P', state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [], parentId: 'milestone:v1.0.0' });
  const imported = world.send('item.imported', PLAN_BODY('plan:1-01', 'phase:1'));
  const blocked = world.send('item.blocked', { id: 'plan:1-01', reason: 'waiting for review' });
  world.send('item.unblocked', { id: 'plan:1-01' });
  const updated = world.send('item.updated', { id: 'plan:1-01', changes: { title: 'Renamed', tags: ['x'] } });
  world.send('member.availability', { availability: 'focus' });
  const forged = world.send('item.blocked', { id: 'plan:1-99', reason: 'no such item' });
  assert.equal(forged.verdict?.accepted, false);
  const cancelled = world.send('item.cancelled', { id: 'plan:1-01', reason: 'dropped' });

  const history = new ItemHistory();
  history.record(world.entries);
  const entries = history.forItem('plan:1-01');
  assert.deepEqual(entries.map((entry) => entry.type), ['item.cancelled', 'item.updated', 'item.unblocked', 'item.blocked', 'item.imported']);
  assert.equal(entries[0]?.eventId, (JSON.parse(cancelled.text) as { id: string }).id);
  assert.equal(entries[0]?.reason, 'dropped');
  assert.equal(entries[3]?.reason, 'waiting for review');
  assert.deepEqual(entries[1]?.changed, ['tags', 'title']);
  assert.equal(entries[1]?.reason, undefined);
  assert.equal(entries[1]?.at, (JSON.parse(updated.text) as { at: string }).at);
  assert.equal(entries[3]?.author, (JSON.parse(blocked.text) as { author: string }).author);
  assert.equal(entries[4]?.eventId, (JSON.parse(imported.text) as { id: string }).id);
  assert.deepEqual(history.forItem('plan:1-99'), [], 'a rejected event leaves no history for an item that does not exist');
  assert.deepEqual(history.forItem('phase:1').map((entry) => entry.type), ['item.imported']);
  assert.deepEqual(history.forItem('nothing'), []);
});

test('history holds at most 50 entries per item, keeps the newest, and recording the same entries again adds nothing', async () => {
  const world = await historyWorld();
  world.send('item.imported', { id: 'milestone:v1.0.0', kind: 'milestone', title: 'M', state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [] });
  world.send('item.imported', { id: 'phase:1', kind: 'phase', title: 'P', state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [], parentId: 'milestone:v1.0.0' });
  world.send('item.imported', PLAN_BODY('plan:1-01', 'phase:1'));
  const sent: string[] = [];
  for (let index = 0; index < 120; index += 1) {
    const entry = world.send('item.updated', { id: 'plan:1-01', changes: { title: `Title ${index}` } });
    sent.push((JSON.parse(entry.text) as { id: string }).id);
  }
  const history = new ItemHistory();
  history.record(world.entries);
  history.record(world.entries);
  const entries = history.forItem('plan:1-01');
  assert.equal(MAX_HISTORY_PER_ITEM, 50);
  assert.equal(entries.length, 50);
  assert.deepEqual(entries.map((entry) => entry.eventId), sent.slice(70).reverse());
  entries.pop();
  assert.equal(history.forItem('plan:1-01').length, 50, 'the returned list is a copy');
});

test('history is not part of the state: it holds plain entries, never the state or its items', async () => {
  const world = await historyWorld();
  world.send('item.imported', { id: 'milestone:v1.0.0', kind: 'milestone', title: 'M', state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [] });
  const before = stateHash(world.state);
  const history = new ItemHistory();
  history.record(world.entries);
  assert.equal(stateHash(world.state), before);
  assert.ok(!('history' in world.state));
  const entry = history.forItem('milestone:v1.0.0')[0];
  assert.deepEqual(Object.keys(entry as object).sort(), ['at', 'author', 'eventId', 'type']);
});

// ---- determinism with item events (D-11) -------------------------------------------------------------------------------------------------

test('roster-only seeded scenarios keep their pinned event sequence now that item events exist', async () => {
  const { createHash } = await import('node:crypto');
  const sequenceOf = async (seed: number): Promise<string> => {
    const scenario = await buildScenario(seed, 60);
    return createHash('sha256').update(scenario.entries.map((entry) => { try { return (JSON.parse(entry.text) as { type: string }).type; } catch { return entry.kind; } }).join(',')).digest('hex').slice(0, 16);
  };
  assert.equal(await sequenceOf(1001), '4ca013cf0ba0efbf');
  assert.equal(await sequenceOf(9920), '72e409e2ea21a256');
});

test('over 20 seeded logs that mix roster and item events, any commit batching gives the same state hash and the same readiness for every item', async () => {
  let readyTotal = 0;
  const seen = new Set<string>();
  for (let index = 0; index < 20; index += 1) {
    const seed = 2003 + index * 977;
    const scenario = await buildScenario(seed, 70, { items: true });
    const full = reduce(scenario.entries, scenario.anchor);
    assert.ok(full.items.size > 0, `seed ${seed}: the log carries items`);
    for (const entry of scenario.valid) {
      try { const type = (JSON.parse(entry.text) as { type: string }).type; if (type.startsWith('item.')) seen.add(type); } catch { /* snapshot placeholder files are not events */ }
    }
    const fullHash = stateHash(full);
    const expected = new Map([...full.items.keys()].map((id) => [id, readiness(full.items, id)]));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const random = mulberry32(seed * 31 + attempt);
      let live = reduce([], scenario.anchor);
      for (let position = 0; position < scenario.entries.length;) {
        const size = 1 + Math.floor(random() * (attempt === 0 ? 1 : 12));
        for (const entry of scenario.entries.slice(position, position + size)) applyEntry(live, entry);
        position += size;
        live = cloneState(live);
      }
      assert.equal(stateHash(live), fullHash, `seed ${seed} batching ${attempt}: state hash`);
      for (const [id, value] of expected) assert.deepEqual(readiness(live.items, id), value, `seed ${seed} batching ${attempt}: ${id}`);
      assert.equal(countReady(live.items), countReady(full.items), `seed ${seed} batching ${attempt}: ready count`);
    }
    readyTotal += countReady(full.items);
    const validOnly = reduce(scenario.valid, scenario.anchor);
    assert.equal(stateHash(validOnly), fullHash, `seed ${seed}: forged entries leave no trace in the hashed state`);
  }
  assert.ok(readyTotal > 0, 'at least one log reaches a ready card');
  for (const type of ['item.imported', 'item.created', 'item.blocked', 'item.updated']) assert.ok(seen.has(type), `the scenarios exercise ${type}`);
});
