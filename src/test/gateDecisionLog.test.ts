// Decision log tests (GATE-07, D-21): order and sequence, rotation, redaction, failures that never block, and where the files may be. Real files in temp
// folders; nothing touches the real global storage. Token-shaped strings are built at run time, never written.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { buildDecisionRecord, validateDecisionRecord } from '../domain/gate/record';
import type { DecisionRecord } from '../domain/gate/record';
import { DECISIONS_DIR, DecisionLog, MAX_DECISION_LOG_BYTES, MAX_ROTATED_FILES, projectLogKey } from '../gate/decisionLog';
import { GATE_DIR_NAME } from '../gate/bundleStore';

const NOW = 1794830400000;
const HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function record(id: number, overrides: { reason?: string; resourceName?: string } = {}): DecisionRecord {
  return buildDecisionRecord({
    recordId: `rec-${id}`, sequence: 0, time: NOW + id, productVersion: '0.0.0-test', actor: { kind: 'person', deviceFingerprint: 'dev-1', sessionId: 'session-1' },
    callId: `call-${id}`, capability: { verb: 'read', paths: ['src/**'] }, resource: { name: overrides.resourceName ?? 'src/app.ts', type: 'file' }, outcome: 'allowed',
    rule: 'settings.mode.other', bundleHash: HASH, ...(overrides.reason === undefined ? {} : { reason: overrides.reason })
  });
}

interface Harness { storage: string; key: string; dir: string; failures: string[]; log: DecisionLog }

async function withLog<T>(work: (h: Harness) => Promise<T>, maxBytes?: number): Promise<T> {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-log-'));
  try {
    const key = projectLogKey(path.join(storage, 'a-project'));
    const failures: string[] = [];
    const log = new DecisionLog({ globalStorageDir: storage, projectKey: key, onWriteFailure: (message) => { failures.push(message); }, ...(maxBytes === undefined ? {} : { maxBytes }) });
    return await work({ storage, key, dir: path.join(storage, GATE_DIR_NAME, DECISIONS_DIR), failures, log });
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
}

async function linesOf(file: string): Promise<DecisionRecord[]> {
  return (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as DecisionRecord);
}

test('three appends give three lines with sequence 1, 2, 3 in order, even when the caller does not wait between them', async () => {
  await withLog(async ({ dir, key, log, failures }) => {
    void log.append(record(1));
    void log.append(record(2));
    await log.append(record(3));
    const lines = await linesOf(path.join(dir, `${key}.jsonl`));
    assert.deepEqual(lines.map((line) => line.metadata.sequence), [1, 2, 3]);
    assert.deepEqual(lines.map((line) => line.metadata.uid), ['rec-1', 'rec-2', 'rec-3']);
    for (const line of lines) assert.equal(validateDecisionRecord(line).ok, true);
    assert.deepEqual(failures, []);
  });
});

test('the first append creates the decisions folder and file, and a record with an empty resources array is written and validates', async () => {
  await withLog(async ({ dir, key, log }) => {
    await assert.rejects(readdir(dir), { code: 'ENOENT' });
    const plan = { ...record(1), resources: [] } as unknown as DecisionRecord;
    assert.equal(validateDecisionRecord(plan).ok, true);
    await log.append(plan);
    const lines = await linesOf(path.join(dir, `${key}.jsonl`));
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0]?.resources, []);
    assert.equal(validateDecisionRecord(lines[0]).ok, true);
  });
});

test('numbering continues from the last line after a restart, and another window appending to the same file keeps it strictly increasing', async () => {
  await withLog(async ({ storage, dir, key, log }) => {
    await log.append(record(1));
    await log.append(record(2));
    const second = new DecisionLog({ globalStorageDir: storage, projectKey: key, onWriteFailure: () => undefined });
    await second.append(record(3));
    await log.append(record(4));
    await second.append(record(5));
    const sequences = (await linesOf(path.join(dir, `${key}.jsonl`))).map((line) => line.metadata.sequence);
    assert.deepEqual(sequences, [1, 2, 3, 4, 5]);
  });
});

