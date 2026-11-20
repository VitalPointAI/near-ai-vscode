import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'node:sqlite';
import test from 'node:test';
import { entryHash, sha256Hex, type EntryHeader } from '@ext/domain/replica/entry';
import { canonicalize } from '@ext/domain/team/canonical';
import { BLOB_SWEEP_AFTER_MS, INVITE_LOCK_AFTER, openHubStore, StoreError, STORE_REFUSALS, type EntryRow, type HubStore } from '../src/store/hubStore';
import { MIGRATIONS, SCHEMA_VERSION, migrate } from '../src/store/schema';

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
      assert.equal(store.schemaVersion(), SCHEMA_VERSION);
      assert.match(store.instanceId(), /^[0-9a-f-]{36}$/);
    } finally {
      store.close();
    }
  });
});

test('hub_meta holds the current schema version and an instance id that survives reopening', async () => {
  await withStoreDir(async (dir) => {
    const first = await openHubStore(dir);
    const id = first.instanceId();
    first.close();
    const second = await openHubStore(dir);
    try {
      assert.equal(second.instanceId(), id);
      assert.equal(second.schemaVersion(), SCHEMA_VERSION);
    } finally {
      second.close();
    }
    const reader = new Database(path.join(dir, 'hub.db'), { readOnly: true });
    try {
      const rows = reader.prepare('SELECT key, value FROM hub_meta ORDER BY key').all() as Array<{ key: string; value: string }>;
      assert.deepEqual(rows.map((row) => row.key), ['instance_id', 'schema_version']);
      assert.equal(rows.find((row) => row.key === 'schema_version')?.value, String(SCHEMA_VERSION));
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

// Task 2: blobs, grants, checkpoints, equivocations, enrolments, invitations and join requests.

const UPLOADER = sha256Hex(Buffer.from('fictional uploader'));
const OTHER_UPLOADER = sha256Hex(Buffer.from('fictional second uploader'));
const HOUR = 60 * 60 * 1000;

function blob(text: string): { hash: string; bytes: Buffer } {
  const bytes = Buffer.from(`sealed blob ${text}`);
  return { hash: sha256Hex(bytes), bytes };
}

/** A grant as the store keeps it: canonical JSON text whose sha256 is its hash (what grantHash computes). */
function grant(cell: string, epoch: number, note = 'one'): { hash: string; cell: string; epoch: number; body: string; receivedAt: number } {
  const body = canonicalize({ v: 1, purpose: 'staff-cell-grant', payload: { cell, epoch, note }, sig: SIG });
  return { hash: sha256Hex(Buffer.from(body)), cell, epoch, body, receivedAt: T0 };
}

function checkpoint(signedAt: number, note: string): { hash: string; body: string; signedAt: number; receivedAt: number } {
  const body = canonicalize({ payload: { project: PROJECT, note }, sig: SIG });
  return { hash: sha256Hex(Buffer.from(`checkpoint ${note}`)), body, signedAt, receivedAt: signedAt + 5 };
}

function proof(seq: number, note = 'a'): { proofHash: string; stream: string; writer: string; seq: number; proof: string; recordedAt: number } {
  return {
    proofHash: sha256Hex(Buffer.from(`proof ${seq} ${note}`)),
    stream: PROJECT,
    writer: WRITER,
    seq,
    proof: canonicalize({ a: { seq }, b: { seq, note } }),
    recordedAt: T0 + seq,
  };
}

async function filesUnder(folder: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(path.relative(folder, path.join(entry.parentPath, entry.name)));
  }
  return out.sort();
}

test('putBlob keeps the file at blobs/<project>/<hash> and its row, readBlob gives the same bytes, a second put is held, another project reads nothing', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      newProject(store);
      newProject(store, OTHER_PROJECT);
      const one = blob('one');
      assert.equal(await store.putBlob(PROJECT, one.hash, one.bytes, UPLOADER, T0), 'stored');
      const file = path.join(dir, 'blobs', PROJECT, one.hash);
      assert.deepEqual(await readFile(file), one.bytes);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(path.join(dir, 'blobs', PROJECT))).mode & 0o777, 0o700);
      assert.deepEqual(await store.readBlob(PROJECT, one.hash), one.bytes);
      assert.deepEqual(store.blobInfo(PROJECT, one.hash), { hash: one.hash, size: one.bytes.length, uploadedBy: UPLOADER, uploadedAt: T0, referencedAt: undefined });
      assert.equal(await store.putBlob(PROJECT, one.hash, one.bytes, OTHER_UPLOADER, T0 + 1), 'held');
      assert.equal(store.blobInfo(PROJECT, one.hash)?.uploadedBy, UPLOADER, 'a held blob keeps its first upload');
      assert.equal(await store.readBlob(OTHER_PROJECT, one.hash), undefined, 'one project never reads another project\'s blob');
      assert.equal(store.blobInfo(OTHER_PROJECT, one.hash), undefined);
      await assert.rejects(store.putBlob(sha256Hex(Buffer.from('no such project')).slice(0, 32), one.hash, one.bytes, UPLOADER, T0), refusal('unknown-project'));
    } finally {
      store.close();
    }
  });
});

