// The command-line credential check (Phase 71 plan 08 Task 3): the product's own checker, built into one engine file that ships in the signed offline
// bundle. Fixtures are made at run time with the engine's own builders for a fictional Example Organization; every key is made here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deployTreeWithEngine } from '../bundle/build.mjs';
import { ENGINE_FILE, buildCredentialEngine } from '../tools/build-credential-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = path.join(ROOT, 'deploy', 'tools', 'credential-check.mjs');
const NOW = Date.UTC(2026, 10, 21);
const AT = '2026-11-21T00:00:00Z';
const REVOCATIONS = 'https://hq.example.org/v1/trust/status/revocation-1';
const SUSPENSIONS = 'https://hq.example.org/v1/trust/status/suspension-1';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

let engine;
let scratch;
let base;
const made = {};

function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const multikey = engine.encodePublicKeyMultibase('Ed25519', new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)));
  const did = `did:key:${multikey}`;
  return { multikey, did, signer: { verificationMethod: `${did}#${multikey}`, suite: 'eddsa-jcs-2022', sign: async (bytes) => new Uint8Array(cryptoSign(null, bytes, privateKey)) } };
}

function policyKey() {
  const seed = createHash('sha256').update('credential-check/issuer', 'utf8').digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const raw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url');
  return { fingerprint: engine.fingerprintOf(raw), publicKey: raw.toString('base64url'), sign: (bytes) => cryptoSign(null, bytes, privateKey).toString('base64url') };
}

async function person(segments) {
  const issuing = newKey();
  const update = newKey();
  const genesis = await engine.buildGenesisEntry({
    domain: 'hq.example.org', path: segments, updateKeys: [update.multikey], portable: true, versionTime: '2026-01-01T00:00:00Z',
    document: (did) => ({
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'], id: did, controller: did,
      verificationMethod: [{ id: `${did}#issuing`, type: 'Multikey', controller: did, publicKeyMultibase: issuing.multikey }],
      authentication: [`${did}#issuing`], assertionMethod: [`${did}#issuing`]
    })
  }, update.signer);
  return { did: genesis.did, scid: genesis.scid, line: genesis.line, signer: { ...issuing.signer, verificationMethod: `${genesis.did}#issuing` } };
}

let index = 100;
async function issue(signer, issuer, type, subject, dates = {}) {
  const revocationIndex = index++;
  const suspensionIndex = index++;
  const credential = await engine.issueCredential(signer, {
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://w3id.org/sterling/credentials/v1'], type: ['VerifiableCredential', type], issuer,
    validFrom: '2026-03-01T00:00:00Z', validUntil: dates.validUntil ?? '2027-03-01T00:00:00Z', credentialSubject: subject,
    credentialStatus: [
      { type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: String(revocationIndex), statusListCredential: REVOCATIONS },
      { type: 'BitstringStatusListEntry', statusPurpose: 'suspension', statusListIndex: String(suspensionIndex), statusListCredential: SUSPENSIONS }
    ]
  }, 'eddsa-jcs-2022', { scales: made.scales });
  return { credential, revocationIndex, suspensionIndex };
}

async function list(key, id, purpose, set = []) {
  const bits = new Uint8Array(131072 / 8);
  for (const bit of set) bits[bit >> 3] |= 0x80 >> (bit & 7);
  return engine.signStatusList(key.signer, engine.buildStatusList({ id, issuer: key.did, purpose, version: 1, validFrom: '2026-11-20T00:00:00Z', validUntil: '2026-11-27T00:00:00Z', bits }), 'eddsa-jcs-2022');
}

/** A trust folder: the issuer key, the signed rules, the logs, the two lists (with any bits set) and no extra roles. */
async function trustFolder(name, { revoked = [], suspended = [], revocationSigner } = {}) {
  const dir = path.join(scratch, name);
  cpSync(base, dir, { recursive: true });
  writeFileSync(path.join(dir, 'lists', 'revocations.json'), JSON.stringify(await list(revocationSigner ?? made.revocationKey, REVOCATIONS, 'revocation', revoked)));
  writeFileSync(path.join(dir, 'lists', 'suspensions.json'), JSON.stringify(await list(made.suspensionKey, SUSPENSIONS, 'suspension', suspended)));
  return dir;
}

