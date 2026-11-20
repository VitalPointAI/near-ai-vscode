// This device's keys for shared staff projects (31-18, D-14, D-19, D-24): one X25519 key per install even with two processes, its binding to the
// device key, a key ring that opens only this device's wraps and can be rebuilt from the grants, join secrets, and no secret in any file.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { buildGrant, newEpochKey, wrapEpochKey, x25519BindingBytes } from '../domain/replica/cellKeys';
import { ORIGIN_ROSTER } from '../domain/replica/roster';
import { writerIdOf } from '../domain/replica/entry';
import type { SecretStorageLike } from '../services/auth';
import { identityDir, loadOrCreateDeviceIdentity } from '../team/identity';
import { DeviceKeyRing, ENCRYPTION_KEY_SECRET, EPOCH_KEY_SECRET_PREFIX, JOIN_SECRET_PREFIX, forgetJoinSecret, joinSecret, loadOrCreateEncryptionKey, storeJoinSecret } from '../staff/replica/keyring';
import type { DeviceEncryptionKey } from '../staff/replica/keyring';
import { ReplicaProject } from '../staff/replica/replicaProject';
import { FileSecrets } from './helpers/replicaStoreChild';
import { fixedSigner, streamId } from './helpers/replicaWorld';

/** Secret storage that records every delete, so a test can show the module deletes nothing but a join secret. */
class RecordingSecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public readonly deleted: string[] = [];
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.deleted.push(key); this.values.delete(key); return Promise.resolve(); }
}

const NOW = '2026-11-20T10:00:00.000Z';
const PROJECT = streamId('keyring/project');
const OTHER_CELL = streamId('keyring/other-cell');

function temp(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `near-ai-keyring-${label}-`));
}

async function deviceAt(secrets: SecretStorageLike, dir: string): Promise<{ writer: string; encryption: DeviceEncryptionKey; publicKey: string }> {
  const { identity } = await loadOrCreateDeviceIdentity(secrets, { identityDir: dir, now: () => new Date(NOW) });
  const encryption = await loadOrCreateEncryptionKey(secrets, { identityDir: dir, identity });
  return { writer: writerIdOf(identity.publicKey), encryption, publicKey: identity.publicKey };
}

// ---- one key per install --------------------------------------------------------------------------------------------------------------------------

// The child is written to the test's own temporary folder: it loads the compiled modules by absolute path, waits for 'go', makes or loads the key and
// reports its public half. Nothing secret is sent back.
const CHILD = `
const [keyring, identity, files, secretsFile, dir] = process.argv.slice(2);
const { loadOrCreateEncryptionKey } = require(keyring);
const { loadDeviceIdentity } = require(identity);
const { FileSecrets } = require(files);
(async () => {
  const secrets = new FileSecrets(secretsFile);
  const device = await loadDeviceIdentity(secrets);
  await new Promise((resolve) => { process.on('message', (message) => { if (message === 'go') resolve(); }); process.send('ready'); });
  const key = await loadOrCreateEncryptionKey(secrets, { identityDir: dir, identity: device });
  process.send({ publicKey: key.publicKey }, () => process.exit(0));
})().catch((error) => { process.send({ error: String(error && error.message) }, () => process.exit(1)); });
`;

