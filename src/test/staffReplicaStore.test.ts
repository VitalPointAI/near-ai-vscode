// The replica store on disk (31-13, D-27, D-46, D-05): layout, self-ignoring folder, signed high-water marks, rollback refusal, torn tails, blob size,
// two processes appending at once, and entries from outside held back by the injected decode check.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { BLOB_MAX_BYTES, GENESIS_PREV, buildEntry, entryHash, prepareEntrySigning, sha256Hex } from '../domain/replica/entry';
import type { BuiltEntry, SealedEntry } from '../domain/replica/entry';
import { REPLICA_DIR } from '../domain/staff/multiUser';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { checkpointHash } from '../domain/replica/checkpoint';
import type { SignedCheckpoint } from '../domain/replica/checkpoint';
import { canonicalBytes } from '../domain/team/canonical';
import { signPayload, verifyPayload } from '../domain/team/signedPayload';
import type { SecretStorageLike } from '../services/auth';
import { MARK_LISTS_DIR, MARK_VERSION, MAX_MARK_LISTED, MAX_MARK_WAITING, REPLICA_MARK_SECRET_PREFIX, digestOf, heldReason, markContentHash, markKey, markListsBytes, markListsFolder, parseReplicaMark, readMark, writeMark } from '../staff/replica/marks';
import type { ReplicaMark } from '../staff/replica/marks';
import { FLOODED_REASON, FLOODED_TEXT, MAX_REFUSED_PER_WRITER, ReplicaStore, START_AGAIN_COMMAND_TITLE, STORE_GITIGNORE, STORE_REFUSALS } from '../staff/replica/store';
import type { ForeignCheck, IngestResult, ReplicaStoreDeps, StoreRefused } from '../staff/replica/store';
import { setFolderSyncProbe } from '../staff/staffFiles';
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
  // The value holds only the compact signed record; the lists are in a file in the store folder named by the sha256 the record signs.
  const stored = JSON.parse(secrets.values.get(keys[0]) as string) as { v: number; signed: unknown };
  assert.deepEqual(Object.keys(stored).sort(), ['signed', 'v']);
  assert.equal(stored.v, MARK_VERSION);
  const verdict = verifyPayload(stored.signed, { purpose: 'staff-replica-mark', status: ACTIVE });
  assert.ok(verdict.ok);
  assert.equal(verdict.ok && verdict.signer.fingerprint, lead.signer.fingerprint);
  const { bytes, name } = onlyListsFile(root, lead.writer);
  const lists = JSON.parse(bytes.toString('utf8')) as { v: number; heads: unknown; held: unknown; waiting: unknown };
  assert.deepEqual(Object.keys(lists).sort(), ['heads', 'held', 'v', 'waiting']);
  assert.equal(lists.v, MARK_VERSION);
  const mark = parseReplicaMark({ rosterHead: null, heads: lists.heads, held: lists.held, waiting: lists.waiting });
  assert.deepEqual(mark, { rosterHead: null, heads: [{ stream: STREAM, writer: lead.writer, seq: 0, hash: built.hash, count: 1, digest: digestOf([built.hash]) }], held: [], waiting: [] });
  assert.equal(name, `${sha256Hex(bytes)}.json`, 'the lists file is named by the sha256 of its bytes');
  assert.ok(markListsBytes(mark as ReplicaMark).equals(bytes), 'the lists file holds exactly the bytes this version writes');
  assert.equal(markContentHash(mark as ReplicaMark), sha256Hex(bytes));
  assert.deepEqual(verdict.ok && verdict.payload, { v: MARK_VERSION, rosterHead: null, heads: 1, held: 0, waiting: 0, content: sha256Hex(bytes) });
  assert.equal(verifyPayload(stored.signed, { purpose: 'staff-ledger-head', status: ACTIVE }).ok, false, 'the purpose is bound');
  const read = await readMark(secrets, path.join(root, REPLICA_DIR), ACTIVE);
  assert.deepEqual(read.kind === 'mark' && read.mark, mark);
});


// ---- Task 2: rollback, tampered marks, torn tails, blob size ------------------------------------------------------------------------------

function streamFile(root: string, writer: string, stream = STREAM): string {
  return path.join(root, REPLICA_DIR, 'streams', stream, `${writer}.jsonl`);
}

/** The one lists file of a device's mark in a store folder: its path, name and bytes. */
function onlyListsFile(root: string, writer: string): { file: string; name: string; bytes: Buffer } {
  const folder = markListsFolder(path.join(root, REPLICA_DIR), writer);
  const names = readdirSync(folder);
  assert.equal(names.length, 1, `one lists file: ${names.join(', ')}`);
  const file = path.join(folder, names[0]);
  return { file, name: names[0], bytes: readFileSync(file) };
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

// Before 31-REVIEW MJ-08 this was refused rolled-back; a damaged line is damage, not a rollback, so it is now refused damaged with its own sentence.
test('damaged: a line edited in place no longer reads as an entry, is skipped, and the file is refused damaged, not rolled back', async () => {
  const { root, lead, secrets } = await threeAppended();
  const file = streamFile(root, lead.writer);
  const lines = readFileSync(file, 'utf8').split('\n');
  const edited = JSON.parse(lines[1]) as { header: unknown; body: string };
  edited.body = `${edited.body.slice(0, -2)}${edited.body.endsWith('AA') ? 'BB' : 'AA'}`;
  lines[1] = JSON.stringify(edited);
  writeFileSync(file, lines.join('\n'));
  const refused = await ReplicaStore.open(root, depsFor(lead, secrets));
  assertRefused(refused, 'damaged');
  assert.match((refused as StoreRefused).message, /damaged/);
  assert.ok((refused as StoreRefused).message.includes(START_AGAIN_COMMAND_TITLE), 'the refusal names the way out');
  // A line that is simply gone is still a rollback.
  lines.splice(1, 1);
  writeFileSync(file, lines.join('\n'));
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'rolled-back');
});

test('a mark whose signature does not verify (a tampered value) is refused mark-unverified, and so is a value that is not a signed mark', async () => {
  const { root, lead, secrets } = await threeAppended();
  const key = markKey(path.join(root, REPLICA_DIR));
  const good = secrets.values.get(key) as string;
  // The lists file is trusted only when it hashes to the signed content; the signed payload itself only with its signature.
  const { file, bytes } = onlyListsFile(root, lead.writer);
  const listEdited = JSON.parse(bytes.toString('utf8')) as { heads: Array<{ count: number }> };
  listEdited.heads[0].count = 1;
  writeFileSync(file, `${JSON.stringify(listEdited)}\n`);
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'mark-unverified');
  const listAdded = JSON.parse(bytes.toString('utf8')) as { waiting: unknown[] };
  listAdded.waiting.push({ hash: 'f'.repeat(64), reason: 'unchecked' });
  writeFileSync(file, `${JSON.stringify(listAdded)}\n`);
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'mark-unverified');
  writeFileSync(file, bytes);
  assert.ok(await ReplicaStore.open(root, depsFor(lead, secrets)) instanceof ReplicaStore, 'the lists file put back opens');
  const payloadEdited = JSON.parse(good) as { signed: { payload: { heads: number } } };
  payloadEdited.signed.payload.heads = 2;
  secrets.values.set(key, JSON.stringify(payloadEdited));
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'mark-unverified');
  // A value with the lists beside the signature (the version 2 shape) reads as unverified: no older version ever shipped, so nothing migrates.
  const older = JSON.parse(good) as Record<string, unknown>;
  secrets.values.set(key, JSON.stringify({ ...older, v: 2, heads: [], held: [], waiting: [] }));
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'mark-unverified');
  secrets.values.set(key, JSON.stringify({ ...older, heads: [], held: [], waiting: [] }));
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

