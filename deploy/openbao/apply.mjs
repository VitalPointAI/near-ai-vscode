#!/usr/bin/env node
// OpenBao as code (D-37 to D-41): mounts, the jwt auth bound to the site's Keycloak, the session and step-up roles, the policies, the PKI
// intermediate's mount and roles, the kubernetes auth that cert-manager signs through (D-16, 47-13), the Raft snapshot job's role on it (D-73,
// 47-24), the status-list key and the credential officers' step-up role (Phase 71, 71-12), the exchange keys and their officers' step-up roles
// (Phase 45.1) and the key custodians' group. The audit device is not here: OpenBao 2.7 refuses to enable audit devices
// through the API ("use declarative, config-based audit device management", spike S5), so it is an audit stanza in the server configuration
// (deploy/values/openbao.yaml). Run at install and again on every update; a second run
// changes nothing (each write is compared with what OpenBao already holds and skipped when equal).
//
//   node deploy/openbao/apply.mjs --addr <https://openbao:8200> --ca-file <site CA pem> --token-file <file> --site <site file>
//        [--jwt-pubkey <pem>] [--dry-run]
//
// The token comes from a file, never an argument. --jwt-pubkey replaces Keycloak discovery with a fixed public key (spikes and tests only).
// --dry-run prints the operations as JSON and calls nothing. Node built-ins only; every call is node:https with the site CA.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSite } from '../bundle/lib/render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The policies written from deploy/openbao/policies/<name>.hcl. */
export const POLICIES = Object.freeze(['sterling-workbench', 'sterling-workbench-sign', 'key-move', 'enrolment', 'install', 'cert-manager', 'credential-issuers', 'guest-operator', 'guest-expiry',
  'guest-removal', 'raft-snapshot', 'guest-secrets-removal', 'guest-retention-check', 'security-officer-notices', 'guest-account', 'exchange-receive', 'exchange-release']);
/**
 * The policy every guest entity carries, and the only one (D-84; deploy/openbao/enrol.mjs attaches it): it denies the guest the staff KV path
 * kv/users/<entity>/ and gives them kv/guests/<entity>/ instead, so a security officer's removal reaches guests' secrets and nobody else's.
 */
export const GUEST_ACCOUNT_POLICY = 'guest-account';
/** The OIDC client whose access tokens a session forwards (47-08 creates it); the jwt roles' bound audience. */
export const AUDIENCE = 'sterling-sessions';
export const REALM = 'sterling';
/** Base session token: 15 minutes, renewable to a working day. */
export const BASE_TTL = Object.freeze({ token_ttl: 900, token_max_ttl: 28800 });
/**
 * The automatic end of guest accounts (D-62, D-63; 47-20's CronJob): a client-credentials token of the Keycloak client sterling-guest-expiry
 * logs in to the jwt role guest-expiry, which admits only that client (audience and azp) and gives a 5-minute token that cannot outlive itself.
 */
export const GUEST_EXPIRY = Object.freeze({ role: 'guest-expiry', client: 'sterling-guest-expiry', ttl: 300 });

/**
 * cert-manager's login (D-16, 47-13): the ClusterIssuers site-pki and site-pki-hub (deploy/charts/sterling-pki) ask Kubernetes for a short
 * token of this dedicated service account, with this audience, and log in to auth/kubernetes role cert-manager with it. The controller's own
 * service account token never leaves the cluster.
 */
export const CERT_MANAGER = Object.freeze({ role: 'cert-manager', serviceAccount: 'openbao-issuer', namespace: 'cert-manager', audience: 'sterling-openbao-pki' });
/** The hourly check for guests past retention (D-84, 47-34): CronJob guest-retention-check, read-only but for the officers' notice. */
export const GUEST_RETENTION_CHECK = Object.freeze({ role: 'guest-retention-check', serviceAccount: 'guest-retention-check', namespace: 'sterling-openbao', audience: 'sterling-openbao-guest-retention' });
/** A subject no sign-in token carries: the officer roles bind it when the site names no security officer, so a stale list never stays admitted. */
export const NO_SUBJECT = 'not-set';
const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The site's security officers (D-84): Keycloak user ids named at the key ceremony; refused unless each is one. */
export function securityOfficers(site) {
  const officers = site.securityOfficers ?? [];
  if (!Array.isArray(officers) || !officers.every((sub) => typeof sub === 'string' && SUBJECT.test(sub))) {
    throw new Error('the site setting securityOfficers must list the Keycloak user ids (lowercase UUIDs) of your organization\'s security officers, named at the key ceremony.');
  }
  return officers.length ? [...officers] : [NO_SUBJECT];
}
/**
 * The scheduled Raft snapshot (D-73, 47-24): CronJob openbao-raft-snapshot logs in with a projected token of its own ServiceAccount for this
 * audience (so the token is no use to the Kubernetes API) and gets a 5-minute token holding only policy raft-snapshot.
 */