test('rotation: the full file is renamed whole to <key>.1.jsonl before the next line, and numbering and order carry on', async () => {
  const lineBytes = Buffer.byteLength(JSON.stringify(record(1)), 'utf8') + 4;
  await withLog(async ({ dir, key, log, failures }) => {
    for (let id = 1; id <= 5; id += 1) await log.append(record(id));
    const names = (await readdir(dir)).sort();
    assert.ok(names.includes(`${key}.jsonl`));
    assert.ok(names.includes(`${key}.1.jsonl`));
    const older = await linesOf(path.join(dir, `${key}.1.jsonl`));
    const current = await linesOf(path.join(dir, `${key}.jsonl`));
    assert.ok(older.length >= 1 && current.length >= 1);
    // Nothing is lost or reordered across the files that are kept.
    const all = [...(await linesOf(path.join(dir, `${key}.2.jsonl`)).catch(() => [])), ...older, ...current];
    assert.deepEqual(all.map((line) => line.metadata.sequence), all.map((_line, index) => (all[0]?.metadata.sequence ?? 0) + index));
    assert.equal(all[all.length - 1]?.metadata.sequence, 5);
    for (const file of names) assert.ok(file.startsWith(key), `${file} is named by the project key`);
    assert.deepEqual(failures, []);
  }, Math.floor(lineBytes * 2.5));
});

test('at most MAX_ROTATED_FILES rotated files are kept, the newest at .1 and the oldest dropped', async () => {
  const lineBytes = Buffer.byteLength(JSON.stringify(record(1)), 'utf8') + 4;
  await withLog(async ({ dir, key, log }) => {
    for (let id = 1; id <= 30; id += 1) await log.append(record(id));
    const names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort();
    const rotated = names.filter((name) => name !== `${key}.jsonl`);
    assert.equal(rotated.length, MAX_ROTATED_FILES);
    assert.deepEqual(rotated, Array.from({ length: MAX_ROTATED_FILES }, (_unused, index) => `${key}.${index + 1}.jsonl`));
    // Newer numbers are in lower-numbered files, with no gap between neighbouring files.
    let expectedLast = 30;
    for (const name of [`${key}.jsonl`, ...rotated]) {
      const lines = await linesOf(path.join(dir, name));
      assert.equal(lines[lines.length - 1]?.metadata.sequence, expectedLast, name);
      expectedLast = (lines[0]?.metadata.sequence ?? 0) - 1;
    }
    assert.ok(expectedLast > 0, 'the oldest records were dropped');
  }, Math.floor(lineBytes * 2.5));
});

test('the default rotation size is 5 MiB and the rotated count is 4', () => {
  assert.equal(MAX_DECISION_LOG_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_ROTATED_FILES, 4);
});

test('gate decision log creation and rotation grant no group or other access on POSIX', {
  skip: process.platform === 'win32' ? 'POSIX permission bits do not model Windows ACLs' : false
}, async () => {
  const lineBytes = Buffer.byteLength(JSON.stringify(record(1)), 'utf8') + 4;
  await withLog(async ({ dir, key, log, failures }) => {
    await log.append(record(1));
    await log.append(record(2));
    const modes = await Promise.all([
      stat(dir), stat(path.join(dir, `${key}.jsonl`)), stat(path.join(dir, `${key}.1.jsonl`))
    ]);
    assert.ok(modes[0].isDirectory());
    assert.ok(modes[1].isFile() && modes[2].isFile());
    assert.deepEqual(modes.map(({ mode }) => mode & 0o077), [0, 0, 0]);
    assert.deepEqual(failures, []);
  }, Math.floor(lineBytes * 1.5));
});

test('a token-shaped string in a record is written redacted', async () => {
  await withLog(async ({ dir, key, log, failures }) => {
    const token = `sk-${'a1B2c3D4'.repeat(4)}`;
    const dirty = record(1, { reason: 'The command was refused.' });
    const leaked = { ...dirty, status_detail: `The command used ${token} directly.`, resources: [{ name: `run --key ${token}`, type: 'command' }] } as unknown as DecisionRecord;
    await log.append(leaked);
    const text = await readFile(path.join(dir, `${key}.jsonl`), 'utf8');
    assert.ok(!text.includes(token));
    assert.match(text, /\[REDACTED\]/);
    assert.deepEqual(failures, []);
  });
});

test('a folder that cannot be written: append returns normally, the failure is reported once with a plain message, and a second failure is not reported again', async () => {
  await withLog(async ({ storage, dir, log, failures }) => {
    // A plain file where the decisions folder should be, so every write fails whoever runs the test.
    await mkdir(path.join(storage, GATE_DIR_NAME), { recursive: true });
    await writeFile(dir, 'in the way', 'utf8');
    await log.append(record(1));
    await log.append(record(2));
    assert.equal(failures.length, 1);
    assert.ok(failures[0]?.includes('Your work is not affected'));
    assert.ok(!failures[0]?.includes(storage), 'the message names no path');
  });
});