test('guarded append refuses another writer’s new entry before writing its own entry or blob', async () => {
  const { root, lead, secrets, built } = await threeAppended();
  const first = await opened(root, depsFor(lead, secrets));
  const other = fixedSigner('guard-other-writer');
  const second = await opened(root, depsFor(other, secrets));
  const expected = await first.appendSnapshot();
  const ownHead = first.head(STREAM, lead.writer);
  const [candidate] = chain(lead, 1, { from: { seq: 2, hash: built[2].hash }, big: true });
  assert.equal(candidate.blobs.length, 1);

  assert.deepEqual(await second.appendOwn(chain(other, 1)), { ok: true, written: 1 });
  assert.deepEqual(await first.appendOwn([candidate], expected),
    { refused: 'snapshot-changed', message: STORE_REFUSALS['snapshot-changed'] });
  assert.deepEqual(first.head(STREAM, lead.writer), ownHead);
  assert.equal(first.has(candidate.hash), false);
  assert.equal(await first.blob(candidate.blobs[0].hash), undefined);
  assert.deepEqual(await first.appendOwn([candidate], await first.appendSnapshot()), { ok: true, written: 1 });
});

test('guarded append detects another window recording a roster head even when writer logs stay unchanged', async () => {
  const { root, lead, secrets, built } = await threeAppended();
  const first = await opened(root, depsFor(lead, secrets));
  const second = await opened(root, depsFor(lead, secrets));
  const expected = await first.appendSnapshot();
  const [candidate] = chain(lead, 1, { from: { seq: 2, hash: built[2].hash } });
  assert.deepEqual(await second.recordRosterHead(built[1].hash), { ok: true });
  const packet = { purpose: 'verified peer fixture' };
  assert.deepEqual(await first.putAccessEvidence(packet, expected),
    { refused: 'snapshot-changed', message: STORE_REFUSALS['snapshot-changed'] });
  assert.deepEqual(await first.accessEvidence(), []);
  assert.deepEqual(await first.appendOwn([candidate], expected),
    { refused: 'snapshot-changed', message: STORE_REFUSALS['snapshot-changed'] });
  assert.equal(first.has(candidate.hash), false);
  assert.deepEqual(await first.appendOwn([candidate]), { ok: true, written: 1 }, 'ordinary appends need no snapshot');
});

test('a guarded locally signed entry refuses a changed store before persisting any entry or blob', async () => {
  const { root, lead, secrets } = await threeAppended();
  const first = await opened(root, depsFor(lead, secrets));
  const other = fixedSigner('guard-other-signer');
  const second = await opened(root, depsFor(other, secrets));
  const expected = await first.appendSnapshot();
  const signer = fixedSigner('guarded-person-signer');
  const [candidate] = chain(signer, 1, { big: true });
  assert.equal(candidate.blobs.length, 1);

  assert.deepEqual(await second.appendOwn(chain(other, 1)), { ok: true, written: 1 });
  assert.deepEqual(await first.ingestForeign([candidate.entry], candidate.blobs, async () => ({ ok: true } as const), expected),
    { refused: 'snapshot-changed', message: STORE_REFUSALS['snapshot-changed'] });
  assert.equal(first.has(candidate.hash), false);
  assert.equal(await first.blob(candidate.blobs[0].hash), undefined);
});

test('guarded local writes retry when another window stores a cell key grant before commit', async () => {
  const { root, lead, secrets, built } = await threeAppended();
  const first = await opened(root, depsFor(lead, secrets));
  const second = await opened(root, depsFor(lead, secrets));
  const expected = await first.appendSnapshot();
  const [candidate] = chain(lead, 1, { from: { seq: 2, hash: built[2].hash }, big: true });
  const [hosted] = chain(fixedSigner('guarded-hosted-grants'), 1, { big: true });
  const cell = streamId('store/cell');
  const grant = signPayload(lead.signer, 'staff-cell-grant', { cell, epoch: 1, device: 'd1', wrapped: 'w' }, { now: () => new Date(AT) });
  assert.ok('ok' in await second.putGrant(cell, 1, grant));

  assert.deepEqual(await first.appendOwn([candidate], expected),
    { refused: 'snapshot-changed', message: STORE_REFUSALS['snapshot-changed'] });
  assert.deepEqual(await first.ingestForeign([hosted.entry], hosted.blobs, async () => ({ ok: true } as const), expected),
    { refused: 'snapshot-changed', message: STORE_REFUSALS['snapshot-changed'] });
  for (const entry of [candidate, hosted]) {
    assert.equal(first.has(entry.hash), false);
    assert.equal(await first.blob(entry.blobs[0].hash), undefined);
  }
});

test('both local signed write paths revalidate expiring authority before persisting the entry or blob', async () => {
  const { root, lead, secrets, built } = await threeAppended();
  const store = await opened(root, depsFor(lead, secrets));
  const expected = await store.appendSnapshot();
  const [device] = chain(lead, 1, { from: { seq: 2, hash: built[2].hash }, big: true });
  const [hosted] = chain(fixedSigner('managed-hosted-expiry'), 1, { big: true });
  const expired = (): boolean => false;
  assert.deepEqual(await store.appendOwn([device], expected, expired),
    { refused: 'snapshot-changed', message: STORE_REFUSALS['snapshot-changed'] });
  assert.deepEqual(await store.ingestForeign([hosted.entry], hosted.blobs, async () => ({ ok: true } as const), expected, expired),
    { refused: 'snapshot-changed', message: STORE_REFUSALS['snapshot-changed'] });
  for (const entry of [device, hosted]) {
    assert.equal(store.has(entry.hash), false);
    assert.equal(await store.blob(entry.blobs[0].hash), undefined);
  }
});