export const RAFT_SNAPSHOT = Object.freeze({ role: 'raft-snapshot', serviceAccount: 'openbao-snapshot', namespace: 'sterling-openbao', audience: 'sterling-openbao-snapshot' });
/**
 * The cluster service domains the ingress role may sign besides the site domain: the in-cluster names of the services that serve TLS from the
 * site PKI (OpenBao and its Raft peers, Keycloak and its Postgres, OpenSearch, the registry, Theia Cloud's CRD conversion webhook). Every
 * other cluster name is refused. conversion.cert is only for the upstream webhook certificate's fixed common name (crd.conversion.cert in
 * the theia-cloud-crds chart, not a value); no client resolves it.
 */
export const SERVICE_DOMAINS = Object.freeze(['sterling-openbao', 'sterling-identity', 'sterling-logging', 'sterling-registry', 'theia-cloud']
  .flatMap((namespace) => [`${namespace}.svc`, `${namespace}.svc.cluster.local`]).concat(['openbao-internal', 'conversion.cert']));

/** The revocation list lifetime when the site file sets none: 30 days, longer than signed media takes to reach an edge site. */
export const DEFAULT_CRL_EXPIRY = '720h';
const DURATION = /^(\d+)(s|m|h)?$/;
/** A duration ("720h", "30m", "2592000s" or a number of seconds) in seconds, or NaN. */
export function durationSeconds(value) {
  const match = DURATION.exec(String(value ?? '').trim());
  return match ? Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2] ?? 's']) : Number.NaN;
}
/** The site's crlExpiry (optional), refused when it is not a duration of at least one day. */
export function crlExpiry(site) {
  const value = site.crlExpiry ?? DEFAULT_CRL_EXPIRY;
  if (!(durationSeconds(value) >= 86400)) throw new Error(`the site setting crlExpiry (${JSON.stringify(value)}) must be a duration of at least a day, for example 720h.`);
  return String(value);
}

/**
 * The credential issuers (Phase 71, 71-12; D-14, D-15): the jwt role whose token signs status lists with the site's status-list key, bound to
 * the step-up acr and to the officers the site file names (credentialIssuers, their Keycloak subjects, set at the key ceremony). Who is an
 * officer comes only from the site file, never from a Keycloak group or a token claim.
 */
export const ISSUER_ROLE = 'sterling-issuer-stepup';
/**
 * The limit on claiming computer places (D-26, G467): each session (one client address per person's session pod) may claim at most this many
 * places under kv/data/site/status-index/device- per hour; binding a computer claims two, so five computers fit in one hour. A client over the
 * limit is blocked from all requests for an hour, OpenBao counts it (vault.quota.rate_limit.violation, name computer-places) and audits it, and
 * the alert rule ComputerPlaceClaimsLimited (deploy/values/prometheus-alerts.yaml) tells the security operators.
 */
export const COMPUTER_PLACES_QUOTA = Object.freeze({ name: 'computer-places', path: 'kv/data/site/status-index/device-', rate: 12, interval: 3600, block_interval: 3600 });
const SITE_NAME = /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/;
const ISSUER_SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$/;
/** The Transit key that signs the site's status lists. */
export function statusListKey(site) {
  if (typeof site.siteName !== 'string' || !SITE_NAME.test(site.siteName)) {
    throw new Error(`the site setting siteName (${JSON.stringify(site.siteName)}) must be lower-case letters, digits and "-", as it names the status-list key.`);
  }
  return `status-list-${site.siteName}`;
}
/** The site's officer subjects (optional; an empty list means nobody can sign status lists yet). */
export function credentialIssuers(site) {
  const subjects = site.credentialIssuers ?? [];
  if (!Array.isArray(subjects) || !subjects.every((sub) => typeof sub === 'string' && ISSUER_SUBJECT.test(sub)) || new Set(subjects).size !== subjects.length) {
    throw new Error('the site setting credentialIssuers must be a list of distinct Keycloak subjects (the officers named at the key ceremony).');
  }
  return [...subjects];
}
/** Sentences the dry run prints besides the operations. */
export function planNotes(site) {
  return credentialIssuers(site).length === 0
    ? [`no jwt role ${ISSUER_ROLE}: the site file names no credentialIssuers, so nobody can sign status lists yet.`] : [];
}

