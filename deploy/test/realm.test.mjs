// Realm sterling as code (D-05, D-08, D-28 to D-35, D-57): the passwordless-only rules hold in deploy/keycloak/realm.json at both signInKeys
// levels, and checkRealm refuses a realm or site that breaks one, before anything is applied. Reads files and substitutes the CI site; no
// Keycloak is needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { FORBIDDEN_AUTHENTICATOR, checkRealm, prepareRealm, realmSettings, substitutedRealm } from '../keycloak/apply.mjs';
import { listReleases, loadSite, renderRelease } from '../bundle/lib/render.mjs';
import { readImagesLock, resolveImage } from '../bundle/lib/locks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (file) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
const RAW = readFileSync(path.join(ROOT, 'deploy/keycloak/realm.json'), 'utf8');
const SITE = loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'));
const REALM_SITE = readJson('deploy/values/site.example/sterling-keycloak-realm.yaml');
const KEYCLOAKX_SITE = readJson('deploy/values/site.example/keycloakx.yaml');
const AAGUID = 'ee882879-721c-4913-9775-3dfcce97072a';
const HARDWARE = { ...SITE, signInKeys: 'hardware-only', acceptableAaguids: [AAGUID] };
const HARDWARE_KEYCLOAKX = { ...KEYCLOAKX_SITE, sterling: { ...KEYCLOAKX_SITE.sterling, attestationRootsConfigMap: 'keycloak-attestation-roots' } };
const prepare = (site = SITE, keycloakxSite = KEYCLOAKX_SITE, realmSite = REALM_SITE) => prepareRealm({ site, realmSite, keycloakxSite });
const passkeys = () => prepare();
const hardware = () => prepare(HARDWARE, HARDWARE_KEYCLOAKX);
/** checkRealm on a changed copy of the passkeys realm; returns its problems. */
const broken = (change) => {
  const { realm, settings } = passkeys();
  const copy = structuredClone(realm);
  change(copy);
  return checkRealm(copy, settings);
};

test('the realm as shipped passes at both levels', () => {
  assert.deepEqual(passkeys().problems, []);
  assert.deepEqual(hardware().problems, []);
});

test('no flow has a password, OTP or recovery-code step, every binding is one of ours, and no client allows direct grants', () => {
  const { realm } = passkeys();
  for (const flow of realm.authenticationFlows) {
    for (const execution of flow.authenticationExecutions) assert.doesNotMatch(execution.authenticator ?? '', FORBIDDEN_AUTHENTICATOR, `${flow.alias}: ${execution.authenticator}`);
  }
  const ours = new Set(realm.authenticationFlows.map((flow) => flow.alias));
  for (const binding of ['browserFlow', 'directGrantFlow', 'resetCredentialsFlow', 'firstBrokerLoginFlow', 'dockerAuthenticationFlow']) assert.ok(ours.has(realm[binding]), binding);
  for (const client of realm.clients) assert.equal(client.directAccessGrantsEnabled, false, client.clientId);
  assert.match(broken((copy) => copy.authenticationFlows[0].authenticationExecutions.push({ authenticator: 'auth-username-password-form', requirement: 'REQUIRED' })).join('\n'), /uses auth-username-password-form/);
  assert.match(broken((copy) => { copy.authenticationFlows.find((flow) => flow.alias === 'sterling-no-credentials').authenticationExecutions.push({ authenticator: 'direct-grant-validate-otp' }); }).join('\n'), /direct-grant-validate-otp/);
  assert.match(broken((copy) => { copy.directGrantFlow = 'direct grant'; }).join('\n'), /directGrantFlow must name a top-level flow defined in realm\.json/);
  assert.match(broken((copy) => { copy.clients[0].directAccessGrantsEnabled = true; }).join('\n'), /must not allow direct grants/);
});

