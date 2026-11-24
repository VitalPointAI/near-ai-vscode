// HQ and edge federation by signed file (D-08, D-36, D-49, D-50): people with their passwordless keys, the site intermediate and revocation
// lists cross between sites only as files signed with your organization's key, and every import checks the signature (and the format and
// relying-party id, or the chain to the HQ root) before any Keycloak or OpenBao call or file write. Keycloak and OpenBao are fakes that count
// their calls. Needs the pinned cosign ($COSIGN or PATH) and openssl; fails, never skips, without them.
// Run: env COSIGN=compliance/out/tools/cosign node scripts/run-tests.mjs deploy/test/federation.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { cosignBinary } from '../bundle/lib/cosign.mjs';
import { signFile, verifySignedFile } from '../bundle/signed-file.mjs';
import { FORMAT, PASSWORDLESS, STORED_FIELDS, exportUsers, importUsers } from '../keycloak/users.mjs';
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
      return { status: 200, data: [...users.values()].filter((user) => user.username === name).map(({ credentials, ...user }) => user) };
    }
    if (method === 'GET' && parts[2] === 'credentials') {
      return { status: 200, data: users.get(parts[1]).credentials.map(({ secretData, ...credential }, index) => ({ id: `${parts[1]}-c${index}`, ...credential,
        credentialData: JSON.stringify({ ...JSON.parse(credential.credentialData), ...DISPLAY }) })) };
    }
    if (method === 'POST' && route === 'users') {
      if (!storable(body.credentials ?? [])) return { status: 500, data: { error: 'Cannot parse the JSON' } };
      const id = `id-${users.size}`;
      users.set(id, { ...body, username: body.username.toLowerCase(), id, credentials: body.credentials ?? [] });
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
