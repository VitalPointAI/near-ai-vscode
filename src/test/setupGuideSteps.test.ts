import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { OpenGetStartedRequest } from '../domain/setup/answers';
import { defaultStaffSettings } from '../domain/staff/profiles';
import { resolveLanding } from '../domain/setup/landing';
import { createSetupRegistries } from '../domain/setup/registries';
import { startSession } from '../domain/setup/session';
import type { StepContext } from '../domain/setup/steps';
import { refreshSetupContext, watchSetupContext } from '../services/setup/contextKeys';
import { createFrontDoor, guideSessionPrefill } from '../services/setup/frontDoor';
import { ALIAS_COMMAND_IDS, registerGuideSteps } from '../services/setup/guideSteps';
import { createLandingHost } from '../services/setup/landingHost';

function fixture(ctx: StepContext = { root: 'project', kind: 'software', setting: () => undefined, facts: {} }) {
  const registries = createSetupRegistries();
  const calls: unknown[][] = [];
  const context = async () => ctx;
  const runCommand = async (id: string) => { calls.push(['command', id]); };
  const registration = registerGuideSteps({
    registries, runCommand, facts: context,
    openStudio: async (options) => { calls.push(['studio', options]); },
    setUpStaffTeam: async (section, preset) => { calls.push(['staff', section, preset]); return 'j2.md'; },
    configureConnection: async () => { calls.push(['configure']); return true; },
    useSavedConnection: async () => { calls.push(['use-saved']); return true; },
    openGetStarted: async (request?: OpenGetStartedRequest) => { calls.push(['guide', request]); }
  });
  return { ctx, context, steps: registries.steps, calls, registration };
}

test('D-23: the ten setup paths use one registry with plain titles', () => {
  const { steps, registration } = fixture();
  assert.deepEqual(steps.list().map((step) => step.id), [
    'connection', 'software-team', 'staff-team', 'spending-limit', 'web-search', 'research-verifiers',
    'mcp', 'my-computers', 'share-with-people', 'change-answers'
  ]);
  for (const step of steps.list()) assert.doesNotMatch(step.title, /Team Mode|Multi-User|Join Staff Project/i);
  registration.dispose();
  assert.deepEqual(steps.list(), []);
});

test('D-24: running the steps never dispatches a Get Started alias', async () => {
  const { steps, ctx, calls } = fixture();
  for (const step of steps.list()) await step.run(ctx);
  const aliases = new Set<string>([...ALIAS_COMMAND_IDS, 'nearAi.setup']);
  for (const [category, id] of calls) if (category === 'command') assert.equal(aliases.has(String(id)), false);
  assert.ok(calls.some(([action]) => action === 'configure'));
  assert.deepEqual(calls.find(([action]) => action === 'guide'), ['guide', { step: 'kind-of-work' }]);
});

test('existing behavior behind the steps uses the shipped checks and commands', async () => {
  const { steps, ctx, calls } = fixture({
    root: 'project', kind: 'software', setting: (key) => key === 'dailySpendLimitUsd' ? 10 : undefined,
    facts: { webSearchReady: true }
  });
  const commands = [
    ['spending-limit', 'nearAi.spendingLimits'], ['web-search', 'nearAi.setUpWebSearch'],
    ['research-verifiers', 'nearAi.setupResearchVerifiers'], ['mcp', 'nearAi.manageMcp'], ['my-computers', 'nearAi.sync.turnOn']
  ];
  for (const [id] of commands) {
    const step = steps.get(id);
    assert.ok(step, `${id} has a registered setup step`);
    await step.run(ctx);
  }
  assert.deepEqual(calls, commands.map(([, id]) => ['command', id]));
  assert.equal(await steps.get('spending-limit')?.state(ctx), 'done');
  assert.equal(await steps.get('spending-limit')?.state({ ...ctx, setting: () => 0 }), 'to-do');
  assert.equal(await steps.get('web-search')?.state(ctx), 'done');
});

test('Phase 33 can replace the sharing step after the existing sharing flows are used', async () => {
  const { steps, ctx, calls, registration } = fixture();
  const step = steps.get('share-with-people');
  assert.ok(step);
  await step.run(ctx);
  await step.run({ ...ctx, kind: 'staff', setting: (key) => key === 'staff.multiUserPreview' });
  assert.deepEqual(calls, [['command', 'nearAi.team.enable'], ['command', 'nearAi.staff.inviteToProject']]);
  const replacement = { ...step, state: () => 'done' as const };
  steps.register(replacement, { replaces: true });
  registration.dispose();
  const keys = new Map<string, unknown>();
  await refreshSetupContext({ registry: steps, ctx, setContext: async (key, value) => { keys.set(key, value); } });
  assert.equal(steps.get('share-with-people'), replacement);
  assert.equal(keys.get('nearAi.setup.done.share-with-people'), true);
});

test('checklist visibility follows work kind and only includes registered steps', async () => {
  const { steps, ctx } = fixture();
  const keys = new Map<string, unknown>();
  await refreshSetupContext({ registry: steps, ctx, setContext: async (key, value) => { keys.set(key, value); } });
  assert.equal(keys.get('nearAi.setup.show.spending-limit'), true);
  assert.equal(keys.get('nearAi.setup.show.staff-team'), false);
  assert.equal(keys.get('nearAi.setup.show.secure-workflow'), undefined);
  assert.equal(keys.get('nearAi.setup.show.data-connections'), undefined);
});

