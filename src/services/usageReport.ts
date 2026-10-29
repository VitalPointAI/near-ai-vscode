import type { ActivitySessionSummary } from '../domain/activity';
import { redactForDisplay } from './agentActivity';
import { DayBoundary, dayStart, nanoToUsd, SpendEntry } from './spendLedger';

// "Export usage and activity": per run and per model, from the projects' activity history and the
// key's spend ledger. Ids, counts, model names, costs, and each run's redacted first line only;
// never prompt or reply content. No VS Code API here.

export interface UsageFilter {
  /** An organization profile ID from the sessions' attribution; undefined for all. */
  organizationProfileId?: string;
  /** A workspace project's root (as UsageProject.root); undefined for all. */
  projectRoot?: string;
  /** Inclusive start and exclusive end, ms. */
  since: number;
  until: number;
}

export interface UsageProject { root: string; label: string; sessions: ActivitySessionSummary[] }

export interface UsageRunRow {
  time: string;
  organization: string;
  project: string;
  conversationId: string;
  runId: string;
  title: string;
  agents: number;
  models: string;
  inputTokens: number;
  outputTokens: number;
  confirmedUsd: number;
  pendingUsd: number;
  outcome: string;
}

export interface UsageModelRow {
  model: string;
  runs: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  confirmedUsd: number;
  pendingUsd: number;
  rateLimited: number;
  retries: number;
  errors: number;
}

export interface UsageReport {
  exportedAt: string;
  range: { since: string; until: string };
  filter: { organization: string; project: string };
  totals: { runs: number; requests: number; inputTokens: number; outputTokens: number; confirmedUsd: number; pendingUsd: number; nearUsd?: number; costText: string };
  runs: UsageRunRow[];
  models: UsageModelRow[];
}

export type UsageRange = 'today' | 'week' | 'month';

/** Today, the last 7 days, or the last 30 days (both including today), ending now. */
export function usageRange(range: UsageRange, now: number, boundary: DayBoundary): { since: number; until: number } {
  const start = dayStart(now, boundary);
  if (range === 'today') return { since: start, until: now + 1 };
  const date = new Date(start);
  const back = range === 'week' ? 6 : 29;
  if (boundary === 'utc') date.setUTCDate(date.getUTCDate() - back); else date.setDate(date.getDate() - back);
  return { since: date.getTime(), until: now + 1 };
}

/** A custom range from two YYYY-MM-DD dates, both days included; undefined when either is not a date or they are reversed. */
export function customRange(from: string, to: string, boundary: DayBoundary): { since: number; until: number } | undefined {
  const day = (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) return undefined;
    const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
    const at = boundary === 'utc' ? Date.UTC(year, month, date) : new Date(year, month, date).getTime();
    const check = new Date(at);
    const same = boundary === 'utc' ? check.getUTCFullYear() === year && check.getUTCMonth() === month && check.getUTCDate() === date : check.getFullYear() === year && check.getMonth() === month && check.getDate() === date;
    return same ? at : undefined;
  };
  const since = day(from);
  const last = day(to);
  if (since === undefined || last === undefined || last < since) return undefined;
  const end = new Date(last);
  if (boundary === 'utc') end.setUTCDate(end.getUTCDate() + 1); else end.setDate(end.getDate() + 1);
  return { since, until: end.getTime() };
}

/** Organizations seen in the projects' history, for the picker. */
export function usageOrganizations(projects: UsageProject[]): Array<{ id: string; label: string }> {
  const seen = new Map<string, string>();
  for (const project of projects) for (const session of project.sessions) {
    const attribution = session.attribution;
    if (attribution?.status === 'attributed' && !seen.has(attribution.organizationProfileId)) seen.set(attribution.organizationProfileId, attribution.organizationDisplayName);
  }
  return [...seen].map(([id, label]) => ({ id, label }));
}

const at = (value: string) => { const time = Date.parse(value); return Number.isFinite(time) ? time : 0; };
const usd = (nano: number) => Math.round(nanoToUsd(nano) * 1e6) / 1e6;
const clean = (value: string | undefined, max = 160) => value ? redactForDisplay(value).replace(/[\r\n\t]+/g, ' ').slice(0, max) : '';

