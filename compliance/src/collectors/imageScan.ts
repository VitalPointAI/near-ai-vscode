// The release image's vulnerability scan as evidence (48.2-05, D-03, D-13, D-15). A Grype JSON report of the image's CycloneDX SBOM becomes
// one image-scan observation whose evidence time is the vulnerability database's build date, never the scan time: what a scan knows is
// only as new as its database, so the result ages by the vulnerability window (ageing after 7 days, out of date after 30). The observation
// keeps counts, a hash and a date only (48 D-13): no package name, advisory id, text or path. The raw report stays a file in the release
// evidence folder. Findings are shown, not judged: SI-2 remediation timeliness is G479.
import { redactObservation } from '../redact.ts';
import type { Observation } from '../model.ts';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'negligible', 'unknown'] as const;
const FIXABLE = ['critical', 'high', 'medium', 'low'] as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parse(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`the ${what} is not JSON`);
  }
  if (!isRecord(value)) throw new Error(`the ${what} is not a JSON object`);
  return value;
}

/** An ISO time from a tool, as the millisecond ISO form observations use; undefined when absent or not a time. */
function isoTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

/** The database's checksum from `grype db status`'s `from` address (`?checksum=sha256:<hex>`), when it names one. */
function databaseChecksum(from: unknown): string | undefined {
  if (typeof from !== 'string') return undefined;
  try {
    const checksum = new URL(from).searchParams.get('checksum') ?? '';
    return /^sha256:[0-9a-f]{64}$/.test(checksum) ? checksum.slice('sha256:'.length) : undefined;
  } catch {
    return undefined;
  }
}

/** The facts `grype db status -o json` gives: the build date, the schema and the checksum; refused without a valid build date. */
export function databaseStatus(text: string): { readonly built: string; readonly schemaMajor?: number; readonly checksum?: string; readonly valid: boolean } {
  const status = parse(text, 'database status');
  const built = isoTime(status.built);
  if (!built) throw new Error('the database status has no build date (grype db status -o json "built")');
  const major = typeof status.schemaVersion === 'string' ? /^v?(\d{1,3})\./.exec(status.schemaVersion)?.[1] : undefined;
  const checksum = databaseChecksum(status.from);
  return { built, ...(major ? { schemaMajor: Number(major) } : {}), ...(checksum ? { checksum } : {}), valid: status.valid === true };
}

/** The digest the image's CycloneDX SBOM gives the image: its metadata component's version, as syft writes it. */
export function sbomImageDigest(sbomText: string): string {
  const sbom = parse(sbomText, 'SBOM');
  const component = isRecord(sbom.metadata) && isRecord(sbom.metadata.component) ? sbom.metadata.component : undefined;
  if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components)) throw new Error('the SBOM is not CycloneDX JSON');
  const version = component?.version;
  if (typeof version !== 'string' || !DIGEST.test(version)) throw new Error('the SBOM does not name its image digest (metadata.component.version)');
  return version;
}

/**
 * The image-scan observation for `subject`: counts by severity and fixable counts, the database schema's major version, the database
 * checksum as its hash, dated at the database build date. The scan must be of the image the SBOM describes (its source manifest digest),
 * must have used the database the status names, and must not predate that database. `passed` says the scan ran on a valid database; the
 * findings themselves are shown, not judged (G479).
 */
export function imageScanObservation(scanText: string, dbStatusText: string, options: { readonly subject: string; readonly sbom: string }): Observation {
  const database = databaseStatus(dbStatusText);
  const scan = parse(scanText, 'Grype report');
  if (!Array.isArray(scan.matches) || !isRecord(scan.descriptor) || !isRecord(scan.source)) throw new Error('the Grype report is not Grype JSON (matches, source, descriptor)');
  const scannedAt = isoTime(scan.descriptor.timestamp);
  if (!scannedAt) throw new Error('the Grype report has no scan time (descriptor.timestamp)');
  if (Date.parse(database.built) > Date.parse(scannedAt)) throw new Error('the database was built after the scan, so the scan cannot have used it');
  const target = isRecord(scan.source.target) ? scan.source.target : undefined;
  if (scan.source.type !== 'image' || target?.manifestDigest !== sbomImageDigest(options.sbom)) throw new Error('the scan is not of the image the SBOM describes');
  const used = isRecord(scan.descriptor.db) && isRecord(scan.descriptor.db.status) ? isoTime(scan.descriptor.db.status.built) : undefined;
  if (used !== database.built) throw new Error('the scan used another database than the database status names');
  const counts: Record<string, number> = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const severity of FIXABLE) counts[`${severity}-fixable`] = 0;
  for (const match of scan.matches) {
    const vulnerability = isRecord(match) && isRecord(match.vulnerability) ? match.vulnerability : {};
    const raw = typeof vulnerability.severity === 'string' ? vulnerability.severity.toLowerCase() : 'unknown';
    const severity = (SEVERITIES as readonly string[]).includes(raw) ? raw : 'unknown';
    counts[severity]! += 1;
    const fixed = isRecord(vulnerability.fix) && vulnerability.fix.state === 'fixed';
    if (fixed && (FIXABLE as readonly string[]).includes(severity)) counts[`${severity}-fixable`]! += 1;
  }
  counts.total = scan.matches.length;
  if (database.schemaMajor !== undefined) counts['db-schema'] = database.schemaMajor;
  return redactObservation({
    collector: 'image-scan', subject: options.subject, passed: database.valid, collectedAt: database.built,
    ...(database.checksum ? { hash: database.checksum } : {}), counts,
  });
}
