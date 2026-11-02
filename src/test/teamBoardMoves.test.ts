// The move table (D-12, D-13, D-16, BOARD-03): every move, every card state and every viewer role, with the exact refusal words the board shows.
// planMove is the one function behind the menu, the drop targets and the write path, so these tables pin all three at once. The expected answers
// are written out as data here, never computed by the code under test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MOVE_KEYS, availableMoves, buildBoardModel, columnMove, planMove } from '../domain/team/board';
import type { MoveIntent, MoveKey } from '../domain/team/board';
import { REFUSALS, staleRefusal } from '../domain/team/boardText';
import { applyEntry, cloneState } from '../domain/team/materialize';
import { findSecrets } from '../domain/team/secrets';
import type { ImplementedEventType } from '../domain/team/types';
import { BOARD_COLUMNS } from '../domain/team/work';
import type { BoardColumn } from '../domain/team/work';
import type { EventIntent } from '../team/eventLog';
import { addFixtureMember, entryOf, makeActor, signed } from './helpers/teamEvents';
import type { TestActor } from './helpers/teamEvents';
import { CHORE_ID, boardWorld, importedBody, seedStandardBoard } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';

// ---- the world: one card in each state a move can start from ---------------------------------------------------------------------------------

const PLAN_BASE = { kind: 'plan' as const, parentId: 'phase:91', scope: ['src/c/**'], estimate: { tokens: 5000 } };

async function moveWorld(): Promise<BoardWorld> {
  const world = await boardWorld();
  seedStandardBoard(world);
  const { owner, lead } = world;
  for (const number of ['01', '02', '03', '04', '05', '06']) world.accept(owner, 'item.imported', importedBody({ ...PLAN_BASE, id: `plan:91-${number}`, title: `Plan 91-${number}` }));
  world.accept(owner, 'item.imported', importedBody({ kind: 'plan', parentId: 'phase:91', id: 'plan:91-07', title: 'Plan 91-07' }));
  world.accept(owner, 'item.imported', importedBody({ kind: 'plan', parentId: 'phase:91', id: 'plan:91-08', title: 'Plan 91-08', scope: ['src/c/**'] }));
  world.accept(owner, 'item.updated', { id: 'plan:91-02', changes: { hold: true } });
  world.accept(lead, 'item.blocked', { id: 'plan:91-03', reason: 'waiting for the API key' });
  world.accept(owner, 'item.updated', { id: 'plan:91-04', changes: { state: 'done' } });
  world.accept(owner, 'item.cancelled', { id: 'plan:91-05', reason: 'replaced by another plan' });
  world.accept(owner, 'item.updated', { id: 'plan:91-06', changes: { summary: true } });
  world.accept(owner, 'item.updated', { id: 'plan:91-08', changes: { hold: true } });
  return world;
}

type Denied = Partial<Record<MoveKey, string>>;
interface StateRow { name: string; id: string; column: BoardColumn; allowed: MoveKey[]; denied: Denied }

const R = REFUSALS;
const NOT_HELD: Denied = { release: R.notHeld, reopen: R.notTerminal, unblock: R.notBlocked };
const SETTLED: Denied = { done: R.alreadySettled, cancel: R.alreadySettled, hold: R.alreadySettled, release: R.notHeld, block: R.alreadySettled, unblock: R.notBlocked };

const STATES: StateRow[] = [
  { name: 'ready', id: 'plan:91-01', column: 'ready', allowed: ['done', 'cancel', 'hold', 'block'], denied: NOT_HELD },
  { name: 'backlog, not ready', id: 'plan:90-02', column: 'backlog', allowed: ['done', 'cancel', 'block'], denied: { hold: R.holdNotReady, ...NOT_HELD } },
  { name: 'held', id: 'plan:91-02', column: 'backlog', allowed: ['done', 'cancel', 'release', 'block'], denied: { hold: R.alreadyHeld, reopen: R.notTerminal, unblock: R.notBlocked } },
  { name: 'held and without an estimate', id: 'plan:91-08', column: 'backlog', allowed: ['done', 'cancel', 'release', 'block'], denied: { hold: R.alreadyHeld, reopen: R.notTerminal, unblock: R.notBlocked } },
  { name: 'blocked', id: 'plan:91-03', column: 'backlog', allowed: ['cancel', 'unblock'], denied: { done: R.doneBlocked, hold: R.holdNotReady, release: R.notHeld, reopen: R.notTerminal, block: R.alreadyBlocked } },
  { name: 'done', id: 'plan:91-04', column: 'done', allowed: ['reopen'], denied: SETTLED },
  { name: 'cancelled', id: 'plan:91-05', column: 'cancelled', allowed: ['reopen'], denied: SETTLED },
  { name: 'done in GSD, waiting for confirmation', id: 'plan:91-06', column: 'ready', allowed: ['done', 'cancel', 'hold', 'block'], denied: NOT_HELD },
  { name: 'a board item without files or an estimate', id: CHORE_ID, column: 'backlog', allowed: ['done', 'cancel', 'block'], denied: { hold: R.holdNotReady, ...NOT_HELD } }
];