test('a blob whose bytes do not hash to its name is refused blob-mismatch and writes nothing, not even a temporary file', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      newProject(store);
      const one = blob('one');
      const two = blob('two');
      await assert.rejects(store.putBlob(PROJECT, one.hash, two.bytes, UPLOADER, T0), (error: unknown) => {
        refusal('blob-mismatch')(error);
        assertPlain(error, one.hash, two.hash, PROJECT);
        return true;
      });
      assert.equal(store.blobInfo(PROJECT, one.hash), undefined);
      assert.deepEqual(await filesUnder(path.join(dir, 'blobs')), []);
    } finally {
      store.close();
    }
  });
});

test('a blob of 8 MiB is kept and one of 8 MiB plus one byte is refused blob-too-large', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      newProject(store);
      const largest = Buffer.alloc(8 * 1024 * 1024, 3);
      assert.equal(await store.putBlob(PROJECT, sha256Hex(largest), largest, UPLOADER, T0), 'stored');
      const tooLarge = Buffer.alloc(8 * 1024 * 1024 + 1, 3);
      await assert.rejects(store.putBlob(PROJECT, sha256Hex(tooLarge), tooLarge, UPLOADER, T0), refusal('blob-too-large'));
      assert.equal(store.blobInfo(PROJECT, sha256Hex(tooLarge)), undefined);
      assert.equal((await store.readBlob(PROJECT, sha256Hex(largest)))?.length, largest.length);
    } finally {
      store.close();
    }
  });
});

test('sweepBlobs removes the rows and files of blobs unreferenced 24 hours after upload, keeps referenced and younger ones, and counts what it removed', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      newProject(store);
      const [entry] = chain(1);
      store.appendEntries(PROJECT, [entry!]);
      const referenced = blob('referenced');
      const abandoned = blob('abandoned');
      const young = blob('young');
      await store.putBlob(PROJECT, referenced.hash, referenced.bytes, UPLOADER, T0);
      await store.putBlob(PROJECT, abandoned.hash, abandoned.bytes, UPLOADER, T0);
      await store.putBlob(PROJECT, young.hash, young.bytes, OTHER_UPLOADER, T0 + 2 * HOUR);
      assert.equal(store.unreferencedBytesOf(PROJECT, UPLOADER), referenced.bytes.length + abandoned.bytes.length);
      store.referenceBlobs(PROJECT, [{ entry: entry!.hash, blob: referenced.hash, stream: PROJECT }], T0 + HOUR);
      assert.equal(store.blobInfo(PROJECT, referenced.hash)?.referencedAt, T0 + HOUR);
      assert.equal(store.unreferencedBytesOf(PROJECT, UPLOADER), abandoned.bytes.length, 'a referenced blob is no longer pending');
      assert.equal(store.unreferencedBytesOf(PROJECT, OTHER_UPLOADER), young.bytes.length);

      assert.equal(BLOB_SWEEP_AFTER_MS, 24 * HOUR);
      assert.equal(await store.sweepBlobs(T0 + 24 * HOUR - 1), 0, 'nothing is removed before 24 hours');
      assert.equal(await store.sweepBlobs(T0 + 24 * HOUR), 1);
      assert.equal(store.blobInfo(PROJECT, abandoned.hash), undefined);
      assert.equal(await store.readBlob(PROJECT, abandoned.hash), undefined);
      assert.deepEqual(await filesUnder(path.join(dir, 'blobs')), [path.join(PROJECT, referenced.hash), path.join(PROJECT, young.hash)].sort());
      assert.equal(store.unreferencedBytesOf(PROJECT, UPLOADER), 0);
      // Long after: the referenced blob is kept for the life of the project.
      assert.equal(await store.sweepBlobs(T0 + 100 * BLOB_SWEEP_AFTER_MS), 1, 'the young one is removed once it is 24 hours old');
      assert.deepEqual(await store.readBlob(PROJECT, referenced.hash), referenced.bytes);
      // A reference to a blob the hub does not hold is blob-missing, and the second reference to the same blob changes nothing.
      assert.throws(() => store.referenceBlobs(PROJECT, [{ entry: entry!.hash, blob: abandoned.hash, stream: PROJECT }], T0), refusal('blob-missing'));
      store.referenceBlobs(PROJECT, [{ entry: entry!.hash, blob: referenced.hash, stream: PROJECT }], T0 + 9 * HOUR);
      assert.equal(store.blobInfo(PROJECT, referenced.hash)?.referencedAt, T0 + HOUR, 'the first reference time stays');
    } finally {
      store.close();
    }
  });
});

