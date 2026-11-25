// HQ and edge federation by signed file (D-08, D-36, D-49, D-50): people with their passwordless keys, the site intermediate and revocation
// lists cross between sites only as files signed with your organization's key, and every import checks the signature (and the format and
// relying-party id, or the chain to the HQ root) before any Keycloak or OpenBao call or file write. Keycloak and OpenBao are fakes that count
// their calls. The optional HQ broker (D-36) renders off unless the realm site file turns it on, and only links people who exist. Needs the
// pinned cosign ($COSIGN or PATH) and openssl; fails, never skips, without them.
// Run: env COSIGN=compliance/out/tools/cosign node scripts/run-tests.mjs deploy/test/federation.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cosignBinary } from '../bundle/lib/cosign.mjs';
import { loadSite } from '../bundle/lib/render.mjs';
import { signFile, verifySignedFile } from '../bundle/signed-file.mjs';
import { HQ_BROKER, HQ_FIRST_LOGIN_FLOW, HQ_SECRET_ENV, checkRealm, prepareRealm } from '../keycloak/apply.mjs';
import { FORMAT, PASSWORDLESS, STORED_FIELDS, USERS_FEATURES, exportUsers, exportUsersToFile, importUsers } from '../keycloak/users.mjs';
import { SITE_EXPORT_PURPOSE, verifyEnvelope as verifyCopy } from '../keycloak/site-evidence.mjs';
import { fingerprintOf, signingInput, verifyEnvelope } from '../../compliance/src/signed.ts';
import { MOUNT, exportCrl, importCrl, importIntermediate, pemBlocks, requestIntermediate } from '../openbao/pki-files.mjs';

process.env.COSIGN_PASSWORD = 'federation-test';
const DIR = mkdtempSync(path.join(tmpdir(), 'federation-'));
const key = (prefix) => ({ private: path.join(DIR, `${prefix}.key`), public: path.join(DIR, `${prefix}.pub`) });
const ORG = key('organization');
const OTHER = key('other');
const RP_ID = 'sterling.example';

before(() => {
  for (const prefix of ['organization', 'other']) {
    const run = spawnSync(cosignBinary(), ['generate-key-pair', '--output-key-prefix', prefix], { cwd: DIR, encoding: 'utf8' });
    assert.ok(!run.error, `cosign was not found (${cosignBinary()}); set COSIGN to the pinned cosign (sh compliance/ci/install-tool.sh cosign compliance/out/tools).`);
    assert.equal(run.status, 0, run.stderr);
  }
});

let serial = 0;
const scratch = (name) => path.join(DIR, `${(serial += 1)}-${name}`);

// --- Keycloak -----------------------------------------------------------------------------------------------------------------------

const DISPLAY = { authenticatorProvider: 'YubiKey 5 Series', iconLight: 'data:image/svg+xml;base64,AA==', iconDark: 'data:image/svg+xml;base64,AA==' };
const webauthn = (credentialId, label) => ({ type: PASSWORDLESS, userLabel: label, createdDate: 1764000000000, secretData: '{}',
  credentialData: JSON.stringify({ aaguid: 'ee882879-721c-4913-9775-3dfcce97072a', credentialId, counter: 7, credentialPublicKey: `pk-${credentialId}`, attestationStatementFormat: 'none', transports: ['usb'] }) });

/**
 * A Keycloak realm behind the admin REST paths users.mjs calls. Like Keycloak 26.8.2 (spike S6, the 47-14 tracer): GET credentials adds the
 * display fields and leaves out secretData, and user creation refuses a credential that carries display fields or has no secretData. PUT
 * with credentials adds them. Every call is recorded.
 */
function fakeKeycloak(people = []) {
  const calls = [];
  const users = new Map(people.map((person, index) => [`id-${index}`, { ...person, id: `id-${index}`, credentials: person.credentials ?? [] }]));
  const storable = (credentials) => credentials.every((credential) => typeof credential.secretData === 'string'
    && !Object.keys(JSON.parse(credential.credentialData)).some((field) => !STORED_FIELDS.includes(field)));
  const admin = async (method, apiPath, body) => {
    calls.push(`${method} ${apiPath}`);
    const [route, query] = apiPath.split('?');
    const parts = route.split('/');
    if (method === 'GET' && route === 'users') {
      const name = new URLSearchParams(query).get('username').toLowerCase();
      return { status: 200, data: [...users.values()].filter((user) => user.username === name).map(({ credentials, groups, ...user }) => user) };
    }
    // The groups of a person (47-21: a member of /guests is a guest); people made without groups belong to none.
    if (method === 'GET' && parts[2] === 'groups') return { status: 200, data: (users.get(parts[1]).groups ?? []).map((groupPath) => ({ path: groupPath, name: groupPath.slice(1) })) };
    if (method === 'GET' && parts[2] === 'credentials') {
      return { status: 200, data: users.get(parts[1]).credentials.map(({ secretData, ...credential }, index) => ({ id: `${parts[1]}-c${index}`, ...credential,
        credentialData: JSON.stringify({ ...JSON.parse(credential.credentialData), ...DISPLAY }) })) };
    }
    if (method === 'POST' && route === 'users') {
      if (!storable(body.credentials ?? [])) return { status: 500, data: { error: 'Cannot parse the JSON' } };
      const id = `id-${users.size}`;
      users.set(id, { ...body, username: body.username.toLowerCase(), id, credentials: body.credentials ?? [], groups: body.groups ?? [] });
      return { status: 201, data: null };
    }
    if (method === 'PUT' && parts.length === 2) {
      if (!storable(body.credentials ?? [])) return { status: 500, data: { error: 'Cannot parse the JSON' } };
      users.get(parts[1]).credentials.push(...(body.credentials ?? []));
      return { status: 204, data: null };
    }
    return { status: 404, data: null };
  };
  return { admin, calls, users };
}

