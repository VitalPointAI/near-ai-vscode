// The one-time merge of an editor's own per-project storage into the project's state home (D-05, SYNC-02). Each editor kept its conversations under its
// own globalStorage, so two editors on one computer saw different history. This copies what that storage holds for the open project into the state home
// every editor shares, by record id: a record already there is merged with, never replaced by an older copy, and nothing in globalStorage is ever
// written, renamed or removed (the sources stay as they are, so a downgrade still finds them).
//
// It is safe to run any number of times and in any order of editors: a second run finds everything present and writes nothing; editor A then B and B
// then A leave the same state. An item that cannot be read yet (a transcript sealed with a key this editor does not have) is counted as locked and tried
// again the next time the editor starts. No vscode here, so the tests run on plain node.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { ComparisonStore } from '../benchmark/store';
import { parseSavedRun, RUN_ID, serializeRun, type SavedRun } from '../benchmark/results';
import { LIVE_CONVERSATIONS_DEFAULT } from '../domain/state/retention';
import { messagesToEntries } from '../domain/state/threadCapture';
import type { ThreadEntry } from '../domain/state/threadEntries';
import { ActivityStore } from './activityStore';
import type { AuthService } from './auth';
import { ProfileStore } from './profileStore';
import { parseRunMarker, type RunMarker, WRITER } from './runMarkers';
import { mirrorProjectSpend } from './spendMirror';
import { editorWriter, ProjectStateHome, stateHomeFor, writeFileAtomic, writerEditor, type MementoLike } from './stateHome';
import type { SecretsLike } from './stateKeys';
import { applyRetention } from './threadArchive';
import { threadStoreFor, type ImportedThread, type ThreadStore } from './threadStore';
import { projectFolderHash, TranscriptStore, type Transcript } from './transcripts';

/** Where an editor's storage came from and who is migrating it. */
export interface MigrationSources {
  /** The project folder. */
  root: string;
  /** The editor's own `globalStorageUri` folder. Read only. */
  globalStorageDir: string;
  /** The editor's old install-local transcript key, or undefined when it has none. Never created here. */
  oldKey: () => Promise<Buffer | undefined>;
  /** `<editor>.<instance>` of the extension host migrating. */
  writer: string;
  /** The project's credential scope id: the tag its spend carries. */
  projectScopeId: string;
}

export interface MigrationReport {
  threads: {
    /** Conversations new to the state home. */
    copied: number;
    /** Conversations the state home already had some of, now made whole. */
    merged: number;
    /** Conversations that were already complete there. */
    unchanged: number;
    /** Conversations that could not be opened yet (an old key this editor does not hold, or a state home it cannot open); tried again next start. */
    locked: number;
    /** Of the copied and merged ones, those whose earliest messages no longer exist anywhere (they had been summarised before 0.4.20). */
    partial: number;
    /** Files that were empty or not a conversation. */
    skipped: number;
  };
  /** The ids of the conversations counted as locked. */
  lockedIds: string[];
  /** Run markers copied (or replaced by a later one). */
  markers: number;
  /** Checkpoint files copied. */
  checkpoints: number;
  /** Saved model comparisons copied. */
  comparisons: number;
  /** Spend lines added to the project's mirror. */
  spendLines: number;
  /** Threads the 5-live rule moved to the archive at the end of the run. */
  archived: number;
  /** Marker, checkpoint and comparison files that were malformed (or not this project's) and left out. */
  skipped: number;
}

export function emptyReport(): MigrationReport {
  return { threads: { copied: 0, merged: 0, unchanged: 0, locked: 0, partial: 0, skipped: 0 }, lockedIds: [], markers: 0, checkpoints: 0, comparisons: 0, spendLines: 0, archived: 0, skipped: 0 };
}

/** How many things the run changed in the state home. Zero means a rerun found everything already there. */
export function changesIn(report: MigrationReport): number {
  return report.threads.copied + report.threads.merged + report.markers + report.checkpoints + report.comparisons + report.spendLines + report.archived;
}

