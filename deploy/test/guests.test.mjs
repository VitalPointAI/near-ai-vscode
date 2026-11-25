// Guest accounts (DEP-13, D-58 to D-63): deploy/keycloak/guests.mjs and the guest path of deploy/openbao/enrol.mjs, against fake Keycloak,
// OpenBao and sessions clients that record every call. The fictional people are Ada Observer (the guest), lead.one (the lead) and sec.one (the
// security contact). No server is needed; the CLI cases start the script against a local HTTP fake.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { checkGuestRequest, CREDENTIAL_CARD_REACHABLE, createGuest, credentialIssuingShipped, endGuest, expireGuests, expireInCluster, extendGuest, guestSettings, guestStatus, linkGuest, listGuests, GuestRefusal, REVOCATION_FORMAT } from '../keycloak/guests.mjs';
import { POLICIES } from '../openbao/apply.mjs';
import { enrolPerson } from '../openbao/enrol.mjs';
import { releaseValueFiles } from '../keycloak/apply.mjs';
import { listReleases, loadSite, renderRelease, splitDocs } from '../bundle/lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = Date.parse('2026-11-24T12:00:00Z');
const UNTIL = '2026-12-20T17:00:00Z';
// issuing: true stands for a release that includes the credential issuing and revocation card (71-12); this one does not yet (see below).
const SETTINGS = { maxDays: 90, checkMinutes: 15, sessionsNamespace: 'theia-cloud', retentionDays: 365, issuing: true };
const LEAD = 'kc-lead-1';
const SEC = 'kc-sec-1';

const passkey = (id) => ({ id: `record-${id}`, type: 'webauthn-passwordless', credentialData: JSON.stringify({ credentialId: id }) });

/** A fake Keycloak admin API: keycloak(method, path, body) -> { status, data }, recording every call. */
function fakeKeycloak({ smtpHost = 'mail.site.example', emailStatus = 204 } = {}) {
  const calls = [];
  const users = new Map();
  const groups = new Map();
  const credentials = new Map();
  let next = 0;
  const add = (user, { groupPaths = [], keys = [] } = {}) => {
    users.set(user.id, { enabled: true, attributes: {}, requiredActions: [], ...user });
    groups.set(user.id, groupPaths.map((groupPath) => ({ path: groupPath, name: groupPath.slice(1) })));
    credentials.set(user.id, keys.map(passkey));
    return users.get(user.id);
  };
  add({ id: LEAD, username: 'lead.one', email: 'lead.one@site.example' });
  add({ id: SEC, username: 'sec.one', email: 'sec.one@site.example' });
  const reply = (status, data = null) => ({ status, data });
  const keycloak = async (method, apiPath, body) => {
    calls.push({ method, path: apiPath, body: body === undefined ? undefined : structuredClone(body) });
    const [route, query = ''] = apiPath.split('?');
    const params = new URLSearchParams(query);
    if (method === 'GET' && route === '') return reply(200, { realm: 'sterling', smtpServer: { host: smtpHost } });
    if (method === 'GET' && route === 'users') {
      const all = [...users.values()];
      if (params.has('username')) return reply(200, all.filter((user) => user.username === params.get('username')).map((user) => structuredClone(user)));
      if (params.has('email')) return reply(200, all.filter((user) => user.email === params.get('email')).map((user) => structuredClone(user)));
      return reply(200, all.map((user) => structuredClone(user)));
    }
    if (method === 'GET' && route === 'group-by-path/guests') return reply(200, { id: 'group-guests', path: '/guests', name: 'guests' });
    if (method === 'GET' && route === 'groups/group-guests/members') {
      const members = [...users.values()].filter((user) => groups.get(user.id).some((group) => group.path === '/guests'));
      const first = Number(params.get('first') ?? 0);
      const max = Number(params.get('max') ?? 100);
      return reply(200, members.slice(first, first + max).map((user) => structuredClone(user)));
    }
    if (method === 'POST' && route === 'users') {
      next += 1;
      const { groups: paths = [], ...rest } = body;
      add({ ...rest, id: `kc-guest-${next}` }, { groupPaths: paths });
      return reply(201);
    }
    const match = /^users\/([^/]+)(?:\/(.+))?$/.exec(route);
    if (!match) return reply(404, { error: `unexpected ${method} ${apiPath}` });
    const id = decodeURIComponent(match[1]);
    if (!users.has(id)) return reply(404, { error: 'User not found' });
    const sub = match[2];
    if (!sub && method === 'GET') { fake.beforeRead?.[id]?.(users.get(id)); return reply(200, structuredClone(users.get(id))); }
    if (sub === 'role-mappings' && method === 'GET') return reply(200, structuredClone(fake.roles?.[id] ?? { realmMappings: [{ name: 'default-roles-sterling' }] }));
    if (!sub && method === 'PUT') { users.set(id, { ...structuredClone(body), id }); return reply(204); }
    if (sub === 'groups' && method === 'GET') return reply(200, structuredClone(groups.get(id)));
    if (sub === 'credentials' && method === 'GET') return reply(200, structuredClone(credentials.get(id)));
    if (sub === 'logout' && method === 'POST') return reply(204);
    if (sub === 'execute-actions-email' && method === 'PUT') return emailStatus < 300 ? reply(emailStatus) : reply(emailStatus, { errorMessage: 'Failed to send execute actions email' });
    return reply(404, { error: `unexpected ${method} ${apiPath}` });
  };
  const writes = () => calls.filter((call) => call.method !== 'GET');
  const fake = { keycloak, calls, users, groups, credentials, add, writes, roles: undefined, beforeRead: undefined };
  return fake;
}

/** A fake OpenBao: entities by name, KV v2 with create-only writers (a second write is a 403, as OpenBao answers), the people directory. */
function fakeBao({ createOnly = true } = {}) {
  const calls = [];
  const entities = new Map();
  const kv = new Map();
  let next = 0;
  const reply = (status, data) => ({ status, data: data === undefined ? null : { data } });
  const addEntity = (name, extra = {}) => { next += 1; const entity = { id: `entity-${next}`, name, disabled: false, policies: [], direct_group_ids: [], metadata: {}, ...extra }; entities.set(name, entity); return entity; };
  const request = async (method, apiPath, body) => {
    calls.push({ method, path: apiPath, body: body === undefined ? undefined : structuredClone(body) });
    if (method === 'GET' && apiPath === 'sys/auth') return reply(200, { 'jwt/': { type: 'jwt', accessor: 'auth_jwt_1' } });
    if (apiPath.startsWith('identity/entity/name/')) {
      const name = apiPath.slice('identity/entity/name/'.length);
      if (method === 'GET') return entities.has(name) ? reply(200, structuredClone(entities.get(name))) : { status: 404, data: { errors: [] } };
      if (!entities.has(name)) addEntity(name);
      Object.assign(entities.get(name), body);
      return { status: 204, data: null };
    }
    if (apiPath.startsWith('identity/entity/id/')) {
      const entity = [...entities.values()].find((item) => item.id === apiPath.slice('identity/entity/id/'.length));
      if (!entity) return { status: 404, data: { errors: [] } };
      if (method === 'GET') return reply(200, structuredClone(entity));
      Object.assign(entity, body);
      return { status: 204, data: null };
    }
    if (apiPath === 'identity/lookup/entity') return { status: 204, data: null };
    if (apiPath === 'identity/entity') { const entity = addEntity(body.name, { metadata: body.metadata, policies: body.policies ?? [] }); return reply(200, { id: entity.id, name: entity.name }); }
    if (apiPath === 'identity/entity-alias') return reply(200, { id: 'alias-1' });
    if (apiPath.startsWith('transit/keys/')) return method === 'GET' ? { status: 404, data: { errors: [] } } : { status: 204, data: null };
    if (apiPath === 'sys/capabilities-self') return reply(200, Object.fromEntries(body.paths.map((where) => [where, /^kv\/data\/site\/(revocation-requests|guest-ended)\/guest-/.test(where) ? ['create'] : ['deny']])));
    if (apiPath.startsWith('kv/data/')) {
      if (method === 'GET') return kv.has(apiPath) ? reply(200, { data: kv.get(apiPath) }) : { status: 404, data: { errors: [] } };
      if (kv.has(apiPath)) return createOnly ? { status: 403, data: { errors: ['permission denied'] } } : { status: 400, data: { errors: ['check-and-set parameter did not match the current version'] } };
      kv.set(apiPath, structuredClone(body.data));
      return reply(200, { version: 1 });
    }
    return { status: 404, data: { errors: [`unexpected ${method} ${apiPath}`] } };
  };
  // The security contact is enrolled and has a DID in the people directory (71-10).
  const sec = addEntity(`keycloak-${SEC}`, { metadata: { keycloak_user_id: SEC } });
  kv.set(`kv/data/site/people/${sec.id}`, { did: 'did:webvh:sec-one.example' });
  return { request, calls, entities, kv, addEntity, writes: () => calls.filter((call) => call.method !== 'GET' && !['sys/capabilities-self', 'identity/lookup/entity'].includes(call.path)) };
}

