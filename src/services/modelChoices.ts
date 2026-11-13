// Model choices that follow the project (D-06, SYNC-06). "Apply recommended" and applying one role used to write the person's user settings, which no other
// interface or computer ever sees. They are now kept in the project's state home (choices.json), and every reader of a model setting resolves in this
// order: an explicit workspace or folder value, then the project choice, then the user value, then the default. The one exception is
// nearAi.agent.roleModels, which resolves role by role (resolveRoleModels), so a choice for one role never freezes the others.
//
// A choice the person clears is kept as a cleared entry (value null, with its time), not deleted, so another computer's older copy cannot bring it back.
//
// No vscode here, so the tests run on plain node. The project choice is only a model id; the privacy and TEE-only checks still apply to the resolved
// model when something is sent. Nothing is ever copied from the user's settings into the project without a click (importOffer only lists).
import { readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { createExclusive, stateHomeFor, writeFileAtomic } from './stateHome';

/** The settings a project can carry as a choice. A name outside this list found in the file is ignored. */
export const PROJECT_CHOICE_SETTINGS = [
  'nearAi.defaultModel',
  'nearAi.agent.deepModel',
  'nearAi.agent.standardModel',
  'nearAi.agent.fastModel',
  'nearAi.agent.visionModel',
  'nearAi.agent.transcriptionModel',
  'nearAi.agent.safetyModel',
  'nearAi.agent.imageModel',
  'nearAi.agent.roleModels'
] as const;
export type ProjectChoiceSetting = typeof PROJECT_CHOICE_SETTINGS[number];
export type ChoiceValue = string | Record<string, string>;

export interface ChoiceEntry { value: ChoiceValue; at: string; writer: string }
/** An entry as stored and synced: a value, or null for a choice that was cleared (kept so the clear syncs). */
export interface StoredChoice { value: ChoiceValue | null; at: string; writer: string }
/** The choices that are in effect: cleared entries are not here. */
export type ProjectChoiceValues = Partial<Record<ProjectChoiceSetting, ChoiceEntry>>;
export type StoredChoiceValues = Partial<Record<ProjectChoiceSetting, StoredChoice>>;
export interface ProjectChoices { version: 1; values: StoredChoiceValues; importDeclined?: boolean }

/** The parts of vscode's `inspect()` result that matter here. */
export interface InspectedSetting<T = unknown> { defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T }

const SETTINGS = new Set<string>(PROJECT_CHOICE_SETTINGS);
const MAX_FILE_BYTES = 256 * 1024;
const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 10_000;

/** `agent.deepModel` and `nearAi.agent.deepModel` both name the same setting; the file always uses the full name. */
export function choiceSettingName(setting: string): ProjectChoiceSetting | undefined {
  const full = setting.startsWith('nearAi.') ? setting : `nearAi.${setting}`;
  return SETTINGS.has(full) ? full as ProjectChoiceSetting : undefined;
}

function requireSetting(setting: string): ProjectChoiceSetting {
  const name = choiceSettingName(setting);
  if (!name) throw new Error(`${setting} is not a setting a project can carry.`);
  return name;
}

function cleanValue(setting: ProjectChoiceSetting, value: unknown): ChoiceValue | undefined {
  if (setting === 'nearAi.agent.roleModels') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length || !entries.every(([role, model]) => role.trim() && typeof model === 'string' && model.trim())) return undefined;
    return Object.fromEntries(entries.map(([role, model]) => [role.trim(), (model as string).trim()]));
  }
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sameValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): string => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return JSON.stringify(Object.entries(value as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)));
    return JSON.stringify(value ?? null);
  };
  return canonical(a) === canonical(b);
}

function parseChoices(text: string): ProjectChoices {
  const empty: ProjectChoices = { version: 1, values: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return empty; }
  const file = parsed as { version?: unknown; values?: unknown; importDeclined?: unknown } | null;
  if (!file || typeof file !== 'object' || file.version !== 1 || !file.values || typeof file.values !== 'object' || Array.isArray(file.values)) return empty;
  const values: StoredChoiceValues = {};
  for (const [name, raw] of Object.entries(file.values as Record<string, unknown>)) {
    if (!SETTINGS.has(name)) continue;
    const setting = name as ProjectChoiceSetting;
    const entry = raw as { value?: unknown; at?: unknown; writer?: unknown } | null;
    if (!entry || typeof entry !== 'object' || typeof entry.at !== 'string') continue;
    const writer = typeof entry.writer === 'string' ? entry.writer : '';
    if (entry.value === null) {
      if (!Number.isNaN(Date.parse(entry.at))) values[setting] = { value: null, at: entry.at, writer };
      continue;
    }
    const value = cleanValue(setting, entry.value);
    if (value === undefined) continue;
    values[setting] = { value, at: entry.at, writer };
  }
  return { version: 1, values, ...(file.importDeclined === true ? { importDeclined: true } : {}) };
}