for (const writer of ['device', 'hosted'] as const) {
  test(`a staged ${writer} write that expires during sidecar sync makes no entry or content blob live`, async () => {
    const root = project();
    const lead = fixedSigner('staged-expiry-device');
    const store = await opened(root, depsFor(lead));
    const expected = await store.appendSnapshot();
    const signer = writer === 'device' ? lead : fixedSigner('staged-expiry-person');
    const frozen = prepareEntrySigning({ signer: signer.signer, key: epochKey('store'), stream: STREAM, seq: 0, prev: GENESIS_PREV, epoch: 0,
      body: { deps: [], roster: ROSTER, lamport: 1, at: AT, actor: { kind: 'person' }, kind: 'cell.rekey', data: { text: 'x'.repeat(20_000) } } });
    const candidate = frozen.finish(signer.signer.sign(frozen.signingBytes()));
    assert.ok(candidate);
    assert.equal(candidate.blobs.length, 1);
    let current = true;
    let synced = false;
    const submit = (entry: BuiltEntry, snapshot: string) => {
      const authorize = () => current && frozen.matches(entry);
      const sidecar = { entry: entry.hash, checked: true };
      return writer === 'device' ? store.appendOwn([entry], snapshot, authorize, sidecar) :
        store.ingestForeign([entry.entry], entry.blobs, async () => ({ ok: true } as const), snapshot,
          authorize, { root: entry.hash, evidence: [sidecar] });
    };
    const refused = { refused: 'snapshot-changed', message: STORE_REFUSALS['snapshot-changed'] };
    const [replacement] = chain(signer, 1, { big: true });
    assert.deepEqual(await submit(replacement, expected), refused);
    assert.equal(await store.blob(replacement.blobs[0].hash) === undefined, true);
    assert.deepEqual(await submit(candidate, '0'.repeat(64)), refused);
    assert.deepEqual(await store.accessEvidence(), []);
    setFolderSyncProbe((folder) => {
      if (path.basename(folder) !== 'access-evidence') return;
      current = false;
      synced = true;
    });
    try {
      assert.deepEqual(await submit(candidate, expected), refused);
      assert.equal(synced, true);
      assert.equal(store.has(candidate.hash), false);
      assert.equal(await store.blob(candidate.blobs[0].hash) === undefined, true);
      assert.equal((await store.accessEvidence()).length, 1, 'the sidecar remains dormant');
    } finally {
      setFolderSyncProbe(undefined);
    }
  });
}

test('only the first of two guarded same-device appends from one snapshot writes its signed entry', async () => {
  const { root, lead, secrets, built } = await threeAppended();
  const first = await opened(root, depsFor(lead, secrets));
  const second = await opened(root, depsFor(lead, secrets));
  const expected = await first.appendSnapshot();
  assert.equal(expected, await second.appendSnapshot());
  const from = { seq: 2, hash: built[2].hash };
  const [candidate] = chain(lead, 1, { from, tag: 'first' });
  const [rival] = chain(lead, 1, { from, tag: 'second' });
  const results = await Promise.all([first.appendOwn([candidate], expected), second.appendOwn([rival], expected)]);
  assert.equal(results.filter(result => 'ok' in result).length, 1);
  const refused = results.find(result => 'refused' in result);
  assert.ok(refused && 'refused' in refused);
  assertRefused(refused, 'snapshot-changed');
  const reopened = await opened(root, depsFor(lead, secrets));
  assert.ok(reopened.has(candidate.hash) !== reopened.has(rival.hash));
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
  const read = await readMark(secrets, path.join(root, REPLICA_DIR), ACTIVE);
  assert.equal(read.kind, 'mark', 'the shared mark verifies');
  const mark = read.kind === 'mark' ? read.mark : undefined;
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
  const read = await readMark(secrets, path.join(root, REPLICA_DIR), ACTIVE);
  assert.equal(read.kind, 'mark');
  assert.deepEqual(read.kind === 'mark' && read.mark.heads.map((head) => [head.writer, head.seq, head.count]).sort(), [[lead.writer, 24, 25], [other.writer, 4, 5]].sort());
});

test('twenty-five one-entry appendOwn calls started in order in one process are written in that order (the .planning/staff lock is joined in call order)', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const store = await opened(root, depsFor(lead, new MemorySecrets()));
  const built = chain(lead, 25);
  const results = await Promise.all(built.map((item) => store.appendOwn([item])));
  assert.ok(results.every((result) => 'ok' in result && result.written === 1), JSON.stringify(results.filter((result) => !('ok' in result))));
  const lines = readFileSync(streamFile(root, lead.writer), 'utf8').split('\n').slice(0, -1);
  assert.deepEqual(lines.map((line) => (JSON.parse(line) as SealedEntryLine).header.seq), [...Array(25).keys()]);
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
  assert.deepEqual(result, { ok: true, added: 3, duplicates: 0, held: [{ hash: foreign[1].hash, reason: 'too-large: the update is over the size limit' }], waiting: [], dropped: 0, blobsAdded: 0, blobsRefused: 0, flooded: 0, deferred: 0 });
  assert.equal(calls.length, 3);
  assert.equal(readFileSync(streamFile(root, colleague.writer), 'utf8').split('\n').length, 4, 'all three lines are written, the held one too');
  assert.deepEqual(store.heldForCheck(), [{ hash: foreign[1].hash, reason: 'too-large: the update is over the size limit' }]);
  assert.deepEqual(store.entries(), [foreign[0].entry, foreign[2].entry], 'the fold gets every entry except the held one');
  assert.ok(store.has(foreign[1].hash), 'the held entry is kept in the store');
  const again = await opened(root, depsFor(lead, secrets));
  assert.deepEqual(again.heldForCheck(), store.heldForCheck());
  assert.deepEqual(again.entries(), [foreign[0].entry, foreign[2].entry]);
  const mark = await readMark(secrets, path.join(root, REPLICA_DIR), ACTIVE);
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

// Before 31-REVIEW MJ-07 the held list was held.json in the project folder, outside the signed mark: deleting it let every held entry into the fold.
// The list now lives in the signed mark, so this test pins the new rule instead of the held.json refusals it used to pin.
test('the held list is covered by the signed mark: deleting or planting held.json changes nothing, editing it in the lists file refuses mark-unverified, deleting the lists file refuses rolled-back', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const foreign = chain(fixedSigner('colleague'), 2);
  await store.ingestForeign(foreign.map((item) => item.entry), [], countingCheck(new Set([foreign[0].hash])).check);
  const held = path.join(root, REPLICA_DIR, 'held.json');
  assert.equal(existsSync(held), false, 'nothing in the project folder decides what is held');
  writeFileSync(held, '{"v":1,"held":[]}');
  const again = await opened(root, depsFor(lead, secrets));
  assert.deepEqual(again.heldForCheck().map((item) => item.hash), [foreign[0].hash]);
  assert.deepEqual(again.entries(), [foreign[1].entry], 'the held entry stays out of the fold');
  const { file, bytes } = onlyListsFile(root, lead.writer);
  const lists = JSON.parse(bytes.toString('utf8')) as { held: unknown[] };
  assert.equal(lists.held.length, 1);
  lists.held = [];
  writeFileSync(file, `${JSON.stringify(lists)}\n`);
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'mark-unverified');
  // Renamed to the hash of its edited bytes, it is no longer the file the record names: still refused, never read as an empty list.
  const edited = readFileSync(file);
  rmSync(file);
  writeFileSync(path.join(path.dirname(file), `${sha256Hex(edited)}.json`), edited);
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'rolled-back');
  rmSync(path.join(path.dirname(file), `${sha256Hex(edited)}.json`));
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'rolled-back');
  rmSync(path.join(root, REPLICA_DIR, MARK_LISTS_DIR), { recursive: true });
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'rolled-back');
  assert.equal((await readMark(secrets, path.join(root, REPLICA_DIR), ACTIVE)).kind, 'lists-missing');
  // Put back, the held entry is held again.
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  const back = await opened(root, depsFor(lead, secrets));
  assert.deepEqual(back.heldForCheck().map((item) => item.hash), [foreign[0].hash]);
  assert.deepEqual(back.entries(), [foreign[1].entry]);
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
  const dir = path.join(root, REPLICA_DIR);
  const read = await readMark(secrets, dir, ACTIVE);
  assert.equal(read.kind === 'mark' && read.mark.rosterHead, roster[1].hash);
  await assert.rejects(() => store.recordRosterHead('e'.repeat(64)), /not an entry in this store/);
  const recorded = await readMark(secrets, dir, ACTIVE);
  assert.ok(recorded.kind === 'mark');
  await writeMark(secrets, dir, lead.signer, { ...recorded.mark, rosterHead: 'e'.repeat(64) });
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'rolled-back');
});

