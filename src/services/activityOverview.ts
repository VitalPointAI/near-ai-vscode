import { ActivitySessionSummary, addSessionStats, emptySessionStats, ModelCounters, SessionOutcome, SessionStats } from '../domain/activity';
import { AgentBoundary, AgentPhase, AgentStats, redactForDisplay, timeBreakdown } from './agentActivity';
import { DayBoundary, dayStart, nanoToUsd, SpendFilter, SpendTotals, totalNanoUsd } from './spendLedger';

// The Agent Activity page's figures, built from what is persisted (the project's ActivityStore
// sessions and the key's spend ledger) plus the live feed for agents still running. No VS Code
// API and no content here: ids, counts, durations, tool and model names, and each run's
// redacted first line.

export type OverviewWindow = 'conversation' | 'today' | 'week';

/**
 * The run's title in history: the first non-empty line of what was asked, redacted and cut to
 * about 80 characters. Everything the page and the history show of a prompt goes through here.
 * (Projects whose content must not be stored at all return undefined from this one function.)
 */
export function runTitleFor(text: string): string | undefined {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  if (!line) return undefined;
  const clean = redactForDisplay(line).replace(/\s+/g, ' ').trim();
  return clean.length > 80 ? `${clean.slice(0, 79).trimEnd()}…` : clean;
}

/** What the page needs from a spend account (SpendAccount satisfies it). */
export interface OverviewSpend {
  totals(filter?: SpendFilter): SpendTotals;
  today(): { text: string; tooltip: string; source: string; near?: unknown };
  window(window: 'conversation' | 'request', filter: SpendFilter): { text: string; tooltip: string; source: string };
}

/** Start (ms) of the window, or undefined for "this conversation". Seven days are today and the six before it. */
export function windowStart(window: OverviewWindow, now: number, boundary: DayBoundary): number | undefined {
  if (window === 'conversation') return undefined;
  const today = dayStart(now, boundary);
  if (window === 'today') return today;
  const date = new Date(today);
  if (boundary === 'utc') date.setUTCDate(date.getUTCDate() - 6);
  else date.setDate(date.getDate() - 6);
  return date.getTime();
}

/** An agent's counters as a session stores them; the conversation persists this when the agent ends. */
export function countersOf(stat: AgentStats, now = Date.now()): Partial<SessionStats> {
  const time = timeBreakdown(stat, now);
  const failed = stat.status === 'failed' ? 1 : 0;
  const stopped = stat.status === 'cancelled' ? 1 : 0;
  const model: ModelCounters = { agents: 1, turns: stat.turns, retries: stat.retries, rateLimited: stat.rateLimited, errors: failed, stopped, inputTokens: stat.inputTokens, outputTokens: stat.outputTokens };
  return {
    agents: 1, turns: stat.turns, toolCalls: stat.toolCalls, toolErrors: stat.toolErrors, retries: stat.retries, rateLimited: stat.rateLimited, errors: failed, stopped,
    inputTokens: stat.inputTokens, outputTokens: stat.outputTokens, generateMs: time.generateMs, toolMs: time.toolMs, userWaitMs: time.userWaitMs, nearWaitMs: time.nearWaitMs,
    approvalsAutoAllowed: stat.approvals.autoAllowed, approvalsAsked: stat.approvals.asked, approvalsDeclined: stat.approvals.declined, approvalsExpired: stat.approvals.expired,
    tools: stat.tools, models: stat.model ? { [stat.model]: model } : {}
  };
}

export interface NowRow {
  agentId: string;
  runId: string;
  label: string;
  sub: boolean;
  model: string;
  boundary?: AgentBoundary;
  phase: AgentPhase;
  phaseSince: number;
  coolUntil?: number;
  coolReason?: 'rate-limited' | 'error';
  tool?: string;
  startedAt: number;
  turns: number;
  toolCalls: number;
  costUsd?: number;
}

