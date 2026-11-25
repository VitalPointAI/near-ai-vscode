// Phase 33 plan 23 (D-61; T-33-N8). The person's X25519 encryption key in a hosted session: made once, sealed with AES-256-GCM under a data key
// that the person's Transit KEK wraps (KeyService, 46-07), and kept only as that envelope in the person's own OpenBao key store (46-07's KV v2
// store, against the fake OpenBao). Every later session opens the same key; nothing plain reaches the key store or the workspace folder. keyring.ts
// runs unchanged over the key store's SecretStorageLike, so epoch keys and join secrets follow the person; plain private keys are refused there.
// Fictional exercise data only.
import assert from 'node:assert/strict';
import { createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { KEY_SERVICE_TEXT } from '../../extension/src/common/key-service.ts';
import { SECRET_STORE_TEXT } from '../../extension/src/common/secret-store.ts';
import type { SessionIdentityStatus } from '../../extension/src/common/session-identity.ts';
import { readHostingConfig, type HostedConfig } from '../../extension/src/node/hosting-config.ts';
import { createKeyService } from '../../extension/src/node/key-service.ts';
import { createOpenBaoKeyStore, type KeyStore } from '../../extension/src/node/key-stores.ts';
import { createOpenBaoClient } from '../../extension/src/node/openbao-client.ts';
import type { ActiveSession } from '../../extension/src/node/session-identity.ts';
import { ENCRYPTION_ENVELOPE_SECRET, ENCRYPTION_KEY_TEXT, openEncryptionKey, type KemEngine, type OpenedKemKeys } from '../../extension/src/node/staff/encryption-key.ts';
import { publishPersonKem } from '../../extension/src/node/staff/person-kem.ts';
import { personSigner } from '../../extension/src/node/staff/person-signer.ts';
import { KEY_STORE_SECRETS_TEXT, STAFF_SECRET_SERVICE, keyStoreSecrets } from '../../extension/src/node/staff/keystore-secrets.ts';
import { SESSION_KEY_TEXT, startSessionKeys } from '../../extension/src/node/staff/session-keys.ts';
import { loadStaffEngine } from '../../extension/src/node/staff/staff-engine.ts';
import type * as StaffEntry from '../../tools/staff-engine-entry.ts';
import { DEVICE_KEY_SECRET, PENDING_DEVICE_KEY_SECRET, PREVIOUS_DEVICE_KEY_SECRET } from '../../../src/team/identity.ts';
import { captureOutput, startFakeOpenBao, type FakeCall, type FakeOpenBao } from '../helpers/fake-openbao.ts';

const workbenchRoot = fileURLToPath(new URL('../../..', import.meta.url));
const engine = loadStaffEngine<typeof StaffEntry>(workbenchRoot);

const ENTITY = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const TOKEN = 's.SESSIONTOKENVALUE0123456789abcdef';
const FORWARDED = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJrYy1wYXQifQ.forwarded-signature';
const PROJECT = '0123456789abcdef0123456789abcdef';
const output = captureOutput();
const fakes: FakeOpenBao[] = [];
const privateTexts: string[] = [];

after(async () => {
  for (const fake of fakes) await fake.close();
  output.stop();
  const text = output.text();
  for (const value of [TOKEN, FORWARDED, ENTITY, ...privateTexts]) assert.ok(!text.includes(value), 'no key, token or entity id reached the output');
});

/** Every text form a private key could be written in. */
function privateForms(key: KeyObject): string[] {
  const der = key.export({ format: 'der', type: 'pkcs8' });
  const raw = Buffer.from(key.export({ format: 'jwk' }).d as string, 'base64url');
  const forms = [der.toString('base64'), der.toString('base64url'), der.toString('hex'), raw.toString('base64url'), raw.toString('base64'), raw.toString('hex')];
  privateTexts.push(...forms);
  return forms;
}

interface Site {
  /** The person's KV v2 secrets, by path inside the mount. */
  kv: Map<string, string>;
  /** What each wrapped data key opens to, as the person's Transit KEK would. */
  wrapped: Map<string, string>;
  fake: FakeOpenBao;
}

/** The fake OpenBao of one site: KV v2 for the key store, and datakey/wrapped and decrypt for the person's KEK. */
async function site(): Promise<Site> {
  const kv = new Map<string, string>();
  const wrapped = new Map<string, string>();
  const routes = new Proxy({}, {
    get: (_target, key: string) => (call: FakeCall) => {
      const [method] = key.split(' ');
      if (key === `POST /v1/transit/datakey/wrapped/kek-${ENTITY}`) {
        const ciphertext = `vault:v1:${randomBytes(60).toString('base64')}`;
        wrapped.set(ciphertext, randomBytes(32).toString('base64'));
        return { json: { data: { ciphertext, key_version: 1 } } };
      }
      if (key === `POST /v1/transit/decrypt/kek-${ENTITY}`) {
        const plaintext = wrapped.get((call.body as { ciphertext: string }).ciphertext);
        return plaintext === undefined ? { status: 400, json: { errors: ['cipher: message authentication failed'] } } : { json: { data: { plaintext } } };
      }
      const prefix = '/v1/kv/';
      if (!call.path.startsWith(prefix)) return { status: 404, json: { errors: [] } };
      const rest = call.path.slice(prefix.length);
      if (rest.startsWith('data/')) {
        const name = rest.slice('data/'.length);
        if (method === 'POST') { kv.set(name, (call.body as { data: { password: string } }).data.password); return { json: { data: { version: 1 } } }; }
        if (method === 'GET') return kv.has(name) ? { json: { data: { data: { password: kv.get(name) } } } } : { status: 404, json: { errors: [] } };
      }
      if (rest.startsWith('metadata/')) {
        const name = rest.slice('metadata/'.length);
        if (method === 'GET' && call.query === '?list=true') {
          const keys = [...kv.keys()].filter((k) => k.startsWith(`${name}/`)).map((k) => k.slice(name.length + 1));
          return keys.length ? { json: { data: { keys } } } : { status: 404, json: { errors: [] } };
        }
        if (method === 'GET') return kv.has(name) ? { json: { data: { current_version: 1 } } } : { status: 404, json: { errors: [] } };
        if (method === 'DELETE') { kv.delete(name); return { status: 204 }; }
      }
      return { status: 404, json: { errors: [] } };
    },
    has: () => true,
  }) as Record<string, (call: FakeCall) => { status?: number; json?: unknown }>;
  const fake = await startFakeOpenBao(routes);
  fakes.push(fake);
  return { kv, wrapped, fake };
}

interface Session {
  store: KeyStore;
  keyService: ReturnType<typeof createKeyService>;
  active: { on: boolean };
  identity: { status(): SessionIdentityStatus };
}

/** One hosted session of the person on the site: a new identity, key store and KeyService, as after a restart. */
function session(where: Site): Session {
  const config = readHostingConfig({ STERLING_OPENBAO_ADDR: where.fake.url, THEIACLOUD_SESSION_USER: 'pat@example.test' }) as HostedConfig;
  const active = { on: true };
  const current: ActiveSession = { token: TOKEN, entityId: ENTITY, forwardedToken: FORWARDED, client: createOpenBaoClient({ addr: where.fake.url, timeoutMs: 2000 }), config };
  const identity = {
    session: () => (active.on ? current : undefined),
    status: (): SessionIdentityStatus => ({ mode: 'hosted', state: active.on ? 'active' : 'identity' }),
  };
  return { store: createOpenBaoKeyStore(identity, { kvMount: 'kv' }), keyService: createKeyService(identity), active, identity };
}

async function opened(s: Session) {
  const result = await openEncryptionKey(s.keyService, keyStoreSecrets(s.store, STAFF_SECRET_SERVICE));
  assert.equal(result.kind, 'ok', JSON.stringify(result));
  if (result.kind !== 'ok') throw new Error('unreachable');
  return result.value;
}

const sharedSecret = (privateKey: KeyObject, peer: KeyObject): Buffer => diffieHellman({ privateKey, publicKey: peer });

// ---- Task 2 ----------------------------------------------------------------------------------------------------------------------------------------

test('the first session makes the key and keeps only its sealed envelope; a new session opens the same key', async () => {
  const where = await site();
  const first = await opened(session(where));
  assert.match(first.publicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.privateKey?.asymmetricKeyType, 'x25519');
  // Only the envelope is stored, under the person's own path.
  assert.equal(where.kv.size, 1);
  const [[storedPath, envelopeText]] = [...where.kv];
  assert.ok(storedPath.startsWith(`users/${ENTITY}/`));
  const envelope = JSON.parse(envelopeText) as Record<string, unknown>;
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'iv', 'tag', 'v', 'wrappedKey']);
  assert.equal(envelope.v, 1);
  assert.match(envelope.wrappedKey as string, /^vault:v1:/);
  assert.equal(Buffer.from(envelope.iv as string, 'base64url').length, 12);
  assert.equal(Buffer.from(envelope.tag as string, 'base64url').length, 16);

  const second = await opened(session(where));
  assert.equal(second.publicKey, first.publicKey);
  const peer = generateKeyPairSync('x25519');
  assert.deepEqual(sharedSecret(second.privateKey as KeyObject, peer.publicKey), sharedSecret(first.privateKey as KeyObject, peer.publicKey), 'the same private key');
  assert.equal(where.kv.size, 1, 'the second session stores nothing');
});

