// Phase 46, plan 07, tasks 1 and 2 (D-04, D-17 to D-19, D-36, D-37; T-46-25, T-46-27). Task 1: against the fake OpenBao, the OpenBao key
// store writes, reads, lists and deletes the person's own KV v2 paths with the session token, refuses every call without an active session,
// and never puts a secret, a token or the entity id in a rejection or on the console; the unavailable store rejects all six methods.
// Task 2: the start-time choice, the keyring override that never falls back to memory, and the rebind of Theia's KeyStoreService.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Container } from '@theia/core/shared/inversify';
import { KeyStoreService } from '@theia/core/lib/common/key-store.js';
import { InMemoryCredentialsProvider, KeyStoreServiceImpl } from '@theia/core/lib/node/key-store-server.js';
import {
  readSecretStoreStatus, SECRET_STORE_TEXT, secretStoreGuidance, SecretStoreGuideSession, SecretStoreService, type SecretStoreStatus
} from '../extension/src/common/secret-store.ts';
import { readHostingConfig, type HostedConfig } from '../extension/src/node/hosting-config.ts';
import { encodeSegment, secretPath } from '../extension/src/node/kv-path.ts';
import { chooseKeyStore, createOpenBaoKeyStore, createUnavailableKeyStore, type KeyringCandidate, type KeyStore, type SessionSource } from '../extension/src/node/key-stores.ts';
import { KeyringKeyStoreService } from '../extension/src/node/keyring-key-store.ts';
import { createKeyStoreModule } from '../extension/src/node/key-store-backend-module.ts';
import { createOpenBaoClient } from '../extension/src/node/openbao-client.ts';
import type { ActiveSession } from '../extension/src/node/session-identity.ts';
import { SessionIdentity } from '../extension/src/node/session-identity.ts';
import { captureOutput, startFakeOpenBao, type FakeCall, type FakeOpenBao } from './helpers/fake-openbao.ts';

const ENTITY = '7d3f9b1a-2c4e-4f6a-8b0c-1d2e3f4a5b6c';
const TOKEN = 's.SESSIONTOKENVALUE0123456789abcdef';
const SECRET = 'probe-secret-value-4f1c';
const FORWARDED = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJrYy1hZGEifQ.forwarded-signature';
const output = captureOutput();
const fakes: FakeOpenBao[] = [];

after(async () => {
  for (const fake of fakes) await fake.close();
  output.stop();
  const text = output.text();
  for (const value of [TOKEN, SECRET, ENTITY, FORWARDED]) assert.ok(!text.includes(value), 'no token, secret value or entity id reached the console');
});

const HOSTED = readHostingConfig({ STERLING_OPENBAO_ADDR: 'http://127.0.0.1:8200', THEIACLOUD_SESSION_USER: 'ada@example.test' }) as HostedConfig;

/** An in-memory KV v2 behind the fake: data and metadata answer like OpenBao for the routes the store uses. */
async function kvWorld(space?: ActiveSession['space']): Promise<{ fake: FakeOpenBao; store: KeyStore; data: Map<string, string>; active: { on: boolean } }> {
  const data = new Map<string, string>();
  const prefix = '/v1/kv/';
  const routes = new Proxy({}, {
    get: (_target, key: string) => (call: FakeCall) => {
      const [method] = key.split(' ');
      const path = call.path.slice(prefix.length);
      if (path.startsWith('data/')) {
        const name = path.slice('data/'.length);
        if (method === 'POST') { data.set(name, (call.body as { data: { password: string } }).data.password); return { status: 200, json: { data: { version: 1 } } }; }
        if (method === 'GET') return data.has(name) ? { json: { data: { data: { password: data.get(name) }, metadata: { version: 1 } } } } : { status: 404, json: { errors: [] } };
      }
      if (path.startsWith('metadata/')) {
        const name = path.slice('metadata/'.length);
        if (method === 'GET' && call.query === '?list=true') {
          const keys = [...data.keys()].filter((k) => k.startsWith(`${name}/`)).map((k) => k.slice(name.length + 1));
          return keys.length ? { json: { data: { keys: [...keys, 'folder/'] } } } : { status: 404, json: { errors: [] } };
        }
        if (method === 'GET') return data.has(name) ? { json: { data: { current_version: 1 } } } : { status: 404, json: { errors: [] } };
        if (method === 'DELETE') { data.delete(name); return { status: 204 }; }
      }
      return { status: 404, json: { errors: [] } };
    },
    has: () => true,
  }) as Record<string, (call: FakeCall) => { status?: number; json?: unknown }>;
  const fake = await startFakeOpenBao(routes);
  fakes.push(fake);
  const client = createOpenBaoClient({ addr: fake.url, timeoutMs: 2000 });
  const active = { on: true };
  const session: ActiveSession = { token: TOKEN, entityId: ENTITY, forwardedToken: FORWARDED, client, config: HOSTED, ...(space ? { space } : {}) };
  const identity: SessionSource = { session: () => (active.on ? session : undefined) };
  return { fake, store: createOpenBaoKeyStore(identity, { kvMount: 'kv' }), data, active };
}

