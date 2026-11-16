// Device identity, event signing and id generators (D-05, D-14, D-15, D-31). All key material is generated at run time.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
import { KEY_HISTORY_FILE, KEY_HISTORY_HEAD_SECRET, localKeyStatus, readKeyHistory } from '../team/keyHistory';
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
