// The local key history on disk (D-09, TMR-05): <identityDir>/key-history.json, holding public keys and signatures only. The head (seq and hash of the
// last record) lives in SecretStorage under KEY_HISTORY_HEAD_SECRET, where an edit to the file cannot reach it, so a history cut short is noticed.
// This module never imports vscode: SecretStorage is reached through the type-only SecretStorageLike interface.
//
// Appends take key-history.lock in the identity folder through the shared file lock. Read, check, write the file and then the head all happen inside
// the lock, so two windows never lose or interleave a record, and an append that no longer fits the state (for example rotating a key that another
// window already rotated) is refused. Lock order wherever both are taken: identity-create.lock first, then key-history.lock.
//
// A history that is broken, or whose active key is not the person's stored key, is never repaired or deleted: archiveKeyHistory renames it beside the
// original and clears the saved end, so a fresh history can start. Archiving fails closed: a key that only the archived history knew reads as unknown
// afterwards (never active), so nothing that depended on it is trusted by mistake. A history that existed before a call is never deleted; the only file
// this module removes is the first-record file of an append whose own head store failed.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretStorageLike } from '../services/auth';
import { keyHistoryWarningSink } from '../domain/keyHistoryWarnings';
import { withFileLock } from '../services/stateMirrorLock';
import { replayKeyHistory, keyRecordHash, MAX_KEY_RECORDS } from '../domain/team/keyRecords';
import type { KeyHistoryFile, KeyHistoryHead, KeyHistoryReplay, KeyRecord, KeyRecordKind } from '../domain/team/keyRecords';
import { NO_KNOWN_KEYS } from '../domain/team/keyStatus';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { PayloadError, signPayload } from '../domain/team/signedPayload';
import type { PayloadSigner, SignedPayload } from '../domain/team/signedPayload';
import type { DeviceRef } from '../domain/team/types';
import { writeFileAtomic } from './teamFile';

export const KEY_HISTORY_FILE = 'key-history.json';
export const KEY_HISTORY_LOCK_FILE = 'key-history.lock';
export const KEY_HISTORY_HEAD_SECRET = 'nearAi.identity.keyHistoryHead';
export const MAX_KEY_HISTORY_BYTES = 1024 * 1024;

export class KeyHistoryError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KeyHistoryError';
  }
}

interface Loaded { text: string | undefined; file: unknown; head: KeyHistoryHead | undefined }
type LoadResult = { ok: true; loaded: Loaded } | { ok: false; reason: string };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function parseHead(text: string): KeyHistoryHead | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || typeof record.seq !== 'number' || typeof record.hash !== 'string') return undefined;
    return { seq: record.seq, hash: record.hash };
  } catch {
    return undefined;
  }
}

// Reads the file and the saved head. A missing file is an empty history; anything else that goes wrong is a plain reason, never a guess.
async function load(identityDir: string, secrets: SecretStorageLike): Promise<LoadResult> {
  const file = path.join(identityDir, KEY_HISTORY_FILE);
  let text: string | undefined;
  try {
    const size = (await stat(file)).size;
    if (size > MAX_KEY_HISTORY_BYTES) return { ok: false, reason: 'The key history file is larger than this version reads, so it is not trusted.' };
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return { ok: false, reason: 'The key history file could not be read, so it is not trusted.' };
  }
  if (text !== undefined && Buffer.byteLength(text, 'utf8') > MAX_KEY_HISTORY_BYTES) {
    return { ok: false, reason: 'The key history file is larger than this version reads, so it is not trusted.' };
  }
  let parsed: unknown = { version: 1, records: [] };
  if (text !== undefined) {
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'The key history file is not valid, so it is not trusted.' };
    }
  }
  let headText: string | undefined;
  try {
    headText = await secrets.get(KEY_HISTORY_HEAD_SECRET);
  } catch {
    return { ok: false, reason: 'The saved end of the key history could not be read, so the history is not trusted.' };
  }
  let head: KeyHistoryHead | undefined;
  if (headText !== undefined && headText !== '') {
    head = parseHead(headText);
    if (head === undefined) return { ok: false, reason: 'The saved end of the key history is not valid, so the history is not trusted.' };
  }
  return { ok: true, loaded: { text, file: parsed, head } };
}