/** A ledger entry's cost, counted once per NEAR request ID: confirmed once NEAR reported it, else pending at the estimate. */
function costs(entries: SpendEntry[]): Map<SpendEntry, { confirmed: number; pending: number }> {
  const counted = new Set<string>();
  const out = new Map<SpendEntry, { confirmed: number; pending: number }>();
  for (const entry of entries) {
    if (entry.requestId && counted.has(entry.requestId)) { out.set(entry, { confirmed: 0, pending: 0 }); continue; }
    if (entry.requestId) counted.add(entry.requestId);
    out.set(entry, entry.actualNanoUsd !== undefined ? { confirmed: entry.actualNanoUsd, pending: 0 } : { confirmed: 0, pending: entry.estimateNanoUsd });
  }
  return out;
}

export function buildUsageReport(input: { projects: UsageProject[]; entries: SpendEntry[]; filter: UsageFilter; now?: number; organizationLabel?: string; projectLabel?: string; nearTodayUsd?: number }): UsageReport {
  const { filter } = input;
  const inRange = (time: number) => time >= filter.since && time < filter.until;
  const projects = input.projects.filter((project) => !filter.projectRoot || project.root === filter.projectRoot);
  const sessions = projects.flatMap((project) => project.sessions.map((session) => ({ project, session })))
    .filter(({ session }) => inRange(at(session.startedAt)) && (!filter.organizationProfileId || (session.attribution?.status === 'attributed' && session.attribution.organizationProfileId === filter.organizationProfileId)))
    .sort((a, b) => at(b.session.startedAt) - at(a.session.startedAt));
  const runIds = new Set(sessions.map(({ session }) => session.runId).filter((id): id is string => Boolean(id)));
  // With a project or organization chosen, only the ledger entries of its runs; otherwise everything this key spent in the range.
  const scoped = Boolean(filter.projectRoot || filter.organizationProfileId);
  const entries = input.entries.filter((entry) => inRange(entry.at) && (!scoped || (entry.runId !== undefined && runIds.has(entry.runId))));
  const cost = costs(entries);
  const byRun = new Map<string, SpendEntry[]>();
  for (const entry of entries) if (entry.runId) (byRun.get(entry.runId) ?? byRun.set(entry.runId, []).get(entry.runId)!).push(entry);
  const runs: UsageRunRow[] = sessions.map(({ project, session }) => {
    const spent = session.runId ? byRun.get(session.runId) ?? [] : [];
    const sum = (pick: (entry: SpendEntry) => number) => spent.reduce((total, entry) => total + pick(entry), 0);
    const models = [...new Set([...Object.keys(session.stats?.models ?? {}), ...spent.map((entry) => entry.model).filter((model): model is string => Boolean(model)), ...session.models])];
    return {
      time: session.startedAt,
      organization: session.attribution?.status === 'attributed' ? clean(session.attribution.organizationDisplayName, 120) : 'Unknown organization',
      project: clean(session.attribution?.status === 'attributed' ? session.attribution.projectLabel : project.label, 160),
      conversationId: session.conversationId ?? '',
      runId: session.runId ?? session.sessionId,
      title: clean(session.title, 100),
      agents: session.stats?.agents ?? 1,
      models: models.join(' '),
      inputTokens: spent.length ? sum((entry) => entry.inputTokens ?? 0) : session.stats?.inputTokens ?? 0,
      outputTokens: spent.length ? sum((entry) => entry.outputTokens ?? 0) : session.stats?.outputTokens ?? 0,
      confirmedUsd: usd(sum((entry) => cost.get(entry)!.confirmed)),
      pendingUsd: usd(sum((entry) => cost.get(entry)!.pending)),
      outcome: session.runOutcome ?? session.outcome
    };
  });
  const models = new Map<string, UsageModelRow & { runSet: Set<string> }>();
  const model = (name: string) => { let row = models.get(name); if (!row) { row = { model: name, runs: 0, requests: 0, inputTokens: 0, outputTokens: 0, confirmedUsd: 0, pendingUsd: 0, rateLimited: 0, retries: 0, errors: 0, runSet: new Set() }; models.set(name, row); } return row; };
  for (const entry of entries) {
    const row = model(clean(entry.model, 160) || 'unknown');
    row.requests += 1;
    row.inputTokens += entry.inputTokens ?? 0;
    row.outputTokens += entry.outputTokens ?? 0;
    row.confirmedUsd += nanoToUsd(cost.get(entry)!.confirmed);
    row.pendingUsd += nanoToUsd(cost.get(entry)!.pending);
    if (entry.runId) row.runSet.add(entry.runId);
  }
  for (const { session } of sessions) for (const [name, counters] of Object.entries(session.stats?.models ?? {})) {
    const row = model(name);
    row.rateLimited += counters.rateLimited;
    row.retries += counters.retries;
    row.errors += counters.errors;
    row.runSet.add(session.runId ?? session.sessionId);
  }
  const modelRows = [...models.values()].map(({ runSet, ...row }) => ({ ...row, runs: runSet.size, confirmedUsd: Math.round(row.confirmedUsd * 1e6) / 1e6, pendingUsd: Math.round(row.pendingUsd * 1e6) / 1e6 })).sort((a, b) => (b.confirmedUsd + b.pendingUsd) - (a.confirmedUsd + a.pendingUsd) || a.model.localeCompare(b.model));
  const all = [...cost.values()];
  const confirmedUsd = usd(all.reduce((total, value) => total + value.confirmed, 0));
  const pendingUsd = usd(all.reduce((total, value) => total + value.pending, 0));
  // NEAR's own figure covers the key's whole day on every computer, so it is shown only for today, unfiltered.
  const near = !scoped && input.nearTodayUsd !== undefined ? input.nearTodayUsd : undefined;
  const costText = near !== undefined ? `$${near.toFixed(2)} (NEAR)` : `$${confirmedUsd.toFixed(4)} confirmed${pendingUsd > 0 ? ` + ~$${pendingUsd.toFixed(4)} pending` : ''}`;
  return {
    exportedAt: new Date(input.now ?? Date.now()).toISOString(),
    range: { since: new Date(filter.since).toISOString(), until: new Date(filter.until).toISOString() },
    filter: { organization: clean(input.organizationLabel ?? (filter.organizationProfileId ? filter.organizationProfileId : 'All organizations (this computer)'), 120), project: clean(input.projectLabel ?? (filter.projectRoot ? projects[0]?.label : 'All projects'), 160) },
    totals: { runs: runs.length, requests: entries.length, inputTokens: entries.reduce((total, entry) => total + (entry.inputTokens ?? 0), 0), outputTokens: entries.reduce((total, entry) => total + (entry.outputTokens ?? 0), 0), confirmedUsd, pendingUsd, ...(near !== undefined ? { nearUsd: near } : {}), costText },
    runs,
    models: modelRows
  };
}

