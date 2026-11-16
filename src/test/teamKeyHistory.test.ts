// Local key history tests (TMR-05, D-09, D-21): a person without a team keeps a signed, hash-chained record of their keys, and replaying it gives
// the same kind of status lookup a team roster gives. Keys are generated at run time; no key material is written here.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { fingerprintOf } from '../domain/team/canonical';
import { MAX_KEY_RECORDS, keyRecordHash, replayKeyHistory } from '../domain/team/keyRecords';
import type { KeyHistoryFile, KeyHistoryHead, KeyRecord, KeyRecordKind } from '../domain/team/keyRecords';
import { signPayload, verifyPayload } from '../domain/team/signedPayload';
import type { PayloadSigner, SignedPayload } from '../domain/team/signedPayload';
import { KEY_HISTORY_FILE, KEY_HISTORY_HEAD_SECRET, KeyHistoryError, MAX_KEY_HISTORY_BYTES, appendKeyRecord, localKeyStatus, readKeyHistory } from '../team/keyHistory';
import { FileSecrets } from './helpers/keyHistoryChild';
import type { KeyHistoryChildReply, KeyHistoryChildStart } from './helpers/keyHistoryChild';
import { MemorySecrets } from './helpers/teamHarness';

interface TestSigner extends PayloadSigner { readonly privateKey: KeyObject }

// A plain Ed25519 key held in a closure, the way an agent-style signer or the device identity is.
function makeSigner(): TestSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return {
    privateKey,
    fingerprint: fingerprintOf(raw),
    publicKey: raw.toString('base64url'),
    sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url')
  };
}

function refOf(signer: PayloadSigner): { fingerprint: string; publicKey: string } {
  return { fingerprint: signer.fingerprint, publicKey: signer.publicKey };
}

