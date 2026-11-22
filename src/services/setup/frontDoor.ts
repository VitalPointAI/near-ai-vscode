import { parseGuidePrefill, type OpenGetStarted, type OpenGetStartedRequest } from '../../domain/setup/answers';
import { isGetStartedTarget } from '../../domain/setup/ids';
import type { StartSessionInput } from '../../domain/setup/session';
import type { StepContext, StepRegistry } from '../../domain/setup/steps';
import { requestedSection } from '../staffSetup';
import { requestedSetupStep } from './guideSteps';

interface FrontDoorDeps {
  openGuide: OpenGetStarted;
  openChecklist: () => Promise<void>;
  steps: StepRegistry;
  hasAnswers: (root?: string) => boolean;
  context: () => Promise<StepContext>;
}

/** Turn the command's prefill into initial answers for a new guide session. */
export function guideSessionPrefill(request?: OpenGetStartedRequest): StartSessionInput['prefill'] {
  const prefill = parseGuidePrefill(request?.prefill);
  if (request?.step === 'staff-team' || prefill?.section !== undefined) return { ...prefill, kindOfWork: 'staff' };
  return prefill;
}

export function createFrontDoor(deps: FrontDoorDeps): OpenGetStarted {
  return async (request) => {
    const target = request?.step;
    if (target === undefined) return deps.openGuide(request);
    if (!isGetStartedTarget(target)) return deps.openGuide({});
    if (target === 'checklist') return deps.openChecklist();

    const step = requestedSetupStep(deps.steps, target);
    if (!step) return deps.openGuide(request);
    const prefill = parseGuidePrefill(request?.prefill);
    const ctx = await deps.context();
    if (!deps.hasAnswers(ctx.root)) {
      // Keep the step on the guide request so the host can replay it after Apply.
      return deps.openGuide(prefill ? request : { step: target });
    }
    const section = target === 'staff-team' ? requestedSection({ section: prefill?.section }) : undefined;
    await step.run(section === undefined ? ctx : { ...ctx, facts: { ...ctx.facts, staffSection: section } });
  };
}