/** How long the settings readers trust the last look at the choices file before asking the file system again. */
export const CHOICES_STAT_TTL_MS = 1000;

/** The test seams and the cache window of a read. `ttlMs` 0 (the default) looks at the file every time. */
export interface ReadOptions { ttlMs?: number; status?: (file: string) => { isFile(): boolean; size: number; mtimeMs: number; ino: number }; now?: () => number }

const cache = new Map<string, { stamp: string; choices: ProjectChoices; checkedAt: number }>();

/**
 * The whole choices file, read synchronously (the settings readers are synchronous). Cached by the file's modification time, size and inode, since every
 * write replaces the file; with a `ttlMs` the file's status is not even asked for again inside that window (every write in this process clears it, so a
 * change made here is seen at once). A missing, oversized or invalid file is an empty result; nothing is created. Cleared entries are included.
 */
export function readChoicesFileSync(root: string | undefined, options: ReadOptions = {}): ProjectChoices {
  if (!root) return { version: 1, values: {} };
  const file = stateHomeFor(root).paths.choices;
  const ttl = options.ttlMs ?? 0;
  const clock = options.now ?? Date.now;
  const cached = cache.get(file);
  if (ttl > 0 && cached && clock() - cached.checkedAt >= 0 && clock() - cached.checkedAt < ttl) return cached.choices;
  const empty = (): ProjectChoices => {
    const choices: ProjectChoices = { version: 1, values: {} };
    if (ttl > 0) cache.set(file, { stamp: '', choices, checkedAt: clock() }); else cache.delete(file);
    return choices;
  };
  try {
    const info = (options.status ?? statSync)(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return empty();
    const stamp = `${info.mtimeMs}:${info.size}:${info.ino}`;
    if (cached?.stamp === stamp) { cache.set(file, { ...cached, checkedAt: clock() }); return cached.choices; }
    const choices = parseChoices(readFileSync(file, 'utf8'));
    cache.set(file, { stamp, choices, checkedAt: clock() });
    return choices;
  } catch {
    return empty();
  }
}

/** The project's choices in effect by setting; empty when the project has none. A cleared choice is not one. */
export function readProjectChoicesSync(root: string | undefined, options: ReadOptions = {}): ProjectChoiceValues {
  const values: ProjectChoiceValues = {};
  for (const [setting, entry] of Object.entries(readChoicesFileSync(root, options).values)) {
    if (entry && entry.value !== null) values[setting as ProjectChoiceSetting] = { value: entry.value, at: entry.at, writer: entry.writer };
  }
  return values;
}

const resolving = (options: ReadOptions): ReadOptions => ({ ttlMs: CHOICES_STAT_TTL_MS, ...options });

/** The project's choice for one setting (either name form), or undefined. Read with the status cache: this is what every settings reader calls. */
export function projectChoiceFor(root: string | undefined, setting: string, options: ReadOptions = {}): ChoiceValue | undefined {
  const name = choiceSettingName(setting);
  return name ? readProjectChoicesSync(root, resolving(options))[name]?.value : undefined;
}

/**
 * The value a reader uses: an explicit workspace-folder or workspace value, then the project choice, then the user value, then the fallback. An empty
 * string anywhere is not a value (the existing validation treated it as missing too).
 */
export function resolveSetting<T>(inspected: InspectedSetting<T> | undefined, projectValue: T | undefined, fallback: T): T {
  const usable = (value: T | undefined): value is T => value !== undefined && value !== null && !(typeof value === 'string' && !value.trim());
  const picks = [inspected?.workspaceFolderValue, inspected?.workspaceValue, projectValue, inspected?.globalValue];
  for (const value of picks) if (usable(value)) return value;
  return fallback;
}

/**
 * nearAi.agent.roleModels, role by role: the defaults, then the user's value, then the project's choice, then the workspace value, then the folder value.
 * A role a later layer does not name keeps the earlier layer's model, so a choice made for one role never freezes the others. Empty or non-string
 * entries are ignored.
 */
export function resolveRoleModels(inspected: InspectedSetting | undefined, projectRoles: unknown, fallback: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const layer of [inspected?.defaultValue ?? fallback, inspected?.globalValue, projectRoles, inspected?.workspaceValue, inspected?.workspaceFolderValue]) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue;
    for (const [role, model] of Object.entries(layer as Record<string, unknown>)) {
      if (typeof model === 'string' && model.trim() && role.trim()) resolved[role.trim()] = model.trim();
    }
  }
  return resolved;
}

