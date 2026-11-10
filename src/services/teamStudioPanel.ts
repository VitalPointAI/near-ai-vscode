import { randomBytes, createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { layoutProbeAsset, registerLayoutProbe, sharedMedia } from './layoutProbe';
import { applyProjectType } from '../agent/projectTypes';
import { slugify, TeamLibrary } from '../agent/teams';
import { AuthService } from './auth';
import { attachTeamStudio, optimiseTarget, StudioTarget, teamStudioHtml, versionLabel } from './teamStudioPage';
import { ChatPrefill, gatherDirectoryInput } from './toolsPage';
import { ComparisonStore } from '../benchmark/store';
import { loadBenchmarkTasks } from '../benchmark/tasks';
import { leaderboardRows, suggestForTeam } from './modelComparisonPage';
import { builderPrompt, parseProposal, TEAM_BUILDER_PROMPT } from '../agent/teamBuilder';
import { activeProvider, clientFor, type ActiveProvider } from './providerCache';
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
 * The provider and the candidate models a role test would use: the three tiers (the models in use now) and the two best any comparison has measured,
 * capped so this stays minutes not hours. Shared by the run and by the cost shown before it, so the count the person is asked about is the count that
 * runs.
 */
/**
 * The longest a plan could take, from the runs' own time limits. It is a CEILING, not an estimate: every run is capped by its task's timeout and they run
 * one after another, so the sum is the worst case a person is agreeing to (0.4.19 review: the confirmation said "a few minutes").
 */
function worstCase(runs: Array<{ task: { timeoutMs: number } }>): string {
  const totalMinutes = Math.round(runs.reduce((total, run) => total + run.task.timeoutMs, 0) / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} minutes`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} hour${hours === 1 ? '' : 's'}${minutes ? ` ${minutes} minutes` : ''}`;
}

async function optimisationSetup(auth: AuthService, context: vscode.ExtensionContext): Promise<{ active: ActiveProvider; candidates: string[] } | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const active = await activeProvider(root, auth).catch(() => undefined);
  if (!active) return undefined;
  const tiers = readModelTiers();
  const tasks = await loadBenchmarkTasks();
  const runs = await new ComparisonStore(path.join(context.globalStorageUri.fsPath, 'evals')).list();
  const board = leaderboardRows(runs, tasks, active.models, [], Date.now());
  // 0.4.19 review: the three tier models were listed FIRST and the list then sliced to three, so the two best measured models were never tested, while the
  // comment claimed they were. The measured models now come first, and the tier models fill the remaining places.
  const measured = [...new Set(board.map((entry) => entry.model))].filter((model) => active.models.some((entry) => entry.id === model));
  const candidates = [...new Set([...measured, tiers.fast, tiers.standard, tiers.deep])].filter((model): model is string => Boolean(model)).slice(0, 3);
  return candidates.length ? { active, candidates } : undefined;
}

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
    optimiseTeam: async (members, teamName, options = {}) => {
      const setup = await optimisationSetup(auth, context);
      if (!setup) return undefined;
      const { active, candidates } = setup;
      const plan = planRoleSuite(members, candidates);
      // The team's own file, found the way the library finds teams, so a name with spaces or capitals still lands on the right file. It is resolved ONCE,
      // before the tests, and the same path is used afterwards (0.4.19 review: resolving it twice, and once when the team could not be found, made the
      // change guard report "changed while its roles were being tested" every time).
      // The project's own team is listed only with the root, so it is passed. The file the caller acted on picks the entry, so a library team that shares
      // the project team's name is never rewritten in its place (optimiseTarget).
      const entries = await library.list(root);
      const teamEntry = optimiseTarget(entries, teamName, options.file);
      const file = teamEntry?.file;
      const beforeTests = file ? await readFile(file, 'utf8').catch(() => undefined) : undefined;
      if (!file || beforeTests === undefined) return { applied: 0, text: `${teamName} could not be found on disk, so its models were left alone.` };
      // The caller has already asked about the whole run when confirm is false, so no modal is shown for one team.
      if (options.confirm !== false) {
        const answer = await vscode.window.showWarningMessage(
          `Test the roles in "${teamName}" and set each member's model?`,
          // 0.4.19 review: "a few minutes" was wrong. Each run is capped by its task's timeout and they run one at a time, so a six-member team can take
          // over two hours. The worst case is stated, from the tasks' own limits, so nobody starts this expecting minutes.
          { modal: true, detail: `${plan.estimatedRuns} runs (${plan.members} member${plan.members === 1 ? '' : 's'} x ${candidates.length} model${candidates.length === 1 ? '' : 's'}), one at a time, up to ${worstCase(plan.runs)} if every run uses its whole time limit and much less when they finish early. Tested: ${candidates.join(', ')}. Costs tokens. Skipping leaves the team exactly as you wrote it.` },
          'Run the tests', 'Skip'
        );
        if (answer !== 'Run the tests') return undefined;
      }
      const outcomes = await runRoleSuite(plan, { clientFor: (model) => clientFor(active, model).client, rules: readAgentRules(), signal: options.signal ?? new AbortController().signal });
      const picks = bestOf(outcomes);
      if (!picks.length) return { applied: 0, text: options.signal?.aborted ? `${teamName}: cancelled, so its models were left alone.` : 'Every role test failed, so the team is unchanged. Run Compare Models to see why.' };
      // Which picks really matched a member, collected where the write happens, so the notice below cannot claim a write that did not happen.
      const wroteNames: typeof picks = [];
      // The team's own file, found the way the library finds teams, so a name with spaces or capitals still lands on the right file.
      {
        // The role tests take minutes, so the file may have been edited in the meantime: the version read BEFORE the tests is compared with the one on disk
        // now, and a change means the models are not written rather than the edit being lost.
        const before = await readFile(file, 'utf8').catch(() => undefined);
        if (before !== undefined && before !== beforeTests) {
          return { applied: 0, text: `${teamName} changed while its roles were being tested, so its models were left alone. Save the team again to apply them: ${picks.map((pick) => `${pick.member} to ${pick.model}`).join(', ')}.` };
        }
        // The file vanished between the tests and the write: say so rather than reporting models that were never written (0.4.19 review).
        if (before === undefined) return { applied: 0, text: `${teamName} was deleted while its roles were being tested, so its models were not set.` };
        const text = before;
        const draft = draftFromMarkdown(text, file);
        {
          for (const pick of picks) {
            const member = draft.members.find((entry) => entry.name === pick.member);
            if (member) { member.model = pick.model; wroteNames.push(pick); }
          }
          await writeFile(file, teamMarkdown(draft, text), 'utf8');
          await library.snapshot(file);
          // The studio's open editor holds the hash from before the write, so it is told the file changed rather than left to conflict on its next save.
          if (current) {
            const changed = await readFile(file, 'utf8');
            void current.panel.webview.postMessage({ type: 'external-change', id: teamEntry?.project ? 'project' : `user:${slugify(path.basename(file, '.md'))}`, reason: 'edited', draft: draftFromMarkdown(changed, file), base: createHash('sha256').update(changed).digest('hex'), versions: (await library.versions(file)).map((version) => ({ ref: path.basename(version), label: versionLabel(path.basename(version)) })) });
          }
        }
      }
      // 0.4.19 review: `picks.length` was reported even when a pick's member was not in the draft, so the notice claimed writes that never happened.
      const written = wroteNames;
      const missing = picks.filter((pick) => !written.includes(pick));
      return {
        applied: written.length,
        text: `Set ${written.length} member model${written.length === 1 ? '' : 's'} from the role tests: ${written.map((pick) => `${pick.member} to ${pick.model}`).join(', ')}.${missing.length ? ` ${missing.map((pick) => pick.member).join(', ')} changed name while being tested, so their models were left alone.` : ''}`
      };
    },
    // The models a role test would try, so testing every team shows the whole cost once before it starts.
    optimiseCandidates: async () => (await optimisationSetup(auth, context))?.candidates ?? [],
    // Emergency stop cancels a run in progress, the same way Compare Models does.
    onStop: (listener) => onDidChangeEmergencyStop((engaged) => { if (engaged) listener(); }),
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
