---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 08
subsystem: deploy
status: complete
tags: [keycloak, webauthn, passkeys, realm-as-code, keycloak-config-cli, step-up, acr]
requires: [47-04]
provides:
  - "deploy/keycloak/realm.json (realm sterling; flows sterling-browser, sterling-no-credentials, sterling-x509; client sterling-sessions)"
  - "deploy/keycloak/apply.mjs (--site, --realm-site, --keycloakx-site, --dry-run; checkRealm, prepareRealm, realmSettings, substitutedRealm)"
  - "deploy/charts/sterling-keycloak-realm (ConfigMap with the checked realm, keycloak-config-cli Job), order 58"
  - "deploy/values/site.example/sterling-keycloak-realm.yaml (smtp, redirectUris, eventsExpirationSeconds, x509) and site.example/keycloakx.yaml (replicas, resources, sterling.attestation, sterling.attestationRootsConfigMap)"
  - "deploy/values/keycloakx.yaml (Postgres verify-full, HTTPS, xforwarded, JSON logs, truststore)"
  - "deploy/test/realm.test.mjs"
affects: [47-12, 47-14, 47-15, 47-16, 47-17, 47-18]
tech-stack:
  added: []
  patterns:
    - "Realm as a curated JSON with site tokens; derived tokens (webAuthnAttestation, acceptableAaguids, realm.*) computed from signInKeys and the per-site files before substitution"
    - "Per-site files that a Node script also reads are JSON syntax (valid YAML), with notes in a note object"
key-files:
  created:
    - deploy/keycloak/realm.json
    - deploy/keycloak/apply.mjs
    - deploy/charts/sterling-keycloak-realm/Chart.yaml
    - deploy/charts/sterling-keycloak-realm/values.yaml
    - deploy/charts/sterling-keycloak-realm/templates/job.yaml
    - deploy/values/sterling-keycloak-realm.yaml
    - deploy/values/sterling-keycloak-realm.release.json
    - deploy/values/site.example/sterling-keycloak-realm.yaml
    - deploy/values/site.example/keycloakx.yaml
    - deploy/test/realm.test.mjs
  modified:
    - deploy/values/keycloakx.yaml
    - deploy/values/keycloakx.release.json
    - deploy/bundle/lib/render.mjs
key-decisions:
  - "Provider ids in Keycloak 26.8.2: webauthn-authenticator-passwordless, conditional-level-of-authentication (loa-condition-level, loa-max-age), auth-cookie, auth-x509-client-username-form; required action webauthn-register-passwordless"
  - "keycloak-config-cli 6.5.1-26.5.5 refuses webAuthnPolicyPasswordlessResidentKey (unknown to its Keycloak 26.5 model); realm.json sets webAuthnPolicyPasswordlessRequireResidentKey Yes, which Keycloak 26.8.2 stores as residentKey required"
  - "Built-in flows cannot be deleted, so every binding (browser, direct grant, reset credentials, first broker login, docker) names a flow defined in realm.json; the four non-browser ones bind sterling-no-credentials, which has no step"
  - "keycloak-config-cli variable substitution is $(env:NAME): the sterling-sessions secret arrived from the Job environment"
  - "acr, auth_time and the sterling-sessions audience are explicit protocol mappers on the client, so they are in the access token whatever the default scopes do"
  - "The admin API returns a WebAuthn credential's credentialData with three display fields (authenticatorProvider, iconLight, iconDark) that POST /users refuses; with only the stored fields (aaguid, credentialId, counter, credentialPublicKey, attestationStatementFormat, transports) the credential round trip is exact (research A11, for 47-14)"
  - "When the site turns smart cards on, sterling-x509 becomes the browser flow; it has no step-up level, so signing is refused while it is bound (safe failure, noted in the site file)"
requirements-completed: [DEP-04]
duration: ~1h30m
completed: 2026-11-24
estimate:
  tokens: 90000
  tasks: 3
actuals:
  tokens: 16500
  tasks: 3
  commits: 3
plan_head_before: 17ebc17e
plan_head_after: a2bd75c8
---

# Phase 47 Plan 08: Keycloak realm as code Summary

