// Copied from relay/src/store/sqliteStore.ts and adapted for the hub (D-26, D-28).
import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { Database } from 'node:sqlite';
import {
  HASH_PATTERN,
  HEADER_MAX_BYTES,
  INLINE_BODY_MAX_BYTES,
  SEALED_OVERHEAD,
  STREAM_ID_PATTERN,
  entryHash,
  parseHeaderShape,
  sha256Hex,
} from '@ext/domain/replica/entry';
import { canonicalize } from '@ext/domain/team/canonical';
import { migrate, StoreError, STORE_REFUSALS, type StoreRefusal } from './schema';

export { StoreError, STORE_REFUSALS, type StoreRefusal };

// The hub's store (D-26, D-44; DESIGN 10.3): one node:sqlite database, hub.db, in the hub's state directory, and a content-addressed blob folder
// beside it. The only hub module that holds SQL. It knows no keys and checks no signatures: it checks shapes, places and hashes, so it is the last
// line against a malformed row whatever the append path above it missed.
//
// Commit discipline (D-26, the relay's D-06): every write runs in BEGIN IMMEDIATE ... COMMIT and a method that writes returns only after COMMIT
// returned, so a caller that acknowledges on return never acknowledges something a restart could lose. synchronous = FULL is set on the
// connection. Only parameter binding is used; no SQL text is built from a value. Times are numbers of milliseconds the caller passes in: the store
// reads no clock.

type Statement = ReturnType<Database['prepare']>;
type Row = Record<string, unknown>;

const BUSY_TIMEOUT_MS = 5000;
const DATABASE_FILE = 'hub.db';
const BLOB_FOLDER = 'blobs';
/** The largest sealed body an entry carries inline: the inline plaintext limit plus what sealing adds (D-04). */
export const BODY_MAX_BYTES = INLINE_BODY_MAX_BYTES + SEALED_OVERHEAD;
/** The pinned anchor of a project is a small canonical record (the lead and the lead's device), well under this. */
const ANCHOR_MAX_BYTES = 64 * 1024;
const ENROLMENT_ID = /^enr-[0-9a-f]{16}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** One entry as the append path hands it over: the header as canonical JSON text and the sealed body as base64url, as received. */
export interface EntryRow {
  header: string;
  body: string;
  receivedAt: number;
}

/** One kept entry. stream, writer, seq and hash are read from the header when it was stored; header and body are exactly what was stored. */
export interface StoredEntry {
  stream: string;
  writer: string;
  seq: number;
  hash: string;
  header: string;
  body: string;
  bodySize: number;
  receivedAt: number;
}

export interface EntryPage {
  entries: StoredEntry[];
  /** True when the log holds more entries after the last one given. */
  more: boolean;
}

export interface PageLimits {
  limit: number;
  /** Header plus body characters. The first entry is always given, so a page never stalls on one entry larger than this. */
  maxBytes: number;
}

export interface Head {
  seq: number;
  hash: string;
}

export interface StreamHeads {
  stream: string;
  heads: Array<{ writer: string; seq: number; hash: string }>;
}

export interface ProjectRecord {
  project: string;
  genesisHash: string;
  /** The project's pinned anchor as the enrolment gave it (canonical JSON text). */
  anchor: string;
  enrolment: string;
  createdAt: number;
}

export interface Durability {
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
}

function invalid(what: string): StoreError {
  return new StoreError('invalid-record', `The record was not stored: ${what}.`);
}

function checkProject(value: unknown): string {
  if (typeof value !== 'string' || !STREAM_ID_PATTERN.test(value)) throw invalid('a project id must be 32 lowercase hex characters');
  return value;
}

function checkHash(field: string, value: unknown): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw invalid(`${field} must be 64 lowercase hex characters`);
  return value;
}

function checkTime(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid(`${field} must be a whole number of milliseconds`);
  return value;
}

function checkSeq(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid(`${field} must be a whole number from 0`);
  return value;
}

