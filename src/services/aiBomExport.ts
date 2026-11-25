import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ResolvedPassport } from '../domain/gate/models';
import { dateShown } from '../domain/gate/placeWords';
import { validateDecisionRecord } from '../domain/gate/record';
import type { DecisionRecord } from '../domain/gate/record';
import { isInside } from '../domain/gate/researchLane';
import { aiBomFor, aiBomSummary } from '../domain/provenance/aiBom';
import { GATE_DIR_NAME } from '../gate/bundleStore';
import { MAX_ROTATED_FILES, MODEL_REQUESTS_DIR, projectLogKey } from '../gate/decisionLog';

// Export AI Bill of Materials (74.1 D-24, MPRV-10, 74.1-UI-SPEC S12): the open project's model-request log, read from this computer's global storage, made
// into a CycloneDX 1.6 bill of materials and written atomically to the project's .near-ai/state/ai-bom.cdx.json, only after checking that the folder
// resolves inside the project (P12: a planted link pointing elsewhere is refused). The log rotates, so the bill covers what this computer still keeps (P11).
// A record that cannot be read is skipped and counted, never guessed. Restricted Mode is identical (Q8). No prompt or answer text is ever written.

export const AI_BOM_COMMAND = 'nearAi.models.exportAiBom';
export const AI_BOM_FILE = 'ai-bom.cdx.json';

/** Every sentence of the export (74.1-UI-SPEC S12). Placeholders in braces are filled by code. */
export const AI_BOM_TEXT = Object.freeze({
  command: 'Export AI Bill of Materials',
  bomPickTitle: 'Export the AI bill of materials for which project?',
  bomProgress: 'Exporting the AI bill of materials',
  bomSaved: 'Saved the AI bill of materials for {project}: {n} used between {first} and {last}. It covers the model requests this computer still keeps.',
  bomSavedSkipped: '{k} records could not be read and were left out.',
  bomSavedNone: 'Saved the AI bill of materials for {project}. This computer keeps no model requests for it, so it lists no models.',
  bomOpen: 'Open File',
  bomNoProject: 'Open a project first. The AI bill of materials lists the models one project used.',
  bomOutside: 'Nothing was saved: this project\'s .near-ai/state folder points outside the project.',
  bomWriteFailed: 'The AI bill of materials could not be saved: {reason}. Check that the project folder can be written to, then run Export AI Bill of Materials again.',
  model: 'model',
  models: 'models'
});

const fill = (template: string, values: Readonly<Record<string, string>>): string => template.replace(/\{([a-z]+)\}/g, (whole, key: string) => values[key] ?? whole);

export interface AiBomExportDeps {
  /** The open project folders. */
  folders(): readonly { readonly name: string; readonly root: string }[];
  /** Asks which project, when several are open; undefined when the person closed the question. */
  pick(folders: readonly { readonly name: string; readonly root: string }[], title: string): Promise<{ readonly name: string; readonly root: string } | undefined>;
  /** The extension's global storage folder, where the gate keeps the model-request logs. */
  readonly globalStorageDir: string;
  /** The approval a model id resolves to now, under the effective rules. */
  resolve(model: string): ResolvedPassport | undefined;
  progress<T>(title: string, work: () => Promise<T>): Promise<T>;
  info(message: string, ...actions: string[]): Promise<string | undefined>;
  error(message: string): Promise<unknown>;
  open(file: string): Promise<unknown>;
}

/** The project's model-request records, oldest file first, and how many lines could not be read. */
export async function readModelRequests(globalStorageDir: string, root: string): Promise<{ readonly records: DecisionRecord[]; readonly skipped: number }> {
  const dir = path.join(globalStorageDir, GATE_DIR_NAME, MODEL_REQUESTS_DIR);
  const key = projectLogKey(root);
  const files = [...Array.from({ length: MAX_ROTATED_FILES }, (_unused, index) => path.join(dir, `${key}.${String(MAX_ROTATED_FILES - index)}.jsonl`)), path.join(dir, `${key}.jsonl`)];
  const records: DecisionRecord[] = [];
  let skipped = 0;
  for (const file of files) {
    let text: string;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = validateDecisionRecord(JSON.parse(line) as unknown);
        if (parsed.ok) records.push(parsed.value); else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
  }
  return { records, skipped };
}

/** The message after a save. */
export function savedMessage(project: string, summary: ReturnType<typeof aiBomSummary>, skipped: number): string {
  const base = summary.models === 0
    ? fill(AI_BOM_TEXT.bomSavedNone, { project })
    : fill(AI_BOM_TEXT.bomSaved, {
      project, n: `${String(summary.models)} ${summary.models === 1 ? AI_BOM_TEXT.model : AI_BOM_TEXT.models}`,
      first: dateShown(summary.first ?? ''), last: dateShown(summary.last ?? '')
    });
  return skipped === 0 ? base : `${base} ${fill(AI_BOM_TEXT.bomSavedSkipped, { k: String(skipped) })}`;
}

/** Runs the export for one open project. Returns the file written, or undefined when nothing was. */
export async function exportAiBom(deps: AiBomExportDeps): Promise<string | undefined> {
  const folders = deps.folders();
  if (folders.length === 0) { await deps.error(AI_BOM_TEXT.bomNoProject); return undefined; }
  const folder = folders.length === 1 ? folders[0] : await deps.pick(folders, AI_BOM_TEXT.bomPickTitle);
  if (folder === undefined) return undefined;
  const outcome = await deps.progress(AI_BOM_TEXT.bomProgress, async (): Promise<{ file: string; message: string } | { error: string }> => {
    const { records, skipped } = await readModelRequests(deps.globalStorageDir, folder.root);
    const bom = aiBomFor(records, { project: folder.name, resolve: deps.resolve });
    const text = `${JSON.stringify(bom, null, 2)}\n`;
    let root: string;
    let state: string;
    try {
      root = await realpath(folder.root);
      state = path.join(folder.root, '.near-ai', 'state');
      await mkdir(state, { recursive: true });
      // P12: the folder must resolve inside the project, so a planted link cannot send the file elsewhere.
      if (!isInside(await realpath(state), root)) return { error: AI_BOM_TEXT.bomOutside };
    } catch (error) {
      return { error: fill(AI_BOM_TEXT.bomWriteFailed, { reason: (error instanceof Error ? error.message : String(error)).replace(/\.$/, '') }) };
    }
    const file = path.join(state, AI_BOM_FILE);
    try {
      const temporary = `${file}.${String(process.pid)}.tmp`;
      await writeFile(temporary, text, 'utf8');
      await rename(temporary, file);
    } catch (error) {
      return { error: fill(AI_BOM_TEXT.bomWriteFailed, { reason: (error instanceof Error ? error.message : String(error)).replace(/\.$/, '') }) };
    }
    return { file, message: savedMessage(folder.name, aiBomSummary(bom), skipped) };
  });
  if ('error' in outcome) { await deps.error(outcome.error); return undefined; }
  const choice = await deps.info(outcome.message, AI_BOM_TEXT.bomOpen);
  if (choice === AI_BOM_TEXT.bomOpen) await deps.open(outcome.file);
  return outcome.file;
}
