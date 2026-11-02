// The lead's kept per-team NEAR session: stored refresh token, in-memory access token, rotation and
// sign out, proven against the fake NEAR server (helpers/fakeNear.ts), which makes refresh tokens single use.
import assert from 'node:assert/strict';
import test from 'node:test';
import { NearOrgClient } from '../team/nearOrg';
import { NEAR_SESSION_SECRET_PREFIX, NearSession, nearSessionSecretName, saveNearSession } from '../team/nearSession';
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
