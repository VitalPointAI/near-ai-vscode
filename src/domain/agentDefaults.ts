// The agent defaults users get out of the box, in one place that both the settings readers and the
// live tests import, so a test can never run under friendlier limits than production does.
// Keep these in step with the defaults declared in package.json (agentDefaults.test.ts checks it).

// Phase 74.1 (D-18, D-18a): the model defaults live here only, by job, as shipped passport ids in preference order (src/domain/gate/shippedPassports.ts);
// src/domain/gate/jobModel.ts turns them into the model a run uses. `reportFallback` holds today's ids, the only place they may appear: used in report mode
// while no preferred model is in the catalogue, never under enforce.
export const AGENT_DEFAULTS = {
  models: {
    standard: ['nvidia/nemotron-3-super', 'cohere/command-a-plus', 'openai/gpt-oss'],
    deep: ['nvidia/nemotron-3-ultra', 'cohere/command-a-plus', 'openai/gpt-oss'],
    fast: ['nvidia/nemotron-3-nano', 'openai/gpt-oss', 'ibm-granite/granite'],
    // The owner's classifier order: gpt-oss, Nemotron 3 Nano, then Granite Guardian (trained to detect harm and jailbreaks).
    safety: ['openai/gpt-oss', 'nvidia/nemotron-3-nano', 'ibm-granite/granite-guardian'],
    vision: ['cohere/command-a-plus'],
    transcription: ['openai/whisper-large-v3'],
    image: ['black-forest-labs/flux.2-klein-4b'],
    // The Granite Embedding passport comes with Phase 32.2; no Western reranker is passported yet.
    embed: [],
    rerank: [],
    // The backup is the job's next family (74.1-08); the research workspace's model is the person's pick (74.1-07).
    backup: [],
    t0: []
  },
  reportFallback: {
    standard: 'z-ai/glm-5.3', deep: 'moonshotai/kimi-k3', fast: 'Qwen/Qwen3.6-35B-A3B-FP8',
    vision: 'z-ai/glm-5.3-flash', transcription: 'openai/whisper-large-v3', image: 'black-forest-labs/FLUX.2-klein-4B'
  },
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
  /** PERF-03: a model turn that streams nothing for this many seconds (first token, or between chunks) is retried once on the backup model. */
  modelStallSeconds: 120,
  /** PERF-04: sub-agents in their own git worktree at once. */
  maxParallelWorktrees: 4,
  /** PERF-05: resume a run a reload cut off. */
  autoResumeAfterReload: true,
  /** 0.4.23: generated images wait as drafts for the person to accept, change or discard ("ask"), or go straight to their path ("off"). */
  imageReview: 'ask'
} as const;
