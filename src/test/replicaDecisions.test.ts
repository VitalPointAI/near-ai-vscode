// The decision algebra for one version (plan 30-07, D-25, DESIGN 15.5, research Table B). Every row runs under every permutation of its acts and
// must give one result: nothing in the algebra depends on array order, names, rank or time.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCausalGraph } from '../domain/replica/causal';
import type { GraphEntry } from '../domain/replica/causal';
import { resolveDecisions } from '../domain/replica/decisions';
import type { DecisionAct, DecisionOutcome, DecisionResult } from '../domain/replica/decisions';
import { GENESIS_PREV } from '../domain/replica/entry';
import type { EntryBody, EntryHeader } from '../domain/replica/entry';
import { permutations, rng, shuffled } from './helpers/replicaWorld';
import type { Rng } from './helpers/replicaWorld';

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

interface RunOptions { pairs?: readonly (readonly [string, string])[]; known?: readonly string[]; strict?: boolean }

/** Resolves the acts in every order and asserts one result; returns it. Strict by default (IN-01): a precedence cycle throws instead of passing silently. */
function resolveAll(acts: readonly DecisionAct[], options: RunOptions = {}): DecisionResult {
  const before = relation(options.pairs ?? []);
  const ids = new Set([...acts.map((a) => a.id), ...(options.known ?? [])]);
  const orders = permutations(acts);
  assert.ok(orders.length <= 720, 'a row has at most 6 acts');
  let first: DecisionResult | undefined;
  for (const order of orders) {
    const result = resolveDecisions({ versionHash: HASH, acts: order, before, isKnownEntry: (id) => ids.has(id), strict: options.strict ?? true });
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
  // WR-09: an act that saw the held act names no unknown id, so it is not held with it.
  const chained = resolveAll([unknown, act('y', 'reject', { seen: ['x'] })]);
  assert.deepEqual(chained.held.map((h) => h.id), ['x']);
  assert.equal(chained.outcome, 'REJECT');
});

test('WR-09 a withdraw naming a bogus id is held alone, and the honest approve that saw it is effective', () => {
  const result = resolveAll([act('w', 'withdraw', { by: 'Owner', seen: ['bogus'] }), act('a', 'approve', { by: 'Ada', seen: ['w'] })]);
  assert.deepEqual(result.held, [{ id: 'w', reason: 'unknown-decision-seen' }]);
  assert.equal(result.status, 'effective');
  assert.equal(result.outcome, 'APPROVE');
  assert.deepEqual(result.effective, ['a']);
  assert.equal(result.terminal, false);
  // The same honest approve is still contested by a concurrent reject: not holding it does not make it win.
  const contested = resolveAll([act('w', 'withdraw', { seen: ['bogus'] }), act('a', 'approve', { seen: ['w'] }), act('r', 'reject')]);
  assert.deepEqual(contested.held.map((h) => h.id), ['w']);
  assert.equal(contested.status, 'contested');
  assert.deepEqual(contested.contested, ['a', 'r']);
});

test('WR-09 in a chain of three honest acts each seeing the previous, only the first, which names a bogus id, is held', () => {
  const result = resolveAll([act('x1', 'approve', { seen: ['bogus'] }), act('x2', 'reject', { seen: ['x1'] }), act('x3', 'approve', { seen: ['x2'] })]);
  assert.deepEqual(result.held, [{ id: 'x1', reason: 'unknown-decision-seen' }]);
  assert.equal(result.status, 'effective');
  assert.equal(result.outcome, 'APPROVE');
  assert.deepEqual(result.effective, ['x3']);
  assert.deepEqual(result.superseded, ['x2']);
  // Once the bogus id becomes known, nothing is held and the chain is the same.
  const known = resolveAll([act('x1', 'approve', { seen: ['bogus'] }), act('x2', 'reject', { seen: ['x1'] }), act('x3', 'approve', { seen: ['x2'] })], { known: ['bogus'] });
  assert.deepEqual(known.held, []);
  assert.deepEqual(known.effective, ['x3']);
  assert.deepEqual(known.superseded, ['x1', 'x2']);
});

