// The replica store on disk (31-13, D-27, D-46, D-05): layout, self-ignoring folder, signed high-water marks, rollback refusal, torn tails, blob size,
// two processes appending at once, and entries from outside held back by the injected decode check.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { BLOB_MAX_BYTES, GENESIS_PREV, buildEntry, entryHash, sha256Hex } from '../domain/replica/entry';
import type { BuiltEntry, SealedEntry } from '../domain/replica/entry';
import { REPLICA_DIR } from '../domain/staff/multiUser';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { checkpointHash } from '../domain/replica/checkpoint';
import type { SignedCheckpoint } from '../domain/replica/checkpoint';
import { canonicalBytes } from '../domain/team/canonical';
import { signPayload, verifyPayload } from '../domain/team/signedPayload';
import type { SecretStorageLike } from '../services/auth';
import { REPLICA_MARK_SECRET_PREFIX, markKey, parseReplicaMark, readMark, writeMark } from '../staff/replica/marks';
import { ReplicaStore, STORE_GITIGNORE, STORE_REFUSALS } from '../staff/replica/store';
import type { ForeignCheck, IngestResult, ReplicaStoreDeps, StoreRefused } from '../staff/replica/store';
import { FileSecrets } from './helpers/replicaStoreChild';
import type { StoreChildMessage } from './helpers/replicaStoreChild';
import { epochKey, fixedSigner, streamId } from './helpers/replicaWorld';
import type { FixedSigner } from './helpers/replicaWorld';

class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

const ACTIVE: KeyStatusLookup = () => ({ state: 'active' });
const STREAM = streamId('store/products');
const ROSTER = 'a'.repeat(64);
const AT = '2026-11-19T11:00:00.000Z';

function project(): string {
  return mkdtempSync(path.join(tmpdir(), 'near-ai-replica-store-'));
}

function depsFor(device: FixedSigner, secrets: SecretStorageLike = new MemorySecrets()): ReplicaStoreDeps {
  return { secrets, signer: () => Promise.resolve(device.signer), keyStatus: () => Promise.resolve(ACTIVE), now: () => new Date(AT) };
}

/** `count` chained entries for one writer in one stream, starting after `after` (seq and hash) or at genesis. */
function chain(device: FixedSigner, count: number, options: { stream?: string; from?: { seq: number; hash: string }; big?: boolean; tag?: string } = {}): BuiltEntry[] {
  const out: BuiltEntry[] = [];
  let seq = options.from ? options.from.seq + 1 : 0;
  let prev = options.from?.hash ?? GENESIS_PREV;
  for (let index = 0; index < count; index += 1) {
    const data = options.big ? { text: `${options.tag ?? 'x'}`.repeat(20_000) } : { n: seq, tag: options.tag ?? 'plain' };
    const built = buildEntry({ signer: device.signer, key: epochKey('store'), stream: options.stream ?? STREAM, seq, prev, epoch: 0, body: { deps: [], roster: ROSTER, lamport: seq, at: AT, actor: { kind: 'person' }, kind: 'doc.update', data } });
    out.push(built);
    prev = built.hash;
    seq += 1;
  }
  return out;
}

async function opened(root: string, deps: ReplicaStoreDeps): Promise<ReplicaStore> {
  const store = await ReplicaStore.open(root, deps);
  assert.ok(store instanceof ReplicaStore, `the store opens (${(store as StoreRefused).refused})`);
  return store;
}

function listTree(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(`${relative}/`, ...listTree(full, relative)); else out.push(relative);
  }
  return out;
}

// ---- Task 1: layout, read back, the mark ---------------------------------------------------------------------------------------------------

test('open makes .planning/staff/replica/ with a .gitignore of exactly * and !.gitignore, and nothing outside that folder', async () => {
  const root = project();
  await opened(root, depsFor(fixedSigner('lead')));
  const dir = path.join(root, REPLICA_DIR);
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*\n!.gitignore\n');
  assert.equal(STORE_GITIGNORE, '*\n!.gitignore\n');
  assert.deepEqual(readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n').filter(Boolean), ['*', '!.gitignore']);
  const tree = listTree(root);
  assert.ok(tree.every((item) => item === '.planning/' || item === '.planning/staff/' || item.startsWith('.planning/staff/replica/')), tree.join(', '));
});

test('appendOwn of one entry with a blob writes streams/<stream>/<writer>.jsonl and blobs/<hash>; a second open reads both back equal', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const deps = depsFor(lead);
  const store = await opened(root, deps);
  const [built] = chain(lead, 1, { big: true });
  assert.equal(built.blobs.length, 1, 'a big body moves into a blob');
  assert.deepEqual(await store.appendOwn([built]), { ok: true, written: 1 });
  const dir = path.join(root, REPLICA_DIR);
  const lines = readFileSync(path.join(dir, 'streams', STREAM, `${lead.writer}.jsonl`), 'utf8').split('\n');
  assert.equal(lines.length, 2, 'one whole line and the empty text after its newline');
  assert.equal(lines[1], '');
  assert.ok(statSync(path.join(dir, 'blobs', built.blobs[0].hash)).isFile());
  const again = await opened(root, deps);
  assert.deepEqual(again.entries(), [built.entry]);
  assert.ok(again.has(built.hash));
  assert.deepEqual(await again.blob(built.blobs[0].hash), built.blobs[0]);
  assert.equal(await again.blob('0'.repeat(64)), undefined);
});

