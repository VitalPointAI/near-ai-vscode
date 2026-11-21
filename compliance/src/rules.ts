// Turns evidence into RuleResults (44-01). A rule's result says passed or not, why, when and from which commit; it never says met. The state is
// computeStatus's alone (status.ts).
import { sourcePathForReport, type EvidenceRule, type Observation, type ReasonCode, type RuleResult, type TestReportRow, type WindowKind } from './model.ts';

/** Where a rule is being evaluated: the commit the evidence was collected at, when, and (for relay or hub reports) the package prefix. */
export interface RuleContext {
  readonly commit: string;
  /** ISO time the report or bundle was collected. */
  readonly collectedAt: string;
  readonly packagePrefix?: string;
  readonly runUrl?: string;
}

/**
 * The freshness window of each collector kind (D-09). A collector not listed here produces evidence about the commit itself, judged against the
 * head (CI checks, mapped tests, the secret scan, workflow hardening and the rest).
 */
export const OBSERVATION_WINDOWS: Readonly<Record<string, WindowKind>> = Object.freeze({
  audit: 'audit',
  settings: 'settings',
  harness: 'harness',
  document: 'document',
  documents: 'document',
  attestation: 'attestation',
  attestations: 'attestation'
});

/** The window for a collector id; unknown collectors are judged against the head commit. */
export function windowForCollector(collector: string): WindowKind {
  return Object.hasOwn(OBSERVATION_WINDOWS, collector) ? OBSERVATION_WINDOWS[collector] : 'head';
}

const TEST_STATUS_REASON: Readonly<Record<TestReportRow['status'], ReasonCode>> = Object.freeze({
  passed: 'met',
  failed: 'test-failed',
  todo: 'test-todo',
  skipped: 'test-skipped'
});

/** When the same test appears more than once, the worst row wins. */
const TEST_STATUS_RANK: Readonly<Record<TestReportRow['status'], number>> = Object.freeze({ failed: 0, todo: 1, skipped: 2, passed: 3 });

const samePath = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((part, index) => part === b[index]);

/**
 * Evaluates a test rule against the rows of one per-test report. The row must match the rule's source file (after sourcePathForReport), suite path
 * and name exactly. No matching row gives test-not-run (44-07 separates a missing file and a missing name with a checkout scan).
 */
export function evaluateTestRule(rule: EvidenceRule, rows: readonly TestReportRow[], context: RuleContext): RuleResult {
  const base = { rule: rule.id, collectedAt: context.collectedAt, commit: context.commit, window: 'head' as const, ...(context.runUrl ? { runUrl: context.runUrl } : {}) };
  const target = rule.kind === 'test' ? rule.test : undefined;
  if (!target) return { ...base, passed: false, reason: 'missing-result' };
  let worst: TestReportRow | undefined;
  for (const row of rows) {
    if (sourcePathForReport(row.file, context.packagePrefix) !== target.file || !samePath(row.path, target.path) || row.name !== target.name) continue;
    const rank = TEST_STATUS_RANK[row.status];
    if (rank === undefined) { worst = { ...row, status: 'failed' }; break; }
    if (!worst || rank < TEST_STATUS_RANK[worst.status]) worst = row;
  }
  if (!worst) return { ...base, passed: false, reason: 'test-not-run' };
  const reason = TEST_STATUS_REASON[worst.status];
  return { ...base, passed: reason === 'met', reason };
}

/**
 * Evaluates an observation rule: the newest observation with the rule's collector and subject decides. None gives missing-result (dated at the
 * context's collection time); one that did not pass gives observation-failed. The window comes from the collector kind (OBSERVATION_WINDOWS).
 */
export function evaluateObservationRule(rule: EvidenceRule, observations: readonly Observation[], context: RuleContext): RuleResult {
  const target = rule.kind === 'observation' ? rule.observation : undefined;
  const window = windowForCollector(target?.collector ?? '');
  let newest: Observation | undefined;
  let newestAt = -Infinity;
  if (target) {
    for (const observation of observations) {
      if (observation.collector !== target.collector || observation.subject !== target.subject) continue;
      const at = Date.parse(observation.collectedAt);
      const atOrOldest = Number.isNaN(at) ? -Infinity : at;
      if (!newest || atOrOldest > newestAt) { newest = observation; newestAt = atOrOldest; }
    }
  }
  if (!newest) {
    return { rule: rule.id, passed: false, reason: 'missing-result', collectedAt: context.collectedAt, commit: context.commit, window, ...(context.runUrl ? { runUrl: context.runUrl } : {}) };
  }
  return {
    rule: rule.id,
    passed: newest.passed === true,
    reason: newest.passed === true ? 'met' : 'observation-failed',
    collectedAt: newest.collectedAt,
    ...(newest.commit ? { commit: newest.commit } : {}),
    window,
    ...(newest.runUrl ? { runUrl: newest.runUrl } : {})
  };
}
