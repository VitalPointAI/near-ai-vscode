// Sealed key delivery (D-23): a NEAR API key sealed to one device with X25519, HKDF-SHA256 and AES-256-GCM.
// Every key and secret is generated at run time; the source holds no secret-shaped literal beyond bare prefixes.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import test from 'node:test';
import { assertNoSecrets } from '../domain/team/secrets';
import { SEAL_SCHEME, openSealed, sealContextBytes, sealTo, wipe } from '../team/keySeal';
import type { SealContext, SealRandomness, SealedEntry } from '../team/keySeal';
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

async function setup(): Promise<{ secrets: MemorySecrets; seal: NonNullable<Awaited<ReturnType<typeof loadSealIdentity>>>; context: SealContext; plaintext: Buffer; entry: SealedEntry }> {
  const secrets = new MemorySecrets();
  const device = await createDeviceIdentity(secrets, TEAM);
  await createSealIdentity(secrets, TEAM);
  const seal = await loadSealIdentity(secrets, TEAM);
  assert.ok(seal);
  const context = contextFor(device.fingerprint);
  const plaintext = canaryKey();
  return { secrets, seal, context, plaintext, entry: sealTo(plaintext, seal.publicKey, context) };
}

function flip(value: string): string {
  return `${value.startsWith('A') ? 'B' : 'A'}${value.slice(1)}`;
}

test('the sealing context is canonical bytes of the purpose, team, member, device and key id', () => {
  const context = contextFor('dev-aaaa');
  const text = sealContextBytes(context).toString('utf8');
  assert.equal(text, `{"device":"dev-aaaa","keyId":"${context.keyId}","memberId":"${context.memberId}","purpose":"near-ai.team.key-seal","teamId":"${TEAM}","v":1}`);
  assert.deepEqual(sealContextBytes({ ...context }), sealContextBytes(context));
});

test('opening fails when any one of team, member, device or key id differs', async () => {
  const { seal, context, plaintext, entry } = await setup();
  assert.ok(seal.open(entry, context)?.equals(plaintext));
  assert.equal(seal.open(entry, { ...context, teamId: 'team-ffffffffffffffffffffffffffffffff' }), undefined);
  assert.equal(seal.open(entry, { ...context, memberId: 'mbr-ffffffffffffffff' }), undefined);
  assert.equal(seal.open(entry, { ...context, device: 'dev-other' }), undefined);
  assert.equal(seal.open(entry, { ...context, keyId: 'key-other' }), undefined);
  assert.equal(seal.open({ ...entry, device: 'dev-other' }, context), undefined, 'the entry device must match the context');
});

test('opening fails when nonce, tag, ciphertext or the ephemeral key has one character changed, and never throws', async () => {
  const { seal, context, entry } = await setup();
  assert.equal(seal.open({ ...entry, nonce: flip(entry.nonce) }, context), undefined);
  assert.equal(seal.open({ ...entry, tag: flip(entry.tag) }, context), undefined);
  assert.equal(seal.open({ ...entry, ciphertext: flip(entry.ciphertext) }, context), undefined);
  assert.equal(seal.open({ ...entry, ephemeral: { publicKey: flip(entry.ephemeral.publicKey) } }, context), undefined);
  const last = entry.ciphertext.slice(-1) === 'A' ? 'B' : 'A';
  assert.equal(seal.open({ ...entry, ciphertext: entry.ciphertext.slice(0, -1) + last }, context), undefined);
  assert.equal(seal.open({ ...entry, ciphertext: entry.ciphertext.slice(0, -4) }, context), undefined);
});

test('opening fails with another device private key', async () => {
  const { entry, context } = await setup();
  const other = new MemorySecrets();
  await createSealIdentity(other, TEAM);
  const stranger = await loadSealIdentity(other, TEAM);
  assert.ok(stranger);
  assert.equal(stranger.open(entry, context), undefined);
});

test('a field that is not strict base64url or has the wrong length fails closed without throwing', async () => {
  const { seal, context, entry } = await setup();
  const bad: SealedEntry[] = [
    { ...entry, nonce: `${entry.nonce.slice(0, 15)}=` },
    { ...entry, nonce: entry.nonce.slice(0, 15) },
    { ...entry, tag: `${entry.tag}A` },
    { ...entry, tag: entry.tag.replace(/.$/, '+') },
    { ...entry, ciphertext: `${entry.ciphertext.slice(0, 10)}+${entry.ciphertext.slice(11)}` },
    { ...entry, ciphertext: `${entry.ciphertext}=` },
    { ...entry, ciphertext: '' },
    { ...entry, ephemeral: { publicKey: `${entry.ephemeral.publicKey}A` } },
    { ...entry, ephemeral: { publicKey: 'A'.repeat(43) } },
    { ...entry, ephemeral: undefined as unknown as { publicKey: string } },
    { ...entry, nonce: 42 as unknown as string }
  ];
  for (const candidate of bad) assert.equal(seal.open(candidate, context), undefined);
  assert.equal(openSealed(entry, generateKeyPairSync('ed25519').privateKey, seal.publicKey, context), undefined, 'a key of the wrong type');
});

