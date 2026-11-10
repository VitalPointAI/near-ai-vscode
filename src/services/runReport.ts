import type { ActivityEvent, ActivitySessionSummary } from '../domain/activity';

// PERF-07: where a project's agent runs spent their time, from the activity history the extension already keeps (.planning/.near-ai/activity.json).
// Pure: it takes the parsed ledger and returns figures and Markdown, so the command, the npm script and the tests all read the same numbers.
// Older logs have no per-run split and kept only their last 100 events per session, so their figures are lower bounds and are labelled as such.

/** A tool call that ran this long (± APPROVAL_TOLERANCE_MS) and failed is the old 15-minute approval timeout. */
export const APPROVAL_TIMEOUT_MS = 15 * 60_000;
const APPROVAL_TOLERANCE_MS = 5_000;

export interface RunRow {
  sessionId: string;
  title: string;
  startedAt: string;
  wallMs: number;
  outcome: string;
  agents: number;
  modelTurns: number;
  toolCalls: number;
  /** From the recorded split when there is one (`split: true`), else estimated from the summed agent counters. */
  modelMs: number;
  toolMs: number;
  approvalWaitMs: number;
  idleMs: number;
  split: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  approvalTimeouts: number;
  reloadKilled: boolean;
  models: string[];
}

export interface RunReport {
  project: string;
  runs: RunRow[];
  totals: { runs: number; wallMs: number; modelMs: number; toolMs: number; approvalWaitMs: number; idleMs: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; approvalTimeouts: number; reloadKilled: number; reloadKilledMs: number };
  model: { calls: number; latencyP50Ms?: number; latencyP90Ms?: number; latencyMaxMs?: number; inputMedian?: number; inputMax?: number; outputMedian?: number; cacheHitCalls: number; cachedShare?: number };
  tools: { calls: number; perModelTurn?: number; maxConcurrentAgents: number };
  models: string[];
  /** Events per session as stored; 100 everywhere means the old cap cut the history. */
  eventsCapped: boolean;
}

/** The value at fraction `p` of sorted numbers (nearest rank), or undefined for none. */
export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const time = (iso: string | undefined): number => { const value = iso ? Date.parse(iso) : NaN; return Number.isFinite(value) ? value : 0; };

/**
 * Tool calls that hit the approval timeout: an end event marked `approval-pending` (this release), or a failed call that ran 15 minutes to within a few
 * seconds. Old logs name neither the call nor its duration on the end event, so starts and ends are paired in order, which is exact for the serial shell.
 */
export function approvalTimeouts(events: ActivityEvent[]): number {
  let found = 0;
  const open: number[] = [];
  for (const event of events) {
    if (event.kind !== 'tool') continue;
    if (event.status === 'running') { open.push(time(event.timestamp)); continue; }
    const started = open.shift();
    if (event.errorCode === 'approval-pending') { found += 1; continue; }
    if (event.status !== 'failed') continue;
    const ran = event.durationMs ?? (started !== undefined ? time(event.timestamp) - started : undefined);
    if (ran !== undefined && Math.abs(ran - APPROVAL_TIMEOUT_MS) <= APPROVAL_TOLERANCE_MS) found += 1;
  }
  return found;
}

