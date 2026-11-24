// Phase 46, plan 02, task 2 (D-03, D-21 to D-25, D-37, D-38; T-46-05 to T-46-07, T-46-09, T-46-10): the identity part of the session state
// machine, transition by transition, against a fake OpenBao with a fake clock. Local mode never calls OpenBao and a missing header never
// switches modes; hosted mode logs in with the forwarded token after the person check, reads the entity id, renews at half the lease,
// re-logs in once on a refused renewal, revokes on stop, and shows failed with a reason. No token reaches a status or the console.
import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { createSessionIdentity, IDENTITY_TIMEOUT_MS, type IdentityClock, type SessionIdentity } from '../extension/src/node/session-identity.ts';
import { createOpenBaoClient } from '../extension/src/node/openbao-client.ts';
import { readHostingConfig, type HostedConfig } from '../extension/src/node/hosting-config.ts';
import { stepUpUrl } from '../extension/src/common/session-identity.ts';
import { captureOutput, closedPort, startFakeOpenBao, type FakeAnswer, type FakeCall, type FakeOpenBao } from './helpers/fake-openbao.ts';
import { makeTestSigner } from './helpers/test-jwt.ts';

const output = captureOutput();
const signer = makeTestSigner();
const START = 1_800_000_000_000;
const ENTITY = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const PERSON = 'ada@example.test';
const issued: string[] = [];

