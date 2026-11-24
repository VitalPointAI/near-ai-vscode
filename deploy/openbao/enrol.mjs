#!/usr/bin/env node
// Person enrolment and administrator-attested re-enrolment on the OpenBao side (D-33, D-40, D-09).
//
//   enrol:  Keycloak cannot require two keys, so this script does: it counts the person's registered passwordless (WebAuthn) keys through the
//           Keycloak admin REST API and refuses below two distinct keys, before any OpenBao call. Then it makes sure the person's OpenBao
//           entity exists with its alias on the jwt mount (the alias name is the Keycloak user id, the `sub` the jwt roles bind to) and creates
//           the two Transit keys, non-exportable: person-<entity> (ed25519, signing) and kek-<entity> (aes256-gcm96, key encryption). Until
//           then the person can sign in but cannot sign. A second run changes nothing. The workbench never creates or deletes keys.
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
import { openbaoClient } from './apply.mjs';

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

/** The entity whose alias on the jwt mount is `sub`, as { entityId, aliasId } or null. */
async function lookupAlias(bao, accessor, sub) {
  const result = await bao('POST', 'identity/lookup/entity', { alias_name: sub, alias_mount_accessor: accessor });
  if (result.status === 204 || !result.data?.data) return null;
  const data = ok(result, 'look up entity');
  const alias = (data.aliases ?? []).find((entry) => entry.name === sub && entry.mount_accessor === accessor);
  return { entityId: data.id, aliasId: alias?.id };
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
export async function enrolPerson({ username, keycloak, bao }) {
  const user = await userWithTwoKeys(keycloak, username);
  const created = [];
  const accessor = await jwtAccessor(bao);
  let found = await lookupAlias(bao, accessor, user.id);
  if (!found) {
    const entity = ok(await bao('POST', 'identity/entity', { name: `keycloak-${user.id}`, metadata: { keycloak_user_id: user.id } }), 'create entity');
    ok(await bao('POST', 'identity/entity-alias', { name: user.id, canonical_id: entity.id, mount_accessor: accessor }), 'create entity alias');
    created.push('entity', 'alias');
    found = { entityId: entity.id };
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

/** The Keycloak admin REST client the CLI uses: findUser(username), credentials(userId). */
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
    credentials: (userId) => get(`users/${encodeURIComponent(userId)}/credentials`)
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
