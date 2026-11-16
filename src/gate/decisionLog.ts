// The gate's decision log on disk (GATE-07, D-21): one JSON line per record in <globalStorage>/gate/decisions/<project key>.jsonl. The project key is a
// hash, so no path appears in a file name, and nothing is ever written into the workspace, the transcripts or the synced project state. Node I/O only:
// this module never imports vscode.
//
// Writing a record never blocks or fails a decision (D-21): append never throws or rejects, a failure is reported once through onWriteFailure with a plain
// message, and the caller does not need to wait for the returned promise. Appends keep their order (one chain in this process, and one file lock across
// processes), metadata.sequence strictly increases per log, and a full file is renamed whole to <key>.1.jsonl (older ones shift up, at most
// MAX_ROTATED_FILES kept) before the next line, so no record is lost or reordered inside what is kept.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { redactRecord, validateDecisionRecord } from '../domain/gate/record';
import type { DecisionRecord } from '../domain/gate/record';
import { withFileLock } from '../services/stateMirrorLock';
import { GATE_DIR_NAME } from './bundleStore';

export const DECISIONS_DIR = 'decisions';
export const MAX_DECISION_LOG_BYTES = 5 * 1024 * 1024;
export const MAX_ROTATED_FILES = 4;
/** One record is a name, a path, a rule id and a sentence, never contents; a line larger than this is not written. */
const MAX_RECORD_BYTES = 64 * 1024;
const PROJECT_KEY_PATTERN = /^[0-9a-f]{32}$/;
const WRITE_FAILED = 'NEAR AI could not save its record of what was allowed or refused, so records for this project are not being kept. Your work is not affected.';

/** The first 32 hex characters of the SHA-256 of the normalised project root, so a file name never carries a path. */
export function projectLogKey(root: string): string {
  const normal = path.resolve(root).split(path.sep).join('/');
  return createHash('sha256').update(normal).digest('hex').slice(0, 32);
}

/**
 * The key of the install-level log, <globalStorage>/gate/decisions/<this key>.jsonl: the policy's own events (policy.created, renewed, reset, load and a
 * failed start), which belong to this install and not to any one project, so they are kept even when no folder is open. It is a fixed hash of a fixed word, so
 * it never equals a project key (those are hashes of a folder path) and no path appears in the file name.
 */
export const INSTALL_LOG_KEY = createHash('sha256').update('near-ai-install-policy-log').digest('hex').slice(0, 32);

export interface DecisionLogOptions {
  readonly globalStorageDir: string;
  /** From projectLogKey. */
  readonly projectKey: string;
  /** Called at most once per log, with a plain message, when a record could not be written. */
  readonly onWriteFailure: (message: string) => void;
  /** Rotation size; tests lower it. */
  readonly maxBytes?: number;
  /** When given, the constructor refuses a global storage folder that lies inside it (GATE-07: nothing is written into the workspace). */
  readonly projectRoot?: string;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function inside(folder: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(folder));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// The sequence of the last line of a file that parses, or undefined when there is none. Reads only the end of the file: a line is never longer than
// MAX_RECORD_BYTES, so the last whole line is always inside what is read.
async function lastSequenceOf(file: string): Promise<number | undefined> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return undefined;
    const length = Math.min(size, MAX_RECORD_BYTES + 2);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index] as string;
      if (line === '') continue;
      try {
        const value = JSON.parse(line) as { metadata?: { sequence?: unknown } };
        const sequence = value.metadata?.sequence;
        if (typeof sequence === 'number' && Number.isSafeInteger(sequence)) return sequence;
      } catch {
        // A torn or foreign line: look at the one before it.
      }
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

export class DecisionLog {
  private readonly dir: string;
  private readonly key: string;
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly onWriteFailure: (message: string) => void;
  private tail: Promise<void> = Promise.resolve();
  private reported = false;
  // What this process last saw of the file, so another window's appends are noticed by a size that does not match.
  private knownSize: number | undefined;
  private lastSequence = 0;

