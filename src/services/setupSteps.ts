import { access } from 'node:fs/promises';
import * as path from 'node:path';

// The one-time setup steps offered after NEAR AI is connected, and again from "NEAR AI: Project
// Setup…". Pure: no VS Code import, so the order and wording are tested in plain Node. The host
// (setupMenu.ts) builds a SetupContext, collects the registered facts, and runs the chosen step.
//
// Extension points (Team Mode plans `repository`, where the project is kept, and `invite-people`,
// who else works on it, between `project-team` and `spending-limit`):
// - registerSetupStep(step, 'project-team') puts a step into SETUP_STEPS, the one registry the
//   menu is built from, so the menu code does not change;
// - registerSetupFacts(name, provider) adds a fact to every SetupContext (ctx.facts[name]) for
//   the steps that need it, so the context grows without changing its shape.

/** What a step can ask about the project, the user's settings, and registered facts. */
export interface SetupContext {
  /** The project folder. */
  root: string;
  /** A `nearAi.*` setting's current value (the key without `nearAi.`). */
  setting(key: string): unknown;
  /** Facts added with registerSetupFacts, by name (for example `webSearchReady`). Missing when its provider failed. */
  facts: Record<string, unknown>;
}

/** Works out one fact from the base context (no facts yet). */
export type SetupFactProvider = (ctx: Omit<SetupContext, 'facts'>) => unknown;

export interface SetupStep {
  id: string;
  /** Short, plain words: what the person does. */
  label: string;
  /** One sentence on why, in plain words. */
  detail: string;
  /** A codicon name, without `$( )`. */
  icon: string;
  /** The VS Code command that runs the step. */
  command: string;
  /** Done steps stay in the menu, marked done, so people can revisit them. */
  isDone(ctx: SetupContext): boolean | Promise<boolean>;
  /** Hidden when false (for example, a step that needs a feature this project does not have). */
  isAvailable?(ctx: SetupContext): boolean | Promise<boolean>;
}

/** The project team file, as TeamLibrary.projectTeamFile names it (that module is not loaded here). */
export function projectTeamFile(root: string): string {
  return path.join(root, '.planning', '.near-ai', 'team.md');
}

/** True once the project has a team: team.md exists. project.json alone (a project type) is not a team. */
export async function projectHasTeam(root: string): Promise<boolean> {
  return access(projectTeamFile(root)).then(() => true, () => false);
}

/**
 * The paths whose creation or deletion can change whether the project has a team, relative to the
 * project folder: the team file and the folders above it (deleting a folder reports only the folder).
 */
export const PROJECT_TEAM_WATCH_PATHS = ['.planning', '.planning/.near-ai', '.planning/.near-ai/team.md', '.planning/.near-ai/project.json'] as const;

export const PROJECT_TEAM_STEP: SetupStep = {
  id: 'project-team',
  label: 'Set up your project team',
  detail: 'Tell us what this project is for. We suggest a team of agents, the models they use and how they work.',
  icon: 'organization',
  command: 'nearAi.setupProjectTeam',
  isDone: (ctx) => projectHasTeam(ctx.root)
};

export const SPENDING_LIMIT_STEP: SetupStep = {
  id: 'spending-limit',
  label: 'Set a spending limit',
  detail: 'Choose the most NEAR AI may spend in a day, so a long task never costs more than you expect.',
  icon: 'shield',
  command: 'nearAi.spendingLimits',
  isDone: (ctx) => Number(ctx.setting('dailySpendLimitUsd')) > 0
};

export const WEB_SEARCH_STEP: SetupStep = {
  id: 'web-search',
  label: 'Turn on web search',
  detail: 'Let agents look things up on the web when they need current facts.',
  icon: 'globe',
  command: 'nearAi.setUpWebSearch',
  isDone: (ctx) => ctx.facts.webSearchReady === true
};

/**
 * The registry: the setup steps, in the order they are suggested. The menu reads it each time it
 * opens. Add steps with registerSetupStep, not by editing the menu.
 */
export const SETUP_STEPS: SetupStep[] = [PROJECT_TEAM_STEP, SPENDING_LIMIT_STEP, WEB_SEARCH_STEP];

/** Puts `step` into SETUP_STEPS right after `after` (at the end when not given or not found). Dispose to take it out. */
export function registerSetupStep(step: SetupStep, after?: string): { dispose(): void } {
  const next = withSetupStep(SETUP_STEPS, step, after ?? '');
  SETUP_STEPS.splice(0, SETUP_STEPS.length, ...next);
  return { dispose: () => { const index = SETUP_STEPS.indexOf(step); if (index !== -1) SETUP_STEPS.splice(index, 1); } };
}

