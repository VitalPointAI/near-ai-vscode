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
