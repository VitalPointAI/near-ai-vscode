#!/usr/bin/env node
// Person enrolment and administrator-attested re-enrolment on the OpenBao side (D-33, D-40, D-09).
//
//   enrol:  Keycloak cannot require two keys, so this script does: it counts the person's registered passwordless (WebAuthn) keys through the
//           Keycloak admin REST API and refuses below two distinct keys, before any OpenBao call. Then it makes sure the person's OpenBao
//           entity exists with its alias on the jwt mount (the alias name is the Keycloak user id, the `sub` the jwt roles bind to) and creates
//           the two Transit keys, non-exportable: person-<entity> (ed25519, signing) and kek-<entity> (aes256-gcm96, key encryption). Until
//           then the person can sign in but cannot sign. A second run changes nothing. The workbench never creates or deletes keys.
//           A member of the Keycloak group guests (deploy/keycloak/guests.mjs, D-61, D-62) is a guest: the account must be enabled with a
//           guestUntil in the future, and the entity is named guest-<Keycloak id> (staff: keycloak-<id>). A staff entity never becomes a
//           guest entity or back. A guest entity carries exactly the policy guest-account, which keeps the guest's secrets under
//           kv/guests/<entity>/ (where a security officer removes them after retention, D-84) and denies them kv/users/; a run adds it to a
//           guest entity that lacks it and refuses one that holds any other policy.
//   rebind: after the runbook has revoked the old credentials in Keycloak and the person has a new account with two new keys, moves the
//           person's jwt alias from the old Keycloak user id to the new one, so the same entity, secrets and keys stay theirs.
//
//   node deploy/openbao/enrol.mjs enrol --user <username> [connection flags]
//   node deploy/openbao/enrol.mjs rebind --user <username> --from-sub <old Keycloak user id> [connection flags]
//   connection flags: --keycloak <https://keycloak.<domain>> --realm sterling --keycloak-token-file <file>
//                     --bao <https://openbao:8200> --ca-file <site CA pem> --bao-token-file <file> (a token with policy enrolment)
//
// Tokens come from files, never arguments. Spike S5 showed a template inside a longer path segment (kek-{{identity.entity.id}}) works in
// OpenBao 2.7.3 ACLs, so no per-person policy is written. Node built-ins only.
import { readFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUEST_ACCOUNT_POLICY, openbaoClient } from './apply.mjs';

const GUESTS_GROUP = '/guests';
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export const PASSWORDLESS = 'webauthn-passwordless';
export const JWT_MOUNT = 'jwt';
export const KEYS = Object.freeze([
  { prefix: 'person', type: 'ed25519' },
  { prefix: 'kek', type: 'aes256-gcm96' }
]);

/** The WebAuthn credential id of a Keycloak credential: from its credentialData JSON, else the credential record's own id. */
function credentialId(credential) {
  try {
    const data = typeof credential.credentialData === 'string' ? JSON.parse(credential.credentialData) : credential.credentialData;
    if (data?.credentialId) return String(data.credentialId);
  } catch { /* a malformed record counts by its record id */ }
  return String(credential.id ?? '');
}

/** The number of distinct passwordless keys among a person's Keycloak credentials. */
export function countPasswordlessKeys(credentials) {
  return new Set((credentials ?? []).filter((credential) => credential?.type === PASSWORDLESS).map(credentialId).filter(Boolean)).size;
}

const ok = (result, what) => {
  if (result.status >= 300) throw new Error(`${what}: OpenBao answered ${result.status} ${JSON.stringify(result.data?.errors ?? result.data)}`);
  return result.data?.data ?? null;
};

async function jwtAccessor(bao) {
  const accessor = ok(await bao('GET', 'sys/auth'), 'read sys/auth')?.[`${JWT_MOUNT}/`]?.accessor;
  if (!accessor) throw new Error(`OpenBao has no ${JWT_MOUNT}/ auth mount; run deploy/openbao/apply.mjs first.`);
  return accessor;
}

/** The entity whose alias on the jwt mount is `sub`, as { entityId, aliasId, name } or null. */
async function lookupAlias(bao, accessor, sub) {
  const result = await bao('POST', 'identity/lookup/entity', { alias_name: sub, alias_mount_accessor: accessor });
  if (result.status === 204 || !result.data?.data) return null;
  const data = ok(result, 'look up entity');
  const alias = (data.aliases ?? []).find((entry) => entry.name === sub && entry.mount_accessor === accessor);
  return { entityId: data.id, aliasId: alias?.id, name: data.name };
}

