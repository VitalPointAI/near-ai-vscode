import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { compareVersions } from '../domain/version';
import { isSecretVariable } from '../agent/shell';
import { loadAgents, loadSkills } from './library';

export const GSD_PACKAGE = '@opengsd/gsd-core';
const KEEP_VERSIONS = 2;

export type ProcessRunner = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;

export const defaultProcessRunner: ProcessRunner = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd: options.cwd, env: options.env, signal: options.signal, timeout: options.timeoutMs ?? 300_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve({ stdout, stderr });
  });
});

export interface SelfTestReport { ok: boolean; version: string | null; skills: number; agents: number; problems: string[] }

/**
 * Open-GSD's Claude Code runtime, installed into the extension's own storage (never the user's
 * ~/.claude). Uses only the installer's documented contract: `npx @opengsd/gsd-core@<version>
 * --claude --global` with CLAUDE_CONFIG_DIR pointing at the target. The installer writes absolute
 * paths into the files, so every version lives in its own permanent directory and `current.json`
 * points at the active one. A new version becomes current only after it passes `selfTest`; the
 * previous version is kept for rollback.
 */
export class GsdRuntime {
  public constructor(private readonly storageDir: string, private readonly run: ProcessRunner = defaultProcessRunner) {}

  private get root(): string { return path.join(this.storageDir, 'gsd'); }
  private dirFor(version: string): string { return path.join(this.root, version); }

  /** The active runtime's config directory, or undefined when none is installed. */
  public async home(): Promise<string | undefined> {
    const version = await this.installedVersion();
    return version ? this.dirFor(version) : undefined;
  }

  public async installedVersion(): Promise<string | null> {
    try {
      const pointer = JSON.parse(await readFile(path.join(this.root, 'current.json'), 'utf8')) as { version?: unknown };
      const version = typeof pointer.version === 'string' ? pointer.version : null;
      if (!version) return null;
      return (await readVersionFile(this.dirFor(version))) === version ? version : null;
    } catch {
      return null;
    }
  }

  public async latestVersion(signal?: AbortSignal): Promise<string> {
    const { stdout } = await this.run('npm', ['view', `${GSD_PACKAGE}@latest`, 'version', '--json'], { signal, timeoutMs: 60_000 });
    const version = stdout.trim().replace(/^"|"$/g, '');
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('The npm registry returned an invalid Open-GSD version.');
    return version;
  }

  /** Installs Open-GSD if missing; returns the active runtime directory. */
  public async ensure(signal?: AbortSignal): Promise<string> {
    const home = await this.home();
    if (home) return home;
    return this.install(await this.latestVersion(signal), signal);
  }

  /** Moves to the latest stable release when it is newer. Returns the version transition, if any. */
  public async update(signal?: AbortSignal): Promise<{ from: string | null; to: string } | undefined> {
    const [installed, latest] = await Promise.all([this.installedVersion(), this.latestVersion(signal)]);
    if (installed && compareVersions(installed, latest) >= 0) return undefined;
    await this.install(latest, signal);
    return { from: installed, to: latest };
  }

