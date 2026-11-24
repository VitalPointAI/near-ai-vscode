import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServiceClient, createSessionDriver, ServiceError } from '../src/service.ts';
import { mintToken, parseUsersFile, TokenStore } from '../src/keycloak.ts';
import { loadRefusals, lockedOperatorDigest, main, type CliDeps } from '../src/cli.ts';
import { verifyRunFile } from '../src/runfile.ts';
import type { Kubectl } from '../src/measure.ts';
import { fakeClock } from './fixtures/fakes.ts';

interface Call { readonly method: string; readonly path: string; readonly auth: string | null; readonly body: string }
const DIGEST = (fill: string): string => `sha256:${fill.repeat(64)}`;

/** A fetch that records each call and answers from `route`. */
function fakeFetch(route: (call: Call, url: URL) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === 'string' ? init.body : '';
    const call = { method: init?.method ?? 'GET', path: url.pathname, auth: headers.get('authorization'), body };
    calls.push(call);
    return route(call, url);
  }) as typeof fetch;
  return { fetch: impl, calls };
}
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const tokens = { tokenFor: async (user: string) => `token-of-${user}` };

test('startSession posts /service/session as the user the token belongs to, with the app id, AppDefinition and workspace', async () => {
  const { fetch, calls } = fakeFetch(() => new Response('site.example/ws-1/', { status: 200 }));
  const client = createServiceClient({ baseUrl: 'https://service.example', appId: 'app-1', appDefinition: 'workbench-loadtest', tokens, fetch });
  assert.equal(await client.startSession('loadtest-user-0001@loadtest.invalid', 'ws-1'), 'site.example/ws-1/');
  const [call] = calls;
  assert.deepEqual([call.method, call.path, call.auth], ['POST', '/service/session', 'Bearer token-of-loadtest-user-0001@loadtest.invalid']);
  const body = JSON.parse(call.body);
  assert.deepEqual({ appId: body.appId, user: body.user, appDefinition: body.appDefinition, workspaceName: body.workspaceName }, { appId: 'app-1', user: 'loadtest-user-0001@loadtest.invalid', appDefinition: 'workbench-loadtest', workspaceName: 'ws-1' });
});

test('a 403 from the service is a failed start, not retried as another user', async () => {
  const { fetch, calls } = fakeFetch((call) => (call.path === '/service/workspace' ? json({ name: 'ws-1' }) : new Response('forbidden: user mismatch', { status: 403 })));
  const client = createServiceClient({ baseUrl: 'https://service.example', appId: 'app-1', appDefinition: 'wb', tokens, fetch });
  const driver = createSessionDriver(client, tokens, fetch);
  await assert.rejects(driver.startSession('loadtest-user-0001@loadtest.invalid'), (error: unknown) => error instanceof ServiceError && error.status === 403 && !error.message.includes('mismatch'));
  assert.deepEqual(calls.map((call) => call.path), ['/service/workspace', '/service/session']);
  assert.ok(calls.every((call) => call.auth === 'Bearer token-of-loadtest-user-0001@loadtest.invalid'));
});

test('createWorkspace, reportActivity, stopSession and listSessions use the documented paths and methods', async () => {
  const { fetch, calls } = fakeFetch((call) => (call.path.startsWith('/service/session/') ? json([{ name: 'session-1', workspace: 'ws-1' }]) : call.path === '/service/workspace' ? json({ name: 'ws-1' }) : new Response('', { status: 200 })));
  const client = createServiceClient({ baseUrl: 'https://service.example', appId: 'app 1', appDefinition: 'wb', tokens, fetch });
  const user = 'loadtest-user-0002@loadtest.invalid';
  assert.equal(await client.createWorkspace(user), 'ws-1');
  await client.reportActivity(user, 'session-1');
  await client.stopSession(user, 'session-1');
  assert.deepEqual(await client.listSessions(user), [{ name: 'session-1', workspace: 'ws-1' }]);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ['POST /service/workspace', 'PATCH /service/session', 'DELETE /service/session', `GET /service/session/app%201/${encodeURIComponent(user)}`]);
  assert.deepEqual(JSON.parse(calls[1].body), { appId: 'app 1', sessionName: 'session-1' });
  assert.deepEqual(JSON.parse(calls[2].body), { appId: 'app 1', user, sessionName: 'session-1' });
});

