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
import { checkGuestRequest, createGuest, endGuest, expireGuests, extendGuest, guestStatus, linkGuest, listGuests, GuestRefusal, REVOCATION_FORMAT } from '../keycloak/guests.mjs';
import { enrolPerson } from '../openbao/enrol.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = Date.parse('2026-11-24T12:00:00Z');
const UNTIL = '2026-12-20T17:00:00Z';
const SETTINGS = { maxDays: 90, checkMinutes: 15, sessionsNamespace: 'theia-cloud' };
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
    if (apiPath === 'identity/lookup/entity') return { status: 204, data: null };
    if (apiPath === 'identity/entity') { const entity = addEntity(body.name, { metadata: body.metadata }); return reply(200, { id: entity.id, name: entity.name }); }
    if (apiPath === 'identity/entity-alias') return reply(200, { id: 'alias-1' });
    if (apiPath.startsWith('transit/keys/')) return method === 'GET' ? { status: 404, data: { errors: [] } } : { status: 204, data: null };
    if (apiPath === 'sys/capabilities-self') return reply(200, Object.fromEntries(body.paths.map((where) => [where, where.startsWith('kv/data/site/revocation-requests/guest-') ? ['create'] : ['deny']])));
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
  const result = await endGuest({ userId: 'kc-ada', reason: 'visit over', early: false, keycloak: kc.keycloak, bao: bao.request, sessions, now: NOW });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(kc.writes().map((call) => `${call.method} ${call.path}`), ['PUT users/kc-ada', 'POST users/kc-ada/logout', 'PUT users/kc-ada']);
  assert.equal(kc.writes()[0].body.enabled, false);
  const recorded = kc.users.get('kc-ada');
  assert.equal(recorded.enabled, false);
  assert.deepEqual(recorded.attributes, { ...GUEST_ATTRS, guestEndedAt: ['2026-11-24T12:00:00Z'], guestEndedReason: ['visit over'] }, 'the other guest attributes survive the end');
  assert.deepEqual(bao.writes().map((call) => [call.method, call.path, call.body]), [['POST', 'identity/entity/name/guest-kc-ada', { disabled: true }]]);
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
  const first = await endGuest({ userId: 'kc-ada', reason: 'left early', early: true, job: 'guests.mjs end', keycloak: kc.keycloak, bao: bao.request, sessions: null, now: NOW });
  assert.deepEqual(first.failures, []);
  assert.equal(first.request, 'filed');
  const where = 'kv/data/site/revocation-requests/guest-kc-ada-guest-ended';
  const write = bao.calls.find((call) => call.path === where);
  assert.deepEqual(write.body.options, { cas: 0 });
  assert.deepEqual(write.body.data, { format: REVOCATION_FORMAT, entity: 'guest-kc-ada', keycloakId: 'kc-ada', reason: 'guest-ended', seenAt: '2026-11-24T12:00:00Z', job: 'guests.mjs end' });
  const second = await endGuest({ userId: 'kc-ada', reason: 'again', early: true, job: 'sterling-guest-expiry', keycloak: kc.keycloak, bao: bao.request, sessions: null, now: NOW + 60_000 });
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
  const result = await endGuest({ userId: 'kc-new', reason: 'cancelled', early: true, keycloak: kc.keycloak, bao: bao.request, sessions: null, now: NOW });
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
  await endGuest({ userId: 'kc-ada', reason: 'paused', keycloak: kc.keycloak, bao: bao.request, sessions: null, now: NOW });
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
  guest('kc-moved', { guestUntil: ['2026-11-24T11:00:00Z'] });
  kc.beforeRead = { 'kc-moved': (user) => { user.attributes.guestUntil = ['2026-12-31T00:00:00Z']; } };
  const result = await expireGuests({ keycloak: kc.keycloak, bao: bao.request, sessions, now: NOW, job: 'sterling-guest-expiry' });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.ended.map((entry) => [entry.username, entry.reason]).sort(), [
    ['admin', 'holds the realm-management role view-users'], ['grouped', 'member of /staff'], ['late', 'end date 2026-11-24T11:00:00Z passed'], ['policy', 'OpenBao entity holds the policy sterling-admin']].sort());
  assert.deepEqual(result.skipped.map((entry) => entry.username), ['moved']);
  for (const id of ['kc-late', 'kc-admin', 'kc-grouped', 'kc-policy']) assert.equal(kc.users.get(id).enabled, false, id);
  for (const id of ['kc-fine', 'kc-moved']) assert.equal(kc.users.get(id).enabled, true, id);
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
  const result = await expireGuests({ keycloak: kc.keycloak, bao: sealed, sessions: null, now: NOW });
  assert.deepEqual(result.ended.map((entry) => entry.username).sort(), ['one', 'two']);
  assert.equal(kc.users.get('kc-one').enabled, false);
  assert.equal(kc.users.get('kc-two').enabled, false);
  assert.ok(result.failures.length >= 2 && result.failures.every((failure) => /OpenBao/.test(failure)), JSON.stringify(result.failures));
});
