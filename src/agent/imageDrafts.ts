// Image drafts (0.4.23, owner): "the user sees what is being generated, can give edit requests to iterate, and only an accepted image moves to its final
// location". In a real run an agent regenerated the same image 11 times over hours, scoring each one with its own scripts and writing every attempt
// straight into the report's image folder, while the person could neither see nor steer it.
//
// With nearAi.agent.imageReview set to "ask", GenerateImage writes each image here first, inside the project, and the chat shows it for review. Only
// an accepted draft is moved to the path the agent asked for; a discarded one is deleted, and drafts left behind are removed after DRAFT_MAX_AGE_MS.
//
// The folder is ignored by git twice over: the project's .gitignore gains `.near-ai/drafts/` (src/domain/scratch.ts), and the folder holds its own
// `.gitignore` of `*`, written before any draft, so a project whose .gitignore was set up before this release never commits a draft either.
// Agents may not write here without asking (the protected .near-ai rule); only the extension's own code writes drafts, never an agent tool.
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/** The drafts folder, relative to the project root, with forward slashes for messages. */
export const DRAFTS_DIR = '.near-ai/drafts/images';
/** A draft's id, and so its file name without `.png`: only names of this shape are ever read, moved, deleted or cleaned. */
export const DRAFT_ID = /^img-[a-f0-9]{12}$/;
/** Drafts older than this are removed when the extension starts or a run starts (owner: 7 days). */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const DRAFT_FILE = /^img-[a-f0-9]{12}\.png$/;

export function newDraftId(): string {
  return `img-${randomBytes(6).toString('hex')}`;
}

export function draftsFolder(root: string): string {
  return path.join(root, '.near-ai', 'drafts', 'images');
}

/** The draft's file. Throws for anything that is not a draft id, so no other name can be made into a path here. */
export function draftFile(root: string, id: string): string {
  if (!DRAFT_ID.test(id)) throw new Error(`${id.slice(0, 40)} is not an image draft id.`);
  return path.join(draftsFolder(root), `${id}.png`);
}

/** Creates the drafts folder with its own `.gitignore` of `*` first (an existing one is never replaced). */
async function ensureDraftsFolder(root: string): Promise<void> {
  const parent = path.join(root, '.near-ai', 'drafts');
  await mkdir(parent, { recursive: true });
  await writeFile(path.join(parent, '.gitignore'), '*\n', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  await mkdir(draftsFolder(root), { recursive: true });
}

/** Saves a new draft and returns its file. */
export async function writeDraft(root: string, id: string, bytes: Uint8Array): Promise<string> {
  const file = draftFile(root, id);
  await ensureDraftsFolder(root);
  await writeFile(file, bytes, { flag: 'wx' });
  return file;
}

export async function readDraft(root: string, id: string): Promise<Buffer | undefined> {
  return readFile(draftFile(root, id)).catch(() => undefined);
}

/** Moves an accepted draft to its final place (a rename; a copy and delete when the two are on different file systems). The caller makes the folder. */
export async function moveDraft(root: string, id: string, target: string): Promise<void> {
  const file = draftFile(root, id);
  try {
    await rename(file, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyFile(file, target);
    await rm(file, { force: true });
  }
}

export async function deleteDraft(root: string, id: string): Promise<void> {
  await rm(draftFile(root, id), { force: true });
}

/**
 * Removes drafts older than `maxAgeMs`: only files in the drafts folder named like a draft the extension made (`img-<12 hex>.png`), never anything else
 * there, and never a folder. Returns how many it removed. Never throws.
 */
export async function cleanOldDrafts(root: string, maxAgeMs = DRAFT_MAX_AGE_MS, now = Date.now()): Promise<number> {
  const folder = draftsFolder(root);
  const entries = await readdir(folder).catch(() => [] as string[]);
  let removed = 0;
  for (const entry of entries) {
    if (!DRAFT_FILE.test(entry)) continue;
    const file = path.join(folder, entry);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile() || now - info.mtimeMs < maxAgeMs) continue;
    if (await rm(file, { force: true }).then(() => true, () => false)) removed += 1;
  }
  return removed;
}