/** Where applying a model writes: the workspace when it already sets the value explicitly, otherwise the project's choices. Never user settings. */
export function planApply(inspected: InspectedSetting | undefined): 'workspace' | 'project' {
  return inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined ? 'workspace' : 'project';
}

/** The settings whose value right now comes from the project's choice: it has one, and the workspace does not set the value explicitly. */
export function choicesInEffect(root: string | undefined, inspect: (setting: string) => InspectedSetting | undefined, options: ReadOptions = {}): ProjectChoiceSetting[] {
  const values = readProjectChoicesSync(root, resolving(options));
  return PROJECT_CHOICE_SETTINGS.filter((setting) => values[setting] !== undefined && planApply(inspect(setting.slice('nearAi.'.length))) === 'project');
}

function later(a: StoredChoice, b: StoredChoice): boolean {
  return a.at > b.at || (a.at === b.at && a.writer > b.writer);
}

const queues = new Map<string, Promise<unknown>>();

/** Held while the file is read, changed and replaced, so two editors never overwrite each other's setting. */
async function withLock<T>(root: string, run: () => Promise<T>): Promise<T> {
  const home = stateHomeFor(root);
  const lock = `${home.paths.choices}.lock`;
  const started = Date.now();
  for (;;) {
    if (await createExclusive(lock, `${process.pid}\n`) === 'created') break;
    const age = Date.now() - ((await stat(lock).catch(() => undefined))?.mtimeMs ?? Date.now());
    if (age > LOCK_STALE_MS) { await rm(lock, { force: true }).catch(() => undefined); continue; }
    if (Date.now() - started > LOCK_WAIT_MS) throw new Error("This project's model choices are being changed by another editor. Try again in a moment. Nothing was changed.");
    await new Promise((resolve) => setTimeout(resolve, 15 + Math.floor(Math.random() * 25)));
  }
  try { return await run(); } finally { await rm(lock, { force: true }).catch(() => undefined); }
}

/** One change at a time in this process, then the file lock across processes. */
function serialised<T>(root: string, run: () => Promise<T>): Promise<T> {
  const key = path.resolve(root);
  const result = (queues.get(key) ?? Promise.resolve()).then(() => withLock(root, run), () => withLock(root, run));
  queues.set(key, result.catch(() => undefined));
  return result;
}

async function readFresh(root: string): Promise<ProjectChoices> {
  const text = await readFile(stateHomeFor(root).paths.choices, 'utf8').catch(() => '');
  return text ? parseChoices(text) : { version: 1, values: {} };
}

async function replace(root: string, choices: ProjectChoices): Promise<void> {
  const home = stateHomeFor(root);
  await mkdir(home.dir, { recursive: true, mode: 0o700 });
  try { await writeFileAtomic(home.paths.choices, `${JSON.stringify(choices, null, 2)}\n`, { mode: 0o600 }); } finally { cache.delete(home.paths.choices); }
}

/**
 * Sets the project's choice for one setting and says whether the file changed. The file is re-read under the lock and merged per setting, a later
 * (at, writer) winning, so a setting another editor wrote a moment ago is kept. Writing the value already stored changes nothing at all.
 */
export async function writeProjectChoice(root: string, setting: string, value: ChoiceValue, writer: string): Promise<boolean> {
  const name = requireSetting(setting);
  const clean = cleanValue(name, value);
  if (clean === undefined) throw new Error(`${setting} needs a model name.`);
  await stateHomeFor(root).ensure();
  return serialised(root, async () => {
    const current = await readFresh(root);
    const existing = current.values[name];
    if (existing && sameValue(existing.value, clean)) return false;
    const entry: StoredChoice = { value: clean, at: new Date().toISOString(), writer };
    if (existing && later(existing, entry)) return false;
    await replace(root, { ...current, values: { ...current.values, [name]: entry } });
    return true;
  });
}

/**
 * Merges choices that came from another computer into the project's file, keeping for each setting the later (at, writer) of the two and the entry's own
 * time and writer (an apply stamps nothing new). Returns whether the file changed. Unknown settings and malformed values are ignored.
 */
