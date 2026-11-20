import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'node:sqlite';
import test from 'node:test';
import { entryHash, sha256Hex, type EntryHeader } from '@ext/domain/replica/entry';
import { canonicalize } from '@ext/domain/team/canonical';
import { openHubStore, StoreError, STORE_REFUSALS, type EntryRow, type HubStore } from '../src/store/hubStore';

// Phase 32, plan 18 (D-26, D-44): the hub's store. One node:sqlite database in WAL mode with synchronous FULL plus a content-addressed blob folder,
// both in the hub's state directory. These tests run on real files in temporary directories; reopening a store is what a restart does.
// All ids below are made up for the tests.

const PROJECT = sha256Hex(Buffer.from('fictional project one')).slice(0, 32);
const OTHER_PROJECT = sha256Hex(Buffer.from('fictional project two')).slice(0, 32);
const WRITER = sha256Hex(Buffer.from('fictional device one'));
const GENESIS = sha256Hex(Buffer.from('fictional genesis'));
const ENROLMENT = 'enr-0123456789abcdef';
const SIG = Buffer.alloc(64, 7).toString('base64url');
const T0 = 1_800_000_000_000;
const PAGE = { limit: 1000, maxBytes: 4 * 1024 * 1024 };

async function withStoreDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-hub-store-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A well-formed entry row. The store checks shapes, places and hashes, not signatures, so a fixed signature is enough here. */
function makeRow(seq: number, options: { stream?: string; writer?: string; prev?: string; text?: string; at?: number } = {}): EntryRow & { hash: string } {
  const wire = Buffer.from(`sealed body ${options.text ?? 'one'} ${seq}`.padEnd(40, '.'));
  const header: EntryHeader = {
    v: 2,
    stream: options.stream ?? PROJECT,
    writer: options.writer ?? WRITER,
    seq,
    prev: options.prev ?? '0'.repeat(64),
    epoch: 1,
    body: { hash: sha256Hex(wire), size: wire.length },
    sig: SIG,
  };
  return { header: canonicalize(header), body: wire.toString('base64url'), receivedAt: options.at ?? T0 + seq, hash: entryHash(header) };
}

function chain(count: number, options: { stream?: string; writer?: string; text?: string } = {}): Array<EntryRow & { hash: string }> {
  const rows: Array<EntryRow & { hash: string }> = [];
  let prev = '0'.repeat(64);
  for (let seq = 0; seq < count; seq += 1) {
    const row = makeRow(seq, { ...options, prev });
    rows.push(row);
    prev = row.hash;
  }
  return rows;
}

function newProject(store: HubStore, project = PROJECT): void {
  store.createProject({ project, genesisHash: GENESIS, anchor: canonicalize({ lead: 'fictional lead' }), enrolment: ENROLMENT, at: T0 });
}

function refusal(id: keyof typeof STORE_REFUSALS): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof StoreError, `expected a StoreError, got ${String(error)}`);
    assert.equal(error.id, id);
    return true;
  };
}

/** A refusal sentence never carries a value it was given: no hash, no project id, no writer id. */
function assertPlain(error: unknown, ...values: string[]): void {
  assert.ok(error instanceof StoreError);
  assert.ok(error.message.length > 0 && error.message.endsWith('.'), 'a refusal is one plain sentence');
  for (const value of values) assert.ok(!error.message.includes(value), 'a refusal sentence names no value');
}

// Task 1: the tracer.

test('openHubStore on an empty state directory creates hub.db 0600 and the blob folder 0700, in WAL mode with synchronous FULL and foreign keys on', async () => {
  await withStoreDir(async (dir) => {
    const previous = process.umask(0o022);
    let store: HubStore;
    try {
      store = await openHubStore(dir);
    } finally {
      process.umask(previous);
    }
    try {
      assert.equal((await stat(path.join(dir, 'hub.db'))).mode & 0o777, 0o600);
      const blobs = await stat(path.join(dir, 'blobs'));
      assert.ok(blobs.isDirectory());
      assert.equal(blobs.mode & 0o777, 0o700);
      assert.deepEqual(store.durability(), { journalMode: 'wal', synchronous: 2, foreignKeys: 1 });
      assert.equal(store.schemaVersion(), 1);
      assert.match(store.instanceId(), /^[0-9a-f-]{36}$/);
    } finally {
      store.close();
    }
  });
});