test('the password, OTP and recovery-code actions are off and passwordless registration is on', () => {
  const actions = new Map(passkeys().realm.requiredActions.map((action) => [action.alias, action.enabled]));
  assert.deepEqual([actions.get('UPDATE_PASSWORD'), actions.get('CONFIGURE_TOTP'), actions.get('CONFIGURE_RECOVERY_AUTHN_CODES'), actions.get('webauthn-register-passwordless')], [false, false, false, true]);
  assert.match(broken((copy) => { copy.requiredActions.find((action) => action.alias === 'CONFIGURE_TOTP').enabled = true; }).join('\n'), /CONFIGURE_TOTP must be listed and disabled/);
  assert.match(broken((copy) => { copy.requiredActions = copy.requiredActions.filter((action) => action.alias !== 'webauthn-register-passwordless'); }).join('\n'), /webauthn-register-passwordless must be enabled/);
});

test('emails are unique and only administrators may change them; no self-registration or password reset', () => {
  const { realm } = passkeys();
  for (const key of ['duplicateEmailsAllowed', 'editUsernameAllowed', 'resetPasswordAllowed', 'registrationAllowed']) assert.equal(realm[key], false, key);
  const profile = JSON.parse(realm.components['org.keycloak.userprofile.UserProfileProvider'][0].config['kc.user.profile.config'][0]);
  assert.deepEqual(profile.attributes.find((attribute) => attribute.name === 'email').permissions.edit, ['admin']);
  assert.match(broken((copy) => { copy.duplicateEmailsAllowed = true; }).join('\n'), /duplicateEmailsAllowed must be false/);
  assert.match(broken((copy) => {
    const component = copy.components['org.keycloak.userprofile.UserProfileProvider'][0];
    const config = JSON.parse(component.config['kc.user.profile.config'][0]);
    config.attributes.find((attribute) => attribute.name === 'email').permissions.edit = ['admin', 'user'];
    component.config['kc.user.profile.config'] = [JSON.stringify(config)];
  }).join('\n'), /only administrators edit email/);
});

test('at both levels the passwordless policy requires user verification and resident keys, on the one shared rpId token', () => {
  assert.match(RAW, /"webAuthnPolicyPasswordlessRpId": "\$\{site\.rpId\}"/);
  for (const { realm } of [passkeys(), hardware()]) {
    assert.equal(realm.webAuthnPolicyPasswordlessRpId, SITE.rpId);
    assert.equal(realm.webAuthnPolicyPasswordlessUserVerificationRequirement, 'required');
    assert.ok([undefined, 'required'].includes(realm.webAuthnPolicyPasswordlessResidentKey));
    assert.equal(realm.webAuthnPolicyPasswordlessRequireResidentKey, 'Yes');
    assert.equal(realm.webAuthnPolicyPasswordlessAvoidSameAuthenticatorRegister, true);
  }
  assert.match(broken((copy) => { copy.webAuthnPolicyPasswordlessUserVerificationRequirement = 'preferred'; }).join('\n'), /user verification must be required/);
  assert.throws(() => prepare({ ...SITE, rpId: '' }), /rpId\} is empty in the site file/);
  assert.match(prepare({ ...SITE, rpId: 'https://site.example' }).problems.join('\n'), /relying-party id must be your organization's one shared parent domain/);
});

