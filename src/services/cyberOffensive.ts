import type { Finding, Verdict } from '../domain/cyber';
import { hardeningAdvice, WSTG_MAP } from '../domain/cyber';
import { renderVerdict } from '../domain/cyberVerdicts';
import { redactSecrets } from '../domain/redaction';
import type { CyberEvidenceStore, CyberLedgerStore } from './cyberLedgerStore';
import { FINDING_MARKER } from './cyberLedgerStore';
import { verifyCleanup, type Sandbox } from './cyberSandbox';
import type { HostToolRunnerOutput } from './cyberHostTools';

// The offensive path (CYBER-08, CYBER-09; D-23, D-24, D-10, D-11): fingerprint, then a known-CVE or
// custom-PoC exploit, run only inside the sandbox, then an access check, a read-only access proof, and
// cleanup verification. Every outcome is one of the four verdicts, and the failure verdicts always say
// why. Nothing runs on the host: a disabled sandbox tier yields could_not_determine with its reason.

/** How the exploit was chosen, stated in the report (D-23). */
export type ExploitPath = 'known-cve' | 'custom-poc';

export interface OffensiveStep {
  /** What the step is for, e.g. "probe the login endpoint". */
  purpose: string;
  target: string;
  /** The payload as an argv list; never a shell string. */
  argv: string[];
  /** The output fragment that proves access when it appears. */
  expectedResult: RegExp | string;
  path: ExploitPath;
  /** The CVE this exploit is for, when the path is known-cve. */
  cve?: string;
}

export interface SandboxAccess {
  /** Opens the engagement's sandbox tier; a disabled tier throws with its reason. */
  open(): Promise<Sandbox>;
  /** The tier the engagement resolved to (D-08). */
  tier: 'container' | 'tempFolder' | 'disabled';
  /** The reason shown when the tier is disabled. */
  reason?: string;
}

export interface OffensiveInput {
  engagementId: string;
  runId: string;
  /** The engagement's scope check; a target outside it is refused before the sandbox opens. */
  inScope(target: string): boolean;
  /** The fingerprint evidence the exploit was planned from (D-23's first phase). */
  fingerprint: { title?: string; technologies?: string[]; hints?: string[] };
  /** The planned exploit. A CVE-first plan sets path 'known-cve' and names the CVE. */
  exploit: OffensiveStep;
  /** The access-proof commands, run only after the exploit succeeded (D-11's read-only list). */
  proofCommands?: string[];
  sandbox: SandboxAccess;
  /** Executes one argv in the sandbox; bound to CyberExploitTool in production, a double in tests. */
  execute?(step: OffensiveStep, sandbox: Sandbox): Promise<HostToolRunnerOutput>;
  ledger: CyberLedgerStore;
  evidence: CyberEvidenceStore;
  /** Files and credentials a step recorded as written, for the D-10 check. */
  recorded?: { filesDropped: string[]; credentialsCreated: string[] };
  now?: () => Date;
}

export interface OffensiveResult {
  findings: Finding[];
  /** The verdict the run reached, for the panel's headline. */
  verdict: Verdict;
  /** The rendered verdict sentence, with its reason where the verdict needs one. */
  verdictLine: string;
  /** Every read-only command the access proof ran, for the report (D-11). */
  commands: string[];
  cleanup: { sandbox: 'verified' | 'failed' | 'not-run'; problems: string[] };
  /** Which path was taken, when an exploit actually ran (D-23). */
  exploitPath?: ExploitPath;
}

const PROOF_TIMEOUT_MS = 10_000;

/** The default executor: the sandbox's own exec, which is the only place a payload runs. */
async function defaultExecute(step: OffensiveStep, sandbox: Sandbox): Promise<HostToolRunnerOutput> {
  const result = await sandbox.exec(step.argv);
  return { stdout: Buffer.from(result.stdout, 'utf8'), stderr: result.stderr, exitCode: result.exitCode, durationMs: 0 };
}

const matches = (expected: RegExp | string, output: string): boolean =>
  typeof expected === 'string' ? output.includes(expected) : expected.test(output);