test('setPassword POSTs {data:{password}} to kv/data/users/<id>/<enc>/<enc> with the session token', async () => {
  const { fake, store } = await kvWorld();
  await store.setPassword('127.0.0.1-sterling-test.secret-probe', 'probe', SECRET);
  const [call] = fake.calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, `/v1/kv/data/${secretPath(ENTITY, '127.0.0.1-sterling-test.secret-probe', 'probe')}`);
  assert.deepEqual(call.body, { data: { password: SECRET } });
  assert.equal(call.token, TOKEN);
});

test('a guest\'s session keeps every secret under kv/guests/<id>/, never kv/users/', async () => {
  const { fake, store, data } = await kvWorld('guests');
  await store.setPassword('svc', 'acct', SECRET);
  assert.equal(await store.getPassword('svc', 'acct'), SECRET);
  assert.deepEqual(await store.keys('svc'), ['acct']);
  assert.equal(await store.deletePassword('svc', 'acct'), true);
  assert.equal(data.size, 0);
  assert.ok(fake.calls.length >= 4);
  assert.ok(fake.calls.every((call) => call.path.startsWith(`/v1/kv/data/guests/${ENTITY}/`) || call.path.startsWith(`/v1/kv/metadata/guests/${ENTITY}/`)), JSON.stringify(fake.calls.map((call) => call.path)));
});

test('getPassword reads data.data.password and answers undefined for a secret that is not there (404)', async () => {
  const { fake, store } = await kvWorld();
  await store.setPassword('svc', 'acct', SECRET);
  assert.equal(await store.getPassword('svc', 'acct'), SECRET);
  assert.equal(await store.getPassword('svc', 'other'), undefined);
  assert.ok(fake.calls.every((call) => call.token === TOKEN));
});

test('keys lists kv/metadata/users/<id>/<enc service>?list=true and decodes the names, skipping folders', async () => {
  const { fake, store } = await kvWorld();
  assert.deepEqual(await store.keys('svc'), []);
  await store.setPassword('svc', 'a/../b', 'one');
  await store.setPassword('svc', 'x:y:tokens', 'two');
  await store.setPassword('other', 'z', 'three');
  assert.deepEqual((await store.keys('svc')).sort(), ['a/../b', 'x:y:tokens']);
  const lists = fake.calls.filter((call) => call.query === '?list=true');
  assert.ok(lists.every((call) => call.method === 'GET' && call.path === `/v1/kv/metadata/users/${ENTITY}/${encodeSegment('svc')}`));
});

test('findCredentials and findPassword read what keys lists', async () => {
  const { store } = await kvWorld();
  assert.deepEqual(await store.findCredentials('svc'), []);
  assert.equal(await store.findPassword('svc'), undefined);
  await store.setPassword('svc', 'first', 'one');
  await store.setPassword('svc', 'second', 'two');
  const found = await store.findCredentials('svc');
  assert.deepEqual(found.sort((a, b) => a.account.localeCompare(b.account)), [{ account: 'first', password: 'one' }, { account: 'second', password: 'two' }]);
  assert.ok(['one', 'two'].includes((await store.findPassword('svc'))!));
});

