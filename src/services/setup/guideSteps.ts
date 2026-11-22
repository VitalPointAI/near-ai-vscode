import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { OpenGetStarted } from '../../domain/setup/answers';
import { CHECKLIST_BY_KIND } from '../../domain/setup/landing';
import { isGetStartedTarget, SETUP_STEP_IDS, type KnownSetupStepId } from '../../domain/setup/ids';
import type { SetupRegistries } from '../../domain/setup/registries';
import { fromLegacyStep, type StepContext, type SetupStepContract, type StepRegistry, type StepState } from '../../domain/setup/steps';
import { STAFF_MULTI_USER_COMMANDS } from '../../domain/staff/commands';
import { defaultStaffSettings, type StaffTeamSection } from '../../domain/staff/profiles';
import { researchProfileActive } from '../../gsd/researchProfile';
import { existingStaffSettings, requestedSection, SET_UP_STAFF_TEAM_COMMAND } from '../staffSetup';
import type { StaffSetupPreset } from '../staffSetupCommand';
import { PROJECT_TEAM_STEP, SPENDING_LIMIT_STEP, WEB_SEARCH_STEP, projectHasStaffTeam } from '../setupSteps';
import { isSharedProject, PROJECT_JSON_FILE, readSetupGuide } from './projectStore';

export const ALIAS_COMMAND_IDS = Object.freeze([
  'nearAi.projectSetup', PROJECT_TEAM_STEP.command, SET_UP_STAFF_TEAM_COMMAND, 'nearAi.newProfile'
] as const);

export const STEP_TEXT = {
  connection: { title: 'Connect an AI service', detail: 'Choose a service and check that it works in this project.' },
  'software-team': { title: PROJECT_TEAM_STEP.label, detail: PROJECT_TEAM_STEP.detail },
  'staff-team': { title: 'Set up a staff agent team', detail: 'Set up the agents and guidance for a staff section.' },
  'spending-limit': { title: SPENDING_LIMIT_STEP.label, detail: SPENDING_LIMIT_STEP.detail },
  'web-search': { title: WEB_SEARCH_STEP.label, detail: WEB_SEARCH_STEP.detail },
  'research-verifiers': { title: 'Set up research verifiers', detail: 'Add checks for citations, figures and private file paths.' },
  mcp: { title: 'Manage tools from other servers', detail: 'Choose which tools this project can use and when to ask for approval.' },
  'my-computers': { title: 'My computers', detail: 'Keep this project in sync across your computers.' },
  'share-with-people': { title: 'Share with people', detail: 'Set up sharing so others can work on this project with you.' },
  'change-answers': { title: 'Change setup answers', detail: 'Review what you told Get Started and update your choices.' }
} as const;

export function requestedSetupStep(registry: StepRegistry, target: unknown): SetupStepContract | undefined {
  if (isGetStartedTarget(target) && (SETUP_STEP_IDS as readonly string[]).includes(target)) return registry.get(target);
  return undefined;
}

export interface GuideStepDeps {
  registries: SetupRegistries;
  openStudio: (options: { wizard?: 'project' }) => void | Promise<void>;
  setUpStaffTeam: (section?: StaffTeamSection, preset?: StaffSetupPreset) => Promise<string | undefined>;
  configureConnection: () => Promise<boolean>;
  useSavedConnection: () => Promise<boolean>;
  runCommand: (id: string, ...args: unknown[]) => PromiseLike<unknown>;
  openGetStarted: OpenGetStarted;
  facts: (root?: string) => Promise<StepContext>;
}

function checklistKinds(id: KnownSetupStepId): NonNullable<SetupStepContract['kinds']> {
  const kinds = Object.keys(CHECKLIST_BY_KIND) as Array<keyof typeof CHECKLIST_BY_KIND>;
  return kinds.filter((kind) => CHECKLIST_BY_KIND[kind].includes(id));
}

const stateOf = (done: boolean): StepState => done ? 'done' : 'to-do';
const available = () => ({ available: true });
const needsProject = (ctx: StepContext) => ({ available: Boolean(ctx.root) });
// The command is registered by teamCommands.ts, which depends on the VS Code host.
const ENABLE_SHARING_COMMAND = 'nearAi.team.enable';

