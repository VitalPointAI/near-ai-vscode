// Reads the project's one real-entity list from its two files (src/domain/staff/realEntities.ts). guard-scan (staffHost) and the scenario loader both
// call this, so a name added in either file is refused by both.
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { GUARD_CONFIG_FILE, mergeRealEntities, parseRealEntityList, REAL_ENTITIES_FILE, realEntitiesFromGuardConfig } from '../domain/staff/realEntities';

const readText = (file: string): Promise<string | undefined> => readFile(file, 'utf8').then((text) => text, () => undefined);

/** The project's real-entity list. A missing or unreadable file adds no names; it never stops the check. */
export async function readRealEntities(root: string): Promise<string[]> {
  const [config, list] = await Promise.all([readText(path.join(root, GUARD_CONFIG_FILE)), readText(path.join(root, REAL_ENTITIES_FILE))]);
  let fromConfig: string[] = [];
  if (config !== undefined) { try { fromConfig = realEntitiesFromGuardConfig(JSON.parse(config)); } catch { fromConfig = []; } }
  return mergeRealEntities(fromConfig, list === undefined ? [] : parseRealEntityList(list));
}
