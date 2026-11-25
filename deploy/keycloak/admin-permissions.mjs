#!/usr/bin/env node
// The one Keycloak admin permission of the automatic end of guest accounts (47-20; D-62, D-63, owner item 17). The client
// sterling-guest-expiry may view the group guests and view and manage its members, and nothing else: no realm-management role, no other
// group, no user, client or role. Fine-grained admin permissions v2 keep this permission in the system client admin-permissions, which
// keycloak-config-cli 6.5.1 refuses to touch ("FGAP V2 is active and this client is system-managed", HTTP 403), so the realm applier Job
// runs this step after keycloak-config-cli when guests are on. It reads first and writes only what differs: a second run writes nothing.
//
// It refuses, before any write, when the realm switch adminPermissionsEnabled is off, when the client's service account holds a
// realm-management role, or when any other permission uses the client's policy (never wider than guests; it deletes nothing, so a
// permission someone added by hand stops the run and is named for the administrator to remove).
//
//   node deploy/keycloak/admin-permissions.mjs     reads KEYCLOAK_URL, KEYCLOAK_CLIENTID, KEYCLOAK_CLIENTSECRET (the applier's master-realm
//                                                  client, as keycloak-config-cli does), optional KEYCLOAK_REALM (sterling) and SITE_CA_FILE
// Node built-ins only.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientCredentialsToken, keycloakAdmin } from './users.mjs';

export const ADMIN_PERMISSIONS_CLIENT = 'admin-permissions';
export const EXPIRY_CLIENT = 'sterling-guest-expiry';
export const EXPIRY_POLICY = 'sterling-guest-expiry client';
export const EXPIRY_PERMISSION = 'guest-expiry manages members of guests';
/** The only scopes, on the only resource (the group guests). Probed on Keycloak 26.8.2: every operation the job uses, and 403 for staff. */
export const EXPIRY_SCOPES = Object.freeze(['manage-members', 'view', 'view-members']);
const enc = encodeURIComponent;

/** The client policy that names the expiry client (by its Keycloak id). */
export const policyBody = (clientId) => ({
  name: EXPIRY_POLICY, description: 'The service account of the automatic end of guest accounts (47-20).', type: 'client', logic: 'POSITIVE',
  decisionStrategy: 'UNANIMOUS', clients: [clientId]
});
/** The scope permission on the group guests (by its id) for that policy. */
export const permissionBody = (groupId, policyId) => ({
  name: EXPIRY_PERMISSION, description: 'Only the members of the group guests; nothing on other groups, users, clients or roles (47-20).', type: 'scope',
  resourceType: 'Groups', resources: [groupId], scopes: [...EXPIRY_SCOPES], policies: [policyId], logic: 'POSITIVE', decisionStrategy: 'UNANIMOUS'
});

const answer = (result, what) => {
  if (result.status >= 300) throw new Error(`${what}: Keycloak answered ${result.status} ${JSON.stringify(result.data?.errorMessage ?? result.data?.error ?? result.data ?? '')}`);
  return result.data;
};
const sameList = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const one = async (admin, apiPath, what) => {
  const found = answer(await admin('GET', apiPath), what) ?? [];
  return Array.isArray(found) ? found : [];
};

/**
 * Grants the permission (see the top of this file). `admin(method, path, body)` is relative to /admin/realms/<realm>/. Returns
 * [{ what, result: 'written' | 'unchanged' }]; throws a plain sentence on any refusal, before any write.
 */
