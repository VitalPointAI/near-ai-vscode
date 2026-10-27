import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { GsdContext } from '../services/agentSession';
import { loadAgents, loadSkills } from './library';
import { GsdRuntime, gsdShellEnv } from './runtime';

/** The skills a chat surface can offer as slash commands. */
export interface GsdCommandInfo { name: string; description: string; argumentHint?: string }

/**
 * Loads the installed Open-GSD runtime for the chat surfaces: skills and agents are read from
 * whatever version is installed (cached per version), and the runtime is installed on demand.
 */
export class GsdHost {
  private cached: { home: string; context: Promise<GsdContext> } | undefined;

  public constructor(private readonly storageDir: string, public readonly runtime: GsdRuntime = new GsdRuntime(storageDir)) {}

  /** The installed runtime, or undefined when Open-GSD is not installed yet. */
  public async context(): Promise<GsdContext | undefined> {
    const home = await this.runtime.home();
    if (!home) return undefined;
    if (this.cached?.home !== home) this.cached = { home, context: this.load(home) };
    return this.cached.context;
  }

  /** Installs Open-GSD when missing, then returns it. */
  public async ensure(signal?: AbortSignal): Promise<GsdContext> {
    await this.runtime.ensure(signal);
    const context = await this.context();
    if (!context) throw new Error('Open-GSD could not be installed.');
    return context;
  }

  public async commands(): Promise<GsdCommandInfo[]> {
    const context = await this.context();
    return context ? context.skills.map((skill) => ({ name: skill.name, description: skill.description, ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}) })) : [];
  }

  private async load(home: string): Promise<GsdContext> {
    const [skills, agents, shellEnv] = await Promise.all([loadSkills(home), loadAgents(home), gsdShellEnv(home, this.storageDir, hasCommand('node'))]);
    return { home, skills, agents, shellEnv };
  }
}

function hasCommand(name: string): boolean {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  return (process.env.PATH ?? '').split(path.delimiter).some((directory) => directory && extensions.some((extension) => existsSync(path.join(directory, name + extension))));
}
