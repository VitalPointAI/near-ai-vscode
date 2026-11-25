// Phase 71, plan 10, tasks 1 and 3 (D-07, D-13, D-15, VCRD-06; owner decision A of 2026-11-24): a person's did:webvh is made by their own backend
// at the first active session, signed once through the key service (which needs a fresh step-up), kept under their own KV prefix with the
// directory entry kv/site/people/<own entity>, and posted to your organization's server at the person's first hub session, through that
// session, once. A single computer is bound to its person after the six words match and a fresh step-up. Fakes for the key service, KV and
// the hub; the identity engine is the real code (tools/identity-entry.ts). Fictional people and keys only, made at run time. Flat file name, so
// the workbench runner runs it (H-71-01).
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { test } from 'node:test';
import * as realEngine from '../tools/identity-entry.ts';
import { verifyCredential } from '../../src/domain/credentials/profile.ts';
import { decodePublicKeyMultibase } from '../../src/domain/credentials/multibase.ts';
import { didKeyFromPublicKey } from '../../src/domain/did/didKey.ts';
import { IDENTITY_TEXT } from '../extension/src/common/identity.ts';
import { KEY_SERVICE_TEXT } from '../extension/src/common/key-service.ts';
import { ok, refused } from '../extension/src/common/service-result.ts';
import {
  createIdentityService, directoryPath, ownRecordPath, type HubTrustSession, type IdentityEngine, type IdentityKv, type StatusAllocator,
} from '../extension/src/node/credentials/identity-service.ts';

const ENTITY = '3a9e7c1b-5d2f-4e8a-9b6c-0d1e2f3a4b5c';
const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const engine = realEngine as unknown as IdentityEngine;

interface FakeKeys {
  keys: Parameters<typeof createIdentityService>[0]['keys'];
  signs: () => number;
  stepUp: (fresh: boolean) => void;
  publicRaw: Buffer;
}

/** A Transit person key: personPublicKey answers its raw public key; sign signs only while the step-up is fresh, as KeyService does. */
function fakeKeys(): FakeKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicRaw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  let fresh = true;
  let count = 0;
  return {
    publicRaw,
    signs: () => count,
    stepUp: (value) => { fresh = value; },
    keys: {
      personPublicKey: async () => ok({ publicKey: publicRaw.toString('base64url'), keyVersion: 1 }),
      sign: async (message: string) => {
        if (!fresh) return refused(KEY_SERVICE_TEXT.stepUpNeeded, KEY_SERVICE_TEXT.confirm);
        count += 1;
        return ok({ signature: edSign(null, Buffer.from(message, 'base64'), privateKey).toString('base64'), keyVersion: 1 });
      },
    },
  };
}

interface MemoryKv extends IdentityKv {
  data: Map<string, Record<string, unknown>>;
  down: (value: boolean) => void;
  failCreate: (path: string | undefined) => void;
}

/** KV v2 in memory with check-and-set create; it can stop answering, or refuse one path's create, to show nothing is made half-way. */
function memoryKv(): MemoryKv {
  const data = new Map<string, Record<string, unknown>>();
  let isDown = false;
  let failing: string | undefined;
  const check = (): void => { if (isDown) throw new Error('store did not answer'); };
  return {
    data,
    down: (value) => { isDown = value; },
    failCreate: (path) => { failing = path; },
    async read(path) { check(); return data.get(path); },
    async create(path, value) {
      check();
      if (path === failing) throw new Error('store did not answer');
      if (data.has(path)) return 'exists';
      data.set(path, structuredClone(value));
      return 'created';
    },
    async write(path, value) { check(); data.set(path, structuredClone(value)); },
  };
}

function fakeHub(status = 201): HubTrustSession & { posts: Array<{ path: string; log: string }>; answer: (value: number) => void } {
  let current = status;
  const posts: Array<{ path: string; log: string }> = [];
  return { posts, answer: (value) => { current = value; }, async postLog(path, log) { posts.push({ path, log }); return { status: current }; } };
}

function service(keys: FakeKeys, kv: IdentityKv, extra: Partial<Parameters<typeof createIdentityService>[0]> = {}) {
  return createIdentityService({ keys: keys.keys, kv, entityId: () => ENTITY, engine: () => engine, domain: 'hq.example.org', now: () => NOW, randomId: () => 'x7k2p9a1b2c3d4e5', ...extra });
}

