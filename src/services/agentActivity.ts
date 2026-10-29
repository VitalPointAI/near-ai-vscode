import { redactSecrets } from '../domain/redaction';
import type { UsageMetadata } from './nearAiClient';

// A live, in-memory record of what every agent is doing (prompts, replies, reasoning, tool calls)
// with running statistics per agent. The Agent Activity page shows the statistics (what each agent
// is doing now, counts, where the time went); the entries are kept only for "Export details".
// Nothing here is written to disk: the conversation persists each agent's counters (no content)
// in the project's ActivityStore when it ends. Entries older than the retention window, or beyond
// the size budget, are dropped oldest first; statistics survive that. Listeners are told about
// changes only while someone is subscribed.

export type ActivityKind = 'system' | 'prompt' | 'text' | 'reasoning' | 'tool' | 'retry' | 'notice' | 'security' | 'agent-start' | 'agent-end';

export interface ActivityEntry {
  seq: number;
  at: number;
  runId: string;
  agentId: string;
  agent: string;
  kind: ActivityKind;
  title?: string;
  text?: string;
  /** For tool rows: the call's input, then its result once it finishes. */
  input?: string;
  ok?: boolean;
  ms?: number;
  callId?: string;
}

export type AgentStatus = 'running' | 'completed' | 'max-turns' | 'cancelled' | 'failed';

/** What a running agent is doing right now. */
export type AgentPhase = 'starting' | 'thinking' | 'generating' | 'tool' | 'waiting-you' | 'cooling-down' | 'paused';

/** Where the agent's model runs: inside NEAR's TEE, on this machine, or forwarded by NEAR. */
export type AgentBoundary = 'tee' | 'local' | 'cloud';

export interface ApprovalCounts { autoAllowed: number; asked: number; declined: number; expired: number }

export interface AgentStats {
  agentId: string;
  agent: string;
  runId: string;
  parentId?: string;
  model: string;
  status: AgentStatus;
  startedAt: number;
  endedAt?: number;
  turns: number;
  inputTokens: number;
  /** Of inputTokens, served from NEAR's prompt cache. */
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
  modelMs: number;
  /** Of modelMs, waiting for the first token of each reply; the rest is generating. */
  waitMs: number;
  /** Of outputTokens, reasoning: as NEAR reports it, or estimated from the streamed characters when `reasoningEstimated`. */
  reasoningTokens: number;
  reasoningEstimated?: boolean;
  toolCalls: number;
  toolErrors: number;
  retries: number;
  /** Defenses that acted for this agent: likely injections flagged, hidden content removed, risky actions held for approval or declined. */
  injections: number;
  hiddenRemoved: number;
  held: number;
  blocked: number;
  /** The chat conversation it ran in (spend for "this conversation" is tagged with it). */
  conversationId?: string;
  boundary?: AgentBoundary;
  /** What it is doing now, since when; `coolUntil` while it waits to retry a refused or failed request. */
  phase: AgentPhase;
  phaseSince: number;
  coolUntil?: number;
  /** Why it is cooling down: NEAR answered 429, or another retryable failure. */
  coolReason?: 'rate-limited' | 'error';
  /** The tool it is running now. */
  tool?: string;
  /** Retries after NEAR answered 429 (rate limited). */
  rateLimited: number;
  /** Time spent waiting to retry (cooling down), and waiting for the user to answer an approval. */
  coolMs: number;
  userWaitMs: number;
  approvals: ApprovalCounts;
  /** Calls and failures by tool name. */
  tools: Record<string, { calls: number; errors: number }>;
  /** Its counters were saved to the project's activity history (after it ended). */
  persisted?: boolean;
}

/**
 * Where an agent's time went: waiting for each reply's first token, generating, and everything
 * else (tools, sub-agents, approvals); generation speed excludes the wait.
 */
