import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { testsCollector, readReports } from './collectors/tests.ts';
import { ciCollector } from './collectors/ci.ts';
import { secretScanCollector } from './collectors/secretScan.ts';
import { documentsCollector } from './collectors/documents.ts';
import { cryptoCollector } from './collectors/crypto.ts';
import { auditCollector } from './collectors/audit.ts';
import { sbomCollector } from './collectors/sbom.ts';
import { releaseCollector } from './collectors/release.ts';
import { attestationsCollector } from './collectors/attestations.ts';
import { settingsCollector } from './collectors/settings.ts';
import { reviewsCollector } from './collectors/reviews.ts';
import { codeScanningCollector } from './collectors/codeScanning.ts';
import type { Collector, CollectorContext, FetchJson } from './collectors/types.ts';
import { buildDashboard, type DashboardBuildInput } from './dashboard.ts';
import type { Observation, TestReportRow } from './model.ts';
import { verifyManifest, writeManifest, type BundleManifest } from './manifest.ts';
import { assertNoSecrets, redactObservation, redactTestRow } from './redact.ts';
import { lintDashboard } from './wordLint.ts';
import { validateOurs } from './validate.ts';
import { writeControlText } from './controlText.ts';

/** Stable order is part of the public bundle contract. */
export const COLLECTORS: readonly Collector[] = Object.freeze([
  // `code-scanning` remains in this list even when no CI input supplies it, so its silence is visible.
  testsCollector, ciCollector, secretScanCollector, documentsCollector, cryptoCollector, auditCollector, sbomCollector,
  releaseCollector, attestationsCollector, settingsCollector, reviewsCollector, codeScanningCollector
]);

export interface BundleInputs {
  readonly repository: string; readonly commit: string; readonly runUrl?: string;
  readonly kind: 'main' | 'scheduled' | 'release' | 'pr'; readonly repoRoot: string;
  readonly collectors: Readonly<Record<string, unknown>>;
  readonly dashboard?: Partial<DashboardBuildInput>;
}
export interface BundleContext { readonly now?: Date; readonly fetchJson?: FetchJson; readonly readFile?: (file: string) => Promise<string>; readonly previous?: string; readonly controlTextSource?: string; }
export interface BundleResult { readonly observations: readonly Observation[]; readonly testRows: readonly TestReportRow[]; readonly collectors: readonly { readonly id: string; readonly ran: boolean; readonly ok: boolean; readonly error?: string; readonly lastCollectedAt?: string }[]; readonly dashboard: ReturnType<typeof buildDashboard>; }

const stable = (value: unknown): string => `${JSON.stringify(value, (_key, child) => child && typeof child === 'object' && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child, 2)}\n`;
const codeOf = (error: unknown) => typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'collector-error';
function prepareOutput(out: string): string {
  const resolved = path.resolve(out);
  if (resolved === path.parse(resolved).root) throw new Error('output directory cannot be a filesystem root');
  // Check existing ancestors before creating any directories through them.
  let existing = resolved;
  while (true) {
    try {
      if (realpathSync(existing) !== existing) throw new Error('bundle output cannot use a symbolic link');
      break;
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
      existing = path.dirname(existing);
    }
  }
  mkdirSync(resolved, { recursive: true });
  if (readdirSync(resolved).length) throw new Error('bundle output directory must be empty');
  mkdirSync(path.join(resolved, 'dashboard'));
  return resolved;
}