test('signInKeys selects the level: passkeys has attestation none and no allowlist, hardware-only attestation direct and the site allowlist', () => {
  assert.match(RAW, /"webAuthnPolicyPasswordlessAttestationConveyancePreference": "\$\{site\.webAuthnAttestation\}"/);
  assert.match(RAW, /"webAuthnPolicyPasswordlessAcceptableAaguids": "\$\{site\.acceptableAaguids\}"/);
  const soft = passkeys().realm;
  assert.equal(soft.webAuthnPolicyPasswordlessAttestationConveyancePreference, 'none');
  assert.deepEqual(soft.webAuthnPolicyPasswordlessAcceptableAaguids, []);
  const hard = hardware().realm;
  assert.equal(hard.webAuthnPolicyPasswordlessAttestationConveyancePreference, 'direct');
  assert.deepEqual(hard.webAuthnPolicyPasswordlessAcceptableAaguids, [AAGUID]);
  const enterprise = prepare(HARDWARE, { ...HARDWARE_KEYCLOAKX, sterling: { ...HARDWARE_KEYCLOAKX.sterling, attestation: 'enterprise' } });
  assert.equal(enterprise.realm.webAuthnPolicyPasswordlessAttestationConveyancePreference, 'enterprise');
  // Refusals.
  assert.throws(() => realmSettings({ ...SITE, signInKeys: undefined }, REALM_SITE), /signInKeys must be passkeys or hardware-only/);
  assert.throws(() => realmSettings({ ...SITE, signInKeys: 'hardware' }, REALM_SITE), /signInKeys must be passkeys or hardware-only/);
  assert.match(prepare({ ...HARDWARE, acceptableAaguids: [] }, HARDWARE_KEYCLOAKX).problems.join('\n'), /acceptableAaguids allowlist is empty, which would accept every authenticator/);
  assert.match(prepare(HARDWARE, KEYCLOAKX_SITE).problems.join('\n'), /attestation roots ConfigMap/);
  assert.match(prepare({ ...SITE, acceptableAaguids: [AAGUID] }).problems.join('\n'), /under passkeys the acceptableAaguids allowlist must be empty/);
  const { realm, settings } = hardware();
  assert.match(checkRealm({ ...realm, webAuthnPolicyPasswordlessAttestationConveyancePreference: 'none' }, settings).join('\n'), /under hardware-only attestation must be direct or enterprise/);
});

test('the step-up levels are the same at both sign-in levels: acr means a fresh WebAuthn ceremony, not hardware', () => {
  const pick = ({ realm }) => JSON.stringify({ flows: realm.authenticationFlows, configs: realm.authenticatorConfig, loa: realm.attributes['acr.loa.map'] });
  assert.equal(pick(passkeys()), pick(hardware()));
});

test('acr.loa.map has two levels, level 2 lasts the site step-up window (a site token, never a literal), and events are recorded', () => {
  assert.match(RAW, /"loa-max-age": "\$\{site\.stepUpMaxAgeSeconds\}"/);
  assert.match(RAW, /\\"\$\{site\.stepUpAcr\}\\":2/);
  const { realm } = passkeys();
  assert.deepEqual(JSON.parse(realm.attributes['acr.loa.map']), { webauthn: 1, [SITE.stepUpAcr]: 2 });
  const level2 = realm.authenticatorConfig.find((entry) => entry.alias === 'sterling loa 2').config;
  assert.deepEqual(level2, { 'loa-condition-level': '2', 'loa-max-age': String(SITE.stepUpMaxAgeSeconds) });
  assert.deepEqual([realm.eventsEnabled, realm.adminEventsEnabled, realm.adminEventsDetailsEnabled, realm.eventsListeners], [true, true, true, ['jboss-logging']]);
  assert.match(broken((copy) => { copy.authenticatorConfig.find((entry) => entry.alias === 'sterling loa 2').config['loa-max-age'] = '36000'; }).join('\n'), /level 2 must be valid only for the site step-up window/);
  assert.match(broken((copy) => { copy.adminEventsEnabled = false; }).join('\n'), /login and admin events/);
});

test('client sterling-sessions is confidential, standard flow only, and puts its audience, acr and auth_time in the access token', () => {
  const sessions = passkeys().realm.clients.find((client) => client.clientId === 'sterling-sessions');
  assert.deepEqual([sessions.publicClient, sessions.standardFlowEnabled, sessions.implicitFlowEnabled, sessions.serviceAccountsEnabled], [false, true, false, false]);
  assert.equal(sessions.secret, '$(env:STERLING_SESSIONS_CLIENT_SECRET)');
  assert.deepEqual(sessions.redirectUris, [`https://*.${SITE.domain}/oauth2/callback`, `https://sessions.${SITE.domain}/*`]);
  assert.match(broken((copy) => { copy.clients[0].protocolMappers = copy.clients[0].protocolMappers.filter((entry) => entry.protocolMapper !== 'oidc-audience-mapper'); }).join('\n'), /add its own audience/);
  assert.match(broken((copy) => { copy.clients[0].protocolMappers.find((entry) => entry.name === 'auth_time').config['access.token.claim'] = 'false'; }).join('\n'), /auth_time must be in the access token/);
  assert.match(broken((copy) => { copy.clients[0].secret = 'a-literal-secret'; }).join('\n'), /must come from the applier Job environment/);
});

