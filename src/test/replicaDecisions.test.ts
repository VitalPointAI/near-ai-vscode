// The decision algebra for one version (plan 30-07, D-25, DESIGN 15.5, research Table B). Every row runs under every permutation of its acts and
// must give one result: nothing in the algebra depends on array order, names, rank or time.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDecisions } from '../domain/replica/decisions';
import type { DecisionAct, DecisionOutcome, DecisionResult } from '../domain/replica/decisions';
import { permutations } from './helpers/replicaWorld';

const HASH = 'hash-v1';

interface ActOptions { by?: string; seen?: string[]; confirmed?: boolean; final?: boolean; versionHash?: string }

function act(id: string, outcome: DecisionOutcome, options: ActOptions = {}): DecisionAct {
  return { id, outcome, by: options.by ?? `by-${id}`, versionHash: options.versionHash ?? HASH, seen: options.seen ?? [], confirmed: options.confirmed ?? true, final: options.final ?? false };
}

/** A transitive `before` built from [earlier, later] pairs (what graph.isBefore gives in the real fold). */
function relation(pairs: readonly (readonly [string, string])[]): (a: string, b: string) => boolean {
  const later = new Map<string, Set<string>>();
  for (const [earlier, after] of pairs) {
    if (!later.has(earlier)) later.set(earlier, new Set());
    later.get(earlier)?.add(after);
  }
  const reach = (from: string, target: string, visited: Set<string>): boolean => {
    for (const next of later.get(from) ?? []) {
      if (next === target) return true;
      if (!visited.has(next)) { visited.add(next); if (reach(next, target, visited)) return true; }
    }
    return false;
  };
  return (a, b) => reach(a, b, new Set([a]));
}

interface RunOptions { pairs?: readonly (readonly [string, string])[]; known?: readonly string[] }

/** Resolves the acts in every order and asserts one result; returns it. */
function resolveAll(acts: readonly DecisionAct[], options: RunOptions = {}): DecisionResult {
  const before = relation(options.pairs ?? []);
  const ids = new Set([...acts.map((a) => a.id), ...(options.known ?? [])]);
  const orders = permutations(acts);
  assert.ok(orders.length <= 720, 'a row has at most 6 acts');
  let first: DecisionResult | undefined;
  for (const order of orders) {
    const result = resolveDecisions({ versionHash: HASH, acts: order, before, isKnownEntry: (id) => ids.has(id) });
    if (first === undefined) first = result;
    else assert.deepEqual(result, first, `order ${order.map((a) => a.id).join(',')} gave another result`);
  }
  return first as DecisionResult;
}

test('D1 no acts gives none', () => {
  const result = resolveAll([]);
  assert.equal(result.status, 'none');
  assert.deepEqual(result.effective, []);
  assert.equal(result.terminal, false);
});

test('D2 one confirmed approve is effective APPROVE with its name', () => {
  const result = resolveAll([act('a', 'approve', { by: 'Ada' })]);
  assert.equal(result.status, 'effective');
  assert.equal(result.outcome, 'APPROVE');
  assert.deepEqual(result.names, ['Ada']);
  assert.deepEqual(result.effective, ['a']);
});

test('D4 approve and reject made concurrently are contested, in both orders, and neither applies', () => {
  const result = resolveAll([act('a', 'approve'), act('r', 'reject')]);
  assert.equal(result.status, 'contested');
  assert.deepEqual(result.contested, ['a', 'r']);
  assert.equal(result.outcome, undefined);
  assert.deepEqual(result.effective, []);
});

test('D3 an approve and a later reject that saw it give effective REJECT', () => {
  const result = resolveAll([act('a', 'approve'), act('r', 'reject')], { pairs: [['a', 'r']] });
  assert.equal(result.status, 'effective');
  assert.equal(result.outcome, 'REJECT');
  assert.deepEqual(result.effective, ['r']);
  assert.deepEqual(result.superseded, ['a']);
});

test('D5 two concurrent approves by different people are effective APPROVE with both names', () => {
  const result = resolveAll([act('a', 'approve', { by: 'Ada' }), act('b', 'approve', { by: 'Bo' })]);
  assert.equal(result.status, 'effective');
  assert.equal(result.outcome, 'APPROVE');
  assert.deepEqual(result.names, ['Ada', 'Bo']);
  assert.deepEqual(result.effective, ['a', 'b']);
});

test('D6 two concurrent rejects are effective REJECT with both names', () => {
  const result = resolveAll([act('a', 'reject', { by: 'Ada' }), act('b', 'reject', { by: 'Bo' })]);
  assert.equal(result.outcome, 'REJECT');
  assert.deepEqual(result.names, ['Ada', 'Bo']);
});

