// GUIDE-08. Pure: no I/O, no clock, no vscode, no package.
import { isStaffTeamSection, type StaffTeamSection } from '../staff/profiles';
import { fillSlots, STAFF_SECTION_ANSWERS, type KindOfWorkAnswer } from './answers';
import type { KnownSetupStepId } from './ids';

export const LANDING_TARGETS = Object.freeze(['chat', 'staff-room', 'policy-editor', 'get-started-options'] as const);

export interface Landing {
  readonly target: (typeof LANDING_TARGETS)[number];
  readonly runFirst?: 'software-team' | 'staff-team';
  readonly section?: StaffTeamSection;
  readonly checklist: readonly KnownSetupStepId[];
  readonly note?: string;
}

export interface FirstRunCheck {
  readonly allowedModel: boolean;
}

interface LandingInput {
  readonly kind?: KindOfWorkAnswer;
  readonly staffSection?: string;
  readonly isAdmin: boolean;
  readonly proposalsOpened: boolean;
  readonly hasTeam: boolean;
  readonly firstRun: FirstRunCheck;
}

export interface LandingPort {
  land(landing: Landing): Promise<void>;
}

export const EXERCISE_REASON_TEXT = 'Exercise on fictional data only, until your organization approves a model for operational work.';
export const EXERCISE_OPTION_TEXT = 'Exercise on fictional data';
export const NO_SECTION_TEMPLATE_TEXT = 'There is no staff template for {section} in this version. You can work in the Staff Room and set up a section with a template later.';

const WRITING_CHECKLIST = Object.freeze(['spending-limit', 'my-computers'] as const);
export const CHECKLIST_BY_KIND: Readonly<Record<KindOfWorkAnswer, readonly KnownSetupStepId[]>> = Object.freeze({
  software: Object.freeze(['spending-limit', 'secure-workflow', 'web-search', 'my-computers', 'share-with-people'] as const),
  staff: Object.freeze(['share-with-people', 'my-computers'] as const),
  analysis: Object.freeze(['data-connections'] as const),
  'capital-projects': Object.freeze(['share-with-people'] as const),
  writing: WRITING_CHECKLIST,
  'something-else': WRITING_CHECKLIST
});

export function resolveLanding(input: LandingInput): Landing {
  if (!input.firstRun.allowedModel) return { target: 'get-started-options', checklist: [] };
  if (input.isAdmin && input.proposalsOpened) return { target: 'policy-editor', checklist: ['policy'] };

  const kind = input.kind ?? 'something-else';
  const checklist = CHECKLIST_BY_KIND[kind];
  if (kind === 'staff') {
    const section = input.staffSection;
    if (isStaffTeamSection(section)) return { target: 'staff-room', runFirst: 'staff-team', section, checklist };
    if (section !== undefined && STAFF_SECTION_ANSWERS.some((answer) => answer === section)) {
      return { target: 'staff-room', checklist, note: fillSlots(NO_SECTION_TEMPLATE_TEXT, { section: section.toUpperCase() }) };
    }
    return { target: 'staff-room', checklist };
  }
  if (kind === 'software' && !input.hasTeam) return { target: 'chat', runFirst: 'software-team', checklist };
  return { target: 'chat', checklist };
}

export function exerciseFor({ kind, operationalApproved }: { kind?: KindOfWorkAnswer; operationalApproved: boolean }): { exercise: boolean; reason?: string } {
  if (kind === 'staff' && !operationalApproved) return { exercise: true, reason: EXERCISE_REASON_TEXT };
  return { exercise: false };
}
