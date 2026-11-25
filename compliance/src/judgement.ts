// The judgement (48.2, D-11): the status engine's inputs for every level, control and component, with their presentation fields, and never a
// state or a clock. rejudge re-runs the one engine (computeStatus, aggregateControl, the one row rule and the REASONS texts) at any time, so
// a release's evidence is judged against the current time wherever it is shown. The dashboard builds its rows through the same functions
// (dashboard.ts), so the dashboard and a re-judged judgement can never apply different rules.
// The evidence folder's manifest (D-15, `sterling-evidence/1`) is defined here once, for the release evidence writer (48.2-05) and the
// session (the workbench backend) alike. This file imports only status.ts and model.ts: the workbench bundles it (engine/compliance.cjs).
import { aggregateControl, computeStatus, isFresh, summarizeLevel } from './status.ts';
import { REASONS, type ComponentRow, type DashboardRow, type Responsibility, type RuleResult, type StatusInput } from './model.ts';

export const JUDGEMENT_FORMAT = 'sterling-judgement/1' as const;

/** One component's engine inputs: a StatusInput without the clock and the judged commit (both given when judged). */
export type JudgementComponent = Omit<StatusInput, 'now' | 'head'> & {
  /** Presentation: the provider an inherited control comes from, filled into the reason text. */
  readonly inheritedFrom?: string;
};

/** A row's engine inputs. `responsibility` is the configured responsibility the row rule uses when no component is in scope. */
export interface JudgementRowInput {
  readonly level: string;
  readonly control: string;
  /** False for a level whose claim is false: the row rule then says only the appliance can provide the control. */
  readonly claim: boolean;
  readonly responsibility: Responsibility;
  readonly components: readonly JudgementComponent[];
}

/** A row's presentation fields: none of them is an engine input. */
export interface JudgementRowPresentation {
  readonly label: string;
  readonly family: string;
  readonly title: string;
  readonly gap?: string;
  readonly textFile?: string;
}

export type JudgementRow = JudgementRowInput & JudgementRowPresentation;

export interface JudgementLevel {
  readonly id: string;
  readonly title: string;
  readonly kind: 'level' | 'overlay';
  readonly profile: string;
  readonly claim: boolean;
  readonly components: readonly string[];
  readonly overlays: readonly string[];
  readonly notes?: Readonly<{ text?: string; profileDifferences?: readonly string[] }>;
}

export interface Judgement {
  readonly format: typeof JUDGEMENT_FORMAT;
  /** When the evidence was gathered and the bundle built; rejudge at this time reproduces the bundle's dashboard rows exactly. */
  readonly generatedAt: string;
  readonly commit: string;
  /** The commit `head`-window evidence must come from: the commit the release was built from. */
  readonly head: string;
  readonly levels: readonly JudgementLevel[];
  readonly rows: readonly JudgementRow[];
}

export type JudgedComponent = ComponentRow & Readonly<{ reasonText: string; statement?: string; limitation?: string; unsettled?: string; requiresOfficialSignature?: boolean; inheritedFrom?: string }>;
export type JudgedRow = DashboardRow & JudgementRowPresentation & Readonly<{ reasonText: string; components: readonly JudgedComponent[] }>;
export type JudgedLevel = JudgementLevel & Readonly<{ counts: ReturnType<typeof summarizeLevel> }>;

/** Fill the safe, local reason template; absent values become plain empty text rather than template braces. */
export function fillReason(reason: keyof typeof REASONS, detail?: Readonly<Record<string, string>>): string {
  return REASONS[reason].replace(/\{(date|reason|text|question|provider)\}/g, (_match, key: string) => detail?.[key] ?? '');
}

/** The results a component's rules name, in rule order: the component's evidence. */
function evidenceOf(component: JudgementComponent): RuleResult[] {
  return Object.values(component.rulesByStatement).flat().map((rule) => component.results[rule.id]).filter((result): result is RuleResult => result !== undefined);
}

/** One component's engine inputs, carrying only the results its own rules name, and never a clock, a commit to judge or a state. */
function judgementComponent(component: JudgementComponent): JudgementComponent {
  const results: Record<string, RuleResult> = {};
  for (const rule of Object.values(component.rulesByStatement).flat()) {
    const result = Object.hasOwn(component.results, rule.id) ? component.results[rule.id] : undefined;
    if (result) results[rule.id] = result;
  }
  return {
    control: component.control, component: component.component, level: component.level, responsibility: component.responsibility,
    statements: component.statements, rulesByStatement: component.rulesByStatement, results,
    ...(component.tailoring ? { tailoring: component.tailoring } : {}),
    ...(component.unsettled ? { unsettled: component.unsettled } : {}),
    ...(component.selfSigned !== undefined ? { selfSigned: component.selfSigned } : {}),
    ...(component.limitation ? { limitation: component.limitation } : {}),
    ...(component.riskAcceptance ? { riskAcceptance: component.riskAcceptance } : {}),
    ...(component.inheritedFrom ? { inheritedFrom: component.inheritedFrom } : {}),
  };
}

