export type ActivityStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'setup-blocked';

export type ActivityKind = 'session' | 'phase' | 'agent' | 'model' | 'tool' | 'approval' | 'message';

export type AttributionStatus = 'attributed' | 'legacy-unknown';

/** Ownership captured by the extension host when a request/session starts. */
export interface AttributionSnapshot {
  version: 1;
  status: AttributionStatus;
  projectId: string;
  projectLabel: string;
  organizationProfileId: string;
  organizationDisplayName: string;
}

export const UNKNOWN_ATTRIBUTION: AttributionSnapshot = {
  version: 1,
  status: 'legacy-unknown',
  projectId: 'unknown-project',
  projectLabel: 'Unknown project',
  organizationProfileId: 'unknown-profile',
  organizationDisplayName: 'Legacy / unknown organization'
};

export function hostAttribution(projectId: string, projectLabel: string, organizationProfileId: string, organizationDisplayName: string): AttributionSnapshot {
  return {
    version: 1,
    status: 'attributed',
    projectId: safeLabel(projectId, 80) ?? UNKNOWN_ATTRIBUTION.projectId,
    projectLabel: safeLabel(projectLabel, 160) ?? UNKNOWN_ATTRIBUTION.projectLabel,
    organizationProfileId: safeLabel(organizationProfileId, 80) ?? UNKNOWN_ATTRIBUTION.organizationProfileId,
    organizationDisplayName: safeLabel(organizationDisplayName, 120) ?? UNKNOWN_ATTRIBUTION.organizationDisplayName
  };
}

export function normalizeAttribution(value: unknown, legacyProjectLabel?: string): AttributionSnapshot {
  if (!value || typeof value !== 'object') return { ...UNKNOWN_ATTRIBUTION, projectLabel: safeLabel(legacyProjectLabel, 160) ?? UNKNOWN_ATTRIBUTION.projectLabel };
  const source = value as Partial<AttributionSnapshot>;
  if (source.status !== 'attributed' || source.version !== 1) return { ...UNKNOWN_ATTRIBUTION, projectLabel: safeLabel(legacyProjectLabel, 160) ?? UNKNOWN_ATTRIBUTION.projectLabel };
  const projectId = safeLabel(source.projectId, 80);
  const projectLabel = safeLabel(source.projectLabel, 160);
  const profileId = safeLabel(source.organizationProfileId, 80);
  const organization = safeLabel(source.organizationDisplayName, 120);
  return projectId && projectLabel && profileId && organization
    ? { version: 1, status: 'attributed', projectId, projectLabel, organizationProfileId: profileId, organizationDisplayName: organization }
    : { ...UNKNOWN_ATTRIBUTION, projectLabel: safeLabel(legacyProjectLabel, 160) ?? UNKNOWN_ATTRIBUTION.projectLabel };
}

export interface ActivityEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  attribution?: AttributionSnapshot;
  kind: ActivityKind;
  status: ActivityStatus;
  summary: string;
  phase?: string;
  agentId?: string;
  agentRole?: string;
  model?: string;
  tool?: string;
  action?: string;
  route?: string;
  requestId?: string;
  cacheHit?: boolean;
  agentCount?: number;
  attempt?: number;
  retry?: boolean;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  inputTokens?: number;
  /** Of inputTokens, how many NEAR served from its prompt cache (0.4.19, PERF-07). */
  cachedInputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  approvalRequired?: boolean;
  errorCode?: string;
}

export type SessionOutcome = 'running' | 'completed' | 'failed' | 'cancelled' | 'setup-blocked';
export interface ActivityApprovalSummary { required: number; approved: number; pending: number; }
export interface ActivityContextSummary { userTurns: number; assistantTurns: number; lastEvent?: string; }
export interface ActivitySessionSummary {
  version: 1;
  sessionId: string;
  project: string;
  attribution?: AttributionSnapshot;
  phase?: string;
  plans: string[];
  agents: AgentCounts;
  models: string[];
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  approvals: ActivityApprovalSummary;
  startedAt: string;
  updatedAt: string;
  outcome: SessionOutcome;
  continuationAvailable: boolean;
  context: ActivityContextSummary;
  events: ActivityEvent[];
  /** The chat run this session is (spend for it is tagged with the run ID) and its conversation. */
  runId?: string;
  conversationId?: string;
  /** The first line of what was asked, redacted and truncated (see runTitleFor). */
  title?: string;
  /** When the run's main agent ended, and how. */
  endedAt?: string;
  runOutcome?: RunOutcomeLabel;
  /** Counters summed over every agent of the run, as each ends: ids, counts, tool and model names only. */
  stats?: SessionStats;
  /** Where the run's wall time went, written once when its main agent ends (PERF-07). */
  run?: RunSplit;
}

