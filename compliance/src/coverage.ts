// The coverage measure CI tracks (44.1-07, D-05, D-19, D-21). From sources only (statements, the applicability map with its reviews, levels and
// profiles) it counts, per level the map covers and per component: applicable cells with a statement, applicable cells without one, Not applicable
// (signed), Not applicable awaiting sign-off, and your organization's (family). One baseline file per component holds the two counts the ratchet
// enforces; a rise in either fails, and so does a fall the baseline was not lowered with. Evidence results are never part of the ratchet: the
// per-state counts of a bundle are reported only (Phase 44 D-07).
import { mapLevels, statementsOutsideMap, type ApplicabilityIndex, type MapLevel } from './applicability.ts';
import { statementsWithoutAcceptableRule, type StatementWithoutAcceptableRule } from './rules.ts';
import { STATES, STATE_WORDS, type ComponentInput, type EvidenceRule, type State } from './model.ts';
import type { ResponsibilityTable } from './responsibility.ts';

export const COVERAGE_CLASSES = Object.freeze(['applicableWithStatement', 'applicableWithoutStatement', 'notApplicableSigned', 'notApplicableAwaitingSignOff', 'yourOrganization'] as const);
export type CoverageClass = (typeof COVERAGE_CLASSES)[number];
export type CoverageCounts = Record<CoverageClass, number>;

/** What the measure reads; the bundle input loader (commands/bundle.ts loadDashboardSources) provides all of it. */
export interface CoverageSources {
  readonly levels: readonly MapLevel[];
  readonly components: readonly ComponentInput[];
  readonly rules: readonly EvidenceRule[];
  readonly responsibilityTable: ResponsibilityTable;
  readonly applicability?: ApplicabilityIndex;
}

export interface CoverageReport {
  /** Level id to component id to counts, for the levels the map covers. */
  readonly byLevel: Readonly<Record<string, Readonly<Record<string, CoverageCounts>>>>;
  /** Component id to counts over every level the map covers; every component definition has an entry. */
  readonly totals: Readonly<Record<string, CoverageCounts>>;
  readonly unacceptable: readonly StatementWithoutAcceptableRule[];
  readonly outside: ReturnType<typeof statementsOutsideMap>;
}

/** compliance/coverage/<component>.json. */
export interface CoverageBaseline {
  readonly component: string;
  readonly applicableWithoutStatement: number;
  readonly notApplicableAwaitingSignOff: number;
}

const zero = (): CoverageCounts => ({ applicableWithStatement: 0, applicableWithoutStatement: 0, notApplicableSigned: 0, notApplicableAwaitingSignOff: 0, yourOrganization: 0 });

function stated(component: ComponentInput | undefined, control: string): boolean {
  return component?.implemented.some((requirement) => requirement.control === control && requirement.statements.length > 0) ?? false;
}

/** The responsibility a silent cell takes, as the dashboard gives it (a family or whole-control exception, else product). */
function silentResponsibility(control: string, component: string, table: ResponsibilityTable): string {
  const exception = table.exceptions.find((entry) => entry.control === control && (entry.component === undefined || entry.component === component));
  if (exception) return exception.responsibility;
  const family = control.split('-')[0];
  return Object.hasOwn(table.families, family) ? table.families[family].responsibility : 'product';
}

/** The class of one cell, as the dashboard would assess it from sources (D-08: a statement gives a part whatever the map says). */
export function cellClass(sources: CoverageSources, level: string, control: string, componentId: string): CoverageClass {
  const component = sources.components.find((entry) => entry.id === componentId);
  if (stated(component, control)) return 'applicableWithStatement';
  const responsibility = silentResponsibility(control, componentId, sources.responsibilityTable);
  if (responsibility !== 'product' && responsibility !== 'shared') return 'yourOrganization';
  const record = sources.applicability?.for(level, control, componentId);
  if (record?.class === 'not-applicable') return record.reviewed ? 'notApplicableSigned' : 'notApplicableAwaitingSignOff';
  return 'applicableWithoutStatement';
}

export function countCoverage(sources: CoverageSources): CoverageReport {
  const byLevel: Record<string, Record<string, CoverageCounts>> = {};
  const totals: Record<string, CoverageCounts> = Object.fromEntries(sources.components.map((component) => [component.id, zero()]));
  for (const level of mapLevels(sources.levels)) {
    const counts: Record<string, CoverageCounts> = {};
    for (const componentId of level.components) {
      const own = (counts[componentId] ??= zero());
      const total = (totals[componentId] ??= zero());
      for (const control of new Set(level.controls)) {
        const cls = cellClass(sources, level.id, control, componentId);
        own[cls]++;
        total[cls]++;
      }
    }
    byLevel[level.id] = counts;
  }
  const rules = sources.applicability?.rules;
  return {
    byLevel,
    totals,
    unacceptable: statementsWithoutAcceptableRule(sources.components, sources.rules, sources.levels),
    outside: rules ? statementsOutsideMap({ levels: sources.levels, components: sources.components, responsibilityTable: sources.responsibilityTable, rules }) : []
  };
}

/** The baselines a report would write: one per component, sorted. */
export function baselinesFrom(report: CoverageReport): Map<string, CoverageBaseline> {
  return new Map(Object.keys(report.totals).sort().map((component) => [component, {
    component,
    applicableWithoutStatement: report.totals[component].applicableWithoutStatement,
    notApplicableAwaitingSignOff: report.totals[component].notApplicableAwaitingSignOff
  }]));
}

const RATCHETED: readonly [keyof Omit<CoverageBaseline, 'component'>, string][] = [
  ['applicableWithoutStatement', 'applicable cells without a statement'],
  ['notApplicableAwaitingSignOff', 'Not applicable cells awaiting sign-off']
];