test('D7 an approve concurrent with a withdraw is contested', () => {
  const result = resolveAll([act('a', 'approve'), act('w', 'withdraw')]);
  assert.equal(result.status, 'contested');
  assert.deepEqual(result.contested, ['a', 'w']);
  assert.equal(result.terminal, false);
});

test('D8 a release concurrent with a reject is contested', () => {
  const result = resolveAll([act('a', 'approve'), act('rel', 'release'), act('j', 'reject')], { pairs: [['a', 'rel'], ['a', 'j']] });
  assert.equal(result.status, 'contested');
  assert.deepEqual(result.contested, ['j', 'rel']);
  assert.deepEqual(result.superseded, ['a']);
});

test('D9 a release concurrent with a withdraw is contested', () => {
  const result = resolveAll([act('a', 'approve'), act('rel', 'release'), act('w', 'withdraw')], { pairs: [['a', 'rel'], ['a', 'w']] });
  assert.equal(result.status, 'contested');
  assert.deepEqual(result.contested, ['rel', 'w']);
});

test('D10 a release concurrent with a second approve is effective APPROVE', () => {
  const result = resolveAll([act('a', 'approve', { by: 'Ada' }), act('rel', 'release', { by: 'Cy' }), act('b', 'approve', { by: 'Bo' })], { pairs: [['a', 'rel']] });
  assert.equal(result.status, 'effective');
  assert.equal(result.outcome, 'APPROVE');
  assert.deepEqual(result.effective, ['b', 'rel']);
  assert.deepEqual(result.names, ['Bo', 'Cy']);
});

test('D11 a contested set settles with a fresh act that saw every member, even by the author of one of them', () => {
  const result = resolveAll([act('a', 'approve', { by: 'Ada' }), act('r', 'reject', { by: 'Bo' }), act('x', 'approve', { by: 'Ada', seen: ['a', 'r'] })]);
  assert.equal(result.status, 'effective');
  assert.equal(result.outcome, 'APPROVE');
  assert.deepEqual(result.effective, ['x']);
  assert.deepEqual(result.superseded, ['a', 'r']);
});

test('D12 a fresh act that saw only one contested act stays contested with the other', () => {
  const result = resolveAll([act('a', 'approve'), act('r', 'reject'), act('x', 'approve', { seen: ['a'] })]);
  assert.equal(result.status, 'contested');
  assert.deepEqual(result.contested, ['r', 'x']);
  assert.deepEqual(result.superseded, ['a']);
});

test('D13 a withdraw that saw every contested act is effective WITHDRAW and terminal', () => {
  const result = resolveAll([act('a', 'approve'), act('r', 'reject'), act('w', 'withdraw', { seen: ['a', 'r'] })]);
  assert.equal(result.status, 'effective');
  assert.equal(result.outcome, 'WITHDRAW');
  assert.equal(result.terminal, true);
});

test('D14 an effective approve and a later concurrent reject are contested', () => {
  const alone = resolveAll([act('a', 'approve')]);
  assert.equal(alone.status, 'effective');
  const result = resolveAll([act('a', 'approve'), act('r', 'reject')]);
  assert.equal(result.status, 'contested');
  assert.deepEqual(result.contested, ['a', 'r']);
});

test('D15 a contest between a final act and a later one has the same status and sets finalBeforeDispute', () => {
  const plain = resolveAll([act('a', 'approve'), act('r', 'reject')]);
  const result = resolveAll([act('a', 'approve', { final: true }), act('r', 'reject')]);
  assert.equal(result.finalBeforeDispute, true);
  assert.equal(plain.finalBeforeDispute, false);
  assert.equal(result.status, plain.status);
  assert.deepEqual(result.contested, plain.contested);
  const bothFinal = resolveAll([act('a', 'approve', { final: true }), act('r', 'reject', { final: true })]);
  assert.equal(bothFinal.finalBeforeDispute, false);
});

test('D16 an unconfirmed decision is pending and the status stays none', () => {
  const result = resolveAll([act('p', 'approve', { confirmed: false })]);
  assert.equal(result.status, 'none');
  assert.deepEqual(result.pending, ['p']);
  assert.deepEqual(result.effective, []);
});