test('the smart-card flow exists but is bound only when the site turns it on', () => {
  assert.equal(passkeys().realm.browserFlow, 'sterling-browser');
  const on = prepare(SITE, KEYCLOAKX_SITE, { ...REALM_SITE, x509: { ...REALM_SITE.x509, enabled: true, ocspResponderUri: 'http://ocsp.site.example' } });
  assert.deepEqual(on.problems, []);
  assert.equal(on.realm.browserFlow, 'sterling-x509');
  const config = on.realm.authenticatorConfig.find((entry) => entry.alias === 'sterling x509').config;
  assert.equal(config['x509-cert-auth.ocsp-checking-enabled'], 'true');
  assert.equal(config['x509-cert-auth.ocsp-responder-uri'], 'http://ocsp.site.example');
  assert.deepEqual(substitutedRealm(RAW, realmSettings(SITE, REALM_SITE)).authenticationFlows.map((flow) => flow.alias).filter((alias) => alias.startsWith('sterling-x509')), ['sterling-x509', 'sterling-x509 forms']);
});

const HELM = process.env.HELM || 'helm';
const keycloakx = () => listReleases(ROOT).find((release) => release.name === 'keycloakx');

test('Keycloak renders from the locked official image, reaches Postgres with verify-full TLS and writes JSON logs (needs helm)', () => {
  const yaml = renderRelease(ROOT, keycloakx(), { site: SITE, helm: HELM });
  const image = resolveImage(readImagesLock(ROOT), 'quay.io/keycloak/keycloak', SITE.registry);
  assert.ok(yaml.includes(`image: "${image.registry}/${image.repository}@${image.digest}"`), 'the image is the lock entry by digest');
  assert.match(yaml, /value: "\?sslmode=verify-full&sslrootcert=\/opt\/keycloak\/site-ca\/ca\.crt"/);
  assert.match(yaml, /name: KC_LOG_CONSOLE_OUTPUT\n\s+value: json/);
  assert.match(yaml, /name: KC_HOSTNAME\n\s+value: "https:\/\/keycloak\.site\.example"/);
  assert.match(yaml, /name: KC_PROXY_HEADERS\n\s+value: xforwarded/);
  assert.doesNotMatch(yaml, /name: KC_HTTP_ENABLED\n\s+value: "true"/, 'no plain HTTP listener on the pod');
  assert.doesNotMatch(yaml, /attestation-roots/, 'no attestation roots under passkeys');
  assert.throws(() => renderRelease(ROOT, keycloakx(), { site: HARDWARE, helm: HELM }), /sterling\.attestationRootsConfigMap .* is required/);
});

// Guest accounts (D-58 to D-60): the group guests carries nothing, Keycloak holds only the guest life cycle, and no token carries an attribute
// or a group (zero trust: Keycloak authenticates and decides nothing).
const profileOf = (copy) => {
  const component = copy.components['org.keycloak.userprofile.UserProfileProvider'][0];
  return { config: JSON.parse(component.config['kc.user.profile.config'][0]), save: (config) => { component.config['kc.user.profile.config'] = [JSON.stringify(config)]; } };
};
const changeProfile = (change) => (copy) => { const { config, save } = profileOf(copy); change(config); save(config); };
const GUEST_ATTRIBUTE_NAMES = ['guestUntil', 'guestRequestedBy', 'guestApprovedBy', 'guestApprovalRef', 'guestEndedAt', 'guestEndedReason'];