function runRow(session: ActivitySessionSummary): RunRow {
  const events = session.events ?? [];
  const startedAt = time(session.startedAt);
  const endedAt = time(session.endedAt) || time(session.updatedAt);
  const wallMs = Math.max(0, endedAt - startedAt);
  const stats = session.stats;
  const modelEvents = events.filter((event) => event.kind === 'model' && event.status === 'completed' && event.summary === 'Model turn completed.');
  const sum = (values: Array<number | undefined>) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
  const fromEvents = { input: sum(modelEvents.map((event) => event.inputTokens)), cached: sum(modelEvents.map((event) => event.cachedInputTokens)), output: sum(modelEvents.map((event) => event.outputTokens)) };
  // Events may be cut (the old 100-event cap); the agents' own counters are not, so the larger count wins. Before PERF-01 an expired approval was
  // counted as `approvalsExpired`; from this release it is `approvalTimeouts`.
  const timeouts = Math.max(approvalTimeouts(events), (stats?.approvalTimeouts ?? 0) + (stats?.approvalsExpired ?? 0));
  const reloadKilled = events.some((event) => /VS Code reloaded/i.test(event.summary)) || /VS Code reloaded/i.test(session.context?.lastEvent ?? '');
  const base = {
    sessionId: session.sessionId, title: session.title ?? session.phase ?? 'Run', startedAt: session.startedAt, wallMs, outcome: session.runOutcome ?? session.outcome,
    agents: stats?.agents ?? 0, modelTurns: Math.max(stats?.turns ?? 0, modelEvents.length), toolCalls: Math.max(stats?.toolCalls ?? 0, events.filter((event) => event.kind === 'tool' && event.status === 'running').length),
    approvalTimeouts: timeouts, reloadKilled, models: session.models ?? []
  };
  if (session.run) {
    return { ...base, modelMs: session.run.modelMs, toolMs: session.run.toolMs, approvalWaitMs: session.run.approvalWaitMs, idleMs: session.run.idleMs, split: true, inputTokens: session.run.inputTokens, cachedInputTokens: session.run.cachedInputTokens, outputTokens: session.run.outputTokens };
  }
  // No recorded split (logs written before PERF-07): estimate from the counters summed over the run's agents. Parallel agents make those sums exceed the
  // wall time, so the three parts are scaled down together to fit it, and what is left is idle.
  const parts = { model: (stats?.generateMs ?? 0) + (stats?.nearWaitMs ?? 0), approval: stats?.userWaitMs ?? 0, tool: stats?.toolMs ?? 0 };
  const summed = parts.model + parts.approval + parts.tool;
  const scale = summed > wallMs && summed > 0 ? wallMs / summed : 1;
  const modelMs = Math.round(parts.model * scale);
  const approvalWaitMs = Math.round(parts.approval * scale);
  const toolMs = Math.round(parts.tool * scale);
  return {
    ...base, modelMs, toolMs, approvalWaitMs, idleMs: Math.max(0, wallMs - modelMs - approvalWaitMs - toolMs), split: false,
    inputTokens: Math.max(stats?.inputTokens ?? 0, fromEvents.input), cachedInputTokens: Math.max(stats?.cachedInputTokens ?? 0, fromEvents.cached), outputTokens: Math.max(stats?.outputTokens ?? 0, fromEvents.output)
  };
}

/** The report for one project's activity ledger (`{ version, sessions }`). */
export function runPerformanceReport(ledger: { sessions?: ActivitySessionSummary[] }, project = ledger.sessions?.[0]?.project ?? 'project'): RunReport {
  const sessions = (ledger.sessions ?? []).filter((session) => session && typeof session.sessionId === 'string');
  const runs = sessions.map(runRow).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const add = (key: keyof RunReport['totals'] & keyof RunRow) => runs.reduce((total, run) => total + Number(run[key] ?? 0), 0);
  const killed = runs.filter((run) => run.reloadKilled);
  const modelEvents = sessions.flatMap((session) => (session.events ?? []).filter((event) => event.kind === 'model' && event.status === 'completed' && event.summary === 'Model turn completed.'));
  const latencies = modelEvents.map((event) => event.durationMs).filter((value): value is number => typeof value === 'number');
  const inputs = modelEvents.map((event) => event.inputTokens).filter((value): value is number => typeof value === 'number');
  const outputs = modelEvents.map((event) => event.outputTokens).filter((value): value is number => typeof value === 'number');
  const cached = modelEvents.reduce((total, event) => total + (event.cachedInputTokens ?? 0), 0);
  const inputTotal = inputs.reduce((total, value) => total + value, 0);
  const toolStarts = sessions.reduce((total, session) => total + (session.events ?? []).filter((event) => event.kind === 'tool' && event.status === 'running').length, 0);
  const models = [...new Set(sessions.flatMap((session) => session.models ?? []))].sort();
  return {
    project,
    runs,
    totals: { runs: runs.length, wallMs: add('wallMs'), modelMs: add('modelMs'), toolMs: add('toolMs'), approvalWaitMs: add('approvalWaitMs'), idleMs: add('idleMs'), inputTokens: add('inputTokens'), cachedInputTokens: add('cachedInputTokens'), outputTokens: add('outputTokens'), approvalTimeouts: add('approvalTimeouts'), reloadKilled: killed.length, reloadKilledMs: killed.reduce((total, run) => total + run.wallMs, 0) },
    model: {
      calls: modelEvents.length, latencyP50Ms: percentile(latencies, 0.5), latencyP90Ms: percentile(latencies, 0.9), latencyMaxMs: latencies.length ? Math.max(...latencies) : undefined,
      inputMedian: percentile(inputs, 0.5), inputMax: inputs.length ? Math.max(...inputs) : undefined, outputMedian: percentile(outputs, 0.5),
      cacheHitCalls: modelEvents.filter((event) => (event.cachedInputTokens ?? 0) > 0 || event.cacheHit === true).length, cachedShare: inputTotal ? cached / inputTotal : undefined
    },
    tools: { calls: toolStarts, perModelTurn: modelEvents.length ? toolStarts / modelEvents.length : undefined, maxConcurrentAgents: Math.max(0, ...sessions.map((session) => session.stats?.agents ?? 0)) },
    models,
    eventsCapped: sessions.some((session) => (session.events ?? []).length === 100)
  };
}