test('deletePassword DELETEs the metadata path and answers true, or false when the secret did not exist', async () => {
  const { fake, store, data } = await kvWorld();
  await store.setPassword('svc', 'acct', SECRET);
  assert.equal(await store.deletePassword('svc', 'acct'), true);
  const deletes = fake.calls.filter((call) => call.method === 'DELETE');
  assert.deepEqual(deletes.map((call) => call.path), [`/v1/kv/metadata/${secretPath(ENTITY, 'svc', 'acct')}`]);
  assert.equal(data.size, 0);
  assert.equal(await store.deletePassword('svc', 'acct'), false);
  assert.equal(fake.calls.filter((call) => call.method === 'DELETE').length, 1, 'no DELETE for a secret that is not there');
});

test('without an active session every method rejects with the not-ready sentence and makes no OpenBao call', async () => {
  const { fake, store, active } = await kvWorld();
  active.on = false;
  const calls: Array<Promise<unknown>> = [
    store.setPassword('svc', 'acct', SECRET), store.getPassword('svc', 'acct'), store.deletePassword('svc', 'acct'),
    store.findPassword('svc'), store.findCredentials('svc'), store.keys('svc'),
  ];
  for (const call of calls) await assert.rejects(call, { message: SECRET_STORE_TEXT.notReady });
  assert.equal(fake.calls.length, 0);
});

test('an OpenBao refusal or silence becomes a plain sentence with no secret, token or entity id', async () => {
  const fake = await startFakeOpenBao({ 'POST /v1/kv/data/users/7d3f9b1a-2c4e-4f6a-8b0c-1d2e3f4a5b6c/udmFj/uYQ': () => ({ status: 403, json: { errors: ['permission denied'] } }) });
  fakes.push(fake);
  const session: ActiveSession = { token: TOKEN, entityId: ENTITY, forwardedToken: FORWARDED, client: createOpenBaoClient({ addr: fake.url, timeoutMs: 2000 }), config: HOSTED };
  const store = createOpenBaoKeyStore({ session: () => session }, { kvMount: 'kv' });
  await assert.rejects(store.setPassword('vac', 'a', SECRET), (error: Error) => {
    assert.equal(error.message, SECRET_STORE_TEXT.refused);
    for (const value of [TOKEN, SECRET, ENTITY]) assert.ok(!JSON.stringify({ message: error.message, stack: error.stack }).includes(value));
    return true;
  });
  const silent: ActiveSession = { ...session, client: createOpenBaoClient({ addr: 'http://127.0.0.1:9', timeoutMs: 500 }) };
  await assert.rejects(createOpenBaoKeyStore({ session: () => silent }, { kvMount: 'kv' }).getPassword('vac', 'a'), { message: SECRET_STORE_TEXT.unreachable });
});

test('the unavailable store rejects all six methods with its reason and never resolves', async () => {
  const store = createUnavailableKeyStore(SECRET_STORE_TEXT.noStore);
  const calls: Array<Promise<unknown>> = [
    store.setPassword('svc', 'acct', SECRET), store.getPassword('svc', 'acct'), store.deletePassword('svc', 'acct'),
    store.findPassword('svc'), store.findCredentials('svc'), store.keys('svc'),
  ];
  for (const call of calls) await assert.rejects(call, { message: SECRET_STORE_TEXT.noStore });
});

// Task 2.

/** Counts every use of Theia's in-memory provider: it must never hold a secret (T-46-27). */
function spyOnMemory(): { uses: () => number; restore: () => void } {
  const proto = InMemoryCredentialsProvider.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const names = ['getPassword', 'setPassword', 'deletePassword', 'findPassword', 'findCredentials', 'clear'];
  const originals = names.map((name) => proto[name]);
  let uses = 0;
  names.forEach((name, index) => { proto[name] = function (this: unknown, ...args: unknown[]) { uses += 1; return originals[index].apply(this, args); }; });
  return { uses: () => uses, restore: () => names.forEach((name, index) => { proto[name] = originals[index]; }) };
}

/** A keytar double: the six keytar functions over a Map, as the real module would answer them. */
function fakeKeytar(): Record<string, (...args: string[]) => Promise<unknown>> {
  const vault = new Map<string, string>();
  const key = (service: string, account: string): string => JSON.stringify([service, account]);
  return {
    getPassword: async (service, account) => vault.get(key(service, account)) ?? null,
    setPassword: async (service, account, password) => { vault.set(key(service, account), password); },
    deletePassword: async (service, account) => vault.delete(key(service, account)),
    findPassword: async (service) => [...vault].find(([k]) => JSON.parse(k)[0] === service)?.[1] ?? null,
    findCredentials: async (service) => [...vault].filter(([k]) => JSON.parse(k)[0] === service).map(([k, password]) => ({ account: JSON.parse(k)[1], password })),
  };
}

