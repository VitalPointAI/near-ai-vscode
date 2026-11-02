// The NEAR AI Cloud organization, invitation and key client, proven against a fake server that
// reproduces the real server's casing, limit and propagation quirks (helpers/fakeNear.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { FetchLike } from '../services/reportingSignIn';
import { checkApiKey, NearAuth, NearOrgClient, NearOrgError, NEAR_SPEND_CURRENCY } from '../team/nearOrg';
import { FakeNear, startFakeNear } from './helpers/fakeNear';

const GIGA = 1_000_000_000;

function staticAuth(token: string, refreshed?: () => string | undefined): NearAuth {
  let current = token;
  return {
    accessToken: async () => current,
    refreshAfterUnauthorized: async () => {
      const next = refreshed?.();
      if (next) current = next;
      return next;
    }
  };
}

interface Fixture { fake: FakeNear; client: NearOrgClient; lead: { accessToken: string; refreshToken: string } }

async function withFake(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fake = await startFakeNear();
  try {
    const lead = fake.addUser({ id: 'user-lead', username: 'lead', email: 'lead@example.invalid' });
    fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-lead', role: 'owner' }] });
    fake.addWorkspace({ id: 'ws-1', organizationId: 'org-1', name: 'Team workspace' });
    const client = new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth(lead.accessToken), sleep: async () => undefined });
    await run({ fake, client, lead });
  } finally {
    await fake.close();
  }
}

test('tracer: a key is created with its cap in the same call, lowered to zero and revoked over real HTTP', async () => {
  await withFake(async ({ fake, client, lead }) => {
    const created = await client.createKey('ws-1', 'team-a-member-1-device-1', 5 * GIGA);
    assert.equal(created.key.spendLimitNanoUsd, 5 * GIGA);
    assert.equal(created.key.workspaceId, 'ws-1');
    assert.equal(created.key.isActive, true);
    assert.ok(Buffer.isBuffer(created.secret));
    assert.match(created.secret.toString('utf8'), /^sk-fake-/);
    assert.equal(fake.key(created.key.id)?.spendLimitNanoUsd, 5 * GIGA, 'the server stored the camelCase limit');
    assert.equal(fake.key(created.key.id)?.secret, created.secret.toString('utf8'));

    assert.equal((await checkApiKey(fake.baseUrl, created.secret)).status, 'valid');
    assert.deepEqual(await checkApiKey(fake.baseUrl, created.secret).then((checked) => checked.status === 'valid' && { org: checked.organizationId, ws: checked.workspaceId, id: checked.apiKeyId }), { org: 'org-1', ws: 'ws-1', id: created.key.id });
    fake.addUsage(created.key.id, 5 * GIGA);
    assert.equal((await checkApiKey(fake.baseUrl, created.secret)).status, 'capped', 'usage at the limit answers 402');

    const lowered = await client.setSpendLimit('ws-1', created.key.id, 0);
    assert.notEqual(lowered, 'missing');
    assert.equal(lowered !== 'missing' && lowered.spendLimitNanoUsd, 0);
    assert.equal(fake.key(created.key.id)?.spendLimitNanoUsd, 0, 'the server stored zero, not null');
    assert.equal((await checkApiKey(fake.baseUrl, created.secret)).status, 'capped', 'a limit of 0 blocks the key');

    assert.equal((await client.findKey('ws-1', created.key.id))?.spendLimitNanoUsd, 0);
    assert.equal(await client.revokeKey('ws-1', created.key.id), 'revoked');
    assert.equal(await client.revokeKey('ws-1', created.key.id), 'missing');
    assert.equal(await client.setSpendLimit('ws-1', created.key.id, GIGA), 'missing');
    assert.equal(fake.key(created.key.id)?.revoked, true);
    assert.equal((await checkApiKey(fake.baseUrl, created.secret)).status, 'invalid');
    assert.equal(await client.findKey('ws-1', created.key.id), undefined);

    const log = fake.requests.map((request) => `${request.method} ${request.path} ${request.auth}`);
    const keyId = created.key.id;
    assert.deepEqual(log.slice(0, 4), [
      'POST /v1/workspaces/ws-1/api-keys session',
      'POST /v1/check_api_key api-key',
      'POST /v1/check_api_key api-key',
      'POST /v1/check_api_key api-key'
    ]);
    assert.ok(log.includes(`PATCH /v1/workspaces/ws-1/api-keys/${keyId}/spend-limit session`));
    assert.ok(log.includes(`DELETE /v1/workspaces/ws-1/api-keys/${keyId} session`));

    const logged = JSON.stringify(fake.requests);
    for (const secret of [lead.accessToken, lead.refreshToken, created.secret.toString('utf8')]) assert.ok(!logged.includes(secret), 'the request log holds no token or key');
  });
});