const REASON_MOVES: readonly MoveKey[] = ['cancel', 'block'];

interface Viewer { name: string; id: (world: BoardWorld) => string | undefined; moves: boolean; refusal: string }

async function removedViewer(world: BoardWorld): Promise<string> {
  const actor = await makeActor(world.teamId);
  addFixtureMember(world.state, actor, 'lead', 'Rex');
  const member = world.state.members.get(actor.memberId);
  assert.ok(member);
  member.removedEvent = 'evt-removed';
  member.removedAt = '2026-03-02T00:00:00.000Z';
  return actor.memberId;
}

const VIEWERS: Viewer[] = [
  { name: 'owner', id: (w) => w.owner.memberId, moves: true, refusal: '' },
  { name: 'lead', id: (w) => w.lead.memberId, moves: true, refusal: '' },
  { name: 'developer', id: (w) => w.dev.memberId, moves: false, refusal: 'Only the team owner or a lead can move cards. Nothing was moved.' },
  { name: 'reviewer', id: (w) => w.reviewer.memberId, moves: false, refusal: 'Only the team owner or a lead can move cards. Nothing was moved.' },
  { name: 'observer', id: (w) => w.observer.memberId, moves: false, refusal: 'Only the team owner or a lead can move cards. Nothing was moved.' },
  { name: 'nobody (no device key)', id: () => undefined, moves: false, refusal: 'This computer has no device key for this team, so it can read the team log but not write to it.' }
];

// ---- every move, state and viewer ------------------------------------------------------------------------------------------------------------

test('planMove answers every move for every state and viewer from the table, and availableMoves lists exactly the moves that succeed', async () => {
  const world = await moveWorld();
  for (const viewer of VIEWERS) {
    const viewerId = viewer.id(world);
    for (const row of STATES) {
      const succeeded: MoveKey[] = [];
      for (const move of MOVE_KEYS) {
        const result = planMove(world.state, viewerId, row.id, move, { reason: 'a good reason' });
        const label = `${viewer.name} / ${row.name} / ${move}`;
        if (!viewer.moves) {
          assert.deepEqual(result, { ok: false, reason: viewer.refusal }, label);
        } else if (row.allowed.includes(move)) {
          assert.equal(result.ok, true, label);
          succeeded.push(move);
        } else {
          assert.deepEqual(result, { ok: false, reason: row.denied[move] }, label);
        }
      }
      const offered = availableMoves(world.state, viewerId, row.id).map((move) => move.key);
      assert.deepEqual(offered, succeeded, `${viewer.name} / ${row.name}: the menu is exactly the moves that succeed, in menu order`);
      if (viewer.moves) assert.deepEqual(offered, MOVE_KEYS.filter((move) => row.allowed.includes(move)), `${viewer.name} / ${row.name}: menu order`);
    }
  }
});

test('a removed member gets no moves and the removal sentence; an id that is not a card is missing', async () => {
  const world = await moveWorld();
  const removed = await removedViewer(world);
  for (const move of MOVE_KEYS) assert.deepEqual(planMove(world.state, removed, 'plan:91-01', move, { reason: 'x' }), { ok: false, reason: 'You were removed from this team. You can still look at the board but not change it.' });
  assert.deepEqual(availableMoves(world.state, removed, 'plan:91-01'), []);
  for (const id of ['phase:91', 'milestone:v0.9.0', 'task:90-01-1', 'plan:99-99']) {
    assert.deepEqual(planMove(world.state, world.owner.memberId, id, 'done'), { ok: false, reason: 'This card is no longer on the board. Nothing was moved.' }, id);
    assert.deepEqual(availableMoves(world.state, world.owner.memberId, id), [], id);
  }
});

