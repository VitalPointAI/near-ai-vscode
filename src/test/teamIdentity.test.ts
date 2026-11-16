// Device identity, event signing and id generators (D-05, D-14, D-15, D-31). All key material is generated at run time.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MAX_EVENT_BYTES, fingerprintOf, verifyEventSignature } from '../domain/team/canonical';
import type { TeamEvent, UnsignedTeamEvent } from '../domain/team/types';
import {
  DEVICE_KEY_SECRET, IDENTITY_CREATE_LOCK_FILE, IDENTITY_DIR_NAME, createDeviceIdentity, forgetDeviceIdentity, identityDir, loadDeviceIdentity,
  forgetCreatedDeviceIdentity, loadOrCreateDeviceIdentity, newEventId, newMemberId, newTeamId, signEvent, ulid
} from '../team/identity';
import { acquireFileLock } from '../services/stateMirrorLock';
import { signPayload, verifyPayload } from '../domain/team/signedPayload';
import { KEY_HISTORY_FILE, KEY_HISTORY_HEAD_SECRET, appendKeyRecord, localKeyStatus, readKeyHistory } from '../team/keyHistory';
import { MemorySecrets } from './helpers/teamHarness';

const TEAM = 'team-0123456789abcdef0123456789abcdef';

function commentEvent(device: string, body: Record<string, string> = { text: 'hello' }): UnsignedTeamEvent<'comment.added'> {
  return { v: 1, id: newEventId(), teamId: TEAM, type: 'comment.added', lamport: 5, at: '2026-01-01T00:00:00.000Z', author: 'mbr-0123456789abcdef', device, prev: '', body };
}

test('creating a device identity stores exactly one secret under the single identity name and loading returns the same identity', async () => {
  const secrets = new MemorySecrets();
  const created = await createDeviceIdentity(secrets);
  assert.equal(DEVICE_KEY_SECRET, 'nearAi.identity.deviceKey');
  assert.deepEqual([...secrets.values.keys()], ['nearAi.identity.deviceKey']);
  const loaded = await loadDeviceIdentity(secrets);
  assert.equal(loaded?.fingerprint, created.fingerprint);
  assert.equal(loaded?.publicKey, created.publicKey);
  assert.equal(created.fingerprint, fingerprintOf(Buffer.from(created.publicKey, 'base64url')));
  assert.equal(Buffer.from(created.publicKey, 'base64url').length, 32);
  assert.equal(await loadDeviceIdentity(new MemorySecrets()), undefined);
});

test('a second key is refused and a forgotten key can be created again', async () => {
  const secrets = new MemorySecrets();
  const first = await createDeviceIdentity(secrets);
  await assert.rejects(() => createDeviceIdentity(secrets), /already has an identity key/);
  assert.equal((await loadDeviceIdentity(secrets))?.fingerprint, first.fingerprint, 'the existing key is untouched');
  await forgetDeviceIdentity(secrets);
  assert.equal(secrets.values.size, 0);
  const second = await createDeviceIdentity(secrets);
  assert.notEqual(second.fingerprint, first.fingerprint);
});

