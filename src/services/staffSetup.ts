// NEAR AI: Set Up a Staff Team, without VS Code: what a person can choose for each staff template, the roster they check before anything is written,
// and the writes themselves. The command in staffSetupCommand.ts asks the questions and confirms; everything here is testable on a temporary folder.
//
// What it writes, for one section (J2, J5 or J3) and one set of choices:
// - the team file in the person's team library (`<section>-<profile>-<level>.md`, run as /team:<that name>), private, with its `staff:` block and a
//   template stamp so Update Team can tell an unchanged member from one the person edited. J2, J5 and J3 teams can sit side by side; an earlier file of
//   the same name is moved to the library's archive first, never deleted;
// - PROFILE.md and the section's skills under .planning/staff/;
// - the staff settings into .planning/.near-ai/project.json (`staff`), keeping every other field;
// - the section's guidance into AGENTS.md between its own markers, beside any project-type block and any other section's.
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { DOCTRINE_PROFILES, MDO_TERMS, PLANNING_TYPES, RED_TEAM_NOTES, STAFF_LEVELS, STAFF_NATIONS, STAFF_PROFILE_IDS } from '../domain/staff/doctrine';
import type { PlanningType, StaffLevel, StaffNation, StaffProfileId } from '../domain/staff/doctrine';
import { defaultStaffSettings, levelOffer, parseStaffSettings, staffSettingsJson } from '../domain/staff/profiles';
import type { StaffSettings } from '../domain/staff/profiles';
import { withStaffGuidance } from '../agent/staff/guidance';
import { j2Renderings } from '../agent/staff/j2Template';
import { j3OptionSets } from '../agent/staff/j3Operations';
import { j5OptionSets } from '../agent/staff/j5Plans';
import { staffTemplate } from '../agent/staff/templates';
import type { StaffTemplate, StaffTemplateOptions } from '../agent/staff/templates';
import type { TacticalEchelon } from '../agent/staff/j2Vocabulary';
import { parseTeam, slugify, TeamLibrary } from '../agent/teams';
import { applyTeamUpdate, planTeamUpdate } from '../agent/teamUpdate';

export const SET_UP_STAFF_TEAM_COMMAND = 'nearAi.setUpStaffTeam';
export const PROJECT_JSON = '.planning/.near-ai/project.json';

/** The profile, level and nation pairs a template is written for: J2 every offered pair; J5 and J3 the pairs their option sets list. */
export function templateOffers(template: StaffTemplate): Array<{ profile: StaffProfileId; level: StaffLevel; nation?: StaffNation }> {
  const seen = new Map<string, { profile: StaffProfileId; level: StaffLevel; nation?: StaffNation }>();
  const add = (settings: StaffSettings) => seen.set(`${settings.profile}/${settings.level}/${settings.nation ?? ''}`, { profile: settings.profile, level: settings.level, ...(settings.nation ? { nation: settings.nation } : {}) });
  if (template.section === 'j2') for (const rendering of j2Renderings()) add(rendering.settings);
  else if (template.section === 'j5') for (const options of j5OptionSets()) add(options.settings);
  else if (template.section === 'j3') for (const options of j3OptionSets()) add(options.settings);
  return [...seen.values()];
}

export interface Choice<T> { readonly value: T; readonly label: string; readonly detail?: string }

/** The doctrine profiles the template offers, with their planning process. */
export function profileChoices(template: StaffTemplate): Array<Choice<StaffProfileId>> {
  const offers = templateOffers(template);
  return STAFF_PROFILE_IDS.filter((profile) => offers.some((offer) => offer.profile === profile)).map((profile) => {
    const levels = STAFF_LEVELS.filter((level) => offers.some((offer) => offer.profile === profile && offer.level === level));
    return { value: profile, label: DOCTRINE_PROFILES[profile].name, detail: `Levels: ${levels.join(', ')}.` };
  });
}

/** The levels the template offers under the profile; a level the profile does not offer says what to use instead. */
export function levelChoices(template: StaffTemplate, profile: StaffProfileId): Array<Choice<StaffLevel>> {
  const offers = templateOffers(template);
  return STAFF_LEVELS.filter((level) => offers.some((offer) => offer.profile === profile && offer.level === level)).map((level) => {
    const offer = levelOffer(profile, level);
    return { value: level, label: level.charAt(0).toUpperCase() + level.slice(1), ...(offer.offered && offer.note ? { detail: offer.note } : {}) };
  });
}

