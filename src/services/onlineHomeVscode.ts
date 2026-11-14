// The editor-facing parts of "Give this project an online home" (D-14): VS Code's own GitHub sign-in, the dialogs, and the one-time offer when a NEAR AI
// project has no online home. Everything else is in onlineHome.ts and codePushCheck.ts and is tested on plain node with fakes. Nothing here acts without
// the person's click: opening a folder shows one message and nothing more. The token is returned to the flow and never shown, stored or logged here.
import * as vscode from 'vscode';
import { isNearAiProject } from '../gsd/runtime';
import { validateRepoName } from '../domain/state/onlineHome';
import type { Visibility } from '../domain/state/onlineHome';
import type { CodePushSummary } from './codePushCheck';
import { mementoProgressStore, systemGhCli } from './onlineHome';
import type { CodePushOffer, GitHubAuth, OnlineHomeUi } from './onlineHome';
import { pushCodeLaterFlow } from './codePushLater';
import type { MementoLike } from './stateHome';
import { mementoSyncSettings } from './syncFlows';
import { gitText, runStateGit } from './stateGit';
import { stateHomeFor } from './stateHome';

const NOT_NOW_KEY = 'nearAi.onlineHome.notNow';
const OFFER_BUTTON = 'Give this project an online home';
const NOT_NOW = 'Not now';
const MAX_LISTED = 30;
const NO_FOLDER = 'Open a folder first.';

/**
 * VS Code's built-in GitHub sign-in. An editor without the GitHub provider (code-server, for example) makes getSession throw, which means "not
 * available" here. The token is handed to the flow, which keeps it in memory only.
 */
export function vscodeGitHubAuth(): GitHubAuth {
  const session = (options: vscode.AuthenticationGetSessionOptions): Thenable<vscode.AuthenticationSession | undefined> =>
    vscode.authentication.getSession('github', ['repo'], options);
  return {
    available: async () => {
      try { await session({ silent: true }); return true; } catch { return false; }
    },
    token: async () => {
      try { return (await session({ createIfNone: true }))?.accessToken; } catch { return undefined; }
    }
  };
}

function listed(files: readonly string[]): string {
  const shown = files.slice(0, MAX_LISTED).join('\n');
  return files.length > MAX_LISTED ? `${shown}\nand ${files.length - MAX_LISTED} more` : shown;
}

/** A QuickPick with nothing active: pressing Enter without choosing does nothing, so neither answer is a default. */
function pickOne<T>(title: string, placeHolder: string, items: Array<vscode.QuickPickItem & { value: T }>): Promise<T | undefined> {
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { value: T }>();
    pick.title = title;
    pick.placeholder = placeHolder;
    pick.ignoreFocusOut = true;
    pick.items = items;
    let answered = false;
    pick.onDidAccept(() => {
      const chosen = pick.selectedItems[0];
      if (!chosen) return;
      answered = true;
      resolve(chosen.value);
      pick.hide();
    });
    pick.onDidHide(() => { pick.dispose(); if (!answered) resolve(undefined); });
    pick.show();
    pick.activeItems = [];
  });
}

function codePushOffer(): CodePushOffer {
  return {
    offer: async () => await vscode.window.showInformationMessage(
      "Also put this project's code on GitHub?",
      { modal: true, detail: 'You will see every file first, and files that look like passwords or keys are blocked. Syncing works without this.' },
      'Show me the files'
    ) === 'Show me the files',
    message: (text) => { void vscode.window.showInformationMessage(text); },
    confirmPush: async (summary: CodePushSummary) => {
      const notes = summary.notes.length > 0 ? `${summary.notes.join('\n')}\n\n` : '';
      return await vscode.window.showInformationMessage(
        `Push ${summary.files.length} ${summary.files.length === 1 ? 'file' : 'files'} to ${summary.remote} (${summary.branch})?`,
        { modal: true, detail: `${notes}${listed(summary.files)}` },
        'Push these files'
      ) === 'Push these files';
    },
    historyBlocked: async (text) => { await vscode.window.showWarningMessage("Your code was not pushed", { modal: true, detail: text }, "Don't push my code"); },
    confirmUnscannedHistory: async (text) => await vscode.window.showWarningMessage(
      'Your history was not fully checked',
      { modal: true, detail: text },
      'Push anyway'
    ) === 'Push anyway',
    confirmIgnore: async (files) => await vscode.window.showWarningMessage(
      'Some files look like secrets',
      { modal: true, detail: `They will not be pushed. Add them to .gitignore?\n\n${listed(files)}` },
      'Add to .gitignore'
    ) === 'Add to .gitignore',
    askIdentity: async () => {
      const name = await vscode.window.showInputBox({ title: 'Your name for this project\'s commits', prompt: 'Git has no name for you here. It is saved for this project only.', ignoreFocusOut: true });
      if (name === undefined || name.trim() === '') return undefined;
      const email = await vscode.window.showInputBox({ title: 'Your email for this project\'s commits', prompt: 'Saved for this project only. It will be visible on GitHub.', ignoreFocusOut: true });
      return email === undefined || email.trim() === '' ? undefined : { name: name.trim(), email: email.trim() };
    }
  };
}