/** A policy file's text, with ${site.siteName} filled in, and the site's key name in place of @SITE@ (the exchange keys, Phase 45.1). */
const policyText = (name, site) => {
  const text = readFileSync(path.join(HERE, 'policies', `${name}.hcl`), 'utf8');
  return text.includes('@SITE@') ? text.replaceAll('@SITE@', keySite(site)).replaceAll('${site.siteName}', site.siteName) : text.replaceAll('${site.siteName}', site.siteName);
};

const KEY_SITE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** The site name as part of a Transit key name (exchange-receive-<site>, release-<site>), refused when it cannot be one. */
export function keySite(site) {
  if (!KEY_SITE.test(String(site.siteName ?? ''))) throw new Error(`the site setting siteName (${JSON.stringify(site.siteName)}) must be lowercase letters, digits and dashes, starting with a letter or digit, at most 63 characters: it names the site's keys.`);
  return site.siteName;
}

const DUTY_SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
/** The sign-in subjects a site file names for one duty (exchangeOfficers, releaseAuthorities): a list of distinct subjects, empty when absent. */
export function namedSubjects(site, key) {
  const value = site[key] ?? [];
  if (!Array.isArray(value) || value.some((subject) => typeof subject !== 'string' || !DUTY_SUBJECT.test(subject)) || new Set(value).size !== value.length) {
    throw new Error(`the site setting ${key} must be a list of distinct sign-in subjects (the Keycloak user ids of the people named at the key ceremony).`);
  }
  return value;
}

/**
 * The exchange keys (Phase 45.1, D-03, D-07): created once, never exportable and never in a plaintext backup. One that already exists in another form
 * stops the apply, because exportable cannot be turned off again and a key of another type is not the one partners were given.
 */
function exchangeKey(name, type) {
  const body = { type, exportable: false, allow_plaintext_backup: false };
  return { what: `transit key ${name} (${type}, not exportable)`, read: `transit/keys/${name}`, write: `transit/keys/${name}`, body,
    compare: (current) => {
      if (!current) return false;
      if (current.type === type && current.exportable === false && current.allow_plaintext_backup === false) return true;
      throw new Error(`transit key ${name} already exists as ${String(current.type)}, exportable ${String(current.exportable)}: it must be ${type} and not exportable. Stop and ask your organization's security officer.`);
    } };
}

/**
 * The operations for a site, in order: { what, read?, write, body, compare? }. `read` is the path whose current value decides whether the
 * write is needed; `compare(current, body)` says whether they already agree (default: every body field equal).
 */
