// Builds the dashboard JSON the Accreditation pages read (44-01). Every state in it comes from computeStatus; this file only gathers inputs and
// arranges rows. 44-04 adds the multi-component aggregate and 44-05 adds fields (never renames these).
import { summarizeLevel } from './status.ts';
import { evaluateObservationRule, evaluateTestRule, type RuleContext } from './rules.ts';
import { gapCoversRow, gapStates, type Gap, type Poam } from './gaps.ts';
import { loadRiskAcceptances } from './riskAcceptance.ts';
import { resolveResponsibility, type ResponsibilityTable } from './responsibility.ts';
import { notApplicableFor, removalsFor, type Tailoring } from './tailoring.ts';
import type { ApplicabilityIndex } from './applicability.ts';
import { STATES, type ComponentRow, type DashboardInput, type DashboardRow, type EvidenceRule, type Responsibility, type RuleResult, type State } from './model.ts';
import { fillReason, judgeComponent, judgementRow, judgeRow, JUDGEMENT_FORMAT, type Judgement, type JudgementComponent, type JudgementRow } from './judgement.ts';
export { fillReason } from './judgement.ts';
type LevelNotes = Readonly<{ text?: string; profileDifferences?: readonly string[] }>;

export interface DashboardBuildInput extends DashboardInput {
  readonly testEvidence?: Pick<RuleContext, 'collectedAt' | 'runUrl'>;
  readonly source?: { readonly kind: 'main' | 'scheduled' | 'release' | 'local'; readonly ref: string };
  readonly runUrl?: string;
  readonly controls?: Readonly<Record<string, { readonly label: string; readonly title: string }>>;
  readonly gapRegister?: { readonly gaps: readonly Gap[]; readonly poam: readonly Poam[]; readonly attestationsDir: string };
  readonly responsibilityTable?: ResponsibilityTable;
  readonly tailoring?: Tailoring;
  /** The component applicability map (44.1, D-06 to D-13). Absent, every cell is assessed as before. */
  readonly applicability?: ApplicabilityIndex;
  readonly levels: readonly (DashboardInput['levels'][number] & { readonly kind?: 'level' | 'overlay'; readonly profile?: string; readonly claim?: boolean; readonly overlays?: readonly string[]; readonly notes?: LevelNotes })[];
}
export type DashboardCounts = Readonly<Record<State, number>> & Readonly<{ notMetTotal: number; metTotal: number }>;
export type DashboardComponentRow = ComponentRow & Readonly<{ reasonText: string; statement?: string; limitation?: string; unsettled?: string; requiresOfficialSignature?: boolean; inheritedFrom?: string }>;
export type DashboardOutputRow = DashboardRow & Readonly<{ gap?: string; label: string; family: string; title: string; reasonText: string; components: readonly DashboardComponentRow[] }>;
type MatrixRow = Readonly<{ control: string; component: string; responsibility: Responsibility; weProvide: string; youDo: string }>;
export interface Dashboard { readonly schemaVersion: 1; readonly generatedAt: string; readonly commit: string; readonly source: { readonly kind: 'main' | 'scheduled' | 'release' | 'local'; readonly ref: string }; readonly levels: readonly { readonly id: string; readonly title: string; readonly kind: 'level' | 'overlay'; readonly profile: string; readonly claim: boolean; readonly components: readonly string[]; readonly overlays: readonly string[]; readonly counts: DashboardCounts; readonly notes?: LevelNotes }[]; readonly rows: readonly DashboardOutputRow[]; readonly gaps: readonly unknown[]; readonly collectors: readonly unknown[]; readonly matrix: readonly MatrixRow[]; readonly textIndex: readonly unknown[]; readonly refusedAcceptances: readonly unknown[]; readonly runUrl?: string; }

export const DASHBOARD_SCHEMA_VERSION = 1 as const;

/** Evaluates every rule once: test rules against the report rows, observation rules against the observations. */
function evaluateRules(input: DashboardBuildInput): Record<string, RuleResult> {
  const context: RuleContext = { commit: input.commit, collectedAt: input.generatedAt };
  const testContext: RuleContext = { ...context, ...input.testEvidence };
  const results: Record<string, RuleResult> = {};
  for (const rule of input.rules) {
    results[rule.id] = rule.kind === 'test' ? evaluateTestRule(rule, input.testRows, testContext) : evaluateObservationRule(rule, input.observations, context);
  }
  return results;
}

