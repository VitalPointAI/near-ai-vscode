import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { layoutProbeAsset, registerLayoutProbe, sharedMedia } from './layoutProbe';
import { estimateComparisonCost, latestResults, performanceTrend, planComparison, reusedRows, runIdFor, savedModel, type SavedRun } from '../benchmark/results';
import { runComparison } from '../benchmark/runner';
import { comparisonStoreFor } from '../benchmark/store';
import { loadBenchmarkTasks, tasksFor, type BenchmarkTask } from '../benchmark/tasks';
import { spendAccountOf } from './agentSession';
import type { AuthService } from './auth';
import { providerErrorMessage } from './chatBridge';
import { isEmergencyStopped, onDidChangeEmergencyStop } from './emergencyStop';
import { catalogEntries, comparisonPageHtml, defaultSelection, clearOneProjectChoice, clearProjectModelChoices, estimateView, historyEntries, leaderboardRows, projectChoicesView, recommendationView, retestView, parseComparisonMessage, reportView, selectionProblem, taskSetsView, type PageState, type Selection } from './modelComparisonPage';
import { declineImport, importOffer, PROJECT_CHOICE_SETTINGS, planApply, projectChoiceFor, projectUndoFor, readChoicesFileSync, undoProjectChoice, writeProjectChoice, type ChoiceValue, type InspectedSetting, type ProjectUndo } from './modelChoices';
import { privacyWarning, roleAppliedText, roleOptions, roleUpdate, type RoleOption } from './modelRoles';
import type { ModelInfo, UsageMetadata } from './nearAiClient';
import { activeProvider, clientFor, type ActiveProvider } from './providerCache';
import { readAgentRules, readModelTiers, readRoleModels, readRunBudget, readSettings } from './settings';
import { nanoToUsd, totalNanoUsd } from './spendLedger';
import { editorWriter } from './stateHome';
import { ensureMigrated } from './stateMigration';

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
/**
 * One undo record per applied setting. "Apply all" changes several, so the map holds a LIST: a single role writes a list of one, and undo restores every
 * entry in reverse order (0.4.19 review: the multi-entry shape was stored under a single-entry type, so Apply all could not be undone at all).
 */
type UndoEntry = { setting: string; previous: unknown; target: vscode.ConfigurationTarget; label: string } | { target: 'project'; project: ProjectUndo; label: string };
const undo = new Map<string, UndoEntry[]>();

const projectRootOf = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

/**
 * The roles of the layer a role is written to: the project's own roleModels choice, or the workspace value when the workspace sets it. Only that layer is
 * extended, so every other role keeps following the person's settings and the defaults (REVIEW: writing the resolved roles froze them all).
 */
function layerRolesFor(where: 'workspace' | 'project', inspected: { workspaceValue?: unknown } | undefined, root: string | undefined): Record<string, string> {
  const value = where === 'workspace' ? inspected?.workspaceValue : projectChoiceFor(root, 'agent.roleModels');
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0));
}

/** The project's state home first (so a comparison made in another editor shows here), then this editor's own folder (D-06). */
const storeFor = (context: vscode.ExtensionContext) => comparisonStoreFor(context.globalStorageUri.fsPath, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
const benchmarkTasks = () => (tasksLoaded ??= loadBenchmarkTasks().catch((error: unknown) => { tasksLoaded = undefined; throw error; }));

export function registerModelComparison(context: vscode.ExtensionContext, auth: AuthService): void {
  context.subscriptions.push(vscode.commands.registerCommand('nearAi.compareModels', () => openModelComparison(context, auth)));
  context.subscriptions.push(vscode.commands.registerCommand('nearAi.clearProjectModelChoices', async () => {
    const configuration = vscode.workspace.getConfiguration('nearAi');
    const text = await clearProjectModelChoices({
      root: projectRootOf(),
      inspect: (setting) => configuration.inspect(setting),
      writer: editorWriter(context.globalState),
      pick: async (items) => vscode.window.showQuickPick(items, { canPickMany: true, title: "Clear This Project's Model Choices", placeHolder: 'Pick the models to put back to your own settings' })
    });
    // A project choice raises no settings event, so an open Compare Models tab is refreshed by hand.
    await repost(context, auth);
    void vscode.window.showInformationMessage(text);
  }));
}

async function gather(context: vscode.ExtensionContext, auth: AuthService): Promise<Gathered> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  // Saved comparisons from before 0.4.20 are in this editor's own storage until they are merged into the project's state home (once; no-op after).
  if (root) await ensureMigrated(root);
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
  const leaderboard = leaderboardRows(runs, tasks, models, roles, Date.now());
  return {
    active, models, tasks, runs, roles,
    state: {
      leaderboard, catalog, selected: defaultSelection(roles, catalog), roles, projectChoices: projectChoicesView(root, (setting) => vscode.workspace.getConfiguration('nearAi').inspect(setting) as InspectedSetting | undefined),
      taskSets: taskSetsView(tasks), history: historyEntries(runs), retest: retestView(leaderboard, models), recommended: recommendationView(leaderboard, roles), trend: performanceTrend(runs),
      ...(running ? { running: { runId: running.runId } } : {}), teeOnly, ...(problem ? { problem } : {})
    }
  };
}