function frontDoorFixture(hasAnswers: boolean) {
  const { steps, calls, context } = fixture();
  const openGuide = async (request?: OpenGetStartedRequest) => { calls.push(['open', request]); };
  const landing = createLandingHost({
    steps, context, walkthroughId: 'example.near-ai#nearAi.getStarted',
    runCommand: async (...args) => { calls.push(args); },
    openPolicyEditor: () => {}, openGuideOptions: async () => {}
  });
  const open = createFrontDoor({ steps, context, hasAnswers: () => hasAnswers, openGuide, openChecklist: landing.openChecklist });
  return { calls, open, landing };
}

test('D-24: saved answers run the requested staff step with its validated section', async () => {
  const { calls, open } = frontDoorFixture(true);
  await open({ step: 'staff-team', prefill: { section: 'j2', fixed: [] } });
  assert.deepEqual(calls, [['staff', 'j2', { settings: defaultStaffSettings() }]]);
});

test('without answers a step opens the guide and remains the target after Apply', async () => {
  const { calls, open, landing } = frontDoorFixture(false);
  await open({ step: 'staff-team', prefill: { section: 'j2', fixed: [] } });
  const request: OpenGetStartedRequest = { step: 'staff-team', prefill: { section: 'j2', fixed: [] } };
  assert.deepEqual(calls, [['open', request]]);
  const { answers } = startSession({ now: 0, prefill: guideSessionPrefill(request) });
  assert.equal(answers.kindOfWork, 'staff');
  assert.equal(answers.staffSection, 'j2');
  const target = resolveLanding({
    kind: answers.kindOfWork, staffSection: answers.staffSection, hasTeam: false,
    isAdmin: false, proposalsOpened: false, firstRun: { allowedModel: true }
  });
  await landing.land(target, request);
  assert.deepEqual(calls.slice(1), [
    ['staff', 'j2', { settings: defaultStaffSettings() }], ['nearAi.openStaffRoom'],
    ['workbench.action.openWalkthrough', 'example.near-ai#nearAi.getStarted', false]
  ]);
});

test('after Apply an explicit setup request can open a step outside the normal landing', async () => {
  const { calls, open, landing } = frontDoorFixture(false);
  const request = { step: 'mcp' };
  await open(request);
  const target = resolveLanding({ kind: 'writing', hasTeam: false, isAdmin: false, proposalsOpened: false, firstRun: { allowedModel: true } });
  await landing.land(target, request);
  assert.deepEqual(calls, [
    ['open', request], ['nearAi.openChat'], ['workbench.action.openWalkthrough', 'example.near-ai#nearAi.getStarted', false],
    ['command', 'nearAi.manageMcp']
  ]);
});

test('guide screens pass through and an unexpected target starts the guide', async () => {
  const { calls, open } = frontDoorFixture(true);
  await open({ step: 'check-answers' });
  await open({});
  await open({ step: 'nearAi.openStaffRoom' });
  assert.deepEqual(calls, [['open', { step: 'check-answers' }], ['open', {}], ['open', {}]]);
});

test('checklist target opens the walkthrough without running a setup step', async () => {
  const { calls, open } = frontDoorFixture(false);
  await open({ step: 'checklist' });
  assert.deepEqual(calls, [['workbench.action.openWalkthrough', 'example.near-ai#nearAi.getStarted', false]]);
});

test('context keys refresh once per burst of changes and clear when a step is removed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { steps, ctx } = fixture({ kind: 'software', setting: () => undefined, facts: {} });
  const keys = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const change = () => listeners.forEach((fn) => fn());
  let changesRead = 0;
  let spending = 0;
  const watcher = watchSetupContext({
    registry: steps,
    context: async () => { changesRead++; return { ...ctx, setting: () => spending }; },
    setContext: async (key: string, value: unknown) => { keys.set(key, value); },
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    }
  });
  t.mock.timers.tick(200);
  await setImmediate();
  assert.equal(changesRead, 1);

  const registration = steps.register({
    id: 'secure-workflow', title: 'Secure workflow', detail: '',
    state: () => 'done', viability: () => ({ available: true }),
    run: async () => ({ outcome: 'opened' })
  });
  spending = 10;
  change();
  change();
  t.mock.timers.tick(199);
  assert.equal(changesRead, 1);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(changesRead, 2);
  assert.equal(keys.get('nearAi.setup.done.spending-limit'), true);
  assert.equal(keys.get('nearAi.setup.show.secure-workflow'), true);

  registration.dispose();
  t.mock.timers.tick(200);
  await setImmediate();
  assert.equal(changesRead, 3);
  assert.equal(keys.get('nearAi.setup.show.secure-workflow'), false);
  assert.equal(keys.get('nearAi.setup.done.secure-workflow'), false);
  change();
  t.mock.timers.tick(200);
  await setImmediate();
  assert.equal(changesRead, 4);
  change();
  watcher.dispose();
  t.mock.timers.tick(200);
  assert.equal(changesRead, 4);
  assert.equal(listeners.size, 0);
});