export function planApply(site, { jwtPubkey, caPem } = {}) {
  const stepUpAcr = site.stepUpAcr;
  const window = Number(site.stepUpMaxAgeSeconds);
  if (!stepUpAcr || !Number.isInteger(window) || window <= 0) throw new Error('the site file needs stepUpAcr and a positive whole stepUpMaxAgeSeconds.');
  const officers = securityOfficers(site);
  const mount = (where, type, options) => ({ what: `mount ${where}/ (${type})`, read: 'sys/mounts', write: `sys/mounts/${where}`, body: { type, ...(options ? { options } : {}) },
    compare: (mounts) => mounts?.[`${where}/`]?.type === type });
  const keyName = statusListKey(site);
  const issuers = credentialIssuers(site);
  const role = (name, extra) => ({ what: `jwt role ${name}`, read: `auth/jwt/role/${name}`, write: `auth/jwt/role/${name}`, body: {
    role_type: 'jwt', bound_audiences: [AUDIENCE], user_claim: 'sub', token_no_default_policy: true, ...extra } });
  const exchangeSite = keySite(site);
  // Phase 45.1: the step-up role of a named duty, bound to the step-up acr and to the subjects the site file names (never a group or a token claim).
  // With nobody named there is no role, so nobody can use the key.
  const dutyRole = (name, subjects, policy) => (subjects.length === 0 ? [] : [role(name, { bound_claims: { acr: stepUpAcr, sub: subjects }, bound_claims_type: 'string',
    token_ttl: window, token_max_ttl: window, token_explicit_max_ttl: window, token_period: 0, token_policies: ['sterling-workbench', 'sterling-workbench-sign', policy] })]);
  return [
    mount('kv', 'kv', { version: '2' }),
    mount('transit', 'transit'),
    // The status-list key (D-14): signs every status list of the site, only through the issuer role below.
    { what: `transit key ${keyName}`, read: `transit/keys/${keyName}`, write: `transit/keys/${keyName}`, body: { type: 'ed25519', exportable: false, allow_plaintext_backup: false } },
    { ...mount('pki_int', 'pki'), body: { type: 'pki', config: { max_lease_ttl: '43800h' } } },
    { what: 'auth jwt/', read: 'sys/auth', write: 'sys/auth/jwt', body: { type: 'jwt' }, compare: (auths) => auths?.['jwt/']?.type === 'jwt' },
    { what: 'jwt config (the site Keycloak)', read: 'auth/jwt/config', write: 'auth/jwt/config', body: jwtPubkey
      ? { jwt_validation_pubkeys: [jwtPubkey], bound_issuer: '' }
      : { oidc_discovery_url: `https://keycloak.${site.domain}/realms/${REALM}`, oidc_discovery_ca_pem: caPem ?? '' } },
    ...POLICIES.map((name) => ({ what: `policy ${name}`, read: `sys/policies/acl/${name}`, write: `sys/policies/acl/${name}`, body: { policy: policyText(name, site) } })),
    // Phase 45.1: your organization's receiving key (decrypt only, D-07) and release key (export label bindings, D-03).
    exchangeKey(`exchange-receive-${exchangeSite}`, 'rsa-3072'),
    exchangeKey(`release-${exchangeSite}`, 'ed25519'),
    role('sterling-workbench', { ...BASE_TTL, token_policies: ['sterling-workbench'] }),
    // The only way to sign (D-34, D-39): the same audience and sub (so the same entity), the step-up acr required, and a token that cannot
    // outlive the step-up window.
    role('sterling-workbench-stepup', { bound_claims: { acr: stepUpAcr }, bound_claims_type: 'string', token_ttl: window, token_max_ttl: window,
      token_explicit_max_ttl: window, token_period: 0, token_policies: ['sterling-workbench', 'sterling-workbench-sign'] }),
    // The officers' step-up (D-14, D-15): the same step-up and window, and only the named officers' subjects; it alone holds credential-issuers.
    ...(issuers.length === 0 ? [] : [role(ISSUER_ROLE, { bound_claims: { acr: stepUpAcr, sub: issuers }, bound_claims_type: 'string', token_ttl: window,
      token_max_ttl: window, token_explicit_max_ttl: window, token_period: 0, token_policies: ['sterling-workbench', 'sterling-workbench-sign', 'credential-issuers'] })]),
    // Removing ended guests' secrets (D-84): only the named security officers, only after a passkey step-up, only for the step-up window, and
    // only that policy; the officers' notice: the same officers, read-only, one minute.
    role('guest-secrets-removal', { bound_claims: { acr: stepUpAcr, sub: officers }, bound_claims_type: 'string', token_policies: ['guest-secrets-removal'],
      token_ttl: window, token_max_ttl: window, token_explicit_max_ttl: window, token_period: 0 }),
    role('security-officer-notices', { bound_claims: { sub: officers }, bound_claims_type: 'string', token_policies: ['security-officer-notices'],
      token_ttl: 60, token_max_ttl: 60, token_explicit_max_ttl: 60, token_period: 0 }),
    // The automatic end of guest accounts: only the client sterling-guest-expiry, only the policy guest-expiry, 5 minutes and no renewal.
    role(GUEST_EXPIRY.role, { bound_audiences: [GUEST_EXPIRY.client], bound_claims: { azp: GUEST_EXPIRY.client }, bound_claims_type: 'string', token_policies: ['guest-expiry'],
      token_ttl: GUEST_EXPIRY.ttl, token_max_ttl: GUEST_EXPIRY.ttl, token_explicit_max_ttl: GUEST_EXPIRY.ttl, token_period: 0 }),
    ...dutyRole('sterling-exchange-receive-stepup', namedSubjects(site, 'exchangeOfficers'), 'exchange-receive'),
    ...dutyRole('sterling-exchange-release-stepup', namedSubjects(site, 'releaseAuthorities'), 'exchange-release'),
    // Certificates of at most 90 days (max_ttl in seconds); cert-manager renews them well before. client_flag is on because OpenSearch's
    // nodes present the same certificate to each other on the transport layer (plugins.security.nodes_dn, 47-10). key_type any: the
    // Certificates cert-manager makes from Ingress annotations (Theia Cloud, Harbor) and the Theia Cloud webhook's use RSA 2048 keys, which
    // an EC-only role refused (spike S7); OpenBao still refuses RSA keys under 2048 bits. Our own Certificates ask for ECDSA P-256. Those
    // Ingress Certificates carry only DNS names, no common name, so require_cn is off (the names are still checked against allowed_domains).
    { what: 'PKI role ingress', read: 'pki_int/roles/ingress', write: 'pki_int/roles/ingress', body: { allowed_domains: [site.domain, ...SERVICE_DOMAINS], allow_subdomains: true,
      allow_bare_domains: false, allow_localhost: false, allow_ip_sans: false, server_flag: true, client_flag: true, key_type: 'any', require_cn: false, max_ttl: 7776000 } },
    { what: 'PKI role hub', read: 'pki_int/roles/hub', write: 'pki_int/roles/hub', body: { allowed_domains: [site.domain, 'sterling-hubs.svc', 'sterling-hubs.svc.cluster.local'],
      allow_subdomains: true, allow_bare_domains: false, allow_localhost: false, allow_ip_sans: false, server_flag: true, client_flag: false, key_type: 'ec', key_bits: 256, max_ttl: 7776000 } },
    // The intermediate's revocation list (D-49): edge sites check it from a signed file carried on media (47-14), so it must stay valid
    // longer than the media takes to arrive. OpenBao's default is 72 hours; the site setting crlExpiry overrides the 30-day default here.
    { what: 'PKI revocation list lifetime', read: 'pki_int/config/crl', write: 'pki_int/config/crl', body: { expiry: crlExpiry(site) },
      compare: (current, body) => durationSeconds(current?.expiry) === durationSeconds(body.expiry) },
    // cert-manager signs through auth/kubernetes (D-16): OpenBao checks the token with the cluster's TokenReview API, using its own pod's service
    // account (the chart's auth-delegator binding) and the in-cluster CA, so no reviewer token or CA is written here.
    { what: 'auth kubernetes/', read: 'sys/auth', write: 'sys/auth/kubernetes', body: { type: 'kubernetes' }, compare: (auths) => auths?.['kubernetes/']?.type === 'kubernetes' },
    { what: 'kubernetes config (this cluster)', read: 'auth/kubernetes/config', write: 'auth/kubernetes/config', body: { kubernetes_host: 'https://kubernetes.default.svc' } },
    { what: `kubernetes role ${CERT_MANAGER.role}`, read: `auth/kubernetes/role/${CERT_MANAGER.role}`, write: `auth/kubernetes/role/${CERT_MANAGER.role}`, body: {
      bound_service_account_names: [CERT_MANAGER.serviceAccount], bound_service_account_namespaces: [CERT_MANAGER.namespace], audience: CERT_MANAGER.audience,
      token_policies: ['cert-manager'], token_no_default_policy: true, token_ttl: 300, token_max_ttl: 300 } },
    // D-26 (G467): at most COMPUTER_PLACES_QUOTA.rate computer place claims per session per hour, and rate limit violations in the audit log.
    { what: `rate limit quota ${COMPUTER_PLACES_QUOTA.name}`, read: `sys/quotas/rate-limit/${COMPUTER_PLACES_QUOTA.name}`, write: `sys/quotas/rate-limit/${COMPUTER_PLACES_QUOTA.name}`,
      body: { path: COMPUTER_PLACES_QUOTA.path, rate: COMPUTER_PLACES_QUOTA.rate, interval: COMPUTER_PLACES_QUOTA.interval, block_interval: COMPUTER_PLACES_QUOTA.block_interval } },
    { what: 'quota audit logging', read: 'sys/quotas/config', write: 'sys/quotas/config', body: { enable_rate_limit_audit_logging: true },
      compare: (current) => current?.enable_rate_limit_audit_logging === true },
    { what: `kubernetes role ${RAFT_SNAPSHOT.role}`, read: `auth/kubernetes/role/${RAFT_SNAPSHOT.role}`, write: `auth/kubernetes/role/${RAFT_SNAPSHOT.role}`, body: {
      bound_service_account_names: [RAFT_SNAPSHOT.serviceAccount], bound_service_account_namespaces: [RAFT_SNAPSHOT.namespace], audience: RAFT_SNAPSHOT.audience,
      token_policies: ['raft-snapshot'], token_no_default_policy: true, token_ttl: 300, token_max_ttl: 600 } },
    { what: `kubernetes role ${GUEST_RETENTION_CHECK.role}`, read: `auth/kubernetes/role/${GUEST_RETENTION_CHECK.role}`, write: `auth/kubernetes/role/${GUEST_RETENTION_CHECK.role}`, body: {
      bound_service_account_names: [GUEST_RETENTION_CHECK.serviceAccount], bound_service_account_namespaces: [GUEST_RETENTION_CHECK.namespace], audience: GUEST_RETENTION_CHECK.audience,
      token_policies: ['guest-retention-check'], token_no_default_policy: true, token_ttl: 300, token_max_ttl: 300 } },
    // The approvers of key moves between sites (key-move.hcl); members are added at the key ceremony and never by this script.
    { what: 'identity group key-custodians', read: 'identity/group/name/key-custodians', write: 'identity/group/name/key-custodians', body: { type: 'internal', policies: [] },
      compare: (group) => group?.type === 'internal' }
  ];
}

