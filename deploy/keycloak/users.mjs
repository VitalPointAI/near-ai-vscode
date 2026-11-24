#!/usr/bin/env node
// A person and their passwordless keys move between sites by signed file (D-08, D-36, D-49). Realm export leaves people out, so this script
// uses the Keycloak admin REST API.
//
//   export: reads each named person and their WebAuthn passwordless credential records at this site, writes one sterling-users/1 file and
//           signs it with your organization's cosign key (COSIGN_PASSWORD in the environment).
//   import: checks the file's signature with the public key from the install media first, and refuses before any Keycloak call when the
//           signature fails, the format is unknown, the file's requires names a feature this import does not read (USERS_FEATURES, 47 D-69)
//           or is missing, the relying-party id differs from this site's (a key registered under another rpId cannot work here), or a
//           record is not a passwordless WebAuthn credential. Then it creates each person who is missing, adds the
//           credential ids they do not already have, and leaves the rest. A second run changes nothing.
//
//   node deploy/keycloak/users.mjs export --users <username,...> --out <file> --key <cosign key> --site <site file> <connection flags>
//   node deploy/keycloak/users.mjs import --in <file> --public-key <cosign pub> --site <site file> <connection flags>
//   connection flags: --keycloak <https://keycloak.<domain>> --token-file <file> [--ca-file <site CA pem>] [--realm sterling]
//
// The admin token comes from a file, never an argument; Keycloak's admin tokens are short-lived, so get it just before the run. The rpId
// and the site name come from the site file. A person's OpenBao Transit keys are not in this file: moving them needs the two-person
// Control Group approval (D-40, the key-move runbook). Node built-ins only.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signFile, signatureFile, verifySignedFile } from '../bundle/signed-file.mjs';
import { loadSite } from '../bundle/lib/render.mjs';

export const FORMAT = 'sterling-users/1';
export const PASSWORDLESS = 'webauthn-passwordless';
/**
 * The feature ids this import reads (47 D-69, version safety). A file names what it needs in `requires` (sorted, unique `name@N` ids;
 * empty for people alone); an import refuses, whole and before any Keycloak call, a file naming an id that is not here. Every addition to
 * the file takes an id, and the import learns it in the same release before any export writes it (guests@1 in 47-21, marking@1 in 47-30).
 * A site reports this list as reads.users (47-32).
 */
export const USERS_FEATURES = Object.freeze([]);
const FEATURE_ID = /^[a-z][a-z0-9-]{0,31}@[1-9][0-9]{0,2}$/;
/**
 * The WebAuthn fields Keycloak stores. The admin API adds display fields looked up from the AAGUID (authenticatorProvider, iconLight,
 * iconDark) that its own user creation refuses, so only these travel (spike S6, 47-08).
 */
export const STORED_FIELDS = Object.freeze(['aaguid', 'credentialId', 'counter', 'credentialPublicKey', 'attestationStatementFormat', 'transports']);

const lower = (value) => String(value ?? '').toLowerCase();
/** A credential id compared across sites: base64 or base64url, with or without padding. */
const sameId = (value) => {
  let id = String(value ?? '').replaceAll('-', '+').replaceAll('_', '/');
  while (id.endsWith('=')) id = id.slice(0, -1);
  return id;
};
const parseData = (credential) => {
  try { return typeof credential.credentialData === 'string' ? JSON.parse(credential.credentialData) : credential.credentialData ?? null; } catch { return null; }
};

/** A Keycloak credential record as it travels: the passwordless type, its label and date, and only the stored WebAuthn fields. */
export function storedCredential(credential) {
  const data = parseData(credential) ?? {};
  const kept = Object.fromEntries(STORED_FIELDS.filter((field) => data[field] !== undefined).map((field) => [field, data[field]]));
  // A WebAuthn credential has no secret; Keycloak's user creation still needs the empty secretData (the 47-14 tracer: 500 without it).
  return { type: PASSWORDLESS, ...(credential.userLabel ? { userLabel: credential.userLabel } : {}), ...(credential.createdDate ? { createdDate: credential.createdDate } : {}),
    credentialData: JSON.stringify(kept), secretData: '{}' };
}

const answer = (result, what) => {
  if (result.status >= 300) throw new Error(`${what}: Keycloak answered ${result.status} ${JSON.stringify(result.data)}`);
  return result.data;
};

/** The person with exactly this username (Keycloak keeps usernames in lower case), or undefined. */
async function findPerson(admin, username) {
  const found = answer(await admin('GET', `users?username=${encodeURIComponent(username)}&exact=true&briefRepresentation=false`), `look up ${username}`);
  return (Array.isArray(found) ? found : []).find((person) => lower(person.username) === lower(username));
}

const passwordless = async (admin, id, username) => (answer(await admin('GET', `users/${encodeURIComponent(id)}/credentials`), `read the keys of ${username}`) ?? [])
  .filter((credential) => credential?.type === PASSWORDLESS);