async function withFolder<T>(work: (folder: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(path.join(tmpdir(), 'near-ai-keyhistory-'));
  try {
    return await work(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const at = (iso: string) => (): Date => new Date(iso);

test('tracer: a created record is written, read back and used to verify a solo payload', async () => {
  await withFolder(async (folder) => {
    const secrets = new MemorySecrets();
    const signer = makeSigner();
    const written = await appendKeyRecord(folder, secrets, signer, { kind: 'created', key: refOf(signer) }, { now: at('2026-03-01T10:00:00.000Z') });
    assert.equal(written.ok, true);

    const read = await readKeyHistory(folder, secrets);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.deepEqual(read.active, refOf(signer));
    assert.equal(read.head?.seq, 1);
    assert.equal(secrets.values.has(KEY_HISTORY_HEAD_SECRET), true);

    const grant = signPayload(signer, 'grant', { capability: 'read', until: '2026-12-01T00:00:00Z' });
    const verdict = verifyPayload(grant, { purpose: 'grant', status: await localKeyStatus(folder, secrets) });
    assert.equal(verdict.ok, true);
    if (verdict.ok) assert.equal(verdict.keyState, 'active');

    // A key the history never saw is unknown, so its payload is refused.
    const stranger = makeSigner();
    const strangers = signPayload(stranger, 'grant', { capability: 'read', until: '2026-12-01T00:00:00Z' });
    const refused = verifyPayload(strangers, { purpose: 'grant', status: await localKeyStatus(folder, secrets) });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, 'unknown-key');

    // The file holds the public key and no rendering of the private key.
    const fileText = await readFile(path.join(folder, KEY_HISTORY_FILE), 'utf8');
    const headText = secrets.values.get(KEY_HISTORY_HEAD_SECRET) ?? '';
    const der = signer.privateKey.export({ format: 'der', type: 'pkcs8' });
    const pem = String(signer.privateKey.export({ format: 'pem', type: 'pkcs8' })).split('\n').filter((line) => !line.startsWith('-----')).join('');
    const jwkD = (signer.privateKey.export({ format: 'jwk' }) as { d: string }).d;
    const seed = der.subarray(der.length - 32);
    assert.ok(fileText.includes(signer.publicKey));
    for (const rendering of [der.toString('base64'), pem, jwkD, seed.toString('base64'), seed.toString('hex')]) {
      assert.ok(!fileText.includes(rendering), 'the history file must not hold a rendering of the private key');
      assert.ok(!headText.includes(rendering), 'the saved head must not hold a rendering of the private key');
    }
  });
});

test('an absent history is empty and trusts no key', async () => {
  await withFolder(async (folder) => {
    const replay = await readKeyHistory(path.join(folder, 'identity'), new MemorySecrets());
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.active, undefined);
    assert.equal(replay.head, undefined);
    assert.equal(replay.lookup(refOf(makeSigner())).state, 'unknown');
    assert.equal(replayKeyHistory(undefined, undefined).ok, false);
  });
});

// ---- Task 2: rotation, revocation, fail-closed tampering and two writers ----

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const T3 = '2026-03-01T00:00:00.000Z';

interface Step {
  by: PayloadSigner;
  kind: KeyRecordKind;
  key: PayloadSigner;
  next?: PayloadSigner;
  at: string;
  // Deliberately wrong values, so a record can be validly signed and still not belong in the chain.
  seq?: number;
  prev?: string;
  payloadAt?: string;
}

// Builds a history by signing each record directly, so cases that the writer would refuse can still be put in a file.
function build(steps: Step[]): { file: KeyHistoryFile; head: KeyHistoryHead | undefined } {
  const records: SignedPayload<KeyRecord>[] = [];
  for (const step of steps) {
    const last = records[records.length - 1];
    const payload: KeyRecord = {
      seq: step.seq ?? records.length + 1,
      prev: step.prev ?? (last === undefined ? '' : keyRecordHash(last)),
      kind: step.kind,
      key: refOf(step.key),
      at: step.payloadAt ?? step.at
    };
    if (step.next !== undefined) payload.next = refOf(step.next);
    records.push(signPayload(step.by, 'key-record', payload, { now: at(step.at) }));
  }
  const last = records[records.length - 1];
  return { file: { version: 1, records }, head: last === undefined ? undefined : { seq: records.length, hash: keyRecordHash(last) } };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function chainAB(): { A: TestSigner; B: TestSigner; C: TestSigner; steps: Step[] } {
  const A = makeSigner();
  const B = makeSigner();
  const C = makeSigner();
  return { A, B, C, steps: [{ by: A, kind: 'created', key: A, at: T1 }, { by: A, kind: 'rotated', key: A, next: B, at: T2 }] };
}

// A broken history reads as: not ok, a plain sentence, and every key unknown.
function assertFailsClosed(result: ReturnType<typeof replayKeyHistory>, keys: readonly PayloadSigner[], expected?: RegExp): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.reason.length > 0 && !result.reason.includes('\u2014'), 'a plain reason without an em-dash');
  if (expected !== undefined) assert.match(result.reason, expected);
  for (const key of keys) assert.equal(result.lookup(refOf(key)).state, 'unknown', 'a broken history trusts no key');
}

test('a rotation hands over from the active key to a key never seen before', () => {
  const { A, B, steps } = chainAB();
  const { file, head } = build(steps);
  const replay = replayKeyHistory(file, head);
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.deepEqual(replay.active, refOf(B));
  assert.deepEqual(replay.head, head);
  assert.deepEqual(replay.lookup(refOf(A)), { state: 'rotated', since: T2, replacedBy: B.fingerprint });
  assert.deepEqual(replay.lookup(refOf(B)), { state: 'active' });
  // A fingerprint with a different public key is not the recorded key.
  assert.equal(replay.lookup({ fingerprint: A.fingerprint, publicKey: B.publicKey }).state, 'unknown');
});

test('revoking the active key leaves no active key and a later created record is allowed', () => {
  const { A, B, steps } = chainAB();
  const revokedB = build([...steps, { by: B, kind: 'revoked', key: B, at: T3 }]);
  const afterRevoke = replayKeyHistory(revokedB.file, revokedB.head);
  assert.equal(afterRevoke.ok, true);
  if (!afterRevoke.ok) return;
  assert.equal(afterRevoke.active, undefined);
  assert.equal(afterRevoke.lookup(refOf(B)).state, 'revoked');
  assert.equal(afterRevoke.lookup(refOf(B)).since, T3);
  assert.equal(afterRevoke.lookup(refOf(A)).state, 'rotated');

  const C = makeSigner();
  const again = build([...steps, { by: B, kind: 'revoked', key: B, at: T3 }, { by: C, kind: 'created', key: C, at: '2026-04-01T00:00:00.000Z' }]);
  const replay = replayKeyHistory(again.file, again.head);
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.deepEqual(replay.active, refOf(C));
  assert.equal(replay.lookup(refOf(B)).state, 'revoked');
});

test('a rotated key can be revoked by itself or by the active key, and a stranger cannot revoke anything', () => {
  const { A, B, C, steps } = chainAB();
  for (const by of [A, B]) {
    const { file, head } = build([...steps, { by, kind: 'revoked', key: A, at: T3 }]);
    const replay = replayKeyHistory(file, head);
    assert.equal(replay.ok, true, `revoked by ${by === A ? 'the rotated key itself' : 'the active key'}`);
    if (!replay.ok) return;
    assert.equal(replay.lookup(refOf(A)).state, 'revoked');
    assert.deepEqual(replay.active, refOf(B), 'revoking the old key leaves the new one active');
  }
  const stranger = build([...steps, { by: C, kind: 'revoked', key: B, at: T3 }]);
  assertFailsClosed(replayKeyHistory(stranger.file, stranger.head), [A, B, C], /not allowed to make that change/);
  // The rotated key may not revoke the key that replaced it.
  const overreach = build([...steps, { by: A, kind: 'revoked', key: B, at: T3 }]);
  assertFailsClosed(replayKeyHistory(overreach.file, overreach.head), [A, B], /not allowed to make that change/);
});

test('records that do not fit the state fail the replay', () => {
  const { A, B, C, steps } = chainAB();
  const cases: Array<[string, Step[], RegExp]> = [
    ['a created record while a key is active', [...steps, { by: C, kind: 'created', key: C, at: T3 }], /still active/],
    ['a rotated record signed by another key', [steps[0] as Step, { by: C, kind: 'rotated', key: A, next: B, at: T2 }], /not allowed to make that change/],
    ['a rotated record whose next key was seen before', [...steps, { by: B, kind: 'rotated', key: B, next: A, at: T3 }], /already used/],
    ['a rotation of a key that is no longer active', [...steps, { by: A, kind: 'rotated', key: A, next: C, at: T3 }], /not allowed to make that change/],
    ['a revoked record of a revoked key', [...steps, { by: B, kind: 'revoked', key: B, at: T3 }, { by: B, kind: 'revoked', key: B, at: '2026-04-01T00:00:00.000Z' }], /not allowed to make that change|already/],
    ['a revoked record of a key the history never saw', [...steps, { by: B, kind: 'revoked', key: C, at: T3 }], /never|not known|does not know/],
    ['a created record for a key that was revoked', [steps[0] as Step, { by: A, kind: 'revoked', key: A, at: T2 }, { by: A, kind: 'created', key: A, at: T3 }], /already used/]
  ];
  for (const [name, list, pattern] of cases) {
    const { file, head } = build(list);
    const result = replayKeyHistory(file, head);
    assert.equal(result.ok, false, name);
    assertFailsClosed(result, [A, B, C], pattern);
  }
});

test('a payload by a rotated key verifies before the rotation and is refused at or after it; a revoked key is refused whatever it claims (D-21)', () => {
  const { A, B, steps } = chainAB();
  const rotated = build(steps);
  const replay = replayKeyHistory(rotated.file, rotated.head);
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  const sample = { capability: 'read', until: '2026-12-01T00:00:00Z' };
  const verify = (signer: PayloadSigner, signedAt: string, lookup = replay.lookup) => verifyPayload(signPayload(signer, 'grant', sample, { now: at(signedAt) }), { purpose: 'grant', status: lookup });

  const before = verify(A, '2026-01-31T23:59:59.999Z');
  assert.equal(before.ok, true);
  if (before.ok) assert.equal(before.keyState, 'rotated');
  for (const claimed of [T2, '2026-02-01T00:00:00.001Z', '2027-01-01T00:00:00.000Z']) {
    const refused = verify(A, claimed);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, 'key-rotated');
  }
  assert.equal(verify(B, '2026-05-01T00:00:00.000Z').ok, true);

  const revoked = build([...steps, { by: B, kind: 'revoked', key: A, at: T3 }]);
  const afterRevoke = replayKeyHistory(revoked.file, revoked.head);
  assert.equal(afterRevoke.ok, true);
  if (!afterRevoke.ok) return;
  for (const claimed of ['2026-01-15T00:00:00.000Z', T3, '2027-01-01T00:00:00.000Z']) {
    const refused = verify(A, claimed, afterRevoke.lookup);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, 'key-revoked');
  }
});