/** The nations, under the NATO/Canadian profile only. */
export function nationChoices(profile: StaffProfileId): Array<Choice<StaffNation>> {
  if (profile !== 'nato-ca') return [];
  const label: Record<StaffNation, string> = { ca: 'Canada (Canadian terms where they differ)', nato: 'NATO (Allied terms)' };
  return STAFF_NATIONS.map((nation) => ({ value: nation, label: label[nation] }));
}

export function planningTypeChoices(): Array<Choice<PlanningType>> {
  const detail: Record<PlanningType, string> = {
    campaign: 'Long-term planning; the J5 leads staff planning.',
    contingency: 'Planning for a situation that may arise; the J5 leads staff planning.',
    crisis: 'Planning against time; the J3 leads staff planning and steps may overlap.'
  };
  return PLANNING_TYPES.map((type) => ({ value: type, label: type.charAt(0).toUpperCase() + type.slice(1), detail: detail[type] }));
}

/** What else the template asks for these settings: the J2 tactical echelon, the J5 multidomain variant and red-team switch. */
export interface TemplateQuestions {
  readonly echelon?: Array<Choice<TacticalEchelon>>;
  readonly variant?: Array<Choice<'standard' | 'mdo'>>;
  readonly redTeam?: Array<Choice<boolean>>;
}

export function templateQuestions(template: StaffTemplate, settings: Pick<StaffSettings, 'profile' | 'level'>): TemplateQuestions {
  if (template.section === 'j2' && settings.level === 'tactical') {
    return { echelon: [{ value: 'brigade', label: 'Brigade', detail: 'Seven members, with a collection manager and a target analyst.' }, { value: 'battalion', label: 'Battalion', detail: 'Five members.' }] };
  }
  if (template.section === 'j5') {
    return {
      ...((MDO_TERMS.profiles as readonly string[]).includes(settings.profile) ? { variant: [{ value: 'standard' as const, label: 'Standard', detail: 'Two COA cells.' }, { value: 'mdo' as const, label: 'Multidomain', detail: 'A convergence planner in place of COA cell B.' }] } : {}),
      ...(RED_TEAM_NOTES[settings.profile].optional ? { redTeam: [{ value: true, label: 'With the red team', detail: RED_TEAM_NOTES[settings.profile].note }, { value: false, label: 'Without the red team' }] } : {})
    };
  }
  return {};
}

/** The settings from the person's choices on the project's existing settings (horizons and phases kept). */
export function settingsFrom(existing: StaffSettings | undefined, choice: { profile: StaffProfileId; level: StaffLevel; nation?: StaffNation; planningType: PlanningType }): StaffSettings {
  const base = existing ?? defaultStaffSettings();
  const { nation: _nation, ...rest } = base;
  return { ...rest, profile: choice.profile, level: choice.level, planningType: choice.planningType, ...(choice.profile === 'nato-ca' ? { nation: choice.nation ?? 'nato' } : {}) };
}

/** One member of the roster the person checks: agents draft, the human lead decides. */
export interface RosterMember { readonly name: string; readonly role?: string; readonly reportsTo?: string; readonly model?: string }
export interface StaffRoster { readonly teamName: string; readonly description: string; readonly humanLead?: string; readonly members: RosterMember[]; readonly fileName: string }

/** One file the setup writes, relative to the project folder. */
export interface StaffWrite { readonly path: string; readonly content: string }

export interface StaffSetupPlan {
  readonly template: StaffTemplate;
  readonly options: StaffTemplateOptions;
  readonly roster: StaffRoster;
  /** The team file text, stamped for Update Team. */
  readonly team: string;
  /** The project files: PROFILE.md, the skills, project.json and AGENTS.md, each with its whole new text. */
  readonly writes: StaffWrite[];
}

/** The team file's name in the library: the section, the profile and the level (and the J2 echelon), so sections and profiles never collide. */
export function staffTeamFileName(template: StaffTemplate, options: StaffTemplateOptions): string {
  return slugify([template.section, options.settings.profile, options.settings.level, options.echelon === 'battalion' ? 'battalion' : undefined].filter(Boolean).join('-'));
}

/** The team text with its template stamp, made the way Update Team stamps it, so a later update knows every member is unchanged. */
export function stampedStaffTeam(team: string, settings: StaffSettings): string {
  const plan = planTeamUpdate(team, { staffSettings: settings });
  return plan ? applyTeamUpdate(team, plan) : team;
}

/**
 * Everything the setup would write for the choices, worked out before anything is written. `agents` and `projectJson` are the current files (undefined
 * when absent); a project.json that is not a JSON object is refused rather than replaced.
 */