const FACT_PROVIDERS = new Map<string, SetupFactProvider>();

/** Adds `ctx.facts[name]` to every SetupContext the menu builds. Registering a name again replaces it. */
export function registerSetupFacts(name: string, provider: SetupFactProvider): { dispose(): void } {
  FACT_PROVIDERS.set(name, provider);
  return { dispose: () => { if (FACT_PROVIDERS.get(name) === provider) FACT_PROVIDERS.delete(name); } };
}

/** The full context: the base plus every registered fact. A provider that fails leaves its fact out. */
export async function collectSetupContext(base: Omit<SetupContext, 'facts'>): Promise<SetupContext> {
  const facts: Record<string, unknown> = {};
  for (const [name, provider] of FACT_PROVIDERS) {
    try { facts[name] = await provider(base); } catch { /* left out */ }
  }
  return { ...base, facts };
}

/** The last choice in the menu, always shown: close setup and go to the chat. */
export const START_CHATTING = {
  id: 'start-chatting',
  label: 'Start chatting',
  detail: 'Ask NEAR AI anything about this project. You can come back to these steps with NEAR AI: Project Setup.',
  icon: 'comment-discussion',
  command: 'nearAi.openChat'
} as const;

/** A copy of `steps` with `step` placed right after the step `after` (at the end when `after` is not found). */
export function withSetupStep(steps: readonly SetupStep[], step: SetupStep, after: string): SetupStep[] {
  const list = steps.filter((existing) => existing.id !== step.id);
  const index = list.findIndex((existing) => existing.id === after);
  list.splice(index === -1 ? list.length : index + 1, 0, step);
  return list;
}

export interface SetupMenuItem {
  id: string;
  label: string;
  detail: string;
  command: string;
  done: boolean;
  recommended: boolean;
}

/**
 * The menu: steps still to do first (in registry order, the first one recommended), then done
 * steps with a check and "(done)", then "Start chatting". Unavailable steps are left out.
 */
export async function buildSetupMenu(steps: readonly SetupStep[], ctx: SetupContext): Promise<SetupMenuItem[]> {
  const checked: Array<{ step: SetupStep; done: boolean }> = [];
  for (const step of steps) {
    if (step.isAvailable && !await safely(() => step.isAvailable!(ctx), true)) continue;
    checked.push({ step, done: await safely(() => step.isDone(ctx), false) });
  }
  const todo = checked.filter((entry) => !entry.done);
  const done = checked.filter((entry) => entry.done);
  return [
    ...todo.map(({ step }, index) => ({ id: step.id, label: `$(${step.icon}) ${step.label}${index === 0 ? ' (recommended)' : ''}`, detail: step.detail, command: step.command, done: false, recommended: index === 0 })),
    ...done.map(({ step }) => ({ id: step.id, label: `$(check) ${step.label} (done)`, detail: step.detail, command: step.command, done: true, recommended: false })),
    { id: START_CHATTING.id, label: `$(${START_CHATTING.icon}) ${START_CHATTING.label}`, detail: START_CHATTING.detail, command: START_CHATTING.command, done: false, recommended: false }
  ];
}

/** A step whose check fails is treated as `fallback`, so one broken check never hides the menu. */
async function safely(check: () => boolean | Promise<boolean>, fallback: boolean): Promise<boolean> {
  try { return Boolean(await check()); } catch { return fallback; }
}

/** workspaceState key: the person chose "Not now" on the chat's team card in this project. */
export const SETUP_NUDGE_DISMISSED_KEY = 'nearAi.setupNudge.dismissed';

/** The chat's "no team yet" card shows while the project has a working profile, no team, and was not dismissed. */
export function shouldShowSetupNudge(facts: { workingProfile: boolean; hasTeam: boolean; dismissed: boolean }): boolean {
  return facts.workingProfile && !facts.hasTeam && !facts.dismissed;
}

/**
 * Posts the result of the latest `refresh()` only: an older computation that finishes after a
 * newer one started, or after `set()`, is dropped. Keeps the chat's card from coming back after
 * "Not now" when a status refresh was still being worked out.
 */
export function latestOnly<T>(compute: () => Promise<T>, post: (value: T) => void): { refresh(): Promise<void>; set(value: T): void } {
  let sequence = 0;
  return {
    async refresh() {
      const mine = ++sequence;
      let value: T;
      try { value = await compute(); } catch { return; }
      if (mine === sequence) post(value);
    },
    set(value) { sequence += 1; post(value); }
  };
}
