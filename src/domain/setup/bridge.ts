// D-46, D-48, D-49, D-50. Pure: no I/O, no clock, no vscode, no package. The one list of the commands between the extension and the Sterling
// workbench, and the parsers for what crosses them. Anything malformed parses as 'invalid', never as a default that widens what runs.
import { checkKeys, isRecord, ownValue } from '../gate/shape';
import type { KindOfWork } from '../gate/sections';
import type { HostKind } from './device';
import { SETUP_STEP_ID_PATTERN } from './ids';

export const GUIDE_COMMANDS = Object.freeze({
  open: 'nearAi.setup',
  message: 'nearAi.setup.message',
  closed: 'nearAi.setup.closed',
  checklist: 'nearAi.setup.checklist',
  show: 'sterling.setupGuide.show',
  post: 'sterling.setupGuide.post',
  environment: 'sterling.setupGuide.environment'
} as const);

export const GUIDE_HOSTINGS = Object.freeze(['hosted', 'local'] as const);
export const GUIDE_EDITIONS = Object.freeze(['ca-defence'] as const);
export type GuideEdition = (typeof GUIDE_EDITIONS)[number];

export interface GuideEnvironment {
  readonly hosting: (typeof GUIDE_HOSTINGS)[number];
  readonly edition?: GuideEdition;
}

const MAX_ENVIRONMENT_TEXT = 40;

function choiceOf<T extends string>(value: unknown, choices: readonly T[]): T | undefined {
  return typeof value === 'string' && value.length <= MAX_ENVIRONMENT_TEXT && (choices as readonly string[]).includes(value) ? value as T : undefined;
}

/** The workbench's answer to `sterling.setupGuide.environment`. */
export function parseGuideEnvironment(value: unknown): GuideEnvironment | 'invalid' {
  if (!isRecord(value) || checkKeys(value, 'environment', ['hosting'], ['edition'])) return 'invalid';
  const hosting = choiceOf(ownValue(value, 'hosting'), GUIDE_HOSTINGS);
  if (!hosting) return 'invalid';
  if (ownValue(value, 'edition') === undefined) return Object.freeze({ hosting });
  const edition = choiceOf(ownValue(value, 'edition'), GUIDE_EDITIONS);
  return edition ? Object.freeze({ hosting, edition }) : 'invalid';
}

/**
 * The host kind a guide run uses (owner D7, D-49). No workbench (the VS Code build) keeps the caller's host kind; a workbench that answers
 * badly or not at all is treated as hosted, the side with fewer network actions.
 */
export function hostKindForEnvironment(env: GuideEnvironment | 'invalid' | undefined, current: HostKind): HostKind {
  if (env === undefined) return current;
  if (env === 'invalid' || env.hosting === 'hosted') return 'hosted';
  return current;
}

export interface ChecklistRow {
  readonly id: string;
  readonly title: string;
  readonly shown: boolean;
  readonly done: boolean;
}

export const MAX_CHECKLIST_ROWS = 20;
export const MAX_CHECKLIST_TITLE = 80;

/** The rows `nearAi.setup.checklist` returns for the Your setup section of Get Started (D-48). */
export function parseChecklistRows(value: unknown): readonly ChecklistRow[] | 'invalid' {
  if (!Array.isArray(value) || value.length > MAX_CHECKLIST_ROWS) return 'invalid';
  const rows: ChecklistRow[] = [];
  for (const row of value) {
    if (!isRecord(row) || checkKeys(row, 'row', ['id', 'title', 'shown', 'done'])) return 'invalid';
    const id = ownValue(row, 'id');
    const title = ownValue(row, 'title');
    const shown = ownValue(row, 'shown');
    const done = ownValue(row, 'done');
    if (typeof id !== 'string' || !SETUP_STEP_ID_PATTERN.test(id)) return 'invalid';
    if (typeof title !== 'string' || title.length === 0 || title.length > MAX_CHECKLIST_TITLE) return 'invalid';
    if (typeof shown !== 'boolean' || typeof done !== 'boolean') return 'invalid';
    rows.push(Object.freeze({ id, title, shown, done }));
  }
  return Object.freeze(rows);
}

/** The Sterling work-area pages a landing can open (`sterling.workAreas.open <page>`). */
export const WORK_AREA_PAGES = Object.freeze(['capability-development', 'planning', 'resources', 'training'] as const);
export type WorkAreaPage = (typeof WORK_AREA_PAGES)[number];

export const WORK_AREA_KINDS = Object.freeze(['capability-development', 'planning', 'resource-management', 'exercises-training'] as const);
export type WorkAreaKind = Extract<KindOfWork, (typeof WORK_AREA_KINDS)[number]>;

export const WORK_AREA_PAGE_FOR_KIND: Readonly<Record<WorkAreaKind, WorkAreaPage>> = Object.freeze({
  'capability-development': 'capability-development',
  planning: 'planning',
  'resource-management': 'resources',
  'exercises-training': 'training'
});
