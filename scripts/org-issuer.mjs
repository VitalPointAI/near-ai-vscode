#!/usr/bin/env node
// The issuer tool for your organization's rules (FND-01, Phase 41 D-11 to D-17, D-56, D-57). The person who holds your organization's key uses it to make
// the key, read its twelve words aloud, enrol computers, send them newer rules and hand over to a new key. Plain Node, no package: it signs with the
// compiled signer in dist/ (the same code the extension checks with), and reads every file it writes back with the extension's own reader before it says
// done.
//
// Kept offline: run it on a computer that holds the key file and nothing else of your organization's. The key file is a small JSON file (version 2)
// whose private key is sealed with AES-256-GCM under a key derived from the passphrase with scrypt (N = 2^17, r = 8, p = 1, 16-byte random salt,
// 12-byte random nonce); it is written once with mode 0600, never overwritten, and create-key opens it again with the passphrase before it says done.
// A key file that is not sealed this way (an unencrypted key, an older format, other scrypt costs) is refused. The passphrase comes from the
// environment variable NEAR_ORG_ISSUER_PASSPHRASE or from the first line of --passphrase-file <file>; it is at least 12 characters, never an
// argument, and never printed.
//
//   npm run compile
//   node scripts/org-issuer.mjs create-key --out <key file>
//   node scripts/org-issuer.mjs words --key <key file>
//   node scripts/org-issuer.mjs sign-layer --key <key file> --rules <rules.json> --out <name.near-org-rules> [--days 90]
//   node scripts/org-issuer.mjs sign-enrolment --key <key file> --organization <organization.json> --rules <rules.json> \
//     --out <name.near-org-enrolment> [--days 30] [--layer-days 90] [--serial 1]
//   node scripts/org-issuer.mjs rotate --key <old key file> --new-key <new key file> --organization <organization.json> --rules <rules.json> \
//     --out <name.near-org-enrolment> --serial <n> [--days 30] [--layer-days 90]
//
// rules.json holds the sections of your organization's rules ({ "labels": ..., "agents": ..., ... }); the tool writes the rest (version, issuer, dates,
// layer and the features the sections need). organization.json is { "name": "...", "contacts": [{ "topic": "security", "name": "...", "how": "..." }] }.
// An enrolment file is at most 64 KiB: when the first rules do not fit, enrol with a smaller first set and send the rest with sign-layer (up to 1 MiB).
// For rotate, the new key's passphrase comes from NEAR_ORG_ISSUER_NEW_PASSPHRASE or --new-passphrase-file, else it is the same passphrase.
//
// Exit codes: 0 done, 1 refused (one plain sentence on stderr, nothing written), 2 usage.
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync, sign as cryptoSign } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY_KIND = 'near-ai-org-issuer-key';
const KEY_FILE_VERSION = 2;
/**
 * WR-04: the one sealing the key file accepts. Fixed, not read from the file, so a file that names a cheaper cost is refused rather than opened.
 * N = 2^17 with r = 8 needs 128 MiB and about a third of a second per try on a current computer; maxmem leaves room above that.
 */
const SEAL = Object.freeze({ kdf: 'scrypt', N: 2 ** 17, r: 8, p: 1, cipher: 'aes-256-gcm', saltBytes: 16, nonceBytes: 12, tagBytes: 16, keyBytes: 32 });
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const SEALED_FIELDS = ['cipher', 'ciphertext', 'kdf', 'N', 'nonce', 'p', 'r', 'salt', 'tag'];
const KEY_FILE_FIELDS = ['createdAt', 'kind', 'privateKey', 'publicKey', 'v'];
const MIN_PASSPHRASE = 12;
const MAX_KEY_FILE_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const DAY_LIMITS = { layer: 366, enrolment: 90 };

class Refusal extends Error {}
class Usage extends Error {}

function refuse(message) { throw new Refusal(message); }
function usage(message) { throw new Usage(message); }

// ---- The compiled signer and readers ------------------------------------------------------------------------------------------------------------------
function loadDist() {
  const require = createRequire(import.meta.url);
  try {
    return {
      enrolment: require(path.join(ROOT, 'dist', 'domain', 'gate', 'enrolment.js')),
      canonical: require(path.join(ROOT, 'dist', 'domain', 'team', 'canonical.js')),
      policyDocument: require(path.join(ROOT, 'dist', 'domain', 'gate', 'policyDocument.js'))
    };
  } catch {
    usage('Run npm run compile first: this tool uses the compiled signer in dist/.');
  }
  return undefined;
}

