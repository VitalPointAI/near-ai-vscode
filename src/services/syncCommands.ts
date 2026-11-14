// The editor side of project sync (D-01, D-02, D-10, D-14, D-16, D-17): the commands in the Command Palette, the dialogs, the safe moments sync runs
// at, and the status the chat panel's sync control shows. Everything that decides something is in syncFlows.ts and stateRestore.ts and is tested on
// plain node; this file only connects them to VS Code. It never prompts for a GitHub sign-in on its own: every background or automatic sync asks the
// GitHub session silently (a missing session becomes "needs sign-in" on the status), and only a person's click may open the sign-in.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AuthService } from './auth';
import { ProfileStore } from './profileStore';
import { mementoProgressStore, onlineHomeFlow, systemGhCli } from './onlineHome';
import { offerOnlineHomeAtStart, vscodeGitHubAuth, vscodeOnlineHomeUi } from './onlineHomeVscode';
import { onRunEnded, runsInFlight } from './runEndHooks';
import { RunMarkers } from './runMarkers';
import { runStateGit } from './stateGit';
import { editorWriter, stateHomeFor, type MementoLike } from './stateHome';
import { stateKeysFor } from './stateKeys';
import { discardPreviousState, profileSyncHooks } from './stateRestore';
import type { SyncOutcome } from './stateSync';
import {
  SyncScheduler, afterRemoteFor, buildStateSync, enterCodeFlow, keepKeyFlow, localHomeState, mementoSyncSettings, newCodeFlow, removeOldInProjectSyncFolders, resolveRemote, statusSentence, tokenRunner, turnOffFlow, turnOnFlow,
  type SyncEnv, type SyncParts, type SyncSettingsStore, type SyncStatus, type SyncUi
} from './syncFlows';
import { threadStoreFor } from './threadStore';

const NO_HOME = 'This project has no online home yet.';
const NO_FOLDER = 'Open a folder first.';

/** One project's sync, as this editor runs it. */
interface Runtime {
  root: string;
  env: SyncEnv;
  parts: SyncParts;
  scheduler: SyncScheduler;
}

const runtimes = new Map<string, Runtime>();
const statusListeners = new Set<(root: string, status: SyncStatus) => void>();

/** Calls `listener` whenever a project's sync status changes (what the chat panel's control shows). Dispose the result to stop. */
export function onSyncStatus(listener: (root: string, status: SyncStatus) => void): { dispose(): void } {
  statusListeners.add(listener);
  return { dispose: () => { statusListeners.delete(listener); } };
}

/** The sync status of a project in this editor: 'off' until sync is turned on. */
export function currentSyncStatus(root: string): SyncStatus {
  return runtimes.get(path.resolve(root))?.scheduler.status() ?? { state: 'off' };
}

/** Editor closing: one bounded sync attempt for every project, never relied on and never failing the close. */
export async function flushSyncOnClose(): Promise<void> {
  await Promise.all([...runtimes.values()].map((runtime) => runtime.scheduler.flushOnClose().catch(() => undefined)));
}

/**
 * While sync is off, works out from a local look at the project's remotes whether it has an online home, and tells the control (D-16: "No online home ·
 * Set up" from the moment the panel opens). Nothing is fetched, no network is contacted and nothing is written. With sync on the scheduler's own state
 * stands; before the editor has set sync up for this project it does nothing.
 */
export async function refreshSyncHome(root: string): Promise<void> {
  const runtime = runtimes.get(path.resolve(root));
  if (!runtime || runtime.scheduler.isEnabled()) return;
  const found = await localHomeState(runtime.root, runtime.parts.git);
  if (found === 'unknown' || runtime.scheduler.isEnabled()) return;
  runtime.scheduler.setHomeKnown(found === 'home');
}

const settings = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('nearAi');
const keepKeyInProject = (): boolean => settings().get<boolean>('sync.keepKeyInProject', true);

/**
 * The GitHub token for a sync. An automatic sync (any trigger but a click) asks the session silently and gets nothing when there is none; only a
 * person's click may open the sign-in. A provider that is missing (code-server) is no token.
 */
