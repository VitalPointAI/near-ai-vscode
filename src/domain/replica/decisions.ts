// The decision algebra for one version (D-25, DESIGN 6.4 and 15.5): a pure function of the acts made on the version and a causal relation.
// It never reads fold order, array order, rank, names or time. Callers pass graph.isBefore as `before`; this file imports nothing.
// Maximal acts under causal-or-seen precedence are grouped into outcome classes: one class is effective, more than one is contested.

export const DECISION_OUTCOMES = ['approve', 'reject', 'release', 'withdraw', 'supersede', 'decline'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];
export type DecisionClass = 'APPROVE' | 'REJECT' | 'WITHDRAW' | 'SUPERSEDE';

/** The decision outcome recorded by a version act. */
export function recordedDecisionOutcome(kind: string, outcome: unknown): DecisionOutcome | undefined {
  if (kind === 'version.release') return 'release';
  if (kind === 'version.withdraw') return 'withdraw';
  if (kind === 'version.supersede') return 'supersede';
  if (kind !== 'version.decide') return undefined;
  return outcome === 'approve' || outcome === 'reject' || outcome === 'decline' ? outcome : undefined;
}

/** `decline` has no class: it settles unconfirmed acts back to none. */
export const OUTCOME_CLASS: Readonly<Record<string, DecisionClass>> = Object.freeze({
  approve: 'APPROVE', release: 'APPROVE', reject: 'REJECT', withdraw: 'WITHDRAW', supersede: 'SUPERSEDE',
});

export const DECISION_REFUSALS = ['stale-version', 'terminal', 'no-approval', 'no-release', 'decline-not-pending'] as const;
export type DecisionRefusal = (typeof DECISION_REFUSALS)[number];
export type DecisionHold = 'unknown-decision-seen' | 'precedence-cycle';

export interface DecisionAct {
  id: string;
  outcome: DecisionOutcome;
  by: string;
  versionHash: string;
  /** The decision entries this act's author had seen (decisionsSeen). */
  seen: readonly string[];
  /** False when the act was made while its role was being withdrawn concurrently (pending-confirmation). */
  confirmed: boolean;
  /** True when the act sits under a checkpoint prefix. Changes wording only. */
  final: boolean;
}

export interface DecisionInput {
  versionHash: string;
  acts: readonly DecisionAct[];
  /** True when entry `a` is in the causal past of entry `b`. */
  before(a: string, b: string): boolean;
  /** True when the entry id is known to the caller at all (a decision seen that is not known holds the act). */
  isKnownEntry(id: string): boolean;
  /**
   * When true, a precedence cycle throws instead of being held (IN-01). A cycle cannot happen with real entries, since an entry can only name or
   * follow entries that existed before it; tests set strict so that one can never pass silently. Production leaves it unset and keeps the hold.
   */
  strict?: boolean;
}