test('a referenced blob row cannot be deleted even from another connection, so no sweep or bug can drop it', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    newProject(store);
    const [entry] = chain(1);
    store.appendEntries(PROJECT, [entry!]);
    const one = blob('one');
    await store.putBlob(PROJECT, one.hash, one.bytes, UPLOADER, T0);
    store.referenceBlobs(PROJECT, [{ entry: entry!.hash, blob: one.hash, stream: PROJECT }], T0);
    store.close();
    const db = new Database(path.join(dir, 'hub.db'));
    try {
      assert.throws(() => db.exec('DELETE FROM blobs'), /kept for the life/);
      assert.throws(() => db.exec('UPDATE blobs SET referenced_at = NULL'), /first reference time/);
      assert.throws(() => db.exec('DELETE FROM blob_refs'), /append-only/);
    } finally {
      db.close();
    }
  });
});

test('on open, a blob file with no row and a stale temporary file are removed and counted, and a row whose file is missing makes the store report itself damaged', async () => {
  await withStoreDir(async (dir) => {
    const first = await openHubStore(dir);
    newProject(first);
    const kept = blob('kept');
    const lost = blob('lost');
    await first.putBlob(PROJECT, kept.hash, kept.bytes, UPLOADER, T0);
    await first.putBlob(PROJECT, lost.hash, lost.bytes, UPLOADER, T0);
    assert.deepEqual(first.openReport, { orphanBlobsRemoved: 0, temporaryFilesRemoved: 0, missingBlobFiles: 0, damaged: undefined });
    first.close();

    const orphan = blob('orphan');
    await writeFile(path.join(dir, 'blobs', PROJECT, orphan.hash), orphan.bytes, { mode: 0o600 });
    await writeFile(path.join(dir, 'blobs', PROJECT, `.${kept.hash}.0a1b2c3d.tmp`), 'half a blob', { mode: 0o600 });
    await rm(path.join(dir, 'blobs', PROJECT, lost.hash));

    const store = await openHubStore(dir);
    try {
      assert.equal(store.openReport.orphanBlobsRemoved, 1);
      assert.equal(store.openReport.temporaryFilesRemoved, 1);
      assert.equal(store.openReport.missingBlobFiles, 1);
      assert.equal(store.openReport.damaged, STORE_REFUSALS['damaged-store']);
      assert.equal(store.damaged(), STORE_REFUSALS['damaged-store']);
      assert.deepEqual(await filesUnder(path.join(dir, 'blobs')), [path.join(PROJECT, kept.hash)]);
      // The row is not silently dropped: it is still there, and reading it says the store is damaged.
      assert.ok(store.blobInfo(PROJECT, lost.hash));
      await assert.rejects(store.readBlob(PROJECT, lost.hash), refusal('damaged-store'));
      assert.deepEqual(await store.readBlob(PROJECT, kept.hash), kept.bytes);
    } finally {
      store.close();
    }
  });
});

test('a blob file whose bytes changed on disk is reported as damage when read, never served', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      newProject(store);
      const one = blob('one');
      await store.putBlob(PROJECT, one.hash, one.bytes, UPLOADER, T0);
      await writeFile(path.join(dir, 'blobs', PROJECT, one.hash), 'changed bytes');
      assert.equal(store.damaged(), undefined);
      await assert.rejects(store.readBlob(PROJECT, one.hash), refusal('damaged-store'));
      assert.equal(store.damaged(), STORE_REFUSALS['damaged-store']);
    } finally {
      store.close();
    }
  });
});

test('a symbolic link in place of a project blob folder is refused, on write and on open', async () => {
  await withStoreDir(async (dir) => {
    const outside = path.join(dir, 'outside');
    await mkdir(outside, { mode: 0o700 });
    const store = await openHubStore(dir);
    newProject(store);
    await symlink(outside, path.join(dir, 'blobs', PROJECT));
    const one = blob('one');
    try {
      await assert.rejects(store.putBlob(PROJECT, one.hash, one.bytes, UPLOADER, T0), refusal('damaged-store'));
      assert.deepEqual(await readdir(outside), [], 'nothing was written through the link');
    } finally {
      store.close();
    }
    await assert.rejects(openHubStore(dir), refusal('damaged-store'));
  });
});