export interface MigrationOptions {
  /** Called after each item is handled, outside its error handling: a throw here ends the run, as a crash would (tests). */
  afterItem?: (item: { kind: 'thread' | 'marker' | 'checkpoint' | 'comparison'; id: string }) => void | Promise<void>;
  /** How many of the most recently used conversations stay live once everything is merged (nearAi.history.liveConversations). */
  liveConversations?: number;
  /** Conversations that must stay live whatever their rank (open in a tab of this editor). */
  protectedIds?: () => Iterable<string>;
  now?: () => Date;
}

/** What a conversation saved before 0.4.20 says of itself when its earlier messages were summarised. */
export const PARTIAL_BEFORE_0_4_20 = 'partial-before-0.4.20';

const ID = /^conv-[a-z0-9-]{6,60}$/;

/** Reads each saved conversation of the project from the editor's storage and merges it into the state home as a full thread. */
async function migrateTranscripts(sources: MigrationSources, threads: ThreadStore, report: MigrationReport, options: MigrationOptions): Promise<void> {
  let key: Promise<Buffer | undefined> | undefined;
  const oldKey = async (): Promise<Buffer> => {
    key ??= sources.oldKey();
    const found = await key;
    if (!found) throw new Error('This editor has no key for these conversations.');
    return found;
  };
  // Read only: the store never saves and does not re-save a conversation from before encryption.
  const old = new TranscriptStore(sources.globalStorageDir, sources.root, oldKey, true);
  const folder = path.join(sources.globalStorageDir, 'transcripts', projectFolderHash(sources.root));
  const listed = (await old.list().catch(() => [])).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const summary of listed) {
    await migrateOne(summary.id, summary.locked === true);
    await options.afterItem?.({ kind: 'thread', id: summary.id });
  }

  async function migrateOne(id: string, unreadable: boolean): Promise<void> {
    try {
      if (unreadable) {
        // A file sealed with a key this editor does not hold waits for the editor that has it; anything else is not a conversation.
        if (await isSealed(path.join(folder, `${id}.json`))) { report.threads.locked += 1; report.lockedIds.push(id); } else report.threads.skipped += 1;
        return;
      }
      let imported: { thread: ImportedThread } | undefined;
      try {
        const transcript = await old.load(id);
        imported = transcript ? importedThread(transcript, sources.writer) : undefined;
      } catch {
        // A file that opens but holds something that is not a conversation (a message with no text, say) is not a conversation.
        imported = undefined;
      }
      if (!imported) { report.threads.skipped += 1; return; }
      const outcome = await threads.importThread(id, imported.thread);
      report.threads[outcome] += 1;
      if (outcome !== 'unchanged' && imported.thread.meta.history === PARTIAL_BEFORE_0_4_20) report.threads.partial += 1;
    } catch {
      // The state home could not be opened or written on this device right now (locked); the conversation stays where it is and is tried next start.
      report.threads.locked += 1;
      report.lockedIds.push(id);
    }
  }
}

async function isSealed(file: string): Promise<boolean> {
  try {
    return (JSON.parse(await readFile(file, 'utf8')) as { enc?: unknown }).enc === 'aes-256-gcm';
  } catch {
    return false;
  }
}

/**
 * The thread an old conversation becomes: every message the model's saved list holds, as entries chained from the start (the same ids a thread begun
 * in 0.4.20 would give them), all stamped with the conversation's last-saved time. A list that begins with a summary has lost its earliest originals,
 * and the thread says so. Undefined for a conversation with nothing a person typed or saw.
 */
