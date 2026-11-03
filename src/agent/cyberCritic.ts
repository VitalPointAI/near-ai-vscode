import type { Finding } from '../domain/cyber';

// The critic (CYBER-05, D-22): a finding is only trusted when a reproduction command or captured
// evidence supports it. When neither exists the critic says exactly what is missing, and it may ask
// for a bounded number of re-probes before declaring the finding unverified — never silently accept.

/** How many re-probe attempts one finding may ask for before it stays unverified. */
export const REPROBE_ATTEMPTS = 2;

export interface CriticEvidence {
  /** Whether the recorded evidence blob exists in the store. */
  has(hash: string): Promise<boolean>;
}

export interface VerifyResult {
  verified: boolean;
  /** Always present when unverified: names the support that is missing. */
  reason: string;
}

/** A finding verifies when it can be reproduced or when its evidence blob is actually stored. */
export async function verifyFinding(finding: Finding, evidence: CriticEvidence): Promise<VerifyResult> {
  const reproduction = finding.reproductionCommand?.trim() ?? '';
  const hash = finding.evidenceHash?.trim() ?? '';
  const stored = hash ? await evidence.has(hash).catch(() => false) : false;
  if (reproduction && stored) return { verified: true, reason: 'A reproduction command and a stored evidence blob support this finding.' };
  if (reproduction) return { verified: true, reason: 'A reproduction command supports this finding.' };
  if (stored) return { verified: true, reason: 'A stored evidence blob supports this finding.' };
  const missing = [hash ? `evidence ${hash.slice(0, 12)}… is not in the store` : 'it carries no evidence hash', 'it has no reproduction command'].join(' and ');
  return { verified: false, reason: `Unverified: ${missing}.` };
}

export interface ProbeAttempt { output: string; evidenceHash?: string; finding?: Finding }

export interface ReprobeDeps {
  /** The text that confirms the finding when it appears in a probe's output. */
  confirmPattern?: RegExp;
  /** Where each attempt's output is recorded, so the chain covers the re-probe too. */
  onEvidence?(attempt: number, result: ProbeAttempt): Promise<string | undefined> | string | undefined;
}

export interface ReprobeResult {
  finding: Finding;
  verified: boolean;
  attempts: number;
  reason: string;
}

/**
 * Bounded re-probe: at most REPROBE_ATTEMPTS calls to `probe`, never one more. A confirming output
 * upgrades the finding and keeps the confirming evidence hash; exhausted attempts leave it
 * unverified with the stated reason, so the reader always knows why.
 */
export async function reProbe(
  finding: Finding,
  probe: (finding: Finding, attempt: number) => Promise<ProbeAttempt>,
  deps: ReprobeDeps = {}
): Promise<ReprobeResult> {
  const pattern = deps.confirmPattern ?? new RegExp(escapeRegExp(finding.checkId), 'i');
  let attempts = 0;
  let lastReason = 'the re-probe produced nothing';
  while (attempts < REPROBE_ATTEMPTS) {
    attempts += 1;
    let result: ProbeAttempt;
    try {
      result = await probe(finding, attempts);
    } catch (error) {
      lastReason = `attempt ${attempts} failed: ${(error as Error).message}`;
      continue;
    }
    // Every attempt is recorded through onEvidence, whether or not it already carries a hash, so the
    // chain covers the re-probe itself and not only the finding it upgrades.
    const recorded = await deps.onEvidence?.(attempts, result);
    const evidenceHash = result.evidenceHash ?? recorded;
    if (pattern.test(result.output)) {
      return { finding: { ...finding, ...(evidenceHash ? { evidenceHash } : {}) }, verified: true, attempts, reason: `Attempt ${attempts} reproduced the finding.` };
    }
    lastReason = `attempt ${attempts} did not contain the confirming output`;
  }
  return { finding, verified: false, attempts, reason: `Unverified: re-probe attempts exhausted after ${REPROBE_ATTEMPTS} (${lastReason}).` };
}

/**
 * An unverified finding keeps its verdict honest in text: a failed exploit is never rendered as
 * "clean" (D-24), and a not-vulnerable verdict says it rests on an attempt, not on proof.
 */
export function criticLabel(finding: Finding, verified: boolean): string {
  if (verified) return `${finding.severity}: ${finding.title} (verified)`;
  const verdict = finding.verdict === 'not_vulnerable'
    ? 'not vulnerable by exploit attempt only'
    : finding.verdict === 'exploit_failed'
      ? 'vulnerable, exploit did not succeed'
      : 'could not determine';
  return `${finding.severity}: ${finding.title} (unverified — ${verdict})`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
