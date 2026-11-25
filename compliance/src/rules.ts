// Turns evidence into RuleResults (44-01). A rule's result says passed or not, why, when and from which commit; it never says met. The state is
// computeStatus's alone (status.ts). 44-07 adds the checkout scan of mapped tests (checkRuleTargets), so a moved, renamed or deleted test is told
// apart from one that did not run (D-21, pitfall 15).
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sourcePathForReport, type EvidenceRule, type Observation, type ReasonCode, type RuleResult, type TestReportRow, type WindowKind } from './model.ts';

/** Where a rule is being evaluated: the commit the evidence was collected at, when, and (for relay or hub reports) the package prefix. */
export interface RuleContext {
  readonly commit: string;
  /** ISO time the report or bundle was collected. */
  readonly collectedAt: string;
  readonly packagePrefix?: string;
  readonly runUrl?: string;
  /** Rule id to the state of its mapped test in the checkout (checkRuleTargets). A rule whose target is not ok fails with that reason first. */
  readonly targets?: ReadonlyMap<string, TargetState>;
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
  crypto: 'document',
  attestation: 'attestation',
  attestations: 'attestation',
  // A site's signed export (48-02): dated at its signed time, so an export older than 7 days reads Stale.
  deployment: 'settings',
  // 48.2 (D-13, D-15, D-23): the image's vulnerability scan, dated by its database build date; the site collector's live facts; the
  // site's exchange agreements, dated by their review date.
  'image-scan': 'vulnerability',
  'site-live': 'live',
  'site-agreements': 'document'
});

/** The window for a collector id; unknown collectors are judged against the head commit. */
export function windowForCollector(collector: string, subject?: string): WindowKind {
  if (collector === 'settings' && subject === 'codeowners-valid') return 'head';
  return Object.hasOwn(OBSERVATION_WINDOWS, collector) ? OBSERVATION_WINDOWS[collector] : 'head';
}

/** Where a test rule's mapped test stands in the checkout: present, its file gone, or its name (or a suite name around it) gone from the file. */
export type TargetState = 'ok' | 'test-missing-file' | 'test-missing-name';

/** A test source file larger than this is not read and counts as missing. */
export const MAX_TEST_SOURCE_BYTES = 16 * 1024 * 1024;

/**
 * The forms a name takes as a JavaScript string literal: single-quoted, double-quoted (JSON form) and a template literal without substitutions.
 * A name built at run time (a template with `${...}`, concatenation) has no literal form and cannot be mapped.
 */
function literalForms(name: string): string[] {
  const escape = (quote: string): string => name.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`).replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t');
  return [`'${escape("'")}'`, JSON.stringify(name), `\`${escape('`').replaceAll('${', '\\${')}\``];
}

/** True when `name` appears in `source` as a whole quoted string literal in one of the three quote forms. */
export function hasStringLiteral(source: string, name: string): boolean {
  return literalForms(name).some((form) => source.includes(form));
}

/** A rule's file as a path inside repoRoot, or undefined when it is absolute, escapes the root or uses backslashes. */
function sourceFileIn(repoRoot: string, file: string): string | undefined {
  if (file === '' || file.includes('\\') || path.isAbsolute(file) || file.split('/').some((part) => part === '..' || part === '')) return undefined;
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, file);
  return resolved.startsWith(root + path.sep) ? resolved : undefined;
}

/**
 * Checks each test rule's mapped test against the checkout under repoRoot: the source file must exist as a regular file (not a link) inside the
 * checkout, and the test name and each suite name of its path must appear in it as a quoted string literal. Each file is read once. Observation
 * rules have no target and get no entry. Returns rule id to TargetState.
 */
export function checkRuleTargets(rules: readonly EvidenceRule[], repoRoot: string): ReadonlyMap<string, TargetState> {
  const sources = new Map<string, string | null>();
  const sourceOf = (file: string): string | null => {
    if (sources.has(file)) return sources.get(file) ?? null;
    let text: string | null = null;
    const resolved = sourceFileIn(repoRoot, file);
    if (resolved) {
      try {
        const stat = lstatSync(resolved);
        if (stat.isFile() && stat.size <= MAX_TEST_SOURCE_BYTES) text = readFileSync(resolved, 'utf8');
      } catch {
        text = null;
      }
    }
    sources.set(file, text);
    return text;
  };
  const targets = new Map<string, TargetState>();
  for (const rule of rules) {
    if (rule.kind !== 'test') continue;
    const target = rule.test;
    const source = target && typeof target.file === 'string' ? sourceOf(target.file) : null;
    if (!target || source === null) { targets.set(rule.id, 'test-missing-file'); continue; }
    const names = [...target.path, target.name];
    targets.set(rule.id, names.every((name) => typeof name === 'string' && hasStringLiteral(source, name)) ? 'ok' : 'test-missing-name');
  }
  return targets;
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
 * Evaluates a test rule. When the context carries targets (checkRuleTargets), a target that is not ok decides first: test-missing-file or
 * test-missing-name. Otherwise the rows of the per-test report decide: the row must match the rule's source file (after sourcePathForReport), suite
 * path and name exactly; the worst matching row gives met, test-failed, test-skipped or test-todo, and no matching row gives test-not-run.
 */
export function evaluateTestRule(rule: EvidenceRule, rows: readonly TestReportRow[], context: RuleContext): RuleResult {
  const base = { rule: rule.id, collectedAt: context.collectedAt, commit: context.commit, window: 'head' as const, ...(context.runUrl ? { runUrl: context.runUrl } : {}) };
  const target = rule.kind === 'test' ? rule.test : undefined;
  if (!target) return { ...base, passed: false, reason: 'missing-result' };
  const targetState = context.targets?.get(rule.id);
  if (targetState !== undefined && targetState !== 'ok') return { ...base, passed: false, reason: targetState };
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
 * context's collection time); one that did not pass gives observation-failed. Settings evidence for the CODEOWNERS file follows the assessed commit.
 */
export function evaluateObservationRule(rule: EvidenceRule, observations: readonly Observation[], context: RuleContext): RuleResult {
  const target = rule.kind === 'observation' ? rule.observation : undefined;
  const window = windowForCollector(target?.collector ?? '', target?.subject);
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
