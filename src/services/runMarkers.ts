import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { writerEditor } from './stateHome';

// A run that the extension host never finished (code-server closed it, the window reloaded or
// crashed) leaves no trace in the chat: its tab reopens stopped, or not at all. Each run of a
// chat conversation therefore records that it started, what it was doing, and that it ended, in a
// small file (one per conversation) in the project's state home, which every editor on this computer shares. A file that says "started" but
// never "ended", written by a process that is gone, is a run that was cut off. A pid means nothing to another editor (its own pid namespace, such
// as a code-server container), so a marker also carries the writer and a heartbeat: a run another editor keeps refreshing is running elsewhere,
// and only silence for FOREIGN_LIVE_MS makes it cut off.
// The files hold IDs, times, a model ID, tool names and the writer id only: never prompts, arguments, or output.

const CONVERSATION_ID = /^conv-[a-z0-9-]{6,60}$/;
const RUN_ID = /^run-\d+-[a-f0-9]{6}$/;
const WRITER = /^[a-z0-9]{6,40}\.[a-z0-9]{6,40}$/;
/** A live run refreshes its marker this often. */
export const HEARTBEAT_MS = 30_000;
/** A marker another editor wrote counts as live while it was refreshed within this long (six missed heartbeats). */
export const FOREIGN_LIVE_MS = 180_000;
/** Tool names kept for the steps started since the last saved state; older ones are dropped. */
const MAX_STEPS = 12;
/** Markers untouched for this long (ended, or cut off and never resumed) are removed when the folder is read. */
const KEEP_MS = 30 * 24 * 60 * 60_000;

export type RunEnd = 'completed' | 'cancelled' | 'failed' | 'max-turns' | 'stuck' | 'resumed' | 'dismissed';

export type RunState = 'finished' | 'running-here' | 'running-elsewhere' | 'cut-off';

export interface RunMarker {
  version: 1 | 2;
  conversationId: string;
  runId: string;
  /** The extension host process that ran it; only meaningful to the same editor (the same pid namespace). */
  pid: number;
  /** `<editor>.<instance>` of the extension host that ran it; absent in a version 1 marker, which counts as another editor's. */
  writer?: string;
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
  /** Set while the run waits on a person (an approval or a question), so another editor can say so; cleared when answered or when the run ends. */
  waitingSince?: string;
}

export interface RunMarkerOptions {
  pid?: number;
  now?: () => number;
  /** Whether a process is still running; a marker of a running process is not reported as cut off. */
  alive?: (pid: number) => boolean;
  /** The marker folder itself (the state home's runs folder); without it the old `<storage>/runs/<hash of the project>` form is used. */
  dir?: string;
  /** Who is writing: `<editor>.<instance>`. Without it a stand-in derived from the pid is used, so one editor with different pids behaves as before. */
  writer?: string;
  /** Awaited before each write; the chat passes the state home's ensure(), so its inner .gitignore exists before the first marker. */
  beforeWrite?: () => Promise<unknown>;
}

/** True when a process with this ID exists (EPERM means it exists but belongs to someone else). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** One project's run markers, in the state home's `runs/<conversation>.json` (or, in the old form, `<storage>/runs/<hash of the project path>/`). */
export class RunMarkers {
  private readonly dir: string;
  private readonly pid: number;
  private readonly writer: string;
  private readonly beforeWrite: (() => Promise<unknown>) | undefined;
  private readonly beats = new Map<string, NodeJS.Timeout>();
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  /** Writes happen one at a time, in order, so a later state never loses to an earlier one. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly live = new Map<string, RunMarker>();

  public constructor(storageDir: string, root: string, options: RunMarkerOptions = {}) {
    this.dir = options.dir ?? path.join(storageDir, 'runs', createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16));
    this.pid = options.pid ?? process.pid;
    this.writer = options.writer ?? `legacy.p${String(this.pid).padStart(6, '0')}`;
    this.beforeWrite = options.beforeWrite;
    this.now = options.now ?? Date.now;
    this.alive = options.alive ?? processAlive;
  }

  private stamp(): string { return new Date(this.now()).toISOString(); }

  /** Records that a run started. */
  public start(input: { conversationId: string; runId: string; model?: string }): Promise<void> {
    if (!CONVERSATION_ID.test(input.conversationId) || !RUN_ID.test(input.runId)) return Promise.resolve();
    const at = this.stamp();
    const marker: RunMarker = { version: 2, conversationId: input.conversationId, runId: input.runId, pid: this.pid, writer: this.writer, ...(input.model ? { model: input.model.slice(0, 200) } : {}), startedAt: at, activeAt: at, steps: [] };
    this.live.set(input.conversationId, marker);
    this.beat(input.conversationId);
    return this.write(marker);
  }