function importedThread(transcript: Transcript, writer: string): { thread: ImportedThread } | undefined {
  if (!ID.test(transcript.id) || !Array.isArray(transcript.messages)) return undefined;
  const time = Date.parse(transcript.updatedAt);
  if (!Number.isFinite(time)) return undefined;
  const at = new Date(time).toISOString();
  const display = new Map<string, string>();
  for (const pair of Array.isArray(transcript.display) ? transcript.display : []) if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') display.set(pair[0], pair[1]);
  const entries: ThreadEntry[] = messagesToEntries(transcript.messages, display, null, { thread: transcript.id, writer, at });
  if (!entries.length) return undefined;
  const partial = transcript.messages.some((message) => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<conversation-summary>'));
  const { basedOnTip: _tip, ...context } = transcript;
  return {
    thread: {
      entries,
      meta: { title: typeof transcript.title === 'string' && transcript.title ? transcript.title : 'Conversation', model: typeof transcript.model === 'string' ? transcript.model : '', origin: 'panel', createdAt: at, lastUsedAt: at, ...(partial ? { history: PARTIAL_BEFORE_0_4_20 } : {}) },
      context: { ...context, updatedAt: at }
    }
  };
}

// ---- run markers ----------------------------------------------------------------------------------------------------------------------

const MARKER_TIME = (marker: RunMarker): number => Date.parse(marker.endedAt ?? marker.activeAt);

/** Whether `candidate` is later than `current`: by last sign of life or end, an ended marker over an open one at the same time, then by text, so the choice never depends on order. */
function markerLater(candidate: RunMarker, current: RunMarker): boolean {
  const a = MARKER_TIME(candidate);
  const b = MARKER_TIME(current);
  if (a !== b) return a > b;
  if (Boolean(candidate.endedAt) !== Boolean(current.endedAt)) return Boolean(candidate.endedAt);
  return JSON.stringify(candidate) > JSON.stringify(current);
}

/**
 * A run marker from 0.4.19 has no writer, so no editor could tell whose run it was: only silence would end it. One still open is stamped as this editor's
 * (`<editor id>.migrated`: an instance no host has), so its process, which is gone, decides at once and this editor can resume it by itself, while another
 * editor sees it as any other editor's run. An ended marker, or one that already has a writer, is left as it is.
 */
function stampedAsMigrated(marker: RunMarker, writer: string): RunMarker {
  const editor = writerEditor(writer);
  const stamp = editor ? `${editor}.migrated` : undefined;
  if (marker.writer || marker.endedAt || !stamp || !WRITER.test(stamp)) return marker;
  return { ...marker, version: 2, writer: stamp };
}

/** Copies the editor's run markers for the project, so a run that was in flight when the editor was upgraded can still be offered for resume. */
async function migrateMarkers(sources: MigrationSources, home: ProjectStateHome, prepare: () => Promise<void>, report: MigrationReport, options: MigrationOptions): Promise<void> {
  const folder = path.join(sources.globalStorageDir, 'runs', projectFolderHash(sources.root));
  for (const name of (await readdir(folder).catch(() => [] as string[])).filter((item) => item.endsWith('.json')).sort()) {
    const id = name.slice(0, -5);
    if (!ID.test(id)) continue;
    try {
      const parsed = parseRunMarker(JSON.parse(await readFile(path.join(folder, name), 'utf8')), id);
      const marker = parsed && stampedAsMigrated(parsed, sources.writer);
      if (!marker) report.skipped += 1;
      else {
        const target = path.join(home.paths.runs, name);
        const existing = await readFile(target, 'utf8').then((content) => parseRunMarker(JSON.parse(content), id), () => undefined);
        if (!existing || markerLater(marker, existing)) {
          await prepare();
          await mkdir(home.paths.runs, { recursive: true, mode: 0o700 });
          await writeFileAtomic(target, `${JSON.stringify(marker)}\n`);
          report.markers += 1;
        }
      }
    } catch {
      report.skipped += 1;
    }
    await options.afterItem?.({ kind: 'marker', id });
  }
}

// ---- checkpoints ----------------------------------------------------------------------------------------------------------------------

type SavedSnapshot = ({ rel: string } | { abs: string; outside: true }) & { original: string | null };

const CHECKPOINT_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{3,80})\.json$/;

function insideRoot(root: string, file: string): string | undefined {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : undefined;
}

/** A relative path from a saved checkpoint, only when it stays inside the project. */
function safeRelative(rel: unknown): string | undefined {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split(/[\\/]/).includes('..')) return undefined;
  return rel;
}

