// Copied from relay/test/killDrill.test.ts and adapted for the hub (D-26, D-28).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { entryHash, sha256Hex, type EntryHeader } from '@ext/domain/replica/entry';
import { canonicalize } from '@ext/domain/team/canonical';
import { openHubStore } from '../src/store/hubStore';

// Phase 32, plan 18 (D-26): the hub store's kill -9 drill. 15 rounds, each on a fresh state directory: a child process (fixtures/hubCrashWriter)
// runs steps through the real store module, each step one blob and then a batch of three entries that reference it, and prints `ack N` only
// after both committed. The parent kills it with SIGKILL just after the permit that follows the kill point, reopens the store and checks that
// every acknowledged batch and blob survived with the right bytes, that at most one unacknowledged step is extra and its batch is whole, that
// nothing is duplicated, that every blob row has a file whose sha256 is its name, that no temporary file is left, and that SQLite's own
// integrity check passes.
//
// What the drill proves: a batch is written atomically; nothing is acknowledged before its COMMIT; a database killed in the middle of a write
// recovers from its write-ahead log on the next open; and a blob file is written before its row, so a kill leaves at most a file with no row,
// which the next open removes, never a row with no file.
// What it does not prove: survival of power loss or an operating system crash. SIGKILL ends the process, not the machine, so the drill passes
// under any synchronous setting and without any fsync. That is why the store sets PRAGMA synchronous = FULL and fsyncs each blob file and its
// folder, which is not something a test on a temporary folder can show.
//
// For later plans: a test that runs the built hub itself as a child with secret files uses test/helpers/hubProcess.ts (32-14), and the
// process-level hard kill of the real hub, with acknowledged appends over HTTP, is in test/api.test.ts (32-20). Look there before writing another.

const CHILD = fileURLToPath(new URL('./fixtures/hubCrashWriter.js', import.meta.url));
const ROUNDS = 15;
const ROUND_TIMEOUT_MS = 60_000;

// The same pure functions as the child's (fixtures/hubCrashWriter.ts), so the drill knows what step N wrote.
const DRILL_PROJECT = sha256Hex(Buffer.from('fictional drill project')).slice(0, 32);
const DRILL_WRITER = sha256Hex(Buffer.from('fictional drill device'));
const SIG = Buffer.alloc(64, 5).toString('base64url');
const BLOB_BYTES = 32 * 1024;

function drillBlob(step: number): { hash: string; bytes: Buffer } {
  const bytes = Buffer.alloc(BLOB_BYTES, `drill blob ${step};`);
  return { hash: sha256Hex(bytes), bytes };
}

function drillRows(step: number, prev: string): Array<{ header: string; body: string; hash: string }> {
  const rows = [];
  for (let seq = 3 * (step - 1); seq < 3 * step; seq += 1) {
    const wire = Buffer.from(`drill entry ${seq}`.padEnd(48, '.'));
    const header: EntryHeader = {
      v: 2,
      stream: DRILL_PROJECT,
      writer: DRILL_WRITER,
      seq,
      prev,
      epoch: 1,
      body: { hash: sha256Hex(wire), size: wire.length },
      sig: SIG,
    };
    const hash = entryHash(header);
    rows.push({ header: canonicalize(header), body: wire.toString('base64url'), hash });
    prev = hash;
  }
  return rows;
}

interface Killed {
  acked: number;
  signal: NodeJS.Signals | null;
}

/**
 * Waits this many microseconds without yielding. The child is a separate process, so it keeps running meanwhile. Without a wait the SIGKILL
 * reaches the child before it has even read its permit, and every round would stop between steps; with a different wait per round the kill lands
 * at different points inside the next step (in the blob file write, between the file and its row, inside the batch).
 */
function spin(micros: number): void {
  const until = process.hrtime.bigint() + BigInt(micros) * 1000n;
  while (process.hrtime.bigint() < until) {
    // busy wait on purpose: a timer would let this process's own work run first and cannot wait less than a millisecond
  }
}

/**
 * Starts the writer, gives it one step at a time, and kills it (by the pid this test spawned) once it has acknowledged `killAt`: the permit for
 * the next step is written, then after `delayMicros` the child is killed with SIGKILL.
 */