test('the driver creates one workspace per person, names the listed session, and a probe counts only a 2xx answer', async () => {
  let probes = 0;
  const { fetch, calls } = fakeFetch((call) => {
    if (call.path === '/service/workspace') return json({ name: 'ws-1' });
    if (call.path === '/service/session' && call.method === 'POST') return new Response('site.example/ws-1/', { status: 200 });
    if (call.path.startsWith('/service/session/')) return json([{ name: 'other' }, { name: 'session-1', workspace: 'ws-1' }]);
    probes += 1;
    return new Response('', { status: probes === 1 ? 302 : 200 });
  });
  const client = createServiceClient({ baseUrl: 'https://service.example', appId: 'a', appDefinition: 'wb', tokens, fetch });
  const driver = createSessionDriver(client, tokens, fetch);
  const user = 'loadtest-user-0003@loadtest.invalid';
  const first = await driver.startSession(user);
  assert.deepEqual(first, { sessionName: 'session-1', url: 'https://site.example/ws-1/' });
  await driver.startSession(user);
  assert.equal(calls.filter((call) => call.path === '/service/workspace').length, 1);
  assert.equal(await driver.probe(first.url), false, 'a redirect to sign in is not a usable session');
  assert.equal(await driver.probe(first.url), true);
  assert.equal(calls.at(-1)?.auth, `Bearer token-of-${user}`);
  assert.equal(await driver.probe('https://site.example/unknown/'), false);
});

test('mintToken refuses a realm not named loadtest-* before any request, and so does the token store', async () => {
  const { fetch, calls } = fakeFetch(() => json({ access_token: 'x', expires_in: 300 }));
  const user = { username: 'loadtest-user-0001', email: 'loadtest-user-0001@loadtest.invalid', password: 'pw' };
  await assert.rejects(mintToken({ baseUrl: 'https://kc.example', realm: 'sterling', fetch }, user), /loadtest-/);
  await assert.rejects(mintToken({ baseUrl: 'https://kc.example', realm: 'production-loadtest-x', fetch }, user), /loadtest-/);
  assert.throws(() => new TokenStore({ baseUrl: 'https://kc.example', realm: 'sterling', fetch }, [user]), /loadtest-/);
  assert.equal(calls.length, 0);
});

test('tokens come from a password grant on the load-test client, are renewed before they expire, and are held in memory only', async () => {
  let minted = 0;
  const { fetch, calls } = fakeFetch(() => json({ access_token: `jwt-${++minted}`, expires_in: 600 }));
  const clock = fakeClock();
  const user = { username: 'loadtest-user-0001', email: 'loadtest-user-0001@loadtest.invalid', password: 'pw-1' };
  const store = new TokenStore({ baseUrl: 'https://kc.example', realm: 'loadtest-sterling', fetch }, [user], clock.now);
  assert.equal(await store.tokenFor(user.email), 'jwt-1');
  assert.equal(await store.tokenFor(user.email), 'jwt-1');
  clock.advance(6 * 60 * 1000);
  assert.equal(await store.tokenFor(user.email), 'jwt-2', 'renewed inside the margin before expiry');
  assert.equal(calls[0].path, '/realms/loadtest-sterling/protocol/openid-connect/token');
  const form = new URLSearchParams(calls[0].body);
  assert.deepEqual([form.get('grant_type'), form.get('client_id'), form.get('username')], ['password', 'loadtest-client', 'loadtest-user-0001']);
  assert.doesNotMatch(JSON.stringify({ store }), /jwt-/);
  await assert.rejects(store.tokenFor('someone@example.com'), /not a user/);
});

test('users refuses an output path inside the repository, and writes synthetic users with mode 0600 outside it', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'loadtest-repo-'));
  const outside = mkdtempSync(join(tmpdir(), 'loadtest-secrets-'));
  const out: string[] = [];
  const deps = { repoRoot: repo, write: (text: string) => out.push(text), error: (text: string) => out.push(text) } as Partial<CliDeps>;
  assert.equal(await main(['users', '--count', '3', '--out', join(repo, 'users.json')], deps), 2);
  assert.deepEqual(readdirSync(repo), []);
  const file = join(outside, 'users.json');
  assert.equal(await main(['users', '--count', '3', '--out', file], deps), 0);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const users = parseUsersFile(readFileSync(file, 'utf8'));
  assert.deepEqual(users.map((user) => [user.username, user.email]), [1, 2, 3].map((n) => [`loadtest-user-000${n}`, `loadtest-user-000${n}@loadtest.invalid`]));
  assert.equal(new Set(users.map((user) => user.password)).size, 3);
  assert.ok(users.every((user) => user.password.length >= 32));
  assert.equal(await main(['users', '--count', '3', '--out', file], deps), 2, 'an existing users file is never overwritten');
});

