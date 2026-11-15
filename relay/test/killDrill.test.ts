import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { RUN_STATES } from '../src/store/relayStore';
import { openSqliteStore } from '../src/store/sqliteStore';

// Phase 68, plan 04 (RELAY-03): the kill -9 drill. 15 rounds, each on a fresh database: a child process accepts inbound messages through the real
// store module and prints `ack N` only after acceptInbound resolved (after COMMIT). The parent kills it with SIGKILL at a chosen N, reopens the
// database and checks that every acknowledged message and its run record survived, that at most one unacknowledged pair is extra, that nothing
// is duplicated, that messages and runs pair one to one, and that SQLite's own integrity check passes.
//
// What the drill proves: the message and its run are written atomically, nothing is acknowledged before it committed, and a database killed in
// the middle of a write recovers from its write-ahead log on the next open.
// What it does not prove: survival of power loss or an operating system crash. SIGKILL ends the process, not the machine, so the drill passes
// under any synchronous setting. That is why the store sets PRAGMA synchronous = FULL on every connection (68-RESEARCH.md Pitfall 7), which is
// not something a test on a temporary directory can show.

const CHILD = fileURLToPath(new URL('./fixtures/crashWriter.js', import.meta.url));
const ROUNDS = 15;

interface Killed {
  acked: number;
  signal: NodeJS.Signals | null;
}

/** Starts the writer, gives it one message at a time, and kills it (by the pid this test spawned) once it has acknowledged `killAt`. */
function runUntilKilled(file: string, killAt: number): Promise<Killed> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, file], { stdio: ['pipe', 'pipe', 'inherit'] });
    let acked = 0;
    let buffer = '';
    let killed = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the writer did not reach ack ${killAt} within 20 s`));
    }, 20_000);
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
        // One more permit, then the kill: the child may be anywhere inside the next message.
        child.stdin.write('\n');
        if (acked >= killAt) {
          killed = true;
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

for (let round = 1; round <= ROUNDS; round += 1) {
  const killAt = 5 + 7 * (round - 1);
  test(`kill -9 round ${round} of ${ROUNDS}: after ack ${killAt} every acknowledged message and run survives, nothing is duplicated`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-relay-drill-'));
    try {
      const file = path.join(dir, 'relay.db');
      const { acked, signal } = await runUntilKilled(file, killAt);
      assert.equal(signal, 'SIGKILL', 'the writer must end by the signal, not by itself');
      assert.ok(acked >= killAt, `the writer acknowledged ${acked} messages, fewer than the kill point ${killAt}`);

      const store = await openSqliteStore(file); // reopening is the write-ahead log recovery
      try {
        for (let n = 1; n <= acked; n += 1) {
          const message = await store.getMessage('drill', `msg-${n}`);
          assert.ok(message, `acknowledged message ${n} was lost`);
          assert.equal(message.payload, `body ${n}`);
          const run = await store.getRun('drill', `run-${n}`);
          assert.ok(run, `the run record of acknowledged message ${n} was lost`);
          assert.equal(run.messageId, message.messageId);
        }
        const depth = await store.queueDepth('drill');
        assert.ok(depth >= acked && depth <= acked + 1, `queue depth ${depth} is not ${acked} or ${acked + 1}`);
        assert.equal(await store.countRuns(RUN_STATES), depth, 'runs and messages must pair one to one');
        // The extra pair, when there is one, is whole: a message with its run, never one without the other.
        if (depth === acked + 1) {
          const extra = await store.getMessage('drill', `msg-${acked + 1}`);
          assert.ok(extra, 'the extra message is not the next one in order');
          const extraRun = await store.getRun('drill', `run-${acked + 1}`);
          assert.ok(extraRun, 'the extra message has no run record');
          assert.equal(extraRun.messageId, extra.messageId);
        }
        assert.equal(await store.getMessage('drill', `msg-${depth + 1}`), undefined, 'a message beyond the in-flight one exists');
      } finally {
        await store.close();
      }

      const reader = new Database(file, { readOnly: true });
      try {
        const integrity = reader.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
        assert.deepEqual(integrity.map((row) => row.integrity_check), ['ok']);
        const keys = reader.prepare('SELECT count(*) AS total, count(DISTINCT dedupe_key) AS distinctKeys FROM messages').get() as {
          total: number;
          distinctKeys: number;
        };
        assert.equal(keys.total, keys.distinctKeys, 'a dedupe key appears twice');
        const runs = reader.prepare('SELECT count(*) AS total, count(DISTINCT message_id) AS distinctMessages FROM runs').get() as {
          total: number;
          distinctMessages: number;
        };
        assert.equal(runs.total, runs.distinctMessages, 'a message has two runs');
        assert.equal(runs.total, keys.total, 'runs and messages differ in number');
      } finally {
        reader.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