test('putGrant keeps canonical grants by hash, refuses a body that does not hash to its name, and grants() lists them', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      newProject(store);
      const base = grant(PROJECT, 1);
      const later = grant(PROJECT, 2);
      assert.equal(store.putGrant(PROJECT, base), 'stored');
      assert.equal(store.putGrant(PROJECT, later), 'stored');
      assert.equal(store.putGrant(PROJECT, base), 'held');
      assert.deepEqual(store.grants(PROJECT).map((item) => [item.hash, item.cell, item.epoch]), [
        [base.hash, PROJECT, 1],
        [later.hash, PROJECT, 2],
      ]);
      assert.equal(store.grant(PROJECT, base.hash)?.body, base.body);
      assert.equal(store.grant(OTHER_PROJECT, base.hash), undefined);
      assert.throws(() => store.putGrant(PROJECT, { ...base, hash: later.hash }), refusal('invalid-record'));
      assert.throws(() => store.putGrant(PROJECT, { ...base, body: JSON.stringify(JSON.parse(base.body), null, 1) }), refusal('invalid-record'));
      assert.throws(() => store.putGrant(PROJECT, { ...base, epoch: 0 }), refusal('invalid-record'));
      assert.throws(() => store.putGrant(OTHER_PROJECT, base), refusal('unknown-project'));
    } finally {
      store.close();
    }
  });
});

test('every checkpoint is kept as evidence, idempotent by hash, listed in signing order, and the latest is the last signed', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      newProject(store);
      assert.equal(store.latestCheckpoint(PROJECT), undefined);
      const second = checkpoint(T0 + 60_000, 'second');
      const first = checkpoint(T0, 'first');
      assert.equal(store.putCheckpoint(PROJECT, second), 'stored');
      assert.equal(store.putCheckpoint(PROJECT, first), 'stored');
      assert.equal(store.putCheckpoint(PROJECT, first), 'held');
      assert.deepEqual(store.checkpoints(PROJECT).map((item) => item.hash), [first.hash, second.hash]);
      assert.deepEqual(store.latestCheckpoint(PROJECT), { hash: second.hash, body: second.body, signedAt: second.signedAt, receivedAt: second.receivedAt });
      assert.throws(() => store.putCheckpoint(PROJECT, { ...first, hash: sha256Hex(Buffer.from('another')), body: 'not json' }), refusal('invalid-record'));
    } finally {
      store.close();
    }
  });
});

/** A signed-checkpoint body whose payload reads as a version 2 checkpoint covering count entries of one stream (the signature is not checked here). */
function coveringCheckpoint(count: number, note: string): { hash: string; body: string } {
  const head = { writer: WRITER, seq: count - 1, hash: sha256Hex(Buffer.from(`head ${note}`)), lamport: count, roster: GENESIS };
  const payload = { type: 'checkpoint', v: 2, project: PROJECT, signer: WRITER, rosterHead: GENESIS, streams: [{ stream: PROJECT, heads: [head], count, orderTip: sha256Hex(Buffer.from(`tip ${note}`)) }] };
  return { hash: sha256Hex(Buffer.from(`covering ${note}`)), body: canonicalize({ payload, sig: SIG }) };
}

test('WR-05: a handed-back checkpoint is placed by its coverage with no other body read, and checkpointsAfter reads only what was kept since a cursor', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      newProject(store);
      const five = coveringCheckpoint(5, 'five');
      const ten = coveringCheckpoint(10, 'ten');
      assert.equal(store.putCheckpoint(PROJECT, { ...five, signedAt: T0, receivedAt: T0 }), 'stored');
      assert.equal(store.putCheckpoint(PROJECT, { ...ten, signedAt: T0 + 60_000, receivedAt: T0 + 60_000 }), 'stored');
      const first = store.checkpointsAfter(PROJECT, 0);
      assert.deepEqual(first.map((item) => item.hash), [five.hash, ten.hash]);
      const cursor = (first[1] as { cursor: number }).cursor;
      assert.deepEqual(store.checkpointsAfter(PROJECT, cursor), []);

      // Covering 7: just below the earliest kept checkpoint covering at least as much (ten).
      const seven = coveringCheckpoint(7, 'seven');
      assert.equal(store.putHandedBackCheckpoint(PROJECT, seven, T0 + 120_000), 'stored');
      assert.equal(store.putHandedBackCheckpoint(PROJECT, seven, T0 + 120_000), 'held');
      // Covering 12: after every kept one, and not before now.
      const twelve = coveringCheckpoint(12, 'twelve');
      assert.equal(store.putHandedBackCheckpoint(PROJECT, twelve, T0 + 30_000), 'stored');
      const listed = store.checkpoints(PROJECT);
      assert.deepEqual(listed.map((item) => item.hash), [five.hash, seven.hash, ten.hash, twelve.hash]);
      assert.equal(listed[1]?.signedAt, T0 + 60_000 - 1);
      assert.equal(listed[3]?.signedAt, T0 + 60_000 + 1);
      assert.equal(store.latestCheckpoint(PROJECT)?.hash, twelve.hash);
      // Only the two handed back since the cursor are read again.
      assert.deepEqual(store.checkpointsAfter(PROJECT, cursor).map((item) => item.hash), [seven.hash, twelve.hash]);
      assert.throws(() => store.checkpointsAfter(PROJECT, -1), refusal('invalid-record'));
    } finally {
      store.close();
    }
  });
});

