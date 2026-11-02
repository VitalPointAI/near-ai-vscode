// The lead's kept per-team NEAR session: stored refresh token, in-memory access token, rotation and
// sign out, proven against the fake NEAR server (helpers/fakeNear.ts), which makes refresh tokens single use.
import assert from 'node:assert/strict';
import test from 'node:test';
import { NearOrgClient } from '../team/nearOrg';
import { NEAR_SESSION_SECRET_PREFIX, NearSession, NearSessionError, nearSessionSecretName, saveNearSession } from '../team/nearSession';
import { FakeNear, startFakeNear } from './helpers/fakeNear';
import { MemorySecrets } from './helpers/teamHarness';

const MINUTE = 60_000;

interface Fixture { fake: FakeNear; secrets: MemorySecrets; lead: { accessToken: string; refreshToken: string } }

async function withFake(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fake = await startFakeNear();
  try {
    const lead = fake.addUser({ id: 'user-lead', username: 'lead', email: 'lead@example.invalid' });
    fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-lead', role: 'owner' }] });
    await run({ fake, secrets: new MemorySecrets(), lead });
  } finally {
    await fake.close();
  }
}

test('tracer: a session is kept per team, refreshed through rotation and signed out', async () => {
  await withFake(async ({ fake, secrets, lead }) => {
    let clock = 1_000_000;
    const session = await saveNearSession(secrets, 'team-a', lead, 'lead on github', { baseUrl: fake.baseUrl, now: () => clock });

    // The stored value is only {v, refreshToken, label}; the access token is memory only.
    const stored = JSON.parse(secrets.values.get(`${NEAR_SESSION_SECRET_PREFIX}team-a`) ?? 'null') as Record<string, unknown>;
    assert.deepEqual(stored, { v: 1, refreshToken: lead.refreshToken, label: 'lead on github' });
    assert.equal(nearSessionSecretName('team-a'), 'nearAi.team.nearSession.team-a');
    assert.ok(!JSON.stringify([...secrets.values.values()]).includes(lead.accessToken), 'the access token is never stored');

    // Fresh: no network call.
    assert.equal(await session.accessToken(), lead.accessToken);
    assert.equal(fake.requests.length, 0);

    // 51 minutes later: one refresh, the new refresh token is stored, and the old one is dead.
    clock += 51 * MINUTE;
    const refreshed = await session.accessToken();
    assert.notEqual(refreshed, lead.accessToken);
    const rotated = JSON.parse(secrets.values.get(nearSessionSecretName('team-a')) ?? 'null') as { refreshToken: string };
    assert.notEqual(rotated.refreshToken, lead.refreshToken);
    assert.match(rotated.refreshToken, /^rt_/);
    assert.deepEqual(fake.requests.map((request) => `${request.method} ${request.path} ${request.status}`), ['POST /v1/users/me/access-tokens 200']);

    // The client refreshes through the session when NEAR rejects the access token once.
    const client = new NearOrgClient({ baseUrl: fake.baseUrl, auth: session, sleep: async () => undefined });
    fake.fail({ method: 'GET', pathPrefix: '/v1/organizations', status: 401, times: 1 });
    const organizations = await client.listOrganizations();
    assert.deepEqual(organizations.map((org) => org.id), ['org-1']);
    assert.equal(fake.requests.filter((request) => request.path === '/v1/users/me/access-tokens').length, 2);

    // A second team's session is untouched by signing out of the first.
    const other = fake.addUser({ id: 'user-other', username: 'other', email: 'other@example.invalid' });
    await saveNearSession(secrets, 'team-b', other, 'other', { baseUrl: fake.baseUrl, now: () => clock });
    assert.deepEqual(await session.signOut(), { serverConfirmed: true });
    assert.equal(await session.signedIn(), undefined);
    assert.equal(secrets.values.has(nearSessionSecretName('team-a')), false);
    assert.equal(secrets.values.has(nearSessionSecretName('team-b')), true);
    assert.ok(fake.requests.some((request) => request.method === 'POST' && request.path === '/v1/auth/logout'));
    assert.ok(!fake.requests.some((request) => request.method === 'DELETE' && request.path === '/v1/users/me/tokens'));
  });
});

const never = async (): Promise<void> => undefined;
const shortWait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, Math.min(ms, 20)); });

function storedRefresh(secrets: MemorySecrets, teamId: string): string {
  return (JSON.parse(secrets.values.get(nearSessionSecretName(teamId)) ?? 'null') as { refreshToken: string }).refreshToken;
}

test('callers in one window share a single refresh', async () => {
  await withFake(async ({ fake, secrets, lead }) => {
    let clock = 0;
    const session = await saveNearSession(secrets, 'team-a', lead, 'lead', { baseUrl: fake.baseUrl, now: () => clock });
    clock += 55 * MINUTE;
    const tokens = await Promise.all([session.accessToken(), session.accessToken(), session.accessToken()]);
    assert.equal(new Set(tokens).size, 1);
    assert.equal(fake.requests.filter((request) => request.path === '/v1/users/me/access-tokens').length, 1);
  });
});