test('two processes sharing one install make one encryption key under identity-create.lock, and both return it', async () => {
  for (let round = 0; round < 3; round += 1) {
    const base = temp('two-processes');
    const secretsFile = path.join(base, 'secrets.json');
    const dir = path.join(base, 'identity');
    await loadOrCreateDeviceIdentity(new FileSecrets(secretsFile), { identityDir: dir, now: () => new Date(NOW) });
    const script = path.join(base, 'child.js');
    writeFileSync(script, CHILD);
    const modules = [path.join(__dirname, '../staff/replica/keyring.js'), path.join(__dirname, '../team/identity.js'), path.join(__dirname, 'helpers/replicaStoreChild.js')];
    const children = [0, 1].map(() => fork(script, [...modules, secretsFile, dir], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
    const answers = children.map((child) => new Promise<{ publicKey?: string; error?: string }>((resolve, reject) => {
      child.on('message', (message: unknown) => { if (message !== 'ready') resolve(message as { publicKey?: string; error?: string }); });
      child.on('error', reject);
      child.on('exit', (code) => { if (code !== 0) reject(new Error(`a child exited with ${String(code)}`)); });
    }));
    await Promise.all(children.map((child) => new Promise<void>((resolve) => { child.once('message', () => { resolve(); }); })));
    for (const child of children) child.send('go');
    const [first, second] = await Promise.all(answers);
    assert.equal(first.error, undefined);
    assert.equal(second.error, undefined);
    assert.equal(first.publicKey, second.publicKey, `round ${round}: both processes return the same key`);
    const stored = JSON.parse(readFileSync(secretsFile, 'utf8')) as Record<string, string>;
    assert.equal(Object.keys(stored).filter((key) => key === ENCRYPTION_KEY_SECRET).length, 1);
    const reloaded = await loadOrCreateEncryptionKey(new FileSecrets(secretsFile), { identityDir: dir, identity: (await loadOrCreateDeviceIdentity(new FileSecrets(secretsFile), { identityDir: dir })).identity });
    assert.equal(reloaded.publicKey, first.publicKey);
  }
});

test('two calls at once in one process make one key; a stored key that does not read is refused and never replaced', async () => {
  const secrets = new RecordingSecrets();
  const dir = path.join(temp('one-process'), 'identity');
  const { identity } = await loadOrCreateDeviceIdentity(secrets, { identityDir: dir, now: () => new Date(NOW) });
  const [a, b] = await Promise.all([loadOrCreateEncryptionKey(secrets, { identityDir: dir, identity }), loadOrCreateEncryptionKey(secrets, { identityDir: dir, identity })]);
  assert.equal(a.publicKey, b.publicKey);
  assert.equal(Buffer.from(a.publicKey, 'base64url').length, 32);

  const damaged = new RecordingSecrets();
  damaged.values.set(ENCRYPTION_KEY_SECRET, 'this is not a key');
  await assert.rejects(() => loadOrCreateEncryptionKey(damaged, { identityDir: dir, identity }), { message: 'The stored encryption key could not be read.' });
  assert.equal(damaged.values.get(ENCRYPTION_KEY_SECRET), 'this is not a key', 'the stored value is untouched');
  assert.deepEqual(damaged.deleted, []);
});

test('the binding is the device key\'s signature over x25519BindingBytes, so the roster can check that this device owns the encryption key', async () => {
  const secrets = new RecordingSecrets();
  const device = await deviceAt(secrets, path.join(temp('binding'), 'identity'));
  const devicePublic = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: device.publicKey }, format: 'jwk' });
  const bytes = x25519BindingBytes(device.encryption.publicKey, device.writer);
  assert.equal(edVerify(null, bytes, devicePublic, Buffer.from(device.encryption.binding, 'base64url')), true);
  // Another X25519 key, or another writer, does not verify with that binding.
  const other = await deviceAt(new RecordingSecrets(), path.join(temp('binding-other'), 'identity'));
  assert.equal(edVerify(null, x25519BindingBytes(other.encryption.publicKey, device.writer), devicePublic, Buffer.from(device.encryption.binding, 'base64url')), false);
  assert.equal(edVerify(null, x25519BindingBytes(device.encryption.publicKey, other.writer), devicePublic, Buffer.from(device.encryption.binding, 'base64url')), false);
});

// ---- the key ring ---------------------------------------------------------------------------------------------------------------------------------

