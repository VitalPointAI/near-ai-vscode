// Team Mode in the editor: the two commands, solo-safe activation and the Enable flow (D-19, D-20, D-22, D-24).
// Activation in a project without .planning/.near-ai/team.json does one fs.stat and nothing else: no timers, no output channel, no status bar
// item, no storage. So this module imports only vscode, Node built-ins and types; every team module is loaded with a dynamic import after
// team.json is found or inside a command. Failures go to the NEAR AI Team output channel or to the user, never to an empty catch.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { JOIN_COMMAND, registerMemberCommands } from './memberCommands';
import type { FetchLike, SessionTokens } from '../reportingSignIn';
import type { TeamSession } from './teamSession';

export const ENABLE_COMMAND = 'nearAi.team.enable';
export const VERIFY_LOG_COMMAND = 'nearAi.team.verifyLog';
export const OPEN_BOARD_COMMAND = 'nearAi.team.openBoard';
export const IMPORT_PLANS_COMMAND = 'nearAi.team.importPlans';
export const SOLO_TEXT = 'Team Mode is not on for this project. Run "NEAR AI: Enable Team Mode" to turn it on.';
// J-10: the person shares Team Mode with their team; the extension does the push. Git words stay in the output channel.
export const PUSH_ACTION = 'Share with my team';
export const VERIFY_ACTION = 'Check the team';
export const SHOW_DETAILS_ACTION = 'Show details';
export const TRY_AGAIN_ACTION = 'Try again';
export const SHARED_TEXT = 'Shared with your team.';
export const SHARE_FAILED_TEXT = 'Team Mode could not be shared with your team yet. Check your internet connection, then choose Try again. Nothing was lost.';
const NOT_SHARED_TEXT = 'This project is not shared online yet, so a team cannot use it. Team Mode works through the place your project is hosted, such as GitHub. Ask whoever set up the project to put it online, or choose Show details for the steps.';
// The plain sentence a person sees when Enable stops, by failure code. The technical message (git, remote, branch) goes to the output channel and
// Show details opens it. A code that is not listed shows its own message, which has no developer words in it.
const ENABLE_PLAIN_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'git-missing': 'Team Mode needs Git, the free tool it uses to share the project, and Git is not working on this computer. Install Git, then try again. Choose Show details for more.',
  'not-a-repo': NOT_SHARED_TEXT, 'no-commit': NOT_SHARED_TEXT, 'no-remote': NOT_SHARED_TEXT,
  'remote-unreachable': 'The place this project is hosted could not be reached, so nothing was changed. Check your internet connection and try again.',
  'exists-remotely': 'This project already has a team. Ask the team lead for an invite, then run "NEAR AI: Join Team".',
  'push-failed': 'The team could not be created online, so nothing was kept on this computer. Check your internet connection and try again. Choose Show details for more.',
  'push-unconfirmed': 'The team may have been created, but this computer could not confirm it. Choose Show details for what to check before you try again.',
  'commit-failed': 'Team Mode is on, but saving it in this project did not finish. Choose Show details for the one step that is left.'
});
const SETTINGS_TEXT = 'The sharing settings of this project could not be used, so nothing was changed. Choose Show details for more.';
export const JOIN_ACTION = 'Join Team';
const OUTPUT_CHANNEL_NAME = 'NEAR AI Team';
const TEAM_FILE_PARTS = ['.planning', '.near-ai', 'team.json'];
const ENABLE_PROGRESS_TITLE = 'Enabling Team Mode';
const IMPORT_PROGRESS_TITLE = 'Importing plans to the Team Board';
const IMPORT_PICK_TITLE = 'Import plans to the Team Board';
const IMPORT_PICK_PLACEHOLDER = 'Which milestone do you want to import?';
const RECOMMENDED = 'Recommended';
const TEAM_MODE_CONTEXT_KEY = 'nearAi.teamMode';
const MILESTONE_ARGUMENT_MAX = 100;
const EMAIL_PROMPT = 'Your email is kept only as a scrambled code (a salted hash) in the team record, never as plain text.';

export type TeamModeState = 'solo' | 'team' | 'error';
// What registerTeamMode keeps of the board, which is loaded only once a session runs (a solo project never loads it).
interface BoardHandle { openPanel(): void; controller: { sessionChanged(): void } }
export interface TeamModeHandle { ready: Promise<TeamModeState>; session(): TeamSession | undefined }
// The extension passes nothing. Tests point the NEAR calls at a fake server and replace the browser sign-in.
export interface TeamModeOptions { nearBaseUrl?: string; fetch?: FetchLike; signIn?: (teamId: string) => Promise<SessionTokens | undefined> }