test('IN-01 a precedence cycle throws in strict mode, naming the acts on the cycle, and is held as before without strict', () => {
  const cycle = [act('a', 'approve', { seen: ['b'] }), act('b', 'reject', { seen: ['a'] }), act('c', 'approve')];
  for (const order of permutations(cycle)) {
    assert.throws(
      () => resolveDecisions({ versionHash: HASH, acts: order, before: () => false, isKnownEntry: () => false, strict: true }),
      (error: unknown) => error instanceof Error && /precedence cycle/.test(error.message) && error.message.endsWith(': a, b'),
    );
  }
  const loose = resolveAll(cycle, { strict: false });
  assert.deepEqual(loose.held, [{ id: 'a', reason: 'precedence-cycle' }, { id: 'b', reason: 'precedence-cycle' }]);
  assert.deepEqual(loose.effective, ['c']);
  // Leaving strict out is the production default: the hold, never a throw.
  const unset = resolveDecisions({ versionHash: HASH, acts: cycle, before: () => false, isKnownEntry: () => false });
  assert.deepEqual(unset, loose);
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
  const cycle = resolveAll([act('a', 'approve', { seen: ['b'] }), act('b', 'reject', { seen: ['a'] }), act('c', 'approve')], { strict: false });
  assert.deepEqual(cycle.held, [{ id: 'a', reason: 'precedence-cycle' }, { id: 'b', reason: 'precedence-cycle' }]);
  assert.deepEqual(cycle.effective, ['c']);
  const hostile = resolveAll([act('a', 'approve'), { ...act('h', 'approve'), outcome: 'constructor' as DecisionOutcome }]);
  assert.deepEqual(hostile.effective, ['a']);
});

// ---- WR-06: one pass in place of the repeated fixpoint, and the lamport bound in the causal graph ----

interface RandomCase { acts: DecisionAct[]; before: (a: string, b: string) => boolean; known: Set<string> }

/**
 * A random set of acts on one version. Acts are made in a hidden creation order; a causal pair and a seen id point from an earlier-made act to a
 * later one, as real entries do. A few acts also name a later act (a precedence cycle), a bogus id, another version or a repeated id, so every
 * branch of the algebra is exercised.
 */
function randomCase(random: Rng, size: number, odd = true): RandomCase {
  const names = shuffled(Array.from({ length: size }, (_, index) => `k${String(index).padStart(3, '0')}`), random);
  const outcomes: DecisionOutcome[] = ['approve', 'approve', 'reject', 'reject', 'release', 'withdraw', 'supersede', 'decline'];
  const ancestors = new Map<string, Set<string>>();
  const acts: DecisionAct[] = [];
  for (let index = 0; index < size; index += 1) {
    const id = names[index];
    const past = new Set<string>();
    for (let earlier = 0; earlier < index; earlier += 1) {
      if (random.chance(0.15)) { past.add(names[earlier]); for (const further of ancestors.get(names[earlier]) ?? []) past.add(further); }
    }
    ancestors.set(id, past);
    const seen = names.slice(0, index).filter(() => random.chance(0.2));
    if (odd && random.chance(0.05)) seen.push('bogus');
    if (odd && index + 1 < size && random.chance(0.05)) seen.push(names[index + 1 + random.int(size - index - 1)]);
    const outcome = random.pick(outcomes);
    acts.push({ id, outcome, by: `by-${random.int(4)}`, versionHash: odd && random.chance(0.05) ? 'hash-v0' : HASH, seen, confirmed: random.chance(0.8), final: random.chance(0.2) });
    if (odd && random.chance(0.04)) acts.push({ id, outcome: random.pick(outcomes), by: 'by-dup', versionHash: HASH, seen: [], confirmed: true, final: false });
  }
  const known = new Set(random.chance(0.3) ? ['bogus'] : []);
  return { acts: shuffled(acts, random), before: (a, b) => ancestors.get(b)?.has(a) ?? false, known };
}

