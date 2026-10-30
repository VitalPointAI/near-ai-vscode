import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { estimateComparisonCost, latestResults, planComparison, reusedRows, runIdFor, savedModel, type SavedRun } from '../benchmark/results';
import { runComparison } from '../benchmark/runner';
import { ComparisonStore } from '../benchmark/store';
import { loadBenchmarkTasks, tasksFor, type BenchmarkTask } from '../benchmark/tasks';
import { spendAccountOf } from './agentSession';
import type { AuthService } from './auth';
import { providerErrorMessage } from './chatBridge';
import { isEmergencyStopped, onDidChangeEmergencyStop } from './emergencyStop';
import { catalogEntries, comparisonPageHtml, defaultSelection, estimateView, historyEntries, leaderboardRows, parseComparisonMessage, reportView, selectionProblem, taskSetsView, type PageState, type Selection } from './modelComparisonPage';
import { privacyWarning, roleOptions, roleUpdate, type RoleOption } from './modelRoles';
import type { ModelInfo, UsageMetadata } from './nearAiClient';
import { activeProvider, clientFor, type ActiveProvider } from './providerCache';
import { readAgentRules, readModelTiers, readRoleModels, readRunBudget, readSettings } from './settings';
import { nanoToUsd, totalNanoUsd } from './spendLedger';

// NEAR AI: Compare Models. A tab that ranks every model tested on this computer, runs new
// comparisons (only what has no saved result, or everything again), saves each one as it goes,
// and puts a model into a role with one click. Runs use the extension's agent loop and permission
// rules in temporary folders outside the workspace, and are billed to the key's spend ledger as `eval`.

/** For the extension-host tests: messages to and from the page. */
export const comparisonTap: { toView?: (message: unknown) => void; fromView?: (message: unknown) => void } = {};

interface Gathered { state: PageState; active?: ActiveProvider; models: ModelInfo[]; tasks: BenchmarkTask[]; runs: SavedRun[]; roles: RoleOption[] }

let panel: vscode.WebviewPanel | undefined;
let post: (message: Record<string, unknown>) => void = () => undefined;
/** A comparison keeps running when the tab is closed; reopening the tab shows it. */
let running: { runId: string; abort: AbortController; saved: SavedRun; done: number; total: number; current?: { model: string; task: string; run: number } } | undefined;
let tasksLoaded: Promise<BenchmarkTask[]> | undefined;
const undo = new Map<string, { setting: string; previous: unknown; target: vscode.ConfigurationTarget; label: string }>();

const storeFor = (context: vscode.ExtensionContext) => new ComparisonStore(path.join(context.globalStorageUri.fsPath, 'evals'));
const benchmarkTasks = () => (tasksLoaded ??= loadBenchmarkTasks().catch((error: unknown) => { tasksLoaded = undefined; throw error; }));

export function registerModelComparison(context: vscode.ExtensionContext, auth: AuthService): void {
  context.subscriptions.push(vscode.commands.registerCommand('nearAi.compareModels', () => openModelComparison(context, auth)));
}

async function gather(context: vscode.ExtensionContext, auth: AuthService): Promise<Gathered> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const settings = readSettings();
  let problem: string | undefined;
  const active = root ? await activeProvider(root, auth).catch((error: unknown) => { problem = providerErrorMessage(error); return undefined; }) : undefined;
  if (!root) problem = 'Open a folder with a NEAR AI profile to test models. Results saved earlier are shown below.';
  else if (!active && !problem) problem = 'Set up a NEAR AI profile for this project (NEAR AI: Set Up) to test models.';
  const models = active?.models ?? [];
  const roles = roleOptions({ mainModel: settings.defaultModel, tiers: readModelTiers(), roleModels: readRoleModels() }, models);
  const teeOnly = settings.privacyMode === 'tee-only';
  const catalog = catalogEntries(models, roles, teeOnly);
  const [tasks, runs] = await Promise.all([benchmarkTasks(), storeFor(context).list()]);
  return {
    active, models, tasks, runs, roles,
    state: {
      leaderboard: leaderboardRows(runs, tasks, models, roles, Date.now()), catalog, selected: defaultSelection(roles, catalog), roles,
      taskSets: taskSetsView(tasks), history: historyEntries(runs), ...(running ? { running: { runId: running.runId } } : {}), teeOnly, ...(problem ? { problem } : {})
    }
  };
}

