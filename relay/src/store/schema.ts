import { randomUUID } from 'node:crypto';
import type { Database } from 'node:sqlite';
import { StoreError } from './relayStore';

// Schema v1 holds all five aggregates now (tenants, conversation bindings, messages, runs, approvals) plus relay_meta. The storage format is
// the costly door (D-05): it is written once, before any data exists. Later phases add migrations at the end of the list; a migration that
// is already applied is never edited. Every table is STRICT, so a value of the wrong type is an error and not silently stored.

export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE relay_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE tenants (
  tenant_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE conversation_bindings (
  channel TEXT NOT NULL CHECK (channel IN ('teams', 'signal')),
  conversation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (channel, conversation_id)
) STRICT;

CREATE TABLE messages (
  message_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  channel TEXT NOT NULL CHECK (channel IN ('teams', 'signal')),
  conversation_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'done')),
  attempts INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  claimed_at INTEGER,
  done_at INTEGER,
  UNIQUE (tenant_id, dedupe_key)
) STRICT;

CREATE INDEX messages_by_conversation ON messages (tenant_id, channel, conversation_id, state, message_id);

CREATE TABLE runs (
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  run_id TEXT NOT NULL,
  message_id INTEGER NOT NULL REFERENCES messages (message_id),
  channel TEXT NOT NULL CHECK (channel IN ('teams', 'signal')),
  conversation_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting-approval', 'finished', 'failed', 'cancelled', 'interrupted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, run_id)
) STRICT;

CREATE INDEX runs_by_state ON runs (state);

CREATE TABLE approvals (
  tenant_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'expired')),
  decision TEXT CHECK (decision IS NULL OR decision IN ('allow', 'allow-run', 'allow-always', 'deny')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  answered_at INTEGER,
  PRIMARY KEY (tenant_id, approval_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs (tenant_id, run_id)
) STRICT;

CREATE INDEX approvals_by_requester ON approvals (tenant_id, state, requester_id);
`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function readVersion(db: Database): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

function newerSchema(found: number, supported: number): StoreError {
  return new StoreError(
    'newer-schema',
    `This state was written by a newer relay (schema ${found}); this relay reads up to schema ${supported}. Start the newer relay or restore a backup.`,
  );
}

/**
 * Brings the database up to the end of `migrations` (SCHEMA_VERSION for the real list). Each pending migration and its version bump commit together;
 * an interrupted migration leaves the old version. The list is a parameter only so a test can inject a failing step.
 */
export function migrate(db: Database, now: () => number, migrations: readonly string[] = MIGRATIONS): void {
  const supported = migrations.length;
  const found = readVersion(db);
  if (found > supported) throw newerSchema(found, supported);

  for (let index = found; index < migrations.length; index += 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Another process may have applied this step while this one waited for the write lock.
      const current = readVersion(db);
      if (current > supported) throw newerSchema(current, supported);
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
    const insert = db.prepare('INSERT OR IGNORE INTO relay_meta (key, value) VALUES (?, ?)');
    insert.run('instance_id', randomUUID());
    insert.run('created_at', String(now()));
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