export function timeBreakdown(stat: AgentStats, now = Date.now()): { elapsedMs: number; waitMs: number; generateMs: number; otherMs: number; toolMs: number; userWaitMs: number; nearWaitMs: number; tokensPerSecond?: number; reasoningShare?: number } {
  const elapsedMs = Math.max(0, (stat.endedAt ?? now) - stat.startedAt);
  const waitMs = Math.min(stat.waitMs, stat.modelMs);
  const generateMs = stat.modelMs - waitMs;
  // The phase in progress counts too, so a long wait shows while it happens.
  const ongoing = stat.status === 'running' ? Math.max(0, now - stat.phaseSince) : 0;
  const userWaitMs = (stat.userWaitMs ?? 0) + (stat.phase === 'waiting-you' ? ongoing : 0);
  const coolMs = (stat.coolMs ?? 0) + (stat.phase === 'cooling-down' ? ongoing : 0);
  const otherMs = Math.max(0, elapsedMs - stat.modelMs);
  return {
    elapsedMs,
    waitMs,
    generateMs,
    otherMs,
    /** Tools and sub-agents: everything outside model requests, approvals, and retry waits. */
    toolMs: Math.max(0, otherMs - userWaitMs - coolMs),
    userWaitMs,
    /** Waiting on NEAR: for each reply's first token, and to retry after a refusal or failure. */
    nearWaitMs: waitMs + coolMs,
    tokensPerSecond: generateMs > 0 && stat.outputTokens ? stat.outputTokens / (generateMs / 1000) : undefined,
    reasoningShare: stat.outputTokens ? Math.min(1, stat.reasoningTokens / stat.outputTokens) : undefined
  };
}

export interface ActivityLimits { maxAgeMs: number; maxBytes: number }
/** Entries added or updated since the last change; `cleared` when the feed was emptied. Read stats with `agentStats()`. */
export interface ActivityChange { entries: ActivityEntry[]; cleared?: boolean }

