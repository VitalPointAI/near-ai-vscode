import { mkdir, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DisclaimerAcceptance, Engagement, EngagementRun, Finding, Severity } from '../domain/cyber';
import { SEVERITY_RANK } from '../domain/cyber';
import type { LedgerEntry } from '../domain/cyberLedger';
import { chainBreak, verifyChain } from '../domain/cyberLedger';
import { redactSecrets } from '../domain/redaction';
import { renderVerdict } from '../domain/cyberVerdicts';
import { SCREENSHOT_ABSENT_NOTE } from './cyberVisualCapture';

// The report is the product (D-26): PTES sections, WSTG ids and CVSS 3.1 per finding, the accepted
// disclaimer always embedded (D-16), and the hash-chain result in the evidence appendix.

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const VERDICT_LABEL: Record<Finding['verdict'], string> = {
  verified_access: 'Verified access',
  exploit_failed: 'Vulnerable — exploit attempt failed',
  could_not_determine: 'Could not determine',
  not_vulnerable: 'Not vulnerable'
};

const cell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function section(title: string, placeholder: string, body?: string): string {
  return `## ${title}\n\n${body ?? `_${placeholder}_`}\n`;
}

/** D-16: every export carries the accepted disclaimer, whoever reads it. */
/** D-16: the one place the authorization table is built; every export imports it. */
export function acceptanceBlock(engagement: Engagement): string {
  const acceptance: DisclaimerAcceptance = engagement.acceptedDisclaimer;
  return [
    '| Field | Value |',
    '|---|---|',
    `| Engagement | ${cell(engagement.id)} |`,
    `| Target | ${cell(`${engagement.target.kind}: ${engagement.target.value}`)} |`,
    `| Scope | ${cell(scopeSummary(engagement))} |`,
    `| Region / law | ${cell(acceptance.region)} (${cell(acceptance.textVersion)}) |`,
    `| Acceptor | ${cell(acceptance.acceptor)} |`,
    `| OS user | ${cell(acceptance.osUser)} |`,
    `| Machine | ${cell(acceptance.machine)} |`,
    `| Extension version | ${cell(acceptance.extensionVersion)} |`,
    `| Accepted at | ${cell(acceptance.acceptedAt)} |`
  ].join('\n');
}

function scopeSummary(engagement: Engagement): string {
  const scope = engagement.resolvedScope;
  const parts = [scope.hosts.length ? `${scope.hosts.length} host(s): ${scope.hosts.slice(0, 8).join(', ')}` : '', scope.ports.length ? `port(s) ${scope.ports.join(', ')}` : '', scope.paths.length ? `path(s) ${scope.paths.join(', ')}` : ''].filter(Boolean);
  return parts.join('; ') || 'no hosts, ports, or paths resolved';
}

function findingBlock(finding: Finding, position: number): string {
  const score = finding.cvssScore === undefined ? 'n/a' : finding.cvssScore.toFixed(1);
  return [
    `### ${position}. ${finding.title}`,
    '',
    `- **Severity:** ${finding.severity}`,
    `- **Verdict:** ${VERDICT_LABEL[finding.verdict]}${finding.reason ? ` — ${finding.reason}` : ''}`,
    `- **CVSS 3.1:** \`${finding.cvssVector}\` (${score})`,
    `- **WSTG:** ${finding.wstg.join(', ') || 'none mapped'}`,
    `- **CWE:** ${finding.cwes.join(', ') || 'none mapped'}`,
    `- **Target:** ${finding.target ?? 'engagement target'}`,
    '',
    '**Evidence excerpt**',
    '',
    '```',
    finding.evidenceExcerpt.trim() || '(no excerpt captured)',
    '```',
    '',
    `**Reproduce:** \`${finding.reproductionCommand}\``,
    '',
    `**Remediation:** ${finding.remediation}`,
    ''
  ].join('\n');
}

export interface ReportOptions {
  /** The previous run of the same engagement, for the diff section (CYBER-12). */
  previousFindings?: Finding[];
  /** Visual captures written beside the report (D-27 kind 4). */
  visualCaptures?: VisualCaptureSection;
}

