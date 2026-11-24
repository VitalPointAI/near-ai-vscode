// Phase 46, plan 07, task 3 (D-20, D-21, D-25; T-46-28 to T-46-30), against the fake OpenBao: sign logs in to the step-up role with the fresh
// forwarded token, signs with that short-lived token and revokes it, in that order, and only after the acr and auth_time guard passes; the
// session's own token never signs. Wrapped data keys and unwrapping use the session token. Missing keys, local mode and an inactive session
// are plain refusals; only sign, datakey/wrapped and decrypt paths are ever called, and one read of the person's own signing key (Phase 33
// D-61, owner decision 2026-11-24); the RPC object has no unwrapDataKey and no personPublicKey; nothing leaks.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { KEY_SERVICE_TEXT } from '../extension/src/common/key-service.ts';
import type { SessionIdentityStatus } from '../extension/src/common/session-identity.ts';
import { readHostingConfig, type HostedConfig } from '../extension/src/node/hosting-config.ts';
import { createKeyService, keyServiceRpc, type KeySessionSource } from '../extension/src/node/key-service.ts';
import { createOpenBaoClient } from '../extension/src/node/openbao-client.ts';
import type { ActiveSession } from '../extension/src/node/session-identity.ts';
import { captureOutput, startFakeOpenBao, type FakeAnswer, type FakeCall, type FakeOpenBao } from './helpers/fake-openbao.ts';

const ENTITY = '3a9e7c1b-5d2f-4e8a-9b6c-0d1e2f3a4b5c';
const SESSION_TOKEN = 's.ORDINARYSESSIONTOKEN0123456789ab';
const STEPUP_TOKEN = 's.STEPUPTOKEN0123456789abcdefghij';
const FORWARDED = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJrYy1hZGEifQ.forwarded-signature';
const ACR = 'urn:sterling:acr:phishing-resistant';
const NOW = 1_795_000_000_000;
const SIGNATURE = Buffer.alloc(64, 7).toString('base64');
const MESSAGE = Buffer.from('a statement to sign').toString('base64');
const PUBLIC_V1 = Buffer.alloc(32, 1);
const PUBLIC_V2 = Buffer.alloc(32, 2);
const output = captureOutput();
const fakes: FakeOpenBao[] = [];
const allCalls: FakeCall[] = [];