export function registerGuideSteps(deps: GuideStepDeps): { dispose(): void } {
  const steps = deps.registries.steps;
  const runCommand = async (id: string): Promise<void> => { await deps.runCommand(id); };
  const commandStep = (
    id: keyof typeof STEP_TEXT, command: string | ((ctx: StepContext) => string),
    state: SetupStepContract['state'], viability: SetupStepContract['viability'] = available, kinds?: SetupStepContract['kinds']
  ): SetupStepContract => ({
    id, ...STEP_TEXT[id], kinds, state, viability,
    async run(ctx) {
      await runCommand(typeof command === 'string' ? command : command(ctx));
      return { outcome: 'opened' };
    }
  });
  const connection: SetupStepContract = {
    id: 'connection', ...STEP_TEXT.connection,
    state: (ctx) => stateOf(ctx.facts.workingProfile === true),
    viability: available,
    async run() {
      return { outcome: await deps.configureConnection() ? 'done' : 'cancelled' };
    }
  };
  const software: SetupStepContract = {
    id: 'software-team', ...STEP_TEXT['software-team'], kinds: ['software'],
    state: async (ctx) => ctx.root && await PROJECT_TEAM_STEP.isDone({ ...ctx, root: ctx.root }) ? 'done' : 'to-do',
    viability: available,
    async run() {
      await deps.openStudio({ wizard: 'project' });
      return { outcome: 'opened' };
    }
  };
  const staff: SetupStepContract = {
    id: 'staff-team', ...STEP_TEXT['staff-team'], kinds: ['staff'],
    state: async (ctx) => ctx.root && await projectHasStaffTeam(ctx.root) ? 'done' : 'to-do',
    viability: available,
    async run(ctx) {
      const guide = ctx.root ? readSetupGuide(ctx.root) : undefined;
      const section = requestedSection({ section: ctx.facts.staffSection ?? guide?.answers.staffSection });
      const project = ctx.root ? await readFile(path.join(ctx.root, PROJECT_JSON_FILE), 'utf8').catch(() => undefined) : undefined;
      const settings = existingStaffSettings(project) ?? defaultStaffSettings();
      const team = await deps.setUpStaffTeam(section, { settings });
      return { outcome: team ? 'done' : 'cancelled' };
    }
  };
  const sharing = commandStep('share-with-people',
    (ctx) => ctx.kind === 'staff' && ctx.setting('staff.multiUserPreview') === true
      ? STAFF_MULTI_USER_COMMANDS.invite : ENABLE_SHARING_COMMAND,
    async (ctx) => stateOf(ctx.facts.teamActive === true || Boolean(ctx.root && await isSharedProject(ctx.root))),
    needsProject, checklistKinds('share-with-people'));
  const registrations = [
    steps.register(connection),
    steps.register(software),
    steps.register(staff),
    steps.register({ ...fromLegacyStep(SPENDING_LIMIT_STEP, runCommand), kinds: checklistKinds('spending-limit') }),
    steps.register({ ...fromLegacyStep(WEB_SEARCH_STEP, runCommand), kinds: checklistKinds('web-search') }),
    steps.register(commandStep('research-verifiers', 'nearAi.setupResearchVerifiers',
      async (ctx) => stateOf(Boolean(ctx.root && await researchProfileActive(ctx.root))), needsProject)),
    steps.register(commandStep('mcp', 'nearAi.manageMcp', (ctx) => stateOf(ctx.facts.mcpConfigured === true))),
    steps.register(commandStep('my-computers', 'nearAi.sync.turnOn',
      (ctx) => stateOf(ctx.facts.syncEnabled === true), needsProject, checklistKinds('my-computers'))),
    steps.register(sharing, { replaceable: true }),
    steps.register({
      id: 'change-answers', ...STEP_TEXT['change-answers'], state: () => 'to-do', viability: available,
      async run() {
        await deps.openGetStarted({ step: 'kind-of-work' });
        return { outcome: 'opened' };
      }
    })
  ];
  return { dispose: () => registrations.forEach((registration) => registration.dispose()) };
}
