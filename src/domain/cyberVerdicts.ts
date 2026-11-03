import type { Finding, Verdict } from './cyber';

// The four verdicts (D-24) and the one place their language is decided. A failure never renders as
// "clean": every failure verdict names its reason, and the SARIF level keeps "the exploit ran and
// failed" distinguishable from "the target is patched" (CYBER-09).

export const VERDICT_LANGUAGE: Record<Verdict, string> = {
  not_vulnerable: 'Target is not vulnerable to {test}',
  exploit_failed: 'Exploit attempt failed — {reason}',
  could_not_determine: 'Unable to determine — {reason}',
  verified_access: 'Verified access — {evidence}'
};

/** The two verdicts that must carry a reason, because their meaning depends on it. */
export function requiresReason(verdict: Verdict): boolean {
  return verdict === 'exploit_failed' || verdict === 'could_not_determine';
}

export type SarifLevel = 'error' | 'warning' | 'note' | 'pass';

/** D-24 to SARIF: access is an error, a failed or inconclusive attempt is a note, a pass is a pass. */
export function verdictToSarifLevel(verdict: Verdict): SarifLevel {
  switch (verdict) {
    case 'verified_access': return 'error';
    case 'exploit_failed': return 'note';
    case 'could_not_determine': return 'note';
    case 'not_vulnerable': return 'pass';
  }
}

export class VerdictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'VerdictError';
  }
}

/** The substitution values a verdict sentence needs, taken from the finding. */
export interface VerdictParts {
  /** The test name, e.g. "missing-hsts"; defaults to the finding's checkId. */
  test?: string;
  evidence?: string;
}

/**
 * The finding's verdict line. A verdict that requires a reason is refused rather than rendered with
 * an empty slot, so "exploit failed — " can never reach a report (CYBER-09's prohibition).
 */
export function renderVerdict(finding: Pick<Finding, 'verdict' | 'checkId' | 'reason' | 'title'>, parts: VerdictParts = {}): string {
  const template = VERDICT_LANGUAGE[finding.verdict];
  if (!template) throw new VerdictError(`Unknown verdict "${String(finding.verdict)}".`);
  const reason = (finding.reason ?? '').trim();
  if (requiresReason(finding.verdict) && !reason) {
    throw new VerdictError(`A "${finding.verdict}" verdict needs a reason; ${finding.checkId} has none.`);
  }
  const evidence = (parts.evidence ?? finding.reason ?? finding.title).trim();
  return template
    .replace('{test}', parts.test ?? finding.checkId)
    .replace('{reason}', reason)
    .replace('{evidence}', evidence);
}

/** Every verdict's rendered line, in report order, for the summary table. */
export function verdictSummary(findings: Array<Pick<Finding, 'verdict' | 'checkId' | 'reason' | 'title'>>): string[] {
  return findings.map((finding) => renderVerdict(finding));
}