/** Opens (or shows) the Compare Models tab. */
export function openModelComparison(context: vscode.ExtensionContext, auth: AuthService): vscode.WebviewPanel {
  if (panel) { panel.reveal(); return panel; }
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'compare');
  const view = vscode.window.createWebviewPanel('nearAiCompareModels', 'Compare Models', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true });
  panel = view;
  view.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'near-ai-vscode-icon.png');
  const asset = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  view.webview.html = comparisonPageHtml({ cspSource: view.webview.cspSource, nonce: randomBytes(16).toString('base64'), script: asset('compare.js'), style: asset('compare.css') });
  post = (message) => { comparisonTap.toView?.(message); void view.webview.postMessage(message); };
  let shown: SavedRun | undefined;
  const refresh = async () => {
    try {
      const gathered = await gather(context, auth);
      post({ type: 'state', state: gathered.state });
      if (running) post({ type: 'progress', done: running.done, total: running.total, ...(running.current ? { current: running.current } : {}) });
      const report = running?.saved ?? shown;
      if (report) post({ type: 'report', ...reportView(report, gathered.models, gathered.roles) });
    } catch (error) {
      post({ type: 'error', text: providerErrorMessage(error) });
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = undefined; void refresh(); }, 150); };
  const subscriptions = [
    vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('nearAi')) soon(); }),
    view.webview.onDidReceiveMessage(async (raw: unknown) => {
      comparisonTap.fromView?.(raw);
      const message = parseComparisonMessage(raw);
      if (!message) return;
      try {
        switch (message.type) {
          case 'ready': case 'refresh': await refresh(); break;
          case 'plan': await sendEstimate(context, auth, message); break;
          case 'start': await start(context, auth, message, (saved) => { shown = saved; }); break;
          case 'cancel': running?.abort.abort('You cancelled the comparison.'); break;
          case 'open-run': {
            const saved = await storeFor(context).load(message.id);
            if (!saved) { post({ type: 'error', text: 'That saved comparison could not be read.' }); break; }
            shown = saved;
            const gathered = await gather(context, auth);
            post({ type: 'report', ...reportView(saved, gathered.models, gathered.roles) });
            break;
          }
          case 'export': await exportRun(context, message.id); break;
          case 'apply-role': await applyRole(context, auth, message.model, message.role); break;
          case 'undo-role': await undoRole(message.token); break;
        }
      } catch (error) {
        post({ type: 'error', text: providerErrorMessage(error) });
      }
    })
  ];
  view.onDidDispose(() => {
    if (timer) clearTimeout(timer);
    for (const subscription of subscriptions) subscription.dispose();
    panel = undefined;
    post = () => undefined;
  });
  return view;
}

async function planFor(context: vscode.ExtensionContext, auth: AuthService, picked: Selection) {
  const gathered = await gather(context, auth);
  const tasks = tasksFor(picked.taskSet, gathered.tasks);
  const plan = planComparison(picked.models, tasks, picked.runs, picked.mode, latestResults(gathered.runs));
  const estimate = estimateComparisonCost(plan, tasks, picked.runs, gathered.models);
  return { gathered, tasks, plan, estimate, problem: selectionProblem(picked.models, gathered.state.catalog) };
}

async function sendEstimate(context: vscode.ExtensionContext, auth: AuthService, picked: Selection): Promise<void> {
  const { plan, estimate, problem } = await planFor(context, auth, picked);
  post({ type: 'estimate', ...estimateView(plan, estimate), ...(problem ? { problem } : {}) });
}

const money = (usd: number) => `$${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}`;

