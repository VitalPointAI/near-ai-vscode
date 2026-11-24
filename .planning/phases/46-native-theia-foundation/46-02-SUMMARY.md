---
phase: 46-native-theia-foundation
plan: 02
subsystem: auth
tags: [theia, openbao, jwt, session-identity, step-up, oauth2-proxy, state-machine]
status: complete

requires:
  - phase: 46-01
    provides: "workbench/ package, bindBackendService/bindFrontendService, test/helpers/docker.ts, the openbao-test FROM line"
provides:
  - "readHostingConfig(env) and parseServiceAddress(value, setting) (hosting-config.ts)"
  - "createOpenBaoClient({ addr, caFile?, timeoutMs }) and OpenBaoError (openbao-client.ts)"
  - "SessionIdentity symbol and createSessionIdentity({ config, client, clock?, log? }); IDENTITY_TIMEOUT_MS = 60000; session() for backend consumers"
  - "/services/sterling-session-identity (status, retry); commands sterling.session.retry and sterling.session.confirmWithSecurityKey"
  - "test helpers startFakeOpenBao, captureOutput, closedPort, makeTestSigner, makeTestCertificate, startDevOpenBao (with createPersonKeys)"
affects: [46-03, 46-07, 46-08, 47]

actuals:
  tokens: 23900       # chars/4 over the added lines of the plan's diff (95,521 chars), SUMMARY excluded
  tasks: 3
  commits: 3          # measured: git rev-list --count plan_head_before..HEAD at SUMMARY time; the SUMMARY commit follows
plan_head_before: ae6f3c45ea9895c46474a74a4b733e7d61f14be0
plan_head_after: 66755b9431339dd4e540db925da0f0b55f832e10

tech-stack:
  added: []
  patterns:
    - "Theia-free core modules (hosting-config, openbao-client, session-identity) with injected clock and timers; thin inversify wrappers"
    - "One OpenBao client for every call: node:http(s), CA file read once, AbortSignal timeout, 1 MiB cap, X-Vault-Token only, redacted error paths"
    - "Every test file that handles a token captures the whole console and asserts no token string reached it"

key-files:
  created:
    - workbench/extension/src/node/hosting-config.ts
    - workbench/extension/src/node/openbao-client.ts
    - workbench/extension/src/node/session-identity.ts
    - workbench/extension/src/common/session-identity.ts
    - workbench/extension/src/node/session-identity-backend-module.ts
    - workbench/extension/src/browser/session-identity-frontend-module.ts
    - workbench/test/openbao-client.test.ts
    - workbench/test/session-identity.test.ts
    - workbench/test/helpers/fake-openbao.ts
    - workbench/test/helpers/test-jwt.ts
    - workbench/test/helpers/tls-cert.ts
    - workbench/test/helpers/openbao-dev.ts
    - workbench/test/container/openbao-identity.test.ts
  modified:
    - workbench/extension/package.json

key-decisions:
  - "IDENTITY_TIMEOUT_MS is a 60 s constant; a token-missing failure returns to identity by itself when a token arrives, every other failure leaves only by Retry"
  - "STERLING_OPENBAO_ADDR accepts http: only for 127.0.0.1, [::1] or localhost; everything else must be https:, with no credentials, query, fragment or path"
  - "An invalid hosted setting stops the backend at start with one line naming the setting (exit 1); it is never a failed state"
  - "The person check compares emails only (THEIACLOUD_SESSION_USER, X-Auth-Request-Email, the token's email claim when present), case-insensitively; the signature is left to OpenBao's jwt login"
  - "A token without an X-Auth-Request-Email header is ignored (logged as email-missing), so it can never pair with an unchecked person"
  - "A refused re-login entity id that differs from the session's entity is failed store-refused"

requirements-completed: [FND-T-05]

duration: about 22 min (including waits on the shared heavy lock)
completed: 2026-11-24
---

# Phase 46 Plan 02: Session identity Summary

**The workbench backend now knows who signed in: it reads the forwarded sign-in token on every HTTP request and WebSocket upgrade, checks that it names the person the session was started for, logs in to OpenBao with jwt auth, renews the token at half its lease, revokes it on stop, and shows "Sign-in check failed" with a plain reason and Retry. No token reaches the browser, a log line or an error text. A real dev-mode OpenBao from the pinned image proves the login, the renewal and the revoke.**

## Owner approval needed in the PR

None. This plan changes no gate file and adds no package, image or tool (node:https, node:crypto and openssl only; the dev OpenBao is the `openbao-test` stage 46-01 registered).

## Contract names as built (46-07 and Phase 47 read these)

