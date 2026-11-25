// Phase 47 plan 34 (D-84, owner 2026-11-25), against the fake OpenBao: the notice reaches named security officers only; listing and removing
// need a fresh step-up and the removal role's token, which is revoked after each call; remove writes one create-only removal record first and
// only then deletes the guest entity's own secrets (kv/guests/<entity>/), only for a disabled guest past its retention; a second officer or a
// failed write deletes nothing, and a failed delete is finished by the next removal; nothing leaks to the console.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { GUEST_SECRETS_TEXT } from '../extension/src/common/guest-secrets.ts';
import type { SessionIdentityStatus } from '../extension/src/common/session-identity.ts';
import { createGuestSecretsService, NOTICE_ROLE, REMOVAL_ROLE } from '../extension/src/node/guest-secrets-service.ts';
import { readHostingConfig, type HostedConfig } from '../extension/src/node/hosting-config.ts';
import { createOpenBaoClient } from '../extension/src/node/openbao-client.ts';
import type { ActiveSession } from '../extension/src/node/session-identity.ts';
import { captureOutput, startFakeOpenBao, type FakeAnswer, type FakeCall, type FakeOpenBao } from './helpers/fake-openbao.ts';

const OFFICER_ENTITY = '7b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const GUEST_ENTITY = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const STAFF_ENTITY = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';
const SESSION_TOKEN = 's.ORDINARYSESSIONTOKEN0123456789ab';
const REMOVAL_TOKEN = 's.REMOVALTOKEN0123456789abcdefghij';
const NOTICE_TOKEN = 's.NOTICETOKEN0123456789abcdefghijk';
const FORWARDED = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJrYy1vZmZpY2VyIn0.forwarded-signature';
const ACR = 'webauthn-fresh';
const NOW = Date.parse('2027-12-01T00:00:00Z');
const GUEST = 'guest-kc-ada';
const RECORD = `${GUEST}-20261124T120000Z`;
const output = captureOutput();
const fakes: FakeOpenBao[] = [];

after(async () => {
  for (const fake of fakes) await fake.close();
  output.stop();
  for (const value of [SESSION_TOKEN, REMOVAL_TOKEN, NOTICE_TOKEN, FORWARDED, GUEST_ENTITY]) assert.ok(!output.text().includes(value), 'no token or entity id reached the console');
});

interface State {
  officer: boolean;
  kv: Map<string, Record<string, unknown>>;
  entities: Map<string, { id: string; name: string; disabled: boolean }>;
  /** Called before a KV data write is applied; may answer for it (another officer's record, a store that is down). */
  beforeWrite?: (key: string) => FakeAnswer | undefined;
  /** KV keys whose metadata delete answers 503. */
  failDelete: Set<string>;
}