/** Opens (or shows) the Compare Models tab. */
export function openModelComparison(context: vscode.ExtensionContext, auth: AuthService): vscode.WebviewPanel {
  if (panel) { panel.reveal(); return panel; }
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'compare');
  const shared = sharedMedia(context.extensionUri);
  const view = vscode.window.createWebviewPanel('nearAiCompareModels', 'Compare Models', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media, shared], retainContextWhenHidden: true });
  panel = view;
  view.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'near-ai-vscode-icon.png');
  const asset = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  view.webview.html = comparisonPageHtml({ cspSource: view.webview.cspSource, nonce: randomBytes(16).toString('base64'), script: asset('compare.js'), style: asset('compare.css'), base: view.webview.asWebviewUri(vscode.Uri.joinPath(shared, 'base.css')).toString(), probe: layoutProbeAsset(view.webview, shared) });
  registerLayoutProbe('compare', view.webview);
  void offerImport(context, () => soon());
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
          case 'apply-recommended': await applyRecommended(context, auth); break;
          case 'undo-role': await undoRole(context, auth, message.token); break;
          case 'clear-project-choice': {
            const outcome = await clearOneProjectChoice(projectRootOf(), message.setting, editorWriter(context.globalState));
            post({ type: outcome.problem ? 'error' : 'notice', text: outcome.text });
            if (outcome.cleared) await repost(context, auth);
            break;
          }
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

/**
 * 0.4.20 (D-06): models chosen earlier were written to the person's user settings, which no other interface or computer sees. They are offered for this
 * project once, never copied without a click; "Not now" is remembered for the project. Dismissing the message asks nothing and writes nothing.
 */
async function offerImport(context: vscode.ExtensionContext, changed: () => void): Promise<void> {
  const root = projectRootOf();
  if (!root) return;
  try {
    const choices = readChoicesFileSync(root);
    if (choices.importDeclined) return;
    const configuration = vscode.workspace.getConfiguration('nearAi');
    const inspected = Object.fromEntries(PROJECT_CHOICE_SETTINGS.map((setting) => [setting, configuration.inspect(setting.slice('nearAi.'.length))]));
    const offer = importOffer(inspected, choices);
    if (!offer.length) return;
    const choice = await vscode.window.showInformationMessage('These models were set up earlier in this editor: use them for this project?', 'Use for this project', 'Not now');
    const writer = editorWriter(context.globalState);
    if (choice === 'Use for this project') {
      for (const candidate of offer) await writeProjectChoice(root, candidate.setting, candidate.value, writer);
      changed();
    } else if (choice === 'Not now') await declineImport(root, writer);
  } catch {
    // The offer is a convenience: failing to show or save it changes nothing.
  }
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
  // D-06: written to the workspace only when it already sets the value explicitly; otherwise it becomes the project's choice, which every interface and
  // computer reads. The person's user settings are never written from here.
  const where = planApply(inspected);
  const update = roleUpdate(option, model, option.id.startsWith('role:') ? layerRolesFor(where, inspected, projectRootOf()) : {});
  const token = randomBytes(8).toString('hex');
  if (where === 'workspace') {
    await configuration.update(update.setting, update.value, vscode.ConfigurationTarget.Workspace);
    undo.set(token, [{ setting: update.setting, previous: inspected?.workspaceValue, target: vscode.ConfigurationTarget.Workspace, label: option.label }]);
  } else {
    const root = projectRootOf();
    if (!root) { post({ type: 'error', text: 'Open a folder to choose models for a project.' }); return; }
    const entryUndo = projectUndoFor(root, update.setting);
    if (!await writeProjectChoice(root, update.setting, update.value as ChoiceValue, editorWriter(context.globalState))) { post({ type: 'notice', text: `${option.label} already uses ${model} for this project.` }); return; }
    undo.set(token, [{ target: 'project', project: entryUndo, label: option.label }]);
  }
  const warning = privacyWarning(entry.privacy, option);
  post({ type: 'role-applied', token, text: roleAppliedText(option.label, model, where), ...(warning ? { warning } : {}) });
  if (where === 'project') await repost(context, auth);
}

/** A project choice raises no settings event, so the page is refreshed by hand after one is written or undone. */
async function repost(context: vscode.ExtensionContext, auth: AuthService): Promise<void> {
  if (!panel) return;
  const refreshed = await gather(context, auth);
  post({ type: 'state', state: refreshed.state });
}

/**
 * Applies the recommended setup in one action (owner, 2026-11-07: "implementable by the user confirming with a button which changes all the models
 * appropriately"). Every tier and every agent role whose best model differs is written, one setting each, to the same place a single role would use (the project's choices, or the workspace when it sets the value itself); the
 * rest are left exactly as they are, so this never rewrites a setting that already holds the recommended model. One undo token restores all of them.
 * A model the catalog does not offer, or that TEE-only mode blocks, is skipped and named rather than silently dropped.
 */
