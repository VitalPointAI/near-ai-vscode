// Team Mode in the editor: the two commands, solo-safe activation and the Enable flow (D-19, D-20, D-22, D-24).
// Activation in a project without .planning/.near-ai/team.json does one fs.stat and nothing else: no timers, no output channel, no status bar
// item, no storage. So this module imports only vscode, Node built-ins and types; every team module is loaded with a dynamic import after
// team.json is found or inside a command. Failures go to the NEAR AI Team output channel or to the user, never to an empty catch.
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { VerifyReport } from '../../team/eventLog';
import type { TeamSession } from './teamSession';

export const ENABLE_COMMAND = 'nearAi.team.enable';
export const VERIFY_LOG_COMMAND = 'nearAi.team.verifyLog';
export const SOLO_TEXT = 'Team Mode is not on for this project. Run "NEAR AI: Enable Team Mode" to turn it on.';
export const PUSH_ACTION = 'Share with my team';
export const SHARED_TEXT = 'Shared with your team.';
export const PREVIEW_OFF_TEXT = 'Team Mode is an early preview and is off. Turn on the setting nearAi.team.preview in Settings, then run "NEAR AI: Enable Team Mode" again.';
export const VERIFY_ACTION = 'Verify Team Log';
export const TRUST_NEW_TEAM_ACTION = 'Trust this new team';
export const TRUST_CONFIRM_ACTION = 'Trust this team';
const OUTPUT_CHANNEL_NAME = 'NEAR AI Team';
const TEAM_FILE_PARTS = ['.planning', '.near-ai', 'team.json'];
const ENABLE_PROGRESS_TITLE = 'Enabling Team Mode';

export type TeamModeState = 'solo' | 'team' | 'error';
export interface TeamModeHandle { ready: Promise<TeamModeState>; session(): TeamSession | undefined }

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

export function registerTeamMode(context: vscode.ExtensionContext): TeamModeHandle {
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
        const { TrustPinError } = await import('../../team/teamFile');
        if (error instanceof TrustPinError) {
          // Not awaited: the session state settles now, and the person answers whenever they choose.
          void offerTrust(projectRoot, await describe(error));
          return 'error';
        }
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

  // One disposer for the running session: it stops the poll timer and removes the status bar item (TeamSession.dispose), and it is the only
  // place that forgets the session, so nothing is left running when the extension stops or the session is replaced.
  function stopSession(): void {
    const current = session;
    session = undefined;
    current?.dispose();
  }

  // D-16: a team.json that names a different team, genesis or owner key than this project had is refused. Trusting it is a deliberate act:
  // the person picks the action, then confirms in a modal that names the team and its owner key; only then is the project's pin replaced.
  async function offerTrust(projectRoot: string, reason: string): Promise<void> {
    try {
      output.appendLine(`Team Mode did not start: ${reason}`);
      const choice = await vscode.window.showWarningMessage(`Team Mode did not start: ${reason}`, TRUST_NEW_TEAM_ACTION);
      if (choice !== TRUST_NEW_TEAM_ACTION || disposed) return;
      const { pinTrust, projectTrustDir, readTeamFile } = await import('../../team/teamFile');
      const teamFile = await readTeamFile(projectRoot);
      if (teamFile === undefined) return;
      const detail = `Only continue if your team confirmed this change. The project's team.json now names the team "${teamFile.name}" (${teamFile.teamId}), whose owner key fingerprint is ${teamFile.genesis.ownerDevice.fingerprint}. This computer will trust that team for this project from now on.`;
      const confirmed = await vscode.window.showWarningMessage('Trust a different team for this project?', { modal: true, detail }, TRUST_CONFIRM_ACTION);
      if (confirmed !== TRUST_CONFIRM_ACTION || disposed) return;
      await pinTrust(projectTrustDir(context.globalStorageUri.fsPath, projectRoot), teamFile);
      output.appendLine(`This project now trusts the team ${teamFile.name} (${teamFile.teamId}).`);
      // The refused start may still be settling; wait for it so this start is not folded into it.
      while (starting !== undefined) await starting;
      await startSession(projectRoot);
    } catch (error) {
      report('error', `The new team could not be trusted: ${await describe(error)}`);
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

  // Resolves to the report it printed, or undefined in a solo project or when the check could not finish (D-30: the extension-host test reads it).
  async function verifyLog(): Promise<VerifyReport | undefined> {
    const projectRoot = firstFolder();
    if (projectRoot === undefined || !(await teamFileExists(projectRoot))) {
      announce('info', SOLO_TEXT);
      return undefined;
    }
    if (session === undefined) {
      const state = await startSession(projectRoot);
      if (state === 'solo') announce('info', SOLO_TEXT);
      if (session === undefined) return undefined;
    }
    return session.verifyLog();
  }

  async function ask(options: vscode.InputBoxOptions): Promise<string | undefined> {
    const answer = await vscode.window.showInputBox({ ignoreFocusOut: true, ...options });
    return answer === undefined ? undefined : answer.trim();
  }

  async function enable(): Promise<void> {
    // The Command Palette hides Enable while the preview is off, but a keybinding or another command can still call it, so it refuses here too:
    // the device key is only ever created for a person who turned the preview on. The core checks again from the flag passed below.
    if (!vscode.workspace.getConfiguration('nearAi').get<boolean>('team.preview', false)) {
      announce('info', PREVIEW_OFF_TEXT);
      return;
    }
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
        report('info', `This project already has a team: ${existing.name}. Joining an existing team arrives with team invitations.`);
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

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: ENABLE_PROGRESS_TITLE },
      () => enableModule.enableTeamMode({
        projectRoot, globalStorageDir: context.globalStorageUri.fsPath, secrets: context.secrets,
        teamName, ownerName, remote: defaults.remote, integrationBranch: defaults.integrationBranch, checked, previewEnabled: true,
        warn: (message) => output.appendLine(message)
      })
    );

    if (!result.ok) {
      // The team exists on the remote even when only the local commit failed, so the session starts for it.
      if (result.code === 'commit-failed') await startSession(projectRoot);
      report(result.code === 'commit-failed' ? 'warn' : result.code === 'exists-locally' ? 'info' : 'error', result.message);
      return;
    }

    await startSession(projectRoot);
    const message = result.branch === undefined
      ? `Team Mode is on for ${result.teamFile.name}.`
      : `Team Mode is on for ${result.teamFile.name}. Share it so teammates can see the team.`;
    output.appendLine(message);
    output.appendLine(result.branch === undefined
      ? 'team.json is committed.'
      : `team.json is committed on ${result.branch}. Sharing pushes ${result.branch} to ${result.remote}.`);
    const actions = result.branch === undefined ? [VERIFY_ACTION] : [PUSH_ACTION, VERIFY_ACTION];
    const choice = await vscode.window.showInformationMessage(message, ...actions);
    if (choice === PUSH_ACTION && result.branch !== undefined) {
      const pushed = await enableModule.pushCodeBranch(projectRoot, result.remote, result.branch);
      if (pushed.ok) {
        output.appendLine(`Pushed ${result.branch} to ${result.remote}.`);
        report('info', SHARED_TEXT);
      }
      else report('error', pushed.message);
    } else if (choice === VERIFY_ACTION) {
      await verifyLog();
    }
  }

  // A command never leaves a rejected promise behind: the failure is written to the channel and shown.
  function guarded<T>(title: string, handler: () => Promise<T>): () => Promise<T | undefined> {
    return async (): Promise<T | undefined> => {
      try {
        return await handler();
      } catch (error) {
        report('error', `${title} did not finish: ${await describe(error)}`);
        return undefined;
      }
    };
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(ENABLE_COMMAND, guarded('Enable Team Mode', enable)),
    vscode.commands.registerCommand(VERIFY_LOG_COMMAND, guarded('Verify Team Log', verifyLog)),
    { dispose: (): void => { disposed = true; stopSession(); } }
  );

  const ready = detect().catch(async (error: unknown): Promise<TeamModeState> => {
    output.appendLine(`Team Mode could not start: ${await describe(error)}`);
    return 'error';
  });
  return { ready, session: () => session };
}