/** The rules for one component and control, grouped by statement id. */
function rulesFor(rules: readonly EvidenceRule[], component: string, control: string): Record<string, EvidenceRule[]> {
  const grouped: Record<string, EvidenceRule[]> = {};
  for (const rule of rules) {
    if (rule.component !== component || rule.control !== control) continue;
    (grouped[rule.statement] ??= []).push(rule);
  }
  return grouped;
}

function configuredResponsibility(control: string, component: string | undefined, table: ResponsibilityTable | undefined, implemented?: Responsibility): Responsibility {
  if (implemented) return implemented;
  if (table && (Object.hasOwn(table.families, control.split('-')[0]) ||
    table.exceptions.some((entry) => entry.control === control && (entry.component === undefined || entry.component === component)))) {
    return resolveResponsibility(control, component, table).value;
  }
  // A catalogue without a family policy cannot create a claim or assign an obligation.
  return 'product';
}

/** Count rows by state; Stale is intentionally included in the not-met total. */
export function countStates(rows: readonly Pick<DashboardRow, 'state'>[]): DashboardCounts {
  const counts = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<State, number>;
  for (const row of rows) counts[row.state]++;
  return { ...counts, notMetTotal: counts['not-met'] + counts.stale, metTotal: counts.met };
}

/** Builds the dashboard: one row per level and control in scope, each with one component row per component in that level's scope. */
export function buildDashboard(input: DashboardBuildInput): Dashboard {
  return build(input).dashboard;
}

/**
 * Builds the dashboard and, beside it, the judgement its rows were judged from (48.2, D-11): the engine inputs of every row, with no state
 * and no clock, so the rows can be judged again at any time with rejudge (judgement.ts).
 */
export function buildJudgement(input: DashboardBuildInput): { readonly dashboard: Dashboard; readonly judgement: Judgement } {
  return build(input);
}

