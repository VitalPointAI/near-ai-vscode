import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentRun, AgentRunError, ModelStalledError, type AgentEvent, type AgentRunOptions, type RunOutcome } from '../agent/loop';
import type { PermissionRules } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { agentSystemPrompt } from '../agent/systemPrompt';
import { CORE_TOOLS } from '../agent/tools';
import { unavailableGateRuntime } from '../agent/gateAdapter';
import { projectLabelOf } from '../agent/gateLabels';
import { OutboundFingerprints } from '../agent/outboundCheck';
import { RunGrants } from '../agent/permissions';
import { SessionMark } from '../domain/gate/dominance';
import type { GateRuntime } from '../domain/gate/decide';
import type { ActionPolicy } from '../domain/policy';
import { SpendLimitError, StreamInterruptedError, type AgentMessage, type UsageMetadata } from '../services/nearAiClient';
import { sessionRouteFrom, withSessionRoute } from '../gate/sessionMark';
import { withSpendTag } from '../services/spendLedger';
import type { ComparisonPlan, ResultRow, RowOutcome } from './results';
import type { UseInput } from '../domain/gate/useTier';

/**
 * The use of every Compare Models task request (74.1 D-17, D-18): a comparison on synthetic tasks, in the research workspace's lane, so models approved for
 * research only can be compared; their records say lane t0. Putting a model to work for a job is a separate, approval-checked step.
 */
export const COMPARE_USE: UseInput = Object.freeze({ compare: 'synthetic', lane: 'research' });
import { costOf, gradeTask, runMetrics, setUpTask, type BenchmarkTask } from './tasks';

// Runs benchmark tasks with the extension's own agent loop, tools, system prompt, and permission
// logic, each in a fresh temporary folder outside any workspace that is deleted afterwards. Shared
// by the live eval and SovAI: Compare Models. No VS Code imports.

export type BenchmarkClient = AgentRunOptions['client'] & { actualCostsUsd?(requestIds: string[]): Promise<number | undefined> };

export interface AgentInFolderOptions {
  maxTurns: number;
  signal?: AbortSignal;
  /** Default: fully autonomous, as for an unattended run; the deny list still applies. */
  policy?: ActionPolicy;
  rules: PermissionRules;
  /** What happens to an action still held for approval (default: declined, since nobody is watching). */
  requestApproval?: AgentRunOptions['requestApproval'];
  beforeTurn?: AgentRunOptions['beforeTurn'];
  onEvent?(event: AgentEvent): void;
  /**
   * The gate this run is decided by (GATE-04). The comparison panel and the team studio pass the host's runtime so the decisions reach the project's log.
   * Without one the run is failed closed (`bundle.unavailable`: the floor, reading and planning only), with presence `none` and context `unattended` unless the
   * caller passes `requestApproval`, which means a person answers (D-43): a run nobody watches is never treated as having someone to ask.
   */
  gate?: GateRuntime;
}

/** The gate a run is decided by: the caller's, or the failed-closed runtime of a run with no gate host, with nobody present unless the caller supplied a way to ask one (D-43, T-70-86). */
export function runGateFor(options: Pick<AgentInFolderOptions, 'gate' | 'requestApproval'>): GateRuntime {
  return options.gate ?? unavailableGateRuntime({ presence: options.requestApproval ? 'person' : 'none', context: options.requestApproval ? 'interactive' : 'unattended' });
}

const UNATTENDED: AgentRunOptions['requestApproval'] = async () => ({ decision: 'deny', feedback: 'Nobody is watching this test run, so actions that need approval are declined. Finish without this action if you can.' });

