import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Component, Ecosystem, readLockfiles } from './lockfiles';
import { PackageFinding, queryOsv, rank, Severity } from './osv';
import { checkRuntimes, declaredRuntimes, installedRuntimes, Runtime, RuntimeFinding, RuntimeVersion } from './runtimes';

// A project's software bill of materials (CycloneDX 1.6, written to sbom.cdx.json) and its known
// vulnerabilities: dependencies from lockfiles checked on OSV.dev, runtimes on endoflife.date.

export const SBOM_FILE = 'sbom.cdx.json';

export interface ScanReport {
  scannedAt: string;
  components: Component[];
  runtimes: RuntimeVersion[];
  packages: PackageFinding[];
  runtimeFindings: RuntimeFinding[];
  lockfiles: string[];
  notes: string[];
  /** Problems reaching OSV.dev or endoflife.date; the SBOM is still written. */
  errors: string[];
  counts: Record<Severity, number>;
  sbomWritten: boolean;
}

const RUNTIME_FOR: Partial<Record<Ecosystem, Runtime>> = { npm: 'node', PyPI: 'python', Packagist: 'php', Go: 'go', RubyGems: 'ruby', 'crates.io': 'rust', NuGet: 'dotnet' };

export interface ScanOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  now?: () => Date;
  run?: (command: string, args: string[]) => Promise<string>;
  /** Write sbom.cdx.json: 'always' (explicit scans), 'if-changed' (automatic ones), or 'never'. */
  write?: 'always' | 'if-changed' | 'never';
  tool?: { name: string; version: string };
}

export async function scanProject(root: string, options: ScanOptions = {}): Promise<ScanReport> {
  const scannedAt = (options.now?.() ?? new Date()).toISOString();
  const lock = await readLockfiles(root);
  const declared = await declaredRuntimes(root);
  const used = new Set<Runtime>([...lock.components.map((component) => RUNTIME_FOR[component.ecosystem]).filter((runtime): runtime is Runtime => Boolean(runtime)), ...declared.map((entry) => entry.runtime)]);
  const runtimes = [...declared, ...await installedRuntimes(used, options.run)];
  const errors: string[] = [];
  const packages = lock.components.length ? await queryOsv(lock.components, { fetch: options.fetch, signal: options.signal }).catch((error: Error) => { errors.push(`Could not check dependencies on OSV.dev: ${error.message}`); return [] as PackageFinding[]; }) : [];
  const runtimeFindings = runtimes.length ? await checkRuntimes(runtimes, { fetch: options.fetch, signal: options.signal }).catch((error: Error) => { errors.push(`Could not check runtimes on endoflife.date: ${error.message}`); return [] as RuntimeFinding[]; }) : [];
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const finding of packages) for (const vuln of finding.vulnerabilities) counts[vuln.severity] += 1;
  for (const finding of runtimeFindings) counts[finding.severity] += 1;
  const report: ScanReport = { scannedAt, components: lock.components, runtimes, packages, runtimeFindings, lockfiles: lock.files, notes: lock.notes, errors, counts, sbomWritten: false };
  if ((options.write ?? 'always') !== 'never') report.sbomWritten = await writeSbom(root, report, options);
  return report;
}

/** CycloneDX 1.6 JSON for the scan. Components are sorted so unchanged projects give unchanged files. */
export function cycloneDx(report: ScanReport, project: string, tool: { name: string; version: string } = { name: 'NEAR AI for VS Code', version: '' }): Record<string, unknown> {
  const status = report.errors.length && !report.packages.length ? 'incomplete' : report.packages.length || report.runtimeFindings.length ? 'vulnerabilities-found' : 'no-known-vulnerabilities';
  const runtimeRef = (entry: RuntimeVersion) => `runtime:${entry.runtime}@${entry.version}:${entry.kind}`;
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: report.scannedAt,
      tools: { components: [{ type: 'application', name: tool.name, ...(tool.version ? { version: tool.version } : {}) }] },
      component: { type: 'application', 'bom-ref': 'project', name: project },
      properties: [
        { name: 'near-ai:scan:time', value: report.scannedAt },
        { name: 'near-ai:scan:status', value: status },
        { name: 'near-ai:scan:sources', value: 'OSV.dev (dependencies), endoflife.date (runtimes)' },
        { name: 'near-ai:scan:lockfiles', value: report.lockfiles.join(', ') || 'none' },
        ...report.errors.map((error) => ({ name: 'near-ai:scan:error', value: error }))
      ]
    },
    components: [
      ...report.components.map((component) => ({
        type: 'library', 'bom-ref': component.purl, name: component.name, version: component.version, purl: component.purl,
        scope: component.development ? 'optional' : 'required',
        properties: [{ name: 'near-ai:source', value: component.source }, ...(component.development ? [{ name: 'near-ai:dependency', value: 'development' }] : [])]
      })),
      ...report.runtimes.map((entry) => ({ type: 'platform', 'bom-ref': runtimeRef(entry), name: entry.runtime, version: entry.version, properties: [{ name: 'near-ai:runtime', value: `${entry.kind}: ${entry.source}` }] }))
    ],
    vulnerabilities: [
      ...report.packages.flatMap((finding) => finding.vulnerabilities.map((vuln) => ({
        'bom-ref': `${vuln.id}:${finding.component.purl}`, id: vuln.id, source: { name: 'OSV', url: vuln.url },
        ratings: [{ severity: vuln.severity === 'unknown' ? 'unknown' : vuln.severity, ...(vuln.score !== undefined ? { score: vuln.score, method: 'CVSSv31', vector: vuln.vector } : {}) }],
        ...(vuln.cwes.length ? { cwes: vuln.cwes.map((cwe) => Number(cwe.replace(/^CWE-/, ''))).filter(Number.isFinite) } : {}),
        description: vuln.summary,
        ...(vuln.fixed.length ? { recommendation: `Upgrade ${finding.component.name} to ${vuln.fixed[0]} or later.` } : {}),
        ...(vuln.published ? { published: vuln.published } : {}), ...(vuln.modified ? { updated: vuln.modified } : {}),
        ...(vuln.aliases.length ? { references: vuln.aliases.map((alias) => ({ id: alias, source: { name: alias.startsWith('CVE-') ? 'NVD' : 'OSV', url: alias.startsWith('CVE-') ? `https://nvd.nist.gov/vuln/detail/${alias}` : `https://osv.dev/vulnerability/${alias}` } })) } : {}),
        affects: [{ ref: finding.component.purl }]
      }))),
      ...report.runtimeFindings.map((finding) => ({ 'bom-ref': `eol:${runtimeRef(finding.runtime)}`, id: `EOL-${finding.runtime.runtime}-${finding.runtime.version}`, source: { name: 'endoflife.date', url: finding.url }, ratings: [{ severity: finding.severity }], description: finding.summary, affects: [{ ref: runtimeRef(finding.runtime) }] }))
    ]
  };
}

