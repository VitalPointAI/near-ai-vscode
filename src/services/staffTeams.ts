// A staff project's section teams: the one record (`staff.teams` in .planning/.near-ai/project.json, written by Set Up a Staff Team) that the chat's
// "Staff teams" card, the /team menu and the Staff Room all read, checked against the person's team library. Node I/O only, no vscode, so the tests drive
// it on a temporary folder.
//
// Each of the four sections (J2, J5, J3, J4) is in one of three states:
// - ready: the project names a team and its file is in the library and reads as a team; it can be tasked with /team:<name>;
// - missing: the project names a team whose file was deleted, renamed or no longer reads; it is shown as missing with "Set up again", never as a command;
// - none: no team is recorded. Library teams that match the project's profile and level by the setup's file-name rule are offered to link (`candidates`);
//   nothing is ever linked without the person choosing it (linkStaffTeam, after the command's confirmation).
import { lstat } from 'node:fs/promises';
import * as path from 'node:path';
import { sectionCode, parseStaffSettings, STAFF_TEAM_SECTIONS, staffSettingsJson } from '../domain/staff/profiles';
import type { StaffSettings, StaffTeamSection } from '../domain/staff/profiles';
import { STAFF_SECTIONS } from '../domain/staff/doctrine';
import { readWhole, snapshotOfBytes, writeIfUnchanged } from '../staff/staffFiles';
import { noTags, parseTeam } from '../agent/teams';
import { PROJECT_JSON, staffTeamCandidates, staffTeamsChanged } from './staffSetup';

export type StaffTeamState = 'ready' | 'missing' | 'none';

export interface StaffTeamEntry {
  readonly section: StaffTeamSection;
  /** The section's code under the project's profile and level ("J-2", "J2", "S-2"). */
  readonly code: string;
  /** What the section does ("Intelligence"). */
  readonly role: string;
  readonly state: StaffTeamState;
  /** The team's name in the library (run as /team:<team>); set when ready or missing. */
  readonly team?: string;
  /** The team's own title from its file, made plain and short; ready only. */
  readonly title?: string;
  /** Library teams that match the project by the setup's file-name rule, offered to link; none state only. */
  readonly candidates?: readonly string[];
}

export interface ProjectStaffTeams {
  /** The project has staff settings (`staff` in project.json). */
  readonly staff: boolean;
  readonly sections: readonly StaffTeamEntry[];
  /** Why the settings could not be read, when they could not: never shown as an empty list without the reason. */
  readonly problem?: string;
}

const NO_STAFF: ProjectStaffTeams = { staff: false, sections: [] };

/** The project's staff settings as read whole, with the bytes they came from (for a write that must not go over a change). */
async function readSettings(root: string): Promise<{ settings?: StaffSettings; config?: Record<string, unknown>; bytes?: Buffer; staff: boolean; problem?: string }> {
  const read = await readWhole(path.join(root, ...PROJECT_JSON.split('/')));
  if (read.kind === 'missing') return { staff: false };
  if (read.kind === 'unreadable') return { staff: false, problem: `${PROJECT_JSON} could not be read: ${read.reason}.` };
  let value: unknown;
  try { value = JSON.parse(read.text); } catch { return { staff: false, problem: `${PROJECT_JSON} is not valid JSON.` }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { staff: false, problem: `${PROJECT_JSON} is not a JSON object.` };
  const config = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(config, 'staff')) return { staff: false, config, bytes: read.bytes };
  const parsed = parseStaffSettings(config.staff);
  if (!parsed.ok) return { staff: true, config, bytes: read.bytes, problem: `The staff settings in ${PROJECT_JSON} are not valid: ${parsed.message}` };
  return { staff: true, settings: parsed.value, config, bytes: read.bytes };
}

/** A library team by name: its title when the file is there and reads as a team, else undefined. */
async function libraryTeam(libraryDir: string, team: string): Promise<{ title: string } | undefined> {
  const file = path.join(libraryDir, `${team}.md`);
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  const read = await readWhole(file);
  if (read.kind !== 'text') return undefined;
  try { return { title: noTags(parseTeam(read.text, file).name).slice(0, 80) }; } catch { return undefined; }
}

