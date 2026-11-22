// The dependency audit collector (44-08, D-09, D-23). CI writes `npm audit --json --omit=dev` once a day for each package (root, relay, hub,
// docs-site, compliance; 44-19), and this collector turns each file into one observation `audit` / <package>: passed when high plus critical is 0,
// with the counts per severity from `metadata.vulnerabilities`. Nothing else from the file is kept: no package names, advisory titles, ranges or
// addresses (D-24). The window is 24 hours, so a daily audit that stops arriving turns the controls relying on it Stale.
import type { Observation } from '../model.ts';
import type { Collector, CollectorContext } from './types.ts';
import { collectorError } from './github.ts';

export interface AuditInput {
  /** One entry per package: its id (the observation subject) and the npm audit JSON file. */
  readonly audits: readonly { readonly package: string; readonly file: string }[];
}

/** The severities npm audit counts, in its order. */
export const AUDIT_SEVERITIES = Object.freeze(['info', 'low', 'moderate', 'high', 'critical'] as const);

const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Reads npm audit JSON (report version 2) and returns its counts per severity and total, or throws not-npm-audit-json. */
export function auditCounts(text: string, file: string): Record<string, number> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw collectorError('not-npm-audit-json', `audit: ${file} is not JSON`);
  }
  const report = doc as { auditReportVersion?: unknown; vulnerabilities?: unknown; metadata?: { vulnerabilities?: Record<string, unknown> } } | null;
  if (!report || typeof report !== 'object' || Array.isArray(report) || report.auditReportVersion !== 2 || typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) {
    throw collectorError('not-npm-audit-json', `audit: ${file} is not an npm audit report (version 2)`);
  }
  const vulnerabilities = report.metadata?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== 'object') throw collectorError('not-npm-audit-json', `audit: ${file} has no metadata.vulnerabilities`);
  const counts: Record<string, number> = {};
  let sum = 0;
  for (const severity of AUDIT_SEVERITIES) {
    const value = vulnerabilities[severity];
    if (!isCount(value)) throw collectorError('not-npm-audit-json', `audit: ${file} has no whole-number count for ${severity}`);
    counts[severity] = value;
    sum += value;
  }
  if (!isCount(vulnerabilities.total) || vulnerabilities.total !== sum) throw collectorError('not-npm-audit-json', `audit: ${file} has a total that is not the sum of its severities`);
  counts.total = sum;
  return counts;
}

export const auditCollector: Collector<AuditInput> = Object.freeze({
  id: 'audit',
  window: 'audit',
  async collect(input: AuditInput, context: CollectorContext): Promise<Observation[]> {
    const audits = input?.audits;
    if (!Array.isArray(audits) || audits.length === 0) throw collectorError('invalid-input', 'audit: no audit files given');
    const seen = new Set<string>();
    for (const entry of audits) {
      if (typeof entry?.package !== 'string' || !PACKAGE_ID.test(entry.package)) throw collectorError('invalid-input', 'audit: a package id is not a plain lower-case id');
      if (typeof entry.file !== 'string' || entry.file === '') throw collectorError('invalid-input', `audit: no file for ${entry.package}`);
      if (seen.has(entry.package)) throw collectorError('invalid-input', `audit: ${entry.package} is listed twice`);
      seen.add(entry.package);
    }
    const collectedAt = context.now.toISOString();
    const observations: Observation[] = [];
    for (const entry of audits) {
      const counts = auditCounts(await context.readFile(entry.file), entry.file);
      observations.push({
        collector: 'audit',
        subject: entry.package,
        passed: counts.high === 0 && counts.critical === 0,
        collectedAt,
        commit: context.commit,
        ...(context.runUrl ? { runUrl: context.runUrl } : {}),
        counts
      });
    }
    return observations;
  }
});