test('openGrants opens only the wraps addressed to this device; keyRing answers the base cell for the roster stream and nothing for other cells or epochs', async () => {
  const lead = fixedSigner('KEYRING-LEAD');
  const secrets = new RecordingSecrets();
  const mine = await deviceAt(secrets, path.join(temp('ring'), 'identity'));
  const other = await deviceAt(new RecordingSecrets(), path.join(temp('ring-other'), 'identity'));
  const baseKey = newEpochKey();
  const otherKey = newEpochKey();
  const wrap = (cell: string, epoch: number, to: { writer: string; encryption: DeviceEncryptionKey }, key: Buffer): { writer: string; wrap: string } =>
    ({ writer: to.writer, wrap: wrapEpochKey({ cell, epoch, writer: to.writer, recipient: to.encryption.publicKey, epochKey: key }) });
  const grants = [
    buildGrant(lead.signer, { cell: PROJECT, epoch: 1, roster: ORIGIN_ROSTER, labelSealed: '', wraps: [wrap(PROJECT, 1, mine, baseKey), wrap(PROJECT, 1, other, baseKey)] }),
    // A cell this device is not on: only the other device has a wrap.
    buildGrant(lead.signer, { cell: OTHER_CELL, epoch: 1, roster: ORIGIN_ROSTER, labelSealed: '', wraps: [wrap(OTHER_CELL, 1, other, otherKey)] }),
    // A grant whose signature was changed after signing does not read.
    { ...buildGrant(lead.signer, { cell: PROJECT, epoch: 2, roster: ORIGIN_ROSTER, labelSealed: '', wraps: [wrap(PROJECT, 2, mine, otherKey)] }), sig: 'A'.repeat(86) },
    'not a grant'
  ];
  const ring = await DeviceKeyRing.load(secrets, PROJECT, { writer: mine.writer, privateKey: mine.encryption.privateKey });
  assert.equal(ring.size, 0);
  assert.equal(await ring.openGrants(grants), 1);
  assert.equal(ring.version, 1);
  const keys = ring.keyRing();
  assert.deepEqual(keys(PROJECT, 1), baseKey, 'the roster stream is the base cell');
  assert.equal(keys(PROJECT, 2), undefined);
  assert.equal(keys(OTHER_CELL, 1), undefined);
  // Opening the same grants again adds nothing and does not count as a change.
  assert.equal(await ring.openGrants(grants), 0);
  assert.equal(ring.version, 1);
  // The other device's ring opens both of its wraps.
  const theirs = await DeviceKeyRing.load(new RecordingSecrets(), PROJECT, { writer: other.writer, privateKey: other.encryption.privateKey });
  assert.equal(await theirs.openGrants(grants), 2);
  assert.deepEqual(theirs.epochKey(OTHER_CELL, 1), otherKey);
});

test('opened keys are cached in secret storage only; with the cache gone, a fresh ring rebuilt from the same grants answers the same', async () => {
  const lead = fixedSigner('KEYRING-LEAD');
  const secrets = new RecordingSecrets();
  const mine = await deviceAt(secrets, path.join(temp('rebuild'), 'identity'));
  const key1 = newEpochKey();
  const key2 = newEpochKey();
  const grants = [1, 2].map((epoch) => buildGrant(lead.signer, {
    cell: PROJECT, epoch, roster: ORIGIN_ROSTER, labelSealed: '',
    wraps: [{ writer: mine.writer, wrap: wrapEpochKey({ cell: PROJECT, epoch, writer: mine.writer, recipient: mine.encryption.publicKey, epochKey: epoch === 1 ? key1 : key2 }) }]
  }));
  const device = { writer: mine.writer, privateKey: mine.encryption.privateKey };
  const ring = await DeviceKeyRing.load(secrets, PROJECT, device);
  await ring.openGrants(grants);
  await ring.addOwn(OTHER_CELL, 1, key2);
  assert.ok(secrets.values.has(EPOCH_KEY_SECRET_PREFIX + PROJECT));
  // A ring loaded from the cache answers without any grant.
  const cached = await DeviceKeyRing.load(secrets, PROJECT, device);
  assert.deepEqual(cached.epochKey(PROJECT, 1), key1);
  assert.deepEqual(cached.epochKey(OTHER_CELL, 1), key2);
  // The cache is lost (a test removing it by hand): nothing is known until the grants are opened again, then the grant keys are back.
  secrets.values.delete(EPOCH_KEY_SECRET_PREFIX + PROJECT);
  const fresh = await DeviceKeyRing.load(secrets, PROJECT, device);
  assert.equal(fresh.epochKey(PROJECT, 1), undefined);
  assert.equal(await fresh.openGrants(grants), 2);
  for (const epoch of [1, 2]) assert.deepEqual(fresh.keyRing()(PROJECT, epoch), ring.keyRing()(PROJECT, epoch));
  // A damaged cache reads as no cache, never as an error.
  secrets.values.set(EPOCH_KEY_SECRET_PREFIX + PROJECT, '{not json');
  assert.equal((await DeviceKeyRing.load(secrets, PROJECT, device)).size, 0);
  // Two rings of one project in two windows: each write merges what the other stored.
  const windowA = await DeviceKeyRing.load(secrets, PROJECT, device);
  const windowB = await DeviceKeyRing.load(secrets, PROJECT, device);
  await windowA.openGrants([grants[0]]);
  await windowB.openGrants([grants[1]]);
  const merged = await DeviceKeyRing.load(secrets, PROJECT, device);
  assert.deepEqual([merged.epochKey(PROJECT, 1), merged.epochKey(PROJECT, 2)], [key1, key2]);
  assert.deepEqual(secrets.deleted, [], 'the key ring deletes nothing');
});