test('WR-05, WR-02: a version 1 store with kept checkpoints is brought to the current schema with each checkpoint\'s coverage and covered heads filled from its body', async () => {
  await withStoreDir(async (dir) => {
    const db = new Database(path.join(dir, 'hub.db'));
    migrate(db, MIGRATIONS.slice(0, 1));
    db.prepare('INSERT INTO projects (project, genesis_hash, anchor, enrolment, created_at) VALUES (?, ?, ?, ?, ?)').run(PROJECT, GENESIS, canonicalize({ lead: 'fictional lead' }), ENROLMENT, T0);
    const nine = coveringCheckpoint(9, 'nine');
    const old = checkpoint(T0, 'not a checkpoint payload');
    db.prepare('INSERT INTO checkpoints (project, hash, body, signed_at, received_at) VALUES (?, ?, ?, ?, ?)').run(PROJECT, nine.hash, nine.body, T0 + 1, T0 + 1);
    db.prepare('INSERT INTO checkpoints (project, hash, body, signed_at, received_at) VALUES (?, ?, ?, ?, ?)').run(PROJECT, old.hash, old.body, T0, T0);
    db.close();
    const store = await openHubStore(dir);
    try {
      assert.equal(store.schemaVersion(), SCHEMA_VERSION);
      // A handed-back checkpoint covering 4 goes below the one covering 9, which the migration read from its body.
      const four = coveringCheckpoint(4, 'four');
      assert.equal(store.putHandedBackCheckpoint(PROJECT, four, T0 + 60_000), 'stored');
      assert.deepEqual(store.checkpoints(PROJECT).map((item) => item.hash), [old.hash, four.hash, nine.hash]);
      // WR-02: the furthest head a kept checkpoint names, read from the body kept before the upgrade too, and never moved back by a smaller one.
      assert.deepEqual(store.coveredHead(PROJECT, PROJECT, WRITER), { seq: 8, hash: sha256Hex(Buffer.from('head nine')) });
      assert.equal(store.coveredHead(PROJECT, PROJECT, sha256Hex(Buffer.from('another writer'))), undefined);
      const twenty = coveringCheckpoint(20, 'twenty');
      assert.equal(store.putCheckpoint(PROJECT, { ...twenty, signedAt: T0 + 120_000, receivedAt: T0 + 120_000 }), 'stored');
      assert.deepEqual(store.coveredHead(PROJECT, PROJECT, WRITER), { seq: 19, hash: sha256Hex(Buffer.from('head twenty')) });
      assert.equal(store.putHandedBackCheckpoint(PROJECT, coveringCheckpoint(2, 'two'), T0 + 180_000), 'stored');
      assert.deepEqual(store.coveredHead(PROJECT, PROJECT, WRITER), { seq: 19, hash: sha256Hex(Buffer.from('head twenty')) });
    } finally {
      store.close();
    }
  });
});

test('putEquivocation keeps each proof once by its hash, and equivocations() lists them', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      newProject(store);
      assert.equal(store.putEquivocation(PROJECT, proof(4)), 'stored');
      assert.equal(store.putEquivocation(PROJECT, proof(4)), 'held');
      assert.equal(store.putEquivocation(PROJECT, proof(7)), 'stored');
      assert.deepEqual(store.equivocations(PROJECT).map((item) => [item.writer, item.seq]), [
        [WRITER, 4],
        [WRITER, 7],
      ]);
      assert.throws(() => store.putEquivocation(PROJECT, { ...proof(9), writer: 'nobody' }), refusal('invalid-record'));
    } finally {
      store.close();
    }
  });
});