test('1000 sealed entries of random 51 byte keys to random recipients all pass assertNoSecrets and open again', () => {
  for (let index = 0; index < 1000; index += 1) {
    const recipient = generateKeyPairSync('x25519');
    const publicKey = String(recipient.publicKey.export({ format: 'jwk' }).x);
    const plaintext = randomBytes(51);
    const context = contextFor(`dev-${randomBytes(8).toString('hex')}`);
    const entry = sealTo(plaintext, publicKey, context);
    const body = { memberId: context.memberId, keyId: context.keyId, scheme: SEAL_SCHEME, sealed: [entry] };
    assert.doesNotThrow(() => assertNoSecrets(body, 'member.key-sealed'), `entry ${index}`);
    assert.ok(!entry.ciphertext.includes(plaintext.toString('base64url')));
    assert.ok(openSealed(entry, recipient.privateKey, publicKey, context)?.equals(plaintext), `entry ${index} opens`);
  }
});

test('plaintext sizes outside the sealed shape and a bad recipient key are refused with plain errors', () => {
  const recipient = generateKeyPairSync('x25519');
  const publicKey = String(recipient.publicKey.export({ format: 'jwk' }).x);
  const context = contextFor('dev-x');
  assert.throws(() => sealTo(randomBytes(15), publicKey, context), /between 16 and 512 bytes/);
  assert.throws(() => sealTo(randomBytes(513), publicKey, context), /between 16 and 512 bytes/);
  assert.throws(() => sealTo(randomBytes(51), `${publicKey.slice(0, 42)}=`, context), /not a valid X25519 public key/);
  assert.equal(sealTo(randomBytes(16), publicKey, context).ciphertext.length, 22);
  assert.equal(sealTo(randomBytes(512), publicKey, context).ciphertext.length, 683);
});

test('a draw whose ciphertext starts like a token is rolled again and the result passes the detector', () => {
  const recipient = generateKeyPairSync('x25519');
  const publicKey = String(recipient.publicKey.export({ format: 'jwk' }).x);
  const context = contextFor('dev-x');
  const fixedPair = generateKeyPairSync('x25519');
  const fixedNonce = randomBytes(12);
  const fixed: SealRandomness = { ephemeral: () => fixedPair, nonce: () => fixedNonce };
  // With the key stream known for the fixed draw, choose a plaintext whose first draw encrypts to a ciphertext starting with "sk-".
  const keyStream = Buffer.from(sealTo(Buffer.alloc(48), publicKey, context, fixed).ciphertext, 'base64url');
  const target = Buffer.from('sk-A', 'base64url');
  const plaintext = randomBytes(48);
  for (let index = 0; index < target.length; index += 1) plaintext[index] = (keyStream[index] ?? 0) ^ (target[index] ?? 0);
  assert.throws(() => sealTo(plaintext, publicKey, context, fixed), /safe to write could not be produced/, 'the same draw always starts like a token, so the cap is reached');
  let draws = 0;
  const firstBad: SealRandomness = {
    ephemeral: () => { draws += 1; return draws === 1 ? fixedPair : generateKeyPairSync('x25519'); },
    nonce: () => (draws === 1 ? fixedNonce : randomBytes(12))
  };
  const entry = sealTo(plaintext, publicKey, context, firstBad);
  assert.ok(draws >= 2, 'the first draw was rejected');
  assert.ok(!entry.ciphertext.startsWith('sk-'));
  assert.doesNotThrow(() => assertNoSecrets({ memberId: context.memberId, keyId: context.keyId, scheme: SEAL_SCHEME, sealed: [entry] }, 'test'));
  assert.ok(openSealed(entry, recipient.privateKey, publicKey, context)?.equals(plaintext));
  const text = JSON.stringify(entry);
  assert.ok(!text.includes(plaintext.toString('utf8')) && !text.includes(plaintext.toString('base64url')));
});

test('a different ephemeral key and nonce are used on every call', () => {
  const recipient = generateKeyPairSync('x25519');
  const publicKey = String(recipient.publicKey.export({ format: 'jwk' }).x);
  const context = contextFor('dev-x');
  const plaintext = canaryKey();
  const first = sealTo(plaintext, publicKey, context);
  const second = sealTo(plaintext, publicKey, context);
  assert.notEqual(first.ephemeral.publicKey, second.ephemeral.publicKey);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
});