const ADA = { username: 'ada', email: 'ada@sterling.example', firstName: 'Ada', lastName: 'Lovelace', enabled: true, emailVerified: true,
  credentials: [webauthn('Y3JlZC1vbmU', 'blue key'), webauthn('Y3JlZC10d28', 'phone')] };

/** Writes a document and signs it; returns the file path. */
const signedDocument = (document, { signWith = ORG } = {}) => {
  const file = scratch('users.json');
  writeFileSync(file, JSON.stringify(document));
  signFile(file, signWith.private);
  return file;
};

/** The export of Ada at site A, signed. */
async function exportedAda(change = (document) => document) {
  const hq = fakeKeycloak([ADA]);
  const document = await exportUsers(hq.admin, { usernames: ['ada'], sourceSite: 'hq', rpId: RP_ID, created: '2026-11-24T00:00:00.000Z' });
  return signedDocument(change(document));
}

test('a person and both passwordless keys move by a verified signed file, and a second import changes nothing', async () => {
  const file = await exportedAda();
  const document = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(document.format, FORMAT);
  // 47 D-69: people alone need no feature, so a site on 47-14 alone still imports this file; this import reads guests@1 (47-21).
  assert.deepEqual(document.requires, []);
  assert.deepEqual(USERS_FEATURES, ['guests@1']);
  for (const credential of document.users[0].credentials) assert.deepEqual(Object.keys(JSON.parse(credential.credentialData)), STORED_FIELDS);
  const edge = fakeKeycloak();
  const imported = await importUsers(edge.admin, { file, publicKey: ORG.public, rpId: RP_ID });
  assert.deepEqual(imported, { ok: true, results: [{ username: 'ada', result: 'created', added: 2, skipped: 0 }] });
  const ada = [...edge.users.values()][0];
  assert.deepEqual([ada.username, ada.email, ada.requiredActions], ['ada', ADA.email, []]);
  assert.deepEqual(ada.credentials.map((credential) => JSON.parse(credential.credentialData)), ADA.credentials.map((credential) => JSON.parse(credential.credentialData)));
  assert.deepEqual(ada.credentials.map((credential) => credential.userLabel), ['blue key', 'phone']);
  const again = await importUsers(edge.admin, { file, publicKey: ORG.public, rpId: RP_ID });
  assert.deepEqual(again.results, [{ username: 'ada', result: 'unchanged', added: 0, skipped: 2 }]);
  assert.equal(edge.calls.filter((call) => !call.startsWith('GET')).length, 1, edge.calls.join(', '));
});

test('a person already here gets only the keys they lack; a person of the same username with another email gets none', async () => {
  const file = await exportedAda();
  const edge = fakeKeycloak([{ ...ADA, credentials: [ADA.credentials[0]] }]);
  assert.deepEqual((await importUsers(edge.admin, { file, publicKey: ORG.public, rpId: RP_ID })).results, [{ username: 'ada', result: 'keys added', added: 1, skipped: 1 }]);
  assert.equal(edge.users.get('id-0').credentials.length, 2);
  const other = fakeKeycloak([{ ...ADA, email: 'someone.else@sterling.example', credentials: [] }]);
  await assert.rejects(importUsers(other.admin, { file, publicKey: ORG.public, rpId: RP_ID }), /exists here with another email/);
  assert.deepEqual(other.calls.filter((call) => !call.startsWith('GET')), []);
});

for (const [name, makeFile] of [
  ['a file changed after signing', async () => {
    const file = await exportedAda();
    const document = JSON.parse(readFileSync(file, 'utf8'));
    document.users[0].credentials.push(webauthn('YXR0YWNrZXI', 'attacker key'));
    writeFileSync(file, JSON.stringify(document));
    return file;
  }],
  ['a file signed with another key', async () => signedDocument(JSON.parse(readFileSync(await exportedAda(), 'utf8')), { signWith: OTHER })],
  ['a file of an unknown format', () => exportedAda((document) => ({ ...document, format: 'sterling-users/2' }))],
  ['a file from another relying-party id', () => exportedAda((document) => ({ ...document, rpId: 'other.example' }))],
  // 47 D-69: requires is part of sterling-users/1 from its first version; a file without it, or with a malformed list, is refused whole.
  ['a file with no requires list', () => exportedAda(({ requires: _requires, ...document }) => document)],
  ['a file whose requires is not a list', () => exportedAda((document) => ({ ...document, requires: 'guests@1' }))],
  ['a file whose requires is not sorted and unique', () => exportedAda((document) => ({ ...document, requires: ['marking@1', 'guests@1'] }))],
  ['a file whose requires holds something other than name@N ids', () => exportedAda((document) => ({ ...document, requires: ['guests'] }))],
  ['a file carrying a password credential', () => exportedAda((document) => {
    document.users[0].credentials.push({ type: 'password', credentialData: '{"hashIterations":1}', secretData: '{"value":"x"}' });
    return document;
  })]
]) {
  test(`${name} is refused with zero Keycloak calls`, async () => {
    const file = await makeFile();
    const edge = fakeKeycloak();
    const result = await importUsers(edge.admin, { file, publicKey: ORG.public, rpId: RP_ID });
    assert.equal(result.ok, false);
    assert.ok(result.reason);
    assert.deepEqual(edge.calls, []);
  });
}