// ---- Arguments ----------------------------------------------------------------------------------------------------------------------------------------
const COMMANDS = {
  'create-key': { required: ['--out'], optional: ['--passphrase-file'] },
  words: { required: ['--key'], optional: [] },
  'sign-layer': { required: ['--key', '--rules', '--out'], optional: ['--days', '--passphrase-file'] },
  'sign-enrolment': { required: ['--key', '--organization', '--rules', '--out'], optional: ['--days', '--layer-days', '--serial', '--passphrase-file'] },
  rotate: {
    required: ['--key', '--new-key', '--organization', '--rules', '--out', '--serial'],
    optional: ['--days', '--layer-days', '--passphrase-file', '--new-passphrase-file']
  }
};

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const spec = COMMANDS[command];
  if (spec === undefined) usage(`Name one of: ${Object.keys(COMMANDS).join(', ')}. See the header of scripts/org-issuer.mjs.`);
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (flag === '--passphrase' || flag === '--new-passphrase') {
      usage('The passphrase is never taken as an argument: set NEAR_ORG_ISSUER_PASSPHRASE or use --passphrase-file.');
    }
    if (!spec.required.includes(flag) && !spec.optional.includes(flag)) usage(`${command} does not take ${String(flag).slice(0, 40)}. See the header of scripts/org-issuer.mjs.`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) usage(`${flag} needs a value.`);
    if (Object.prototype.hasOwnProperty.call(options, flag)) usage(`${flag} is given twice.`);
    options[flag] = value;
  }
  for (const flag of spec.required) if (options[flag] === undefined) usage(`${command} needs ${spec.required.join(', ')}.`);
  return { command, options };
}

function whole(options, flag, fallback, min, max) {
  const text = options[flag];
  if (text === undefined) return fallback;
  if (!/^[0-9]{1,10}$/.test(text)) usage(`${flag} must be a whole number from ${min} to ${max}.`);
  const value = Number(text);
  if (value < min || value > max) usage(`${flag} must be a whole number from ${min} to ${max}.`);
  return value;
}

function outPath(options, extension) {
  const out = options['--out'];
  if (!out.endsWith(extension)) usage(`--out must name a file ending with ${extension}.`);
  if (existsSync(out)) refuse(`${path.basename(out)} already exists. Nothing was written: choose another name.`);
  return out;
}

// ---- Passphrase and key file --------------------------------------------------------------------------------------------------------------------------
function passphraseFrom(envName, fileFlag, options, fallback) {
  const file = options[fileFlag];
  let passphrase;
  if (file !== undefined) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { refuse(`The passphrase file ${path.basename(file)} could not be read. Nothing was written.`); }
    passphrase = text.split(/\r?\n/)[0];
  } else {
    passphrase = process.env[envName] ?? fallback;
  }
  if (passphrase === undefined || passphrase === '') refuse('The key file needs a passphrase: set NEAR_ORG_ISSUER_PASSPHRASE or use --passphrase-file. Nothing was written.');
  if (passphrase.length < MIN_PASSPHRASE) refuse(`The passphrase must be at least ${MIN_PASSPHRASE} characters. Nothing was written.`);
  return passphrase;
}

function readSmall(file, max, what) {
  let size;
  try { size = statSync(file).size; } catch { refuse(`The ${what} ${path.basename(file)} could not be read. Nothing was written.`); }
  if (size > max) refuse(`The ${what} ${path.basename(file)} is larger than ${max} bytes. Nothing was written.`);
  try { return readFileSync(file, 'utf8'); } catch { refuse(`The ${what} ${path.basename(file)} could not be read. Nothing was written.`); }
  return undefined;
}

function readJson(file, what) {
  const text = readSmall(file, MAX_INPUT_BYTES, what);
  try { return JSON.parse(text); } catch { refuse(`The ${what} ${path.basename(file)} is not JSON. Nothing was written.`); }
  return undefined;
}