test('an enrolment keeps only its secret hash; enrolProject stores project, entries, grants and blobs in one go and uses the enrolment', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      const secretHash = sha256Hex(Buffer.from('fictional enrolment secret'));
      store.putEnrolment({ enrolment: ENROLMENT, secretHash, expiresAt: T0 + 7 * 24 * HOUR, createdAt: T0 });
      assert.deepEqual(store.enrolment(ENROLMENT), { enrolment: ENROLMENT, secretHash, expiresAt: T0 + 7 * 24 * HOUR, createdAt: T0, usedAt: undefined, project: undefined });
      assert.throws(() => store.putEnrolment({ enrolment: ENROLMENT, secretHash, expiresAt: T0, createdAt: T0 }), refusal('invalid-record'));
      const rows = chain(2);
      const base = grant(PROJECT, 1);
      const one = blob('one');
      await store.enrolProject({
        project: { project: PROJECT, genesisHash: rows[0]!.hash, anchor: canonicalize({ lead: 'fictional lead' }) },
        entries: rows,
        grants: [base],
        blobs: [{ hash: one.hash, bytes: one.bytes, uploadedBy: WRITER }],
        blobRefs: [{ entry: rows[1]!.hash, blob: one.hash, stream: PROJECT }],
        enrolment: ENROLMENT,
        at: T0 + 10,
      });
      assert.equal(store.project(PROJECT)?.genesisHash, rows[0]!.hash);
      assert.equal(store.project(PROJECT)?.enrolment, ENROLMENT);
      assert.equal(store.headOf(PROJECT, PROJECT, WRITER)?.seq, 1);
      assert.equal(store.grants(PROJECT).length, 1);
      assert.deepEqual(await store.readBlob(PROJECT, one.hash), one.bytes);
      assert.equal(store.blobInfo(PROJECT, one.hash)?.referencedAt, T0 + 10);
      assert.deepEqual(store.enrolment(ENROLMENT), { enrolment: ENROLMENT, secretHash, expiresAt: T0 + 7 * 24 * HOUR, createdAt: T0, usedAt: T0 + 10, project: PROJECT });
    } finally {
      store.close();
    }
  });
});

test('enrolProject refuses enrolment-used and project-exists and leaves nothing behind: no project, no entry, no grant, no blob file', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      const secretHash = sha256Hex(Buffer.from('fictional enrolment secret'));
      const second = 'enr-fedcba9876543210';
      store.putEnrolment({ enrolment: ENROLMENT, secretHash, expiresAt: T0 + HOUR, createdAt: T0 });
      store.putEnrolment({ enrolment: second, secretHash: sha256Hex(Buffer.from('second secret')), expiresAt: T0 + HOUR, createdAt: T0 });
      const anchor = canonicalize({ lead: 'fictional lead' });
      const rows = chain(1);
      await store.enrolProject({ project: { project: PROJECT, genesisHash: rows[0]!.hash, anchor }, entries: rows, grants: [], blobs: [], enrolment: ENROLMENT, at: T0 });

      const otherRows = chain(1, { stream: OTHER_PROJECT });
      const extra = blob('extra');
      // The enrolment is used: a second project through it is refused, and its blob file is not left behind.
      await assert.rejects(
        store.enrolProject({
          project: { project: OTHER_PROJECT, genesisHash: otherRows[0]!.hash, anchor },
          entries: otherRows,
          grants: [grant(OTHER_PROJECT, 1)],
          blobs: [{ hash: extra.hash, bytes: extra.bytes, uploadedBy: WRITER }],
          enrolment: ENROLMENT,
          at: T0 + 1,
        }),
        (error: unknown) => {
          refusal('enrolment-used')(error);
          assertPlain(error, ENROLMENT, OTHER_PROJECT);
          return true;
        },
      );
      assert.equal(store.project(OTHER_PROJECT), undefined);
      // The project exists: a second enrolment for it is refused and stays unused.
      await assert.rejects(
        store.enrolProject({
          project: { project: PROJECT, genesisHash: rows[0]!.hash, anchor },
          entries: [makeRow(1, { prev: rows[0]!.hash })],
          grants: [],
          blobs: [{ hash: extra.hash, bytes: extra.bytes, uploadedBy: WRITER }],
          enrolment: second,
          at: T0 + 2,
        }),
        refusal('project-exists'),
      );
      assert.equal(store.enrolment(second)?.usedAt, undefined);
      assert.equal(store.headOf(PROJECT, PROJECT, WRITER)?.seq, 0);
      assert.equal(store.blobInfo(PROJECT, extra.hash), undefined);
      // A batch with one bad row is refused whole after the blob files were written: the files go too.
      await assert.rejects(
        store.enrolProject({
          project: { project: OTHER_PROJECT, genesisHash: otherRows[0]!.hash, anchor },
          entries: [...otherRows, otherRows[0]!],
          grants: [],
          blobs: [{ hash: extra.hash, bytes: extra.bytes, uploadedBy: WRITER }],
          enrolment: second,
          at: T0 + 3,
        }),
        refusal('hash-taken'),
      );
      assert.equal(store.project(OTHER_PROJECT), undefined);
      assert.equal(store.enrolment(second)?.usedAt, undefined);
      assert.deepEqual(await filesUnder(path.join(dir, 'blobs')), []);
      await assert.rejects(
        store.enrolProject({ project: { project: OTHER_PROJECT, genesisHash: otherRows[0]!.hash, anchor }, entries: otherRows, grants: [], blobs: [], enrolment: 'enr-0000000000000000', at: T0 }),
        refusal('not-found'),
      );
    } finally {
      store.close();
    }
  });
});