export async function mergeProjectChoices(root: string, incoming: Record<string, StoredChoice>): Promise<boolean> {
  const wanted: Array<[ProjectChoiceSetting, StoredChoice]> = [];
  for (const [name, entry] of Object.entries(incoming)) {
    const setting = choiceSettingName(name);
    const value = setting ? (entry?.value === null ? null : cleanValue(setting, entry?.value)) : undefined;
    if (!setting || value === undefined || typeof entry.at !== 'string' || Number.isNaN(Date.parse(entry.at))) continue;
    wanted.push([setting, { value, at: entry.at, writer: typeof entry.writer === 'string' ? entry.writer : '' }]);
  }
  if (!wanted.length) return false;
  await stateHomeFor(root).ensure();
  return serialised(root, async () => {
    const current = await readFresh(root);
    const values = { ...current.values };
    let changed = false;
    for (const [setting, entry] of wanted) {
      const existing = values[setting];
      if (existing && (later(existing, entry) || (existing.at === entry.at && existing.writer === entry.writer && sameValue(existing.value, entry.value)))) continue;
      values[setting] = entry;
      changed = true;
    }
    if (changed) await replace(root, { ...current, values });
    return changed;
  });
}

/**
 * Clears the project's choice for one setting (the undo of a first-time choice, and "Use my settings"); true when there was one. The entry is kept as a
 * cleared entry with its time, so the clear syncs and another computer's older copy cannot bring the choice back. Other settings are kept.
 */
export async function removeProjectChoice(root: string, setting: string, writer: string): Promise<boolean> {
  const name = requireSetting(setting);
  if (!(await stateHomeFor(root).exists())) return false;
  return serialised(root, async () => {
    const current = await readFresh(root);
    const existing = current.values[name];
    if (!existing || existing.value === null) return false;
    // A deliberate clear is later than the choice it clears, even inside one millisecond.
    const now = new Date();
    const at = now.toISOString() > existing.at ? now.toISOString() : new Date(Date.parse(existing.at) + 1).toISOString();
    await replace(root, { ...current, values: { ...current.values, [name]: { value: null, at, writer } } });
    return true;
  });
}

/** "Not now" on the import offer: remembered for the project, so the offer is not shown again. */
export async function declineImport(root: string, _writer: string): Promise<void> {
  await stateHomeFor(root).ensure();
  await serialised(root, async () => {
    const current = await readFresh(root);
    if (current.importDeclined) return;
    await replace(root, { ...current, importDeclined: true });
  });
}

/** What one apply replaced, so undo can put it back exactly: the previous project choice, or none (undo removes it). */
export interface ProjectUndo { root: string; setting: ProjectChoiceSetting; previous: ChoiceValue | undefined }

/** Captures the project's current choice for a setting; call it BEFORE the write so a failed write still leaves what happened undoable. */
export function projectUndoFor(root: string, setting: string): ProjectUndo {
  const name = requireSetting(setting);
  return { root, setting: name, previous: readProjectChoicesSync(root)[name]?.value };
}

/** Puts the project's choice back to what it was before the apply: the old choice, or none. */
export async function undoProjectChoice(undo: ProjectUndo, writer: string): Promise<void> {
  if (undo.previous === undefined) await removeProjectChoice(undo.root, undo.setting, writer);
  else await writeProjectChoice(undo.root, undo.setting, undo.previous, writer);
}

export interface ImportCandidate { setting: ProjectChoiceSetting; value: ChoiceValue }

/**
 * The settings set earlier in the person's user settings that the project could take: the user value differs from the default, and the project has no
 * choice for it yet. Empty when the person already said "Not now", when the user value is the default or already the project's choice, or when every
 * setting already has a project choice. This only lists; nothing is copied until the person clicks.
 */
export function importOffer(inspectedBySetting: Record<string, InspectedSetting | undefined>, choices: ProjectChoices): ImportCandidate[] {
  if (choices.importDeclined) return [];
  const offered: ImportCandidate[] = [];
  for (const setting of PROJECT_CHOICE_SETTINGS) {
    const inspected = inspectedBySetting[setting] ?? inspectedBySetting[setting.slice('nearAi.'.length)];
    const user = cleanValue(setting, inspected?.globalValue);
    if (user === undefined || sameValue(user, inspected?.defaultValue)) continue;
    const project = choices.values[setting];
    if (project) continue;
    offered.push({ setting, value: user });
  }
  return offered;
}