| Name | Shape |
|------|-------|
| `readHostingConfig(env)` | `{ mode: 'local' }` or `{ mode: 'hosted', addr, caFile?, jwtMount ('jwt'), jwtRole ('sterling-workbench'), kvMount ('kv'), transitMount ('transit'), stepUpAcr?, stepUpMaxAgeSeconds (300), sessionUser }`; throws one sentence beginning with the setting's name |
| `parseServiceAddress(value, setting)` | the shared address rule (https, or http to a loopback address; no credentials, query or fragment); 46-03 reuses it |
| `createOpenBaoClient({ addr, caFile?, timeoutMs })` | `request(method, path, { token?, body? })` resolves `{ status, json }` for 2xx and 404; `OpenBaoError` with `kind` `unreachable`, `refused` (400, 401, 403) or `bad-response`, and `status` |
| `SessionIdentity` (symbol and interface) | `observe(headers, now?)`, `start()`, `retry()`, `stop()`, `status()`, `session()`; `session()` is `{ token, entityId, acr?, authTime?, client, config }` only while `active` |
| `createSessionIdentity({ config, client, clock?, log? })` | the factory; `IDENTITY_TIMEOUT_MS = 60000`, `REVOKE_BUDGET_MS = 3000` |
| Common | `SESSION_IDENTITY_PATH = '/services/sterling-session-identity'`, `SessionIdentityService` (`status()`, `retry()`), `SessionIdentityStatus`, `FailureReason` (`token-missing`, `person-mismatch`, `store-unreachable`, `store-refused`), `SESSION_IDENTITY_TEXT`, `stepUpUrl(currentPathAndQuery, acr)` |
| Commands | `sterling.session.retry` ("Sterling: Retry the sign-in check", shown only in `failed`), `sterling.session.confirmWithSecurityKey` ("Sterling: Confirm with your passkey or security key", shown only when the status carries `stepUp`) |
| Status bar | entry `sterling-session-identity`: "Checking your sign-in" in `identity`, "Sign-in check failed" in `failed` (tooltip: the reason, click: Retry); none in `active` or local mode |
| Test helpers | `startFakeOpenBao(routes, { tls? })`, `captureOutput()`, `closedPort()`, `makeTestSigner()`, `makeTestCertificate()`, `startDevOpenBao({ tokenTtl?, tokenMaxTtl?, network? })` with `addr`, `networkAddr`, `rootToken`, `signer`, `api()`, `createPersonKeys(entityId)`, `stop()` |

Log lines are `Sterling session identity: <state>` or `<state> (<reason>)`, and `ignored a sign-in token (<code>)` with the codes `token-unreadable`, `token-expired`, `email-missing` and `person-mismatch`. They never carry a token, an email or an entity id.

## Planning choices (as reported)

1. `IDENTITY_TIMEOUT_MS` = 60 s, a constant. A `failed` state whose reason is `token-missing` goes back to `identity` by itself when a valid token arrives. Every other `failed` state leaves only through Retry, which runs the same code path as start. Reversible.
2. `STERLING_OPENBAO_ADDR` accepts `http:` only to `127.0.0.1`, `[::1]` or `localhost`. Everything else must be `https:`, with no user name, password, query, fragment or path. Recorded for the Phase 47 contract in 46-08. Costly.
3. An invalid hosted setting (address, CA file, mount, role, step-up window, missing `THEIACLOUD_SESSION_USER`) stops the backend at start with `The Sterling workbench cannot start: <sentence naming the setting>` and exit 1. Reversible.
4. The person check compares emails only. `X-Auth-Request-User` is read but not compared. The token's signature is checked by OpenBao's jwt login, never locally. Reversible.

## Measured renew timing

With the dev OpenBao role's `token_ttl` at 10 s, `renew-self` ran at **5.0 s, 10.0 s and 15.0 s** after login, which is half of each 10 s lease. At 15.5 s `lookup-self` with the same session token still answered 200. Without the renewals the token would have expired at 10 s.

## Tasks

| Task | Commit | Content |
|------|--------|---------|
| 1 | `cb2ec900` | hosting-config.ts, openbao-client.ts, fake OpenBao, test CA and output capture helpers; 13 tests |
| 2 | `8545a3fc` | session-identity.ts (state machine), common/session-identity.ts, test-jwt.ts; 19 tests |
| 3 | `66755b94` | backend and frontend modules, theiaExtensions entry, openbao-dev.ts, container suite; 5 tests |

## Verification (tests run, separate from tests added)

