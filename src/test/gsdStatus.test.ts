import assert from 'node:assert/strict';
import test from 'node:test';
import { formatGsdStatusLine, parseGsdPlanningState, statusSnapshot } from '../domain/gsdStatus';

test('GSD status line keeps project progress visible below chat', () => {
  assert.equal(formatGsdStatusLine({
    projectPercent: 42,
    currentPhase: 2,
    totalPhases: 5,
    currentPlan: 1,
    totalPlans: 3,
    state: 'executing',
    activeAgents: 2,
    estimatedCostUsd: 0.1234
  }), '42% · Phase 2/5 · Plan 1/3 · executing · Agents 2 · Est. $0.1234');
});

test('planning state parses progress, execution, agents, and cost context', () => {
  const parsed = parseGsdPlanningState(`status: executing\ncurrent_phase: 2\ncurrent_plan: 1\ntotal_plans: 3\ncompleted_phases: 1\ntotal_phases: 5\nactive_agents: 2\nestimated_cost_usd: 0.12\nbudget_remaining_usd: 4.5`);
  assert.deepEqual(statusSnapshot(parsed), {
    projectPercent: 20,
    currentPhase: 2,
    totalPhases: 5,
    currentPlan: 1,
    totalPlans: 3,
    state: 'executing',
    activeAgents: 2,
    estimatedCostUsd: 0.12,
    budgetRemainingUsd: 4.5
  });
});
