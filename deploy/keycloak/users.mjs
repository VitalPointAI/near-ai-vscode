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
// Guests stay at their site unless they are named (D-64, 47-21). Export refuses a member of guests that --include-guests does not name, and
// one who is ended or past their end. A named guest's record carries guest { until, requestedBy, approvedBy, approvalRef } and their DID only:
// how they serve, their nationality, organization and agreements are credentials, issued again by the destination's security contact. A file
// that names a guest requires guests@1, so a site whose import does not read guest records refuses it whole; and before it writes anything,
// export --include-guests checks that the target site's newest signed evidence export shows its import reads guests@1 (site-evidence.mjs).
// Import refuses, before any Keycloak call, a guest record that --include-guests does not name or whose details fail this site's guest rules
// (checkGuestRequest under the realm site file), then checks this site's lead and security contact (guests.mjs checkApproval) and creates the
// guest in /guests, ending at the earlier of the source's end and this site's guests.maxDays. It never creates OpenBao entities or keys: the
// guest enrols here with enrol.mjs enrol, and their Transit keys never move.
//
//   node deploy/keycloak/users.mjs export --users <username,...> --out <file> --key <cosign key> --site <site file> <connection flags>
//        [--include-guests <username,...> --target-site <id> --sites <file> --site-exports <folder> --bao <url> --bao-token-file <file>]
//   node deploy/keycloak/users.mjs import --in <file> --public-key <cosign pub> --site <site file> <connection flags>
//        [--include-guests <username,...> --realm-site <file> --requested-by <lead> --approved-by <security contact>
//         --approver-credential <file> --trust <folder> --approval-ref <reference> --bao <url> --bao-token-file <file>]
//   connection flags: --keycloak <https://keycloak.<domain>> --token-file <file> [--ca-file <site CA pem>] [--realm sterling]
//   --bao-token-file: a token with policy guest-operator (it reads a guest's DID at export, and the approver's at import).
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
import { openbaoClient } from '../openbao/apply.mjs';
import { checkApproval, checkGuestRequest, credentialCheck, guestSettings, GUESTS_GROUP, UTC_INSTANT } from './guests.mjs';
import { newestSiteEvidence, parseSitesFile } from './site-evidence.mjs';

export const FORMAT = 'sterling-users/1';
export const PASSWORDLESS = 'webauthn-passwordless';
/**
 * The feature ids this import reads (47 D-69, version safety). A file names what it needs in `requires` (sorted, unique `name@N` ids;
 * empty for people alone); an import refuses, whole and before any Keycloak call, a file naming an id that is not here. Every addition to
 * the file takes an id, and the import learns it in the same release before any export writes it (guests@1 in 47-21, marking@1 in 47-30).
 * A site reports this list as reads.users (47-32).
 */
export const USERS_FEATURES = Object.freeze(['guests@1']);
/** The feature a file needs when it names a guest (47-21). */
export const GUESTS_FEATURE = 'guests@1';
/** The fields of a guest record's guest object: the guest's life cycle at the source, nothing about the person. */
export const GUEST_RECORD_FIELDS = Object.freeze(['until', 'requestedBy', 'approvedBy', 'approvalRef']);
const GUEST_USER_FIELDS = Object.freeze(['username', 'email', 'firstName', 'lastName', 'enabled', 'emailVerified', 'credentials', 'guest', 'did']);
const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,512}$/;
const DAY_MS = 86_400_000;
const utc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const attribute = (person, name) => person?.attributes?.[name]?.[0];
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

/**
 * The sterling-users/1 document for the named people. Refuses a name that is not a person here, and a guest unless includeGuests names them
 * (D-64). A named guest must be enabled, not ended and before their end; their record gets guest {...} and did, from didOf(keycloakId) (the
 * site's people directory). `admin(method, path, body)` is relative to the realm.
 */
