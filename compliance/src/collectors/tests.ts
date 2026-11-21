// The tests collector (44-07, D-21, D-23, D-24). Each package's CI job writes a per-test NDJSON report (scripts/run-tests.mjs with
// NEAR_AI_TEST_REPORT, 44-02). This module reads those reports into TestReportRows keyed by source path (sourcePathForReport), for the mapped-test
// rules, and gives one observation per package that holds counts only: never a test name, skip text or output.
import { readFile as fsReadFile } from 'node:fs/promises';
import { sourcePathForReport, type Observation, type TestReportRow } from '../model.ts';
import type { Collector, CollectorContext } from './types.ts';

/** A report line longer than this (in UTF-8 bytes) is reported, not parsed. */
export const MAX_REPORT_LINE_BYTES = 64 * 1024;
/** A report larger than this (in UTF-16 code units, as read) is refused as a whole. */
export const MAX_REPORT_CHARS = 64 * 1024 * 1024;

/** A package's report: `root` for the repository's own suite, otherwise the package folder (relay, hub, compliance), which is also its prefix. */
export interface TestReportInput {
  readonly package: string;
  /** The report file, relative to the repository root unless absolute. */
  readonly file: string;
}

export interface TestsInput {
  readonly reports: readonly TestReportInput[];
}

/** Rows with source paths, and one message per line that could not be read (line number and why; never the line's text). */
export interface ReportRead {
  readonly rows: TestReportRow[];
  readonly errors: string[];
}

const PACKAGE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STATUSES: ReadonlySet<string> = new Set(['passed', 'failed', 'skipped', 'todo']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The row a report line holds, or undefined when its shape is not the reporter's. Only the known fields are copied. */
function rowOf(value: unknown, packagePrefix: string | undefined): TestReportRow | undefined {
  if (!isRecord(value)) return undefined;
  const { file, path, name, status, skip, ms } = value;
  if (typeof file !== 'string' || typeof name !== 'string' || typeof status !== 'string' || !STATUSES.has(status)) return undefined;
  if (!Array.isArray(path) || !path.every((part) => typeof part === 'string')) return undefined;
  if (skip !== null && typeof skip !== 'string') return undefined;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return { file: sourcePathForReport(file, packagePrefix), path: [...path], name, status: status as TestReportRow['status'], skip, ms };
}

/** Parses report text. A line that is too long, not JSON or not a report row is reported by number and skipped; the other lines still count. */
export function parseReport(text: string, packagePrefix?: string, label = 'report'): ReportRead {
  const rows: TestReportRow[] = [];
  const errors: string[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === '') continue;
    const where = `${label} line ${index + 1}`;
    if (Buffer.byteLength(line, 'utf8') > MAX_REPORT_LINE_BYTES) { errors.push(`${where}: longer than ${MAX_REPORT_LINE_BYTES} bytes`); continue; }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      errors.push(`${where}: not valid JSON`);
      continue;
    }
    const row = rowOf(value, packagePrefix);
    if (row) rows.push(row);
    else errors.push(`${where}: not a test report row`);
  }
  return { rows, errors };
}

const defaultReadFile = (file: string): Promise<string> => fsReadFile(file, 'utf8');

/** Reads one report and maps its paths to source files (with a package prefix such as relay or hub). */
export async function readReport(file: string, packagePrefix?: string, readFile: (file: string) => Promise<string> = defaultReadFile): Promise<ReportRead> {
  const text = await readFile(file);
  if (text.length > MAX_REPORT_CHARS) throw new Error(`the report ${file} is larger than ${MAX_REPORT_CHARS} characters`);
  return parseReport(text, packagePrefix, packagePrefix ? `${packagePrefix} report` : 'root report');
}

const isMissing = (error: unknown): boolean => isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

function checkInput(input: TestsInput): readonly TestReportInput[] {
  if (!isRecord(input) || !Array.isArray(input.reports)) throw new Error('tests collector: input.reports must be a list of { package, file }');
  const seen = new Set<string>();
  for (const report of input.reports) {
    if (!isRecord(report) || typeof report.package !== 'string' || !PACKAGE_PATTERN.test(report.package)) throw new Error('tests collector: each report needs a package name of lowercase letters, digits and dashes');
    if (typeof report.file !== 'string' || report.file === '') throw new Error(`tests collector: the ${report.package} report needs a file`);
    if (seen.has(report.package)) throw new Error(`tests collector: the package ${report.package} is listed twice`);
    seen.add(report.package);
  }
  return input.reports;
}

/** Every package's rows (source paths) and line errors, and one observation per package. Used by the bundle for the rows and by testsCollector. */
export async function readReports(input: TestsInput, context: CollectorContext): Promise<{ rows: TestReportRow[]; errors: string[]; observations: Observation[] }> {
  const rows: TestReportRow[] = [];
  const errors: string[] = [];
  const observations: Observation[] = [];
  for (const report of checkInput(input)) {
    const prefix = report.package === 'root' ? undefined : report.package;
    let read: ReportRead | undefined;
    try {
      read = await readReport(report.file, prefix, context.readFile);
    } catch (error) {
      if (!isMissing(error)) throw error;
      errors.push(`${report.package} report: missing`);
    }
    const counts = { rows: 0, passed: 0, failed: 0, skipped: 0, todo: 0, malformed: read?.errors.length ?? 0, missing: read ? 0 : 1 };
    for (const row of read?.rows ?? []) {
      counts.rows++;
      counts[row.status]++;
    }
    if (read) { rows.push(...read.rows); errors.push(...read.errors); }
    observations.push({
      collector: 'tests',
      subject: report.package,
      passed: read !== undefined && counts.rows > 0 && counts.failed === 0 && counts.malformed === 0,
      collectedAt: context.now.toISOString(),
      commit: context.commit,
      ...(context.runUrl ? { runUrl: context.runUrl } : {}),
      counts
    });
  }
  return { rows, errors, observations };
}

/** One observation `tests` / `<package>`: passed when the report exists, has rows, and has no failed or malformed row. Skipped and todo rows are counted, not failures here; the mapped-test rules judge those per test. */
export const testsCollector: Collector<TestsInput> = Object.freeze({
  id: 'tests',
  window: 'head',
  async collect(input: TestsInput, context: CollectorContext): Promise<Observation[]> {
    return (await readReports(input, context)).observations;
  }
});
