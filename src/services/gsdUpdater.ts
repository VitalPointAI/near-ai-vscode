import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { compareVersions } from '../domain/version';

const execFileAsync = promisify(execFile);
export const GSD_PACKAGE = '@opengsd/gsd-core';
export const GSD_CHANNEL = 'latest';
export const GSD_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface GsdVersionState {
  installed: string | null;
  latest: string;
}

export interface CommandRunner {
  (command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }>;
}

export const defaultCommandRunner: CommandRunner = async (command, args, cwd) => {
  const result = await execFileAsync(command, args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
};

/** A project-local install is only refreshed where one already exists; the updater never adds one to a project. */
export const hasLocalGsdInstall = async (workspaceRoot: string): Promise<boolean> => isDirectory(path.join(workspaceRoot, '.codex', 'gsd-core'));

/**
 * A workspace counts as a NEAR AI project only after the user acts in the extension there
 * (running an Open-GSD command, saving a profile, ...), which creates `.planning/.near-ai/`.
 */
export const isNearAiProject = async (workspaceRoot: string): Promise<boolean> => isDirectory(path.join(workspaceRoot, '.planning', '.near-ai'));

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export class GsdUpdater {
  private updateInProgress = false;

  public constructor(
    private readonly runner: CommandRunner = defaultCommandRunner,
    private readonly workspaceRoot: string | undefined = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    private readonly localInstallExists: (workspaceRoot: string) => Promise<boolean> = hasLocalGsdInstall,
    private readonly projectInitiated: (workspaceRoot: string) => Promise<boolean> = isNearAiProject
  ) {}

  /** Keeps Open-GSD current in NEAR AI projects. Any other workspace gets no npm calls, timers, or notifications. */
  public async start(context: vscode.ExtensionContext): Promise<boolean> {
    if (!this.workspaceRoot || !await this.projectInitiated(this.workspaceRoot)) return false;
    void this.checkAndUpdate();
    const timer = setInterval(() => void this.checkAndUpdate(), GSD_CHECK_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
    return true;
  }

  /** Called when the user runs an Open-GSD command from the extension: installs Open-GSD only if it is missing. */
  public async ensureInstalled(): Promise<boolean> {
    if (await this.getInstalledVersion()) return true;
    return (await this.checkAndUpdate()) !== null;
  }

  public async checkAndUpdate(): Promise<GsdVersionState | null> {
    if (this.updateInProgress) return null;
    this.updateInProgress = true;
    try {
      const [installed, latest] = await Promise.all([this.getInstalledVersion(), this.getLatestVersion()]);
      const state = { installed, latest };
      if (!installed || compareVersions(installed, latest) < 0) {
        void vscode.window.showInformationMessage(
          installed
            ? `Open-GSD ${latest} is available; updating from ${installed}.`
            : `Open-GSD is not installed; installing stable ${latest} for this environment.`
        );
        await this.installLatest();
        void vscode.window.showInformationMessage(`Open-GSD ${latest} is ready.`);
      }
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(`Open-GSD update check failed: ${message}`);
      return null;
    } finally {
      this.updateInProgress = false;
    }
  }

  private async getInstalledVersion(): Promise<string | null> {
    try {
      const result = await this.runner('npm', ['list', '--global', GSD_PACKAGE, '--depth=0', '--json']);
      const parsed = JSON.parse(result.stdout) as { dependencies?: Record<string, { version?: string }> };
      return parsed.dependencies?.[GSD_PACKAGE]?.version ?? null;
    } catch {
      return null;
    }
  }

  private async getLatestVersion(): Promise<string> {
    const result = await this.runner('npm', ['view', `${GSD_PACKAGE}@${GSD_CHANNEL}`, 'version', '--json']);
    const latest = result.stdout.trim().replace(/^"|"$/g, '');
    if (!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error('The official Open-GSD registry returned an invalid version.');
    return latest;
  }

  private async installLatest(): Promise<void> {
    const installerArgs = ['--yes', `${GSD_PACKAGE}@${GSD_CHANNEL}`, '--codex', '--global'];
    await this.runner('npx', installerArgs);
    if (this.workspaceRoot && await this.localInstallExists(this.workspaceRoot)) {
      await this.runner('npx', ['--yes', `${GSD_PACKAGE}@${GSD_CHANNEL}`, '--codex', '--local'], this.workspaceRoot);
    }
  }
}