type Level = 'info' | 'warn' | 'error';

/**
 * The running team session of a window and the one start in flight (WR-06). start() joins a start in flight. restart() first waits for any
 * start in flight (so it never ends on a session built from the old team.json or device key), disposes what is running, then starts fresh;
 * restarts run one after another.
 */
export interface SessionSlot<T extends { dispose(): void }> {
  current(): T | undefined;
  start(): Promise<TeamModeState>;
  restart(): Promise<TeamModeState>;
  /** Forgets the session without disposing it (the window is closing and its subscriptions dispose it). */
  clear(): void;
}

export function createSessionSlot<T extends { dispose(): void }>(make: () => Promise<{ session?: T; state: TeamModeState }>): SessionSlot<T> {
  let session: T | undefined;
  let starting: Promise<TeamModeState> | undefined;
  let restarting: Promise<unknown> = Promise.resolve();

  async function start(): Promise<TeamModeState> {
    if (session !== undefined) return 'team';
    if (starting !== undefined) return starting;
    const run = (async (): Promise<TeamModeState> => {
      const made = await make();
      if (made.session !== undefined) session = made.session;
      return made.state;
    })();
    starting = run;
    try {
      return await run;
    } finally {
      if (starting === run) starting = undefined;
    }
  }

  async function restartNow(): Promise<TeamModeState> {
    // A start that began before this restart read the old team.json and device key; it is let finish and then thrown away.
    while (starting !== undefined) await starting.catch(() => undefined);
    const old = session;
    session = undefined;
    old?.dispose();
    return start();
  }

  function restart(): Promise<TeamModeState> {
    const run = restarting.then(restartNow, restartNow);
    restarting = run.catch(() => undefined);
    return run;
  }

  return { current: () => session, start, restart, clear: (): void => { session = undefined; } };
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function firstFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// The only filesystem work in a solo project: one stat. A missing file (or a file where the folder should be) means no team.
async function teamFileExists(projectRoot: string): Promise<boolean> {
  try {
    await fs.stat(path.join(projectRoot, ...TEAM_FILE_PARTS));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export function registerTeamMode(context: vscode.ExtensionContext, options: TeamModeOptions = {}): TeamModeHandle {
  let channel: vscode.OutputChannel | undefined;
  let disposed = false;
  let projectRootForSlot: string | undefined;
  let board: BoardHandle | undefined;
  let contextKeySet = false;

  // Created on first use, so a solo project never gets one.
  const output = {
    appendLine(line: string): void {
      if (channel === undefined) {
        channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
        context.subscriptions.push(channel);
      }
      channel.appendLine(line);
    },
    show(preserveFocus?: boolean): void {
      if (channel === undefined) {
        channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
        context.subscriptions.push(channel);
      }
      channel.show(preserveFocus);
    }
  };

  // Credentials in a git error are removed by the team code's own redaction, which loads only when there is something to describe.
  async function describe(error: unknown): Promise<string> {
    const text = error instanceof Error ? error.message : String(error);
    const { safeReason } = await import('./teamStatusBar');
    return safeReason(text);
  }

  // Shows a message without waiting for the user to dismiss it. A failure to show it is written to the channel.
  function announce(level: Level, message: string): void {
    const shown = level === 'info' ? vscode.window.showInformationMessage(message)
      : level === 'warn' ? vscode.window.showWarningMessage(message)
        : vscode.window.showErrorMessage(message);
    Promise.resolve(shown).catch(async (error: unknown) => {
      output.appendLine(`A Team Mode message could not be shown: ${await describe(error)}`);
    });
  }

  // A result the user must see and may need again later: shown as a message and kept in the channel.
  function report(level: Level, message: string): void {
    output.appendLine(message);
    announce(level, message);
  }

  // A message with buttons: the choice, or undefined when it is dismissed or cannot be shown (the failure goes to the channel).
  async function choose(level: Level, message: string, ...actions: string[]): Promise<string | undefined> {
    try {
      return await (level === 'info' ? vscode.window.showInformationMessage(message, ...actions)
        : level === 'warn' ? vscode.window.showWarningMessage(message, ...actions)
          : vscode.window.showErrorMessage(message, ...actions));
    } catch (error) {
      output.appendLine(`A Team Mode message could not be shown: ${await describe(error)}`);
      return undefined;
    }
  }

  // Enable stopped: the technical reason is kept in the channel, the person gets plain words and Show details (J-10).
  async function enableStopped(level: Level, code: string, message: string): Promise<void> {
    output.appendLine(message);
    const plain = ENABLE_PLAIN_TEXT[code] ?? (code === 'invalid-input' && /remote|branch/i.test(message) ? SETTINGS_TEXT : message);
    if (plain === message) {
      announce(level, plain);
      return;
    }
    if (await choose(level, plain, SHOW_DETAILS_ACTION) === SHOW_DETAILS_ACTION) output.show(true);
  }

  const slot = createSessionSlot<TeamSession>(async () => {
    const projectRoot = projectRootForSlot;
    if (projectRoot === undefined) return { state: 'solo' };
    try {
      const { readTeamFile } = await import('../../team/teamFile');
      const teamFile = await readTeamFile(projectRoot);
      if (teamFile === undefined) return { state: 'solo' };
      const { createVscodeTeamSession } = await import('./teamSession');
      const started = await createVscodeTeamSession(context, projectRoot, teamFile, output);
      if (disposed) {
        started.dispose();
        return { state: 'solo' };
      }
      return { session: started, state: 'team' };
    } catch (error) {
      report('warn', `Team Mode did not start: ${await describe(error)}`);
      return { state: 'error' };
    }
  });

  // Runs a context command without leaving a rejection behind: a failure goes to the channel.
  function setContextKey(value: boolean): void {
    Promise.resolve(vscode.commands.executeCommand('setContext', TEAM_MODE_CONTEXT_KEY, value)).catch(async (error: unknown) => {
      output.appendLine(`The Team Board view could not be ${value ? 'shown' : 'hidden'}: ${await describe(error)}`);
    });
  }

  // Once a session runs, the board is loaded (once per extension lifetime), follows the session and the view is shown. Safe to call again after
  // every start and restart. A failure here never stops the session: it is written to the channel and the next call tries again.
  async function bringUpBoard(): Promise<void> {
    if (disposed || slot.current() === undefined) return;
    try {
      if (board === undefined) {
        const { registerTeamBoard } = await import('./boardView');
        board ??= registerTeamBoard(context, { session: () => slot.current(), output });
      }
      board.controller.sessionChanged();
      if (!contextKeySet) {
        contextKeySet = true;
        setContextKey(true);
      }
    } catch (error) {
      output.appendLine(`The Team Board could not start: ${await describe(error)}`);
    }
  }

  async function startSession(projectRoot: string): Promise<TeamModeState> {
    projectRootForSlot = projectRoot;
    const state = await slot.start();
    if (state === 'team') await bringUpBoard();
    return state;
  }

  async function detect(): Promise<TeamModeState> {
    const projectRoot = firstFolder();
    if (projectRoot === undefined) return 'solo';
    try {
      if (!(await teamFileExists(projectRoot))) return 'solo';
    } catch (error) {
      output.appendLine(`Team Mode could not check this project: ${await describe(error)}`);
      return 'error';
    }
    return startSession(projectRoot);
  }

  // After a join or a NEAR link the running session is out of date (a new device key, a changed team.json), so it is replaced by a fresh one.
  // A start still in flight is waited for and thrown away first (WR-06), so the restart never ends on the old session.
  async function restartSession(projectRoot: string): Promise<void> {
    projectRootForSlot = projectRoot;
    await slot.restart();
    await bringUpBoard();
  }

  async function verifyLog(): Promise<void> {
    const projectRoot = firstFolder();
    if (projectRoot === undefined || !(await teamFileExists(projectRoot))) {
      announce('info', SOLO_TEXT);
      return;
    }
    if (slot.current() === undefined) {
      const state = await startSession(projectRoot);
      if (state === 'solo') announce('info', SOLO_TEXT);
    }
    const running = slot.current();
    if (running === undefined) return;
    await running.verifyLog();
  }

  async function ask(options: vscode.InputBoxOptions): Promise<string | undefined> {
    const answer = await vscode.window.showInputBox({ ignoreFocusOut: true, ...options });
    return answer === undefined ? undefined : answer.trim();
  }

  async function enable(): Promise<void> {
    const projectRoot = firstFolder();
    if (projectRoot === undefined) {
      announce('error', 'Open your project folder first, then run "NEAR AI: Enable Team Mode" again.');
      return;
    }
    const enableModule = await import('../../team/enable');
    const checked = await enableModule.checkEnablePreconditions(projectRoot);
    if (!checked.ok) {
      await enableStopped('error', checked.code, checked.message);
      return;
    }
    // D-22: an existing team is reported before any question is asked.
    const { TeamFileError, readTeamFile } = await import('../../team/teamFile');
    try {
      const existing = await readTeamFile(projectRoot);
      if (existing !== undefined) {
        const message = `This project already has a team: ${existing.name}. If your lead sent you an invite, join with it.`;
        output.appendLine(message);
        const choice = await vscode.window.showInformationMessage(message, JOIN_ACTION);
        if (choice === JOIN_ACTION) await vscode.commands.executeCommand(JOIN_COMMAND);
        return;
      }
    } catch (error) {
      if (!(error instanceof TeamFileError)) throw error;
      report('error', `${await describe(error)} Nothing was changed.`);
      return;
    }

    const defaults = await enableModule.enableDefaults(projectRoot);
    const required = (value: string): string | undefined => (value.trim() === '' ? 'Enter a value to continue.' : undefined);
    const teamName = await ask({ title: 'Enable Team Mode', prompt: 'Team name', value: defaults.teamName, validateInput: required });
    if (teamName === undefined) return;
    const ownerName = await ask({ title: 'Enable Team Mode', prompt: 'Your name as teammates will see it', value: defaults.ownerName, validateInput: required });
    if (ownerName === undefined) return;
    const ownerEmail = await ask({ title: 'Enable Team Mode', prompt: EMAIL_PROMPT, placeHolder: 'Your email (optional)', value: defaults.ownerEmail });
    if (ownerEmail === undefined) return;

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: ENABLE_PROGRESS_TITLE },
      () => enableModule.enableTeamMode({
        projectRoot, globalStorageDir: context.globalStorageUri.fsPath, secrets: context.secrets,
        teamName, ownerName, ...(ownerEmail === '' ? {} : { ownerEmail }),
        remote: defaults.remote, integrationBranch: defaults.integrationBranch
      })
    );

    if (!result.ok) {
      // The team exists on the remote even when only the local commit failed, so the session starts for it.
      if (result.code === 'commit-failed') await startSession(projectRoot);
      await enableStopped(result.code === 'commit-failed' ? 'warn' : result.code === 'exists-locally' ? 'info' : 'error', result.code, result.message);
      return;
    }

    await startSession(projectRoot);
    const message = result.branch === undefined
      ? `Team Mode is on for ${result.teamFile.name}.`
      : `Team Mode is on for ${result.teamFile.name}. Share it so teammates can see the team.`;
    output.appendLine(message);
    output.appendLine(result.branch === undefined ? 'team.json is committed.' : `team.json is committed on ${result.branch}. Sharing pushes ${result.branch} to ${result.remote}.`);
    const actions = result.branch === undefined ? [VERIFY_ACTION] : [PUSH_ACTION, VERIFY_ACTION];
    const choice = await vscode.window.showInformationMessage(message, ...actions);
    if (choice === PUSH_ACTION && result.branch !== undefined) {
      await share(projectRoot, result.remote, result.branch);
    } else if (choice === VERIFY_ACTION) {
      await verifyLog();
    }
  }

  // J-10: Share with my team pushes the code branch that holds team.json. A failure keeps its git reason in the channel and offers Try again.
  async function share(projectRoot: string, remote: string, branch: string): Promise<void> {
    const { pushCodeBranch } = await import('../../team/enable');
    for (;;) {
      const pushed = await pushCodeBranch(projectRoot, remote, branch);
      if (pushed.ok) {
        output.appendLine(`Pushed ${branch} to ${remote}.`);
        report('info', SHARED_TEXT);
        return;
      }
      output.appendLine(await describe(pushed.message));
      const next = await choose('error', SHARE_FAILED_TEXT, TRY_AGAIN_ACTION, SHOW_DETAILS_ACTION);
      if (next === SHOW_DETAILS_ACTION) output.show(true);
      if (next !== TRY_AGAIN_ACTION) return;
    }
  }

  // The team session of a command that needs one, started if this window has not started it yet. A solo project, or a session that did not start,
  // is explained (or already reported) and gives undefined.
  async function sessionForCommand(): Promise<TeamSession | undefined> {
    const projectRoot = firstFolder();
    if (projectRoot === undefined || !(await teamFileExists(projectRoot))) {
      announce('info', SOLO_TEXT);
      return undefined;
    }
    if (slot.current() === undefined) {
      const state = await startSession(projectRoot);
      if (state === 'solo') announce('info', SOLO_TEXT);
    }
    return slot.current();
  }

  async function openBoard(): Promise<void> {
    if (await sessionForCommand() === undefined) return;
    await bringUpBoard();
    board?.openPanel();
  }

  // The milestone to import: the page's argument (always the current one), or from the Command Palette a pick when the roadmap has more than one.
  // undefined means the current milestone; the symbol means the person dismissed the pick.
  const DISMISSED = Symbol('dismissed');
  async function chooseMilestone(running: TeamSession, projectRoot: string, argument: unknown): Promise<string | undefined | typeof DISMISSED> {
    if (typeof argument === 'object' && argument !== null && typeof (argument as { milestone?: unknown }).milestone === 'string') {
      const named = (argument as { milestone: string }).milestone;
      return named === 'current' || named.length === 0 || named.length > MILESTONE_ARGUMENT_MAX ? undefined : named;
    }
    const { listImportableMilestones } = await import('../../team/importPlans');
    const milestones = await listImportableMilestones({ projectRoot, remote: running.teamFile.coordination.remote, branch: running.state().team.policy.integrationBranch });
    if (milestones.length < 2) return undefined;
    const items = milestones.map((milestone) => ({ label: milestone.title, ...(milestone.current ? { description: RECOMMENDED } : {}), key: milestone.key, current: milestone.current }));
    const picked = await vscode.window.showQuickPick(items, { title: IMPORT_PICK_TITLE, placeHolder: IMPORT_PICK_PLACEHOLDER, ignoreFocusOut: true });
    if (picked === undefined) return DISMISSED;
    return picked.current ? undefined : picked.key;
  }

  async function importPlansCommand(argument?: unknown): Promise<void> {
    const running = await sessionForCommand();
    const projectRoot = firstFolder();
    if (running === undefined || projectRoot === undefined) return;
    const milestone = await chooseMilestone(running, projectRoot, argument);
    if (milestone === DISMISSED) return;
    const { importResultText } = await import('../../team/importPlans');
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: IMPORT_PROGRESS_TITLE, cancellable: false },
      () => running.importPlans({ mode: 'command', ...(milestone === undefined ? {} : { milestone }) })
    );
    if (!result.ok && result.detail !== undefined) output.appendLine(`Import details: ${result.detail}`);
    report(result.ok ? 'info' : 'error', importResultText(result));
  }

  // A command never leaves a rejected promise behind: the failure is written to the channel and shown.
  function guarded(title: string, handler: (...args: unknown[]) => Promise<void>): (...args: unknown[]) => Promise<void> {
    return async (...args: unknown[]): Promise<void> => {
      try {
        await handler(...args);
      } catch (error) {
        report('error', `${title} did not finish: ${await describe(error)}`);
      }
    };
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(ENABLE_COMMAND, guarded('Enable Team Mode', enable)),
    vscode.commands.registerCommand(VERIFY_LOG_COMMAND, guarded('Check Team Record', verifyLog)),
    vscode.commands.registerCommand(OPEN_BOARD_COMMAND, guarded('Open Team Board', openBoard)),
    vscode.commands.registerCommand(IMPORT_PLANS_COMMAND, guarded('Import Plans to Team Board', importPlansCommand)),
    ...registerMemberCommands({
      context, output, report, announce, soloText: SOLO_TEXT, firstFolder, session: () => slot.current(), startSession, restartSession,
      ...(options.nearBaseUrl === undefined ? {} : { nearBaseUrl: options.nearBaseUrl }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.signIn === undefined ? {} : { signIn: options.signIn })
    }),
    { dispose: (): void => { disposed = true; slot.clear(); if (contextKeySet) setContextKey(false); } }
  );

  const ready = detect().catch(async (error: unknown): Promise<TeamModeState> => {
    output.appendLine(`Team Mode could not start: ${await describe(error)}`);
    return 'error';
  });
  return { ready, session: () => slot.current() };
}
