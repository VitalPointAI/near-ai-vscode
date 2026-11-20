// Runs scripts/org-issuer.mjs (D-17) as the issuer would: a passphrase-protected key file, the twelve words, an enrolment file, a rules update and a key
// handover, each checked with the compiled readers the extension itself uses (dist/domain/gate/enrolment.js). Needs `npm run compile` first. Keys and the
// passphrase are made at test time; nothing here is key material.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
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
const PEM_HEAD = /^-{5}BEGIN ENCRYPTED PRIVATE KEY-{5}\n/;

test('create-key writes a passphrase-protected key file once', () => {
  const dir = folder();
  const file = path.join(dir, 'issuer-key.json');
  const made = run(['create-key', '--out', file]);
  assert.equal(made.status, 0, made.stderr);
  const key = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(key).sort(), ['createdAt', 'kind', 'privateKeyPem', 'publicKey', 'v']);
  assert.equal(key.v, 1);
  assert.equal(key.kind, 'near-ai-org-issuer-key');
  assert.equal(key.publicKey.length, 43);
  assert.match(key.privateKeyPem, PEM_HEAD);
  assert.ok(!Number.isNaN(Date.parse(key.createdAt)));
  // The passphrase opens it and gives the key the file names; without the passphrase it does not open.
  const opened = createPrivateKey({ key: key.privateKeyPem, format: 'pem', passphrase: PASSPHRASE });
  assert.equal(createPublicKey(opened).export({ format: 'jwk' }).x, key.publicKey);
  assert.throws(() => createPrivateKey({ key: key.privateKeyPem, format: 'pem' }));
  assert.throws(() => createPrivateKey({ key: key.privateKeyPem, format: 'pem', passphrase: OTHER_PASSPHRASE }));
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
  assert.doesNotThrow(() => createPrivateKey({ key: second.privateKeyPem, format: 'pem', passphrase: OTHER_PASSPHRASE }));
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

test('no secret reaches the screen', () => {
  assert.ok(outputs.length > 20);
  for (const text of outputs) {
    assert.ok(!text.includes('PRIVATE KEY'), 'no private key on screen');
    assert.ok(!text.includes(PASSPHRASE), 'no passphrase on screen');
    assert.ok(!text.includes(OTHER_PASSPHRASE), 'no passphrase on screen');
  }
});