test('a load run is refused unless sessionsPerUser is 1, the AppDefinition image has a digest, and the operator digest is the locked one', () => {
  const lock = { images: [], built: [{ name: 'sterling/theia-cloud-operator', image: 'deploy/images/theia-cloud-operator/image.json', component: 'theia-cloud', digest: DIGEST('a') }], release: [] };
  const locked = lockedOperatorDigest(lock);
  assert.equal(locked, DIGEST('a'));
  const good = { sessionsPerUser: 1, appImage: `registry.site.example/sterling/sterling-workbench@${DIGEST('b')}`, operatorImage: `registry.site.example/sterling/theia-cloud-operator@${DIGEST('a')}`, lockedOperatorDigest: locked };
  assert.deepEqual(loadRefusals(good), []);
  assert.match(loadRefusals({ ...good, sessionsPerUser: 2 }).join('\n'), /sessionsPerUser/);
  assert.match(loadRefusals({ ...good, sessionsPerUser: null }).join('\n'), /sessionsPerUser/);
  assert.match(loadRefusals({ ...good, appImage: 'registry.site.example/sterling/sterling-workbench:1.0' }).join('\n'), /digest/);
  assert.match(loadRefusals({ ...good, operatorImage: `registry.site.example/sterling/theia-cloud-operator@${DIGEST('c')}` }).join('\n'), /images\.lock\.json/);
  assert.match(loadRefusals({ ...good, lockedOperatorDigest: lockedOperatorDigest({ built: [{ name: 'sterling/theia-cloud-operator', digest: null }] }) }).join('\n'), /images\.lock\.json/);
});

