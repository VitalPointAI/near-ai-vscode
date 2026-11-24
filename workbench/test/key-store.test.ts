// Phase 46, plan 07, task 1 (D-04, D-17 to D-19, D-36, D-37; T-46-25, T-46-27). Task 1: against the fake OpenBao, the OpenBao key
// store writes, reads, lists and deletes the person's own KV v2 paths with the session token, refuses every call without an active session,
// and never puts a secret, a token or the entity id in a rejection or on the console; the unavailable store rejects all six methods.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { SECRET_STORE_TEXT } from '../extension/src/common/secret-store.ts';
import { readHostingConfig, type HostedConfig } from '../extension/src/node/hosting-config.ts';
import { encodeSegment, secretPath } from '../extension/src/node/kv-path.ts';
import { createOpenBaoKeyStore, createUnavailableKeyStore, type KeyStore, type SessionSource } from '../extension/src/node/key-stores.ts';
import { createOpenBaoClient } from '../extension/src/node/openbao-client.ts';
import type { ActiveSession } from '../extension/src/node/session-identity.ts';
import { captureOutput, startFakeOpenBao, type FakeCall, type FakeOpenBao } from './helpers/fake-openbao.ts';

const ENTITY = '7d3f9b1a-2c4e-4f6a-8b0c-1d2e3f4a5b6c';
const TOKEN = 's.SESSIONTOKENVALUE0123456789abcdef';
const SECRET = 'probe-secret-value-4f1c';
const output = captureOutput();
const fakes: FakeOpenBao[] = [];

after(async () => {
  for (const fake of fakes) await fake.close();
  output.stop();
  const text = output.text();
  for (const value of [TOKEN, SECRET, ENTITY]) assert.ok(!text.includes(value), 'no token, secret value or entity id reached the console');
});

const HOSTED = readHostingConfig({ STERLING_OPENBAO_ADDR: 'http://127.0.0.1:8200', THEIACLOUD_SESSION_USER: 'ada@example.test' }) as HostedConfig;

/** An in-memory KV v2 behind the fake: data and metadata answer like OpenBao for the routes the store uses. */
async function kvWorld(): Promise<{ fake: FakeOpenBao; store: KeyStore; data: Map<string, string>; active: { on: boolean } }> {
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
  const session: ActiveSession = { token: TOKEN, entityId: ENTITY, client, config: HOSTED };
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
  const session: ActiveSession = { token: TOKEN, entityId: ENTITY, client: createOpenBaoClient({ addr: fake.url, timeoutMs: 2000 }), config: HOSTED };
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