test('after an append, secret storage holds one nearAi.staff.replicaMarks. key whose value verifies as staff-replica-mark and names the head', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const [built] = chain(lead, 1);
  await store.appendOwn([built]);
  const keys = [...secrets.values.keys()];
  assert.equal(keys.length, 1);
  assert.ok(keys[0].startsWith(REPLICA_MARK_SECRET_PREFIX));
  assert.equal(keys[0], markKey(path.join(root, REPLICA_DIR)));
  assert.match(keys[0].slice(REPLICA_MARK_SECRET_PREFIX.length), /^[0-9a-f]{32}$/, 'the key holds a hash of the path, never the path');
  const verdict = verifyPayload(JSON.parse(secrets.values.get(keys[0]) as string) as unknown, { purpose: 'staff-replica-mark', status: ACTIVE });
  assert.ok(verdict.ok);
  assert.equal(verdict.ok && verdict.signer.fingerprint, lead.signer.fingerprint);
  const mark = parseReplicaMark(verdict.ok ? verdict.payload : undefined);
  assert.deepEqual(mark, { v: 1, rosterHead: null, heads: [{ stream: STREAM, writer: lead.writer, seq: 0, hash: built.hash, count: 1 }] });
  assert.equal(verifyPayload(JSON.parse(secrets.values.get(keys[0]) as string) as unknown, { purpose: 'staff-ledger-head', status: ACTIVE }).ok, false, 'the purpose is bound');
});


// ---- Task 2: rollback, tampered marks, torn tails, blob size ------------------------------------------------------------------------------

function streamFile(root: string, writer: string, stream = STREAM): string {
  return path.join(root, REPLICA_DIR, 'streams', stream, `${writer}.jsonl`);
}

async function threeAppended(): Promise<{ root: string; lead: FixedSigner; secrets: MemorySecrets; built: BuiltEntry[] }> {
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const built = chain(lead, 3);
  for (const item of built) assert.deepEqual(await store.appendOwn([item]), { ok: true, written: 1 });
  return { root, lead, secrets, built };
}

function assertRefused(result: ReplicaStore | StoreRefused, reason: StoreRefused['refused']): void {
  assert.ok(!(result instanceof ReplicaStore), `refused ${reason}`);
  assert.equal((result as StoreRefused).refused, reason);
  assert.equal((result as StoreRefused).message, STORE_REFUSALS[reason]);
}

test('rolled-back: a writer file cut to two of its three lines, or deleted, is refused, with a message saying what happened and what to do', async () => {
  const { root, lead, secrets } = await threeAppended();
  const file = streamFile(root, lead.writer);
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, original.split('\n').slice(0, 2).map((line) => `${line}\n`).join(''));
  const refused = await ReplicaStore.open(root, depsFor(lead, secrets));
  assertRefused(refused, 'rolled-back');
  const message = (refused as StoreRefused).message;
  assert.match(message, /older than what this device has already seen/);
  assert.match(message, /Nothing was changed/);
  assert.match(message, /Put the newer copy of the folder back|ask your staff lead/);
  assert.equal(readFileSync(file, 'utf8').split('\n').length, 3, 'the refusal changed nothing');
  rmSync(file);
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'rolled-back');
  writeFileSync(file, original);
  assert.ok(await ReplicaStore.open(root, depsFor(lead, secrets)) instanceof ReplicaStore, 'the full file opens again');
});

test('rolled-back: an older copy of the whole store folder put back in place is refused', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const built = chain(lead, 3);
  await store.appendOwn(built.slice(0, 2));
  const dir = path.join(root, REPLICA_DIR);
  const backup = path.join(project(), 'backup');
  cpSync(dir, backup, { recursive: true });
  await store.appendOwn(built.slice(2));
  rmSync(dir, { recursive: true });
  cpSync(backup, dir, { recursive: true });
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'rolled-back');
});

