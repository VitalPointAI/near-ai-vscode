import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { StoreError } from '../src/store/relayStore';
import { MIGRATIONS, SCHEMA_VERSION, migrate } from '../src/store/schema';
import { openSqliteStore } from '../src/store/sqliteStore';

// Phase 68, plan 05 (RELAY-03, T-68-13): the on-disk format is versioned and guarded. A fresh database carries the current version in WAL mode;
// a migration applies once and atomically with its version bump; a database written by a newer relay is refused in plain words, by the store and
// by the built relay; and the relay's instance id (relay_meta) is the same after a kill -9 and a restart. Raw SQL appears only in this file, only
// to inspect a database or to set its version.

const BIN = fileURLToPath(new URL('../bin.mjs', import.meta.url));

async function withTemp<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-relay-schema-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function readPragma(file: string, name: 'user_version' | 'journal_mode'): unknown {
  const reader = new Database(file, { readOnly: true });
  try {
    const row = reader.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
    return row[name];
  } finally {
    reader.close();
  }
}

function setUserVersion(file: string, version: number): void {
  const writer = new Database(file);
  try {
    writer.exec(`PRAGMA user_version = ${version}`);
  } finally {
    writer.close();
  }
}

function tableNames(file: string): string[] {
  const reader = new Database(file, { readOnly: true });
  try {
    const rows = reader.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  } finally {
    reader.close();
  }
}

test('a fresh store has user_version equal to SCHEMA_VERSION, write-ahead logging on, and every table of schema v1', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'relay.db');
    const store = await openSqliteStore(file);
    await store.close();
    assert.equal(readPragma(file, 'user_version'), SCHEMA_VERSION);
    assert.equal(readPragma(file, 'journal_mode'), 'wal');
    for (const table of ['approvals', 'conversation_bindings', 'messages', 'relay_meta', 'runs', 'tenants']) {
      assert.ok(tableNames(file).includes(table), `schema v1 has no ${table} table`);
    }
  });
});

test('the store connection reads back synchronous FULL, write-ahead logging and foreign keys on, also after a reopen (A5)', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'relay.db');
    for (let open = 0; open < 2; open += 1) {
      const store = await openSqliteStore(file);
      try {
        // synchronous is per connection, so it is read on the store's own connection: 2 is FULL, which the kill drill cannot show.
        assert.deepEqual(store.durability(), { journalMode: 'wal', synchronous: 2, foreignKeys: 1 });
      } finally {
        await store.close();
      }
    }
  });
  // The SQLite bundled with Node 26.13.1 already defaults to FULL, so the read-back alone would not notice the pragma being removed; it would
  // only notice a weaker setting. The store must set FULL itself so a Node release with another default cannot weaken it silently.
  const source = readFileSync(fileURLToPath(new URL('../../src/store/sqliteStore.ts', import.meta.url)), 'utf8');
  assert.match(source, /db\.exec\('PRAGMA synchronous = FULL'\)/, 'the store sets synchronous = FULL on every connection');
});

test('opening, closing and opening again leaves user_version and the instance id unchanged', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'relay.db');
    const first = await openSqliteStore(file);
    const instanceId = await first.instanceId();
    await first.close();
    const second = await openSqliteStore(file);
    assert.equal(await second.instanceId(), instanceId);
    await second.close();
    const third = await openSqliteStore(file);
    assert.equal(await third.instanceId(), instanceId);
    await third.close();
    assert.equal(readPragma(file, 'user_version'), SCHEMA_VERSION);
    assert.match(instanceId, /^[0-9a-f-]{36}$/);
  });
});

test('a migration that fails halfway leaves the previous version and none of its own statements', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'relay.db');
    const db = new Database(file);
    try {
      const broken = `CREATE TABLE half_done (x INTEGER) STRICT; THIS IS NOT SQL;`;
      assert.throws(() => migrate(db, () => 1, [...MIGRATIONS, broken]));
      assert.equal(db.isTransaction, false, 'a failed migration must not leave a transaction open');
    } finally {
      db.close();
    }
    assert.equal(readPragma(file, 'user_version'), 1);
    const tables = tableNames(file);
    assert.ok(tables.includes('tenants'), 'the v1 tables must stay');
    assert.ok(!tables.includes('half_done'), 'the failed migration left a table behind');
  });
});