test('no plain private key reaches the key store or the workspace folder in any encoding', async () => {
  const where = await site();
  const workspace = await mkdtemp(path.join(tmpdir(), 'staff-workspace-'));
  const before = process.cwd();
  process.chdir(workspace);
  let key: KeyObject;
  try {
    key = (await opened(session(where))).privateKey as KeyObject;
    await opened(session(where));
  } finally {
    process.chdir(before);
  }
  const forms = privateForms(key);
  for (const value of where.kv.values()) for (const form of forms) assert.ok(!value.includes(form), 'no plain key in the key store');
  const files = await readdir(workspace, { recursive: true, withFileTypes: true });
  for (const file of files.filter((entry) => entry.isFile())) {
    const bytes = await readFile(path.join(file.parentPath, file.name));
    for (const form of forms) assert.ok(!bytes.toString('latin1').includes(form), `no plain key in ${file.name}`);
  }
});

test('keyStoreSecrets round-trips keyring\'s names, and one keyring flow from the engine bundle runs over it unchanged', async () => {
  const where = await site();
  const s = session(where);
  const secrets = keyStoreSecrets(s.store, STAFF_SECRET_SERVICE);
  const epochName = `${engine.EPOCH_KEY_SECRET_PREFIX}${PROJECT}`;
  for (const name of [ENCRYPTION_ENVELOPE_SECRET, epochName, `${engine.JOIN_SECRET_PREFIX}inv-pat`]) {
    assert.equal(await secrets.get(name), undefined);
    await secrets.store(name, 'value one');
    assert.equal(await secrets.get(name), 'value one');
    await secrets.delete(name);
    assert.equal(await secrets.get(name), undefined);
  }
  assert.equal(where.kv.size, 0);

  // Join secrets: kept, read, refused when different, forgotten.
  await engine.storeJoinSecret(secrets, 'inv-pat', 'join-secret-one');
  assert.equal(await engine.joinSecret(secrets, 'inv-pat'), 'join-secret-one');
  await assert.rejects(engine.storeJoinSecret(secrets, 'inv-pat', 'another'), /already has a join secret/);
  await engine.forgetJoinSecret(secrets, 'inv-pat');
  assert.equal(await engine.joinSecret(secrets, 'inv-pat'), undefined);

  // Epoch keys: a key this device made is written through to the person's store and read back by a new session's ring.
  const key = (await opened(s)).privateKey as KeyObject;
  const device = { writer: 'a'.repeat(64), privateKey: key };
  const ring = await engine.DeviceKeyRing.load(secrets, PROJECT, device);
  const epochKey = randomBytes(32);
  await ring.addOwn(PROJECT, 1, epochKey, 'b'.repeat(64));
  const later = session(where);
  const again = await engine.DeviceKeyRing.load(keyStoreSecrets(later.store, STAFF_SECRET_SERVICE), PROJECT, device);
  assert.deepEqual(again.readingCandidates(PROJECT, []).map((candidate) => [candidate.epoch, candidate.key.equals(epochKey), candidate.own]), [[1, true, true]]);
  assert.ok([...where.kv.keys()].every((name) => name.startsWith(`users/${ENTITY}/`)));
  privateTexts.push(epochKey.toString('base64url'));
});