test('D17 a confirmed decision of the same outcome that saw the pending one is effective', () => {
  const result = resolveAll([act('p', 'approve', { confirmed: false }), act('y', 'approve', { by: 'Lead', seen: ['p'] })]);
  assert.equal(result.status, 'effective');
  assert.equal(result.outcome, 'APPROVE');
  assert.deepEqual(result.names, ['Lead']);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(result.superseded, ['p']);
});

test('D18 a confirmed decision of the other outcome that saw the pending one is effective with the new outcome', () => {
  const result = resolveAll([act('p', 'approve', { confirmed: false }), act('y', 'reject', { seen: ['p'] })]);
  assert.equal(result.status, 'effective');
  assert.equal(result.outcome, 'REJECT');
  assert.deepEqual(result.pending, []);
  assert.deepEqual(result.superseded, ['p']);
});

test('D19 a decline that saw only the pending act returns the state to none and clears pending', () => {
  const result = resolveAll([act('p', 'approve', { confirmed: false }), act('d', 'decline', { seen: ['p'] })]);
  assert.equal(result.status, 'none');
  assert.deepEqual(result.pending, []);
  assert.deepEqual(result.superseded, ['p']);
  assert.deepEqual(result.refused, []);
});

test('D20 a decision made before the role was withdrawn is confirmed, so effective and not pending', () => {
  const result = resolveAll([act('a', 'approve', { by: 'Ada', confirmed: true })]);
  assert.equal(result.status, 'effective');
  assert.deepEqual(result.pending, []);
});

test('D22 an approve for another version hash is refused stale-version and does not count', () => {
  const stale = act('s', 'approve', { versionHash: 'hash-v0' });
  const alone = resolveAll([stale]);
  assert.equal(alone.status, 'none');
  assert.deepEqual(alone.refused, [{ id: 's', reason: 'stale-version' }]);
  const mixed = resolveAll([stale, act('r', 'reject')]);
  assert.equal(mixed.outcome, 'REJECT');
  assert.deepEqual(mixed.refused, [{ id: 's', reason: 'stale-version' }]);
});

test('D23 an approve after an uncontested effective withdraw is refused terminal, but a fresh act that saw a contested set including the withdraw settles it', () => {
  const late = resolveAll([act('a', 'approve'), act('w', 'withdraw'), act('z', 'approve')], { pairs: [['a', 'w'], ['w', 'z']] });
  assert.equal(late.status, 'effective');
  assert.equal(late.outcome, 'WITHDRAW');
  assert.equal(late.terminal, true);
  assert.deepEqual(late.refused, [{ id: 'z', reason: 'terminal' }]);

  const settled = resolveAll([act('a', 'approve'), act('w', 'withdraw'), act('x', 'approve', { seen: ['a', 'w'] })]);
  assert.equal(settled.status, 'effective');
  assert.equal(settled.outcome, 'APPROVE');
  assert.equal(settled.terminal, false);
  assert.deepEqual(settled.refused, []);

  const partial = resolveAll([act('a', 'approve'), act('w', 'withdraw'), act('x', 'reject', { seen: ['w'] })]);
  assert.equal(partial.status, 'contested');
  assert.deepEqual(partial.refused, [{ id: 'x', reason: 'terminal' }]);
});

test('D24 an act whose decisionsSeen names an unknown entry is held until that entry is known', () => {
  const unknown = act('x', 'approve', { seen: ['ghost'] });
  const held = resolveAll([unknown]);
  assert.equal(held.status, 'none');
  assert.deepEqual(held.held, [{ id: 'x', reason: 'unknown-decision-seen' }]);
  const arrived = resolveAll([unknown], { known: ['ghost'] });
  assert.equal(arrived.status, 'effective');
  assert.deepEqual(arrived.held, []);
  const chained = resolveAll([unknown, act('y', 'reject', { seen: ['x'] })]);
  assert.deepEqual(chained.held.map((h) => h.id), ['x', 'y']);
});

test('supersede concurrent with a withdraw is contested', () => {
  const result = resolveAll(
    [act('a', 'approve'), act('rel', 'release'), act('s', 'supersede'), act('w', 'withdraw')],
    { pairs: [['a', 'rel'], ['rel', 's'], ['rel', 'w']] },
  );
  assert.equal(result.status, 'contested');
  assert.deepEqual(result.contested, ['s', 'w']);
});

test('a supersede after a release is effective SUPERSEDE and terminal; a later act is refused terminal', () => {
  const result = resolveAll(
    [act('a', 'approve'), act('rel', 'release'), act('s', 'supersede'), act('z', 'reject')],
    { pairs: [['a', 'rel'], ['rel', 's'], ['s', 'z']] },
  );
  assert.equal(result.outcome, 'SUPERSEDE');
  assert.equal(result.terminal, true);
  assert.deepEqual(result.refused, [{ id: 'z', reason: 'terminal' }]);
});