/** Runs the agent non-interactively in `root` and returns the outcome and usage. */
export async function runAgentInFolder(client: BenchmarkClient, model: string, root: string, prompt: string, options: AgentInFolderOptions): Promise<{ outcome: RunOutcome; answer: string; usage: UsageMetadata[]; ms: number; changed: string[] }> {
  const shell = new ShellSession(root);
  const started = Date.now();
  const checkpoints = new RunCheckpoints(`benchmark-${Date.now()}`);
  const gate = runGateFor(options);
  try {
    // A run with no chat starts at the project's resolved label with a mark of its own, raised by its reads and read by its own route (D-54).
    const grants = new RunGrants();
    const mark = new SessionMark(await projectLabelOf(gate, root));
    grants.mark = mark;
    grants.outbound = new OutboundFingerprints();
    const run = new AgentRun({
      client, model, tools: CORE_TOOLS, maxTurns: options.maxTurns,
      context: { root, checkpoints, shell, readFiles: new Set() },
      policy: options.policy ?? { mode: 'fully-autonomous', emergencyStop: false }, rules: options.rules,
      requestApproval: options.requestApproval ?? UNATTENDED, emit: (event) => options.onEvent?.(event),
      gate, grants,
      ...(options.beforeTurn ? { beforeTurn: options.beforeTurn } : {})
    });
    // The production system prompt, so the benchmark measures models as the extension runs them.
    const messages: AgentMessage[] = [{ role: 'system', content: agentSystemPrompt({ root, platform: `${process.platform} ${process.arch}`, date: new Date().toISOString().slice(0, 10), isGitRepo: false, model }) }, { role: 'user', content: prompt }];
    // CLAS-06: every model request of the run (comparison, benchmark and role-suite runs all come here) is routed by a session route built from the run's own
    // gate, so a run with no gate host is decided by the failed-closed policy, and its requests are recorded where its decisions are.
    const result = await withSessionRoute(sessionRouteFrom(gate, { markOf: () => mark.current(), use: COMPARE_USE }), () => run.run(messages, options.signal ?? new AbortController().signal));
    const answer = [...result.messages].reverse().find((message) => message.role === 'assistant' && message.content)?.content ?? '';
    return { outcome: result.outcome, answer: String(answer), usage: result.usage, ms: Date.now() - started, changed: checkpoints.changedFiles };
  } finally {
    shell.dispose();
    await gate.labels?.(root).flushRaises?.().catch(() => undefined);
  }
}

export interface ComparisonOptions {
  /** Tags the spend ledger entries of every request (kind `eval`). */
  runId: string;
  plan: ComparisonPlan;
  tasks: BenchmarkTask[];
  runsPerTask: number;
  clientFor(model: string): BenchmarkClient;
  rules: PermissionRules;
  emergencyStopped(): boolean;
  /** Cancelling it stops the comparison; a string reason is reported as why. */
  signal: AbortSignal;
  /** Checked before each model turn: a reason to stop this one task run (it reached the run budget). */
  overBudget?(runTag: string, usage: UsageMetadata[]): string | undefined;
  /** Checked before each task run and model turn: a reason to stop the whole comparison (e.g. the daily limit). */
  stopAll?(): string | undefined;
  /** Where the temporary task folders go (default: the system temp folder). */
  tempDir?: string;
  /** The gate each task run is decided by, made fresh for each run so a record names the run it belongs to. Without it a run is failed closed (no gate host). */
  gateFor?(run: { model: string; task: string; run: number; root: string }): GateRuntime | undefined | Promise<GateRuntime | undefined>;
  /** Per-task time limit override (tests). */
  timeoutMs?(task: BenchmarkTask): number;
  onRow(row: ResultRow): void | Promise<void>;
  onProgress?(progress: { done: number; total: number; model: string; task: string; run: number }): void;
  now?: () => Date;
}

export interface ComparisonOutcome { status: 'completed' | 'cancelled' | 'stopped'; stopReason?: string }

/** Runs every cell of the plan that is not reused, `runsPerTask` times; a row is reported as each run is graded. */
export async function runComparison(options: ComparisonOptions): Promise<ComparisonOutcome> {
  const now = options.now ?? (() => new Date());
  const work = options.plan.cells.filter((cell) => !cell.reuse);
  const total = work.length * options.runsPerTask;
  let done = 0;
  // Run by run, then task by task, then model by model, so a comparison stopped early still compares every model on what it reached.
  const order: Array<{ model: string; task: BenchmarkTask; run: number }> = [];
  for (let run = 1; run <= options.runsPerTask; run += 1) {
    for (const benchmark of options.tasks) for (const cell of work.filter((candidate) => candidate.task === benchmark.id)) order.push({ model: cell.model, task: benchmark, run });
  }
  for (const step of order) {
    if (options.signal.aborted) return cancelled(options.signal);
    const stop = options.emergencyStopped() ? 'Emergency stop is on.' : options.stopAll?.();
    if (stop) return { status: 'stopped', stopReason: stop };
    options.onProgress?.({ done, total, model: step.model, task: step.task.id, run: step.run });
    const result = await runOne(options, step.model, step.task, step.run, now);
    if (result.kind === 'cancelled') return cancelled(options.signal);
    if (result.kind === 'stopped') return { status: 'stopped', stopReason: result.reason };
    await options.onRow(result.row);
    done += 1;
  }
  options.onProgress?.({ done, total, model: '', task: '', run: 0 });
  return { status: 'completed' };
}