export async function applyExpiryPermission(admin) {
  const realm = answer(await admin('GET', ''), 'read the realm');
  if (realm?.adminPermissionsEnabled !== true) throw new Error('The realm\'s fine-grained admin permissions are off (adminPermissionsEnabled), so the automatic end of guest accounts would have no access. Apply the realm with guests on first.');
  const idOf = async (clientId) => {
    const id = (await one(admin, `clients?clientId=${enc(clientId)}`, `find the client ${clientId}`)).find((client) => client.clientId === clientId)?.id;
    if (!id) throw new Error(`The realm has no client ${clientId}; apply the realm first.`);
    return id;
  };
  const permissionsClient = await idOf(ADMIN_PERMISSIONS_CLIENT);
  const expiryClient = await idOf(EXPIRY_CLIENT);
  const group = answer(await admin('GET', 'group-by-path/guests'), 'find the group guests');
  const serviceAccount = answer(await admin('GET', `clients/${enc(expiryClient)}/service-account-user`), `read the service account of ${EXPIRY_CLIENT}`);
  const roles = await one(admin, `users/${enc(serviceAccount.id)}/role-mappings/clients/${enc(await idOf('realm-management'))}`, 'read its realm-management roles');
  if (roles.length) throw new Error(`The service account of ${EXPIRY_CLIENT} holds the realm-management role ${roles.map((role) => role.name).join(', ')}. It must hold none: its only access is the permission on the group guests. Remove the role first.`);
  const base = `clients/${enc(permissionsClient)}/authz/resource-server`;
  const named = async (name, type) => (await one(admin, `${base}/policy?name=${enc(name)}&first=0&max=100`, `look up ${name}`)).find((entry) => entry.name === name && entry.type === type);

  const results = [];
  // The client policy.
  let policy = await named(EXPIRY_POLICY, 'client');
  const wantedPolicy = policyBody(expiryClient);
  if (policy) {
    const current = answer(await admin('GET', `${base}/policy/client/${enc(policy.id)}`), 'read the client policy');
    // The other permissions that use the policy: only ours may.
    const dependents = (await one(admin, `${base}/policy/${enc(policy.id)}/dependentPolicies`, 'read the permissions that use the client policy')).filter((entry) => entry.name !== EXPIRY_PERMISSION);
    if (dependents.length) throw new Error(`The permission ${dependents.map((entry) => JSON.stringify(entry.name)).join(', ')} also uses ${JSON.stringify(EXPIRY_POLICY)}, which would give the automatic end of guest accounts more than the group guests. Remove it in the administration console, then apply again. Nothing was changed.`);
    if (current.logic === wantedPolicy.logic && current.decisionStrategy === wantedPolicy.decisionStrategy && sameList(current.clients ?? [], wantedPolicy.clients)) results.push({ what: 'client policy', result: 'unchanged' });
    else {
      answer(await admin('PUT', `${base}/policy/client/${enc(policy.id)}`, { id: policy.id, ...wantedPolicy }), 'update the client policy');
      results.push({ what: 'client policy', result: 'written' });
    }
  } else {
    answer(await admin('POST', `${base}/policy/client`, wantedPolicy), 'create the client policy');
    policy = await named(EXPIRY_POLICY, 'client');
    if (!policy) throw new Error('Keycloak created the client policy but does not find it.');
    results.push({ what: 'client policy', result: 'written' });
  }
  // The scope permission.
  const wanted = permissionBody(group.id, policy.id);
  const permission = await named(EXPIRY_PERMISSION, 'scope');
  if (permission) {
    const current = answer(await admin('GET', `${base}/permission/scope/${enc(permission.id)}`), 'read the permission');
    const resources = (await one(admin, `${base}/policy/${enc(permission.id)}/resources`, 'read its resources')).map((entry) => entry.name);
    const scopes = (await one(admin, `${base}/policy/${enc(permission.id)}/scopes`, 'read its scopes')).map((entry) => entry.name);
    const policies = (await one(admin, `${base}/policy/${enc(permission.id)}/associatedPolicies`, 'read its policies')).map((entry) => entry.id);
    const agrees = current.resourceType === wanted.resourceType && current.logic === wanted.logic && current.decisionStrategy === wanted.decisionStrategy
      && sameList(resources, wanted.resources) && sameList(scopes, wanted.scopes) && sameList(policies, wanted.policies);
    if (agrees) results.push({ what: 'permission on the group guests', result: 'unchanged' });
    else {
      answer(await admin('PUT', `${base}/permission/scope/${enc(permission.id)}`, { id: permission.id, ...wanted }), 'update the permission');
      results.push({ what: 'permission on the group guests', result: 'written' });
    }
  } else {
    answer(await admin('POST', `${base}/permission/scope`, wanted), 'create the permission');
    results.push({ what: 'permission on the group guests', result: 'written' });
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const env = process.env;
    const missing = ['KEYCLOAK_URL', 'KEYCLOAK_CLIENTID', 'KEYCLOAK_CLIENTSECRET'].filter((name) => !env[name]);
    if (missing.length) throw new Error(`usage: KEYCLOAK_URL, KEYCLOAK_CLIENTID and KEYCLOAK_CLIENTSECRET must be set (missing: ${missing.join(', ')}).`);
    const caPem = env.SITE_CA_FILE ? readFileSync(env.SITE_CA_FILE, 'utf8') : undefined;
    const token = await clientCredentialsToken({ base: env.KEYCLOAK_URL, realm: 'master', clientId: env.KEYCLOAK_CLIENTID, secret: env.KEYCLOAK_CLIENTSECRET, caPem });
    const admin = keycloakAdmin({ base: env.KEYCLOAK_URL, realm: env.KEYCLOAK_REALM || 'sterling', token, caPem });
    for (const { what, result } of await applyExpiryPermission(admin)) console.log(`${result}: ${what}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