async function start(context: vscode.ExtensionContext, auth: AuthService, picked: Selection, show: (saved: SavedRun) => void): Promise<void> {
  if (running) { post({ type: 'error', text: 'A comparison is already running. Cancel it first to start another.' }); return; }
  if (isEmergencyStopped()) { post({ type: 'error', text: 'Emergency stop is on, so nothing runs. Resume NEAR AI first.' }); return; }
  const { gathered, tasks, plan, estimate, problem } = await planFor(context, auth, picked);
  const active = gathered.active;
  if (problem || !active) { post({ type: 'error', text: problem ?? gathered.state.problem ?? 'NEAR AI is not set up for this project.' }); return; }
  if (plan.toRun > 0) {
    const reused = plan.reusedCells ? ` ${plan.reusedCells} model-task result${plan.reusedCells === 1 ? '' : 's'} saved earlier will be reused at no cost.` : '';
    const unpriced = estimate.unpriced.length ? ` Not included (no published prices): ${estimate.unpriced.join(', ')}.` : '';
    const choice = await vscode.window.showWarningMessage(
      `Compare ${picked.models.length} models with ${plan.toRun} task run${plan.toRun === 1 ? '' : 's'}? Estimated cost: about ${money(estimate.usd)} of NEAR AI credit.${unpriced}${reused}`,
      { modal: true, detail: 'This spends real credit from your key. The estimate is rough: a model that takes more steps costs more. Each task run is stopped at your per-run cost limit (nearAi.agent.maxRunCostUsd), and the whole comparison stops at your daily limit.' },
      'Start comparison'
    );
    if (choice !== 'Start comparison') return;
  }
  const store = storeFor(context);
  const now = new Date();
  const runId = await store.newId(runIdFor(now));
  const saved: SavedRun = {
    format: 'near-ai-model-comparison', version: 1, id: runId, startedAt: now.toISOString(), status: 'running', taskSet: picked.taskSet, mode: picked.mode, runsPerTask: picked.runs,
    models: picked.models.map((model) => savedModel(gathered.models.find((info) => info.id === model) ?? { id: model })),
    tasks: tasks.map((task) => ({ id: task.id, kind: task.kind, version: task.version })),
    rows: plan.cells.flatMap((cell) => (cell.reuse ? reusedRows(cell.reuse) : []))
  };
  await store.save(saved);
  show(saved);
  const abort = new AbortController();
  running = { runId, abort, saved, done: 0, total: plan.toRun };
  const stopListener = onDidChangeEmergencyStop((engaged) => { if (engaged) abort.abort('Emergency stop is on.'); });
  const account = spendAccountOf(active.provider.client);
  await account?.ledger.refresh();
  const reportNow = () => post({ type: 'report', ...reportView(saved, gathered.models, gathered.roles) });
  reportNow();
  try {
    const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Comparing models', cancellable: true }, async (progress, token) => {
      token.onCancellationRequested(() => abort.abort('You cancelled the comparison.'));
      return runComparison({
        runId, plan, tasks, runsPerTask: picked.runs, signal: abort.signal, rules: readAgentRules(), emergencyStopped: isEmergencyStopped,
        clientFor: (model) => clientFor(active, model).client,
        overBudget: (runTag, usage) => overBudget(account, runTag, usage),
        stopAll: () => {
          const reached = account?.limitReached();
          return reached ? `Today's NEAR AI spend ($${reached.spentUsd.toFixed(2)}) reached your daily limit of $${reached.limitUsd.toFixed(2)} (nearAi.dailySpendLimitUsd).` : undefined;
        },
        onProgress: (step) => {
          if (!running) return;
          running.done = step.done;
          running.current = step.model ? { model: step.model, task: step.task, run: step.run } : undefined;
          if (step.model) progress.report({ message: `${step.done + 1} of ${step.total}: ${step.model} on ${step.task}` });
          post({ type: 'progress', done: step.done, total: step.total, ...(running.current ? { current: running.current } : {}) });
        },
        onRow: async (row) => {
          saved.rows.push(row);
          // Saved after every result, so closing VS Code mid-comparison keeps what finished.
          await store.save(saved);
          reportNow();
        }
      });
    });
    saved.status = outcome.status;
    if (outcome.stopReason) saved.stopReason = outcome.stopReason;
  } catch (error) {
    saved.status = 'stopped';
    saved.stopReason = providerErrorMessage(error);
  } finally {
    stopListener.dispose();
    saved.finishedAt = new Date().toISOString();
    await store.save(saved).catch(() => undefined);
    running = undefined;
  }
  post({ type: 'finished', status: saved.status, ...(saved.stopReason ? { stopReason: saved.stopReason } : {}) });
  if (panel) {
    const refreshed = await gather(context, auth);
    post({ type: 'state', state: refreshed.state });
    post({ type: 'report', ...reportView(saved, refreshed.models, refreshed.roles) });
  }
  const text = saved.status === 'completed' ? 'Model comparison finished.' : `Model comparison ${saved.status === 'cancelled' ? 'cancelled' : 'stopped'}${saved.stopReason ? `: ${saved.stopReason}` : '.'} What finished is saved.`;
  void vscode.window.showInformationMessage(text, 'Show results').then((choice) => { if (choice) void vscode.commands.executeCommand('nearAi.compareModels'); });
}