export async function runOffensiveScan(input: OffensiveInput): Promise<OffensiveResult> {
  const now = input.now ?? (() => new Date());
  const commands: string[] = [];
  const findings: Finding[] = [];
  const record = (fields: { tool: string; arguments: string; result: string; reasoning: string; evidenceHash?: string }) =>
    input.ledger.append(input.runId, {
      timestamp: now().toISOString().slice(0, 19) + 'Z',
      tool: fields.tool,
      arguments: redactSecrets(fields.arguments).slice(0, 4_000),
      result: redactSecrets(fields.result).slice(0, 8_000),
      modelReasoning: redactSecrets(fields.reasoning).slice(0, 2_000),
      evidenceHash: fields.evidenceHash ?? ''
    });

  const findingFor = (verdict: Verdict, extra: { reason?: string; evidenceHash?: string; evidence?: string; checkId?: string; title?: string; target?: string }): Finding => {
    const checkId = extra.checkId ?? 'sql-injection';
    const finding: Finding = {
      id: `${checkId}-${verdict}-${input.runId.slice(-6)}`,
      checkId,
      title: extra.title ?? 'An injected login predicate returns access',
      severity: verdict === 'verified_access' ? 'critical' : 'medium',
      verdict,
      cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N',
      cwes: verdict === 'verified_access' ? ['CWE-89'] : [],
      wstg: WSTG_MAP[checkId] ?? [],
      evidenceExcerpt: redactSecrets(extra.evidence ?? '').slice(0, 600),
      evidenceHash: extra.evidenceHash ?? '',
      reproductionCommand: reproductionFor(input.exploit),
      remediation: hardeningAdvice(checkId),
      ...(extra.reason ? { reason: extra.reason } : {}),
      target: extra.target ?? input.exploit.target
    };
    findings.push(finding);
    return finding;
  };

  // (1) Fingerprint: recorded as the planner's evidence, never as a finding on its own.
  const fingerprintText = [
    `title: ${input.fingerprint.title || '(none)'}`,
    `technologies: ${(input.fingerprint.technologies ?? []).join(', ') || '(none identified)'}`,
    `hints: ${(input.fingerprint.hints ?? []).join('; ') || '(none)'}`
  ].join('\n');
  const fingerprintHash = await input.evidence.put(input.runId, `[CyberFingerprintProbe] ${input.exploit.target}\n${fingerprintText}`);
  await record({ tool: 'CyberFingerprintProbe', arguments: input.exploit.target, result: fingerprintText, reasoning: 'fingerprint the target before choosing an exploit', evidenceHash: fingerprintHash });

  const pathLabel = input.exploit.path === 'known-cve' ? `known CVE ${input.exploit.cve ?? '(unnamed)'}` : 'a custom PoC from the discovered weakness';

  // (2) A disabled tier never runs a payload on the host: it is inconclusive, with the reason.
  if (input.sandbox.tier === 'disabled') {
    const reason = input.sandbox.reason ?? 'the engagement resolved to the disabled sandbox tier';
    const evidenceHash = await input.evidence.put(input.runId, `[sandbox] ${input.exploit.target}\n${reason}`);
    await record({ tool: 'CyberExploitTool', arguments: input.exploit.argv.join(' '), result: `not run: ${reason}`, reasoning: `planned ${pathLabel}`, evidenceHash });
    const finding = findingFor('could_not_determine', { reason: `${reason}, so no exploit was attempted.`, evidenceHash, evidence: reason });
    return { findings, verdict: 'could_not_determine', verdictLine: renderVerdict(finding), commands, cleanup: { sandbox: 'not-run', problems: [] } };
  }

  if (!input.inScope(input.exploit.target)) {
    const reason = `${input.exploit.target} is outside the resolved scope of engagement ${input.engagementId}`;
    await record({ tool: 'CyberExploitTool', arguments: input.exploit.argv.join(' '), result: `refused: ${reason}`, reasoning: `planned ${pathLabel}` });
    const finding = findingFor('could_not_determine', { reason, evidence: reason });
    return { findings, verdict: 'could_not_determine', verdictLine: renderVerdict(finding), commands, cleanup: { sandbox: 'not-run', problems: [] } };
  }

  // (3) The exploit, only inside the sandbox.
  let sandbox: Sandbox | undefined;
  let exploitOutput = '';
  let exploitExit: number | null = null;
  let sandboxProblem: string | undefined;
  try {
    sandbox = await input.sandbox.open();
    const result = await (input.execute ?? defaultExecute)(input.exploit, sandbox);
    exploitOutput = result.stdout.toString('utf8');
    exploitExit = result.exitCode;
  } catch (error) {
    sandboxProblem = (error as Error).message;
  }

  const exploitHash = await input.evidence.put(input.runId, `[CyberExploitTool] ${input.exploit.target}\n${exploitOutput || sandboxProblem || ''}`);
  await record({
    tool: 'CyberExploitTool',
    arguments: JSON.stringify({ argv: input.exploit.argv, path: input.exploit.path, ...(input.exploit.cve ? { cve: input.exploit.cve } : {}) }),
    result: exploitOutput || `not run: ${sandboxProblem ?? 'no output'}`,
    reasoning: `planned ${pathLabel}`,
    evidenceHash: exploitHash
  });

  let verdict: Verdict;
  let finding: Finding;
  if (sandboxProblem) {
    // The sandbox failed or was refused: inconclusive, never a host execution and never "clean".
    finding = findingFor('could_not_determine', { reason: `the sandbox could not run the payload (${sandboxProblem}).`, evidenceHash: exploitHash, evidence: sandboxProblem });
    verdict = 'could_not_determine';
  } else if (matches(input.exploit.expectedResult, exploitOutput)) {
    // (4) Access verified; (5) the read-only access proof is collected while the session is open.
    const proof: string[] = [];
    for (const command of input.proofCommands ?? ['whoami', 'hostname']) {
      if (!sandbox) break;
      try {
        const result = await sandbox.exec(command.split(' '));
        commands.push(command);
        proof.push(`$ ${command}\n${redactSecrets(result.stdout.trim())}`);
      } catch (error) {
        proof.push(`$ ${command}\n(error: ${(error as Error).message})`);
      }
    }
    const accessProof = [`[access proof at ${now().toISOString()}]`, ...proof].join('\n');
    const proofHash = await input.evidence.put(input.runId, `[CyberPostExploitTool] ${input.exploit.target}\n${accessProof}`);
    await record({ tool: 'CyberPostExploitTool', arguments: commands.join(', '), result: accessProof, reasoning: 'record a minimal access proof after verified access', evidenceHash: proofHash });
    finding = findingFor('verified_access', { evidenceHash: proofHash, evidence: `${exploitOutput.trim()}\n${accessProof}` });
    verdict = 'verified_access';
  } else if (exploitExit !== null && exploitExit !== 0) {
    finding = findingFor('exploit_failed', { reason: `the payload exited ${exploitExit} without access: ${firstLine(exploitOutput) || 'no output'}.`, evidenceHash: exploitHash, evidence: exploitOutput });
    verdict = 'exploit_failed';
  } else {
    finding = findingFor('exploit_failed', { reason: `the payload ran and exited 0, but its output did not match "${String(input.exploit.expectedResult)}": ${firstLine(exploitOutput) || 'no output'}.`, evidenceHash: exploitHash, evidence: exploitOutput });
    verdict = 'exploit_failed';
  }

  // (6) Cleanup: the sandbox's own proof plus the recorded files and credentials (D-10).
  const cleanup: OffensiveResult['cleanup'] = { sandbox: 'not-run', problems: [] };
  if (sandbox) {
    try {
      await sandbox.stop();
      cleanup.sandbox = 'verified';
    } catch (error) {
      cleanup.sandbox = 'failed';
      cleanup.problems.push((error as Error).message);
    }
    const leakProblems = await verifyCleanup(input.recorded ?? { filesDropped: [], credentialsCreated: [] }, sandbox).catch((error: Error) => [(error as Error).message]);
    cleanup.problems.push(...leakProblems);
    await record({ tool: 'cleanup', arguments: '', result: cleanup.problems.length ? cleanup.problems.join('; ') : 'sandbox stopped and no recorded file or credential remains', reasoning: 'verify cleanup after the run (D-10)', evidenceHash: '' });
  }

  return { findings, verdict, verdictLine: renderVerdict(finding), commands, cleanup, exploitPath: input.exploit.path };
}

/** A command the reader can run to repeat the exploit, in the same argv form the sandbox used. */
function reproductionFor(step: OffensiveStep): string {
  const quoted = step.argv.map((arg) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' ');
  return `sandbox$ ${quoted}`;
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

/**
 * Builds the finding records the report and export consume, from a stored run. Findings already
 * carry their verdict; this renders the verdict line beside each (never the word "clean").
 */
export function verdictLinesFor(findings: Finding[]): string[] {
  return findings.map((finding) => renderVerdict(finding));
}

/** Findings persisted into the chain, so replay and export read the same records (25-05). */
export async function persistFindings(runId: string, findings: Finding[], ledger: CyberLedgerStore, now: () => Date = () => new Date()): Promise<void> {
  for (const finding of findings) {
    await ledger.append(runId, {
      timestamp: now().toISOString().slice(0, 19) + 'Z',
      tool: 'finding',
      arguments: finding.checkId,
      result: `${FINDING_MARKER}${JSON.stringify(finding)}`,
      modelReasoning: finding.remediation,
      evidenceHash: finding.evidenceHash
    });
  }
}