test('hub_meta holds schema version 1 and an instance id that survives reopening', async () => {
  await withStoreDir(async (dir) => {
    const first = await openHubStore(dir);
    const id = first.instanceId();
    first.close();
    const second = await openHubStore(dir);
    try {
      assert.equal(second.instanceId(), id);
      assert.equal(second.schemaVersion(), 1);
    } finally {
      second.close();
    }
    const reader = new Database(path.join(dir, 'hub.db'), { readOnly: true });
    try {
      const rows = reader.prepare('SELECT key, value FROM hub_meta ORDER BY key').all() as Array<{ key: string; value: string }>;
      assert.deepEqual(rows.map((row) => row.key), ['instance_id', 'schema_version']);
      assert.equal(rows.find((row) => row.key === 'schema_version')?.value, '1');
      const strict = reader.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE '%STRICT%'`).all();
      assert.deepEqual(strict, [], 'every table is STRICT');
    } finally {
      reader.close();
    }
  });
});

test('a project and three entries of one writer survive close and reopen, and read back in seq order with their head', async () => {
  await withStoreDir(async (dir) => {
    const rows = chain(3);
    const first = await openHubStore(dir);
    newProject(first);
    first.appendEntries(PROJECT, rows);
    first.close();

    const store = await openHubStore(dir);
    try {
      assert.deepEqual(store.project(PROJECT), { project: PROJECT, genesisHash: GENESIS, anchor: canonicalize({ lead: 'fictional lead' }), enrolment: ENROLMENT, createdAt: T0 });
      const page = store.entriesFrom(PROJECT, PROJECT, WRITER, 0, PAGE);
      assert.equal(page.more, false);
      assert.deepEqual(page.entries.map((entry) => entry.seq), [0, 1, 2]);
      for (const [index, entry] of page.entries.entries()) {
        const row = rows[index]!;
        assert.equal(entry.hash, row.hash);
        assert.equal(entry.header, row.header);
        assert.equal(entry.body, row.body);
        assert.equal(entry.bodySize, Buffer.from(row.body, 'base64url').length);
        assert.equal(entry.receivedAt, row.receivedAt);
        assert.equal(entry.stream, PROJECT);
        assert.equal(entry.writer, WRITER);
      }
      assert.deepEqual(store.headOf(PROJECT, PROJECT, WRITER), { seq: 2, hash: rows[2]!.hash });
      assert.deepEqual(store.heads(PROJECT), [{ stream: PROJECT, heads: [{ writer: WRITER, seq: 2, hash: rows[2]!.hash }] }]);
      assert.equal(store.entryAt(PROJECT, PROJECT, WRITER, 1)?.hash, rows[1]!.hash);
      assert.equal(store.entryByHash(PROJECT, rows[2]!.hash)?.seq, 2);
      assert.equal(store.entriesFrom(PROJECT, PROJECT, WRITER, 1, PAGE).entries[0]?.seq, 1);
      assert.equal(store.headOf(PROJECT, PROJECT, sha256Hex(Buffer.from('nobody'))), undefined);
    } finally {
      store.close();
    }
  });
});

test('a second row at a used seq is refused seq-taken, the same row again hash-taken, and a refused batch stores nothing', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      newProject(store);
      const rows = chain(3);
      store.appendEntries(PROJECT, rows);
      const fork = makeRow(2, { prev: rows[1]!.hash, text: 'fork' });
      const next = makeRow(3, { prev: rows[2]!.hash });
      // The good row first and the bad one second: the whole batch is refused, so seq 3 is not kept either.
      assert.throws(() => store.appendEntries(PROJECT, [next, fork]), (error: unknown) => {
        refusal('seq-taken')(error);
        assert.equal((error as StoreError).index, 1);
        assertPlain(error, fork.hash, PROJECT, WRITER);
        return true;
      });
      assert.equal(store.entryAt(PROJECT, PROJECT, WRITER, 3), undefined, 'a refused batch stores nothing');
      assert.equal(store.entryAt(PROJECT, PROJECT, WRITER, 2)?.hash, rows[2]!.hash, 'the first entry at a place stays');
      assert.throws(() => store.appendEntries(PROJECT, [rows[2]!]), refusal('hash-taken'));
      // Two rows for one place inside one batch are refused as well.
      assert.throws(() => store.appendEntries(PROJECT, [next, makeRow(3, { prev: rows[2]!.hash, text: 'other' })]), refusal('seq-taken'));
      assert.equal(store.headOf(PROJECT, PROJECT, WRITER)?.seq, 2);
      store.appendEntries(PROJECT, [next]);
      assert.equal(store.headOf(PROJECT, PROJECT, WRITER)?.seq, 3);
    } finally {
      store.close();
    }
  });
});

test('entriesFrom pages by limit and by bytes, with more true, and never returns zero rows when one row fits', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      newProject(store);
      const rows = chain(3);
      store.appendEntries(PROJECT, rows);
      const byLimit = store.entriesFrom(PROJECT, PROJECT, WRITER, 0, { limit: 2, maxBytes: PAGE.maxBytes });
      assert.deepEqual(byLimit.entries.map((entry) => entry.seq), [0, 1]);
      assert.equal(byLimit.more, true);
      const oneRow = rows[0]!.header.length + rows[0]!.body.length;
      const byBytes = store.entriesFrom(PROJECT, PROJECT, WRITER, 0, { limit: 1000, maxBytes: oneRow + 10 });
      assert.deepEqual(byBytes.entries.map((entry) => entry.seq), [0]);
      assert.equal(byBytes.more, true);
      const tiny = store.entriesFrom(PROJECT, PROJECT, WRITER, 2, { limit: 1000, maxBytes: 1 });
      assert.deepEqual(tiny.entries.map((entry) => entry.seq), [2], 'the first row is always given, so a page never stalls');
      assert.equal(tiny.more, false);
      const past = store.entriesFrom(PROJECT, PROJECT, WRITER, 3, PAGE);
      assert.deepEqual(past, { entries: [], more: false });
    } finally {
      store.close();
    }
  });
});

test('rows are checked before any SQL: bad ids, a header that is not canonical or not a header, and a body too large are invalid-record', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      newProject(store);
      const good = makeRow(0);
      const header = JSON.parse(good.header) as EntryHeader;
      const cases: Array<[string, EntryRow]> = [
        ['stream not 32 hex', { ...good, header: canonicalize({ ...header, stream: 'ABC' }) }],
        ['writer not 64 hex', { ...good, header: canonicalize({ ...header, writer: 'x'.repeat(64) }) }],
        ['seq not whole', { ...good, header: good.header.replace('"seq":0', '"seq":1.5') }],
        ['header not canonical', { ...good, header: JSON.stringify(header, null, 1) }],
        ['header not JSON', { ...good, header: '{' }],
        ['header too large', { ...good, header: canonicalize({ ...header, extra: 'x'.repeat(5000) }) }],
        ['body not base64url', { ...good, body: '***' }],
        ['body hash differs', { ...good, body: Buffer.alloc(Buffer.from(good.body, 'base64url').length, 1).toString('base64url') }],
        ['body size differs', { ...good, body: Buffer.from('a shorter body').toString('base64url') }],
        ['body too large', { ...good, body: Buffer.alloc(16 * 1024 + 29).toString('base64url') }],
        ['received time negative', { ...good, receivedAt: -1 }],
      ];
      for (const [name, row] of cases) {
        assert.throws(() => store.appendEntries(PROJECT, [row]), (error: unknown) => {
          refusal('invalid-record')(error);
          assertPlain(error, PROJECT, WRITER, good.hash);
          return true;
        }, name);
      }
      assert.throws(() => store.appendEntries('not a project', [good]), refusal('invalid-record'));
      assert.throws(() => store.appendEntries(OTHER_PROJECT, [good]), refusal('unknown-project'));
      assert.deepEqual(store.heads(PROJECT), []);
    } finally {
      store.close();
    }
  });
});

test('a second project with the same id is refused project-exists and leaves the first as it was', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      newProject(store);
      assert.throws(
        () => store.createProject({ project: PROJECT, genesisHash: sha256Hex(Buffer.from('other genesis')), anchor: '{}', enrolment: ENROLMENT, at: T0 + 1 }),
        refusal('project-exists'),
      );
      assert.equal(store.project(PROJECT)?.genesisHash, GENESIS);
      assert.equal(store.project(OTHER_PROJECT), undefined);
    } finally {
      store.close();
    }
  });
});

test('entries are append-only in the schema itself: an UPDATE or DELETE from another connection is refused', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    newProject(store);
    store.appendEntries(PROJECT, chain(2));
    store.close();
    const db = new Database(path.join(dir, 'hub.db'));
    try {
      assert.throws(() => db.exec(`UPDATE entries SET body = 'changed'`), /append-only/);
      assert.throws(() => db.exec('DELETE FROM entries'), /append-only/);
      const count = db.prepare('SELECT count(*) AS total FROM entries').get() as { total: number };
      assert.equal(count.total, 2);
    } finally {
      db.close();
    }
  });
});

test('a database written by a newer hub schema is refused at open with a plain sentence', async () => {
  await withStoreDir(async (dir) => {
    (await openHubStore(dir)).close();
    const db = new Database(path.join(dir, 'hub.db'));
    db.exec('PRAGMA user_version = 9');
    db.close();
    await assert.rejects(openHubStore(dir), refusal('newer-schema'));
  });
});