/**
 * One run's wall time, from its main agent's point of view, split so the four parts add up to the whole: waiting on the model (each reply, and retry
 * waits), running tools (sub-agents included, since the lead waits on them as tool calls), waiting for an approval, and idle (paused, or waiting for
 * background agents with nothing else to do). Tokens are the whole run's, sub-agents included.
 */
export interface RunSplit {
  wallMs: number;
  modelMs: number;
  toolMs: number;
  approvalWaitMs: number;
  idleMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

const RUN_SPLIT_KEYS: Array<keyof RunSplit> = ['wallMs', 'modelMs', 'toolMs', 'approvalWaitMs', 'idleMs', 'inputTokens', 'cachedInputTokens', 'outputTokens'];

/** A run split read from disk: unknown fields dropped, anything not a non-negative number zeroed; undefined when it is not an object. */
export function normalizeRunSplit(value: unknown): RunSplit | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(RUN_SPLIT_KEYS.map((key) => [key, count(source[key])])) as unknown as RunSplit;
}

export type RunOutcomeLabel = 'completed' | 'max-turns' | 'stuck' | 'cancelled' | 'failed';

/** Counters an agent adds to its run's session. Every field is summed, never replaced. */
export interface SessionCounters {
  agents: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  retries: number;
  rateLimited: number;
  /** Agents that failed, and that were stopped (cancelled). */
  errors: number;
  stopped: number;
  inputTokens: number;
  outputTokens: number;
  /** Of inputTokens, how many were prompt-cache hits (PERF-07). */
  cachedInputTokens: number;
  generateMs: number;
  toolMs: number;
  userWaitMs: number;
  nearWaitMs: number;
  approvalsAutoAllowed: number;
  approvalsAsked: number;
  approvalsDeclined: number;
  approvalsExpired: number;
  /** Approvals that nobody answered within the agent's wait, so the call returned "awaiting approval" (PERF-01). */
  approvalTimeouts: number;
}

export interface ModelCounters { agents: number; turns: number; retries: number; rateLimited: number; errors: number; stopped: number; inputTokens: number; outputTokens: number }

export interface SessionStats extends SessionCounters {
  tools: Record<string, { calls: number; errors: number }>;
  models: Record<string, ModelCounters>;
}

const COUNTER_KEYS: Array<keyof SessionCounters> = ['agents', 'turns', 'toolCalls', 'toolErrors', 'retries', 'rateLimited', 'errors', 'stopped', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'generateMs', 'toolMs', 'userWaitMs', 'nearWaitMs', 'approvalsAutoAllowed', 'approvalsAsked', 'approvalsDeclined', 'approvalsExpired', 'approvalTimeouts'];
const MODEL_KEYS: Array<keyof ModelCounters> = ['agents', 'turns', 'retries', 'rateLimited', 'errors', 'stopped', 'inputTokens', 'outputTokens'];
const MAX_TOOLS = 80;
const MAX_MODELS = 20;

export function emptySessionStats(): SessionStats {
  return { ...Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0])) as unknown as SessionCounters, tools: {}, models: {} };
}

