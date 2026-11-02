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

async function withFake(run: (fixture: Fixture) => Promise<void>, options: Parameters<typeof startFakeNear>[0] = {}): Promise<void> {
  const fake = await startFakeNear(options);
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

// ---- the rest of the surface ----

const clientFor = (fake: FakeNear, tokens: { accessToken: string }, extra: { sleep?: (ms: number) => Promise<void>; maxRetries?: number } = {}) =>
  new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth(tokens.accessToken), sleep: extra.sleep ?? (async () => undefined), ...(extra.maxRetries === undefined ? {} : { maxRetries: extra.maxRetries }) });

const rejectsWith = async (promise: Promise<unknown>, code: string): Promise<NearOrgError> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof NearOrgError, `expected a NearOrgError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected the call to fail with ${code}`);
};

test('organizations, workspaces and members: roles, paging and the email only when the server returns it', async () => {
  await withFake(async ({ fake, client }) => {
    fake.addUser({ id: 'user-dev', username: 'dev', email: 'dev@example.invalid' });
    fake.addOrganization({ id: 'org-2', name: 'Second', members: [{ userId: 'user-lead', role: 'admin' }, { userId: 'user-dev', role: 'owner' }] });
    for (let index = 0; index < 105; index += 1) fake.addWorkspace({ id: `bulk-${index}`, organizationId: 'org-2', name: `Workspace ${index}` });
    assert.deepEqual((await client.listOrganizations()).map((org) => [org.id, org.name, org.role]).sort(), [['org-1', 'Team Org', 'owner'], ['org-2', 'Second', 'admin']]);
    assert.deepEqual(await client.listWorkspaces('org-1'), [{ id: 'ws-1', name: 'Team workspace', organizationId: 'org-1' }]);
    assert.equal((await client.listWorkspaces('org-2')).length, 105, 'paged until the total');
    const members = await client.listMembers('org-2');
    assert.deepEqual(members.map((member) => [member.userId, member.role]).sort(), [['user-dev', 'owner'], ['user-lead', 'admin']]);
    assert.ok(members.every((member) => member.email === undefined), 'the real members route does not return emails');
  });
  await withFake(async ({ client }) => {
    const members = await client.listMembers('org-1');
    assert.deepEqual(members, [{ userId: 'user-lead', role: 'owner', email: 'lead@example.invalid' }]);
  }, { membersIncludeEmail: true });
});

test('inviting by email: the answer is a per-email result, the id is found in the pending list, and a cancel works once', async () => {
  await withFake(async ({ fake, client }) => {
    const outcome = await client.inviteByEmail('org-1', 'Invitee@Example.invalid', 'admin');
    assert.deepEqual(outcome, { ok: true, alreadyMember: false });
    assert.deepEqual(await client.inviteByEmail('org-1', 'invitee@example.invalid', 'member'), { ok: false, reason: 'An invitation is already pending for this email' });

    const pending = await client.listInvitations('org-1', 'pending');
    const found = pending.find((invitation) => invitation.email.toLowerCase() === 'invitee@example.invalid');
    assert.ok(found, 'found by case-insensitive email');
    assert.equal(found.role, 'admin');
    assert.equal(found.status, 'pending');
    assert.equal(found.organizationId, 'org-1');
    assert.deepEqual(await client.listInvitations('org-1', 'accepted'), []);

    assert.equal(await client.cancelInvitation('org-1', found.id), 'cancelled');
    assert.equal(await client.cancelInvitation('org-1', found.id), 'not-pending', 'a second cancel');
    assert.deepEqual(await client.listInvitations('org-1', 'pending'), []);

    // The invite route answers 200 even when the email failed, and its answer never carries an id.
    const invite = fake.requests.filter((request) => request.path.endsWith('/invite-by-email'));
    assert.deepEqual(invite.map((request) => request.status), [200, 200]);
  });
});