**Realm sterling is now code: passwordless WebAuthn only at both sign-in levels, step-up level 2 valid for the site's step-up window, and admin-only unique emails. keycloak-config-cli applied it to Keycloak 26.8.2 twice, and the second run changed nothing. checkRealm refuses each broken rule before anything is applied, including an empty allowlist under hardware-only.**

## Tasks

| Task | Result | Commit |
|---|---|---|
| 1. Spike S6 (tracer): flows built and exported, applier twice, credential round trip | done; tracer gate re-ran the applier end to end before expanding | `082588d9` |
| 2. The realm rules locked by checkRealm and the test (TDD) | done, 10 tests | `14d1ef29` |
| 3. keycloakx values | done, 1 render test | `a2bd75c8` |

## Spike S6

Keycloak `quay.io/keycloak/keycloak@sha256:75b5c435...` (26.8.2, `start-dev`) and keycloak-config-cli `@sha256:303b5c80...` (6.5.1-26.5.5)
ran in podman on an internal network, under the memory cap and the heavy-run lock.

**Flows built through the admin REST API and exported** (`POST /admin/realms/sterling/partial-export`), once with attestation `none` and no
AAGUIDs and once with `direct` and a test AAGUID. The only fields that differ are `webAuthnPolicyPasswordlessAttestationConveyancePreference`
(`none` / `direct`) and `webAuthnPolicyPasswordlessAcceptableAaguids` (`[]` / `["ee882879-..."]`). The export shape (aliases, `authenticatorFlow`,
`flowAlias`, `authenticatorConfig` by alias, `requirement` ALTERNATIVE and CONDITIONAL) was copied into `realm.json`. Ids and secrets were
dropped, and the test values were replaced by `${site.rpId}`, `${site.webAuthnAttestation}`, `${site.acceptableAaguids}`,
`${site.stepUpAcr}` and `${site.stepUpMaxAgeSeconds}`.

```
authenticator providers (webauthn, x509): webauthn-authenticator, direct-grant-auth-x509-username, auth-x509-client-username-form, webauthn-authenticator-passwordless
user profile in export: components["org.keycloak.userprofile.UserProfileProvider"] = [{ providerId: declarative-user-profile, config: { kc.user.profile.config: ["<json>"] } }]
```

**Applier, twice, against a fresh Keycloak** (the realm as `apply.mjs` substitutes it for the CI site; `checkRealm problems: 0`):

```
run 1: Importing file 'file:/config/realm.json' ... Server info available. Using version: 26.8.2 ... keycloak-config-cli ran in 00:04.150
run 2: Importing file 'file:/config/realm.json' ... keycloak-config-cli ran in 00:00.823   (realm checksum unchanged: nothing imported)
first attempt: Unrecognized field "webAuthnPolicyPasswordlessResidentKey" (class de.adorsys.keycloak.config.model.RealmImport)  -> field removed
applied realm: browserFlow sterling-browser, directGrantFlow sterling-no-credentials, attestation none, AAGUIDs [], acr.loa.map {"webauthn":1,"webauthn-fresh":2}
resident key after apply: requireResidentKey Yes, residentKey required, user verification required
client secret from the Job environment: from-the-job-environment      ($(env:STERLING_SESSIONS_CLIENT_SECRET) in realm.json)
email edit: ["admin"]
required actions: CONFIGURE_TOTP=false UPDATE_PASSWORD=false webauthn-register-passwordless=true CONFIGURE_RECOVERY_AUTHN_CODES=false
browser flow: auth-cookie ALTERNATIVE, sterling-browser webauthn ALTERNATIVE, sterling level 1 CONDITIONAL (LoA REQUIRED, webauthn-authenticator-passwordless REQUIRED), sterling level 2 fresh CONDITIONAL (...)
```

**Credential export and import (research A11):**

```
POST /users with credentials [{ type: webauthn-passwordless, credentialData, secretData: "{}" }]   -> 201
GET /users/{id}/credentials -> fields id, type, userLabel, createdDate, credentialData (no secretData)
  credentialData adds authenticatorProvider "YubiKey 5 Series", iconLight, iconDark (looked up from the AAGUID)
POST /users into another realm with credentialData exactly as returned  -> 500 "Cannot parse the JSON"
POST /users with only aaguid, credentialId, counter, credentialPublicKey, attestationStatementFormat, transports -> 201
stored credential fields equal after the round trip: true
```

