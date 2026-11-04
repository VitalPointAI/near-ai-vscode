// Team Mode in the editor: the two commands, solo-safe activation and the Enable flow (D-19, D-20, D-22, D-24).
// Activation in a project without .planning/.near-ai/team.json does one fs.stat and nothing else: no timers, no output channel, no status bar
// item, no storage. So this module imports only vscode, Node built-ins and types; every team module is loaded with a dynamic import after
// team.json is found or inside a command. Failures go to the NEAR AI Team output channel or to the user, never to an empty catch.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { JOIN_COMMAND, registerMemberCommands } from './memberCommands';
import { teamPrompts } from './teamPrompts';
import type { FetchLike, SessionTokens } from '../reportingSignIn';
import type { TeamSession } from './teamSession';

export const ENABLE_COMMAND = 'nearAi.team.enable';
export const VERIFY_LOG_COMMAND = 'nearAi.team.verifyLog';
export const OPEN_BOARD_COMMAND = 'nearAi.team.openBoard';
export const IMPORT_PLANS_COMMAND = 'nearAi.team.importPlans';
// G-61-3: shares exactly the team setup after one plain confirmation (src/services/team/shareFlow.ts).
export const SHARE_COMMAND = 'nearAi.team.share';
// G-61-8: Just me for now, kept per project in VS Code's workspace state under this one key and read only when the sidebar asks. It changes no team
// record, event or file, and it is cleared once the project has a team (created here or joined).
export const JUST_ME_KEY = 'nearAi.team.justMe';
// Every team action is a button in the NEAR AI sidebar, so the person is pointed there rather than at a palette command. The words speak of your
// team, never of turning a mode on (G-61-8): even one person works with a team of agents.
export const SOLO_TEXT = 'This project has no team yet. To work with other people, choose Invite someone in the NEAR AI sidebar.';
const OPEN_FOLDER_TEXT = 'Open your project folder first, then choose Invite someone in the NEAR AI sidebar.';
// G-61-2: before any question, Enable says plainly when teammates cannot reach the project's online home. Share Team Setup uses the same words.
export const TURN_ON_ANYWAY_ACTION = 'Set up anyway';
export const NOT_NOW_ACTION = 'Not now';
export const LOCAL_ONLY_TEXT = 'Teammates cannot reach this project yet, because it is kept only on this computer.';
export const LOCAL_ONLY_DETAIL = 'Put the project online where your teammates can reach it, for example on GitHub, then invite people.';
export const NOT_SHAREABLE_TEXT = 'Teammates cannot reach this project yet, because the address it is kept at online cannot be given to them as it is.';
export const NOT_SHAREABLE_DETAIL = 'Keep the project online at an address your teammates can use, for example on GitHub, with no password or token in it, then invite people.';
const ENABLE_ANYWAY_DETAIL = ' You can set up your team now and share it once the project is online.';
// J-10: the person shares Team Mode with their team through Share Team Setup. Git words stay in the output channel.
export const PUSH_ACTION = 'Share with my team';
export const VERIFY_ACTION = 'Check the team';
export const SHOW_DETAILS_ACTION = 'Show details';
export const TRY_AGAIN_ACTION = 'Try again';
const NOT_SHARED_TEXT = 'This project is not shared online yet, so a team cannot use it. A team works through the place your project is hosted, such as GitHub. Ask whoever set up the project to put it online, or choose Show details for the steps.';
// The plain sentence a person sees when Enable stops, by failure code. The technical message (git, remote, branch) goes to the output channel and
// Show details opens it. A code that is not listed shows its own message, which has no developer words in it.
const ENABLE_PLAIN_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'git-missing': 'Working with other people needs Git, the free tool used to share the project, and Git is not working on this computer. Install Git, then try again. Choose Show details for more.',
  'not-a-repo': NOT_SHARED_TEXT, 'no-commit': NOT_SHARED_TEXT, 'no-remote': NOT_SHARED_TEXT,
  'remote-unreachable': 'The place this project is hosted could not be reached, so nothing was changed. Check your internet connection and try again.',
  'exists-remotely': 'This project already has a team. Ask the team lead for an invite, then run "NEAR AI: Join Team".',
  'push-failed': 'The team could not be created online, so nothing was kept on this computer. Check your internet connection and try again. Choose Show details for more.',
  'push-unconfirmed': 'The team may have been created, but this computer could not confirm it. Choose Show details for what to check before you try again.',
  'commit-failed': 'Your team is set up, but saving it in this project did not finish. Choose Show details for the one step that is left.'
});
const SETTINGS_TEXT = 'The sharing settings of this project could not be used, so nothing was changed. Choose Show details for more.';
export const JOIN_ACTION = 'Join Team';
// G-61-1: Enable in a project where NEAR AI is not connected yet connects it right there (the chat's Set up key flow) and then carries on.
export const CONNECT_NEAR_AI_ACTION = 'Connect NEAR AI';
export const NOT_CONNECTED_TEXT = 'NEAR AI is not connected in this project yet. Connect it to set up your team.';
const NOT_CONNECTED_DETAIL = 'Connecting asks where your AI models run and for your NEAR AI key, the same as Set up in the chat. Setting up your team carries on right after.';
export const STILL_NOT_CONNECTED_TEXT = 'NEAR AI was not connected, so your team was not set up and nothing was changed.';
const OUTPUT_CHANNEL_NAME = 'NEAR AI Team';
const TEAM_FILE_PARTS = ['.planning', '.near-ai', 'team.json'];
const ENABLE_PROGRESS_TITLE = 'Setting up your team';
// The question titles: the palette's Enable flow, and the same questions when Invite someone sets the team up on the way.
const ENABLE_TITLE = 'Set up your team';
const INVITE_TITLE = 'Invite someone';
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
// onDidChange: called when Team Mode starts, restarts or stops, when a turn-on attempt ends and when Just me for now changes, so the sidebar's Team
// section can refresh.
// boardSummary (G-62-1): the board's Ready, Blocked and Mine numbers for the sidebar's one line; undefined while no session runs, before the board
// module has loaded, or once this computer's member was removed.
// justMe (G-61-8): whether Just me for now was chosen for this project, read from VS Code's workspace state (false when there is none); setJustMe
// keeps or clears it there and tells the listeners. Neither touches a team record, an event or a file.
export interface TeamModeHandle {
  ready: Promise<TeamModeState>;
  session(): TeamSession | undefined;
  onDidChange(listener: () => void): { dispose(): void };
  boardSummary(): { ready: number; blocked: number; mine: number } | undefined;
  justMe(): boolean;
  setJustMe(value: boolean): Promise<void>;
}
// The extension passes connectNearAi, the same key setup the chat's Set up button runs. Tests point the NEAR calls at a fake server and replace the
// browser sign-in and the key setup.
export interface TeamModeOptions {
  nearBaseUrl?: string;
  fetch?: FetchLike;
  signIn?: (teamId: string) => Promise<SessionTokens | undefined>;
  connectNearAi?: () => Promise<void>;
}

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
  // The pure summary function, loaded with the board once a session runs, so a project without a team never loads the board model.
  let summarize: typeof import('../../domain/team/board').boardSummary | undefined;
  let contextKeySet = false;
  const changeListeners = new Set<() => void>();

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
    const shown = teamPrompts.message(level, message, undefined);
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
      return await teamPrompts.message(level, message, undefined, ...actions);
    } catch (error) {
      output.appendLine(`A Team Mode message could not be shown: ${await describe(error)}`);
      return undefined;
    }
  }

  // Tells every listener that Team Mode may have changed. A listener that throws never stops the others; its failure goes to the channel.
  function changed(): void {
    for (const listener of [...changeListeners]) {
      try {
        listener();
      } catch (error) {
        void describe(error).then((reason) => { output.appendLine(`A Team Mode listener failed: ${reason}`); });
      }
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
      report('warn', `Your team could not start on this computer: ${await describe(error)}`);
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
        const [{ registerTeamBoard }, { boardSummary }] = await Promise.all([import('./boardView'), import('../../domain/team/board')]);
        summarize ??= boardSummary;
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

  // Just me for now lives only in VS Code's workspace state for this project; without one (an older host, a test) it reads as not chosen.
  function justMe(): boolean {
    return context.workspaceState?.get<boolean>(JUST_ME_KEY) === true;
  }

  async function setJustMe(value: boolean): Promise<void> {
    const state = context.workspaceState;
    if (state !== undefined && justMe() !== value) await state.update(JUST_ME_KEY, value ? true : undefined);
    changed();
  }

  // Once the project has a team (created here or joined), the choice no longer applies, so it is cleared. A failure is written to the channel.
  async function clearJustMe(): Promise<void> {
    if (slot.current() === undefined || !justMe()) return;
    try {
      await context.workspaceState?.update(JUST_ME_KEY, undefined);
    } catch (error) {
      output.appendLine(`Just me for now could not be cleared: ${await describe(error)}`);
    }
  }

  async function startSession(projectRoot: string): Promise<TeamModeState> {
    projectRootForSlot = projectRoot;
    const state = await slot.start();
    if (state === 'team') {
      await clearJustMe();
      await bringUpBoard();
    }
    changed();
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
    await clearJustMe();
    await bringUpBoard();
    changed();
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
    const answer = await teamPrompts.input({ ignoreFocusOut: true, ...options });
    return answer === undefined ? undefined : answer.trim();
  }

  // One modal with Connect NEAR AI; true once the person chose it and the key setup ran (whether or not it finished).
  async function connectNearAi(): Promise<boolean> {
    output.appendLine('NEAR AI is not set up in this project: .planning/.near-ai is missing. Offering the key setup before Team Mode is turned on.');
    const choice = await teamPrompts.message('warn', NOT_CONNECTED_TEXT, { modal: true, detail: NOT_CONNECTED_DETAIL }, CONNECT_NEAR_AI_ACTION);
    if (choice !== CONNECT_NEAR_AI_ACTION) return false;
    try {
      await options.connectNearAi?.();
    } catch (error) {
      output.appendLine(`The NEAR AI key setup did not finish: ${await describe(error)}`);
    }
    return true;
  }

  // Every turn-on attempt, however it ends, is reported to the listeners. 'enable' is the palette's Enable command (with the email question and the
  // closing message); 'invite' is Invite someone in a project with no team: the same checks and consent prompts, only the team name and your name
  // (both filled in), and no closing message, because the invite carries straight on. True when the team's session runs afterwards.
  async function enable(mode: 'enable' | 'invite' = 'enable'): Promise<boolean> {
    try {
      await enableOnce(mode);
    } finally {
      changed();
    }
    return slot.current() !== undefined;
  }

  // G-61-2: whether teammates can reach the online home, read from git config only. When they cannot, one modal says so with what to do and
  // the person chooses Turn on anyway or Not now; the technical steps go to the channel. Undefined means Not now.
  async function confirmOnlineHome(projectRoot: string, remote: string): Promise<{ shareable: boolean } | undefined> {
    const { checkOnlineHome } = await import('../../team/projectHome');
    const home = await checkOnlineHome(projectRoot, remote);
    if (home.kind !== 'local-only' && home.kind !== 'not-shareable') return { shareable: home.kind === 'shareable' };
    if (home.kind === 'local-only') {
      output.appendLine(`The team remote "${home.remote}" is a folder on this computer (a local path or a file:// address), so teammates cannot fetch from it. To fix: create an online repository (for example on GitHub), run git remote set-url ${home.remote} <its address>, push your branch, then invite people.`);
    } else {
      output.appendLine(`The team remote "${home.remote}" cannot be given to teammates: ${home.reason} To fix: run git remote set-url ${home.remote} <an address without a password or token> and let git keep the credential, then invite people.`);
    }
    const text = home.kind === 'local-only' ? LOCAL_ONLY_TEXT : NOT_SHAREABLE_TEXT;
    const detail = `${home.kind === 'local-only' ? LOCAL_ONLY_DETAIL : NOT_SHAREABLE_DETAIL}${ENABLE_ANYWAY_DETAIL}`;
    const choice = await teamPrompts.message('warn', text, { modal: true, detail }, TURN_ON_ANYWAY_ACTION, NOT_NOW_ACTION);
    return choice === TURN_ON_ANYWAY_ACTION ? { shareable: false } : undefined;
  }

  async function enableOnce(mode: 'enable' | 'invite'): Promise<void> {
    const projectRoot = firstFolder();
    if (projectRoot === undefined) {
      announce('error', OPEN_FOLDER_TEXT);
      return;
    }
    const enableModule = await import('../../team/enable');
    let checked = await enableModule.checkEnablePreconditions(projectRoot);
    if (!checked.ok && checked.code === 'not-initialised') {
      // G-61-1: connected right here instead of naming another command; Enable then checks again once.
      if (!(await connectNearAi())) return;
      checked = await enableModule.checkEnablePreconditions(projectRoot);
      if (!checked.ok && checked.code === 'not-initialised') {
        report('warn', STILL_NOT_CONNECTED_TEXT);
        return;
      }
    }
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
        const choice = await choose('info', message, JOIN_ACTION);
        if (choice === JOIN_ACTION) await vscode.commands.executeCommand(JOIN_COMMAND);
        return;
      }
    } catch (error) {
      if (!(error instanceof TeamFileError)) throw error;
      report('error', `${await describe(error)} Nothing was changed.`);
      return;
    }

    const defaults = await enableModule.enableDefaults(projectRoot);
    const home = await confirmOnlineHome(projectRoot, defaults.remote);
    if (home === undefined) return;
    const required = (value: string): string | undefined => (value.trim() === '' ? 'Enter a value to continue.' : undefined);
    const title = mode === 'invite' ? INVITE_TITLE : ENABLE_TITLE;
    const teamName = await ask({ title, prompt: 'Team name', value: defaults.teamName, validateInput: required });
    if (teamName === undefined) return;
    const ownerName = await ask({ title, prompt: 'Your name as teammates will see it', value: defaults.ownerName, validateInput: required });
    if (ownerName === undefined) return;
    // The email is optional, so Invite someone does not ask it; the palette's Enable still offers it.
    const ownerEmail = mode === 'invite' ? '' : await ask({ title, prompt: EMAIL_PROMPT, placeHolder: 'Your email (optional)', value: defaults.ownerEmail });
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
    output.appendLine(result.branch === undefined ? 'team.json is committed.' : `team.json is committed on ${result.branch}. Sharing puts only team.json on ${defaults.integrationBranch} at ${result.remote}.`);
    // Invite someone carries on into the invite, which shares the setup with its own confirmation, so no closing message interrupts it.
    if (mode === 'invite') {
      output.appendLine(`The team ${result.teamFile.name} was set up while inviting someone.`);
      return;
    }
    const offerShare = home.shareable && result.branch !== undefined;
    const message = !home.shareable
      ? `Your team for ${result.teamFile.name} is ready, for you only until the project is online where teammates can reach it.`
      : result.branch === undefined
        ? `Your team for ${result.teamFile.name} is ready.`
        : `Your team for ${result.teamFile.name} is ready. Share it so teammates can see the team.`;
    output.appendLine(message);
    const actions = offerShare ? [PUSH_ACTION, VERIFY_ACTION] : [VERIFY_ACTION];
    const choice = await choose('info', message, ...actions);
    if (choice === PUSH_ACTION && offerShare) {
      await vscode.commands.executeCommand(SHARE_COMMAND, { reason: 'enable' });
    } else if (choice === VERIFY_ACTION) {
      await verifyLog();
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

  // G-61-3: Share Team Setup. Only the owner or a lead may share (the member.invite decision, as Invite uses); anyone else is told who can.
  async function shareCommand(argument?: unknown): Promise<void> {
    const running = await sessionForCommand();
    const projectRoot = firstFolder();
    if (running === undefined || projectRoot === undefined) return;
    const { decideTeamAction } = await import('../../domain/team/permissions');
    const myId = running.memberId();
    if (myId === undefined) {
      report('info', 'This computer is not a member of the team yet, so it cannot share the team setup.');
      return;
    }
    if (!decideTeamAction(running.state(), myId, { kind: 'member.invite' }).allowed) {
      const role = running.state().members.get(myId)?.role ?? 'member';
      report('info', `Only the owner or a lead can share the team setup. Your role in this team is ${role}.`);
      return;
    }
    // This computer's team.json is what teammates must get; the running session may be a moment behind it.
    const { readTeamFile } = await import('../../team/teamFile');
    const teamFile = (await readTeamFile(projectRoot)) ?? running.teamFile;
    const fromEnable = typeof argument === 'object' && argument !== null && (argument as { reason?: unknown }).reason === 'enable';
    const { ensureTeamSetupShared } = await import('./shareFlow');
    await ensureTeamSetupShared({ output, announce }, {
      projectRoot, teamFile, branch: running.state().team.policy.integrationBranch, reason: fromEnable ? 'enable' : 'command'
    });
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
    const picked = await teamPrompts.pick(items, { title: IMPORT_PICK_TITLE, placeHolder: IMPORT_PICK_PLACEHOLDER, ignoreFocusOut: true });
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
    vscode.commands.registerCommand(ENABLE_COMMAND, guarded('Setting up your team', async () => { await enable('enable'); })),
    vscode.commands.registerCommand(VERIFY_LOG_COMMAND, guarded('Check Team Record', verifyLog)),
    vscode.commands.registerCommand(OPEN_BOARD_COMMAND, guarded('Open Team Board', openBoard)),
    vscode.commands.registerCommand(IMPORT_PLANS_COMMAND, guarded('Import Plans to Team Board', importPlansCommand)),
    vscode.commands.registerCommand(SHARE_COMMAND, guarded('Share Team Setup', shareCommand)),
    ...registerMemberCommands({
      context, output, report, announce, soloText: SOLO_TEXT, firstFolder, session: () => slot.current(), startSession, restartSession,
      startTeam: () => enable('invite'),
      ...(options.nearBaseUrl === undefined ? {} : { nearBaseUrl: options.nearBaseUrl }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.signIn === undefined ? {} : { signIn: options.signIn })
    }),
    { dispose: (): void => { disposed = true; slot.clear(); if (contextKeySet) setContextKey(false); changed(); changeListeners.clear(); } }
  );

  const ready = detect().catch(async (error: unknown): Promise<TeamModeState> => {
    output.appendLine(`Team Mode could not start: ${await describe(error)}`);
    return 'error';
  });
  return {
    ready,
    session: () => slot.current(),
    onDidChange(listener: () => void): { dispose(): void } {
      changeListeners.add(listener);
      return { dispose: (): void => { changeListeners.delete(listener); } };
    },
    boardSummary(): { ready: number; blocked: number; mine: number } | undefined {
      const session = slot.current();
      if (session === undefined || summarize === undefined || session.isRemoved()) return undefined;
      const state = session.state();
      const memberId = session.memberId();
      const me = memberId === undefined ? undefined : state.members.get(memberId);
      if (me?.removedEvent !== undefined || session.boardStatus().kind === 'removed') return undefined;
      return summarize(state, memberId);
    },
    justMe,
    setJustMe
  };
}