test('a member-role caller cannot invite, list, cancel or remove; owner invitations cannot be asked for', async () => {
  await withFake(async ({ fake, client }) => {
    const plain = fake.addUser({ id: 'user-plain', username: 'plain', email: 'plain@example.invalid' });
    fake.addOrganization({ id: 'org-3', name: 'Third', members: [{ userId: 'user-lead', role: 'owner' }, { userId: 'user-plain', role: 'member' }] });
    const asMember = clientFor(fake, plain);
    await rejectsWith(asMember.inviteByEmail('org-3', 'someone@example.invalid', 'member'), 'forbidden');
    await rejectsWith(asMember.listInvitations('org-3'), 'forbidden');
    await rejectsWith(asMember.cancelInvitation('org-3', 'inv-1'), 'forbidden');
    await rejectsWith(asMember.removeMember('org-3', 'user-lead'), 'forbidden');
    await rejectsWith(asMember.listMembers('org-9'), 'not-found');
    assert.equal((await asMember.listMembers('org-3')).length, 2, 'a member can read the member list');
    // The role argument is 'admin' | 'member'; an owner invitation does not compile (and NEAR refuses it).
    const impossible = () => client.inviteByEmail('org-3', 'x@example.invalid',
      // @ts-expect-error owner is not an invitable role
      'owner');
    assert.equal(typeof impossible, 'function');
  });
});

test('an invitation is seen and accepted only by the matching login email, by id or by the emailed token', async () => {
  await withFake(async ({ fake, client }) => {
    const invitee = fake.addUser({ id: 'user-inv', username: 'inv', email: 'Invitee@example.invalid' });
    const other = fake.addUser({ id: 'user-other', username: 'other', email: 'other@example.invalid' });
    const third = fake.addUser({ id: 'user-third', username: 'third', email: 'third@example.invalid' });
    assert.deepEqual(await client.inviteByEmail('org-1', 'invitee@example.invalid', 'admin'), { ok: true, alreadyMember: false });
    assert.deepEqual(await client.inviteByEmail('org-1', 'third@example.invalid', 'admin'), { ok: true, alreadyMember: false });

    const asInvitee = clientFor(fake, invitee);
    const mine = await asInvitee.myInvitations();
    assert.equal(mine.length, 1);
    assert.equal(mine[0].organizationId, 'org-1');
    assert.equal(mine[0].organizationName, 'Team Org');
    assert.deepEqual(await clientFor(fake, other).myInvitations(), [], 'another login email sees nothing');
    await rejectsWith(clientFor(fake, other).acceptInvitation(mine[0].id), 'not-found');

    assert.equal(await asInvitee.acceptInvitation(mine[0].id), 'accepted');
    assert.equal(await asInvitee.acceptInvitation(mine[0].id), 'already-member', '409 is already a member');
    assert.deepEqual((await client.listMembers('org-1')).map((member) => [member.userId, member.role]).sort(), [['user-inv', 'admin'], ['user-lead', 'owner']]);
    assert.deepEqual(await client.inviteByEmail('org-1', 'invitee@example.invalid', 'member'), { ok: true, alreadyMember: true }, '"already a member" is not a failure');

    const token = fake.emailedToken('third@example.invalid');
    assert.ok(token);
    const asThird = clientFor(fake, third);
    await rejectsWith(clientFor(fake, other).acceptInvitationToken(token), 'forbidden');
    assert.equal(await asThird.acceptInvitationToken(token), 'accepted');
    assert.equal(await asThird.acceptInvitationToken(token), 'already-member');
    const failure = await rejectsWith(asThird.acceptInvitationToken('not-a-real-token-1234567890'), 'not-found');
    assert.ok(!failure.message.includes('not-a-real-token'), 'the emailed token is never echoed');
    const logged = fake.requests.map((request) => request.path).join('\n');
    assert.ok(logged.includes('/v1/invitations/:token/accept'));
    assert.ok(!logged.includes(token), 'the fake log keeps no emailed token');
  });
});

test('removing a member: removed, then missing; the last owner and a non-manager are refused', async () => {
  await withFake(async ({ fake, client }) => {
    fake.addUser({ id: 'user-dev', username: 'dev', email: 'dev@example.invalid' });
    const admin = fake.addUser({ id: 'user-admin', username: 'admin', email: 'admin@example.invalid' });
    fake.addOrganization({ id: 'org-4', name: 'Fourth', members: [{ userId: 'user-lead', role: 'owner' }, { userId: 'user-dev', role: 'member' }, { userId: 'user-admin', role: 'admin' }] });
    assert.equal(await client.removeMember('org-4', 'user-dev'), 'removed');
    assert.equal(await client.removeMember('org-4', 'user-dev'), 'missing');
    await rejectsWith(client.removeMember('org-4', 'user-lead'), 'bad-request');
    await rejectsWith(clientFor(fake, admin).removeMember('org-4', 'user-lead'), 'forbidden');
    assert.deepEqual((await client.listMembers('org-4')).map((member) => member.userId).sort(), ['user-admin', 'user-lead']);
  });
});

