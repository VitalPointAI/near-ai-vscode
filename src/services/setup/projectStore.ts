import { readFileSync, statSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ScaleTable } from '../../domain/gate/labels';
import { parseProjectLayer, type ProjectLayerRead } from '../../domain/gate/layers';
import type { PolicyDocument } from '../../domain/gate/policyDocument';
import { isRecord } from '../../domain/gate/shape';
import { DEFAULT_MODE, MODE_IDS, type ModeId } from '../../domain/org/modes';
import { parseSetupGuideEntry, type SetupGuideEntry } from '../../domain/setup/answers';
import { REPLICA_PROJECT_FILE } from '../../domain/staff/multiUser';
import { writeFileAtomic } from '../../team/teamFile';
import { withFileLock } from '../stateMirrorLock';

export const PROJECT_JSON_FILE = '.planning/.near-ai/project.json';
export const MAX_PROJECT_JSON_BYTES = 256 * 1024;
export const PROJECT_JSON_UNREADABLE_TEXT = "This project's settings could not be read.";
export const PROJECT_JSON_WRITE_FAILED_TEXT = "This project's settings could not be saved.";

const NO_PROJECT_LAYER = Object.freeze({ state: 'none' } as const);
const UNREADABLE_PROJECT_LAYER = Object.freeze({ state: 'unreadable' } as const);
const RECHECK_MS = 1_000;
const PROJECT_LOCK = 'project.json.lock';

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export function projectLayerOf(current: Readonly<Record<string, unknown>>, scales: ScaleTable): ProjectLayerRead {
  if (!Object.hasOwn(current, 'projectLayer')) return NO_PROJECT_LAYER;
  const value = current.projectLayer;
  if (!isRecord(value)) return UNREADABLE_PROJECT_LAYER;
  // The signed label map is the sole source of a project's label.
  const { label: _label, ...settings } = value;
  const parsed = parseProjectLayer(settings, scales);
  return parsed.ok ? Object.freeze({ state: 'valid', layer: parsed.value }) : UNREADABLE_PROJECT_LAYER;
}

interface ProjectLayerSourceDeps {
  readonly readFileSync: (file: string, encoding: 'utf8') => string;
  readonly statSync: (file: string) => { mtimeMs: number; size: number; isFile(): boolean; ctimeMs?: number; ino?: number };
  readonly scales: () => ScaleTable;
  readonly now: () => number;
}

function readLayerFile(file: string, read: ProjectLayerSourceDeps['readFileSync'], info: ReturnType<ProjectLayerSourceDeps['statSync']>, scales: ScaleTable): ProjectLayerRead {
  if (!info.isFile() || info.size > MAX_PROJECT_JSON_BYTES) return UNREADABLE_PROJECT_LAYER;
  const text = read(file, 'utf8');
  if (Buffer.byteLength(text) > MAX_PROJECT_JSON_BYTES) return UNREADABLE_PROJECT_LAYER;
  let current: unknown;
  try {
    current = JSON.parse(text);
  } catch {
    return text.includes('projectLayer') ? UNREADABLE_PROJECT_LAYER : NO_PROJECT_LAYER;
  }
  return isRecord(current) ? projectLayerOf(current, scales) : NO_PROJECT_LAYER;
}

export function readProjectLayer(root: string, scales: ScaleTable = {}): ProjectLayerRead {
  const file = path.join(root, PROJECT_JSON_FILE);
  try {
    return readLayerFile(file, readFileSync, statSync(file), scales);
  } catch (error) {
    return missing(error) ? NO_PROJECT_LAYER : UNREADABLE_PROJECT_LAYER;
  }
}

export function createProjectLayerSource(deps: ProjectLayerSourceDeps): { read(root: string): ProjectLayerRead; invalidate(root: string): void } {
  const cache = new Map<string, { checkedAt: number; fingerprint?: string; scales?: ScaleTable; result: ProjectLayerRead }>();
  return {
    read(root) {
      const file = path.resolve(root, PROJECT_JSON_FILE);
      const checkedAt = deps.now();
      const previous = cache.get(file);
      if (previous && checkedAt >= previous.checkedAt && checkedAt - previous.checkedAt < RECHECK_MS) return previous.result;
      try {
        const info = deps.statSync(file);
        const fingerprint = `${info.mtimeMs}:${info.size}:${info.ctimeMs}:${info.ino}`;
        const scales = deps.scales();
        const result = previous?.fingerprint === fingerprint && previous.scales === scales
          ? previous.result : readLayerFile(file, deps.readFileSync, info, scales);
        cache.set(file, { checkedAt, fingerprint, scales, result });
        return result;
      } catch (error) {
        const result = missing(error) ? NO_PROJECT_LAYER : UNREADABLE_PROJECT_LAYER;
        cache.set(file, { checkedAt, result });
        return result;
      }
    },
    invalidate(root) {
      cache.delete(path.resolve(root, PROJECT_JSON_FILE));
    }
  };
}