test('the first active session makes the person\'s did:webvh naming their Transit key, signs once, and writes their record and directory entry', async () => {
  const keys = fakeKeys();
  const kv = memoryKv();
  const status = await service(keys, kv).ensurePersonDid();
  assert.equal(status.state, 'ready');
  if (status.state !== 'ready') return;
  assert.match(status.did, /^did:webvh:Qm[1-9A-HJ-NP-Za-km-z]{44}:hq\.example\.org:people:x7k2p9a1b2c3d4e5$/);
  assert.equal(status.published, false);
  assert.equal(keys.signs(), 1);
  assert.deepEqual(kv.data.get(directoryPath(ENTITY)), { did: status.did });
  const own = kv.data.get(ownRecordPath(ENTITY)) as { log: string; path: string };
  assert.equal(own.path, 'people/x7k2p9a1b2c3d4e5');
  const verified = realEngine.verifyWebvhLog(own.log, { now: NOW });
  assert.ok(verified.ok);
  const multikey = realEngine.encodePublicKeyMultibase('Ed25519', new Uint8Array(keys.publicRaw));
  assert.deepEqual(verified.ok && verified.state.parameters.updateKeys, [multikey], 'the person key controls the DID');
  const doc = verified.ok ? (verified.state.versions[0]?.document as { verificationMethod: Array<{ publicKeyMultibase: string }> }) : undefined;
  assert.equal(doc?.verificationMethod[0]?.publicKeyMultibase, multikey, 'and is the key it issues with');
});

test('a second session finds the identity and signs, writes and posts nothing', async () => {
  const keys = fakeKeys();
  const kv = memoryKv();
  const first = await service(keys, kv).ensurePersonDid();
  const before = structuredClone([...kv.data]);
  const hub = fakeHub();
  const again = await service(keys, kv).ensurePersonDid();
  assert.deepEqual(again, first);
  assert.equal(keys.signs(), 1);
  assert.deepEqual([...kv.data], before);
  assert.equal(hub.posts.length, 0);
});

test('a step-up refusal writes nothing and leaves the identity pending with one sentence and Retry; Retry succeeds once signing works', async () => {
  const keys = fakeKeys();
  keys.stepUp(false);
  const kv = memoryKv();
  const identity = service(keys, kv);
  assert.deepEqual(await identity.ensurePersonDid(), { state: 'pending', message: IDENTITY_TEXT.notSetUp, action: IDENTITY_TEXT.retry });
  assert.equal(IDENTITY_TEXT.notSetUp, 'Your identity is not set up yet.');
  assert.equal(kv.data.size, 0, 'nothing half-way');
  keys.stepUp(true);
  assert.equal((await identity.ensurePersonDid()).state, 'ready');
  assert.equal(identity.status().state, 'ready');
});

test('a secret store that does not answer leaves the identity pending; one that stops between the two writes is finished without a second signature', async () => {
  const keys = fakeKeys();
  const kv = memoryKv();
  kv.down(true);
  const identity = service(keys, kv);
  assert.equal((await identity.ensurePersonDid()).state, 'pending');
  assert.equal(keys.signs(), 0);
  kv.down(false);
  kv.failCreate(directoryPath(ENTITY));
  assert.equal((await identity.ensurePersonDid()).state, 'pending');
  assert.equal(keys.signs(), 1);
  assert.ok(kv.data.has(ownRecordPath(ENTITY)) && !kv.data.has(directoryPath(ENTITY)));
  kv.failCreate(undefined);
  const done = await identity.ensurePersonDid();
  assert.equal(done.state, 'ready');
  assert.equal(keys.signs(), 1, 'the log made earlier is used, not signed again');
  assert.deepEqual(kv.data.get(directoryPath(ENTITY)), { did: done.state === 'ready' ? done.did : '' });
});

test('at the first hub session the log is posted once, through that session, at its own path; a refusal is retried at the next session', async () => {
  const keys = fakeKeys();
  const kv = memoryKv();
  const identity = service(keys, kv);
  const made = await identity.ensurePersonDid();
  assert.ok(made.state === 'ready');
  const hub = fakeHub(503);
  assert.deepEqual(await identity.publishToHub(hub), refused(IDENTITY_TEXT.notPublished));
  assert.equal((kv.data.get(ownRecordPath(ENTITY)) as { published: boolean }).published, false);
  hub.answer(201);
  assert.deepEqual(await identity.publishToHub(hub), ok({ posted: true }));
  assert.deepEqual(hub.posts.map((post) => post.path), ['people/x7k2p9a1b2c3d4e5', 'people/x7k2p9a1b2c3d4e5']);
  assert.ok(realEngine.verifyWebvhLog(hub.posts[1]?.log as string, { now: NOW }).ok);
  assert.ok((hub.posts[1]?.log as string).endsWith('\n'));
  assert.deepEqual(identity.status(), { state: 'ready', did: made.did, published: true });
  assert.deepEqual(await identity.publishToHub(hub), ok({ posted: false }), 'posted once');
  assert.equal(hub.posts.length, 2);
});

