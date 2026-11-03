import { access } from 'node:fs/promises';
import * as path from 'node:path';

// The one-time setup steps offered after NEAR AI is connected, and again from "NEAR AI: Project
// Setup…". Pure: no VS Code import, so the order and wording are tested in plain Node. The host
// (setupMenu.ts) supplies what it knows through SetupContext and runs the chosen step's command.

/** What a step can ask about the project and the user's settings. */
export interface SetupContext {
  /** The project folder. */
  root: string;
  /** A `nearAi.*` setting's current value (the key without `nearAi.`). */
  setting(key: string): unknown;
  /** Whether web search has a provider and its key or address. */
  webSearchReady(): boolean | Promise<boolean>;
}

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

/** Where a project's team and project type are kept; either one means the project has a team. */
export function projectTeamFiles(root: string): string[] {
  const folder = path.join(root, '.planning', '.near-ai');
  return [path.join(folder, 'team.md'), path.join(folder, 'project.json')];
}

/** True once the project has a team (team.md) or a project type (project.json). */
export async function projectHasTeam(root: string): Promise<boolean> {
  for (const file of projectTeamFiles(root)) {
    if (await access(file).then(() => true, () => false)) return true;
  }
  return false;
}

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
  isDone: (ctx) => ctx.webSearchReady()
};

/**
 * The setup steps, in the order they are suggested.
 *
 * Extension point: a later feature adds its step here, or with `withSetupStep(SETUP_STEPS, step,
 * 'project-team')`, and the menu needs no change. Team Mode plans `repository` (where the project
 * is kept) and `invite-people` (who else works on it) between `project-team` and `spending-limit`.
 */
export const SETUP_STEPS: readonly SetupStep[] = [PROJECT_TEAM_STEP, SPENDING_LIMIT_STEP, WEB_SEARCH_STEP];

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