- Added: 37 tests. That is 13 in `openbao-client.test.ts`, 19 in `session-identity.test.ts` and 5 in `container/openbao-identity.test.ts`.
- `npm --prefix workbench run lint`: clean, with both the extension and the tests type-checked.
- `npm --prefix workbench test`: 44 run, 44 passed. 12 of them come from 46-01.
- `npm --prefix workbench run test:container`: 9 run, 9 passed. The 5 new OpenBao identity tests use the pinned `openbao-test` image. The 4 smoke tests from 46-01 also pass, now with the new modules in the image: local mode, Get Started, and the Team preview in Chromium (2 Playwright tests passed).
- Acceptance greps: `X-Vault-Token` 2. No `@theia/` import in openbao-client.ts or hosting-config.ts. No `console.` in openbao-client.ts. `revoke-self` 2. `export function stepUpUrl` 1. The confirm text 1. Em-dashes 0. `onDidWebSocketUpgrade` 1. `EarlyExpressMiddleware` 2. `session-identity-backend-module` 1. `password` in the frontend module 0.
- No container, network or image was left behind. `docker ps -a` and `docker images` show no `sterling-workbench-test-*` objects after the suite.

TDD RED: each task's tests came before its modules. Task 1's first run failed at the test build with `Could not resolve "../extension/src/node/hosting-config.ts"` and `openbao-client.ts`. That run also caught a test-side bug: `assert.throws` with `/^SETTING /` matched against `Error: ...`, so the tests now check `error.message`. For Tasks 2 and 3 the tests import `session-identity.ts` and `openbao-dev.ts`. Those files did not exist at the previous commit, so the tests failed at the build in the same way. The Task 2 red run was queued on the shared heavy lock and ran only after the module had been written, so that one red run was not observed separately.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 2 - Correctness] An entity id or person change on re-login is refused**
- **Found during:** Task 2.
- **Issue:** The plan's re-login after a refused renewal did not say what happens if OpenBao returns another entity. A changed entity id would silently move the person's secret prefix.
- **Fix:** The re-login compares the new entity id with the session's own. A different one is `failed store-refused`, and the new token is revoked.
- **Commit:** `8545a3fc`.

**2. [Rule 2 - Correctness] A token without the email header is ignored**
- **Found during:** Task 2.
- **Issue:** The person check needs the email header. Without the header, the plan does not say whether the token counts.
- **Fix:** Such a token is ignored and logged as `email-missing`, so the identity timer ends in `token-missing`. It is never used for a login.
- **Commit:** `8545a3fc`.

**3. [Rule 2 - Correctness] Entity ids are also hidden in error paths**
- **Fix:** Besides replacing `users/<id>` with `users/…` as the plan asked, any UUID in a path (for example `transit/sign/person-<id>`) becomes `…`, so no entity id reaches an error text.
- **Commit:** `cb2ec900`.

**4. A renewal that cannot reach OpenBao is retried**
- **Fix:** A renewal answered `unreachable` or `bad-response` is tried again at half the time left on the lease. With less than 2 s left the state is `failed` with `store-unreachable`. Only a refused renewal re-logs in, as the plan says.
- **Commit:** `8545a3fc`.

**5. Dev OpenBao on a network**
- **Fix:** `startDevOpenBao({ network })` always publishes a 127.0.0.1 port for setup and checks, and then runs `docker network connect --alias openbao-<n>` for the given network. This works for an `--internal` network, where a published port alone would not, and gives `networkAddr` for a workbench on that network.
- **Note for 46-03 and 46-08:** a workbench reaching `http://openbao-<n>:8200` is not loopback, so `readHostingConfig` refuses it under planning choice 2. Those plans need either TLS with `makeTestCertificate()` (the dev listener would then need a TLS config) or a loopback route.
- **Commit:** `66755b94`.

Other small choices:
- `SESSION_IDENTITY_TEXT` gained `retryCommand: 'Retry the sign-in check'`, the palette label for `sterling.session.retry`. It follows the D-43 writing rules.
- `SKIP_SETCAP=true` and `BAO_DEV_LISTEN_ADDRESS=0.0.0.0:8200` are set on the dev container.

## Known Stubs

None.

## Gaps for later plans

- The hosted-mode browser view (the status bar entry, the Retry notification and the step-up command) is type-checked and loads in the image in local mode, where it shows nothing. No browser test drives it in hosted mode yet, because that needs a workbench container with OpenBao and forwarded headers. 46-08, or the Phase 47 end-to-end run in 46-VALIDATION's manual list, is the place for it.
- The root copy lint over the new browser strings runs after 46-05 merges, as the plan's verification says.

## Threat Flags

None beyond the plan's threat model. The one new RPC path, `/services/sterling-session-identity`, returns only the state, the reason code and the step-up acr.

## Self-Check: PASSED

All 13 created files and the modified `extension/package.json` exist. The commits `cb2ec900`, `8545a3fc` and `66755b94` are ancestors of HEAD on `feat/phase-46-02-03`.