const fakeSessions = () => {
  const stopped = [];
  return { stopped, stop: async (email) => { stopped.push(email); return 1; } };
};
const holds = () => { const checks = []; const check = async (args) => { checks.push(args); return { ok: true, message: 'sec.one holds a valid SecurityContactCredential.' }; }; check.checks = checks; return check; };

const REQUEST = Object.freeze({ user: 'ada.observer', email: 'guest-07@site.example', first: 'Ada', last: 'Observer', until: UNTIL,
  requestedBy: 'lead.one', approvedBy: 'sec.one', approverCredential: '/media/sec-one.near-vc', trust: '/media/trust', approvalRef: 'VR-001' });

test('a valid request creates one account in /guests with the lifecycle attributes and the passwordless registration action', async () => {
  const kc = fakeKeycloak();
  const bao = fakeBao();
  const checkCredential = holds();
  const { user, link } = await createGuest({ request: { ...REQUEST, until: '2026-12-20T12:00:00-05:00' }, settings: SETTINGS, keycloak: kc.keycloak, bao: bao.request, checkCredential, now: NOW, noLink: true });
  const posts = kc.writes().filter((call) => call.method === 'POST' && call.path === 'users');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body.groups, ['/guests']);
  assert.deepEqual(posts[0].body.requiredActions, ['webauthn-register-passwordless']);
  assert.deepEqual(posts[0].body.attributes, { guestUntil: ['2026-12-20T17:00:00Z'], guestRequestedBy: ['lead.one'], guestApprovedBy: ['sec.one'], guestApprovalRef: ['VR-001'] },
    'only lifecycle attributes, the end normalised to UTC');
  assert.equal(link, null);
  assert.equal(kc.calls.filter((call) => call.path.includes('execute-actions-email')).length, 0, '--no-link makes no email call');
  assert.equal(user.username, 'ada.observer');
  // The approver's credential is checked for the DID the people directory holds for sec.one.
  assert.deepEqual(checkCredential.checks.map((args) => [args.holder, args.type, args.credential, args.trust]), [['did:webvh:sec-one.example', 'SecurityContactCredential', '/media/sec-one.near-vc', '/media/trust']]);
  assert.equal(bao.writes().length, 0, 'creating a guest writes nothing to OpenBao');
});

test('create sends the registration link when the realm has a mail server, and keeps the account but reports it when none is sent', async () => {
  const sent = fakeKeycloak();
  const ok = await createGuest({ request: REQUEST, settings: SETTINGS, keycloak: sent.keycloak, bao: fakeBao().request, checkCredential: holds(), now: NOW });
  assert.equal(ok.link.sent, true);
  const email = sent.calls.find((call) => call.path.includes('execute-actions-email'));
  assert.match(email.path, /lifespan=86400$/);
  assert.deepEqual(email.body, ['webauthn-register-passwordless']);

  const noMail = fakeKeycloak({ smtpHost: 'not-set' });
  const unsent = await createGuest({ request: REQUEST, settings: SETTINGS, keycloak: noMail.keycloak, bao: fakeBao().request, checkCredential: holds(), now: NOW });
  assert.equal(unsent.link.sent, false);
  assert.match(unsent.link.message, /no mail server.*smtp.*realm site file.*guests\.mjs link --user ada\.observer/s);
  assert.equal(noMail.calls.filter((call) => call.path.includes('execute-actions-email')).length, 0, 'nothing is sent without a mail host');

  const refused = fakeKeycloak({ emailStatus: 500 });
  const failed = await createGuest({ request: REQUEST, settings: SETTINGS, keycloak: refused.keycloak, bao: fakeBao().request, checkCredential: holds(), now: NOW });
  assert.equal(failed.link.sent, false);
  assert.match(failed.link.message, /answered 500 "Failed to send execute actions email".*smtp in the realm site file.*guests\.mjs link --user ada\.observer/s);
  assert.ok([...refused.users.values()].some((user) => user.username === 'ada.observer'), 'the account stays');
  assert.equal(refused.calls.filter((call) => call.method === 'DELETE').length, 0, 'nothing is rolled back');
});

test('link refuses an ended guest', async () => {
  const kc = fakeKeycloak();
  kc.add({ id: 'kc-ended', username: 'ended.guest', email: 'guest-08@site.example', enabled: false, attributes: { guestUntil: [UNTIL], guestEndedAt: ['2026-11-20T10:00:00Z'] } }, { groupPaths: ['/guests'] });
  await assert.rejects(linkGuest({ username: 'ended.guest', keycloak: kc.keycloak, now: NOW }), (error) => error instanceof GuestRefusal && /has ended/.test(error.message));
  assert.equal(kc.writes().length, 0);
});

/** The end record of D-84 for kc-ada ended at NOW with a 365-day retention. */
const END_RECORD = { format: 'sterling-guest-ended/1', entity: 'guest-kc-ada', keycloakId: 'kc-ada', endedAt: '2026-11-24T12:00:00Z', removeAfter: '2027-11-24T12:00:00Z' };
const GUEST_ATTRS = { guestUntil: [UNTIL], guestRequestedBy: ['lead.one'], guestApprovedBy: ['sec.one'], guestApprovalRef: ['VR-001'] };
const enrolledGuest = (kc, bao, id = 'kc-ada') => {
  kc.add({ id, username: 'ada.observer', email: 'guest-07@site.example', attributes: structuredClone(GUEST_ATTRS) }, { groupPaths: ['/guests'], keys: ['k1', 'k2'] });
  return bao.addEntity(`guest-${id}`, { metadata: { keycloak_user_id: id, account: 'guest' } });
};

