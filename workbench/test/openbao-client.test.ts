// Phase 46, plan 02, task 1 (D-19, D-22, D-25; T-46-06, T-46-08): the hosting settings choose local or hosted mode only from
// STERLING_OPENBAO_ADDR and refuse any invalid value with one sentence naming the setting; the OpenBao client is plain node:http(s) with the
// site's CA, a timeout on every call, a 1 MiB answer cap, the token only in X-Vault-Token, and no token in any error or console output.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readHostingConfig } from '../extension/src/node/hosting-config.ts';
import { createOpenBaoClient, OpenBaoError } from '../extension/src/node/openbao-client.ts';
import { captureOutput, closedPort, startFakeOpenBao, type FakeOpenBao } from './helpers/fake-openbao.ts';
import { makeTestCertificate, type TestCertificate } from './helpers/tls-cert.ts';

const TOKEN = 's.fake-openbao-token-7f3a9c';
const HOSTED = { STERLING_OPENBAO_ADDR: 'https://bao.example.test:8200', THEIACLOUD_SESSION_USER: 'ada@example.test' };
const output = captureOutput();
let fake: FakeOpenBao;
let cert: TestCertificate;
let tlsFake: FakeOpenBao;

before(async () => {
  fake = await startFakeOpenBao({
    'GET /v1/auth/token/lookup-self': () => ({ json: { data: { entity_id: '00000000-0000-4000-8000-000000000001' } } }),
    'POST /v1/echo': (call) => ({ json: { echoed: call.body } }),
    'POST /v1/auth/jwt/login': () => ({ status: 403, json: { errors: ['permission denied'] } }),
    'GET /v1/slow': () => ({ delayMs: 2000, json: {} }),
    'GET /v1/huge': () => ({ raw: JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 10) }) }),
    'GET /v1/not-json': () => ({ raw: '{ this is not json' }),
    'GET /v1/broken': () => ({ status: 500, json: { errors: ['internal error'] } }),
    'POST /v1/auth/token/revoke-self': () => ({ status: 204 }),
    'GET /v1/kv/data/users/00000000-0000-4000-8000-000000000001/svc/acct': () => ({ status: 403, json: { errors: ['permission denied'] } }),
  });
  cert = makeTestCertificate();
  tlsFake = await startFakeOpenBao({ 'GET /v1/sys/health': () => ({ json: { initialized: true } }) }, { tls: cert });
});

after(async () => {
  await fake.close();
  await tlsFake.close();
  cert.cleanup();
  output.stop();
  assert.ok(!output.text().includes(TOKEN), 'the token string never reached the console');
});