test('fail closed: one byte of a record changed', () => {
  const { A, B, C, steps } = chainAB();
  const { file, head } = build([...steps, { by: B, kind: 'rotated', key: B, next: C, at: T3 }]);
  for (const edit of [
    (copy: KeyHistoryFile) => { (copy.records[0] as SignedPayload<KeyRecord>).payload.at = '2026-01-01T00:00:00.001Z'; },
    (copy: KeyHistoryFile) => { const record = copy.records[1] as SignedPayload<KeyRecord>; record.sig = `${record.sig.startsWith('A') ? 'B' : 'A'}${record.sig.slice(1)}`; },
    (copy: KeyHistoryFile) => { (copy.records[2] as SignedPayload<KeyRecord>).signedAt = '2026-03-01T00:00:00.001Z'; }
  ]) {
    const copy = clone(file);
    edit(copy);
    assertFailsClosed(replayKeyHistory(copy, head), [A, B, C], /changed|cannot be trusted|time/);
  }
});

test('fail closed: two records swapped, a middle record removed, a wrong prev and a seq gap', () => {
  const { A, B, C, steps } = chainAB();
  const three = build([...steps, { by: B, kind: 'rotated', key: B, next: C, at: T3 }]);
  const swapped = clone(three.file);
  [swapped.records[1], swapped.records[2]] = [swapped.records[2] as SignedPayload<KeyRecord>, swapped.records[1] as SignedPayload<KeyRecord>];
  assertFailsClosed(replayKeyHistory(swapped, three.head), [A, B, C], /out of order|does not follow/);

  const removed = clone(three.file);
  removed.records.splice(1, 1);
  assertFailsClosed(replayKeyHistory(removed, three.head), [A, B, C], /out of order|missing/);

  const wrongPrev = build([steps[0] as Step, { ...(steps[1] as Step), prev: 'a'.repeat(64) }]);
  assertFailsClosed(replayKeyHistory(wrongPrev.file, wrongPrev.head), [A, B], /does not follow/);

  const gap = build([steps[0] as Step, { ...(steps[1] as Step), seq: 3 }]);
  assertFailsClosed(replayKeyHistory(gap.file, gap.head), [A, B], /out of order|missing/);
});

