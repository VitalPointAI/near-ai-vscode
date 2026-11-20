// The replica store on disk (31-13, D-27, D-46, D-05): layout, self-ignoring folder, signed high-water marks, rollback refusal, torn tails, blob size,
// two processes appending at once, and entries from outside held back by the injected decode check.
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { BLOB_MAX_BYTES, GENESIS_PREV, buildEntry, entryHash, sha256Hex } from '../domain/replica/entry';
import type { BuiltEntry } from '../domain/replica/entry';
import { REPLICA_DIR } from '../domain/staff/multiUser';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { verifyPayload } from '../domain/team/signedPayload';
import type { SecretStorageLike } from '../services/auth';
import { REPLICA_MARK_SECRET_PREFIX, markKey, parseReplicaMark } from '../staff/replica/marks';
import { ReplicaStore, STORE_GITIGNORE, STORE_REFUSALS } from '../staff/replica/store';
import type { ReplicaStoreDeps, StoreRefused } from '../staff/replica/store';
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
    assert.doesNotMatch(message, /—/, reason);
    assert.ok(message.length > 20, reason);
  }
});