/** The sterling-users/1 document for the named people. Refuses a name that is not a person here. `admin(method, path, body)` is relative to the realm. */
export async function exportUsers(admin, { usernames, sourceSite, rpId, created = new Date().toISOString() }) {
  if (!usernames?.length) throw new Error('name at least one person to export (--users).');
  if (!sourceSite || !rpId) throw new Error('the site name and rpId are needed (from the site file).');
  if (new Set(usernames.map(lower)).size !== usernames.length) throw new Error('a person is named twice in --users.');
  const users = [];
  for (const username of usernames) {
    const person = await findPerson(admin, username);
    if (!person?.id) throw new Error(`this site has no person ${username}; nothing was exported.`);
    const credentials = (await passwordless(admin, person.id, username)).map(storedCredential);
    users.push({ username: person.username, email: person.email ?? '', firstName: person.firstName ?? '', lastName: person.lastName ?? '',
      enabled: person.enabled !== false, emailVerified: person.emailVerified === true, credentials });
  }
  return { format: FORMAT, requires: [], sourceSite, rpId, created, users };
}

/** Every reason a parsed document may not be imported at a site whose rpId is `rpId`; empty means it may. */
export function checkUsersDocument(document, rpId) {
  if (!document || typeof document !== 'object') return ['the file is not a JSON object'];
  if (document.format !== FORMAT) return [`the format is ${JSON.stringify(document.format)}, not ${FORMAT}`];
  // requires is part of sterling-users/1 from its first version (47 D-69): a file without it, or with a malformed list, is not one this
  // import can trust to name what it needs, so it is refused like an unknown format.
  const requires = document.requires;
  if (!Array.isArray(requires)) return ['the file has no requires list (47 D-69); export it again with this release\'s users.mjs'];
  if (!requires.every((id) => typeof id === 'string' && FEATURE_ID.test(id))) return [`the file's requires ${JSON.stringify(requires)} is not a list of name@N feature ids`];
  if (requires.some((id, index) => index > 0 && requires[index - 1] >= id)) return [`the file's requires ${JSON.stringify(requires)} is not sorted and unique`];
  const unread = requires.filter((id) => !USERS_FEATURES.includes(id));
  if (unread.length) {
    return [`the file needs ${unread.join(', ')}, which this site's import does not read; update this site from a newer signed bundle first, then import the file again`];
  }
  if (!rpId || document.rpId !== rpId) return [`the file's relying-party id ${JSON.stringify(document.rpId)} is not this site's ${JSON.stringify(rpId)}; a key registered under another rpId cannot sign in here (D-08)`];
  if (!Array.isArray(document.users) || !document.users.length) return ['the file lists no people'];
  const problems = [];
  const names = new Set();
  const ids = new Set();
  for (const user of document.users) {
    const name = typeof user?.username === 'string' ? user.username.trim() : '';
    if (!name) { problems.push('a person has no username'); continue; }
    if (names.has(lower(name))) problems.push(`${name} is listed twice`);
    names.add(lower(name));
    if (!Array.isArray(user.credentials)) { problems.push(`${name} has no credentials list`); continue; }
    for (const credential of user.credentials) {
      if (credential?.type !== PASSWORDLESS) { problems.push(`${name} has a ${JSON.stringify(credential?.type)} credential; only ${PASSWORDLESS} records are carried`); continue; }
      const data = parseData(credential);
      if (!data?.credentialId || !data.credentialPublicKey) { problems.push(`${name} has a credential without a credential id and public key`); continue; }
      const extra = Object.keys(data).filter((field) => !STORED_FIELDS.includes(field));
      if (extra.length) problems.push(`${name}'s credential carries ${extra.join(', ')}, which Keycloak's import refuses`);
      if (ids.has(sameId(data.credentialId))) problems.push(`the credential id ${data.credentialId} appears twice`);
      ids.add(sameId(data.credentialId));
    }
  }
  return problems;
}

/**
 * Verifies the signed file and returns its text. The file and its signature are copied into a private folder first, and the copy that was
 * verified is the one read, so the file cannot change between the check and the use.
 */