function runUntilKilled(dir: string, killAt: number, delayMicros: number): Promise<Killed> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, dir], { stdio: ['pipe', 'pipe', 'inherit'] });
    let acked = 0;
    let buffer = '';
    let killed = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the writer did not reach ack ${killAt} within ${ROUND_TIMEOUT_MS / 1000} s`));
    }, ROUND_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.on('error', () => undefined); // the child may be gone by the time a permit is written
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const match = /^ack (\d+)$/.exec(line);
        if (!match) continue;
        acked = Number(match[1]);
        if (killed) continue;
        // One more permit, then the kill: the child may be anywhere inside the next step.
        child.stdin.write('\n');
        if (acked >= killAt) {
          killed = true;
          spin(delayMicros);
          child.kill('SIGKILL');
        }
      }
    });
    child.on('close', (_code, signal) => {
      clearTimeout(timer);
      resolve({ acked, signal });
    });
  });
}

async function allFiles(folder: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(path.relative(folder, path.join(entry.parentPath, entry.name)));
  }
  return out;
}

for (let round = 1; round <= ROUNDS; round += 1) {
  const killAt = 5 + 7 * (round - 1);
  const delayMicros = (round - 1) * 150;
  test(`kill -9 round ${round} of ${ROUNDS}: after ack ${killAt} every acknowledged batch and blob survives, nothing is duplicated or torn`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-hub-drill-'));
    try {
      const { acked, signal } = await runUntilKilled(dir, killAt, delayMicros);
      assert.equal(signal, 'SIGKILL', 'the writer must end by the signal, not by itself');
      assert.ok(acked >= killAt, `the writer acknowledged ${acked} steps, fewer than the kill point ${killAt}`);

      const store = await openHubStore(dir); // reopening is the write-ahead log recovery and the blob folder sweep
      let entryCount: number;
      try {
        assert.equal(store.openReport.missingBlobFiles, 0, 'a row names a blob file that is missing');
        assert.equal(store.openReport.damaged, undefined);
        let prev = '0'.repeat(64);
        for (let step = 1; step <= acked; step += 1) {
          const blob = drillBlob(step);
          assert.deepEqual(await store.readBlob(DRILL_PROJECT, blob.hash), blob.bytes, `the blob of acknowledged step ${step} was lost or changed`);
          const rows = drillRows(step, prev);
          for (const row of rows) {
            const kept = store.entryByHash(DRILL_PROJECT, row.hash);
            assert.ok(kept, `an entry of acknowledged step ${step} was lost`);
            assert.equal(kept.header, row.header);
            assert.equal(kept.body, row.body);
          }
          assert.ok(store.blobInfo(DRILL_PROJECT, blob.hash)?.referencedAt !== undefined, `the blob of acknowledged step ${step} lost its reference`);
          prev = rows[rows.length - 1]!.hash;
        }
        const head = store.headOf(DRILL_PROJECT, DRILL_PROJECT, DRILL_WRITER);
        entryCount = head === undefined ? 0 : head.seq + 1;
        // The extra step, when there is one, is whole: three rows or none, and its blob is there when its rows are.
        assert.ok(entryCount === 3 * acked || entryCount === 3 * (acked + 1), `${entryCount} entries is neither ${3 * acked} nor ${3 * (acked + 1)}`);
        const extraBlob = drillBlob(acked + 1);
        if (entryCount === 3 * (acked + 1)) {
          for (const row of drillRows(acked + 1, prev)) assert.ok(store.entryByHash(DRILL_PROJECT, row.hash), 'the extra batch is not the next one in order');
          assert.deepEqual(await store.readBlob(DRILL_PROJECT, extraBlob.hash), extraBlob.bytes, 'the extra batch references a blob that is not there');
        }
        assert.equal(store.blobInfo(DRILL_PROJECT, drillBlob(acked + 2).hash), undefined, 'a blob beyond the in-flight step exists');
      } finally {
        store.close();
      }

      const reader = new Database(path.join(dir, 'hub.db'), { readOnly: true });
      try {
        const integrity = reader.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
        assert.deepEqual(integrity.map((row) => row.integrity_check), ['ok']);
        const places = reader.prepare('SELECT count(*) AS total, count(DISTINCT stream || writer || seq) AS places, count(DISTINCT hash) AS hashes FROM entries').get() as {
          total: number;
          places: number;
          hashes: number;
        };
        assert.equal(places.total, entryCount, 'the entry rows differ from the head');
        assert.equal(places.places, places.total, 'a place appears twice');
        assert.equal(places.hashes, places.total, 'a hash appears twice');
        const blobs = reader.prepare('SELECT project, hash, size FROM blobs').all() as Array<{ project: string; hash: string; size: number }>;
        assert.ok(blobs.length === acked || blobs.length === acked + 1, `${blobs.length} blob rows is neither ${acked} nor ${acked + 1}`);
        for (const row of blobs) {
          const bytes = await readFile(path.join(dir, 'blobs', row.project, row.hash));
          assert.equal(sha256Hex(bytes), row.hash, 'a blob file does not hash to its name');
          assert.equal(bytes.length, row.size);
        }
        const files = await allFiles(path.join(dir, 'blobs'));
        assert.deepEqual(files.filter((name) => name.endsWith('.tmp')), [], 'a temporary file was left behind');
        assert.equal(files.length, blobs.length, 'a blob file has no row');
      } finally {
        reader.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
