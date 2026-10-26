import { execFile } from 'node:child_process';
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

export class GsdUpdater {
  private updateInProgress = false;

  public constructor(
    private readonly runner: CommandRunner = defaultCommandRunner,
    private readonly workspaceRoot: string | undefined = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  ) {}

  public start(context: vscode.ExtensionContext): void {
    void this.checkAndUpdate(true);
    const timer = setInterval(() => void this.checkAndUpdate(), GSD_CHECK_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  public async checkAndUpdate(startup = false): Promise<GsdVersionState | null> {
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
      } else if (startup) {
        void vscode.window.showInformationMessage(`Open-GSD ${installed} is ready.`);
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
    if (this.workspaceRoot) {
      await this.runner('npx', ['--yes', `${GSD_PACKAGE}@${GSD_CHANNEL}`, '--codex', '--local'], this.workspaceRoot);
    }
  }
}