export function readVerified(file, publicKey, { cosign } = {}) {
  if (!existsSync(file)) return { ok: false, reason: `${file} does not exist` };
  const dir = mkdtempSync(path.join(tmpdir(), 'sterling-signed-'));
  try {
    const copy = path.join(dir, path.basename(file));
    copyFileSync(file, copy);
    if (existsSync(signatureFile(file))) copyFileSync(signatureFile(file), signatureFile(copy));
    const verified = verifySignedFile(copy, publicKey, { cosign });
    return verified.ok ? { ok: true, reason: '', text: readFileSync(copy, 'utf8') } : verified;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Imports a signed sterling-users/1 file. Returns { ok: false, reason } with no Keycloak call when the file is refused, else
 * { ok: true, results: [{ username, result: 'created' | 'keys added' | 'unchanged', added, skipped }] }. Throws on a Keycloak error.
 */
export async function importUsers(admin, { file, publicKey, rpId, cosign }) {
  const verified = readVerified(file, publicKey, { cosign });
  if (!verified.ok) return { ok: false, reason: verified.reason };
  let document;
  try { document = JSON.parse(verified.text); } catch (error) { return { ok: false, reason: `the file is not JSON (${error.message})` }; }
  const problems = checkUsersDocument(document, rpId);
  if (problems.length) return { ok: false, reason: problems.join('; ') };
  const results = [];
  for (const user of document.users) {
    const credentials = user.credentials.map(storedCredential);
    const person = await findPerson(admin, user.username);
    if (!person?.id) {
      // With keys arriving, the passwordless registration action stays off; a person with none registers at first sign-in.
      const body = { username: user.username, email: user.email || undefined, firstName: user.firstName, lastName: user.lastName, enabled: user.enabled !== false,
        emailVerified: user.emailVerified === true, requiredActions: credentials.length ? [] : ['webauthn-register-passwordless'], credentials };
      answer(await admin('POST', 'users', body), `create ${user.username}`);
      results.push({ username: user.username, result: 'created', added: credentials.length, skipped: 0 });
      continue;
    }
    // A person of the same username with another email is someone else: their account never receives these keys.
    if (lower(person.email) !== lower(user.email)) throw new Error(`${user.username} exists here with another email (${person.email ?? 'none'}, the file says ${user.email || 'none'}); refusing to add their keys to a different person.`);
    const present = new Set((await passwordless(admin, person.id, user.username)).map((credential) => sameId(parseData(credential)?.credentialId)));
    const missing = credentials.filter((credential) => !present.has(sameId(parseData(credential).credentialId)));
    // PUT with credentials adds them and leaves the person's other fields and keys as they are (Keycloak 26.8.2, checked in the 47-14 tracer).
    if (missing.length) answer(await admin('PUT', `users/${encodeURIComponent(person.id)}`, { credentials: missing }), `add keys to ${user.username}`);
    results.push({ username: user.username, result: missing.length ? 'keys added' : 'unchanged', added: missing.length, skipped: credentials.length - missing.length });
  }
  return { ok: true, results };
}

/** The admin REST client: admin(method, path relative to /admin/realms/<realm>/, body) -> { status, data }. */
export function keycloakAdmin({ base, realm = 'sterling', token, caPem }) {
  const root = new URL(base);
  const transport = root.protocol === 'https:' ? https : http;
  return (method, apiPath, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = transport.request(new URL(`/admin/realms/${encodeURIComponent(realm)}/${apiPath}`, root), { method, ca: caPem,
      headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
        resolve({ status: response.statusCode, data });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...argv] = process.argv.slice(2);
  const option = (flag) => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  const usage = 'usage: users.mjs export --users <username,...> --out <file> --key <cosign key> --site <site file> <connection flags>\n'
    + '       users.mjs import --in <file> --public-key <cosign pub> --site <site file> <connection flags>\n'
    + '       connection flags: --keycloak <url> --token-file <file> [--ca-file <pem>] [--realm sterling]';
  if (!command || command === '--help' || argv.includes('--help')) { console.log(usage); process.exit(command ? 0 : 2); }
  try {
    const required = { export: ['--users', '--out', '--key'], import: ['--in', '--public-key'] }[command];
    const missing = required ? [...required, '--site', '--keycloak', '--token-file'].filter((flag) => !option(flag)) : [];
    if (!required || missing.length) throw new Error(`${usage}${missing.length ? `\nmissing: ${missing.join(' ')}` : ''}`);
    const site = loadSite(option('--site'));
    const admin = keycloakAdmin({ base: option('--keycloak'), realm: option('--realm') ?? 'sterling', token: readFileSync(option('--token-file'), 'utf8').trim(),
      caPem: option('--ca-file') ? readFileSync(option('--ca-file'), 'utf8') : undefined });
    if (command === 'export') {
      const document = await exportUsers(admin, { usernames: option('--users').split(',').map((name) => name.trim()).filter(Boolean), sourceSite: site.siteName, rpId: site.rpId });
      const out = option('--out');
      writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      try { signFile(out, option('--key')); } catch (error) { rmSync(out, { force: true }); throw error; }
      const keys = document.users.reduce((sum, user) => sum + user.credentials.length, 0);
      console.log(`exported ${document.users.length} people with ${keys} passwordless keys to ${out}, signed (${signatureFile(out)})`);
    } else {
      const result = await importUsers(admin, { file: option('--in'), publicKey: option('--public-key'), rpId: site.rpId });
      if (!result.ok) { console.error(`refused: ${result.reason}; nothing was changed.`); process.exit(1); }
      for (const entry of result.results) console.log(`${entry.result}: ${entry.username} (${entry.added} keys added, ${entry.skipped} already here)`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