export interface DecisionResult {
  status: 'none' | 'effective' | 'contested';
  /** The outcome class when effective. */
  outcome?: DecisionClass;
  /** Ids of the maximal acts when effective, sorted. */
  effective: string[];
  /** Names (`by`) of the effective acts, sorted and without repeats. */
  names: string[];
  /** Ids of the maximal acts when contested, sorted. */
  contested: string[];
  /** Unconfirmed acts no confirmed act or decline has settled, sorted. */
  pending: string[];
  /** Valid acts that a later act or decline has replaced, sorted. */
  superseded: string[];
  refused: { id: string; reason: DecisionRefusal }[];
  held: { id: string; reason: DecisionHold }[];
  /** True when the effective class is WITHDRAW or SUPERSEDE. */
  terminal: boolean;
  /** True when the result is contested and one maximal act is under a checkpoint prefix and another is not. Wording only. */
  finalBeforeDispute: boolean;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedIds = (acts: readonly DecisionAct[]): string[] => acts.map((act) => act.id).sort(compareText);
const classOf = (outcome: string): DecisionClass | undefined => (Object.prototype.hasOwnProperty.call(OUTCOME_CLASS, outcome) ? OUTCOME_CLASS[outcome] : undefined);

function actKey(act: DecisionAct): string {
  return JSON.stringify([act.id, act.outcome, act.by, act.versionHash, [...act.seen].sort(compareText), act.confirmed, act.final]);
}

interface Settled { max: DecisionAct[]; classes: DecisionClass[]; pending: DecisionAct[]; superseded: DecisionAct[] }

/** Maximal confirmed acts, their classes, and which unconfirmed acts are still pending. `preceded(x, y)` is true when x is in the past of y. */
function settle(members: readonly DecisionAct[], preceded: (x: DecisionAct, y: DecisionAct) => boolean): Settled {
  const counting = members.filter((m) => m.confirmed && m.outcome !== 'decline');
  const settlers = members.filter((m) => m.confirmed);
  const max = counting.filter((m) => !counting.some((o) => o !== m && preceded(m, o)));
  const pending = members.filter((m) => !m.confirmed && !settlers.some((s) => preceded(m, s)));
  const superseded = members.filter((m) => m.outcome !== 'decline' && !max.includes(m) && !pending.includes(m));
  const classes = [...new Set(max.map((m) => classOf(m.outcome) as DecisionClass))].sort(compareText);
  return { max, classes, pending, superseded };
}

export function resolveDecisions(input: DecisionInput): DecisionResult {
  const refused: { id: string; reason: DecisionRefusal }[] = [];
  const held: { id: string; reason: DecisionHold }[] = [];

  // One act per id, in an order that depends only on the acts themselves, so no later step can see the input order.
  const ordered = [...input.acts].filter((act) => classOf(act.outcome) !== undefined || act.outcome === 'decline')
    .sort((a, b) => compareText(actKey(a), actKey(b)));
  const unique = ordered.filter((act, index) => index === 0 || act.id !== ordered[index - 1].id);

  let active: DecisionAct[] = [];
  for (const act of unique) {
    if (act.versionHash !== input.versionHash) refused.push({ id: act.id, reason: 'stale-version' });
    else active.push(act);
  }

  // A decision seen that nobody knows holds the act that names it, and only that act (WR-09): an act that saw a held act names a known id, so one
  // bogus id cannot hold every honest act made after it.
  const ids = new Set(unique.map((act) => act.id));
  const heldIds = new Set(active.filter((act) => act.seen.some((id) => !(ids.has(id) || input.isKnownEntry(id)))).map((act) => act.id));
  for (const id of [...heldIds].sort(compareText)) held.push({ id, reason: 'unknown-decision-seen' });
  active = active.filter((act) => !heldIds.has(act.id));

  // Precedence: x precedes y when x is in y's causal past or y saw x; closed transitively (deps are capped, so neither alone is enough). The direct
  // edges cost at most one call to `before` per ordered pair; the closure is then built in one pass in topological order (WR-06), since precedence only
  // points from an entry to entries made before it. Acts on a cycle (impossible with real entries, IN-01) are found as strongly connected parts.
  const direct = precedenceEdges(active, input.before);
  const cyclic = cyclicActs(direct).map((index) => active[index].id).sort(compareText);
  if (cyclic.length > 0) {
    if (input.strict === true) throw new Error(`Decision precedence cycle on version ${input.versionHash}: ${cyclic.join(', ')}`);
    for (const id of cyclic) held.push({ id, reason: 'precedence-cycle' });
  }
  const onCycle = new Set(cyclic);
  const { order, closure } = closeInOrder(active, direct, onCycle);
  active = order;
  const preceded = (x: DecisionAct, y: DecisionAct): boolean => closure.get(y.id)?.has(x.id) ?? false;

  const valid = settleValidity(active, preceded, refused);
  const final = settle(valid, preceded);

  const result: DecisionResult = {
    status: 'none', effective: [], names: [], contested: [], pending: sortedIds(final.pending), superseded: sortedIds(final.superseded),
    refused: refused.sort((a, b) => compareText(a.id, b.id)), held: held.sort((a, b) => compareText(a.id, b.id)), terminal: false, finalBeforeDispute: false,
  };
  if (final.classes.length === 1) {
    result.status = 'effective';
    result.outcome = final.classes[0];
    result.effective = sortedIds(final.max);
    result.names = [...new Set(final.max.map((m) => m.by))].sort(compareText);
    result.terminal = final.classes[0] === 'WITHDRAW' || final.classes[0] === 'SUPERSEDE';
  } else if (final.classes.length > 1) {
    result.status = 'contested';
    result.contested = sortedIds(final.max);
    result.finalBeforeDispute = final.max.some((m) => m.final) && final.max.some((m) => !m.final);
  }
  return result;
}

/** For each act, the indexes of the acts directly before it: in its causal past, or named in its seen list. At most one `before` call per ordered pair. */
function precedenceEdges(acts: readonly DecisionAct[], before: (a: string, b: string) => boolean): number[][] {
  return acts.map((y, j) => {
    const seen = new Set(y.seen);
    const preds: number[] = [];
    acts.forEach((x, i) => {
      if (i !== j && (seen.has(x.id) || before(x.id, y.id))) preds.push(i);
    });
    return preds;
  });
}

/** The indexes of the acts that lie on a precedence cycle: members of a strongly connected part with more than one act (Tarjan, without recursion). */
function cyclicActs(preds: readonly number[][]): number[] {
  const n = preds.length;
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const found: number[] = [];
  let counter = 0;
  for (let root = 0; root < n; root += 1) {
    if (index[root] !== -1) continue;
    const work: [number, number][] = [[root, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const [v, next] = frame;
      if (next === 0) { index[v] = counter; low[v] = counter; counter += 1; stack.push(v); onStack[v] = true; }
      if (next < preds[v].length) {
        frame[1] = next + 1;
        const w = preds[v][next];
        if (index[w] === -1) work.push([w, 0]);
        else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      work.pop();
      if (work.length > 0) { const parent = work[work.length - 1][0]; low[parent] = Math.min(low[parent], low[v]); }
      if (low[v] === index[v]) {
        const part: number[] = [];
        for (let w = -1; w !== v;) { w = stack.pop() as number; onStack[w] = false; part.push(w); }
        if (part.length > 1) found.push(...part);
      }
    }
  }
  return found;
}

/**
 * The acts not on a cycle in topological order (every act after all acts before it), and each act's transitive precedence set, built in that one
 * pass: an act's set is its direct predecessors and their sets. A predecessor already in the set is skipped, because its own set is then in it too.
 */
function closeInOrder(acts: readonly DecisionAct[], preds: readonly number[][], onCycle: ReadonlySet<string>): { order: DecisionAct[]; closure: Map<string, Set<string>> } {
  const keep = acts.map((act) => !onCycle.has(act.id));
  const position = new Array<number>(acts.length).fill(-1);
  const order: number[] = [];
  // Depth-first post-order over predecessors puts every act after its predecessors. Roots go in id order so the order depends only on the acts.
  const roots = acts.map((_, i) => i).filter((i) => keep[i]).sort((a, b) => compareText(acts[a].id, acts[b].id));
  for (const root of roots) {
    if (position[root] !== -1) continue;
    const work: [number, number][] = [[root, 0]];
    position[root] = -2;
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const [v, next] = frame;
      if (next < preds[v].length) {
        frame[1] = next + 1;
        const w = preds[v][next];
        if (keep[w] && position[w] === -1) { position[w] = -2; work.push([w, 0]); }
        continue;
      }
      work.pop();
      position[v] = order.length;
      order.push(v);
    }
  }
  const closure = new Map<string, Set<string>>();
  for (const v of order) {
    const set = new Set<string>();
    const direct = preds[v].filter((w) => keep[w]).sort((a, b) => position[b] - position[a]);
    for (const w of direct) {
      if (set.has(acts[w].id)) continue;
      set.add(acts[w].id);
      for (const further of closure.get(acts[w].id) as Set<string>) set.add(further);
    }
    closure.set(acts[v].id, set);
  }
  return { order: order.map((v) => acts[v]), closure };
}

/**
 * Which acts are valid in their own causal past (D-25, D-37). Acts are visited in topological order, so every act meets its past already judged. Valid means: not after an effective withdraw or supersede (terminal, unless the act's past is itself contested), a release
 * with an effective approval in its past, a supersede with a release in its past, a decline that saw only unconfirmed acts.
 */
function settleValidity(
  ordered: readonly DecisionAct[],
  preceded: (x: DecisionAct, y: DecisionAct) => boolean,
  refused: { id: string; reason: DecisionRefusal }[],
): DecisionAct[] {
  const valid: DecisionAct[] = [];
  for (const act of ordered) {
    const past = valid.filter((x) => preceded(x, act));
    const inPast = settle(past, preceded);
    const only = inPast.classes.length === 1 ? inPast.classes[0] : undefined;
    let reason: DecisionRefusal | undefined;
    if (only === 'WITHDRAW' || only === 'SUPERSEDE') reason = 'terminal';
    else if (act.outcome === 'release' && only !== 'APPROVE') reason = 'no-approval';
    else if (act.outcome === 'supersede' && !past.some((x) => x.outcome === 'release')) reason = 'no-release';
    else if (act.outcome === 'decline') {
      const saw = past.filter((x) => x.outcome !== 'decline');
      if (saw.length === 0 || saw.some((x) => x.confirmed)) reason = 'decline-not-pending';
    }
    if (reason) refused.push({ id: act.id, reason });
    else valid.push(act);
  }
  return valid;
}