after(async () => {
  for (const fake of fakes) await fake.close();
  output.stop();
  const text = output.text();
  for (const value of [SESSION_TOKEN, STEPUP_TOKEN, FORWARDED, ENTITY]) assert.ok(!text.includes(value), 'no token or entity id reached the console');
  // Across the whole file: only the step-up login, its revoke, the three Transit paths and a GET of the person's own signing key, never a key
  // administration path (T-46-30).
  const ownKey = `GET /v1/transit/keys/person-${ENTITY}`;
  const allowed = [/^\/v1\/auth\/jwt\/login$/, /^\/v1\/auth\/token\/revoke-self$/, /^\/v1\/transit\/sign\//, /^\/v1\/transit\/datakey\/wrapped\//, /^\/v1\/transit\/decrypt\//];
  for (const call of allCalls) assert.ok(`${call.method} ${call.path}` === ownKey || allowed.some((rule) => rule.test(call.path)), `unexpected OpenBao path ${call.path}`);
  assert.ok(allCalls.every((call) => `${call.method} ${call.path}` === ownKey || !/transit\/(keys|rotate|export|config|restore|backup|trim)/.test(call.path)));
  assert.ok(allCalls.every((call) => !/transit\/(rotate|export|config|restore|backup|trim)|\/keys\/.*\//.test(call.path)));
});

const HOSTED_ENV = { STERLING_OPENBAO_ADDR: 'http://127.0.0.1:8200', THEIACLOUD_SESSION_USER: 'ada@example.test', STERLING_STEPUP_ACR: ACR };

interface World {
  fake: FakeOpenBao;
  service: ReturnType<typeof createKeyService>;
}

async function world(options: {
  routes?: Record<string, (call: FakeCall) => FakeAnswer>;
  session?: Partial<ActiveSession> | null;
  env?: Record<string, string>;
  local?: boolean;
} = {}): Promise<World> {
  const routes: Record<string, (call: FakeCall) => FakeAnswer> = {
    'POST /v1/auth/jwt/login': () => ({ json: { auth: { client_token: STEPUP_TOKEN, lease_duration: 300 } } }),
    'POST /v1/auth/token/revoke-self': () => ({ status: 204 }),
    [`POST /v1/transit/sign/person-${ENTITY}`]: () => ({ json: { data: { signature: `vault:v1:${SIGNATURE}`, key_version: 1 } } }),
    [`POST /v1/transit/datakey/wrapped/kek-${ENTITY}`]: () => ({ json: { data: { ciphertext: 'vault:v1:d3JhcHBlZA==', key_version: 1 } } }),
    [`POST /v1/transit/decrypt/kek-${ENTITY}`]: () => ({ json: { data: { plaintext: Buffer.alloc(32, 9).toString('base64') } } }),
    [`GET /v1/transit/keys/person-${ENTITY}`]: () => ({ json: { data: { type: 'ed25519', latest_version: 2, exportable: false, keys: {
      1: { public_key: PUBLIC_V1.toString('base64'), name: 'ed25519' }, 2: { public_key: PUBLIC_V2.toString('base64'), name: 'ed25519' },
    } } } }),
    ...options.routes,
  };
  const recording = Object.fromEntries(Object.entries(routes).map(([key, route]) => [key, (call: FakeCall) => { allCalls.push(call); return route(call); }]));
  const fake = await startFakeOpenBao(new Proxy(recording, {
    get: (target, key: string) => target[key] ?? ((call: FakeCall) => { allCalls.push(call); return { status: 404, json: { errors: [] } }; }),
  }));
  fakes.push(fake);
  const config = readHostingConfig({ ...HOSTED_ENV, STERLING_OPENBAO_ADDR: fake.url, ...options.env }) as HostedConfig;
  const base: ActiveSession = {
    token: SESSION_TOKEN, entityId: ENTITY, forwardedToken: FORWARDED, acr: ACR, authTime: NOW / 1000 - 10,
    client: createOpenBaoClient({ addr: fake.url, timeoutMs: 2000 }), config,
  };
  const session = options.session === null ? undefined : { ...base, ...options.session };
  const identity: KeySessionSource = {
    session: () => session,
    status: (): SessionIdentityStatus => (options.local ? { mode: 'local' } : { mode: 'hosted', state: session ? 'active' : 'identity' }),
  };
  return { fake, service: createKeyService(identity, { now: () => NOW }) };
}

const transitAndLogin = (fake: FakeOpenBao): FakeCall[] => fake.calls;

test('a fresh step-up signs: login to the step-up role, sign with that token, then revoke it, in that order', async () => {
  const { fake, service } = await world();
  const result = await service.sign(MESSAGE);
  assert.deepEqual(result, { kind: 'ok', value: { signature: SIGNATURE, keyVersion: 1 } });
  assert.deepEqual(fake.calls.map((call) => `${call.method} ${call.path}`), [
    'POST /v1/auth/jwt/login', `POST /v1/transit/sign/person-${ENTITY}`, 'POST /v1/auth/token/revoke-self',
  ]);
  const [login, sign, revoke] = fake.calls;
  assert.deepEqual(login.body, { role: 'sterling-workbench-stepup', jwt: FORWARDED });
  assert.equal(login.hasToken, false);
  assert.deepEqual(sign.body, { input: MESSAGE });
  assert.equal(sign.token, STEPUP_TOKEN, 'the step-up token signs');
  assert.equal(revoke.token, STEPUP_TOKEN, 'and is revoked');
  assert.ok(fake.calls.every((call) => call.token !== SESSION_TOKEN), "the session's ordinary token never signs");
  // A step-up token lives no longer than the window and OpenBao refuses it after that (47-07's lab run), so no token is kept between
  // signatures: the next one logs in again.
  assert.equal((await service.sign(MESSAGE)).kind, 'ok');
  assert.equal(fake.callsTo('POST /v1/auth/jwt/login').length, 2);
  assert.equal(fake.callsTo('POST /v1/auth/token/revoke-self').length, 2);
});

test('acr missing or different, auth_time missing, too old or in the future: refused with the fix, and no OpenBao call', async () => {
  const cases: Array<Partial<ActiveSession>> = [
    { acr: undefined }, { acr: 'urn:sterling:acr:password' }, { authTime: undefined }, { authTime: NOW / 1000 - 301 }, { authTime: NOW / 1000 + 600 },
  ];
  for (const session of cases) {
    const { fake, service } = await world({ session });
    assert.deepEqual(await service.sign(MESSAGE), { kind: 'refused', reason: KEY_SERVICE_TEXT.stepUpNeeded, fix: 'Confirm with your passkey or security key' });
    assert.equal(fake.calls.length, 0, `no call for ${JSON.stringify(session)}`);
  }
  const edge = await world({ session: { authTime: NOW / 1000 - 300 } });
  assert.equal((await edge.service.sign(MESSAGE)).kind, 'ok', 'exactly at the window still signs');
});

test('STERLING_STEPUP_ACR unset: signing is not set up on this site, and no OpenBao call', async () => {
  const { fake, service } = await world({ env: { STERLING_STEPUP_ACR: '' } });
  assert.deepEqual(await service.sign(MESSAGE), { kind: 'refused', reason: KEY_SERVICE_TEXT.notSetUp });
  assert.equal(fake.calls.length, 0);
});

test('a refused step-up login is the same plain refusal and makes no sign call', async () => {
  const { fake, service } = await world({ routes: { 'POST /v1/auth/jwt/login': () => ({ status: 400, json: { errors: ['claim "acr" does not match'] } }) } });
  assert.deepEqual(await service.sign(MESSAGE), { kind: 'refused', reason: KEY_SERVICE_TEXT.stepUpNeeded, fix: KEY_SERVICE_TEXT.confirm });
  assert.deepEqual(fake.calls.map((call) => call.path), ['/v1/auth/jwt/login']);
});

test('a message that is not base64, or larger than 64 KiB, is refused without a call', async () => {
  const { fake, service } = await world();
  for (const message of ['not base64!', 'YQ', Buffer.alloc(64 * 1024 + 1).toString('base64')]) {
    assert.deepEqual(await service.sign(message), { kind: 'refused', reason: KEY_SERVICE_TEXT.badMessage });
  }
  assert.equal((await service.sign(Buffer.alloc(64 * 1024).toString('base64'))).kind, 'ok', '64 KiB exactly is accepted');
  assert.equal(fake.calls.filter((call) => call.path.includes('/sign/')).length, 1);
});

test('a missing signing key (400 or 404) is refused plainly, and the step-up token is still revoked', async () => {
  for (const status of [400, 404]) {
    const { fake, service } = await world({ routes: { [`POST /v1/transit/sign/person-${ENTITY}`]: () => ({ status, json: { errors: ['signing key not found'] } }) } });
    assert.deepEqual(await service.sign(MESSAGE), { kind: 'refused', reason: KEY_SERVICE_TEXT.signingKeyMissing });
    assert.equal(fake.callsTo('POST /v1/auth/token/revoke-self').length, 1);
  }
});

test('generateWrappedDataKey returns the vault:vN: ciphertext from datakey/wrapped with the session token', async () => {
  const { fake, service } = await world();
  assert.deepEqual(await service.generateWrappedDataKey(), { kind: 'ok', value: { ciphertext: 'vault:v1:d3JhcHBlZA==' } });
  assert.deepEqual(fake.calls.map((call) => [call.path, call.token]), [[`/v1/transit/datakey/wrapped/kek-${ENTITY}`, SESSION_TOKEN]]);
  const missing = await world({ routes: { [`POST /v1/transit/datakey/wrapped/kek-${ENTITY}`]: () => ({ status: 400, json: { errors: ['encryption key not found'] } }) } });
  assert.deepEqual(await missing.service.generateWrappedDataKey(), { kind: 'refused', reason: KEY_SERVICE_TEXT.dataKeyMissing });
});

test('unwrapDataKey refuses a malformed ciphertext without a call and decrypts a valid one with the session token, no step-up needed', async () => {
  const { fake, service } = await world({ session: { acr: undefined, authTime: undefined } });
  for (const bad of ['', 'd3JhcHBlZA==', 'vault:v0:abc=', 'vault:v1:', 'vault:v1:not base64', `vault:v1:${'A'.repeat(5000)}`]) {
    assert.deepEqual(await service.unwrapDataKey(bad), { kind: 'refused', reason: KEY_SERVICE_TEXT.badCiphertext });
  }
  assert.equal(fake.calls.length, 0);
  const result = await service.unwrapDataKey('vault:v1:d3JhcHBlZA==');
  assert.equal(result.kind, 'ok');
  assert.equal(Buffer.from((result as { value: { plaintext: string } }).value.plaintext, 'base64').length, 32);
  assert.deepEqual(fake.calls.map((call) => [call.path, call.body, call.token]), [[`/v1/transit/decrypt/kek-${ENTITY}`, { ciphertext: 'vault:v1:d3JhcHBlZA==' }, SESSION_TOKEN]]);
});

test('personPublicKey reads the latest version of the person\'s own signing key with the session token, no step-up needed', async () => {
  const { fake, service } = await world({ session: { acr: undefined, authTime: undefined } });
  assert.deepEqual(await service.personPublicKey(), { kind: 'ok', value: { publicKey: PUBLIC_V2.toString('base64url'), keyVersion: 2 } });
  assert.deepEqual(fake.calls.map((call) => [call.method, call.path, call.token]), [['GET', `/v1/transit/keys/person-${ENTITY}`, SESSION_TOKEN]]);
});

test('personPublicKey: a missing key, a refusal and an answer that is not one ed25519 public key are plain refusals', async () => {
  const route = `GET /v1/transit/keys/person-${ENTITY}`;
  const answer = (data: unknown) => () => ({ json: { data } });
  const cases: Array<[() => { status?: number; json?: unknown }, string]> = [
    [() => ({ status: 404, json: { errors: [] } }), KEY_SERVICE_TEXT.signingKeyMissing],
    [() => ({ status: 403, json: { errors: ['permission denied'] } }), KEY_SERVICE_TEXT.refused],
    [answer({ type: 'aes256-gcm96', latest_version: 1, keys: { 1: 1700000000 } }), KEY_SERVICE_TEXT.unreachable],
    [answer({ type: 'ed25519', latest_version: 3, keys: { 1: { public_key: PUBLIC_V1.toString('base64') } } }), KEY_SERVICE_TEXT.unreachable],
    [answer({ type: 'ed25519', latest_version: 1, keys: { 1: { public_key: Buffer.alloc(31).toString('base64') } } }), KEY_SERVICE_TEXT.unreachable],
    [answer({ type: 'ed25519', latest_version: 0, keys: {} }), KEY_SERVICE_TEXT.unreachable],
  ];
  for (const [reply, reason] of cases) {
    const { service } = await world({ routes: { [route]: reply } });
    assert.deepEqual(await service.personPublicKey(), { kind: 'refused', reason });
  }
});

test('local mode: long-term keys are not available on this computer, for every method, with no call', async () => {
  const { fake, service } = await world({ local: true, session: null });
  const local = { kind: 'refused', reason: KEY_SERVICE_TEXT.local };
  assert.deepEqual(await service.sign(MESSAGE), local);
  assert.deepEqual(await service.generateWrappedDataKey(), local);
  assert.deepEqual(await service.unwrapDataKey('vault:v1:d3JhcHBlZA=='), local);
  assert.deepEqual(await service.personPublicKey(), local);
  assert.equal(fake.calls.length, 0);
});

test('an inactive hosted session is refused not-ready for every method, with no call', async () => {
  const { fake, service } = await world({ session: null });
  const notReady = { kind: 'refused', reason: KEY_SERVICE_TEXT.notReady };
  assert.deepEqual(await service.sign(MESSAGE), notReady);
  assert.deepEqual(await service.generateWrappedDataKey(), notReady);
  assert.deepEqual(await service.unwrapDataKey('vault:v1:d3JhcHBlZA=='), notReady);
  assert.deepEqual(await service.personPublicKey(), notReady);
  assert.equal(fake.calls.length, 0);
});

test('an OpenBao that refuses or does not answer gives a plain refusal with no token, key or entity id', async () => {
  const { service } = await world({ routes: { [`POST /v1/transit/datakey/wrapped/kek-${ENTITY}`]: () => ({ status: 403, json: { errors: ['permission denied'] } }) } });
  const denied = await service.generateWrappedDataKey();
  assert.deepEqual(denied, { kind: 'refused', reason: KEY_SERVICE_TEXT.refused });
  const silent = await world({ routes: { [`POST /v1/transit/datakey/wrapped/kek-${ENTITY}`]: () => ({ status: 200, delayMs: 3000 }) } });
  const late = await silent.service.generateWrappedDataKey();
  assert.deepEqual(late, { kind: 'refused', reason: KEY_SERVICE_TEXT.unreachable });
  for (const value of [SESSION_TOKEN, ENTITY]) assert.ok(!JSON.stringify([denied, late]).includes(value));
});

test('the RPC object has sign and generateWrappedDataKey, and no unwrapDataKey or personPublicKey', async () => {
  const { fake, service } = await world();
  const rpc = keyServiceRpc(service);
  assert.deepEqual(Object.keys(rpc).sort(), ['generateWrappedDataKey', 'sign']);
  assert.equal((rpc as unknown as Record<string, unknown>).unwrapDataKey, undefined);
  assert.equal((await rpc.sign(MESSAGE)).kind, 'ok');
  assert.equal((await rpc.generateWrappedDataKey()).kind, 'ok');
  assert.ok(transitAndLogin(fake).every((call) => !call.path.includes('/decrypt/')));
});