export interface WindowSummary {
  window: OverviewWindow;
  /** For "this conversation": none yet in this window. */
  empty: boolean;
  runs: number;
  agents: number;
  time: { generateMs: number; toolMs: number; userWaitMs: number; nearWaitMs: number };
  tokens: { input: number; output: number; source: 'ledger' | 'activity' };
  cost?: { text: string; tooltip: string; source: string; confirmedUsd: number; pendingUsd: number; near: boolean };
  tools: Array<{ name: string; calls: number; errors: number }>;
  approvals: { autoAllowed: number; asked: number; declined: number; expired: number };
  problems: { rateLimited: number; retries: number; errors: number; stopped: number; toolErrors: number };
  models: Array<{ model: string } & ModelCounters>;
}

export interface HistoryRow {
  sessionId: string;
  runId?: string;
  conversationId?: string;
  startedAt: string;
  title: string;
  agents: number;
  durationMs?: number;
  costText?: string;
  costUsd?: number;
  outcome: SessionOutcome | 'max-turns';
}

export interface HistoryPage { rows: HistoryRow[]; page: number; pages: number; total: number }

export interface OverviewInput {
  sessions: ActivitySessionSummary[];
  live: AgentStats[];
  spend?: OverviewSpend;
  window: OverviewWindow;
  now: number;
  boundary: DayBoundary;
  conversationId?: string;
}

const time = (value: string) => { const at = Date.parse(value); return Number.isFinite(at) ? at : 0; };

/** Sessions in the window, newest first. */
export function sessionsIn(sessions: ActivitySessionSummary[], window: OverviewWindow, now: number, boundary: DayBoundary, conversationId?: string): ActivitySessionSummary[] {
  const since = windowStart(window, now, boundary);
  return sessions.filter((session) => window === 'conversation' ? Boolean(conversationId) && session.conversationId === conversationId : time(session.startedAt) >= (since ?? 0)).sort((a, b) => time(b.startedAt) - time(a.startedAt));
}

/** Live agents whose counters are not in the history yet and that belong to the window. */
function liveIn(live: AgentStats[], window: OverviewWindow, now: number, boundary: DayBoundary, conversationId?: string): AgentStats[] {
  const since = windowStart(window, now, boundary);
  return live.filter((stat) => !stat.persisted && (window === 'conversation' ? Boolean(conversationId) && stat.conversationId === conversationId : stat.startedAt >= (since ?? 0)));
}