export type ProjectJsonUpdate = { ok: true } | { ok: false; text: string };

async function fileInfo(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (!missing(error)) throw error;
    return undefined;
  }
}

/** Serialize project settings reads and writes across the guide and staff setup. */
export async function withProjectJsonLock<T>(root: string, work: (file: string) => Promise<T>): Promise<T> {
  const file = path.resolve(root, PROJECT_JSON_FILE);
  const dir = path.dirname(file);
  // A checkout can contain links. Keep the lock and temporary files inside the project.
  for (const parent of [path.dirname(dir), dir]) {
    const info = await fileInfo(parent);
    if (info && !info.isDirectory()) throw new Error(PROJECT_JSON_UNREADABLE_TEXT);
  }
  const lock = await fileInfo(path.join(dir, PROJECT_LOCK));
  if (lock && !lock.isFile()) throw new Error(PROJECT_JSON_WRITE_FAILED_TEXT);
  return withFileLock(dir, PROJECT_LOCK, () => work(file));
}

/** Preserve unrelated project settings and publish the guide's changes together under a separate lock file. */
export async function updateProjectJson(
  root: string,
  mutate: (current: Readonly<Record<string, unknown>>) => Record<string, unknown>,
  source?: { invalidate(root: string): void }
): Promise<ProjectJsonUpdate> {
  try {
    return await withProjectJsonLock(root, async (file) => {
      let current: unknown = {};
      try {
        const info = await fileInfo(file);
        if (info) {
          if (!info.isFile() || info.size > MAX_PROJECT_JSON_BYTES) return { ok: false, text: PROJECT_JSON_UNREADABLE_TEXT };
          const text = await readFile(file, 'utf8');
          if (Buffer.byteLength(text) > MAX_PROJECT_JSON_BYTES) return { ok: false, text: PROJECT_JSON_UNREADABLE_TEXT };
          current = JSON.parse(text);
        }
      } catch {
        return { ok: false, text: PROJECT_JSON_UNREADABLE_TEXT };
      }
      if (!isRecord(current)) return { ok: false, text: PROJECT_JSON_UNREADABLE_TEXT };
      const snapshot = Object.freeze({ ...current });
      const next = mutate(snapshot);
      if (next !== snapshot) {
        if (!isRecord(next)) return { ok: false, text: PROJECT_JSON_WRITE_FAILED_TEXT };
        const text = `${JSON.stringify(next, null, 2)}\n`;
        if (Buffer.byteLength(text) > MAX_PROJECT_JSON_BYTES) return { ok: false, text: PROJECT_JSON_WRITE_FAILED_TEXT };
        await writeFileAtomic(file, text);
        source?.invalidate(root);
      }
      return { ok: true };
    });
  } catch (error) {
    const text = error instanceof Error && error.message === PROJECT_JSON_UNREADABLE_TEXT ? PROJECT_JSON_UNREADABLE_TEXT : PROJECT_JSON_WRITE_FAILED_TEXT;
    return { ok: false, text };
  }
}

export function readSetupGuide(root: string): SetupGuideEntry | undefined {
  const file = path.join(root, PROJECT_JSON_FILE);
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size > MAX_PROJECT_JSON_BYTES) return undefined;
    const text = readFileSync(file, 'utf8');
    if (Buffer.byteLength(text) > MAX_PROJECT_JSON_BYTES) return undefined;
    const current: unknown = JSON.parse(text);
    return isRecord(current) ? parseSetupGuideEntry(current.setupGuide) : undefined;
  } catch {
    return undefined;
  }
}

export function projectMode(root: string, effective?: PolicyDocument): ModeId {
  const project = readProjectLayer(root, effective?.labels.scales);
  const organization = effective?.people?.organization;
  if (project.state === 'valid') {
    const mode = MODE_IDS.find((id) => id === project.layer.mode);
    if (mode !== undefined && (organization === undefined || organization.allowedModes.includes(mode))) return mode;
  }
  return organization?.mode ?? DEFAULT_MODE;
}

export async function isSharedProject(root: string): Promise<boolean> {
  try {
    await lstat(path.join(root, REPLICA_PROJECT_FILE));
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