test('a stored key of another type or an unreadable value is refused with a plain message', async () => {
  const rsa = new MemorySecrets();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  rsa.values.set(DEVICE_KEY_SECRET, privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
  await assert.rejects(() => loadDeviceIdentity(rsa), { message: 'The stored team device key is not an Ed25519 key.' });
  const garbage = new MemorySecrets();
  garbage.values.set(DEVICE_KEY_SECRET, 'this is not a key');
  await assert.rejects(() => loadDeviceIdentity(garbage), { message: 'The stored team device key could not be read.' });
});

test('the identity object never serialises the private key', async () => {
  const secrets = new MemorySecrets();
  const identity = await createDeviceIdentity(secrets);
  const stored = secrets.values.get(DEVICE_KEY_SECRET) as string;
  const asBase64url = Buffer.from(stored, 'base64').toString('base64url');
  const text = JSON.stringify(identity);
  assert.equal(text.includes(stored), false);
  assert.equal(text.includes(asBase64url), false);
  assert.equal(text.includes(stored.slice(0, 21)), false, 'not even the PKCS#8 header');
  assert.deepEqual(Object.keys(identity).sort(), ['fingerprint', 'publicKey', 'sign']);
  assert.equal(String(identity).includes(stored), false);
});

test('loadOrCreateDeviceIdentity creates the key once and then returns the same identity with created false', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-identity-'));
  try {
    const secrets = new MemorySecrets();
    const options = { identityDir: identityDir(dir) };
    const first = await loadOrCreateDeviceIdentity(secrets, options);
    assert.equal(first.created, true);
    const second = await loadOrCreateDeviceIdentity(secrets, options);
    assert.equal(second.created, false);
    assert.equal(second.identity.fingerprint, first.identity.fingerprint);
    assert.deepEqual([...secrets.values.keys()].sort(), [DEVICE_KEY_SECRET, KEY_HISTORY_HEAD_SECRET].sort(), 'the key and the saved end of its history');
    assert.equal(path.basename(identityDir(dir)), IDENTITY_DIR_NAME);
    assert.equal((await readdir(identityDir(dir))).includes(IDENTITY_CREATE_LOCK_FILE), false, 'the lock is released');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a fresh install creates its identity with a created record, then signs and verifies a first policy bundle against its own history', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-identity-'));
  try {
    const secrets = new MemorySecrets();
    const options = { identityDir: identityDir(dir) };
    const first = await loadOrCreateDeviceIdentity(secrets, options);
    assert.equal(first.created, true);

    const history = await readKeyHistory(options.identityDir, secrets);
    assert.equal(history.ok, true);
    if (!history.ok) return;
    assert.equal(history.active?.fingerprint, first.identity.fingerprint);
    assert.equal(history.head?.seq, 1, 'exactly one record');
    const file = JSON.parse(await readFile(path.join(options.identityDir, KEY_HISTORY_FILE), 'utf8')) as { records: Array<{ payload: { kind: string; key: { fingerprint: string } }; signer: { fingerprint: string } }> };
    assert.equal(file.records.length, 1);
    assert.equal(file.records[0]?.payload.kind, 'created');
    assert.equal(file.records[0]?.payload.key.fingerprint, first.identity.fingerprint);
    assert.equal(file.records[0]?.signer.fingerprint, first.identity.fingerprint, 'the key signed its own creation');

    const bundle = signPayload(first.identity, 'policy-bundle', { rules: [{ name: 'review-before-merge', required: true }] });
    const verdict = verifyPayload(bundle, { purpose: 'policy-bundle', status: await localKeyStatus(options.identityDir, secrets) });
    assert.equal(verdict.ok, true);
    if (verdict.ok) assert.equal(verdict.keyState, 'active');

    const second = await loadOrCreateDeviceIdentity(secrets, options);
    assert.equal(second.created, false);
    assert.equal(second.identity.fingerprint, first.identity.fingerprint);
    const again = await readKeyHistory(options.identityDir, secrets);
    assert.equal(again.ok && again.head?.seq, 1, 'the second call adds no record');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('forgetCreatedDeviceIdentity deletes nothing unless the stored key is the one named, and then returns whether it deleted', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-identity-'));
  try {
    const secrets = new MemorySecrets();
    const options = { identityDir: identityDir(dir) };
    const { identity } = await loadOrCreateDeviceIdentity(secrets, options);
    const stranger = await createDeviceIdentity(new MemorySecrets());
    assert.equal(await forgetCreatedDeviceIdentity(secrets, { ...options, fingerprint: stranger.fingerprint }), false);
    assert.equal((await loadDeviceIdentity(secrets))?.fingerprint, identity.fingerprint, 'another fingerprint deletes nothing');
    assert.equal(await forgetCreatedDeviceIdentity(secrets, { ...options, fingerprint: identity.fingerprint }), true);
    assert.deepEqual([...secrets.values.keys()], [KEY_HISTORY_HEAD_SECRET], 'the key is gone; only the saved end of its history remains');
    assert.equal(await forgetCreatedDeviceIdentity(secrets, { ...options, fingerprint: identity.fingerprint }), false, 'nothing stored, nothing deleted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function withFolder<T>(work: (folder: string, secrets: MemorySecrets) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-identity-'));
  try {
    return await work(identityDir(dir), new MemorySecrets());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ARCHIVE_NAME = /^key-history\.archived-\d{8}T\d{6}Z-[0-9a-f]{6}\.json$/;

interface HistoryFileShape { records: Array<{ payload: { kind: string; key: { fingerprint: string } }; signer: { fingerprint: string } }> }

async function historyFile(folder: string): Promise<HistoryFileShape> {
  return JSON.parse(await readFile(path.join(folder, KEY_HISTORY_FILE), 'utf8')) as HistoryFileShape;
}

async function archivedFiles(folder: string): Promise<string[]> {
  return (await readdir(folder)).filter((name) => name.startsWith('key-history.archived-')).sort();
}

test('a key stored before any history exists gets exactly one created record signed by that key, and created stays false', async () => {
  await withFolder(async (folder, secrets) => {
    const early = await createDeviceIdentity(secrets);
    assert.equal(secrets.values.has(KEY_HISTORY_HEAD_SECRET), false, 'no history yet');
    const result = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    assert.equal(result.created, false);
    assert.equal(result.identity.fingerprint, early.fingerprint);
    const file = await historyFile(folder);
    assert.equal(file.records.length, 1);
    assert.equal(file.records[0]?.payload.kind, 'created');
    assert.equal(file.records[0]?.payload.key.fingerprint, early.fingerprint);
    assert.equal(file.records[0]?.signer.fingerprint, early.fingerprint);
    const replay = await readKeyHistory(folder, secrets);
    assert.equal(replay.ok && replay.active?.fingerprint, early.fingerprint);
    await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    assert.equal((await historyFile(folder)).records.length, 1, 'a later call does not add another');
    assert.deepEqual(await archivedFiles(folder), []);
  });
});

test('a history with one byte changed is archived with its old bytes, a fresh created record starts, and nothing is deleted', async () => {
  await withFolder(async (folder, secrets) => {
    const first = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    const file = path.join(folder, KEY_HISTORY_FILE);
    const original = await readFile(file, 'utf8');
    const changed = original.replace(/"sig": "(.)/, (_whole, letter: string) => `"sig": "${letter === 'A' ? 'B' : 'A'}`);
    assert.notEqual(changed, original);
    assert.equal(changed.length, original.length, 'one byte differs');
    await writeFile(file, changed, 'utf8');
    assert.equal((await readKeyHistory(folder, secrets)).ok, false, 'the edited history is not trusted');

    const again = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    assert.equal(again.created, false);
    const archives = await archivedFiles(folder);
    assert.equal(archives.length, 1);
    assert.match(archives[0] as string, ARCHIVE_NAME);
    assert.equal(await readFile(path.join(folder, archives[0] as string), 'utf8'), changed, 'the archive holds exactly the old bytes');
    const fresh = await historyFile(folder);
    assert.deepEqual(fresh.records.map((record) => record.payload.kind), ['created']);
    assert.equal(fresh.records[0]?.payload.key.fingerprint, first.identity.fingerprint);
    const replay = await readKeyHistory(folder, secrets);
    assert.equal(replay.ok && replay.head?.seq, 1, 'the saved end matches the fresh history');
    assert.equal(replay.ok && replay.active?.fingerprint, first.identity.fingerprint);
  });
});

test('a history whose active key is not the stored key is archived, and a payload by a key only the archived history knew is unknown-key', async () => {
  await withFolder(async (folder, secrets) => {
    const old = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    const file = path.join(folder, KEY_HISTORY_FILE);
    const oldBytes = await readFile(file, 'utf8');
    const oldHead = secrets.values.get(KEY_HISTORY_HEAD_SECRET);
    // The stored key is replaced behind the history's back (for example secret storage was reset and a key made by another route).
    await forgetDeviceIdentity(secrets);
    const replacement = await createDeviceIdentity(secrets);
    assert.notEqual(replacement.fingerprint, old.identity.fingerprint);

    const result = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    assert.equal(result.created, false);
    assert.equal(result.identity.fingerprint, replacement.fingerprint);
    const archives = await archivedFiles(folder);
    assert.equal(archives.length, 1);
    assert.equal(await readFile(path.join(folder, archives[0] as string), 'utf8'), oldBytes, 'the old history is kept byte for byte');
    assert.notEqual(secrets.values.get(KEY_HISTORY_HEAD_SECRET), oldHead, 'the saved end follows the fresh history');
    const fresh = await historyFile(folder);
    assert.deepEqual(fresh.records.map((record) => `${record.payload.kind}:${record.payload.key.fingerprint}`), [`created:${replacement.fingerprint}`]);
    assert.equal((await readKeyHistory(folder, secrets)).ok, true);

    const status = await localKeyStatus(folder, secrets);
    const fromOld = verifyPayload(signPayload(old.identity, 'policy-bundle', { rules: [] }), { purpose: 'policy-bundle', status });
    assert.equal(fromOld.ok, false);
    if (!fromOld.ok) assert.equal(fromOld.reason, 'unknown-key', 'fails closed: the old key reads as unknown');
    const fromNew = verifyPayload(signPayload(result.identity, 'policy-bundle', { rules: [] }), { purpose: 'policy-bundle', status });
    assert.equal(fromNew.ok, true);
  });
});

test('a lone saved end with no history file is cleared and a fresh history starts, with nothing to archive', async () => {
  await withFolder(async (folder, secrets) => {
    const first = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    await rm(path.join(folder, KEY_HISTORY_FILE));
    assert.equal((await readKeyHistory(folder, secrets)).ok, false);
    await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    assert.deepEqual(await archivedFiles(folder), [], 'there was no file to move');
    const replay = await readKeyHistory(folder, secrets);
    assert.equal(replay.ok && replay.active?.fingerprint, first.identity.fingerprint);
  });
});

test('a backfill that fails after the unusable history was archived leaves the stored key and the archive in place', async () => {
  await withFolder(async (folder, secrets) => {
    await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    await writeFile(path.join(folder, KEY_HISTORY_FILE), 'not json', 'utf8');
    const stored = secrets.values.get(DEVICE_KEY_SECRET);
    // A failing secret store makes the append after the archive fail; the key that already existed stays.
    const failing = Object.assign(Object.create(secrets) as MemorySecrets, { store: async (): Promise<void> => { throw new Error('store is not available'); } });
    await assert.rejects(() => loadOrCreateDeviceIdentity(failing, { identityDir: folder }));
    assert.equal(secrets.values.get(DEVICE_KEY_SECRET), stored, 'an existing key is never removed by a failed backfill');
    assert.equal((await archivedFiles(folder)).length, 1, 'the unusable history was kept aside, not deleted');
  });
});

test('a key made by this call is forgotten when its created record cannot be written', async () => {
  await withFolder(async (folder, secrets) => {
    const failing = Object.assign(Object.create(secrets) as MemorySecrets, {
      store: async (key: string, value: string): Promise<void> => {
        if (key === KEY_HISTORY_HEAD_SECRET) throw new Error('head store is not available');
        secrets.values.set(key, value);
      }
    });
    await assert.rejects(() => loadOrCreateDeviceIdentity(failing, { identityDir: folder }), /could not be stored/);
    assert.equal(secrets.values.has(DEVICE_KEY_SECRET), false, 'no key without a history record is left behind');
    assert.equal((await readdir(folder)).includes(KEY_HISTORY_FILE), false);
    const later = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    assert.equal(later.created, true);
  });
});

test('forgetCreatedDeviceIdentity appends a revoked record signed by the key before deleting it, and the chain replays ok', async () => {
  await withFolder(async (folder, secrets) => {
    const { identity } = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    assert.equal(await forgetCreatedDeviceIdentity(secrets, { identityDir: folder, fingerprint: identity.fingerprint }), true);
    assert.equal(secrets.values.has(DEVICE_KEY_SECRET), false);
    const file = await historyFile(folder);
    assert.deepEqual(file.records.map((record) => `${record.payload.kind}:${record.payload.key.fingerprint}`), [`created:${identity.fingerprint}`, `revoked:${identity.fingerprint}`]);
    assert.equal(file.records[1]?.signer.fingerprint, identity.fingerprint, 'the key signed its own withdrawal');
    const replay = await readKeyHistory(folder, secrets);
    assert.equal(replay.ok, true);
    assert.equal(replay.ok && replay.active, undefined);
    assert.equal(replay.ok && replay.head?.seq, 2);
    assert.deepEqual(await archivedFiles(folder), []);

    const next = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    assert.equal(next.created, true);
    assert.notEqual(next.identity.fingerprint, identity.fingerprint);
    assert.deepEqual((await historyFile(folder)).records.map((record) => record.payload.kind), ['created', 'revoked', 'created']);
    assert.deepEqual(await archivedFiles(folder), [], 'the chain simply continues');
    const status = await localKeyStatus(folder, secrets);
    const refused = verifyPayload(signPayload(identity, 'policy-bundle', { rules: [] }), { purpose: 'policy-bundle', status });
    assert.equal(refused.ok, false, 'the withdrawn key is refused');
    assert.equal(verifyPayload(signPayload(next.identity, 'policy-bundle', { rules: [] }), { purpose: 'policy-bundle', status }).ok, true);
  });
});

test('forgetCreatedDeviceIdentity refuses, deleting nothing, when the key has any history record after its created one', async () => {
  await withFolder(async (folder, secrets) => {
    const { identity } = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    const successor = await createDeviceIdentity(new MemorySecrets());
    await appendKeyRecord(
      folder, secrets, identity,
      { kind: 'rotated', key: { fingerprint: identity.fingerprint, publicKey: identity.publicKey }, next: { fingerprint: successor.fingerprint, publicKey: successor.publicKey } }
    );
    const before = await readFile(path.join(folder, KEY_HISTORY_FILE), 'utf8');
    const storedBefore = secrets.values.get(DEVICE_KEY_SECRET);
    assert.equal(await forgetCreatedDeviceIdentity(secrets, { identityDir: folder, fingerprint: identity.fingerprint }), false);
    assert.equal(secrets.values.get(DEVICE_KEY_SECRET), storedBefore, 'the key is still stored');
    assert.equal(await readFile(path.join(folder, KEY_HISTORY_FILE), 'utf8'), before, 'and the history is unchanged');
  });
});

test('forgetCreatedDeviceIdentity refuses when the history is broken or does not hold exactly the created record', async () => {
  await withFolder(async (folder, secrets) => {
    const { identity } = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    const file = path.join(folder, KEY_HISTORY_FILE);
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace(/"sig": "(.)/, (_whole, letter: string) => `"sig": "${letter === 'A' ? 'B' : 'A'}`), 'utf8');
    assert.equal(await forgetCreatedDeviceIdentity(secrets, { identityDir: folder, fingerprint: identity.fingerprint }), false);
    assert.equal(secrets.values.has(DEVICE_KEY_SECRET), true);
    await rm(file);
    assert.equal(await forgetCreatedDeviceIdentity(secrets, { identityDir: folder, fingerprint: identity.fingerprint }), false);
    assert.equal(secrets.values.has(DEVICE_KEY_SECRET), true);
  });
});

test('the history file and the saved end hold no rendering of the private key', async () => {
  await withFolder(async (folder, secrets) => {
    await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    const stored = secrets.values.get(DEVICE_KEY_SECRET) as string;
    const text = `${await readFile(path.join(folder, KEY_HISTORY_FILE), 'utf8')}\n${secrets.values.get(KEY_HISTORY_HEAD_SECRET) as string}`;
    const der = Buffer.from(stored, 'base64');
    const seed = der.subarray(der.length - 32);
    for (const form of [stored, der.toString('base64url'), seed.toString('hex'), seed.toString('base64url'), seed.toString('base64')]) {
      assert.equal(text.includes(form), false);
    }
  });
});

test('while another window holds identity-create.lock, creation waits and then returns the key that window stored', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-identity-'));
  try {
    const secrets = new MemorySecrets();
    const folder = identityDir(dir);
    const held = await acquireFileLock(folder, IDENTITY_CREATE_LOCK_FILE, { sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }), random: Math.random });
    let settled = false;
    const waiting = loadOrCreateDeviceIdentity(secrets, { identityDir: folder }).then((result) => { settled = true; return result; });
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    assert.equal(settled, false, 'the call waits for the lock');
    assert.equal(secrets.values.size, 0, 'and has created nothing yet');
    const other = await createDeviceIdentity(secrets);
    await held.release();
    const result = await waiting;
    assert.equal(result.created, false);
    assert.equal(result.identity.fingerprint, other.fingerprint);
    assert.equal(secrets.values.has(DEVICE_KEY_SECRET), true);
    assert.equal([...secrets.values.keys()].filter((key) => key === DEVICE_KEY_SECRET).length, 1, 'one key');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two creations racing in one process end with one key', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-identity-'));
  try {
    const secrets = new MemorySecrets();
    const options = { identityDir: identityDir(dir) };
    const results = await Promise.all([loadOrCreateDeviceIdentity(secrets, options), loadOrCreateDeviceIdentity(secrets, options), loadOrCreateDeviceIdentity(secrets, options)]);
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(new Set(results.map((result) => result.identity.fingerprint)).size, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('signed events verify, and any change to the event, the key or the signature makes verification false', async () => {
  const identity = await createDeviceIdentity(new MemorySecrets());
  const other = await createDeviceIdentity(new MemorySecrets());
  const event = signEvent(identity, commentEvent(identity.fingerprint));
  assert.equal(event.sig.length, 86);
  assert.equal(verifyEventSignature(event, identity.publicKey), true);
  assert.equal(verifyEventSignature({ ...event, body: { text: 'changed' } }, identity.publicKey), false);
  assert.equal(verifyEventSignature({ ...event, author: 'mbr-ffffffffffffffff' }, identity.publicKey), false);
  assert.equal(verifyEventSignature(event, other.publicKey), false, 'a different key');

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const trailing = event.sig.slice(0, 85) + (alphabet[alphabet.indexOf(event.sig.slice(85)) | 1] as string);
  assert.deepEqual(Buffer.from(trailing, 'base64url'), Buffer.from(event.sig, 'base64url'), 'same bytes, different text');
  const variants: Array<[string, TeamEvent]> = [
    ['padded signature', { ...event, sig: `${event.sig}==` }],
    ['85 character signature', { ...event, sig: event.sig.slice(0, 85) }],
    ['non-canonical trailing bits', { ...event, sig: trailing }],
    ['empty signature', { ...event, sig: '' }],
    ['standard alphabet signature', { ...event, sig: `+${event.sig.slice(1)}` }]
  ];
  for (const [label, candidate] of variants) {
    assert.equal(verifyEventSignature(candidate, identity.publicKey), false, label);
  }
  assert.equal(verifyEventSignature(event, `${identity.publicKey}=`), false, 'padded public key');
  assert.equal(verifyEventSignature(event, identity.publicKey.slice(0, 42)), false, 'short public key');
});

test('signing refuses an event that names another device or is larger than 16 KB', async () => {
  const identity = await createDeviceIdentity(new MemorySecrets());
  const stranger = await createDeviceIdentity(new MemorySecrets());
  assert.throws(() => signEvent(identity, commentEvent(stranger.fingerprint)), /different device/);
  assert.throws(() => signEvent(identity, commentEvent(identity.fingerprint, { text: 'x'.repeat(MAX_EVENT_BYTES) })), /over the 16384 byte limit/);
  assert.doesNotThrow(() => signEvent(identity, commentEvent(identity.fingerprint, { text: 'x'.repeat(MAX_EVENT_BYTES - 1000) })));
  assert.throws(() => signEvent(identity, { ...commentEvent(identity.fingerprint), lamport: 1.5 }), /safe integers/);
});

test('generated ids have the documented shapes and do not repeat', () => {
  assert.match(newTeamId(), /^team-[0-9a-f]{32}$/);
  assert.match(newMemberId(), /^mbr-[0-9a-f]{16}$/);
  assert.match(newEventId(), /^evt-[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(new Set(Array.from({ length: 1000 }, () => newEventId())).size, 1000);
  assert.equal(new Set(Array.from({ length: 200 }, () => newTeamId())).size, 200);
  assert.equal(ulid(1469918176385).slice(0, 10), '01ARYZ6S41', 'the time prefix follows the ULID specification example');
  assert.equal(ulid(0).slice(0, 10), '0000000000');
  assert.equal(ulid(0).length, 26);
});

test('the identity module offers no way to derive a value from an email address', async () => {
  // The team id is public in team.json, so any hash of an address salted with it could be reversed by guessing addresses (see validate.ts).
  const exported = Object.keys(await import('../team/identity'));
  assert.deepEqual(exported.filter((name) => /mail/i.test(name)), []);
});
