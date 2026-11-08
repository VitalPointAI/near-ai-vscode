import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { layoutProbeAsset, registerLayoutProbe, sharedMedia } from './layoutProbe';
import { applyProjectType } from '../agent/projectTypes';
import { slugify, TeamLibrary } from '../agent/teams';
import { AuthService } from './auth';
import { attachTeamStudio, StudioTarget, teamStudioHtml } from './teamStudioPage';
import { ChatPrefill, gatherDirectoryInput } from './toolsPage';
import { ComparisonStore } from '../benchmark/store';
import { loadBenchmarkTasks } from '../benchmark/tasks';
import { leaderboardRows, suggestForTeam } from './modelComparisonPage';
import { builderPrompt, parseProposal, TEAM_BUILDER_PROMPT } from '../agent/teamBuilder';
import { activeProvider, clientFor } from './providerCache';
import { readAgentRules, readModelTiers } from './settings';
import { bestOf, planRoleSuite, runRoleSuite } from '../benchmark/roleSuite';
import { draftFromMarkdown, teamMarkdown } from '../agent/teamMarkdown';
import { readFile, writeFile } from 'node:fs/promises';
import { onDidChangeEmergencyStop } from './emergencyStop';
import { homeFolder, teamLibraryDir, teamsMoveInFlight, whenTeamsMoved } from '../domain/teamStorage';

// The NEAR AI Team Studio tab. One tab at a time; opening it again shows it (and, for the project
// team setup, starts the guided builder).

const DRAFT_KEY = 'nearAi.teamStudio.draft';
/** Unsaved work kept when the tab was closed (VS Code cannot ask before a webview panel closes). */
const KEPT_KEY = 'nearAi.teamStudio.kept';
let current: { panel: vscode.WebviewPanel; startWizard(target: StudioTarget): Promise<void> } | undefined;

/**
 * Opens Team Studio, after the one-time move of older teams has finished (0.4.18 review), so the studio never opens on a half-copied library. It
 * returns a promise so a caller (and a test) can await the panel; VS Code ignores a command handler's promise.
 */