test('a release with no effective approval in its past is refused no-approval', () => {
  const alone = resolveAll([act('rel', 'release')]);
  assert.equal(alone.status, 'none');
  assert.deepEqual(alone.refused, [{ id: 'rel', reason: 'no-approval' }]);
  const afterReject = resolveAll([act('a', 'approve'), act('r', 'reject'), act('rel', 'release')], { pairs: [['a', 'r'], ['r', 'rel']] });
  assert.deepEqual(afterReject.refused, [{ id: 'rel', reason: 'no-approval' }]);
  assert.equal(afterReject.outcome, 'REJECT');
});

test('a supersede with no release in its past is refused no-release', () => {
  const result = resolveAll([act('a', 'approve'), act('s', 'supersede')], { pairs: [['a', 's']] });
  assert.deepEqual(result.refused, [{ id: 's', reason: 'no-release' }]);
  assert.equal(result.outcome, 'APPROVE');
});

test('a decline that saw a confirmed act is refused decline-not-pending and settles nothing', () => {
  const result = resolveAll([act('c', 'approve'), act('d', 'decline', { seen: ['c'] })]);
  assert.deepEqual(result.refused, [{ id: 'd', reason: 'decline-not-pending' }]);
  assert.equal(result.status, 'effective');
  const empty = resolveAll([act('d', 'decline')]);
  assert.deepEqual(empty.refused, [{ id: 'd', reason: 'decline-not-pending' }]);
});

test('precedence by causal past and by decisionsSeen give the same result', () => {
  const byPast = resolveAll([act('a', 'approve'), act('r', 'reject')], { pairs: [['a', 'r']] });
  const bySeen = resolveAll([act('a', 'approve'), act('r', 'reject', { seen: ['a'] })]);
  assert.deepEqual(bySeen, byPast);
  const chain = resolveAll([act('a', 'approve'), act('b', 'reject', { seen: ['a'] }), act('c', 'approve', { seen: ['b'] })]);
  assert.deepEqual(chain.effective, ['c']);
});

test('swapping every name between acts changes neither status nor outcome nor which acts are effective', () => {
  const rows: { name: string; acts: DecisionAct[]; pairs: [string, string][] }[] = [
    { name: 'contest', acts: [act('a', 'approve'), act('r', 'reject')], pairs: [] },
    { name: 'concurrent approves', acts: [act('a', 'approve'), act('b', 'approve')], pairs: [] },
    { name: 'change of mind', acts: [act('a', 'approve'), act('r', 'reject')], pairs: [['a', 'r']] },
    { name: 'pending settled', acts: [act('p', 'approve', { confirmed: false }), act('y', 'reject', { seen: ['p'] })], pairs: [] },
    { name: 'withdraw contest', acts: [act('a', 'approve'), act('w', 'withdraw'), act('x', 'approve', { seen: ['a'] })], pairs: [] },
  ];
  for (const row of rows) {
    const base = resolveAll(row.acts, { pairs: row.pairs });
    const names = row.acts.map((a) => a.by);
    const rotated = row.acts.map((a, index) => ({ ...a, by: names[(index + 1) % names.length] }));
    const swapped = resolveAll(rotated, { pairs: row.pairs });
    assert.equal(swapped.status, base.status, row.name);
    assert.equal(swapped.outcome, base.outcome, row.name);
    assert.deepEqual(swapped.effective, base.effective, row.name);
    assert.deepEqual(swapped.contested, base.contested, row.name);
    assert.deepEqual(swapped.pending, base.pending, row.name);
  }
});

test('the function is total: duplicate ids, a precedence cycle and unknown outcomes never throw and stay order independent', () => {
  const dup = resolveAll([act('a', 'approve'), act('a', 'approve'), act('r', 'reject')]);
  assert.equal(dup.status, 'contested');
  const cycle = resolveAll([act('a', 'approve', { seen: ['b'] }), act('b', 'reject', { seen: ['a'] }), act('c', 'approve')]);
  assert.deepEqual(cycle.held, [{ id: 'a', reason: 'precedence-cycle' }, { id: 'b', reason: 'precedence-cycle' }]);
  assert.deepEqual(cycle.effective, ['c']);
  const hostile = resolveAll([act('a', 'approve'), { ...act('h', 'approve'), outcome: 'constructor' as DecisionOutcome }]);
  assert.deepEqual(hostile.effective, ['a']);
});
