---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 14
subsystem: deploy
status: complete
tags: [federation, keycloak, webauthn, signed-file, cosign, openbao, pki, crl, oidc-broker]
requires: [47-06, 47-07, 47-08]
provides:
  - "deploy/keycloak/users.mjs (export, import; exportUsers, importUsers, checkUsersDocument, readVerified, keycloakAdmin); file format sterling-users/1"
  - "deploy/openbao/pki-files.mjs (csr, import-intermediate, export-crl, import-crl; requestIntermediate, importIntermediate, exportCrl, importCrl, pemBlocks)"
  - "identity provider hq and flow sterling-hq-first-login in deploy/keycloak/realm.json, off unless the realm site file sets hqBroker.enabled"
  - "deploy/test/federation.test.mjs"
affects: [47-13, 47-16, 47-17, 47-18]
tech-stack:
  added: []
  patterns:
    - "Verify a private copy: the signed file and its signature are copied into a private folder, the copy is verified, and the copy is what is read"
    - "Refuse before change: every import returns { ok: false, reason } before its first Keycloak or OpenBao call or file write, and the tests count those calls"
key-files:
  created:
    - deploy/keycloak/users.mjs
    - deploy/openbao/pki-files.mjs
    - deploy/test/federation.test.mjs
  modified:
    - deploy/keycloak/realm.json
    - deploy/keycloak/apply.mjs
    - deploy/values/site.example/sterling-keycloak-realm.yaml
    - deploy/charts/sterling-keycloak-realm/templates/job.yaml
key-decisions:
  - "A credential record travels with only the stored WebAuthn fields plus secretData \"{}\": Keycloak 26.8.2 answers 500 to user creation when secretData is missing (found by the tracer; the fake Keycloak now refuses it too)"
  - "Keycloak 26.8.2 adds credentials to an existing person through PUT /users/{id} with a credentials list, and keeps the person's other fields and keys"
  - "Import refuses to add keys to a local person of the same username whose email differs: that is a different person"
  - "The rpId an import compares with is the site file's rpId (the same value apply.mjs puts in the realm), so a refusal needs no Keycloak call"
  - "import-intermediate finds the imported issuer by serial number and makes it the default only if OpenBao holds its key; the HQ root is imported beside it as a keyless issuer"
  - "The HQ broker is reached only through kc_idp_hint=hq (identity-provider-redirector with no default provider) or the login page; its first sign-in is idp-detect-existing-broker-user then idp-auto-link, and syncMode IMPORT"
requirements-completed: [DEP-09]
duration: ~1h10m
completed: 2026-11-24
estimate:
  tokens: 70000
  tasks: 3
actuals:
  tokens: 17000
  tasks: 3
  commits: 3
plan_head_before: 4ee42c0b9b68f47672f51c4fdaed223b79d707f2
plan_head_after: 907a58c384a6fd8f06c39baa8b7c864bccb878f8
---

# Phase 47 Plan 14: HQ and edge federation by signed file Summary

**A person and both of their passwordless credentials moved from one Keycloak 26.8.2 to another through a signed `sterling-users/1` file, and the credential records match exactly at both sites. A site's intermediate CSR came out of a real OpenBao 2.7.3 and was signed by a lab root. It was imported only after its signature, its chain to the root and its CA and validity checks passed, and a certificate issued from it verifies against the written chain. Revocation lists travel the same way. HQ brokering is in the realm but off by default, and when it is on it only links people who already exist at the site. Every refused file is refused before any Keycloak or OpenBao call and before any file is written.**

## Tasks

| Task | Result | Commit |
|---|---|---|
| 1. A person and their passwordless keys by signed file (tracer) | done. The tracer found a bug (missing `secretData`) that was fixed before expanding. The tracer gate re-ran the test and the two-Keycloak tracer end to end. | `26d12d5e` |
| 2. The site intermediate and revocation lists by signed file (TDD) | done, 9 tests, also checked against a real OpenBao | `a4938669` |
| 3. Optional HQ brokering, off by default | done, 2 tests, also checked against Keycloak with keycloak-config-cli | `907a58c3` |