test('a spend limit is only ever a whole number of nano-USD, checked before any request', async () => {
  await withFake(async ({ fake, client }) => {
    const created = await client.createKey('ws-1', 'name', GIGA);
    const before = fake.requests.length;
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(client.setSpendLimit('ws-1', created.key.id, bad), RangeError, `setSpendLimit(${bad})`);
      await assert.rejects(client.createKey('ws-1', 'other', bad), RangeError, `createKey(${bad})`);
    }
    assert.equal(fake.requests.length, before, 'nothing was sent');
    assert.equal(NEAR_SPEND_CURRENCY, 'USD');
    assert.equal((await client.setSpendLimit('ws-1', created.key.id, Number.MAX_SAFE_INTEGER)) !== 'missing', true, 'the largest safe integer is allowed');
    assert.equal(fake.key(created.key.id)?.spendLimitNanoUsd, Number.MAX_SAFE_INTEGER);
  });
});

test('a response that carries a different limit than the one asked for fails, and a just-created key is revoked', async () => {
  const calls: string[] = [];
  const keyBody = (limit: unknown) => JSON.stringify({ id: 'key-x', key: 'sk-never-logged-0123456789', name: 'n', workspace_id: 'ws-1', created_by_user_id: 'u', is_active: true, spend_limit: limit, usage: null });
  const stub: FetchLike = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    if (init.method === 'POST') return { ok: true, status: 201, json: async () => JSON.parse(keyBody({ amount: 1, scale: 9, currency: 'USD' })), text: async () => keyBody({ amount: 1, scale: 9, currency: 'USD' }) };
    if (init.method === 'PATCH') return { ok: true, status: 200, json: async () => ({}), text: async () => keyBody(null) };
    return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
  };
  const client = new NearOrgClient({ baseUrl: 'https://cloud-api.near.ai/v1', auth: staticAuth('fa-token'), fetch: stub, sleep: async () => undefined });
  await assert.rejects(client.createKey('ws-1', 'n', 5 * GIGA), (error: NearOrgError) => error.code === 'limit-mismatch' && !error.message.includes('sk-never'));
  assert.deepEqual(calls, ['POST /v1/workspaces/ws-1/api-keys', 'DELETE /v1/workspaces/ws-1/api-keys/key-x']);
  await assert.rejects(client.setSpendLimit('ws-1', 'key-x', 5 * GIGA), (error: NearOrgError) => error.code === 'limit-mismatch', 'a null limit in the answer is a mismatch');
});

test('a response limit with another scale is converted with integer arithmetic only', async () => {
  const answer = (limit: unknown) => JSON.stringify({ id: 'key-x', name: 'n', workspace_id: 'ws-1', is_active: true, spend_limit: limit, usage: { amount: 12, scale: 6, currency: 'USD' } });
  const stub: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => answer({ amount: 5_000_000, scale: 6, currency: 'USD' }) });
  const client = new NearOrgClient({ baseUrl: 'https://cloud-api.near.ai/v1', auth: staticAuth('fa-token'), fetch: stub, sleep: async () => undefined });
  const key = await client.setSpendLimit('ws-1', 'key-x', 5 * GIGA);
  assert.notEqual(key, 'missing');
  assert.equal(key !== 'missing' && key.spendLimitNanoUsd, 5 * GIGA, '5,000,000 at scale 6 is 5 USD is 5,000,000,000 nano-USD');
  assert.equal(key !== 'missing' && key.usageNanoUsd, 12_000, 'usage 12 at scale 6 is 12,000 nano-USD');
});