test('an unwrap refusal (the sign-in not ready) opens no key and leaves the envelope as it is', async () => {
  const where = await site();
  await opened(session(where));
  const envelope = [...where.kv.values()][0];
  const s = session(where);
  const notReady = session(where);
  notReady.active.on = false;
  assert.deepEqual(await openEncryptionKey(notReady.keyService, keyStoreSecrets(s.store, STAFF_SECRET_SERVICE)), { kind: 'refused', reason: KEY_SERVICE_TEXT.notReady });
  assert.deepEqual([...where.kv.values()], [envelope]);
  // The key store not ready either: its own sentence.
  assert.deepEqual(await openEncryptionKey(notReady.keyService, keyStoreSecrets(notReady.store, STAFF_SECRET_SERVICE)), { kind: 'refused', reason: SECRET_STORE_TEXT.notReady });
});

test('a damaged or foreign envelope is refused and never replaced', async () => {
  const where = await site();
  const s = session(where);
  await opened(s);
  const [name, text] = [...where.kv][0];
  const envelope = JSON.parse(text) as Record<string, string>;
  const flipped = Buffer.from(envelope.ciphertext, 'base64url');
  flipped[0] ^= 1;
  for (const damaged of ['not json', JSON.stringify({ ...envelope, v: 2 }), JSON.stringify({ ...envelope, ciphertext: flipped.toString('base64url') }), JSON.stringify({ ...envelope, wrappedKey: 'vault:v1:AAAA' })]) {
    where.kv.set(name, damaged);
    const result = await openEncryptionKey(s.keyService, keyStoreSecrets(s.store, STAFF_SECRET_SERVICE));
    assert.equal(result.kind, 'refused');
    if (result.kind === 'refused') assert.ok([ENCRYPTION_KEY_TEXT.unreadable, KEY_SERVICE_TEXT.dataKeyMissing].includes(result.reason as never), result.reason);
    assert.equal(where.kv.get(name), damaged, 'left as it is');
  }
});