test('commitAppend writes entries, grants, equivocation proofs and blob references in one transaction, and one bad part stores nothing', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      newProject(store);
      const rows = chain(3);
      const one = blob('one');
      await store.putBlob(PROJECT, one.hash, one.bytes, UPLOADER, T0);
      const base = grant(PROJECT, 1);
      const accepted = store.commitAppend(PROJECT, {
        entries: rows.slice(0, 2),
        grants: [base],
        equivocations: [proof(1)],
        blobRefs: [{ entry: rows[1]!.hash, blob: one.hash, stream: PROJECT }],
        at: T0 + 5,
      });
      assert.deepEqual(accepted.map((entry) => entry.hash), [rows[0]!.hash, rows[1]!.hash]);
      assert.equal(store.blobInfo(PROJECT, one.hash)?.referencedAt, T0 + 5);
      assert.equal(store.grants(PROJECT).length, 1);
      assert.equal(store.equivocations(PROJECT).length, 1);

      const missing = blob('missing');
      const tries: Array<[string, Parameters<HubStore['commitAppend']>[1], keyof typeof STORE_REFUSALS]> = [
        ['a blob the hub does not hold', { entries: [rows[2]!], grants: [grant(PROJECT, 2)], equivocations: [proof(2)], blobRefs: [{ entry: rows[2]!.hash, blob: missing.hash, stream: PROJECT }], at: T0 + 6 }, 'blob-missing'],
        ['a malformed grant', { entries: [rows[2]!], grants: [{ ...grant(PROJECT, 2), hash: base.hash }], equivocations: [], blobRefs: [], at: T0 + 6 }, 'invalid-record'],
        ['a malformed proof', { entries: [rows[2]!], grants: [grant(PROJECT, 2)], equivocations: [{ ...proof(2), seq: -1 }], blobRefs: [], at: T0 + 6 }, 'invalid-record'],
        ['a reference to an entry the hub does not keep', { entries: [rows[2]!], grants: [], equivocations: [], blobRefs: [{ entry: sha256Hex(Buffer.from('no entry')), blob: one.hash, stream: PROJECT }], at: T0 + 6 }, 'invalid-record'],
        ['an entry at a used place', { entries: [rows[2]!, makeRow(0, { text: 'fork' })], grants: [grant(PROJECT, 2)], equivocations: [proof(2)], blobRefs: [], at: T0 + 6 }, 'seq-taken'],
      ];
      for (const [name, batch, id] of tries) {
        assert.throws(() => store.commitAppend(PROJECT, batch), refusal(id), name);
        assert.equal(store.headOf(PROJECT, PROJECT, WRITER)?.seq, 1, `${name}: no entry was stored`);
        assert.equal(store.grants(PROJECT).length, 1, `${name}: no grant was stored`);
        assert.equal(store.equivocations(PROJECT).length, 1, `${name}: no proof was stored`);
      }
      assert.throws(() => store.commitAppend(OTHER_PROJECT, { entries: [], at: T0 }), refusal('unknown-project'));
    } finally {
      store.close();
    }
  });
});

