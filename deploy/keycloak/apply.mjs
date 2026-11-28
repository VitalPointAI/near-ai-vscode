#!/usr/bin/env node
// Realm sterling as code (D-05, D-08, D-28 to D-35, D-57). Reads deploy/keycloak/realm.json, fills it from the site file and the per-site
// realm file, checks every passwordless-only rule (checkRealm), and only then installs the applier release, which runs keycloak-config-cli
// with the checked realm. The same script runs at install and on every update.
//
//   node deploy/keycloak/apply.mjs --site <site file> [--realm-site <per-site realm file>] [--keycloakx-site <per-site keycloakx file>] [--dry-run]
//
// The sign-in level comes from the site's signInKeys (D-57):
//   passkeys       attestation none and no AAGUID allowlist: any WebAuthn passkey (phone, synced or device-bound) or a hardware key;
//   hardware-only  attestation direct (or enterprise, keycloakx site file sterling.attestation), the site's acceptableAaguids (refused when
//                  empty: an empty allowlist accepts every authenticator, self-attestation included) and the vendor attestation roots
//                  ConfigMap (keycloakx site file sterling.attestationRootsConfigMap) from the bundled FIDO MDS snapshot.
// Both levels: no password, OTP or recovery code anywhere; user verification and resident keys required; the one shared rpId (D-08).
// HQ brokering (D-36): identity provider hq is in every realm and off unless the per-site realm file turns hqBroker on (an edge site linked
// to HQ). It is never the default: HQ is used only when a person picks it or a link names it (kc_idp_hint), and its first sign-in only links
// the local person with the same email, never creates one. Local people keep signing in with their keys when the link is down.
// Guests (D-58 to D-60): the top-level group guests carries no role, subgroup or attribute; the six guest life-cycle attributes are in the
// user profile for administrators only; serves, nationality, organization and a security-contacts group are refused (they are credentials,
// Phase 71); and no client or client scope puts a user attribute or a group into the access token (zero trust: Keycloak decides nothing).
// The system use notice (D-76, AC-8): the realm site file's systemUseNotice (language to text, en required) becomes the realm message
// sterlingSystemUseNotice, which the login theme sterling (deploy/charts/sterling-keycloak-theme) shows on every sign-in page.
// --dry-run prints the checked realm's summary and installs nothing. Node built-ins only; helm from $HELM or PATH.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageSets, listReleases, loadSite, substituteSite } from '../bundle/lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const REALM_FILE = 'deploy/keycloak/realm.json';
export const RELEASE = 'sterling-keycloak-realm';
export const SIGN_IN_KEYS = Object.freeze(['passkeys', 'hardware-only']);
/** Authenticators that ask for something other than a WebAuthn key: never in any flow (D-05, D-31). */
export const FORBIDDEN_AUTHENTICATOR = /password(?!less)|otp|recovery|reset-credential|kerberos|spnego|http-basic/i;
const BINDINGS = ['browserFlow', 'directGrantFlow', 'resetCredentialsFlow', 'firstBrokerLoginFlow', 'dockerAuthenticationFlow'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HQ_BROKER = 'hq';
export const HQ_FIRST_LOGIN_FLOW = 'sterling-hq-first-login';
/** The applier Job environment variable that carries the client secret HQ issued for this site (Secret keycloak-hq-broker). */
export const HQ_SECRET_ENV = 'STERLING_HQ_BROKER_CLIENT_SECRET';
/** The issuer a site without the broker renders: a reserved name that never resolves (RFC 2606), so Keycloak's URL checks pass. */
export const HQ_PLACEHOLDER_ISSUER = 'https://hq.invalid/realms/sterling';
const HQ_FIRST_LOGIN_STEPS = JSON.stringify([['idp-detect-existing-broker-user', 'REQUIRED'], ['idp-auto-link', 'REQUIRED']]);
const ENV_SECRET = /^\$\(env:[A-Z0-9_]+\)$/;
/** The system use notice (D-76): the realm message the login theme sterling renders in footer.ftl, and the language codes it accepts. */
export const NOTICE_MESSAGE = 'sterlingSystemUseNotice';
export const LOGIN_THEME = 'sterling';
const NOTICE_LANGUAGE = /^[a-z]{2}(-[A-Z]{2})?$/;
/** The group that makes an account a guest, and the guest life-cycle attributes (deploy/keycloak/guests.mjs; D-59). */
export const GUESTS_GROUP = 'guests';
export const GUEST_ATTRIBUTES = Object.freeze(['guestUntil', 'guestRequestedBy', 'guestApprovedBy', 'guestApprovalRef', 'guestEndedAt', 'guestEndedReason']);
/** Protocol mappers that put a user attribute or a group into a token (access.token.claim defaults to true when absent). */
export const CLAIM_MAPPERS = Object.freeze(['oidc-usermodel-attribute-mapper', 'oidc-group-membership-mapper', 'oidc-usermodel-aggregated-attribute-mapper',
  'oidc-script-based-protocol-mapper']);

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/**
 * The site values the realm's tokens name, derived from signInKeys and the per-site files: webAuthnAttestation, acceptableAaguids and
 * realm.* (strings, so Keycloak's string maps take them). Refuses a missing or unknown signInKeys.
 */
export function realmSettings(site, realmSite, keycloakxSite = {}) {
  if (!SIGN_IN_KEYS.includes(site.signInKeys)) throw new Error(`signInKeys must be ${SIGN_IN_KEYS.join(' or ')}, not ${JSON.stringify(site.signInKeys)} (D-57).`);
  const hardware = site.signInKeys === 'hardware-only';
  const x509 = realmSite.x509 ?? {};
  const orNotSet = (value) => (typeof value === 'string' && value.trim() ? value : 'not-set');
  const brokered = realmSite.hqBroker?.enabled === true;
  let issuer = brokered ? orNotSet(realmSite.hqBroker.issuer).trim() : HQ_PLACEHOLDER_ISSUER;
  while (issuer.endsWith('/')) issuer = issuer.slice(0, -1);
  return {
    ...site,
    webAuthnAttestation: hardware ? (keycloakxSite.sterling?.attestation || 'direct') : 'none',
    acceptableAaguids: hardware ? (site.acceptableAaguids ?? []) : (site.acceptableAaguids ?? []),
    attestationRootsConfigMap: hardware ? (keycloakxSite.sterling?.attestationRootsConfigMap ?? '') : '',
    realm: {
      eventsExpirationSeconds: realmSite.eventsExpirationSeconds,
      smtp: { host: realmSite.smtp?.host, port: String(realmSite.smtp?.port ?? ''), from: realmSite.smtp?.from },
      redirectUris: realmSite.redirectUris,
      x509: {
        enabled: x509.enabled === true,
        webauthnRequirement: x509.webauthnRequired === false ? 'DISABLED' : 'REQUIRED',
        ocspCheckingEnabled: String(x509.enabled === true && x509.revocation === 'ocsp'),
        crlCheckingEnabled: String(x509.enabled === true && x509.revocation === 'crl'),
        ocspResponderUri: orNotSet(x509.ocspResponderUri),
        crlPath: orNotSet(x509.crlPath)
      },
      hq: { enabled: brokered, issuer, clientId: brokered ? orNotSet(realmSite.hqBroker.clientId) : 'not-set', clientSecret: brokered ? `$(env:${HQ_SECRET_ENV})` : 'not-set' }
    },
    systemUseNotice: realmSite.systemUseNotice
  };
}

/** The plain problems of a systemUseNotice (D-76): an object from language code to text, with a non-blank en and no blank text. */
export function noticeProblems(notice) {
  if (!notice || typeof notice !== 'object' || Array.isArray(notice)) return ['the realm site file needs systemUseNotice, your organization\'s system use notice by language (D-76)'];
  const problems = [];
  if (typeof notice.en !== 'string' || !notice.en.trim()) problems.push('systemUseNotice.en, the English notice, is required and must not be blank (D-76)');
  for (const [language, text] of Object.entries(notice)) {
    if (!NOTICE_LANGUAGE.test(language)) problems.push(`systemUseNotice: ${JSON.stringify(language)} is not a language code such as en, fr or fr-CA`);
    else if (language !== 'en' && (typeof text !== 'string' || !text.trim())) problems.push(`systemUseNotice.${language} is blank; give the text or leave the language out`);
  }
  return problems;
}

/**
 * A text as a Keycloak message: Keycloak formats every message with Java's MessageFormat, which drops a single apostrophe and reads braces as
 * arguments (the 47-23 tracer showed "your organization's" rendered as "your organizations"). Doubling apostrophes and quoting braces makes
 * the page show the text exactly as the site file has it.
 */
export const messageText = (text) => String(text).replaceAll("'", "''").replace(/[{}]/g, (brace) => `'${brace}'`);

/**
 * Writes the notice onto the realm object (never by text substitution, so quotes and accents need no escaping in the site file): the realm
 * message sterlingSystemUseNotice per language, internationalization on, the notice's languages as the supported locales, English the default.
 */
export function applyNotice(realm, notice) {
  const languages = Object.keys(notice);
  realm.localizationTexts = Object.fromEntries(languages.map((language) => [language, { [NOTICE_MESSAGE]: messageText(notice[language]) }]));
  realm.internationalizationEnabled = true;
  realm.supportedLocales = languages;
  realm.defaultLocale = 'en';
  return realm;
}

/** The realm with the site settings substituted, authenticator config values as strings, and the X.509 flow bound when the site turns it on. */
export function substitutedRealm(text, settings) {
  const realm = JSON.parse(substituteSite(text, settings, REALM_FILE));
  for (const entry of realm.authenticatorConfig ?? []) entry.config = Object.fromEntries(Object.entries(entry.config ?? {}).map(([key, value]) => [key, String(value)]));
  if (realm.smtpServer) realm.smtpServer = Object.fromEntries(Object.entries(realm.smtpServer).map(([key, value]) => [key, String(value)]));
  if (settings.realm.x509.enabled) realm.browserFlow = 'sterling-x509';
  return realm;
}

/** Every rule the realm must keep (see the top of this file). Returns a list of plain problems; empty means the realm may be applied. */
export function checkRealm(realm, settings) {
  const problems = [];
  const need = (condition, problem) => { if (!condition) problems.push(problem); };
  const hardware = settings.signInKeys === 'hardware-only';
  need(SIGN_IN_KEYS.includes(settings.signInKeys), `signInKeys must be ${SIGN_IN_KEYS.join(' or ')}`);
  const rpId = realm.webAuthnPolicyPasswordlessRpId;
  need(typeof rpId === 'string' && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(rpId), `the relying-party id must be your organization's one shared parent domain, not ${JSON.stringify(rpId)} (D-08)`);
  // The passwordless policy, the same at both levels.
  need(realm.webAuthnPolicyPasswordlessUserVerificationRequirement === 'required', 'user verification must be required');
  // RequireResidentKey is the field keycloak-config-cli 6.5.1 (Keycloak 26.5 model) accepts; Keycloak 26.8 maps it to residentKey required (spike S6).
  need(realm.webAuthnPolicyPasswordlessRequireResidentKey === 'Yes' && [undefined, 'required'].includes(realm.webAuthnPolicyPasswordlessResidentKey), 'resident keys (discoverable credentials) must be required');
  need(realm.webAuthnPolicyPasswordlessAvoidSameAuthenticatorRegister === true, 'the same authenticator must not be registered twice (two real keys)');
  const attestation = realm.webAuthnPolicyPasswordlessAttestationConveyancePreference;
  const aaguids = realm.webAuthnPolicyPasswordlessAcceptableAaguids;
  if (hardware) {
    need(['direct', 'enterprise'].includes(attestation), `under hardware-only attestation must be direct or enterprise, not ${JSON.stringify(attestation)}`);
    need(Array.isArray(aaguids) && aaguids.length > 0, 'under hardware-only the acceptableAaguids allowlist is empty, which would accept every authenticator including self-attestation; list the approved hardware key models');
    need(Array.isArray(aaguids) && aaguids.every((id) => UUID.test(String(id))), 'every acceptable AAGUID must be a lowercase UUID');
    need(Boolean(settings.attestationRootsConfigMap), 'under hardware-only the vendor attestation roots ConfigMap (keycloakx site file sterling.attestationRootsConfigMap) must be named');
  } else {
    need(attestation === 'none', `under passkeys attestation must be none, not ${JSON.stringify(attestation)}`);
    need(Array.isArray(aaguids) && aaguids.length === 0, 'under passkeys the acceptableAaguids allowlist must be empty (a list would refuse phone passkeys); use signInKeys hardware-only to restrict models');
  }
  // Flows: none asks for a password, OTP or recovery code, and every binding names one of ours.
  const flows = new Map((realm.authenticationFlows ?? []).map((flow) => [flow.alias, flow]));
  for (const flow of flows.values()) {
    for (const execution of flow.authenticationExecutions ?? []) {
      need(!FORBIDDEN_AUTHENTICATOR.test(execution.authenticator ?? ''), `flow ${flow.alias} uses ${execution.authenticator}, which is not a WebAuthn step`);
      need(execution.authenticator !== 'idp-create-user-if-unique', `flow ${flow.alias} creates people from an identity provider; brokering only links people who exist here`);
      if (execution.authenticator === 'identity-provider-redirector') need(!execution.authenticatorConfig, `flow ${flow.alias}: the identity provider redirector must name no default provider; HQ is used only when asked for`);
      if (execution.authenticatorFlow) need(flows.has(execution.flowAlias), `flow ${flow.alias} names the subflow ${execution.flowAlias}, which realm.json does not define`);
    }
  }
  for (const binding of BINDINGS) need(flows.has(realm[binding]) && flows.get(realm[binding]).topLevel, `${binding} must name a top-level flow defined in realm.json, not ${JSON.stringify(realm[binding])} (a built-in flow has password steps)`);
  const empty = flows.get('sterling-no-credentials');
  need(Boolean(empty) && (empty.authenticationExecutions ?? []).length === 0, 'flow sterling-no-credentials must have no step');
  for (const binding of ['directGrantFlow', 'resetCredentialsFlow', 'firstBrokerLoginFlow', 'dockerAuthenticationFlow']) need(realm[binding] === 'sterling-no-credentials', `${binding} must be sterling-no-credentials`);
  need(realm.browserFlow === (settings.realm?.x509?.enabled ? 'sterling-x509' : 'sterling-browser'), 'the browser flow is sterling-browser, or sterling-x509 when the site turns smart cards on');
  need(flows.has('sterling-x509'), 'the optional smart-card flow sterling-x509 must exist (D-32)');
  // HQ brokering (D-36).
  const brokers = realm.identityProviders ?? [];
  need(brokers.length === 1 && brokers[0].alias === HQ_BROKER, `the only identity provider must be ${HQ_BROKER} (HQ brokering)`);
  for (const broker of brokers) {
    const config = broker.config ?? {};
    need(broker.enabled === (settings.realm?.hq?.enabled === true), `identity provider ${broker.alias} must be on exactly when the realm site file turns hqBroker on`);
    need(broker.firstBrokerLoginFlowAlias === HQ_FIRST_LOGIN_FLOW && !broker.postBrokerLoginFlowAlias, `identity provider ${broker.alias}'s first sign-in must be ${HQ_FIRST_LOGIN_FLOW}, with no post-login flow`);
    need(broker.authenticateByDefault !== true, `identity provider ${broker.alias} must not be the default`);
    need(config.syncMode === 'IMPORT', `identity provider ${broker.alias} must not overwrite local people at each sign-in (syncMode IMPORT; FORCE would let HQ change a local email)`);
    need(ENV_SECRET.test(config.clientSecret ?? '') || (broker.enabled === false && config.clientSecret === 'not-set'), `identity provider ${broker.alias}'s client secret must come from the applier Job environment, never be written in realm.json`);
    if (broker.enabled) {
      need(String(config.issuer).startsWith('https://') && config.issuer !== HQ_PLACEHOLDER_ISSUER && config.clientId && config.clientId !== 'not-set',
        'the HQ broker is on: hqBroker needs the https issuer of HQ\'s realm and the client id HQ registered for this site');
    }
  }
  const firstLogin = flows.get(HQ_FIRST_LOGIN_FLOW);
  need(Boolean(firstLogin?.topLevel) && JSON.stringify((firstLogin?.authenticationExecutions ?? []).map((execution) => [execution.authenticator, execution.requirement])) === HQ_FIRST_LOGIN_STEPS,
    `flow ${HQ_FIRST_LOGIN_FLOW} must only find the local person with the same email and link them (idp-detect-existing-broker-user, then idp-auto-link), never create one`);
  // Required actions.
  const actions = new Map((realm.requiredActions ?? []).map((action) => [action.alias, action]));
  for (const alias of ['UPDATE_PASSWORD', 'CONFIGURE_TOTP', 'CONFIGURE_RECOVERY_AUTHN_CODES']) need(actions.get(alias)?.enabled === false, `required action ${alias} must be listed and disabled`);
  need(actions.get('webauthn-register-passwordless')?.enabled === true, 'required action webauthn-register-passwordless must be enabled (D-33)');
  // People and email (D-28).
  for (const key of ['duplicateEmailsAllowed', 'editUsernameAllowed', 'resetPasswordAllowed', 'registrationAllowed']) need(realm[key] === false, `${key} must be false`);
  need(realm.bruteForceProtected === true, 'brute-force protection must be on');
  const profile = (realm.components?.['org.keycloak.userprofile.UserProfileProvider'] ?? [])[0];
  let email;
  try { email = JSON.parse(profile?.config?.['kc.user.profile.config']?.[0] ?? '{}').attributes?.find((attribute) => attribute.name === 'email'); } catch { email = undefined; }
  need(JSON.stringify(email?.permissions?.edit) === JSON.stringify(['admin']), 'the user profile must let only administrators edit email');
  // Guest accounts (D-58 to D-60): membership of guests makes a guest and grants nothing; Keycloak keeps only the guest life cycle, which
  // only administrators see; how a guest serves, their nationality and organization are credentials (Phase 71), never Keycloak data.
  let profileAttributes = [];
  try { profileAttributes = JSON.parse(profile?.config?.['kc.user.profile.config']?.[0] ?? '{}').attributes ?? []; } catch { profileAttributes = []; }
  const groups = realm.groups ?? [];
  const guests = groups.find((group) => group.name === GUESTS_GROUP);
  need(Boolean(guests) && (guests.path ?? `/${GUESTS_GROUP}`) === `/${GUESTS_GROUP}`, `the top-level group ${GUESTS_GROUP} must exist (it makes an account a guest)`);
  if (guests) {
    need((guests.realmRoles ?? []).length === 0, `${GUESTS_GROUP} must carry no realm role`);
    need(Object.values(guests.clientRoles ?? {}).every((roles) => (roles ?? []).length === 0), `${GUESTS_GROUP} must carry no client role`);
    need((guests.subGroups ?? []).length === 0, `${GUESTS_GROUP} must have no subgroup`);
    need(Object.keys(guests.attributes ?? {}).length === 0, `${GUESTS_GROUP} must carry no attribute`);
  }
  const allGroups = (list) => list.flatMap((group) => [group, ...allGroups(group.subGroups ?? [])]);
  need(!allGroups(groups).some((group) => group.name === 'security-contacts'), 'there must be no security-contacts group: who may approve guests is a SecurityContactCredential (Phase 71)');
  for (const name of GUEST_ATTRIBUTES) {
    const entry = profileAttributes.find((attribute) => attribute.name === name);
    need(Boolean(entry), `${name} must be in the user profile (guest accounts)`);
    if (entry) need(JSON.stringify(entry.permissions?.view) === '["admin"]' && JSON.stringify(entry.permissions?.edit) === '["admin"]', `${name}: only administrators may view or edit a guest attribute`);
  }
  for (const name of ['serves', 'nationality', 'organization']) need(!profileAttributes.some((attribute) => attribute.name === name), `${name} is a credential the security contact issues (Phase 71), not a Keycloak attribute`);
  // Zero trust: no token carries an attribute or a group, so nothing can decide access from one.
  const claimMappers = (owner, mappers) => {
    for (const mapper of mappers ?? []) {
      if (!CLAIM_MAPPERS.includes(mapper.protocolMapper)) continue;
      need(mapper.config?.['access.token.claim'] === 'false', `${owner} puts a user attribute or a group into the access token (${mapper.name}); Keycloak decides nothing`);
    }
  };
  for (const client of realm.clients ?? []) claimMappers(`client ${client.clientId}`, client.protocolMappers);
  for (const scope of realm.clientScopes ?? []) claimMappers(`client scope ${scope.name}`, scope.protocolMappers);
  // Step-up levels (D-34): two levels, the step-up acr at level 2, its max age the site window.
  let loa = {};
  try { loa = JSON.parse(realm.attributes?.['acr.loa.map'] ?? '{}'); } catch { loa = {}; }
  need(Object.keys(loa).length === 2 && Number(loa.webauthn) === 1 && Number(loa[settings.stepUpAcr]) === 2, `acr.loa.map must map webauthn to 1 and ${settings.stepUpAcr} to 2`);
  const configs = new Map((realm.authenticatorConfig ?? []).map((entry) => [entry.alias, entry.config ?? {}]));
  need(configs.get('sterling loa 2')?.['loa-condition-level'] === '2' && configs.get('sterling loa 2')?.['loa-max-age'] === String(settings.stepUpMaxAgeSeconds), 'level 2 must be valid only for the site step-up window (stepUpMaxAgeSeconds)');
  need(configs.get('sterling loa 1')?.['loa-condition-level'] === '1', 'level 1 must exist');
  // Events (D-35).
  need(realm.eventsEnabled === true && realm.adminEventsEnabled === true && realm.adminEventsDetailsEnabled === true, 'login and admin events (with details) must be on');
  need((realm.eventsListeners ?? []).includes('jboss-logging'), 'events must go to the log (jboss-logging), which Fluent Bit ships');
  // Clients.
  for (const client of realm.clients ?? []) need(client.directAccessGrantsEnabled === false, `client ${client.clientId} must not allow direct grants (a password grant)`);
  const sessions = (realm.clients ?? []).find((client) => client.clientId === 'sterling-sessions');
  need(Boolean(sessions), 'client sterling-sessions must exist');
  if (sessions) {
    need(sessions.publicClient === false && sessions.standardFlowEnabled === true && sessions.implicitFlowEnabled === false && sessions.serviceAccountsEnabled === false,
      'sterling-sessions must be confidential with the standard flow only');
    need(ENV_SECRET.test(sessions.secret ?? ''), 'the sterling-sessions secret must come from the applier Job environment, never be written in realm.json');
    const mapper = (type, check) => (sessions.protocolMappers ?? []).some((entry) => entry.protocolMapper === type && check(entry.config ?? {}));
    need(mapper('oidc-audience-mapper', (config) => config['included.client.audience'] === 'sterling-sessions' && config['access.token.claim'] === 'true'), 'sterling-sessions must add its own audience to the access token (OpenBao bound_audiences)');
    need(mapper('oidc-acr-mapper', (config) => config['access.token.claim'] === 'true'), 'acr must be in the access token');
    need(mapper('oidc-usersessionmodel-note-mapper', (config) => config['user.session.note'] === 'AUTH_TIME' && config['claim.name'] === 'auth_time' && config['access.token.claim'] === 'true'), 'auth_time must be in the access token');
    need(Array.isArray(sessions.redirectUris) && sessions.redirectUris.length > 0 && sessions.redirectUris.every((uri) => String(uri).startsWith('https://')), 'sterling-sessions needs https redirect URIs from the site file');
  }
  // The approvers' sign-in for your organization's software registry (48.3-05, D-18): public, the device grant and PKCE to loopback only, and
  // always the step-up level (Keycloak's device endpoint asks for the client's default ACR values, never a request's acr_values).
  const review = (realm.clients ?? []).find((client) => client.clientId === 'sterling-supply-review');
  if (review) {
    const attributes = review.attributes ?? {};
    need(review.publicClient === true && review.implicitFlowEnabled === false && review.serviceAccountsEnabled === false && attributes['oauth2.device.authorization.grant.enabled'] === 'true'
      && attributes['pkce.code.challenge.method'] === 'S256', 'sterling-supply-review must be public with the device grant and PKCE only');
    need(Array.isArray(review.redirectUris) && review.redirectUris.every((uri) => ['http://127.0.0.1/*', 'http://[::1]/*'].includes(uri)), 'sterling-supply-review may redirect only to loopback addresses');
    need(attributes['default.acr.values'] === settings.stepUpAcr && attributes['minimum.acr.value'] === settings.stepUpAcr, `sterling-supply-review must ask for the step-up (${settings.stepUpAcr})`);
  }
  // The system use notice (D-76, AC-8): the login theme sterling shows the realm message sterlingSystemUseNotice on every sign-in page.
  const noticeIssues = noticeProblems(settings.systemUseNotice);
  problems.push(...noticeIssues);
  need(realm.loginTheme === LOGIN_THEME, `the login theme must be ${LOGIN_THEME}, which shows your organization's system use notice on every sign-in page (D-76)`);
  if (!noticeIssues.length) {
    const languages = Object.keys(settings.systemUseNotice);
    need(realm.internationalizationEnabled === true && realm.defaultLocale === 'en' && JSON.stringify(realm.supportedLocales) === JSON.stringify(languages)
      && languages.every((language) => realm.localizationTexts?.[language]?.[NOTICE_MESSAGE] === messageText(settings.systemUseNotice[language])),
    `the realm must carry the notice of every language in the realm site file as ${NOTICE_MESSAGE}, with those languages supported and en the default`);
  }
  return problems;
}

/** Reads, fills and checks the realm for a site. Returns { realm, settings, problems }. */
export function prepareRealm({ site, realmSite, keycloakxSite }) {
  const fill = (value) => JSON.parse(substituteSite(JSON.stringify(value), site, 'the per-site realm file'));
  const settings = realmSettings(site, fill(realmSite), keycloakxSite);
  const realm = substitutedRealm(readFileSync(path.join(ROOT, REALM_FILE), 'utf8'), settings);
  if (!noticeProblems(settings.systemUseNotice).length) applyNotice(realm, settings.systemUseNotice);
  return { realm, settings, problems: checkRealm(realm, settings) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (flag) => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  const usage = 'usage: apply.mjs --site <site file> [--realm-site <file>] [--keycloakx-site <file>] [--dry-run]';
  if (argv.includes('--help')) { console.log(usage); process.exit(0); }
  try {
    if (!option('--site')) throw new Error(usage);
    const site = loadSite(option('--site'));
    const release = listReleases(ROOT).find((entry) => entry.name === RELEASE);
    const realmSite = readJson(option('--realm-site') ?? path.join(ROOT, release.site));
    const keycloakxSite = readJson(option('--keycloakx-site') ?? path.join(ROOT, 'deploy/values/site.example/keycloakx.yaml'));
    const { realm, settings, problems } = prepareRealm({ site, realmSite, keycloakxSite });
    if (problems.length) {
      console.error('refused: the realm breaks these rules; nothing was applied:');
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    const summary = `realm ${realm.realm} checked: signInKeys ${settings.signInKeys}, attestation ${realm.webAuthnPolicyPasswordlessAttestationConveyancePreference}, `
      + `${realm.webAuthnPolicyPasswordlessAcceptableAaguids.length} acceptable AAGUIDs, rpId ${realm.webAuthnPolicyPasswordlessRpId}, browser flow ${realm.browserFlow}`;
    if (argv.includes('--dry-run')) { console.log(summary); process.exit(0); }
    const scratch = mkdtempSync(path.join(tmpdir(), 'sterling-realm-'));
    try {
      const realmFile = path.join(scratch, 'realm.json');
      writeFileSync(realmFile, JSON.stringify(realm, null, 2), { mode: 0o600 });
      const valueFiles = [...release.values, release.site].map((file, index) => {
        const copy = path.join(scratch, `${index}.yaml`);
        writeFileSync(copy, substituteSite(readFileSync(path.join(ROOT, file), 'utf8'), site, file));
        return copy;
      });
      const run = spawnSync(process.env.HELM || 'helm', ['upgrade', '--install', RELEASE, path.join(ROOT, release.chart.slice('path:'.length)), '--namespace', release.namespace,
        ...valueFiles.flatMap((file) => ['-f', file]), ...imageSets(ROOT, release, site), '--set-file', `realm=${realmFile}`, '--wait', '--wait-for-jobs', '--timeout', '15m'], { stdio: 'inherit' });
      if (run.status !== 0) throw new Error(`helm upgrade --install ${RELEASE} failed`);
      console.log(`applied: ${summary}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