test('the group guests is top level and carries no role, subgroup or attribute; a missing or loaded guests group is refused', () => {
  const { realm } = passkeys();
  assert.deepEqual(realm.groups, [{ name: 'guests', path: '/guests', attributes: {}, realmRoles: [], clientRoles: {}, subGroups: [] }]);
  assert.match(broken((copy) => { copy.groups = []; }).join('\n'), /group guests must exist/);
  assert.match(broken((copy) => { copy.groups[0].realmRoles = ['offline_access']; }).join('\n'), /guests must carry no realm role/);
  assert.match(broken((copy) => { copy.groups[0].clientRoles = { 'realm-management': ['view-users'] }; }).join('\n'), /guests must carry no client role/);
  assert.match(broken((copy) => { copy.groups[0].subGroups = [{ name: 'vip', path: '/guests/vip' }]; }).join('\n'), /guests must have no subgroup/);
  assert.match(broken((copy) => { copy.groups[0].attributes = { serves: ['industry'] }; }).join('\n'), /guests must carry no attribute/);
});

test('every guest attribute is in the user profile and only administrators view or edit it; the credential fields are not there', () => {
  const { realm } = passkeys();
  const { config } = profileOf(structuredClone(realm));
  for (const name of GUEST_ATTRIBUTE_NAMES) {
    const entry = config.attributes.find((attribute) => attribute.name === name);
    assert.ok(entry, name);
    assert.deepEqual(entry.permissions, { view: ['admin'], edit: ['admin'] }, name);
    assert.equal(entry.group, 'guest', name);
  }
  assert.match(broken(changeProfile((profile) => { profile.attributes = profile.attributes.filter((attribute) => attribute.name !== 'guestUntil'); })).join('\n'), /guestUntil must be in the user profile/);
  assert.match(broken(changeProfile((profile) => { profile.attributes.find((attribute) => attribute.name === 'guestApprovedBy').permissions.view = ['admin', 'user']; })).join('\n'), /guestApprovedBy.*only administrators/);
  assert.match(broken(changeProfile((profile) => { profile.attributes.find((attribute) => attribute.name === 'guestEndedAt').permissions.edit = ['admin', 'user']; })).join('\n'), /guestEndedAt.*only administrators/);
  for (const name of ['serves', 'nationality', 'organization']) {
    assert.match(broken(changeProfile((profile) => { profile.attributes.push({ name, permissions: { view: ['admin'], edit: ['admin'] } }); })).join('\n'), new RegExp(`${name} is a credential`), name);
  }
});

test('a security-contacts group is refused: who may approve guests is a SecurityContactCredential', () => {
  assert.match(broken((copy) => { copy.groups.push({ name: 'security-contacts', path: '/security-contacts', attributes: {}, realmRoles: [], clientRoles: {}, subGroups: [] }); }).join('\n'), /security-contacts group/);
  assert.match(broken((copy) => { copy.groups[0].subGroups = [{ name: 'security-contacts', path: '/guests/security-contacts' }]; }).join('\n'), /security-contacts group/);
});