/** The snapshots of a saved checkpoint in either format, as format 2 entries; a malformed item is dropped. */
function snapshotsOf(value: unknown, root: string): SavedSnapshot[] {
  const found: SavedSnapshot[] = [];
  const original = (item: unknown): string | null | undefined => (item === null || typeof item === 'string' ? item : undefined);
  if (Array.isArray(value)) {
    for (const item of value as Array<Record<string, unknown>>) {
      const content = original(item?.original);
      if (!item || typeof item.path !== 'string' || !path.isAbsolute(item.path) || content === undefined) continue;
      const rel = insideRoot(root, item.path);
      found.push(rel ? { rel, original: content } : { abs: item.path, outside: true, original: content });
    }
    return found;
  }
  const saved = value as { format?: unknown; snapshots?: unknown } | null;
  if (!saved || saved.format !== 2 || !Array.isArray(saved.snapshots)) return found;
  for (const item of saved.snapshots as Array<Record<string, unknown>>) {
    const content = original(item?.original);
    if (!item || content === undefined) continue;
    if (item.outside === true && typeof item.abs === 'string' && path.isAbsolute(item.abs)) { found.push({ abs: item.abs, outside: true, original: content }); continue; }
    const rel = safeRelative(item.rel);
    if (rel) found.push({ rel, original: content });
  }
  return found;
}

/**
 * Copies this project's checkpoints. The editor keeps one flat folder for every project, so a run belongs to this project when its id is in the
 * project's activity history or one of its saved files is inside the project. Another project's checkpoints are not copied, and one already in the
 * state home is left as it is (a run id is never reused).
 */
async function migrateCheckpoints(sources: MigrationSources, home: ProjectStateHome, prepare: () => Promise<void>, report: MigrationReport, options: MigrationOptions): Promise<void> {
  const folder = path.join(sources.globalStorageDir, 'checkpoints');
  const names = (await readdir(folder).catch(() => [] as string[])).filter((name) => CHECKPOINT_FILE.test(name)).sort();
  if (!names.length) return;
  const root = path.resolve(sources.root);
  const projectRuns = new Set((await new ActivityStore(root).list().catch(() => [])).flatMap((session) => (session.runId ? [session.runId] : [])));
  for (const name of names) {
    const runId = name.slice(0, -5);
    const target = path.join(home.paths.checkpoints, name);
    if (!(await stat(target).catch(() => undefined))) {
      try {
        const snapshots = snapshotsOf(JSON.parse(await readFile(path.join(folder, name), 'utf8')), root);
        const mine = projectRuns.has(runId) || snapshots.some((snapshot) => 'rel' in snapshot);
        if (mine && snapshots.length) {
          await prepare();
          await mkdir(home.paths.checkpoints, { recursive: true, mode: 0o700 });
          await writeFileAtomic(target, JSON.stringify({ format: 2, snapshots }));
          report.checkpoints += 1;
        } else if (mine) report.skipped += 1;
      } catch {
        report.skipped += 1;
      }
    }
    await options.afterItem?.({ kind: 'checkpoint', id: runId });
  }
}

// ---- comparisons ----------------------------------------------------------------------------------------------------------------------

/** Whether the editor's copy of a comparison should replace the one in the state home: the later finished, then the greater text, so order never matters. */
function runPreferred(candidate: SavedRun, current: SavedRun): boolean {
  const a = candidate.finishedAt ?? candidate.startedAt;
  const b = current.finishedAt ?? current.startedAt;
  if (a !== b) return a > b;
  return serializeRun(candidate) > serializeRun(current);
}