test('a record that is not valid is not written and is reported, and later records are still written', async () => {
  await withLog(async ({ dir, key, log, failures }) => {
    await log.append({ ...record(1), class_uid: 1 } as unknown as DecisionRecord);
    await log.append(record(2));
    assert.equal(failures.length, 1);
    const lines = await linesOf(path.join(dir, `${key}.jsonl`));
    assert.deepEqual(lines.map((line) => line.metadata.uid), ['rec-2']);
    assert.equal(lines[0]?.metadata.sequence, 1);
  });
});

test('the record that is validated is the record that is stored: one that is only invalid with its real sequence is refused, and nothing is written for it', async () => {
  await withLog(async ({ dir, key, log, failures }) => {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${key}.jsonl`);
    // The last line of the file carries the largest whole number a record may hold, so the next number is not a whole number a record may hold.
    const last = { ...record(0), metadata: { ...record(0).metadata, sequence: Number.MAX_SAFE_INTEGER } };
    await writeFile(file, `${JSON.stringify(last)}\n`, 'utf8');
    await log.append(record(1));
    assert.equal(failures.length, 1, 'refused and reported once');
    assert.equal((await readFile(file, 'utf8')), `${JSON.stringify(last)}\n`, 'no line was added');
  });
});

test('every stored line validates as it is stored, with the sequence the log gave it and not the one the caller put in', async () => {
  await withLog(async ({ dir, key, log }) => {
    await log.append({ ...record(1), metadata: { ...record(1).metadata, sequence: 41 } });
    await log.append(record(2));
    const text = await readFile(path.join(dir, `${key}.jsonl`), 'utf8');
    const stored = text.split('\n').filter((line) => line !== '');
    assert.equal(stored.length, 2);
    for (const line of stored) {
      const checked = validateDecisionRecord(JSON.parse(line));
      assert.equal(checked.ok, true);
      assert.equal(JSON.stringify(checked.ok ? checked.value : undefined), line, 'the validated object is the stored line');
    }
    assert.deepEqual(stored.map((line) => (JSON.parse(line) as DecisionRecord).metadata.sequence), [1, 2]);
  });
});

test('a failure report that itself throws never turns into a rejected append', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-log-'));
  try {
    await mkdir(path.join(storage, GATE_DIR_NAME), { recursive: true });
    await writeFile(path.join(storage, GATE_DIR_NAME, DECISIONS_DIR), 'in the way', 'utf8');
    const log = new DecisionLog({ globalStorageDir: storage, projectKey: projectLogKey('/x'), onWriteFailure: () => { throw new Error('the reporter broke'); } });
    await log.append(record(1));
    await log.flush();
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test('where the files go: the file name is a hash of the project root with no path in it, the folder is under gate/decisions, and nothing lands elsewhere', async () => {
  await withLog(async ({ storage, key, dir, log }) => {
    const root = path.join(storage, 'a-project');
    assert.equal(key, projectLogKey(root));
    assert.match(key, /^[0-9a-f]{32}$/);
    assert.notEqual(projectLogKey(path.join(storage, 'another')), key);
    assert.equal(projectLogKey(root + path.sep), key);
    assert.ok(!key.includes('a-project'));
    await log.append(record(1));
    assert.deepEqual(await readdir(dir), [`${key}.jsonl`].concat((await readdir(dir)).filter((name) => name.endsWith('.lock'))));
    assert.deepEqual((await readdir(storage)).sort(), [GATE_DIR_NAME]);
  });
});

test('the constructor refuses a global storage folder inside the project root, and a project key that is not a hash', () => {
  const root = path.join(tmpdir(), 'near-ai-gate-root');
  assert.throws(() => new DecisionLog({ globalStorageDir: path.join(root, '.near-ai'), projectKey: projectLogKey(root), onWriteFailure: () => undefined, projectRoot: root }), /outside the project/);
  assert.throws(() => new DecisionLog({ globalStorageDir: root, projectKey: projectLogKey(root), onWriteFailure: () => undefined, projectRoot: root }), /outside the project/);
  assert.doesNotThrow(() => new DecisionLog({ globalStorageDir: path.join(tmpdir(), 'near-ai-gate-global'), projectKey: projectLogKey(root), onWriteFailure: () => undefined, projectRoot: root }));
  assert.throws(() => new DecisionLog({ globalStorageDir: root, projectKey: '../escape', onWriteFailure: () => undefined }), /project key/);
});
