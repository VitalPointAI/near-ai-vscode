import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { testsCollector, readReports } from './collectors/tests.ts';
import { ciCollector } from './collectors/ci.ts';
import { secretScanCollector } from './collectors/secretScan.ts';
import { documentsCollector } from './collectors/documents.ts';
import { cryptoCollector } from './collectors/crypto.ts';
import { auditCollector } from './collectors/audit.ts';
import { sbomCollector, type SbomInput } from './collectors/sbom.ts';
import { releaseCollector } from './collectors/release.ts';
import { attestationsCollector } from './collectors/attestations.ts';
import { settingsCollector } from './collectors/settings.ts';
import { reviewsCollector } from './collectors/reviews.ts';
import { codeScanningCollector } from './collectors/codeScanning.ts';
import { deploymentCollector } from './collectors/deployment.ts';
import type { Collector, CollectorContext, FetchJson } from './collectors/types.ts';
import { buildJudgement, type DashboardBuildInput } from './dashboard.ts';
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
  releaseCollector, attestationsCollector, settingsCollector, reviewsCollector, codeScanningCollector, deploymentCollector
]);

export interface BundleInputs {
  readonly repository: string; readonly commit: string; readonly runUrl?: string;
  readonly kind: 'main' | 'scheduled' | 'release' | 'pr'; readonly repoRoot: string;
  readonly collectors: Readonly<Record<string, unknown>>;
  readonly dashboard?: Partial<DashboardBuildInput>;
}
interface ScheduledEvidence { readonly directory: string; readonly runUrl: string }
export interface BundleContext { readonly now?: Date; readonly fetchJson?: FetchJson; readonly readFile?: (file: string) => Promise<string>; readonly previous?: string; readonly controlTextSource?: string; readonly scheduled?: ScheduledEvidence; }
export interface BundleResult { readonly observations: readonly Observation[]; readonly testRows: readonly TestReportRow[]; readonly collectors: readonly { readonly id: string; readonly ran: boolean; readonly ok: boolean; readonly error?: string; readonly lastCollectedAt?: string }[]; readonly dashboard: ReturnType<typeof buildJudgement>['dashboard']; }

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

const scheduledCollectors = new Set(['settings', 'review-trail']);

function readScheduledEvidence(source: ScheduledEvidence, inputs: BundleInputs, now: Date): Observation[] {
  const runPrefix = `https://github.com/${inputs.repository}/actions/runs/`;
  if (!source.runUrl.startsWith(runPrefix) || !/^[1-9]\d*$/.test(source.runUrl.slice(runPrefix.length))) {
    throw new Error('scheduled evidence requires a run URL in this repository');
  }
  const checked = verifyManifest(source.directory);
  if (!checked.ok) throw new Error('scheduled evidence manifest does not verify');
  const manifest = JSON.parse(readFileSync(path.join(source.directory, 'manifest.json'), 'utf8')) as BundleManifest;
  const record = JSON.parse(readFileSync(path.join(source.directory, 'observations.json'), 'utf8')) as {
    schemaVersion?: unknown; kind?: unknown; commit?: unknown; generatedAt?: unknown; observations?: Observation[];
  };
  const collectedAt = Date.parse(manifest.createdAt);
  if (manifest.commit !== inputs.commit || record?.commit !== inputs.commit || record.kind !== 'scheduled' ||
      record.schemaVersion !== 1 || record.generatedAt !== manifest.createdAt || !Number.isFinite(collectedAt) || collectedAt > now.getTime() ||
      !Array.isArray(record.observations)) {
    throw new Error('scheduled evidence must describe the assessed release commit');
  }
  const scoped = record.observations.filter((entry) => scheduledCollectors.has(entry?.collector));
  const observed = new Set<string>();
  for (const raw of scoped) {
    const row = redactObservation(raw);
    const key = `${row.collector}/${row.subject}`;
    if (!isDeepStrictEqual(raw, row) || row.commit !== inputs.commit || row.runUrl !== source.runUrl ||
        row.collectedAt !== manifest.createdAt || observed.has(key)) {
      throw new Error('scheduled settings or review observations lack consistent provenance');
    }
    observed.add(key);
  }
  if (!scoped.length) throw new Error('scheduled evidence has no settings or review observations');
  return scoped;
}