async function applyRecommended(context: vscode.ExtensionContext, auth: AuthService): Promise<void> {
  const gathered = await gather(context, auth);
  const { recommended } = gathered.state;
  const choices = [...recommended.tiers, ...recommended.roles].filter((entry) => entry.changes);
  if (!choices.length) { post({ type: 'notice', text: 'Every tier and agent role already uses the model these results recommend.' }); return; }
  const configuration = vscode.workspace.getConfiguration('nearAi');
  const applied: string[] = [];
  const skipped: string[] = [];
  const undoEntries: UndoEntry[] = [];
  const root = projectRootOf();
  // The roles of the layer being written, extended as each role is applied (every role goes to the same layer).
  let layerRoles: Record<string, string> | undefined;
  let wroteProject = false;
  for (const choice of choices) {
    // 0.4.19 review: the cyber recommendation is NOT the chat model. Mapping it to `main` rewrote the ordinary chat model with an abliterated one
    // chosen only because it will not refuse attack payloads. The cyber engagement picks its model when it starts (src/domain/cyberModel.ts), so the bulk
    // apply leaves it alone and says so.
    if ('tier' in choice && choice.tier === 'cyber') { skipped.push(`the cyber model (${choice.model}), which a scan picks when it starts`); continue; }
    const roleId = 'tier' in choice ? `tier:${choice.tier}` : `role:${choice.role}`;
    const option = gathered.roles.find((role) => role.id === roleId);
    const entry = gathered.state.catalog.find((candidate) => candidate.id === choice.model);
    if (!option || !entry || entry.blocked) { skipped.push(`${'tier' in choice ? choice.tier : choice.role} (${choice.model})`); continue; }
    const inspected = configuration.inspect(option.setting);
    const where = planApply(inspected);
    if (option.id.startsWith('role:')) layerRoles ??= layerRolesFor(where, inspected, root);
    const update = roleUpdate(option, choice.model, option.id.startsWith('role:') ? layerRoles ?? {} : {});
    if (where === 'project' && !root) { skipped.push(`${'tier' in choice ? choice.tier : choice.role} (no project folder is open)`); continue; }
    // The undo entry is recorded BEFORE the write, so a write that throws half way leaves every change that did happen undoable (0.4.19 review: entries were
    // collected after the loop, so a failure left changes applied with no way back).
    const undoEntry: UndoEntry = where === 'workspace'
      ? { setting: update.setting, previous: inspected?.workspaceValue, target: vscode.ConfigurationTarget.Workspace, label: option.label }
      : { target: 'project', project: projectUndoFor(root!, update.setting), label: option.label };
    undoEntries.push(undoEntry);
    try {
      if (where === 'workspace') await configuration.update(update.setting, update.value, vscode.ConfigurationTarget.Workspace);
      else if (await writeProjectChoice(root!, update.setting, update.value as ChoiceValue, editorWriter(context.globalState))) wroteProject = true;
      else { undoEntries.splice(undoEntries.indexOf(undoEntry), 1); continue; }
      if (update.setting === 'agent.roleModels') layerRoles = { ...(update.value as Record<string, string>) };
      applied.push(`${option.label} to ${choice.model}`);
    } catch (error) {
      // This one did not happen after all, so it is not undone; the ones already written still are.
      undoEntries.splice(undoEntries.indexOf(undoEntry), 1);
      applied.push(`${option.label} could not be set: ${(error as Error).message}`);
      break;
    }
  }
  const token = randomBytes(8).toString('hex');
  if (undoEntries.length) undo.set(token, undoEntries);
  const text = applied.length
    ? `Applied ${applied.length} change${applied.length === 1 ? '' : 's'}: ${applied.join('; ')}.${skipped.length ? ` Skipped ${skipped.join(', ')}, which the catalog no longer offers or TEE-only mode blocks.` : ''}`
    : `Nothing was applied. Skipped ${skipped.join(', ')}.`;
  post({ type: applied.length ? 'role-applied' : 'notice', token, text });
  if (wroteProject) await repost(context, auth);
}

async function undoRole(context: vscode.ExtensionContext, auth: AuthService, token: string): Promise<void> {
  const change = undo.get(token);
  if (!change || !change.length) return;
  undo.delete(token);
  // In reverse, so two changes to the same setting unwind in the order they were made.
  let touchedProject = false;
  for (const entry of [...change].reverse()) {
    if (entry.target === 'project') { await undoProjectChoice(entry.project, editorWriter(context.globalState)); touchedProject = true; }
    else await vscode.workspace.getConfiguration('nearAi').update(entry.setting, entry.previous, entry.target);
  }
  if (touchedProject) await repost(context, auth);
  post({ type: 'notice', text: change.length === 1 ? `Undone: ${change[0]?.label} is back to what it was.` : `Undone: ${change.length} settings are back to what they were.` });
}