  /** While the run is live its marker is refreshed every HEARTBEAT_MS, so another editor can tell a running run from a cut-off one. */
  private beat(conversationId: string): void {
    this.stopBeat(conversationId);
    const timer = setInterval(() => {
      const marker = this.live.get(conversationId);
      if (!marker || marker.endedAt) { this.stopBeat(conversationId); return; }
      marker.activeAt = this.stamp();
      void this.write(marker);
    }, HEARTBEAT_MS);
    timer.unref?.();
    this.beats.set(conversationId, timer);
  }

  private stopBeat(conversationId: string): void {
    const timer = this.beats.get(conversationId);
    if (timer) clearInterval(timer);
    this.beats.delete(conversationId);
  }

  /** Resolves when every write started so far has finished. */
  public async idle(): Promise<void> { await this.queue; }

  /** Stops every heartbeat, for when the window closes. The markers stay as they are. */
  public dispose(): void { for (const id of [...this.beats.keys()]) this.stopBeat(id); }

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

  /**
   * Records that the run waits on a person (an approval or a question), or no longer does, so another editor can say "waiting for your answer" instead of
   * "running". A second prompt while one is open does not move the start of the wait. Only the run that wrote the marker can change it.
   */
  public waiting(conversationId: string, runId: string, on: boolean): Promise<void> {
    const marker = this.current(conversationId, runId);
    if (!marker || Boolean(marker.waitingSince) === on) return Promise.resolve();
    marker.activeAt = this.stamp();
    if (on) marker.waitingSince = marker.activeAt; else delete marker.waitingSince;
    return this.write(marker);
  }

  /** Records that the run ended. Only the run that wrote the marker can end it. */
  public end(conversationId: string, runId: string, outcome: RunEnd): Promise<void> {
    const marker = this.current(conversationId, runId);
    if (!marker) return Promise.resolve();
    this.live.delete(conversationId);
    this.stopBeat(conversationId);
    marker.endedAt = this.stamp();
    marker.outcome = outcome;
    delete marker.waitingSince;
    return this.write(marker);
  }

  /** Settles a cut-off run the user resumed or dismissed, so it is not reported again. */
  public async settle(conversationId: string, outcome: 'resumed' | 'dismissed'): Promise<void> {
    await this.queue;
    const marker = await this.read(conversationId);
    if (!marker || marker.endedAt) return;
    this.stopBeat(conversationId);
    marker.endedAt = this.stamp();
    marker.outcome = outcome;
    delete marker.waitingSince;
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

  /**
   * Where a run stands, as this editor sees it. Only the same editor's pid is trusted (Pitfall 1): another editor's pid is in another pid namespace,
   * so for its markers the heartbeat decides.
   */
  public runState(marker: RunMarker): RunState {
    if (marker.endedAt) return 'finished';
    if (marker.writer === this.writer) return 'running-here';
    const sameEditor = marker.writer !== undefined && writerEditor(marker.writer) === writerEditor(this.writer);
    if (sameEditor && !this.alive(marker.pid)) return 'cut-off';
    return this.now() - Date.parse(marker.activeAt) < FOREIGN_LIVE_MS ? 'running-elsewhere' : 'cut-off';
  }

  /** Whether the conversation's run (that run, when a runId is given) is live in another window or editor right now. */
  public async liveElsewhere(conversationId: string, runId?: string): Promise<boolean> {
    const marker = await this.read(conversationId);
    return Boolean(marker && (runId === undefined || marker.runId === runId) && this.runState(marker) === 'running-elsewhere');
  }

  /** Every run of this project that is running right now, in this window or another (the state is as this editor sees it). */
  public async liveRuns(): Promise<Array<{ conversationId: string; state: RunState }>> {
    const found: Array<{ conversationId: string; state: RunState }> = [];
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      const marker = await this.read(name.slice(0, -5));
      const state = marker ? this.runState(marker) : undefined;
      if (marker && (state === 'running-here' || state === 'running-elsewhere')) found.push({ conversationId: marker.conversationId, state });
    }
    return found;
  }