// OpenBao returns durations in seconds and PEM text without its last newline, so values are compared as trimmed strings (lists sorted).
const normalise = (value) => (Array.isArray(value) ? [...value].map((item) => String(item).trim()).sort() : value && typeof value === 'object' ? value : String(value ?? '').trim());
/** Whether the current value already holds every field of the body. */
export function sameFields(current, body) {
  if (!current) return false;
  return Object.entries(body).every(([key, value]) => {
    if (key === 'policy') return typeof current.policy === 'string' && current.policy.trim() === String(value).trim();
    if (value && typeof value === 'object' && !Array.isArray(value)) return JSON.stringify(current[key] ?? {}) === JSON.stringify(value);
    return JSON.stringify(normalise(current[key])) === JSON.stringify(normalise(value));
  });
}

/** A minimal OpenBao HTTP client: request(method, path, body) -> { status, data }. */
export function openbaoClient({ addr, token, caPem }) {
  const base = new URL(addr);
  const transport = base.protocol === 'https:' ? https : http;
  return (method, apiPath, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = transport.request(new URL(`/v1/${apiPath}`, base), { method, ca: caPem, headers: { 'X-Vault-Token': token, ...(payload ? { 'content-type': 'application/json' } : {}) } }, (response) => {
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

/** Applies the plan; returns [{ what, result: 'written' | 'unchanged' }]. Throws on any refusal. */
export async function applyPlan(request, operations) {
  const results = [];
  for (const operation of operations) {
    let current = null;
    if (operation.read) {
      const read = await request('GET', operation.read);
      if (read.status === 200) current = read.data?.data ?? read.data;
    }
    const agrees = operation.compare ? operation.compare(current, operation.body) : sameFields(current, operation.body);
    if (agrees) { results.push({ what: operation.what, result: 'unchanged' }); continue; }
    const write = await request('POST', operation.write, operation.body);
    if (write.status >= 300) throw new Error(`${operation.what}: OpenBao answered ${write.status} ${JSON.stringify(write.data?.errors ?? write.data)}`);
    results.push({ what: operation.what, result: 'written' });
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (flag) => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  const usage = 'usage: apply.mjs --addr <url> --ca-file <pem> --token-file <file> --site <site file> [--jwt-pubkey <pem>] [--dry-run]';
  if (argv.includes('--help')) { console.log(usage); process.exit(0); }
  try {
    if (!option('--site')) throw new Error(usage);
    const site = loadSite(option('--site'));
    const caPem = option('--ca-file') ? readFileSync(option('--ca-file'), 'utf8') : undefined;
    const jwtPubkey = option('--jwt-pubkey') ? readFileSync(option('--jwt-pubkey'), 'utf8') : undefined;
    const operations = planApply(site, { jwtPubkey, caPem });
    for (const note of planNotes(site)) console.error(note);
    if (argv.includes('--dry-run')) {
      console.log(JSON.stringify(operations.map(({ what, write, body }) => ({ what, write, body })), null, 2));
    } else {
      if (!option('--addr') || !option('--token-file')) throw new Error(usage);
      const request = openbaoClient({ addr: option('--addr'), token: readFileSync(option('--token-file'), 'utf8').trim(), caPem });
      for (const { what, result } of await applyPlan(request, operations)) console.log(`${result}: ${what}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
