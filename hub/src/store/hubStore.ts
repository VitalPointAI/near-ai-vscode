// Copied from relay/src/store/sqliteStore.ts and adapted for the hub (D-26, D-28).
import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { Database } from 'node:sqlite';
import { GRANT_MAX_BYTES } from '@ext/domain/replica/cellKeys';
import { CHECKPOINT_MAX_BYTES, readCheckpoint } from '@ext/domain/replica/checkpoint';
import {
  BLOB_MAX_BYTES,
  HASH_PATTERN,
  HEADER_MAX_BYTES,
  INLINE_BODY_MAX_BYTES,
  SEALED_OVERHEAD,
  STREAM_ID_PATTERN,
  entryHash,
  parseHeaderShape,
  sha256Hex,
} from '@ext/domain/replica/entry';
import { ENROLMENT_ID_PATTERN } from '@ext/domain/replica/hubFile';
import { HUB_CHECK_KEY_BYTES as CHECK_KEY_BYTES } from '@ext/domain/replica/invite';
import { canonicalize } from '@ext/domain/team/canonical';
import { readBlobFile, removeBlobFile, sweepOrphans, syncFolder, writeBlobFile } from './blobFolder';
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

/** A blob nobody's entry references within this long of its upload is removed by sweepBlobs (D-44). */
export const BLOB_SWEEP_AFTER_MS = 24 * 60 * 60 * 1000;
/** An invitation is locked by this many failed hub MAC checks (D-48). */
export const INVITE_LOCK_AFTER = 5;
/** A signed checkpoint is at most CHECKPOINT_MAX_BYTES; the stored text gets the same room twice over for its JSON form. */
const CHECKPOINT_BODY_MAX_BYTES = 2 * CHECKPOINT_MAX_BYTES;
/** An equivocation proof is two headers (at most 4096 bytes each), a public key and the hashes of the branches. */
const PROOF_MAX_BYTES = 64 * 1024;
/** A join request is a small body (D-37: 64 KiB). */
const JOIN_REQUEST_MAX_BYTES = 64 * 1024;
/** The invite id form of src/domain/replica/invite.ts (its SLUG). */
const INVITE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface BlobInput {
  hash: string;
  bytes: Buffer;
  uploadedBy: string;
}

type CheckedBlob = BlobInput;

export interface BlobRecord {
  hash: string;
  size: number;
  uploadedBy: string;
  uploadedAt: number;
  referencedAt: number | undefined;
}

/** An entry's use of a blob, as the append declares it (D-69): the hub cannot read sealed bodies, so the client names what each entry uses. */
export interface BlobRef {
  entry: string;
  blob: string;
  stream: string;
}

export interface GrantInput {
  hash: string;
  cell: string;
  epoch: number;
  /** The signed grant as canonical JSON text; its sha256 is the hash (what grantHash computes). */
  body: string;
  receivedAt: number;
}

export type GrantRecord = GrantInput;

export interface CheckpointRecord {
  hash: string;
  /** The signed checkpoint as JSON text. */
  body: string;
  signedAt: number;
  receivedAt: number;
}

export interface EquivocationRecord {
  proofHash: string;
  stream: string;
  writer: string;
  seq: number;
  /** The proof (both headers and the writer's key) as JSON text. */
  proof: string;
  recordedAt: number;
}

export interface AppendBatch {
  entries: readonly EntryRow[];
  grants?: readonly GrantInput[];
  equivocations?: readonly EquivocationRecord[];
  blobRefs?: readonly BlobRef[];
  at: number;
}

export interface EnrolmentRecord {
  enrolment: string;
  secretHash: string;
  expiresAt: number;
  createdAt: number;
  usedAt: number | undefined;
  project: string | undefined;
}

export interface EnrolInput {
  project: { project: string; genesisHash: string; anchor: string };
  entries: readonly EntryRow[];
  grants: readonly GrantInput[];
  blobs: readonly BlobInput[];
  blobRefs?: readonly BlobRef[];
  enrolment: string;
  at: number;
}

export interface InviteInput {
  project: string;
  invite: string;
  expiresAt: number;
  /** HKDF-SHA256 of the join secret for this invite, as base64url (D-48). Never the join secret. */
  checkKey: string;
  registeredBy: string;
  registeredAt: number;
}

export interface InviteRecord extends InviteInput {
  failures: number;
  lockedAt: number | undefined;
  usedAt: number | undefined;
}

export interface JoinRequestRecord {
  project: string;
  requestHash: string;
  invite: string;
  /** The join request as JSON text. */
  body: string;
  receivedAt: number;
  acceptedAt?: number | undefined;
}

