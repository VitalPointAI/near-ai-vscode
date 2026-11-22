import type { OpenGetStartedRequest } from '../../domain/setup/answers';
import type { Landing, LandingPort } from '../../domain/setup/landing';
import type { StepContext, StepRegistry } from '../../domain/setup/steps';
import { OPEN_STAFF_ROOM_COMMAND } from '../../domain/staff/commands';
import { START_CHATTING } from '../setupSteps';
import { requestedSetupStep } from './guideSteps';

export interface LandingHostDeps {
  steps: StepRegistry;
  runCommand: (id: string, ...args: unknown[]) => PromiseLike<unknown>;
  openPolicyEditor: () => void;
  openGuideOptions: () => Promise<void>;
  walkthroughId: string;
  context: () => Promise<StepContext>;
}

export interface LandingHost extends LandingPort {
  land(landing: Landing, request?: OpenGetStartedRequest): Promise<void>;
  openChecklist(): Promise<void>;
}

export function createLandingHost(deps: LandingHostDeps): LandingHost {
  async function openChecklist(): Promise<void> {
    await deps.runCommand('workbench.action.openWalkthrough', deps.walkthroughId, false);
  }
  return {
    openChecklist,
    async land(landing, request) {
      if (landing.target === 'get-started-options') {
        await deps.openGuideOptions();
        return;
      }
      const step = landing.runFirst && deps.steps.get(landing.runFirst);
      if (step) {
        const ctx = await deps.context();
        await step.run(landing.section === undefined ? ctx : { ...ctx, facts: { ...ctx.facts, staffSection: landing.section } });
      }
      switch (landing.target) {
        case 'chat': await deps.runCommand(START_CHATTING.command); break;
        case 'staff-room': await deps.runCommand(OPEN_STAFF_ROOM_COMMAND); break;
        case 'policy-editor': deps.openPolicyEditor(); break;
      }
      await openChecklist();
      // Keep the requested surface in view after the usual landing. The first-run
      // team step may already have handled this request using the answers just applied.
      const target = request?.step;
      if (target !== landing.runFirst) {
        const requested = requestedSetupStep(deps.steps, target);
        if (requested) await requested.run(await deps.context());
      }
    }
  };
}
