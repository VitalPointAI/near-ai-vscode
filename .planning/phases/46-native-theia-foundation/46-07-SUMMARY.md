---
phase: 46-native-theia-foundation
plan: 07
subsystem: auth
tags: [theia, openbao, kv-v2, transit, keystore, secretstorage, step-up, ed25519]
status: complete

requires:
  - phase: 46-02
    provides: "SessionIdentity.session(), createOpenBaoClient, readHostingConfig, startFakeOpenBao, makeTestSigner, startDevOpenBao, createPersonKeys"
  - phase: 46-05
    provides: "the copy lint over workbench/extension/src/browser and common"
provides:
  - "encodeSegment, decodeSegment, serviceFolder, secretPath (kv-path.ts)"
  - "createOpenBaoKeyStore, createUnavailableKeyStore, chooseKeyStore, createDelegatingKeyStore (key-stores.ts)"
  - "KeyringKeyStoreService (keyring-key-store.ts): Theia's KeyStoreServiceImpl with no memory fallback"
  - "rebind(KeyStoreService) and /services/sterling-secret-store (key-store-backend-module.ts); status bar entry sterling-secret-store"
  - "createKeyService, keyServiceRpc, KeyService (key-service.ts); /services/sterling-key-service with sign and generateWrappedDataKey only"
  - "STERLING_OPENBAO_STEPUP_ROLE (default sterling-workbench-stepup) in readHostingConfig; ActiveSession.forwardedToken"
  - "test fixtures: the sterling-workbench-stepup role, its signing policy (sterling-workbench-sign after the 46-08 alignment) and TEST_STEPUP_ACR in startDevOpenBao"
affects: [46-08, 47, 33]

actuals:
  tokens: 20500       # chars/4 over the added lines of the plan diff (81,948 chars), SUMMARY excluded
  tasks: 3
  commits: 3          # measured: git rev-list --count plan_head_before..HEAD at SUMMARY time; the SUMMARY commit follows
plan_head_before: 9573ec418a85b08111979d39a3681566d0b419dc
plan_head_after: 1ee3d837a51d1b3007d92b20944d86b95ddf0353

tech-stack:
  added: []
  patterns:
    - "Theia-free cores (kv-path, key-stores, key-service) with thin inversify modules; refusals as ServiceResult values"
    - "A Theia binding replaced with rebind() and a delegating store that awaits a start-time choice held in a singleton chooser (inversify 6 cannot resolve a Promise-valued binding with get())"

key-files:
  created:
    - workbench/extension/src/common/secret-store.ts
    - workbench/extension/src/common/key-service.ts
    - workbench/extension/src/node/kv-path.ts
    - workbench/extension/src/node/key-stores.ts
    - workbench/extension/src/node/keyring-key-store.ts
    - workbench/extension/src/node/key-store-backend-module.ts
    - workbench/extension/src/node/key-service.ts
    - workbench/extension/src/node/key-service-backend-module.ts
    - workbench/extension/src/browser/secret-store-frontend-module.ts
    - workbench/test/kv-path.test.ts
    - workbench/test/key-store.test.ts
    - workbench/test/key-service.test.ts
    - workbench/test/container/openbao-keys.test.ts
  modified:
    - workbench/extension/package.json
    - workbench/extension/src/node/hosting-config.ts
    - workbench/extension/src/node/session-identity.ts
    - workbench/test/helpers/openbao-dev.ts
    - workbench/test/openbao-client.test.ts
    - workbench/test/session-identity.test.ts

key-decisions:
  - "KV segment encoding is u + base64url of the UTF-8 bytes; a string with an unpaired surrogate is refused, because two such strings share a UTF-8 form"
  - "deletePassword reads the metadata first and answers false for a secret that is not there, then deletes the metadata (all versions)"
  - "In local mode a keytar module that is not there at all gives the no-store reason; one that loads but cannot reach a keyring gives the keyring-failed reason"
  - "STERLING_OPENBAO_STEPUP_ROLE is read with the other hosted settings and must differ from STERLING_OPENBAO_JWT_ROLE"
  - "The ordinary sterling-workbench test policy no longer grants transit/sign; only the step-up role's policy does"