test('rolled-back: the third line replaced by a different valid entry at the same seq is refused', async () => {
  const { root, lead, secrets, built } = await threeAppended();
  const [other] = chain(lead, 1, { from: { seq: 1, hash: built[1].hash }, tag: 'other' });
  assert.equal(other.entry.header.seq, 2);
  assert.notEqual(other.hash, built[2].hash);
  const file = streamFile(root, lead.writer);
  const lines = readFileSync(file, 'utf8').split('\n');
  lines[2] = JSON.stringify(other.entry);
  writeFileSync(file, lines.join('\n'));
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'rolled-back');
});

test('rolled-back: a line edited in place no longer reads as an entry, is skipped, and the shorter count is refused', async () => {
  const { root, lead, secrets } = await threeAppended();
  const file = streamFile(root, lead.writer);
  const lines = readFileSync(file, 'utf8').split('\n');
  const edited = JSON.parse(lines[1]) as { header: unknown; body: string };
  edited.body = `${edited.body.slice(0, -2)}${edited.body.endsWith('AA') ? 'BB' : 'AA'}`;
  lines[1] = JSON.stringify(edited);
  writeFileSync(file, lines.join('\n'));
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'rolled-back');
});

test('a mark whose signature does not verify (a tampered value) is refused mark-unverified, and so is a value that is not a signed mark', async () => {
  const { root, lead, secrets } = await threeAppended();
  const key = markKey(path.join(root, REPLICA_DIR));
  const envelope = JSON.parse(secrets.values.get(key) as string) as { payload: { heads: Array<{ count: number }> } };
  envelope.payload.heads[0].count = 1;
  secrets.values.set(key, JSON.stringify(envelope));
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'mark-unverified');
  secrets.values.set(key, 'not json');
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'mark-unverified');
  const unknownKey = depsFor(lead, secrets);
  secrets.values.delete(key);
  const store = await opened(root, unknownKey);
  assert.equal(store.entries().length, 3, 'with no mark at all the store opens (first use on this device)');
  assert.deepEqual(await store.appendOwn(chain(lead, 1, { from: { seq: 2, hash: chainHash(store, 2) } })), { ok: true, written: 1 }, 'the next append records a fresh mark');
  const untrusted: ReplicaStoreDeps = { ...depsFor(lead, secrets), keyStatus: () => Promise.resolve((() => ({ state: 'unknown' })) as KeyStatusLookup) };
  assertRefused(await ReplicaStore.open(root, untrusted), 'mark-unverified');
});

function chainHash(store: ReplicaStore, seq: number): string {
  const entry = store.entries().find((item) => item.header.seq === seq);
  assert.ok(entry);
  return entryHash(entry.header);
}

test('a file ending in a partial line opens; the partial line is not counted; the next append starts on a new line and every whole line reads back', async () => {
  const { root, lead, secrets, built } = await threeAppended();
  const file = streamFile(root, lead.writer);
  const [next] = chain(lead, 1, { from: { seq: 2, hash: built[2].hash } });
  // Longer than the next line, so a write over it without cutting it off would leave torn bytes behind.
  const torn = `${JSON.stringify(next.entry).slice(0, 120)}${'x'.repeat(40_000)}`;
  appendFileSync(file, torn);
  const store = await opened(root, depsFor(lead, secrets));
  assert.equal(store.entries().length, 3, 'the torn line is not an entry');
  assert.equal(store.has(next.hash), false);
  assert.deepEqual(await store.appendOwn([next]), { ok: true, written: 1 });
  const text = readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.includes(torn + '{'), 'the new line does not run on from the torn bytes');
  const lines = text.split('\n').slice(0, -1);
  assert.equal(lines.length, 4);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  const again = await opened(root, depsFor(lead, secrets));
  assert.deepEqual(again.entries().map((entry) => entry.header.seq), [0, 1, 2, 3]);
  assert.equal(again.damagedLines(), 0);
});