test('without a DID domain or the engine bundle nothing is made, and nothing is signed', async () => {
  const keys = fakeKeys();
  const kv = memoryKv();
  assert.deepEqual(await service(keys, kv, { domain: undefined }).ensurePersonDid(), { state: 'not-configured' });
  assert.deepEqual(await service(keys, kv, { engine: () => undefined }).ensurePersonDid(), { state: 'not-configured' });
  assert.deepEqual(await service(keys, kv, { domain: 'not a host' }).ensurePersonDid(), { state: 'not-configured' });
  assert.equal(keys.signs(), 0);
  assert.equal(kv.data.size, 0);
});

// ---- Task 3: binding a single computer -----------------------------------------------------------------------------------------------------

const computer = (): string => {
  const { publicKey } = generateKeyPairSync('ed25519');
  return didKeyFromPublicKey('Ed25519', new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url')));
};
const allocator: StatusAllocator = {
  allocate: async () => ({
    revocation: { list: 'https://hq.example.org/v1/trust/status/revocation-1', index: 4821 },
    suspension: { list: 'https://hq.example.org/v1/trust/status/suspension-1', index: 77 },
  }),
};

test('binding a computer refuses words that differ, a missing step-up and missing status lists, and makes nothing', async () => {
  const keys = fakeKeys();
  const kv = memoryKv();
  const identity = service(keys, kv, { statusAllocator: allocator });
  await identity.ensurePersonDid();
  const did = computer();
  const words = realEngine.deviceIdentityWords(did).join(' ');
  assert.deepEqual(await identity.bindComputer(did, `${words.split(' ').slice(1).join(' ')} other`, 'managed'), refused(IDENTITY_TEXT.wordsDiffer));
  assert.deepEqual(await identity.bindComputer('did:key:not-a-key', words, 'managed'), refused(IDENTITY_TEXT.notADevice));
  keys.stepUp(false);
  assert.deepEqual(await identity.bindComputer(did, words, 'managed'), refused(KEY_SERVICE_TEXT.stepUpNeeded, KEY_SERVICE_TEXT.confirm));
  keys.stepUp(true);
  assert.deepEqual(await service(keys, kv).bindComputer(did, words, 'managed'), refused(IDENTITY_TEXT.noStatusLists));
  const fresh = service(fakeKeys(), memoryKv(), { statusAllocator: allocator });
  assert.deepEqual(await fresh.bindComputer(did, words, 'managed'), refused(IDENTITY_TEXT.notSetUp, IDENTITY_TEXT.retry), 'no identity yet');
});

test('after the words match and a fresh step-up, the binding names this computer\'s did:key and the person\'s did:webvh and verifies with the person key', async () => {
  const keys = fakeKeys();
  const kv = memoryKv();
  const identity = service(keys, kv, { statusAllocator: allocator });
  const made = await identity.ensurePersonDid();
  assert.ok(made.state === 'ready');
  const did = computer();
  const bound = await identity.bindComputer(did, ` ${realEngine.deviceIdentityWords(did).join('  ').toUpperCase()} `, 'personal');
  assert.equal(bound.kind, 'ok');
  if (bound.kind !== 'ok') return;
  assert.match(bound.value.fileName, /^computer-[0-9a-f]{8}\.near-vc$/);
  const credential = JSON.parse(bound.value.text) as Record<string, any>;
  assert.equal(credential.issuer, made.did);
  assert.deepEqual(credential.credentialSubject, { id: did, device: realEngine.deviceFingerprint(did), class: 'personal' });
  assert.deepEqual(credential.credentialStatus.map((entry: Record<string, string>) => entry.statusListIndex), ['4821', '77']);
  const multikey = realEngine.encodePublicKeyMultibase('Ed25519', new Uint8Array(keys.publicRaw));
  const verified = verifyCredential(credential, { scales: realEngine.SCALE_PRESETS, publicKey: decodePublicKeyMultibase(multikey) });
  assert.ok(verified.ok, verified.ok ? '' : verified.message);
  assert.equal(keys.signs(), 2, 'the DID once, the binding once');
  // The words are this computer's own: another computer's did:key gives other words.
  assert.notDeepEqual(realEngine.deviceIdentityWords(computer()), realEngine.deviceIdentityWords(did));
});