/** The SBOM without per-run fields, to tell whether anything actually changed. */
const stable = (bom: Record<string, unknown>) => JSON.stringify({ ...bom, serialNumber: undefined, metadata: { ...(bom.metadata as object), timestamp: undefined, properties: ((bom.metadata as { properties: Array<{ name: string }> }).properties).filter((property) => property.name !== 'near-ai:scan:time') } });

async function writeSbom(root: string, report: ScanReport, options: ScanOptions): Promise<boolean> {
  const file = path.join(root, SBOM_FILE);
  const bom = cycloneDx(report, path.basename(root), options.tool);
  if (options.write === 'if-changed') {
    const existing = await readFile(file, 'utf8').then((text) => JSON.parse(text) as Record<string, unknown>).catch(() => undefined);
    if (existing && stable(existing) === stable(bom)) return false;
  }
  await writeFile(file, `${JSON.stringify(bom, null, 2)}\n`, 'utf8');
  return true;
}

export function worstSeverity(report: ScanReport): Severity | undefined {
  return (['critical', 'high', 'medium', 'low', 'unknown'] as Severity[]).find((severity) => report.counts[severity] > 0);
}

/** A plain-text report for the agent and the output channel, most severe first. */
export function scanSummary(report: ScanReport, limit = 40): string {
  const total = Object.values(report.counts).reduce((sum, count) => sum + count, 0);
  const lines = [`Scanned ${report.components.length} dependencies from ${report.lockfiles.length ? report.lockfiles.join(', ') : 'no lockfiles'} and ${report.runtimes.length} runtime version(s) at ${report.scannedAt}.`];
  if (!report.lockfiles.length) lines.push('No lockfile was found, so dependencies could not be checked. Commit a lockfile (package-lock.json, poetry.lock, uv.lock, Cargo.lock, go.mod, composer.lock, Gemfile.lock, …).');
  lines.push(total ? `Found ${total}: ${(['critical', 'high', 'medium', 'low', 'unknown'] as Severity[]).filter((severity) => report.counts[severity]).map((severity) => `${report.counts[severity]} ${severity}`).join(', ')}.` : report.errors.length ? 'No vulnerabilities were reported, but the check was incomplete (see below).' : 'No known vulnerabilities.');
  let shown = 0;
  for (const finding of report.packages) for (const vuln of finding.vulnerabilities) {
    if (shown++ >= limit) break;
    lines.push(`- [${vuln.severity}${vuln.score !== undefined ? ` ${vuln.score}` : ''}] ${finding.component.name} ${finding.component.version} (${finding.component.source}${finding.component.development ? ', dev' : ''}): ${vuln.id}${vuln.aliases.length ? ` / ${vuln.aliases.join(', ')}` : ''} ${vuln.summary}${vuln.fixed.length ? ` Fixed in ${vuln.fixed[0]}.` : ' No fixed version published.'}`);
  }
  if (shown > limit) lines.push(`- … and ${shown - limit} more in ${SBOM_FILE}.`);
  for (const finding of [...report.runtimeFindings].sort((a, b) => rank(b.severity) - rank(a.severity))) lines.push(`- [${finding.severity}] ${finding.summary}`);
  for (const note of [...report.notes, ...report.errors]) lines.push(`Note: ${note}`);
  if (report.sbomWritten) lines.push(`Wrote ${SBOM_FILE} (CycloneDX 1.6).`);
  return lines.join('\n');
}

/** GitHub Actions workflow that runs OSV-Scanner on every push and pull request and weekly. */
export const CI_WORKFLOW = `# Checks dependencies for known vulnerabilities with OSV-Scanner on every push and pull
# request, and weekly for vulnerabilities published since. Results appear under Security >
# Code scanning. Pinned to a commit of google/osv-scanner-action v2.7.0.
name: Dependency scan

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  merge_group:
    branches: [main]
  schedule:
    - cron: "30 6 * * 1"

permissions:
  actions: read
  security-events: write
  contents: read

jobs:
  scan:
    if: \${{ github.event_name == 'push' || github.event_name == 'schedule' }}
    uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@b1d267aea5211fa648d9d442fa64b90dbdcbdd36 # v2.7.0
  scan-pr:
    if: \${{ github.event_name == 'pull_request' || github.event_name == 'merge_group' }}
    uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable-pr.yml@b1d267aea5211fa648d9d442fa64b90dbdcbdd36 # v2.7.0
`;