/** Every field of a result on one line, so a frozen expectation is short. */
function line(result: DecisionResult): string {
  const pairs = (items: { id: string; reason: string }[]): string => items.map((item) => `${item.id}=${item.reason}`).join(',');
  return [result.status, result.outcome ?? '-', result.effective.join(','), result.names.join(','), result.contested.join(','), result.pending.join(','),
    result.superseded.join(','), pairs(result.refused), pairs(result.held), result.terminal ? 'T' : 'F', result.finalBeforeDispute ? 'F' : '-'].join('|');
}

// Results of the 40 seeded cases below computed with the decision algebra as it was before the one-pass change (after WR-09), frozen here so the
// change is checked against the old behaviour.
const FROZEN: readonly string[] = [
  'effective|APPROVE|k001|by-2||k000,k002||||F|-',
  'effective|APPROVE|k004|by-0||k001,k002||k000=decline-not-pending,k003=stale-version||F|-',
  'contested|-|||k002,k009|k005|k001|k000=no-approval,k003=no-approval,k004=no-release,k007=stale-version,k008=stale-version,k010=decline-not-pending|k006=unknown-decision-seen|F|F',
  'contested|-|||k001,k004,k007,k008||k000,k002,k005,k009|k003=no-release|k006=unknown-decision-seen|F|F',
  'contested|-|||k000,k001,k005||k006|k002=stale-version,k003=no-approval,k004=no-approval||F|-',
  'contested|-|||k007,k008||k000,k001,k003,k005|k002=decline-not-pending,k004=no-approval,k006=no-release||F|-',
  'none|-||||||k000=no-approval|k001=precedence-cycle,k002=precedence-cycle,k003=precedence-cycle|F|-',
  'effective|APPROVE|k000,k004,k006|by-0,by-2,by-3|||k002,k003,k005|k001=no-release,k007=no-release||F|-',
  'contested|-|||k001,k006,k007||k000,k004,k005|k002=no-release,k003=no-approval||F|F',
  'effective|REJECT|k001|by-2||||k000=no-approval||F|-',
  'effective|WITHDRAW|k007|by-1|||k002,k003,k005|k000=stale-version,k001=terminal,k004=terminal,k006=terminal,k008=terminal,k009=terminal,k010=terminal||T|-',
  'effective|REJECT|k001|by-1|||k000,k004|k002=no-release|k003=precedence-cycle,k005=precedence-cycle|F|-',
  'effective|APPROVE|k005|by-0|||k002,k003,k004,k006|k000=decline-not-pending,k001=stale-version||F|-',
  'effective|APPROVE|k001,k004|by-0,by-2||k002||k000=decline-not-pending,k006=no-approval|k003=unknown-decision-seen,k005=unknown-decision-seen|F|-',
  'effective|APPROVE|k003|by-1|||k001|k000=decline-not-pending,k002=no-approval|k004=unknown-decision-seen|F|-',
  'none|-||||k003||k001=no-approval,k002=no-release|k000=unknown-decision-seen|F|-',
  'contested|-|||k002,k006,k011|k009||k000=terminal,k004=terminal,k010=decline-not-pending|k001=precedence-cycle,k003=precedence-cycle,k005=precedence-cycle,k007=precedence-cycle,k008=precedence-cycle|F|-',
  'effective|WITHDRAW|k002|by-0||||k000=decline-not-pending,k001=stale-version||T|-',
  'none|-||||||k000=no-approval,k001=decline-not-pending||F|-',
  'effective|REJECT|k002|by-0||k001||k000=no-release|k003=unknown-decision-seen|F|-',
  'none|-||||||k001=stale-version|k000=unknown-decision-seen|F|-',
  'effective|APPROVE|k007|by-0|||k000,k002,k003,k004,k006,k008|k001=decline-not-pending,k005=decline-not-pending||F|-',
  'effective|APPROVE|k001|by-3|||k000,k002|k003=no-release,k004=no-approval,k005=decline-not-pending,k006=no-release,k007=decline-not-pending,k008=decline-not-pending||F|-',
  'contested|-|||k001,k002,k003,k005,k006||k000,k004,k009|k007=no-release,k008=no-release,k010=no-approval||F|F',
  'effective|REJECT|k003|by-3||||k000=no-release,k001=no-release,k002=no-release||F|-',
  'effective|APPROVE|k000|by-0||||k001=decline-not-pending||F|-',
  'contested|-|||k005,k006,k008,k010|k002||k000=no-release,k001=no-approval,k003=decline-not-pending,k004=decline-not-pending,k009=no-release|k007=unknown-decision-seen|F|F',
  'none|-|||||||k000=unknown-decision-seen|F|-',
  'contested|-|||k001,k002|k000||k003=no-approval,k004=terminal,k005=terminal||F|-',
  'effective|APPROVE|k003|by-0|||k000,k001,k004,k005,k007,k008|k002=no-approval,k006=decline-not-pending||F|-',
  'effective|REJECT|k011|by-0|||k000,k001,k005,k008,k009,k010|k002=terminal,k003=terminal,k004=stale-version,k006=no-approval,k007=terminal||F|-',
  'effective|APPROVE|k000,k006|by-3,by-dup|||k002|k001=no-release,k003=stale-version,k004=stale-version,k005=no-approval||F|-',
  'contested|-|||k000,k005|k004|k003|k001=no-release,k002=decline-not-pending,k006=no-approval,k007=decline-not-pending||F|F',
  'effective|WITHDRAW|k002|by-2||k001,k008|k000,k007,k010|k003=stale-version,k004=no-approval,k005=terminal,k006=decline-not-pending,k009=terminal||T|-',
  'effective|REJECT|k001|by-0||||k000=no-release||F|-',
  'effective|APPROVE|k002|by-1||k003|k004|k000=no-release,k001=no-approval,k005=no-approval||F|-',
  'effective|WITHDRAW|k003,k006|by-0,by-1|||k000,k001,k004,k005|k002=decline-not-pending,k007=terminal,k008=terminal,k009=no-approval,k010=stale-version||T|-',
  'contested|-|||k002,k003|||k000=decline-not-pending,k001=no-release||F|-',
  'effective|REJECT|k000,k002,k003|by-0,by-2,by-3|||k001|||F|-',
  'contested|-|||k000,k002||k001,k003|k004=no-approval,k005=stale-version,k006=stale-version||F|F',
];