test('a torn tail that is a whole entry without its newline is still not counted, so a retried append never forks the writer', async () => {
  const { root, lead, secrets, built } = await threeAppended();
  const file = streamFile(root, lead.writer);
  const [lost] = chain(lead, 1, { from: { seq: 2, hash: built[2].hash }, tag: 'lost' });
  appendFileSync(file, JSON.stringify(lost.entry));
  const store = await opened(root, depsFor(lead, secrets));
  assert.equal(store.has(lost.hash), false);
  const [rebuilt] = chain(lead, 1, { from: { seq: 2, hash: built[2].hash }, tag: 'rebuilt' });
  assert.deepEqual(await store.appendOwn([rebuilt]), { ok: true, written: 1 });
  const again = await opened(root, depsFor(lead, secrets));
  assert.deepEqual(again.entries().filter((entry) => entry.header.seq === 3).length, 1, 'one entry at seq 3, never two');
  assert.equal(again.has(lost.hash), false);
});

test('a blob over BLOB_MAX_BYTES is refused blob-too-large and nothing is written: no blob, no line, no mark change', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const [built] = chain(lead, 1, { big: true });
  const wire = Buffer.alloc(BLOB_MAX_BYTES + 1, 7);
  const huge = { hash: sha256Hex(wire), bytes: wire.toString('base64url') };
  const result = await store.appendOwn([{ ...built, blobs: [huge] }]);
  assert.deepEqual(result, { refused: 'blob-too-large', message: STORE_REFUSALS['blob-too-large'] });
  const dir = path.join(root, REPLICA_DIR);
  assert.equal(existsSync(path.join(dir, 'blobs', huge.hash)), false);
  assert.equal(existsSync(streamFile(root, lead.writer)), false);
  assert.equal(secrets.values.size, 0);
  assert.equal(store.entries().length, 0);
});

test('appendOwn skips an entry already stored, refuses one that does not follow the last (out-of-order), and takes only this device\'s entries', async () => {
  const { root, lead, secrets, built } = await threeAppended();
  const store = await opened(root, depsFor(lead, secrets));
  assert.deepEqual(await store.appendOwn(built), { ok: true, written: 0 }, 'a retried batch writes nothing again');
  const [gap] = chain(lead, 1, { from: { seq: 4, hash: built[2].hash } });
  assert.deepEqual(await store.appendOwn([gap]), { refused: 'out-of-order', message: STORE_REFUSALS['out-of-order'] });
  const [wrongPrev] = chain(lead, 1, { from: { seq: 2, hash: built[1].hash } });
  assert.equal((await store.appendOwn([wrongPrev]) as StoreRefused).refused, 'out-of-order');
  const [fresh] = chain(lead, 1, { stream: streamId('store/other') });
  await assert.rejects(() => store.appendOwn(chain(fixedSigner('someone-else'), 1)), /only entries this device built/);
  assert.deepEqual(await store.appendOwn([fresh]), { ok: true, written: 1 }, 'a new stream starts at genesis');
  assert.equal(readFileSync(streamFile(root, lead.writer), 'utf8').split('\n').length, 4, 'nothing refused was written');
});

test('a symbolic link on the way to the store, or as a stream file, is refused and nothing is written through it', async () => {
  const root = project();
  const elsewhere = project();
  mkdirSync(path.join(root, '.planning'));
  symlinkSync(elsewhere, path.join(root, '.planning', 'staff'));
  const lead = fixedSigner('lead');
  assertRefused(await ReplicaStore.open(root, depsFor(lead)), 'symlink');
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing was made in the link target');
  const { root: other, secrets } = await threeAppended();
  const file = streamFile(other, lead.writer);
  const target = path.join(elsewhere, 'target.jsonl');
  writeFileSync(target, readFileSync(file));
  rmSync(file);
  symlinkSync(target, file);
  assertRefused(await ReplicaStore.open(other, depsFor(lead, secrets)), 'symlink');
});

test('no refusal message names a key, a secret or a hash longer than 12 characters, and none uses an em-dash', () => {
  for (const [reason, message] of Object.entries(STORE_REFUSALS)) {
    assert.doesNotMatch(message, /[0-9a-f]{13,}/i, reason);
    assert.doesNotMatch(message, /\bkey\b|secret|nearAi\./i, reason);
    assert.doesNotMatch(message, /\u2014/, reason);
    assert.ok(message.length > 20, reason);
  }
});

// ---- Task 3: two processes and two calls at once ------------------------------------------------------------------------------------------

class StoreChild {
  private readonly child: ChildProcess;
  private readonly received: StoreChildMessage[] = [];
  private readonly waiters = new Set<() => void>();
  private ended = false;
  private stderr = '';
  public readonly exited: Promise<number | null>;

