// Copied from relay/src/store/schema.ts and adapted for the hub (D-26, D-28).
import { randomUUID } from 'node:crypto';
import type { Database } from 'node:sqlite';

// Every refusal of the store: an id a caller can branch on and one plain sentence that names no value it was given (no hash, no project id, no
// writer id), so a refusal can be logged and sent back as it is. The ids are the contract; 32-19 to 32-25 map them to their own answers.
export const STORE_REFUSALS = {
  'invalid-record': 'The record was not stored: it does not have the shape the hub keeps.',
  'seq-taken': "The entry was not stored: another entry already holds its place in the writer's log.",
  'hash-taken': 'The entry was not stored: the hub already keeps an entry with the same hash.',
  'unknown-project': 'The record was not stored: its project is not kept on this hub.',
  'project-exists': 'The project was not enrolled: this hub already keeps a project with that id.',
  'blob-mismatch': 'The blob was not stored: its bytes do not hash to its name.',
  'blob-too-large': 'The blob was not stored: it is larger than 8 MiB.',
  'blob-missing': 'Nothing was stored: an entry refers to a blob this hub does not hold for the project.',
  'enrolment-used': 'The project was not enrolled: its enrolment was already used.',
  'not-found': 'Nothing was changed: the hub keeps no such record.',
  'damaged-store': "The hub's store is damaged: a blob file its records name is missing or does not match. Restore the state directory from a backup.",
  'newer-schema': 'This state was written by a newer hub; this hub cannot read it. Start the newer hub or restore a backup.',
} as const;

export type StoreRefusal = keyof typeof STORE_REFUSALS;

export class StoreError extends Error {
  /** For a refused batch: the position of the first row that was refused. Nothing of the batch was stored. */
  readonly index: number | undefined;

  constructor(
    readonly id: StoreRefusal,
    message: string = STORE_REFUSALS[id],
    index?: number,
  ) {
    super(message);
    this.name = 'StoreError';
    this.index = index;
  }
}

// Schema v1 holds every table the hub plans of Phase 32 need (D-26, D-41, D-43, D-44, D-45, D-48; DESIGN 10.3). The storage format is the
// costly door: it is written once, before any data exists. Later phases add migrations at the end of the list; a migration that is already
// applied is never edited. Every table is STRICT, so a value of the wrong type is an error and not silently stored.
//
// History is append-only in the schema itself, not only in the code: entries, blob references, grants, checkpoints and equivocation proofs refuse
// UPDATE and DELETE through triggers, and a blob row that an entry references can never be deleted. So a later bug in a store method, or a
// second connection, cannot rewrite what the hub accepted (T-32-65).

