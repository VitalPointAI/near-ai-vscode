// Device identity, event signing and id generators (D-05, D-14, D-15, D-31). All key material is generated at run time.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MAX_EVENT_BYTES, fingerprintOf, verifyEventSignature } from '../domain/team/canonical';
import type { TeamEvent, UnsignedTeamEvent } from '../domain/team/types';
import {
  DEVICE_KEY_SECRET, IDENTITY_CREATE_LOCK_FILE, IDENTITY_DIR_NAME, createDeviceIdentity, emailHash, forgetDeviceIdentity, identityDir, loadDeviceIdentity,
  loadOrCreateDeviceIdentity, newEventId, newMemberId, newTeamId, signEvent, ulid
} from '../team/identity';
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
    assert.deepEqual([...secrets.values.keys()], [DEVICE_KEY_SECRET]);
    assert.equal(path.basename(identityDir(dir)), IDENTITY_DIR_NAME);
    assert.equal((await readdir(identityDir(dir))).includes(IDENTITY_CREATE_LOCK_FILE), false, 'the lock is released');
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

test('email hashes ignore case and spacing, differ across teams, and never contain the address', () => {
  const hash = emailHash(TEAM, ' Ana@Example.INVALID ');
  assert.equal(hash, emailHash(TEAM, 'ana@example.invalid'));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, createHash('sha256').update(`${TEAM}:ana@example.invalid`).digest('hex'));
  assert.notEqual(hash, emailHash('team-ffffffffffffffffffffffffffffffff', 'ana@example.invalid'));
  assert.notEqual(hash, emailHash(TEAM, 'bob@example.invalid'));
  assert.equal(hash.includes('ana'), false);
});