test('a file needing a feature this import does not read is refused whole, naming it, with zero Keycloak calls', async () => {
  // A site on 47-14 alone reads no feature (USERS_FEATURES []): a file naming a guest needs guests@1, so such a site never makes the guest an
  // ordinary member (T-47-125). This release reads guests@1 but not a later id.
  for (const [features, needs] of [[[], 'guests@1'], [USERS_FEATURES, 'marking@1']]) {
    const file = await exportedAda((document) => ({ ...document, requires: [needs] }));
    const edge = fakeKeycloak();
    const result = await importUsers(edge.admin, { file, publicKey: ORG.public, rpId: RP_ID, features });
    assert.equal(result.ok, false);
    assert.match(result.reason, new RegExp(`needs ${needs}, which this site's import does not read`));
    assert.deepEqual(edge.calls, []);
    assert.equal(edge.users.size, 0);
  }
});

// --- Guests between sites (47-21, D-64, 47 D-69) ----------------------------------------------------------------------------------------

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const DAY = 86_400_000;
const GUEST_UNTIL = '2026-12-20T17:00:00Z';
const GUEST_DID = 'did:key:z6MkfictionalAdaObserverKey0000000000000000000000';
// The source site's guest: lifecycle attributes only (47-19), two passwordless keys, a member of /guests.
const ADA_GUEST = { username: 'ada.observer', email: 'ada.observer@guests.sterling.example', firstName: 'Ada', lastName: 'Observer', enabled: true, emailVerified: false,
  groups: ['/guests'], attributes: { guestUntil: [GUEST_UNTIL], guestRequestedBy: ['lead.hq'], guestApprovedBy: ['sec.hq'], guestApprovalRef: ['VR-001'] },
  credentials: [webauthn('Z3Vlc3Qtb25l', 'guest key 1'), webauthn('Z3Vlc3QtdHdv', 'guest key 2')] };
const didOf = async () => GUEST_DID;

// Site evidence exports (48-02's envelope, 48-11's schema 2): each site signs its own with its Ed25519 key, listed in the sites file (32.1 D-62).
const siteKey = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { privateKey, publicKey: raw.toString('base64url'), fingerprint: fingerprintOf(raw) };
};
const EDGE_KEY = siteKey();
const OTHER_SITE_KEY = siteKey();
const sitesFile = () => {
  const file = scratch('sites.json');
  writeFileSync(file, JSON.stringify({ sites: [
    { id: 'edge-1', name: 'Edge one', role: 'site', publicKey: EDGE_KEY.publicKey, fingerprint: EDGE_KEY.fingerprint },
    { id: 'edge-2', name: 'Edge two', role: 'site', publicKey: OTHER_SITE_KEY.publicKey, fingerprint: OTHER_SITE_KEY.fingerprint }] }));
  return file;
};
const signExport = (key, payload, signedAt) => {
  const unsigned = { v: 1, purpose: SITE_EXPORT_PURPOSE, signer: { fingerprint: key.fingerprint, publicKey: key.publicKey }, signedAt, payload };
  return { ...unsigned, sig: edSign(null, signingInput(SITE_EXPORT_PURPOSE, unsigned), key.privateKey).toString('base64url') };
};
/** A folder of site exports; each entry { key, site, ageDays, schema, users } becomes one signed file. */
const exportsFolder = (entries) => {
  const folder = scratch('site-exports');
  mkdirSync(folder);
  entries.forEach(({ key = EDGE_KEY, site = 'edge-1', ageDays = 1, schema = 2, users = ['guests@1'] }, index) => {
    const signedAt = new Date(NOW - ageDays * DAY).toISOString();
    const facts = schema === 2 ? { sterling: { release: '0.4.40', reads: { policy: ['work-areas@1'], ...(users ? { users } : {}) } } } : {};
    writeFileSync(path.join(folder, `export-${index}.json`), JSON.stringify(signExport(key, { schema, site, generatedAt: signedAt, facts }, signedAt)));
  });
  return folder;
};

/** Exports through the same path as the CLI: the target-site check, then Keycloak, then the signed file. */
const guestExport = async ({ people = [ADA, ADA_GUEST], usernames = ['ada', 'ada.observer'], includeGuests = ['ada.observer'], target } = {}) => {
  const hq = fakeKeycloak(people);
  const out = scratch('users-with-guests.json');
  const run = exportUsersToFile(hq.admin, { usernames, includeGuests, sourceSite: 'hq', rpId: RP_ID, out, key: ORG.private, didOf, now: NOW, created: '2026-11-24T00:00:00.000Z',
    target: target === undefined ? { site: 'edge-1', sitesFile: sitesFile(), siteExports: exportsFolder([{}]) } : target });
  return { hq, out, run };
};