/** The ratchet: a rise fails; a fall fails until the baseline is lowered with it (coverage --write). */
export function checkBaseline(report: CoverageReport, baselines: ReadonlyMap<string, CoverageBaseline>): string[] {
  const problems: string[] = [];
  for (const component of Object.keys(report.totals).sort()) {
    const baseline = baselines.get(component);
    if (!baseline) { problems.push(`${component}: no baseline file compliance/coverage/${component}.json; run coverage --write`); continue; }
    for (const [key, words] of RATCHETED) {
      const now = report.totals[component][key];
      const was = baseline[key];
      if (now > was) problems.push(`${component}: ${words} rose from ${was} to ${now}`);
      if (now < was) problems.push(`${component}: ${words} fell from ${was} to ${now}; lower the baseline with coverage --write`);
    }
  }
  for (const component of [...baselines.keys()].sort()) if (!Object.hasOwn(report.totals, component)) problems.push(`${component}: a baseline for a component that does not exist`);
  return problems;
}

/** Everything coverage --check refuses: the ratchet, a statement without an acceptable rule (D-18), and applicability drift (D-10). */
export function checkCoverage(report: CoverageReport, baselines: ReadonlyMap<string, CoverageBaseline>, applicabilityProblems: readonly string[]): string[] {
  return [
    ...checkBaseline(report, baselines),
    ...report.unacceptable.filter((entry) => !entry.exempt).map((entry) => `${entry.component} ${entry.control} ${entry.statement}: ${entry.reason}`),
    ...applicabilityProblems.map((problem) => `applicability: ${problem}`)
  ];
}

/** A component's applicable pairs without a statement, Unclassified controls first (D-21), each with the levels it appears in. */
export function workList(sources: CoverageSources, component: string): { readonly control: string; readonly levels: readonly string[] }[] {
  const pairs = new Map<string, string[]>();
  for (const level of mapLevels(sources.levels)) {
    if (!level.components.includes(component)) continue;
    for (const control of new Set(level.controls)) if (cellClass(sources, level.id, control, component) === 'applicableWithoutStatement') pairs.set(control, [...(pairs.get(control) ?? []), level.id]);
  }
  const first = (levels: readonly string[]) => levels.includes('unclassified') ? 0 : 1;
  return [...pairs].map(([control, levels]) => ({ control, levels })).sort((a, b) => first(a.levels) - first(b.levels) || a.control.localeCompare(b.control));
}

type DashboardLike = { readonly rows: readonly { readonly components: readonly { readonly component: string; readonly state: string }[] }[] };

function stateCounts(dashboard: DashboardLike): Map<string, Record<State, number>> {
  const counts = new Map<string, Record<State, number>>();
  for (const row of dashboard.rows) for (const cell of row.components) {
    const entry = counts.get(cell.component) ?? (Object.fromEntries(STATES.map((state) => [state, 0])) as Record<State, number>);
    if ((STATES as readonly string[]).includes(cell.state)) entry[cell.state as State]++;
    counts.set(cell.component, entry);
  }
  return counts;
}

/** A Markdown table of cell counts per state and component from a bundle's dashboard, with the change from the previous bundle when given. */
export function summaryTable(dashboard: DashboardLike, previous?: DashboardLike): string {
  const now = stateCounts(dashboard);
  const before = previous ? stateCounts(previous) : undefined;
  const lines = ['### Compliance coverage per component', '', previous ? 'Cell counts per state, with the change since the previous main bundle.' : 'No previous bundle: counts are shown without a change.', '',
    `| Component | ${STATES.map((state) => STATE_WORDS[state]).join(' | ')} |`, `|---|${STATES.map(() => '---').join('|')}|`];
  for (const component of [...new Set([...now.keys(), ...(before?.keys() ?? [])])].sort()) {
    const cells = STATES.map((state) => {
      const value = now.get(component)?.[state] ?? 0;
      if (!before) return String(value);
      const delta = value - (before.get(component)?.[state] ?? 0);
      return value === 0 && delta === 0 ? '0' : `${value} (${delta > 0 ? '+' : ''}${delta})`;
    });
    lines.push(`| ${component} | ${cells.join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

/** A plain report of the counts per level and component, then the totals and the statements needing attention. */
export function reportText(report: CoverageReport): string {
  const head = `| Level | Component | ${COVERAGE_CLASSES.join(' | ')} |`;
  const lines = ['# Compliance coverage (sources only)', '', head, `|---|---|${COVERAGE_CLASSES.map(() => '---').join('|')}|`];
  for (const [level, components] of Object.entries(report.byLevel)) for (const [component, counts] of Object.entries(components)) lines.push(`| ${level} | ${component} | ${COVERAGE_CLASSES.map((cls) => counts[cls]).join(' | ')} |`);
  lines.push('', '## Totals over the levels the map covers', '', `| Component | ${COVERAGE_CLASSES.join(' | ')} |`, `|---|${COVERAGE_CLASSES.map(() => '---').join('|')}|`);
  for (const [component, counts] of Object.entries(report.totals).sort(([a], [b]) => a.localeCompare(b))) lines.push(`| ${component} | ${COVERAGE_CLASSES.map((cls) => counts[cls]).join(' | ')} |`);
  lines.push('', `Statements without an acceptable rule: ${report.unacceptable.filter((entry) => !entry.exempt).length} (exempt: ${report.unacceptable.filter((entry) => entry.exempt).length}). Statements outside the map: ${report.outside.length}.`);
  return `${lines.join('\n')}\n`;
}

