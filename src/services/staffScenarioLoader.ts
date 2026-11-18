// Loads an exercise scenario into a staff project (design 10, section 8; WP-DEMO): the starter scenario the extension ships, or a scenario file a
// person brings. No vscode: the command in staffScenario.ts asks the questions; this file reads, checks and writes.
//
// A scenario already in the project is never deleted or overwritten in place: it is moved, with the demo scripts made from it, to
// `.planning/staff/archive/<time>/` first. Nothing is written unless the whole scenario reads cleanly, and nothing is written through a symbolic link.
import { lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { DEMO_SECTIONS, demoScriptPath, renderDemoScript } from '../domain/staff/demoScripts';
import { defaultStaffSettings, parseStaffSettings } from '../domain/staff/profiles';
import type { StaffSettings } from '../domain/staff/profiles';
import { parseScenarioText, SCENARIO_DIR, SCENARIO_MAX_FILE, scenarioFiles } from '../domain/staff/scenario';
import type { Scenario } from '../domain/staff/scenario';

/** The starter scenario shipped with the extension. */
export const STARTER_SCENARIO_FILE = path.join(__dirname, '..', '..', 'resources', 'staff', 'scenarios', 'iron-lantern.json');
export const DEMO_DIR = '.planning/staff/demo';
export const ARCHIVE_DIR = '.planning/staff/archive';
/** Your organization's real-entity list for this project: one name per line, `#` starts a note. Optional. */
export const REAL_ENTITIES_FILE = '.planning/staff/real-entities.txt';
const PROJECT_FILE = '.planning/.near-ai/project.json';

export type LoadScenarioResult =
  | {
    readonly ok: true;
    readonly scenario: Scenario;
    readonly written: readonly string[];
    readonly archivedTo?: string;
    /** The settings the demo scripts were written for, and whether they came from the project or the defaults. */
    readonly settings: StaffSettings;
    readonly settingsFrom: 'project' | 'defaults';
    /** Why no demo scripts were written (a scenario of your own that the starter scripts do not fit). */
    readonly demoSkipped?: string;
  }
  | { readonly ok: false; readonly message: string };

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch { return false; }
}

/** Refuses when any folder on the way to `relative` under `root` is a symbolic link, so a write can never land outside the project. */
async function linkOnPath(root: string, relative: string): Promise<string | undefined> {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return path.relative(root, current);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The staff settings in project.json, or the defaults when the project has none (or none that read cleanly). */
export async function projectStaffSettings(root: string): Promise<{ settings: StaffSettings; from: 'project' | 'defaults' }> {
  try {
    const value = JSON.parse(await readFile(path.join(root, PROJECT_FILE), 'utf8')) as unknown;
    const staff = typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, 'staff') ? (value as Record<string, unknown>).staff : undefined;
    if (staff !== undefined) {
      const parsed = parseStaffSettings(staff);
      if (parsed.ok) return { settings: parsed.value, from: 'project' };
    }
  } catch {
    // No project file, or not JSON: the defaults apply.
  }
  return { settings: defaultStaffSettings(), from: 'defaults' };
}

/** The project's real-entity list, or an empty list when it has none. */
export async function projectRealEntities(root: string): Promise<string[]> {
  try {
    const text = await readFile(path.join(root, REAL_ENTITIES_FILE), 'utf8');
    return text.split(/\r?\n/).map((line) => line.replace(/(^|\s)#.*$/, '').trim()).filter((line) => line !== '');
  } catch {
    return [];
  }
}

/** Whether the project already holds a loaded scenario. */
export async function hasLoadedScenario(root: string): Promise<boolean> {
  return exists(path.join(root, SCENARIO_DIR));
}

/** Reads a scenario file a person picked, refusing one too large to be a scenario before reading it. */
export async function readScenarioFile(file: string): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return { ok: false, message: 'That is not a file.' };
    if (info.size > SCENARIO_MAX_FILE) return { ok: false, message: 'The file is larger than a scenario may be.' };
    return { ok: true, text: await readFile(file, 'utf8') };
  } catch {
    return { ok: false, message: 'The file could not be read.' };
  }
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * Checks the scenario text and, only if it reads cleanly, writes it into the project: the scenario folder and, when the starter demo scripts fit
 * the scenario, the J2 and J5 demo scripts for the project's profile and level. An earlier scenario and its demo scripts are archived first.
 */
export async function loadScenarioIntoProject(root: string, text: string, options: { readonly now?: Date } = {}): Promise<LoadScenarioResult> {
  const parsed = parseScenarioText(text, { realEntities: await projectRealEntities(root) });
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const scenario = parsed.value;
  const { settings, from } = await projectStaffSettings(root);

  for (const relative of [SCENARIO_DIR, DEMO_DIR, ARCHIVE_DIR]) {
    const link = await linkOnPath(root, relative);
    if (link) return { ok: false, message: `${link} is a symbolic link. Scenarios are written only to real folders inside the project.` };
  }

  const demos: Array<{ path: string; content: string }> = [];
  let demoSkipped: string | undefined;
  try {
    for (const section of DEMO_SECTIONS) demos.push({ path: demoScriptPath(section), content: renderDemoScript(section, settings, scenario) });
  } catch (error) {
    demos.length = 0;
    demoSkipped = `The demo scripts are written for the starter scenario and do not fit this one (${error instanceof Error ? error.message : String(error)}).`;
  }

  let archivedTo: string | undefined;
  // The demo scripts belong to the scenario they were made from, so they move with it even when the new scenario gets none.
  for (const relative of [SCENARIO_DIR, DEMO_DIR]) {
    if (!(await exists(path.join(root, relative)))) continue;
    archivedTo ??= `${ARCHIVE_DIR}/${stamp(options.now ?? new Date())}`;
    const target = path.join(root, archivedTo, path.basename(relative));
    if (await exists(target)) return { ok: false, message: `${archivedTo} already exists. Try again in a moment.` };
    await mkdir(path.dirname(target), { recursive: true });
    await rename(path.join(root, relative), target);
  }

  const written: string[] = [];
  for (const file of [...scenarioFiles(scenario), ...demos]) {
    const target = path.join(root, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx' });
    written.push(file.path);
  }
  return { ok: true, scenario, written, ...(archivedTo ? { archivedTo } : {}), settings, settingsFrom: from, ...(demoSkipped ? { demoSkipped } : {}) };
}