test('two windows refreshing at the same moment both end with a working session and the newest refresh token is kept', async () => {
  await withFake(async ({ fake, secrets, lead }) => {
    let clock = 0;
    const options = { baseUrl: fake.baseUrl, now: () => clock, sleep: shortWait };
    const windowA = await saveNearSession(secrets, 'team-a', lead, 'lead', options);
    const windowB = new NearSession({ teamId: 'team-a', secrets, ...options, initialAccessToken: lead.accessToken });
    clock += 55 * MINUTE;

    const [tokenA, tokenB] = await Promise.all([windowA.accessToken(), windowB.accessToken()]);
    assert.ok(tokenA && tokenB);

    // Each window can still use NEAR: a token the other window's rotation replaced is refreshed on the 401.
    for (const window of [windowA, windowB]) {
      const client = new NearOrgClient({ baseUrl: fake.baseUrl, auth: window, sleep: never });
      assert.deepEqual((await client.listOrganizations()).map((org) => org.id), ['org-1']);
    }

    // The stored refresh token is the newest one the fake issued: a third window opens from it.
    const before = fake.requests.length;
    const third = new NearSession({ teamId: 'team-a', secrets, ...options });
    assert.ok(await third.accessToken());
    const refreshes = fake.requests.slice(before).filter((request) => request.path === '/v1/users/me/access-tokens');
    assert.deepEqual(refreshes.map((request) => request.status), [200]);
    assert.notEqual(storedRefresh(secrets, 'team-a'), lead.refreshToken);
  });
});

test('a refresh token NEAR refuses, with no other window having rotated it, says the sign-in expired and keeps the stored value', async () => {
  await withFake(async ({ fake, secrets }) => {
    let clock = 0;
    const dead = { accessToken: 'fa-stale', refreshToken: 'rt_deadbeefdeadbeef' };
    const session = await saveNearSession(secrets, 'team-a', dead, 'lead', { baseUrl: fake.baseUrl, now: () => clock, sleep: never });
    clock += 55 * MINUTE;
    await assert.rejects(session.accessToken(), (error: unknown) => {
      assert.ok(error instanceof NearSessionError);
      assert.equal(error.code, 'expired');
      assert.equal(error.message, 'Your NEAR sign-in for this team expired. Sign in again.');
      assert.ok(!`${error.message}${error.stack}`.includes('rt_deadbeefdeadbeef'));
      return true;
    });
    assert.equal(storedRefresh(secrets, 'team-a'), 'rt_deadbeefdeadbeef', 'nothing is deleted on an expired refresh');
    assert.equal(await session.refreshAfterUnauthorized(), undefined);
    assert.deepEqual(await session.signedIn(), { label: 'lead' });
  });
});

test('a NEAR outage while refreshing is unavailable, not expired, and the session is kept', async () => {
  await withFake(async ({ fake, secrets, lead }) => {
    let clock = 0;
    const session = await saveNearSession(secrets, 'team-a', lead, 'lead', { baseUrl: fake.baseUrl, now: () => clock, sleep: never });
    clock += 55 * MINUTE;
    fake.fail({ method: 'POST', pathPrefix: '/v1/users/me/access-tokens', status: 500, times: 1, message: `boom ${lead.refreshToken}` });
    await assert.rejects(session.accessToken(), (error: unknown) => {
      assert.ok(error instanceof NearSessionError);
      assert.equal(error.code, 'unavailable');
      assert.ok(!`${error.message}${error.stack}`.includes(lead.refreshToken));
      return true;
    });
    assert.equal(storedRefresh(secrets, 'team-a'), lead.refreshToken);
    assert.ok(await session.accessToken(), 'the next try works');
  });
});

test('a damaged or foreign stored value is treated as signed out and deleted', async () => {
  await withFake(async ({ fake, secrets }) => {
    const session = new NearSession({ teamId: 'team-a', secrets, baseUrl: fake.baseUrl, sleep: never });
    for (const bad of ['not json', '{"v":2,"refreshToken":"rt_x1234567","label":"a"}', '{"v":1,"refreshToken":"abc","label":"a"}', `{"v":1,"refreshToken":"rt_x1234567","label":"${'a'.repeat(81)}"}`, '[]']) {
      secrets.values.set(nearSessionSecretName('team-a'), bad);
      assert.equal(await session.signedIn(), undefined, bad);
      assert.equal(secrets.values.has(nearSessionSecretName('team-a')), false, 'the bad value is deleted');
    }
    await assert.rejects(session.accessToken(), (error: unknown) => error instanceof NearSessionError && error.code === 'signed-out');
    assert.equal(fake.requests.length, 0);
  });
});

test('sign out forgets the session even when NEAR cannot be reached', async () => {
  await withFake(async ({ fake, secrets, lead }) => {
    const session = await saveNearSession(secrets, 'team-a', lead, 'lead', { baseUrl: fake.baseUrl, sleep: never });
    fake.fail({ method: 'POST', pathPrefix: '/v1/auth/logout', status: 'drop', times: 1 });
    assert.deepEqual(await session.signOut(), { serverConfirmed: false });
    assert.equal(secrets.values.has(nearSessionSecretName('team-a')), false);
    assert.deepEqual(await session.signOut(), { serverConfirmed: true }, 'nothing left to end');
    await assert.rejects(session.accessToken(), (error: unknown) => error instanceof NearSessionError && error.code === 'signed-out');
  });
});

test('a session refuses a plain-HTTP address that is not this computer', () => {
  assert.throws(() => new NearSession({ teamId: 'team-a', secrets: new MemorySecrets(), baseUrl: 'http://near.example.invalid/v1' }), RangeError);
});