  public constructor(args: string[]) {
    this.child = fork(path.join(__dirname, 'helpers', 'replicaStoreChild.js'), args, { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    this.child.stderr?.on('data', (chunk: Buffer) => { this.stderr += chunk.toString('utf8'); });
    this.child.on('message', (message: StoreChildMessage) => { this.received.push(message); this.wake(); });
    this.exited = new Promise((resolve) => { this.child.on('exit', (code) => { this.ended = true; this.wake(); resolve(code); }); });
  }

  private wake(): void {
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiting) resolve();
  }

  public async expect(type: StoreChildMessage['type']): Promise<StoreChildMessage> {
    for (;;) {
      const found = this.received.find((message) => message.type === type);
      if (found) return found;
      const error = this.received.find((message) => message.type === 'error');
      if (error && error.type === 'error') throw new Error(`the store child failed: ${error.message}`);
      if (this.ended) throw new Error(`the store child ended before it sent ${type}: ${this.stderr}`);
      await new Promise<void>((resolve) => { this.waiters.add(resolve); });
    }
  }

  public go(): void { this.child.send({ type: 'go' }); }
  public kill(): void { if (!this.ended) this.child.kill('SIGKILL'); }
}

test('two processes appending 50 entries each for two writers into one store at once lose and interleave nothing, and the mark names both heads', async () => {
  const root = project();
  const secretsFile = path.join(project(), 'secrets.json');
  const children = [new StoreChild([root, secretsFile, 'window-a', '50', STREAM]), new StoreChild([root, secretsFile, 'window-b', '50', STREAM])];
  try {
    await Promise.all(children.map((child) => child.expect('ready')));
    for (const child of children) child.go();
    const done = await Promise.all(children.map((child) => child.expect('done')));
    assert.deepEqual(done, [{ type: 'done', written: 50 }, { type: 'done', written: 50 }]);
    assert.deepEqual(await Promise.all(children.map((child) => child.exited)), [0, 0]);
  } finally {
    for (const child of children) child.kill();
  }
  for (const label of ['window-a', 'window-b']) {
    const writer = fixedSigner(label).writer;
    const text = readFileSync(streamFile(root, writer), 'utf8');
    assert.ok(text.endsWith('\n'));
    const lines = text.split('\n').slice(0, -1);
    assert.equal(lines.length, 50, `${label}: exactly 50 whole lines`);
    lines.forEach((line, index) => {
      const parsed = JSON.parse(line) as SealedEntryLine;
      assert.equal(parsed.header.writer, writer);
      assert.equal(parsed.header.seq, index, `${label}: line ${index} holds seq ${index}`);
    });
  }
  const secrets = new FileSecrets(secretsFile);
  const key = markKey(path.join(root, REPLICA_DIR));
  const verdict = verifyPayload(JSON.parse((await secrets.get(key)) as string) as unknown, { purpose: 'staff-replica-mark', status: ACTIVE });
  assert.ok(verdict.ok, 'the shared mark verifies');
  const mark = parseReplicaMark(verdict.ok ? verdict.payload : undefined);
  assert.deepEqual(mark?.heads.map((head) => [head.writer, head.seq, head.count]).sort(), [[fixedSigner('window-a').writer, 49, 50], [fixedSigner('window-b').writer, 49, 50]].sort());
  const reader = await opened(root, depsFor(fixedSigner('window-a'), secrets));
  assert.equal(reader.entries().length, 100);
  assert.equal(reader.damagedLines(), 0);
});

interface SealedEntryLine { header: { writer: string; seq: number } }

test('two processes signing as one device (two windows of one install) appending 25 entries each share one writer file without a fork or a lost line', async () => {
  const root = project();
  const secretsFile = path.join(project(), 'secrets.json');
  const children = [new StoreChild([root, secretsFile, 'one-device', '25', STREAM]), new StoreChild([root, secretsFile, 'one-device', '25', STREAM])];
  try {
    await Promise.all(children.map((child) => child.expect('ready')));
    for (const child of children) child.go();
    assert.deepEqual(await Promise.all(children.map((child) => child.expect('done'))), [{ type: 'done', written: 25 }, { type: 'done', written: 25 }]);
    assert.deepEqual(await Promise.all(children.map((child) => child.exited)), [0, 0]);
  } finally {
    for (const child of children) child.kill();
  }
  const device = fixedSigner('one-device');
  const lines = readFileSync(streamFile(root, device.writer), 'utf8').split('\n');
  assert.equal(lines.pop(), '', 'the file ends with a newline');
  assert.equal(lines.length, 50);
  const entries = lines.map((line) => JSON.parse(line) as SealedEntry);
  assert.deepEqual(entries.map((entry) => entry.header.seq), [...Array(50).keys()], 'one entry per seq, in order: no fork');
  entries.slice(1).forEach((entry, index) => { assert.equal(entry.header.prev, entryHash(entries[index].header), `seq ${index + 1} follows seq ${index}`); });
  const reader = await opened(root, depsFor(device, new FileSecrets(secretsFile)));
  assert.equal(reader.entries().length, 50);
  assert.deepEqual(reader.head(STREAM, device.writer), { seq: 49, hash: entryHash(entries[49].header) });
});

test('two appendOwn calls at once in one process for one writer keep seq order, and two store objects on one folder share the mark', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const built = chain(lead, 20);
  const results = await Promise.all([store.appendOwn(built.slice(0, 10)), store.appendOwn(built.slice(10))]);
  assert.deepEqual(results, [{ ok: true, written: 10 }, { ok: true, written: 10 }]);
  const lines = readFileSync(streamFile(root, lead.writer), 'utf8').split('\n').slice(0, -1);
  assert.deepEqual(lines.map((line) => (JSON.parse(line) as SealedEntryLine).header.seq), [...Array(20).keys()]);
  // Two windows of one install in one process: separate store objects on one folder, one secret storage.
  const other = fixedSigner('second-window');
  const first = await opened(root, depsFor(lead, secrets));
  const second = await opened(root, depsFor(other, secrets));
  const mine = chain(lead, 5, { from: { seq: 19, hash: built[19].hash } });
  const theirs = chain(other, 5);
  const all = await Promise.all([...mine.map((item) => first.appendOwn([item])), ...theirs.map((item) => second.appendOwn([item]))]);
  assert.ok(all.every((result) => 'ok' in result && result.written === 1));
  const reopened = await opened(root, depsFor(lead, secrets));
  assert.equal(reopened.entries().length, 30);
  const read = await readMark(secrets, markKey(path.join(root, REPLICA_DIR)), ACTIVE);
  assert.equal(read.kind, 'mark');
  assert.deepEqual(read.kind === 'mark' && read.mark.heads.map((head) => [head.writer, head.seq, head.count]).sort(), [[lead.writer, 24, 25], [other.writer, 4, 5]].sort());
});