// The approvers' sign-in for your organization's software registry (48.3-05, D-18): a public client with the device grant and, as the decided
// fallback, the code flow with PKCE to loopback addresses only. Keycloak 26.8.2's device endpoint ignores a request's acr_values and asks for
// the client's default ACR values, so the step-up comes from the client itself.
test('client sterling-supply-review is public, device grant and loopback PKCE only, asks for the step-up and carries what OpenBao binds', () => {
  const { realm, problems } = passkeys();
  assert.deepEqual(problems, []);
  const review = realm.clients.find((client) => client.clientId === 'sterling-supply-review');
  assert.ok(review, 'client sterling-supply-review');
  assert.deepEqual([review.publicClient, review.standardFlowEnabled, review.implicitFlowEnabled, review.directAccessGrantsEnabled, review.serviceAccountsEnabled],
    [true, true, false, false, false]);
  assert.equal(review.secret, undefined, 'a public client has no secret');
  assert.deepEqual(review.redirectUris, ['http://127.0.0.1/*', 'http://[::1]/*']);
  assert.equal(review.attributes['oauth2.device.authorization.grant.enabled'], 'true');
  assert.equal(review.attributes['pkce.code.challenge.method'], 'S256');
  assert.equal(review.attributes['default.acr.values'], SITE.stepUpAcr, 'the device grant asks for the step-up level');
  assert.equal(review.attributes['minimum.acr.value'], SITE.stepUpAcr);
  const mapper = (type) => review.protocolMappers.find((entry) => entry.protocolMapper === type);
  assert.equal(mapper('oidc-audience-mapper').config['included.client.audience'], 'sterling-supply-review');
  assert.equal(mapper('oidc-acr-mapper').config['access.token.claim'], 'true');
  assert.deepEqual(mapper('oidc-usersessionmodel-note-mapper').config, {
    'user.session.note': 'AUTH_TIME', 'claim.name': 'sterling_auth_time', 'jsonType.label': 'String', 'access.token.claim': 'true', 'id.token.claim': 'false', 'introspection.token.claim': 'true',
  });
  const index = realm.clients.indexOf(review);
  assert.match(broken((copy) => { copy.clients[index].redirectUris = ['https://evil.example/*']; }).join('\n'), /sterling-supply-review may redirect only to loopback addresses/);
  assert.match(broken((copy) => { copy.clients[index].implicitFlowEnabled = true; }).join('\n'), /sterling-supply-review must be public with the device grant and PKCE only/);
  assert.match(broken((copy) => { copy.clients[index].attributes['default.acr.values'] = 'webauthn'; }).join('\n'), /sterling-supply-review must ask for the step-up/);
});

test('no client or client scope puts a user attribute or a group into the access token', () => {
  const attributeMapper = { name: 'serves', protocol: 'openid-connect', protocolMapper: 'oidc-usermodel-attribute-mapper', config: { 'user.attribute': 'serves', 'claim.name': 'serves', 'access.token.claim': 'true' } };
  const groupMapper = { name: 'groups', protocol: 'openid-connect', protocolMapper: 'oidc-group-membership-mapper', config: { 'claim.name': 'groups' } };
  assert.match(broken((copy) => { copy.clients[0].protocolMappers.push(attributeMapper); }).join('\n'), /client sterling-sessions puts a user attribute or a group into the access token \(serves\)/);
  assert.match(broken((copy) => { copy.clients[0].protocolMappers.push(groupMapper); }).join('\n'), /puts a user attribute or a group into the access token \(groups\)/, 'access.token.claim defaults to true');
  assert.match(broken((copy) => { copy.clientScopes = [{ name: 'guest-claims', protocol: 'openid-connect', protocolMappers: [groupMapper] }]; }).join('\n'), /client scope guest-claims puts a user attribute or a group/);
  assert.deepEqual(broken((copy) => { copy.clients[0].protocolMappers.push({ ...attributeMapper, config: { ...attributeMapper.config, 'access.token.claim': 'false' } }); }), []);
});

// The system use notice (D-76, AC-8): every sign-in page shows your organization's notice, set per language in the realm site file.
const withNotice = (systemUseNotice) => prepare(SITE, KEYCLOAKX_SITE, { ...REALM_SITE, systemUseNotice });

test('prepareRealm writes the notice per language, turns internationalization on, supports the notice\'s languages and defaults to English', () => {
  const { realm, problems } = passkeys();
  assert.deepEqual(problems, []);
  assert.equal(realm.loginTheme, 'sterling');
  assert.equal(realm.internationalizationEnabled, true);
  assert.deepEqual(realm.supportedLocales, ['en', 'fr']);
  assert.equal(realm.defaultLocale, 'en');
  // Keycloak formats messages with MessageFormat, so the site's apostrophes are doubled to be shown as typed (47-23 tracer).
  assert.equal(realm.localizationTexts.en.sterlingSystemUseNotice, REALM_SITE.systemUseNotice.en.replaceAll("'", "''"));
  assert.equal(realm.localizationTexts.fr.sterlingSystemUseNotice, REALM_SITE.systemUseNotice.fr.replaceAll("'", "''"));
  assert.match(RAW, /"loginTheme": "sterling"/);
});