const minutes = (ms: number): string => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
const seconds = (ms: number | undefined): string => (ms === undefined ? '–' : `${(ms / 1000).toFixed(0)} s`);
const thousands = (value: number | undefined): string => (value === undefined ? '–' : Math.round(value).toLocaleString('en-US'));
const share = (part: number, whole: number): string => (whole > 0 ? `${Math.round((100 * part) / whole)}%` : '–');

/** The report as Markdown, for the command's document and the npm script. */
export function formatRunReport(report: RunReport): string {
  const t = report.totals;
  const lines = [
    `# Run performance: ${report.project}`,
    '',
    `${t.runs} run${t.runs === 1 ? '' : 's'}, ${minutes(t.wallMs)} of wall time.${report.eventsCapped ? ' Some sessions hold exactly 100 events: this log was written with the old 100-event cap, so event-based counts are lower bounds.' : ''}`,
    '',
    '## Where the time went',
    '',
    '| Part | Time | Share |',
    '| --- | --- | --- |',
    `| Model wait | ${minutes(t.modelMs)} | ${share(t.modelMs, t.wallMs)} |`,
    `| Tools (sub-agents included) | ${minutes(t.toolMs)} | ${share(t.toolMs, t.wallMs)} |`,
    `| Approval wait | ${minutes(t.approvalWaitMs)} | ${share(t.approvalWaitMs, t.wallMs)} |`,
    `| Idle | ${minutes(t.idleMs)} | ${share(t.idleMs, t.wallMs)} |`,
    '',
    '## Tokens and model calls',
    '',
    `- Input ${thousands(t.inputTokens)}, of which cached ${thousands(t.cachedInputTokens)} (${share(t.cachedInputTokens, t.inputTokens)}); output ${thousands(t.outputTokens)}.`,
    `- Model calls in the log: ${report.model.calls}; latency p50 ${seconds(report.model.latencyP50Ms)}, p90 ${seconds(report.model.latencyP90Ms)}, max ${seconds(report.model.latencyMaxMs)}.`,
    `- Input tokens per call: median ${thousands(report.model.inputMedian)}, max ${thousands(report.model.inputMax)}; output median ${thousands(report.model.outputMedian)}.`,
    `- Calls with prompt-cache hits: ${report.model.cacheHitCalls} of ${report.model.calls}.`,
    `- Tool calls: ${report.tools.calls} (${report.tools.perModelTurn === undefined ? '–' : report.tools.perModelTurn.toFixed(2)} per model call); most agents in one run: ${report.tools.maxConcurrentAgents}.`,
    `- Models: ${report.models.join(', ') || '–'}.`,
    '',
    '## Stalls',
    '',
    `- Approval timeouts (an approval nobody answered: the old ${APPROVAL_TIMEOUT_MS / 60_000}-minute expiry, or "awaiting approval" from this release): ${t.approvalTimeouts}.`,
    `- Runs ended by a VS Code reload: ${t.reloadKilled} (${minutes(t.reloadKilledMs)} of work cut off).`,
    '',
    '## Runs',
    '',
    '| Started | Run | Outcome | Wall | Model | Tools | Approval | Idle | Input | Cached | Output | Timeouts |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.runs.map((run) => `| ${run.startedAt.slice(0, 16).replace('T', ' ')} | ${run.title.replace(/\|/g, '/').slice(0, 50)}${run.split ? '' : ' (est.)'}${run.reloadKilled ? ' (reload)' : ''} | ${run.outcome} | ${minutes(run.wallMs)} | ${minutes(run.modelMs)} | ${minutes(run.toolMs)} | ${minutes(run.approvalWaitMs)} | ${minutes(run.idleMs)} | ${thousands(run.inputTokens)} | ${thousands(run.cachedInputTokens)} | ${thousands(run.outputTokens)} | ${run.approvalTimeouts} |`),
    '',
    'Runs marked (est.) were recorded before per-run splits existed; their split is estimated from the agents\' summed counters.'
  ];
  return `${lines.join('\n')}\n`;
}