const RUN_COLUMNS: Array<keyof UsageRunRow> = ['time', 'organization', 'project', 'conversationId', 'runId', 'title', 'agents', 'models', 'inputTokens', 'outputTokens', 'confirmedUsd', 'pendingUsd', 'outcome'];
const MODEL_COLUMNS: Array<keyof UsageModelRow> = ['model', 'runs', 'requests', 'inputTokens', 'outputTokens', 'confirmedUsd', 'pendingUsd', 'rateLimited', 'retries', 'errors'];

/** A CSV cell: quoted when needed, and never read as a formula by a spreadsheet. */
function cell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text) && typeof value === 'string') text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV with a `kind` column: a row per run, then a row per model, then the totals. */
export function usageCsv(report: UsageReport): string {
  const columns = ['kind', ...new Set([...RUN_COLUMNS, ...MODEL_COLUMNS])] as string[];
  const row = (kind: string, values: Record<string, unknown>) => columns.map((column) => cell(column === 'kind' ? kind : values[column])).join(',');
  const lines = [columns.join(',')];
  for (const run of report.runs) lines.push(row('run', run as unknown as Record<string, unknown>));
  for (const model of report.models) lines.push(row('model', model as unknown as Record<string, unknown>));
  lines.push(row('total', { time: report.range.since, organization: report.filter.organization, project: report.filter.project, runs: report.totals.runs, requests: report.totals.requests, inputTokens: report.totals.inputTokens, outputTokens: report.totals.outputTokens, confirmedUsd: report.totals.confirmedUsd, pendingUsd: report.totals.pendingUsd, title: report.totals.costText }));
  return `${lines.join('\r\n')}\r\n`;
}

export function usageJson(report: UsageReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