// ---- Task 4: entries from outside, grants and checkpoints, SECURITY.md --------------------------------------------------------------------

/** A check that refuses the entries whose hash is in `refuse`, and counts its calls. */
function countingCheck(refuse: ReadonlySet<string>): { check: ForeignCheck; calls: string[] } {
  const calls: string[] = [];
  const check: ForeignCheck = (entry) => {
    const hash = entryHash(entry.header);
    calls.push(hash);
    return Promise.resolve(refuse.has(hash) ? { ok: false, reason: 'too-large: the update is over the size limit' } : { ok: true });
  };
  return { check, calls };
}

test('ingestForeign keeps all three entries when the check refuses one, holds that one back with its reason, and the held list survives a reopen', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const colleague = fixedSigner('colleague');
  const secrets = new MemorySecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const foreign = chain(colleague, 3);
  const { check, calls } = countingCheck(new Set([foreign[1].hash]));
  const result = await store.ingestForeign(foreign.map((item) => item.entry), [], check);
  assert.deepEqual(result, { ok: true, added: 3, duplicates: 0, held: [{ hash: foreign[1].hash, reason: 'too-large: the update is over the size limit' }], dropped: 0, blobsAdded: 0, blobsRefused: 0 });
  assert.equal(calls.length, 3);
  assert.equal(readFileSync(streamFile(root, colleague.writer), 'utf8').split('\n').length, 4, 'all three lines are written, the held one too');
  assert.deepEqual(store.heldForCheck(), [{ hash: foreign[1].hash, reason: 'too-large: the update is over the size limit' }]);
  assert.deepEqual(store.entries(), [foreign[0].entry, foreign[2].entry], 'the fold gets every entry except the held one');
  assert.ok(store.has(foreign[1].hash), 'the held entry is kept in the store');
  const again = await opened(root, depsFor(lead, secrets));
  assert.deepEqual(again.heldForCheck(), store.heldForCheck());
  assert.deepEqual(again.entries(), [foreign[0].entry, foreign[2].entry]);
  const mark = await readMark(secrets, markKey(path.join(root, REPLICA_DIR)), ACTIVE);
  assert.deepEqual(mark.kind === 'mark' && mark.mark.heads.map((head) => [head.writer, head.seq, head.count]), [[colleague.writer, 2, 3]], 'entries from outside move the mark too');
});