function build(input: DashboardBuildInput): { readonly dashboard: Dashboard; readonly judgement: Judgement } {
  const results = evaluateRules(input);
  const components = new Map(input.components.map((component) => [component.id, component]));
  const rows: DashboardOutputRow[] = [];
  const judgementRows: JudgementRow[] = [];
  const matrix = new Map<string, MatrixRow>();
  for (const level of input.levels) {
    const removals = new Set(input.tailoring ? removalsFor(input.tailoring, level.id)
      .filter(({ reason, reviewer, reviewedAt }) => reason.trim() && reviewer.trim() && /^\d{4}-\d{2}-\d{2}$/.test(reviewedAt))
      .map(({ control }) => control) : []);
    for (const control of level.controls) {
      if (removals.has(control)) continue;
      const judgementComponents: JudgementComponent[] = [];
      const declaredComponents: boolean[] = [];
      for (const componentId of level.components) {
        const implemented = components.get(componentId)?.implemented.find((requirement) => requirement.control === control);
        const tailoring = input.tailoring && notApplicableFor(input.tailoring, level.id, control, componentId);
        const exception = input.responsibilityTable?.exceptions.some((entry) => entry.control === control && entry.component === componentId);
        // An in-scope component that says nothing about the control is not skipped: it is assessed as "No statement yet" (or its family's
        // reviewed responsibility), so one component's evidence never makes the whole control Met while another in-scope component is silent.
        // A component the control does not apply to needs a reviewed tailoring record, as any other Not applicable does.
        const declared = Boolean(implemented || tailoring || exception);
        const configured = configuredResponsibility(control, componentId, input.responsibilityTable, implemented?.responsibility);
        // A component with an implemented requirement has a part whatever the map says (D-08); only a silent component asks the map.
        const applicability = implemented ? undefined : input.applicability?.for(level.id, control, componentId);
        const statements = implemented?.statements ?? [];
        const rulesByStatement = implemented ? rulesFor(input.rules, componentId, control) : {};
        // The engine inputs go into the judgement (48.2, D-11) and the row is judged from them, so the dashboard and a re-judged judgement
        // run the same code.
        const inputs: JudgementComponent = {
          control, component: componentId, level: level.id, responsibility: configured, statements, rulesByStatement, results,
          ...(tailoring ? { tailoring } : {}), ...(implemented?.inheritedFrom ? { inheritedFrom: implemented.inheritedFrom } : {}),
          ...(applicability ? { applicability } : {}),
        };
        judgementComponents.push(inputs);
        declaredComponents.push(declared);
      }
      const info = input.controls?.[control] ?? { label: control.toUpperCase(), title: control };
      const judgement = judgementRow(
        { level: level.id, control, claim: level.claim !== false, responsibility: configuredResponsibility(control, undefined, input.responsibilityTable), components: judgementComponents },
        { label: info.label, family: control.split('-')[0], title: info.title });
      judgementRows.push(judgement);
      const row = judgeRow(judgement, input.head, input.now);
      rows.push(row);
      for (const [index, component] of row.components.entries()) {
        const { responsibility, statements } = judgementComponents[index]!;
        if (declaredComponents[index] && level.claim !== false && component.state !== 'not-applicable' &&
          (responsibility === 'shared' || responsibility === 'your-organization' || responsibility === 'inherited')) {
          matrix.set(`${control}:${component.component}`, {
            control,
            component: component.component,
            responsibility,
            weProvide: [...new Set(statements.map(({ description }) => description).filter(Boolean))].join('\n'),
            youDo: [...new Set(statements.flatMap(({ yourOrganizationDoes }) => yourOrganizationDoes ? [yourOrganizationDoes] : []))].join('\n'),
          });
        }
      }
    }
  }
  const levels = input.levels.map((level) => ({
    id: level.id, title: level.title, kind: level.kind ?? 'level', profile: level.profile ?? '', claim: level.claim ?? false,
    components: level.components, overlays: level.overlays ?? [], counts: summarizeLevel(rows.filter((row) => row.level === level.id)),
    ...(level.notes ? { notes: level.notes } : {}),
  }));
  const register = input.gapRegister;
  const gaps = [];
  const refusedAcceptances = [];
  const gapByRow = new Map<DashboardOutputRow, string>();
  if (register) {
    const { verified, refused } = loadRiskAcceptances(register.attestationsDir, input.now);
    for (const refusal of refused) refusedAcceptances.push({ file: refusal.file, reason: refusal.message });
    const states = gapStates({ ...register, rows, acceptances: verified, now: input.now });
    for (const [index, gap] of register.gaps.entries()) {
      const state = states[index];
      const { id, controls, remediation, ownerRole, poam } = gap;
      const affected = rows.filter((row) => gapCoversRow(gap, row));
      for (const row of affected) if (!gapByRow.has(row)) gapByRow.set(row, id);
      const unresolved = affected.filter((row) => row.state !== 'met' && row.state !== 'not-applicable');
      const milestones = register.poam.find((item) => item.id === poam)?.milestones;
      gaps.push({ ...state, title: gap.title ?? id, controls, remediation, ownerRole, levelsBlocked: new Set(unresolved.map((row) => row.level)).size,
        ...(state.acceptedUntil ? { acceptedUntil: state.acceptedUntil.slice(0, 10) } : {}),
        ...(poam ? { poam } : {}), ...(milestones ? { milestones } : {}), ...(gap.profiles ? { profiles: gap.profiles } : {}) });
    }
  }
  const linkedRows = rows.map((row) => {
    const gap = gapByRow.get(row);
    return gap ? { ...row, gap } : row;
  });
  const linkedJudgementRows = judgementRows.map((row, index) => {
    const gap = gapByRow.get(rows[index]!);
    return gap ? { ...row, gap } : row;
  });
  const dashboard: Dashboard = { schemaVersion: DASHBOARD_SCHEMA_VERSION, generatedAt: input.generatedAt, commit: input.commit, ...(input.runUrl ? { runUrl: input.runUrl } : {}), source: input.source ?? { kind: 'local', ref: input.head }, levels, rows: linkedRows, gaps, collectors: [], matrix: [...matrix.values()], textIndex: [], refusedAcceptances };
  const judgement: Judgement = {
    format: JUDGEMENT_FORMAT, generatedAt: input.generatedAt, commit: input.commit, head: input.head,
    levels: levels.map(({ counts: _counts, ...level }) => level), rows: linkedJudgementRows,
  };
  return { dashboard, judgement };
}