/** The dialogs for the flow: a modal start, a QuickPick with no default for public or private, input boxes, and one progress notification for the steps. */
export function vscodeOnlineHomeUi(): OnlineHomeUi {
  let latest = '';
  let reporter: vscode.Progress<{ message?: string }> | undefined;
  let started = false;
  let ended = false;
  let end: (() => void) | undefined;
  return {
    confirmStart: async () => await vscode.window.showInformationMessage(
      'Give this project an online home?',
      { modal: true, detail: 'This creates a repository on your GitHub account (you choose public or private next) and keeps your NEAR AI project state there, encrypted. Nothing is created until you continue.' },
      'Continue'
    ) === 'Continue',
    progress: (message) => {
      latest = message;
      if (reporter) { reporter.report({ message }); return; }
      if (started) return;
      started = true;
      void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Online home' }, (progress) => {
        reporter = progress;
        progress.report({ message: latest });
        return new Promise<void>((resolve) => { end = resolve; if (ended) resolve(); });
      });
    },
    message: (text) => { void vscode.window.showInformationMessage(text); },
    pickVisibility: (notes) => pickOne<Visibility>('Public or private?', 'Choose who can see this repository', [
      { label: 'Private', detail: notes.private, value: 'private' },
      { label: 'Public', detail: notes.public, value: 'public' }
    ]),
    askName: (suggested, problem) => Promise.resolve(vscode.window.showInputBox({
      title: 'Name for the new repository',
      prompt: problem ?? 'This becomes the repository\'s name on GitHub.',
      value: suggested,
      ignoreFocusOut: true,
      validateInput: (value) => validateRepoName(value.trim()) ? undefined : 'Use letters, numbers, dots, dashes and underscores.'
    })),
    pickFallback: (choices) => pickOne<'gh' | 'url'>('GitHub sign-in is not available in this editor', 'How do you want to set up the repository?', [
      ...(choices.gh ? [{ label: 'Use the GitHub command line (gh)', detail: 'It is installed and signed in on this computer.', value: 'gh' as const }] : []),
      { label: 'Paste the address of an empty repository', detail: 'Create an empty repository on GitHub yourself, then paste its address.', value: 'url' as const }
    ]),
    askRepoUrl: (problem) => Promise.resolve(vscode.window.showInputBox({
      title: 'Address of an existing, empty repository',
      prompt: problem ?? 'For example https://github.com/you/project.git. Do not put a password or token in it.',
      ignoreFocusOut: true
    })),
    codePush: codePushOffer(),
    confirmDefaultBranch: async (branch) => {
      const make = `Make ${branch} the default`;
      return await vscode.window.showInformationMessage(
        `GitHub shows NEAR AI's encrypted sync branch first in this repository. Show ${branch} first instead?`,
        make,
        NOT_NOW
      ) === make;
    },
    done: () => { ended = true; end?.(); }
  };
}

/**
 * "NEAR AI: Put This Project's Code Online": the checked code push on the person's own command, for a project that already has an online home (G-27-6b).
 * The offer question is not asked, running the command is the choice; every other question of the checked step is.
 */
export function registerCodePushCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('nearAi.sync.pushCode', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { void vscode.window.showInformationMessage(NO_FOLDER); return; }
    await pushCodeLaterFlow({
      root,
      // What the setup saved and the remote this editor chose are kept in this editor's own storage, never in a file inside the project.
      progress: mementoProgressStore(context.globalState as MementoLike, root),
      settings: mementoSyncSettings(context.globalState as MementoLike, root),
      ui: codePushOffer(),
      auth: vscodeGitHubAuth(),
      gh: systemGhCli(),
      pickRemote: async (names) => await vscode.window.showQuickPick(names, { title: 'Which online repository should get your code?', ignoreFocusOut: true })
    });
  }));
}

async function hasRemote(root: string): Promise<boolean> {
  try {
    const listedRemotes = await runStateGit(['-C', root, 'remote']);
    return listedRemotes.code === 0 && gitText(listedRemotes) !== '';
  } catch {
    return false;
  }
}

/**
 * Shown once when a NEAR AI project (one with saved project state) has no repository or no remote. Only the person's click on the button starts
 * anything; "Not now" is remembered for this workspace, and closing the message changes nothing.
 */
export async function offerOnlineHomeAtStart(context: vscode.ExtensionContext, root: string, run: () => PromiseLike<unknown>): Promise<void> {
  if (context.workspaceState.get<boolean>(NOT_NOW_KEY) === true) return;
  if (!(await isNearAiProject(root)) && !(await stateHomeFor(root).exists())) return;
  if (await hasRemote(root)) return;
  const choice = await vscode.window.showInformationMessage(
    'This project has no online home yet, so it cannot follow you to your other computers.',
    OFFER_BUTTON,
    NOT_NOW
  );
  if (choice === OFFER_BUTTON) await run();
  else if (choice === NOT_NOW) await context.workspaceState.update(NOT_NOW_KEY, true);
}
