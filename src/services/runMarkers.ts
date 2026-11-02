import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

// A run that the extension host never finished (code-server closed it, the window reloaded or
// crashed) leaves no trace in the chat: its tab reopens stopped, or not at all. Each run of a
// chat conversation therefore records that it started, what it was doing, and that it ended, in a
// small file in the extension's storage (one per conversation, never in the project). A file that
// says "started" but never "ended", written by a process that is gone, is a run that was cut off.
// The files hold IDs, times, a model ID, and tool names only: never prompts, arguments, or output.

const CONVERSATION_ID = /^conv-[a-z0-9-]{6,60}$/;
const RUN_ID = /^run-\d+-[a-f0-9]{6}$/;
/** Tool names kept for the steps started since the last saved state; older ones are dropped. */
const MAX_STEPS = 12;
/** Markers untouched for this long (ended, or cut off and never resumed) are removed when the folder is read. */
const KEEP_MS = 30 * 24 * 60 * 60_000;

export type RunEnd = 'completed' | 'cancelled' | 'failed' | 'max-turns' | 'resumed' | 'dismissed';

export interface RunMarker {
  version: 1;
  conversationId: string;
  runId: string;
  /** The extension host process that ran it; a marker of a live process is not interrupted. */
  pid: number;
  model?: string;
  startedAt: string;
  /** Last sign of life: the run started, saved its state, or started a step. */
  activeAt: string;
  /** When the conversation's transcript last saved the run's state (every finished step is in it). */
  savedAt?: string;
  /** Tools the run started after its last saved state, oldest first: their results were never saved. */
  steps: string[];
  endedAt?: string;
  outcome?: RunEnd;
}

export interface RunMarkerOptions {
  pid?: number;
  now?: () => number;
  /** Whether a process is still running; a marker of a running process is not reported as cut off. */
  alive?: (pid: number) => boolean;
}

/** True when a process with this ID exists (EPERM means it exists but belongs to someone else). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** One project's run markers, in `<storage>/runs/<hash of the project path>/<conversation>.json`. */
export class RunMarkers {
  private readonly dir: string;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  /** Writes happen one at a time, in order, so a later state never loses to an earlier one. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly live = new Map<string, RunMarker>();

  public constructor(storageDir: string, root: string, options: RunMarkerOptions = {}) {
    this.dir = path.join(storageDir, 'runs', createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16));
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? Date.now;
    this.alive = options.alive ?? processAlive;
  }

  private stamp(): string { return new Date(this.now()).toISOString(); }

  /** Records that a run started. */
  public start(input: { conversationId: string; runId: string; model?: string }): Promise<void> {
    if (!CONVERSATION_ID.test(input.conversationId) || !RUN_ID.test(input.runId)) return Promise.resolve();
    const at = this.stamp();
    const marker: RunMarker = { version: 1, conversationId: input.conversationId, runId: input.runId, pid: this.pid, ...(input.model ? { model: input.model.slice(0, 200) } : {}), startedAt: at, activeAt: at, steps: [] };
    this.live.set(input.conversationId, marker);
    return this.write(marker);
  }

