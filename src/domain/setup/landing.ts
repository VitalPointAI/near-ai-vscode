// GUIDE-08. Pure: no I/O, no clock, no vscode, no package.
import { checkKeys, isRecord, ownValue } from '../gate/shape';
import { isStaffTeamSection, type StaffTeamSection } from '../staff/profiles';
import { fillSlots, STAFF_SECTION_ANSWERS, type KindOfWorkAnswer } from './answers';
import { WORK_AREA_PAGE_FOR_KIND, WORK_AREA_PAGES, type WorkAreaPage } from './bridge';
import { SETUP_STEP_IDS, type KnownSetupStepId } from './ids';

/** D-50: `get-started` is the Sterling home page; `work-area` names a workbench page (`sterling.workAreas.open <page>`). */
export const LANDING_TARGETS = Object.freeze(['chat', 'staff-room', 'policy-editor', 'get-started-options', 'get-started', 'work-area'] as const);
const RUN_FIRST = Object.freeze(['software-team', 'staff-team'] as const);
const MAX_NOTE = 300;

export interface Landing {
  readonly target: (typeof LANDING_TARGETS)[number];
  readonly runFirst?: (typeof RUN_FIRST)[number];
  readonly section?: StaffTeamSection;
  /** Present exactly when the target is `work-area`. */
  readonly workArea?: WorkAreaPage;
  readonly checklist: readonly KnownSetupStepId[];
  readonly note?: string;
}

const oneOf = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === 'string' && (values as readonly string[]).includes(value);

/** A landing the host may act on: known target, steps and fields only, and a work-area page exactly when the target is a work area. */
export function isLanding(value: unknown): value is Landing {
  if (!isRecord(value) || checkKeys(value, 'landing', ['target', 'checklist'], ['runFirst', 'section', 'workArea', 'note'])) return false;
  const target = ownValue(value, 'target');
  const checklist = ownValue(value, 'checklist');
  const { runFirst, section, workArea, note } = { runFirst: ownValue(value, 'runFirst'), section: ownValue(value, 'section'),
    workArea: ownValue(value, 'workArea'), note: ownValue(value, 'note') };
  if (!oneOf(target, LANDING_TARGETS) || !Array.isArray(checklist) || !checklist.every((step) => oneOf(step, SETUP_STEP_IDS))) return false;
  if ((target === 'work-area') !== (workArea !== undefined) || (workArea !== undefined && !oneOf(workArea, WORK_AREA_PAGES))) return false;
  if (runFirst !== undefined && !oneOf(runFirst, RUN_FIRST)) return false;
  if (section !== undefined && !isStaffTeamSection(section)) return false;
  return note === undefined || (typeof note === 'string' && note.length <= MAX_NOTE);
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
  // D-50: capability development, resources and exercises share like capital projects; planning works like staff.
  'capability-development': Object.freeze(['share-with-people'] as const),
  planning: Object.freeze(['share-with-people', 'my-computers'] as const),
  'resource-management': Object.freeze(['share-with-people'] as const),
  'exercises-training': Object.freeze(['share-with-people'] as const),
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
  if (Object.hasOwn(WORK_AREA_PAGE_FOR_KIND, kind)) {
    return { target: 'work-area', workArea: WORK_AREA_PAGE_FOR_KIND[kind as keyof typeof WORK_AREA_PAGE_FOR_KIND], checklist };
  }
  if (kind === 'software' && !input.hasTeam) return { target: 'chat', runFirst: 'software-team', checklist };
  return { target: 'chat', checklist };
}

export function exerciseFor({ kind, operationalApproved }: { kind?: KindOfWorkAnswer; operationalApproved: boolean }): { exercise: boolean; reason?: string } {
  // D-50: planning follows the staff exercise rule.
  if ((kind === 'staff' || kind === 'planning') && !operationalApproved) return { exercise: true, reason: EXERCISE_REASON_TEXT };
  return { exercise: false };
}