function refusal(reason: string): KeyHistoryReplay {
  return { ok: false, reason, lookup: NO_KNOWN_KEYS };
}

export async function readKeyHistory(identityDir: string, secrets: SecretStorageLike): Promise<KeyHistoryReplay> {
  const result = await load(identityDir, secrets);
  if (!result.ok) return refusal(result.reason);
  return replayKeyHistory(result.loaded.file, result.loaded.head);
}

/** Compares a captured head with the exact prefix of the one current protected replay. The caller holds KEY_HISTORY_LOCK_FILE. */
export async function readKeyHistoryPrefix(identityDir: string, secrets: SecretStorageLike, head: KeyHistoryHead) {
  if (!Number.isSafeInteger(head.seq) || head.seq < 1) return undefined;
  const result = await load(identityDir, secrets);
  if (!result.ok) return undefined;
  const current = replayKeyHistory(result.loaded.file, result.loaded.head);
  if (!current.ok || current.head === undefined || head.seq > current.head.seq) return undefined;
  if (head.seq === current.head.seq) return head.hash === current.head.hash ? { current, captured: current } : undefined;
  // The full replay authenticated every record in this parsed file. Replaying the prefix compares its exact final hash
  // to the captured head and recovers the original signer dispositions without trusting a second disk read.
  const file = result.loaded.file as KeyHistoryFile;
  const captured = replayKeyHistory({ version: file.version, records: file.records.slice(0, head.seq) }, head);
  return captured.ok ? { current, captured } : undefined;
}

// The status source for a solo payload: keys this person's own history knows, and unknown for everything else (also when the history is broken).
export async function localKeyStatus(identityDir: string, secrets: SecretStorageLike): Promise<KeyStatusLookup> {
  return (await readKeyHistory(identityDir, secrets)).lookup;
}

/**
 * Where a key-history warning goes when the caller passed no `warn` of its own (0.4.26, PR #62 review: only Enable passed one, so a warning raised while
 * rotating, revoking or at any other first need went nowhere). Team Mode installs its output channel when it registers (src/domain/keyHistoryWarnings.ts,
 * which keeps the sinks), so every path that writes the history reaches the person, including ones added later. Never given key material.
 */
export { setKeyHistoryWarningSink } from '../domain/keyHistoryWarnings';

export interface AppendKeyRecordOptions {
  now?: () => Date;
  /** Where a plain warning goes (the Team Mode output channel). Never given key material. */
  warn?: (message: string) => void;
}
export interface KeyChange { kind: KeyRecordKind; key: DeviceRef; next?: DeviceRef }

