// The decision algebra for one version (D-25, DESIGN 6.4 and 15.5): a pure function of the acts made on the version and a causal relation.
// It never reads fold order, array order, rank, names or time. Callers pass graph.isBefore as `before`; this file imports nothing.
// Maximal acts under causal-or-seen precedence are grouped into outcome classes: one class is effective, more than one is contested.

export const DECISION_OUTCOMES = ['approve', 'reject', 'release', 'withdraw', 'supersede', 'decline'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];
export type DecisionClass = 'APPROVE' | 'REJECT' | 'WITHDRAW' | 'SUPERSEDE';

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

/** Maximal confirmed acts, their classes, and which unconfirmed acts are still pending. `preceded(x, y)` is true when x is in y's past. */
function settle(members: readonly DecisionAct[], preceded: (x: DecisionAct, y: DecisionAct) => boolean): Settled {
  const counting = members.filter((m) => m.confirmed && m.outcome !== 'decline');
  const settlers = members.filter((m) => m.confirmed);
  const max = counting.filter((m) => !counting.some((o) => o !== m && preceded(o, m)));
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

  // A decision seen that nobody knows holds the act; an act that saw a held act is held with it.
  const ids = new Set(unique.map((act) => act.id));
  const heldIds = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const act of active) {
      if (heldIds.has(act.id)) continue;
      if (act.seen.some((id) => heldIds.has(id) || !(ids.has(id) || input.isKnownEntry(id)))) { heldIds.add(act.id); changed = true; }
    }
  }
  for (const id of [...heldIds].sort(compareText)) held.push({ id, reason: 'unknown-decision-seen' });
  active = active.filter((act) => !heldIds.has(act.id));

  // Precedence: x precedes y when x is in y's causal past or y saw x; closed transitively (deps are capped, so neither alone is enough).
  const closureOf = (acts: readonly DecisionAct[]): Map<string, Set<string>> => {
    const past = new Map<string, Set<string>>();
    for (const y of acts) {
      past.set(y.id, new Set(acts.filter((x) => x.id !== y.id && (input.before(x.id, y.id) || y.seen.includes(x.id))).map((x) => x.id)));
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const set of past.values()) {
        for (const id of [...set]) {
          for (const further of past.get(id) ?? []) {
            if (!set.has(further)) { set.add(further); changed = true; }
          }
        }
      }
    }
    return past;
  };
  let closure = closureOf(active);
  const cyclic = active.filter((act) => closure.get(act.id)?.has(act.id) ?? false).map((act) => act.id);
  if (cyclic.length > 0) {
    for (const id of cyclic.sort(compareText)) held.push({ id, reason: 'precedence-cycle' });
    active = active.filter((act) => !cyclic.includes(act.id));
    closure = closureOf(active);
  }
  const preceded = (x: DecisionAct, y: DecisionAct): boolean => closure.get(y.id)?.has(x.id) ?? false;

  const valid = settleValidity(active, closure, preceded, refused);
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

/**
 * Which acts are valid in their own causal past (D-25, D-37). Acts are visited with the smaller pasts first, so every act meets its past
 * already judged. Valid means: not after an effective withdraw or supersede (terminal, unless the act's past is itself contested), a release
 * with an effective approval in its past, a supersede with a release in its past, a decline that saw only unconfirmed acts.
 */
function settleValidity(
  active: readonly DecisionAct[],
  closure: Map<string, Set<string>>,
  preceded: (x: DecisionAct, y: DecisionAct) => boolean,
  refused: { id: string; reason: DecisionRefusal }[],
): DecisionAct[] {
  const visit = [...active].sort((a, b) => ((closure.get(a.id)?.size ?? 0) - (closure.get(b.id)?.size ?? 0)) || compareText(a.id, b.id));
  const valid: DecisionAct[] = [];
  for (const act of visit) {
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