/** A stateful fake: KV v2 under kv/, identity entities by name, and the two jwt roles admitting the officer only. */
async function world(options: { officer?: boolean; session?: Partial<ActiveSession>; seed?: (state: State) => void } = {}) {
  const state: State = { officer: options.officer ?? true, kv: new Map(), entities: new Map(), failDelete: new Set() };
  state.entities.set(GUEST, { id: GUEST_ENTITY, name: GUEST, disabled: true });
  state.kv.set(`site/guest-ended/${RECORD}`, { format: 'sterling-guest-ended/1', entity: GUEST, endedAt: '2026-11-24T12:00:00Z', removeAfter: '2027-11-24T12:00:00Z' });
  state.kv.set(`guests/${GUEST_ENTITY}/mail/work`, { v: 'guest' });
  state.kv.set(`guests/${GUEST_ENTITY}/files/notes/a`, { v: 'guest' });
  state.kv.set(`users/${STAFF_ENTITY}/mail/work`, { v: 'staff' });
  state.kv.set('site/notices/guest-secrets-removal', { format: 'sterling-notice/1', count: 1, checkedAt: '2027-12-01T00:40:00Z' });
  options.seed?.(state);
  const answer = (call: FakeCall): FakeAnswer => {
    const p = call.path.replace(/^\/v1\//, '');
    if (call.method === 'POST' && p === 'auth/jwt/login') {
      const role = (call.body as { role?: string }).role;
      if (!state.officer || (role !== REMOVAL_ROLE && role !== NOTICE_ROLE)) return { status: 400, json: { errors: ['claim "sub" does not match any associated bound claim values'] } };
      return { json: { auth: { client_token: role === REMOVAL_ROLE ? REMOVAL_TOKEN : NOTICE_TOKEN } } };
    }
    if (p === 'auth/token/revoke-self') return { status: 204 };
    if (p === 'auth/token/lookup-self') return { json: { data: { entity_id: OFFICER_ENTITY } } };
    if (p.startsWith('identity/entity/name/')) {
      const entity = state.entities.get(p.slice('identity/entity/name/'.length));
      return entity ? { json: { data: entity } } : { status: 404, json: { errors: [] } };
    }
    if (call.method === 'GET' && call.query === '?list=true' && p.startsWith('kv/metadata/')) {
      const prefix = p.slice('kv/metadata/'.length);
      const keys = new Set<string>();
      for (const key of state.kv.keys()) if (key.startsWith(prefix)) { const rest = key.slice(prefix.length); keys.add(rest.includes('/') ? `${rest.split('/')[0]}/` : rest); }
      return keys.size ? { json: { data: { keys: [...keys].sort() } } } : { status: 404, json: { errors: [] } };
    }
    if (call.method === 'DELETE' && p.startsWith('kv/metadata/')) {
      const key = p.slice('kv/metadata/'.length);
      if (state.failDelete.has(key)) return { status: 503, json: { errors: ['sealed'] } };
      state.kv.delete(key);
      return { status: 204 };
    }
    if (p.startsWith('kv/data/')) {
      const key = p.slice('kv/data/'.length);
      if (call.method === 'GET') return state.kv.has(key) ? { json: { data: { data: state.kv.get(key) } } } : { status: 404, json: { errors: [] } };
      const early = state.beforeWrite?.(key);
      if (early) return early;
      if (state.kv.has(key)) return { status: 400, json: { errors: ['check-and-set parameter did not match the current version'] } };
      state.kv.set(key, (call.body as { data: Record<string, unknown> }).data);
      return { json: { data: { version: 1 } } };
    }
    return { status: 404, json: { errors: [] } };
  };
  const fake = await startFakeOpenBao(new Proxy({}, { get: () => answer }));
  fakes.push(fake);
  const config = readHostingConfig({ STERLING_OPENBAO_ADDR: fake.url, THEIACLOUD_SESSION_USER: 'officer@example.test', STERLING_STEPUP_ACR: ACR }) as HostedConfig;
  const session: ActiveSession = {
    token: SESSION_TOKEN, entityId: OFFICER_ENTITY, forwardedToken: FORWARDED, acr: ACR, authTime: NOW / 1000 - 10,
    client: createOpenBaoClient({ addr: fake.url, timeoutMs: 2000 }), config, ...options.session,
  };
  const identity = { session: () => session, status: (): SessionIdentityStatus => ({ mode: 'hosted', state: 'active' }) as SessionIdentityStatus };
  return { fake, state, service: createGuestSecretsService(identity, { now: () => NOW }) };
}

test('an officer sees the count, through the notice role, without a step-up; anyone else sees nothing', async () => {
  const { fake, service } = await world();
  assert.deepEqual(await service.notice(), { kind: 'ok', value: { count: 1, checkedAt: '2027-12-01T00:40:00Z' } });
  assert.deepEqual(fake.calls.map((call) => `${call.method} ${call.path}`), ['POST /v1/auth/jwt/login', 'GET /v1/kv/data/site/notices/guest-secrets-removal', 'POST /v1/auth/token/revoke-self']);
  assert.deepEqual(fake.calls[0]!.body, { role: NOTICE_ROLE, jwt: FORWARDED });
  assert.equal(fake.calls[1]!.token, NOTICE_TOKEN);
  const other = await world({ officer: false });
  assert.deepEqual(await other.service.notice(), { kind: 'ok', value: null });
  assert.equal(other.fake.calls.length, 1, 'a refused login reads nothing');
});

test('listing and removing need a fresh step-up; without it nothing is called, and a non-officer is refused by OpenBao', async () => {
  const stale = await world({ session: { authTime: NOW / 1000 - 3600 } });
  assert.deepEqual(await stale.service.candidates(), { kind: 'refused', reason: GUEST_SECRETS_TEXT.stepUpNeeded, fix: GUEST_SECRETS_TEXT.confirm });
  assert.deepEqual(await stale.service.remove(RECORD), { kind: 'refused', reason: GUEST_SECRETS_TEXT.stepUpNeeded, fix: GUEST_SECRETS_TEXT.confirm });
  assert.equal(stale.fake.calls.length, 0);
  const plain = await world({ session: { acr: '1' } });
  assert.equal((await plain.service.candidates()).kind, 'refused');
  assert.equal(plain.fake.calls.length, 0);
  const other = await world({ officer: false });
  assert.deepEqual(await other.service.candidates(), { kind: 'refused', reason: GUEST_SECRETS_TEXT.notOfficer });
  assert.deepEqual(other.fake.calls.map((call) => (call.body as { role?: string } | undefined)?.role), [REMOVAL_ROLE]);
});

test('candidates lists the newest end record of each disabled guest past retention with no removal record', async () => {
  const { service } = await world({ seed: (state) => {
    state.entities.set('guest-kc-bo', { id: STAFF_ENTITY, name: 'guest-kc-bo', disabled: false });
    state.kv.set('site/guest-ended/guest-kc-bo-20250101T000000Z', { entity: 'guest-kc-bo', endedAt: '2025-01-01T00:00:00Z', removeAfter: '2026-01-01T00:00:00Z' });
    state.entities.set('guest-kc-cy', { id: '2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d', name: 'guest-kc-cy', disabled: true });
    state.kv.set('site/guest-ended/guest-kc-cy-20250101T000000Z', { entity: 'guest-kc-cy', endedAt: '2025-01-01T00:00:00Z', removeAfter: '2026-01-01T00:00:00Z' });
    state.kv.set('site/guest-ended/guest-kc-cy-20271120T000000Z', { entity: 'guest-kc-cy', endedAt: '2027-11-20T00:00:00Z', removeAfter: '2028-11-20T00:00:00Z' });
    state.entities.set('guest-kc-di', { id: '3c4d5e6f-7081-4b9c-8d0e-2f3a4b5c6d7e', name: 'guest-kc-di', disabled: true });
    state.kv.set('site/guest-ended/guest-kc-di-20250101T000000Z', { entity: 'guest-kc-di', endedAt: '2025-01-01T00:00:00Z', removeAfter: '2026-01-01T00:00:00Z' });
    state.kv.set('site/guest-secrets-removed/guest-kc-di-20250101T000000Z', { format: 'sterling-guest-secrets-removed/1' });
  } });
  // bo is enabled again; cy's newest end is not past retention; di is removed already.
  assert.deepEqual(await service.candidates(), { kind: 'ok', value: [{ record: RECORD, endedAt: '2026-11-24T12:00:00Z', removeAfter: '2027-11-24T12:00:00Z' }] });
});

test('remove records who did it once, then deletes every secret of the guest entity and nothing of anyone else, and the token is revoked', async () => {
  const { fake, state, service } = await world();
  assert.deepEqual(await service.remove(RECORD), { kind: 'ok', value: { removed: 2 } });
  assert.deepEqual([...state.kv.keys()].filter((key) => key.startsWith('users/') || key.startsWith('guests/')), [`users/${STAFF_ENTITY}/mail/work`]);
  const deletes = fake.calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
  assert.deepEqual(deletes.sort(), [`/v1/kv/metadata/guests/${GUEST_ENTITY}/files/notes/a`, `/v1/kv/metadata/guests/${GUEST_ENTITY}/mail/work`]);
  const recordAt = fake.calls.findIndex((call) => call.method === 'POST' && call.path.startsWith('/v1/kv/data/site/guest-secrets-removed/'));
  assert.ok(recordAt >= 0 && fake.calls.findIndex((call) => call.method === 'DELETE') > recordAt, 'the removal record is written before any delete');
  assert.ok(fake.calls.filter((call) => call.path !== '/v1/auth/jwt/login').every((call) => call.token === REMOVAL_TOKEN), 'only the step-up removal token acts');
  assert.equal(fake.calls.at(-1)!.path, '/v1/auth/token/revoke-self');
  const write = fake.calls.find((call) => call.path === `/v1/kv/data/site/guest-secrets-removed/${RECORD}`);
  assert.deepEqual(write!.body, { options: { cas: 0 }, data: { format: 'sterling-guest-secrets-removed/1', entity: GUEST, record: RECORD, removedAt: '2027-12-01T00:00:00Z', removedBy: OFFICER_ENTITY, secrets: 2 } });
  // A second removal of the same record is refused before any delete.
  const before = fake.calls.filter((call) => call.method === 'DELETE').length;
  assert.deepEqual(await service.remove(RECORD), { kind: 'refused', reason: GUEST_SECRETS_TEXT.notDue });
  assert.equal(fake.calls.filter((call) => call.method === 'DELETE').length, before);
});

test('a second officer who wrote the removal record first, or a record write that fails, means nothing is deleted', async () => {
  const raced = await world({ seed: (state) => {
    // Another officer's record lands between this officer's checks and their write: the create-only write is refused (check-and-set).
    state.beforeWrite = (key) => {
      if (key !== `site/guest-secrets-removed/${RECORD}`) return undefined;
      state.kv.set(key, { format: 'sterling-guest-secrets-removed/1', removedBy: STAFF_ENTITY });
      return { status: 400, json: { errors: ['check-and-set parameter did not match the current version'] } };
    };
  } });
  assert.deepEqual(await raced.service.remove(RECORD), { kind: 'refused', reason: GUEST_SECRETS_TEXT.removedByOther });
  assert.equal(raced.fake.calls.filter((call) => call.method === 'DELETE').length, 0);
  assert.equal(raced.state.kv.size, 6, 'the guest\'s secrets are all still there');
  assert.equal(raced.fake.calls.at(-1)!.path, '/v1/auth/token/revoke-self');
  for (const answer of [{ status: 503, json: { errors: ['sealed'] } }, { status: 403, json: { errors: ['permission denied'] } }]) {
    const down = await world({ seed: (state) => { state.beforeWrite = () => answer; } });
    assert.deepEqual(await down.service.remove(RECORD), { kind: 'refused', reason: GUEST_SECRETS_TEXT.unreachable }, String(answer.status));
    assert.equal(down.fake.calls.filter((call) => call.method === 'DELETE').length, 0, `no delete after a ${answer.status} write`);
    assert.ok(down.state.kv.has(`guests/${GUEST_ENTITY}/mail/work`));
  }
});

test('a delete that fails leaves the record written; the guest is offered again and the next removal finishes without a second record', async () => {
  const { fake, state, service } = await world({ seed: (seeded) => { seeded.failDelete.add(`guests/${GUEST_ENTITY}/mail/work`); } });
  assert.deepEqual(await service.remove(RECORD), { kind: 'refused', reason: GUEST_SECRETS_TEXT.unfinished(1), fix: GUEST_SECRETS_TEXT.command });
  assert.ok(state.kv.has(`site/guest-secrets-removed/${RECORD}`), 'recorded');
  assert.deepEqual([...state.kv.keys()].filter((key) => key.startsWith('guests/')), [`guests/${GUEST_ENTITY}/mail/work`]);
  assert.deepEqual(await service.candidates(), { kind: 'ok', value: [{ record: RECORD, endedAt: '2026-11-24T12:00:00Z', removeAfter: '2027-11-24T12:00:00Z' }] });
  state.failDelete.clear();
  const writes = fake.calls.filter((call) => call.method === 'POST' && call.path.includes('guest-secrets-removed')).length;
  assert.deepEqual(await service.remove(RECORD), { kind: 'ok', value: { removed: 1 } });
  assert.equal(fake.calls.filter((call) => call.method === 'POST' && call.path.includes('guest-secrets-removed')).length, writes, 'no second record');
  assert.deepEqual([...state.kv.keys()].filter((key) => key.startsWith('guests/')), []);
  assert.deepEqual(await service.candidates(), { kind: 'ok', value: [] }, 'finished: not offered again');
});

test('remove refuses a guest enabled again, one not past retention, a staff entity and a malformed record, before any delete', async () => {
  for (const seed of [
    (state: State) => { state.entities.get(GUEST)!.disabled = false; },
    (state: State) => { state.kv.set(`site/guest-ended/${RECORD}`, { entity: GUEST, endedAt: '2026-11-24T12:00:00Z', removeAfter: '2028-01-01T00:00:00Z' }); },
  ]) {
    const { fake, service } = await world({ seed });
    assert.deepEqual(await service.remove(RECORD), { kind: 'refused', reason: GUEST_SECRETS_TEXT.notDue });
    assert.equal(fake.calls.filter((call) => call.method === 'DELETE').length, 0);
  }
  const { fake, service } = await world();
  for (const record of [`keycloak-kc-sam-20261124T120000Z`, '../users', `${GUEST}`, `${RECORD}/../x`]) {
    assert.deepEqual(await service.remove(record), { kind: 'refused', reason: GUEST_SECRETS_TEXT.badRecord }, record);
  }
  assert.equal(fake.calls.length, 0);
});
