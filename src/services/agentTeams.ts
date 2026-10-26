import { createHash } from 'node:crypto';
import { AgentDiscoveryAnswers, AgentRole, AgentTeamRecommendation, AgentTeamRole, AGENT_TEAM_VERSION } from '../domain/agents';

const roleDetails: Record<AgentRole, Omit<AgentTeamRole, 'profileId'>> = {
  planner: { role: 'planner', responsibility: 'Break the goal into an executable plan.', coordination: 'Publishes a bounded plan for implementer and reviewer handoff.', modelTradeoff: 'A lower-cost reasoning model is usually sufficient.', privacyBoundary: 'Receives project shape and approved metadata, not credentials.' },
  implementer: { role: 'implementer', responsibility: 'Make the accepted code changes.', coordination: 'Works from the planner output and reports changed surfaces.', modelTradeoff: 'A stronger coding model costs more but reduces rework.', privacyBoundary: 'Receives only the approved workspace context for its task.' },
  reviewer: { role: 'reviewer', responsibility: 'Check correctness, regressions, and acceptance criteria.', coordination: 'Runs after implementation and returns actionable findings.', modelTradeoff: 'Parallel review improves confidence but adds latency and cost.', privacyBoundary: 'Sees diffs and test results, never provider secrets.' },
  security: { role: 'security', responsibility: 'Assess privacy, authorization, and trust-boundary risks.', coordination: 'Can block execution when a high-risk finding is unresolved.', modelTradeoff: 'Specialized review is higher cost but protects sensitive boundaries.', privacyBoundary: 'Uses redacted metadata and explicit security scope.' },
  tester: { role: 'tester', responsibility: 'Design and run focused verification.', coordination: 'Confirms the implementation before final review.', modelTradeoff: 'Local execution lowers cost; cloud execution may be faster.', privacyBoundary: 'Receives test contracts and safe workspace labels.' },
  researcher: { role: 'researcher', responsibility: 'Resolve unfamiliar technical or product questions.', coordination: 'Provides sources and decisions to the planner.', modelTradeoff: 'Optional for familiar work; network research adds privacy review.', privacyBoundary: 'Network access is opt-in and policy-gated.' }
};

export function recommendAgentTeam(answers: AgentDiscoveryAnswers): AgentTeamRecommendation {
  const roles: AgentRole[] = answers.workShape === 'research' ? ['researcher', 'planner', 'reviewer'] : answers.riskLevel === 'high' ? ['planner', 'implementer', 'security', 'tester', 'reviewer'] : ['planner', 'implementer', 'tester', 'reviewer'];
  const roleRows = roles.map((role, index) => ({ ...roleDetails[role], profileId: profileReference(answers, role, index) }));
  const estimatedCost = roles.length >= 5 || answers.locality === 'cloud' ? 'high' : roles.length === 4 ? 'medium' : 'low';
  return { version: AGENT_TEAM_VERSION, recommendationId: `team-${createHash('sha256').update(JSON.stringify({ ...answers, goal: answers.goal.trim().slice(0, 160) })).digest('hex').slice(0, 12)}`, rationale: `A ${answers.workShape} workflow with ${answers.riskLevel} risk uses explicit role handoffs before execution.`, roles: roleRows, estimatedCost, coordinationTradeoff: roles.length > 4 ? 'More independent checks improve confidence but increase coordination and cost.' : 'A compact team reduces cost and keeps handoffs easy to inspect.' };
}

export function customizeAgentTeam(recommendation: AgentTeamRecommendation, changes: { add?: AgentRole[]; remove?: AgentRole[]; reassign?: Partial<Record<AgentRole, AgentRole>> }): AgentTeamRecommendation {
  const remove = new Set(changes.remove ?? []); const existing = recommendation.roles.filter((row) => !remove.has(row.role)); const additions = (changes.add ?? []).filter((role) => !existing.some((row) => row.role === role)).map((role, index) => ({ ...roleDetails[role], profileId: `profile-reference-${role}-${index + 1}` }));
  const roles = [...existing, ...additions].map((row) => { const target = changes.reassign?.[row.role]; return target && roleDetails[target] ? { ...roleDetails[target], profileId: row.profileId } : row; });
  if (!roles.length) throw new Error('An accepted team must contain at least one role.');
  return { ...recommendation, roles, recommendationId: `${recommendation.recommendationId}-custom-${roles.length}` };
}

function profileReference(answers: AgentDiscoveryAnswers, role: AgentRole, index: number): string { return `profile-reference-${createHash('sha256').update(`${answers.preferredProvider}:${answers.locality}:${role}:${index}`).digest('hex').slice(0, 12)}`; }