// ---- 31-REVIEW CR-02, MJ-06, MJ-07, MJ-08 ------------------------------------------------------------------------------------------------------

/** An entry built by `by` and then given this device's writer id: it does not carry this device's signature. */
function forgedAs(device: FixedSigner, by: FixedSigner, from: { seq: number; hash: string }): SealedEntry {
  const [built] = chain(by, 1, { from, tag: 'forged' });
  return { header: { ...built.entry.header, writer: device.writer }, body: built.entry.body };
}

test('CR-02: an entry naming this device as writer without its signature is dropped from outside, and planted in its file is damaged and never its head', async () => {
  const { root, lead, secrets, built } = await threeAppended();
  const store = await opened(root, depsFor(lead, secrets));
  const forged = forgedAs(lead, fixedSigner('intruder'), { seq: 998, hash: built[2].hash });
  assert.equal(forged.header.seq, 999);
  const { check, calls } = countingCheck(new Set());
  const result = await store.ingestForeign([forged], [], check);
  assert.ok('ok' in result);
  assert.deepEqual([result.added, result.dropped], [0, 1], 'the unsigned entry is dropped, not stored');
  assert.deepEqual(calls, []);
  assert.deepEqual(store.head(STREAM, lead.writer), { seq: 2, hash: built[2].hash }, 'the head did not move');
  // Planted straight into this device's own file: read as damaged, never as an entry, never as the head.
  appendFileSync(streamFile(root, lead.writer), `${JSON.stringify(forged)}\n`);
  const reopened = await opened(root, depsFor(lead, secrets));
  assert.equal(reopened.damagedLines(), 1);
  assert.equal(reopened.has(entryHash(forged.header)), false);
  assert.deepEqual(reopened.head(STREAM, lead.writer), { seq: 2, hash: built[2].hash });
  const [next] = chain(lead, 1, { from: { seq: 2, hash: built[2].hash } });
  assert.deepEqual(await reopened.appendOwn([next]), { ok: true, written: 1 }, 'the honest next entry is not blocked');
  assert.deepEqual(reopened.head(STREAM, lead.writer), { seq: 3, hash: next.hash });
  await assert.rejects(() => reopened.appendOwn([{ entry: forged, hash: entryHash(forged.header), blobs: [] }]), /only entries this device built and signed/);
  // This device's own signed entries from outside (a welcome carrying its own roster entries) are taken without a decode check.
  const other = await opened(project(), depsFor(lead));
  const own = await other.ingestForeign(built.map((item) => item.entry), [], check);
  assert.ok('ok' in own);
  assert.deepEqual([own.added, own.dropped], [3, 0]);
  assert.deepEqual(calls, []);
  assert.deepEqual(other.entries(), built.map((item) => item.entry));
});

test('MJ-06: a store with 1,300 (stream, writer) files is written, marked and reopened; the secret storage value stays under 2 KB', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const built = Array.from({ length: 1300 }, (_, index) => chain(lead, 1, { stream: streamId(`store/many/${index}`) })[0]);
  assert.deepEqual(await store.appendOwn(built), { ok: true, written: 1300 });
  const value = secrets.values.get(markKey(path.join(root, REPLICA_DIR))) as string;
  assert.ok(Buffer.byteLength(value) < 2048, `the secret storage value does not grow with the number of files (${Buffer.byteLength(value)} bytes)`);
  assert.equal((JSON.parse(onlyListsFile(root, lead.writer).bytes.toString('utf8')) as { heads: unknown[] }).heads.length, 1300);
  const again = await opened(root, depsFor(lead, secrets));
  assert.equal(again.entries().length, 1300);
  const [next] = chain(lead, 1, { stream: streamId('store/many/0'), from: { seq: 0, hash: built[0].hash } });
  assert.deepEqual(await again.appendOwn([next]), { ok: true, written: 1 });
  const read = await readMark(secrets, path.join(root, REPLICA_DIR), ACTIVE);
  assert.equal(read.kind === 'mark' && read.mark.heads.length, 1300);
});

class FailingSecrets extends MemorySecrets {
  public failNext = false;
  public override store(key: string, value: string): Promise<void> {
    if (this.failNext) { this.failNext = false; return Promise.reject(new Error('secret storage is busy')); }
    return super.store(key, value);
  }
}

test('MJ-06: a mark that could not be recorded leaves the synced lines ahead of it; the store still opens and the next write records every file', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new FailingSecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const built = chain(lead, 3);
  assert.deepEqual(await store.appendOwn([built[0]]), { ok: true, written: 1 });
  secrets.failNext = true;
  await assert.rejects(() => store.appendOwn([built[1]]), /busy/);
  assert.ok(store.has(built[1].hash), 'the line was written and synced before the mark');
  const again = await opened(root, depsFor(lead, secrets));
  assert.equal(again.entries().length, 2, 'the older mark is a floor, so the store opens');
  assert.deepEqual(await again.appendOwn([built[2]]), { ok: true, written: 1 });
  const read = await readMark(secrets, path.join(root, REPLICA_DIR), ACTIVE);
  assert.deepEqual(read.kind === 'mark' && read.mark.heads.map((head) => [head.seq, head.count]), [[2, 3]]);
});

/** A mark of `heads` heads and `listed` held and waiting entries each, every held reason MAX_HELD_REASON long. */
function bigMark(heads: number, listed: number): ReplicaMark {
  const hex = (tag: string, index: number): string => sha256Hex(Buffer.from(`${tag}/${index}`));
  return {
    rosterHead: null,
    heads: Array.from({ length: heads }, (_, index) => ({ stream: hex('s', index).slice(0, 32), writer: hex('w', index), seq: index, hash: hex('h', index), count: index + 1, digest: hex('d', index) })),
    held: Array.from({ length: listed }, (_, index) => ({ hash: hex('held', index), reason: 'r'.repeat(200) })),
    waiting: Array.from({ length: listed }, (_, index) => ({ hash: hex('wait', index), reason: 'awaiting-key' as const }))
  };
}