test('the realm apply refuses a missing notice, a blank English or French text, a language code that is not one, and another login theme', () => {
  const { systemUseNotice: _omitted, ...withoutNotice } = REALM_SITE;
  assert.match(prepare(SITE, KEYCLOAKX_SITE, withoutNotice).problems.join('\n'), /the realm site file needs systemUseNotice/);
  assert.match(withNotice({ en: '   ', fr: 'Texte.' }).problems.join('\n'), /systemUseNotice\.en, the English notice, is required and must not be blank/);
  assert.match(withNotice({ fr: 'Texte.' }).problems.join('\n'), /systemUseNotice\.en, the English notice, is required/);
  assert.match(withNotice({ en: 'Text.', fr: '' }).problems.join('\n'), /systemUseNotice\.fr is blank/);
  assert.match(withNotice({ en: 'Text.', english: 'Text.' }).problems.join('\n'), /"english" is not a language code such as en, fr or fr-CA/);
  assert.match(withNotice('Text.').problems.join('\n'), /the realm site file needs systemUseNotice/);
  assert.deepEqual(withNotice({ en: 'Text.', 'fr-CA': 'Texte.' }).problems, []);
  assert.match(broken((copy) => { copy.loginTheme = 'keycloak.v2'; }).join('\n'), /the login theme must be sterling/);
  assert.match(broken((copy) => { delete copy.localizationTexts.fr; }).join('\n'), /must carry the notice of every language/);
});

test('a notice with only English gives supportedLocales [en]', () => {
  const { realm, problems } = withNotice({ en: 'Authorized use only.' });
  assert.deepEqual(problems, []);
  assert.deepEqual(realm.supportedLocales, ['en']);
  assert.deepEqual(Object.keys(realm.localizationTexts), ['en']);
});

test('the login theme reaches Keycloak as ConfigMap sterling-login-theme, installed before Keycloak, mounted read-only and not optional (needs helm)', () => {
  const releases = listReleases(ROOT);
  const theme = releases.find((release) => release.name === 'sterling-keycloak-theme');
  assert.ok(theme && theme.namespace === 'sterling-identity' && theme.order < keycloakx().order, 'the theme release is in sterling-identity, before keycloakx');
  const configMap = renderRelease(ROOT, theme, { site: SITE, helm: HELM });
  assert.match(configMap, /kind: ConfigMap\n[\s\S]*name: sterling-login-theme/);
  assert.match(configMap, /\n {2}theme\.properties: \|\n[\s\S]*parent=keycloak\.v2/);
  assert.match(configMap, /\n {2}footer\.ftl: \|\n[\s\S]*sterlingSystemUseNotice/);
  assert.doesNotMatch(configMap, /no_esc/, 'HTML escaping stays on');
  const statefulSet = renderRelease(ROOT, keycloakx(), { site: SITE, helm: HELM });
  assert.match(statefulSet, /- name: login-theme\n\s+mountPath: \/opt\/keycloak\/themes\/sterling\/login\n\s+readOnly: true/);
  assert.match(statefulSet, /- name: login-theme\n\s+configMap:\n\s+name: sterling-login-theme\n\s+optional: false/);
});

test('quotes, an apostrophe, braces and accented letters reach the realm message so the page shows them as typed', () => {
  const text = '« Accès réservé » "quoted" l\'usage {0} ç.';
  const { realm, problems } = withNotice({ en: 'Text.', fr: text });
  assert.deepEqual(problems, []);
  assert.equal(realm.localizationTexts.fr.sterlingSystemUseNotice, '« Accès réservé » "quoted" l\'\'usage \'{\'0\'}\' ç.');
});
