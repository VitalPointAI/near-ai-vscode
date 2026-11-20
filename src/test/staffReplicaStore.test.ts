// The replica store on disk (31-13, D-27, D-46, D-05): layout, self-ignoring folder, signed high-water marks, rollback refusal, torn tails, blob size,
// two processes appending at once, and entries from outside held back by the injected decode check.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { GENESIS_PREV, buildEntry } from '../domain/replica/entry';
import type { BuiltEntry } from '../domain/replica/entry';
import { REPLICA_DIR } from '../domain/staff/multiUser';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { verifyPayload } from '../domain/team/signedPayload';
import type { SecretStorageLike } from '../services/auth';
import { REPLICA_MARK_SECRET_PREFIX, markKey, parseReplicaMark } from '../staff/replica/marks';
import { ReplicaStore, STORE_GITIGNORE } from '../staff/replica/store';
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