test('PR #130 review: with 1,300 heads and 5,000 held and 5,000 waiting entries the secret storage value stays under 2 KB; the lists are in the content-addressed file', async () => {
  const dir = path.join(project(), REPLICA_DIR);
  mkdirSync(dir, { recursive: true });
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const mark = bigMark(1300, 5000);
  const text = await writeMark(secrets, dir, lead.signer, mark, () => new Date(AT));
  assert.equal(secrets.values.get(markKey(dir)), text);
  assert.ok(Buffer.byteLength(text) < 2048, `the secret storage value is ${Buffer.byteLength(text)} bytes`);
  const stored = JSON.parse(text) as { v: number; signed: unknown };
  assert.deepEqual(Object.keys(stored).sort(), ['signed', 'v']);
  const verdict = verifyPayload<{ content: string }>(stored.signed, { purpose: 'staff-replica-mark', status: ACTIVE });
  assert.ok(verdict.ok);
  const folder = markListsFolder(dir, lead.writer);
  assert.equal(folder, path.join(dir, 'marks', lead.writer));
  assert.deepEqual(readdirSync(folder), [`${verdict.payload.content}.json`], 'the lists file is named by the signed content hash');
  const bytes = readFileSync(path.join(folder, `${verdict.payload.content}.json`));
  assert.equal(sha256Hex(bytes), verdict.payload.content, 'the signed content is the sha256 of the lists file');
  assert.ok(bytes.length > 1_000_000, 'the lists are in the file, not in secret storage');
  const read = await readMark(secrets, dir, ACTIVE);
  assert.equal(read.kind, 'mark');
  assert.deepEqual(read.kind === 'mark' && read.mark, parseReplicaMark(mark));
});

test('PR #130 review: a crash between the lists file and the secret leaves the old mark readable and the store opening; older lists files go only after a secret write', async () => {
  const root = project();
  const dir = path.join(root, REPLICA_DIR);
  const lead = fixedSigner('lead');
  const secrets = new FailingSecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const built = chain(lead, 4);
  assert.deepEqual(await store.appendOwn([built[0]]), { ok: true, written: 1 });
  const before = onlyListsFile(root, lead.writer);
  const oldText = secrets.values.get(markKey(dir));
  // The lists file is written, then the secret write fails: the new file is there, the old one is not removed, and the secret is unchanged.
  secrets.failNext = true;
  await assert.rejects(() => store.appendOwn([built[1]]), /busy/);
  assert.equal(secrets.values.get(markKey(dir)), oldText);
  const folder = markListsFolder(dir, lead.writer);
  const names = readdirSync(folder).sort();
  assert.equal(names.length, 2, `the old lists file stays until a secret write names a new one: ${names.join(', ')}`);
  assert.ok(names.includes(before.name));
  assert.ok(readFileSync(before.file).equals(before.bytes));
  const read = await readMark(secrets, dir, ACTIVE);
  assert.deepEqual(read.kind === 'mark' && read.mark.heads.map((head) => [head.seq, head.count]), [[0, 1]], 'the old mark reads');
  const again = await opened(root, depsFor(lead, secrets));
  assert.equal(again.entries().length, 2);
  // A stale temporary file and a stale lists file of this device are removed with the old one after the next secret write; other files stay.
  writeFileSync(path.join(folder, `${'b'.repeat(64)}.json`), '{}\n');
  writeFileSync(path.join(folder, `${'c'.repeat(64)}.json.123.abcdefabcdef.tmp`), 'x');
  writeFileSync(path.join(folder, 'notes.txt'), 'kept');
  const otherDevice = markListsFolder(dir, fixedSigner('other-install').writer);
  mkdirSync(otherDevice, { recursive: true });
  writeFileSync(path.join(otherDevice, `${'d'.repeat(64)}.json`), '{}\n');
  assert.deepEqual(await again.appendOwn([built[2]]), { ok: true, written: 1 });
  const after = readdirSync(folder).sort();
  const current = JSON.parse(secrets.values.get(markKey(dir)) as string) as { signed: { payload: { content: string } } };
  assert.deepEqual(after, [`${current.signed.payload.content}.json`, 'notes.txt'].sort());
  assert.deepEqual(readdirSync(otherDevice), [`${'d'.repeat(64)}.json`], 'another install\'s lists are never removed');
  // A failed secret write never removes anything.
  secrets.failNext = true;
  await assert.rejects(() => again.appendOwn([built[3]]), /busy/);
  assert.ok(readdirSync(folder).includes(`${current.signed.payload.content}.json`));
  assert.equal((await readMark(secrets, dir, ACTIVE)).kind, 'mark');
});

// The parse-limit test of the lists file moved to staffReplicaMarks.test.ts (32-07), with its figures set to the D-14 bounds.

test('MJ-07: an entry the check cannot run on yet waits out of the fold, across a reopen, until recheck passes or holds it; a held entry is never let in', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const foreign = chain(fixedSigner('colleague'), 3);
  const later: ForeignCheck = (entry) => {
    const hash = entryHash(entry.header);
    return Promise.resolve(hash === foreign[1].hash ? { ok: false, awaiting: 'key' } : hash === foreign[2].hash ? { ok: false, awaiting: 'blob' } : { ok: true });
  };
  const result = await store.ingestForeign(foreign.map((item) => item.entry), [], later);
  assert.ok('ok' in result);
  assert.deepEqual(result.held, []);
  assert.deepEqual(result.waiting, [{ hash: foreign[1].hash, reason: 'awaiting-key' }, { hash: foreign[2].hash, reason: 'awaiting-blob' }]);
  assert.deepEqual(store.entries(), [foreign[0].entry], 'an entry that was not checked does not reach the fold');
  assert.deepEqual(store.rosterEntries(), foreign.map((item) => item.entry), 'the roster fold reads the waiting entries too, so it can settle the keys they wait for');
  const again = await opened(root, depsFor(lead, secrets));
  assert.deepEqual(again.waitingForCheck(), store.waitingForCheck(), 'the waiting list is in the signed mark');
  assert.deepEqual(again.entries(), [foreign[0].entry]);
  assert.deepEqual(await again.recheck(later), { ok: true, passed: 0, held: 0, waiting: 2 }, 'still no key or blob: still waiting');
  const { check, calls } = countingCheck(new Set([foreign[2].hash]));
  assert.deepEqual(await again.recheck(check), { ok: true, passed: 1, held: 1, waiting: 0 });
  assert.deepEqual([...calls].sort(), [foreign[1].hash, foreign[2].hash].sort());
  assert.deepEqual(again.entries(), [foreign[0].entry, foreign[1].entry]);
  assert.deepEqual(again.heldForCheck().map((item) => item.hash), [foreign[2].hash]);
  assert.deepEqual(again.rosterEntries(), [foreign[0].entry, foreign[1].entry], 'a held entry reaches neither fold');
  const third = await opened(root, depsFor(lead, secrets));
  assert.deepEqual(await third.recheck(() => Promise.resolve({ ok: true })), { ok: true, passed: 0, held: 0, waiting: 0 });
  assert.deepEqual(third.heldForCheck().map((item) => item.hash), [foreign[2].hash], 'a later check never releases a held entry');
  assert.deepEqual(third.entries(), [foreign[0].entry, foreign[1].entry]);
});

test('MJ-07: lines copied into streams/ by hand wait unchecked until a check passes them, and another open store takes that verdict from the mark', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const open = await opened(root, depsFor(lead, secrets));
  const colleague = fixedSigner('colleague');
  const foreign = chain(colleague, 2);
  const file = streamFile(root, colleague.writer);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, foreign.map((item) => `${JSON.stringify(item.entry)}\n`).join(''));
  const again = await opened(root, depsFor(lead, secrets));
  assert.deepEqual(again.entries(), []);
  assert.deepEqual(again.waitingForCheck(), foreign.map((item) => ({ hash: item.hash, reason: 'unchecked' })));
  assert.ok(again.waitingVersion > 0);
  const { check } = countingCheck(new Set([foreign[1].hash]));
  assert.deepEqual(await again.recheck(check), { ok: true, passed: 1, held: 1, waiting: 0 });
  assert.deepEqual(again.entries(), [foreign[0].entry]);
  assert.ok('ok' in await open.refresh());
  assert.deepEqual(open.entries(), [foreign[0].entry], 'the store that was open when they were copied in takes the verdicts from the mark');
  assert.deepEqual(open.heldForCheck().map((item) => item.hash), [foreign[1].hash]);
});