  public constructor(options: DecisionLogOptions) {
    if (!PROJECT_KEY_PATTERN.test(options.projectKey)) throw new Error('The decision log needs a project key made by projectLogKey.');
    if (options.projectRoot !== undefined && inside(options.globalStorageDir, options.projectRoot)) {
      throw new Error('The decision log folder must be outside the project, so records never land in the workspace.');
    }
    this.key = options.projectKey;
    this.dir = path.join(options.globalStorageDir, GATE_DIR_NAME, DECISIONS_DIR);
    this.file = path.join(this.dir, `${this.key}.jsonl`);
    this.maxBytes = options.maxBytes ?? MAX_DECISION_LOG_BYTES;
    this.onWriteFailure = options.onWriteFailure;
  }

  /**
   * Validates, redacts and appends one line, creating the folder on first use, and sets metadata.sequence (1, 2, 3, then on from the file's last line).
   * The returned promise never rejects, so a caller may ignore it: a decision does not wait for its record.
   */
  public append(record: DecisionRecord): Promise<void> {
    const run = this.tail.then(() => this.write(record)).catch((error: unknown) => { this.fail(error); });
    this.tail = run;
    return run;
  }

  /** Resolves when every record appended so far has been written or has failed. */
  public flush(): Promise<void> {
    return this.tail;
  }

  private fail(error: unknown): void {
    // A line that was half written, or a file that changed under us, is read again the next time.
    this.knownSize = undefined;
    if (this.reported) return;
    this.reported = true;
    try {
      this.onWriteFailure(error instanceof RecordRefused ? error.message : WRITE_FAILED);
    } catch {
      // The report itself must never become a failure of the decision.
    }
  }

  private async write(record: DecisionRecord): Promise<void> {
    const clean = redactRecord(record);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await withFileLock(this.dir, `${this.key}.lock`, async () => {
      let size = 0;
      try {
        size = (await stat(this.file)).size;
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
      if (this.knownSize !== size) {
        // First use in this process, or another window wrote: the last line says where the numbering is.
        this.lastSequence = (await lastSequenceOf(this.file)) ?? (await lastSequenceOf(this.rotated(1))) ?? 0;
      }
      const sequence = this.lastSequence + 1;
      // The record that is checked is exactly the record that is stored: the real sequence goes in first, then the check, then the line is made from it.
      const stored: DecisionRecord = { ...clean, metadata: { ...clean.metadata, sequence } };
      const checked = validateDecisionRecord(stored);
      if (!checked.ok) throw new RecordRefused('A decision record was not valid, so it was not saved. Your work is not affected.');
      const line = `${JSON.stringify(checked.value)}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      if (bytes > MAX_RECORD_BYTES) throw new RecordRefused('A decision record was larger than the allowed size, so it was not saved. Your work is not affected.');
      if (size > 0 && size + bytes > this.maxBytes) {
        await this.rotate();
        size = 0;
      }
      await appendFile(this.file, line, { encoding: 'utf8', mode: 0o600 });
      this.knownSize = size + bytes;
      this.lastSequence = sequence;
    });
  }

  private rotated(number: number): string {
    return path.join(this.dir, `${this.key}.${number}.jsonl`);
  }

  // The whole full file becomes <key>.1.jsonl; older ones move up one number and the one past MAX_ROTATED_FILES is the only record set that goes.
  private async rotate(): Promise<void> {
    await rm(this.rotated(MAX_ROTATED_FILES), { force: true });
    for (let number = MAX_ROTATED_FILES - 1; number >= 1; number -= 1) {
      try {
        await rename(this.rotated(number), this.rotated(number + 1));
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
    await rename(this.file, this.rotated(1));
  }
}

// A refusal whose message is already plain and safe to show.
class RecordRefused extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RecordRefused';
  }
}
