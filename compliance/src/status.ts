// The status engine (D-17, D-18, D-19). computeStatus is a pure function of statements, responsibility, rules, results, the head commit and the
// clock, and the only code that produces a State. Nothing it reads carries a state.
//
// 44-01 rules: your-organization and inherited are your organization's responsibility (never met in the public view); not-applicable needs a reviewed
// tailoring record (44-04), so here it is not met; then no statements, a statement with no rules, a rule with no result, a failed result, a result
// outside its window (stale) and finally met. Tailoring, unsettled questions, self-signed decisions, limitations and risk acceptances never raise a
// row above not met here; 44-04 gives each its own rule without changing this signature.
import { FRESHNESS, type ReasonCode, type RuleResult, type StatusInput, type StatusOutcome } from './model.ts';

/** How far ahead of the clock a result's time may be (clock skew) before it no longer counts as fresh. */
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** True when a passed result is still inside its freshness window (D-09). */
export function isFresh(result: RuleResult, head: string, now: Date): boolean {
  const window = FRESHNESS[result.window];
  if (window === undefined) return false;
  if (window === 'head') return typeof result.commit === 'string' && result.commit !== '' && result.commit === head;
  const at = Date.parse(result.collectedAt);
  if (Number.isNaN(at)) return false;
  const age = now.getTime() - at;
  return age >= -FUTURE_TOLERANCE_MS && age <= window;
}

/** A result counts as passed only when it says so and carries the met reason; anything else is a failure with its own reason. */
const resultPassed = (result: RuleResult): boolean => result.passed === true && result.reason === 'met';
const failureReason = (result: RuleResult): ReasonCode => (result.reason === 'met' ? 'missing-result' : result.reason);

/** Computes one level, control and component's state from evidence and the clock only. */
export function computeStatus(input: StatusInput): StatusOutcome {
  if (input.responsibility === 'your-organization') return { state: 'your-organizations-responsibility', reason: 'your-organization' };
  if (input.responsibility === 'inherited') return { state: 'your-organizations-responsibility', reason: 'inherited' };
  if (input.responsibility === 'not-applicable') return { state: 'not-met', reason: 'not-applicable-unreviewed' };
  if (input.responsibility !== 'product' && input.responsibility !== 'shared') return { state: 'not-met', reason: 'no-statement' };

  const statements = input.statements ?? [];
  if (statements.length === 0) return { state: 'not-met', reason: 'no-statement' };

  const rules = statements.map((statement) => (Object.hasOwn(input.rulesByStatement ?? {}, statement.id) ? input.rulesByStatement[statement.id] : []) ?? []);
  if (rules.some((list) => list.length === 0)) return { state: 'not-met', reason: 'no-rules' };

  const results: RuleResult[] = [];
  for (const rule of rules.flat()) {
    const result = Object.hasOwn(input.results ?? {}, rule.id) ? input.results[rule.id] : undefined;
    if (!result) return { state: 'not-met', reason: 'missing-result' };
    results.push(result);
  }
  const failed = results.find((result) => !resultPassed(result));
  if (failed) return { state: 'not-met', reason: failureReason(failed) };

  let outcome: StatusOutcome = { state: 'met', reason: 'met' };
  const stale = results.filter((result) => !isFresh(result, input.head, input.now));
  if (stale.length > 0) {
    const oldest = stale.map((result) => result.collectedAt).sort()[0];
    outcome = { state: 'stale', reason: 'stale', detail: { date: oldest } };
  }

  // Never upward: each of these can only keep a row at or below not met in 44-01.
  const unsettled = input.unsettled ?? statements.find((statement) => statement.unsettled)?.unsettled;
  if (unsettled) return { state: 'not-met', reason: 'unsettled', detail: { question: unsettled } };
  if (input.selfSigned === true && statements.some((statement) => statement.requiresOfficialSignature === true)) return { state: 'not-met', reason: 'self-signed' };
  const limitation = input.limitation ?? statements.find((statement) => statement.limitation)?.limitation;
  if (limitation) return { state: 'not-met', reason: 'limitation', detail: { text: limitation } };
  return outcome;
}