  /** The conversation's marker, whatever state its run is in. */
  public markerOf(conversationId: string): Promise<RunMarker | undefined> { return this.read(conversationId); }

  private isInterrupted(marker: RunMarker): boolean {
    return this.runState(marker) === 'cut-off';
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
      // A random suffix: two editors writing one conversation's marker never share a temporary name (Pitfall 3), whatever their pids.
      const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await this.beforeWrite?.();
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
  const writer = typeof raw.writer === 'string' && WRITER.test(raw.writer) ? raw.writer : undefined;
  if ((raw.version !== 1 && raw.version !== 2) || (raw.version === 2 && !writer) || raw.conversationId !== conversationId || typeof raw.runId !== 'string' || !RUN_ID.test(raw.runId) || typeof raw.pid !== 'number' || !time(raw.startedAt) || !time(raw.activeAt)) return undefined;
  const outcomes = new Set(['completed', 'cancelled', 'failed', 'max-turns', 'stuck', 'resumed', 'dismissed']);
  return {
    version: raw.version as 1 | 2,
    conversationId,
    runId: raw.runId,
    pid: raw.pid,
    ...(writer ? { writer } : {}),
    ...(typeof raw.model === 'string' && raw.model ? { model: raw.model.slice(0, 200) } : {}),
    startedAt: raw.startedAt as string,
    activeAt: raw.activeAt as string,
    ...(time(raw.savedAt) ? { savedAt: raw.savedAt as string } : {}),
    steps: Array.isArray(raw.steps) ? raw.steps.filter((step): step is string => typeof step === 'string').map((step) => step.slice(0, 80)).slice(-MAX_STEPS) : [],
    ...(time(raw.waitingSince) ? { waitingSince: raw.waitingSince as string } : {}),
    ...(time(raw.endedAt) ? { endedAt: raw.endedAt as string } : {}),
    ...(typeof raw.outcome === 'string' && outcomes.has(raw.outcome) ? { outcome: raw.outcome as RunEnd } : {})
  };
}

/** The markers written by this editor (any window of it): the only ones that may resume by themselves (D-03). Another editor's cut-off run waits for a click. */
export function ownEditorMarkers<T extends Pick<RunMarker, 'writer'>>(markers: T[], writer: string): T[] {
  const editor = writerEditor(writer);
  return editor ? markers.filter((marker) => writerEditor(marker.writer) === editor) : [];
}

/** PERF-05: a run cut off longer ago than this is left for the person to resume; one this recent carries on by itself after the reload. */
export const AUTO_RESUME_WITHIN_MS = 12 * 60 * 60_000;
/** At most this many cut-off runs resume by themselves at once after a reload (the newest first). */
export const MAX_AUTO_RESUMES = 3;

/** Whether a cut-off run resumes by itself: the setting is on and it was active within AUTO_RESUME_WITHIN_MS. */
export function shouldAutoResume(marker: Pick<RunMarker, 'activeAt'>, enabled: boolean, now = Date.now()): boolean {
  const at = Date.parse(marker.activeAt);
  return enabled && Number.isFinite(at) && now - at <= AUTO_RESUME_WITHIN_MS && now >= at - 60_000;
}

/**
 * Which cut-off runs resume by themselves after a reload: none while the emergency stop is on (in any window; #36 shares it), since a stop means
 * nothing runs until the person resumes; otherwise the recent ones, newest first, at most MAX_AUTO_RESUMES. The rest keep their Resume button.
 */
export function autoResumeChoice<T extends { activeAt: string }>(cutOff: T[], options: { enabled: boolean; emergencyStopped: boolean; now?: number }): T[] {
  if (options.emergencyStopped) return [];
  return cutOff.filter((marker) => shouldAutoResume(marker, options.enabled, options.now)).sort((a, b) => b.activeAt.localeCompare(a.activeAt)).slice(0, MAX_AUTO_RESUMES);
}

/** The notice a conversation shows when its cut-off run resumes by itself. */
export function autoResumeNotice(marker: Pick<RunMarker, 'activeAt'>, now = Date.now()): string {
  return `Resuming automatically: this run was cut off by a reload at ${cutOffTime(marker.activeAt, now)}. It carries on from its last saved step, and steps that had finished are not run again. Press Stop to halt it; turn this off with the setting nearAi.agent.autoResumeAfterReload.`;
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