test('fail closed: a record re-signed by a different key, and a whole history made by someone else', () => {
  const { A, B, C, steps } = chainAB();
  const original = build(steps);
  // The same payload for record 2, signed by an attacker key instead of A.
  const attacker = makeSigner();
  const resigned = clone(original.file);
  const second = resigned.records[1] as SignedPayload<KeyRecord>;
  resigned.records[1] = signPayload(attacker, 'key-record', second.payload, { now: at(second.signedAt) });
  assertFailsClosed(replayKeyHistory(resigned, original.head), [A, B, attacker], /not allowed to make that change/);

  // A complete, internally valid history of the attacker's own keys, offered where this person's history was: the saved head does not match.
  const own = build([{ by: attacker, kind: 'created', key: attacker, at: T1 }, { by: attacker, kind: 'rotated', key: attacker, next: C, at: T2 }]);
  assert.equal(replayKeyHistory(own.file, own.head).ok, true, 'the attacker\'s history alone is a valid chain');
  assertFailsClosed(replayKeyHistory(own.file, original.head), [A, B, C, attacker], /does not match the end/);
});

test('fail closed: a record whose at differs from its signedAt', () => {
  const { A, B, steps } = chainAB();
  const { file, head } = build([steps[0] as Step, { ...(steps[1] as Step), payloadAt: '2026-01-31T00:00:00.000Z' }]);
  assertFailsClosed(replayKeyHistory(file, head), [A, B], /different time/);
});