test('an entry already in the store delivered again (or twice in one call, or as a JSON clone) is not written twice and not checked twice', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const colleague = fixedSigner('colleague');
  const store = await opened(root, depsFor(lead));
  const foreign = chain(colleague, 3);
  const first = countingCheck(new Set([foreign[2].hash]));
  await store.ingestForeign([foreign[0].entry, foreign[0].entry, foreign[1].entry, foreign[2].entry], [], first.check);
  assert.equal(first.calls.length, 3, 'the copy in the same call is not checked');
  const second = countingCheck(new Set());
  const result = await store.ingestForeign([...foreign.map((item) => JSON.parse(JSON.stringify(item.entry)) as unknown), foreign[1].entry], [], second.check);
  assert.equal('ok' in result && result.added, 0);
  assert.equal('ok' in result && result.duplicates, 4);
  assert.deepEqual(second.calls, [], 'nothing already stored is checked again, so a held entry is not let in by a later check');
  assert.equal(readFileSync(streamFile(root, colleague.writer), 'utf8').split('\n').length, 4);
  assert.deepEqual(store.heldForCheck().map((item) => item.hash), [foreign[2].hash]);
  const own = await opened(root, depsFor(lead));
  const third = countingCheck(new Set());
  assert.equal(((await own.ingestForeign(foreign.map((item) => item.entry), [], third.check)) as IngestResult).duplicates, 3, 'a second store object reads them from disk');
  assert.deepEqual(third.calls, []);
});

test('ingestForeign drops what is not a sealed entry, counts a throwing check as a refusal, and refuses wrong or oversized blobs', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const colleague = fixedSigner('colleague');
  const store = await opened(root, depsFor(lead));
  const [big, plain] = [chain(colleague, 1, { big: true })[0], chain(fixedSigner('third'), 1)[0]];
  const damagedBody = { ...plain.entry, body: `${plain.entry.body.slice(0, -2)}${plain.entry.body.endsWith('AA') ? 'BB' : 'AA'}` };
  const wrongBlob = { hash: big.blobs[0].hash, bytes: Buffer.from('not the blob').toString('base64url') };
  const huge = Buffer.alloc(BLOB_MAX_BYTES + 1, 1);
  const throwing: ForeignCheck = (entry) => (entryHash(entry.header) === plain.hash ? Promise.reject(new Error('worker gone')) : Promise.resolve({ ok: true }));
  const result = await store.ingestForeign([null, 'text', { header: {}, body: '' }, damagedBody, big.entry, plain.entry], [wrongBlob, { hash: sha256Hex(huge), bytes: huge.toString('base64url') }, big.blobs[0]], throwing);
  assert.ok('ok' in result);
  assert.equal(result.dropped, 4);
  assert.equal(result.added, 2);
  assert.deepEqual(result.held, [{ hash: plain.hash, reason: 'The decode check could not run on this update.' }]);
  assert.equal(result.blobsAdded, 1);
  assert.equal(result.blobsRefused, 2);
  assert.deepEqual(await store.blob(big.blobs[0].hash), big.blobs[0]);
  assert.equal(existsSync(path.join(root, REPLICA_DIR, 'blobs', sha256Hex(huge))), false);
  assert.deepEqual(store.entries(), [big.entry]);
  const reasons = await store.ingestForeign(chain(fixedSigner('fourth'), 1).map((item) => item.entry), [], () => Promise.resolve({ ok: false, reason: `line one\nline two ${'z'.repeat(400)}` }));
  assert.ok('ok' in reasons);
  assert.equal(reasons.held[0].reason.includes('\n'), false, 'a reason is kept as one line');
  assert.equal(reasons.held[0].reason.length, 200);
});

test('held.json that cannot be read refuses the store (never read as empty), and a held.json that is a symbolic link is refused', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const foreign = chain(fixedSigner('colleague'), 2);
  await store.ingestForeign(foreign.map((item) => item.entry), [], countingCheck(new Set([foreign[0].hash])).check);
  const held = path.join(root, REPLICA_DIR, 'held.json');
  const good = readFileSync(held, 'utf8');
  writeFileSync(held, '{"v":1,"held":[{"hash":"zz"}]}');
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'unreadable');
  rmSync(held);
  const target = path.join(project(), 'held.json');
  writeFileSync(target, good);
  symlinkSync(target, held);
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'symlink');
  rmSync(held);
  writeFileSync(held, good);
  assert.deepEqual((await opened(root, depsFor(lead, secrets))).heldForCheck().map((item) => item.hash), [foreign[0].hash]);
});

