// The agent defaults users get out of the box, in one place that both the settings readers and the
// live tests import, so a test can never run under friendlier limits than production does.
// Keep these in step with the defaults declared in package.json (agentDefaults.test.ts checks it).

export const AGENT_DEFAULTS = {
  tiers: { deep: 'moonshotai/kimi-k3', standard: 'z-ai/glm-5.3', fast: 'Qwen/Qwen3.6-35B-A3B-FP8' },
  maxTurns: 60,
  maxParallelAgents: 8,
  maxRunCostUsd: 5,
  maxRunTokens: 4_000_000,
  maxOutputTokens: 32_000,
  approvalTimeoutMinutes: 15,
  /** PERF-01: how long a sub-agent's approval card waits before the call returns "awaiting approval". */
  subagentApprovalWaitSeconds: 20,
  /** PERF-01: consecutive unanswered approvals that pause the run (0 never pauses). */
  approvalTimeoutsBeforePause: 3,
  unattendedAutoApprove: true,
  /** PERF-02: compact a transcript at this many tokens whatever the model's window. */
  compactAtTokens: 70_000,
  /** PERF-03: a model turn not finished after this many seconds is retried once on the backup model. */
  modelDeadlineSeconds: 120,
  /** PERF-04: sub-agents in their own git worktree at once. */
  maxParallelWorktrees: 4,
  /** PERF-05: resume a run a reload cut off. */
  autoResumeAfterReload: true
} as const;