/** A rig in fakes: kubectl answers, the service, Keycloak test realm and Prometheus behind one fetch. */
function fakeRig(options: { sessionsPerUser: string; appImage: string }): { kubectl: Kubectl; fetch: typeof fetch; minted: string[] } {
  const minted: string[] = [];
  const kubectl: Kubectl = async (args) => {
    const kind = args[1];
    if (kind === 'nodes') return JSON.stringify({ items: [{ metadata: { name: 'node-1', labels: { 'node-role.kubernetes.io/worker': 'true' } }, status: { capacity: { cpu: '64', memory: '527958116Ki', pods: '110' }, nodeInfo: { kubeletVersion: 'v1.31.4+rke2r1' } } }] });
    if (kind === 'appdefinitions.theia.cloud') return JSON.stringify({ spec: { image: options.appImage, ingressname: 'theia-cloud-ingress' } });
    if (kind === 'deployment') return JSON.stringify({ spec: { template: { spec: { containers: [{ image: `registry.site.example/sterling/theia-cloud-operator@${DIGEST('a')}`, args: ['--keycloak', '--sessionsPerUser', options.sessionsPerUser] }] } } } });
    if (kind === 'ingress') return JSON.stringify({ spec: { rules: [] } });
    const created = '2026-11-23T12:00:00Z';
    const numbers = [1, 2, 3];
    if (kind === 'sessions.theia.cloud') return JSON.stringify({ items: numbers.map((n) => ({ metadata: { name: `session-${n}`, creationTimestamp: created }, spec: { name: `session-${n}` } })) });
    if (kind === 'deployments') return JSON.stringify({ items: numbers.map((n) => ({ metadata: { name: `dep-${n}`, creationTimestamp: created, ownerReferences: [{ kind: 'Session', name: `session-${n}` }] } })) });
    if (kind === 'pods') return JSON.stringify({ items: numbers.map((n) => ({ metadata: { name: `dep-${n}-abc` }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True', lastTransitionTime: created }] } })) });
    return JSON.stringify({ items: [] });
  };
  let session = 0;
  const { fetch } = fakeFetch((call, url) => {
    if (url.host === 'kc.example') { const token = `eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0${minted.length}In0.c2lnbmF0dXJlc2ln`; minted.push(token); return json({ access_token: token, expires_in: 3600 }); }
    if (url.host === 'prom.example') return url.pathname.endsWith('/values') ? json({ status: 'success', data: [] }) : json({ status: 'success', data: { resultType: 'matrix', result: [] } });
    if (call.path === '/service/workspace') return json({ name: `ws-${++session}` });
    if (call.path === '/service/session' && call.method === 'POST') return new Response(`site.example/ws-${session}/`);
    if (call.path.startsWith('/service/session/')) return json([{ name: `session-${session}`, workspace: `ws-${session}` }]);
    return new Response('', { status: 200 });
  });
  return { kubectl, fetch, minted };
}

function rigFolders(): { repo: string; config: string } {
  const repo = mkdtempSync(join(tmpdir(), 'loadtest-repo-'));
  const secrets = mkdtempSync(join(tmpdir(), 'loadtest-secrets-'));
  mkdirSync(join(repo, 'deploy/bundle'), { recursive: true });
  writeFileSync(join(repo, 'deploy/bundle/images.lock.json'), JSON.stringify({ images: [], built: [{ name: 'sterling/theia-cloud-operator', digest: DIGEST('a') }], release: [] }));
  const usersFile = join(secrets, 'users.json');
  writeFileSync(usersFile, JSON.stringify({ users: [1, 2, 3].map((n) => ({ username: `loadtest-user-000${n}`, email: `loadtest-user-000${n}@loadtest.invalid`, credentials: [{ type: 'password', value: `password-${n}-xxxxxxxxxxxxxxxxxxxxxxxx`, temporary: false }] })) }), { mode: 0o600 });
  const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  const config = join(secrets, 'config.json');
  writeFileSync(config, JSON.stringify({ ...example, serviceUrl: 'https://service.example', prometheusUrl: 'https://prom.example', keycloak: { ...example.keycloak, url: 'https://kc.example' }, usersFile, holdMs: 1_000, activityIntervalMs: 500, pollIntervalMs: 100, burst: 1, startTimeoutMs: 1_000, pendingLimitMs: 0 }));
  return { repo, config };
}

test('run refuses --kind load on a rig that is not the assessed configuration, and writes nothing', async () => {
  const { repo, config } = rigFolders();
  const rig = fakeRig({ sessionsPerUser: '2', appImage: 'registry.site.example/sterling/sterling-workbench:1.0' });
  const out: string[] = [];
  const deps: Partial<CliDeps> = { repoRoot: repo, kubectl: rig.kubectl, fetch: rig.fetch, clock: fakeClock(), env: { THEIA_CLOUD_APP_ID: 'app-1' }, write: (text) => out.push(text), error: (text) => out.push(text) };
  assert.equal(await main(['run', '--config', config, '--stages', '2', '--kind', 'load'], deps), 2);
  assert.match(out.join(''), /sessionsPerUser/);
  assert.match(out.join(''), /digest/);
  assert.equal(rig.minted.length, 0, 'no token is minted for a refused run');
  assert.deepEqual(readdirSync(repo).sort(), ['deploy']);
});

test('a dry-run is allowed on that rig, writes a verified run file of kind dry-run, and no file it writes holds a token', async () => {
  const { repo, config } = rigFolders();
  const rig = fakeRig({ sessionsPerUser: '2', appImage: 'registry.site.example/sterling/sterling-workbench:1.0' });
  const out: string[] = [];
  const deps: Partial<CliDeps> = { repoRoot: repo, kubectl: rig.kubectl, fetch: rig.fetch, clock: fakeClock(), env: { THEIA_CLOUD_APP_ID: 'app-1' }, write: (text) => out.push(text), error: (text) => out.push(text) };
  assert.equal(await main(['run', '--config', config, '--stages', '2', '--kind', 'dry-run'], deps), 0, out.join(''));
  const runs = readdirSync(join(repo, 'loadtest/runs'));
  assert.equal(runs.length, 1);
  const text = readFileSync(join(repo, 'loadtest/runs', runs[0]), 'utf8');
  const run = verifyRunFile(text);
  assert.equal(run.kind, 'dry-run');
  assert.deepEqual(run.stages.map((item) => [item.target, item.reached]), [[2, true]]);
  assert.equal(run.inputs.sessionsPerUser, 2);
  assert.equal(run.hardware.nodes[0].maxPods, 110);
  assert.ok(rig.minted.length > 0);
  for (const token of rig.minted) { assert.ok(!text.includes(token)); assert.ok(!out.join('').includes(token)); }
  assert.ok(!text.includes('app-1'), 'the service app id is not written');
});

test('the test realm is named loadtest-*, has only the load-test client with direct access grants, and defines no user', () => {
  const realm = JSON.parse(readFileSync(new URL('../realm/loadtest-realm.json', import.meta.url), 'utf8'));
  assert.match(realm.realm, /^loadtest-/);
  assert.deepEqual(realm.clients.map((client: { clientId: string }) => client.clientId), ['loadtest-client']);
  assert.equal(realm.clients[0].directAccessGrantsEnabled, true);
  assert.equal(realm.clients[0].publicClient, true);
  assert.equal(realm.users, undefined);
});
