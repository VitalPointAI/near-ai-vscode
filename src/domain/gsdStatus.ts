export interface GsdStatusSnapshot {
  projectPercent: number | null;
  currentPhase: number | null;
  totalPhases: number | null;
  currentPlan: number | null;
  totalPlans: number | null;
  state: string;
  activeAgents: number;
  estimatedCostUsd?: number;
  budgetRemainingUsd?: number;
}

export interface GsdPlanningState {
  state: string;
  currentPhase: number | null;
  totalPhases: number | null;
  currentPlan: number | null;
  totalPlans: number | null;
  completedPhases: number | null;
  projectPercent: number | null;
  activeAgents: number;
  estimatedCostUsd?: number;
  budgetRemainingUsd?: number;
}

function numberFrom(source: string, pattern: RegExp): number | null {
  const value = source.match(pattern)?.[1];
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function moneyFrom(source: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const value = numberFrom(source, pattern);
    if (value !== null) return value;
  }
  return undefined;
}

/** Parse only non-sensitive planning metadata; prompts and file contents are ignored. */
export function parseGsdPlanningState(state: string, roadmap = ''): GsdPlanningState {
  const completedPhases = numberFrom(state, /^\s*completed_phases:\s*(\d+)\s*$/m);
  const totalPhases = numberFrom(state, /^\s*total_phases:\s*(\d+)\s*$/m)
    ?? ((roadmap.match(/^### Phase /gm) ?? []).length || null);
  const explicitPercent = numberFrom(state, /^\s*percent:\s*(\d+(?:\.\d+)?)\s*$/m);
  const calculatedPercent = completedPhases !== null && totalPhases
    ? (completedPhases / totalPhases) * 100
    : null;
  const activeAgents = numberFrom(state, /^\s*active_agents:\s*(\d+)\s*$/m)
    ?? numberFrom(state, /^\s*activeAgents:\s*(\d+)\s*$/m)
    ?? 0;
  return {
    state: state.match(/^status:\s*(.+)$/m)?.[1]?.trim() ?? 'ready',
    currentPhase: numberFrom(state, /^\s*current_phase:\s*(\d+)\s*$/m),
    totalPhases,
    currentPlan: numberFrom(state, /^\s*current_plan:\s*(\d+)\s*$/m),
    totalPlans: numberFrom(state, /^\s*total_plans:\s*(\d+)\s*$/m),
    completedPhases,
    projectPercent: explicitPercent ?? calculatedPercent,
    activeAgents,
    estimatedCostUsd: moneyFrom(state, [
      /^\s*(?:estimated_cost_usd|estimatedCostUsd):\s*\$?([\d.]+)\s*$/mi,
      /^\s*estimated cost:\s*\$?([\d.]+)\s*$/mi
    ]),
    budgetRemainingUsd: moneyFrom(state, [
      /^\s*(?:budget_remaining_usd|budgetRemainingUsd):\s*\$?([\d.]+)\s*$/mi,
      /^\s*budget remaining:\s*\$?([\d.]+)\s*$/mi
    ])
  };
}

export function statusSnapshot(state: GsdPlanningState): GsdStatusSnapshot {
  return {
    projectPercent: state.projectPercent,
    currentPhase: state.currentPhase,
    totalPhases: state.totalPhases,
    currentPlan: state.currentPlan,
    totalPlans: state.totalPlans,
    state: state.state,
    activeAgents: state.activeAgents,
    estimatedCostUsd: state.estimatedCostUsd,
    budgetRemainingUsd: state.budgetRemainingUsd
  };
}

export function formatGsdStatusLine(snapshot: GsdStatusSnapshot): string {
  const percent = snapshot.projectPercent === null ? '—' : `${Math.round(snapshot.projectPercent)}%`;
  const phase = snapshot.currentPhase === null || snapshot.totalPhases === null ? 'Phase —' : `Phase ${snapshot.currentPhase}/${snapshot.totalPhases}`;
  const plan = snapshot.currentPlan === null || snapshot.totalPlans === null ? 'Plan —' : `Plan ${snapshot.currentPlan}/${snapshot.totalPlans}`;
  const agents = `Agents ${snapshot.activeAgents}`;
  const costs = [
    snapshot.estimatedCostUsd === undefined ? undefined : `Est. $${snapshot.estimatedCostUsd.toFixed(4)}`,
    snapshot.budgetRemainingUsd === undefined ? undefined : `Budget $${snapshot.budgetRemainingUsd.toFixed(4)}`
  ].filter((value): value is string => value !== undefined);
  const cost = costs.length ? ` · ${costs.join(' · ')}` : '';
  return `${percent} · ${phase} · ${plan} · ${snapshot.state} · ${agents}${cost}`;
}
