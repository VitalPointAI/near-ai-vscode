// The one-time merge of an editor's own per-project storage into the project's state home (D-05, SYNC-02). Each editor kept its conversations under its
// own globalStorage, so two editors on one computer saw different history. This copies what that storage holds for the open project into the state home
// every editor shares, by record id: a record already there is merged with, never replaced by an older copy, and nothing in globalStorage is ever
// written, renamed or removed (the sources stay as they are, so a downgrade still finds them).
//
// It is safe to run any number of times and in any order of editors: a second run finds everything present and writes nothing; editor A then B and B
// then A leave the same state. An item that cannot be read yet (a transcript sealed with a key this editor does not have) is counted as locked and tried
// again the next time the editor starts. No vscode here, so the tests run on plain node.
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { messagesToEntries } from '../domain/state/threadCapture';
import type { ThreadEntry } from '../domain/state/threadEntries';
import { ProjectStateHome } from './stateHome';
import type { ImportedThread, ThreadStore } from './threadStore';
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
}

export function emptyReport(): MigrationReport {
  return { threads: { copied: 0, merged: 0, unchanged: 0, locked: 0, partial: 0, skipped: 0 }, lockedIds: [] };
}

/** How many things the run changed in the state home. Zero means a rerun found everything already there. */
export function changesIn(report: MigrationReport): number {
  return report.threads.copied + report.threads.merged;
}

export interface MigrationOptions {
  /** Called after each item is handled, outside its error handling: a throw here ends the run, as a crash would (tests). */
  afterItem?: (item: { kind: 'thread'; id: string }) => void | Promise<void>;
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
      const transcript = await old.load(id);
      const imported = transcript ? importedThread(transcript, sources.writer) : undefined;
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

/**
 * Merges this editor's storage for the project into the state home. Reads `sources.globalStorageDir` and writes only below the state home.
 * An editor with no storage for the project (or none at all) changes nothing and creates nothing.
 */
export async function migrateEditorStorage(sources: MigrationSources, _home: ProjectStateHome, threads: ThreadStore, options: MigrationOptions = {}): Promise<MigrationReport> {
  const report = emptyReport();
  await migrateTranscripts(sources, threads, report, options);
  return report;
}
