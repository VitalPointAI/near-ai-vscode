// Phase 46, plan 07, task 3 (D-17, D-19 to D-21; FND-T-03, FND-T-04; T-46-25, T-46-26, T-46-28 to T-46-30): the key store and KeyService cores
// against a real dev-mode OpenBao from the pinned openbao-test image, over http to 127.0.0.1 (the loopback rule). Person A's secrets land
// only under kv/.../users/<A>/ with awkward names, survive a new identity and store, and are invisible to person B, whose token gets 403 on
// A's raw path. A signature made after a fresh step-up verifies with ed25519 against A's public key; OpenBao itself refuses to sign with the
// ordinary session token or to log a token without the step-up acr in to the step-up role. Data keys wrap and unwrap to the same 32 bytes.
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { after, before, test } from 'node:test';
import { KEY_SERVICE_TEXT } from '../../extension/src/common/key-service';
import { readHostingConfig } from '../../extension/src/node/hosting-config';
import { createKeyService } from '../../extension/src/node/key-service';
import { createOpenBaoKeyStore, type KeyStore } from '../../extension/src/node/key-stores';
import { encodeSegment } from '../../extension/src/node/kv-path';
import { createOpenBaoClient, OpenBaoError, type OpenBaoClient } from '../../extension/src/node/openbao-client';
import { createSessionIdentity, type SessionIdentity } from '../../extension/src/node/session-identity';
import { removeOwn } from '../helpers/docker';
import { captureOutput } from '../helpers/fake-openbao';
import { startDevOpenBao, TEST_AUDIENCE, TEST_STEPUP_ACR, type DevOpenBao } from '../helpers/openbao-dev';

const output = captureOutput();
const secrets: string[] = [];
const running: SessionIdentity[] = [];
let bao: DevOpenBao;

const PEOPLE = {
  a: { sub: 'kc-ada', email: 'ada@example.test' },
  b: { sub: 'kc-bob', email: 'bob@example.test' },
} as const;
type Person = keyof typeof PEOPLE;

const AWKWARD: Array<[string, string]> = [
  ['127.0.0.1-sterling-test.secret-probe', 'probe'],
  ['theia-ai-mcp-oauth', 'https%3A%2F%2Fmcp.example.test:read%20write:tokens'],
  ['../..', 'a/../b'],
  ['日本語 🔑', ''],
];
const VALUE = 'the-probe-secret-value-91b2';

before(async () => {
  bao = await startDevOpenBao();
  secrets.push(bao.rootToken, VALUE);
});

after(async () => {
  for (const identity of running) await identity.stop();
  await bao?.stop();
  await removeOwn();
  output.stop();
  const text = output.text();
  for (const secret of secrets) assert.ok(!text.includes(secret), 'no JWT, root token, session token or secret value reached the console');
});

function jwt(person: Person, claims: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const token = bao.signer.sign({ sub: PEOPLE[person].sub, aud: TEST_AUDIENCE, email: PEOPLE[person].email, iat: now, exp: now + 600, ...claims });
  secrets.push(token);
  return token;
}

/** A new SessionIdentity for the person, active, with a step-up acr and auth_time when `fresh` (as after a passkey or security key). */
async function signIn(person: Person, fresh = true, authAgeSeconds = 5): Promise<{ identity: SessionIdentity; client: OpenBaoClient; entityId: string; token: string }> {
  const config = readHostingConfig({ STERLING_OPENBAO_ADDR: bao.addr, THEIACLOUD_SESSION_USER: PEOPLE[person].email, STERLING_STEPUP_ACR: TEST_STEPUP_ACR });
  const client = createOpenBaoClient({ addr: bao.addr, timeoutMs: 5000 });
  const identity = createSessionIdentity({ config, client, log: () => undefined });
  running.push(identity);
  const claims = fresh ? { acr: TEST_STEPUP_ACR, auth_time: Math.floor(Date.now() / 1000) - authAgeSeconds } : {};
  identity.observe({ 'x-forwarded-access-token': jwt(person, claims), 'x-auth-request-email': PEOPLE[person].email, 'x-auth-request-user': PEOPLE[person].sub });
  await identity.start();
  const session = identity.session();
  assert.ok(session, `${person} is active`);
  secrets.push(session.token);
  return { identity, client, entityId: session.entityId, token: session.token };
}