  /** Records a step (tool) the run started; its result is saved with the next saved state. */
  public step(conversationId: string, runId: string, tool: string): Promise<void> {
    const marker = this.current(conversationId, runId);
    if (!marker) return Promise.resolve();
    marker.steps = [...marker.steps, tool.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80) || 'a tool'].slice(-MAX_STEPS);
    marker.activeAt = this.stamp();
    return this.write(marker);
  }

  /** Records that the run's state (every step so far, with its result) was saved in the transcript. */
  public saved(conversationId: string, runId: string): Promise<void> {
    const marker = this.current(conversationId, runId);
    if (!marker) return Promise.resolve();
    marker.savedAt = marker.activeAt = this.stamp();
    marker.steps = [];
    return this.write(marker);
  }

  /** Records that the run ended. Only the run that wrote the marker can end it. */
  public end(conversationId: string, runId: string, outcome: RunEnd): Promise<void> {
    const marker = this.current(conversationId, runId);
    if (!marker) return Promise.resolve();
    this.live.delete(conversationId);
    marker.endedAt = this.stamp();
    marker.outcome = outcome;
    return this.write(marker);
  }

  /** Settles a cut-off run the user resumed or dismissed, so it is not reported again. */
  public async settle(conversationId: string, outcome: 'resumed' | 'dismissed'): Promise<void> {
    await this.queue;
    const marker = await this.read(conversationId);
    if (!marker || marker.endedAt) return;
    marker.endedAt = this.stamp();
    marker.outcome = outcome;
    await this.write(marker);
  }

  /** The conversation's marker when its run was cut off (started, never ended, and its process is gone). */
  public async interruptedRun(conversationId: string): Promise<RunMarker | undefined> {
    const marker = await this.read(conversationId);
    return marker && this.isInterrupted(marker) ? marker : undefined;
  }

  /** Every run of this project that was cut off, newest first. Markers older than 30 days are cleared away. */
  public async interrupted(): Promise<RunMarker[]> {
    const found: RunMarker[] = [];
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      const marker = await this.read(name.slice(0, -5));
      if (!marker) continue;
      if (this.now() - Date.parse(marker.endedAt ?? marker.activeAt) > KEEP_MS) { await rm(path.join(this.dir, name), { force: true }).catch(() => undefined); continue; }
      if (this.isInterrupted(marker)) found.push(marker);
    }
    return found.sort((a, b) => b.activeAt.localeCompare(a.activeAt));
  }

  private isInterrupted(marker: RunMarker): boolean {
    return !marker.endedAt && marker.pid !== this.pid && !this.alive(marker.pid);
  }

  private current(conversationId: string, runId: string): RunMarker | undefined {
    const marker = this.live.get(conversationId);
    return marker && marker.runId === runId ? marker : undefined;
  }

  private async read(conversationId: string): Promise<RunMarker | undefined> {
    if (!CONVERSATION_ID.test(conversationId)) return undefined;
    try { return parseRunMarker(JSON.parse(await readFile(path.join(this.dir, `${conversationId}.json`), 'utf8')), conversationId); } catch { return undefined; }
  }

  /** Atomic: written to a temporary file, then renamed over the marker. Failures never stop a run. */
  private write(marker: RunMarker): Promise<void> {
    const snapshot = JSON.stringify(marker);
    const next = this.queue.then(async () => {
      const file = path.join(this.dir, `${marker.conversationId}.json`);
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        await mkdir(this.dir, { recursive: true });
        await writeFile(temporary, `${snapshot}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, file);
      } catch {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    this.queue = next;
    return next;
  }
}

/** Reads a marker strictly: anything malformed is ignored, never trusted. */
export function parseRunMarker(value: unknown, conversationId: string): RunMarker | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const time = (field: unknown) => typeof field === 'string' && !Number.isNaN(Date.parse(field));
  if (raw.version !== 1 || raw.conversationId !== conversationId || typeof raw.runId !== 'string' || !RUN_ID.test(raw.runId) || typeof raw.pid !== 'number' || !time(raw.startedAt) || !time(raw.activeAt)) return undefined;
  const outcomes = new Set(['completed', 'cancelled', 'failed', 'max-turns', 'resumed', 'dismissed']);
  return {
    version: 1,
    conversationId,
    runId: raw.runId,
    pid: raw.pid,
    ...(typeof raw.model === 'string' && raw.model ? { model: raw.model.slice(0, 200) } : {}),
    startedAt: raw.startedAt as string,
    activeAt: raw.activeAt as string,
    ...(time(raw.savedAt) ? { savedAt: raw.savedAt as string } : {}),
    steps: Array.isArray(raw.steps) ? raw.steps.filter((step): step is string => typeof step === 'string').map((step) => step.slice(0, 80)).slice(-MAX_STEPS) : [],
    ...(time(raw.endedAt) ? { endedAt: raw.endedAt as string } : {}),
    ...(typeof raw.outcome === 'string' && outcomes.has(raw.outcome) ? { outcome: raw.outcome as RunEnd } : {})
  };
}

/** How the chat says when a run was cut off: the time, and the date when it was not today. */
export function cutOffTime(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  return sameDay ? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** The chat line for a cut-off run. */
export function cutOffNotice(marker: Pick<RunMarker, 'activeAt'>, now = Date.now()): string {
  return `This run was cut off (the window or code-server closed it) at ${cutOffTime(marker.activeAt, now)}.`;
}

/**
 * The message Resume sends: continue from the saved state, and check (rather than repeat) any
 * step whose result was never recorded, since it may have partly or fully happened.
 */
export function resumePrompt(marker: Pick<RunMarker, 'activeAt' | 'steps'>, now = Date.now()): string {
  const when = cutOffTime(marker.activeAt, now);
  const steps = [...new Set(marker.steps)];
  const unknown = steps.length
    ? `After the last saved point it had started ${steps.length === 1 ? 'this step' : 'these steps'}: ${steps.join(', ')}. ${steps.length === 1 ? 'Its result was' : 'Their results were'} never recorded, so ${steps.length === 1 ? 'it' : 'each'} may or may not have completed. Before repeating any of them, check whether it already took effect (look at the files, the git status, or what the command would have changed), so nothing is done twice.`
    : 'It had not started any step after the last saved point, but check the workspace before redoing anything that changes files or runs commands.';
  return `Continue the task. Your previous run was cut off at ${when} (the window or code-server closed it) before it finished. Everything up to its last saved point is above. ${unknown}`;
}