export async function exportUsers(admin, { usernames, sourceSite, rpId, created = new Date().toISOString(), includeGuests = [], didOf, now = Date.now() }) {
  if (!usernames?.length) throw new Error('name at least one person to export (--users).');
  if (!sourceSite || !rpId) throw new Error('the site name and rpId are needed (from the site file).');
  if (new Set(usernames.map(lower)).size !== usernames.length) throw new Error('a person is named twice in --users.');
  const named = new Set(includeGuests.map(lower));
  for (const name of named) if (!usernames.some((username) => lower(username) === name)) throw new Error(`--include-guests names ${name}, who is not in --users; nothing was exported.`);
  const users = [];
  for (const username of usernames) {
    const person = await findPerson(admin, username);
    if (!person?.id) throw new Error(`this site has no person ${username}; nothing was exported.`);
    const guest = (answer(await admin('GET', `users/${encodeURIComponent(person.id)}/groups`), `read the groups of ${username}`) ?? []).some((group) => group.path === GUESTS_GROUP);
    if (guest && !named.has(lower(person.username))) throw new Error(`${person.username} is a guest. Guests stay at their site unless you name them with --include-guests (D-64). Nothing was exported.`);
    if (!guest && named.has(lower(person.username))) throw new Error(`--include-guests names ${person.username}, who is not a guest here; nothing was exported.`);
    let guestRecord = {};
    if (guest) {
      if (person.enabled === false || attribute(person, 'guestEndedAt')) throw new Error(`${person.username}'s guest account has ended, so it cannot be carried to another site; nothing was exported.`);
      const until = attribute(person, 'guestUntil');
      if (!until || !(Date.parse(until) > now)) throw new Error(`${person.username}'s end date ${until ?? '(none)'} has passed, so the guest cannot be carried to another site; nothing was exported.`);
      const did = didOf ? await didOf(person.id) : undefined;
      if (!DID.test(String(did ?? ''))) throw new Error(`${person.username} has no DID in this site's people directory, so the destination's security contact could not issue their credentials. They enrol and sign in once here first; nothing was exported.`);
      guestRecord = { guest: { until, requestedBy: attribute(person, 'guestRequestedBy') ?? '', approvedBy: attribute(person, 'guestApprovedBy') ?? '', approvalRef: attribute(person, 'guestApprovalRef') ?? '' }, did };
    }
    const credentials = (await passwordless(admin, person.id, username)).map(storedCredential);
    users.push({ username: person.username, email: person.email ?? '', firstName: person.firstName ?? '', lastName: person.lastName ?? '',
      enabled: person.enabled !== false, emailVerified: person.emailVerified === true, credentials, ...guestRecord });
  }
  return { format: FORMAT, requires: users.some((user) => user.guest) ? [GUESTS_FEATURE] : [], sourceSite, rpId, created, users };
}

/**
 * The authoring check before a guest leaves (47 D-69, 32.1 D-62): the target site's newest signed evidence export must show that its user
 * import reads guests@1. Reads only files; returns nothing or throws one sentence naming the site and what it lacks.
 */
export function checkGuestTarget({ site, sitesFile, siteExports, now = Date.now() } = {}) {
  if (!site || !sitesFile || !siteExports) throw new Error('A guest is carried only to a site that reads guest records: give --target-site, --sites and --site-exports (your organization\'s sites file and the folder of signed site evidence exports). Nothing was exported.');
  let sites;
  try { sites = parseSitesFile(JSON.parse(readFileSync(sitesFile, 'utf8'))); } catch (error) { throw new Error(`${error.message} Nothing was exported.`); }
  const evidence = newestSiteEvidence({ site, sites, exportsDir: siteExports, now });
  if (evidence.refusal) throw new Error(`${evidence.refusal} Nothing was exported.`);
  if (!(evidence.reads.users ?? []).includes(GUESTS_FEATURE)) {
    throw new Error(`${site} runs Sterling ${evidence.release}, whose user import does not read ${GUESTS_FEATURE} (guest records), so a guest would arrive there as an ordinary member. Ask its administrator to update the site and send a fresh site evidence export. Nothing was exported.`);
  }
}

/**
 * export as the CLI runs it: with guests named, the target-site check first (before any Keycloak call), then the document, then the file
 * written and signed with your organization's key. No file is left when anything is refused or the signing fails.
 */
export async function exportUsersToFile(admin, { usernames, includeGuests = [], sourceSite, rpId, out, key, target, didOf, now = Date.now(), created, cosign }) {
  if (includeGuests.length) checkGuestTarget({ ...target, now });
  const document = await exportUsers(admin, { usernames, includeGuests, sourceSite, rpId, didOf, now, ...(created ? { created } : {}) });
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  try { signFile(out, key, { cosign }); } catch (error) { rmSync(out, { force: true }); throw error; }
  return document;
}