## Tracer (Task 1)

Two Keycloak 26.8.2 containers (`quay.io/keycloak/keycloak@sha256:75b5c435...`, `start-dev`, 1g each) ran under the heavy lock and were removed in
the same run. Each got realm `sterling` as `apply.mjs` prepares it for the CI site (`checkRealm problems: 0`, rpId `site.example`). The person
was created at A with two synthetic passwordless credentials. The `users.mjs` CLI used a throwaway cosign key pair; the token came from a file.

```
POST realm sterling at A: 201, at B: 201
POST person ada at A with two synthetic passwordless credentials: 201
users.mjs export --users ada ... (A)        -> exit 0  exported 1 people with 2 passwordless keys to ada.users.json, signed
users.mjs import --in ada.users.json ... (B) -> exit 1  create ada: Keycloak answered 500        (first run: secretData missing, fixed)
users.mjs import ... (B), after the fix      -> exit 0  created: ada (2 keys added, 0 already here)
users.mjs import ... (B), again              -> exit 0  unchanged: ada (0 keys added, 2 already here)
at A: {"username":"ada","email":"ada@site.example","requiredActions":[]}; credential ids bkqpVjyqXTZiZjyidNglbDU2a2TmjtoG7Wp0bbjPovM, eTZmsxsxlsSVfrg1HmSsQWQaTUuzJd10R1seExd-NYk
at B: {"username":"ada","email":"ada@site.example","requiredActions":[]}; credential ids bkqpVjyqXTZiZjyidNglbDU2a2TmjtoG7Wp0bbjPovM, eTZmsxsxlsSVfrg1HmSsQWQaTUuzJd10R1seExd-NYk
credential records equal at A and B (type, label, aaguid, id, counter, public key, format, transports): true
file changed after signing, import at B      -> exit 1  refused: ada.users.json: the signature does not verify with org.pub (...); nothing was changed.
credentials at B before and after the refused import: 2, 2
```

A probe before the tracer showed that `PUT /admin/realms/<realm>/users/{id}` with `{ credentials: [...] }` adds the credential. The person then
had two keys, and their email, names and other keys were unchanged. `importUsers` uses this for a person who already exists and lacks some of
their key ids.

## PKI against a real OpenBao (Task 2)

OpenBao `openbao-ubi@sha256:bb94f6b1...` (2.7.3, dev mode, throwaway, 512m) ran with a `pki_int` mount and a P-384 lab root made with openssl,
which stands in for the HQ offline root. The CLI was run end to end:

```
pki-files.mjs csr                  -> exit 0  wrote the signed intermediate CSR site.csr (OpenBao key e2ae6b48-...); subject CN=Sterling ci site intermediate
openssl x509 -req ... -CA lab-root.pem    (the key ceremony's step, offline), then signed-file.mjs sign
pki-files.mjs import-intermediate  -> exit 0  pki_int issuer f82e900a-... is the default; the chain is in site-ca-chain.pem
issuers: d33774e2-... key_id "" (the lab root, imported beside it), f82e900a-... key_id e2ae6b48-... is_default true
chain subjects: CN=Sterling ci site intermediate, CN=Lab HQ offline root
second run                         -> exit 0  same issuer, still the default
leaf from pki_int/issue            -> openssl verify -CAfile lab-root.pem -untrusted site-int.pem leaf.pem: OK
pki-files.mjs export-crl (after revoking the leaf) -> exit 0; issuer CN=Sterling ci site intermediate, Next Update +72 h, the leaf's serial listed
pki-files.mjs import-crl --out smart-card/site.crl.pem --out tls/site.crl.pem -> exit 0; both copies equal the exported CRL
import-intermediate --root other-root.pem -> exit 1  refused: the certificate does not chain to the HQ root CN=Other root (issuer CN=Lab HQ offline root); nothing was changed. (no chain file)
```

## HQ brokering against Keycloak (Task 3)