test('endGuest disables, logs out, records the end, disables the entity and stops the sessions, and deletes nothing', async () => {
  const kc = fakeKeycloak();
  const bao = fakeBao();
  const sessions = fakeSessions();
  enrolledGuest(kc, bao);
  const result = await endGuest({ userId: 'kc-ada', reason: 'visit over', early: false, keycloak: kc.keycloak, bao: bao.request, sessions, now: NOW, retentionDays: 365 });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(kc.writes().map((call) => `${call.method} ${call.path}`), ['PUT users/kc-ada', 'POST users/kc-ada/logout', 'PUT users/kc-ada']);
  assert.equal(kc.writes()[0].body.enabled, false);
  const recorded = kc.users.get('kc-ada');
  assert.equal(recorded.enabled, false);
  assert.deepEqual(recorded.attributes, { ...GUEST_ATTRS, guestEndedAt: ['2026-11-24T12:00:00Z'], guestEndedReason: ['visit over'] }, 'the other guest attributes survive the end');
  assert.deepEqual(bao.writes().map((call) => [call.method, call.path, call.body]), [['POST', 'identity/entity/name/guest-kc-ada', { disabled: true }],
    ['POST', 'kv/data/site/guest-ended/guest-kc-ada-20261124T120000Z', { options: { cas: 0 }, data: END_RECORD }]]);
  assert.equal(bao.entities.get('guest-kc-ada').disabled, true);
  assert.deepEqual(sessions.stopped, ['guest-07@site.example']);
  for (const call of [...kc.calls, ...bao.calls]) assert.notEqual(call.method, 'DELETE', `${call.path} is a delete`);
  assert.equal(result.request, 'none', 'a date end files no revocation request');
  assert.equal([...bao.kv.keys()].filter((key) => key.includes('revocation-requests')).length, 0);
});

test('an early end files one create-only revocation request with exactly the D-22 fields, and a second early end overwrites nothing', async () => {
  const kc = fakeKeycloak();
  const bao = fakeBao();
  enrolledGuest(kc, bao);
  const first = await endGuest({ userId: 'kc-ada', reason: 'left early', early: true, job: 'guests.mjs end', keycloak: kc.keycloak, bao: bao.request, sessions: null, now: NOW, retentionDays: 365 });
  assert.deepEqual(first.failures, []);
  assert.equal(first.request, 'filed');
  const where = 'kv/data/site/revocation-requests/guest-kc-ada-guest-ended';
  const write = bao.calls.find((call) => call.path === where);
  assert.deepEqual(write.body.options, { cas: 0 });
  assert.deepEqual(write.body.data, { format: REVOCATION_FORMAT, entity: 'guest-kc-ada', keycloakId: 'kc-ada', reason: 'guest-ended', seenAt: '2026-11-24T12:00:00Z', job: 'guests.mjs end' });
  const second = await endGuest({ userId: 'kc-ada', reason: 'again', early: true, job: 'sterling-guest-expiry', keycloak: kc.keycloak, bao: bao.request, sessions: null, now: NOW + 60_000, retentionDays: 365 });
  assert.deepEqual(second.failures, []);
  assert.equal(second.request, 'already filed');
  assert.equal(bao.kv.get(where).job, 'guests.mjs end', 'the first request is unchanged');
  assert.deepEqual([kc.users.get('kc-ada').attributes.guestEndedAt, kc.users.get('kc-ada').attributes.guestEndedReason], [['2026-11-24T12:00:00Z'], ['left early']], 'the first end\'s time and reason are kept');
  assert.equal([...bao.kv.keys()].filter((key) => key.includes('revocation-requests')).length, 1);
});

test('a guest who never enrolled has no entity: endGuest skips the OpenBao disable and never creates an entity', async () => {
  const kc = fakeKeycloak();
  const bao = fakeBao();
  kc.add({ id: 'kc-new', username: 'new.guest', email: 'guest-09@site.example', attributes: structuredClone(GUEST_ATTRS) }, { groupPaths: ['/guests'] });
  const result = await endGuest({ userId: 'kc-new', reason: 'cancelled', early: true, keycloak: kc.keycloak, bao: bao.request, sessions: null, now: NOW, retentionDays: 365 });
  assert.deepEqual(result.failures, []);
  assert.equal(bao.writes().length, 0);
  assert.ok(!bao.entities.has('guest-kc-new'));
});

const enrolKeycloak = (kc) => ({
  findUser: async (username) => [...kc.users.values()].find((user) => user.username === username),
  credentials: async (id) => kc.credentials.get(id) ?? [],
  groups: async (id) => kc.groups.get(id) ?? []
});

test('enrolPerson names a guest\'s entity guest-<id> with account guest, and refuses a past guestUntil before any OpenBao call', async () => {
  const kc = fakeKeycloak();
  kc.add({ id: 'kc-ada', username: 'ada.observer', email: 'guest-07@site.example', attributes: structuredClone(GUEST_ATTRS) }, { groupPaths: ['/guests'], keys: ['k1', 'k2'] });
  const bao = fakeBao();
  const { entityId, created } = await enrolPerson({ username: 'ada.observer', keycloak: enrolKeycloak(kc), bao: bao.request, now: NOW });
  const entity = bao.entities.get('guest-kc-ada');
  assert.equal(entity.id, entityId);
  assert.deepEqual(entity.metadata, { keycloak_user_id: 'kc-ada', account: 'guest' });
  assert.deepEqual(entity.policies, ['guest-account'], 'a guest entity carries guest-account, so its secrets go under kv/guests/');
  assert.deepEqual(created, ['entity', 'alias', `person-${entityId}`, `kek-${entityId}`]);

  const late = fakeKeycloak();
  late.add({ id: 'kc-late', username: 'late.guest', email: 'guest-10@site.example', attributes: { ...structuredClone(GUEST_ATTRS), guestUntil: ['2026-11-01T00:00:00Z'] } }, { groupPaths: ['/guests'], keys: ['k1', 'k2'] });
  const untouched = fakeBao();
  await assert.rejects(enrolPerson({ username: 'late.guest', keycloak: enrolKeycloak(late), bao: untouched.request, now: NOW }), /ended at 2026-11-01T00:00:00Z/);
  assert.equal(untouched.calls.length, 0);
  late.add({ id: 'kc-none', username: 'no.end', email: 'guest-11@site.example', attributes: {} }, { groupPaths: ['/guests'], keys: ['k1', 'k2'] });
  await assert.rejects(enrolPerson({ username: 'no.end', keycloak: enrolKeycloak(late), bao: untouched.request, now: NOW }), /without a valid end date/);
  late.add({ id: 'kc-off', username: 'off.guest', email: 'guest-12@site.example', enabled: false, attributes: structuredClone(GUEST_ATTRS) }, { groupPaths: ['/guests'], keys: ['k1', 'k2'] });
  await assert.rejects(enrolPerson({ username: 'off.guest', keycloak: enrolKeycloak(late), bao: untouched.request, now: NOW }), /disabled/);
  assert.equal(untouched.calls.length, 0);
});

test('enrolPerson attaches guest-account to an adopted guest entity that lacks it, and refuses one holding any other policy', async () => {
  const kc = fakeKeycloak();
  kc.add({ id: 'kc-ada', username: 'ada.observer', email: 'guest-07@site.example', attributes: structuredClone(GUEST_ATTRS) }, { groupPaths: ['/guests'], keys: ['k1', 'k2'] });
  const bao = fakeBao();
  bao.addEntity('guest-kc-ada', { metadata: { keycloak_user_id: 'kc-ada', account: 'guest' } });
  const { created } = await enrolPerson({ username: 'ada.observer', keycloak: enrolKeycloak(kc), bao: bao.request, now: NOW });
  assert.ok(created.includes('guest-account'));
  assert.deepEqual(bao.entities.get('guest-kc-ada').policies, ['guest-account']);
  const held = fakeBao();
  held.addEntity('guest-kc-ada', { metadata: { keycloak_user_id: 'kc-ada', account: 'guest' }, policies: ['sterling-admin'] });
  await assert.rejects(enrolPerson({ username: 'ada.observer', keycloak: enrolKeycloak(kc), bao: held.request, now: NOW }), /holds the policy sterling-admin; a guest holds only guest-account/);
  assert.deepEqual(held.entities.get('guest-kc-ada').policies, ['sterling-admin']);
});

