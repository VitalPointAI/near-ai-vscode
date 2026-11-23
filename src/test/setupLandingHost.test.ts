import assert from 'node:assert/strict';
import test from 'node:test';
import { createSetupRegistries } from '../domain/setup/registries';
import { defaultStaffSettings } from '../domain/staff/profiles';
import { resolveLanding } from '../domain/setup/landing';
import type { StepContext } from '../domain/setup/steps';
import { refreshSetupContext } from '../services/setup/contextKeys';
import { registerGuideSteps } from '../services/setup/guideSteps';
import { createLandingHost } from '../services/setup/landingHost';

function host(ctx: StepContext) {
  const registries = createSetupRegistries();
  const calls: unknown[][] = [];
  const walkthroughId = 'example.near-ai#nearAi.getStarted';
  const context = async () => ctx;
  const runCommand = async (...args: unknown[]) => { calls.push(args); };
  registerGuideSteps({
    registries, facts: context, runCommand,
    openStudio: async (options: unknown) => { calls.push(['studio', options]); },
    setUpStaffTeam: async (...args: unknown[]) => { calls.push(['staff', ...args]); return 'j2.md'; },
    configureConnection: async () => true, useSavedConnection: async () => false,
    openGetStarted: async () => {}
  });
  const landing = createLandingHost({
    steps: registries.steps, runCommand, context, walkthroughId,
    openPolicyEditor: () => calls.push(['policy']),
    openGuideOptions: async () => { calls.push(['options']); }
  });
  return { calls, landing, registries, walkthroughId };
}

const checklistCall = (id: string) => ['workbench.action.openWalkthrough', id, false];

test('SC6 (host level): staff J2 runs the preset before opening the Staff Room and checklist', async () => {
  const ctx: StepContext = { root: 'project', kind: 'staff', facts: {}, setting: () => undefined };
  const { calls, landing, registries, walkthroughId } = host(ctx);
  await landing.land({ target: 'staff-room', runFirst: 'staff-team', section: 'j2', checklist: ['share-with-people', 'my-computers'] });
  assert.deepEqual(calls, [['staff', 'j2', { settings: defaultStaffSettings() }, 'project'], ['nearAi.openStaffRoom'], checklistCall(walkthroughId)]);

  const keys = new Map<string, unknown>();
  await refreshSetupContext({ registry: registries.steps, ctx, setContext: async (key: string, value: unknown) => { keys.set(key, value); } });
  assert.equal(keys.get('nearAi.setup.show.share-with-people'), true);
  assert.equal(keys.get('nearAi.setup.show.my-computers'), true);
});

test('software opens the project wizard when needed and opens chat in either case', async () => {
  const { calls, landing, walkthroughId } = host({ kind: 'software', facts: {}, setting: () => undefined });
  const input = { kind: 'software', isAdmin: false, proposalsOpened: false, firstRun: { allowedModel: true } } as const;
  await landing.land(resolveLanding({ ...input, hasTeam: false }));
  await landing.land(resolveLanding({ ...input, hasTeam: true }));
  assert.deepEqual(calls, [
    ['studio', { wizard: 'project' }], ['nearAi.openChat'], checklistCall(walkthroughId),
    ['nearAi.openChat'], checklistCall(walkthroughId)
  ]);
});

test('first-run guarantee opens only options when no model is allowed', async () => {
  const { calls, landing } = host({ kind: 'staff', facts: {}, setting: () => undefined });
  await landing.land({ target: 'get-started-options', checklist: [] });
  assert.deepEqual(calls, [['options']]);
});

test('administrator proposals open in the policy editor before the checklist', async () => {
  const { calls, landing, walkthroughId } = host({ kind: 'software', facts: {}, setting: () => undefined });
  await landing.land(resolveLanding({ isAdmin: true, proposalsOpened: true, hasTeam: false, firstRun: { allowedModel: true } }));
  assert.deepEqual(calls, [['policy'], checklistCall(walkthroughId)]);
});

test('landing skips the team step and the next commands if projects change while its context is loading', async () => {
  const { calls, registries, walkthroughId } = host({ root: 'selected', kind: 'staff', facts: {}, setting: () => undefined });
  let current = 'selected';
  let resolveContext!: (ctx: StepContext) => void;
  const pendingContext = new Promise<StepContext>((resolve) => { resolveContext = resolve; });
  const landing = createLandingHost({
    steps: registries.steps, walkthroughId, request: { step: 'mcp' },
    project: { root: 'selected', currentRoot: () => current },
    context: () => pendingContext,
    runCommand: async (...args) => { calls.push(args); },
    openPolicyEditor: () => assert.fail('policy editor must not open'), openGuideOptions: () => assert.fail('options must not open')
  });
  const running = landing.land({ target: 'staff-room', runFirst: 'staff-team', section: 'j2', checklist: [] });
  current = 'other';
  resolveContext({ root: 'selected', kind: 'staff', facts: {}, setting: () => undefined });
  await running;
  assert.deepEqual(calls, []);
});