test('key usage history gives whole nano-USD entries, pages, and a 404 means the route is not offered', async () => {
  await withFake(async ({ fake, client }) => {
    const created = await client.createKey('ws-1', 'usage-key', 10 * GIGA);
    fake.addUsage(created.key.id, 1_500_000);
    fake.addUsage(created.key.id, 250);
    const all = await client.keyUsageHistory('ws-1', created.key.id);
    assert.notEqual(all, 'not-offered');
    if (all === 'not-offered') return;
    assert.equal(all.total, 2);
    assert.deepEqual(all.entries.map((entry) => entry.totalCostNanoUsd), [250, 1_500_000], 'newest first, whole numbers');
    assert.ok(all.entries.every((entry) => entry.model === 'fake-model' && entry.id.length > 0 && !Number.isNaN(Date.parse(entry.createdAt))));
    const second = await client.keyUsageHistory('ws-1', created.key.id, { limit: 1, offset: 1 });
    assert.ok(second !== 'not-offered' && second.entries.length === 1 && second.total === 2 && second.entries[0].totalCostNanoUsd === 1_500_000);
    assert.equal((await client.findKey('ws-1', created.key.id))?.usageNanoUsd, 1_500_250);

    fake.fail({ method: 'GET', pathPrefix: `/v1/workspaces/ws-1/api-keys/${created.key.id}/usage`, status: 404, times: 1 });
    assert.equal(await client.keyUsageHistory('ws-1', created.key.id), 'not-offered');
  });
});

test('the current user: id, username, email and organization ids', async () => {
  await withFake(async ({ fake, client }) => {
    fake.addOrganization({ id: 'org-5', name: 'Fifth', members: [{ userId: 'user-lead', role: 'member' }] });
    const me = await client.currentUser();
    assert.equal(me.id, 'user-lead');
    assert.equal(me.username, 'lead');
    assert.equal(me.email, 'lead@example.invalid');
    assert.deepEqual([...me.organizationIds].sort(), ['org-1', 'org-5']);
  });
});