function checkText(field: string, value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${field} must be a non-empty text`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw invalid(`${field} is too large`);
  return value;
}

/** Decodes strict base64url (no padding, re-encodes to the same text) or returns undefined. */
function strictBase64url(value: string): Buffer | undefined {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return undefined;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : undefined;
}

/** Canonical JSON text of a record: the text must be exactly how canonicalize writes the value it parses to. */
function checkCanonical(field: string, value: unknown, maxBytes: number): string {
  const text = checkText(field, value, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw invalid(`${field} is not JSON text`);
  }
  let again: string;
  try {
    again = canonicalize(parsed);
  } catch {
    throw invalid(`${field} is not a canonical record`);
  }
  if (again !== text) throw invalid(`${field} is not canonical JSON text`);
  return text;
}

type CheckedEntry = StoredEntry;

/** Every check a row passes before any SQL: header shape and canonical text, body encoding, size and hash, received time. */
function checkEntryRow(row: unknown): CheckedEntry {
  if (typeof row !== 'object' || row === null) throw invalid('an entry row must be a record');
  const { header, body, receivedAt } = row as Partial<EntryRow>;
  if (typeof header !== 'string' || header.length === 0 || Buffer.byteLength(header, 'utf8') > HEADER_MAX_BYTES) {
    throw invalid('the entry header must be a text of at most 4096 bytes');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(header) as unknown;
  } catch {
    throw invalid('the entry header is not JSON text');
  }
  const shape = parseHeaderShape(parsed);
  if (!shape.ok) throw invalid('the entry header does not have the entry header shape');
  if (canonicalize(shape.header) !== header) throw invalid('the entry header is not canonical JSON text');
  if (typeof body !== 'string') throw invalid('the entry body must be base64url text');
  const bytes = strictBase64url(body);
  if (bytes === undefined) throw invalid('the entry body must be base64url text');
  if (bytes.length > BODY_MAX_BYTES) throw invalid('the entry body is larger than an inline body may be');
  if (bytes.length !== shape.header.body.size || sha256Hex(bytes) !== shape.header.body.hash) {
    throw invalid('the entry body does not match the size and hash its header names');
  }
  checkTime('the received time', receivedAt);
  const { stream, writer, seq } = shape.header;
  return { stream, writer, seq, hash: entryHash(shape.header), header, body, bodySize: bytes.length, receivedAt: receivedAt as number };
}

function toEntry(row: Row): StoredEntry {
  return {
    stream: row.stream as string,
    writer: row.writer as string,
    seq: Number(row.seq),
    hash: row.hash as string,
    header: row.header as string,
    body: row.body as string,
    bodySize: Number(row.body_size),
    receivedAt: Number(row.received_at),
  };
}

function toProject(row: Row): ProjectRecord {
  return {
    project: row.project as string,
    genesisHash: row.genesis_hash as string,
    anchor: row.anchor as string,
    enrolment: row.enrolment as string,
    createdAt: Number(row.created_at),
  };
}

/** Refuses a symbolic link or anything that is not a real folder where a hub folder should be, and creates a missing one 0700. */
function ensurePrivateFolder(folder: string): void {
  try {
    mkdirSync(folder, { mode: 0o700 });
    chmodSync(folder, 0o700); // the umask may have taken bits away; it never adds any, but chmod makes the mode exact
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = lstatSync(folder);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new StoreError('damaged-store');
}

/** Creates hub.db 0600 first, so SQLite's -wal and -shm files inherit 0600 whatever the umask (the relay's Pitfall 6). Never follows a link. */
function precreatePrivate(file: string): void {
  const fd = openSync(file, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

export interface OpenReport {
  /** How many blob files with no row were removed (a kill between the file and its row leaves one). */
  orphanBlobsRemoved: number;
  /** How many temporary blob files a kill left behind were removed. */
  temporaryFilesRemoved: number;
  /** How many blob rows name a file that is missing. Never silently dropped: the store reports itself damaged. */
  missingBlobFiles: number;
  /** A plain sentence when the store is damaged, else undefined. */
  damaged: string | undefined;
}

export async function openHubStore(dir: string): Promise<HubStore> {
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new StoreError('damaged-store', 'The hub state directory is not a real folder.');
  const file = path.join(dir, DATABASE_FILE);
  precreatePrivate(file);
  const db = new Database(file, { timeout: BUSY_TIMEOUT_MS });
  try {
    const mode = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | undefined;
    if (mode?.journal_mode !== 'wal') throw new Error('The database could not be put in write-ahead mode.');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    const blobRoot = path.join(dir, BLOB_FOLDER);
    ensurePrivateFolder(blobRoot);
    const report: OpenReport = { orphanBlobsRemoved: 0, temporaryFilesRemoved: 0, missingBlobFiles: 0, damaged: undefined };
    return new HubStore(db, blobRoot, report);
  } catch (error) {
    if (db.isOpen) db.close();
    throw error;
  }
}

export class HubStore {
  private readonly stmt: Map<string, Statement> = new Map();
  private closed = false;

  constructor(
    private readonly db: Database,
    readonly blobRoot: string,
    readonly openReport: OpenReport,
  ) {}

  /** Prepared statements, made once on first use. */
  private sql(text: string): Statement {
    let found = this.stmt.get(text);
    if (found === undefined) {
      found = this.db.prepare(text);
      this.stmt.set(text, found);
    }
    return found;
  }

  /** Runs body inside BEGIN IMMEDIATE and COMMIT. A caller returns only after this returned, which is after COMMIT. */
  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private requireProject(project: string): void {
    if (this.sql('SELECT 1 FROM projects WHERE project = ?').get(project) === undefined) throw new StoreError('unknown-project');
  }

  instanceId(): string {
    const row = this.sql(`SELECT value FROM hub_meta WHERE key = 'instance_id'`).get() as Row | undefined;
    if (!row || typeof row.value !== 'string') throw new StoreError('damaged-store', 'The hub state has no instance id.');
    return row.value;
  }

  schemaVersion(): number {
    const row = this.sql(`SELECT value FROM hub_meta WHERE key = 'schema_version'`).get() as Row | undefined;
    return Number(row?.value);
  }

  // Projects.

  createProject(input: { project: string; genesisHash: string; anchor: string; enrolment: string; at: number }): void {
    const record = this.checkProjectInput(input);
    this.transaction(() => this.insertProject(record));
  }

  private checkProjectInput(input: { project: string; genesisHash: string; anchor: string; enrolment: string; at: number }): ProjectRecord {
    if (typeof input !== 'object' || input === null) throw invalid('a project must be a record');
    const project = checkProject(input.project);
    const genesisHash = checkHash('the genesis hash', input.genesisHash);
    const anchor = checkCanonical('the anchor', input.anchor, ANCHOR_MAX_BYTES);
    if (typeof input.enrolment !== 'string' || !ENROLMENT_ID.test(input.enrolment)) throw invalid('an enrolment id must be enr- and 16 hex characters');
    const createdAt = checkTime('the creation time', input.at);
    return { project, genesisHash, anchor, enrolment: input.enrolment, createdAt };
  }

  private insertProject(record: ProjectRecord): void {
    if (this.sql('SELECT 1 FROM projects WHERE project = ?').get(record.project) !== undefined) throw new StoreError('project-exists');
    this.sql('INSERT INTO projects (project, genesis_hash, anchor, enrolment, created_at) VALUES (?, ?, ?, ?, ?)').run(
      record.project,
      record.genesisHash,
      record.anchor,
      record.enrolment,
      record.createdAt,
    );
  }

  project(project: string): ProjectRecord | undefined {
    checkProject(project);
    const row = this.sql('SELECT * FROM projects WHERE project = ?').get(project) as Row | undefined;
    return row ? toProject(row) : undefined;
  }

  // Entries (D-44): kept per (project, stream, writer, seq), unique by place and by hash, never deleted or rewritten.

  /** Stores a batch of entries all or nothing. A refusal names the first refused row in StoreError.index; nothing of the batch is stored. */
  appendEntries(project: string, rows: readonly EntryRow[]): StoredEntry[] {
    checkProject(project);
    const checked = this.checkRows(rows);
    return this.transaction(() => {
      this.requireProject(project);
      this.insertEntries(project, checked);
      return checked;
    });
  }

  private checkRows(rows: readonly EntryRow[]): CheckedEntry[] {
    if (!Array.isArray(rows)) throw invalid('the entries must be a list');
    return rows.map((row, index) => {
      try {
        return checkEntryRow(row);
      } catch (error) {
        if (error instanceof StoreError) throw new StoreError(error.id, error.message, index);
        throw error;
      }
    });
  }

  /** Inside a transaction: hash first (the same entry again is hash-taken), then place (another entry at a used place is seq-taken). */
  private insertEntries(project: string, rows: readonly CheckedEntry[]): void {
    const byHash = this.sql('SELECT 1 FROM entries WHERE project = ? AND hash = ?');
    const atPlace = this.sql('SELECT 1 FROM entries WHERE project = ? AND stream = ? AND writer = ? AND seq = ?');
    const insert = this.sql(
      `INSERT INTO entries (project, stream, writer, seq, hash, header, body, body_size, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    rows.forEach((row, index) => {
      if (byHash.get(project, row.hash) !== undefined) throw new StoreError('hash-taken', STORE_REFUSALS['hash-taken'], index);
      if (atPlace.get(project, row.stream, row.writer, row.seq) !== undefined) throw new StoreError('seq-taken', STORE_REFUSALS['seq-taken'], index);
      insert.run(project, row.stream, row.writer, row.seq, row.hash, row.header, row.body, row.bodySize, row.receivedAt);
    });
  }

  /** One writer's entries in a stream from seq `from`, in seq order, at most `limit` entries and `maxBytes` header plus body characters. */
  entriesFrom(project: string, stream: string, writer: string, from: number, limits: PageLimits): EntryPage {
    checkProject(project);
    if (typeof stream !== 'string' || !STREAM_ID_PATTERN.test(stream)) throw invalid('a stream id must be 32 lowercase hex characters');
    checkHash('a writer id', writer);
    checkSeq('the first seq', from);
    if (!Number.isSafeInteger(limits?.limit) || limits.limit < 1) throw invalid('a page limit must be a whole number from 1');
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) throw invalid('a page byte limit must be a whole number from 1');
    const entries: StoredEntry[] = [];
    let bytes = 0;
    let more = false;
    const rows = this.sql('SELECT * FROM entries WHERE project = ? AND stream = ? AND writer = ? AND seq >= ? ORDER BY seq').iterate(project, stream, writer, from);
    for (const raw of rows) {
      const entry = toEntry(raw as Row);
      const size = entry.header.length + entry.body.length;
      if (entries.length >= limits.limit || (entries.length > 0 && bytes + size > limits.maxBytes)) {
        more = true;
        break;
      }
      entries.push(entry);
      bytes += size;
    }
    return { entries, more };
  }

  entryAt(project: string, stream: string, writer: string, seq: number): StoredEntry | undefined {
    checkProject(project);
    if (typeof stream !== 'string' || !STREAM_ID_PATTERN.test(stream)) throw invalid('a stream id must be 32 lowercase hex characters');
    checkHash('a writer id', writer);
    checkSeq('a seq', seq);
    const row = this.sql('SELECT * FROM entries WHERE project = ? AND stream = ? AND writer = ? AND seq = ?').get(project, stream, writer, seq) as Row | undefined;
    return row ? toEntry(row) : undefined;
  }

  entryByHash(project: string, hash: string): StoredEntry | undefined {
    checkProject(project);
    checkHash('an entry hash', hash);
    const row = this.sql('SELECT * FROM entries WHERE project = ? AND hash = ?').get(project, hash) as Row | undefined;
    return row ? toEntry(row) : undefined;
  }

  /** The newest entry of one writer's log in a stream, or undefined when the hub holds none. */
  headOf(project: string, stream: string, writer: string): Head | undefined {
    checkProject(project);
    if (typeof stream !== 'string' || !STREAM_ID_PATTERN.test(stream)) throw invalid('a stream id must be 32 lowercase hex characters');
    checkHash('a writer id', writer);
    const row = this.sql('SELECT seq, hash FROM entries WHERE project = ? AND stream = ? AND writer = ? ORDER BY seq DESC LIMIT 1').get(project, stream, writer) as
      | Row
      | undefined;
    return row ? { seq: Number(row.seq), hash: row.hash as string } : undefined;
  }

  /** Every writer's head in every stream of the project, sorted by stream and then writer. */
  heads(project: string): StreamHeads[] {
    checkProject(project);
    // With exactly one max() aggregate, SQLite takes the bare column hash from the row holding the max (documented behaviour).
    const rows = this.sql('SELECT stream, writer, max(seq) AS seq, hash FROM entries WHERE project = ? GROUP BY stream, writer ORDER BY stream, writer').all(
      project,
    ) as Row[];
    const out: StreamHeads[] = [];
    for (const row of rows) {
      const stream = row.stream as string;
      let current = out[out.length - 1];
      if (current === undefined || current.stream !== stream) {
        current = { stream, heads: [] };
        out.push(current);
      }
      current.heads.push({ writer: row.writer as string, seq: Number(row.seq), hash: row.hash as string });
    }
    return out;
  }

  /** The durability settings of this store's own connection, read back from SQLite. synchronous 2 is FULL. */
  durability(): Durability {
    const journal = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const synchronous = this.db.prepare('PRAGMA synchronous').get() as { synchronous: number };
    const foreignKeys = this.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    return { journalMode: journal.journal_mode, synchronous: Number(synchronous.synchronous), foreignKeys: Number(foreignKeys.foreign_keys) };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.db.isOpen) this.db.close();
  }
}