test('each migration applies exactly once: migrating again does not run an applied step', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'relay.db');
    const db = new Database(file);
    try {
      // Running this ALTER twice would fail on the second run (duplicate column), so a clean second migrate proves it was skipped.
      const second = `ALTER TABLE tenants ADD COLUMN note TEXT`;
      const list = [...MIGRATIONS, second];
      migrate(db, () => 1, list);
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
      migrate(db, () => 2, list);
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
      const meta = db.prepare(`SELECT count(*) AS total FROM relay_meta WHERE key = 'instance_id'`).get() as { total: number };
      assert.equal(meta.total, 1);
    } finally {
      db.close();
    }
  });
});

test('a database whose user_version is above SCHEMA_VERSION is refused by the store with a plain sentence and left as it was', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'relay.db');
    const store = await openSqliteStore(file);
    await store.close();
    setUserVersion(file, SCHEMA_VERSION + 1);
    await assert.rejects(openSqliteStore(file), (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.equal(error.code, 'newer-schema');
      assert.match(error.message, /newer relay/);
      assert.match(error.message, new RegExp(`schema ${SCHEMA_VERSION + 1}`));
      return true;
    });
    assert.equal(readPragma(file, 'user_version'), SCHEMA_VERSION + 1);
  });
});

interface Finished {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface Running {
  /** Resolves with the first stdout line whose event is `event`. */
  waitFor(event: string): Promise<Record<string, unknown>>;
  kill(signal: NodeJS.Signals): void;
  done: Promise<Finished>;
}

function startRelay(stateDir: string): Running {
  const child = spawn(process.execPath, [BIN], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RELAY_HOST: '127.0.0.1', RELAY_PORT: '0', RELAY_STATE_DIR: stateDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const watchers: Array<() => void> = [];
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    for (const watcher of [...watchers]) watcher();
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const done = new Promise<Finished>((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  const lines = (): Array<Record<string, unknown>> =>
    stdout.split('\n').slice(0, -1).filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    done,
    kill: (signal) => child.kill(signal),
    waitFor: (event) =>
      new Promise((resolve, reject) => {
        const check = (): void => {
          const found = lines().find((line) => line.event === event);
          if (found) {
            watchers.splice(watchers.indexOf(check), 1);
            resolve(found);
          }
        };
        watchers.push(check);
        void done.then(() => reject(new Error(`the relay ended before it logged ${event}; stdout: ${stdout}`)));
        check();
      }),
  };
}

test('the built relay pointed at a newer database exits 1 with relay.start_refused reason store and a sentence naming the newer relay', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'relay.db');
    const store = await openSqliteStore(file);
    await store.close();
    setUserVersion(file, SCHEMA_VERSION + 1);
    const finished = await startRelay(dir).done;
    assert.equal(finished.code, 1);
    const lines = finished.stdout.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
    // secrets.loaded and log.pseudonym_key (plan 06) come before the store is opened.
    assert.deepEqual(lines.map((line) => line.event), ['secrets.loaded', 'log.pseudonym_key', 'relay.start_refused']);
    assert.equal(lines[2]?.reason, 'store');
    assert.match(String(lines[2]?.detail), /newer relay/);
    assert.equal(finished.stderr, '');
  });
});

test('the relay keeps the same instanceId across kill -9 and a restart, and answers /healthz both times', async () => {
  await withTemp(async (dir) => {
    const first = startRelay(dir);
    const listening = await first.waitFor('relay.listening');
    assert.match(String(listening.instanceId), /^[0-9a-f-]{36}$/);
    assert.equal((await fetch(`http://127.0.0.1:${listening.port as number}/healthz`)).status, 200);
    first.kill('SIGKILL');
    const killed = await first.done;
    assert.equal(killed.signal, 'SIGKILL');

    const second = startRelay(dir);
    try {
      const again = await second.waitFor('relay.listening');
      assert.equal(again.instanceId, listening.instanceId);
      assert.equal((await fetch(`http://127.0.0.1:${again.port as number}/healthz`)).status, 200);
    } finally {
      second.kill('SIGTERM');
      await second.done;
    }
  });
});