async function rejection(promise: Promise<unknown>): Promise<OpenBaoError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof OpenBaoError, `expected an OpenBaoError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the call to fail');
}

/** The call throws one sentence that begins with the setting's name. */
function refusesNaming(call: () => unknown, setting: string): void {
  assert.throws(call, (error: Error) => {
    assert.ok(error.message.startsWith(`${setting} `), `expected a sentence naming ${setting}, got: ${error.message}`);
    return true;
  });
}

function assertNoToken(error: OpenBaoError): void {
  assert.ok(!error.message.includes(TOKEN), 'no token in the message');
  assert.ok(!JSON.stringify({ ...error, stack: error.stack }).includes(TOKEN), 'no token in any field');
}

test('with STERLING_OPENBAO_ADDR unset or empty the session is local', () => {
  assert.deepEqual(readHostingConfig({}), { mode: 'local' });
  assert.deepEqual(readHostingConfig({ STERLING_OPENBAO_ADDR: '', THEIACLOUD_SESSION_USER: 'ada@example.test' }), { mode: 'local' });
  assert.deepEqual(readHostingConfig({ STERLING_OPENBAO_ADDR: '   ' }), { mode: 'local' });
});

test('hosted mode takes the defaults jwt, sterling-workbench, kv, transit and 300', () => {
  assert.deepEqual(readHostingConfig(HOSTED), {
    mode: 'hosted',
    addr: 'https://bao.example.test:8200',
    jwtMount: 'jwt',
    jwtRole: 'sterling-workbench',
    kvMount: 'kv',
    transitMount: 'transit',
    stepUpMaxAgeSeconds: 300,
    sessionUser: 'ada@example.test',
  });
  const custom = readHostingConfig({ ...HOSTED, STERLING_OPENBAO_CA_FILE: '/etc/sterling/ca.pem', STERLING_OPENBAO_JWT_MOUNT: 'keycloak',
    STERLING_OPENBAO_JWT_ROLE: 'hq-workbench', STERLING_OPENBAO_KV_MOUNT: 'secret', STERLING_OPENBAO_TRANSIT_MOUNT: 'keys',
    STERLING_STEPUP_ACR: 'urn:example:acr:hw', STERLING_STEPUP_MAX_AGE_SECONDS: '120' });
  assert.deepEqual(custom, { mode: 'hosted', addr: 'https://bao.example.test:8200', caFile: '/etc/sterling/ca.pem', jwtMount: 'keycloak',
    jwtRole: 'hq-workbench', kvMount: 'secret', transitMount: 'keys', stepUpAcr: 'urn:example:acr:hw', stepUpMaxAgeSeconds: 120,
    sessionUser: 'ada@example.test' });
});

test('http is accepted only to a loopback address', () => {
  assert.throws(() => readHostingConfig({ ...HOSTED, STERLING_OPENBAO_ADDR: 'http://bao.example.test' }), /STERLING_OPENBAO_ADDR/);
  assert.throws(() => readHostingConfig({ ...HOSTED, STERLING_OPENBAO_ADDR: 'ftp://bao.example.test' }), /STERLING_OPENBAO_ADDR/);
  assert.throws(() => readHostingConfig({ ...HOSTED, STERLING_OPENBAO_ADDR: 'bao.example.test:8200' }), /STERLING_OPENBAO_ADDR/);
  for (const addr of ['http://127.0.0.1:8200', 'http://[::1]:8200', 'http://localhost:8200']) {
    const config = readHostingConfig({ ...HOSTED, STERLING_OPENBAO_ADDR: addr });
    assert.equal(config.mode === 'hosted' && config.addr, addr);
  }
});

test('an address with a user name, a password, a query, a fragment or a path is refused', () => {
  for (const addr of ['https://ada@bao.example.test', 'https://ada:secret@bao.example.test', 'https://bao.example.test/?x=1',
    'https://bao.example.test/#top', 'https://bao.example.test/v1']) {
    assert.throws(() => readHostingConfig({ ...HOSTED, STERLING_OPENBAO_ADDR: addr }), (error: Error) => {
      assert.match(error.message, /^STERLING_OPENBAO_ADDR /);
      assert.ok(!error.message.includes('secret'), 'the refusal does not repeat a password');
      return true;
    });
  }
});

test('mount names, the step-up window and the session user are checked, each refusal naming its setting', () => {
  for (const setting of ['STERLING_OPENBAO_JWT_MOUNT', 'STERLING_OPENBAO_KV_MOUNT', 'STERLING_OPENBAO_TRANSIT_MOUNT']) {
    for (const value of ['a/b', '..', 'kv/..', 'Upper', '']) {
      if (value === '') continue; // empty means the default
      refusesNaming(() => readHostingConfig({ ...HOSTED, [setting]: value }), setting);
    }
  }
  refusesNaming(() => readHostingConfig({ ...HOSTED, STERLING_OPENBAO_JWT_ROLE: 'a/b' }), 'STERLING_OPENBAO_JWT_ROLE');
  for (const value of ['0', '3601', '5m', '1.5', '-1']) {
    refusesNaming(() => readHostingConfig({ ...HOSTED, STERLING_STEPUP_MAX_AGE_SECONDS: value }), 'STERLING_STEPUP_MAX_AGE_SECONDS');
  }
  assert.equal((readHostingConfig({ ...HOSTED, STERLING_STEPUP_MAX_AGE_SECONDS: '3600' }) as { stepUpMaxAgeSeconds: number }).stepUpMaxAgeSeconds, 3600);
  refusesNaming(() => readHostingConfig({ STERLING_OPENBAO_ADDR: HOSTED.STERLING_OPENBAO_ADDR }), 'THEIACLOUD_SESSION_USER');
  refusesNaming(() => readHostingConfig({ ...HOSTED, THEIACLOUD_SESSION_USER: '  ' }), 'THEIACLOUD_SESSION_USER');
});

test('the client sends X-Vault-Token only when a token is given, and JSON bodies round-trip', async () => {
  const client = createOpenBaoClient({ addr: fake.url, timeoutMs: 1000 });
  const looked = await client.request('GET', 'auth/token/lookup-self', { token: TOKEN });
  assert.equal(looked.status, 200);
  assert.deepEqual(looked.json, { data: { entity_id: '00000000-0000-4000-8000-000000000001' } });
  const echoed = await client.request('POST', 'echo', { body: { role: 'r', nested: { list: [1, 'two'] } } });
  assert.deepEqual(echoed.json, { echoed: { role: 'r', nested: { list: [1, 'two'] } } });
  const [lookup] = fake.callsTo('GET /v1/auth/token/lookup-self');
  assert.equal(lookup.hasToken, true);
  assert.equal(lookup.token, TOKEN);
  assert.equal(fake.callsTo('POST /v1/echo')[0].hasToken, false);
  const revoked = await client.request('POST', 'auth/token/revoke-self', { token: TOKEN });
  assert.deepEqual(revoked, { status: 204, json: undefined });
});

test('a 404 answers { status: 404 } without throwing', async () => {
  const client = createOpenBaoClient({ addr: fake.url, timeoutMs: 1000 });
  assert.deepEqual(await client.request('GET', 'kv/data/users/x/missing', { token: TOKEN }), { status: 404, json: undefined });
});

test('connection refused and a slow answer are unreachable', async () => {
  const port = await closedPort();
  const refusedConnection = await rejection(createOpenBaoClient({ addr: `http://127.0.0.1:${port}`, timeoutMs: 1000 }).request('GET', 'sys/health', { token: TOKEN }));
  assert.equal(refusedConnection.kind, 'unreachable');
  assertNoToken(refusedConnection);
  const started = Date.now();
  const slow = await rejection(createOpenBaoClient({ addr: fake.url, timeoutMs: 200 }).request('GET', 'slow', { token: TOKEN }));
  assert.equal(slow.kind, 'unreachable');
  assert.ok(Date.now() - started < 1500, 'the timeout ends the call');
  assertNoToken(slow);
});