test('fail closed: version 2, a file of the wrong shape, and more than MAX_KEY_RECORDS records', () => {
  const { A, B, steps } = chainAB();
  const { file, head } = build(steps);
  assertFailsClosed(replayKeyHistory({ ...clone(file), version: 2 }, head), [A, B], /newer format/);
  assertFailsClosed(replayKeyHistory({ ...clone(file), extra: true }, head), [A, B], /not in a form/);
  assertFailsClosed(replayKeyHistory({ version: 1, records: 'none' }, head), [A, B], /not in a form/);
  const many: KeyHistoryFile = { version: 1, records: Array.from({ length: MAX_KEY_RECORDS + 1 }, () => file.records[0] as SignedPayload<KeyRecord>) };
  assertFailsClosed(replayKeyHistory(many, head), [A, B], /more than 1000 records/);
});

test('fail closed: a history cut to its first records while the saved head names the last, and a head that is missing, unreadable or alone', () => {
  const { A, B, C, steps } = chainAB();
  const full = build([...steps, { by: B, kind: 'rotated', key: B, next: C, at: T3 }]);
  const cut = clone(full.file);
  cut.records.length = 2;
  assert.equal(replayKeyHistory(cut, { seq: 2, hash: keyRecordHash(cut.records[1] as SignedPayload<KeyRecord>) }).ok, true, 'the cut history is a valid chain on its own');
  assertFailsClosed(replayKeyHistory(cut, full.head), [A, B, C], /shorter than this computer last saw/);
  assertFailsClosed(replayKeyHistory(full.file, undefined), [A, B, C], /saved no end/);
  assertFailsClosed(replayKeyHistory({ version: 1, records: [] }, full.head), [A, B, C], /empty but this computer saved an end/);
  assertFailsClosed(replayKeyHistory(full.file, { seq: 3, hash: 'zz' }), [A, B, C], /saved end.*not in a form/);
  assertFailsClosed(replayKeyHistory(full.file, { seq: 3, hash: 'b'.repeat(64) }), [A, B, C], /does not match the end/);
});

test('replay never throws on hostile input', () => {
  const trap = new Proxy({}, { get: () => { throw new Error('trap'); }, ownKeys: () => { throw new Error('trap'); } });
  const circular: Record<string, unknown> = { version: 1 };
  circular.records = [circular];
  for (const input of [null, 0, 'text', [], trap, circular, { version: 1, records: [null, 1, {}] }, { version: 1, records: [{ payload: trap }] }]) {
    assertFailsClosed(replayKeyHistory(input, undefined), []);
  }
});

test('the file on disk: over MAX_KEY_HISTORY_BYTES, not JSON, or removed after a record was saved all fail closed', async () => {
  await withFolder(async (folder) => {
    const secrets = new MemorySecrets();
    const signer = makeSigner();
    await appendKeyRecord(folder, secrets, signer, { kind: 'created', key: refOf(signer) });
    const file = path.join(folder, KEY_HISTORY_FILE);
    const good = await readFile(file, 'utf8');

    await writeFile(file, `${good}${' '.repeat(MAX_KEY_HISTORY_BYTES)}`, 'utf8');
    const big = await readKeyHistory(folder, secrets);
    assert.equal(big.ok, false);
    assert.equal(big.lookup(refOf(signer)).state, 'unknown');
    if (!big.ok) assert.match(big.reason, /larger than this version reads/);

    await writeFile(file, '{ not json', 'utf8');
    assert.equal((await readKeyHistory(folder, secrets)).ok, false);

    await rm(file);
    const removed = await readKeyHistory(folder, secrets);
    assert.equal(removed.ok, false);
    if (!removed.ok) assert.match(removed.reason, /empty but this computer saved an end/);

    await writeFile(file, good, 'utf8');
    assert.equal((await readKeyHistory(folder, secrets)).ok, true);
    secrets.values.set(KEY_HISTORY_HEAD_SECRET, 'not json');
    const badHead = await readKeyHistory(folder, secrets);
    assert.equal(badHead.ok, false);
    assert.equal(badHead.lookup(refOf(signer)).state, 'unknown');
    secrets.values.delete(KEY_HISTORY_HEAD_SECRET);
    const noHead = await readKeyHistory(folder, secrets);
    assert.equal(noHead.ok, false);
    if (!noHead.ok) assert.match(noHead.reason, /saved no end/);
  });
});

