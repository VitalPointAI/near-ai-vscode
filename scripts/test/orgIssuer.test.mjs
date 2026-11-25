// Runs scripts/org-issuer.mjs (D-17) as the issuer would: a passphrase-protected key file, the twelve words, an enrolment file, a rules update and a key
// handover, each checked with the compiled readers the extension itself uses (dist/domain/gate/enrolment.js). Needs `npm run compile` first. Keys and the
// passphrase are made at test time; nothing here is key material.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'org-issuer.mjs');
const require = createRequire(import.meta.url);
const enrolment = require(path.join(ROOT, 'dist', 'domain', 'gate', 'enrolment.js'));
const fixtures = require(path.join(ROOT, 'dist', 'test', 'helpers', 'enrolmentFixtures.js'));
const webvh = require(path.join(ROOT, 'dist', 'domain', 'did', 'didWebvh.js'));
const profile = require(path.join(ROOT, 'dist', 'domain', 'credentials', 'profile.js'));
const multibase = require(path.join(ROOT, 'dist', 'domain', 'credentials', 'multibase.js'));
const labels = require(path.join(ROOT, 'dist', 'domain', 'gate', 'labels.js'));
const policyFixtures = require(path.join(ROOT, 'dist', 'test', 'helpers', 'policyFixtures.js'));

const PASSPHRASE = randomBytes(12).toString('hex');
const OTHER_PASSPHRASE = randomBytes(12).toString('hex');
const outputs = [];
const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function folder() {
  const dir = mkdtempSync(path.join(tmpdir(), 'org-issuer-test-'));
  roots.push(dir);
  return dir;
}