test('WR-06 the one-pass algebra gives the same result as the old fixpoint on 40 seeded random inputs of up to 12 acts', () => {
  const lines: string[] = [];
  for (let seed = 1; seed <= 40; seed += 1) {
    const random = rng(seed * 7919);
    const { acts, before, known } = randomCase(random, 1 + random.int(12));
    const result = resolveDecisions({ versionHash: HASH, acts, before, isKnownEntry: (id) => known.has(id), strict: false });
    lines.push(line(result));
    // Order independence holds for these inputs too.
    const reversed = resolveDecisions({ versionHash: HASH, acts: [...acts].reverse(), before, isKnownEntry: (id) => known.has(id), strict: false });
    assert.deepEqual(reversed, result, `seed ${seed}`);
  }
  assert.deepEqual(lines, FROZEN);
});

test('WR-06 for 200 acts on one version the injected before relation is called at most 2 * 200 * 200 times, and the result is order independent', () => {
  const random = rng(2026);
  const names = Array.from({ length: 200 }, (_, index) => `n${String(index).padStart(3, '0')}`);
  const ancestors = new Map<string, Set<string>>();
  const acts: DecisionAct[] = names.map((id, index) => {
    const past = new Set<string>();
    for (let earlier = 0; earlier < index; earlier += 1) {
      if (random.chance(0.03)) { past.add(names[earlier]); for (const further of ancestors.get(names[earlier]) ?? []) past.add(further); }
    }
    ancestors.set(id, past);
    const seen = names.slice(0, index).filter(() => random.chance(0.05));
    return { id, outcome: random.chance(0.5) ? 'approve' : 'reject', by: `by-${random.int(6)}`, versionHash: HASH, seen, confirmed: true, final: false };
  });
  let calls = 0;
  const before = (a: string, b: string): boolean => { calls += 1; return ancestors.get(b)?.has(a) ?? false; };
  const result = resolveDecisions({ versionHash: HASH, acts: shuffled(acts, random), before, isKnownEntry: () => false, strict: true });
  assert.ok(calls <= 2 * 200 * 200, `before was called ${calls} times`);
  assert.ok(result.status === 'effective' || result.status === 'contested');
  assert.deepEqual(result.held, []);
  const again = resolveDecisions({ versionHash: HASH, acts: [...acts].reverse(), before: (a, b) => ancestors.get(b)?.has(a) ?? false, isKnownEntry: () => false, strict: true });
  assert.deepEqual(again, result);
});