/** One judgement row: the engine inputs and the presentation fields, never a state. */
export function judgementRow(input: JudgementRowInput, presentation: JudgementRowPresentation): JudgementRow {
  return {
    level: input.level, control: input.control, claim: input.claim, responsibility: input.responsibility,
    components: input.components.map(judgementComponent),
    label: presentation.label, family: presentation.family, title: presentation.title,
    ...(presentation.gap ? { gap: presentation.gap } : {}),
    ...(presentation.textFile ? { textFile: presentation.textFile } : {}),
  };
}

/** Judges one component now: computeStatus and the reason text, with its evidence and its first statement's presentation. */
export function judgeComponent(component: JudgementComponent, head: string, now: Date): JudgedComponent {
  const { inheritedFrom, ...input } = component;
  const outcome = computeStatus({ ...input, head, now });
  const statement = component.statements[0];
  return {
    component: component.component,
    state: outcome.state,
    reason: outcome.reason,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
    reasonText: fillReason(outcome.reason, outcome.reason === 'inherited' ? { ...(outcome.detail ?? {}), provider: inheritedFrom ?? '' } : outcome.detail),
    responsibility: component.responsibility,
    evidence: evidenceOf(component),
    ...(statement ? { statement: statement.description } : {}),
    ...(statement?.limitation ? { limitation: statement.limitation } : {}),
    ...(statement?.unsettled ? { unsettled: statement.unsettled } : {}),
    ...(statement?.requiresOfficialSignature ? { requiresOfficialSignature: true } : {}),
    ...(inheritedFrom ? { inheritedFrom } : {}),
  };
}

/**
 * The row rule (moved unchanged from dashboard.ts): one component gives its own state; several give the worst of them through
 * aggregateControl; none gives what computeStatus says of a control with no statement, so even that state comes from the status engine.
 * A level whose claim is false makes no claim for any control.
 */
export function controlState(components: readonly ComponentRow[], row: Pick<JudgementRowInput, 'level' | 'control' | 'claim' | 'responsibility'>, head: string, now: Date): Pick<DashboardRow, 'state' | 'reason' | 'detail'> {
  if (row.claim === false) return { state: 'not-met', reason: 'appliance-only' };
  if (components.length === 0) {
    const outcome = computeStatus({ control: row.control, component: '', level: row.level, responsibility: row.responsibility, statements: [], rulesByStatement: {}, results: {}, head, now });
    return { state: outcome.state, reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) };
  }
  const applicable = components.filter((component) => component.state !== 'not-applicable');
  // A reviewed exclusion does not dilute assessment of any remaining components. Keep its
  // reason if all are excluded. An unreviewed exclusion remains a gap in the aggregate.
  const unreviewed = applicable.find((component) => component.reason === 'not-applicable-unreviewed');
  const single = unreviewed ?? (applicable.length <= 1 ? applicable[0] ?? components[0] : undefined);
  // Preserve the exact outcome (including stale date and inherited provider) when
  // there is only one component; aggregateControl is for a genuine combination.
  if (single) {
    return { state: single.state, reason: single.reason, ...(single.detail ? { detail: single.detail } : {}) };
  }
  const aggregate = aggregateControl(applicable);
  return { state: aggregate.state, reason: aggregate.reason, ...(aggregate.detail ? { detail: aggregate.detail } : {}) };
}

/** Judges one row now: every component, then the one row rule, then the reason text. */
export function judgeRow(row: JudgementRow, head: string, now: Date): JudgedRow {
  const components = row.components.map((component) => judgeComponent(component, head, now));
  const outcome = controlState(components, row, head, now);
  return {
    level: row.level, control: row.control, label: row.label, family: row.family, title: row.title,
    ...outcome, reasonText: fillReason(outcome.reason, outcome.detail), components,
    ...(row.gap ? { gap: row.gap } : {}),
    ...(row.textFile ? { textFile: row.textFile } : {}),
  };
}

/** Re-judges a judgement at `now`: the rows and level counts in the dashboard's shape. */
export function rejudge(judgement: Judgement, options: { readonly now: Date }): { readonly judgedAt: string; readonly levels: readonly JudgedLevel[]; readonly rows: readonly JudgedRow[] } {
  if (judgement?.format !== JUDGEMENT_FORMAT) throw new Error('unsupported judgement format');
  const rows = judgement.rows.map((row) => judgeRow(row, judgement.head, options.now));
  const levels = judgement.levels.map((level) => ({ ...level, counts: summarizeLevel(rows.filter((row) => row.level === level.id)) }));
  return { judgedAt: options.now.toISOString(), levels, rows };
}