// ---- 32-07 (D-14): a bound on refused entries, so one device cannot grow this device's mark until it can no longer be written --------------

const REFUSED = 'too-large: the update is over the size limit';
const refuseAll: ForeignCheck = () => Promise.resolve({ ok: false, reason: REFUSED });

function linesOf(root: string, writer: string, stream = STREAM): number {
  const file = streamFile(root, writer, stream);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
}

test('D-14 flooded: a colleague\'s 1,200 refused entries keep 1,000 with one flooded line; the mark still advances for everyone else, across a reopen', async () => {
  assert.equal(MAX_REFUSED_PER_WRITER, 1_000);
  assert.equal(heldReason(FLOODED_REASON), FLOODED_REASON, 'the flooded line is a held reason as this version stores it');
  assert.equal(FLOODED_TEXT, 'Too many refused changes arrived from one device. They were not kept.');
  const root = project();
  const lead = fixedSigner('lead');
  const colleague = fixedSigner('colleague');
  const secrets = new MemorySecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const flood = chain(colleague, 1205);
  const result = await store.ingestForeign(flood.slice(0, 1200).map((item) => item.entry), [], refuseAll);
  assert.ok('ok' in result);
  assert.equal(result.added, 1000, 'only the first 1,000 are written');
  assert.equal(result.held.length, 1000);
  assert.ok(result.held.slice(0, 999).every((item) => item.reason === REFUSED));
  assert.deepEqual(result.held[999], { hash: flood[999].hash, reason: FLOODED_REASON }, 'the 1,000th is the writer\'s one flooded line');
  assert.equal(result.flooded, 200);
  assert.equal(result.deferred, 0);
  assert.equal(linesOf(root, colleague.writer), 1000);
  assert.deepEqual(store.flooded(), [{ stream: STREAM, writer: colleague.writer }]);
  const dir = path.join(root, REPLICA_DIR);
  const read = await readMark(secrets, dir, ACTIVE);
  assert.equal(read.kind === 'mark' && read.mark.held.length, 1000, 'the mark verifies and holds 1,000');
  // Everyone else's changes are still recorded.
  const other = fixedSigner('second colleague');
  const passing = chain(other, 3);
  const taken = await store.ingestForeign(passing.map((item) => item.entry), [], countingCheck(new Set()).check);
  assert.ok('ok' in taken);
  assert.equal(taken.added, 3);
  assert.equal(taken.flooded, 0);
  assert.deepEqual(store.entries(), passing.map((item) => item.entry));
  const after = await readMark(secrets, dir, ACTIVE);
  assert.deepEqual(after.kind === 'mark' && after.mark.heads.filter((head) => head.writer === other.writer).map((head) => [head.seq, head.hash, head.count]), [[2, passing[2].hash, 3]]);
  // The flooded writer's later entries are not written, even ones the check would pass, and the check is not called for them.
  const { check, calls } = countingCheck(new Set());
  const later = await store.ingestForeign(flood.slice(1200).map((item) => item.entry), [], check);
  assert.ok('ok' in later);
  assert.equal(later.added, 0);
  assert.equal(later.flooded, 5);
  assert.deepEqual(later.held, []);
  assert.deepEqual(calls, [], 'a flooded writer costs no more checks');
  assert.equal(linesOf(root, colleague.writer), 1000);
  const again = await opened(root, depsFor(lead, secrets));
  assert.deepEqual(again.flooded(), [{ stream: STREAM, writer: colleague.writer }], 'the flooded line is read back from the mark');
  assert.equal(again.heldForCheck().length, 1000);
  const retry = await again.ingestForeign(flood.slice(1200).map((item) => item.entry), [], check);
  assert.equal('ok' in retry && retry.flooded, 5);
  assert.deepEqual(calls, []);
});

test('D-14 flooded: a check reason that equals the flooded line is stored with "check: " in front and never floods a writer', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const store = await opened(root, depsFor(lead));
  const foreign = chain(fixedSigner('colleague'), 2);
  const imitating: ForeignCheck = () => Promise.resolve({ ok: false, reason: ` ${FLOODED_REASON}\n` });
  const result = await store.ingestForeign(foreign.map((item) => item.entry), [], imitating);
  assert.ok('ok' in result);
  assert.equal(result.added, 2);
  assert.deepEqual(result.held.map((item) => item.reason), [`check: ${FLOODED_REASON}`, `check: ${FLOODED_REASON}`]);
  assert.deepEqual(store.flooded(), []);
  assert.deepEqual((await opened(root, depsFor(lead))).flooded(), []);
});

test('D-14 store bound: the held list stops at MAX_MARK_LISTED with a flooded line, a later writer\'s refused entry is not kept, and its passing one is written', async () => {
  assert.equal(MAX_MARK_LISTED, 10_000);
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const dir = path.join(root, REPLICA_DIR);
  const verifies = async (held: number): Promise<void> => {
    const read = await readMark(secrets, dir, ACTIVE);
    assert.equal(read.kind, 'mark', 'the mark can always be written and read');
    assert.equal(read.kind === 'mark' && read.mark.held.length, held);
  };
  for (let index = 0; index < 10; index += 1) {
    const result = await store.ingestForeign(chain(fixedSigner(`flooding writer ${index}`), 999).map((item) => item.entry), [], refuseAll);
    assert.ok('ok' in result);
    assert.equal(result.held.length, 999);
    assert.equal(result.flooded, 0, 'one short of a writer\'s bound floods nothing');
    await verifies(999 * (index + 1));
  }
  assert.deepEqual(store.flooded(), []);
  const eleventh = fixedSigner('eleventh writer');
  const filling = chain(eleventh, 20);
  const full = await store.ingestForeign(filling.map((item) => item.entry), [], refuseAll);
  assert.ok('ok' in full);
  assert.equal(full.added, 10);
  assert.equal(full.held.length, 10);
  assert.ok(full.held.slice(0, 9).every((item) => item.reason === REFUSED));
  assert.deepEqual(full.held[9], { hash: filling[9].hash, reason: FLOODED_REASON }, 'the entry that fills the held list is its writer\'s flooded line');
  assert.equal(full.flooded, 10);
  assert.equal(store.heldForCheck().length, MAX_MARK_LISTED);
  assert.equal(linesOf(root, eleventh.writer), 10);
  await verifies(MAX_MARK_LISTED);
  const twelfth = fixedSigner('twelfth writer');
  const late = chain(twelfth, 2);
  const result = await store.ingestForeign(late.map((item) => item.entry), [], countingCheck(new Set([late[0].hash])).check);
  assert.ok('ok' in result);
  assert.equal(result.added, 1);
  assert.equal(result.flooded, 1, 'a refused entry the held list has no room for is not kept');
  assert.deepEqual(result.held, []);
  assert.deepEqual(store.flooded(), [{ stream: STREAM, writer: eleventh.writer }], 'the twelfth writer is not flooded');
  assert.equal(store.has(late[0].hash), false);
  assert.deepEqual(store.entries(), [late[1].entry], 'its passing entry is written and reaches the fold');
  assert.equal(linesOf(root, twelfth.writer), 1);
  await verifies(MAX_MARK_LISTED);
  const again = await opened(root, depsFor(lead, secrets));
  assert.equal(again.heldForCheck().length, MAX_MARK_LISTED);
  assert.deepEqual(again.flooded(), [{ stream: STREAM, writer: eleventh.writer }]);
});

