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
export const SOLO_TEXT = 'Team Mode is not on for this project. Run "NEAR AI: Enable Team Mode" to turn it on.';
export const PUSH_ACTION = 'Push';
export const VERIFY_ACTION = 'Verify Team Log';
export const JOIN_ACTION = 'Join Team';
const OUTPUT_CHANNEL_NAME = 'NEAR AI Team';
const TEAM_FILE_PARTS = ['.planning', '.near-ai', 'team.json'];
const ENABLE_PROGRESS_TITLE = 'Enabling Team Mode';
const EMAIL_PROMPT = 'Your email is stored only as a salted hash in the team log.';

export type TeamModeState = 'solo' | 'team' | 'error';
export interface TeamModeHandle { ready: Promise<TeamModeState>; session(): TeamSession | undefined }
// The extension passes nothing. Tests point the NEAR calls at a fake server and replace the browser sign-in.
export interface TeamModeOptions { nearBaseUrl?: string; fetch?: FetchLike; signIn?: (teamId: string) => Promise<SessionTokens | undefined> }

type Level = 'info' | 'warn' | 'error';

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
  let session: TeamSession | undefined;
  let starting: Promise<TeamModeState> | undefined;
  let disposed = false;

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
    Promise.resolve(shown).catch((error: unknown) => {
      output.appendLine(`A Team Mode message could not be shown: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  // A result the user must see and may need again later: shown as a message and kept in the channel.
  function report(level: Level, message: string): void {
    output.appendLine(message);
    announce(level, message);
  }

  async function startSession(projectRoot: string): Promise<TeamModeState> {
    if (session !== undefined) return 'team';
    if (starting !== undefined) return starting;
    const run = (async (): Promise<TeamModeState> => {
      try {
        const { readTeamFile } = await import('../../team/teamFile');
        const teamFile = await readTeamFile(projectRoot);
        if (teamFile === undefined) return 'solo';
        const { createVscodeTeamSession } = await import('./teamSession');
        const started = await createVscodeTeamSession(context, projectRoot, teamFile, output);
        if (disposed) {
          started.dispose();
          return 'solo';
        }
        session = started;
        return 'team';
      } catch (error) {
        report('warn', `Team Mode did not start: ${await describe(error)}`);
        return 'error';
      }
    })();
    starting = run;
    try {
      return await run;
    } finally {
      starting = undefined;
    }
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
  async function restartSession(projectRoot: string): Promise<void> {
    const old = session;
    session = undefined;
    old?.dispose();
    await startSession(projectRoot);
  }

  async function verifyLog(): Promise<void> {
    const projectRoot = firstFolder();
    if (projectRoot === undefined || !(await teamFileExists(projectRoot))) {
      announce('info', SOLO_TEXT);
      return;
    }
    if (session === undefined) {
      const state = await startSession(projectRoot);
      if (state === 'solo') announce('info', SOLO_TEXT);
      if (session === undefined) return;
    }
    await session.verifyLog();
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
      report('error', checked.message);
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
      report('error', `${error.message} Nothing was changed.`);
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
      report(result.code === 'commit-failed' ? 'warn' : result.code === 'exists-locally' ? 'info' : 'error', result.message);
      return;
    }

    await startSession(projectRoot);
    const where = result.branch === undefined
      ? 'team.json is committed.'
      : `team.json is committed on ${result.branch}. Push it when you are ready so teammates can see the team.`;
    const message = `Team Mode is on for ${result.teamFile.name}. ${where}`;
    output.appendLine(message);
    const actions = result.branch === undefined ? [VERIFY_ACTION] : [PUSH_ACTION, VERIFY_ACTION];
    const choice = await vscode.window.showInformationMessage(message, ...actions);
    if (choice === PUSH_ACTION && result.branch !== undefined) {
      const pushed = await enableModule.pushCodeBranch(projectRoot, result.remote, result.branch);
      if (pushed.ok) report('info', `Pushed ${result.branch} to ${result.remote}.`);
      else report('error', pushed.message);
    } else if (choice === VERIFY_ACTION) {
      await verifyLog();
    }
  }

  // A command never leaves a rejected promise behind: the failure is written to the channel and shown.
  function guarded(title: string, handler: () => Promise<void>): () => Promise<void> {
    return async (): Promise<void> => {
      try {
        await handler();
      } catch (error) {
        report('error', `${title} did not finish: ${await describe(error)}`);
      }
    };
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(ENABLE_COMMAND, guarded('Enable Team Mode', enable)),
    vscode.commands.registerCommand(VERIFY_LOG_COMMAND, guarded('Verify Team Log', verifyLog)),
    ...registerMemberCommands({
      context, output, report, announce, soloText: SOLO_TEXT, firstFolder, session: () => session, startSession, restartSession,
      ...(options.nearBaseUrl === undefined ? {} : { nearBaseUrl: options.nearBaseUrl }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.signIn === undefined ? {} : { signIn: options.signIn })
    }),
    { dispose: (): void => { disposed = true; session = undefined; } }
  );

  const ready = detect().catch(async (error: unknown): Promise<TeamModeState> => {
    output.appendLine(`Team Mode could not start: ${await describe(error)}`);
    return 'error';
  });
  return { ready, session: () => session };
}
