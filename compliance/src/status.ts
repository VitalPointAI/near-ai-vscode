// The status engine (D-17 to D-20). It derives every public state from evidence, tailoring and the clock.
import { FRESHNESS, STATES, type ComponentRow, type ReasonCode, type RuleResult, type State, type Statement, type StatusInput, type StatusOutcome } from './model.ts';

export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export function isFresh(result: RuleResult, head: string, now: Date): boolean {
  const window = FRESHNESS[result.window];
  if (window === undefined) return false;
  if (window === 'head') return typeof result.commit === 'string' && result.commit !== '' && result.commit === head;
  const at = Date.parse(result.collectedAt);
  return !Number.isNaN(at) && now.getTime() - at >= -FUTURE_TOLERANCE_MS && now.getTime() - at <= window;
}

const resultPassed = (result: RuleResult): boolean => result.passed === true && result.reason === 'met';
const failureReason = (result: RuleResult): ReasonCode => result.reason === 'met' ? 'missing-result' : result.reason;

function withRiskAcceptance(input: StatusInput, outcome: StatusOutcome): StatusOutcome {
  const acceptance = input.riskAcceptance;
  if (acceptance && outcome.state === 'not-met' && acceptance.controls.includes(input.control) && (acceptance.levels === undefined || acceptance.levels.includes(input.level)) && Date.parse(acceptance.expiresAt) > input.now.getTime()) return { state: 'not-met', reason: 'risk-accepted', detail: { date: acceptance.expiresAt } };
  return outcome;
}

function statementStatus(input: StatusInput, statement: Statement): StatusOutcome {
  const rules = (Object.hasOwn(input.rulesByStatement, statement.id) ? input.rulesByStatement[statement.id] : []) ?? [];
  if (rules.length === 0) return { state: 'not-met', reason: 'no-rules' };
  const results: RuleResult[] = [];
  for (const rule of rules) {
    const result = Object.hasOwn(input.results, rule.id) ? input.results[rule.id] : undefined;
    if (!result) return { state: 'not-met', reason: 'missing-result' };
    results.push(result);
  }
  const failed = results.find((result) => !resultPassed(result));
  if (failed) return { state: 'not-met', reason: failureReason(failed) };
  const stale = results.filter((result) => !isFresh(result, input.head, input.now));
  return stale.length === 0 ? { state: 'met', reason: 'met' } : { state: 'stale', reason: 'stale', detail: { date: stale.map((result) => result.collectedAt).sort()[0] } };
}

function applyHonestyRules(input: StatusInput, statements: readonly Statement[], outcome: StatusOutcome): StatusOutcome {
  const unsettled = input.unsettled ?? statements.find((statement) => statement.unsettled)?.unsettled;
  if (unsettled) return withRiskAcceptance(input, { state: 'not-met', reason: 'unsettled', detail: { question: unsettled } });
  if (input.selfSigned === true && statements.some((statement) => statement.requiresOfficialSignature === true)) return withRiskAcceptance(input, { state: 'not-met', reason: 'self-signed' });
  return withRiskAcceptance(input, outcome);
}

/** Computes one component's row; no input field is itself a status. */
export function computeStatus(input: StatusInput): StatusOutcome {
  if (input.responsibility === 'your-organization') return { state: 'your-organizations-responsibility', reason: 'your-organization' };
  if (input.responsibility === 'inherited') return { state: 'your-organizations-responsibility', reason: 'inherited' };
  const tailoring = input.tailoring;
  const reviewed = tailoring !== undefined && tailoring.reason.trim() !== '' && tailoring.reviewer.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(tailoring.reviewedAt);
  if (input.responsibility === 'not-applicable' || tailoring !== undefined) return reviewed ? { state: 'not-applicable', reason: 'not-applicable', detail: { reason: tailoring!.reason } } : withRiskAcceptance(input, { state: 'not-met', reason: 'not-applicable-unreviewed' });
  if (input.responsibility !== 'product' && input.responsibility !== 'shared') return withRiskAcceptance(input, { state: 'not-met', reason: 'no-statement' });
  const statements = input.statements;
  if (statements.length === 0) return withRiskAcceptance(input, { state: 'not-met', reason: 'no-statement' });
  const outcomes = statements.map((statement) => statementStatus(input, statement));
  const limitation = input.limitation ?? statements.find((statement) => statement.limitation)?.limitation;
  if (outcomes.every((outcome) => outcome.state === 'met')) return applyHonestyRules(input, statements, limitation ? { state: 'partly-met', reason: 'limitation', detail: { text: limitation } } : { state: 'met', reason: 'met' });
  if (outcomes.every((outcome) => outcome.state === 'met' || outcome.state === 'stale') && outcomes.some((outcome) => outcome.state === 'stale')) {
    const dates = outcomes.flatMap((outcome) => outcome.state === 'stale' && outcome.detail?.date ? [outcome.detail.date] : []);
    return applyHonestyRules(input, statements, { state: 'stale', reason: 'stale', detail: { date: dates.sort()[0] ?? input.now.toISOString() } });
  }
  if (outcomes.some((outcome) => outcome.state === 'met' || outcome.state === 'partly-met') && outcomes.some((outcome) => outcome.state === 'not-met')) return applyHonestyRules(input, statements, { state: 'partly-met', reason: 'partly-statements' });
  return applyHonestyRules(input, statements, outcomes.find((outcome) => outcome.state === 'not-met') ?? outcomes[0]);
}

export function aggregateControl(rows: readonly ComponentRow[]): StatusOutcome {
  const assessable = rows.filter((row) => row.responsibility === 'product' || row.responsibility === 'shared');
  if (assessable.length === 0) {
    if (rows.some((row) => row.responsibility === 'your-organization' || row.responsibility === 'inherited')) return { state: 'your-organizations-responsibility', reason: 'your-organization' };
    if (rows.length > 0 && rows.every((row) => row.state === 'not-applicable')) return { state: 'not-applicable', reason: 'not-applicable' };
    return { state: 'not-met', reason: 'no-statement' };
  }
  const states = assessable.map((row) => row.state);
  if (states.every((state) => state === 'met')) return { state: 'met', reason: 'met' };
  if (states.every((state) => state === 'met' || state === 'stale') && states.includes('stale')) return { state: 'stale', reason: 'stale' };
  if (states.some((state) => state === 'met' || state === 'partly-met') && states.some((state) => state === 'not-met' || state === 'stale')) return { state: 'partly-met', reason: 'partly-statements' };
  if (states.every((state) => state === 'partly-met')) return { state: 'partly-met', reason: 'partly-statements' };
  const first = assessable.find((row) => row.state === 'not-met' || row.state === 'stale' || row.state === 'partly-met');
  return first ? { state: first.state, reason: first.reason, ...(first.detail ? { detail: first.detail } : {}) } : { state: 'not-met', reason: 'no-statement' };
}

export type LevelSummary = Readonly<Record<State, number>> & { readonly notMetTotal: number; readonly metTotal: number };
export function summarizeLevel(rows: readonly Pick<StatusOutcome, 'state'>[]): LevelSummary {
  const counts = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<State, number>;
  for (const row of rows) counts[row.state] += 1;
  return { ...counts, notMetTotal: counts['not-met'] + counts.stale, metTotal: counts.met };
}