// ---- Test-only seam (D-30) ----
// Built only by src/extension.ts, inside the NEAR_AI_E2E === '1' return of activate, like the rest of NearAiTestApi. The extension-host test reads
// the team session and checks that no rendering of the device key reached a file. The private key never crosses this seam: the test receives the
// fingerprint, the public key and SHA-256 digests of the private renderings, and the key, its DER bytes and its seed are never returned, logged,
// written or put in an error message.

export interface DeviceKeyEvidence {
  readonly fingerprint: string;
  readonly publicKey: { readonly base64: string; readonly base64url: string; readonly hex: string };
  readonly privateKeySha256: string;
  readonly privateFormDigests: ReadonlyArray<{ readonly length: number; readonly sha256: string }>;
}

export interface TeamModeTestApi {
  readonly ready: Promise<TeamModeState>;
  session(): TeamSession | undefined;
  deviceKeyEvidence(): Promise<DeviceKeyEvidence | undefined>;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// The stored key is base64 PKCS#8 for Ed25519: a fixed header and the 32 byte seed. Each text a leak could take: the PKCS#8 DER as stored
// (base64), as base64url and as hex; the seed as hex, base64url and base64 (padded and unpadded); and the SPKI DER of its public half as hex.
// Repeats are dropped (base64 and base64url are the same text when the key has no + or /). Only digests and lengths leave this function.
function privateRenderingDigests(stored: string): Array<{ length: number; sha256: string }> {
  const der = Buffer.from(stored, 'base64');
  const seed = der.subarray(der.length - 32);
  const spki = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' });
  const seedBase64 = seed.toString('base64');
  const forms = [...new Set([
    stored, der.toString('base64url'), der.toString('hex'),
    seed.toString('hex'), seed.toString('base64url'), seedBase64, seedBase64.replace(/=+$/, ''),
    spki.toString('hex')
  ])];
  return forms.map((form) => ({ length: form.length, sha256: sha256Hex(form) }));
}

export function teamModeTestApi(context: vscode.ExtensionContext, handle: TeamModeHandle): TeamModeTestApi {
  return {
    ready: handle.ready,
    session: handle.session,
    async deviceKeyEvidence(): Promise<DeviceKeyEvidence | undefined> {
      const { DEVICE_KEY_SECRET, loadDeviceIdentity } = await import('../../team/identity');
      const stored = await context.secrets.get(DEVICE_KEY_SECRET);
      if (stored === undefined || stored === '') return undefined;
      const identity = await loadDeviceIdentity(context.secrets);
      if (identity === undefined) return undefined;
      const raw = Buffer.from(identity.publicKey, 'base64url');
      return {
        fingerprint: identity.fingerprint,
        publicKey: { base64: raw.toString('base64'), base64url: raw.toString('base64url'), hex: raw.toString('hex') },
        privateKeySha256: sha256Hex(stored),
        privateFormDigests: privateRenderingDigests(stored)
      };
    }
  };
}