test('export refuses a guest it is not told to include, an ended guest and a guest past their end, before writing any file (D-64)', async () => {
  for (const [people, usernames, includeGuests, pattern] of [
    [[ADA, ADA_GUEST], ['ada', 'ada.observer'], [], /ada\.observer is a guest\. Guests stay at their site unless you name them with --include-guests \(D-64\)/],
    [[ADA, { ...ADA_GUEST, enabled: false }], ['ada.observer'], ['ada.observer'], /ada\.observer's guest account has ended/],
    [[ADA, { ...ADA_GUEST, attributes: { ...ADA_GUEST.attributes, guestEndedAt: ['2026-11-20T00:00:00Z'] } }], ['ada.observer'], ['ada.observer'], /ada\.observer's guest account has ended/],
    [[ADA, { ...ADA_GUEST, attributes: { ...ADA_GUEST.attributes, guestUntil: ['2026-11-01T00:00:00Z'] } }], ['ada.observer'], ['ada.observer'], /ada\.observer's end date 2026-11-01T00:00:00Z has passed/],
    [[ADA, ADA_GUEST], ['ada'], ['ada'], /--include-guests names ada, who is not a guest here/]
  ]) {
    const { out, run } = await guestExport({ people, usernames, includeGuests });
    await assert.rejects(run, pattern);
    assert.equal(existsSync(out), false);
  }
});

test('a named guest travels with their end, lead, approver, approval and DID only, and the file needs guests@1; staff records are unchanged', async () => {
  const { out, run } = await guestExport();
  await run;
  assert.equal(verifySignedFile(out, ORG.public).ok, true);
  const document = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(document.requires, ['guests@1']);
  const [staff, guest] = document.users;
  assert.deepEqual(Object.keys(staff).sort(), ['credentials', 'email', 'emailVerified', 'enabled', 'firstName', 'lastName', 'username']);
  assert.deepEqual(guest.guest, { until: GUEST_UNTIL, requestedBy: 'lead.hq', approvedBy: 'sec.hq', approvalRef: 'VR-001' });
  assert.equal(guest.did, GUEST_DID);
  for (const field of ['serves', 'nationality', 'organization', 'agreements', 'attributes', 'groups']) {
    assert.equal(JSON.stringify(guest).includes(`"${field}"`), false, `${field} is a credential or Keycloak detail and never travels`);
  }
  assert.deepEqual(guest.credentials.map((credential) => JSON.parse(credential.credentialData).credentialId), ['Z3Vlc3Qtb25l', 'Z3Vlc3QtdHdv']);
  // Without a guest the file is as 47-14 wrote it, so a site on 47-14 alone still imports it.
  const plain = fakeKeycloak([ADA, ADA_GUEST]);
  const staffOnly = await exportUsers(plain.admin, { usernames: ['ada'], sourceSite: 'hq', rpId: RP_ID, created: '2026-11-24T00:00:00.000Z' });
  assert.deepEqual(staffOnly.requires, []);
  assert.equal(staffOnly.users[0].guest, undefined);
});

test('export --include-guests writes no file unless the target site\'s recent signed export shows its import reads guests@1 (T-47-125)', async () => {
  const sites = sitesFile();
  for (const [target, pattern] of [
    [{}, /--target-site, --sites and --site-exports/],
    [{ site: 'edge-9', sitesFile: sites, siteExports: exportsFolder([{}]) }, /edge-9 is not in your sites file/],
    [{ site: 'edge-1', sitesFile: sites, siteExports: exportsFolder([]) }, /edge-1 has no signed evidence export from the last 7 days/],
    [{ site: 'edge-1', sitesFile: sites, siteExports: exportsFolder([{ ageDays: 8 }]) }, /edge-1 has no signed evidence export from the last 7 days/],
    [{ site: 'edge-1', sitesFile: sites, siteExports: exportsFolder([{ schema: 1 }]) }, /edge-1's newest export does not say which release it runs/],
    [{ site: 'edge-1', sitesFile: sites, siteExports: exportsFolder([{ key: OTHER_SITE_KEY }]) }, /edge-1 has no signed evidence export from the last 7 days/],
    [{ site: 'edge-1', sitesFile: sites, siteExports: exportsFolder([{ users: [] }]) }, /edge-1 runs Sterling 0\.4\.40, whose user import does not read guests@1/],
    [{ site: 'edge-1', sitesFile: sites, siteExports: exportsFolder([{ users: null }]) }, /edge-1 runs Sterling 0\.4\.40, whose user import does not read guests@1/],
    // The newest verified export decides: an older one that read guests@1 does not outweigh a newer one that does not.
    [{ site: 'edge-1', sitesFile: sites, siteExports: exportsFolder([{ ageDays: 3 }, { ageDays: 1, users: [] }]) }, /does not read guests@1/]
  ]) {
    const { hq, out, run } = await guestExport({ target });
    await assert.rejects(run, pattern);
    assert.equal(existsSync(out), false);
    assert.deepEqual(hq.calls, [], 'the target is checked before Keycloak is asked anything');
  }
  const { out, run } = await guestExport({ target: { site: 'edge-1', sitesFile: sites, siteExports: exportsFolder([{ ageDays: 6 }]) } });
  await run;
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).requires, ['guests@1']);
});

test('the site export verifier deploy/ carries accepts and refuses exactly what compliance/src/signed.ts does', () => {
  const now = new Date(NOW);
  const good = signExport(EDGE_KEY, { schema: 2, site: 'edge-1', generatedAt: new Date(NOW).toISOString(), facts: {} }, new Date(NOW).toISOString());
  const keys = [{ fingerprint: EDGE_KEY.fingerprint, publicKey: EDGE_KEY.publicKey }];
  const changed = structuredClone(good);
  changed.payload.site = 'edge-2';
  for (const [envelope, options] of [[good, { keys }], [changed, { keys }], [good, { keys: [] }], [good, { keys, purpose: 'other' }], [{ ...good, signedAt: new Date(NOW + DAY).toISOString() }, { keys }], [{ ...good, v: 2 }, { keys }]]) {
    const opts = { purpose: SITE_EXPORT_PURPOSE, now, ...options };
    const ours = verifyCopy(envelope, opts);
    const theirs = verifyEnvelope(envelope, opts);
    assert.deepEqual({ ok: ours.ok, reason: ours.reason }, { ok: theirs.ok, reason: theirs.reason });
  }
  assert.equal(verifyCopy(good, { purpose: SITE_EXPORT_PURPOSE, now, keys }).ok, true);
});

/** The destination's approval and rules: lead.one asks, sec.one approves under a SecurityContactCredential the verifier tool accepts. */
const LEAD_EDGE = { username: 'lead.one', email: 'lead.one@sterling.example', firstName: 'Lead', lastName: 'One', enabled: true, credentials: [] };
const SEC_EDGE = { username: 'sec.one', email: 'sec.one@sterling.example', firstName: 'Sec', lastName: 'One', enabled: true, credentials: [] };
const edgeBao = () => {
  const calls = [];
  const bao = async (method, apiPath) => {
    calls.push(`${method} ${apiPath}`);
    if (apiPath === 'identity/entity/name/keycloak-id-1') return { status: 200, data: { data: { id: 'entity-sec-one' } } };
    if (apiPath === 'kv/data/site/people/entity-sec-one') return { status: 200, data: { data: { data: { did: 'did:key:z6MkfictionalSecOne' } } } };
    return { status: 404, data: null };
  };
  return { bao, calls };
};
const GUEST_RULES = { maxDays: 90, checkMinutes: 15, sessionsNamespace: 'theia-cloud', retentionDays: 365, issuing: true };
const guestImport = (overrides = {}) => ({ settings: GUEST_RULES, requestedBy: 'lead.one', approvedBy: 'sec.one', approverCredential: '/media/sec.one.credential.json',
  trust: '/media/trust', approvalRef: 'VR-002', bao: edgeBao().bao, checkCredential: () => ({ ok: true, message: 'holds' }), now: NOW, ...overrides });
const guestFile = async (change = (document) => document) => {
  const { out, run } = await guestExport();
  await run;
  return signedDocument(change(JSON.parse(readFileSync(out, 'utf8'))));
};

for (const [name, makeFile, options] of [
  ['a guest record that --include-guests does not name', () => guestFile(), { includeGuests: [] }],
  ['a guest record at a site whose guests are off', () => guestFile(), { includeGuests: ['ada.observer'], guests: guestImport({ settings: { ...GUEST_RULES, maxDays: 0 } }) }],
  ['a guest record at a site on a release without the credential card (71-12)', () => guestFile(), { includeGuests: ['ada.observer'], guests: guestImport({ settings: { ...GUEST_RULES, issuing: false } }) }],
  ['a guest record without the destination\'s approval reference', () => guestFile(), { includeGuests: ['ada.observer'], guests: guestImport({ approvalRef: '' }) }],
  ['a guest record whose end has passed', () => guestFile((document) => { document.users[1].guest.until = '2026-11-01T00:00:00Z'; return document; }), { includeGuests: ['ada.observer'], guests: guestImport() }],
  ['a guest record in a file whose requires does not name guests@1', () => guestFile((document) => ({ ...document, requires: [] })), { includeGuests: ['ada.observer'], guests: guestImport() }],
  ['a guest record carrying how the guest serves', () => guestFile((document) => { document.users[1].guest.serves = 'industry'; return document; }), { includeGuests: ['ada.observer'], guests: guestImport() }],
  ['a guest record without a DID', () => guestFile((document) => { delete document.users[1].did; return document; }), { includeGuests: ['ada.observer'], guests: guestImport() }]
]) {
  test(`import refuses ${name} with zero Keycloak calls`, async () => {
    const file = await makeFile();
    const edge = fakeKeycloak([LEAD_EDGE, SEC_EDGE]);
    const result = await importUsers(edge.admin, { file, publicKey: ORG.public, rpId: RP_ID, ...options });
    assert.equal(result.ok, false);
    assert.ok(result.reason);
    assert.deepEqual(edge.calls, []);
  });
}

test('import makes a named guest a guest here: in /guests, ending no later than the source and within this site\'s maxDays, under this site\'s approval', async () => {
  const file = await guestFile();
  const edge = fakeKeycloak([LEAD_EDGE, SEC_EDGE]);
  const result = await importUsers(edge.admin, { file, publicKey: ORG.public, rpId: RP_ID, includeGuests: ['ada.observer'], guests: guestImport() });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.results.map(({ username, result: outcome, added }) => [username, outcome, added]), [['ada', 'created', 2], ['ada.observer', 'created', 2]]);
  assert.deepEqual(result.results[1].guest, { until: GUEST_UNTIL, did: GUEST_DID });
  const guest = [...edge.users.values()].find((user) => user.username === 'ada.observer');
  assert.deepEqual(guest.groups, ['/guests']);
  assert.deepEqual(guest.attributes, { guestUntil: [GUEST_UNTIL], guestRequestedBy: ['lead.one'], guestApprovedBy: ['sec.one'], guestApprovalRef: ['VR-002'] });
  assert.deepEqual(guest.requiredActions, [], 'the keys arrive, so the registration action stays off');
  assert.deepEqual(guest.credentials.map((credential) => JSON.parse(credential.credentialData).credentialId), ['Z3Vlc3Qtb25l', 'Z3Vlc3QtdHdv']);
  assert.equal([...edge.users.values()].find((user) => user.username === 'ada').groups.length, 0, 'staff stay staff');
  // The end is the earlier of the source's and this site's longest stay.
  const shortStay = fakeKeycloak([LEAD_EDGE, SEC_EDGE]);
  await importUsers(shortStay.admin, { file, publicKey: ORG.public, rpId: RP_ID, includeGuests: ['ada.observer'], guests: guestImport({ settings: { ...GUEST_RULES, maxDays: 10 } }) });
  assert.deepEqual([...shortStay.users.values()].find((user) => user.username === 'ada.observer').attributes.guestUntil, [new Date(NOW + 10 * DAY).toISOString().replace('.000Z', 'Z')]);
  // A second import changes nothing; an approver whose credential does not hold stops the guest before any write.
  const again = await importUsers(edge.admin, { file, publicKey: ORG.public, rpId: RP_ID, includeGuests: ['ada.observer'], guests: guestImport() });
  assert.deepEqual(again.results.map(({ result: outcome }) => outcome), ['unchanged', 'unchanged']);
  const refused = fakeKeycloak([LEAD_EDGE, SEC_EDGE]);
  await assert.rejects(importUsers(refused.admin, { file, publicKey: ORG.public, rpId: RP_ID, includeGuests: ['ada.observer'], guests: guestImport({ checkCredential: () => ({ ok: false, message: 'A cited credential is revoked.' }) }) }),
    /sec\.one's SecurityContactCredential does not hold: A cited credential is revoked/);
  assert.deepEqual(refused.calls.filter((call) => !call.startsWith('GET')), []);
  // A staff account of the same name never becomes a guest, and gets no keys.
  const staffHere = fakeKeycloak([LEAD_EDGE, SEC_EDGE, { ...ADA_GUEST, groups: [], attributes: {}, credentials: [] }]);
  await assert.rejects(importUsers(staffHere.admin, { file, publicKey: ORG.public, rpId: RP_ID, includeGuests: ['ada.observer'], guests: guestImport() }), /ada\.observer has an account here that is not a guest/);
  assert.deepEqual(staffHere.calls.filter((call) => !call.startsWith('GET')), []);
});

// --- PKI intermediate and revocation lists --------------------------------------------------------------------------------------------

const openssl = (...args) => {
  const run = spawnSync('openssl', args, { cwd: DIR, encoding: 'utf8' });
  assert.ok(!run.error, 'openssl was not found; it makes the test certificates.');
  assert.equal(run.status, 0, run.stderr);
};
const pem = (name) => readFileSync(path.join(DIR, name), 'utf8');
const serialNumber = () => `0x${randomBytes(12).toString('hex')}`;
/** A self-signed CA, standing in for HQ's offline root (made in the key ceremony). */
const makeRoot = (name) => openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.pem`,
  '-subj', `/CN=${name}`, '-days', '3650', '-set_serial', serialNumber(), '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
/** A certificate for a new key, signed by `root`: a CA certificate unless `ca` is false. */
function issue(root, name, { ca = true } = {}) {
  openssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-384', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
  writeFileSync(path.join(DIR, `${name}.ext`), ca ? 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n' : 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n');
  openssl('x509', '-req', '-in', `${name}.csr`, '-CA', `${root}.pem`, '-CAkey', `${root}.key`, '-days', '365', '-set_serial', serialNumber(), '-extfile', `${name}.ext`, '-out', `${name}.pem`);
}
const CRL = `-----BEGIN X509 CRL-----\n${randomBytes(96).toString('base64')}\n-----END X509 CRL-----\n`;

before(() => {
  makeRoot('hq-root');
  makeRoot('other-root');
  issue('hq-root', 'site-intermediate');
  issue('other-root', 'foreign-intermediate');
  issue('hq-root', 'leaf', { ca: false });
});

/** OpenBao's pki_int behind the paths pki-files.mjs calls; set-signed imports each certificate as an issuer, the first with `keyId`. */
function fakeOpenbao({ keyId = 'key-site' } = {}) {
  const calls = [];
  const state = { issuers: {}, default: null };
  const colons = (hex) => hex.toLowerCase().match(/../g).join(':');
  const bao = async (method, apiPath, body) => {
    calls.push(`${method} ${apiPath}`);
    if (apiPath === `${MOUNT}/intermediate/generate/internal`) return { status: 200, data: { data: { csr: pem('site-intermediate.csr'), key_id: keyId } } };
    if (apiPath === `${MOUNT}/intermediate/set-signed`) {
      pemBlocks(body.certificate).forEach((block, index) => {
        state.issuers[`issuer-${index}`] = { serial_number: colons(new X509Certificate(block.pem).serialNumber), key_id: index === 0 ? keyId : '' };
      });
      return { status: 200, data: { data: {} } };
    }
    if (apiPath === `${MOUNT}/issuers?list=true`) return { status: 200, data: { data: { keys: Object.keys(state.issuers), key_info: state.issuers } } };
    if (apiPath === `${MOUNT}/config/issuers`) { state.default = body.default; return { status: 200, data: { data: {} } }; }
    if (apiPath === `${MOUNT}/cert/crl`) return { status: 200, data: { data: { certificate: CRL } } };
    return { status: 404, data: null };
  };
  return { bao, calls, state };
}

/** A copy of a certificate file in the scratch folder, signed. */
const signedCopy = (name, { signWith = ORG, text = pem(name) } = {}) => {
  const file = scratch(name);
  writeFileSync(file, text);
  signFile(file, signWith.private);
  return file;
};

test('csr and export-crl write files that verify with the site public key; the CSR and its key come from OpenBao', async () => {
  const openbao = fakeOpenbao();
  const csrFile = scratch('site.csr');
  const { csr } = await requestIntermediate(openbao.bao, { out: csrFile, key: ORG.private, siteName: 'edge-1' });
  assert.equal(csr, pem('site-intermediate.csr'));
  assert.equal(readFileSync(csrFile, 'utf8'), csr);
  const crlFile = scratch('site.crl.pem');
  await exportCrl(openbao.bao, { out: crlFile, key: ORG.private });
  assert.equal(readFileSync(crlFile, 'utf8'), CRL);
  for (const file of [csrFile, crlFile]) {
    assert.equal(verifySignedFile(file, ORG.public).ok, true, file);
    assert.equal(verifySignedFile(file, OTHER.public).ok, false, file);
  }
  assert.deepEqual(openbao.calls, [`POST ${MOUNT}/intermediate/generate/internal`, `GET ${MOUNT}/cert/crl`]);
});

test('an intermediate signed by the HQ root becomes the default issuer and the chain is written for siteCaChain', async () => {
  const openbao = fakeOpenbao();
  const chainOut = scratch('site-ca-chain.pem');
  const result = await importIntermediate(openbao.bao, { file: signedCopy('site-intermediate.pem'), publicKey: ORG.public, rootPem: pem('hq-root.pem'), chainOut });
  assert.deepEqual(result, { ok: true, issuerId: 'issuer-0', chainOut });
  assert.equal(openbao.state.default, 'issuer-0');
  assert.deepEqual(pemBlocks(readFileSync(chainOut, 'utf8')).map((block) => new X509Certificate(block.pem).subject), ['CN=site-intermediate', 'CN=hq-root']);
  // A certificate OpenBao holds no key for cannot sign: it is never made the default and no chain is written.
  const keyless = fakeOpenbao({ keyId: '' });
  const keylessOut = scratch('keyless-chain.pem');
  await assert.rejects(importIntermediate(keyless.bao, { file: signedCopy('site-intermediate.pem'), publicKey: ORG.public, rootPem: pem('hq-root.pem'), chainOut: keylessOut }), /does not match a key pki_int generated/);
  assert.equal(keyless.state.default, null);
  assert.equal(existsSync(keylessOut), false);
});

for (const [name, makeFile, options = {}] of [
  ['a certificate file changed after signing', () => {
    const file = signedCopy('site-intermediate.pem');
    writeFileSync(file, pem('foreign-intermediate.pem'));
    return file;
  }],
  ['a certificate file signed with another key', () => signedCopy('site-intermediate.pem', { signWith: OTHER })],
  ['an intermediate issued by another root', () => signedCopy('foreign-intermediate.pem')],
  ['a certificate that is not a CA certificate', () => signedCopy('leaf.pem')],
  ['an intermediate that is no longer valid', () => signedCopy('site-intermediate.pem'), { now: new Date('2100-01-01T00:00:00Z') }],
  ['a file with text outside the certificate', () => signedCopy('site-intermediate.pem', { text: `Certificate:\n    Data: ...\n${pem('site-intermediate.pem')}` })]
]) {
  test(`import-intermediate refuses ${name} with zero OpenBao calls and no file written`, async () => {
    const openbao = fakeOpenbao();
    const chainOut = scratch('refused-chain.pem');
    const result = await importIntermediate(openbao.bao, { file: makeFile(), publicKey: ORG.public, rootPem: pem('hq-root.pem'), chainOut, ...options });
    assert.equal(result.ok, false);
    assert.ok(result.reason);
    assert.deepEqual(openbao.calls, []);
    assert.equal(existsSync(chainOut), false);
  });
}

test('import-crl places a verified revocation list at every path and writes nothing for a refused one', () => {
  const file = scratch('hq.crl.pem');
  writeFileSync(file, CRL);
  signFile(file, ORG.private);
  const outs = [scratch('smart-card.crl.pem'), scratch('tls-trust.crl.pem')];
  assert.deepEqual(importCrl({ file, publicKey: ORG.public, outs }), { ok: true, outs });
  for (const out of outs) assert.equal(readFileSync(out, 'utf8'), CRL);
  const tampered = scratch('tampered.crl.pem');
  writeFileSync(tampered, CRL);
  signFile(tampered, ORG.private);
  writeFileSync(tampered, `-----BEGIN X509 CRL-----\n${randomBytes(96).toString('base64')}\n-----END X509 CRL-----\n`);
  for (const refused of [tampered, (() => { const other = scratch('other.crl.pem'); writeFileSync(other, CRL); signFile(other, OTHER.private); return other; })(), signedCopy('hq-root.pem')]) {
    const written = [];
    const result = importCrl({ file: refused, publicKey: ORG.public, outs: [scratch('never.crl.pem')], write: (out) => written.push(out) });
    assert.equal(result.ok, false, refused);
    assert.deepEqual(written, []);
  }
});

// --- Optional HQ brokering ------------------------------------------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readRepoJson = (file) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
const CI_SITE = loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'));
const REALM_SITE = readRepoJson('deploy/values/site.example/sterling-keycloak-realm.yaml');
const LINKED = { enabled: true, issuer: 'https://keycloak.hq.example/realms/sterling/', clientId: 'edge-1' };
const realmFor = (hqBroker) => prepareRealm({ site: CI_SITE, realmSite: hqBroker ? { ...REALM_SITE, hqBroker } : REALM_SITE, keycloakxSite: readRepoJson('deploy/values/site.example/keycloakx.yaml') });
const hqOf = ({ realm }) => realm.identityProviders.find((provider) => provider.alias === HQ_BROKER);
const stepsOf = ({ realm }, alias) => realm.authenticationFlows.find((flow) => flow.alias === alias).authenticationExecutions.map((execution) => [execution.authenticator, execution.requirement]);

test('the HQ broker renders off for the CI site and on, linking only, when the realm site file turns it on', () => {
  const off = realmFor();
  assert.deepEqual(off.problems, []);
  assert.equal(hqOf(off).enabled, false);
  assert.equal(hqOf(off).config.clientSecret, 'not-set', 'no secret is asked of a site without the broker');
  const on = realmFor(LINKED);
  assert.deepEqual(on.problems, []);
  const hq = hqOf(on);
  assert.deepEqual([hq.enabled, hq.authenticateByDefault, hq.config.issuer, hq.config.clientId, hq.config.clientSecret, hq.config.syncMode],
    [true, false, 'https://keycloak.hq.example/realms/sterling', 'edge-1', `$(env:${HQ_SECRET_ENV})`, 'IMPORT']);
  assert.equal(hq.firstBrokerLoginFlowAlias, HQ_FIRST_LOGIN_FLOW);
  assert.deepEqual(stepsOf(on, HQ_FIRST_LOGIN_FLOW), [['idp-detect-existing-broker-user', 'REQUIRED'], ['idp-auto-link', 'REQUIRED']], 'links an existing person, never creates one');
  assert.equal(on.realm.firstBrokerLoginFlow, 'sterling-no-credentials');
  // Local sign-in is unchanged: the redirector only follows an explicit request, and the WebAuthn subflow stays an alternative.
  assert.deepEqual(stepsOf(on, 'sterling-browser'), [['auth-cookie', 'ALTERNATIVE'], ['identity-provider-redirector', 'ALTERNATIVE'], [undefined, 'ALTERNATIVE']]);
});

test('checkRealm refuses a broker that would create people, ask for a password, be the default or overwrite local people', () => {
  const broken = (change, hqBroker = LINKED) => {
    const { realm, settings } = realmFor(hqBroker);
    const copy = structuredClone(realm);
    change(copy);
    return checkRealm(copy, settings).join('\n');
  };
  const firstLogin = (copy) => copy.authenticationFlows.find((flow) => flow.alias === HQ_FIRST_LOGIN_FLOW).authenticationExecutions;
  assert.match(broken((copy) => { firstLogin(copy)[1].authenticator = 'idp-create-user-if-unique'; }), /creates people from an identity provider/);
  assert.match(broken((copy) => { firstLogin(copy).push({ authenticator: 'idp-username-password-form', requirement: 'REQUIRED' }); }), /uses idp-username-password-form, which is not a WebAuthn step/);
  assert.match(broken((copy) => { copy.identityProviders[0].firstBrokerLoginFlowAlias = 'first broker login'; }), /first sign-in must be sterling-hq-first-login/);
  assert.match(broken((copy) => { copy.authenticationFlows[0].authenticationExecutions[1].authenticatorConfig = 'redirect to hq'; }), /must name no default provider/);
  assert.match(broken((copy) => { copy.identityProviders[0].authenticateByDefault = true; }), /must not be the default/);
  assert.match(broken((copy) => { copy.identityProviders[0].config.syncMode = 'FORCE'; }), /syncMode IMPORT/);
  assert.match(broken((copy) => { copy.identityProviders[0].config.clientSecret = 'a-literal-secret'; }), /client secret must come from the applier Job environment/);
  assert.match(broken(() => {}, { enabled: true, issuer: '', clientId: '' }), /hqBroker needs the https issuer of HQ's realm and the client id/);
  assert.match(broken((copy) => { copy.identityProviders[0].enabled = true; }, null), /must be on exactly when the realm site file turns hqBroker on/);
});