test('D-14 recheck: a refusal that reaches a writer\'s bound becomes its flooded line; the flooded writer\'s waiting entries stay out and are not checked again', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const colleague = fixedSigner('colleague');
  const foreign = chain(colleague, 1002);
  const first = await store.ingestForeign(foreign.slice(0, 999).map((item) => item.entry), [], refuseAll);
  assert.equal('ok' in first && first.held.length, 999);
  const awaiting: ForeignCheck = () => Promise.resolve({ ok: false, awaiting: 'key' });
  const waiting = await store.ingestForeign(foreign.slice(999).map((item) => item.entry), [], awaiting);
  assert.equal('ok' in waiting && waiting.waiting.length, 3);
  const calls: string[] = [];
  const refusing: ForeignCheck = (entry) => { calls.push(entryHash(entry.header)); return Promise.resolve({ ok: false, reason: REFUSED }); };
  assert.deepEqual(await store.recheck(refusing), { ok: true, passed: 0, held: 1, waiting: 2 });
  assert.deepEqual(store.heldForCheck().find((item) => item.hash === foreign[999].hash), { hash: foreign[999].hash, reason: FLOODED_REASON });
  assert.equal(store.heldForCheck().length, 1000);
  assert.deepEqual(store.flooded(), [{ stream: STREAM, writer: colleague.writer }]);
  assert.deepEqual(store.waitingForCheck().map((item) => item.hash), [foreign[1000].hash, foreign[1001].hash], 'the other two stay waiting, out of the fold');
  assert.deepEqual(store.entries(), []);
  calls.length = 0;
  const passing = countingCheck(new Set());
  assert.deepEqual(await store.recheck(passing.check), { ok: true, passed: 0, held: 0, waiting: 2 });
  assert.deepEqual(passing.calls, [], 'a flooded writer\'s waiting entries are not checked again');
  assert.deepEqual(store.entries(), [], 'and never reach the fold');
  const again = await opened(root, depsFor(lead, secrets));
  assert.deepEqual(await again.recheck(passing.check), { ok: true, passed: 0, held: 0, waiting: 2 });
  assert.deepEqual(passing.calls, []);
  assert.equal((await readMark(secrets, path.join(root, REPLICA_DIR), ACTIVE)).kind, 'mark');
});

test('D-14 recheck: with the held list full, a waiting entry the check refuses stays waiting and its writer is not flooded', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const deps: ReplicaStoreDeps = { ...depsFor(lead), limits: { heldPerStore: 2 } };
  const store = await opened(root, deps);
  const flooding = fixedSigner('colleague');
  const filled = await store.ingestForeign(chain(flooding, 3).map((item) => item.entry), [], refuseAll);
  assert.ok('ok' in filled);
  assert.deepEqual(filled.held.map((item) => item.reason), [REFUSED, FLOODED_REASON], 'the entry that fills the held list is the flooded line');
  assert.equal(filled.flooded, 1);
  const other = fixedSigner('second colleague');
  const later = chain(other, 1);
  await store.ingestForeign(later.map((item) => item.entry), [], () => Promise.resolve({ ok: false, awaiting: 'blob' }));
  const { check, calls } = countingCheck(new Set([later[0].hash]));
  assert.deepEqual(await store.recheck(check), { ok: true, passed: 0, held: 0, waiting: 1 });
  assert.deepEqual(calls, [later[0].hash]);
  assert.deepEqual(store.waitingForCheck(), [{ hash: later[0].hash, reason: 'awaiting-blob' }]);
  assert.equal(store.heldForCheck().length, 2);
  assert.deepEqual(store.flooded(), [{ stream: STREAM, writer: flooding.writer }]);
  // When the check passes it later, it reaches the fold.
  assert.deepEqual(await store.recheck(countingCheck(new Set()).check), { ok: true, passed: 1, held: 0, waiting: 0 });
  assert.deepEqual(store.entries(), [later[0].entry]);
});

test('D-14 waiting bound: past it a new entry that would wait is not written and is deferred, and it is taken when delivered again', async () => {
  assert.equal(MAX_MARK_WAITING, 100_000);
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const deps: ReplicaStoreDeps = { ...depsFor(lead, secrets), limits: { waiting: 5 } };
  const store = await opened(root, deps);
  const colleague = fixedSigner('colleague');
  const foreign = chain(colleague, 8);
  const awaiting: ForeignCheck = () => Promise.resolve({ ok: false, awaiting: 'key' });
  const result = await store.ingestForeign(foreign.map((item) => item.entry), [], awaiting);
  assert.ok('ok' in result);
  assert.equal(result.added, 5);
  assert.equal(result.waiting.length, 5);
  assert.equal(result.deferred, 3);
  assert.equal(result.flooded, 0);
  assert.equal(linesOf(root, colleague.writer), 5);
  for (const item of foreign.slice(5)) assert.equal(store.has(item.hash), false, 'a deferred entry is not in the files');
  assert.equal((await readMark(secrets, path.join(root, REPLICA_DIR), ACTIVE)).kind, 'mark');
  assert.deepEqual(await store.recheck(countingCheck(new Set()).check), { ok: true, passed: 5, held: 0, waiting: 0 });
  const again = await store.ingestForeign(foreign.map((item) => item.entry), [], countingCheck(new Set()).check);
  assert.ok('ok' in again);
  assert.equal(again.duplicates, 5);
  assert.equal(again.added, 3);
  assert.equal(again.deferred, 0);
  assert.deepEqual(store.entries(), foreign.map((item) => item.entry));
  // Without the override the bound is MAX_MARK_WAITING, so eight waiting entries are all taken.
  const plain = await opened(project(), depsFor(lead));
  const taken = await plain.ingestForeign(foreign.map((item) => item.entry), [], awaiting);
  assert.ok('ok' in taken);
  assert.equal(taken.waiting.length, 8);
  assert.equal(taken.deferred, 0);
});

/** Every file under a folder by relative path with the hash of its bytes, leaving out the lock file. */
function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of listTree(dir)) {
    if (item.endsWith('/') || item === 'replica.lock') continue;
    out[item] = sha256Hex(readFileSync(path.join(dir, item)));
  }
  return out;
}

function assertStoreRefused(result: unknown, reason: StoreRefused['refused']): void {
  assert.deepEqual(result, { refused: reason, message: STORE_REFUSALS[reason] });
}

