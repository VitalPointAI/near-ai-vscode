import { randomBytes, createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { layoutProbeAsset, registerLayoutProbe, sharedMedia } from './layoutProbe';
import { sharedActivityFeed } from './activityView';
import { applyProjectType } from '../agent/projectTypes';
import { applyResearchProfile, usesResearchProfile } from '../gsd/researchProfile';
import { slugify, TeamLibrary } from '../agent/teams';
import { AuthService } from './auth';
import { runtimePerRoot, unattendedRuntimeFor } from '../gate/host';
import type { GateRuntime } from '../domain/gate/decide';
import type { GateHost } from '../gate/host';
import { defaultSessionRoute, sessionRouteFrom, withSessionRoute } from '../gate/sessionMark';
import { attachTeamStudio, optimiseTarget, StudioTarget, teamStudioHtml, versionLabel } from './teamStudioPage';
import { createStaffSetupPreview, type TeamStudioLanguage } from './teamStudioStaffSetup';
import { setUpStaffTeam } from './staffSetupCommand';
import { ChatPrefill, gatherDirectoryInput } from './toolsPage';
import { comparisonStoreFor } from '../benchmark/store';
import { loadBenchmarkTasks } from '../benchmark/tasks';
import { leaderboardRows, suggestForTeam } from './modelComparisonPage';
import { activeProvider, clientFor, privateRouteFor, type ActiveProvider } from './providerCache';
import { readAgentModels, readAgentRules, readModelTiers, readSettings } from './settings';
import { withSpendTag } from './spendLedger';
import { spendAccountOf } from './agentSession';
import type { TeamAiDeps } from './teamStudioAi';
import { bestOf, planRoleSuite, runRoleSuite } from '../benchmark/roleSuite';
import { draftFromMarkdown, teamMarkdown } from '../agent/teamMarkdown';
import { readFile, writeFile } from 'node:fs/promises';
import { onDidChangeEmergencyStop } from './emergencyStop';
import { homeFolder, teamLibraryDir, teamsMoveInFlight, whenTeamsMoved } from '../domain/teamStorage';
import { ActivityStore } from './activityStore';
import { keptRoleTests, projectIdentity, teamKey } from '../domain/teamDashboard';

// The SovAI Team Studio tab. One tab at a time; opening it again shows it (and, for the project
// team setup, starts the guided builder).

const DRAFT_KEY = 'nearAi.teamStudio.draft';
/** Unsaved work kept when the tab was closed (VS Code cannot ask before a webview panel closes). */
const KEPT_KEY = 'nearAi.teamStudio.kept';
/**
 * The last role test of each team (the dashboard's health): scores only, keyed by the team's identity (user:<slug>, or project:<hash of the project
 * folder's real path>), at most 200. This extension's own storage
 * on this computer: VS Code syncs a key of globalState only when told to, and this one is not.
 */
const ROLE_TESTS_KEY = 'nearAi.teamStudio.roleTests';
/** How the person last sorted and filtered the dashboard, so the tab opens that way again (this computer only, like the role tests). */
const VIEW_KEY = 'nearAi.teamStudio.view';
/**
 * The person's own rating of each team (PR 86 review): kept here, by the team's identity, and never in a team file, so a project team's rating never goes
 * where the project's files go (a code push included). This computer only, like the role tests.
 */
const RATINGS_KEY = 'nearAi.teamStudio.ratings';
/** A team the AI drafted and the person has not used or discarded yet (PR 86 review, round 2), so it outlives the tab. This computer only. */
const PROPOSAL_KEY = 'nearAi.teamStudio.proposal';
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
  const runs = await comparisonStoreFor(context.globalStorageUri.fsPath, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).list();
  const board = leaderboardRows(runs, tasks, active.models, [], Date.now());
  // 0.4.19 review: the three tier models were listed FIRST and the list then sliced to three, so the two best measured models were never tested, while the
  // comment claimed they were. The measured models now come first, and the tier models fill the remaining places.
  const measured = [...new Set(board.map((entry) => entry.model))].filter((model) => active.models.some((entry) => entry.id === model));
  const candidates = [...new Set([...measured, tiers.fast, tiers.standard, tiers.deep])].filter((model): model is string => Boolean(model)).slice(0, 3);
  return candidates.length ? { active, candidates } : undefined;
}

/**
 * What a Team Studio model call needs from the active profile: the catalogue, the tier models in order of preference, each model's route (for the
 * private check), the settings the outbound check reads, and today's spend from the key's ledger. Throws when the project has no profile.
 */
