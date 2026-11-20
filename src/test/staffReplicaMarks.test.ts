// The replica store's signed mark (marks.ts): the parse limits of its lists file (32-CONTEXT D-14), and the folder syncs that keep the lists file the
// signed record names on disk through a power cut (D-06).
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { GENESIS_PREV, buildEntry, sha256Hex } from '../domain/replica/entry';
import type { BuiltEntry } from '../domain/replica/entry';
import { REPLICA_DIR } from '../domain/staff/multiUser';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { signPayload } from '../domain/team/signedPayload';
import type { SecretStorageLike } from '../services/auth';
import { MARK_LISTS_DIR, MARK_VERSION, MAX_MARK_LISTED, MAX_MARK_LISTS_BYTES, MAX_MARK_WAITING, markKey, markListsFolder, readMark, writeMark } from '../staff/replica/marks';
import type { ReplicaMark } from '../staff/replica/marks';
import { ReplicaStore, STORE_REFUSALS } from '../staff/replica/store';
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
const STREAM = streamId('marks/products');
const ROSTER = 'a'.repeat(64);
const AT = '2026-11-20T09:00:00.000Z';

function project(): string {
  return mkdtempSync(path.join(tmpdir(), 'near-ai-replica-marks-'));
}

function depsFor(device: FixedSigner, secrets: SecretStorageLike): ReplicaStoreDeps {
  return { secrets, signer: () => Promise.resolve(device.signer), keyStatus: () => Promise.resolve(ACTIVE), now: () => new Date(AT) };
}

function chain(device: FixedSigner, count: number): BuiltEntry[] {
  const out: BuiltEntry[] = [];
  let prev = GENESIS_PREV;
  for (let seq = 0; seq < count; seq += 1) {
    const built = buildEntry({ signer: device.signer, key: epochKey('marks'), stream: STREAM, seq, prev, epoch: 0, body: { deps: [], roster: ROSTER, lamport: seq, at: AT, actor: { kind: 'person' }, kind: 'doc.update', data: { n: seq } } });
    out.push(built);
    prev = built.hash;
  }
  return out;
}

async function threeAppended(): Promise<{ root: string; lead: FixedSigner; secrets: MemorySecrets }> {
  const root = project();
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const store = await ReplicaStore.open(root, depsFor(lead, secrets));
  assert.ok(store instanceof ReplicaStore);
  for (const item of chain(lead, 3)) assert.deepEqual(await store.appendOwn([item]), { ok: true, written: 1 });
  return { root, lead, secrets };
}

function onlyListsFile(root: string, writer: string): { file: string; name: string; bytes: Buffer } {
  const folder = markListsFolder(path.join(root, REPLICA_DIR), writer);
  const names = readdirSync(folder);
  assert.equal(names.length, 1, `one lists file: ${names.join(', ')}`);
  const file = path.join(folder, names[0]);
  return { file, name: names[0], bytes: readFileSync(file) };
}

function assertRefused(result: ReplicaStore | StoreRefused, reason: StoreRefused['refused']): void {
  assert.ok(!(result instanceof ReplicaStore), `refused ${reason}`);
  assert.equal((result as StoreRefused).refused, reason);
  assert.equal((result as StoreRefused).message, STORE_REFUSALS[reason]);
}

// The D-14 figures, written out so a test fails when a bound changes, not only when the code disagrees with its own constant.
const HELD_BOUND = 10_000;
const WAITING_BOUND = 100_000;

const byHash = (a: { hash: string }, b: { hash: string }): number => (a.hash < b.hash ? -1 : 1);
const hashes = (tag: string, count: number): string[] => Array.from({ length: count }, (_, index) => sha256Hex(Buffer.from(`${tag}/${index}`)));

/** Plants a lists file of these lists and a record signed by this device naming it, with the sizes given. */
function planter(dir: string, lead: FixedSigner, secrets: MemorySecrets): (lists: { held: unknown[]; waiting: unknown[] }, sizes: { held: number; waiting: number }) => void {
  return (lists, sizes) => {
    const bytes = Buffer.from(`${JSON.stringify({ v: MARK_VERSION, heads: [], held: lists.held, waiting: lists.waiting })}\n`);
    const content = sha256Hex(bytes);
    writeFileSync(path.join(markListsFolder(dir, lead.writer), `${content}.json`), bytes);
    const signed = signPayload(lead.signer, 'staff-replica-mark', { v: MARK_VERSION, rosterHead: null, heads: 0, held: sizes.held, waiting: sizes.waiting, content }, { now: () => new Date(AT) });
    secrets.values.set(markKey(dir), JSON.stringify({ v: MARK_VERSION, signed }));
  };
}