test('every intent planMove builds for an allowed move is accepted by the materialiser for the owner and for a lead', async () => {
  const world = await moveWorld();
  const actors: TestActor[] = [world.owner, world.lead];
  for (const row of STATES) {
    for (const move of row.allowed) {
      for (const actor of actors) {
        const planned = planMove(world.state, actor.memberId, row.id, move, { reason: 'a good reason' });
        assert.equal(planned.ok, true, `${row.name} / ${move}`);
        if (!planned.ok) continue;
        const copy = cloneState(world.state);
        const event = signed(actor, { teamId: world.teamId, type: planned.intent.type as ImplementedEventType, body: planned.intent.body as never, lamport: copy.highLamport + 1, prev: copy.head.eventId });
        const verdict = applyEntry(copy, entryOf(event));
        assert.equal(verdict.accepted, true, `${row.name} / ${move} / ${actor.memberId}: ${verdict.accepted ? '' : verdict.rejection.reason}`);
      }
    }
  }
});

test('a MoveIntent is an EventIntent, so the host can append it without a cast', async () => {
  const world = await moveWorld();
  const planned = planMove(world.state, world.owner.memberId, 'plan:91-01', 'cancel', { reason: 'replaced' });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const asIntent: EventIntent = planned.intent;
  const back: MoveIntent = asIntent as MoveIntent;
  assert.deepEqual(back, { type: 'item.cancelled', body: { id: 'plan:91-01', reason: 'replaced' } });
});

// ---- reasons for block and cancel ------------------------------------------------------------------------------------------------------------

test('a block or cancel reason is trimmed into the intent, flattened to one line, and refused when empty, too long or secret-like', async () => {
  const world = await moveWorld();
  const owner = world.owner.memberId;
  const secret = `use sk-${'a1B2c3D4'.repeat(5)} for the call`;
  assert.notDeepEqual(findSecrets(secret), [], 'the fixture reason really is secret-like');
  for (const move of REASON_MOVES) {
    const id = 'plan:91-01';
    const type = move === 'block' ? 'item.blocked' : 'item.cancelled';
    assert.deepEqual(planMove(world.state, owner, id, move, { reason: '  waiting for the API key  ' }), { ok: true, intent: { type, body: { id, reason: 'waiting for the API key' } } }, move);
    assert.deepEqual(planMove(world.state, owner, id, move, { reason: 'first line\nsecond line' }), { ok: true, intent: { type, body: { id, reason: 'first line second line' } } }, `${move} one line`);
    assert.equal(planMove(world.state, owner, id, move, { reason: 'x'.repeat(200) }).ok, true, `${move} 200 characters`);
    for (const bad of [undefined, '', '   ', '\n\t', 'x'.repeat(201)]) {
      const input = bad === undefined ? {} : { reason: bad };
      assert.deepEqual(planMove(world.state, owner, id, move, input), { ok: false, reason: 'Enter a reason, up to 200 characters.' }, `${move} ${JSON.stringify(bad)}`);
    }
    assert.deepEqual(planMove(world.state, owner, id, move, { reason: secret }), { ok: false, reason: 'This text looks like a password or key, so it was not saved. Remove it and try again.' }, `${move} secret`);
  }
  // The moves that need no reason ignore one, so a stray reason never reaches the log.
  assert.deepEqual(planMove(world.state, owner, 'plan:91-01', 'hold', { reason: secret }), { ok: true, intent: { type: 'item.updated', body: { id: 'plan:91-01', changes: { hold: true } } } });
  assert.deepEqual(planMove(world.state, owner, 'plan:91-03', 'unblock', { reason: secret }), { ok: true, intent: { type: 'item.unblocked', body: { id: 'plan:91-03' } } });
});