/** The capture list the appendix references, plus the screenshot status line. */
export interface VisualCaptureSection {
  captures: Array<{ kind: string; fileName: string; evidenceHash: string }>;
  screenshot: { status: 'absent'; reason: string };
}

export interface FindingDiff {
  added: string[];
  resolved: string[];
  unchanged: string[];
  /** Ids that appear in exactly one set with no counterpart; surfaced, never dropped. */
  unknown: string[];
}

/** Stable finding ids: the same problem in two runs compares equal (never array positions). */
const findingKey = (finding: Finding): string => `${finding.checkId}@${finding.target ?? ''}`;

/** The four-category diff between two runs of one engagement. */
export function diffFindings(previous: Finding[], current: Finding[]): FindingDiff {
  const before = new Map(previous.map((finding) => [findingKey(finding), finding]));
  const after = new Map(current.map((finding) => [findingKey(finding), finding]));
  const added: string[] = [];
  const unchanged: string[] = [];
  const unknown: string[] = [];
  for (const key of after.keys()) {
    if (!before.has(key)) added.push(key);
    else unchanged.push(key);
  }
  const resolved = [...before.keys()].filter((key) => !after.has(key));
  // An id the reader cannot place either way (a finding with no target, say) is its own category.
  for (const key of [...added, ...resolved]) if (key.endsWith('@')) { unknown.push(key); }
  return {
    added: added.filter((key) => !key.endsWith('@')).sort(),
    resolved: resolved.filter((key) => !key.endsWith('@')).sort(),
    unchanged: unchanged.sort(),
    unknown: [...new Set(unknown)].sort()
  };
}

function diffSection(diff: FindingDiff): string {
  const list = (label: string, ids: string[], empty: string) => `**${label}** (${ids.length})\n\n${ids.length ? ids.map((id) => `- \`${id}\``).join('\n') : `_${empty}_`}`;
  return [
    list('Added since the previous run', diff.added, 'No finding is new.'),
    '',
    list('Resolved since the previous run', diff.resolved, 'No finding was resolved.'),
    '',
    list('Unchanged', diff.unchanged, 'No finding is unchanged.'),
    '',
    list('Unplaceable ids', diff.unknown, 'Every id appears in exactly one run with a target.')
  ].join('\n');
}

/** The Evidence Appendix: hashes, chain verdict, the visual references, and the browser status. */
function evidenceAppendix(ordered: Finding[], ledger: LedgerEntry[], visualCaptures?: VisualCaptureSection): string {
  const captures = visualCaptures?.captures ?? [];
  const lines = [
    `Findings captured ${ordered.length} evidence blob${ordered.length === 1 ? '' : 's'}.`,
    '',
    '**Hash chain**',
    '',
    '```',
    `${verifyChain(ledger) ? 'Chain verified' : 'Chain NOT verified'}: ${ledger.length} entr${ledger.length === 1 ? 'y' : 'ies'}${chainBreak(ledger) ? `; first break at ${chainBreak(ledger)}` : ''}`,
    '```',
    '',
    ...(ordered.length ? ['**Evidence hashes**', '', ...ordered.filter((finding) => finding.evidenceHash).map((finding) => `- \`${finding.evidenceHash}\` — ${finding.checkId}`), ''] : []),
    '**Visual captures**',
    '',
    ...(captures.length
      ? captures.map((capture) => `- **${capture.kind}** — [${capture.fileName}](${capture.fileName}) (evidence \`${capture.evidenceHash}\`)`)
      : ['_No visual captures were recorded for this run._']),
    '',
    visualCaptures ? `**Screenshot:** ${visualCaptures.screenshot.status} — ${visualCaptures.screenshot.reason}` : `**Screenshot:** absent — ${SCREENSHOT_ABSENT_NOTE}`
  ];
  return lines.join('\n');
}

/** The exploitation narrative: which path each offensive finding took, and what ran (D-23, D-11). */
function narrativeSection(ordered: Finding[], commands: string[] = []): string | undefined {
  const offensive = ordered.filter((finding) => finding.verdict !== 'not_vulnerable' && (finding.checkId === 'sql-injection' || finding.verdict === 'verified_access'));
  if (!offensive.length && !commands.length) return undefined;
  return [
    ...offensive.map((finding) => `- **${finding.checkId}** at \`${finding.target ?? 'engagement target'}\`: ${renderVerdict(finding)}`),
    ...(commands.length ? ['', 'Post-exploitation commands (read-only, D-11):', '', ...commands.map((command) => `- \`${command}\``)] : [])
  ].join('\n');
}