test('appending rotates through the file, refuses a change that does not fit and refuses to build on a broken history', async () => {
  await withFolder(async (folder) => {
    const secrets = new MemorySecrets();
    const A = makeSigner();
    const B = makeSigner();
    const C = makeSigner();
    await appendKeyRecord(folder, secrets, A, { kind: 'created', key: refOf(A) }, { now: at(T1) });
    const rotated = await appendKeyRecord(folder, secrets, A, { kind: 'rotated', key: refOf(A), next: refOf(B) }, { now: at(T2) });
    assert.equal(rotated.ok, true);
    if (!rotated.ok) return;
    assert.equal(rotated.head?.seq, 2);
    assert.equal(rotated.lookup(refOf(A)).state, 'rotated');

    const file = path.join(folder, KEY_HISTORY_FILE);
    const before = await readFile(file, 'utf8');
    const headBefore = secrets.values.get(KEY_HISTORY_HEAD_SECRET);
    // A is no longer active: another window already rotated it.
    await assert.rejects(appendKeyRecord(folder, secrets, A, { kind: 'rotated', key: refOf(A), next: refOf(C) }), (error: unknown) => {
      assert.ok(error instanceof KeyHistoryError);
      assert.ok(!error.message.includes('\u2014'));
      assert.match(error.message, /Nothing was added/);
      return true;
    });
    assert.equal(await readFile(file, 'utf8'), before, 'a refused change writes nothing');
    assert.equal(secrets.values.get(KEY_HISTORY_HEAD_SECRET), headBefore);

    // An edit to the file makes the history untrusted, and nothing is appended to it.
    const edited = clone(JSON.parse(before) as KeyHistoryFile);
    (edited.records[0] as SignedPayload<KeyRecord>).payload.at = '2026-01-01T00:00:00.001Z';
    await writeFile(file, JSON.stringify(edited), 'utf8');
    await assert.rejects(appendKeyRecord(folder, secrets, B, { kind: 'revoked', key: refOf(B) }), /Nothing was added.*(changed|cannot be trusted)/);
    assert.equal((await readKeyHistory(folder, secrets)).ok, false);
  });
});

test('a head that cannot be stored puts the file back as it was', async () => {
  await withFolder(async (folder) => {
    const secrets = new MemorySecrets();
    const A = makeSigner();
    const B = makeSigner();
    await appendKeyRecord(folder, secrets, A, { kind: 'created', key: refOf(A) });
    const file = path.join(folder, KEY_HISTORY_FILE);
    const before = await readFile(file, 'utf8');
    const failing = { get: (key: string) => secrets.get(key), delete: (key: string) => secrets.delete(key), store: (): Promise<void> => Promise.reject(new Error('store failed')) };
    await assert.rejects(appendKeyRecord(folder, failing, A, { kind: 'rotated', key: refOf(A), next: refOf(B) }), /saved end could not be stored/);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal((await readKeyHistory(folder, secrets)).ok, true);
    // The same on a first record: the file that did not exist before is removed again.
    const empty = await mkdtemp(path.join(folder, 'first-'));
    const fresh = new MemorySecrets();
    const failingFresh = { get: (key: string) => fresh.get(key), delete: (key: string) => fresh.delete(key), store: (): Promise<void> => Promise.reject(new Error('store failed')) };
    await assert.rejects(appendKeyRecord(empty, failingFresh, A, { kind: 'created', key: refOf(A) }), /saved end could not be stored/);
    await assert.rejects(readFile(path.join(empty, KEY_HISTORY_FILE), 'utf8'), /ENOENT/);
  });
});

