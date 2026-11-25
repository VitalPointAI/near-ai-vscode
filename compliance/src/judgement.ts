// The judgement (48.2, D-11): the status engine's inputs for every level, control and component, with their presentation fields, and never a
// state or a clock. rejudge re-runs the one engine (computeStatus, aggregateControl, the one row rule and the REASONS texts) at any time, so
// a release's evidence is judged against the current time wherever it is shown. The dashboard builds its rows through the same functions
// (dashboard.ts), so the dashboard and a re-judged judgement can never apply different rules.
// The evidence folder's manifest (D-15, `sterling-evidence/1`) is defined here once, for the release evidence writer (48.2-05) and the
// session (the workbench backend) alike. 48.2-03 adds freshness, the site policy that only tightens, the honest clock and layering.
// This file imports only status.ts, rules.ts and model.ts, never a loader or a validator: the workbench bundles it (engine/compliance.cjs).
import { aggregateControl, computeStatus, FUTURE_TOLERANCE_MS, isFresh, summarizeLevel } from './status.ts';
import { evaluateObservationRule } from './rules.ts';
import { AGEING, FRESHNESS, REASONS, type ComponentRow, type DashboardRow, type FreshnessWindows, type Observation, type Responsibility, type RuleResult, type StatusInput, type WindowKind } from './model.ts';

export const JUDGEMENT_FORMAT = 'sterling-judgement/1' as const;

