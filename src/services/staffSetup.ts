// SovAI: Set Up a Staff Team, without VS Code: what a person can choose for each staff template, the roster they check before anything is written,
// and the writes themselves. The command in staffSetupCommand.ts asks the questions and confirms; everything here is testable on a temporary folder.
//
// What it writes, for one section (J2, J5, J3 or J4) and one set of choices:
// - the team file in the person's team library (`<section>-<profile>-<level>.md`, run as /team:<that name>), private, with its `staff:` block and a
//   template stamp so Update Team can tell an unchanged member from one the person edited. Teams of different sections sit side by side; an earlier file of
//   the same name is moved to the library's archive first, never deleted;
// - PROFILE.md and the section's skills under .planning/staff/;
// - the staff settings into .planning/.near-ai/project.json (`staff`), keeping every other field;
// - the section's guidance into AGENTS.md between its own markers, beside any project-type block and any other section's.
import { MAX_STAFF_FILE_BYTES, replaceKeepingEdits, snapshotOfBytes, writeIfUnchanged } from '../staff/staffFiles';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import * as path from 'node:path';
import { DOCTRINE_PROFILES, MDO_TERMS, PLANNING_TYPES, RED_TEAM_NOTES, STAFF_LEVELS, STAFF_NATIONS, STAFF_PROFILE_IDS } from '../domain/staff/doctrine';
import type { PlanningType, StaffLevel, StaffNation, StaffProfileId } from '../domain/staff/doctrine';
import { defaultStaffSettings, isStaffTeamSection, levelOffer, parseStaffSettings, staffSettingsJson } from '../domain/staff/profiles';
import type { StaffSettings, StaffTeamSection } from '../domain/staff/profiles';
import { withStaffGuidance } from '../agent/staff/guidance';
import { j2Renderings } from '../agent/staff/j2Template';
import { j3OptionSets } from '../agent/staff/j3Operations';
import { j4Renderings } from '../agent/staff/j4Template';
import { j5OptionSets } from '../agent/staff/j5Plans';
import { staffTemplate } from '../agent/staff/templates';
import type { StaffTemplate, StaffTemplateOptions } from '../agent/staff/templates';
import type { TacticalEchelon } from '../agent/staff/j2Vocabulary';
import { parseTeam, slugify, TeamLibrary } from '../agent/teams';
import { applyTeamUpdate, planTeamUpdate } from '../agent/teamUpdate';

export const SET_UP_STAFF_TEAM_COMMAND = 'nearAi.setUpStaffTeam';
export const PROJECT_JSON = '.planning/.near-ai/project.json';

/**
 * Told when this extension has written a project's staff teams (Set Up a Staff Team, Link on the chat's card), with the project folder. The chat's
 * "Staff teams" card refreshes from this at once instead of waiting on a file watcher, which a remote editor such as code-server does not always deliver
 * (D-48 of 0.4.35: the chat kept "no team yet" after the J2 team was set up). A listener that throws never stops the others or the write.
 */
const staffTeamsListeners = new Set<(root: string) => void>();
export function onStaffTeamsChanged(listener: (root: string) => void): { dispose(): void } {
  staffTeamsListeners.add(listener);
  return { dispose: () => { staffTeamsListeners.delete(listener); } };
}
export function staffTeamsChanged(root: string): void {
  for (const listener of [...staffTeamsListeners]) {
    try { listener(root); } catch { /* one listener never stops the others */ }
  }
}