/** Copies the editor's saved model comparisons (they are not per project) into the state home's comparisons folder, so Compare Models shows them in every editor. */
async function migrateComparisons(sources: MigrationSources, home: ProjectStateHome, prepare: () => Promise<void>, report: MigrationReport, options: MigrationOptions): Promise<void> {
  const folder = path.join(sources.globalStorageDir, 'evals');
  const names = (await readdir(folder).catch(() => [] as string[])).filter((name) => name.endsWith('.json') && RUN_ID.test(name.slice(0, -5))).sort();
  if (!names.length) return;
  const destination = new ComparisonStore(home.paths.comparisons, async () => { await prepare(); });
  for (const name of names) {
    const id = name.slice(0, -5);
    try {
      const run = parseSavedRun(await readFile(path.join(folder, name), 'utf8'));
      if (!run || run.id !== id) report.skipped += 1;
      else {
        const existing = await destination.load(id);
        if (!existing || (runPreferred(run, existing) && serializeRun(run) !== serializeRun(existing))) { await destination.save(run); report.comparisons += 1; }
      }
    } catch {
      report.skipped += 1;
    }
    await options.afterItem?.({ kind: 'comparison', id });
  }
}

// ---- the run -------------------------------------------------------------------------------------------------------------------------

/**
 * Merges this editor's storage for the project into the state home. Reads `sources.globalStorageDir` and writes only below the state home.
 * An editor with no storage for the project (or none at all) changes nothing and creates nothing. Team Mode, cyber, the runtime and the emergency
 * stop in that storage are not part of a project's state and are not looked at.
 */
export async function migrateEditorStorage(sources: MigrationSources, home: ProjectStateHome, threads: ThreadStore, options: MigrationOptions = {}): Promise<MigrationReport> {
  const report = emptyReport();
  let prepared: Promise<unknown> | undefined;
  const prepare = async (): Promise<void> => { prepared ??= home.ensure(); await prepared; };
  await migrateTranscripts(sources, threads, report, options);
  await migrateMarkers(sources, home, prepare, report, options);
  await migrateCheckpoints(sources, home, prepare, report, options);
  await migrateComparisons(sources, home, prepare, report, options);
  report.spendLines = await mirrorProjectSpend({ ledgerRoot: path.join(sources.globalStorageDir, 'spend'), projectScopeId: sources.projectScopeId, home }).catch(() => 0);

  // The 5-live rule over everything now merged: the older conversations are archived, never deleted.
  try {
    const result = await applyRetention(threads, options.liveConversations ?? LIVE_CONVERSATIONS_DEFAULT, options.protectedIds?.() ?? []);
    report.archived = result.archived.length;
  } catch { /* a conversation that could not be archived stays live; the next run tries again */ }

  // Recorded only as a hint of when this editor's storage was last merged; nothing depends on it, so losing it costs nothing.
  if (changesIn(report) > 0 && report.threads.locked === 0 && await home.exists()) {
    const key = createHash('sha256').update(path.resolve(sources.globalStorageDir)).digest('hex').slice(0, 12);
    const meta = await home.readMeta().catch(() => undefined);
    if (meta && !(meta.migrated && key in meta.migrated)) await home.updateMeta({ migrated: { ...(meta.migrated ?? {}), [key]: (options.now?.() ?? new Date()).toISOString() } }).catch(() => undefined);
  }
  return report;
}

// ---- when it runs ---------------------------------------------------------------------------------------------------------------------

/** What the migration needs of the extension context (the parts of vscode.ExtensionContext it uses), so it runs on plain node in tests. */
export interface MigrationContext {
  globalStorageUri: { fsPath: string };
  secrets: SecretsLike;
  globalState: MementoLike;
}

export interface MigrationExtras {
  /** nearAi.sync.keepKeyInProject. */
  keepKeyInProject?: () => boolean;
  /** nearAi.history.liveConversations, read when the run reaches the 5-live step. */
  liveConversations?: () => number;
  /** Conversations open in a tab of this editor, so the 5-live step leaves them live. */
  protectedIds?: () => Iterable<string>;
  /** Where the counts are written. Only counts go here: never a title, an id or any text. */
  log?: (line: string) => void;
  /** The clock the retry back-off reads (tests). */
  now?: () => number;
}

/** After a merge fails, the next try waits this long, doubling with each failure in a row up to MIGRATION_RETRY_MAX_MS. */
export const MIGRATION_RETRY_FIRST_MS = 60_000;
export const MIGRATION_RETRY_MAX_MS = 1_800_000;
const retryDelay = (failures: number): number => Math.min(MIGRATION_RETRY_MAX_MS, MIGRATION_RETRY_FIRST_MS * 2 ** Math.max(0, failures - 1));