export function buildPtesReport(engagement: Engagement, run: EngagementRun, findings: Finding[], ledger: LedgerEntry[], options: ReportOptions = {}): string {
  const ordered = [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.title.localeCompare(b.title));
  const counts = SEVERITY_ORDER.map((severity) => `${severity}: ${ordered.filter((finding) => finding.severity === severity).length}`).join(', ');
  const worst = ordered[0];
  const verified = verifyChain(ledger);
  const lines = [
    `# Penetration test report — ${engagement.id}`,
    '',
    `Target: \`${engagement.target.kind}: ${engagement.target.value}\` · Depth: ${run.depth} · Run: ${run.id}`,
    '',
    section('Executive Summary', 'Filled by the planner from the findings below.', [
      ordered.length ? `The run recorded ${ordered.length} finding${ordered.length === 1 ? '' : 's'} (${counts}). The highest severity found was **${worst.severity}**: ${worst.title}.` : 'The run recorded no findings. That is not a clean bill of health: only the checks named under Methodology ran, and any missing host tool is listed there.',
      '',
      `Verdicts are explicit (D-24): a finding that could not be confirmed reads "could not determine", never "clean".`
    ].join('\n')),
    section('Scope and Rules of Engagement', 'Filled from the engagement record.', [
      `- **Resolved scope:** ${scopeSummary(engagement)}`,
      `- **Exclusions:** ${engagement.exclusions.join(', ') || 'none'}`,
      `- **Allowed modes:** ${engagement.allowedModes.join(', ') || 'none recorded'}`,
      `- **Authorisation statement:** ${engagement.authorizationStatement}`,
      engagement.window ? `- **Window:** ${engagement.window.start} to ${engagement.window.end}` : '',
      engagement.rateLimit ? `- **Rate limit:** ${engagement.rateLimit.opsPerMinute} operations per minute` : '',
      engagement.sandbox.reason ? `- **Sandbox:** ${engagement.sandbox.tier} (${engagement.sandbox.reason})` : `- **Sandbox:** ${engagement.sandbox.tier}`
    ].filter(Boolean).join('\n')),
    section('Methodology', 'Filled by the protocol driver with the plan it followed.', `- **Depth profile:** ${run.depth}\n- **Model:** ${run.model ?? 'not recorded'}\n- **Standards:** OWASP WSTG test ids per check, CVSS 3.1 vectors per finding.\n- **Host tools missing:** the driver lists them here, so an empty result never reads as clean (D-12).`),
    section('Findings by Severity', 'No finding-producing check ran.', ordered.length ? ordered.map((finding, index) => findingBlock(finding, index + 1)).join('\n') : undefined),
    section('Exploitation Narrative', 'Filled by the operator when an offensive mode ran.', narrativeSection(ordered)),
    section('Remediation Summary', 'Filled by the reporter with prioritised fixes.', ordered.length ? ordered.map((finding, index) => `${index + 1}. **${finding.severity}** — ${finding.remediation}`).join('\n') : undefined),
    ...(options.previousFindings ? [section('Run Diff', 'No previous run to compare against.', diffSection(diffFindings(options.previousFindings, ordered)))] : []),
    section('Evidence Appendix', 'Evidence blobs are stored beside the ledger.', evidenceAppendix(ordered, ledger, options.visualCaptures)),
    section('Acceptance / Authorization', 'Filled from the acceptance record.', acceptanceBlock(engagement))
  ];
  return `${redactSecrets(lines.join('\n')).trimEnd()}\n`;
}

/** Writes through a temp file and a rename, so a reader never sees a half-written report. */
export async function writeReport(dir: string, name: string, markdown: string): Promise<string> {
  const safeName = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'report.md';
  const target = path.join(dir, safeName.endsWith('.md') ? safeName : `${safeName}.md`);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await mkdir(dir, { recursive: true });
  await writeFile(temporary, markdown, 'utf8');
  await rename(temporary, target);
  return target;
}