function keyringWith(load: () => Promise<unknown>): KeyringKeyStoreService {
  const keyring = new KeyringKeyStoreService();
  (keyring as unknown as { loadKeytar: () => Promise<unknown> }).loadKeytar = load;
  return keyring;
}

const noIdentity: SessionSource = { session: () => undefined };

test('an unknown refusal reason gives general recovery without retaining backend text', () => {
  const reason = 'unrecognized detail from the backend';
  const result = secretStoreGuidance({ store: 'unavailable', reason });
  assert.equal(result.choice, 'unavailable', 'an unfamiliar backend reason gets the bounded general recovery');
  assert.deepEqual(result.confirmed, { store: 'unavailable' });
  assert.equal(result.automaticallyOpen, true);
  assert.equal(secretStoreGuidance({ store: 'unavailable' }).choice, 'unavailable');
});

test('rejected, timed-out and malformed startup checks never open the unavailable guide', async () => {
  const signal = new AbortController().signal;
  const failure = await readSecretStoreStatus({ status: async () => { throw new Error('unrecognized detail'); } }, signal);
  let finish!: (status: SecretStoreStatus) => void;
  const timedOut = await readSecretStoreStatus({
    status: () => new Promise(resolve => { finish = resolve; })
  }, signal, 5);
  finish({ store: 'unavailable' });
  assert.equal(failure, undefined);
  assert.equal(timedOut, undefined);
  for (const reply of [failure, timedOut, null, {}, { store: 'ready' }]) {
    const result = secretStoreGuidance(reply);
    assert.equal(result.choice, 'unknown');
    assert.equal(result.confirmed, undefined);
    assert.equal(result.automaticallyOpen, false);
  }
});

test('a failed recheck keeps the last confirmed choice until a new supported kind is returned', () => {
  const previous: SecretStoreStatus = { store: 'unavailable', reason: SECRET_STORE_TEXT.noStore };
  const stale = secretStoreGuidance(undefined, previous);
  assert.equal(stale.stale, true, 'a failed check positively marks the previous result as the last confirmation');
  assert.deepEqual(stale.confirmed, previous);
  assert.equal(stale.choice, 'noStore');
  assert.equal(stale.automaticallyOpen, false);

  const newChoice = secretStoreGuidance({ store: 'keyring' }, stale.confirmed);
  assert.deepEqual(newChoice.confirmed, { store: 'keyring' });
  assert.equal(newChoice.choice, 'keyring');
  assert.equal(newChoice.stale, false);
  assert.equal(newChoice.automaticallyOpen, false);
});

test('shutdown ends a pending status check and discards a late confirmation', async () => {
  const controller = new AbortController();
  let finish!: (status: SecretStoreStatus) => void;
  const pending = readSecretStoreStatus({
    status: () => new Promise(resolve => { finish = resolve; })
  }, controller.signal);
  controller.abort();
  finish({ store: 'unavailable' });
  assert.equal(await pending, undefined);
});

test('closing the guide while checking keeps the first confirmed unavailable presentation eligible', async () => {
  const session = new SecretStoreGuideSession();
  const signal = new AbortController().signal;
  const unavailable: SecretStoreStatus = { store: 'unavailable', reason: SECRET_STORE_TEXT.noStore };
  let finish!: (status: SecretStoreStatus) => void;
  const pending = readSecretStoreStatus({ status: () => new Promise(resolve => { finish = resolve; }) }, signal);

  session.markVisible(); // A manual open while the check is pending showed no confirmed choice.
  assert.equal(session.automaticallyOpen, false);
  // The person closes the manual guide before the missing-store confirmation arrives.
  finish(unavailable);
  session.accept(await pending);
  assert.equal(session.automaticallyOpen, true, 'a first confirmation still gets an automatic presentation');
  session.markVisible();
  session.accept(unavailable);
  assert.equal(session.automaticallyOpen, false, 'the guide already showed confirmed unavailability');
});

