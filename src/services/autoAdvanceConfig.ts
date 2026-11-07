// Writing the Open-GSD auto-advance flags for a project (owner, 2026-11-06). Open-GSD reads `workflow.auto_advance` and `workflow._auto_chain_active`
// from the project's .planning/config.json and stops at every boundary when both are false. The approval mode decides them, so a run in Auto carries on
// by itself and a run in an asking mode stops.
//
// Careful with the file: it belongs to the person's project, may have comments, and holds settings the extension must not disturb. Only the two keys are
// changed, everything else is preserved as text, and a file that cannot be parsed is left exactly as it was, with a plain sentence saying so.
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { AUTO_ADVANCE_TEXT, autoAdvanceFlags } from '../domain/autoAdvance';

export interface AutoAdvanceWrite { changed: string[]; text: string }

/** Where a project keeps the Open-GSD configuration the flags live in. */
export function planningConfigFile(root: string): string {
  return path.join(root, '.planning', 'config.json');
}

/** Sets (or clears) the two flags for the mode, keeping every other setting exactly as it was. Returns what changed and what to tell the person. */
export async function syncAutoAdvance(mode: string, root: string | undefined): Promise<string | undefined> {
  if (root === undefined) return undefined;
  const file = planningConfigFile(root);
  const raw = await readFile(file, 'utf8').catch(() => undefined);
  // A project without Open-GSD has nothing to tell: the flags mean nothing there.
  if (raw === undefined) return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return 'The project\'s .planning/config.json could not be read, so each step still stops at its boundary.';
  }
  const workflow = (parsed.workflow !== null && typeof parsed.workflow === 'object' ? parsed.workflow : {}) as Record<string, unknown>;
  const changes = autoAdvanceFlags(mode, { auto_advance: workflow.auto_advance === true, _auto_chain_active: workflow._auto_chain_active === true });
  const changed = Object.keys(changes);
  if (changed.length === 0) return mode === 'auto' || mode === 'fully-autonomous' ? AUTO_ADVANCE_TEXT.on : AUTO_ADVANCE_TEXT.off;
  parsed.workflow = { ...workflow, ...changes };
  try {
    await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch {
    return 'The project\'s .planning/config.json could not be written, so each step still stops at its boundary.';
  }
  return mode === 'auto' || mode === 'fully-autonomous' ? AUTO_ADVANCE_TEXT.on : AUTO_ADVANCE_TEXT.off;
}