test('enrolPerson refuses a guest-<id> entity it did not make (a disabled one, or one without this account\'s id)', async () => {
  const kc = fakeKeycloak();
  kc.add({ id: 'kc-ada', username: 'ada.observer', email: 'guest-07@site.example', attributes: structuredClone(GUEST_ATTRS) }, { groupPaths: ['/guests'], keys: ['k1', 'k2'] });
  const bao = fakeBao();
  bao.addEntity('guest-kc-ada', { disabled: true });
  await assert.rejects(enrolPerson({ username: 'ada.observer', keycloak: enrolKeycloak(kc), bao: bao.request, now: NOW }), /did not make/);
  assert.equal(bao.writes().length, 0);
});

/** Serves the fake Keycloak and OpenBao over HTTP so the CLI runs unchanged; resolves with { base, close }. */
function serve(kc, bao) {
  const server = http.createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', async () => {
      const url = new URL(request.url, 'http://localhost');
      const body = text ? JSON.parse(text) : undefined;
      let result;
      if (url.pathname.startsWith('/admin/realms/sterling')) result = await kc.keycloak(request.method, `${url.pathname.slice('/admin/realms/sterling/'.length)}${url.search}`, body);
      else result = await bao.request(request.method, url.pathname.slice('/v1/'.length), body);
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(result.data === null ? '' : JSON.stringify(result.data));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'deploy/keycloak/guests.mjs'), ...args], { encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('the link command exits 1, naming the mail settings and the next step, when Keycloak refuses the send or the realm has no mail host', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sterling-guests-'));
  for (const name of ['kc-token', 'bao-token', 'ca.pem']) writeFileSync(path.join(dir, name), 'test\n');
  for (const [options, expected] of [[{ emailStatus: 500 }, /answered 500.*smtp in the realm site file.*guests\.mjs link --user ada\.observer/s], [{ smtpHost: '' }, /no mail server/]]) {
    const kc = fakeKeycloak(options);
    kc.add({ id: 'kc-ada', username: 'ada.observer', email: 'guest-07@site.example', attributes: structuredClone(GUEST_ATTRS) }, { groupPaths: ['/guests'] });
    const bao = fakeBao();
    const { base, close } = await serve(kc, bao);
    try {
      const run = await cli(['link', '--user', 'ada.observer', '--keycloak', base, '--keycloak-token-file', path.join(dir, 'kc-token'), '--bao', base,
        '--ca-file', path.join(dir, 'ca.pem'), '--bao-token-file', path.join(dir, 'bao-token')]);
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stderr, expected);
      assert.ok(kc.users.has('kc-ada'));
    } finally {
      close();
    }
  }
});

// ---- The guest rules locked (47-19 Task 2) ----

const refusal = (change) => checkGuestRequest({ ...REQUEST, ...change }, SETTINGS, NOW).problems.join('\n');

