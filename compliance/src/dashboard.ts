// Builds the dashboard JSON the Accreditation pages read (44-01). Every state in it comes from computeStatus; this file only gathers inputs and
// arranges rows. 44-04 adds the multi-component aggregate and 44-05 adds fields (never renames these).
import { computeStatus } from './status.ts';
import { evaluateObservationRule, evaluateTestRule, type RuleContext } from './rules.ts';
import { REASONS, STATES, type ComponentRow, type Dashboard, type DashboardBuildInput, type DashboardCounts, type DashboardRow, type EvidenceRule, type RuleResult, type State } from './model.ts';
export type { DashboardBuildInput } from './model.ts';

export const DASHBOARD_SCHEMA_VERSION = 1 as const;

/** Worst first. Used only to pick a control row's state when several components disagree, until 44-04's aggregate replaces it. */
const STATE_RANK: Readonly<Record<State, number>> = Object.freeze({
  'not-met': 0,
  'stale': 1,
  'partly-met': 2,
  'your-organizations-responsibility': 3,
  'not-applicable': 4,
  'met': 5
});

/** Evaluates every rule once: test rules against the report rows, observation rules against the observations. */
function evaluateRules(input: DashboardBuildInput): Record<string, RuleResult> {
  const context: RuleContext = { commit: input.commit, collectedAt: input.generatedAt };
  const results: Record<string, RuleResult> = {};
  for (const rule of input.rules) {
    results[rule.id] = rule.kind === 'test' ? evaluateTestRule(rule, input.testRows, context) : evaluateObservationRule(rule, input.observations, context);
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

/**
 * The control row's state from its component rows: one component gives its own state; several give the worst of them (44-04's aggregate replaces
 * this); none gives what computeStatus says of a control with no statement, so even that state comes from the status engine.
 */
function controlState(components: readonly ComponentRow[], level: string, control: string, input: DashboardBuildInput): Pick<DashboardRow, 'state' | 'reason' | 'detail'> {
  if (components.length === 0) {
    const outcome = computeStatus({ control, component: '', level, responsibility: 'product', statements: [], rulesByStatement: {}, results: {}, head: input.head, now: input.now });
    return { state: outcome.state, reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) };
  }
  let worst = components[0];
  for (const row of components) if (STATE_RANK[row.state] < STATE_RANK[worst.state]) worst = row;
  return { state: worst.state, reason: worst.reason, ...(worst.detail ? { detail: worst.detail } : {}) };
}

/** Builds the dashboard: one row per level and control in scope, each with one component row per component that implements the control. */
/** Count rows by state; Stale is intentionally included in the not-met total. */
export function countStates(rows: readonly Pick<DashboardRow, 'state'>[]): DashboardCounts {
  const counts = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<State, number>;
  for (const row of rows) counts[row.state]++;
  return { ...counts, notMetTotal: counts['not-met'] + counts.stale, metTotal: counts.met };
}

/** Fill the safe, local reason template; absent values become plain empty text rather than template braces. */
export function fillReason(reason: keyof typeof REASONS, detail?: Readonly<Record<string, string>>): string {
  return REASONS[reason].replace(/\{(date|reason|text|question|provider)\}/g, (_match, key: string) => detail?.[key] ?? '');
}

export function buildDashboard(input: DashboardBuildInput): Dashboard {
  const results = evaluateRules(input);
  const components = new Map(input.components.map((component) => [component.id, component]));
  const rows: DashboardRow[] = [];
  for (const level of input.levels) {
    for (const control of level.controls) {
      const componentRows: ComponentRow[] = [];
      for (const componentId of level.components) {
        const implemented = components.get(componentId)?.implemented.find((requirement) => requirement.control === control);
        if (!implemented) continue;
        const rulesByStatement = rulesFor(input.rules, componentId, control);
        const outcome = computeStatus({
          control,
          component: componentId,
          level: level.id,
          responsibility: implemented.responsibility,
          statements: implemented.statements,
          rulesByStatement,
          results,
          head: input.head,
          now: input.now
        });
        const evidence = Object.values(rulesByStatement).flat().map((rule) => results[rule.id]).filter((result): result is RuleResult => result !== undefined);
        const component = {
          component: componentId,
          state: outcome.state,
          reason: outcome.reason,
          ...(outcome.detail ? { detail: outcome.detail } : {}),
          reasonText: fillReason(outcome.reason, outcome.reason === 'inherited' ? { ...(outcome.detail ?? {}), provider: implemented.inheritedFrom ?? '' } : outcome.detail),
          responsibility: implemented.responsibility,
          evidence,
          ...(implemented.statements[0] ? { statement: implemented.statements[0].description } : {}),
          ...(implemented.statements[0]?.limitation ? { limitation: implemented.statements[0].limitation } : {}),
          ...(implemented.statements[0]?.unsettled ? { unsettled: implemented.statements[0].unsettled } : {}),
          ...(implemented.statements[0]?.requiresOfficialSignature ? { requiresOfficialSignature: true } : {}),
          ...(implemented.inheritedFrom ? { inheritedFrom: implemented.inheritedFrom } : {})
        } as ComponentRow;
        componentRows.push(component);
      }
      const outcome = controlState(componentRows, level.id, control, input);
      const info = input.controls?.[control] ?? { label: control.toUpperCase(), title: control };
      rows.push({ level: level.id, control, label: info.label, family: control.split('-')[0], title: info.title, ...outcome, reasonText: fillReason(outcome.reason, outcome.detail), components: componentRows });
    }
  }
  const levels = input.levels.map((level) => ({
    id: level.id, title: level.title, kind: level.kind ?? 'level', profile: level.profile ?? '', claim: level.claim ?? false,
    components: level.components, overlays: level.overlays ?? [], counts: countStates(rows.filter((row) => row.level === level.id))
  }));
  return { schemaVersion: DASHBOARD_SCHEMA_VERSION, generatedAt: input.generatedAt, commit: input.commit, ...(input.runUrl ? { runUrl: input.runUrl } : {}), source: input.source ?? { kind: 'local', ref: input.head }, levels, rows, gaps: [], collectors: [], matrix: [], textIndex: [], refusedAcceptances: [] };
}