test('listKeys pages until the total is reached', async () => {
  await withFake(async ({ client }) => {
    const names = Array.from({ length: 105 }, (_, index) => `key-${index}`);
    for (const name of names) await client.createKey('ws-1', name, GIGA);
    const listed = await client.listKeys('ws-1');
    assert.equal(listed.length, 105);
    assert.deepEqual(new Set(listed.map((key) => key.name)), new Set(names));
    assert.ok(listed.every((key) => key.usageNanoUsd === 0 && key.spendLimitNanoUsd === GIGA));
  });
});

test('a 401 triggers one refresh and one retry; a second 401 surfaces as unauthorized', async () => {
  await withFake(async ({ fake, lead }) => {
    const refreshed = fake.addUser({ id: 'user-2', username: 'second', email: 'second@example.invalid' });
    fake.addOrganization({ id: 'org-2', name: 'Other', members: [{ userId: 'user-2', role: 'owner' }] });
    fake.addWorkspace({ id: 'ws-2', organizationId: 'org-2', name: 'Other workspace' });
    let refreshes = 0;
    const client = new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth('fa-stale', () => { refreshes += 1; return refreshed.accessToken; }), sleep: async () => undefined });
    assert.deepEqual(await client.listKeys('ws-2'), []);
    assert.equal(refreshes, 1);

    const stubborn = new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth('fa-stale-too', () => 'fa-still-wrong'), sleep: async () => undefined });
    await assert.rejects(stubborn.listKeys('ws-2'), (error: NearOrgError) => error.code === 'unauthorized' && error.status === 401);
    const noRefresh = new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth('fa-stale-three'), sleep: async () => undefined });
    await assert.rejects(noRefresh.listKeys('ws-2'), (error: NearOrgError) => error.code === 'unauthorized');
    assert.ok(!JSON.stringify(fake.requests).includes(lead.accessToken));
  });
});

test('a base URL that is not HTTPS (or loopback HTTP) is refused', () => {
  const auth = staticAuth('fa-token');
  assert.throws(() => new NearOrgClient({ baseUrl: 'http://cloud-api.near.ai/v1', auth }), RangeError);
  assert.throws(() => new NearOrgClient({ baseUrl: 'not a url', auth }), RangeError);
  assert.doesNotThrow(() => new NearOrgClient({ baseUrl: 'https://cloud-api.near.ai/v1/', auth }));
  assert.doesNotThrow(() => new NearOrgClient({ baseUrl: 'http://127.0.0.1:8080/v1', auth }));
});

test('checkApiKey: anything unexpected is unavailable, never valid', async () => {
  const answer = (status: number, body: string): FetchLike => async () => ({ ok: status < 300, status, json: async () => JSON.parse(body), text: async () => body });
  const key = Buffer.from('sk-unit-test-key-0000');
  assert.equal((await checkApiKey('https://cloud-api.near.ai/v1', key, answer(200, '{"valid":true,"organization_id":"o","workspace_id":"w","api_key_id":"k"}'))).status, 'valid');
  assert.equal((await checkApiKey('https://cloud-api.near.ai/v1', key, answer(200, '{"valid":true}'))).status, 'unavailable', 'a 200 without ids is not trusted');
  assert.equal((await checkApiKey('https://cloud-api.near.ai/v1', key, answer(402, '{}'))).status, 'capped');
  assert.equal((await checkApiKey('https://cloud-api.near.ai/v1', key, answer(401, '{}'))).status, 'invalid');
  assert.equal((await checkApiKey('https://cloud-api.near.ai/v1', key, answer(403, '{}'))).status, 'invalid');
  assert.equal((await checkApiKey('https://cloud-api.near.ai/v1', key, answer(500, '{}'))).status, 'unavailable');
  assert.equal((await checkApiKey('https://cloud-api.near.ai/v1', key, async () => { throw new Error('connection reset'); })).status, 'unavailable');
  assert.equal((await checkApiKey('http://cloud-api.near.ai/v1', key, answer(200, '{}'))).status, 'unavailable', 'a plain HTTP address is never sent a key');
});