test('a 403 on login is refused with its status; a 500 is a bad response', async () => {
  const client = createOpenBaoClient({ addr: fake.url, timeoutMs: 1000 });
  const login = await rejection(client.request('POST', 'auth/jwt/login', { body: { role: 'sterling-workbench', jwt: TOKEN } }));
  assert.equal(login.kind, 'refused');
  assert.equal(login.status, 403);
  assert.match(login.message, /POST auth\/jwt\/login/);
  assertNoToken(login);
  const broken = await rejection(client.request('GET', 'broken', { token: TOKEN }));
  assert.equal(broken.kind, 'bad-response');
  assert.equal(broken.status, 500);
});

test('an answer over 1 MiB or with invalid JSON is a bad response', async () => {
  const client = createOpenBaoClient({ addr: fake.url, timeoutMs: 2000 });
  assert.equal((await rejection(client.request('GET', 'huge', { token: TOKEN }))).kind, 'bad-response');
  const invalid = await rejection(client.request('GET', 'not-json', { token: TOKEN }));
  assert.equal(invalid.kind, 'bad-response');
  assertNoToken(invalid);
});

test('error texts name the method, the path with users/<id> hidden, and the status, never a header or a body', async () => {
  const client = createOpenBaoClient({ addr: fake.url, timeoutMs: 1000 });
  const error = await rejection(client.request('GET', 'kv/data/users/00000000-0000-4000-8000-000000000001/svc/acct', { token: TOKEN }));
  assert.equal(error.kind, 'refused');
  assert.ok(!error.message.includes('00000000-0000-4000-8000-000000000001'), 'no entity id in the message');
  assert.match(error.message, /GET kv\/data\/users\/…/);
  assert.match(error.message, /403/);
  assert.ok(!error.message.includes('permission denied'), 'no answer body in the message');
});

test('over https the client trusts the CA in caFile, and without it the call is unreachable', async () => {
  const trusted = await createOpenBaoClient({ addr: tlsFake.url, caFile: cert.caFile, timeoutMs: 2000 }).request('GET', 'sys/health', { token: TOKEN });
  assert.deepEqual(trusted, { status: 200, json: { initialized: true } });
  const untrusted = await rejection(createOpenBaoClient({ addr: tlsFake.url, timeoutMs: 2000 }).request('GET', 'sys/health', { token: TOKEN }));
  assert.equal(untrusted.kind, 'unreachable');
  assertNoToken(untrusted);
});

test('a CA file that cannot be read is refused when the client is made, naming STERLING_OPENBAO_CA_FILE', () => {
  refusesNaming(() => createOpenBaoClient({ addr: tlsFake.url, caFile: `${cert.dir}/no-such-ca.pem`, timeoutMs: 1000 }), 'STERLING_OPENBAO_CA_FILE');
});