test('an invitation keeps its check key only, counts failed checks, locks at 5 and is used once', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      newProject(store);
      const checkKey = Buffer.alloc(32, 9).toString('base64url');
      const invite = { project: PROJECT, invite: 'fictional-invite', expiresAt: T0 + HOUR, checkKey, registeredBy: WRITER, registeredAt: T0 };
      assert.equal(store.putInvite(invite), 'stored');
      assert.equal(store.putInvite({ ...invite, expiresAt: T0 + 2 * HOUR, registeredAt: T0 + 1 }), 'held', 'registering the same invitation again keeps it, with the new expiry');
      assert.equal(store.invite(PROJECT, 'fictional-invite')?.expiresAt, T0 + 2 * HOUR);
      assert.throws(() => store.putInvite({ ...invite, checkKey: Buffer.alloc(32, 8).toString('base64url') }), refusal('invalid-record'));
      assert.throws(() => store.putInvite({ ...invite, checkKey: 'short' }), refusal('invalid-record'));
      assert.throws(() => store.putInvite({ ...invite, project: OTHER_PROJECT }), refusal('unknown-project'));
      assert.equal(INVITE_LOCK_AFTER, 5);
      for (let n = 1; n <= 4; n += 1) assert.equal(store.recordInviteFailure(PROJECT, 'fictional-invite', T0 + n), n);
      assert.equal(store.invite(PROJECT, 'fictional-invite')?.lockedAt, undefined);
      assert.equal(store.recordInviteFailure(PROJECT, 'fictional-invite', T0 + 5), 5);
      assert.equal(store.invite(PROJECT, 'fictional-invite')?.lockedAt, T0 + 5);
      assert.equal(store.recordInviteFailure(PROJECT, 'fictional-invite', T0 + 6), 6);
      assert.equal(store.invite(PROJECT, 'fictional-invite')?.lockedAt, T0 + 5, 'the lock time stays the first');
      assert.equal(store.useInvite(PROJECT, 'fictional-invite', T0 + 7), false, 'a locked invitation is not used');
      assert.throws(() => store.recordInviteFailure(PROJECT, 'no-such-invite', T0), refusal('not-found'));

      store.putInvite({ ...invite, invite: 'second-invite' });
      assert.equal(store.useInvite(PROJECT, 'second-invite', T0 + 8), true);
      assert.equal(store.useInvite(PROJECT, 'second-invite', T0 + 9), false);
      assert.equal(store.invite(PROJECT, 'second-invite')?.usedAt, T0 + 8);
    } finally {
      store.close();
    }
  });
});

test('join requests are kept once by hash, listed, accepted, and removeAcceptedBefore removes accepted requests older than the cutoff only', async () => {
  await withStoreDir(async (dir) => {
    const store = await openHubStore(dir);
    try {
      newProject(store);
      store.putInvite({ project: PROJECT, invite: 'fictional-invite', expiresAt: T0 + HOUR, checkKey: Buffer.alloc(32, 9).toString('base64url'), registeredBy: WRITER, registeredAt: T0 });
      const request = (note: string, at: number) => ({
        project: PROJECT,
        requestHash: sha256Hex(Buffer.from(`request ${note}`)),
        invite: 'fictional-invite',
        body: canonicalize({ note }),
        receivedAt: at,
      });
      const old = request('old', T0);
      const recent = request('recent', T0 + 1);
      const open = request('open', T0 + 2);
      assert.equal(store.putJoinRequest(old), 'stored');
      assert.equal(store.putJoinRequest(old), 'held');
      store.putJoinRequest(recent);
      store.putJoinRequest(open);
      assert.throws(() => store.putJoinRequest({ ...request('stray', T0), invite: 'no-such-invite' }), refusal('not-found'));
      assert.deepEqual(store.joinRequests(PROJECT).map((item) => item.requestHash), [old.requestHash, recent.requestHash, open.requestHash]);
      assert.equal(store.acceptJoinRequest(PROJECT, old.requestHash, T0 + HOUR), true);
      assert.equal(store.acceptJoinRequest(PROJECT, old.requestHash, T0 + 2 * HOUR), false, 'accepting twice changes nothing');
      assert.equal(store.acceptJoinRequest(PROJECT, recent.requestHash, T0 + 5 * HOUR), true);
      assert.throws(() => store.acceptJoinRequest(PROJECT, sha256Hex(Buffer.from('nothing')), T0), refusal('not-found'));
      assert.equal(store.removeAcceptedBefore(T0 + 3 * HOUR), 1);
      assert.deepEqual(store.joinRequests(PROJECT).map((item) => [item.requestHash, item.acceptedAt]), [
        [recent.requestHash, T0 + 5 * HOUR],
        [open.requestHash, undefined],
      ]);
      assert.equal(store.removeAcceptedBefore(T0 + 100 * HOUR), 1, 'a request never accepted is never removed by age');
      assert.deepEqual(store.joinRequests(PROJECT).map((item) => item.requestHash), [open.requestHash]);
    } finally {
      store.close();
    }
  });
});

test('every store refusal is one plain sentence with no dash used as punctuation', () => {
  for (const [id, sentence] of Object.entries(STORE_REFUSALS)) {
    assert.match(sentence, /^[A-Z].*\.$/, id);
    assert.ok(!sentence.includes(String.fromCharCode(0x2014)) && !sentence.includes(' - '), id);
  }
});