function sameKeys(value, names) {
  const keys = Object.keys(value).sort();
  const want = [...names].sort();
  return keys.length === want.length && keys.every((name, index) => name === want[index]);
}

/** The wrapping key for the private key, from the passphrase and the file's salt. */
function wrappingKey(passphrase, salt) {
  return scryptSync(passphrase.normalize('NFC'), salt, SEAL.keyBytes, { N: SEAL.N, r: SEAL.r, p: SEAL.p, maxmem: SCRYPT_MAXMEM });
}

/** Ties the ciphertext to the public key and the sealing it names, so neither can be swapped without the open failing. */
function sealedHeader(publicKey, sealed) {
  return Buffer.from(JSON.stringify([KEY_KIND, KEY_FILE_VERSION, publicKey, sealed.kdf, sealed.N, sealed.r, sealed.p, sealed.salt, sealed.cipher, sealed.nonce]), 'utf8');
}

/** Seals the 32-byte private key with the passphrase. */
function seal(publicKey, privateKeyBytes, passphrase) {
  const salt = randomBytes(SEAL.saltBytes);
  const nonce = randomBytes(SEAL.nonceBytes);
  const sealed = { kdf: SEAL.kdf, N: SEAL.N, r: SEAL.r, p: SEAL.p, salt: salt.toString('base64url'), cipher: SEAL.cipher, nonce: nonce.toString('base64url') };
  const key = wrappingKey(passphrase, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: SEAL.tagBytes });
    cipher.setAAD(sealedHeader(publicKey, sealed));
    const ciphertext = Buffer.concat([cipher.update(privateKeyBytes), cipher.final()]);
    return { ...sealed, ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
  } finally {
    key.fill(0);
  }
}

/** The key file's public part and sealed private key, checked; the private key stays sealed. */
function readKeyFile(dist, file) {
  const text = readSmall(file, MAX_KEY_FILE_BYTES, 'key file');
  const name = path.basename(file);
  let key;
  try { key = JSON.parse(text); } catch { refuse(`The key file ${name} is not a key file from this tool.`); }
  if (key === null || typeof key !== 'object' || Array.isArray(key) || key.kind !== KEY_KIND) refuse(`The key file ${name} is not a key file from this tool.`);
  // WR-04: an unencrypted key, or the older PKCS#8 file this tool once wrote, is never opened, so a key someone decrypted "for now" stops working.
  if (key.v !== KEY_FILE_VERSION || Object.prototype.hasOwnProperty.call(key, 'privateKeyPem') || typeof key.privateKey === 'string') {
    refuse(`The key file ${name} does not keep its key sealed with scrypt and AES-256-GCM as this tool does. Nothing was written: make a new key with create-key and enrol with it, or hand over to it with rotate.`);
  }
  const sealed = key.privateKey;
  const { isStrictBase64url } = dist.canonical;
  const ok = sameKeys(key, KEY_FILE_FIELDS) && typeof key.publicKey === 'string' && isStrictBase64url(key.publicKey, 32)
    && typeof key.createdAt === 'string'
    && sealed !== null && typeof sealed === 'object' && !Array.isArray(sealed) && sameKeys(sealed, SEALED_FIELDS)
    && sealed.kdf === SEAL.kdf && sealed.N === SEAL.N && sealed.r === SEAL.r && sealed.p === SEAL.p && sealed.cipher === SEAL.cipher
    && isStrictBase64url(sealed.salt, SEAL.saltBytes) && isStrictBase64url(sealed.nonce, SEAL.nonceBytes)
    && isStrictBase64url(sealed.tag, SEAL.tagBytes) && isStrictBase64url(sealed.ciphertext, 32);
  if (!ok) refuse(`The key file ${name} is not a key file from this tool, or its sealing is not the one this tool uses.`);
  return key;
}