test('hosted settings choose the OpenBao store without touching the keyring', async () => {
  let asked = 0;
  const choice = await chooseKeyStore(HOSTED, { identity: noIdentity, keyring: () => { asked += 1; throw new Error('no keyring here'); } });
  assert.equal(choice.kind, 'openbao');
  const guidance = secretStoreGuidance({ store: choice.kind });
  assert.equal(guidance.choice, 'openbao', 'hosted selection has its own information without an unavailable warning');
  assert.equal(guidance.automaticallyOpen, false);
  assert.equal(choice.reason, undefined);
  assert.equal(asked, 0);
  await assert.rejects(choice.store.getPassword('svc', 'acct'), { message: SECRET_STORE_TEXT.notReady });
});

test('local settings with a keytar that does not load choose unavailable; saving fails and memory is never used', async () => {
  const memory = spyOnMemory();
  try {
    const failing = (): Promise<unknown> => Promise.reject(new Error('libsecret-1.so.0: cannot open shared object file'));
    const choice = await chooseKeyStore({ mode: 'local' }, { identity: noIdentity, keyring: () => keyringWith(failing) });
    assert.equal(choice.kind, 'unavailable');
    assert.equal(choice.reason, SECRET_STORE_TEXT.keyringFailed);
    assert.equal(secretStoreGuidance({ store: choice.kind, reason: choice.reason }).choice, 'keyringFailed', 'keyring failure leads to keyring repair');
    await assert.rejects(choice.store.setPassword('svc', 'acct', SECRET), { message: SECRET_STORE_TEXT.keyringFailed });
    // Even used directly, the override rethrows where Theia's own getKeytar would quietly switch to memory.
    await assert.rejects(keyringWith(failing).setPassword('svc', 'acct', SECRET), { message: SECRET_STORE_TEXT.keyringFailed });
    const missing = Object.assign(new Error("Cannot find module 'keytar'"), { code: 'ERR_MODULE_NOT_FOUND' });
    const absent = await chooseKeyStore({ mode: 'local' }, { identity: noIdentity, keyring: () => keyringWith(() => Promise.reject(missing)) });
    assert.deepEqual([absent.kind, absent.reason], ['unavailable', SECRET_STORE_TEXT.noStore]);
    assert.equal(secretStoreGuidance({ store: absent.kind, reason: absent.reason }).choice, 'noStore', 'missing integration leads to provisioning');
    assert.equal(memory.uses(), 0, "Theia's in-memory provider was never used");
  } finally {
    memory.restore();
  }
});

test('local settings with a keytar that loads and answers choose the keyring, which round-trips a password', async () => {
  const keytar = fakeKeytar();
  const choice = await chooseKeyStore({ mode: 'local' }, { identity: noIdentity, keyring: () => keyringWith(async () => keytar) });
  assert.equal(choice.kind, 'keyring');
  const guidance = secretStoreGuidance({ store: choice.kind });
  assert.equal(guidance.choice, 'keyring', 'keyring selection has its own information without an unavailable warning');
  assert.equal(guidance.automaticallyOpen, false);
  await choice.store.setPassword('svc', 'acct', SECRET);
  assert.equal(await choice.store.getPassword('svc', 'acct'), SECRET);
  assert.deepEqual(await choice.store.keys('svc'), ['acct']);
  assert.equal(await choice.store.deletePassword('svc', 'acct'), true);
});

test("Theia's KeyStoreService binding is rebound to the delegating store, and a call before the choice is made waits for it", async () => {
  const container = new Container();
  container.bind(KeyStoreService).to(KeyStoreServiceImpl).inSingletonScope();
  container.bind(SessionIdentity).toConstantValue({ session: () => undefined });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const keytar = fakeKeytar();
  const keyring = (): KeyringCandidate => keyringWith(async () => { await gate; return keytar; });
  container.load(createKeyStoreModule({ env: {}, keyring, log: () => undefined }));

  const service = container.get<KeyStoreService>(KeyStoreService);
  assert.ok(!(service instanceof KeyStoreServiceImpl), "Theia's own KeyStoreServiceImpl is no longer what KeyStoreService resolves to");
  let settled = false;
  const saving = service.setPassword('svc', 'acct', SECRET).then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, 'the save waits for the start-time choice');
  release();
  await saving;
  assert.equal(await service.getPassword('svc', 'acct'), SECRET);
  const status = await container.get<{ status(): Promise<SecretStoreStatus> }>(SecretStoreService).status();
  assert.deepEqual(status, { store: 'keyring' });
});