The realm was prepared by `apply.mjs` and applied by keycloak-config-cli 6.5.1 (`@sha256:303b5c80...`, the real applier) to two Keycloak
26.8.2 containers: A with `hqBroker` on (issuer `https://keycloak.hq.example/realms/sterling`, client `edge-1`) and B with the example's
`hqBroker` off. The browser checks ran over plain HTTP, so on these throwaway realms only the tracer lowered `sslRequired`; it did so after the
applier had applied the realm with `sslRequired all`.

```
realm on:  checkRealm problems 0; hq enabled true,  issuer https://keycloak.hq.example/realms/sterling, clientSecret $(env:STERLING_HQ_BROKER_CLIENT_SECRET)
realm off: checkRealm problems 0; hq enabled false, issuer https://hq.invalid/realms/sterling,          clientSecret not-set
A (on), applier run 1 -> ran in 00:04.429; run 2 -> ran in 00:00.775 (nothing to change)
B (off), no broker secret in the Job environment -> ran in 00:04.945
A hq: enabled true,  firstBrokerLoginFlowAlias sterling-hq-first-login, authenticateByDefault false, syncMode IMPORT
B hq: enabled false, (same flow), issuer https://hq.invalid/realms/sterling, clientId not-set
sterling-hq-first-login: idp-detect-existing-broker-user REQUIRED, idp-auto-link REQUIRED
sterling-browser: auth-cookie ALTERNATIVE, identity-provider-redirector ALTERNATIVE, sterling-browser webauthn ALTERNATIVE
realm firstBrokerLoginFlow: sterling-no-credentials (unchanged)
A (on)  with kc_idp_hint=hq: 303 -> /realms/sterling/broker/hq/login
A (on)  without a hint:      200 local WebAuthn page (no HQ link on the page)
B (off) with kc_idp_hint=hq: 200 local WebAuthn page (the hint is ignored)
B with hqBroker on but no broker secret in the environment -> keycloak-config-cli: Cannot resolve variable 'env:STERLING_HQ_BROKER_CLIENT_SECRET';
  nothing applied (B's hq stayed disabled)
```

The passwordless WebAuthn page does not list identity providers, so a person reaches HQ only through a link that carries `kc_idp_hint=hq`. The
landing page (47-15) or the runbook (47-17) can offer that link at a linked edge site.

## Verification

- `deploy/test/federation.test.mjs` and `deploy/test/realm.test.mjs`, with the pinned cosign and helm, under the memory cap and the heavy lock:
  29 run, 29 pass. This plan added all 18 tests in federation.test.mjs: 7 for users, 9 for PKI and 2 for the broker. The 11 realm tests
  are unchanged and still pass with the broker in the realm.
- Every refusal test asserts that the fake Keycloak or OpenBao recorded zero calls, and that no chain file or CRL file was written.
- `node deploy/openbao/pki-files.mjs --help` lists `csr`, `import-intermediate`, `export-crl` and `import-crl`. `node deploy/keycloak/users.mjs --help`
  lists `export` and `import`.