test('WR-06 a long chain of seen links settles to its last act without a repeated fixpoint, in any input order', () => {
  // 300 acts where each saw only the one before it: the old fixpoint widened the ancestor sets a little at a time, round after round.
  const id = (index: number): string => `c${String(index).padStart(3, '0')}`;
  const acts = Array.from({ length: 300 }, (_, index) => act(id(index), index % 2 === 0 ? 'approve' : 'reject', { seen: index === 0 ? [] : [id(index - 1)] }));
  const forward = resolveDecisions({ versionHash: HASH, acts, before: () => false, isKnownEntry: () => false, strict: true });
  const backward = resolveDecisions({ versionHash: HASH, acts: [...acts].reverse(), before: () => false, isKnownEntry: () => false, strict: true });
  assert.deepEqual(backward, forward);
  assert.equal(forward.outcome, 'REJECT');
  assert.deepEqual(forward.effective, [id(299)]);
  assert.equal(forward.superseded.length, 299);
});

/** A graph entry with only the fields the causal graph reads. */
function node(hash: string, lamport: number, prev: string, deps: string[] = []): GraphEntry {
  return { hash, header: { prev } as EntryHeader, body: { deps: deps.map((dep) => ({ hash: dep })), lamport } as unknown as EntryBody };
}

test('WR-06 isBefore answers false at once when the first entry\'s lamport is not below the second\'s, without building an ancestor set', () => {
  // a1 <- a2 <- a3 on one writer, b1 on another, and c2 after b1 and a1.
  const graph = buildCausalGraph([node('a1', 1, GENESIS_PREV), node('a2', 2, 'a1'), node('a3', 3, 'a2'), node('b1', 1, GENESIS_PREV), node('c2', 2, 'b1', ['a1'])]);
  assert.equal(graph.stats().pastsBuilt, 0);
  assert.equal(graph.isBefore('a3', 'a1'), false);
  assert.equal(graph.isBefore('a2', 'c2'), false);
  assert.equal(graph.isBefore('b1', 'a1'), false);
  assert.equal(graph.isBefore('a1', 'a1'), false);
  assert.equal(graph.isBefore('ghost', 'a3'), false);
  assert.equal(graph.concurrent('a2', 'c2'), true);
  assert.equal(graph.stats().pastsBuilt, 0, 'no ancestor set was built for a pair the lamport bound settles');
  // A real ancestor still answers true, and builds the one set it needs.
  assert.equal(graph.isBefore('a1', 'a3'), true);
  assert.equal(graph.stats().pastsBuilt, 1);
  assert.equal(graph.isBefore('a1', 'c2'), true);
  assert.equal(graph.isBefore('b1', 'a3'), false);
  assert.equal(graph.concurrent('b1', 'a3'), true);
  assert.equal(graph.concurrent('a1', 'c2'), false);
  assert.equal(graph.stats().pastsBuilt, 2);
});

test('WR-06 a graph whose lamports do not rise along every edge never uses the bound, so its answers stay the true ancestor relation', () => {
  // x2 follows x1 but carries a smaller lamport: only an entry the chain would refuse looks like this. The bound would wrongly answer "not before".
  const graph = buildCausalGraph([node('x1', 5, GENESIS_PREV), node('x2', 3, 'x1'), node('y1', 1, GENESIS_PREV)]);
  assert.equal(graph.isBefore('x1', 'x2'), true);
  assert.equal(graph.concurrent('x1', 'x2'), false);
  assert.equal(graph.isBefore('x2', 'x1'), false);
  assert.equal(graph.concurrent('y1', 'x2'), true);
});
