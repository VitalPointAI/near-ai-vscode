// Phase 46, plan 02, task 3 (D-22, D-23, D-29; FND-T-05): the SessionIdentity core against a real dev-mode OpenBao from the pinned
// openbao-test image, over http to 127.0.0.1 (the loopback rule). A JWT signed by the registered test key logs in through jwt auth and
// lookup-self gives one entity per sub; with a 10 s token TTL the session token is renewed and still works after 15 s; stop() revokes it;
// a JWT from another key is refused and an address with nothing listening is unreachable. No token reaches the console.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readHostingConfig } from '../../extension/src/node/hosting-config';
import { createOpenBaoClient, type OpenBaoClient } from '../../extension/src/node/openbao-client';
import { createSessionIdentity, type SessionIdentity } from '../../extension/src/node/session-identity';
import { removeOwn } from '../helpers/docker';
import { captureOutput, closedPort } from '../helpers/fake-openbao';
import { startDevOpenBao, TEST_AUDIENCE, type DevOpenBao } from '../helpers/openbao-dev';
import { makeTestSigner } from '../helpers/test-jwt';

const PERSON = 'ada@example.test';
const output = captureOutput();
const secrets: string[] = [];
const running: SessionIdentity[] = [];
let bao: DevOpenBao;

before(async () => {
  bao = await startDevOpenBao({ tokenTtl: '10s', tokenMaxTtl: '1h' });
  secrets.push(bao.rootToken);
});

after(async () => {
  for (const identity of running) await identity.stop();
  await bao?.stop();
  await removeOwn();
  output.stop();
  const text = output.text();
  for (const secret of secrets) assert.ok(!text.includes(secret), 'no JWT, root token or session token reached the console');
});

function jwt(sign: (claims: Record<string, unknown>) => string, sub = 'kc-ada'): string {
  const now = Math.floor(Date.now() / 1000);
  const token = sign({ sub, aud: TEST_AUDIENCE, email: PERSON, iat: now, exp: now + 600 });
  secrets.push(token);
  return token;
}

const headers = (token: string): Record<string, string> => ({ 'x-forwarded-access-token': token, 'x-auth-request-email': PERSON, 'x-auth-request-user': 'kc-ada' });

function identityAt(addr: string, client?: OpenBaoClient): SessionIdentity {
  const config = readHostingConfig({ STERLING_OPENBAO_ADDR: addr, THEIACLOUD_SESSION_USER: PERSON });
  const identity = createSessionIdentity({ config, client: client ?? createOpenBaoClient({ addr, timeoutMs: 2000 }), log: () => undefined });
  running.push(identity);
  return identity;
}

const stateOf = (identity: SessionIdentity): unknown => identity.status();

test('a JWT signed by the registered key logs in, goes active, and one sub has one entity id', async () => {
  const first = identityAt(bao.addr);
  first.observe(headers(jwt(bao.signer.sign)));
  await first.start();
  assert.deepEqual(stateOf(first), { mode: 'hosted', state: 'active' });
  const entityId = first.session()?.entityId;
  assert.match(entityId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  secrets.push(first.session()!.token);

  const second = identityAt(bao.addr);
  second.observe(headers(jwt(bao.signer.sign)));
  await second.start();
  assert.equal(second.session()?.entityId, entityId, 'the same sub is the same entity');
  assert.notEqual(second.session()?.token, first.session()?.token);
  secrets.push(second.session()!.token);
  await first.stop();
  await second.stop();
});

test('with a 10 s token TTL the session token is renewed before it expires and still works after 15 s', async () => {
  const base = createOpenBaoClient({ addr: bao.addr, timeoutMs: 2000 });
  const renewals: number[] = [];
  const started = Date.now();
  const counting: OpenBaoClient = {
    request: (method, path, options) => {
      if (path === 'auth/token/renew-self') renewals.push(Date.now() - started);
      return base.request(method, path, options);
    },
  };
  const identity = identityAt(bao.addr, counting);
  identity.observe(headers(jwt(bao.signer.sign)));
  await identity.start();
  const token = identity.session()!.token;
  secrets.push(token);
  await new Promise((resolve) => setTimeout(resolve, 15_500));
  assert.deepEqual(stateOf(identity), { mode: 'hosted', state: 'active' });
  assert.equal(identity.session()?.token, token, 'renewed, not replaced');
  const looked = await bao.api('GET', 'auth/token/lookup-self', undefined, token);
  assert.equal(looked.status, 200, 'the session token still works after 15 s');
  assert.ok(renewals.length >= 2, `renewed at least twice in 15 s (renewals at ${renewals.join(', ')} ms)`);
  assert.ok(renewals[0] >= 4_000 && renewals[0] <= 6_500, `the first renewal came at about half the 10 s lease (${renewals[0]} ms)`);
  console.info(`renew-self timing with a 10 s lease: ${renewals.map((ms) => `${(ms / 1000).toFixed(1)} s`).join(', ')}`);
  await identity.stop();
});

test('after stop() the token taken from session() is revoked: lookup-self answers 403', async () => {
  const identity = identityAt(bao.addr);
  identity.observe(headers(jwt(bao.signer.sign)));
  await identity.start();
  const token = identity.session()!.token;
  secrets.push(token);
  assert.equal((await bao.api('GET', 'auth/token/lookup-self', undefined, token)).status, 200);
  await identity.stop();
  assert.deepEqual(stateOf(identity), { mode: 'hosted', state: 'stopped' });
  assert.equal(identity.session(), undefined);
  assert.equal((await bao.api('GET', 'auth/token/lookup-self', undefined, token)).status, 403);
});

test('a JWT signed by another key is failed store-refused', async () => {
  const stranger = makeTestSigner();
  const identity = identityAt(bao.addr);
  identity.observe(headers(jwt(stranger.sign)));
  await identity.start();
  assert.deepEqual(stateOf(identity), { mode: 'hosted', state: 'failed', reason: 'store-refused' });
  assert.equal(identity.session(), undefined);
});

test('an address with nothing listening is failed store-unreachable', async () => {
  const identity = identityAt(`http://127.0.0.1:${await closedPort()}`);
  identity.observe(headers(jwt(bao.signer.sign)));
  await identity.start();
  assert.deepEqual(stateOf(identity), { mode: 'hosted', state: 'failed', reason: 'store-unreachable' });
});