test('the real traps: a snake_case or missing limit stores none, and no client method can send one', async () => {
  await withFake(async ({ fake, client, lead }) => {
    const created = await client.createKey('ws-1', 'trap-key', 3 * GIGA);
    const raw = (method: string, path: string, body: unknown) => fetch(`${fake.baseUrl}${path}`, { method, headers: { authorization: `Bearer ${lead.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const limitPath = `/workspaces/ws-1/api-keys/${created.key.id}/spend-limit`;

    assert.equal((await raw('PATCH', limitPath, { spend_limit: { amount: 7 * GIGA, currency: 'USD' } })).status, 200, 'the real server answers 200');
    assert.equal(fake.key(created.key.id)?.spendLimitNanoUsd, null, 'snake_case stored no limit');
    await client.setSpendLimit('ws-1', created.key.id, 3 * GIGA);
    assert.equal(fake.key(created.key.id)?.spendLimitNanoUsd, 3 * GIGA);
    assert.equal((await raw('PATCH', limitPath, {})).status, 200);
    assert.equal(fake.key(created.key.id)?.spendLimitNanoUsd, null, 'a missing field stored no limit');
    assert.equal((await raw('PATCH', limitPath, { spendLimit: { amount: 4 * GIGA, currency: 'USD' } })).status, 200);
    assert.equal(fake.key(created.key.id)?.spendLimitNanoUsd, 4 * GIGA, 'camelCase works');

    const noLimit = await (await raw('POST', '/workspaces/ws-1/api-keys', { name: 'raw-no-limit' })).json() as { id: string };
    assert.equal(fake.key(noLimit.id)?.spendLimitNanoUsd, null, 'a create without spendLimit stores none');

    // Whatever the client sends, the server ends up with the limit that was asked for.
    for (const amount of [0, 1, 999_999_999_999]) {
      await client.setSpendLimit('ws-1', created.key.id, amount);
      assert.equal(fake.key(created.key.id)?.spendLimitNanoUsd, amount);
    }
    for (const amount of [0, 42]) {
      const made = await client.createKey('ws-1', `made-${amount}`, amount);
      assert.equal(fake.key(made.key.id)?.spendLimitNanoUsd, amount);
    }
  });
});

test('a limit round trip through the client and checkApiKey agree: zero blocks, a raised limit unblocks', async () => {
  await withFake(async ({ fake, client }) => {
    const created = await client.createKey('ws-1', 'cap-key', 0);
    assert.equal((await checkApiKey(fake.baseUrl, created.secret)).status, 'capped', 'a key created at 0 is blocked from the start');
    await client.setSpendLimit('ws-1', created.key.id, 2 * GIGA);
    assert.equal((await checkApiKey(fake.baseUrl, created.secret)).status, 'valid');
    fake.addUsage(created.key.id, 2 * GIGA);
    assert.equal((await checkApiKey(fake.baseUrl, created.secret)).status, 'capped');
  });
});

test('a new key is invalid until it has activated, then valid', async () => {
  await withFake(async ({ fake, client }) => {
    fake.setActivationDelayMs(500);
    const created = await client.createKey('ws-1', 'slow-key', GIGA);
    const first = await checkApiKey(fake.baseUrl, created.secret);
    assert.equal(first.status, 'invalid');
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal((await checkApiKey(fake.baseUrl, created.secret)).status, 'valid');
  });
});

test('GET, DELETE and the spend-limit PATCH retry; a 429 waits for Retry-After', async () => {
  await withFake(async ({ fake, lead }) => {
    const sleeps: number[] = [];
    const client = clientFor(fake, lead, { sleep: async (ms) => { sleeps.push(ms); } });
    fake.fail({ method: 'GET', pathPrefix: '/v1/organizations', status: 429, times: 1, retryAfterSeconds: 1 });
    assert.equal((await client.listOrganizations()).length, 1);
    assert.deepEqual(sleeps, [1000], 'Retry-After 1 is a one second wait');

    sleeps.length = 0;
    fake.fail({ method: 'GET', pathPrefix: '/v1/organizations', status: 500, times: 3 });
    assert.equal((await client.listOrganizations()).length, 1, 'three 500s then success');
    assert.deepEqual(sleeps, [250, 500, 1000], 'backoff doubles');

    fake.fail({ method: 'GET', pathPrefix: '/v1/organizations', status: 'drop', times: 2 });
    assert.equal((await client.listOrganizations()).length, 1, 'a dropped connection is retried');

    const created = await client.createKey('ws-1', 'retry-key', GIGA);
    fake.fail({ method: 'PATCH', pathPrefix: '/v1/workspaces/ws-1/api-keys', status: 502, times: 2 });
    const lowered = await client.setSpendLimit('ws-1', created.key.id, 0);
    assert.equal(lowered !== 'missing' && lowered.spendLimitNanoUsd, 0, 'the spend-limit PATCH retries');
    fake.fail({ method: 'DELETE', pathPrefix: '/v1/workspaces/ws-1/api-keys', status: 503, times: 1 });
    assert.equal(await client.revokeKey('ws-1', created.key.id), 'revoked');
  });
});

test('four 500s in a row fail with code server; maxRetries 0 never retries', async () => {
  await withFake(async ({ fake, lead }) => {
    const client = clientFor(fake, lead);
    fake.fail({ method: 'GET', pathPrefix: '/v1/organizations', status: 500, times: 4 });
    const error = await rejectsWith(client.listOrganizations(), 'server');
    assert.equal(error.status, 500);
    assert.equal(fake.requests.filter((request) => request.path === '/v1/organizations').length, 4, 'one try and three retries');

    const strict = clientFor(fake, lead, { maxRetries: 0 });
    fake.fail({ method: 'GET', pathPrefix: '/v1/organizations', status: 500, times: 1 });
    const before = fake.requests.length;
    await rejectsWith(strict.listOrganizations(), 'server');
    assert.equal(fake.requests.length - before, 1);
    fake.fail({ method: 'GET', pathPrefix: '/v1/organizations', status: 429, times: 1 });
    await rejectsWith(strict.listOrganizations(), 'rate-limited');
  });
});

test('a POST is never retried blindly: invite and create-key each go out once', async () => {
  await withFake(async ({ fake, client }) => {
    fake.fail({ method: 'POST', pathPrefix: '/v1/organizations/org-1/members/invite-by-email', status: 500, times: 1 });
    await rejectsWith(client.inviteByEmail('org-1', 'a@example.invalid', 'member'), 'server');
    assert.equal(fake.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/invite-by-email')).length, 1);

    fake.fail({ method: 'POST', pathPrefix: '/v1/workspaces/ws-1/api-keys', status: 500, times: 1 });
    const error = await rejectsWith(client.createKey('ws-1', 'once-key', GIGA), 'server');
    assert.match(error.message, /No key with that name was found/);
    assert.equal(fake.requests.filter((request) => request.method === 'POST' && request.path === '/v1/workspaces/ws-1/api-keys').length, 1, 'no second POST');
    fake.fail({ method: 'POST', pathPrefix: '/v1/organizations/org-1/members/invite-by-email', status: 429, times: 1, retryAfterSeconds: 1 });
    await rejectsWith(client.inviteByEmail('org-1', 'a@example.invalid', 'member'), 'rate-limited');
  });
});

test('a create-key whose answer is lost lists keys by its name and revokes the match', async () => {
  await withFake(async ({ fake, client }) => {
    await client.createKey('ws-1', 'bystander', GIGA);
    fake.fail({ method: 'POST', pathPrefix: '/v1/workspaces/ws-1/api-keys', status: 'drop', times: 1, afterEffect: true });
    const start = fake.requests.length;
    const error = await rejectsWith(client.createKey('ws-1', 'lost-answer', 2 * GIGA), 'network');
    assert.match(error.message, /Revoked 1 key/);
    assert.deepEqual(fake.requests.slice(start).map((request) => request.method), ['POST', 'GET', 'DELETE'], 'POST, list by name, revoke');
    const left = await client.listKeys('ws-1');
    assert.deepEqual(left.map((key) => key.name), ['bystander'], 'only the unrelated key is left');

    fake.fail({ method: 'POST', pathPrefix: '/v1/workspaces/ws-1/api-keys', status: 500, times: 1, afterEffect: true });
    await rejectsWith(client.createKey('ws-1', 'lost-500', GIGA), 'server');
    assert.deepEqual((await client.listKeys('ws-1')).map((key) => key.name), ['bystander'], 'a 500 that made the key is cleaned up too');
  });
});

test('no error, message or request log ever holds a bearer token, a refresh token or a key secret', async () => {
  await withFake(async ({ fake, client, lead }) => {
    const created = await client.createKey('ws-1', 'redact-key', GIGA);
    const secret = created.secret.toString('utf8');
    const seen: unknown[] = [];
    const attempt = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { seen.push(error); } };

    const hostile = `Bearer ${lead.accessToken} refresh ${lead.refreshToken} key ${secret} api_key=${secret} \u0007\u001b[31m ${'x'.repeat(2000)}`;
    for (const status of [400, 403, 404, 409, 422, 500]) {
      fake.fail({ method: 'GET', pathPrefix: '/v1/organizations', status, times: 4, message: hostile });
      await attempt(client.listOrganizations());
    }
    fake.fail({ method: 'POST', pathPrefix: '/v1/workspaces/ws-1/api-keys', status: 400, times: 1, message: hostile });
    await attempt(client.createKey('ws-1', 'redact-key-2', GIGA));
    fake.fail({ method: 'PATCH', pathPrefix: '/v1/workspaces/ws-1/api-keys', status: 400, times: 1, message: hostile });
    await attempt(client.setSpendLimit('ws-1', created.key.id, 1));
    await attempt(client.acceptInvitationToken(lead.refreshToken));
    await attempt(clientFor(fake, { accessToken: 'fa-not-a-real-token-at-all' }).listOrganizations());

    assert.ok(seen.length >= 9, 'the failures happened');
    for (const error of seen) {
      assert.ok(error instanceof NearOrgError);
      const everything = [error.message, error.stack ?? '', JSON.stringify(error), String(error), JSON.stringify({ ...error })].join('\n');
      for (const forbidden of [lead.accessToken, lead.refreshToken, secret]) assert.ok(!everything.includes(forbidden), 'no credential in an error');
      assert.ok(!/\bsk-[A-Za-z0-9_-]{6,}/.test(everything) && !/\brt_[A-Za-z0-9_-]{6,}/.test(everything));
      assert.ok(error.message.length <= 400, 'bounded');
      // eslint-disable-next-line no-control-regex
      assert.ok(!/[\u0000-\u001f]/.test(error.message), 'no control characters');
    }
    const logged = JSON.stringify(fake.requests);
    for (const forbidden of [lead.accessToken, lead.refreshToken, secret]) assert.ok(!logged.includes(forbidden));
  });
});

test('the fake rotates refresh tokens and logout ends only the current session', async () => {
  await withFake(async ({ fake, lead }) => {
    const call = (path: string, bearer: string) => fetch(`${fake.baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` } });
    const refreshed = await call('/users/me/access-tokens', lead.refreshToken);
    assert.equal(refreshed.status, 200);
    const next = await refreshed.json() as { access_token: string; refresh_token: string; refresh_token_expiration: string };
    assert.notEqual(next.refresh_token, lead.refreshToken);
    assert.equal((await call('/users/me/access-tokens', lead.refreshToken)).status, 401, 'the old refresh token is dead');
    assert.equal((await fetch(`${fake.baseUrl}/users/me`, { headers: { authorization: `Bearer ${lead.accessToken}` } })).status, 401, 'the old access token stopped working');
    assert.equal((await fetch(`${fake.baseUrl}/users/me`, { headers: { authorization: `Bearer ${next.access_token}` } })).status, 200);
    assert.equal((await call('/auth/logout', next.refresh_token)).status, 200);
    assert.equal((await call('/auth/logout', next.refresh_token)).status, 200, 'logout is idempotent');
    assert.equal((await fetch(`${fake.baseUrl}/users/me`, { headers: { authorization: `Bearer ${next.access_token}` } })).status, 401);
    assert.ok(fake.requests.every((request) => !request.path.includes('/users/me/tokens')));
    assert.ok(fake.requests.some((request) => request.path === '/v1/users/me/access-tokens' && request.auth === 'refresh'));
  });
});

test('answers that miss a required field are bad-response, not guesses', async () => {
  const answering = (body: unknown, status = 200): FetchLike => async () => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const make = (body: unknown, status?: number) => new NearOrgClient({ baseUrl: 'https://cloud-api.near.ai/v1', auth: staticAuth('fa-token'), fetch: answering(body, status), sleep: async () => undefined });
  await rejectsWith(make({ organizations: [{ id: 'o', name: 'n' }], total: 1 }).listOrganizations(), 'bad-response');
  await rejectsWith(make({ organizations: [{ id: 'o', name: 'n', role: 'emperor' }], total: 1 }).listOrganizations(), 'bad-response');
  await rejectsWith(make({ workspaces: 'nope', total: 1 }).listWorkspaces('o'), 'bad-response');
  await rejectsWith(make({ members: [{ role: 'member', user: {} }], total: 1 }).listMembers('o'), 'bad-response');
  await rejectsWith(make({ results: [] }).inviteByEmail('o', 'a@example.invalid', 'member'), 'bad-response');
  await rejectsWith(make([{ id: 'i' }]).listInvitations('o'), 'bad-response');
  await rejectsWith(make({ data: [{ id: 'u', model: 'm', total_cost: 1.5, created_at: 'x' }], total: 1 }).keyUsageHistory('w', 'k'), 'bad-response');
  await rejectsWith(make({ id: 'u', email: 'x@example.invalid' }).currentUser(), 'bad-response');
  await rejectsWith(make({ api_keys: [{ id: 'k', workspace_id: 'w', is_active: true, spend_limit: { amount: 1.5, scale: 9, currency: 'USD' } }], total: 1 }).listKeys('w'), 'bad-response');
  await rejectsWith(make({ api_keys: [{ id: 'k', workspace_id: 'w', is_active: true, spend_limit: { amount: 1, scale: 9, currency: 'EUR' } }], total: 1 }).listKeys('w'), 'bad-response');
});

test('invite-by-email maps NEAR\'s per-email messages to plain outcomes', async () => {
  const result = (error: string | null) => ({ results: [{ email: 'a@example.invalid', success: error === null, email_sent: error === null, error, email_error: null, member: null }], total: 1, successful: error === null ? 1 : 0, failed: error === null ? 0 : 1 });
  const make = (body: unknown) => new NearOrgClient({ baseUrl: 'https://cloud-api.near.ai/v1', auth: staticAuth('fa-token'), fetch: async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }), sleep: async () => undefined });
  assert.deepEqual(await make(result(null)).inviteByEmail('o', 'a@example.invalid', 'member'), { ok: true, alreadyMember: false });
  assert.deepEqual(await make(result('User is already a member of this organization')).inviteByEmail('o', 'a@example.invalid', 'member'), { ok: true, alreadyMember: true });
  const denied = await make(result('Insufficient permissions to invite as admin')).inviteByEmail('o', 'a@example.invalid', 'admin');
  assert.equal(denied.ok, false);
  assert.match(denied.ok ? '' : denied.reason, /cannot invite/);
  const other = await make(result(`Something odd sk-${'a'.repeat(24)}`)).inviteByEmail('o', 'a@example.invalid', 'member');
  assert.equal(other.ok, false);
  assert.ok(!(other.ok ? '' : other.reason).includes('aaaaaaaaaaaa'), 'NEAR text is redacted');
});