/** Every section's team for the project in `root`, checked against the team library in `libraryDir`. */
export async function projectStaffTeams(root: string, libraryDir: string): Promise<ProjectStaffTeams> {
  const read = await readSettings(root);
  if (!read.staff) return read.problem ? { ...NO_STAFF, problem: read.problem } : NO_STAFF;
  if (!read.settings) return { staff: true, sections: [], ...(read.problem ? { problem: read.problem } : {}) };
  const settings = read.settings;
  const sections = await Promise.all(STAFF_TEAM_SECTIONS.map(async (section): Promise<StaffTeamEntry> => {
    const base = { section, code: sectionCode(settings.profile, settings.level, section) ?? section.toUpperCase(), role: STAFF_SECTIONS[section].function };
    const team = settings.teams?.[section];
    if (team) {
      const found = await libraryTeam(libraryDir, team);
      return found ? { ...base, state: 'ready', team, title: found.title } : { ...base, state: 'missing', team };
    }
    const candidates: string[] = [];
    for (const name of staffTeamCandidates(section, settings)) if (await libraryTeam(libraryDir, name)) candidates.push(name);
    return { ...base, state: 'none', ...(candidates.length ? { candidates } : {}) };
  }));
  return { staff: true, sections };
}

/**
 * projectStaffTeams for the chat's card, the /team menu and Link, which never fails silently: a reason the settings do not read, or an unexpected error,
 * goes to `log` (the NEAR AI output channel), and an error comes back as the card's reason rather than as "not a staff project", which used to put the
 * "no team yet" card in its place with nothing said. The library folder is worked out inside, so an error there is reported the same way.
 */
export async function projectStaffTeamsReported(root: string, libraryDir: () => string, log: (line: string) => void): Promise<ProjectStaffTeams> {
  try {
    const teams = await projectStaffTeams(root, libraryDir());
    if (teams.problem) log(`Staff teams: ${teams.problem}`);
    return teams;
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error';
    log(`Staff teams could not be read: ${error instanceof Error && error.stack ? error.stack : reason}`);
    return { staff: true, sections: [], problem: `${reason}. The NEAR AI output has the details.` };
  }
}

export type LinkResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Records a library team as the project's team for one section, after the person chose it. Only a team the file-name rule matches for the project's
 * profile and level, whose file is in the library, and only for a section with no team recorded; project.json is written only if it still holds the
 * bytes read (the host never overwrites bytes it did not read), and a symbolic link on the way is refused.
 */
export async function linkStaffTeam(root: string, libraryDir: string, section: StaffTeamSection, team: string): Promise<LinkResult> {
  const parts = PROJECT_JSON.split('/');
  for (let index = 1; index <= parts.length; index += 1) {
    const info = await lstat(path.join(root, ...parts.slice(0, index))).catch(() => undefined);
    if (info?.isSymbolicLink()) return { ok: false, message: `${parts.slice(0, index).join('/')} is a symbolic link, so nothing was written.` };
  }
  const read = await readSettings(root);
  if (!read.settings || !read.config || !read.bytes) return { ok: false, message: read.problem ?? 'This project has no staff settings. Set up a staff team first.' };
  if (read.settings.teams?.[section]) return { ok: false, message: `This project already has a ${section.toUpperCase()} team, ${read.settings.teams[section]}.` };
  if (!staffTeamCandidates(section, read.settings).includes(team)) return { ok: false, message: `${team} is not a ${section.toUpperCase()} team for this project's profile and level.` };
  if (!(await libraryTeam(libraryDir, team))) return { ok: false, message: `${team}.md is not in your teams.` };
  const staff = staffSettingsJson({ ...read.settings, teams: { ...(read.settings.teams ?? {}), [section]: team } });
  const text = `${JSON.stringify({ ...read.config, staff }, null, 2)}\n`;
  const written = await writeIfUnchanged(path.join(root, ...parts), snapshotOfBytes(read.bytes), text);
  if (!written) return { ok: false, message: `${PROJECT_JSON} changed while the team was being linked. Nothing was written; try again.` };
  staffTeamsChanged(root);
  return { ok: true };
}

/** The /team menu entries for a staff project's ready section teams, in section order, each labelled with its section. */
export function staffMenuEntries(teams: ProjectStaffTeams): Array<{ command: string; title: string; description: string; argumentHint: string }> {
  return teams.sections.flatMap((entry) => entry.state === 'ready' && entry.team ? [{
    command: `team:${entry.team}`,
    title: `${entry.code} ${entry.role.toLowerCase()}: ${entry.title ?? entry.team}`,
    description: `${entry.code} ${entry.role.toLowerCase()} staff team${entry.title ? `: ${entry.title}` : ''}`,
    argumentHint: `<task for the ${entry.code} team>`
  }] : []);
}