/**
 * Whether the account is a guest, after the guest rules (D-61): an enabled account with a guestUntil in the future. Throws before any OpenBao
 * call when a guest breaks one.
 */
async function guestAccount(keycloak, user, now) {
  const guest = (await keycloak.groups(user.id)).some((group) => group.path === GUESTS_GROUP);
  if (!guest) return false;
  if (user.enabled === false) throw new Error(`${user.username ?? user.id}'s guest account is disabled; an ended guest is not enrolled.`);
  const until = user.attributes?.guestUntil?.[0];
  if (!until || !UTC_INSTANT.test(until)) throw new Error(`${user.username ?? user.id} is a guest without a valid end date (guestUntil ${JSON.stringify(until ?? null)}); set it with guests.mjs extend.`);
  if (!(Date.parse(until) > now)) throw new Error(`${user.username ?? user.id}'s guest account ended at ${until}; extend it with guests.mjs extend before enrolling.`);
  return true;
}

/** Refuses unless the Keycloak user has two distinct passwordless keys; returns the user. */
async function userWithTwoKeys(keycloak, username) {
  const user = await keycloak.findUser(username);
  if (!user?.id) throw new Error(`Keycloak has no user ${username}.`);
  const count = countPasswordlessKeys(await keycloak.credentials(user.id));
  if (count < 2) throw new Error(`${username} has ${count} registered passwordless key${count === 1 ? '' : 's'}; enrolment needs two registered keys before signing keys are made (D-33).`);
  return user;
}

/** Enrols a person (see the top of this file). Returns { entityId, created } (what was created this run). */
export async function enrolPerson({ username, keycloak, bao, now = Date.now() }) {
  const user = await userWithTwoKeys(keycloak, username);
  const guest = await guestAccount(keycloak, user, now);
  const prefix = guest ? 'guest' : 'keycloak';
  const created = [];
  const accessor = await jwtAccessor(bao);
  let found = await lookupAlias(bao, accessor, user.id);
  if (found && typeof found.name === 'string' && !found.name.startsWith(`${prefix}-`)) {
    throw new Error(`${username}'s OpenBao entity is ${found.name}, but the account is ${guest ? 'a guest' : 'staff'}; a staff entity never becomes a guest entity or back. An administrator checks the account.`);
  }
  if (!found && guest) {
    // An entity of this name without the person's alias was not made by this script, or a run stopped half way. Only the second is adopted:
    // it is enabled and names this Keycloak id. (A disabled one with no metadata can be written by any token that may disable guest entities.)
    const existing = await bao('GET', `identity/entity/name/guest-${user.id}`);
    if (existing.status === 200 && existing.data?.data) {
      const entity = existing.data.data;
      if (entity.disabled || entity.metadata?.keycloak_user_id !== user.id || entity.metadata?.account !== 'guest') {
        throw new Error(`OpenBao already has an entity guest-${user.id} that this script did not make (disabled or without this account's id); an administrator checks it before ${username} is enrolled.`);
      }
      ok(await bao('POST', 'identity/entity-alias', { name: user.id, canonical_id: entity.id, mount_accessor: accessor }), 'create entity alias');
      created.push('alias');
      found = { entityId: entity.id };
    }
  }
  if (!found) {
    const metadata = guest ? { keycloak_user_id: user.id, account: 'guest' } : { keycloak_user_id: user.id };
    const entity = ok(await bao('POST', 'identity/entity', { name: `${prefix}-${user.id}`, metadata, ...(guest ? { policies: [GUEST_ACCOUNT_POLICY] } : {}) }), 'create entity');
    ok(await bao('POST', 'identity/entity-alias', { name: user.id, canonical_id: entity.id, mount_accessor: accessor }), 'create entity alias');
    created.push('entity', 'alias');
    found = { entityId: entity.id };
  }
  if (guest) {
    // The guest's one policy (D-84): its secrets go under kv/guests/, never kv/users/. Added if missing; any other policy is refused (D-60).
    const entity = ok(await bao('GET', `identity/entity/id/${found.entityId}`), 'read the guest entity');
    const held = entity?.policies ?? [];
    const others = held.filter((name) => name !== GUEST_ACCOUNT_POLICY);
    if (others.length) throw new Error(`${username}'s OpenBao entity holds the policy ${others.join(', ')}; a guest holds only ${GUEST_ACCOUNT_POLICY}. An administrator removes it first.`);
    if (!held.includes(GUEST_ACCOUNT_POLICY)) {
      ok(await bao('POST', `identity/entity/id/${found.entityId}`, { policies: [GUEST_ACCOUNT_POLICY] }), `attach the policy ${GUEST_ACCOUNT_POLICY}`);
      created.push(GUEST_ACCOUNT_POLICY);
    }
  }
  for (const { prefix, type } of KEYS) {
    const name = `${prefix}-${found.entityId}`;
    const existing = await bao('GET', `transit/keys/${name}`);
    if (existing.status === 200) continue;
    if (existing.status !== 404) ok(existing, `read transit key ${name}`);
    ok(await bao('POST', `transit/keys/${name}`, { type, exportable: false, allow_plaintext_backup: false }), `create transit key ${name}`);
    created.push(name);
  }
  return { entityId: found.entityId, created };
}