export async function openTeamStudio(context: vscode.ExtensionContext, auth: AuthService, sidebar: ChatPrefill, options: { wizard?: StudioTarget } = {}): Promise<void> {
  // Only an actual move is waited for: with nothing to move this opens in the same tick, as it always did.
  if (teamsMoveInFlight() !== undefined) await whenTeamsMoved();
  if (current) {
    current.panel.reveal();
    if (options.wizard) void current.startWizard(options.wizard);
    return;
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const library = new TeamLibrary(teamLibraryDir(homeFolder()));
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'teams');
  const shared = sharedMedia(context.extensionUri);
  const panel = vscode.window.createWebviewPanel('nearAiTeamStudio', 'NEAR AI Team Studio', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media, shared] });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'near-ai-vscode-icon.png');
  const asset = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  panel.webview.html = teamStudioHtml({ cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString('base64'), script: asset('teams.js'), style: asset('teams.css'), network: asset('network.css'), base: panel.webview.asWebviewUri(vscode.Uri.joinPath(shared, 'base.css')).toString(), probe: layoutProbeAsset(panel.webview, shared) });
  registerLayoutProbe('teams', panel.webview);
  const studio = attachTeamStudio(panel, {
    library, root,
    gather: () => gatherDirectoryInput(context, auth),
    knowledgeBase: async () => Boolean(root && await stat(path.join(root, '.near-kb')).catch(() => undefined)),
    sidebar,
    openFile: async (file) => vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: false, viewColumn: vscode.ViewColumn.Beside }),
    openSetting: (key) => Promise.resolve(vscode.commands.executeCommand('workbench.action.openSettings', key)),
    confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
    choose: async (message, ...actions) => vscode.window.showWarningMessage(message, { modal: true }, ...actions),
    // The tested model for each role, from the comparisons this machine has run, so a saved team is checked against evidence rather than defaults.
    // The AI start (owner, 2026-11-08): one call drafts the team from the person's own words, and the result is a proposal they accept or edit.
    draftTeam: async (brief) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const active = await activeProvider(root, auth).catch(() => undefined);
      if (!active) throw new Error('Set up a NEAR AI profile for this project first.');
      const tiers = readModelTiers();
      const client = clientFor(active, tiers.deep || active.models[0]?.id).client;
      const reply = await client.completeOnce(tiers.deep || active.models[0]?.id, [
        { role: 'system', content: TEAM_BUILDER_PROMPT },
        { role: 'user', content: builderPrompt(brief) }
      ], { maxTokens: 2000 });
      return parseProposal(reply.text, brief);
    },
    // The final step of adding a team: measure each member's role on a few candidate models, then write the winner into the team file. The person is
    // asked first, because this spends real time and tokens, and skipping it leaves exactly the team they wrote.
    optimiseTeam: async (members, teamName) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const active = await activeProvider(root, auth).catch(() => undefined);
      if (!active) return undefined;
      // The candidates: the three tiers (the models in use now) and the two best any comparison has measured, capped so this stays minutes not hours.
      const tiers = readModelTiers();
      const tasks = await loadBenchmarkTasks();
      const runs = await new ComparisonStore(path.join(context.globalStorageUri.fsPath, 'evals')).list();
      const board = leaderboardRows(runs, tasks, active.models, [], Date.now());
      const candidates = [...new Set([tiers.fast, tiers.standard, tiers.deep, ...board.slice(0, 2).map((entry) => entry.model)])].filter((model): model is string => Boolean(model && active.models.some((entry) => entry.id === model))).slice(0, 3);
      if (!candidates.length) return undefined;
      const plan = planRoleSuite(members, candidates);
      const answer = await vscode.window.showWarningMessage(
        `Test the roles in "${teamName}" and set each member's model?`,
        { modal: true, detail: `${plan.estimatedRuns} short runs (${plan.members} member${plan.members === 1 ? '' : 's'} x ${candidates.length} model${candidates.length === 1 ? '' : 's'}), a few minutes. Tested: ${candidates.join(', ')}. Skipping leaves the team exactly as you wrote it.` },
        'Run the tests', 'Skip'
      );
      if (answer !== 'Run the tests') return undefined;
      const outcomes = await runRoleSuite(plan, { clientFor: (model) => clientFor(active, model).client, rules: readAgentRules(), signal: new AbortController().signal });
      const picks = bestOf(outcomes);
      if (!picks.length) return { applied: 0, text: 'Every role test failed, so the team is unchanged. Run Compare Models to see why.' };
      // The team is the newest file for this name in the library; its models are set by rewriting that member's model line.
      // The team's own file, found the way the library finds teams, so a name with spaces or capitals still lands on the right file.
      const entries = await library.list();
      const file = entries.find((entry) => entry.team?.name === teamName || path.basename(entry.file, '.md') === slugify(teamName))?.file;
      if (file) {
        const text = await readFile(file, 'utf8').catch(() => undefined);
        if (text !== undefined) {
          const draft = draftFromMarkdown(text, file);
          for (const pick of picks) {
            const member = draft.members.find((entry) => entry.name === pick.member);
            if (member) member.model = pick.model;
          }
          await writeFile(file, teamMarkdown(draft, text), 'utf8');
          await library.snapshot(file);
        }
      }
      return { applied: picks.length, text: `Set ${picks.length} member model${picks.length === 1 ? '' : 's'} from the role tests: ${picks.map((pick) => `${pick.member} to ${pick.model}`).join(', ')}.` };
    },
    suggestModels: async (members) => {
      const tasks = await loadBenchmarkTasks();
      const runs = await new ComparisonStore(path.join(context.globalStorageUri.fsPath, 'evals')).list();
      if (!runs.length) return [];
      // The catalogue is only needed for prices and privacy, and a failure there must not block the suggestion.
      const active = await activeProvider(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', auth).catch(() => undefined);
      const rows = leaderboardRows(runs, tasks, active?.models ?? [], [], Date.now());
      return suggestForTeam(rows, members);
    },
    ask: (prompt, value) => Promise.resolve(vscode.window.showInputBox({ title: 'Team Studio', prompt, value, validateInput: (text) => text.trim() ? undefined : 'Enter a name.' })),
    pickExportTarget: async (name) => (await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(root ?? context.globalStorageUri.fsPath, name)), filters: { 'Team file': ['md'] }, title: 'Export team' }))?.fsPath,
    pickImportSource: async () => (await vscode.window.showOpenDialog({ filters: { 'Team file': ['md'] }, title: 'Import a NEAR AI team file', canSelectMany: false }))?.[0]?.fsPath,
    applyProjectType: (projectRoot, type, goal) => applyProjectType(projectRoot, type, goal),
    drafts: { get: () => context.globalState.get(DRAFT_KEY), set: (value) => Promise.resolve(context.globalState.update(DRAFT_KEY, value)) },
    kept: { get: () => context.globalState.get(KEPT_KEY), set: (value) => Promise.resolve(context.globalState.update(KEPT_KEY, value)) },
    watch: (listener) => {
      const watchers = [new vscode.RelativePattern(vscode.Uri.file(library.directory), '{*.md,.archived/*.md}'), ...(root ? [new vscode.RelativePattern(vscode.Uri.file(path.dirname(TeamLibrary.projectTeamFile(root))), 'team.md')] : [])]
        .map((pattern) => vscode.workspace.createFileSystemWatcher(pattern));
      const subscriptions = watchers.flatMap((watcher) => [watcher.onDidChange((uri) => listener(uri.fsPath)), watcher.onDidCreate((uri) => listener(uri.fsPath)), watcher.onDidDelete((uri) => listener(uri.fsPath)), watcher]);
      return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
    },
    onDidChangeSettings: (listener) => {
      const subscriptions = [vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('nearAi')) listener(); }), onDidChangeEmergencyStop(() => listener())];
      return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
    }
  });
  current = { panel, startWizard: (target) => studio.startWizard(target) };
  if (options.wizard) void studio.startWizard(options.wizard);
  panel.onDidDispose(() => { current = undefined; }, undefined, context.subscriptions);
}