test('the key store refuses a plain private key under keyring\'s and identity\'s names, and writes nothing', async () => {
  const where = await site();
  const secrets = keyStoreSecrets(session(where).store, STAFF_SECRET_SERVICE);
  for (const name of [engine.ENCRYPTION_KEY_SECRET, DEVICE_KEY_SECRET, PENDING_DEVICE_KEY_SECRET, PREVIOUS_DEVICE_KEY_SECRET]) {
    await assert.rejects(secrets.store(name, 'MC4CAQAwBQYDK2VuBCIEIA'), { message: KEY_STORE_SECRETS_TEXT.plainPrivateKey });
  }
  assert.equal(where.kv.size, 0);
});

test('the opened key is dropped with the session key when the session stops', async () => {
  const where = await site();
  const s = session(where);
  const key = await opened(s);
  const personPublicKey = Buffer.from(generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64url');
  const keys = await startSessionKeys(s.keyService, s.identity, { now: () => Date.now() }, { personPublicKey, engine });
  assert.equal(keys.kind, 'ok');
  if (keys.kind !== 'ok') return;
  keys.value.hold(key);
  assert.equal(key.privateKey?.asymmetricKeyType, 'x25519');
  s.active.on = false;
  keys.value.stop();
  assert.equal(key.privateKey, undefined);
  assert.throws(() => keys.value.sessionSigner.sign(Buffer.from('after the end')), { message: SESSION_KEY_TEXT.ended });
});

// ---- 33.2-04 Task 2 (D-03): the person's post-quantum keys in the same envelope ----------------------------------------------------------------

async function openedWithKem(s: Session, kem: KemEngine = engine) {
  const result = await openEncryptionKey(s.keyService, keyStoreSecrets(s.store, STAFF_SECRET_SERVICE), kem);
  assert.equal(result.kind, 'ok', JSON.stringify(result));
  if (result.kind !== 'ok') throw new Error('unreachable');
  return result.value;
}

/** Every text form a post-quantum seed could be written in: the P-256 scalar and the ML-KEM seed (the last 64 bytes of its seed-form PKCS8). */
function kemForms(keys: { p256: KeyObject; mlkem768: KeyObject }): string[] {
  const scalar = Buffer.from(keys.p256.export({ format: 'jwk' }).d as string, 'base64url');
  const seed = keys.mlkem768.export({ format: 'der', type: 'pkcs8' }).subarray(-64);
  const forms = [scalar, seed].flatMap((bytes) => [bytes.toString('base64url'), bytes.toString('base64'), bytes.toString('hex')]);
  privateTexts.push(...forms);
  return forms;
}

test('with the engine, the first session seals the X25519 key and the post-quantum keys in one envelope; a new session opens the same keys', async () => {
  const where = await site();
  const first = await openedWithKem(session(where));
  assert.ok(first.kem !== undefined);
  assert.equal(Buffer.from(first.kem.publicKeys.p256, 'base64url').length, 65);
  assert.equal(Buffer.from(first.kem.publicKeys.mlkem768, 'base64url').length, 1184);
  assert.equal(where.kv.size, 1, 'one envelope, one Transit-wrapped data key');
  const second = await openedWithKem(session(where));
  assert.equal(second.publicKey, first.publicKey);
  assert.deepEqual(second.kem?.publicKeys, first.kem.publicKeys);
  for (const value of where.kv.values()) for (const form of kemForms(first.kem.privateKeys as { p256: KeyObject; mlkem768: KeyObject })) assert.ok(!value.includes(form), 'no plain seed in the key store');
});

test('an envelope written before this change opens, and the post-quantum keys are added at the next session start under the same wrapped key', async () => {
  const where = await site();
  const old = await opened(session(where));
  assert.equal(old.kem, undefined, 'a v1 envelope holds no post-quantum keys');
  const [[name, before]] = [...where.kv];
  const upgraded = await openedWithKem(session(where));
  assert.equal(upgraded.publicKey, old.publicKey, 'the X25519 key is unchanged');
  assert.ok(upgraded.kem !== undefined);
  const after = where.kv.get(name) as string;
  assert.notEqual(after, before);
  assert.equal((JSON.parse(after) as { wrappedKey: string }).wrappedKey, (JSON.parse(before) as { wrappedKey: string }).wrappedKey, 'no new data key');
  const again = await openedWithKem(session(where));
  assert.deepEqual(again.kem?.publicKeys, upgraded.kem.publicKeys);
  assert.equal((await opened(session(where))).publicKey, old.publicKey, 'a session without the engine still opens the upgraded envelope');
});

test('where the probe fails nothing post-quantum is made; drop() releases the post-quantum private keys with the X25519 key', async () => {
  const where = await site();
  const noProbe = await openedWithKem(session(where), { ...engine, probeWrapV2: () => false });
  assert.equal(noProbe.kem, undefined);
  const s = session(where);
  const key = await openedWithKem(s);
  assert.ok(key.kem?.privateKeys !== undefined);
  key.drop();
  assert.equal(key.privateKey, undefined);
  assert.equal(key.kem?.privateKeys, undefined);
});

/** A person signer over a local Ed25519 key, or one whose every signature needs a fresh confirmation. */
function personOf(stepUp: boolean) {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64url');
  const keyService = {
    sign: async (messageBase64: string) => (stepUp
      ? { kind: 'refused' as const, reason: KEY_SERVICE_TEXT.stepUpNeeded }
      : { kind: 'ok' as const, value: { signature: edSign(null, Buffer.from(messageBase64, 'base64'), pair.privateKey).toString('base64') } }),
  };
  return personSigner(keyService as never, publicKey);
}

/** A project stand-in: an empty roster, and every append recorded. */
function target() {
  const written: Array<{ kind: string; data: Record<string, string> }> = [];
  const roster = { kems: new Map<string, unknown>(), members: { devices: new Map<string, unknown>() } };
  return {
    written,
    roster,
    state: async () => ({ roster }),
    appendOwn: async (kind: string, data: unknown) => {
      written.push({ kind, data: data as Record<string, string> });
      return { ok: true as const };
    },
  };
}

test('the person key signs the binding and the device.kem once; the binding verifies; with the keys in the roster nothing more is signed', async () => {
  const where = await site();
  const key = await openedWithKem(session(where));
  const person = personOf(false);
  const project = target();
  assert.deepEqual(await publishPersonKem(project, person, key.kem as OpenedKemKeys, engine), { kind: 'ok', value: 'published' });
  assert.equal(project.written.length, 1);
  const [{ kind, data }] = project.written;
  assert.equal(kind, 'device.kem');
  const writer = engine.writerIdOf(person.publicKey);
  assert.equal(data.device, writer);
  const raw = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(person.publicKey, 'base64url')]), format: 'der', type: 'spki' });
  assert.equal(edVerify(null, engine.kemBindingBytes(key.kem?.publicKeys as never, writer), raw, Buffer.from(data.sig, 'base64url')), true);
  project.roster.kems.set(writer, { p256: data.p256, mlkem768: data.mlkem768 });
  assert.deepEqual(await publishPersonKem(project, person, key.kem as OpenedKemKeys, engine), { kind: 'ok', value: 'present' });
  assert.equal(project.written.length, 1);
});

test('a refused confirmation publishes nothing, says to confirm with a passkey or security key, and leaves the keys made in the envelope', async () => {
  const where = await site();
  const key = await openedWithKem(session(where));
  const project = target();
  assert.deepEqual(await publishPersonKem(project, personOf(true), key.kem as OpenedKemKeys, engine), { kind: 'refused', reason: SESSION_KEY_TEXT.stepUp, fix: KEY_SERVICE_TEXT.confirm });
  assert.equal(project.written.length, 0);
  assert.deepEqual((await openedWithKem(session(where))).kem?.publicKeys, key.kem?.publicKeys);
});