test('a record that is not for the signer: a created record for another key is refused', async () => {
  await withFolder(async (folder) => {
    const secrets = new MemorySecrets();
    const A = makeSigner();
    const B = makeSigner();
    await assert.rejects(appendKeyRecord(folder, secrets, A, { kind: 'created', key: refOf(B) }), /not allowed to make that change/);
    assert.equal((await readKeyHistory(folder, secrets)).ok, true);
    assert.equal(secrets.values.has(KEY_HISTORY_HEAD_SECRET), false);
  });
});

interface Racer { child: ChildProcess; ready: Promise<void>; done: Promise<{ ok: boolean; message: string }> }

function startRacer(start: KeyHistoryChildStart): Racer {
  const child = fork(path.join(__dirname, 'helpers', 'keyHistoryChild.js'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const ready = new Promise<void>((resolve, reject) => {
    child.on('message', (message: KeyHistoryChildReply) => { if (message.type === 'ready') resolve(); });
    child.on('error', reject);
    child.on('exit', (code) => { reject(new Error(`the appender exited with ${String(code)} before it was ready: ${stderr}`)); });
  });
  const done = new Promise<{ ok: boolean; message: string }>((resolve, reject) => {
    child.on('message', (message: KeyHistoryChildReply) => { if (message.type === 'done') resolve({ ok: message.ok, message: message.message }); });
    child.on('exit', (code) => { reject(new Error(`the appender exited with ${String(code)} without an answer: ${stderr}`)); });
  });
  ready.catch(() => undefined);
  done.catch(() => undefined);
  child.send(start);
  return { child, ready, done };
}

test('two processes rotating the same key at the same moment: exactly one succeeds and the history stays whole', async () => {
  await withFolder(async (folder) => {
    const identityDir = path.join(folder, 'identity');
    await mkdir(identityDir, { recursive: true });
    const secretsFile = path.join(folder, 'secrets.json');
    const secrets = new FileSecrets(secretsFile);
    const A = makeSigner();
    const B = makeSigner();
    const C = makeSigner();
    await appendKeyRecord(identityDir, secrets, A, { kind: 'created', key: refOf(A) }, { now: at(T1) });

    // The private key travels over the IPC channel only.
    const keyDer = A.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const racers = [B, C].map((next) => startRacer({ type: 'start', identityDir, secretsFile, keyDer, next: refOf(next) }));
    try {
      await Promise.all(racers.map((racer) => racer.ready));
      for (const racer of racers) racer.child.send({ type: 'go' });
      const results = await Promise.all(racers.map((racer) => racer.done));
      const winners = results.filter((result) => result.ok);
      const losers = results.filter((result) => !result.ok);
      assert.equal(winners.length, 1, `exactly one rotation wins, got ${JSON.stringify(results)}`);
      assert.equal(losers.length, 1);
      assert.match((losers[0] as { message: string }).message, /Nothing was added to the key history.*not allowed to make that change/);
    } finally {
      for (const racer of racers) racer.child.kill();
    }

    const final = await readKeyHistory(identityDir, secrets);
    assert.equal(final.ok, true);
    if (!final.ok) return;
    assert.equal(final.head?.seq, 2, 'two contiguous records, nothing lost or interleaved');
    const winner = racers.length === 2 && [B, C].find((candidate) => final.active?.fingerprint === candidate.fingerprint);
    assert.ok(winner, 'the active key is the one the winning process rotated to');
    assert.equal(final.lookup(refOf(A)).state, 'rotated');
    const text = JSON.parse(await readFile(path.join(identityDir, KEY_HISTORY_FILE), 'utf8')) as KeyHistoryFile;
    assert.deepEqual(text.records.map((record) => record.payload.seq), [1, 2]);
  });
});