/** Opens the key with its passphrase and returns the one signer shape every builder takes. The private key never leaves this function's closure. */
function signerFor(dist, file, passphrase) {
  const key = readKeyFile(dist, file);
  const sealed = key.privateKey;
  const wrap = wrappingKey(passphrase, Buffer.from(sealed.salt, 'base64url'));
  let seed;
  try {
    const decipher = createDecipheriv('aes-256-gcm', wrap, Buffer.from(sealed.nonce, 'base64url'), { authTagLength: SEAL.tagBytes });
    decipher.setAAD(sealedHeader(key.publicKey, sealed));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
    seed = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64url')), decipher.final()]);
  } catch {
    refuse(`The passphrase does not open the key file ${path.basename(file)}. Nothing was written.`);
  } finally {
    wrap.fill(0);
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: seed.toString('base64url'), x: key.publicKey }, format: 'jwk' });
  } catch {
    privateKey = undefined;
  } finally {
    seed.fill(0);
  }
  if (privateKey === undefined || privateKey.asymmetricKeyType !== 'ed25519' || createPublicKey(privateKey).export({ format: 'jwk' }).x !== key.publicKey) {
    refuse(`The key file ${path.basename(file)} is damaged: its key does not match the public key it names. Nothing was written.`);
  }
  const raw = Buffer.from(key.publicKey, 'base64url');
  return Object.freeze({
    fingerprint: dist.canonical.fingerprintOf(raw),
    publicKey: key.publicKey,
    sign: (bytes) => cryptoSign(null, bytes, privateKey).toString('base64url')
  });
}

function printWords(dist, publicKey, lead) {
  const { issuerWords, issuerWordsText, issuerFingerprintHex, issuerDetailsLine } = dist.enrolment;
  console.log(lead);
  console.log(`  ${issuerWordsText(issuerWords(publicKey))}`);
  console.log(issuerDetailsLine(issuerFingerprintHex(publicKey)));
}

/** Writes a file once (never over another), reads it back from disk and checks it with the extension's reader, or removes it and refuses. */
function writeChecked(out, text, check) {
  const before = check(text);
  if (before !== undefined) refuse(`Nothing was written: the file does not read back. ${before}`);
  try {
    writeFileSync(out, text, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error && error.code === 'EEXIST') refuse(`${path.basename(out)} already exists. Nothing was written: choose another name.`);
    refuse(`${path.basename(out)} could not be written. Nothing was written.`);
  }
  const back = readFileSync(out, 'utf8');
  const after = back === text ? check(back) : 'The file on disk differs from what was written.';
  if (after !== undefined) {
    // This run made the file a moment ago and it is wrong, so it is removed rather than left for someone to send.
    try { unlinkSync(out); } catch { /* reported below */ }
    refuse(`${path.basename(out)} did not read back and was removed. ${after}`);
  }
}

function built(make) {
  try { return make(); } catch (error) { refuse(String(error && error.message ? error.message : error).split('\n')[0]); }
  return undefined;
}

// ---- Commands -----------------------------------------------------------------------------------------------------------------------------------------
function createKey(dist, options) {
  const out = options['--out'];
  const passphrase = passphraseFrom('NEAR_ORG_ISSUER_PASSPHRASE', '--passphrase-file', options);
  if (existsSync(out)) refuse(`${path.basename(out)} already exists. Nothing was written: a key file is never replaced.`);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x;
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  let sealed;
  try { sealed = seal(raw, seed, passphrase); } finally { seed.fill(0); }
  const file = { v: KEY_FILE_VERSION, kind: KEY_KIND, publicKey: raw, privateKey: sealed, createdAt: new Date().toISOString() };
  try {
    writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error && error.code === 'EEXIST') refuse(`${path.basename(out)} already exists. Nothing was written: a key file is never replaced.`);
    refuse(`${path.basename(out)} could not be written. Nothing was written.`);
  }
  // WR-04: the file on disk is opened again with the passphrase before the tool says done. A key file this run just made that does not open is of no
  // use to anyone (nothing has been signed with it yet), so it is removed rather than left to be kept offline by mistake.
  let opened;
  try {
    opened = signerFor(dist, out, passphrase);
  } catch (error) {
    opened = undefined;
    if (!(error instanceof Refusal)) throw error;
  }
  if (opened === undefined || opened.publicKey !== raw) {
    try { unlinkSync(out); } catch { /* reported below */ }
    refuse(`${path.basename(out)} did not open again with the passphrase and was removed. Make a new key file.`);
  }
  console.log(`Wrote ${path.basename(out)}. Keep it offline, with its passphrase stored apart from it.`);
  printWords(dist, raw, 'Your organization\'s key reads as these twelve words:');
}