export function buildWindowSummary(input: OverviewInput): WindowSummary {
  const { window, now, boundary, conversationId, spend } = input;
  const sessions = sessionsIn(input.sessions, window, now, boundary, conversationId);
  const live = liveIn(input.live, window, now, boundary, conversationId);
  let stats: SessionStats = emptySessionStats();
  for (const session of sessions) if (session.stats) stats = addSessionStats(stats, session.stats);
  for (const stat of live) stats = addSessionStats(stats, countersOf(stat, now));
  const runs = new Set([...sessions.map((session) => session.runId ?? session.sessionId), ...live.map((stat) => stat.runId)]);
  const since = windowStart(window, now, boundary);
  const filter: SpendFilter | undefined = window === 'conversation' ? (conversationId ? { conversationId } : undefined) : { since };
  const totals = spend && filter ? spend.totals(filter) : undefined;
  let cost: WindowSummary['cost'];
  if (spend && filter && totals) {
    const view = window === 'today' ? spend.today() : spend.window(window === 'conversation' ? 'conversation' : 'request', filter);
    cost = { text: view.text, tooltip: view.tooltip, source: view.source, confirmedUsd: nanoToUsd(totals.confirmedNanoUsd), pendingUsd: nanoToUsd(totals.pendingNanoUsd + totals.estimatedNanoUsd), near: view.source === 'near' };
  }
  const ledgerTokens = totals && totals.requests > 0;
  return {
    window,
    empty: runs.size === 0,
    runs: runs.size,
    agents: stats.agents,
    time: { generateMs: stats.generateMs, toolMs: stats.toolMs, userWaitMs: stats.userWaitMs, nearWaitMs: stats.nearWaitMs },
    tokens: ledgerTokens ? { input: totals.inputTokens, output: totals.outputTokens, source: 'ledger' } : { input: stats.inputTokens, output: stats.outputTokens, source: 'activity' },
    ...(cost ? { cost } : {}),
    tools: Object.entries(stats.tools).map(([name, count]) => ({ name, ...count })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    approvals: { autoAllowed: stats.approvalsAutoAllowed, asked: stats.approvalsAsked, declined: stats.approvalsDeclined, expired: stats.approvalsExpired },
    problems: { rateLimited: stats.rateLimited, retries: stats.retries, errors: stats.errors, stopped: stats.stopped, toolErrors: stats.toolErrors },
    models: Object.entries(stats.models).map(([model, count]) => ({ model, ...count })).sort((a, b) => (b.rateLimited + b.retries + b.errors) - (a.rateLimited + a.retries + a.errors) || b.agents - a.agents || a.model.localeCompare(b.model))
  };
}

/** The agents running now, oldest first, with their spend so far from the ledger. */
export function nowRows(live: AgentStats[], spend?: OverviewSpend): NowRow[] {
  return live.filter((stat) => stat.status === 'running').sort((a, b) => a.startedAt - b.startedAt).map((stat) => {
    const totals = spend?.totals({ agentId: stat.agentId });
    return {
      agentId: stat.agentId, runId: stat.runId, label: stat.agent, sub: Boolean(stat.parentId), model: stat.model, ...(stat.boundary ? { boundary: stat.boundary } : {}),
      phase: stat.phase, phaseSince: stat.phaseSince, ...(stat.coolUntil ? { coolUntil: stat.coolUntil } : {}), ...(stat.coolReason ? { coolReason: stat.coolReason } : {}), ...(stat.tool ? { tool: stat.tool } : {}),
      startedAt: stat.startedAt, turns: stat.turns, toolCalls: stat.toolCalls, ...(totals?.requests ? { costUsd: nanoToUsd(totalNanoUsd(totals)) } : {})
    };
  });
}

export const HISTORY_PAGE_SIZE = 15;

/** Past (and running) runs, newest first, one page at a time. */
export function historyPage(sessions: ActivitySessionSummary[], page: number, spend?: OverviewSpend, now = Date.now(), size = HISTORY_PAGE_SIZE): HistoryPage {
  const sorted = [...sessions].sort((a, b) => time(b.startedAt) - time(a.startedAt));
  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const current = Math.max(0, Math.min(pages - 1, Math.floor(Number.isFinite(page) ? page : 0)));
  const rows = sorted.slice(current * size, current * size + size).map((session): HistoryRow => {
    const totals = spend && session.runId ? spend.totals({ runId: session.runId }) : undefined;
    const usd = totals?.requests ? nanoToUsd(totalNanoUsd(totals)) : session.actualCostUsd ?? session.estimatedCostUsd;
    const pending = totals ? totals.pendingRequests > 0 || totals.estimatedNanoUsd > 0 : session.actualCostUsd === undefined;
    const ended = session.endedAt ? time(session.endedAt) : session.outcome === 'running' ? now : time(session.updatedAt);
    return {
      sessionId: session.sessionId,
      ...(session.runId ? { runId: session.runId } : {}),
      ...(session.conversationId ? { conversationId: session.conversationId } : {}),
      startedAt: session.startedAt,
      title: session.title ?? (session.plans[0] ? `/${session.plans[0]}` : 'Agent run'),
      agents: session.stats?.agents ?? 1,
      durationMs: Math.max(0, ended - time(session.startedAt)),
      ...(usd !== undefined ? { costUsd: usd, costText: `${usd > 0 && usd < 0.0001 ? '<$0.0001' : `$${usd.toFixed(usd < 1 ? 4 : 2)}`}${usd > 0 && pending ? ' (pending)' : ''}` } : {}),
      outcome: session.runOutcome === 'max-turns' ? 'max-turns' : session.runOutcome ?? session.outcome
    };
  });
  return { rows, page: current, pages, total: sorted.length };
}