test('each move says what kind of prompt follows, and a cancel reports how many unfinished plans wait for the card', async () => {
  const world = await moveWorld();
  const kinds = (id: string): Record<string, string> => Object.fromEntries(availableMoves(world.state, world.owner.memberId, id).map((move) => [move.key, move.prompt]));
  assert.deepEqual(kinds('plan:91-01'), { done: 'confirm', cancel: 'reason', hold: 'none', block: 'reason' });
  assert.deepEqual(kinds('plan:91-03'), { cancel: 'reason', unblock: 'none' });
  assert.deepEqual(kinds('plan:91-04'), { reopen: 'none' });
  const cancelOf = (id: string) => availableMoves(world.state, world.owner.memberId, id).find((move) => move.key === 'cancel');
  assert.equal(cancelOf('plan:90-01')?.dependents, 1, 'plan:90-02 waits for plan:90-01');
  assert.equal(cancelOf('plan:91-01')?.dependents, 0);
  for (const move of availableMoves(world.state, world.owner.memberId, 'plan:90-01')) if (move.key !== 'cancel') assert.equal(move.dependents, undefined, move.key);
  // A dependent that is already finished no longer waits.
  world.accept(world.owner, 'item.updated', { id: 'plan:90-02', changes: { state: 'done' } });
  assert.equal(cancelOf('plan:90-01')?.dependents, 0);
});

// ---- drop targets ----------------------------------------------------------------------------------------------------------------------------

const CLAIM_SENTENCES: Array<[BoardColumn, string]> = [
  ['claimed', 'Claiming a plan arrives in a later update. Nothing was moved.'],
  ['in-progress', 'Starting work from the board arrives with claims in a later update. Nothing was moved.'],
  ['in-review', 'Review arrives in a later update. Nothing was moved.'],
  ['integrating', 'Merging arrives in a later update. Nothing was moved.']
];
const REOPEN_SENTENCE = 'A finished or cancelled card can only be reopened. Use Move to... and choose Reopen. Nothing was moved.';

type Drop = { ok: true; move?: MoveKey } | { ok: false; reason: string };
const OK = (move?: MoveKey): Drop => (move === undefined ? { ok: true } : { ok: true, move });
const NO = (reason: string): Drop => ({ ok: false, reason });

function claimDrops(): Array<[BoardColumn, Drop]> {
  return CLAIM_SENTENCES.map(([column, text]) => [column, NO(text)]);
}

const DROPS: Array<{ name: string; id: string; drops: Array<[BoardColumn, Drop]> }> = [
  { name: 'a ready plan', id: 'plan:91-01', drops: [['backlog', OK('hold')], ['ready', OK()], ...claimDrops(), ['done', OK('done')], ['cancelled', OK('cancel')]] },
  {
    name: 'a plan that waits for another plan', id: 'plan:90-02',
    drops: [['backlog', OK()], ['ready', NO('This plan is not ready yet: it waits for 1 unfinished plan. Nothing was moved.')], ...claimDrops(), ['done', OK('done')], ['cancelled', OK('cancel')]]
  },
  {
    name: 'a plan with no estimate and no files', id: 'plan:91-07',
    drops: [['backlog', OK()], ['ready', NO('This plan is not ready yet: it has no estimate, it lists no files. Nothing was moved.')], ['done', OK('done')], ['cancelled', OK('cancel')]]
  },
  { name: 'a held plan', id: 'plan:91-02', drops: [['backlog', OK()], ['ready', OK('release')], ...claimDrops(), ['done', OK('done')], ['cancelled', OK('cancel')]] },
  {
    name: 'a held plan that is also missing its estimate', id: 'plan:91-08',
    drops: [['ready', NO('This plan is not ready yet: it is on hold, it has no estimate. Nothing was moved.')], ['backlog', OK()]]
  },
  {
    name: 'a blocked plan', id: 'plan:91-03',
    drops: [
      ['ready', NO('This plan is not ready yet: it is blocked. Nothing was moved.')], ['backlog', OK()],
      ['done', NO('This card is blocked, so it cannot be marked done. Unblock it first. Nothing was moved.')], ['cancelled', OK('cancel')]
    ]
  },
  {
    name: 'a finished plan', id: 'plan:91-04',
    drops: [['backlog', OK('reopen')], ['done', OK()], ['ready', NO(REOPEN_SENTENCE)], ['cancelled', NO(REOPEN_SENTENCE)], ...CLAIM_SENTENCES.map(([column]): [BoardColumn, Drop] => [column, NO(REOPEN_SENTENCE)])]
  },
  {
    name: 'a cancelled plan', id: 'plan:91-05',
    drops: [['backlog', OK('reopen')], ['cancelled', OK()], ['ready', NO(REOPEN_SENTENCE)], ['done', NO(REOPEN_SENTENCE)], ...CLAIM_SENTENCES.map(([column]): [BoardColumn, Drop] => [column, NO(REOPEN_SENTENCE)])]
  },
  {
    name: 'a board item with no estimate and no files', id: CHORE_ID,
    drops: [['ready', NO('This item is not ready yet: it has no estimate, it lists no files. Nothing was moved.')], ['backlog', OK()], ['done', OK('done')]]
  }
];