requirements-completed: [FND-T-03, FND-T-04]

duration: about 70 min of work, plus about 50 min waiting on the shared heavy lock
completed: 2026-11-24
---

# Phase 46 Plan 07: Per-person secrets and the key service Summary

**Every secret an extension or the MCP OAuth store saves through Theia's key store now goes to the person's own OpenBao KV path (or this computer's keyring, or fails with a plain reason), never to memory; the person's long-term keys stay in OpenBao Transit, and signing happens only through OpenBao's step-up role after a fresh passkey or security key sign-in. A real dev OpenBao proves the paths, that a second person gets 403, and an ed25519 signature that verifies.**

## Owner approval needed in the PR

None. No gate file changed and no package, image or tool was added (keytar is Theia's own dependency and is not built into the image).

## Contract names as built (46-08 and Phase 47 read these)

| Name | Shape |
|------|-------|
| `secretPath(entityId, service, account)` | `users/<entityId>/u<base64url(service)>/u<base64url(account)>` inside the KV mount; `encodeSegment`, `decodeSegment`, `serviceFolder` beside it |
| `createOpenBaoKeyStore(identity, { kvMount })` | the six KeyStoreService methods; `GET`/`POST <kv>/data/<path>`, `GET <kv>/metadata/<folder>?list=true`, `GET` then `DELETE <kv>/metadata/<path>` |
| `createUnavailableKeyStore(reason)`, `chooseKeyStore(config, { identity, keyring })`, `createDelegatingKeyStore(choice)` | the start-time choice: hosted is OpenBao; local is the keyring when it loads and answers, otherwise unavailable |
| `KeyringKeyStoreService` | Theia's `KeyStoreServiceImpl` with `getKeytar()` rethrowing; `probe()` |
| `createKeyStoreModule(options)` / default export | `rebind(KeyStoreService)`, a `BackendApplicationContribution` that makes the choice at start and logs `Sterling secret store: <kind>`, and the status service |
| Common secret store | `SECRET_STORE_PATH = '/services/sterling-secret-store'`, `SecretStoreService` (`status()`), `SecretStoreStatus` (`{ store: 'openbao' \| 'keyring' \| 'unavailable', reason? }`), `SECRET_STORE_TEXT` |
| Status bar | entry `sterling-secret-store` (DOM id `status-bar-sterling-secret-store`), "Secrets are unavailable" with the reason as tooltip, plus one notification; nothing in hosted or keyring mode |
| `createKeyService(identity, clock?)` | `sign(messageBase64)` gives `{ signature, keyVersion }`; `generateWrappedDataKey()` gives `{ ciphertext }`; `unwrapDataKey(ciphertext)` gives `{ plaintext }` (base64), backend only; every result a `ServiceResult` |
| `keyServiceRpc(service)` and `KEY_SERVICE_PATH = '/services/sterling-key-service'` | `KeyServiceRpc` with `sign` and `generateWrappedDataKey` only; `KEY_SERVICE_TEXT` |
| Hosting setting | `STERLING_OPENBAO_STEPUP_ROLE`, default `sterling-workbench-stepup`, must differ from `STERLING_OPENBAO_JWT_ROLE` |
| `ActiveSession.forwardedToken` | the latest forwarded JWT, backend only, for the step-up login |
| Test fixtures | `TEST_STEPUP_ACR` and role `sterling-workbench-stepup` (bound `acr`, TTL 5 min) in `startDevOpenBao`; the ordinary `sterling-workbench` test policy no longer grants `transit/sign`. Aligned during 46-08 with Phase 47's `deploy/openbao` (47-07): the signing policy is `sterling-workbench-sign` (`transit/sign/person-<id>` only, exported as `STERLING_SIGN_POLICY`), the step-up role carries it beside `sterling-workbench`, with `token_explicit_max_ttl` equal to the window and `token_no_default_policy` on both roles |

Signing order, as the unit fake asserts: `POST auth/<jwt>/login {role: <step-up role>, jwt: <forwarded token>}`, then `POST <transit>/sign/person-<id> {input}` with that token, then `POST auth/token/revoke-self` with it (also when the sign fails). The guard before any call: `STERLING_STEPUP_ACR` set, the token's `acr` equal to it, `auth_time` present, no older than `STERLING_STEPUP_MAX_AGE_SECONDS` and no more than 30 s ahead of the clock.

## Planning choices (as reported)

1. Segment encoding `u` + base64url of the UTF-8 bytes. Never empty, never `.` or `..`, no `/`, reversible for `keys()` and `findCredentials()`. A string with an unpaired surrogate is refused, because two such strings have the same UTF-8 form and would share a path. `deletePassword` deletes the metadata, so all versions. Rated costly: it is in the Phase 47 contract.
2. The RPC exposes `sign` and `generateWrappedDataKey` only; `unwrapDataKey` stays a backend call for Phase 33. Reversible.
3. The secret store status is its own small RPC (`/services/sterling-secret-store`), so the browser says "Secrets are unavailable" at start. Reversible.

## Real-test evidence (dev OpenBao from the pinned openbao-test image)

- Person A's six key store methods round-trip four awkward name pairs (`127.0.0.1-sterling-test.secret-probe`/`probe`, an MCP OAuth account with `%`, `:` and spaces, `../..`/`a/../b`, and unicode with an empty account). Root's recursive listing of `kv/metadata/` shows exactly those four paths, each under `users/<A>/`.
- A new identity and store for A (as after a restart) read the secret back, with the same entity and a new token.
- Person B's store sees nothing of A's, and B's token on A's raw `kv/data/users/<A>/…` and on the listing of `kv/metadata/users/<A>/` answers **403**.
- After a fresh step-up, `sign` returns a signature that **verifies with ed25519** (node:crypto, the 32-byte raw key from `transit/keys/person-<A>` read by root, wrapped as SPKI), and does not verify for another message.
- OpenBao itself refuses: the ordinary session token on `transit/sign/person-<A>` answers 403, and a JWT without the step-up `acr` cannot log in to the step-up role.
- A stale step-up (an hour old) is refused by the workbench with no OpenBao call; a token without `acr` is refused.
- A wrapped data key unwraps to 32 bytes, the same twice, and the ciphertext does not contain them.
- B, with no keys yet, gets "Your signing key is not set up yet" and "Your data key is not set up yet".

## Tasks

| Task | Commit | Content |
|------|--------|---------|
| 1 | `3855b345` | kv-path.ts, key-stores.ts, common/secret-store.ts; 13 tests |
| 2 | `3ed74fe3` | keyring-key-store.ts, key-store-backend-module.ts, secret-store-frontend-module.ts, theiaExtensions entry; 4 tests |
| 3 | `1ee3d837` | key-service.ts, common/key-service.ts, key-service-backend-module.ts, the step-up role setting, `forwardedToken`, the dev OpenBao step-up role; 12 unit and 8 dev-OpenBao tests, plus 2 extended assertions |

## Verification (tests run, separate from tests added)

- Added: 37 tests. That is 5 in `kv-path.test.ts`, 12 in `key-store.test.ts`, 12 in `key-service.test.ts` and 8 in `container/openbao-keys.test.ts`. Extended: `openbao-client.test.ts` (the step-up role default, a bad name, and a role equal to the session role) and `session-identity.test.ts` (`forwardedToken` is the person's own latest token). No test was removed or loosened; the two hosting-config `deepEqual`s gained the new `stepUpRole` field.
- `npm --prefix workbench run lint`: clean.
- `npm --prefix workbench test`: 81 run, 81 passed.
- `npm --prefix workbench run test:container`: 30 run, 30 passed (egress 4, image 9, openbao-identity 5, openbao-keys 8, smoke 4 with its 2 Playwright tests). The image carries both new backend modules and the frontend module and still passes every 46-01 to 46-03 check.
- Root copy lint after the wave: 31 run, 31 passed, with no baseline change, so the new secret store and key service copy is at zero hits.
- Acceptance greps: `export function secretPath` 1; `InMemoryCredentialsProvider` in key-stores.ts 0; `@theia/` imports in kv-path.ts 0; `rebind(KeyStoreService)` 1; `getKeytar` 3; `key-store-backend-module` in extension/package.json 1; `transit/keys` in key-service.ts 0; `datakey/wrapped` 2; the confirm text 1; an `unwrapDataKey` member on the RPC interface 0; em-dashes 0.
- No container, network or image was left behind.

TDD RED, each observed before its modules existed: Task 1's run failed at the test build with `Could not resolve "../extension/src/node/kv-path.ts"`, `key-stores.ts` and `common/secret-store.ts`. Task 2's failed with `Could not resolve "../extension/src/node/keyring-key-store.ts"` and `key-store-backend-module.ts`. Task 3's first failed with `Could not resolve` for `key-service.ts` and `common/key-service.ts`; with the key service in place but before the hosting-config and session changes, 6 tests failed: the step-up sign order (no role was sent), the two hosting-config tests, the `forwardedToken` assertion, and the two file-level hooks. The 8 dev-OpenBao tests passed on their first run once the modules existed.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 3 - Blocking] `ActiveSession` had no forwarded token, and the hosting settings had no step-up role**
- **Found during:** Task 3.
- **Issue:** The plan's step-up login needs the fresh forwarded JWT and the role name, but 46-02's `session()` exposed only the claims, and `readHostingConfig` had no `STERLING_OPENBAO_STEPUP_ROLE`.
- **Fix:** `ActiveSession.forwardedToken` (backend only, like the session token) and `HostedConfig.stepUpRole` with the plan's default; files outside the plan's list: `session-identity.ts`, `hosting-config.ts` and their two tests.
- **Commit:** `1ee3d837`.

**2. [Rule 2 - Security] The step-up role must differ from the session role**
- **Issue:** Setting both to the same role would let the ordinary session token sign, which is the gap this plan closes.
- **Fix:** `readHostingConfig` refuses `STERLING_OPENBAO_STEPUP_ROLE` equal to `STERLING_OPENBAO_JWT_ROLE`, naming the setting; the test fixture's ordinary policy no longer grants `transit/sign`, and a real test shows OpenBao refusing the session token there.
- **Commit:** `1ee3d837`.

**3. [Rule 1 - Bug] Two strings could share a KV path**
- **Issue:** JavaScript strings with unpaired surrogates have no UTF-8 form of their own; `Buffer.from(s, 'utf8')` maps them all to U+FFFD, so `"\uD800"` and `"\uDFFF"` would encode alike.
- **Fix:** `encodeSegment` refuses such a string with "A secret name must be valid text."; `decodeSegment` also refuses any name that does not re-encode to itself.
- **Commit:** `3855b345`.

**4. `chooseKeyStore` lives in key-stores.ts, not the module**
- The plan put it in key-store-backend-module.ts. It is Theia-free logic, so it sits with the stores and is unit tested there; the module calls it. Two reasons are told apart: a keytar that is not there at all (the image) is "This workbench has no secret store…", one that loads but cannot reach a keyring is "This computer's keyring could not be opened…".

**5. The start-time choice is held in a singleton chooser**
- Inversify 6 cannot resolve a Promise-valued binding with `get()`, so the module binds an object whose `choice()` makes the choice once and caches the promise; the delegating store and the status service both await it.

Other small choices: `deletePassword` reads the metadata first so it can answer `false` for a secret that is not there (KV v2 answers 204 to a delete either way). `sign` refuses a message that is not strict base64 or is over 64 KiB decoded. A Transit 400 or 404 is the missing-key refusal; a 403 is "refused this request"; anything else is "did not answer".

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new-rpc | workbench/extension/src/node/key-service-backend-module.ts | `/services/sterling-key-service` lets the browser ask for a signature and a wrapped data key (in the threat model as T-46-28 and T-46-29); a signature needs the person's fresh step-up and OpenBao's step-up role |
| threat_flag: new-rpc | workbench/extension/src/node/key-store-backend-module.ts | `/services/sterling-secret-store` returns only the store kind and a plain reason |

## Self-Check: PASSED

All 13 created and 6 modified files exist, and the commits `3855b345`, `3ed74fe3` and `1ee3d837` are ancestors of HEAD on the integration branch.