const APPEND_ONLY = (table: string): string => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
`;

export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE hub_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
  project TEXT PRIMARY KEY CHECK (length(project) = 32),
  genesis_hash TEXT NOT NULL CHECK (length(genesis_hash) = 64),
  anchor TEXT NOT NULL,
  enrolment TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE entries (
  project TEXT NOT NULL REFERENCES projects (project),
  stream TEXT NOT NULL CHECK (length(stream) = 32),
  writer TEXT NOT NULL CHECK (length(writer) = 64),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  header TEXT NOT NULL,
  body TEXT NOT NULL,
  body_size INTEGER NOT NULL CHECK (body_size >= 0),
  received_at INTEGER NOT NULL,
  PRIMARY KEY (project, stream, writer, seq),
  UNIQUE (project, hash)
) STRICT;
${APPEND_ONLY('entries')}
CREATE TABLE blobs (
  project TEXT NOT NULL REFERENCES projects (project),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  size INTEGER NOT NULL CHECK (size >= 0),
  uploaded_by TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL,
  referenced_at INTEGER,
  PRIMARY KEY (project, hash)
) STRICT;

CREATE INDEX blobs_unreferenced ON blobs (uploaded_at) WHERE referenced_at IS NULL;
CREATE INDEX blobs_pending_by_uploader ON blobs (project, uploaded_by) WHERE referenced_at IS NULL;

-- A referenced blob is kept for the life of the project (D-44): only the sweep of never-referenced uploads deletes blob rows.
CREATE TRIGGER blobs_keep_referenced BEFORE DELETE ON blobs WHEN OLD.referenced_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a referenced blob is kept for the life of its project'); END;
CREATE TRIGGER blobs_reference_once BEFORE UPDATE ON blobs
WHEN OLD.referenced_at IS NOT NULL OR NEW.project IS NOT OLD.project OR NEW.hash IS NOT OLD.hash OR NEW.size IS NOT OLD.size
  OR NEW.uploaded_by IS NOT OLD.uploaded_by OR NEW.uploaded_at IS NOT OLD.uploaded_at
BEGIN SELECT RAISE(ABORT, 'a blob row only ever gains its first reference time'); END;

CREATE TABLE blob_refs (
  project TEXT NOT NULL,
  blob TEXT NOT NULL,
  entry TEXT NOT NULL,
  stream TEXT NOT NULL CHECK (length(stream) = 32),
  PRIMARY KEY (project, blob, entry),
  FOREIGN KEY (project, blob) REFERENCES blobs (project, hash),
  FOREIGN KEY (project, entry) REFERENCES entries (project, hash)
) STRICT;
${APPEND_ONLY('blob_refs')}
CREATE TABLE grants (
  project TEXT NOT NULL REFERENCES projects (project),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  cell TEXT NOT NULL CHECK (length(cell) = 32),
  epoch INTEGER NOT NULL CHECK (epoch >= 1),
  body TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (project, hash)
) STRICT;
${APPEND_ONLY('grants')}
CREATE TABLE checkpoints (
  project TEXT NOT NULL REFERENCES projects (project),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  body TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (project, hash)
) STRICT;

CREATE INDEX checkpoints_in_signing_order ON checkpoints (project, signed_at, received_at, hash);
${APPEND_ONLY('checkpoints')}
CREATE TABLE equivocations (
  project TEXT NOT NULL REFERENCES projects (project),
  proof_hash TEXT NOT NULL CHECK (length(proof_hash) = 64),
  stream TEXT NOT NULL CHECK (length(stream) = 32),
  writer TEXT NOT NULL CHECK (length(writer) = 64),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  proof TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (project, proof_hash)
) STRICT;
${APPEND_ONLY('equivocations')}
-- An enrolment keeps the hash of its one-time secret only, never the secret (D-41, T-32-68).
CREATE TABLE enrolments (
  enrolment TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  project TEXT,
  CHECK ((used_at IS NULL) = (project IS NULL))
) STRICT;

-- An invitation keeps the hub check key only, never the join secret (D-48, T-32-68).
CREATE TABLE invites (
  project TEXT NOT NULL REFERENCES projects (project),
  invite TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  check_key TEXT NOT NULL,
  registered_by TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  locked_at INTEGER,
  used_at INTEGER,
  registered_at INTEGER NOT NULL,
  PRIMARY KEY (project, invite)
) STRICT;

CREATE TABLE join_requests (
  project TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  invite TEXT NOT NULL,
  body TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  accepted_at INTEGER,
  PRIMARY KEY (project, request_hash),
  FOREIGN KEY (project, invite) REFERENCES invites (project, invite)
) STRICT;

CREATE INDEX join_requests_accepted ON join_requests (accepted_at) WHERE accepted_at IS NOT NULL;

INSERT INTO hub_meta (key, value) VALUES ('schema_version', '1');
`,
  // v2 (WR-05): each kept checkpoint's coverage (how many entries it covers), so a handed-back checkpoint is placed among the kept ones with one
  // query instead of reading and parsing every kept checkpoint. Append-only like the checkpoints it describes; rows of checkpoints kept before
  // this migration are filled from their bodies.
  `
CREATE TABLE checkpoint_coverage (
  project TEXT NOT NULL,
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  coverage INTEGER NOT NULL CHECK (coverage >= 0),
  PRIMARY KEY (project, hash),
  FOREIGN KEY (project, hash) REFERENCES checkpoints (project, hash)
) STRICT;

CREATE INDEX checkpoint_coverage_by_size ON checkpoint_coverage (project, coverage);
${APPEND_ONLY('checkpoint_coverage')}
INSERT INTO checkpoint_coverage (project, hash, coverage)
SELECT c.project, c.hash, max(0, coalesce((SELECT sum(CAST(json_extract(s.value, '$.count') AS INTEGER)) FROM json_each(c.body, '$.payload.streams') AS s), 0))
FROM checkpoints AS c;

UPDATE hub_meta SET value = '2' WHERE key = 'schema_version';
`,
  // v3 (WR-02): per writer log, the furthest place a kept checkpoint of this hub names as a head. A place at or below it is one the hub accepted
  // before, so after a restore the entry there is taken back even from a device revoked since. Derived from the kept checkpoints and only ever
  // moved forward by the store, so it is not append-only; rows for checkpoints kept before this migration are filled from their bodies.
  `
CREATE TABLE checkpoint_cover (
  project TEXT NOT NULL REFERENCES projects (project),
  stream TEXT NOT NULL CHECK (length(stream) = 32),
  writer TEXT NOT NULL CHECK (length(writer) = 64),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  PRIMARY KEY (project, stream, writer)
) STRICT;

INSERT INTO checkpoint_cover (project, stream, writer, seq, hash)
SELECT project, stream, writer, max(seq), hash FROM (
  SELECT c.project AS project, json_extract(s.value, '$.stream') AS stream, json_extract(h.value, '$.writer') AS writer,
    json_extract(h.value, '$.seq') AS seq, json_extract(h.value, '$.hash') AS hash
  FROM checkpoints AS c, json_each(c.body, '$.payload.streams') AS s, json_each(s.value, '$.heads') AS h
)
WHERE typeof(stream) = 'text' AND length(stream) = 32 AND typeof(writer) = 'text' AND length(writer) = 64
  AND typeof(seq) = 'integer' AND seq >= 0 AND typeof(hash) = 'text' AND length(hash) = 64
GROUP BY project, stream, writer;

UPDATE hub_meta SET value = '3' WHERE key = 'schema_version';
`,
  // v4 (Phase 71, 71-09): what the hub hosts as your organization's trust host (trustStore.ts). One did:webvh log per path, which may only grow
  // (the stored log is always a prefix of its replacement) and is never deleted. Every signed status list version, append-only: a version is
  // stored only above the newest of its list and never twice; the hub's PUT also requires exactly one above, so two officers never overwrite each
  // other (compare-and-swap, D-14), while an edge's import may skip versions (71-11). And the status
  // entries of the credentials each member's entries cited (D-16), so a later revocation of one of them refuses that member's sessions.
  `
CREATE TABLE trust_logs (
  path TEXT PRIMARY KEY CHECK (length(path) BETWEEN 1 AND 600),
  scid TEXT NOT NULL CHECK (length(scid) BETWEEN 1 AND 100),
  did TEXT NOT NULL CHECK (length(did) BETWEEN 1 AND 2048),
  log TEXT NOT NULL CHECK (length(log) BETWEEN 1 AND 1048576),
  witness TEXT CHECK (witness IS NULL OR length(witness) <= 262144),
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER trust_logs_no_delete BEFORE DELETE ON trust_logs BEGIN SELECT RAISE(ABORT, 'trust_logs keeps every log'); END;
CREATE TRIGGER trust_logs_grow_only BEFORE UPDATE ON trust_logs
WHEN NEW.path <> OLD.path OR NEW.scid <> OLD.scid OR substr(NEW.log, 1, length(OLD.log)) <> OLD.log
BEGIN SELECT RAISE(ABORT, 'a trust log may only grow'); END;

CREATE TABLE trust_lists (
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 2048),
  version INTEGER NOT NULL CHECK (version >= 1),
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64),
  valid_from TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) <= 131072),
  stored_at INTEGER NOT NULL,
  PRIMARY KEY (id, version)
) STRICT;
CREATE TRIGGER trust_lists_newer_only BEFORE INSERT ON trust_lists
WHEN NEW.version <= (SELECT coalesce(max(version), 0) FROM trust_lists WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'a status list version must be above the newest'); END;
${APPEND_ONLY('trust_lists')}
CREATE TABLE trust_cited (
  project TEXT NOT NULL REFERENCES projects (project),
  member TEXT NOT NULL CHECK (length(member) BETWEEN 1 AND 200),
  list TEXT NOT NULL CHECK (length(list) BETWEEN 1 AND 2048),
  idx INTEGER NOT NULL CHECK (idx >= 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('revocation', 'suspension')),
  PRIMARY KEY (project, member, list, idx, purpose)
) STRICT;
${APPEND_ONLY('trust_cited')}
UPDATE hub_meta SET value = '4' WHERE key = 'schema_version';
`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function readVersion(db: Database): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

function newerSchema(): StoreError {
  return new StoreError('newer-schema');
}

/**
 * Brings the database up to the end of `migrations` (SCHEMA_VERSION for the real list). Each pending migration and its version bump commit together;
 * an interrupted migration leaves the old version. The list is a parameter only so a test can inject a failing step. The hub reads no clock here:
 * hub_meta keeps the schema version and a random instance id, nothing with a time.
 */
export function migrate(db: Database, migrations: readonly string[] = MIGRATIONS): void {
  const supported = migrations.length;
  if (readVersion(db) > supported) throw newerSchema();

  for (let index = readVersion(db); index < migrations.length; index += 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Another process may have applied this step while this one waited for the write lock.
      const current = readVersion(db);
      if (current > supported) throw newerSchema();
      if (current <= index) {
        db.exec(migrations[index] as string);
        db.exec(`PRAGMA user_version = ${index + 1}`);
      }
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO hub_meta (key, value) VALUES (?, ?)').run('instance_id', randomUUID());
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