// Adds one record. The signer signs it (created and rotated: the key itself or the active key; revoked: the key withdrawn or the active key). Returns the
// replay of the new history. Throws KeyHistoryError with a plain message when the history is broken or the change does not fit the current state, and
// nothing is written then.
export async function appendKeyRecord(
  identityDir: string, secrets: SecretStorageLike, signer: PayloadSigner, change: KeyChange, options: AppendKeyRecordOptions = {}
): Promise<KeyHistoryReplay> {
  await mkdir(identityDir, { recursive: true, mode: 0o700 });
  return withFileLock(identityDir, KEY_HISTORY_LOCK_FILE, async () => {
    const result = await load(identityDir, secrets);
    if (!result.ok) throw new KeyHistoryError(`Nothing was added to the key history: ${result.reason}`);
    const { loaded } = result;
    const current = replayKeyHistory(loaded.file, loaded.head);
    if (!current.ok) throw new KeyHistoryError(`Nothing was added to the key history: ${current.reason}`);
    const records = (loaded.file as KeyHistoryFile).records;
    if (records.length >= MAX_KEY_RECORDS) throw new KeyHistoryError('Nothing was added to the key history: it already holds the most records this version reads.');
    const last = records[records.length - 1];
    const at = (options.now ?? (() => new Date()))();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new KeyHistoryError('Nothing was added to the key history: the clock gave no valid time.');
    const payload: KeyRecord = { seq: records.length + 1, prev: last === undefined ? '' : keyRecordHash(last), kind: change.kind, key: { fingerprint: change.key.fingerprint, publicKey: change.key.publicKey }, at: at.toISOString() };
    if (change.next !== undefined) payload.next = { fingerprint: change.next.fingerprint, publicKey: change.next.publicKey };
    let signed: SignedPayload<KeyRecord>;
    try {
      signed = signPayload(signer, 'key-record', payload, { now: () => at });
    } catch (error) {
      if (error instanceof PayloadError) throw new KeyHistoryError(error.message, { cause: error });
      throw error;
    }
    const next: KeyHistoryFile = { version: 1, records: [...records, signed] };
    const head: KeyHistoryHead = { seq: signed.payload.seq, hash: keyRecordHash(signed) };
    // The new history must replay by itself before anything is written, so a change that does not fit leaves the files as they were.
    const proof = replayKeyHistory(next, head);
    if (!proof.ok) throw new KeyHistoryError(`Nothing was added to the key history: ${proof.reason}`);
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_KEY_HISTORY_BYTES) throw new KeyHistoryError('Nothing was added to the key history: it would be larger than this version reads.');
    const file = path.join(identityDir, KEY_HISTORY_FILE);
    await writeFileAtomic(file, text);
    try {
      await secrets.store(KEY_HISTORY_HEAD_SECRET, JSON.stringify(head));
    } catch (error) {
      // The head did not follow the file, so the file goes back to what it was; otherwise the history would read as changed from outside.
      // 0.4.25 (PR #61 review): when that fails too, the history reads as changed and the next first need archives it, so it is reported, with the
      // error code only (no path, no key material), instead of being swallowed.
      try {
        if (loaded.text === undefined) await rm(file, { force: true });
        else await writeFileAtomic(file, loaded.text);
      } catch (restoreError) {
        const code = errorCode(restoreError);
        (options.warn ?? keyHistoryWarningSink())?.(`The key history could not be put back after its saved end failed to store${code === undefined ? '' : ` (${code})`}. It will read as changed, and the next time your identity key is needed the history is archived and a new one starts.`);
      }
      throw new KeyHistoryError('Nothing was added to the key history: its saved end could not be stored.', { cause: error });
    }
    return proof;
  });
}

const MAX_ARCHIVE_NAME_ATTEMPTS = 8;

function archiveName(at: Date): string {
  const compact = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `key-history.archived-${compact}-${randomBytes(3).toString('hex')}.json`;
}

// Moves an unusable history aside (D-09): the file is renamed to key-history.archived-<UTC time>-<6 hex>.json in the same folder and the saved end is
// cleared, so the next append starts a fresh history. Returns the archived path, or undefined when there was no file (a lone saved end is still cleared).
// Rename only: the bytes are kept as they were and an existing archive is never overwritten. Keys only the archived history knew read as unknown from
// then on, which is the fail-closed outcome.
export async function archiveKeyHistory(
  identityDir: string, secrets: SecretStorageLike, options: { now?: () => Date } = {}
): Promise<string | undefined> {
  await mkdir(identityDir, { recursive: true, mode: 0o700 });
  return withFileLock(identityDir, KEY_HISTORY_LOCK_FILE, async () => {
    const file = path.join(identityDir, KEY_HISTORY_FILE);
    let archived: string | undefined;
    let exists = true;
    try {
      await stat(file);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw new KeyHistoryError('The key history could not be moved aside, so nothing was changed.', { cause: error });
      exists = false;
    }
    if (exists) {
      const at = (options.now ?? (() => new Date()))();
      const stamp = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
      for (let attempt = 0; archived === undefined; attempt += 1) {
        if (attempt >= MAX_ARCHIVE_NAME_ATTEMPTS) throw new KeyHistoryError('The key history could not be moved aside, so nothing was changed.');
        const target = path.join(identityDir, archiveName(stamp));
        try {
          await stat(target);
        } catch (error) {
          if (errorCode(error) === 'ENOENT') archived = target;
          else throw new KeyHistoryError('The key history could not be moved aside, so nothing was changed.', { cause: error });
        }
      }
      try {
        await rename(file, archived);
      } catch (error) {
        throw new KeyHistoryError('The key history could not be moved aside, so nothing was changed.', { cause: error });
      }
    }
    await secrets.delete(KEY_HISTORY_HEAD_SECRET);
    return archived;
  });
}