async function githubToken(interactive: boolean): Promise<string | undefined> {
  try {
    const session = await vscode.authentication.getSession('github', ['repo'], interactive ? { createIfNone: true } : { silent: true });
    return session?.accessToken;
  } catch {
    return undefined;
  }
}

function vscodeSyncUi(): SyncUi {
  return {
    showCodeOnce: async (code) => {
      // Shown in an input box so it can be copied; closing it without a click on the button below means the code was not saved.
      await vscode.window.showInputBox({
        title: 'Your recovery code',
        prompt: 'Your recovery code. Copy it now and keep it somewhere safe. It is shown only this once.',
        value: code,
        ignoreFocusOut: true
      });
      const saved = 'I have saved it';
      return await vscode.window.showInformationMessage(
        'Have you saved your recovery code?',
        { modal: true, detail: 'It will not be shown again, and without it you cannot open this project on another computer.' },
        saved
      ) === saved;
    },
    askCode: () => Promise.resolve(vscode.window.showInputBox({
      title: 'Enter your recovery code',
      prompt: 'The recovery code you saved when you turned on project sync.',
      password: true,
      ignoreFocusOut: true
    })),
    confirm: async (text) => await vscode.window.showInformationMessage('NEAR AI project sync', { modal: true, detail: text }, 'Continue') === 'Continue',
    pickRemote: (names) => Promise.resolve(vscode.window.showQuickPick(names, { title: 'Which remote should hold this project\'s state?', placeHolder: 'Choose one. You are asked only once.', ignoreFocusOut: true })),
    info: (text) => { void vscode.window.showInformationMessage(text); },
    warn: (text) => { void vscode.window.showWarningMessage(text); }
  };
}

/** Looks at a restored profile in the background and makes it this project's active one when it passes, so no key is typed again. */
async function checkRestoredProfiles(root: string, auth: AuthService): Promise<void> {
  const store = new ProfileStore(root, auth);
  for (const profile of await store.list()) {
    if (profile.keySource || profile.validation.status !== 'stale') continue;
    const checked = await store.validate(profile.profileId).catch(() => undefined);
    if (checked?.validation.status === 'valid' && !(await store.getActiveSelection())) await store.select(profile.profileId).catch(() => undefined);
  }
}

function runtimeFor(context: vscode.ExtensionContext, auth: AuthService, root: string): Runtime {
  const resolved = path.resolve(root);
  const existing = runtimes.get(resolved);
  if (existing) return existing;
  const writer = editorWriter(context.globalState as MementoLike);
  const home = stateHomeFor(resolved);
  const keys = stateKeysFor(resolved, context.secrets, keepKeyInProject);
  const threads = threadStoreFor(resolved, context.secrets, writer, keepKeyInProject);
  // The run state of a marker depends only on the marker and this editor's writer id, so this store reads the same answers as the chat's own.
  const markers = new RunMarkers(context.globalStorageUri.fsPath, resolved, { dir: home.paths.runs, writer });
  const parts: SyncParts = {
    root: resolved, home, keys, threads, writer, git: runStateGit,
    // The private mirror lives in this editor's own storage, never inside the project (REVIEW B1).
    mirrorRoot: path.join(context.globalStorageUri.fsPath, 'sync-mirrors'),
    isIdle: () => runsInFlight(resolved) === 0,
    runState: (marker) => markers.runState(marker),
    profiles: profileSyncHooks(resolved, auth, keys, home)
  };
  // Whether sync is on and which remote it uses live in this editor's own storage, never in a file inside the project (REVIEW B1). A switch an earlier
  // build kept in meta.json is adopted once, and only when this editor can already open the project's key.
  const syncSettings = mementoSyncSettings(context.globalState as MementoLike, resolved, { home, keys, git: runStateGit });
  const scheduler: SyncScheduler = new SyncScheduler({
    runsInFlight: () => runsInFlight(resolved),
    intervalMinutes: () => settings().get<unknown>('sync.intervalMinutes', 10),
    runSync: (request) => runOnce(parts, resolved, syncSettings, request.mode, request.interactive)
  });
  scheduler.onStatus((status) => { for (const listener of [...statusListeners]) { try { listener(resolved, status); } catch { /* a listener never stops sync */ } } });
  const env: SyncEnv = {
    root: resolved, home, keys, threads, git: runStateGit, keepKeyInProject, writer, settings: syncSettings,
    // These syncs are a person's action (a command they ran), so a GitHub sign-in may be asked for.
    makeSync: (input) => buildStateSync(parts, { ...input, git: input.git ?? tokenRunner(runStateGit, () => githubToken(true)) }),
    // A join waits while a chat runs in this editor or, by the shared run markers, in another editor on this computer.
    runsLive: async () => runsInFlight(resolved) > 0 || (await markers.liveRuns()).length > 0,
    onEnabled: (on) => scheduler.setEnabled(on),
    afterRestore: () => { void checkRestoredProfiles(resolved, auth).catch(() => undefined); }
  };
  const runtime: Runtime = { root: resolved, env, parts, scheduler };
  runtimes.set(resolved, runtime);
  return runtime;
}