test('every drop target maps to a move, to nothing, or to the exact sentence the board shows', async () => {
  const world = await moveWorld();
  for (const row of DROPS) {
    for (const [column, expected] of row.drops) {
      assert.deepEqual(columnMove(world.state, world.owner.memberId, row.id, column), expected, `${row.name} dropped on ${column}`);
    }
  }
});

test('the card carries the same answers: a refusal for every column it may not enter, and none for the ones it may', async () => {
  const world = await moveWorld();
  const model = buildBoardModel(world.state, { nowMs: Date.parse('2026-03-05T12:00:00.000Z'), status: { kind: 'live', text: 'Live' }, viewerId: world.owner.memberId, canWrite: true });
  for (const row of DROPS) {
    const card = model.cards.find((entry) => entry.id === row.id);
    assert.ok(card, row.id);
    const expected: Record<string, string> = {};
    for (const column of BOARD_COLUMNS) {
      if (column === card.column) continue;
      const listed = row.drops.find(([target]) => target === column);
      // A column the table does not list is one the card was never meant to enter from here; it must still be refused with a sentence.
      if (listed === undefined) assert.ok(card.refusals[column]?.endsWith('Nothing was moved.'), `${row.name} -> ${column} has a refusal`);
      else if (!listed[1].ok) expected[column] = listed[1].reason;
    }
    for (const [column, text] of Object.entries(expected)) assert.equal(card.refusals[column as BoardColumn], text, `${row.name} refusal for ${column}`);
    for (const [column, drop] of row.drops) if (drop.ok) assert.equal(card.refusals[column], undefined, `${row.name} has no refusal for ${column}`);
  }
});

test('a viewer who may not move gets their own reason for every other column and nothing for the column the card is in', async () => {
  const world = await moveWorld();
  for (const viewer of VIEWERS.filter((entry) => !entry.moves)) {
    const id = viewer.id(world);
    for (const column of BOARD_COLUMNS) {
      const verdict = columnMove(world.state, id, 'plan:91-01', column);
      assert.deepEqual(verdict, column === 'ready' ? { ok: true } : { ok: false, reason: viewer.refusal }, `${viewer.name} dropped on ${column}`);
    }
  }
  assert.deepEqual(columnMove(world.state, world.owner.memberId, 'plan:99-99', 'done'), { ok: false, reason: 'This card is no longer on the board. Nothing was moved.' });
});

test('a card in a read-only model has no moves and every other column refuses with the host reason', async () => {
  const world = await moveWorld();
  const reason = 'You are offline. Cards cannot be moved or added until the connection returns.';
  const model = buildBoardModel(world.state, { nowMs: Date.parse('2026-03-05T12:00:00.000Z'), status: { kind: 'offline', text: 'Offline' }, viewerId: world.owner.memberId, canWrite: false, readOnlyReason: reason });
  for (const card of model.cards) {
    assert.deepEqual(card.moves, [], card.id);
    for (const column of BOARD_COLUMNS) assert.equal(card.refusals[column], column === card.column ? undefined : reason, `${card.id} ${column}`);
  }
});

test('the stale refusal names the teammate who got there first, on one bounded line', () => {
  assert.equal(staleRefusal('Dana'), 'Dana already changed this card. The board now shows the latest. Nothing was moved.');
  const hostile = staleRefusal(`Dana\n${'x'.repeat(200)}`);
  assert.ok(!hostile.includes('\n'));
  assert.ok(hostile.length < 200, hostile);
  assert.ok(hostile.endsWith('already changed this card. The board now shows the latest. Nothing was moved.'));
});