async function teamAiDeps(auth: AuthService, runtimeOf: (root: string) => Promise<GateRuntime | undefined>): Promise<TeamAiDeps> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const active = await activeProvider(root, auth).catch(() => undefined);
  if (!active) throw new Error('Set up an AI profile for this project first.');
  const tiers = readModelTiers();
  const settings = readSettings();
  return {
    models: active.models,
    preferred: [tiers.deep, tiers.standard, settings.defaultModel],
    routeFor: (model) => privateRouteFor(active.provider, clientFor(active, model.id).local),
    privacyMode: settings.privacyMode,
    settings,
    spentTodayUsd: async () => {
      const account = spendAccountOf(active.provider.client);
      // Picks up what other windows on this computer spent with the same key, as chat does.
      await account?.ledger.refresh();
      return account?.spentTodayUsd().usd ?? 0;
    },
    // CLAS-06: a person drafts and improves the team here, so each request is routed (and recorded) as the person's, in the project's log. With no gate host
    // it is decided with the default route.
    complete: async (model, messages, options) => {
      const send = () => clientFor(active, model).client.completeOnce(model, messages, options);
      // The panel's runtime for this folder, asked of the host once when the panel first needed it, so no call waits on the host's start again.
      const runtime = await runtimeOf(root);
      return withSessionRoute(runtime ? sessionRouteFrom(runtime) : defaultSessionRoute(), send);
    },
    // 0.4.30, team icons: the image model the settings name, and one image made the way GenerateImage makes it (the client records its cost, tagged as
    // generation like every other image), routed and recorded as the person's like the requests above.
    imageModel: readAgentModels().imageModel,
    generateImage: async (model, prompt, signal) => {
      // Its own name: the route check reads the work handed to withSessionRoute by name, so the two in this file must differ.
      const sendImage = () => withSpendTag({ kind: 'generation' }, () => clientFor(active, model).client.generateImage(model, prompt, { count: 1 }, signal));
      // The same per-panel runtime as the text requests above (PR #81 review): the host is asked once per folder, not before each image.
      const runtime = await runtimeOf(root);
      return withSessionRoute(runtime ? sessionRouteFrom(runtime) : defaultSessionRoute(), sendImage);
    }
  };
}

/**
 * Opens Team Studio, after the one-time move of older teams has finished (0.4.18 review), so the studio never opens on a half-copied library. It
 * returns a promise so a caller (and a test) can await the panel; VS Code ignores a command handler's promise.
 */
