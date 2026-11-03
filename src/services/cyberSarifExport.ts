import { mkdir, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Engagement, Finding } from '../domain/cyber';
import { safeVerdictLine, verdictToSarifLevel, type SarifLevel } from '../domain/cyberVerdicts';
import { redactSecrets } from '../domain/redaction';
import { acceptanceBlock, buildPtesReport, type VisualCaptureSection } from './cyberReport';
import type { EngagementRun } from '../domain/cyber';
import type { LedgerEntry } from '../domain/cyberLedger';

// SARIF 2.1.0 export (CYBER-12, D-16). Structural correctness matters more than schema libraries
// here: every result carries at least one location (research Pitfall 6), the level is the verdict's
// (D-24), and the authorization block rides every result's properties so an exported file can always
// say who authorized the work.

export const SARIF_VERSION = '2.1.0';
export const SARIF_SCHEMA = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';
export const TOOL_NAME = 'Near AI Cybersecurity';
export const TOOL_URI = 'https://github.com/VitalPointAI/near-ai-vscode';

/** The sentinel `redactSecrets` leaves behind; an export containing a raw value is refused. */
const REDACTION_MARKER = '[REDACTED]';
const UNREDACTED_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
  /\b(?:api[-_]?key|access[-_]?token|password)\s*[:=]\s*(?!\[REDACTED\])[A-Za-z0-9_\-./+=]{12,}/i
];

export class ExportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

export interface SarifPayload {
  toolVersion: string;
  engagement: Engagement;
  findings: Finding[];
  ledgerVerified: boolean;
  /** The 25-03 register, so an empty result never reads as clean (D-12). */
  missingTools: string;
}

interface SarifRule { id: string; name: string; shortDescription: { text: string }; helpUri: string }

/** WSTG ids across the findings, sorted, one rule each. */
function rulesFor(findings: Finding[]): SarifRule[] {
  const ids = [...new Set(findings.flatMap((finding) => finding.wstg.length ? finding.wstg : [`${finding.checkId}`]))].sort();
  return ids.map((id) => ({
    id,
    name: id.replace(/[^A-Za-z0-9]+/g, '_'),
    shortDescription: { text: `OWASP WSTG check ${id}` },
    helpUri: `https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/`
  }));
}

/** The authorization object every result carries (D-16). */
export function authorizationFor(engagement: Engagement): Record<string, unknown> {
  const acceptance = engagement.acceptedDisclaimer;
  return {
    engagementId: engagement.id,
    target: `${engagement.target.kind}: ${engagement.target.value}`,
    scope: engagement.resolvedScope,
    region: acceptance.region,
    law: acceptance.textVersion,
    acceptor: acceptance.acceptor,
    machine: acceptance.machine,
    extensionVersion: acceptance.extensionVersion,
    timestamp: acceptance.acceptedAt
  };
}

/** Refuses an export whose text still carries a raw credential (T-25-45). */
export function assertRedacted(text: string, where: string): void {
  for (const shape of UNREDACTED_SHAPES) {
    const match = shape.exec(text);
    if (match && !match[0].includes(REDACTION_MARKER)) throw new ExportError(`${where} carries an unredacted credential (${match[0].slice(0, 12)}…); the export was refused.`);
  }
}

/** A network finding's location is its URL; a workspace finding's is its file (research Pitfall 6). */
/** SARIF requires a non-empty `locations` array on every result (research Pitfall 6). */
function locationsFor(finding: Finding): Array<Record<string, unknown>> {
  const target = (finding.target ?? '').trim();
  const uri = /^https?:\/\//i.test(target) ? target : target || 'unknown://finding';
  const fileLike = !/^[a-z]+:\/\//i.test(uri) && (uri.includes('/') || uri.includes('\\'));
  return [{
    physicalLocation: {
      artifactLocation: { uri: fileLike ? uri : uri, ...(fileLike ? {} : { uriBaseId: 'SRCROOT' }) },
      region: { startLine: Math.max(1, Number(/:(\d+)$/.exec(uri)?.[1] ?? 1)), startColumn: 1 }
    },
    logicalLocations: [{ fullyQualifiedName: finding.checkId, kind: 'function' }]
  }];
}

export function toSarif(payload: SarifPayload): Record<string, unknown> {
  const rules = rulesFor(payload.findings);
  const authorization = authorizationFor(payload.engagement);
  for (const finding of payload.findings) {
    assertRedacted([finding.evidenceExcerpt, finding.reproductionCommand, finding.title, finding.remediation].join('\n'), `Finding ${finding.id}`);
  }
  const results = payload.findings.map((finding) => {
    const ruleId = finding.wstg[0] ?? finding.checkId;
    const level: SarifLevel = verdictToSarifLevel(finding.verdict);
    // An export must never throw on a finding: a probe's finding routinely has no reason (an open
    // port needs none) and renderVerdict refuses a failure verdict without one. The fallback states
    // the finding without inventing a reason.
    const verdictLine = safeVerdictLine(finding);
    return {
      ruleId,
      ruleIndex: Math.max(0, rules.findIndex((rule) => rule.id === ruleId)),
      level,
      message: { text: `${finding.title}\n${verdictLine}` },
      locations: locationsFor(finding),
      partialFingerprints: { findingId: finding.id },
      properties: {
        cvss31: finding.cvssVector,
        ...(finding.cvssScore !== undefined ? { cvss31Score: finding.cvssScore } : {}),
        severity: finding.severity,
        wstg: finding.wstg,
        cwe: finding.cwes,
        verdict: finding.verdict,
        evidenceHash: finding.evidenceHash,
        reproductionCommand: finding.reproductionCommand,
        authorization
      }
    };
  });
  const worst = payload.findings
    .map((finding) => finding.severity)
    .sort((a, b) => severityScore(b) - severityScore(a))[0];
  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [{
      tool: { driver: { name: TOOL_NAME, version: payload.toolVersion, informationUri: TOOL_URI, rules } },
      results,
      properties: {
        ledgerVerified: payload.ledgerVerified,
        missingTools: payload.missingTools,
        authorization,
        ...(worst ? { worstSeverity: worst } : {})
      }
    }]
  };
}