const storeOf = (identity: SessionIdentity): KeyStore => createOpenBaoKeyStore(identity, { kvMount: 'kv' });

/** Every secret path under kv/metadata/<prefix>, listed by root. */
async function listAll(prefix: string): Promise<string[]> {
  const answer = await bao.api('GET', `kv/metadata/${prefix}?list=true`);
  if (answer.status === 404) return [];
  const keys = (answer.json as { data: { keys: string[] } }).data.keys;
  const found: string[] = [];
  for (const key of keys) {
    if (key.endsWith('/')) found.push(...await listAll(`${prefix}${key}`));
    else found.push(`${prefix}${key}`);
  }
  return found;
}

let ada: Awaited<ReturnType<typeof signIn>>;

test("the six key store methods round-trip awkward names, and every path root sees is under person A's own users/<A>/", async () => {
  ada = await signIn('a');
  await bao.createPersonKeys(ada.entityId);
  const store = storeOf(ada.identity);
  for (const [service, account] of AWKWARD) await store.setPassword(service, account, `${VALUE}:${account}`);
  for (const [service, account] of AWKWARD) assert.equal(await store.getPassword(service, account), `${VALUE}:${account}`);
  assert.deepEqual(await store.keys(AWKWARD[1][0]), [AWKWARD[1][1]]);
  assert.deepEqual(await store.findCredentials(AWKWARD[2][0]), [{ account: 'a/../b', password: `${VALUE}:a/../b` }]);
  assert.equal(await store.findPassword(AWKWARD[0][0]), `${VALUE}:probe`);
  await store.setPassword('to-delete', 'x', VALUE);
  assert.equal(await store.deletePassword('to-delete', 'x'), true);
  assert.equal(await store.deletePassword('to-delete', 'x'), false);
  assert.equal(await store.getPassword('to-delete', 'x'), undefined);

  const paths = await listAll('');
  assert.equal(paths.length, AWKWARD.length);
  for (const path of paths) assert.ok(path.startsWith(`users/${ada.entityId}/`), `${path} is under users/<A>/`);
  assert.ok(paths.includes(`users/${ada.entityId}/${encodeSegment('../..')}/${encodeSegment('a/../b')}`));
});

test('a new identity and store for person A, as after a restart, read the secret back', async () => {
  const again = await signIn('a');
  assert.equal(again.entityId, ada.entityId, 'the same person is the same entity');
  assert.notEqual(again.token, ada.token);
  assert.equal(await storeOf(again.identity).getPassword(AWKWARD[0][0], AWKWARD[0][1]), `${VALUE}:probe`);
});

test("person B's store does not see A's secret, and B's token reading A's raw KV path answers 403", async () => {
  const bob = await signIn('b');
  assert.notEqual(bob.entityId, ada.entityId);
  const store = storeOf(bob.identity);
  assert.equal(await store.getPassword(AWKWARD[0][0], AWKWARD[0][1]), undefined);
  assert.deepEqual(await store.keys(AWKWARD[0][0]), []);
  const raw = `users/${ada.entityId}/${encodeSegment(AWKWARD[0][0])}/${encodeSegment(AWKWARD[0][1])}`;
  assert.equal((await bao.api('GET', `kv/data/${raw}`, undefined, bob.token)).status, 403);
  assert.equal((await bao.api('GET', `kv/metadata/users/${ada.entityId}/?list=true`, undefined, bob.token)).status, 403);
  await assert.rejects(bob.client.request('GET', `kv/data/${raw}`, { token: bob.token }), (error: OpenBaoError) => error.status === 403);
});

test("after a fresh step-up, sign's signature verifies with ed25519 against A's public key read by root", async () => {
  const message = Buffer.from('Sterling: approve the J5 plan, version 3');
  const result = await createKeyService(ada.identity).sign(message.toString('base64'));
  assert.equal(result.kind, 'ok', JSON.stringify(result));
  const { signature, keyVersion } = (result as { value: { signature: string; keyVersion: number } }).value;
  const key = await bao.api('GET', `transit/keys/person-${ada.entityId}`);
  const raw = Buffer.from((key.json as { data: { keys: Record<string, { public_key: string }> } }).data.keys[String(keyVersion)].public_key, 'base64');
  assert.equal(raw.length, 32);
  const spki = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  assert.equal(verify(null, message, spki, Buffer.from(signature, 'base64')), true);
  assert.equal(verify(null, Buffer.from('something else'), spki, Buffer.from(signature, 'base64')), false);
});