// Moved here from staffReplicaStore.test.ts by 32-07, with the waiting figure set to MAX_MARK_WAITING (D-14).
test('PR #130 review: a lists file over the size limit, a symbolic link, or a file naming more than MAX_MARK_WAITING waiting entries is unverified, never read as empty', async () => {
  assert.equal(MAX_MARK_LISTED, 10_000);
  assert.equal(MAX_MARK_WAITING, 100_000);
  assert.equal(MAX_MARK_LISTS_BYTES, 64 * 1024 * 1024);
  const { root, lead, secrets } = await threeAppended();
  const dir = path.join(root, REPLICA_DIR);
  const { file, bytes } = onlyListsFile(root, lead.writer);
  // Over the limit (a sparse file, so the test stays cheap): refused before it is read or hashed.
  truncateSync(file, MAX_MARK_LISTS_BYTES + 1);
  assert.equal((await readMark(secrets, dir, ACTIVE)).kind, 'unverified');
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'mark-unverified');
  // A symbolic link in place of the lists file is not followed, even to the right bytes.
  rmSync(file);
  const elsewhere = path.join(project(), 'lists.json');
  writeFileSync(elsewhere, bytes);
  symlinkSync(elsewhere, file);
  assert.equal((await readMark(secrets, dir, ACTIVE)).kind, 'unverified');
  rmSync(file);
  writeFileSync(file, bytes);
  assert.equal((await readMark(secrets, dir, ACTIVE)).kind, 'mark');
  // A symbolic link in place of the marks folder is refused like every other store path.
  const marks = path.join(dir, MARK_LISTS_DIR);
  const moved = path.join(project(), 'marks');
  cpSync(marks, moved, { recursive: true });
  rmSync(marks, { recursive: true });
  symlinkSync(moved, marks);
  assert.equal((await readMark(secrets, dir, ACTIVE)).kind, 'unverified');
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'symlink');
  rmSync(marks);
  cpSync(moved, marks, { recursive: true });
  assert.ok(await ReplicaStore.open(root, depsFor(lead, secrets)) instanceof ReplicaStore);
  // A record signed by this device naming a lists file of MAX_MARK_WAITING + 1 waiting entries, its hash and sizes matching: unverified.
  const waiting = hashes('w', MAX_MARK_WAITING + 1).map((hash) => ({ hash, reason: 'unchecked' })).sort(byHash);
  const plant = planter(dir, lead, secrets);
  plant({ held: [], waiting }, { held: 0, waiting: MAX_MARK_WAITING + 1 });
  assert.equal((await readMark(secrets, dir, ACTIVE)).kind, 'unverified');
  plant({ held: [], waiting }, { held: 0, waiting: MAX_MARK_WAITING });
  assert.equal((await readMark(secrets, dir, ACTIVE)).kind, 'unverified', 'sizes that do not match the file');
  // At the limit, the same planted record verifies, so the bound is the list length and not something else.
  plant({ held: [], waiting: waiting.slice(0, MAX_MARK_WAITING) }, { held: 0, waiting: MAX_MARK_WAITING });
  const read = await readMark(secrets, dir, ACTIVE);
  assert.equal(read.kind === 'mark' && read.mark.waiting.length, MAX_MARK_WAITING);
  await assert.rejects(() => writeMark(secrets, dir, lead.signer, { rosterHead: null, heads: [], held: [], waiting: waiting as ReplicaMark['waiting'] }), /not in the shape/);
});

test('D-14: a planted signed lists file with 10,001 held entries reads unverified, and one at the limit reads as a mark', async () => {
  const { root, lead, secrets } = await threeAppended();
  const dir = path.join(root, REPLICA_DIR);
  const plant = planter(dir, lead, secrets);
  const held = hashes('h', HELD_BOUND + 1).map((hash) => ({ hash, reason: 'too-large: the update is over the size limit' })).sort(byHash);
  plant({ held, waiting: [] }, { held: HELD_BOUND + 1, waiting: 0 });
  assert.equal((await readMark(secrets, dir, ACTIVE)).kind, 'unverified', 'over the held bound');
  assertRefused(await ReplicaStore.open(root, depsFor(lead, secrets)), 'mark-unverified');
  plant({ held: held.slice(0, HELD_BOUND), waiting: [] }, { held: HELD_BOUND, waiting: 0 });
  const read = await readMark(secrets, dir, ACTIVE);
  assert.equal(read.kind === 'mark' && read.mark.held.length, HELD_BOUND, 'at the held bound');
  // Both lists at their bounds at once still read as a mark: the bounds are per list.
  const waiting = hashes('w', WAITING_BOUND).map((hash) => ({ hash, reason: 'awaiting-key' })).sort(byHash);
  plant({ held: held.slice(0, HELD_BOUND), waiting }, { held: HELD_BOUND, waiting: WAITING_BOUND });
  const both = await readMark(secrets, dir, ACTIVE);
  assert.deepEqual(both.kind === 'mark' && [both.mark.held.length, both.mark.waiting.length], [HELD_BOUND, WAITING_BOUND]);
});

test('D-14: writeMark refuses a mark over either bound and records nothing; at both bounds it writes a mark that reads back', async () => {
  const dir = path.join(project(), REPLICA_DIR);
  mkdirSync(dir, { recursive: true });
  const lead = fixedSigner('lead');
  const secrets = new MemorySecrets();
  const held = hashes('h', HELD_BOUND + 1).map((hash) => ({ hash, reason: 'refused' }));
  const waiting = hashes('w', WAITING_BOUND + 1).map((hash) => ({ hash, reason: 'unchecked' as const }));
  await assert.rejects(() => writeMark(secrets, dir, lead.signer, { rosterHead: null, heads: [], held, waiting: [] }), /not in the shape/);
  await assert.rejects(() => writeMark(secrets, dir, lead.signer, { rosterHead: null, heads: [], held: [], waiting }), /not in the shape/);
  assert.equal(secrets.values.size, 0, 'nothing was recorded');
  await writeMark(secrets, dir, lead.signer, { rosterHead: null, heads: [], held: held.slice(0, HELD_BOUND), waiting: waiting.slice(0, WAITING_BOUND) }, () => new Date(AT));
  const read = await readMark(secrets, dir, ACTIVE);
  assert.deepEqual(read.kind === 'mark' && [read.mark.held.length, read.mark.waiting.length], [HELD_BOUND, WAITING_BOUND]);
});