function cancelled(signal: AbortSignal): ComparisonOutcome {
  return { status: 'cancelled', ...(typeof signal.reason === 'string' ? { stopReason: signal.reason } : {}) };
}

async function runOne(options: ComparisonOptions, model: string, benchmark: BenchmarkTask, run: number, now: () => Date): Promise<{ kind: 'row'; row: ResultRow } | { kind: 'cancelled' } | { kind: 'stopped'; reason: string }> {
  const root = await mkdtemp(path.join(options.tempDir ?? tmpdir(), 'near-ai-compare-'));
  const abort = new AbortController();
  const forward = () => abort.abort();
  options.signal.addEventListener('abort', forward, { once: true });
  let timedOut = false;
  let budgetReason: string | undefined;
  let stopReason: string | undefined;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, options.timeoutMs?.(benchmark) ?? benchmark.timeoutMs);
  const usage: UsageMetadata[] = [];
  let stalls = 0;
  const runTag = `${options.runId}/${model}/${benchmark.id}/${run}`;
  const started = Date.now();
  try {
    await setUpTask(benchmark, root);
    const client = options.clientFor(model);
    let outcome: RowOutcome;
    let misses: string[] = [];
    try {
      const gate = await options.gateFor?.({ model, task: benchmark.id, run, root });
      const result = await withSpendTag({ kind: 'eval', runId: runTag }, () => runAgentInFolder(client, model, root, benchmark.prompt, {
        maxTurns: benchmark.maxTurns, signal: abort.signal, rules: options.rules, ...(gate ? { gate } : {}),
        policy: { mode: 'fully-autonomous', emergencyStop: options.emergencyStopped() },
        onEvent: (event) => {
          if (event.type === 'turn') usage.push(event.usage);
          if (event.type === 'retry' && event.stall) stalls += 1;
        },
        beforeTurn: async () => {
          stopReason = options.emergencyStopped() ? 'Emergency stop is on.' : options.stopAll?.();
          budgetReason = stopReason ? undefined : options.overBudget?.(runTag, usage);
          if (stopReason || budgetReason) abort.abort();
        }
      }));
      if (result.outcome === 'cancelled' && !timedOut && !budgetReason) return stopReason ? { kind: 'stopped', reason: stopReason } : { kind: 'cancelled' };
      outcome = timedOut ? 'timed-out' : budgetReason ? 'over-budget' : result.outcome === 'max-turns' || result.outcome === 'stuck' ? 'max-turns' : 'completed';
      if (budgetReason) misses = [budgetReason];
    } catch (error) {
      const cause = error instanceof AgentRunError ? error.cause : error;
      // The daily limit refused the request before it was sent: nothing more can run today.
      if (cause instanceof SpendLimitError) return { kind: 'stopped', reason: cause.message };
      if (options.signal.aborted) return { kind: 'cancelled' };
      outcome = cause instanceof ModelStalledError || cause instanceof StreamInterruptedError ? 'stalled' : 'failed';
      misses = [`${outcome === 'stalled' ? 'stopped responding' : 'error'}: ${(cause instanceof Error ? cause.message : String(cause)).slice(0, 160)}`];
    }
    clearTimeout(timer);
    // Graded as it stands, so a run cut off by the time limit still earns what it finished.
    const graded = await gradeTask(benchmark, root, options.signal);
    if (options.signal.aborted) return { kind: 'cancelled' };
    const metrics = runMetrics(usage);
    const cost = await costOf(client, usage);
    return {
      kind: 'row',
      row: {
        model, task: benchmark.id, kind: benchmark.kind, taskVersion: benchmark.version, run,
        score: graded.score, outOf: graded.outOf, outcome, seconds: Math.round((Date.now() - started) / 1000),
        turns: metrics.turns, inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens, generatingMs: metrics.generatingMs,
        ...(cost.usd !== undefined ? { costUsd: cost.usd } : {}), costEstimated: cost.estimated, stalls,
        misses: [...misses, ...graded.misses], at: now().toISOString()
      }
    };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', forward);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}