47-14's signed user export must keep only those stored fields. The base64 text of `credentialPublicKey` is re-encoded by Keycloak on first
import (the synthetic value did not compare byte for byte with the first input). After that, export and import are exact.

**Moved to the lab run (47-18):** `acr` and `auth_time` in a real access token after a WebAuthn ceremony, and a step-up request with
`acr_values`, all with a same-device passkey (D-57).

## Verification

- `deploy/test/realm.test.mjs`, `render.test.mjs` and `rke2.test.mjs` with the pinned helm, under the memory cap: 25 tests run, 25 pass. This plan
  added 11 of them, all in realm.test.mjs. The render test now also renders `keycloakx` with the new values and `sterling-keycloak-realm`.
- `node deploy/keycloak/apply.mjs --site deploy/test/fixtures/site.ci.yaml --dry-run` -> `realm sterling checked: signInKeys passkeys, attestation
  none, 0 acceptable AAGUIDs, rpId site.example, browser flow sterling-browser` (exit 0).
- The same with a copy of the CI site set to `hardware-only` and `acceptableAaguids []` exits 1 with two problems: "the acceptableAaguids allowlist
  is empty, which would accept every authenticator including self-attestation" and the missing attestation-roots ConfigMap.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] "passwordless" matched the forbidden-step pattern**
- `/password/` also matched `webauthn-authenticator-passwordless`. The pattern is now `password(?!less)|otp|recovery|...`, which is linear and has no
  nested repetition.

**2. [Rule 3 - Blocking] The resident-key field the applier knows**
- See key-decisions. `checkRealm` requires `RequireResidentKey` `Yes`, and accepts `ResidentKey` only when it is absent or `required`.

**3. [Rule 3 - Blocking] Per-site files that apply.mjs reads**
- `site.example/sterling-keycloak-realm.yaml` and `site.example/keycloakx.yaml` are JSON syntax, because apply.mjs has no YAML parser. The realm
  site file may name `${site.<key>}` (for example the mail host `mail.${site.domain}`). Empty optional X.509 values are filled with `not-set`,
  because the substitution refuses empty strings.

**4. [Rule 2 - Missing critical] More bindings and actions closed**
- `firstBrokerLoginFlow` (the built-in one re-authenticates with a password) and `dockerAuthenticationFlow` (HTTP basic) are bound to
  `sterling-no-credentials`. `webauthn-register` (the second-factor variant) and `UPDATE_EMAIL` are disabled. `username` is admin-edit only too.

**5. Chart and sequencing**
- The realm chart renders a placeholder `{}` realm when the value is empty, so plain renders (the global render test) still work. Only apply.mjs
  installs it, with the checked realm. The Job name carries a hash of the realm, so a changed realm runs a new Job.
- Task 2's commit carries the keycloakx render test, which passes once Task 3's values are in; both commits were pushed together.
- The applier trusts the site CA through ConfigMap `sterling-site-ca` key `truststore.p12` (a password-less PKCS12 for Java). 47-13 or 47-16
  must write that key next to `ca.crt`.

### Process

- **The shared heavy-run lock was held by mistake.** The first S6 run started a podman network inside a `flock`. Its `aardvark-dns` daemon
  inherited the lock descriptor and kept the lock after the command ended, which blocked the other executor's runs for about 10 minutes. It
  was found with `fuser` and released by removing the spike network. Every later container run uses `flock -o` (the lock is not passed to
  children) and removes its containers in the same run.

## Settings chosen

- Keycloak: 2 nodes, 500m CPU and 1Gi request, 2Gi limit, sized for an HQ of about 400 people with sign-in bursts of about 200. These are
  provisional until Phase 48, and no capacity is claimed.
- Events are kept 90 days in Keycloak's database; the site log store keeps them longer. Brute-force protection is on (10 failures).

## Known Stubs

None. `attestationRootsConfigMap` is empty in the example on purpose: it is unused under passkeys, and required (render and apply refuse)
under hardware-only.

## Self-Check: PASSED

- All 10 created files exist; commits `082588d9`, `14d1ef29`, `a2bd75c8` are ancestors of HEAD.