/** Moves the person's jwt alias from the old Keycloak user id to the current one (re-enrolment, D-09). Returns { entityId }. */
export async function rebindPerson({ username, fromSub, keycloak, bao }) {
  const user = await userWithTwoKeys(keycloak, username);
  if (user.id === fromSub) throw new Error(`${username} still has the Keycloak user id ${fromSub}; nothing to re-bind.`);
  const accessor = await jwtAccessor(bao);
  const old = await lookupAlias(bao, accessor, fromSub);
  if (!old?.aliasId) throw new Error(`OpenBao has no person bound to the Keycloak user id ${fromSub}.`);
  const taken = await lookupAlias(bao, accessor, user.id);
  if (taken && taken.entityId !== old.entityId) throw new Error(`the Keycloak user id ${user.id} is already bound to another OpenBao entity; refusing to merge two people.`);
  if (!taken) ok(await bao('POST', `identity/entity-alias/id/${old.aliasId}`, { name: user.id, canonical_id: old.entityId, mount_accessor: accessor }), 'move entity alias');
  return { entityId: old.entityId };
}

/** The Keycloak admin REST client the CLI uses: findUser(username), credentials(userId), groups(userId). */
export function keycloakClient({ base, realm, token, caPem }) {
  const get = (apiPath) => new Promise((resolve, reject) => {
    const request = https.request(new URL(`/admin/realms/${encodeURIComponent(realm)}/${apiPath}`, base), { method: 'GET', ca: caPem, headers: { authorization: `Bearer ${token}` } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => (response.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(`Keycloak answered ${response.statusCode} for ${apiPath}`))));
    });
    request.on('error', reject);
    request.end();
  });
  return {
    findUser: async (username) => (await get(`users?username=${encodeURIComponent(username)}&exact=true`))[0],
    credentials: (userId) => get(`users/${encodeURIComponent(userId)}/credentials`),
    groups: (userId) => get(`users/${encodeURIComponent(userId)}/groups`)
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...argv] = process.argv.slice(2);
  const option = (flag) => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  const usage = 'usage: enrol.mjs enrol --user <username> | rebind --user <username> --from-sub <old Keycloak user id>\n'
    + '       with --keycloak <url> --realm sterling --keycloak-token-file <file> --bao <url> --ca-file <pem> --bao-token-file <file>';
  if (!command || command === '--help' || argv.includes('--help')) { console.log(usage); process.exit(command ? 0 : 2); }
  try {
    const required = ['--user', '--keycloak', '--keycloak-token-file', '--bao', '--ca-file', '--bao-token-file', ...(command === 'rebind' ? ['--from-sub'] : [])];
    const missing = required.filter((flag) => !option(flag));
    if (!['enrol', 'rebind'].includes(command) || missing.length) throw new Error(`${usage}${missing.length ? `\nmissing: ${missing.join(' ')}` : ''}`);
    const caPem = readFileSync(option('--ca-file'), 'utf8');
    const keycloak = keycloakClient({ base: option('--keycloak'), realm: option('--realm') ?? 'sterling', token: readFileSync(option('--keycloak-token-file'), 'utf8').trim(), caPem });
    const bao = openbaoClient({ addr: option('--bao'), token: readFileSync(option('--bao-token-file'), 'utf8').trim(), caPem });
    if (command === 'enrol') {
      const { entityId, created } = await enrolPerson({ username: option('--user'), keycloak, bao });
      console.log(`enrolled ${option('--user')}: entity ${entityId}; ${created.length ? `created ${created.join(', ')}` : 'nothing to create'}`);
    } else {
      const { entityId } = await rebindPerson({ username: option('--user'), fromSub: option('--from-sub'), keycloak, bao });
      console.log(`re-bound ${option('--user')} to entity ${entityId}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