/** One component's engine inputs: a StatusInput without the clock and the judged commit (both given when judged). */
export type JudgementComponent = Omit<StatusInput, 'now' | 'head'> & {
  /** Presentation: the provider an inherited control comes from, filled into the reason text. */
  readonly inheritedFrom?: string;
  /** Presentation: the rule ids in the order the component's evidence is listed, which JSON key order may not keep. */
  readonly evidenceOrder?: readonly string[];
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
export type JudgedRow = Omit<DashboardRow, 'components'> & JudgementRowPresentation & Readonly<{ reasonText: string; components: readonly JudgedComponent[] }>;
export type JudgedLevel = JudgementLevel & Readonly<{ counts: ReturnType<typeof summarizeLevel> }>;

/** A result's freshness (D-12): Current, Ageing, Out of date (exactly the engine's Stale), or Unknown when the clock cannot be trusted. */
export type Freshness = 'current' | 'ageing' | 'out-of-date' | 'unknown';
/** A row's freshness: the worst of its results, or `none` when it has no evidence. */
export type RowFreshness = Freshness | 'none';
export type AgeingThresholds = Readonly<Partial<Record<WindowKind, number>>>;
/** Where a result comes from (D-24): the release, your site, or the supplier's reference site (a release result on a site-only collector). */
export type EvidenceSource = 'release' | 'site' | 'reference-site';
/** A result as re-judged: with its freshness and its source. */
export type FreshResult = RuleResult & Readonly<{ freshness: Freshness; source: EvidenceSource }>;
/** Collectors whose facts are about a site: a release carries them only from the supplier's reference site. */
export const SITE_COLLECTORS: ReadonlySet<string> = new Set(['deployment', 'site-live', 'site-agreements']);
/** A row as re-judged: the dashboard's row, each result with its freshness, the row's worst freshness and its oldest result time. */
export type FreshRow = Omit<JudgedRow, 'components'> & Readonly<{
  components: readonly (Omit<JudgedComponent, 'evidence'> & Readonly<{ evidence: readonly FreshResult[] }>)[];
  freshness: RowFreshness;
  asOf?: string;
}>;

const FRESHNESS_RANK: Readonly<Record<RowFreshness, number>> = { none: -1, current: 0, ageing: 1, 'out-of-date': 2, unknown: 3 };

/**
 * One result's freshness: Out of date exactly when the status engine's isFresh says it is not fresh (so Out of date and Stale can never
 * disagree); otherwise Ageing past its kind's ageing threshold and Current before it. `head` evidence has no ageing: it is current while it
 * is about the commit being judged. `unknown` only when the caller says the clock cannot be trusted (the clock case, 48.2-03 Task 2).
 */
export function freshnessOf(result: RuleResult, options: { readonly head: string; readonly now: Date; readonly windows?: FreshnessWindows; readonly ageing?: AgeingThresholds; readonly clockUnknown?: boolean }): Freshness {
  if (options.clockUnknown) return 'unknown';
  const windows = options.windows ?? FRESHNESS;
  if (!isFresh(result, options.head, options.now, windows)) return 'out-of-date';
  const ageing: AgeingThresholds = options.ageing ?? AGEING;
  const after = Object.hasOwn(ageing, result.window) ? ageing[result.window] : undefined;
  if (after === undefined || windows[result.window] === 'head') return 'current';
  return options.now.getTime() - Date.parse(result.collectedAt) > after ? 'ageing' : 'current';
}

/** A judged row with each result's freshness, the row's worst freshness and the oldest result time. */
function withFreshness(row: JudgedRow, sources: ReadonlyMap<string, EvidenceSource>, options: Parameters<typeof freshnessOf>[1]): FreshRow {
  let worst: RowFreshness = 'none';
  let asOf: string | undefined;
  const components = row.components.map((component) => ({
    ...component,
    evidence: component.evidence.map((result) => {
      const freshness = freshnessOf(result, options);
      if (FRESHNESS_RANK[freshness] > FRESHNESS_RANK[worst]) worst = freshness;
      if (asOf === undefined || result.collectedAt < asOf) asOf = result.collectedAt;
      return { ...result, freshness, source: sources.get(result.rule) ?? 'release' };
    }),
  }));
  return { ...row, components, freshness: worst, ...(asOf !== undefined ? { asOf } : {}) };
}

/** Fill the safe, local reason template; absent values become plain empty text rather than template braces. */
export function fillReason(reason: keyof typeof REASONS, detail?: Readonly<Record<string, string>>): string {
  return REASONS[reason].replace(/\{(date|reason|text|question|provider)\}/g, (_match, key: string) => detail?.[key] ?? '');
}

const ruleOrder = (component: Pick<JudgementComponent, 'rulesByStatement'>): string[] => Object.values(component.rulesByStatement).flat().map((rule) => rule.id);

/** The results a component's rules name, in rule order: the component's evidence. */
function evidenceOf(component: JudgementComponent): RuleResult[] {
  return (component.evidenceOrder ?? ruleOrder(component)).map((id) => Object.hasOwn(component.results, id) ? component.results[id] : undefined)
    .filter((result): result is RuleResult => result !== undefined);
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
    evidenceOrder: component.evidenceOrder ?? ruleOrder(component),
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
export function judgeComponent(component: JudgementComponent, head: string, now: Date, windows?: FreshnessWindows): JudgedComponent {
  const { inheritedFrom, evidenceOrder: _order, ...input } = component;
  const outcome = computeStatus({ ...input, head, now, ...(windows ? { windows } : {}) });
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
export function judgeRow(row: JudgementRow, head: string, now: Date, windows?: FreshnessWindows): JudgedRow {
  const components = row.components.map((component) => judgeComponent(component, head, now, windows));
  const outcome = controlState(components, row, head, now);
  return {
    level: row.level, control: row.control, label: row.label, family: row.family, title: row.title,
    ...outcome, reasonText: fillReason(outcome.reason, outcome.detail), components,
    ...(row.gap ? { gap: row.gap } : {}),
    ...(row.textFile ? { textFile: row.textFile } : {}),
  };
}

/** A site freshness policy (D-13): per kind, hours after which evidence is Ageing and Out of date. It may only tighten the release defaults. */
export type FreshnessPolicy = Readonly<Partial<Record<Exclude<WindowKind, 'head'>, Readonly<{ ageingAfterHours?: number; outOfDateAfterHours?: number }>>>>;
export interface EffectivePolicy {
  readonly windows: Readonly<Record<WindowKind, number | 'head'>>;
  readonly ageing: Readonly<Record<Exclude<WindowKind, 'head'>, number>>;
  /** `<kind>.<setting>` for each value looser than the release default, which was kept instead. */
  readonly clamped: readonly string[];
  /** Why the whole policy was refused (the release defaults apply), when it was. */
  readonly refused?: string;
}

const HOUR_MS = 60 * 60 * 1000;
const POLICY_SETTINGS = new Set(['ageingAfterHours', 'outOfDateAfterHours']);

/**
 * The windows and ageing thresholds in force (D-13): the release defaults, tightened by the site policy. A value looser than the default is
 * clamped to it and reported; an unknown kind or setting, a value that is not a positive whole number of hours, or ageing at or after out of
 * date refuses the whole policy, so the release defaults apply and the refusal is reported. Ageing never comes after out of date.
 */
export function effectivePolicy(policy?: unknown): EffectivePolicy {
  const windows: Record<string, number | 'head'> = { ...FRESHNESS };
  const ageing: Record<string, number> = { ...AGEING };
  const defaults = (refused: string): EffectivePolicy => ({ windows: { ...FRESHNESS }, ageing: { ...AGEING }, clamped: [], refused });
  if (policy === undefined || policy === null) return { windows: windows as EffectivePolicy['windows'], ageing: ageing as EffectivePolicy['ageing'], clamped: [] };
  if (!isRecord(policy)) return defaults('the freshness policy is not an object');
  const clamped: string[] = [];
  for (const [kind, entry] of Object.entries(policy)) {
    if (!Object.hasOwn(AGEING, kind)) return defaults(`unknown evidence kind ${kind}`);
    if (!isRecord(entry) || Object.keys(entry).some((key) => !POLICY_SETTINGS.has(key))) return defaults(`unknown setting for ${kind}`);
    for (const value of Object.values(entry)) if (!Number.isSafeInteger(value) || (value as number) < 1) return defaults(`${kind} needs a positive whole number of hours`);
    const { ageingAfterHours: soon, outOfDateAfterHours: late } = entry as { ageingAfterHours?: number; outOfDateAfterHours?: number };
    if (soon !== undefined && late !== undefined && soon >= late) return defaults(`${kind} ages at or after it is out of date`);
    const key = kind as Exclude<WindowKind, 'head'>;
    if (late !== undefined) { if (late * HOUR_MS > FRESHNESS[key]) clamped.push(`${kind}.outOfDateAfterHours`); else windows[key] = late * HOUR_MS; }
    if (soon !== undefined) { if (soon * HOUR_MS > AGEING[key]) clamped.push(`${kind}.ageingAfterHours`); else ageing[key] = soon * HOUR_MS; }
    ageing[key] = Math.min(ageing[key]!, windows[key] as number);
  }
  return { windows: windows as EffectivePolicy['windows'], ageing: ageing as EffectivePolicy['ageing'], clamped };
}

/** Evidence the engine did not use because it is dated more than FUTURE_TOLERANCE_MS after the session clock (D-14, D-18). */
export type RefusedEvidence =
  | { readonly kind: 'result'; readonly rule: string; readonly reason: 'future-dated'; readonly at: string }
  | { readonly kind: 'observation'; readonly collector: string; readonly subject: string; readonly reason: 'future-dated'; readonly at: string };

export interface RejudgeOptions {
  readonly now: Date;
  /** Verified site observations (D-24): each replaces the release's result for the rules on its collector and subject when it is newer. */
  readonly observations?: readonly Observation[];
  /** The site's freshness policy, from the verified site trust document (D-13, D-17). */
  readonly policy?: unknown;
  /** The release build time; the judgement's generatedAt when absent. A clock earlier than it is the clock case (D-14). */
  readonly builtAt?: string;
}

export interface Rejudged {
  readonly judgedAt: string;
  readonly levels: readonly JudgedLevel[];
  readonly rows: readonly FreshRow[];
  readonly refused: readonly RefusedEvidence[];
  readonly policy: Readonly<{ clamped: readonly string[]; refused?: string }>;
  /** Present when the session clock is earlier than the release build: every freshness is Unknown and nothing is Met. */
  readonly clock?: 'clock-behind-build';
}

const isFuture = (at: string, now: Date): boolean => Date.parse(at) - now.getTime() > FUTURE_TOLERANCE_MS;

/**
 * Re-judges a judgement at `now` (D-11 to D-14, D-24): the rows and level counts in the dashboard's shape, each result with its freshness and
 * its source, each row with the worst freshness of its results and its oldest result time.
 * - The windows are the release defaults tightened by the site policy, passed to the status engine, so Out of date and Stale agree.
 * - A clock earlier than the release build is the clock case: every row is shown, every freshness is Unknown and no result counts as fresh,
 *   so nothing is Met. It is never a refusal.
 * - Otherwise a result or an observation dated more than five minutes ahead is refused (did not verify) and not used; its rule has no result.
 * - A site observation with a rule's collector and subject, newer than the release's result, replaces it, with source `site`.
 * The judgement itself is never changed.
 */
export function rejudge(judgement: Judgement, options: RejudgeOptions): Rejudged {
  if (judgement?.format !== JUDGEMENT_FORMAT) throw new Error('unsupported judgement format');
  const { now } = options;
  const effective = effectivePolicy(options.policy);
  const clockBehind = isFuture(options.builtAt ?? judgement.generatedAt, now);
  const refused: RefusedEvidence[] = [];
  const refusedRules = new Set<string>();
  const refusedObservations: RefusedEvidence[] = [];
  const observations: Observation[] = [];
  for (const observation of options.observations ?? []) {
    if (isFuture(observation.collectedAt, now)) refusedObservations.push({ kind: 'observation', collector: observation.collector, subject: observation.subject, reason: 'future-dated', at: observation.collectedAt });
    else observations.push(observation);
  }
  const context = { commit: judgement.commit, collectedAt: judgement.generatedAt };
  const windows: FreshnessWindows = clockBehind ? {} : effective.windows;
  const rows = judgement.rows.map((row) => {
    const sources = new Map<string, EvidenceSource>();
    const components = row.components.map((component) => {
      const results: Record<string, RuleResult> = { ...component.results };
      for (const rule of Object.values(component.rulesByStatement).flat()) {
        const collector = rule.kind === 'observation' ? rule.observation?.collector : undefined;
        sources.set(rule.id, collector && SITE_COLLECTORS.has(collector) ? 'reference-site' : 'release');
        const release = Object.hasOwn(results, rule.id) ? results[rule.id] : undefined;
        if (release && !clockBehind && isFuture(release.collectedAt, now)) {
          if (!refusedRules.has(rule.id)) { refusedRules.add(rule.id); refused.push({ kind: 'result', rule: rule.id, reason: 'future-dated', at: release.collectedAt }); }
          delete results[rule.id];
        }
        const target = rule.kind === 'observation' ? rule.observation : undefined;
        const matching = target ? observations.filter((item) => item.collector === target.collector && item.subject === target.subject) : [];
        if (matching.length === 0) continue;
        const site = evaluateObservationRule(rule, matching, context);
        const kept = Object.hasOwn(results, rule.id) ? results[rule.id] : undefined;
        if (!kept || kept.reason === 'missing-result' || Date.parse(site.collectedAt) > Date.parse(kept.collectedAt)) {
          results[rule.id] = site;
          sources.set(rule.id, 'site');
        }
      }
      return { ...component, results };
    });
    const judged = judgeRow({ ...row, components }, judgement.head, now, windows);
    return withFreshness(judged, sources, { head: judgement.head, now, windows: effective.windows, ageing: effective.ageing, clockUnknown: clockBehind });
  });
  const levels = judgement.levels.map((level) => ({ ...level, counts: summarizeLevel(rows.filter((row) => row.level === level.id)) }));
  return {
    judgedAt: now.toISOString(), levels, rows, refused: [...refused, ...refusedObservations],
    policy: { clamped: effective.clamped, ...(effective.refused ? { refused: effective.refused } : {}) },
    ...(clockBehind ? { clock: 'clock-behind-build' as const } : {}),
  };
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