/** One automatic or manual sync: the remote the project already uses (never asked about here), the GitHub session asked silently unless this is a click. */
async function runOnce(parts: SyncParts, root: string, syncSettings: SyncSettingsStore, mode: 'sync' | 'pull', interactive: boolean): Promise<SyncOutcome> {
  const found = await resolveRemote({ root, git: runStateGit, settings: syncSettings }, { pickRemote: async () => undefined });
  if (found.kind === 'none') return { kind: 'failed', message: NO_HOME, failure: { kind: 'no-remote', message: NO_HOME } };
  if (found.kind === 'cancelled') return { kind: 'refused', message: 'Sync could not tell which remote to use. Run Turn On Project Sync to choose one.' };
  const sync = buildStateSync(parts, { remote: found.name, git: tokenRunner(runStateGit, () => githubToken(interactive)) });
  const outcome = await (mode === 'sync' ? sync.sync() : sync.pullOnly());
  // A folder kept from before a join goes after the first sync that pushed the joined state, and only when every conversation in it is in that state. It
  // is not waited for: the status never depends on it, and it does nothing when no such folder is there.
  if (mode === 'sync' && outcome.kind === 'synced') void discardPreviousState(root, parts.threads).catch(() => undefined);
  return outcome;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Tells the scheduler how a flow's own first sync went, so the control shows it. */
function note(runtime: Runtime, status: string, message: string): void {
  if (status === 'on' || status === 'restored') runtime.scheduler.recordOutcome({ kind: 'synced', message, pushed: true });
  else if (status === 'pending') runtime.scheduler.recordOutcome({ kind: 'failed', message });
  else if (status === 'no-home') runtime.scheduler.setNoHome();
}

export function registerSyncCommands(context: vscode.ExtensionContext, auth: AuthService): void {
  const ui = vscodeSyncUi();
  const onlineHome = (runtime: Runtime) => (afterRemote: Parameters<typeof onlineHomeFlow>[0]['afterRemote']) =>
    onlineHomeFlow({ root: runtime.root, progress: mementoProgressStore(context.globalState as MementoLike, runtime.root), ui: vscodeOnlineHomeUi(), auth: vscodeGitHubAuth(), gh: systemGhCli(), afterRemote });
  const withRuntime = (work: (runtime: Runtime) => Promise<unknown>) => async (): Promise<void> => {
    const root = workspaceRoot();
    if (!root) { void vscode.window.showInformationMessage(NO_FOLDER); return; }
    await work(runtimeFor(context, auth, root));
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('nearAi.sync.turnOn', withRuntime(async (runtime) => {
      const result = await turnOnFlow({ env: runtime.env, ui, onlineHome: onlineHome(runtime) });
      note(runtime, result.status, result.message);
      await refreshSyncHome(runtime.root);
    })),
    vscode.commands.registerCommand('nearAi.sync.now', withRuntime(async (runtime) => {
      if (!runtime.scheduler.isEnabled()) {
        const choice = await vscode.window.showInformationMessage('Project sync is off for this project.', 'Turn On Project Sync');
        if (choice) await vscode.commands.executeCommand('nearAi.sync.turnOn');
        return;
      }
      const outcome = await runtime.scheduler.syncNow();
      if (outcome) void (outcome.kind === 'synced' || outcome.kind === 'nothing-yet' || outcome.kind === 'waiting' ? vscode.window.showInformationMessage(outcome.message) : vscode.window.showWarningMessage(statusSentence(outcome, true)));
    })),
    vscode.commands.registerCommand('nearAi.sync.enterRecoveryCode', withRuntime(async (runtime) => {
      const result = await enterCodeFlow({ env: runtime.env, ui });
      note(runtime, result.status, result.message);
    })),
    vscode.commands.registerCommand('nearAi.sync.newRecoveryCode', withRuntime((runtime) => newCodeFlow({ env: runtime.env, ui }))),
    vscode.commands.registerCommand('nearAi.sync.turnOff', withRuntime(async (runtime) => {
      await turnOffFlow({ env: runtime.env, ui });
      await refreshSyncHome(runtime.root);
    })),
    vscode.commands.registerCommand('nearAi.sync.onlineHome', withRuntime(async (runtime) => {
      const result = await onlineHome(runtime)(afterRemoteFor(runtime.env, ui));
      if (result.status === 'done') note(runtime, 'on', 'Your project is encrypted and saved on your git host.');
      await refreshSyncHome(runtime.root);
    })),
    // The key file setting: changing it runs the flow that makes the change safe; a flow that did not finish puts the setting back.
    vscode.workspace.onDidChangeConfiguration((event) => {
      const root = workspaceRoot();
      if (!root) return;
      if (event.affectsConfiguration('nearAi.sync.intervalMinutes')) runtimes.get(path.resolve(root))?.scheduler.reschedule();
      if (event.affectsConfiguration('nearAi.sync.keepKeyInProject')) void applyKeyFileSetting(runtimeFor(context, auth, root), ui);
    }),
    vscode.window.onDidChangeWindowState((state) => { for (const runtime of runtimes.values()) runtime.scheduler.windowFocus(state.focused); }),
    onRunEnded((event) => { runtimes.get(path.resolve(event.root))?.scheduler.runEnded(); })
  );

  // Opening the project with sync on: a pull starts at once and is not waited for. Nothing here writes anything for a project that never turned sync on.
  const root = workspaceRoot();
  if (!root) return;
  const runtime = runtimeFor(context, auth, root);
  // What earlier dev builds kept inside the project (the sync mirror and hooks folder) is removed once; it never creates the state home.
  void removeOldInProjectSyncFolders(runtime.env.home);
  void (runtime.env.settings as SyncSettingsStore).read().then((found) => {
    runtime.scheduler.setEnabled(found.enabled);
    runtime.scheduler.start();
    return refreshSyncHome(root);
  }).catch(() => undefined);
  void offerOnlineHomeAtStart(context, root, () => vscode.commands.executeCommand('nearAi.sync.onlineHome')).catch(() => undefined);
}

let revertingKeyFileSetting = false;

async function applyKeyFileSetting(runtime: Runtime, ui: SyncUi): Promise<void> {
  if (revertingKeyFileSetting) return;
  const on = keepKeyInProject();
  const result = await keepKeyFlow({ env: runtime.env, ui }, on).catch(() => ({ status: 'failed' as const }));
  if (result.status === 'done') return;
  // Not done (declined, or the project is locked here): the setting goes back to what the files say.
  const inspected = settings().inspect<boolean>('sync.keepKeyInProject');
  const target = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  revertingKeyFileSetting = true;
  try { await settings().update('sync.keepKeyInProject', !on, target); } finally { revertingKeyFileSetting = false; }
}