/** The problems of one record's guest fields (47-21): the guest object's four strings with a UTC end, a DID, and nothing else on the record. */
function guestRecordProblems(user, name) {
  const problems = [];
  const extra = Object.keys(user).filter((field) => !GUEST_USER_FIELDS.includes(field));
  if (extra.length) problems.push(`${name}'s record carries ${extra.join(', ')}; a guest's other details are credentials and never travel`);
  const guest = user.guest;
  if (!guest || typeof guest !== 'object' || Array.isArray(guest) || Object.keys(guest).sort().join() !== [...GUEST_RECORD_FIELDS].sort().join()
    || !GUEST_RECORD_FIELDS.every((field) => typeof guest[field] === 'string' && guest[field].trim())) {
    problems.push(`${name}'s guest details must be exactly ${GUEST_RECORD_FIELDS.join(', ')}, each given; how a guest serves, their nationality and organization are credentials, not guest details`);
  } else if (!UTC_INSTANT.test(guest.until)) problems.push(`${name}'s end ${JSON.stringify(guest.until)} is not a UTC time`);
  if (!DID.test(String(user.did ?? ''))) problems.push(`${name}'s record has no DID, so this site's security contact could not issue their credentials`);
  return problems;
}

/** Every reason a parsed document may not be imported at a site whose rpId is `rpId`; empty means it may. */
export function checkUsersDocument(document, rpId, features = USERS_FEATURES) {
  if (!document || typeof document !== 'object') return ['the file is not a JSON object'];
  if (document.format !== FORMAT) return [`the format is ${JSON.stringify(document.format)}, not ${FORMAT}`];
  // requires is part of sterling-users/1 from its first version (47 D-69): a file without it, or with a malformed list, is not one this
  // import can trust to name what it needs, so it is refused like an unknown format.
  const requires = document.requires;
  if (!Array.isArray(requires)) return ['the file has no requires list (47 D-69); export it again with this release\'s users.mjs'];
  if (!requires.every((id) => typeof id === 'string' && FEATURE_ID.test(id))) return [`the file's requires ${JSON.stringify(requires)} is not a list of name@N feature ids`];
  if (requires.some((id, index) => index > 0 && requires[index - 1] >= id)) return [`the file's requires ${JSON.stringify(requires)} is not sorted and unique`];
  const unread = requires.filter((id) => !features.includes(id));
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
    if (user.guest !== undefined) {
      // A guest record without guests@1 in requires would be read as an ordinary member by a site that does not read guest records (T-47-125).
      if (!requires.includes(GUESTS_FEATURE)) problems.push(`${name} is a guest, but the file's requires does not name ${GUESTS_FEATURE}`);
      problems.push(...guestRecordProblems(user, name));
    } else if (user.did !== undefined) problems.push(`${name}'s record carries a DID but no guest details; only a guest's record carries one`);
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
 * The guest records of a checked document under this site's rules, before any Keycloak call (D-64): each must be named in includeGuests and
 * pass checkGuestRequest with the end set to the earlier of the source's end and now + this site's guests.maxDays. Returns { problems, ends }.
 */
function checkGuestRecords(document, includeGuests, guests) {
  const named = new Set(includeGuests.map(lower));
  const records = document.users.filter((user) => user.guest);
  const problems = [];
  for (const name of named) if (!records.some((user) => lower(user.username) === name)) problems.push(`--include-guests names ${name}, who is not a guest in this file`);
  const ends = new Map();
  for (const user of records) {
    if (!named.has(lower(user.username))) { problems.push(`${user.username} is a guest. Guests come to this site only when you name them with --include-guests (D-64)`); continue; }
    if (!guests) { problems.push(`${user.username} is a guest: give this site's realm site file, lead, security contact and approval (--realm-site, --requested-by, --approved-by, --approver-credential, --trust, --approval-ref)`); continue; }
    const now = guests.now ?? Date.now();
    const maxDays = Number(guests.settings?.maxDays ?? 0);
    const end = maxDays > 0 ? Math.min(Date.parse(user.guest.until), now + maxDays * DAY_MS) : Date.parse(user.guest.until);
    const request = { user: user.username, until: utc(end), requestedBy: guests.requestedBy, approvedBy: guests.approvedBy, approverCredential: guests.approverCredential,
      trust: guests.trust, approvalRef: guests.approvalRef };
    const check = checkGuestRequest(request, guests.settings, now);
    problems.push(...check.problems.map((problem) => `${user.username}: ${problem}`));
    ends.set(user.username, check.until);
  }
  return { problems, ends };
}

/**
 * Imports a signed sterling-users/1 file. Returns { ok: false, reason } with no Keycloak call when the file is refused, else
 * { ok: true, results: [{ username, result: 'created' | 'keys added' | 'unchanged', added, skipped, guest? }] }. Throws on a Keycloak error,
 * and before any write when this site's lead or security contact does not hold (GuestRefusal) or a guest's name belongs to a member here.
 * `features` is what this import reads (USERS_FEATURES; a test stands in a site on an older release with another list). Guest records need
 * includeGuests and `guests`: { settings (guestSettings of the realm site file), requestedBy, approvedBy, approverCredential, trust,
 * approvalRef, bao (a guest-operator token's client), checkCredential?, now? }.
 */
export async function importUsers(admin, { file, publicKey, rpId, cosign, features = USERS_FEATURES, includeGuests = [], guests }) {
  const verified = readVerified(file, publicKey, { cosign });
  if (!verified.ok) return { ok: false, reason: verified.reason };
  let document;
  try { document = JSON.parse(verified.text); } catch (error) { return { ok: false, reason: `the file is not JSON (${error.message})` }; }
  const problems = checkUsersDocument(document, rpId, features);
  if (problems.length) return { ok: false, reason: problems.join('; ') };
  const { problems: guestProblems, ends } = checkGuestRecords(document, includeGuests, guests);
  if (guestProblems.length) return { ok: false, reason: guestProblems.join('; ') };
  if (ends.size) {
    // Reads only: a guest's name must not belong to a member here, and this site's lead and security contact must hold (47-19).
    for (const username of ends.keys()) {
      const person = await findPerson(admin, username);
      if (person?.id && !(answer(await admin('GET', `users/${encodeURIComponent(person.id)}/groups`), `read the groups of ${username}`) ?? []).some((group) => group.path === GUESTS_GROUP)) {
        throw new Error(`${username} has an account here that is not a guest; a guest record never changes a member's account. Nothing was changed.`);
      }
    }
    await checkApproval({ request: { requestedBy: guests.requestedBy, approvedBy: guests.approvedBy, approverCredential: guests.approverCredential, trust: guests.trust },
      keycloak: admin, bao: guests.bao, checkCredential: guests.checkCredential ?? credentialCheck, now: guests.now ?? Date.now() });
  }
  const results = [];
  for (const user of document.users) {
    const credentials = user.credentials.map(storedCredential);
    const person = await findPerson(admin, user.username);
    const guestEnd = ends.get(user.username);
    if (!person?.id) {
      // With keys arriving, the passwordless registration action stays off; a person with none registers at first sign-in.
      const body = { username: user.username, email: user.email || undefined, firstName: user.firstName, lastName: user.lastName, enabled: user.enabled !== false,
        emailVerified: user.emailVerified === true, requiredActions: credentials.length ? [] : ['webauthn-register-passwordless'], credentials,
        // A guest arrives as a guest under this site's approval, never with the source's lead or approver, and never ended.
        ...(guestEnd ? { enabled: true, groups: [GUESTS_GROUP], attributes: { guestUntil: [guestEnd], guestRequestedBy: [guests.requestedBy], guestApprovedBy: [guests.approvedBy],
          guestApprovalRef: [guests.approvalRef] } } : {}) };
      answer(await admin('POST', 'users', body), `create ${user.username}`);
      results.push({ username: user.username, result: 'created', added: credentials.length, skipped: 0, ...(guestEnd ? { guest: { until: guestEnd, did: user.did } } : {}) });
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

/**
 * One HTTP call with the site CA: { method, url, headers, body (a string, sent as is), caPem } -> { status, data } with data the parsed
 * JSON, { raw } for other text, or null.
 */
export function httpCall({ method, url, headers = {}, body, caPem }) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(target, { method, ca: caPem, headers }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
        resolve({ status: response.statusCode, data });
      });
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/**
 * A client-credentials access token from Keycloak. The client id and secret travel only in the Basic Authorization header (RFC 6749 2.3.1,
 * each form-encoded first), never in the URL, the body or a command line.
 */
export async function clientCredentialsToken({ base, realm, clientId, secret, caPem, call = httpCall }) {
  const basic = Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString('base64');
  const result = await call({ method: 'POST', url: new URL(`/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`, base).toString(), caPem,
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  if (result.status !== 200 || typeof result.data?.access_token !== 'string') {
    throw new Error(`Keycloak refused the client credentials of ${clientId} in realm ${realm}: it answered ${result.status} ${JSON.stringify(result.data?.error_description ?? result.data?.error ?? '')}.`);
  }
  return result.data.access_token;
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
    + '         [--include-guests <username,...> --target-site <id> --sites <file> --site-exports <folder> --bao <url> --bao-token-file <file>]\n'
    + '       users.mjs import --in <file> --public-key <cosign pub> --site <site file> <connection flags>\n'
    + '         [--include-guests <username,...> --realm-site <file> --requested-by <lead> --approved-by <security contact> --approver-credential <file>\n'
    + '          --trust <folder> --approval-ref <reference> --bao <url> --bao-token-file <file>]\n'
    + '       connection flags: --keycloak <url> --token-file <file> [--ca-file <pem>] [--realm sterling]';
  if (!command || command === '--help' || argv.includes('--help')) { console.log(usage); process.exit(command ? 0 : 2); }
  try {
    const required = { export: ['--users', '--out', '--key'], import: ['--in', '--public-key'] }[command];
    const includeGuests = (option('--include-guests') ?? '').split(',').map((name) => name.trim()).filter(Boolean);
    const guestFlags = !includeGuests.length ? [] : command === 'export' ? ['--target-site', '--sites', '--site-exports', '--bao', '--bao-token-file']
      : ['--realm-site', '--requested-by', '--approved-by', '--approver-credential', '--trust', '--approval-ref', '--bao', '--bao-token-file'];
    const missing = required ? [...required, '--site', '--keycloak', '--token-file', ...guestFlags].filter((flag) => !option(flag)) : [];
    if (!required || missing.length) throw new Error(`${usage}${missing.length ? `\nmissing: ${missing.join(' ')}` : ''}`);
    const site = loadSite(option('--site'));
    const caPem = option('--ca-file') ? readFileSync(option('--ca-file'), 'utf8') : undefined;
    const admin = keycloakAdmin({ base: option('--keycloak'), realm: option('--realm') ?? 'sterling', token: readFileSync(option('--token-file'), 'utf8').trim(), caPem });
    const bao = includeGuests.length ? openbaoClient({ addr: option('--bao'), token: readFileSync(option('--bao-token-file'), 'utf8').trim(), caPem }) : null;
    if (command === 'export') {
      // A guest's DID comes from the site's people directory (71-10), through the guest's own entity guest-<Keycloak id>.
      const didOf = async (keycloakId) => {
        const entity = await bao('GET', `identity/entity/name/guest-${keycloakId}`);
        if (entity.status >= 300) return undefined;
        const entry = await bao('GET', `kv/data/site/people/${entity.data?.data?.id}`);
        return entry.status < 300 ? entry.data?.data?.data?.did : undefined;
      };
      const out = option('--out');
      const document = await exportUsersToFile(admin, { usernames: option('--users').split(',').map((name) => name.trim()).filter(Boolean), includeGuests, sourceSite: site.siteName,
        rpId: site.rpId, out, key: option('--key'), didOf, target: { site: option('--target-site'), sitesFile: option('--sites'), siteExports: option('--site-exports') } });
      const keys = document.users.reduce((sum, user) => sum + user.credentials.length, 0);
      const guests = document.users.filter((user) => user.guest).length;
      console.log(`exported ${document.users.length} people${guests ? ` (${guests} guest${guests === 1 ? '' : 's'}, for ${option('--target-site')})` : ''} with ${keys} passwordless keys to ${out}, signed (${signatureFile(out)})`);
    } else {
      const guests = includeGuests.length ? { settings: guestSettings(JSON.parse(readFileSync(option('--realm-site'), 'utf8'))), requestedBy: option('--requested-by'),
        approvedBy: option('--approved-by'), approverCredential: option('--approver-credential'), trust: option('--trust'), approvalRef: option('--approval-ref'), bao } : undefined;
      const result = await importUsers(admin, { file: option('--in'), publicKey: option('--public-key'), rpId: site.rpId, includeGuests, guests });
      if (!result.ok) { console.error(`refused: ${result.reason}; nothing was changed.`); process.exit(1); }
      for (const entry of result.results) {
        console.log(`${entry.result}: ${entry.username} (${entry.added} keys added, ${entry.skipped} already here)${entry.guest ? `, a guest until ${entry.guest.until}, DID ${entry.guest.did}` : ''}`);
      }
      if (result.results.some((entry) => entry.guest)) console.log('Next for each guest: enrol them here with deploy/openbao/enrol.mjs enrol; the security contact issues their credentials to the DID above.');
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
