// The project's real-entity list (design 10, 4.2 and 8 item 4): names of real units, places, people and organizations that must never appear in
// exercise material. One list, read by guard-scan for products and by the scenario reader for imported scenarios, kept in two places a person can edit:
// the `realEntities` array of .planning/.near-ai/staff-guard.json (which an agent must ask before changing) and .planning/staff/real-entities.txt (one
// name per line, `#` starts a note). A name in either place counts. Pure: no I/O, no clock, no vscode.

/** The guard settings file a person keeps: the exercise box and real entities. */
export const GUARD_CONFIG_FILE = '.planning/.near-ai/staff-guard.json';
/** The plain list, one name per line, beside the scenario. */
export const REAL_ENTITIES_FILE = '.planning/staff/real-entities.txt';
/** Names shorter than this are ignored: one letter would match everywhere. */
export const MIN_REAL_ENTITY_LENGTH = 2;
const MAX_REAL_ENTITIES = 10_000;

/** The names in the text list: notes after a `#` at the start of a line or after a space are dropped, and blank or one-letter lines too. */
export function parseRealEntityList(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.replace(/(^|\s)#.*$/, '').trim()).filter((name) => name.length >= MIN_REAL_ENTITY_LENGTH);
}

/** The names in the guard settings' `realEntities` array, or none when the value is not a list. */
export function realEntitiesFromGuardConfig(value: unknown): string[] {
  const list = typeof value === 'object' && value !== null ? (value as { realEntities?: unknown }).realEntities : undefined;
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string').map((name) => name.trim()).filter((name) => name.length >= MIN_REAL_ENTITY_LENGTH) : [];
}

/** The one list: both sources, each name once, at most 10,000 names. */
export function mergeRealEntities(fromConfig: readonly string[], fromList: readonly string[]): string[] {
  return [...new Set([...fromConfig, ...fromList])].slice(0, MAX_REAL_ENTITIES);
}