/** The CVSS-ish score a severity label implies, only for ordering the headline severity. */
function severityScore(severity: Finding['severity']): number {
  return { critical: 9.5, high: 8, medium: 5, low: 2, info: 0.1 }[severity];
}

/** The Markdown export carries the same acceptance table the report does (D-16). */
export function markdownAuthorization(engagement: Engagement): string {
  return acceptanceBlock(engagement);
}

export interface ExportBundle {
  directory: string;
  report: string;
  json: string;
  sarif: string;
}

/**
 * Writes report.md, findings.json and findings.sarif through a temp file and a rename, so a reader
 * never sees a half-written export. Serialisation is deterministic: the same input yields the same
 * bytes, so two exports of one run are identical.
 */
export async function exportFiles(directory: string, files: { report: string; findings: Record<string, unknown>; sarif: Record<string, unknown> }): Promise<ExportBundle> {
  await mkdir(directory, { recursive: true });
  assertRedacted(files.report, 'The Markdown report');
  const serialised = { json: `${JSON.stringify(files.findings, null, 2)}\n`, sarif: `${JSON.stringify(files.sarif, null, 2)}\n` };
  assertRedacted(serialised.json, 'findings.json');
  assertRedacted(serialised.sarif, 'findings.sarif');
  const write = async (name: string, body: string) => {
    const target = path.join(directory, name);
    const temporary = `${target}.tmp-${process.pid}`;
    await writeFile(temporary, body, 'utf8');
    await rename(temporary, target);
    return target;
  };
  await write('report.md', files.report);
  await write('findings.json', serialised.json);
  await write('findings.sarif', serialised.sarif);
  return { directory, report: path.join(directory, 'report.md'), json: path.join(directory, 'findings.json'), sarif: path.join(directory, 'findings.sarif') };
}

/** The machine-readable document: engagement, acceptance, findings, ledger verdict, missing tools. */
export function findingsDocument(payload: SarifPayload, extra: { runId: string; startedAt: string; visualCaptures?: Array<{ kind: string; fileName: string; evidenceHash: string }> } = { runId: '', startedAt: '' }): Record<string, unknown> {
  return {
    engagement: {
      id: payload.engagement.id,
      target: `${payload.engagement.target.kind}: ${payload.engagement.target.value}`,
      scope: payload.engagement.resolvedScope,
      modes: payload.engagement.allowedModes,
      sandbox: payload.engagement.sandbox
    },
    run: { id: extra.runId, startedAt: extra.startedAt },
    authorization: authorizationFor(payload.engagement),
    acceptance: redactSecrets(acceptanceBlock(payload.engagement)),
    ledgerVerified: payload.ledgerVerified,
    missingTools: payload.missingTools,
    findings: payload.findings,
    ...(extra.visualCaptures?.length ? { visualCaptures: extra.visualCaptures } : {})
  };
}

export interface ExportRunOptions {
  directory: string;
  payload: SarifPayload;
  run: EngagementRun;
  ledger: LedgerEntry[];
  previousFindings?: Finding[];
  visualCaptures?: VisualCaptureSection;
  /** The captures' SVG text, written beside the report so the Markdown links resolve. */
  captureFiles?: Array<{ fileName: string; svgText: string }>;
  /** Post-exploitation commands for the narrative (D-11). */
  commands?: string[];
}

/**
 * The one export action: report.md, findings.json, findings.sarif, and any capture SVGs, all in the
 * run directory, all through the atomic write. Deterministic — two exports of one run are identical.
 */
export async function exportRun(options: ExportRunOptions): Promise<ExportBundle> {
  const markdown = buildPtesReport(options.payload.engagement, options.run, options.payload.findings, options.ledger, {
    ...(options.previousFindings ? { previousFindings: options.previousFindings } : {}),
    ...(options.visualCaptures ? { visualCaptures: options.visualCaptures } : {})
  });
  const document = findingsDocument(options.payload, {
    runId: options.run.id,
    startedAt: options.run.startedAt,
    ...(options.visualCaptures ? { visualCaptures: options.visualCaptures.captures } : {})
  });
  const bundle = await exportFiles(options.directory, { report: markdown, findings: document, sarif: toSarif(options.payload) });
  for (const capture of options.captureFiles ?? []) {
    const target = path.join(options.directory, capture.fileName);
    const temporary = `${target}.tmp-${process.pid}`;
    await writeFile(temporary, capture.svgText, 'utf8');
    await rename(temporary, target);
  }
  return bundle;
}