test('checkGuestRequest refuses each broken rule and accepts a good request', () => {
  assert.deepEqual(checkGuestRequest(REQUEST, SETTINGS, NOW), { problems: [], until: UNTIL });
  assert.match(refusal({ until: undefined }), /The end date is missing/);
  assert.match(refusal({ until: '2026-12-20T17:00:00' }), /has no time zone/);
  assert.match(refusal({ until: '2026-11-01T00:00:00Z' }), /is in the past/);
  assert.match(refusal({ until: '2027-03-01T00:00:00Z' }), /The end date is more than 90 days away\. This site allows guests for at most 90 days \(guests\.maxDays\)\./);
  assert.match(checkGuestRequest(REQUEST, { ...SETTINGS, maxDays: 0 }, NOW).problems.join('\n'), /Guests are off at this site\. Set guests\.maxDays in the realm site file\./);
  assert.match(checkGuestRequest(REQUEST, {}, NOW).problems.join('\n'), /Guests are off at this site/);
  // G449: a nonzero maxDays on a release without the credential issuing and revocation card (71-12) is refused, plainly.
  assert.match(checkGuestRequest(REQUEST, { ...SETTINGS, issuing: false }, NOW).problems.join('\n'),
    /Guests stay off on this release: the realm site file sets guests\.maxDays to 90, but this release does not include the credential issuing and revocation card \(71-12\).*Set guests\.maxDays to 0/);
  assert.match(refusal({ approvedBy: undefined }), /security contact's approval/);
  assert.match(refusal({ approverCredential: undefined }), /--approver-credential/);
  assert.match(refusal({ approvalRef: undefined }), /--approval-ref/);
  assert.match(refusal({ requestedBy: undefined }), /at a lead's request/);
  for (const field of ['serves', 'nationality', 'organization']) assert.match(refusal({ [field]: 'industry' }), new RegExp(`--${field} is not kept in Keycloak any more: .* are credentials`), field);
  assert.match(refusal({ approvedBy: 'lead.one' }), /someone other than the lead/);
  assert.match(refusal({ approvedBy: 'ada.observer' }), /cannot approve their own account/);
});

test('create refuses, before any write, a failed SecurityContactCredential check, a disabled approver and a lead who is a guest', async () => {
  for (const message of ['Whoever signed a cited credential did not have the authority to issue it.', 'This credential is about someone else.',
    'A cited credential was not valid at the time of the entry.', 'A cited credential is revoked.']) {
    const kc = fakeKeycloak();
    const bao = fakeBao();
    await assert.rejects(createGuest({ request: REQUEST, settings: SETTINGS, keycloak: kc.keycloak, bao: bao.request, checkCredential: async () => ({ ok: false, message }), now: NOW }),
      (error) => error instanceof GuestRefusal && error.message.includes(message));
    assert.equal(kc.writes().length, 0, message);
    assert.equal(bao.writes().length, 0, message);
  }
  const disabled = fakeKeycloak();
  disabled.users.get(SEC).enabled = false;
  const untouched = fakeBao();
  await assert.rejects(createGuest({ request: REQUEST, settings: SETTINGS, keycloak: disabled.keycloak, bao: untouched.request, checkCredential: holds(), now: NOW }), /approver sec\.one's account is disabled/);
  const guestLead = fakeKeycloak();
  guestLead.groups.set(LEAD, [{ path: '/guests', name: 'guests' }]);
  await assert.rejects(createGuest({ request: REQUEST, settings: SETTINGS, keycloak: guestLead.keycloak, bao: untouched.request, checkCredential: holds(), now: NOW }), /lead\.one is a guest/);
  assert.equal(disabled.writes().length + guestLead.writes().length, 0);
  assert.equal(untouched.calls.length, 0, 'no OpenBao call before the Keycloak checks pass');
  // A rule refusal makes no call at all.
  const quiet = fakeKeycloak();
  const quietBao = fakeBao();
  await assert.rejects(createGuest({ request: { ...REQUEST, until: '2027-06-01T00:00:00Z' }, settings: SETTINGS, keycloak: quiet.keycloak, bao: quietBao.request, checkCredential: holds(), now: NOW }), /more than 90 days/);
  assert.equal(quiet.calls.length + quietBao.calls.length, 0);
});

const extendRequest = { ...REQUEST, until: '2027-01-15T17:00:00Z', approvalRef: 'VR-002' };

test('extend follows the create rules, moves the end, and brings an ended guest and its entity back; it never creates an entity', async () => {
  const kc = fakeKeycloak();
  const bao = fakeBao();
  enrolledGuest(kc, bao);
  await endGuest({ userId: 'kc-ada', reason: 'paused', keycloak: kc.keycloak, bao: bao.request, sessions: null, now: NOW, retentionDays: 365 });
  await assert.rejects(extendGuest({ request: { ...extendRequest, until: '2027-06-01T00:00:00Z' }, settings: SETTINGS, keycloak: kc.keycloak, bao: bao.request, checkCredential: holds(), now: NOW }), /more than 90 days/);
  await assert.rejects(extendGuest({ request: extendRequest, settings: SETTINGS, keycloak: kc.keycloak, bao: bao.request, checkCredential: async () => ({ ok: false, message: 'A cited credential is revoked.' }), now: NOW }), /revoked/);
  assert.equal(kc.users.get('kc-ada').enabled, false, 'refusals change nothing');
  const result = await extendGuest({ request: extendRequest, settings: SETTINGS, keycloak: kc.keycloak, bao: bao.request, checkCredential: holds(), now: NOW });
  const user = kc.users.get('kc-ada');
  assert.equal(user.enabled, true);
  assert.deepEqual(user.attributes, { guestUntil: ['2027-01-15T17:00:00Z'], guestRequestedBy: ['lead.one'], guestApprovedBy: ['sec.one'], guestApprovalRef: ['VR-002'] }, 'the ended attributes are cleared, the latest approval shown');
  assert.equal(bao.entities.get('guest-kc-ada').disabled, false);
  assert.equal(result.entity, 'enabled again');
  // A guest without an entity: extend reads and leaves OpenBao alone.
  kc.add({ id: 'kc-new', username: 'new.guest', email: 'guest-09@site.example', attributes: structuredClone(GUEST_ATTRS) }, { groupPaths: ['/guests'] });
  const before = bao.writes().length;
  await extendGuest({ request: { ...extendRequest, user: 'new.guest' }, settings: SETTINGS, keycloak: kc.keycloak, bao: bao.request, checkCredential: holds(), now: NOW });
  assert.equal(bao.writes().length, before);
  assert.ok(!bao.entities.has('guest-kc-new'));
});

test('extend refuses a guest who holds a realm-management role, another group, or an OpenBao policy', async () => {
  const kc = fakeKeycloak();
  const bao = fakeBao();
  enrolledGuest(kc, bao);
  kc.groups.set('kc-ada', [{ path: '/guests', name: 'guests' }, { path: '/staff', name: 'staff' }]);
  await assert.rejects(extendGuest({ request: extendRequest, settings: SETTINGS, keycloak: kc.keycloak, bao: bao.request, checkCredential: holds(), now: NOW }), /member of \/staff/);
  kc.groups.set('kc-ada', [{ path: '/guests', name: 'guests' }]);
  kc.roles = { 'kc-ada': { clientMappings: { 'realm-management': { mappings: [{ name: 'manage-users' }] } } } };
  await assert.rejects(extendGuest({ request: extendRequest, settings: SETTINGS, keycloak: kc.keycloak, bao: bao.request, checkCredential: holds(), now: NOW }), /realm-management role manage-users/);
  kc.roles = undefined;
  bao.entities.get('guest-kc-ada').policies = ['sterling-admin'];
  await assert.rejects(extendGuest({ request: extendRequest, settings: SETTINGS, keycloak: kc.keycloak, bao: bao.request, checkCredential: holds(), now: NOW }), /policy sterling-admin/);
  assert.equal(kc.writes().length, 0);
});

test('G449: this release has no reachable 71-12 card, so the example site file keeps guests off and create and extend refuse a nonzero maxDays before any call', async () => {
  // 71-12's credential-issuers policy is in this release, but its card is not reachable in a hosted session until G465 closes.
  assert.ok(POLICIES.includes('credential-issuers'), '71-12 ships its policy');
  assert.equal(CREDENTIAL_CARD_REACHABLE, false, 'when G465 closes, the change that closes it sets CREDENTIAL_CARD_REACHABLE and G449 closes after the lab run');
  assert.equal(credentialIssuingShipped(), false);
  const example = JSON.parse(readFileSync(path.join(ROOT, 'deploy/values/site.example/sterling-keycloak-realm.yaml'), 'utf8'));
  assert.equal(example.guests.maxDays, 0, 'the example ships guests off');
  const settings = guestSettings({ guests: { ...example.guests, maxDays: 90, issuing: true } });
  assert.equal(settings.issuing, false, 'the site file cannot claim the card is here');
  const kc = fakeKeycloak();
  const bao = fakeBao();
  await assert.rejects(createGuest({ request: REQUEST, settings, keycloak: kc.keycloak, bao: bao.request, checkCredential: holds(), now: NOW }), /Guests stay off on this release/);
  await assert.rejects(extendGuest({ request: REQUEST, settings, keycloak: kc.keycloak, bao: bao.request, checkCredential: holds(), now: NOW }), /Guests stay off on this release/);
  assert.equal(kc.calls.length, 0);
  assert.equal(bao.calls.length, 0);
});

test('guestStatus: pending-keys, active, overdue and ended', () => {
  const user = (attributes, enabled = true) => ({ enabled, attributes });
  assert.equal(guestStatus(user({ guestUntil: [UNTIL] }), 1, NOW), 'pending-keys');
  assert.equal(guestStatus(user({ guestUntil: [UNTIL] }), 2, NOW), 'active');
  assert.equal(guestStatus(user({ guestUntil: ['2026-11-01T00:00:00Z'] }), 2, NOW), 'overdue');
  assert.equal(guestStatus(user({}), 2, NOW), 'overdue', 'no end date counts as overdue');
  assert.equal(guestStatus(user({ guestUntil: [UNTIL] }, false), 2, NOW), 'ended');
  assert.equal(guestStatus(user({ guestUntil: [UNTIL], guestEndedAt: ['2026-11-20T00:00:00Z'] }), 2, NOW), 'ended');
});

test('list gives each guest with the end, status, lead and approver, and writes nothing', async () => {
  const kc = fakeKeycloak();
  const bao = fakeBao();
  enrolledGuest(kc, bao);
  kc.add({ id: 'kc-new', username: 'new.guest', email: 'guest-09@site.example', attributes: structuredClone(GUEST_ATTRS) }, { groupPaths: ['/guests'], keys: ['k1'] });
  const rows = await listGuests({ keycloak: kc.keycloak, now: NOW });
  assert.deepEqual(rows.map((row) => [row.username, row.until, row.status, row.requestedBy, row.approvedBy]),
    [['ada.observer', UNTIL, 'active', 'lead.one', 'sec.one'], ['new.guest', UNTIL, 'pending-keys', 'lead.one', 'sec.one']]);
  assert.equal(kc.writes().length, 0);
});

test('expireGuests ends the overdue, fails closed on a role, a group or an OpenBao policy, and skips an end moved into the future', async () => {
  const kc = fakeKeycloak();
  const bao = fakeBao();
  const sessions = fakeSessions();
  const guest = (id, attributes, extra = {}) => {
    kc.add({ id, username: id.replace('kc-', ''), email: `${id}@guests.site.example`, attributes: { ...structuredClone(GUEST_ATTRS), ...attributes } }, { groupPaths: ['/guests'], keys: ['k1', 'k2'], ...extra });
    return bao.addEntity(`guest-${id}`, { metadata: { keycloak_user_id: id, account: 'guest' } });
  };
  guest('kc-late', { guestUntil: ['2026-11-24T11:00:00Z'] });
  guest('kc-fine', {});
  guest('kc-admin', {});
  kc.roles = { 'kc-admin': { clientMappings: { 'realm-management': { mappings: [{ name: 'view-users' }] } } } };
  guest('kc-grouped', {}, { groupPaths: ['/guests', '/staff'] });
  guest('kc-policy', {}).policies = ['sterling-admin'];
  guest('kc-own', {}).policies = ['guest-account'];
  guest('kc-moved', { guestUntil: ['2026-11-24T11:00:00Z'] });
  kc.beforeRead = { 'kc-moved': (user) => { user.attributes.guestUntil = ['2026-12-31T00:00:00Z']; } };
  const result = await expireGuests({ keycloak: kc.keycloak, bao: bao.request, sessions, now: NOW, job: 'sterling-guest-expiry', retentionDays: 365 });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.ended.map((entry) => [entry.username, entry.reason]).sort(), [
    ['admin', 'holds the realm-management role view-users'], ['grouped', 'member of /staff'], ['late', 'end date 2026-11-24T11:00:00Z passed'], ['policy', 'OpenBao entity holds the policy sterling-admin']].sort());
  assert.deepEqual(result.skipped.map((entry) => entry.username), ['moved']);
  for (const id of ['kc-late', 'kc-admin', 'kc-grouped', 'kc-policy']) assert.equal(kc.users.get(id).enabled, false, id);
  for (const id of ['kc-fine', 'kc-moved', 'kc-own']) assert.equal(kc.users.get(id).enabled, true, id);
  assert.deepEqual(result.unchecked, []);
  assert.equal(sessions.stopped.length, 4);
  // Fail-closed ends before the end date are early, so they file a revocation request; the date end does not.
  const requests = [...bao.kv.keys()].filter((key) => key.includes('revocation-requests')).sort();
  assert.deepEqual(requests, ['kv/data/site/revocation-requests/guest-kc-admin-guest-ended', 'kv/data/site/revocation-requests/guest-kc-grouped-guest-ended', 'kv/data/site/revocation-requests/guest-kc-policy-guest-ended']);
  assert.equal(bao.kv.get(requests[0]).job, 'sterling-guest-expiry');
});

test('expireGuests still ends on the Keycloak side when OpenBao fails, reports the failure, and goes on to the next guest', async () => {
  const kc = fakeKeycloak();
  const bao = fakeBao();
  for (const id of ['kc-one', 'kc-two']) kc.add({ id, username: id.slice(3), email: `${id}@guests.site.example`, attributes: { ...structuredClone(GUEST_ATTRS), guestUntil: ['2026-11-01T00:00:00Z'] } }, { groupPaths: ['/guests'] });
  const sealed = async (method, apiPath, body) => (apiPath.startsWith('identity/') ? { status: 503, data: { errors: ['sealed'] } } : bao.request(method, apiPath, body));
  const result = await expireGuests({ keycloak: kc.keycloak, bao: sealed, sessions: null, now: NOW, retentionDays: 365 });
  assert.deepEqual(result.ended.map((entry) => entry.username).sort(), ['one', 'two']);
  assert.equal(kc.users.get('kc-one').enabled, false);
  assert.equal(kc.users.get('kc-two').enabled, false);
  assert.ok(result.failures.length >= 2 && result.failures.every((failure) => /OpenBao/.test(failure)), JSON.stringify(result.failures));
});

test('expireGuests lists a guest whose fail-closed check could not run as unchecked, never as fine, and reports the failure', async () => {
  const kc = fakeKeycloak();
  const bao = fakeBao();
  kc.add({ id: 'kc-ada', username: 'ada.observer', email: 'kc-ada@guests.site.example', attributes: structuredClone(GUEST_ATTRS) }, { groupPaths: ['/guests'] });
  kc.add({ id: 'kc-late', username: 'late', email: 'kc-late@guests.site.example', attributes: { ...structuredClone(GUEST_ATTRS), guestUntil: ['2026-11-01T00:00:00Z'] } }, { groupPaths: ['/guests'] });
  const sealed = async (method, apiPath, body) => (apiPath.startsWith('identity/entity/name/') && method === 'GET' ? { status: 503, data: { errors: ['sealed'] } } : bao.request(method, apiPath, body));
  const result = await expireGuests({ keycloak: kc.keycloak, bao: sealed, sessions: null, now: NOW, retentionDays: 365 });
  assert.deepEqual(result.unchecked.map((entry) => entry.username), ['ada.observer']);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.ended.map((entry) => entry.username), ['late'], 'a guest past the end is still ended');
  assert.ok(result.failures.some((failure) => /^ada\.observer: OpenBao/.test(failure)), JSON.stringify(result.failures));
  assert.equal(kc.users.get('kc-ada').enabled, true, 'not ended for a failed read');
});

// ---- 47-34 (D-84): the end record that starts the retention period ----

test('every end of an enrolled guest files one create-only end record; a second end files nothing new; a never-enrolled guest gets none', async () => {
  const kc = fakeKeycloak();
  const bao = fakeBao();
  enrolledGuest(kc, bao);
  const first = await endGuest({ userId: 'kc-ada', reason: 'visit over', keycloak: kc.keycloak, bao: bao.request, sessions: null, now: NOW, retentionDays: 365 });
  assert.deepEqual(first.failures, []);
  assert.ok(first.steps.includes('end record filed'));
  assert.deepEqual(bao.kv.get('kv/data/site/guest-ended/guest-kc-ada-20261124T120000Z'), END_RECORD);
  const second = await endGuest({ userId: 'kc-ada', reason: 'again', keycloak: kc.keycloak, bao: bao.request, sessions: null, now: NOW + 3_600_000, retentionDays: 365 });
  assert.deepEqual(second.failures, []);
  assert.ok(second.steps.includes('end record already filed'), 'the recorded end time names the same record');
  assert.equal([...bao.kv.keys()].filter((key) => key.includes('guest-ended')).length, 1);
});

test('without guests.retentionDays no end record is filed, the end says so, and no guest can be created', async () => {
  const kc = fakeKeycloak();
  const bao = fakeBao();
  enrolledGuest(kc, bao);
  const result = await endGuest({ userId: 'kc-ada', reason: 'visit over', keycloak: kc.keycloak, bao: bao.request, sessions: null, now: NOW });
  assert.match(result.failures.join('\n'), /guests\.retentionDays is not set/);
  assert.equal(kc.users.get('kc-ada').enabled, false, 'the end itself still happens');
  assert.equal([...bao.kv.keys()].filter((key) => key.includes('guest-ended')).length, 0);
  assert.match(checkGuestRequest(REQUEST, { ...SETTINGS, retentionDays: 0 }, NOW).problems.join('\n'), /Set guests\.retentionDays/);
});

// --- The automatic end in the cluster (47-20): expire --in-cluster -----------------------------------------------------------------------

const IN_CLUSTER_ENV = Object.freeze({ KEYCLOAK_URL: 'https://keycloakx-http.sterling-identity.svc:8443', KEYCLOAK_REALM: 'sterling', GUEST_EXPIRY_CLIENT_ID: 'sterling-guest-expiry',
  GUEST_EXPIRY_CLIENT_SECRET_FILE: '/var/run/sterling-guest-expiry/client-secret', OPENBAO_ADDR: 'https://openbao.sterling-openbao.svc:8200', OPENBAO_JWT_ROLE: 'guest-expiry',
  SITE_CA_FILE: '/etc/site-ca/ca.crt', SESSIONS_NAMESPACE: 'theia-cloud', GUEST_RETENTION_DAYS: '365', KUBERNETES_SERVICE_HOST: '10.43.0.1', KUBERNETES_SERVICE_PORT: '443' });
const SECRET = 'the-client-secret-from-its-file';
/** The files the job's pod mounts. */
const podFiles = (file) => ({ '/var/run/sterling-guest-expiry/client-secret': `${SECRET}\n`, '/etc/site-ca/ca.crt': 'site CA', '/var/run/secrets/kubernetes.io/serviceaccount/token': 'sa-token',
  '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt': 'cluster CA' })[file];
/** The job's raw HTTP calls: Keycloak's token endpoint, OpenBao's jwt login and the Kubernetes API, each recorded. */
function podNetwork({ login = 200, sessions = [] } = {}) {
  const calls = [];
  const call = async (request) => {
    calls.push(structuredClone(request));
    if (request.url.endsWith('/realms/sterling/protocol/openid-connect/token')) return { status: 200, data: { access_token: 'expiry-access-token' } };
    if (request.url.endsWith('/v1/auth/jwt/login')) return login === 200 ? { status: 200, data: { auth: { client_token: 'bao-job-token' } } } : { status: login, data: { errors: ['permission denied'] } };
    if (request.method === 'GET' && request.url.endsWith('/apis/theia.cloud/v1beta8/namespaces/theia-cloud/sessions')) return { status: 200, data: { items: sessions } };
    if (request.method === 'DELETE' && request.url.includes('/apis/theia.cloud/v1beta8/namespaces/theia-cloud/sessions/')) return { status: 200, data: {} };
    return { status: 404, data: null };
  };
  return { call, calls };
}
const overdueGuest = (kc, bao, id = 'kc-late') => {
  kc.add({ id, username: id.slice(3), email: `${id}@guests.site.example`, attributes: { ...structuredClone(GUEST_ATTRS), guestUntil: ['2026-11-24T11:00:00Z'] } }, { groupPaths: ['/guests'], keys: ['k1', 'k2'] });
  bao.addEntity(`guest-${id}`, { metadata: { keycloak_user_id: id, account: 'guest' }, policies: ['guest-account'] });
};

test('expire --in-cluster asks Keycloak for its token with the secret only in the Basic header, logs in to OpenBao as guest-expiry, ends the guest and revokes its token', async () => {
  const kc = fakeKeycloak();
  const bao = fakeBao();
  overdueGuest(kc, bao);
  const network = podNetwork({ sessions: [{ metadata: { name: 's-late' }, spec: { user: 'kc-late@guests.site.example' } }, { metadata: { name: 's-staff' }, spec: { user: 'lead.one@site.example' } }] });
  const made = {};
  const result = await expireInCluster({ env: IN_CLUSTER_ENV, readFile: podFiles, call: network.call, now: NOW,
    makeKeycloak: (options) => { made.keycloak = options; return kc.keycloak; },
    makeBao: (options) => {
      made.bao = options;
      return async (method, apiPath, body) => {
        if (apiPath !== 'auth/token/revoke-self') return bao.request(method, apiPath, body);
        bao.calls.push({ method, path: apiPath, body });
        return { status: 204, data: null };
      };
    } });
  assert.deepEqual(result.errors, []);
  assert.equal(result.exit, 0);
  assert.deepEqual(result.lines, ['ended late: end date 2026-11-24T11:00:00Z passed']);
  const [token, login] = network.calls;
  assert.equal(token.url, 'https://keycloakx-http.sterling-identity.svc:8443/realms/sterling/protocol/openid-connect/token');
  assert.equal(token.headers.authorization, `Basic ${Buffer.from(`sterling-guest-expiry:${SECRET}`).toString('base64')}`);
  assert.equal(token.body, 'grant_type=client_credentials');
  for (const request of network.calls) {
    assert.equal(`${request.url} ${request.body ?? ''}`.includes(SECRET), false, 'the secret is never in a URL or a body');
  }
  assert.equal(login.url, 'https://openbao.sterling-openbao.svc:8200/v1/auth/jwt/login');
  assert.deepEqual(JSON.parse(login.body), { role: 'guest-expiry', jwt: 'expiry-access-token' });
  assert.deepEqual([made.keycloak.token, made.keycloak.caPem, made.bao.token], ['expiry-access-token', 'site CA', 'bao-job-token']);
  assert.equal(kc.users.get('kc-late').enabled, false);
  assert.equal(bao.entities.get('guest-kc-late').disabled, true);
  // Only the guest's Session record is deleted, with the ServiceAccount token; the Workspace and its volume are never touched.
  const kube = network.calls.filter((request) => request.url.startsWith('https://10.43.0.1:443/'));
  assert.deepEqual(kube.map((request) => `${request.method} ${request.url.slice('https://10.43.0.1:443'.length)}`), [
    'GET /apis/theia.cloud/v1beta8/namespaces/theia-cloud/sessions', 'DELETE /apis/theia.cloud/v1beta8/namespaces/theia-cloud/sessions/s-late']);
  assert.ok(kube.every((request) => request.headers.authorization === 'Bearer sa-token' && request.caPem === 'cluster CA'));
  assert.deepEqual(bao.calls.at(-1), { method: 'POST', path: 'auth/token/revoke-self', body: undefined });
});

test('expire --in-cluster with OpenBao\'s login refused still ends the guest in Keycloak, reports it and exits non-zero', async () => {
  const kc = fakeKeycloak();
  const bao = fakeBao();
  overdueGuest(kc, bao);
  const network = podNetwork({ login: 403 });
  const result = await expireInCluster({ env: IN_CLUSTER_ENV, readFile: podFiles, call: network.call, now: NOW, noSessions: true,
    makeKeycloak: () => kc.keycloak, makeBao: () => { throw new Error('no OpenBao client without a login'); } });
  assert.equal(result.exit, 1);
  assert.equal(kc.users.get('kc-late').enabled, false, 'the Keycloak side ends the guest');
  assert.equal(kc.users.get('kc-late').attributes.guestEndedReason[0], 'end date 2026-11-24T11:00:00Z passed');
  assert.match(result.errors.join('\n'), /OpenBao refused the login to role guest-expiry \(403/);
  assert.match(result.errors.join('\n'), /failed: late: OpenBao/);
  assert.equal(bao.entities.get('guest-kc-late').disabled, false, 'OpenBao was never reached');
  assert.ok(network.calls.every((request) => !request.url.includes('/apis/')), '--no-sessions skips Kubernetes');
});

test('expire --in-cluster refuses to start without its settings, and stops when Keycloak refuses the client', async () => {
  const { KEYCLOAK_URL: _url, ...withoutUrl } = IN_CLUSTER_ENV;
  const missing = await expireInCluster({ env: withoutUrl, readFile: podFiles, call: async () => { throw new Error('no call'); } });
  assert.deepEqual([missing.exit, missing.errors], [1, ['the job\'s settings are missing: KEYCLOAK_URL']]);
  const refused = await expireInCluster({ env: IN_CLUSTER_ENV, readFile: podFiles, call: async () => ({ status: 401, data: { error: 'unauthorized_client' } }) });
  assert.equal(refused.exit, 1);
  assert.match(refused.errors[0], /Keycloak refused the client credentials of sterling-guest-expiry in realm sterling: it answered 401/);
});

// --- The automatic end in the realm release (47-20): rendered only with guests on -------------------------------------------------------

const HELM = process.env.HELM || 'helm';
const CI_SITE = loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'));
const REALM_RELEASE = () => listReleases(ROOT).find((release) => release.name === 'sterling-keycloak-realm');
const EXAMPLE_REALM_SITE = JSON.parse(readFileSync(path.join(ROOT, 'deploy/values/site.example/sterling-keycloak-realm.yaml'), 'utf8'));
/** A site folder whose realm site file sets guests (as a site's own copy of the example would). */
const realmSiteDir = (guests) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'realm-site-'));
  writeFileSync(path.join(dir, 'sterling-keycloak-realm.yaml'), JSON.stringify({ ...EXAMPLE_REALM_SITE, guests: { ...EXAMPLE_REALM_SITE.guests, ...guests } }));
  return dir;
};
const renderRealm = (guests) => splitDocs(renderRelease(ROOT, REALM_RELEASE(), { site: CI_SITE, helm: HELM, ...(guests ? { siteDir: realmSiteDir(guests) } : {}) }));
const docOf = (docs, kind, name) => docs.find((doc) => new RegExp(`^kind: ${kind}$`, 'm').test(doc) && new RegExp(`^  name: ${name}$`, 'm').test(doc));