test('putGrant and putCheckpoint write content-addressed files atomically; grants() and checkpoints() read them back and list a damaged file as unreadable', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const store = await opened(root, depsFor(lead));
  const cell = streamId('store/cell');
  const grant = signPayload(lead.signer, 'staff-cell-grant', { cell, epoch: 1, device: 'd1', wrapped: 'w' }, { now: () => new Date(AT) });
  const put = await store.putGrant(cell, 1, grant);
  assert.ok('ok' in put);
  assert.equal(put.hash, sha256Hex(canonicalBytes(grant)));
  const name = path.join(root, REPLICA_DIR, 'grants', cell, `1-${put.hash}.json`);
  assert.ok(statSync(name).isFile());
  assert.deepEqual(await store.putGrant(cell, 1, grant), put, 'the same grant twice is one file');
  assert.deepEqual(readdirSync(path.join(root, REPLICA_DIR, 'grants', cell)), [`1-${put.hash}.json`], 'no temporary file is left behind');
  const checkpoint = { v: 1, purpose: 'staff-replica', signer: { fingerprint: 'f', publicKey: 'k' }, signedAt: AT, payload: { v: 2, stream: STREAM }, sig: 'signature' } as unknown as SignedCheckpoint;
  const cp = await store.putCheckpoint(checkpoint);
  assert.ok('ok' in cp);
  assert.equal(cp.hash, checkpointHash(checkpoint));
  assert.deepEqual(await store.grants(), { grants: [{ cell, epoch: 1, hash: put.hash, signed: JSON.parse(JSON.stringify(grant)) as unknown }], unreadable: [] });
  assert.deepEqual(await store.checkpoints(), { checkpoints: [{ hash: cp.hash, signed: JSON.parse(JSON.stringify(checkpoint)) as unknown }], unreadable: [] });
  // A grant file that does not parse, and one whose content is not what its name says, are listed, never dropped silently.
  writeFileSync(path.join(root, REPLICA_DIR, 'grants', cell, `2-${'b'.repeat(64)}.json`), '{ not json');
  writeFileSync(path.join(root, REPLICA_DIR, 'grants', cell, `3-${'c'.repeat(64)}.json`), JSON.stringify(grant));
  writeFileSync(path.join(root, REPLICA_DIR, 'checkpoints', `${'d'.repeat(64)}.json`), JSON.stringify(checkpoint));
  const read = await store.grants();
  assert.equal(read.grants.length, 1);
  assert.deepEqual(read.unreadable, [
    { file: `grants/${cell}/2-${'b'.repeat(64)}.json`, reason: 'it is not readable JSON' },
    { file: `grants/${cell}/3-${'c'.repeat(64)}.json`, reason: 'its content does not match its name' }
  ]);
  assert.deepEqual((await store.checkpoints()).unreadable, [{ file: `checkpoints/${'d'.repeat(64)}.json`, reason: 'its content does not match its name' }]);
  await assert.rejects(() => store.putGrant('../escape', 1, grant), /cell id/);
  await assert.rejects(() => store.putGrant(cell, 0, grant), /epoch of 1 or more/);
});

test('a recorded roster head is in the mark, and a store that no longer holds that entry is refused rolled-back', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const roster = chain(lead, 2, { stream: streamId('store/roster') });
  await store.appendOwn(roster);
  assert.deepEqual(await store.recordRosterHead(roster[1].hash), { ok: true });
  const key = markKey(path.join(root, REPLICA_DIR));
  const read = await readMark(secrets, key, ACTIVE);
  assert.equal(read.kind === 'mark' && read.mark.rosterHead, roster[1].hash);
  await assert.rejects(() => store.recordRosterHead('e'.repeat(64)), /not an entry in this store/);
  await writeMark(secrets, key, lead.signer, { v: 1, rosterHead: 'e'.repeat(64), heads: [] });
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'rolled-back');
});

test('SECURITY.md has the replica store subsection once, inside the multi-user section, with no em-dash', () => {
  const text = readFileSync(path.resolve(__dirname, '..', '..', 'SECURITY.md'), 'utf8');
  assert.equal(text.split('\n').filter((line) => line === '### The replica store and rollback detection').length, 1);
  const section = text.slice(text.indexOf('## Multi-user staff projects (preview)'), text.indexOf('\n## ', text.indexOf('## Multi-user staff projects (preview)') + 1));
  assert.ok(section.includes('### The replica store and rollback detection'));
  assert.doesNotMatch(text, /\u2014/);
  for (const phrase of ['.planning/staff/replica/', 'git', 'secret storage', 'private key', 'set aside']) assert.ok(section.toLowerCase().includes(phrase.toLowerCase()), phrase);
});