test("the session token reads A's own signing key and its public key matches personPublicKey; B's key, A's KEK and the key list are refused", async () => {
  const bob = await signIn('b');
  const own = await createKeyService(ada.identity).personPublicKey();
  assert.equal(own.kind, 'ok', JSON.stringify(own));
  const byRoot = await bao.api('GET', `transit/keys/person-${ada.entityId}`);
  const latest = (byRoot.json as { data: { latest_version: number; keys: Record<string, { public_key: string }> } }).data;
  assert.deepEqual((own as { value: unknown }).value, { publicKey: Buffer.from(latest.keys[String(latest.latest_version)].public_key, 'base64').toString('base64url'), keyVersion: latest.latest_version });
  assert.equal((await bao.api('GET', `transit/keys/person-${ada.entityId}`, undefined, ada.token)).status, 200);
  assert.equal((await bao.api('GET', `transit/keys/person-${bob.entityId}`, undefined, ada.token)).status, 403);
  assert.equal((await bao.api('GET', `transit/keys/kek-${ada.entityId}`, undefined, ada.token)).status, 403);
  assert.equal((await bao.api('GET', 'transit/keys?list=true', undefined, ada.token)).status, 403);
  assert.equal((await bao.api('POST', `transit/keys/person-${ada.entityId}/rotate`, {}, ada.token)).status, 403);
  assert.equal((await bao.api('GET', `transit/export/public-key/person-${ada.entityId}`, undefined, ada.token)).status, 403);
});

test('OpenBao itself refuses to sign with the ordinary session token, and refuses a token without the step-up acr at the step-up role', async () => {
  const input = Buffer.from('x').toString('base64');
  assert.equal((await bao.api('POST', `transit/sign/person-${ada.entityId}`, { input }, ada.token)).status, 403);
  const login = await bao.api('POST', 'auth/jwt/login', { role: 'sterling-workbench-stepup', jwt: jwt('a', { auth_time: Math.floor(Date.now() / 1000) }) }, '');
  assert.ok(login.status === 400 || login.status === 403, `no step-up token without the step-up acr (status ${login.status})`);
});

test('a stale step-up is refused by the workbench before any OpenBao call', async () => {
  const stale = await signIn('a', true, 3600);
  const calls: string[] = [];
  const session = stale.identity.session()!;
  const counting = { session: () => ({ ...session, client: { request: (method: string, path: string, options?: Parameters<OpenBaoClient['request']>[2]) => { calls.push(path); return session.client.request(method, path, options); } } }), status: () => stale.identity.status() };
  assert.deepEqual(await createKeyService(counting).sign(Buffer.from('x').toString('base64')), { kind: 'refused', reason: KEY_SERVICE_TEXT.stepUpNeeded, fix: KEY_SERVICE_TEXT.confirm });
  assert.deepEqual(calls, []);
  const plain = await signIn('a', false);
  assert.equal((await createKeyService(plain.identity).sign(Buffer.from('x').toString('base64'))).kind, 'refused');
});

test('a wrapped data key unwraps to 32 bytes, the same twice; the ciphertext never holds them', async () => {
  const service = createKeyService(ada.identity);
  const wrapped = await service.generateWrappedDataKey();
  assert.equal(wrapped.kind, 'ok', JSON.stringify(wrapped));
  const { ciphertext } = (wrapped as { value: { ciphertext: string } }).value;
  assert.match(ciphertext, /^vault:v1:/);
  const first = await service.unwrapDataKey(ciphertext);
  const second = await service.unwrapDataKey(ciphertext);
  assert.equal(first.kind, 'ok');
  const bytes = Buffer.from((first as { value: { plaintext: string } }).value.plaintext, 'base64');
  assert.equal(bytes.length, 32);
  assert.deepEqual(second, first);
  assert.ok(!ciphertext.includes(bytes.toString('base64')));
});

test('person B, who has no keys yet, gets the missing-key refusals', async () => {
  const bob = await signIn('b');
  const service = createKeyService(bob.identity);
  assert.deepEqual(await service.sign(Buffer.from('x').toString('base64')), { kind: 'refused', reason: KEY_SERVICE_TEXT.signingKeyMissing });
  assert.deepEqual(await service.generateWrappedDataKey(), { kind: 'refused', reason: KEY_SERVICE_TEXT.dataKeyMissing });
});