/** The profile, level and nation pairs a template is written for: J2 and J4 every offered pair; J5 and J3 the pairs their option sets list. */
export function templateOffers(template: StaffTemplate): Array<{ profile: StaffProfileId; level: StaffLevel; nation?: StaffNation }> {
  const seen = new Map<string, { profile: StaffProfileId; level: StaffLevel; nation?: StaffNation }>();
  const add = (settings: StaffSettings) => seen.set(`${settings.profile}/${settings.level}/${settings.nation ?? ''}`, { profile: settings.profile, level: settings.level, ...(settings.nation ? { nation: settings.nation } : {}) });
  if (template.section === 'j2') for (const rendering of j2Renderings()) add(rendering.settings);
  else if (template.section === 'j5') for (const options of j5OptionSets()) add(options.settings);
  else if (template.section === 'j3') for (const options of j3OptionSets()) add(options.settings);
  else if (template.section === 'j4') for (const rendering of j4Renderings()) add(rendering.settings);
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

/**
 * The team names the setup gives a section under a profile and level, by the same rule as staffTeamFileName: `<section>-<profile>-<level>`, and for a
 * tactical J2 also the battalion roster's `-battalion` name. Used to find library teams an older project set up before it recorded them.
 */
export function staffTeamCandidates(section: StaffTemplate['section'], settings: Pick<StaffSettings, 'profile' | 'level'>): string[] {
  const base = slugify([section, settings.profile, settings.level].join('-'));
  return section === 'j2' && settings.level === 'tactical' ? [base, `${base}-battalion`] : [base];
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
  // The project records its section teams: this section's entry is set (a re-run replaces only it), every other section's is kept as it was.
  const section = template.section;
  if (!isStaffTeamSection(section)) throw new Error(`${template.label} is not a section a project records a team for.`);
  const earlier = Object.prototype.hasOwnProperty.call(config, 'staff') ? parseStaffSettings(config.staff) : undefined;
  const teams = { ...(earlier?.ok ? earlier.value.teams ?? {} : {}), [section]: fileName };
  const writes: StaffWrite[] = [
    ...output.files.map((file) => ({ path: file.path, content: file.content })),
    { path: PROJECT_JSON, content: `${JSON.stringify({ ...config, staff: staffSettingsJson({ ...input.options.settings, teams }) }, null, 2)}\n` },
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

/**
 * The section a caller asked to set up (the chat's Staff teams card or the Staff Room's "Set up"): `{ section: 'j2' }` with exactly that key, or nothing.
 * Anything else is ignored and the person is asked as usual.
 */
export function requestedSection(arg: unknown): StaffTeamSection | undefined {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) return undefined;
  const keys = Object.keys(arg);
  if (keys.length !== 1 || keys[0] !== 'section') return undefined;
  const section = (arg as Record<string, unknown>).section;
  return isStaffTeamSection(section) ? section : undefined;
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

/** A host-only selection. Team Studio obtains it from the editor and keeps its lifetime bound to one chooser session. */
export interface StudioStaffSelection {
  readonly root: string;
  readonly name: string;
  readonly projectJson?: string;
  isCurrent(): boolean;
  isSameDirectory?(): boolean;
}

interface StudioStaffInputs {
  readonly sources: ReadonlyMap<string, Buffer | undefined>;
  readonly agents?: string;
  readonly projectJson?: string;
}

interface StudioStaffReview {
  readonly selection: StudioStaffSelection;
  readonly files: ReadonlyMap<string, Buffer | undefined>;
}

export const STUDIO_STAFF_CHANGED = 'The project changed. Review the staff setup again.';
export function studioSharedTeamMessage(file: string): string {
  return `${path.basename(file)} already exists in the shared team library. Team Studio left it and the project unchanged.`;
}

function ensureStudioCurrent(selection: StudioStaffSelection): void {
  if (!selection.isCurrent()) throw new Error(STUDIO_STAFF_CHANGED);
}

/** Walk the known staff paths without following links. An unreadable path cannot be treated as a blank one. */
async function setupFile(root: string, relative: string): Promise<string> {
  const parts = relative.split('/');
  for (let index = 1; index <= parts.length; index += 1) {
    try {
      const info = await lstat(path.join(root, ...parts.slice(0, index)));
      if (info.isSymbolicLink()) throw new Error(`${parts.slice(0, index).join('/')} is a symbolic link, so nothing was written.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      break;
    }
  }
  return path.join(root, ...parts);
}

async function studioFile(root: string, relative: string): Promise<Buffer | undefined> {
  const file = await setupFile(root, relative);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_STAFF_FILE_BYTES) throw new Error(`${relative} could not be reviewed.`);
    const bytes = await handle.readFile();
    if (bytes.length > MAX_STAFF_FILE_BYTES) throw new Error(`${relative} could not be reviewed.`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function setupText(bytes: Buffer | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  const text = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(text))) throw new Error('A project file is not valid UTF-8 and could not be reviewed.');
  return text;
}

export async function readStudioStaffInputs(selection: StudioStaffSelection): Promise<StudioStaffInputs> {
  ensureStudioCurrent(selection);
  const files = ['AGENTS.md', PROJECT_JSON, '.planning/staff/PROFILE.md'];
  const sources = new Map(await Promise.all(files.map(async (relative) => [relative, await studioFile(selection.root, relative)] as const)));
  ensureStudioCurrent(selection);
  const projectJson = setupText(sources.get(PROJECT_JSON));
  if (projectJson !== selection.projectJson) throw new Error(STUDIO_STAFF_CHANGED);
  const agents = setupText(sources.get('AGENTS.md'));
  setupText(sources.get('.planning/staff/PROFILE.md'));
  return { sources, ...(agents === undefined ? {} : { agents }), ...(projectJson === undefined ? {} : { projectJson }) };
}

async function verifyStudioFiles(selection: StudioStaffSelection, files: ReadonlyMap<string, Buffer | undefined>): Promise<void> {
  ensureStudioCurrent(selection);
  for (const [relative, expected] of files) {
    const actual = await studioFile(selection.root, relative);
    if (actual === undefined ? expected !== undefined : !expected?.equals(actual)) throw new Error(STUDIO_STAFF_CHANGED);
  }
  ensureStudioCurrent(selection);
}

export async function reviewStudioStaffSetup(selection: StudioStaffSelection, original: StudioStaffInputs, plan: StaffSetupPlan): Promise<StudioStaffReview> {
  await verifyStudioFiles(selection, original.sources);
  const files = new Map(original.sources);
  for (const write of plan.writes) {
    if (files.has(write.path)) continue;
    const bytes = await studioFile(selection.root, write.path);
    setupText(bytes);
    files.set(write.path, bytes);
  }
  await verifyStudioFiles(selection, files);
  return { selection, files };
}

/** The library file the plan's team goes to, and whether one is already there. */
export async function staffTeamTarget(library: TeamLibrary, plan: StaffSetupPlan): Promise<{ file: string; exists: boolean }> {
  const file = path.join(library.directory, `${plan.roster.fileName}.md`);
  return { file, exists: Boolean(await lstat(file).catch(() => undefined)) };
}

export interface StaffSetupResult { readonly teamFile: string; readonly archived?: string; readonly written: string[] }

/**
 * Writes the plan: the project files first (PROFILE.md, the skills, the settings, the guidance), then the team file last, so a team never exists
 * without the files it reads. An earlier team file of the same name is archived just before the new one is written (the caller asked the person). On
 * any failure everything written is rolled back: each project file goes back to what it held (or is removed when it was new), only if it still holds
 * what the setup wrote, and an archived team is put back. A path on the way that is a symbolic link is refused before anything is written, so a link
 * cannot send a write outside the project.
 */
export async function applyStaffSetup(root: string, library: TeamLibrary, plan: StaffSetupPlan, options: { replace?: boolean; studioReview?: StudioStaffReview } = {}): Promise<StaffSetupResult> {
  const review = options.studioReview;
  const guard = review ? () => review.selection.isCurrent() : undefined;
  const mayRestore = review ? () => review.selection.isSameDirectory?.() ?? review.selection.isCurrent() : undefined;
  if (review) {
    if (root !== review.selection.root || !plan.writes.every(({ path: file }) => review.files.has(file))) throw new Error(STUDIO_STAFF_CHANGED);
    await verifyStudioFiles(review.selection, review.files);
  } else {
    for (const write of plan.writes) await setupFile(root, write.path);
  }
  const target = await staffTeamTarget(library, plan);
  if (review && target.exists) throw new Error(studioSharedTeamMessage(target.file));
  if (target.exists && !options.replace) throw new Error(`${path.basename(target.file)} is already in your teams. Nothing was written.`);
  const done: Array<{ file: string; before: Buffer | undefined; wrote: string }> = [];
  let archived: string | undefined;
  let teamWritten = false;
  try {
    for (const write of plan.writes) {
      const file = path.join(root, ...write.path.split('/'));
      const before = review ? review.files.get(write.path) : await readFile(file).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? undefined : Promise.reject(error)));
      if (review) ensureStudioCurrent(review.selection);
      else await mkdir(path.dirname(file), { recursive: true });
      if (!(await writeIfUnchanged(file, snapshotOfBytes(before), write.content, guard))) {
        if (review) ensureStudioCurrent(review.selection);
        throw new Error(`${write.path} changed while the staff team was being set up.`);
      }
      done.push({ file, before, wrote: write.content });
    }
    await mkdir(library.directory, { recursive: true });
    if (review) {
      ensureStudioCurrent(review.selection);
      const created = await replaceKeepingEdits(target.file, { exists: false }, plan.team, () => review.selection.isCurrent());
      if (created.status !== 'written') throw new Error(review.selection.isCurrent() ? studioSharedTeamMessage(target.file) : STUDIO_STAFF_CHANGED);
    } else {
      archived = target.exists ? await library.archive(target.file) : undefined;
      if (!(await writeIfUnchanged(target.file, { exists: false }, plan.team))) throw new Error(`${path.basename(target.file)} appeared in your teams while the staff team was being set up.`);
    }
    teamWritten = true;
    await library.snapshot(target.file);
  } catch (error) {
    if (teamWritten) await writeIfUnchanged(target.file, snapshotOfBytes(Buffer.from(plan.team, 'utf8')), undefined).catch(() => undefined);
    if (archived) {
      await (path.basename(archived) === path.basename(target.file) ? library.restore(archived) : rename(archived, target.file)).catch(() => undefined);
    }
    for (const entry of done.reverse()) {
      if (mayRestore && !mayRestore()) {
        throw new Error('The project folder moved during setup. Review the original folder for any setup files.');
      }
      await writeIfUnchanged(entry.file, snapshotOfBytes(Buffer.from(entry.wrote, 'utf8')), entry.before === undefined ? undefined : entry.before.toString('utf8'), mayRestore).catch(() => undefined);
    }
    throw new Error(`The staff team was not set up, and what was written is rolled back: ${error instanceof Error ? error.message : String(error)}`);
  }
  staffTeamsChanged(root);
  return { teamFile: target.file, ...(archived ? { archived } : {}), written: done.map((entry) => path.relative(root, entry.file).split(path.sep).join('/')) };
}