/** Execute supplied collectors, preserve failures as evidence, then write one self-verifying folder. */
export async function runBundle(inputs: BundleInputs, out: string, supplied: BundleContext = {}): Promise<BundleResult> {
  if (!/^[0-9a-f]{40}$/.test(inputs.commit)) throw new Error('bundle commit must be a 40-character lower-case SHA');
  if (supplied.scheduled && (inputs.kind !== 'release' || !supplied.previous || Object.keys(inputs.collectors).length)) {
    throw new Error('scheduled evidence requires a release bundle built from verified CI evidence');
  }
  const now = supplied.now ?? new Date();
  const scheduled = supplied.scheduled && readScheduledEvidence(supplied.scheduled, inputs, now);
  const output = prepareOutput(out);
  const context: CollectorContext = { now, commit: inputs.commit, ...(inputs.runUrl ? { runUrl: inputs.runUrl } : {}), ...(supplied.fetchJson ? { fetchJson: supplied.fetchJson } : {}), readFile: supplied.readFile ?? ((file) => Promise.resolve(readFileSync(path.resolve(inputs.repoRoot, file), 'utf8'))) };
  const observations: Observation[] = []; const testRows: TestReportRow[] = []; const carried: string[] = [];
  const collectorRows: { id: string; ran: boolean; ok: boolean; error?: string; lastCollectedAt?: string }[] = [];
  for (const collector of COLLECTORS) {
    if (!(collector.id in inputs.collectors)) { collectorRows.push({ id: collector.id, ran: false, ok: false }); continue; }
    try {
      let result: Observation[];
      if (collector.id === 'tests') { const report = await readReports(inputs.collectors.tests as any, context); result = report.observations; testRows.push(...report.rows); }
      else result = await collector.collect(inputs.collectors[collector.id], context);
      const redacted = result.map(redactObservation);
      if (collector.id === 'sbom') {
        const input = inputs.collectors.sbom as SbomInput;
        if (input.retainVsix === true) {
          const sources = input.sboms.filter(({ subject }) => subject === 'vsix');
          const [source] = sources;
          const observed = redacted.find((row) => row.collector === 'sbom' && row.subject === 'vsix' && row.passed);
          if (sources.length !== 1 || !source || !observed) throw new Error('Expected one verified installer SBOM');
          const text = await context.readFile(source.file);
          if (createHash('sha256').update(text).digest('hex') !== observed.hash) throw new Error('The installer SBOM changed during collection');
          writeFileSync(path.join(output, 'vsix-sbom.cdx.json'), text, { flag: 'wx' });
        }
      }
      observations.push(...redacted);
      collectorRows.push({ id: collector.id, ran: true, ok: true, ...(redacted[0] ? { lastCollectedAt: redacted.map((row) => row.collectedAt).sort().at(-1) } : {}) });
    } catch (error) { collectorRows.push({ id: collector.id, ran: true, ok: false, error: codeOf(error) }); }
  }
  if (supplied.previous) {
    const previousDir = path.resolve(supplied.previous);
    const verified = verifyManifest(previousDir);
    if (!verified.ok) throw new Error(`previous bundle does not verify: ${verified.errors.join('; ')}`);
    const manifest = JSON.parse(readFileSync(path.join(previousDir, 'manifest.json'), 'utf8')) as BundleManifest;
    const previous = JSON.parse(readFileSync(path.join(previousDir, 'observations.json'), 'utf8')) as { observations?: unknown; commit?: unknown; kind?: unknown };
    if (!Array.isArray(previous.observations)) throw new Error('previous observations.json is invalid');
    if (scheduled && (manifest.commit !== inputs.commit || previous.commit !== inputs.commit || previous.kind !== 'main')) {
      throw new Error('scheduled release evidence requires the assessed commit’s main CI bundle');
    }
    const ran = new Set(collectorRows.filter((row) => row.ran).map((row) => row.id));
    for (const raw of previous.observations) {
      const observation = redactObservation(raw as Observation);
      if (scheduled && scheduledCollectors.has(observation.collector)) continue;
      if (!ran.has(observation.collector) && COLLECTORS.some((collector) => collector.id === observation.collector)) {
        observations.push(observation); if (!carried.includes(observation.collector)) carried.push(observation.collector);
      }
    }
    if (scheduled) {
      observations.push(...scheduled);
      for (const collector of new Set(scheduled.map((row) => row.collector))) carried.push(collector);
      const installerSbom = path.join(previousDir, 'vsix-sbom.cdx.json');
      if (existsSync(installerSbom)) {
        const text = readFileSync(installerSbom);
        const hash = createHash('sha256').update(text).digest('hex');
        const verifiedSbom = observations.find((row) => row.collector === 'sbom' && row.subject === 'vsix' &&
          row.commit === inputs.commit && row.passed && row.hash === hash);
        if (!verifiedSbom) throw new Error('installer SBOM does not match the main CI observation');
        writeFileSync(path.join(output, 'vsix-sbom.cdx.json'), text, { flag: 'wx' });
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
  // The judgement holds the engine inputs the rows were judged from, so a session can judge them again at any time (48.2, D-11).
  const { dashboard, judgement } = buildJudgement(dashboardInput);
  // These fields are presentation data, never source inputs. Their values stay schema-safe.
  const official = supplied.controlTextSource && writeControlText(path.join(output, 'dashboard'), supplied.controlTextSource);
  const withText = <T extends { readonly level: string; readonly control: string }>(row: T): T => {
    const control = official && official.byLevel.get(row.level)?.get(row.control);
    return control ? { ...row, ...control } : row;
  };
  const rows = official ? dashboard.rows.map(withText) : dashboard.rows;
  const judgementRows = official ? judgement.rows.map(withText) : judgement.rows;
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
  writeFileSync(path.join(output, 'dashboard', 'judgement.json'), stable({ ...judgement, rows: judgementRows }));
  assertNoSecrets(output);
  writeManifest(output, { createdAt: now.toISOString(), commit: inputs.commit });
  return { observations, testRows, collectors: collectorRows, dashboard: enriched };
}