export function emptyModelCounters(): ModelCounters {
  return Object.fromEntries(MODEL_KEYS.map((key) => [key, 0])) as unknown as ModelCounters;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
const NAME = /^[A-Za-z0-9][\w./:@+-]{0,159}$/;

/** `delta` added onto `base` (both normalized): the sum semantics every writer relies on. */
export function addSessionStats(base: SessionStats | undefined, delta: Partial<SessionStats>): SessionStats {
  const into = normalizeSessionStats(base);
  for (const key of COUNTER_KEYS) into[key] += count(delta[key]);
  for (const [name, value] of Object.entries(delta.tools ?? {})) {
    if (!NAME.test(name) || (!(name in into.tools) && Object.keys(into.tools).length >= MAX_TOOLS)) continue;
    const tool = (into.tools[name] ??= { calls: 0, errors: 0 });
    tool.calls += count(value?.calls);
    tool.errors += count(value?.errors);
  }
  for (const [name, value] of Object.entries(delta.models ?? {})) {
    if (!NAME.test(name) || (!(name in into.models) && Object.keys(into.models).length >= MAX_MODELS)) continue;
    const model = (into.models[name] ??= emptyModelCounters());
    for (const key of MODEL_KEYS) model[key] += count(value?.[key]);
  }
  return into;
}

/** Counters read from disk: unknown fields dropped, negative or non-numeric values zeroed. */
export function normalizeSessionStats(value: unknown): SessionStats {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<SessionStats>;
  const stats = emptySessionStats();
  for (const key of COUNTER_KEYS) stats[key] = count(source[key]);
  for (const [name, tool] of Object.entries(source.tools && typeof source.tools === 'object' ? source.tools : {}).slice(0, MAX_TOOLS)) if (NAME.test(name)) stats.tools[name] = { calls: count(tool?.calls), errors: count(tool?.errors) };
  for (const [name, model] of Object.entries(source.models && typeof source.models === 'object' ? source.models : {}).slice(0, MAX_MODELS)) {
    if (!NAME.test(name)) continue;
    stats.models[name] = emptyModelCounters();
    for (const key of MODEL_KEYS) stats.models[name][key] = count(model?.[key]);
  }
  return stats;
}
export interface ActivityLedger { version: 1; sessions: ActivitySessionSummary[]; }

export interface AgentCounts {
  deployed: number;
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export function emptyAgentCounts(): AgentCounts {
  return { deployed: 0, active: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 };
}

/**
 * Counts agents, not events: a sub-agent records "running" and later "completed" or "failed", so only its latest event says where it is. An agent
 * event without an id stands for one agent of its own.
 */
export function summarizeAgentCounts(events: ActivityEvent[]): AgentCounts {
  const latest = new Map<string, ActivityStatus>();
  for (const event of events) if (event.kind === 'agent') latest.set(event.agentId ? `agent:${event.agentId}` : `event:${event.id}`, event.status);
  const counts = emptyAgentCounts();
  counts.deployed = latest.size;
  for (const status of latest.values()) {
    if (status === 'running') counts.active += 1;
    if (status === 'waiting') counts.waiting += 1;
    if (status === 'completed') counts.completed += 1;
    if (status === 'failed') counts.failed += 1;
    if (status === 'cancelled') counts.cancelled += 1;
  }
  return counts;
}

/**
 * A run's cost after one more event. An event with a request id is one request: its cost is added, less what an earlier event for the same request
 * already added (a request may be recorded queued, running and done). An event without one is a total someone else summed (a sub-agent's, or the
 * whole run's from the spend ledger), which already includes the requests above, so it raises the cost to that total rather than adding to it.
 */
export function runningCost(current: number | undefined, value: number | undefined, requestId: string | undefined, earlier: ActivityEvent[], field: 'estimatedCostUsd' | 'actualCostUsd'): number | undefined {
  if (value === undefined) return current;
  if (!requestId) return Math.max(current ?? 0, value);
  const counted = earlier.reduce((most, event) => event.requestId === requestId && event[field] !== undefined ? Math.max(most, event[field] as number) : most, 0);
  return (current ?? 0) + Math.max(0, value - counted);
}

export function sessionOutcome(status: ActivityStatus): SessionOutcome {
  if (status === 'setup-blocked') return 'setup-blocked';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'completed';
  return 'running';
}

function safeLabel(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || /[\r\n\t]/.test(value) || /(?:api[_ -]?key|refresh[-_ ]?token|bearer\s|authorization\s*[:=]|private prompt|raw context|command\s*[:=]|[A-Za-z]:\\|^\/)/i.test(value)) return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}