test('join secrets round trip by invite id; a different secret for the same invite is refused; forgetJoinSecret is the only delete the module makes', async () => {
  const secrets = new RecordingSecrets();
  const dir = path.join(temp('join'), 'identity');
  // Everything else the module does, with a recording store: no delete.
  const mine = await deviceAt(secrets, dir);
  const ring = await DeviceKeyRing.load(secrets, PROJECT, { writer: mine.writer, privateKey: mine.encryption.privateKey });
  await ring.addOwn(PROJECT, 1, newEpochKey());
  await storeJoinSecret(secrets, 'inv-jo', 'first-secret');
  await storeJoinSecret(secrets, 'inv-jo', 'first-secret');
  await assert.rejects(() => storeJoinSecret(secrets, 'inv-jo', 'second-secret'), { message: 'This invitation already has a join secret on this computer, so it was not replaced.' });
  await storeJoinSecret(secrets, 'inv-sam', 'sam-secret');
  assert.equal(await joinSecret(secrets, 'inv-jo'), 'first-secret');
  assert.equal(await joinSecret(secrets, 'inv-unknown'), undefined);
  await assert.rejects(() => joinSecret(secrets, '../escape'), /invitation id/);
  assert.deepEqual(secrets.deleted, []);
  const before = new Set(secrets.values.keys());
  await forgetJoinSecret(secrets, 'inv-jo');
  assert.deepEqual(secrets.deleted, [`${JOIN_SECRET_PREFIX}inv-jo`]);
  assert.equal(await joinSecret(secrets, 'inv-jo'), undefined);
  assert.equal(await joinSecret(secrets, 'inv-sam'), 'sam-secret', 'another invitation keeps its secret');
  assert.deepEqual([...before].filter((key) => !secrets.values.has(key)), [`${JOIN_SECRET_PREFIX}inv-jo`], 'every other key is still there');
  // The compiled module holds exactly one SecretStorage delete.
  const source = readFileSync(path.join(__dirname, '../staff/replica/keyring.js'), 'utf8');
  assert.equal(source.split('.delete(').length - 1, 1);
});

// ---- nothing secret in any file ------------------------------------------------------------------------------------------------------------------

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full)); else out.push(full);
  }
  return out;
}

test('a scan of every file under the project folder and the global storage folder finds no private key, no epoch key and no join secret', async () => {
  const base = temp('scan');
  const secrets = new RecordingSecrets();
  const root = path.join(base, 'project');
  const global = path.join(base, 'global');
  mkdirSync(root, { recursive: true });
  const deps = { secrets, globalStorageDir: global, now: () => new Date(NOW) };
  const shared = await ReplicaProject.createSharedProject(root, deps, { name: 'Exercise Northwind', profile: 'j2', labelMapHash: 'c'.repeat(64), lead: { member: 'mbr-lead' } });
  assert.ok(shared instanceof ReplicaProject);
  assert.ok('ok' in await shared.appendOwn('doc.client', { product: 'intel-estimate', clientId: 1 << 20, actor: { kind: 'person' } }));
  const extraKey = newEpochKey();
  await shared.keys.addOwn(OTHER_CELL, 1, extraKey);
  const secret = 'join-secret-that-must-stay-in-secret-storage';
  await storeJoinSecret(secrets, 'inv-jo', secret);
  await shared.state();
  assert.ok(filesUnder(identityDir(global)).length > 0, 'the identity folder exists and is scanned too');

  const needles: Array<[string, Buffer]> = [];
  const add = (what: string, raw: Buffer): void => {
    needles.push([`${what} raw`, raw], [`${what} base64`, Buffer.from(raw.toString('base64'))], [`${what} base64url`, Buffer.from(raw.toString('base64url'))], [`${what} hex`, Buffer.from(raw.toString('hex'))]);
  };
  for (const name of [ENCRYPTION_KEY_SECRET, 'nearAi.identity.deviceKey']) {
    const der = Buffer.from(secrets.values.get(name) as string, 'base64');
    add(`${name} DER`, der);
    add(`${name} seed`, der.subarray(der.length - 32));
  }
  add('base cell key', shared.keys.epochKey(shared.projectId, 1) as Buffer);
  add('added cell key', extraKey);
  needles.push(['join secret', Buffer.from(secret)]);
  const files = [...filesUnder(root), ...filesUnder(global)];
  assert.ok(files.length >= 5);
  for (const file of files) {
    const bytes = readFileSync(file);
    for (const [what, needle] of needles) assert.equal(bytes.includes(needle), false, `${what} found in ${path.relative(base, file)}`);
  }
});