function credentialFile(name, credential) {
  const file = path.join(scratch, `${name}.near-vc`);
  writeFileSync(file, JSON.stringify(credential));
  return file;
}

function run(args, tool = TOOL) {
  const result = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function argsFor(credential, trust, extra = []) {
  return ['--holder', made.alex.did, '--type', 'SecurityContactCredential', '--credential', credential, '--trust', trust, '--at', AT, ...extra];
}

before(async () => {
  await buildCredentialEngine();
  engine = await import(ENGINE_FILE);
  scratch = mkdtempSync(path.join(tmpdir(), 'near-ai-credential-check-'));
  const issuer = policyKey();
  const start = engine.documentFromBundle(engine.defaultBundlePayload({ issuer: { fingerprint: issuer.fingerprint, publicKey: issuer.publicKey }, now: NOW }));
  made.scales = start.labels.scales;
  made.root = await person(['org']);
  made.alex = await person(['people', 'alex']);
  made.kim = await person(['people', 'kim']);
  made.revocationKey = newKey();
  made.suspensionKey = newKey();
  const credentials = {
    v: 1, root: { did: made.root.did, scid: made.root.scid }, issuance: {}, suites: ['eddsa-jcs-2022'], didMethods: ['did:key', 'did:webvh'],
    statusLists: [{ uri: REVOCATIONS, purpose: 'revocation', key: made.revocationKey.multikey }, { uri: SUSPENSIONS, purpose: 'suspension', key: made.suspensionKey.multikey }],
    statusTtl: 900, maxOfflineAge: {}, requiredBySensitivity: {}
  };
  const layer = engine.buildOrganizationLayer(issuer, { labels: start.labels, agents: start.agents, credentials }, { now: NOW - 86_400_000, days: 90 });
  base = path.join(scratch, 'base');
  mkdirSync(path.join(base, 'logs'), { recursive: true });
  mkdirSync(path.join(base, 'lists'));
  mkdirSync(path.join(base, 'roles'));
  writeFileSync(path.join(base, 'issuer.pub'), `${issuer.publicKey}\n`);
  writeFileSync(path.join(base, 'organization.near-org-rules'), JSON.stringify(layer));
  for (const [name, p] of [['root', made.root], ['alex', made.alex], ['kim', made.kim]]) writeFileSync(path.join(base, 'logs', `${name}.jsonl`), `${p.line}\n`);
  made.contact = await issue(made.root.signer, made.root.did, 'SecurityContactCredential', { id: made.alex.did, scope: 'organization' });
  made.good = await trustFolder('good');
});

after(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

test('a valid SecurityContactCredential exits 0 with one sentence that names only the holder and the type', () => {
  const result = run(argsFor(credentialFile('valid', made.contact.credential), made.good, ['--holder-name', 'Alex', '--scope', 'organization']));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Alex holds a valid SecurityContactCredential.');
  assert.equal(result.stderr, '');
});

test('a revoked or a suspended credential exits 1 with one plain sentence', async () => {
  const file = credentialFile('contact', made.contact.credential);
  const revoked = run(argsFor(file, await trustFolder('revoked', { revoked: [made.contact.revocationIndex] })));
  assert.deepEqual([revoked.status, revoked.stderr], [1, 'A cited credential is revoked.']);
  const suspended = run(argsFor(file, await trustFolder('suspended', { suspended: [made.contact.suspensionIndex] })));
  assert.deepEqual([suspended.status, suspended.stderr], [1, 'A cited credential is suspended.']);
});

test('an expired credential exits 1', async () => {
  const ended = await issue(made.root.signer, made.root.did, 'SecurityContactCredential', { id: made.alex.did, scope: 'organization' }, { validUntil: '2026-11-01T00:00:00Z' });
  const result = run(argsFor(credentialFile('ended', ended.credential), made.good));
  assert.deepEqual([result.status, result.stderr], [1, 'A cited credential was not valid at the time of the entry.']);
});

test('another holder, another type or another scope exits 1', () => {
  const file = credentialFile('contact-2', made.contact.credential);
  assert.deepEqual(run(['--holder', made.kim.did, '--type', 'SecurityContactCredential', '--credential', file, '--trust', made.good, '--at', AT]).stderr, 'This credential is about someone else.');
  const wrongType = run(['--holder', made.alex.did, '--type', 'ReleaseAuthorityCredential', '--credential', file, '--trust', made.good, '--at', AT]);
  assert.deepEqual([wrongType.status, wrongType.stderr], [1, 'This credential is not a ReleaseAuthorityCredential.']);
  assert.equal(run(argsFor(file, made.good, ['--scope', 'project:example'])).stderr, 'This credential is not for that scope.');
});

test('a credential issued by a device key exits 1, whatever it says', async () => {
  const device = newKey();
  const forged = await issue(device.signer, device.did, 'SecurityContactCredential', { id: made.alex.did, scope: 'organization' });
  const result = run(argsFor(credentialFile('device', forged.credential), made.good));
  assert.deepEqual([result.status, result.stderr], [1, 'Whoever signed a cited credential did not have the authority to issue it.']);
});

test('a changed credential exits 1', () => {
  const tampered = JSON.parse(JSON.stringify(made.contact.credential));
  tampered.credentialSubject.scope = 'project:everything';
  const result = run(argsFor(credentialFile('tampered', tampered), made.good));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^A cited credential cannot be read or its signature does not match\.$/);
});

test('a status list signed by a key other than the one your organization\'s rules name exits 1', async () => {
  const result = run(argsFor(credentialFile('contact-3', made.contact.credential), await trustFolder('forged-list', { revocationSigner: newKey() })));
  assert.deepEqual([result.status, result.stderr], [1, 'A status list in the trust folder was not signed by the key your organization\'s rules name for it.']);
});

test('wrong usage exits 2 with the usage line', () => {
  for (const args of [[], ['--holder', made.alex.did], ['--holder', made.alex.did, '--type', 'X', '--credential', 'a', '--trust', 'b', '--at', 'yesterday'], ['--unknown', 'x']]) {
    const result = run(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /^usage: credential-check\.mjs/);
  }
});

test('without its engine the tool refuses and names the signed offline bundle', () => {
  const alone = path.join(scratch, 'alone');
  mkdirSync(alone);
  copyFileSync(TOOL, path.join(alone, 'credential-check.mjs'));
  const result = run(argsFor(credentialFile('contact-4', made.contact.credential), made.good), path.join(alone, 'credential-check.mjs'));
  assert.deepEqual([result.status, result.stderr], [1, 'This tool is incomplete. Use the copy from your organization\'s signed offline bundle.']);
});

test('the output never carries the credential or its claims', () => {
  const result = run(argsFor(credentialFile('contact-5', made.contact.credential), made.good));
  for (const text of [result.stdout, result.stderr]) {
    assert.doesNotMatch(text, /did:|proofValue|organization"|z6Mk/);
  }
  assert.equal(result.stdout, 'The holder holds a valid SecurityContactCredential.');
});

test('the engine imports only node: built-ins, and the offline bundle\'s deploy tree carries it beside the tool', async () => {
  const text = readFileSync(ENGINE_FILE, 'utf8');
  const imports = [...text.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)].map((match) => match[1]);
  assert.ok(imports.length > 0 && imports.every((name) => name.startsWith('node:')), imports.join(', '));
  const dir = path.join(scratch, 'tree');
  mkdirSync(dir);
  const tar = await deployTreeWithEngine(ROOT, dir);
  const listing = spawnSync('tar', ['-tf', tar], { encoding: 'utf8' }).stdout.split('\n');
  assert.ok(listing.includes('deploy/tools/credential-checker.engine.mjs'));
  assert.ok(listing.includes('deploy/tools/credential-check.mjs'));
  assert.ok(!listing.some((entry) => entry.startsWith('deploy/test/')));
  assert.ok(existsSync(ENGINE_FILE));
});