- `node deploy/keycloak/apply.mjs --site deploy/test/fixtures/site.ci.yaml --dry-run` -> `realm sterling checked: ... browser flow sterling-browser`.
- The whole deploy suite (`deploy/test/*.test.mjs`, as CI runs it) with the pinned helm and cosign, once at the end, under the cap and the lock: 76 run, 76 pass, 0 skipped. That covers the render test of the applier Job with the new optional environment entry.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] User creation needs `secretData`**
- Found during: Task 1 (tracer). Keycloak answered 500 to `POST /users` because the credentials had no `secretData` (47-08's S6 sent `"{}"`).
  `storedCredential` now sends `secretData: "{}"`, and the fake Keycloak refuses a credential without it, so the test would catch a regression.
  Commit `26d12d5e`.

**2. [Rule 2 - Missing critical] Import checks beyond the plan's list (T-47-47)**
- Import refuses any credential type other than `webauthn-passwordless`, such as a password record in a signed file, before any call.
  It also refuses to add keys to a local person of the same username whose email differs.
- The signed file is verified as a private copy, and that same copy is what gets read, so the file cannot change between the check and the use.
  `readVerified` lives in `users.mjs`, and `pki-files.mjs` imports it from there. It could move into `deploy/bundle/signed-file.mjs`, which was
  not in this plan's file list.

**3. [Rule 3 - Blocking] Task 3 needed four files outside `files_modified`**
- The broker's issuer, client and secret come from the realm site file. That needed:
  - `realmSettings` and `checkRealm` in `deploy/keycloak/apply.mjs`;
  - `hqBroker` in `deploy/values/site.example/sterling-keycloak-realm.yaml`;
  - an optional `STERLING_HQ_BROKER_CLIENT_SECRET` (Secret `keycloak-hq-broker`) in the applier Job, `deploy/charts/sterling-keycloak-realm/templates/job.yaml`.
- Without the Job entry, an enabled broker could never be applied. keycloak-config-cli fails on an undefined variable, as the tracer showed.
- No other plan in this wave lists these files. 47-18 later adds `deploy/lab/site.lab/sterling-keycloak-realm.yaml`, which needs the
  `hqBroker` key (off) to be copied from the example.

**4. [Rule 2 - Missing critical] The identity-provider redirector in `sterling-browser`**
- Without it, `kc_idp_hint=hq` does nothing and the WebAuthn page shows no HQ link, so the broker would be unreachable.
- It is an ALTERNATIVE with no default provider (checkRealm refuses one), and the tracer showed local sign-in unchanged.

**5. Sequencing**
- Task 2's code was drafted before its tests were written down, so there was no separate RED run (the same as 47-07 Task 2).
- The light unit tests waited behind the lab VM's heavy lock for about 30 minutes; running them outside the lock was refused.

## Notes for later plans

- **47-13 / apply.mjs (OpenBao):** `pki_int`'s CRL expires after OpenBao's default of 72 hours (`Next Update` in the run above). A disconnected
  edge that checks CRLs strictly will refuse certificates once the carried list expires. Set `pki_int/config/crl` `expiry` longer than the
  media carry interval.
- **47-16 / 47-17:** the chain `import-intermediate` writes is the site's `siteCaChain` value (ConfigMap `sterling-site-ca`). `import-crl --out`
  takes the CRL path of the smart-card flow (realm site file `x509.crlPath`) and the TLS trust folder; loading them into the cluster is the runbook's job.
- **47-17 runbook:** a person's OpenBao Transit keys do not travel in the user export. Moving them needs the Control Group approval with
  `X-Vault-Wrap-TTL` (47-07).
- Signing at an edge site after an HQ-brokered sign-in still needs a fresh local WebAuthn ceremony (step-up level 2). The person's keys are at
  the edge through the signed user export.

## Known Stubs

None. The disabled broker's `https://hq.invalid/realms/sterling` issuer and `not-set` client are deliberate placeholders: Keycloak's URL
checks accept them, the name never resolves, and checkRealm refuses them once the broker is on.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: auth-path | deploy/keycloak/realm.json | identity-provider-redirector added to the browser flow (follows `kc_idp_hint` only to an enabled provider; covered by T-47-49 and the checkRealm rules above) |

## Self-Check: PASSED

- All 3 created files exist; commits `26d12d5e`, `a4938669` and `907a58c3` are on feat/phase-47-14.

## Amendment: version safety (47 D-69, from #185), added at the wave 5 integration

- `exportUsers` writes `requires: []`; `USERS_FEATURES` is exported and empty. `checkUsersDocument` refuses the whole file before any
  Keycloak call when `requires` is missing or not a list (requires is part of `sterling-users/1` from its first version, and no file has
  reached a site yet), holds anything but sorted, unique `name@N` ids, or names an id not in `USERS_FEATURES`, with one sentence naming the
  ids. The target-site check before an export (`reads.users`) is 47-21's and 47-30's, not this plan's.
- Tests (`federation.test.mjs`, 5 added): `requires: ['guests@1']` refused naming it with zero admin calls; a missing list, a non-list, an
  unsorted list and a malformed id each refused with zero calls; the existing import case checks `requires: []` is written and accepted.