test('MJ-08: Start Again on a rolled-back store sets the folder aside byte for byte, carries this device\'s signed entries, grants, blobs and project.json, and the new store opens', async () => {
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const store = await opened(root, depsFor(lead, secrets));
  const [first] = chain(lead, 1, { big: true });
  const own = [first, ...chain(lead, 2, { from: { seq: 0, hash: first.hash } })];
  assert.deepEqual(await store.appendOwn(own), { ok: true, written: 3 });
  const colleague = fixedSigner('colleague');
  await store.ingestForeign(chain(colleague, 2).map((item) => item.entry), [], countingCheck(new Set()).check);
  const cell = streamId('store/cell');
  const grant = signPayload(lead.signer, 'staff-cell-grant', { cell, epoch: 1, device: 'd1', wrapped: 'w' }, { now: () => new Date(AT) });
  const put = await store.putGrant(cell, 1, grant);
  assert.ok('ok' in put);
  const dir = path.join(root, REPLICA_DIR);
  writeFileSync(path.join(dir, 'project.json'), '{"v":1,"anchor":"as written by the project host"}\n');
  // An older copy of the colleague's file comes back: one of its two lines.
  const colleagueFile = streamFile(root, colleague.writer);
  writeFileSync(colleagueFile, `${readFileSync(colleagueFile, 'utf8').split('\n')[0]}\n`);
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'rolled-back');
  const before = filesOf(dir);
  const started = await ReplicaStore.startAgain(root, depsFor(lead, secrets));
  assert.deepEqual(started, { ok: true, setAside: `${REPLICA_DIR}.set-aside-20261119-110000`, carried: 3 });
  const aside = path.join(root, `${REPLICA_DIR}.set-aside-20261119-110000`);
  assert.deepEqual(filesOf(aside), before, 'the old folder is set aside unchanged, nothing deleted');
  assert.equal(readFileSync(path.join(aside, '.gitignore'), 'utf8'), STORE_GITIGNORE, 'git still ignores the folder set aside');
  const fresh = await opened(root, depsFor(lead, secrets));
  assert.deepEqual(fresh.entries(), own.map((item) => item.entry), 'only this device\'s own signed entries are carried');
  assert.deepEqual(fresh.head(STREAM, lead.writer), { seq: 2, hash: own[2].hash });
  assert.deepEqual(await fresh.blob(first.blobs[0].hash), first.blobs[0]);
  assert.deepEqual((await fresh.grants()).grants.map((item) => item.hash), [put.hash]);
  assert.equal(readFileSync(path.join(dir, 'project.json'), 'utf8'), '{"v":1,"anchor":"as written by the project host"}\n');
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), STORE_GITIGNORE);
  const [next] = chain(lead, 1, { from: { seq: 2, hash: own[2].hash } });
  assert.deepEqual(await fresh.appendOwn([next]), { ok: true, written: 1 }, 'the next own entry follows the last one: no fork');
  // Run again on a store that opens: refused not-needed, and nothing is set aside.
  assertStoreRefused(await ReplicaStore.startAgain(root, depsFor(lead, secrets)), 'not-needed');
  assert.deepEqual(readdirSync(path.dirname(dir)).sort(), ['replica', 'replica.set-aside-20261119-110000']);
});

test('MJ-08: Start Again resolves damaged and mark-unverified too, names each folder set aside apart, and leaves a symbolic link refusal alone', async () => {
  const { root, lead, secrets, built } = await threeAppended();
  const file = streamFile(root, lead.writer);
  const lines = readFileSync(file, 'utf8').split('\n');
  const edited = JSON.parse(lines[1]) as { header: unknown; body: string };
  edited.body = `${edited.body.slice(0, -2)}${edited.body.endsWith('AA') ? 'BB' : 'AA'}`;
  lines[1] = JSON.stringify(edited);
  writeFileSync(file, lines.join('\n'));
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'damaged');
  const damaged = await ReplicaStore.startAgain(root, depsFor(lead, secrets));
  assert.deepEqual(damaged, { ok: true, setAside: `${REPLICA_DIR}.set-aside-20261119-110000`, carried: 2 });
  const after = await opened(root, depsFor(lead, secrets));
  assert.deepEqual(after.head(STREAM, lead.writer), { seq: 2, hash: built[2].hash });
  // The mark does not verify: started again too, in a folder of its own beside the first.
  secrets.values.set(markKey(path.join(root, REPLICA_DIR)), 'not json');
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'mark-unverified');
  const unverified = await ReplicaStore.startAgain(root, depsFor(lead, secrets));
  assert.deepEqual(unverified, { ok: true, setAside: `${REPLICA_DIR}.set-aside-20261119-110000-2`, carried: 2 });
  assert.ok(await ReplicaStore.open(root, depsFor(lead, secrets)) instanceof ReplicaStore);
  assert.equal((await readMark(secrets, path.join(root, REPLICA_DIR), ACTIVE)).kind, 'mark', 'a new mark that verifies');
  // A refusal with its own fix is never reset.
  const linked = project();
  const elsewhere = project();
  mkdirSync(path.join(linked, '.planning'));
  symlinkSync(elsewhere, path.join(linked, '.planning', 'staff'));
  assertStoreRefused(await ReplicaStore.startAgain(linked, depsFor(lead)), 'symlink');
  assert.deepEqual(readdirSync(elsewhere), []);
  // A fresh store opens, so there is nothing to start again.
  assertStoreRefused(await ReplicaStore.startAgain(project(), depsFor(lead)), 'not-needed');
});

test('every store refusal that Start Again resolves names the command, and the others do not', () => {
  for (const [reason, message] of Object.entries(STORE_REFUSALS)) {
    assert.equal(message.includes(START_AGAIN_COMMAND_TITLE), ['rolled-back', 'damaged', 'mark-unverified'].includes(reason), reason);
  }
  assert.equal(START_AGAIN_COMMAND_TITLE, 'Staff: Start This Computer\'s Shared History Again');
});

test('SECURITY.md has the replica store subsection once, inside the multi-user section, with no em-dash', () => {
  const text = readFileSync(path.resolve(__dirname, '..', '..', 'SECURITY.md'), 'utf8');
  assert.equal(text.split('\n').filter((line) => line === '### The replica store and rollback detection').length, 1);
  const section = text.slice(text.indexOf('## Multi-user staff projects (preview)'), text.indexOf('\n## ', text.indexOf('## Multi-user staff projects (preview)') + 1));
  assert.ok(section.includes('### The replica store and rollback detection'));
  assert.doesNotMatch(text, /\u2014/);
  for (const phrase of ['.planning/staff/replica/', 'git', 'secret storage', 'private key', 'set aside']) assert.ok(section.toLowerCase().includes(phrase.toLowerCase()), phrase);
  // 32-07 (D-14, D-03, D-06): the bounds of the lists file, the synced lists folder and the resumable Start Again, in the replica store subsection.
  const start = text.indexOf('### The replica store and rollback detection');
  const subsection = text.slice(start, text.indexOf('\n### ', start + 1));
  for (const phrase of ['1,000', '10,000', '100,000 waiting', 'finishes', 'never starts empty', 'synced to disk before']) assert.ok(subsection.includes(phrase), phrase);
  assert.doesNotMatch(subsection, /few hundred bytes, however many files/, 'the old promise is replaced by the bound');
});