/** The run budget, as for a chat run: a task run stops once its cost reaches nearAi.agent.maxRunCostUsd (or its unpriced tokens nearAi.agent.maxRunTokens). */
function overBudget(account: ReturnType<typeof spendAccountOf>, runTag: string, usage: UsageMetadata[]): string | undefined {
  const budget = readRunBudget();
  const cost = account ? nanoToUsd(totalNanoUsd(account.totals({ runId: runTag }))) : usage.reduce((sum, turn) => sum + (turn.estimatedCostUsd ?? 0), 0);
  if (cost >= budget.maxCostUsd) return `stopped at the per-run cost limit of $${budget.maxCostUsd.toFixed(2)} (nearAi.agent.maxRunCostUsd)`;
  const unpriced = usage.filter((turn) => turn.estimatedCostUsd === undefined).reduce((sum, turn) => sum + (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0), 0);
  if (unpriced >= budget.maxTokens) return `stopped at the per-run token limit of ${budget.maxTokens.toLocaleString('en-US')} (nearAi.agent.maxRunTokens)`;
  return undefined;
}

async function exportRun(context: vscode.ExtensionContext, id: string): Promise<void> {
  const saved = running?.saved.id === id ? running.saved : await storeFor(context).load(id);
  if (!saved) { post({ type: 'error', text: 'That saved comparison could not be read.' }); return; }
  const target = await vscode.window.showSaveDialog({ title: 'Export model comparison', defaultUri: vscode.Uri.file(path.join(homedir(), `near-ai-model-comparison-${id}.json`)), filters: { JSON: ['json'] } });
  if (!target) return;
  await writeFile(target.fsPath, `${JSON.stringify(saved, null, 2)}\n`, 'utf8');
  post({ type: 'notice', text: `Exported to ${target.fsPath}.` });
}

async function applyRole(context: vscode.ExtensionContext, auth: AuthService, model: string, roleId: string): Promise<void> {
  const gathered = await gather(context, auth);
  const option = gathered.roles.find((role) => role.id === roleId);
  const entry = gathered.state.catalog.find((candidate) => candidate.id === model);
  if (!option) { post({ type: 'error', text: 'That role is not available.' }); return; }
  if (!entry) { post({ type: 'error', text: `${model} is not in your key’s model list, so it cannot be used.` }); return; }
  if (entry.blocked) { post({ type: 'error', text: `TEE-only mode is on, so ${model}, which is not private, cannot be used.` }); return; }
  const configuration = vscode.workspace.getConfiguration('nearAi');
  const inspected = configuration.inspect(option.setting);
  // Written where the setting is set now: this workspace if it overrides it, else your user settings.
  const inWorkspace = inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined;
  const target = inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const previous = inWorkspace ? inspected?.workspaceValue : inspected?.globalValue;
  const update = roleUpdate(option, model, readRoleModels());
  await configuration.update(update.setting, update.value, target);
  const token = randomBytes(8).toString('hex');
  undo.set(token, { setting: update.setting, previous, target, label: option.label });
  const warning = privacyWarning(entry.privacy, option);
  post({ type: 'role-applied', token, text: `${option.label} now uses ${model}${inWorkspace ? ' in this workspace' : ''}.`, ...(warning ? { warning } : {}) });
}

async function undoRole(token: string): Promise<void> {
  const change = undo.get(token);
  if (!change) return;
  undo.delete(token);
  await vscode.workspace.getConfiguration('nearAi').update(change.setting, change.previous, change.target);
  post({ type: 'notice', text: `Undone: ${change.label} is back to what it was.` });
}