function words(dist, options) {
  const key = readKeyFile(dist, options['--key']);
  printWords(dist, key.publicKey, 'Your organization\'s key reads as these twelve words:');
}

function signLayer(dist, options) {
  const { enrolment } = dist;
  const out = outPath(options, enrolment.ORGANIZATION_RULES_FILE_EXTENSION);
  const days = whole(options, '--days', 90, 1, DAY_LIMITS.layer);
  const rules = readJson(options['--rules'], 'rules file');
  const signer = signerFor(dist, options['--key'], passphraseFrom('NEAR_ORG_ISSUER_PASSPHRASE', '--passphrase-file', options));
  const layer = built(() => enrolment.buildOrganizationLayer(signer, rules, { now: Date.now(), days }));
  const text = enrolment.fileTextOf(layer);
  writeChecked(out, text, (candidate) => {
    const verdict = enrolment.verifyOrganizationLayer(candidate, { issuerPublicKey: signer.publicKey, now: Date.now() });
    return verdict.ok ? undefined : verdict.message;
  });
  console.log(`Wrote ${path.basename(out)}: your organization's rules, valid until ${layer.payload.expiresAt}. Send it to the computers enrolled with this key.`);
}

function enrolmentFile(dist, options, rotation) {
  const { enrolment } = dist;
  const out = outPath(options, enrolment.ENROLMENT_FILE_EXTENSION);
  const days = whole(options, '--days', 30, 1, DAY_LIMITS.enrolment);
  const layerDays = whole(options, '--layer-days', 90, 1, DAY_LIMITS.layer);
  const serial = whole(options, '--serial', 1, rotation ? 2 : 1, 2 ** 31);
  const organization = readJson(options['--organization'], 'organization file');
  const rules = readJson(options['--rules'], 'rules file');
  const passphrase = passphraseFrom('NEAR_ORG_ISSUER_PASSPHRASE', '--passphrase-file', options);
  const first = signerFor(dist, options['--key'], passphrase);
  let signer = first;
  let previous;
  if (rotation) {
    signer = signerFor(dist, options['--new-key'], passphraseFrom('NEAR_ORG_ISSUER_NEW_PASSPHRASE', '--new-passphrase-file', options, passphrase));
    previous = first;
    if (signer.publicKey === previous.publicKey) refuse('The new key is the same as the old key. Nothing was written: make a new key with create-key.');
  }
  const now = Date.now();
  const layer = built(() => enrolment.buildOrganizationLayer(signer, rules, { now, days: layerDays }));
  const envelope = built(() => enrolment.buildEnrolment(signer, { organization, layer, now, days, serial, ...(previous === undefined ? {} : { rotation: previous }) }));
  const text = enrolment.fileTextOf(envelope);
  writeChecked(out, text, (candidate) => {
    const read = enrolment.readEnrolmentFile(candidate, { now: Date.now() });
    if (!read.ok) return read.message;
    if (rotation && enrolment.classifyEnrolment(read, { publicKey: previous.publicKey, serial: serial - 1 }) !== 'rotate') return 'The key handover does not read as a handover.';
    return undefined;
  });
  console.log(`Wrote ${path.basename(out)}: the enrolment file for ${organization.name}, serial ${serial}, valid until ${envelope.payload.expiresAt}.`);
  printWords(dist, signer.publicKey, rotation
    ? 'Your organization\'s new key reads as these twelve words. Read them to each person when they open the file:'
    : 'Read these twelve words to each person when they open the file:');
}

const HANDLERS = {
  'create-key': createKey,
  words,
  'sign-layer': signLayer,
  'sign-enrolment': (dist, options) => enrolmentFile(dist, options, false),
  rotate: (dist, options) => enrolmentFile(dist, options, true)
};

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  const dist = loadDist();
  HANDLERS[command](dist, options);
  process.exitCode = 0;
} catch (error) {
  if (error instanceof Usage) {
    console.error(error.message);
    process.exitCode = 2;
  } else if (error instanceof Refusal) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    // An unexpected failure: say what kind of thing failed, never the values it held.
    console.error(`Nothing was written: ${error && error.name ? error.name : 'an error'} stopped the tool.`);
    process.exitCode = 1;
  }
}