/** Execute supplied collectors, preserve failures as evidence, then write one self-verifying folder. */
export async function runBundle(inputs: BundleInputs, out: string, supplied: BundleContext = {}): Promise<BundleResult> {
  if (!/^[0-9a-f]{40}$/.test(inputs.commit)) throw new Error('bundle commit must be a 40-character lower-case SHA');
  const output = prepareOutput(out);
  const now = supplied.now ?? new Date();
  const context: CollectorContext = { now, commit: inputs.commit, ...(inputs.runUrl ? { runUrl: inputs.runUrl } : {}), ...(supplied.fetchJson ? { fetchJson: supplied.fetchJson } : {}), readFile: supplied.readFile ?? ((file) => Promise.resolve(readFileSync(path.resolve(inputs.repoRoot, file), 'utf8'))) };
  const observations: Observation[] = []; const testRows: TestReportRow[] = []; const carried: string[] = [];
  const collectorRows: { id: string; ran: boolean; ok: boolean; error?: string; lastCollectedAt?: string }[] = [];
  for (const collector of COLLECTORS) {
    if (!(collector.id in inputs.collectors)) { collectorRows.push({ id: collector.id, ran: false, ok: false }); continue; }
    try {
      let result: Observation[];
      if (collector.id === 'tests') { const report = await readReports(inputs.collectors.tests as any, context); result = report.observations; testRows.push(...report.rows); }
      else result = await collector.collect(inputs.collectors[collector.id], context);
      const redacted = result.map(redactObservation); observations.push(...redacted);
      collectorRows.push({ id: collector.id, ran: true, ok: true, ...(redacted[0] ? { lastCollectedAt: redacted.map((row) => row.collectedAt).sort().at(-1) } : {}) });
    } catch (error) { collectorRows.push({ id: collector.id, ran: true, ok: false, error: codeOf(error) }); }
  }
  if (supplied.previous) {
    const previousDir = path.resolve(supplied.previous);
    const verified = verifyManifest(previousDir);
    if (!verified.ok) throw new Error(`previous bundle does not verify: ${verified.errors.join('; ')}`);
    const manifest = JSON.parse(readFileSync(path.join(previousDir, 'manifest.json'), 'utf8')) as BundleManifest;
    const previous = JSON.parse(readFileSync(path.join(previousDir, 'observations.json'), 'utf8')) as { observations?: unknown };
    if (!Array.isArray(previous.observations)) throw new Error('previous observations.json is invalid');
    const ran = new Set(collectorRows.filter((row) => row.ran).map((row) => row.id));
    for (const raw of previous.observations) {
      const observation = redactObservation(raw as Observation);
      if (!ran.has(observation.collector) && COLLECTORS.some((collector) => collector.id === observation.collector)) {
        observations.push(observation); if (!carried.includes(observation.collector)) carried.push(observation.collector);
      }
    }
    for (const row of collectorRows) if (!row.ran) {
      const dates = observations.filter((item) => item.collector === row.id).map((item) => item.collectedAt).sort();
      if (dates.length) { row.ok = true; row.lastCollectedAt = dates.at(-1); }
    }
    const reportFile = path.join(previousDir, 'test-rows.json');
    if (!ran.has('tests') && manifest.commit === inputs.commit && existsSync(reportFile)) {
      const rows: unknown = JSON.parse(readFileSync(reportFile, 'utf8'));
      if (!Array.isArray(rows)) throw new Error('previous test-rows.json is invalid');
      for (const row of rows) testRows.push(redactTestRow(row));
    }
  }
  // The bundle's per-package observations hold provenance for its combined test rows.
  const testObservations = observations.filter((item) => item.collector === 'tests');
  const [testEvidence] = testObservations;
  if (testRows.length && (!testEvidence || testObservations.some((item) => item.commit !== inputs.commit ||
    item.collectedAt !== testEvidence.collectedAt || item.runUrl !== testEvidence.runUrl))) {
    throw new Error('test rows lack consistent collection provenance for the bundle commit');
  }
  if (testRows.length && testObservations.reduce((count, item) => count + (item.counts?.rows ?? 0), 0) !== testRows.length) {
    throw new Error('test row count does not match the test collector observations');
  }
  const dashboardInput: DashboardBuildInput = {
    commit: inputs.commit, generatedAt: now.toISOString(), now, head: inputs.commit, levels: [], components: [], rules: [], observations,
    ...(testRows.length && testEvidence ? { testEvidence: { collectedAt: testEvidence.collectedAt, runUrl: testEvidence.runUrl } } : {}),
    testRows: testRows.map(redactTestRow), source: { kind: inputs.kind === 'pr' ? 'local' : inputs.kind, ref: inputs.commit }, ...(inputs.runUrl ? { runUrl: inputs.runUrl } : {}), ...inputs.dashboard
  };
  const dashboard = buildDashboard(dashboardInput);
  // These fields are presentation data, never source inputs. Their values stay schema-safe.
  const official = supplied.controlTextSource && writeControlText(path.join(output, 'dashboard'), supplied.controlTextSource);
  const rows = official ? dashboard.rows.map((row) => {
    const control = official.byLevel.get(row.level)?.get(row.control);
    return control ? { ...row, ...control } : row;
  }) : dashboard.rows;
  const enriched = { ...dashboard, rows, ...(official ? { textIndex: official.index } : {}), collectors: collectorRows.map((row) => ({ id: row.id, window: COLLECTORS.find((item) => item.id === row.id)!.window, ...(row.lastCollectedAt ? { lastCollectedAt: row.lastCollectedAt } : {}), ...(row.ran ? { passed: row.ok } : {}) })) };
  const copyFindings = lintDashboard(enriched);
  if (copyFindings.length) {
    throw new Error(`dashboard copy lint failed: ${copyFindings.map(({ path, rule }) => `${path}: ${rule}`).join('; ')}`);
  }
  const valid = validateOurs(enriched, 'dashboard');
  if (!valid.ok) throw new Error(`invalid evidence dashboard: ${valid.errors.join('; ')}`);
  writeFileSync(path.join(output, 'observations.json'), stable({ schemaVersion: 1, commit: inputs.commit, generatedAt: now.toISOString(), kind: inputs.kind, observations, carried: carried.sort() }));
  writeFileSync(path.join(output, 'test-rows.json'), stable(testRows.map(redactTestRow)));
  writeFileSync(path.join(output, 'collectors.json'), stable(collectorRows));
  writeFileSync(path.join(output, 'dashboard', 'dashboard.json'), stable(enriched));
  assertNoSecrets(output);
  writeManifest(output, { createdAt: now.toISOString(), commit: inputs.commit });
  return { observations, testRows, collectors: collectorRows, dashboard: enriched };
}