export async function openTeamStudio(context: vscode.ExtensionContext, auth: AuthService, sidebar: ChatPrefill, options: { wizard?: StudioTarget } = {}, gateHost?: GateHost, language?: TeamStudioLanguage): Promise<void> {
  void language?.refresh();
  // Only an actual move is waited for: with nothing to move this opens in the same tick, as it always did.
  if (teamsMoveInFlight() !== undefined) await whenTeamsMoved();
  if (current) {
    current.panel.reveal();
    if (options.wizard) void current.startWizard(options.wizard);
    return;
  }
  // The folder open now, asked each time it is used: a folder opened, closed or changed while the tab is open is followed (PR #70 review carry-over).
  const rootNow = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  // One runtime per folder for this panel's model calls (PR #81 review): the host is asked once, not before each call.
  const studioRuntime = runtimePerRoot(gateHost, (root) => ({ root, actor: { kind: 'person', sessionId: 'team-studio' }, presence: 'person', context: 'interactive' }));
  const library = new TeamLibrary(teamLibraryDir(homeFolder()));
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'teams');
  const shared = sharedMedia(context.extensionUri);
  const panel = vscode.window.createWebviewPanel('nearAiTeamStudio', 'SovAI Team Studio', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media, shared] });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'near-ai-vscode-icon.png');
  const asset = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  panel.webview.html = teamStudioHtml({ cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString('base64'), script: asset('teams.js'), style: asset('teams.css'), network: asset('network.css'), base: panel.webview.asWebviewUri(vscode.Uri.joinPath(shared, 'base.css')).toString(), probe: layoutProbeAsset(panel.webview, shared) });
  registerLayoutProbe('teams', panel.webview);
  const studio = attachTeamStudio(panel, {
    library, root: rootNow,
    staffSetupPreview: createStaffSetupPreview({
      folders: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => ({ root: folder.uri.fsPath, name: folder.name })),
      pick: async (folders) => (await vscode.window.showQuickPick(
        folders.map((folder) => ({ label: folder.name, description: folder.root, folder })),
        { title: language?.current() === 'fr-CA' ? 'Pour quel projet voulez-vous examiner l’état-major?' : 'Which project’s staff would you like to review?' }
      ))?.folder,
      libraryDir: library.directory,
      startSection: async (section, project) => {
        const file = await setUpStaffTeam({ section, studio: project, chat: sidebar, library, language: language?.current });
        if (file) await studio.refresh().catch(() => undefined);
        return Boolean(file);
      },
      post: (message) => { void panel.webview.postMessage(message); }
    }),
    onDidChangeFolder: (listener) => vscode.workspace.onDidChangeWorkspaceFolders(() => listener()),
    gather: () => gatherDirectoryInput(context, auth),
    knowledgeBase: async () => { const root = rootNow(); return Boolean(root && await stat(path.join(root, '.near-kb')).catch(() => undefined)); },
    sidebar,
    openFile: async (file) => vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: false, viewColumn: vscode.ViewColumn.Beside }),
    openSetting: (key) => Promise.resolve(vscode.commands.executeCommand('workbench.action.openSettings', key)),
    updateTeam: (file) => Promise.resolve(vscode.commands.executeCommand('nearAi.updateTeam', file)),
    setUpStaffTeam: () => Promise.resolve(vscode.commands.executeCommand('nearAi.setUpStaffTeam')),
    openStaffRoom: () => Promise.resolve(vscode.commands.executeCommand('nearAi.openStaffRoom')),
    liveRun: (slug) => sharedActivityFeed().teamRunning(slug),
    watchLive: (runId) => Promise.resolve(runId ? vscode.commands.executeCommand('nearAi.openTeamLive', runId) : vscode.commands.executeCommand('nearAi.openTeamLive')),
    // The dashboard (0.4.31): the open project's run history, the team runs going now, and a notification when one starts or ends.
    history: async () => { const root = rootNow(); return root ? new ActivityStore(root).list() : []; },
    runningTeams: () => {
      const feed = sharedActivityFeed();
      return feed.teamRuns().filter((run) => run.status === 'running').map((run) => {
        const file = feed.runTeam(run.runId)?.file;
        return { runId: run.runId, slug: run.team, ...(file ? { file } : {}) };
      });
    },
    onDidChangeRuns: (listener) => {
      // Only a team run starting, ending, or having its end saved to the history (its counters persisted) is news here; tokens and tools are not.
      const feed = sharedActivityFeed();
      // Asked on every feed change, so it reads the feed's team runs without copying every agent's counters.
      const runs = () => feed.teamRuns().map((run) => `${run.runId}:${run.status}:${run.persisted ? 1 : 0}`).sort().join(',');
      let seen = runs();
      const subscription = feed.subscribe(() => { const now = runs(); if (now !== seen) { seen = now; listener(); } });
      return { dispose: () => subscription.dispose() };
    },
    roleTests: { get: () => context.globalState.get(ROLE_TESTS_KEY), set: (value) => Promise.resolve(context.globalState.update(ROLE_TESTS_KEY, value)) },
    ratings: { get: () => context.globalState.get(RATINGS_KEY), set: (value) => Promise.resolve(context.globalState.update(RATINGS_KEY, value)) },
    proposal: { get: () => context.globalState.get(PROPOSAL_KEY), set: (value) => Promise.resolve(context.globalState.update(PROPOSAL_KEY, value)) },
    view: { get: () => context.globalState.get(VIEW_KEY), set: (value) => Promise.resolve(context.globalState.update(VIEW_KEY, value)) },
    confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
    choose: async (message, ...actions) => vscode.window.showWarningMessage(message, { modal: true }, ...actions),
    // The tested model for each role, from the comparisons this machine has run, so a saved team is checked against evidence rather than defaults.
    // The studio's only way to a model (0.4.27): drafting a team and Improve with AI both go through teamModelCall with these, and the host decides
    // which model may be used.
    teamAi: () => teamAiDeps(auth, studioRuntime),
    // The final step of adding a team: measure each member's role on a few candidate models, then write the winner into the team file. The person is
    // asked first, because this spends real time and tokens, and skipping it leaves exactly the team they wrote.
    optimiseTeam: async (members, teamName, options = {}) => {
      // The folder open when the tests start: the team file and the runs' decision log both follow it for this whole run.
      const root = rootNow();
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
      const outcomes = await runRoleSuite(plan, {
        clientFor: (model) => clientFor(active, model).client, rules: readAgentRules(), signal: options.signal ?? new AbortController().signal,
        // Nobody watches a role run: it is decided with presence none in an unattended context, and its decisions reach the project's log (GATE-07, D-43).
        ...(gateHost ? { gateFor: (run: { member: string; model: string }) => unattendedRuntimeFor(gateHost, root, `team-roles-${teamName}`, `${run.member} on ${run.model}`) } : {})
      });
      // Kept for the dashboard's health before anything else happens to the team, whatever the tests found (scores only; no model or task text).
      // A run cancelled part-way is not the team's last role test: it would count the members it never reached as failing.
      const testedKey = teamKey({ kind: teamEntry?.project ? 'project' : 'user', slug: slugify(path.basename(file, '.md')) }, teamEntry?.project && root ? await projectIdentity(root) : undefined);
      const keptBefore = context.globalState.get(ROLE_TESTS_KEY);
      const testedAt = new Date().toISOString();
      const nextRoleTests = keptRoleTests(keptBefore, testedKey, outcomes, plan.members, options.signal?.aborted === true, testedAt);
      if (nextRoleTests) await context.globalState.update(ROLE_TESTS_KEY, nextRoleTests).then(undefined, () => undefined);
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
      const runs = await comparisonStoreFor(context.globalStorageUri.fsPath, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).list();
      if (!runs.length) return [];
      // The catalogue is only needed for prices and privacy, and a failure there must not block the suggestion.
      const active = await activeProvider(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', auth).catch(() => undefined);
      const rows = leaderboardRows(runs, tasks, active?.models ?? [], [], Date.now());
      return suggestForTeam(rows, members);
    },
    ask: (prompt, value, validate) => Promise.resolve(vscode.window.showInputBox({ title: 'Team Studio', prompt, value, validateInput: (text) => text.trim() ? validate?.(text) : 'Enter a name.' })),
    // A share file is <team>.near-team.json; the dialog filters on its last extension, json. A team .md file can be imported too.
    pickShareTarget: async (name) => (await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(rootNow() ?? homeFolder(), name)), filters: { 'SovAI agent team': ['json'] }, title: 'Share team: save it as one file to send' }))?.fsPath,
    pickImportSource: async () => (await vscode.window.showOpenDialog({ filters: { 'SovAI agent team': ['json', 'md'] }, title: 'Import a SovAI agent team', canSelectMany: false }))?.[0]?.fsPath,
    // 0.4.30: a picture for a team's icon. The host checks it by its bytes (PNG, JPEG or WebP, at most 2 MB); SVG is never offered or accepted.
    pickIconSource: async () => (await vscode.window.showOpenDialog({ filters: { Images: ['png', 'jpg', 'jpeg', 'webp'] }, title: 'Choose a picture for the team icon', canSelectMany: false, openLabel: 'Use as icon' }))?.[0]?.fsPath,
    home: homeFolder(),
    applyProjectType: async (projectRoot, type, goal) => {
      const applied = await applyProjectType(projectRoot, type, goal);
      // PERF-06: research and writing projects also get the research GSD profile and its verifier scripts (nearAi.gsd.researchProfile).
      if (usesResearchProfile(type.id) && vscode.workspace.getConfiguration('nearAi').get<boolean>('gsd.researchProfile', true) !== false) await applyResearchProfile(projectRoot);
      return applied;
    },
    drafts: { get: () => context.globalState.get(DRAFT_KEY), set: (value) => Promise.resolve(context.globalState.update(DRAFT_KEY, value)) },
    kept: { get: () => context.globalState.get(KEPT_KEY), set: (value) => Promise.resolve(context.globalState.update(KEPT_KEY, value)) },
    watch: (listener) => {
      const watching = (pattern: vscode.RelativePattern): vscode.Disposable[] => {
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        return [watcher.onDidChange((uri) => listener(uri.fsPath)), watcher.onDidCreate((uri) => listener(uri.fsPath)), watcher.onDidDelete((uri) => listener(uri.fsPath)), watcher];
      };
      const libraryWatch = watching(new vscode.RelativePattern(vscode.Uri.file(library.directory), '{*.md,.archived/*.md}'));
      // The project team file of the folder open now; pointed at the new folder's when the window's folders change.
      let projectWatch: vscode.Disposable[] = [];
      const watchProject = () => {
        projectWatch.forEach((subscription) => subscription.dispose());
        const root = rootNow();
        projectWatch = root ? watching(new vscode.RelativePattern(vscode.Uri.file(path.dirname(TeamLibrary.projectTeamFile(root))), 'team.md')) : [];
      };
      watchProject();
      const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => watchProject());
      return { dispose: () => { [...libraryWatch, ...projectWatch, folders].forEach((subscription) => subscription.dispose()); } };
    },
    onDidChangeSettings: (listener) => {
      const subscriptions = [vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('nearAi')) listener(); }), onDidChangeEmergencyStop(() => listener())];
      return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
    }
  });
  current = { panel, startWizard: (target) => studio.startWizard(target) };
  if (options.wizard) void studio.startWizard(options.wizard);
  let disposed = false;
  const postLocale = () => {
    if (!disposed && language) void panel.webview.postMessage({ type: 'staff-preview-locale', locale: language.current() });
  };
  const updates = language?.subscribe(postLocale);
  const visibility = language && panel.onDidChangeViewState(({ webviewPanel }) => {
    if (webviewPanel.visible) postLocale();
  });
  const pageMessages = language && panel.webview.onDidReceiveMessage((message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'ready') postLocale();
  });
  panel.onDidDispose(() => {
    disposed = true;
    updates?.dispose();
    visibility?.dispose();
    pageMessages?.dispose();
    current = undefined;
  }, undefined, context.subscriptions);
}