interface Host { context: MigrationContext; auth?: AuthService; extras: MigrationExtras }

let host: Host | undefined;
const runs = new Map<string, Promise<MigrationReport | undefined>>();
/** Per project: when the merge last failed and how many times in a row, so a stuck merge is not started before every message. */
const failed = new Map<string, { at: number; count: number }>();

/** Gives the migration this editor's storage, secrets and writer. Called once at activation; it reads and writes nothing. */
export function configureMigration(context: MigrationContext, auth?: AuthService, extras: MigrationExtras = {}): void {
  host = { context, ...(auth ? { auth } : {}), extras };
  runs.clear();
  failed.clear();
}

/** The editor's old install-local transcript key, read without creating one: an editor that never had one has nothing sealed with it. */
function oldKeyFrom(secrets: SecretsLike): () => Promise<Buffer | undefined> {
  return async () => {
    const stored = await secrets.get('nearAi.transcripts.key');
    const key = stored ? Buffer.from(stored, 'base64') : undefined;
    return key && key.length === 32 ? key : undefined;
  };
}

function countsLine(report: MigrationReport): string {
  const { threads } = report;
  return `State merge: conversations ${threads.copied} copied, ${threads.merged} merged, ${threads.unchanged} already there, ${threads.locked} locked, ${threads.skipped + report.skipped} skipped; run markers ${report.markers}; checkpoints ${report.checkpoints}; comparisons ${report.comparisons}; spend lines ${report.spendLines}; archived ${report.archived}.`;
}

/**
 * Merges this editor's own storage for the project into the state home, once per project in this extension host. The first call starts it and every
 * later call gets the same result, so a chat, the history and Compare Models can each ask without repeating the work. Never rejects: a run that fails
 * is forgotten and tried again after a back-off (a minute, doubling to half an hour), with one log line per failure; asks in between get undefined at
 * once. What could not be opened yet (locked) is tried again at the next start. Without configureMigration
 * (a test, or a host with nothing to migrate) it does nothing.
 */
export function ensureMigrated(root: string): Promise<MigrationReport | undefined> {
  if (!host) return Promise.resolve(undefined);
  const key = path.resolve(root);
  const existing = runs.get(key);
  if (existing) return existing;
  const { context, auth, extras } = host;
  const now = extras.now ?? Date.now;
  const lastFailure = failed.get(key);
  if (lastFailure && now() < lastFailure.at + retryDelay(lastFailure.count)) return Promise.resolve(undefined);
  const run = (async (): Promise<MigrationReport | undefined> => {
    // Yields once, so a failure that happens at once still forgets the run after it was remembered below, never before.
    await Promise.resolve();
    try {
      const sources: MigrationSources = {
        root: key,
        globalStorageDir: context.globalStorageUri.fsPath,
        oldKey: oldKeyFrom(context.secrets),
        writer: editorWriter(context.globalState),
        projectScopeId: (auth ? new ProfileStore(key, auth) : new ProfileStore(key)).projectScopeId
      };
      const threads = threadStoreFor(key, context.secrets, sources.writer, extras.keepKeyInProject);
      const report = await migrateEditorStorage(sources, stateHomeFor(key), threads, {
        ...(extras.liveConversations ? { liveConversations: extras.liveConversations() } : {}),
        ...(extras.protectedIds ? { protectedIds: extras.protectedIds } : {})
      });
      if (changesIn(report) > 0 || report.threads.locked > 0) extras.log?.(countsLine(report));
      failed.delete(key);
      return report;
    } catch {
      const count = (failed.get(key)?.count ?? 0) + 1;
      failed.set(key, { at: now(), count });
      const minutes = Math.ceil(retryDelay(count) / 60_000);
      extras.log?.(`State merge did not finish; it will be tried again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
      runs.delete(key);
      return undefined;
    }
  })();
  runs.set(key, run);
  return run;
}