class FakeClock implements IdentityClock {
  private time = START;
  private next = 1;
  private readonly timers = new Map<number, { at: number; run: () => void }>();
  now(): number { return this.time; }
  setTimeout(run: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, run });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  /** Moves time forward, running each timer that falls due, in order. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].run();
    }
    this.time = end;
  }
}

function jwt(claims: Record<string, unknown> = {}): string {
  const token = signer.sign({ sub: 'kc-ada', aud: 'sterling-workbench-test', email: PERSON, exp: START / 1000 + 3600, ...claims });
  issued.push(token);
  return token;
}

function headers(token: string | undefined, email: string | undefined = PERSON): Record<string, string | undefined> {
  return { 'x-forwarded-access-token': token, 'x-auth-request-email': email, 'x-auth-request-user': 'kc-ada' };
}

async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Lets in-flight requests finish without moving the fake clock. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

interface World {
  fake: FakeOpenBao;
  clock: FakeClock;
  identity: SessionIdentity;
  logs: string[];
  answers: Record<string, FakeAnswer | ((call: FakeCall) => FakeAnswer)>;
  config: HostedConfig;
}

const worlds: World[] = [];
let tokenCounter = 0;

async function world(options: { lease?: number; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<World> {
  const answers: World['answers'] = {};
  const answer = (key: string, fallback: (call: FakeCall) => FakeAnswer) => (call: FakeCall): FakeAnswer => {
    const given = answers[key];
    return given === undefined ? fallback(call) : typeof given === 'function' ? given(call) : given;
  };
  const fake = await startFakeOpenBao({
    'POST /v1/auth/jwt/login': answer('login', () => {
      const token = `s.fake-bao-${++tokenCounter}-a8d1`;
      issued.push(token);
      return { json: { auth: { client_token: token, lease_duration: options.lease ?? 3600, renewable: true } } };
    }),
    'GET /v1/auth/token/lookup-self': answer('lookup', () => ({ json: { data: { entity_id: ENTITY, ttl: options.lease ?? 3600 } } })),
    'POST /v1/auth/token/renew-self': answer('renew', () => ({ json: { auth: { lease_duration: options.lease ?? 3600, renewable: true } } })),
    'POST /v1/auth/token/revoke-self': answer('revoke', () => ({ status: 204 })),
  });
  const config = readHostingConfig({ STERLING_OPENBAO_ADDR: fake.url, THEIACLOUD_SESSION_USER: PERSON, ...options.env }) as HostedConfig;
  const clock = new FakeClock();
  const logs: string[] = [];
  const identity = createSessionIdentity({
    config,
    client: createOpenBaoClient({ addr: fake.url, timeoutMs: options.timeoutMs ?? 1000 }),
    clock,
    log: (line) => logs.push(line),
  });
  const made = { fake, clock, identity, logs, answers, config };
  worlds.push(made);
  return made;
}

afterEach(async () => {
  for (const made of worlds.splice(0)) {
    await made.identity.stop();
    await made.fake.close();
  }
});

after(() => {
  output.stop();
  const text = output.text();
  for (const token of issued) assert.ok(!text.includes(token), 'no test JWT or OpenBao token reached the console');
});

test('local mode: status is local with or without headers, session() is undefined and OpenBao is never called', async () => {
  const fake = await startFakeOpenBao({});
  const identity = createSessionIdentity({ config: { mode: 'local' }, client: createOpenBaoClient({ addr: fake.url }), clock: new FakeClock(), log: () => undefined });
  assert.deepEqual(identity.status(), { mode: 'local' });
  await identity.start();
  identity.observe({});
  identity.observe(headers(jwt()));
  await settle();
  assert.deepEqual(identity.status(), { mode: 'local' });
  assert.equal(identity.session(), undefined);
  await identity.retry();
  await identity.stop();
  assert.deepEqual(identity.status(), { mode: 'local' });
  assert.equal(fake.calls.length, 0);
  await fake.close();
});

test('hosted: a valid token with the matching person logs in once, reads the entity id, and goes active', async () => {
  const { fake, identity, logs } = await world();
  await identity.start();
  assert.deepEqual(identity.status(), { mode: 'hosted', state: 'identity' });
  const token = jwt();
  identity.observe(headers(token));
  await until(() => identity.status().mode === 'hosted' && (identity.status() as { state: string }).state === 'active', 'active');
  const logins = fake.callsTo('POST /v1/auth/jwt/login');
  assert.equal(logins.length, 1);
  assert.deepEqual(logins[0].body, { role: 'sterling-workbench', jwt: token });
  assert.equal(logins[0].hasToken, false);
  assert.equal(fake.callsTo('GET /v1/auth/token/lookup-self').length, 1);
  const session = identity.session();
  assert.equal(session?.entityId, ENTITY);
  assert.equal(fake.callsTo('GET /v1/auth/token/lookup-self')[0].token, session?.token);
  const status = JSON.stringify(identity.status());
  assert.ok(!status.includes(ENTITY) && !status.includes(session!.token) && !status.includes(token), 'no token or entity id in the status');
  assert.ok(logs.some((line) => /active/.test(line)));
  for (const line of logs) assert.ok(!line.includes(ENTITY), 'no entity id in a log line');
});

test('a token observed before start is used as soon as start runs', async () => {
  const { identity } = await world();
  identity.observe(headers(jwt()));
  await identity.start();
  assert.equal((identity.status() as { state: string }).state, 'active');
});

test('no token within IDENTITY_TIMEOUT_MS is failed token-missing, and a later token recovers without Retry', async () => {
  const { fake, clock, identity } = await world();
  await identity.start();
  identity.observe({});
  identity.observe(headers(undefined));
  clock.advance(IDENTITY_TIMEOUT_MS - 1);
  assert.equal((identity.status() as { state: string }).state, 'identity');
  clock.advance(1);
  assert.deepEqual(identity.status(), { mode: 'hosted', state: 'failed', reason: 'token-missing' });
  assert.equal(fake.calls.length, 0, 'no secret store call in failed');
  identity.observe(headers(jwt()));
  await until(() => (identity.status() as { state: string }).state === 'active', 'active after a late token');
  assert.equal(fake.callsTo('POST /v1/auth/jwt/login').length, 1);
});

test('the person check is case-insensitive', async () => {
  const { identity } = await world({ env: { THEIACLOUD_SESSION_USER: 'Ada@Example.TEST' } });
  await identity.start();
  identity.observe(headers(jwt({ email: 'ADA@example.test' }), 'ada@EXAMPLE.test'));
  await until(() => (identity.status() as { state: string }).state === 'active', 'active');
});

test('the email header, the token email or THEIACLOUD_SESSION_USER disagreeing is failed person-mismatch with no login', async () => {
  const cases: Array<{ env?: Record<string, string>; claims?: Record<string, unknown>; email?: string }> = [
    { email: 'bob@example.test' },
    { claims: { email: 'bob@example.test' } },
    { env: { THEIACLOUD_SESSION_USER: 'bob@example.test' } },
  ];
  for (const one of cases) {
    const { fake, identity } = await world({ env: one.env });
    await identity.start();
    identity.observe(headers(jwt(one.claims), one.email ?? PERSON));
    await settle();
    assert.deepEqual(identity.status(), { mode: 'hosted', state: 'failed', reason: 'person-mismatch' });
    assert.equal(fake.calls.length, 0, 'no login call for a mismatch');
  }
});

test('login refused (403) is failed store-refused; a new token does not leave it, and Retry runs the start path again', async () => {
  const { fake, identity, answers } = await world();
  answers.login = { status: 403, json: { errors: ['permission denied'] } };
  await identity.start();
  identity.observe(headers(jwt()));
  await until(() => (identity.status() as { state: string }).state === 'failed', 'failed');
  assert.deepEqual(identity.status(), { mode: 'hosted', state: 'failed', reason: 'store-refused' });
  assert.equal(identity.session(), undefined);
  delete answers.login;
  const later = jwt({ acr: 'later' });
  identity.observe(headers(later));
  await settle();
  assert.equal((identity.status() as { reason?: string }).reason, 'store-refused', 'only Retry leaves this failed state');
  assert.equal(fake.callsTo('POST /v1/auth/jwt/login').length, 1);
  await identity.retry();
  assert.equal((identity.status() as { state: string }).state, 'active');
  assert.deepEqual(fake.callsTo('POST /v1/auth/jwt/login')[1].body, { role: 'sterling-workbench', jwt: later }, 'Retry uses the latest token');
});

test('OpenBao unreachable is failed store-unreachable (connection refused, and a timeout), and Retry recovers', async () => {
  const port = await closedPort();
  const config = readHostingConfig({ STERLING_OPENBAO_ADDR: `http://127.0.0.1:${port}`, THEIACLOUD_SESSION_USER: PERSON });
  const down = createSessionIdentity({ config, client: createOpenBaoClient({ addr: `http://127.0.0.1:${port}`, timeoutMs: 500 }), clock: new FakeClock(), log: () => undefined });
  down.observe(headers(jwt()));
  await down.start();
  assert.deepEqual(down.status(), { mode: 'hosted', state: 'failed', reason: 'store-unreachable' });
  await down.stop();

  const { identity, answers } = await world({ timeoutMs: 200 });
  answers.login = { delayMs: 1000, json: {} };
  identity.observe(headers(jwt()));
  await identity.start();
  assert.deepEqual(identity.status(), { mode: 'hosted', state: 'failed', reason: 'store-unreachable' });
  delete answers.login;
  await identity.retry();
  assert.equal((identity.status() as { state: string }).state, 'active');
});

test('an entity id that is not a UUID is failed store-refused, and that token is revoked', async () => {
  const { fake, identity, answers } = await world();
  answers.lookup = { json: { data: { entity_id: '../../other' } } };
  identity.observe(headers(jwt()));
  await identity.start();
  assert.deepEqual(identity.status(), { mode: 'hosted', state: 'failed', reason: 'store-refused' });
  await until(() => fake.callsTo('POST /v1/auth/token/revoke-self').length === 1, 'revoke of the unused token');
});

test('an expired token and a token without a readable payload are ignored', async () => {
  const { fake, clock, identity, logs } = await world();
  await identity.start();
  identity.observe(headers(jwt({ exp: START / 1000 - 1 })));
  identity.observe(headers('not-a-jwt'));
  identity.observe(headers('a.%%%.b'));
  identity.observe(headers(`x.${Buffer.from('[1,2]').toString('base64url')}.y`));
  await settle();
  assert.equal(fake.calls.length, 0);
  assert.equal((identity.status() as { state: string }).state, 'identity');
  assert.ok(logs.some((line) => /token-expired/.test(line)));
  assert.ok(logs.some((line) => /token-unreadable/.test(line)));
  clock.advance(IDENTITY_TIMEOUT_MS);
  assert.equal((identity.status() as { reason?: string }).reason, 'token-missing');
});

test('in active, a token or email header naming someone else is ignored and never replaces the latest token', async () => {
  const { fake, identity, logs, answers, clock } = await world({ lease: 20 });
  const own = jwt({ acr: 'own' });
  identity.observe(headers(own));
  await identity.start();
  identity.observe(headers(jwt({ email: 'bob@example.test', acr: 'bob' })));
  identity.observe(headers(jwt({ acr: 'bob-header' }), 'bob@example.test'));
  assert.equal((identity.status() as { state: string }).state, 'active');
  assert.equal(identity.session()?.acr, 'own');
  assert.equal(identity.session()?.forwardedToken, own, "session() carries the person's own latest forwarded token, for the step-up login (46-07)");
  assert.ok(logs.filter((line) => /person-mismatch/.test(line)).length >= 2, 'logged by reason code');
  answers.renew = { status: 403, json: { errors: ['permission denied'] } };
  clock.advance(10_000);
  await until(() => fake.callsTo('POST /v1/auth/jwt/login').length === 2, 're-login');
  assert.deepEqual(fake.callsTo('POST /v1/auth/jwt/login')[1].body, { role: 'sterling-workbench', jwt: own });
});

test('with a 20 s lease renew-self runs at about 10 s and again at half of each new lease', async () => {
  const { fake, clock, identity } = await world({ lease: 20 });
  identity.observe(headers(jwt()));
  await identity.start();
  const token = identity.session()?.token;
  clock.advance(9_900);
  await settle();
  assert.equal(fake.callsTo('POST /v1/auth/token/renew-self').length, 0);
  clock.advance(200);
  await until(() => fake.callsTo('POST /v1/auth/token/renew-self').length === 1, 'the first renewal');
  assert.equal(fake.callsTo('POST /v1/auth/token/renew-self')[0].token, token);
  await settle();
  clock.advance(10_000);
  await until(() => fake.callsTo('POST /v1/auth/token/renew-self').length === 2, 'the second renewal');
  assert.equal((identity.status() as { state: string }).state, 'active');
});

test('a refused renewal re-logs in once with the latest unexpired token; if that fails too the state is failed with its reason', async () => {
  const { fake, clock, identity, answers } = await world({ lease: 20 });
  identity.observe(headers(jwt()));
  await identity.start();
  const first = identity.session()?.token;
  const fresher = jwt({ acr: 'fresher' });
  identity.observe(headers(fresher));
  answers.renew = { status: 403, json: { errors: ['permission denied'] } };
  clock.advance(10_000);
  await until(() => identity.session()?.token !== undefined && identity.session()?.token !== first, 'a new OpenBao token');
  assert.deepEqual(fake.callsTo('POST /v1/auth/jwt/login')[1].body, { role: 'sterling-workbench', jwt: fresher });
  assert.equal((identity.status() as { state: string }).state, 'active');

  answers.login = { status: 403, json: { errors: ['permission denied'] } };
  clock.advance(10_000);
  await until(() => (identity.status() as { state: string }).state === 'failed', 'failed after a refused re-login');
  assert.deepEqual(identity.status(), { mode: 'hosted', state: 'failed', reason: 'store-refused' });
  assert.equal(fake.callsTo('POST /v1/auth/jwt/login').length, 3, 'exactly one re-login per refused renewal');
  assert.equal(identity.session(), undefined);
});

test('a refused renewal with every forwarded token expired is failed token-missing, and a new token recovers', async () => {
  const { clock, identity, answers } = await world({ lease: 20 });
  identity.observe(headers(jwt({ exp: START / 1000 + 5 })));
  await identity.start();
  answers.renew = { status: 403, json: { errors: ['permission denied'] } };
  clock.advance(10_000);
  await until(() => (identity.status() as { state: string }).state === 'failed', 'failed');
  assert.deepEqual(identity.status(), { mode: 'hosted', state: 'failed', reason: 'token-missing' });
  delete answers.renew;
  identity.observe(headers(jwt({ exp: START / 1000 + 3600 })));
  await until(() => (identity.status() as { state: string }).state === 'active', 'active again');
});

test('stop() from active revokes the token once and ends stopped with session() undefined', async () => {
  const { fake, identity } = await world();
  identity.observe(headers(jwt()));
  await identity.start();
  const token = identity.session()?.token;
  await identity.stop();
  assert.deepEqual(identity.status(), { mode: 'hosted', state: 'stopped' });
  assert.equal(identity.session(), undefined);
  const revokes = fake.callsTo('POST /v1/auth/token/revoke-self');
  assert.equal(revokes.length, 1);
  assert.equal(revokes[0].token, token);
  await identity.stop();
  identity.observe(headers(jwt()));
  await identity.retry();
  await settle();
  assert.equal(fake.callsTo('POST /v1/auth/token/revoke-self').length, 1);
  assert.equal(fake.callsTo('POST /v1/auth/jwt/login').length, 1, 'a stopped session never logs in again');
});

test('a revoke that fails or times out still ends stopped', async () => {
  for (const revoke of [{ status: 500, json: { errors: ['internal'] } }, { delayMs: 2000, status: 204 }]) {
    const { identity, answers } = await world({ timeoutMs: 300 });
    answers.revoke = revoke;
    identity.observe(headers(jwt()));
    await identity.start();
    const started = Date.now();
    await identity.stop();
    assert.ok(Date.now() - started < 1500);
    assert.deepEqual(identity.status(), { mode: 'hosted', state: 'stopped' });
    assert.equal(identity.session(), undefined);
  }
});

test('stop() from identity or failed makes no OpenBao call', async () => {
  const waiting = await world();
  await waiting.identity.start();
  await waiting.identity.stop();
  assert.equal(waiting.fake.calls.length, 0);
  const failing = await world();
  await failing.identity.start();
  failing.clock.advance(IDENTITY_TIMEOUT_MS);
  assert.equal((failing.identity.status() as { state: string }).state, 'failed');
  await failing.identity.stop();
  assert.equal(failing.fake.calls.length, 0);
  assert.deepEqual(failing.identity.status(), { mode: 'hosted', state: 'stopped' });
});

test('session().acr and authTime follow the latest observed token without a new login; status offers step-up when configured', async () => {
  const { fake, identity } = await world({ env: { STERLING_STEPUP_ACR: 'urn:example:acr:hw' } });
  identity.observe(headers(jwt({ acr: '1', auth_time: START / 1000 - 600 })));
  await identity.start();
  assert.equal(identity.session()?.acr, '1');
  assert.equal(identity.session()?.authTime, START / 1000 - 600);
  identity.observe(headers(jwt({ acr: 'urn:example:acr:hw', auth_time: START / 1000 })));
  assert.equal(identity.session()?.acr, 'urn:example:acr:hw');
  assert.equal(identity.session()?.authTime, START / 1000);
  assert.equal(fake.callsTo('POST /v1/auth/jwt/login').length, 1);
  assert.deepEqual(identity.status(), { mode: 'hosted', state: 'active', stepUp: { acr: 'urn:example:acr:hw' } });
});

test('stepUpUrl builds the same-origin /oauth2/start link and refuses any other origin', () => {
  assert.equal(stepUpUrl('/?x=1', 'urn:example:acr:hw'), '/oauth2/start?rd=%2F%3Fx%3D1&acr_values=urn%3Aexample%3Aacr%3Ahw&max_age=0');
  for (const rd of ['https://elsewhere.example/', '//elsewhere.example/', '/\\elsewhere.example', 'relative', '', '/\\']) {
    assert.throws(() => stepUpUrl(rd, 'acr'), /only return to a page of this workbench/);
  }
});