function checkList<T>(field: string, value: readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`${field} must be a list`);
  return value;
}

/** JSON text of one record (an object), at most maxBytes. Kept as given: these are evidence, so the store does not rewrite them. */
function checkJsonRecord(field: string, value: unknown, maxBytes: number): string {
  const text = checkText(field, value, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw invalid(`${field} is not JSON text`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalid(`${field} must be a JSON record`);
  return text;
}

function checkEnrolmentId(value: unknown): string {
  if (typeof value !== 'string' || !ENROLMENT_ID_PATTERN.test(value)) throw invalid('an enrolment id must be enr- and 16 hex characters');
  return value;
}

function checkInviteId(value: unknown): string {
  if (typeof value !== 'string' || !INVITE_ID.test(value)) throw invalid('an invite id must be a short lowercase name');
  return value;
}

/** Size first (so a huge buffer is never hashed), then the hash of the bytes against the name. */
function checkBlob(project: string, blob: BlobInput): CheckedBlob {
  checkProject(project);
  if (typeof blob !== 'object' || blob === null) throw invalid('a blob must be a record');
  const hash = checkHash('a blob hash', blob.hash);
  checkHash('the uploader id', blob.uploadedBy);
  if (!Buffer.isBuffer(blob.bytes)) throw invalid('blob bytes must be a buffer');
  if (blob.bytes.length > BLOB_MAX_BYTES) throw new StoreError('blob-too-large');
  if (sha256Hex(blob.bytes) !== hash) throw new StoreError('blob-mismatch');
  return { hash, bytes: blob.bytes, uploadedBy: blob.uploadedBy };
}

function checkBlobRefs(value: readonly BlobRef[]): BlobRef[] {
  return checkList('the blob references', value).map((ref) => {
    if (typeof ref !== 'object' || ref === null) throw invalid('a blob reference must be a record');
    checkHash('the referencing entry', ref.entry);
    checkHash('the referenced blob', ref.blob);
    if (typeof ref.stream !== 'string' || !STREAM_ID_PATTERN.test(ref.stream)) throw invalid('a stream id must be 32 lowercase hex characters');
    return { entry: ref.entry, blob: ref.blob, stream: ref.stream };
  });
}

/** A grant is canonical JSON text whose sha256 is its hash, for a 32 hex cell and an epoch from 1. */
function checkGrant(grant: GrantInput): GrantInput {
  if (typeof grant !== 'object' || grant === null) throw invalid('a grant must be a record');
  const hash = checkHash('a grant hash', grant.hash);
  if (typeof grant.cell !== 'string' || !STREAM_ID_PATTERN.test(grant.cell)) throw invalid('a cell id must be 32 lowercase hex characters');
  if (!Number.isSafeInteger(grant.epoch) || grant.epoch < 1) throw invalid('a grant epoch must be a whole number from 1');
  const body = checkCanonical('the grant', grant.body, GRANT_MAX_BYTES);
  if (sha256Hex(Buffer.from(body, 'utf8')) !== hash) throw invalid('the grant does not hash to its name');
  const receivedAt = checkTime('the received time', grant.receivedAt);
  return { hash, cell: grant.cell, epoch: grant.epoch, body, receivedAt };
}

function checkProof(proof: EquivocationRecord): EquivocationRecord {
  if (typeof proof !== 'object' || proof === null) throw invalid('an equivocation proof must be a record');
  const proofHash = checkHash('a proof hash', proof.proofHash);
  if (typeof proof.stream !== 'string' || !STREAM_ID_PATTERN.test(proof.stream)) throw invalid('a stream id must be 32 lowercase hex characters');
  const writer = checkHash('a writer id', proof.writer);
  const seq = checkSeq('the proof seq', proof.seq);
  const text = checkJsonRecord('the proof', proof.proof, PROOF_MAX_BYTES);
  const recordedAt = checkTime('the recorded time', proof.recordedAt);
  return { proofHash, stream: proof.stream, writer, seq, proof: text, recordedAt };
}

function toGrant(row: Row): GrantRecord {
  return {
    hash: row.hash as string,
    cell: row.cell as string,
    epoch: Number(row.epoch),
    body: row.body as string,
    receivedAt: Number(row.received_at),
  };
}

function toCheckpoint(row: Row): CheckpointRecord {
  return { hash: row.hash as string, body: row.body as string, signedAt: Number(row.signed_at), receivedAt: Number(row.received_at) };
}

/** How many entries a signed checkpoint covers (the sum of its stream counts); 0 for a body that is not a checkpoint. */
function coverageOfBody(body: string): number {
  try {
    const checkpoint = readCheckpoint((JSON.parse(body) as { payload?: unknown }).payload);
    return checkpoint === undefined ? 0 : checkpoint.streams.reduce((total, stream) => total + stream.count, 0);
  } catch {
    return 0;
  }
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

/**
 * Opens the store. recoverBlobs false skips the blob folder sweep at open: only for a short second process (the operator's --hub-file) that writes
 * no blob, so it never removes a file a running hub has written but not yet given its row.
 */
export async function openHubStore(dir: string, options: { recoverBlobs?: boolean } = {}): Promise<HubStore> {
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
    const store = new HubStore(db, blobRoot, report);
    if (options.recoverBlobs !== false) await store.recoverBlobFolder();
    return store;
  } catch (error) {
    if (db.isOpen) db.close();
    throw error;
  }
}

export class HubStore {
  private readonly stmt: Map<string, Statement> = new Map();
  private closed = false;
  private damage: string | undefined;

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
    checkEnrolmentId(input.enrolment);
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

  // Blobs (D-44): content-addressed by the sha256 of their bytes, per project. The file is written before its row.

  /** Stores one sealed blob. 'held' when the project already holds it (the first upload is kept). */
  async putBlob(project: string, hash: string, bytes: Buffer, uploadedBy: string, at: number): Promise<'stored' | 'held'> {
    const blob = checkBlob(project, { hash, bytes, uploadedBy });
    checkTime('the upload time', at);
    this.requireProject(project);
    if (this.blobRow(project, hash) !== undefined) return 'held';
    await writeBlobFile(this.blobRoot, project, hash, blob.bytes);
    try {
      return this.transaction(() => {
        this.requireProject(project);
        if (this.blobRow(project, hash) !== undefined) return 'held';
        this.insertBlob(project, blob, at);
        return 'stored';
      });
    } catch (error) {
      this.removeFilesWithoutRow(project, [hash]);
      throw error;
    }
  }

  /** The bytes of a blob the project holds, or undefined. A row whose file is missing or changed is damage, never served and never dropped. */
  async readBlob(project: string, hash: string): Promise<Buffer | undefined> {
    checkProject(project);
    checkHash('a blob hash', hash);
    const row = this.blobRow(project, hash);
    if (row === undefined) return undefined;
    const bytes = await readBlobFile(this.blobRoot, project, hash);
    if (bytes === undefined || bytes.length !== Number(row.size) || sha256Hex(bytes) !== hash) {
      this.damage = STORE_REFUSALS['damaged-store'];
      throw new StoreError('damaged-store');
    }
    return bytes;
  }

  blobInfo(project: string, hash: string): BlobRecord | undefined {
    checkProject(project);
    checkHash('a blob hash', hash);
    const row = this.blobRow(project, hash);
    if (row === undefined) return undefined;
    return {
      hash: row.hash as string,
      size: Number(row.size),
      uploadedBy: row.uploaded_by as string,
      uploadedAt: Number(row.uploaded_at),
      referencedAt: row.referenced_at === null ? undefined : Number(row.referenced_at),
    };
  }

  /** Marks blobs referenced by entries the hub keeps. All or nothing; a blob the project does not hold is blob-missing. */
  referenceBlobs(project: string, refs: readonly BlobRef[], at: number): void {
    checkProject(project);
    const checked = checkBlobRefs(refs);
    checkTime('the reference time', at);
    this.transaction(() => {
      this.requireProject(project);
      this.insertBlobRefs(project, checked, at);
    });
  }

  /** The streams whose entries reference this blob (D-69), for the blob route's access check. */
  blobStreams(project: string, hash: string): string[] {
    checkProject(project);
    checkHash('a blob hash', hash);
    return (this.sql('SELECT DISTINCT stream FROM blob_refs WHERE project = ? AND blob = ? ORDER BY stream').all(project, hash) as Row[]).map((row) => row.stream as string);
  }

  /** Bytes of the project's blobs this uploader put that no entry references yet: what 32-19's per-uploader quota counts. */
  unreferencedBytesOf(project: string, uploader: string): number {
    checkProject(project);
    checkHash('an uploader id', uploader);
    const row = this.sql('SELECT coalesce(sum(size), 0) AS total FROM blobs WHERE project = ? AND uploaded_by = ? AND referenced_at IS NULL').get(project, uploader) as Row;
    return Number(row.total);
  }

  /**
   * Removes every blob no entry referenced within BLOB_SWEEP_AFTER_MS of its upload (D-44): rows first in one transaction, then the files at
   * once, with nothing else running in between. A kill after the COMMIT leaves files with no row, which the next open removes. Returns the count.
   */
  async sweepBlobs(now: number): Promise<number> {
    checkTime('the sweep time', now);
    const cutoff = now - BLOB_SWEEP_AFTER_MS;
    const removed = this.transaction(() => {
      const rows = this.sql('SELECT project, hash FROM blobs WHERE referenced_at IS NULL AND uploaded_at <= ?').all(cutoff) as Row[];
      this.sql('DELETE FROM blobs WHERE referenced_at IS NULL AND uploaded_at <= ?').run(cutoff);
      return rows.map((row) => ({ project: row.project as string, hash: row.hash as string }));
    });
    const folders = new Set<string>();
    for (const { project, hash } of removed) {
      if (removeBlobFile(this.blobRoot, project, hash)) folders.add(project);
    }
    for (const project of folders) await syncFolder(path.join(this.blobRoot, project));
    return removed.length;
  }

  /** The plain sentence when the store found itself damaged (at open or on a read), else undefined. For the health check of 32-20. */
  damaged(): string | undefined {
    return this.damage;
  }

  private blobRow(project: string, hash: string): Row | undefined {
    return this.sql('SELECT * FROM blobs WHERE project = ? AND hash = ?').get(project, hash) as Row | undefined;
  }

  private insertBlob(project: string, blob: CheckedBlob, at: number): void {
    this.sql('INSERT OR IGNORE INTO blobs (project, hash, size, uploaded_by, uploaded_at, referenced_at) VALUES (?, ?, ?, ?, ?, NULL)').run(
      project,
      blob.hash,
      blob.bytes.length,
      blob.uploadedBy,
      at,
    );
  }

  /** Inside a transaction: every referenced entry is kept and every referenced blob is held, else nothing of the call is written. */
  private insertBlobRefs(project: string, refs: readonly BlobRef[], at: number): void {
    const entry = this.sql('SELECT stream FROM entries WHERE project = ? AND hash = ?');
    const insert = this.sql('INSERT OR IGNORE INTO blob_refs (project, blob, entry, stream) VALUES (?, ?, ?, ?)');
    const mark = this.sql('UPDATE blobs SET referenced_at = ? WHERE project = ? AND hash = ? AND referenced_at IS NULL');
    for (const ref of refs) {
      if (this.blobRow(project, ref.blob) === undefined) throw new StoreError('blob-missing');
      const held = entry.get(project, ref.entry) as Row | undefined;
      if (held === undefined) throw invalid('a blob reference names an entry the hub does not keep');
      if (held.stream !== ref.stream) throw invalid('a blob reference names another stream than its entry');
      insert.run(project, ref.blob, ref.entry, ref.stream);
      mark.run(at, project, ref.blob);
    }
  }

  /** After a refused write: removes the files of these blobs that have no row (a row means another write kept the same bytes). Synchronous. */
  private removeFilesWithoutRow(project: string, hashes: readonly string[]): void {
    for (const hash of hashes) {
      if (this.blobRow(project, hash) === undefined) removeBlobFile(this.blobRoot, project, hash);
    }
  }

  /** At open: removes files with no row and stale temporary files, and counts rows whose file is missing. */
  async recoverBlobFolder(): Promise<void> {
    const known = this.sql('SELECT 1 FROM blobs WHERE project = ? AND hash = ?');
    const sweep = await sweepOrphans(this.blobRoot, (project, hash) => known.get(project, hash) !== undefined);
    let missing = 0;
    for (const row of this.sql('SELECT project, count(*) AS total FROM blobs GROUP BY project').all() as Row[]) {
      missing += Number(row.total) - (sweep.found.get(row.project as string) ?? 0);
    }
    this.openReport.orphanBlobsRemoved = sweep.orphans;
    this.openReport.temporaryFilesRemoved = sweep.temporary;
    this.openReport.missingBlobFiles = missing;
    if (missing > 0) {
      this.openReport.damaged = STORE_REFUSALS['damaged-store'];
      this.damage = this.openReport.damaged;
    }
  }

  // Grants (D-64, D-69): signed cell grants as canonical JSON text, kept by hash for the life of the project and served through the blob route.

  putGrant(project: string, grant: GrantInput): 'stored' | 'held' {
    checkProject(project);
    const checked = checkGrant(grant);
    return this.transaction(() => {
      this.requireProject(project);
      return this.insertGrant(project, checked);
    });
  }

  private insertGrant(project: string, grant: GrantInput): 'stored' | 'held' {
    const held = this.sql('SELECT body FROM grants WHERE project = ? AND hash = ?').get(project, grant.hash) as Row | undefined;
    if (held !== undefined) return 'held';
    this.sql('INSERT INTO grants (project, hash, cell, epoch, body, received_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      project,
      grant.hash,
      grant.cell,
      grant.epoch,
      grant.body,
      grant.receivedAt,
    );
    return 'stored';
  }

  grants(project: string): GrantRecord[] {
    checkProject(project);
    return (this.sql('SELECT * FROM grants WHERE project = ? ORDER BY cell, epoch, received_at, hash').all(project) as Row[]).map(toGrant);
  }

  grant(project: string, hash: string): GrantRecord | undefined {
    checkProject(project);
    checkHash('a grant hash', hash);
    const row = this.sql('SELECT * FROM grants WHERE project = ? AND hash = ?').get(project, hash) as Row | undefined;
    return row ? toGrant(row) : undefined;
  }

  // Checkpoints (D-45): every one is kept as evidence, never replaced.

  putCheckpoint(project: string, checkpoint: CheckpointRecord): 'stored' | 'held' {
    checkProject(project);
    const hash = checkHash('a checkpoint hash', checkpoint?.hash);
    const body = checkJsonRecord('the checkpoint', checkpoint.body, CHECKPOINT_BODY_MAX_BYTES);
    const signedAt = checkTime('the signing time', checkpoint.signedAt);
    const receivedAt = checkTime('the received time', checkpoint.receivedAt);
    return this.transaction(() => {
      this.requireProject(project);
      if (this.sql('SELECT 1 FROM checkpoints WHERE project = ? AND hash = ?').get(project, hash) !== undefined) return 'held';
      this.insertCheckpoint(project, hash, body, signedAt, receivedAt);
      return 'stored';
    });
  }

  /**
   * Keeps a checkpoint a client handed back (D-54, D-70), placed among the kept ones by its coverage in one transaction (WR-05): just below the
   * earliest kept checkpoint that covers at least as much, or else after every kept one (and not before now). Reads no other checkpoint body.
   */
  putHandedBackCheckpoint(project: string, checkpoint: { hash: string; body: string }, now: number): 'stored' | 'held' {
    checkProject(project);
    const hash = checkHash('a checkpoint hash', checkpoint?.hash);
    const body = checkJsonRecord('the checkpoint', checkpoint.body, CHECKPOINT_BODY_MAX_BYTES);
    const receivedAt = checkTime('the received time', now);
    const coverage = coverageOfBody(body);
    return this.transaction(() => {
      this.requireProject(project);
      if (this.sql('SELECT 1 FROM checkpoints WHERE project = ? AND hash = ?').get(project, hash) !== undefined) return 'held';
      const above = this.sql(
        'SELECT min(c.signed_at) AS at FROM checkpoints AS c JOIN checkpoint_coverage AS k ON k.project = c.project AND k.hash = c.hash WHERE c.project = ? AND k.coverage >= ?',
      ).get(project, coverage) as Row | undefined;
      let signedAt: number;
      if (above?.at !== null && above?.at !== undefined) {
        signedAt = Math.max(0, Number(above.at) - 1);
      } else {
        const last = this.sql('SELECT max(signed_at) AS at FROM checkpoints WHERE project = ?').get(project) as Row | undefined;
        signedAt = last?.at === null || last?.at === undefined ? receivedAt : Math.max(receivedAt, Number(last.at) + 1);
      }
      this.insertCheckpoint(project, hash, body, signedAt, receivedAt);
      return 'stored';
    });
  }

  private insertCheckpoint(project: string, hash: string, body: string, signedAt: number, receivedAt: number): void {
    this.sql('INSERT INTO checkpoints (project, hash, body, signed_at, received_at) VALUES (?, ?, ?, ?, ?)').run(project, hash, body, signedAt, receivedAt);
    this.sql('INSERT INTO checkpoint_coverage (project, hash, coverage) VALUES (?, ?, ?)').run(project, hash, coverageOfBody(body));
  }

  /** The checkpoints kept after a read cursor, in the order they were kept, each with its own cursor (WR-05: a reader reads only what is new). */
  checkpointsAfter(project: string, cursor: number): Array<CheckpointRecord & { cursor: number }> {
    checkProject(project);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw invalid('a checkpoint cursor must be a whole number');
    return (this.sql('SELECT rowid AS cursor, * FROM checkpoints WHERE project = ? AND rowid > ? ORDER BY rowid').all(project, cursor) as Row[]).map((row) => ({
      ...toCheckpoint(row),
      cursor: Number(row.cursor),
    }));
  }

  /** Every checkpoint of the project in signing order (then received order, then hash, so the order is total). */
  checkpoints(project: string): CheckpointRecord[] {
    checkProject(project);
    return (this.sql('SELECT * FROM checkpoints WHERE project = ? ORDER BY signed_at, received_at, hash').all(project) as Row[]).map(toCheckpoint);
  }

  latestCheckpoint(project: string): CheckpointRecord | undefined {
    checkProject(project);
    const row = this.sql('SELECT * FROM checkpoints WHERE project = ? ORDER BY signed_at DESC, received_at DESC, hash DESC LIMIT 1').get(project) as Row | undefined;
    return row ? toCheckpoint(row) : undefined;
  }

  // Equivocation proofs (D-43): both headers of a second entry at a used place, kept once by the proof's hash.

  putEquivocation(project: string, proof: EquivocationRecord): 'stored' | 'held' {
    checkProject(project);
    const checked = checkProof(proof);
    return this.transaction(() => {
      this.requireProject(project);
      return this.insertEquivocation(project, checked);
    });
  }

  private insertEquivocation(project: string, proof: EquivocationRecord): 'stored' | 'held' {
    if (this.sql('SELECT 1 FROM equivocations WHERE project = ? AND proof_hash = ?').get(project, proof.proofHash) !== undefined) return 'held';
    this.sql('INSERT INTO equivocations (project, proof_hash, stream, writer, seq, proof, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      project,
      proof.proofHash,
      proof.stream,
      proof.writer,
      proof.seq,
      proof.proof,
      proof.recordedAt,
    );
    return 'stored';
  }

  equivocations(project: string): EquivocationRecord[] {
    checkProject(project);
    return (this.sql('SELECT * FROM equivocations WHERE project = ? ORDER BY recorded_at, proof_hash').all(project) as Row[]).map((row) => ({
      proofHash: row.proof_hash as string,
      stream: row.stream as string,
      writer: row.writer as string,
      seq: Number(row.seq),
      proof: row.proof as string,
      recordedAt: Number(row.recorded_at),
    }));
  }

  // The append path (32-19): one transaction for everything an accepted batch writes.

  /**
   * Writes a checked batch in one transaction: its entries, the grants it carries, the equivocation proofs it produced and the blob references
   * its entries declare. One bad part refuses the whole call and nothing is written. Returns the stored entries in batch order.
   */
  commitAppend(project: string, batch: AppendBatch): StoredEntry[] {
    checkProject(project);
    if (typeof batch !== 'object' || batch === null) throw invalid('an append batch must be a record');
    const entries = this.checkRows(batch.entries ?? []);
    const grants = checkList('the grants', batch.grants).map(checkGrant);
    const proofs = checkList('the equivocation proofs', batch.equivocations).map(checkProof);
    const refs = checkBlobRefs(batch.blobRefs ?? []);
    const at = checkTime('the append time', batch.at);
    return this.transaction(() => {
      this.requireProject(project);
      this.insertEntries(project, entries);
      for (const grant of grants) this.insertGrant(project, grant);
      for (const proof of proofs) this.insertEquivocation(project, proof);
      this.insertBlobRefs(project, refs, at);
      return entries;
    });
  }

  // Enrolments (D-41): the hub keeps the hash of each one-time secret only.

  putEnrolment(input: { enrolment: string; secretHash: string; expiresAt: number; createdAt: number }): void {
    const enrolment = checkEnrolmentId(input?.enrolment);
    const secretHash = checkHash('the secret hash', input.secretHash);
    const expiresAt = checkTime('the expiry', input.expiresAt);
    const createdAt = checkTime('the creation time', input.createdAt);
    this.transaction(() => {
      if (this.sql('SELECT 1 FROM enrolments WHERE enrolment = ?').get(enrolment) !== undefined) throw invalid('the enrolment id is already kept');
      this.sql('INSERT INTO enrolments (enrolment, secret_hash, expires_at, created_at, used_at, project) VALUES (?, ?, ?, ?, NULL, NULL)').run(
        enrolment,
        secretHash,
        expiresAt,
        createdAt,
      );
    });
  }

  enrolment(id: string): EnrolmentRecord | undefined {
    const enrolment = checkEnrolmentId(id);
    const row = this.sql('SELECT * FROM enrolments WHERE enrolment = ?').get(enrolment) as Row | undefined;
    if (row === undefined) return undefined;
    return {
      enrolment: row.enrolment as string,
      secretHash: row.secret_hash as string,
      expiresAt: Number(row.expires_at),
      createdAt: Number(row.created_at),
      usedAt: row.used_at === null ? undefined : Number(row.used_at),
      project: row.project === null ? undefined : (row.project as string),
    };
  }

  /**
   * Creates a project from its enrolment in one transaction: the project row, its first entries, grants, blobs and blob references, and the
   * enrolment marked used. Refuses not-found, enrolment-used and project-exists before any file is written, and leaves nothing behind when the
   * transaction is refused: blob files written for it that no row kept are removed. Checking the expiry and the enrolment MAC is 32-19's.
   */
  async enrolProject(input: EnrolInput): Promise<void> {
    if (typeof input !== 'object' || input === null) throw invalid('an enrolment must be a record');
    const at = checkTime('the enrolment time', input.at);
    const record = this.checkProjectInput({ ...input.project, enrolment: input.enrolment, at });
    const entries = this.checkRows(input.entries ?? []);
    const grants = checkList('the grants', input.grants).map(checkGrant);
    const blobs = checkList('the blobs', input.blobs).map((blob) => checkBlob(record.project, blob));
    const refs = checkBlobRefs(input.blobRefs ?? []);
    this.checkEnrolmentFree(record);
    const written: string[] = [];
    try {
      for (const blob of blobs) {
        await writeBlobFile(this.blobRoot, record.project, blob.hash, blob.bytes);
        written.push(blob.hash);
      }
      this.transaction(() => {
        this.checkEnrolmentFree(record);
        this.insertProject(record);
        this.insertEntries(record.project, entries);
        for (const grant of grants) this.insertGrant(record.project, grant);
        for (const blob of blobs) this.insertBlob(record.project, blob, at);
        this.insertBlobRefs(record.project, refs, at);
        this.sql('UPDATE enrolments SET used_at = ?, project = ? WHERE enrolment = ? AND used_at IS NULL').run(at, record.project, record.enrolment);
      });
    } catch (error) {
      this.removeFilesWithoutRow(record.project, written);
      throw error;
    }
  }

  private checkEnrolmentFree(record: ProjectRecord): void {
    const row = this.sql('SELECT used_at FROM enrolments WHERE enrolment = ?').get(record.enrolment) as Row | undefined;
    if (row === undefined) throw new StoreError('not-found', 'The project was not enrolled: the hub keeps no such enrolment.');
    if (row.used_at !== null) throw new StoreError('enrolment-used');
    if (this.sql('SELECT 1 FROM projects WHERE project = ?').get(record.project) !== undefined) throw new StoreError('project-exists');
  }

  // Invitations (D-48): the hub check key only, never the join secret; locked after INVITE_LOCK_AFTER failed checks.

  /** Registers an invitation. The same invitation again (same check key) is held with the new expiry; another check key is refused. */
  putInvite(input: InviteInput): 'stored' | 'held' {
    const project = checkProject(input?.project);
    const invite = checkInviteId(input.invite);
    const expiresAt = checkTime('the expiry', input.expiresAt);
    if (typeof input.checkKey !== 'string' || strictBase64url(input.checkKey)?.length !== CHECK_KEY_BYTES) throw invalid('a check key must be 32 bytes as base64url');
    const registeredBy = checkHash('the registering device', input.registeredBy);
    const registeredAt = checkTime('the registration time', input.registeredAt);
    return this.transaction(() => {
      this.requireProject(project);
      const held = this.sql('SELECT check_key FROM invites WHERE project = ? AND invite = ?').get(project, invite) as Row | undefined;
      if (held !== undefined) {
        if (held.check_key !== input.checkKey) throw invalid('the invitation is already registered with another check key');
        this.sql('UPDATE invites SET expires_at = ? WHERE project = ? AND invite = ?').run(expiresAt, project, invite);
        return 'held';
      }
      this.sql(
        `INSERT INTO invites (project, invite, expires_at, check_key, registered_by, failures, locked_at, used_at, registered_at)
         VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?)`,
      ).run(project, invite, expiresAt, input.checkKey, registeredBy, registeredAt);
      return 'stored';
    });
  }

  invite(project: string, invite: string): InviteRecord | undefined {
    checkProject(project);
    checkInviteId(invite);
    const row = this.sql('SELECT * FROM invites WHERE project = ? AND invite = ?').get(project, invite) as Row | undefined;
    if (row === undefined) return undefined;
    return {
      project: row.project as string,
      invite: row.invite as string,
      expiresAt: Number(row.expires_at),
      checkKey: row.check_key as string,
      registeredBy: row.registered_by as string,
      failures: Number(row.failures),
      lockedAt: row.locked_at === null ? undefined : Number(row.locked_at),
      usedAt: row.used_at === null ? undefined : Number(row.used_at),
      registeredAt: Number(row.registered_at),
    };
  }

  /** Counts one failed check of the hub MAC and returns the new count; the INVITE_LOCK_AFTER-th failure locks the invitation. */
  recordInviteFailure(project: string, invite: string, at: number): number {
    checkProject(project);
    checkInviteId(invite);
    checkTime('the failure time', at);
    return this.transaction(() => {
      const changed = this.sql('UPDATE invites SET failures = failures + 1 WHERE project = ? AND invite = ?').run(project, invite);
      if (Number(changed.changes) !== 1) throw new StoreError('not-found');
      this.sql('UPDATE invites SET locked_at = ? WHERE project = ? AND invite = ? AND locked_at IS NULL AND failures >= ?').run(at, project, invite, INVITE_LOCK_AFTER);
      const row = this.sql('SELECT failures FROM invites WHERE project = ? AND invite = ?').get(project, invite) as Row;
      return Number(row.failures);
    });
  }

  /** Uses an invitation once. True when this call used it; false when it was already used or is locked. */
  useInvite(project: string, invite: string, at: number): boolean {
    checkProject(project);
    checkInviteId(invite);
    checkTime('the use time', at);
    return this.transaction(() => {
      if (this.sql('SELECT 1 FROM invites WHERE project = ? AND invite = ?').get(project, invite) === undefined) throw new StoreError('not-found');
      const changed = this.sql('UPDATE invites SET used_at = ? WHERE project = ? AND invite = ? AND used_at IS NULL AND locked_at IS NULL').run(at, project, invite);
      return Number(changed.changes) === 1;
    });
  }

  // Join requests (D-48): kept until the lead's device takes them; accepted ones are removed after 7 days by removeAcceptedBefore.

  putJoinRequest(input: JoinRequestRecord): 'stored' | 'held' {
    const project = checkProject(input?.project);
    const requestHash = checkHash('a request hash', input.requestHash);
    const invite = checkInviteId(input.invite);
    const body = checkJsonRecord('the join request', input.body, JOIN_REQUEST_MAX_BYTES);
    const receivedAt = checkTime('the received time', input.receivedAt);
    return this.transaction(() => {
      this.requireProject(project);
      if (this.sql('SELECT 1 FROM invites WHERE project = ? AND invite = ?').get(project, invite) === undefined) {
        throw new StoreError('not-found', 'The join request was not stored: the hub keeps no such invitation.');
      }
      if (this.sql('SELECT 1 FROM join_requests WHERE project = ? AND request_hash = ?').get(project, requestHash) !== undefined) return 'held';
      this.sql('INSERT INTO join_requests (project, request_hash, invite, body, received_at, accepted_at) VALUES (?, ?, ?, ?, ?, NULL)').run(
        project,
        requestHash,
        invite,
        body,
        receivedAt,
      );
      return 'stored';
    });
  }

  joinRequests(project: string): JoinRequestRecord[] {
    checkProject(project);
    return (this.sql('SELECT * FROM join_requests WHERE project = ? ORDER BY received_at, request_hash').all(project) as Row[]).map((row) => ({
      project: row.project as string,
      requestHash: row.request_hash as string,
      invite: row.invite as string,
      body: row.body as string,
      receivedAt: Number(row.received_at),
      acceptedAt: row.accepted_at === null ? undefined : Number(row.accepted_at),
    }));
  }

  /** True when this call accepted the request; false when it was accepted before. */
  acceptJoinRequest(project: string, requestHash: string, at: number): boolean {
    checkProject(project);
    checkHash('a request hash', requestHash);
    checkTime('the acceptance time', at);
    return this.transaction(() => {
      if (this.sql('SELECT 1 FROM join_requests WHERE project = ? AND request_hash = ?').get(project, requestHash) === undefined) throw new StoreError('not-found');
      const changed = this.sql('UPDATE join_requests SET accepted_at = ? WHERE project = ? AND request_hash = ? AND accepted_at IS NULL').run(at, project, requestHash);
      return Number(changed.changes) === 1;
    });
  }

  /** Removes accepted requests accepted before the cutoff (the caller passes now minus 7 days). Requests never accepted stay. Returns the count. */
  removeAcceptedBefore(cutoff: number): number {
    checkTime('the cutoff', cutoff);
    return this.transaction(() => Number(this.sql('DELETE FROM join_requests WHERE accepted_at IS NOT NULL AND accepted_at < ?').run(cutoff).changes));
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