test('with guests off the realm release renders no CronJob, ServiceAccount, Role or RoleBinding, and the applier Job is as before (needs helm)', () => {
  const docs = renderRealm();
  assert.deepEqual(docs.map((doc) => /^kind: (\S+)$/m.exec(doc)[1]).sort(), ['ConfigMap', 'Job']);
  const job = docOf(docs, 'Job', 'sterling-keycloak-realm-\\w+');
  assert.doesNotMatch(job, /initContainers|guest-expiry-permission/);
  assert.match(job, /automountServiceAccountToken: false/);
  // The realm sets the client's secret from the same Secret the CronJob mounts.
  assert.match(job, /- name: STERLING_GUEST_EXPIRY_CLIENT_SECRET\n\s+valueFrom:\n\s+secretKeyRef: \{ name: sterling-guest-expiry, key: client-secret \}/);
});

test('with guests on the CronJob runs expire --in-cluster every checkMinutes, hardened, from the locked image, with its secret and the site CA (needs helm)', () => {
  const docs = renderRealm({ maxDays: 30, checkMinutes: 15, retentionDays: 365 });
  const cron = docOf(docs, 'CronJob', 'sterling-guest-expiry');
  assert.ok(cron, 'CronJob sterling-guest-expiry');
  assert.match(cron, /schedule: "\*\/15 \* \* \* \*"/);
  assert.match(cron, /concurrencyPolicy: Forbid/);
  assert.match(cron, /successfulJobsHistoryLimit: 3\n\s+failedJobsHistoryLimit: 3/);
  assert.match(cron, /image: "registry\.site\.example\/sterling\/guest-expiry@sha256:[0-9a-f]{64}"/);
  assert.match(cron, /args: \["expire", "--in-cluster"\]/);
  for (const setting of [/runAsNonRoot: true/, /readOnlyRootFilesystem: true/, /allowPrivilegeEscalation: false/, /drop: \[ALL\]/, /type: RuntimeDefault/, /limits:\n\s+memory: 128Mi/]) assert.match(cron, setting);
  assert.match(cron, /- name: client-secret\n\s+secret:\n\s+secretName: sterling-guest-expiry\n\s+defaultMode: 0400\n\s+items:\n\s+- \{ key: client-secret, path: client-secret \}/);
  assert.match(cron, /- name: site-ca\n\s+configMap:\n\s+name: sterling-site-ca/);
  const env = Object.fromEntries([...cron.matchAll(/- name: ([A-Z_]+)\n\s+value: "?([^"\n]*)"?/g)].map((match) => [match[1], match[2]]));
  assert.deepEqual(env, { KEYCLOAK_URL: 'https://keycloakx-http.sterling-identity.svc:8443', KEYCLOAK_REALM: 'sterling', GUEST_EXPIRY_CLIENT_ID: 'sterling-guest-expiry',
    GUEST_EXPIRY_CLIENT_SECRET_FILE: '/var/run/sterling-guest-expiry/client-secret', OPENBAO_ADDR: 'https://openbao.sterling-openbao.svc:8200', OPENBAO_JWT_ROLE: 'guest-expiry',
    SITE_CA_FILE: '/etc/site-ca/ca.crt', SESSIONS_NAMESPACE: 'theia-cloud', GUEST_RETENTION_DAYS: '365' });
  assert.throws(() => renderRealm({ maxDays: 30, checkMinutes: 60 }), /guests\.checkMinutes must be a whole number of minutes from 1 to 59/);
});

test('with guests on the Role allows only get, list and delete on Session records in the sessions namespace, and only the CronJob pod mounts a token (needs helm)', () => {
  const docs = renderRealm({ maxDays: 30 });
  const role = docOf(docs, 'Role', 'sterling-guest-expiry');
  assert.match(role, /namespace: "theia-cloud"/);
  assert.equal(role.slice(role.indexOf('rules:')).trim(), 'rules:\n  - apiGroups: ["theia.cloud"]\n    resources: ["sessions"]\n    verbs: ["get", "list", "delete"]');
  const binding = docOf(docs, 'RoleBinding', 'sterling-guest-expiry');
  assert.match(binding, /namespace: "theia-cloud"/);
  assert.match(binding, /subjects:\n\s+- kind: ServiceAccount\n\s+name: sterling-guest-expiry\n\s+namespace: sterling-identity/);
  assert.match(docOf(docs, 'ServiceAccount', 'sterling-guest-expiry'), /automountServiceAccountToken: false/);
  assert.equal(docs.filter((doc) => /kind: (ClusterRole|ClusterRoleBinding)\b/.test(doc)).length, 0);
  const cron = docOf(docs, 'CronJob', 'sterling-guest-expiry');
  assert.match(cron, /serviceAccountName: sterling-guest-expiry\n\s+# [^\n]*\n\s+automountServiceAccountToken: true/);
  // The applier Job runs keycloak-config-cli first, then the permission step, and mounts no ServiceAccount token.
  const job = docOf(docs, 'Job', 'sterling-keycloak-realm-\\w+');
  assert.match(job, /automountServiceAccountToken: false/);
  assert.match(job, /initContainers:\n\s+- name: keycloak-config-cli[\s\S]*\n {6}containers:\n\s+- name: guest-expiry-permission\n\s+image: "registry\.site\.example\/sterling\/guest-expiry@sha256:[0-9a-f]{64}"/);
  assert.match(job, /command: \["node", "\/opt\/sterling\/deploy\/keycloak\/admin-permissions\.mjs"\]/);
});

test('apply.mjs hands helm the realm site file it checked, and the example only when none is given', () => {
  const release = REALM_RELEASE();
  const own = path.join(realmSiteDir({ maxDays: 30 }), 'sterling-keycloak-realm.yaml');
  assert.equal(releaseValueFiles(release, own).at(-1), own);
  assert.equal(releaseValueFiles(release).at(-1), path.join(ROOT, 'deploy/values/site.example/sterling-keycloak-realm.yaml'));
  assert.deepEqual(releaseValueFiles(release, own).slice(0, -1), [path.join(ROOT, 'deploy/values/sterling-keycloak-realm.yaml')]);
});