export function planStaffSetup(input: { templateId: string; options: StaffTemplateOptions; agents?: string; projectJson?: string }): StaffSetupPlan {
  const template = staffTemplate(input.templateId);
  if (!template) throw new Error(`There is no staff template ${input.templateId}.`);
  const output = template.render(input.options);
  const team = stampedStaffTeam(output.team, input.options.settings);
  const fileName = staffTeamFileName(template, input.options);
  const parsed = parseTeam(team, `${fileName}.md`);
  let config: Record<string, unknown> = {};
  if (input.projectJson !== undefined && input.projectJson.trim()) {
    let value: unknown;
    try { value = JSON.parse(input.projectJson); } catch { throw new Error(`${PROJECT_JSON} is not valid JSON, so the staff settings were not written. Fix or move it, then set up the staff team again.`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${PROJECT_JSON} is not a JSON object, so the staff settings were not written.`);
    config = value as Record<string, unknown>;
  }
  const writes: StaffWrite[] = [
    ...output.files.map((file) => ({ path: file.path, content: file.content })),
    { path: PROJECT_JSON, content: `${JSON.stringify({ ...config, staff: staffSettingsJson(input.options.settings) }, null, 2)}\n` },
    { path: 'AGENTS.md', content: withStaffGuidance(input.agents ?? '', template.id, output.guidance) }
  ];
  return {
    template, options: input.options, team, writes,
    roster: {
      teamName: parsed.name, description: parsed.description, fileName,
      ...(parsed.staff?.humanLead ? { humanLead: parsed.staff.humanLead } : {}),
      members: parsed.members.map((member) => ({ name: member.name, ...(member.role ? { role: member.role } : {}), ...(member.reportsTo ? { reportsTo: member.reportsTo } : {}), ...(member.model ? { model: member.model } : {}) }))
    }
  };
}

/** The staff settings already in a project.json text, if any parse. */
export function existingStaffSettings(projectJson: string | undefined): StaffSettings | undefined {
  if (!projectJson) return undefined;
  try {
    const value = JSON.parse(projectJson) as { staff?: unknown };
    if (!value || typeof value !== 'object' || value.staff === undefined) return undefined;
    const read = parseStaffSettings(value.staff);
    return read.ok ? read.value : undefined;
  } catch {
    return undefined;
  }
}

const readMaybe = (file: string) => readFile(file, 'utf8').catch(() => undefined);

/** The current AGENTS.md and project.json of a project, for planStaffSetup. */
export async function readStaffSetupInputs(root: string): Promise<{ agents?: string; projectJson?: string }> {
  const [agents, projectJson] = await Promise.all([readMaybe(path.join(root, 'AGENTS.md')), readMaybe(path.join(root, PROJECT_JSON))]);
  return { ...(agents !== undefined ? { agents } : {}), ...(projectJson !== undefined ? { projectJson } : {}) };
}

/** The library file the plan's team goes to, and whether one is already there. */
export async function staffTeamTarget(library: TeamLibrary, plan: StaffSetupPlan): Promise<{ file: string; exists: boolean }> {
  const file = path.join(library.directory, `${plan.roster.fileName}.md`);
  return { file, exists: Boolean(await lstat(file).catch(() => undefined)) };
}

export interface StaffSetupResult { readonly teamFile: string; readonly archived?: string; readonly written: string[] }

/**
 * Writes the plan: an earlier team file of the same name is archived first (the caller asked the person), then the team file, then the project files.
 * A path on the way that is a symbolic link is refused before anything is written, so a link cannot send a write outside the project.
 */
export async function applyStaffSetup(root: string, library: TeamLibrary, plan: StaffSetupPlan, options: { replace?: boolean } = {}): Promise<StaffSetupResult> {
  for (const write of plan.writes) {
    const parts = write.path.split('/');
    for (let index = 1; index <= parts.length; index += 1) {
      const info = await lstat(path.join(root, ...parts.slice(0, index))).catch(() => undefined);
      if (info?.isSymbolicLink()) throw new Error(`${parts.slice(0, index).join('/')} is a symbolic link, so nothing was written.`);
    }
  }
  const target = await staffTeamTarget(library, plan);
  if (target.exists && !options.replace) throw new Error(`${path.basename(target.file)} is already in your teams. Nothing was written.`);
  await mkdir(library.directory, { recursive: true });
  const archived = target.exists ? await library.archive(target.file) : undefined;
  await writeFile(target.file, plan.team, 'utf8');
  await library.snapshot(target.file);
  const written: string[] = [];
  for (const write of plan.writes) {
    const file = path.join(root, ...write.path.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, write.content, 'utf8');
    written.push(write.path);
  }
  return { teamFile: target.file, ...(archived ? { archived } : {}), written };
}
