// Sealed key delivery (D-23): a NEAR API key sealed to one device with X25519, HKDF-SHA256 and AES-256-GCM.
// Every key and secret is generated at run time; the source holds no secret-shaped literal beyond bare prefixes.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { assertNoSecrets } from '../domain/team/secrets';
import { SEAL_SCHEME, sealTo, wipe } from '../team/keySeal';
import type { SealContext } from '../team/keySeal';
import {
  SEAL_KEY_SECRET_PREFIX, createDeviceIdentity, createSealIdentity, deviceKeySecretName, forgetDeviceIdentity, loadSealIdentity, sealKeySecretName
} from '../team/identity';
import { MemorySecrets } from './helpers/teamHarness';

const TEAM = 'team-0123456789abcdef0123456789abcdef';

function canaryKey(): Buffer {
  return Buffer.from(`sk-canary${randomBytes(20).toString('hex')}`, 'utf8');
}

function contextFor(device: string): SealContext {
  return { teamId: TEAM, memberId: 'mbr-0123456789abcdef', device, keyId: `key-${randomBytes(8).toString('hex')}` };
}

test('creating a seal identity stores one PKCS#8 X25519 key under the team seal name and loading returns the same public key', async () => {
  const secrets = new MemorySecrets();
  const created = await createSealIdentity(secrets, TEAM);
  assert.equal(SEAL_KEY_SECRET_PREFIX, 'nearAi.team.sealKey.');
  assert.equal(sealKeySecretName(TEAM), `nearAi.team.sealKey.${TEAM}`);
  assert.deepEqual([...secrets.values.keys()], [sealKeySecretName(TEAM)]);
  const stored = secrets.values.get(sealKeySecretName(TEAM)) as string;
  assert.ok(stored.startsWith('MC4CAQAwBQYDK2VuBCIEI'), 'stored form is PKCS#8 DER base64 for X25519');
  assert.equal(created.publicKey.length, 43);
  assert.equal(created.teamId, TEAM);
  const loaded = await loadSealIdentity(secrets, TEAM);
  assert.equal(loaded?.publicKey, created.publicKey);
  assert.equal(await loadSealIdentity(secrets, 'team-ffffffffffffffffffffffffffffffff'), undefined);
  await assert.rejects(() => createSealIdentity(secrets, TEAM), /already has a seal key/);
  assert.equal((await loadSealIdentity(secrets, TEAM))?.publicKey, created.publicKey, 'the existing key is untouched');
});

test('forgetDeviceIdentity removes the device key and the seal key together', async () => {
  const secrets = new MemorySecrets();
  await createDeviceIdentity(secrets, TEAM);
  await createSealIdentity(secrets, TEAM);
  assert.deepEqual([...secrets.values.keys()].sort(), [deviceKeySecretName(TEAM), sealKeySecretName(TEAM)].sort());
  await forgetDeviceIdentity(secrets, TEAM);
  assert.equal(secrets.values.size, 0);
});

test('a key sealed to a device opens with the X25519 key loaded back from SecretStorage and the entry passes the write-side secret check', async () => {
  const secrets = new MemorySecrets();
  const device = await createDeviceIdentity(secrets, TEAM);
  const created = await createSealIdentity(secrets, TEAM);
  const context = contextFor(device.fingerprint);
  const canary = canaryKey();
  const entry = sealTo(canary, created.publicKey, context);
  assert.equal(entry.device, context.device);
  assert.equal(entry.ephemeral.publicKey.length, 43);
  assert.equal(entry.nonce.length, 16);
  assert.equal(entry.tag.length, 22);
  assert.match(entry.ciphertext, /^[A-Za-z0-9_-]+$/);
  const loaded = await loadSealIdentity(secrets, TEAM);
  assert.ok(loaded);
  const opened = loaded.open(entry, context);
  assert.ok(opened);
  assert.ok(opened.equals(canary));
  const body = { memberId: context.memberId, keyId: context.keyId, scheme: SEAL_SCHEME, sealed: [entry] };
  assert.doesNotThrow(() => assertNoSecrets(body, 'test'));
  const text = JSON.stringify(entry);
  assert.ok(!text.includes(canary.toString('utf8')));
  assert.ok(!text.includes(canary.toString('base64url')));
  assert.ok(!text.includes(canary.toString('base64')));
});

test('wipe zero-fills a buffer', () => {
  const buffer = randomBytes(64);
  wipe(buffer);
  assert.ok(buffer.every((byte) => byte === 0));
});