/**
 * A judged row's evidence facts: its as-of time (the oldest result time) and its freshness (the worst of its results). `none` when the row
 * has no evidence. Until the freshness policy (48.2-03) adds ageing, a result is current inside its engine window and out of date past it.
 */
export function rowFreshness(row: Pick<JudgedRow, 'components'>, head: string, now: Date): { readonly asOf?: string; readonly freshness: 'current' | 'out-of-date' | 'none' } {
  const results = row.components.flatMap((component) => component.evidence);
  if (results.length === 0) return { freshness: 'none' };
  const asOf = results.map((result) => result.collectedAt).sort()[0];
  return { ...(asOf ? { asOf } : {}), freshness: results.every((result) => isFresh(result, head, now)) ? 'current' : 'out-of-date' };
}

// ---- The release evidence folder's manifest (D-15) ----

export const EVIDENCE_FORMAT = 'sterling-evidence/1' as const;
export const EVIDENCE_MANIFEST_FILE = 'manifest.json';
/** Where a release's judgement sits inside its evidence folder. */
export const EVIDENCE_JUDGEMENT_FILE = 'bundle/dashboard/judgement.json';

export interface EvidenceManifestFile { readonly path: string; readonly sha256: string; readonly size: number }
export interface EvidenceManifest {
  readonly format: typeof EVIDENCE_FORMAT;
  readonly release: string;
  readonly commit: string;
  readonly builtAt: string;
  /** The software image ID the SBOM and the scan describe. */
  readonly subject: string;
  readonly bundle: 'included' | 'none';
  readonly package: 'included' | 'none';
  readonly files: readonly EvidenceManifestFile[];
}

/** What the caller measured in the folder (everything except manifest.json): each regular file's size and SHA-256, or that it is a link. */
export type MeasuredEvidenceFile = Readonly<{ path: string; size: number; sha256: string }> | Readonly<{ path: string; link: true }>;

export type EvidenceManifestCheck =
  | { readonly ok: true; readonly manifest: EvidenceManifest }
  | { readonly ok: false; readonly reason: 'format' | 'field' | 'path' | 'missing' | 'extra' | 'symlink' | 'size' | 'hash'; readonly file: string };

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks a release evidence manifest against the files the caller measured: the format, every field, and the exact file set with each
 * size and hash. No link, no file outside the list and no list entry without its file. Pure: the caller reads the folder.
 */
export function checkEvidenceManifest(manifest: unknown, files: readonly MeasuredEvidenceFile[]): EvidenceManifestCheck {
  const refuse = (reason: Exclude<EvidenceManifestCheck, { ok: true }>['reason'], file = EVIDENCE_MANIFEST_FILE): EvidenceManifestCheck => ({ ok: false, reason, file });
  if (!isRecord(manifest) || manifest.format !== EVIDENCE_FORMAT) return refuse('format');
  if (typeof manifest.release !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(manifest.release)
    || typeof manifest.commit !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.commit)
    || typeof manifest.builtAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(manifest.builtAt) || Number.isNaN(Date.parse(manifest.builtAt))
    || typeof manifest.subject !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(manifest.subject)
    || (manifest.bundle !== 'included' && manifest.bundle !== 'none')
    || (manifest.package !== 'included' && manifest.package !== 'none')
    || !Array.isArray(manifest.files)) return refuse('field');
  const listed = new Map<string, EvidenceManifestFile>();
  for (const entry of manifest.files as unknown[]) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || !Number.isSafeInteger(entry.size) || (entry.size as number) < 0) return refuse('field');
    if (!SAFE_PATH.test(entry.path) || entry.path === EVIDENCE_MANIFEST_FILE || listed.has(entry.path)) return refuse('path', entry.path);
    listed.set(entry.path, { path: entry.path, sha256: entry.sha256, size: entry.size as number });
  }
  const measured = new Map(files.map((file) => [file.path, file]));
  for (const file of files) {
    if ('link' in file) return refuse('symlink', file.path);
    if (!listed.has(file.path)) return refuse('extra', file.path);
  }
  for (const entry of listed.values()) {
    const file = measured.get(entry.path);
    if (!file || 'link' in file) return refuse('missing', entry.path);
    if (file.size !== entry.size) return refuse('size', entry.path);
    if (file.sha256 !== entry.sha256) return refuse('hash', entry.path);
  }
  if (manifest.bundle === 'included' && !listed.has(EVIDENCE_JUDGEMENT_FILE)) return refuse('missing', EVIDENCE_JUDGEMENT_FILE);
  return { ok: true, manifest: manifest as unknown as EvidenceManifest };
}
