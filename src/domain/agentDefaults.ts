// The agent defaults users get out of the box, in one place that both the settings readers and the
// live tests import, so a test can never run under friendlier limits than production does.
// Keep these in step with the defaults declared in package.json (agentDefaults.test.ts checks it).

export const AGENT_DEFAULTS = {
  tiers: { deep: 'moonshotai/kimi-k3', standard: 'z-ai/glm-5.3', fast: 'z-ai/glm-5.3-flash' },
  maxTurns: 60,
  maxParallelAgents: 4,
  maxRunCostUsd: 5,
  maxRunTokens: 4_000_000,
  maxOutputTokens: 32_000,
  approvalTimeoutMinutes: 15
} as const;