  /** Installs an exact version into its own directory, checks it, then makes it current. */
  public async install(version: string, signal?: AbortSignal): Promise<string> {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Refusing to install an unversioned Open-GSD package (${version}).`);
    const target = this.dirFor(version);
    const report = await selfTest(target);
    if (!report.ok || report.version !== version) {
      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true });
      try {
        // The installer is third-party code: it gets the environment without credential-like variables.
        await this.run('npx', ['--yes', `${GSD_PACKAGE}@${version}`, '--claude', '--global'], { cwd: target, env: { ...installerEnv(), CLAUDE_CONFIG_DIR: target }, signal, timeoutMs: 300_000 });
      } catch (error) {
        await rm(target, { recursive: true, force: true });
        const detail = (error as { stderr?: string }).stderr?.trim().split('\n').slice(-3).join(' ') || (error as Error).message;
        throw new Error(`Installing Open-GSD ${version} failed: ${detail}`);
      }
      const checked = await selfTest(target);
      if (!checked.ok || checked.version !== version) {
        await rm(target, { recursive: true, force: true });
        throw new Error(`Open-GSD ${version} installed but failed the compatibility check, so the previous version stays active: ${checked.problems.slice(0, 3).join('; ')}`);
      }
    }
    await this.point(version);
    await this.prune(version);
    return target;
  }

  private async point(version: string): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temporary = path.join(this.root, `current.json.${process.pid}.tmp`);
    await writeFile(temporary, JSON.stringify({ version, activatedAt: new Date().toISOString() }), 'utf8');
    await rename(temporary, path.join(this.root, 'current.json'));
  }

  private async prune(current: string): Promise<void> {
    const versions = (await readdir(this.root).catch(() => [])).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort(compareVersions).reverse();
    for (const version of versions.filter((name) => name !== current).slice(KEEP_VERSIONS - 1)) await rm(this.dirFor(version), { recursive: true, force: true });
  }
}

function installerEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) => !isSecretVariable(name, value)));
}

async function readVersionFile(home: string): Promise<string | null> {
  try {
    const version = (await readFile(path.join(home, 'gsd-core', 'VERSION'), 'utf8')).trim();
    return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * The compatibility contract the runner relies on, checked against an installed runtime: a
 * VERSION file, gsd-tools, at least one loadable skill and agent, and every `@` include in the
 * skills resolving to a file. A future Open-GSD release that changes this layout fails here
 * instead of failing in the middle of a workflow.
 */
export async function selfTest(home: string): Promise<SelfTestReport> {
  const problems: string[] = [];
  const version = await readVersionFile(home);
  if (!version) problems.push('gsd-core/VERSION is missing or not a version');
  if (!(await stat(path.join(home, 'gsd-core', 'bin', 'gsd-tools.cjs')).catch(() => undefined))) problems.push('gsd-core/bin/gsd-tools.cjs is missing');
  const skills = await loadSkills(home).catch((error: Error) => { problems.push(`skills could not be loaded: ${error.message}`); return []; });
  const agents = await loadAgents(home).catch((error: Error) => { problems.push(`agents could not be loaded: ${error.message}`); return []; });
  if (!skills.length) problems.push('no skills were found');
  if (!agents.length) problems.push('no agents were found');
  for (const skill of skills) {
    for (const include of skill.includes) {
      if (!(await stat(include).catch(() => undefined))) problems.push(`${skill.name} includes a missing file: ${include}`);
    }
  }
  return { ok: problems.length === 0, version, skills: skills.length, agents: agents.length, problems };
}

/**
 * Environment for the agent's shell so Open-GSD's workflow snippets find this runtime:
 * CLAUDE_CONFIG_DIR points at it, and when the machine has no `node`, a wrapper that runs
 * VS Code's bundled Node is put on PATH so `gsd-tools.cjs` still runs.
 */
export async function gsdShellEnv(home: string, storageDir: string, hasSystemNode: boolean, electronNode = process.execPath): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: home };
  if (hasSystemNode || process.platform === 'win32') return env;
  const binDir = path.join(storageDir, 'bin');
  await mkdir(binDir, { recursive: true });
  const shim = path.join(binDir, 'node');
  await writeFile(shim, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${electronNode.replace(/"/g, '\\"')}" "$@"\n`, { mode: 0o755 });
  env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  return env;
}

/**
 * A workspace counts as a NEAR AI project only after the user acts in the extension there
 * (running a workflow, saving a profile, …), which creates `.planning/.near-ai/`.
 */
export async function isNearAiProject(workspaceRoot: string): Promise<boolean> {
  return Boolean((await stat(path.join(workspaceRoot, '.planning', '.near-ai')).catch(() => undefined))?.isDirectory());
}

export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Keeps an installed runtime current in NEAR AI projects: once at startup and daily. Never
 * installs (that happens only when a workflow runs) and does nothing in other workspaces.
 */
export async function startRuntimeUpdates(runtime: GsdRuntime, workspaceRoot: string | undefined, report: (message: string, failed: boolean) => void): Promise<{ dispose(): void } | undefined> {
  if (!workspaceRoot || !(await isNearAiProject(workspaceRoot))) return undefined;
  const check = async () => {
    if (!(await runtime.installedVersion())) return;
    try {
      const change = await runtime.update();
      if (change) report(`Open-GSD updated from ${change.from ?? 'none'} to ${change.to}.`, false);
    } catch (error) {
      report(`Open-GSD update check failed; the installed version stays active. ${(error as Error).message}`, true);
    }
  };
  void check();
  const timer = setInterval(() => void check(), UPDATE_INTERVAL_MS);
  return { dispose: () => clearInterval(timer) };
}