/** Runs the tool with the passphrase in its environment (or the given environment), and keeps every output for the last test. */
function run(args, env = { NEAR_ORG_ISSUER_PASSPHRASE: PASSPHRASE }) {
  const clean = { ...process.env };
  delete clean.NEAR_ORG_ISSUER_PASSPHRASE;
  delete clean.NEAR_ORG_ISSUER_NEW_PASSPHRASE;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...clean, ...env } });
  outputs.push(result.stdout, result.stderr);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function json(dir, name, value) {
  const file = path.join(dir, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function keyIn(dir, name = 'issuer-key.json', env) {
  const file = path.join(dir, name);
  const made = run(['create-key', '--out', file], env);
  assert.equal(made.status, 0, made.stderr);
  return { file, publicKey: JSON.parse(readFileSync(file, 'utf8')).publicKey };
}

const organization = { name: 'Example Organization', contacts: [{ topic: 'security', name: 'Security desk', how: 'security@example.org' }] };
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

/**
 * Opens a key file the way its format is documented, written here independently of the tool (WR-04): scrypt over the passphrase and the file's salt,
 * then AES-256-GCM with the file's nonce and tag, bound to the public key and the sealing it names. Returns the 32-byte private key, or throws.
 */
function openKeyFile(key, passphrase) {
  const sealed = key.privateKey;
  const wrap = scryptSync(passphrase.normalize('NFC'), Buffer.from(sealed.salt, 'base64url'), 32, SCRYPT);
  const header = JSON.stringify([key.kind, key.v, key.publicKey, sealed.kdf, sealed.N, sealed.r, sealed.p, sealed.salt, sealed.cipher, sealed.nonce]);
  const decipher = createDecipheriv('aes-256-gcm', wrap, Buffer.from(sealed.nonce, 'base64url'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(header, 'utf8'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64url')), decipher.final()]);
}

function publicKeyOf(seed, publicKey) {
  const opened = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: seed.toString('base64url'), x: publicKey }, format: 'jwk' });
  return createPublicKey(opened).export({ format: 'jwk' }).x;
}

test('create-key writes a passphrase-protected key file once', () => {
  const dir = folder();
  const file = path.join(dir, 'issuer-key.json');
  const made = run(['create-key', '--out', file]);
  assert.equal(made.status, 0, made.stderr);
  const key = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(key).sort(), ['createdAt', 'kind', 'privateKey', 'publicKey', 'v']);
  assert.equal(key.v, 2);
  assert.equal(key.kind, 'near-ai-org-issuer-key');
  assert.equal(key.publicKey.length, 43);
  assert.ok(!Number.isNaN(Date.parse(key.createdAt)));
  // The passphrase opens it and gives the key the file names; another passphrase does not open it.
  assert.equal(publicKeyOf(openKeyFile(key, PASSPHRASE), key.publicKey), key.publicKey);
  assert.throws(() => openKeyFile(key, OTHER_PASSPHRASE));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(made.stdout.includes(enrolment.issuerWordsText(enrolment.issuerWords(key.publicKey))));

  const before = readFileSync(file);
  const again = run(['create-key', '--out', file]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  assert.ok(readFileSync(file).equals(before), 'the key file is unchanged byte for byte');

  const short = path.join(dir, 'short.json');
  const refused = run(['create-key', '--out', short], { NEAR_ORG_ISSUER_PASSPHRASE: 'eleven-char' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /12 characters/);
  assert.equal(existsSync(short), false);

  const none = path.join(dir, 'none.json');
  assert.equal(run(['create-key', '--out', none], {}).status, 1);
  assert.equal(existsSync(none), false);

  // The passphrase is never an argument; a passphrase file works.
  const argument = path.join(dir, 'argument.json');
  assert.equal(run(['create-key', '--out', argument, '--passphrase', PASSPHRASE], {}).status, 2);
  assert.equal(existsSync(argument), false);
  const fromFile = path.join(dir, 'from-file.json');
  const passFile = path.join(dir, 'passphrase.txt');
  writeFileSync(passFile, `${OTHER_PASSPHRASE}\nsecond line ignored\n`);
  assert.equal(run(['create-key', '--out', fromFile, '--passphrase-file', passFile], {}).status, 0);
  const second = JSON.parse(readFileSync(fromFile, 'utf8'));
  assert.doesNotThrow(() => openKeyFile(second, OTHER_PASSPHRASE));
  assert.notEqual(second.publicKey, key.publicKey);

  assert.equal(run([]).status, 2);
  assert.equal(run(['make-coffee']).status, 2);
});

test('words prints the twelve words and the hex fingerprint', () => {
  const dir = folder();
  const key = keyIn(dir);
  const shown = run(['words', '--key', key.file], {});
  assert.equal(shown.status, 0, shown.stderr);
  assert.ok(shown.stdout.includes(enrolment.issuerWordsText(enrolment.issuerWords(key.publicKey))));
  assert.ok(shown.stdout.includes(enrolment.issuerFingerprintHex(key.publicKey)));
  assert.equal(run(['words', '--key', path.join(dir, 'missing.json')], {}).status, 1);
});

test('sign-enrolment makes a file the extension reads', () => {
  const dir = folder();
  const key = keyIn(dir);
  const rules = json(dir, 'rules.json', fixtures.organizationSections());
  const org = json(dir, 'organization.json', organization);
  const out = path.join(dir, 'example.near-org-enrolment');
  const signed = run(['sign-enrolment', '--key', key.file, '--organization', org, '--rules', rules, '--out', out]);
  assert.equal(signed.status, 0, signed.stderr);
  assert.ok(out.endsWith(enrolment.ENROLMENT_FILE_EXTENSION));
  const text = readFileSync(out, 'utf8');
  assert.ok(text.endsWith('}\n'));
  const read = enrolment.readEnrolmentFile(text, { now: Date.now() });
  assert.equal(read.ok, true, read.message);
  assert.equal(read.enrolment.organization.name, 'Example Organization');
  assert.equal(read.enrolment.issuer.publicKey, key.publicKey);
  assert.equal(read.enrolment.serial, 1);
  assert.equal(read.layer.document.labels.routing.levels['org/Internal'], 'local-only');
  assert.equal(enrolment.classifyEnrolment(read), 'enrol');
  assert.ok(signed.stdout.includes(enrolment.issuerWordsText(read.words)));

  const before = readFileSync(out);
  const again = run(['sign-enrolment', '--key', key.file, '--organization', org, '--rules', rules, '--out', out, '--serial', '3']);
  assert.equal(again.status, 1);
  assert.ok(readFileSync(out).equals(before), 'never overwritten');

  const wrongName = path.join(dir, 'example.json');
  assert.equal(run(['sign-enrolment', '--key', key.file, '--organization', org, '--rules', rules, '--out', wrongName]).status, 2);
  assert.equal(existsSync(wrongName), false);
  const tooLong = path.join(dir, 'long.near-org-enrolment');
  assert.equal(run(['sign-enrolment', '--key', key.file, '--organization', org, '--rules', rules, '--out', tooLong, '--days', '91']).status, 2);
  assert.equal(existsSync(tooLong), false);
});

test('sign-layer makes a rules update the pin accepts', () => {
  const dir = folder();
  const key = keyIn(dir);
  const rules = json(dir, 'rules.json', fixtures.organizationSections());
  const out = path.join(dir, 'update.near-org-rules');
  const signed = run(['sign-layer', '--key', key.file, '--rules', rules, '--out', out, '--days', '120']);
  assert.equal(signed.status, 0, signed.stderr);
  const text = readFileSync(out, 'utf8');
  const verdict = enrolment.verifyOrganizationLayer(text, { issuerPublicKey: key.publicKey, now: Date.now() });
  assert.equal(verdict.ok, true, verdict.message);
  assert.equal(Date.parse(verdict.expiresAt) - Date.parse(verdict.issuedAt), 120 * 24 * 60 * 60 * 1000);
  // Another computer's pin refuses it.
  const other = keyIn(dir, 'other-key.json');
  assert.equal(enrolment.verifyOrganizationLayer(text, { issuerPublicKey: other.publicKey, now: Date.now() }).reason, 'unknown-key');
  const wrongName = path.join(dir, 'update.json');
  assert.equal(run(['sign-layer', '--key', key.file, '--rules', rules, '--out', wrongName]).status, 2);
  assert.equal(existsSync(wrongName), false);
});

test('rotate hands over to a new key', () => {
  const dir = folder();
  const oldKey = keyIn(dir, 'old-key.json');
  const newKey = keyIn(dir, 'new-key.json', { NEAR_ORG_ISSUER_PASSPHRASE: OTHER_PASSPHRASE });
  const rules = json(dir, 'rules.json', fixtures.organizationSections());
  const org = json(dir, 'organization.json', organization);
  const out = path.join(dir, 'handover.near-org-enrolment');
  const rotated = run(
    ['rotate', '--key', oldKey.file, '--new-key', newKey.file, '--organization', org, '--rules', rules, '--out', out, '--serial', '2'],
    { NEAR_ORG_ISSUER_PASSPHRASE: PASSPHRASE, NEAR_ORG_ISSUER_NEW_PASSPHRASE: OTHER_PASSPHRASE }
  );
  assert.equal(rotated.status, 0, rotated.stderr);
  const read = enrolment.readEnrolmentFile(readFileSync(out, 'utf8'), { now: Date.now() });
  assert.equal(read.ok, true, read.message);
  assert.equal(read.enrolment.issuer.publicKey, newKey.publicKey);
  assert.equal(read.enrolment.rotation.previous.publicKey, oldKey.publicKey);
  assert.equal(enrolment.classifyEnrolment(read, { publicKey: oldKey.publicKey, serial: 1 }), 'rotate');
  assert.equal(enrolment.classifyEnrolment(read, { publicKey: oldKey.publicKey, serial: 2 }), 'older-file');
  assert.ok(rotated.stdout.includes(enrolment.issuerWordsText(enrolment.issuerWords(newKey.publicKey))));

  // A serial is required, and the new key's passphrase must open the new key.
  const noSerial = path.join(dir, 'no-serial.near-org-enrolment');
  assert.equal(run(['rotate', '--key', oldKey.file, '--new-key', newKey.file, '--organization', org, '--rules', rules, '--out', noSerial]).status, 2);
  assert.equal(existsSync(noSerial), false);
  const wrongNew = path.join(dir, 'wrong-new.near-org-enrolment');
  assert.equal(run(['rotate', '--key', oldKey.file, '--new-key', newKey.file, '--organization', org, '--rules', rules, '--out', wrongNew, '--serial', '2']).status, 1);
  assert.equal(existsSync(wrongNew), false);
});

test('refusals write nothing', () => {
  const dir = folder();
  const key = keyIn(dir);
  const org = json(dir, 'organization.json', organization);
  const rules = json(dir, 'rules.json', fixtures.organizationSections());
  const unknownSection = json(dir, 'unknown.json', { ...fixtures.organizationSections(), colours: { v: 1 } });
  const envelopeKey = json(dir, 'envelope.json', { ...fixtures.organizationSections(), issuedAt: '2026-11-20T00:00:00.000Z' });
  const badShape = json(dir, 'bad-shape.json', { ...fixtures.organizationSections(), agents: { v: 1 } });
  // Two hundred signed authorizations make a first set of rules far larger than an enrolment file may be.
  const authorizations = [];
  for (let index = 0; index < 200; index += 1) {
    const body = policyFixtures.authorizationFor({ kind: 't1-risk', id: `t1-risk-${String(index).padStart(3, '0')}` });
    authorizations.push(JSON.parse(JSON.stringify(policyFixtures.signAuthorization(body, policyFixtures.issuerKey()))));
  }
  const large = json(dir, 'large.json', { ...fixtures.organizationSections(), authorizations });

  const cases = [
    ['a wrong passphrase', ['sign-layer', '--key', key.file, '--rules', rules], 'layer.near-org-rules', { NEAR_ORG_ISSUER_PASSPHRASE: OTHER_PASSPHRASE }, /passphrase/],
    ['an unknown section', ['sign-layer', '--key', key.file, '--rules', unknownSection], 'unknown.near-org-rules', undefined, /does not know/],
    ['an envelope key', ['sign-layer', '--key', key.file, '--rules', envelopeKey], 'envelope.near-org-rules', undefined, /may not set/],
    ['a section of the wrong shape', ['sign-enrolment', '--key', key.file, '--organization', org, '--rules', badShape], 'bad.near-org-enrolment', undefined, /not signed/],
    ['first rules over 64 KiB', ['sign-enrolment', '--key', key.file, '--organization', org, '--rules', large], 'large.near-org-enrolment', undefined, /over the 65536 byte limit\. Enrol with a smaller first set of rules and send the rest as a rules update\./],
    ['a missing rules file', ['sign-layer', '--key', key.file, '--rules', path.join(dir, 'missing.json')], 'missing.near-org-rules', undefined, /could not be read/]
  ];
  for (const [name, args, outName, env, sentence] of cases) {
    const out = path.join(dir, outName);
    const result = run([...args, '--out', out], env);
    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    assert.match(result.stderr, sentence, name);
    assert.equal(result.stderr.trim().split('\n').length, 1, `${name}: one plain sentence`);
    assert.equal(existsSync(out), false, `${name}: no output file`);
  }
  // The same large rules are fine as a rules update (up to 1 MiB).
  const update = path.join(dir, 'large.near-org-rules');
  assert.equal(run(['sign-layer', '--key', key.file, '--rules', large, '--out', update]).status, 0);
  assert.equal(enrolment.verifyOrganizationLayer(readFileSync(update, 'utf8'), { issuerPublicKey: key.publicKey, now: Date.now() }).ok, true);
});

/** Seals a private key the way the tool does but with a scrypt cost of the caller's choosing, to show the tool refuses any cost but its own. */
function sealedWith(publicKey, seed, passphrase, N) {
  const salt = randomBytes(16).toString('base64url');
  const nonce = randomBytes(12).toString('base64url');
  const sealed = { kdf: 'scrypt', N, r: 8, p: 1, salt, cipher: 'aes-256-gcm', nonce };
  const wrap = scryptSync(passphrase.normalize('NFC'), Buffer.from(salt, 'base64url'), 32, { ...SCRYPT, N });
  const cipher = createCipheriv('aes-256-gcm', wrap, Buffer.from(nonce, 'base64url'), { authTagLength: 16 });
  cipher.setAAD(Buffer.from(JSON.stringify(['near-ai-org-issuer-key', 2, publicKey, 'scrypt', N, 8, 1, salt, 'aes-256-gcm', nonce]), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
  return { ...sealed, ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}

test('the key file is sealed with scrypt and AES-256-GCM, and anything else is refused (WR-04)', () => {
  const dir = folder();
  const key = keyIn(dir);
  const text = readFileSync(key.file, 'utf8');
  const file = JSON.parse(text);
  const rules = json(dir, 'rules.json', fixtures.organizationSections());

  // The sealing named in the file is the strong one, with a fresh salt and nonce per key file.
  const sealed = file.privateKey;
  assert.deepEqual(Object.keys(sealed).sort(), ['N', 'cipher', 'ciphertext', 'kdf', 'nonce', 'p', 'r', 'salt', 'tag']);
  assert.deepEqual([sealed.kdf, sealed.N, sealed.r, sealed.p, sealed.cipher], ['scrypt', 2 ** 17, 8, 1, 'aes-256-gcm']);
  assert.equal(Buffer.from(sealed.salt, 'base64url').length, 16);
  assert.equal(Buffer.from(sealed.nonce, 'base64url').length, 12);
  assert.equal(Buffer.from(sealed.tag, 'base64url').length, 16);
  const other = JSON.parse(readFileSync(keyIn(dir, 'other-key.json').file, 'utf8')).privateKey;
  assert.notEqual(other.salt, sealed.salt);
  assert.notEqual(other.nonce, sealed.nonce);

  // No plaintext key in the file: the private key opened with the passphrase appears in no common encoding, and no PEM block is there.
  const seed = openKeyFile(file, PASSPHRASE);
  assert.equal(seed.length, 32);
  for (const encoded of [seed.toString('hex'), seed.toString('base64'), seed.toString('base64url')]) assert.ok(!text.includes(encoded), 'no plaintext key');
  assert.ok(!text.includes('PRIVATE KEY'));
  assert.ok(!text.includes('-----'));

  // Round trip: the passphrase opens the file and signs rules the extension accepts under the key the file names.
  const good = path.join(dir, 'good.near-org-rules');
  assert.equal(run(['sign-layer', '--key', key.file, '--rules', rules, '--out', good]).status, 0);
  assert.equal(enrolment.verifyOrganizationLayer(readFileSync(good, 'utf8'), { issuerPublicKey: key.publicKey, now: Date.now() }).ok, true);

  // A wrong passphrase is refused and writes nothing.
  const wrong = path.join(dir, 'wrong.near-org-rules');
  const refusedWrong = run(['sign-layer', '--key', key.file, '--rules', rules, '--out', wrong], { NEAR_ORG_ISSUER_PASSPHRASE: OTHER_PASSPHRASE });
  assert.equal(refusedWrong.status, 1);
  assert.match(refusedWrong.stderr, /passphrase does not open/);
  assert.equal(existsSync(wrong), false);

  // Key files made some other way, each with the right public key, are refused before any signing.
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'jwk' }).x;
  const plainPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const olderPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASSPHRASE });
  const pairSeed = Buffer.from(pair.privateKey.export({ format: 'jwk' }).d, 'base64url');
  const base = { kind: 'near-ai-org-issuer-key', publicKey, createdAt: new Date().toISOString() };
  const refusedFiles = [
    ['an unencrypted key in the older layout', { v: 1, ...base, privateKeyPem: plainPem }, /does not keep its key sealed/],
    ['an unencrypted key in the new layout', { v: 2, ...base, privateKey: plainPem }, /does not keep its key sealed/],
    ['the older PBKDF2 key file', { v: 1, ...base, privateKeyPem: olderPem }, /does not keep its key sealed/],
    ['an unknown version', { v: 3, ...base, privateKey: sealedWith(publicKey, pairSeed, PASSPHRASE, 2 ** 17) }, /does not keep its key sealed/],
    ['a cheaper scrypt cost', { v: 2, ...base, privateKey: sealedWith(publicKey, pairSeed, PASSPHRASE, 2 ** 14) }, /sealing is not the one/],
    ['another cipher named', { v: 2, ...base, privateKey: { ...sealedWith(publicKey, pairSeed, PASSPHRASE, 2 ** 17), cipher: 'aes-256-cbc' } }, /sealing is not the one/],
    ['an extra field', { v: 2, ...base, privateKey: sealedWith(publicKey, pairSeed, PASSPHRASE, 2 ** 17), note: 'x' }, /not a key file from this tool/],
    ['another kind', { v: 2, ...base, kind: 'something-else', privateKey: sealedWith(publicKey, pairSeed, PASSPHRASE, 2 ** 17) }, /not a key file from this tool/],
    ['a public key swapped for another', { v: 2, ...base, publicKey: key.publicKey, privateKey: sealedWith(publicKey, pairSeed, PASSPHRASE, 2 ** 17) }, /passphrase does not open/]
  ];
  for (const [name, content, sentence] of refusedFiles) {
    const keyFile = json(dir, `refused-${refusedFiles.findIndex((entry) => entry[0] === name)}.json`, content);
    const out = path.join(dir, `refused-${name.replace(/[^a-z]+/g, '-')}.near-org-rules`);
    const result = run(['sign-layer', '--key', keyFile, '--rules', rules, '--out', out]);
    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    assert.match(result.stderr, sentence, name);
    assert.equal(existsSync(out), false, `${name}: no output file`);
  }
  // The same sealing at the tool's own cost opens and signs: the refusals above are about the format, not the key.
  const proper = json(dir, 'proper.json', { v: 2, ...base, privateKey: sealedWith(publicKey, pairSeed, PASSPHRASE, 2 ** 17) });
  const signed = path.join(dir, 'proper.near-org-rules');
  assert.equal(run(['sign-layer', '--key', proper, '--rules', rules, '--out', signed]).status, 0);
  assert.equal(enrolment.verifyOrganizationLayer(readFileSync(signed, 'utf8'), { issuerPublicKey: publicKey, now: Date.now() }).ok, true);
});

// ---- Your organization's root identity (Phase 71, 71-10; D-07, D-13) --------------------------------------------------------------------------------

const REVOCATION = 'https://hq.example.org/v1/trust/status/revocation-1';
const SUSPENSION = 'https://hq.example.org/v1/trust/status/suspension-1';
const ALEX = 'did:webvh:QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG:hq.example.org:people:x7k2p9';

function rootIdentity(dir) {
  const key = path.join(dir, 'root-key.json');
  const next = path.join(dir, 'root-next-key.json');
  const log = path.join(dir, 'organization.did.jsonl');
  const made = run(['create-did', '--key', key, '--next-key', next, '--domain', 'hq.example.org', '--out', log]);
  assert.equal(made.status, 0, made.stderr);
  return { key, next, log };
}

const multikeyOf = (file) => multibase.encodePublicKeyMultibase('Ed25519', new Uint8Array(Buffer.from(JSON.parse(readFileSync(file, 'utf8')).publicKey, 'base64url')));

test('create-did writes the root\'s genesis log with pre-rotation on: the next key\'s hash is committed, and both key files are sealed', () => {
  const dir = folder();
  const { key, next, log } = rootIdentity(dir);
  const verified = webvh.verifyWebvhLog(readFileSync(log, 'utf8'), { now: Date.now() });
  assert.equal(verified.ok, true, verified.message);
  assert.match(verified.state.did, /^did:webvh:Qm[1-9A-HJ-NP-Za-km-z]{44}:hq\.example\.org:org$/);
  assert.deepEqual(verified.state.parameters.updateKeys, [multikeyOf(key)]);
  assert.deepEqual(verified.state.parameters.nextKeyHashes, [webvh.nextKeyHash(multikeyOf(next))]);
  for (const file of [key, next]) {
    const content = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(content.kind, 'near-ai-org-did-key');
    assert.equal(content.privateKey.N, 2 ** 17, 'sealed as create-key seals');
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test('create-did never overwrites a key file or a log, and refuses a malformed domain', () => {
  const dir = folder();
  const { key, next, log } = rootIdentity(dir);
  const before = readFileSync(key, 'utf8');
  const again = run(['create-did', '--key', key, '--next-key', path.join(dir, 'other-next.json'), '--domain', 'hq.example.org', '--out', path.join(dir, 'again.did.jsonl')]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  assert.equal(readFileSync(key, 'utf8'), before);
  assert.equal(existsSync(path.join(dir, 'again.did.jsonl')), false);
  assert.equal(run(['create-did', '--key', path.join(dir, 'k2.json'), '--next-key', path.join(dir, 'n2.json'), '--domain', 'HQ Example', '--out', path.join(dir, 'x.did.jsonl')]).status, 2);
  assert.ok(existsSync(next) && existsSync(log));
});

test('rotate-did with the pre-rotated key appends an update that verifies and commits to a new next key', () => {
  const dir = folder();
  const { next, log } = rootIdentity(dir);
  const newNext = path.join(dir, 'root-next-2.json');
  const out = path.join(dir, 'organization-2.did.jsonl');
  const rotated = run(['rotate-did', '--log', log, '--key', next, '--next-key', newNext, '--out', out]);
  assert.equal(rotated.status, 0, rotated.stderr);
  const text = readFileSync(out, 'utf8');
  assert.ok(text.startsWith(readFileSync(log, 'utf8')), 'the new log continues the old one');
  const verified = webvh.verifyWebvhLog(text, { now: Date.now() + 5000 });
  assert.equal(verified.ok, true, verified.message);
  assert.equal(verified.state.versions.length, 2);
  assert.deepEqual(verified.state.parameters.updateKeys, [multikeyOf(next)]);
  assert.deepEqual(verified.state.parameters.nextKeyHashes, [webvh.nextKeyHash(multikeyOf(newNext))]);
});

test('rotate-did with any other key refuses in one sentence and writes nothing', () => {
  const dir = folder();
  const { key, log } = rootIdentity(dir);
  const out = path.join(dir, 'organization-2.did.jsonl');
  const spent = run(['rotate-did', '--log', log, '--key', key, '--next-key', path.join(dir, 'n.json'), '--out', out]);
  assert.equal(spent.status, 1);
  assert.match(spent.stderr, /not the key the root identity committed to/);
  assert.equal(spent.stderr.trim().split('\n').length, 1);
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(path.join(dir, 'n.json')), false, 'no new key file either');
});

test('the rules key and a root identity key are kept apart: neither signs as the other', () => {
  const dir = folder();
  const rulesKey = keyIn(dir);
  const { key } = rootIdentity(dir);
  const rules = json(dir, 'rules.json', fixtures.organizationSections());
  const asRules = run(['sign-layer', '--key', key, '--rules', rules, '--out', path.join(dir, 'x.near-org-rules')]);
  assert.equal(asRules.status, 1);
  assert.match(asRules.stderr, /root identity key, not your organization's rules key/);
  const claims = json(dir, 'claims.json', { scope: 'organization' });
  const asRoot = run(['issue-role', '--key', rulesKey.file, '--log', path.join(dir, 'organization.did.jsonl'), '--type', 'SecurityContactCredential', '--subject', ALEX,
    '--claims', claims, '--status', `${REVOCATION}#10`, '--suspension', `${SUSPENSION}#11`, '--out', path.join(dir, 'x.near-vc')]);
  assert.equal(asRoot.status, 1);
  assert.match(asRoot.stderr, /rules key, not a root identity key/);
});

test('issue-role signs a role credential for a person\'s did:webvh that verifies with the root key, with the status entries given', () => {
  const dir = folder();
  const { key, log } = rootIdentity(dir);
  const claims = json(dir, 'claims.json', { credentialType: 'ClearanceCredential', scale: 'ca-classified', upTo: 'Secret' });
  const out = path.join(dir, 'alex-issuer.near-vc');
  const issued = run(['issue-role', '--key', key, '--log', log, '--type', 'IssuerRoleCredential', '--subject', ALEX, '--claims', claims,
    '--status', `${REVOCATION}#4821`, '--suspension', `${SUSPENSION}#77`, '--out', out, '--days', '365']);
  assert.equal(issued.status, 0, issued.stderr);
  const credential = JSON.parse(readFileSync(out, 'utf8'));
  const state = webvh.verifyWebvhLog(readFileSync(log, 'utf8'), { now: Date.now() }).state;
  assert.equal(credential.issuer, state.did);
  assert.equal(credential.credentialSubject.id, ALEX);
  assert.deepEqual(credential.credentialStatus.map((entry) => [entry.statusPurpose, entry.statusListIndex, entry.statusListCredential]), [['revocation', '4821', REVOCATION], ['suspension', '77', SUSPENSION]]);
  const verified = profile.verifyCredential(credential, { scales: labels.SCALE_PRESETS, publicKey: multibase.decodePublicKeyMultibase(multikeyOf(key)) });
  assert.equal(verified.ok, true, verified.message);
  assert.equal(verified.type, 'IssuerRoleCredential');
});

test('issue-role refuses a did:key subject, a type that is not a role, and malformed status entries, writing nothing', () => {
  const dir = folder();
  const { key, log } = rootIdentity(dir);
  const claims = json(dir, 'claims.json', { scope: 'organization' });
  const base = ['--key', key, '--log', log, '--claims', claims, '--status', `${REVOCATION}#1`, '--suspension', `${SUSPENSION}#2`];
  const device = run(['issue-role', ...base, '--type', 'SecurityContactCredential', '--subject', 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', '--out', path.join(dir, 'a.near-vc')]);
  assert.equal(device.status, 1);
  assert.match(device.stderr, /never issues/);
  const notRole = run(['issue-role', ...base, '--type', 'ClearanceCredential', '--subject', ALEX, '--out', path.join(dir, 'b.near-vc')]);
  assert.equal(notRole.status, 2);
  const badStatus = run(['issue-role', '--key', key, '--log', log, '--claims', claims, '--status', 'revocation-1', '--suspension', `${SUSPENSION}#2`, '--type', 'SecurityContactCredential', '--subject', ALEX, '--out', path.join(dir, 'c.near-vc')]);
  assert.equal(badStatus.status, 2);
  for (const name of ['a', 'b', 'c']) assert.equal(existsSync(path.join(dir, `${name}.near-vc`)), false);
});

test('after a rotation, issue-role refuses the spent key and signs with the key in force', () => {
  const dir = folder();
  const { key, next, log } = rootIdentity(dir);
  const rotatedLog = path.join(dir, 'organization-2.did.jsonl');
  assert.equal(run(['rotate-did', '--log', log, '--key', next, '--next-key', path.join(dir, 'n2.json'), '--out', rotatedLog]).status, 0);
  const claims = json(dir, 'claims.json', { scope: 'organization' });
  const args = (keyFile, out) => ['issue-role', '--key', keyFile, '--log', rotatedLog, '--type', 'SecurityContactCredential', '--subject', ALEX, '--claims', claims,
    '--status', `${REVOCATION}#3`, '--suspension', `${SUSPENSION}#4`, '--out', path.join(dir, out)];
  const spent = run(args(key, 'spent.near-vc'));
  assert.equal(spent.status, 1, spent.stdout);
  assert.match(spent.stderr, /not the root identity's key in force/);
  assert.equal(run(args(next, 'current.near-vc')).status, 0);
});

test('no secret reaches the screen', () => {
  assert.ok(outputs.length > 20);
  for (const text of outputs) {
    assert.ok(!text.includes('PRIVATE KEY'), 'no private key on screen');
    assert.ok(!text.includes(PASSPHRASE), 'no passphrase on screen');
    assert.ok(!text.includes(OTHER_PASSPHRASE), 'no passphrase on screen');
  }
});