const CAPS: Partial<Record<ActivityKind, number>> = { system: 20_000, prompt: 20_000, text: 50_000, reasoning: 50_000 };
const TOOL_INPUT_CAP = 4_000;
const TOOL_OUTPUT_CAP = 8_000;
const MAX_AGENTS = 300;
const TOKENS = /\b(?:sk-[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)\b/g;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

export function redactForDisplay(value: string): string {
  return redactSecrets(value).replace(PRIVATE_KEY, '[PRIVATE KEY REDACTED]').replace(TOKENS, '[REDACTED]');
}

function cap(value: string | undefined, limit: number): string | undefined {
  if (value === undefined) return undefined;
  const clean = redactForDisplay(value);
  return clean.length > limit ? `${clean.slice(0, limit)}\n… [${(clean.length - limit).toLocaleString('en-US')} more characters not kept]` : clean;
}

const MAX_TOOL_NAMES = 60;

/** A tool's name as the page groups it: the name only, never its input (a title like "Bash npm test" is "Bash"). */
export function toolName(value: string): string {
  const name = value.trim().split(/[\s(:]/)[0] ?? '';
  return /^[A-Za-z][\w.-]{0,79}$/.test(name) ? name : 'other';
}

function cloneStat(stat: AgentStats): AgentStats {
  return { ...stat, approvals: { ...stat.approvals }, tools: Object.fromEntries(Object.entries(stat.tools).map(([name, count]) => [name, { ...count }])) };
}

const size = (entry: ActivityEntry) => 200 + 2 * ((entry.text?.length ?? 0) + (entry.input?.length ?? 0) + (entry.title?.length ?? 0));

export class ActivityFeed {
  private entries: ActivityEntry[] = [];
  private readonly open = new Map<string, ActivityEntry>();
  private readonly stats = new Map<string, AgentStats>();
  private readonly listeners = new Set<(change: ActivityChange) => void>();
  private readonly toolNames = new Map<string, string>();
  private conversation: string | undefined;
  /** Set once the chat says which conversation is on screen. */
  private focused = false;
  private seq = 0;
  private bytes = 0;

  public constructor(private limits: ActivityLimits, private readonly now: () => number = Date.now) {}

  public setLimits(limits: ActivityLimits): void { this.limits = limits; this.evict(); }
  public get usage(): { entries: number; bytes: number; limits: ActivityLimits } { this.evict(); return { entries: this.entries.length, bytes: this.bytes, limits: this.limits }; }

  /** Starts listening; the first call gets everything still kept. */
  public subscribe(listener: (change: ActivityChange) => void): { dispose(): void; snapshot: ActivityEntry[] } {
    this.evict();
    this.listeners.add(listener);
    return { snapshot: this.entries.map((entry) => ({ ...entry })), dispose: () => { this.listeners.delete(listener); } };
  }

  public agentStats(): AgentStats[] { return [...this.stats.values()].map(cloneStat); }

  public get watched(): boolean { return this.listeners.size > 0; }

  public clear(): void {
    this.entries = [];
    this.open.clear();
    this.bytes = 0;
    for (const [id, stat] of this.stats) if (stat.status !== 'running') this.stats.delete(id);
    this.notify({ entries: [], cleared: true });
  }

  public agentStarted(agent: { agentId: string; agent: string; runId: string; model: string; parentId?: string; conversationId?: string; boundary?: AgentBoundary }, prompt?: string, system?: string): void {
    const now = this.now();
    this.stats.set(agent.agentId, { ...agent, status: 'running', startedAt: now, turns: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, modelMs: 0, waitMs: 0, reasoningTokens: 0, toolCalls: 0, toolErrors: 0, retries: 0, injections: 0, hiddenRemoved: 0, held: 0, blocked: 0, phase: 'starting', phaseSince: now, rateLimited: 0, coolMs: 0, userWaitMs: 0, approvals: { autoAllowed: 0, asked: 0, declined: 0, expired: 0 }, tools: {} });
    if (agent.conversationId && !agent.parentId && !this.focused) this.conversation = agent.conversationId;
    for (const stale of [...this.stats.keys()].slice(0, Math.max(0, this.stats.size - MAX_AGENTS))) this.stats.delete(stale);
    const base = { runId: agent.runId, agentId: agent.agentId, agent: agent.agent };
    this.add({ ...base, kind: 'agent-start', title: `${agent.agent} started on ${agent.model}` });
    if (system) this.add({ ...base, kind: 'system', title: 'System prompt', text: system });
    if (prompt) this.add({ ...base, kind: 'prompt', title: 'Prompt', text: prompt });
  }

  public agentEnded(agentId: string, status: Exclude<AgentStatus, 'running'>, summary?: string): void {
    const stat = this.stats.get(agentId);
    if (!stat) return;
    this.enter(stat, 'thinking');
    stat.status = status;
    stat.endedAt = this.now();
    stat.coolUntil = undefined;
    stat.tool = undefined;
    this.closeText(agentId);
    this.add({ runId: stat.runId, agentId, agent: stat.agent, kind: 'agent-end', title: `${stat.agent} ${status === 'max-turns' ? 'reached its turn limit' : status}`, text: summary });
  }

  public prompt(agentId: string, text: string): void { this.withAgent(agentId, (base) => { this.closeText(agentId); this.add({ ...base, kind: 'prompt', title: 'Prompt', text }); }); }

  /** Streamed reply or reasoning text, merged into one entry until something else happens. */
  public stream(agentId: string, kind: 'text' | 'reasoning', text: string): void {
    this.withAgent(agentId, (base, stat) => {
      if (stat.phase !== 'tool' && stat.phase !== 'waiting-you') this.enter(stat, kind === 'text' ? 'generating' : 'thinking');
      const key = `${agentId}:stream`;
      const current = this.open.get(key);
      if (current && current.kind === kind && this.entries.includes(current)) {
        const limit = CAPS[kind]!;
        if ((current.text?.length ?? 0) < limit) {
          this.bytes -= size(current);
          current.text = cap(`${current.text ?? ''}${text}`, limit);
          this.bytes += size(current);
          this.changed([current]);
        }
        return;
      }
      this.open.set(key, this.add({ ...base, kind, text }));
    });
  }

  public toolStarted(agentId: string, callId: string, title: string, input?: string, tool?: string): void {
    this.withAgent(agentId, (base, stat) => {
      this.closeText(agentId);
      stat.toolCalls += 1;
      const name = toolName(tool ?? title);
      if (name in stat.tools || Object.keys(stat.tools).length < MAX_TOOL_NAMES) (stat.tools[name] ??= { calls: 0, errors: 0 }).calls += 1;
      this.toolNames.set(`${agentId}:${callId}`, name);
      this.enter(stat, 'tool');
      stat.tool = name;
      this.open.set(`${agentId}:${callId}`, this.add({ ...base, kind: 'tool', callId, title, input: cap(input, TOOL_INPUT_CAP) }));
    });
  }

  public toolEnded(agentId: string, callId: string, ok: boolean, output: string): void {
    const stat = this.stats.get(agentId);
    const name = this.toolNames.get(`${agentId}:${callId}`);
    this.toolNames.delete(`${agentId}:${callId}`);
    if (stat && !ok) { stat.toolErrors += 1; if (name && stat.tools[name]) stat.tools[name].errors += 1; }
    // With parallel calls, the agent is still running tools until the last one ends.
    const stillRunning = [...this.toolNames.keys()].some((key) => key.startsWith(`${agentId}:`));
    if (stat?.status === 'running' && !stillRunning && stat.phase === 'tool') { this.enter(stat, 'thinking'); stat.tool = undefined; }
    const entry = this.open.get(`${agentId}:${callId}`);
    this.open.delete(`${agentId}:${callId}`);
    if (!entry || !this.entries.includes(entry)) { this.changed([]); return; }
    this.bytes -= size(entry);
    entry.ok = ok;
    entry.ms = this.now() - entry.at;
    entry.text = cap(output, TOOL_OUTPUT_CAP);
    this.bytes += size(entry);
    this.changed([entry]);
  }

  public turn(agentId: string, usage: UsageMetadata): void {
    const stat = this.stats.get(agentId);
    if (!stat) return;
    stat.turns += 1;
    if (stat.status === 'running' && stat.phase !== 'tool') this.enter(stat, 'thinking');
    stat.inputTokens += usage.inputTokens ?? 0;
    stat.cachedTokens += usage.cachedInputTokens ?? 0;
    stat.outputTokens += usage.outputTokens ?? 0;
    stat.costUsd += usage.estimatedCostUsd ?? 0;
    stat.modelMs += usage.latencyMs ?? 0;
    stat.waitMs += usage.firstTokenMs ?? 0;
    if (usage.reasoningTokens !== undefined) stat.reasoningTokens += usage.reasoningTokens;
    else if (usage.reasoningChars && usage.outputTokens) {
      stat.reasoningTokens += Math.round((usage.outputTokens * usage.reasoningChars) / (usage.reasoningChars + (usage.answerChars ?? 0)));
      stat.reasoningEstimated = true;
    }
    this.closeText(agentId);
    this.changed([]);
  }

  /** A model request failed and will be retried after `delayMs`; `status` 429 is a rate limit. */
  public retry(agentId: string, text: string, detail: { status?: number; delayMs?: number } = {}): void {
    this.withAgent(agentId, (base, stat) => {
      stat.retries += 1;
      if (detail.status === 429) stat.rateLimited += 1;
      this.enter(stat, 'cooling-down');
      stat.coolUntil = detail.delayMs !== undefined ? this.now() + Math.max(0, detail.delayMs) : undefined;
      stat.coolReason = detail.status === 429 ? 'rate-limited' : 'error';
      this.closeText(agentId);
      this.add({ ...base, kind: 'retry', title: 'Retrying', text });
    });
  }

  /** An approval was put to the user; `approvalSettled` says how it ended. */
  public approvalAsked(agentId: string): void {
    this.withAgent(agentId, (_base, stat) => { stat.approvals.asked += 1; this.enter(stat, 'waiting-you'); this.changed([]); });
  }

  /** `cancelled`: the run stopped while it waited, which is neither an answer nor an expiry. */
  public approvalSettled(agentId: string, outcome: 'allowed' | 'declined' | 'expired' | 'cancelled'): void {
    this.withAgent(agentId, (_base, stat) => {
      if (outcome === 'declined') stat.approvals.declined += 1;
      if (outcome === 'expired') stat.approvals.expired += 1;
      if (stat.phase === 'waiting-you') this.enter(stat, 'tool');
      this.changed([]);
    });
  }

  /** A gated action the policy allowed without asking, or a rule refused. */
  public permission(agentId: string, decision: 'auto-allowed' | 'denied'): void {
    this.withAgent(agentId, (_base, stat) => { if (decision === 'auto-allowed') stat.approvals.autoAllowed += 1; else stat.approvals.declined += 1; });
  }

  public setPaused(agentId: string, paused: boolean): void {
    this.withAgent(agentId, (_base, stat) => {
      if (stat.status !== 'running') return;
      if (paused) this.enter(stat, 'paused');
      else if (stat.phase === 'paused') this.enter(stat, 'thinking');
      this.changed([]);
    });
  }

  /** One agent's statistics. */
  public agentStat(agentId: string): AgentStats | undefined { const stat = this.stats.get(agentId); return stat ? cloneStat(stat) : undefined; }

  /** The agent's counters are in the project's activity history now, so overviews read them from there. */
  public markPersisted(agentId: string): void { const stat = this.stats.get(agentId); if (stat) { stat.persisted = true; this.changed([]); } }

  /** The conversation of the most recently started main agent: "this conversation" on the page. */
  public get currentConversation(): string | undefined { return this.conversation; }

  /**
   * The conversation on screen in the chat, which "this conversation" follows from then on
   * (a run starting in a background conversation does not take it over).
   */
  public focusConversation(conversationId: string): void {
    this.focused = true;
    if (this.conversation === conversationId) return;
    this.conversation = conversationId;
    this.changed([]);
  }

  /** Leaves the current phase, adding a finished wait to its total. */
  private enter(stat: AgentStats, phase: AgentPhase): void {
    if (stat.phase === phase) return;
    const now = this.now();
    const spent = Math.max(0, now - stat.phaseSince);
    if (stat.phase === 'cooling-down') { stat.coolMs += spent; stat.coolUntil = undefined; stat.coolReason = undefined; }
    if (stat.phase === 'waiting-you') stat.userWaitMs += spent;
    stat.phase = phase;
    stat.phaseSince = now;
  }

  /** A defense that acted, with where it happened (a URL, search, attachment, or action). */
  public security(agentId: string, event: { kind: 'injection' | 'hidden-content' | 'held' | 'blocked'; source: string; detail: string }): void {
    this.withAgent(agentId, (base, stat) => {
      if (event.kind === 'injection') stat.injections += 1;
      else if (event.kind === 'hidden-content') stat.hiddenRemoved += 1;
      else if (event.kind === 'held') stat.held += 1;
      else stat.blocked += 1;
      const label = { injection: 'Possible prompt injection', 'hidden-content': 'Hidden content removed', held: 'Held for approval', blocked: 'Blocked' }[event.kind];
      this.closeText(agentId);
      this.add({ ...base, kind: 'security', title: `${label} · ${event.source}`, text: event.detail });
    });
  }

  public notice(agentId: string, text: string): void { this.withAgent(agentId, (base) => this.add({ ...base, kind: 'notice', text })); }

  private withAgent(agentId: string, act: (base: Pick<ActivityEntry, 'runId' | 'agentId' | 'agent'>, stat: AgentStats) => void): void {
    const stat = this.stats.get(agentId);
    if (stat) act({ runId: stat.runId, agentId, agent: stat.agent }, stat);
  }

  private closeText(agentId: string): void { this.open.delete(`${agentId}:stream`); }

  private add(partial: Omit<ActivityEntry, 'seq' | 'at'>): ActivityEntry {
    const limit = CAPS[partial.kind];
    const entry: ActivityEntry = { ...partial, seq: ++this.seq, at: this.now(), ...(partial.text !== undefined ? { text: cap(partial.text, limit ?? TOOL_OUTPUT_CAP) } : {}), ...(partial.title !== undefined ? { title: cap(partial.title, 500) } : {}) };
    this.entries.push(entry);
    this.bytes += size(entry);
    this.evict();
    this.changed([entry]);
    return entry;
  }

  private evict(): void {
    const oldest = this.now() - this.limits.maxAgeMs;
    let drop = 0;
    let bytes = this.bytes;
    while (drop < this.entries.length && (this.entries[drop].at < oldest || bytes > this.limits.maxBytes)) bytes -= size(this.entries[drop++]);
    if (!drop) return;
    this.entries = this.entries.slice(drop);
    this.bytes = Math.max(0, bytes);
  }

  /** Passes the live entries; a listener copies what it keeps (the page's controller does, once per flush). */
  private changed(entries: ActivityEntry[]): void { if (this.listeners.size) this.notify({ entries }); }

  private notify(change: ActivityChange): void { for (const listener of this.listeners) listener(change); }
}
