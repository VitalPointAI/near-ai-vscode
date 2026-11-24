---
phase: 46-native-theia-foundation
plan: 08
subsystem: testing
tags: [theia, playwright, openbao, tls, secretstorage, step-up, e2e, phase-47-contract]
status: complete

requires:
  - phase: 46-02
    provides: "session identity, the dev OpenBao helper, the test signer and certificate helpers"
  - phase: 46-03
    provides: "the outbound recording hook and the egress suite"
  - phase: 46-07
    provides: "the rebound key store, the secret store status, the key service and the step-up role"
provides:
  - "workbench/test/container/hosted-e2e.test.ts: hosted mode in a real browser against the built image and a real OpenBao over TLS"
  - "workbench/test/e2e/session.spec.ts and secrets.spec.ts (SPEC_STEP; WORKBENCH_TOKEN, WORKBENCH_EMAIL, WORKBENCH_USER, PROBE_VALUE, WORKBENCH_STEPUP_ACR)"
  - "workbench/test/fixtures/secret-probe: commands secretProbe.save and secretProbe.read through context.secrets (test only)"
  - "startDevOpenBao({ network, tls }) with tlsNetworkAddr and caFile; makeTestCertificate({ dnsNames })"
  - "workbench/README.md: Settings, Interface with Phase 47 (with What Phase 47 closes), Browser harness and air-gapped runs"
affects: [47, 48, 32.1, 33]

actuals:
  tokens: 10600       # chars/4 over the added non-planning lines of the plan diff (42,284 chars), SUMMARY excluded
  tasks: 2
  commits: 4          # measured: git rev-list --count plan_head_before..HEAD at SUMMARY time (one is the 46-07 fixture alignment); the SUMMARY commit follows
plan_head_before: 2c3c7dd969540b4a8acc0a2922d9275a820d2870
plan_head_after: 3774a298a80ec3d77ba2b9864064db94456c71b5

tech-stack:
  added: []
  patterns:
    - "The harness plays oauth2-proxy: forwarded headers with a JWT signed by a test key OpenBao trusts; no Keycloak, no proxy"
    - "A dev OpenBao with an extra TLS listener (-config) signed by a throwaway CA, reached by network alias the way a site reaches OpenBao"

key-files:
  created:
    - workbench/test/container/hosted-e2e.test.ts
    - workbench/test/e2e/session.spec.ts
    - workbench/test/e2e/secrets.spec.ts
    - workbench/test/fixtures/secret-probe/package.json
    - workbench/test/fixtures/secret-probe/extension.js
  modified:
    - workbench/test/helpers/openbao-dev.ts
    - workbench/test/helpers/tls-cert.ts
    - workbench/README.md
    - workbench/extension/src/node/openbao-client.ts
    - workbench/test/openbao-client.test.ts
    - workbench/test/key-service.test.ts

key-decisions:
  - "The test OpenBao is reached over TLS by network alias with STERLING_OPENBAO_CA_FILE, not through a shared loopback; the production address rule is unchanged"
  - "Restart persistence is a removed container and a new one, never docker restart"
  - "workbench/README.md is the one place Phase 47 reads the names; they match Phase 47's deploy/openbao (roles, policies, audience sterling-sessions)"

requirements-completed: [FND-T-03, FND-T-05, FND-T-06, FND-T-07]

duration: about 45 min, plus waits on the shared heavy lock
completed: 2026-11-24
---

# Phase 46 Plan 08: End-to-end browser proof and the Phase 47 contract Summary

**In Chromium against the built image and a real OpenBao reached over TLS, a VS Code extension's secret is saved to the person's own KV path and read back by a new container; the right person's session is active with no status entry and the step-up command opens the same-origin sign-in link; someone else's headers show "Sign-in check failed" with the reason until the right person chooses Retry; local mode says "Secrets are unavailable"; and no connection outside loopback and OpenBao, no token and no secret appears. `workbench/README.md` now holds every name Phase 47 configures, matched to Phase 47's `deploy/openbao`.**

## Owner approval needed in the PR

None in this plan. The integration PR carries 46-04's and 46-06's gate files.

## End-to-end evidence (hosted-e2e.test.ts, 5 tests, all passing)

| Test | What the browser and OpenBao showed |
|------|-------------------------------------|
| Same person | After the forwarded headers for `person.a@example.test`, the backend logged `Sterling session identity: active`; 11 s after the page loaded there was no `status-bar-sterling-session-identity` and no `status-bar-sterling-secret-store` entry. "Sterling: Confirm with your passkey or security key" navigated to `/oauth2/start` on the page's own origin with `acr_values=<STERLING_STEPUP_ACR>`, `max_age=0` and an `rd` starting with `/`. |
| Restart | "Secret probe: Save" showed "Saved". Root listed exactly one folder under `kv/metadata/users/`, then exactly `u<b64url("127.0.0.1-sterling-test.secret-probe")>/` below it and `u<b64url("probe")>` below that; the stored value is Theia's `{"extensionId":"sterling-test.secret-probe","content":<the probe value>}`. The container was removed and a new one started with the same settings; "Secret probe: Read" showed the value. |
| Other person, then Retry | Person B's headers to A's session: the backend logged `failed (person-mismatch)`, the entry read "Sign-in check failed" and the notification gave "This session was started for someone else. Sign in as that person, then choose Retry." A new browser with A's headers chose "Retry the sign-in check" and the entry went away; the backend logged `active`. |
| Local mode | No OpenBao settings: the entry read "Secrets are unavailable", "Secret probe: Save" showed "Not saved: …", the backend logged `Sterling secret store: unavailable` and never Theia's in-memory provider. |
| Nothing leaks | Across the five workbench containers the hook logged no `refused` line, every hosted one reached the OpenBao host, and no `docker logs` held a test JWT, the root token, the probe value or anything matching `\b(?:s|hvs)\.[A-Za-z0-9]{20,}`. |

This also covers the hosted-mode browser view wave 2 could not test: the status entry, the failure notification, Retry and the step-up link.

**Release image backstop:** partly proven, one item open. With the VSIX that `npm run verify:release` built from this branch, the `release` target was built from a clean export of this commit and 46-03's egress suite was run against it (`WORKBENCH_TEST_IMAGE`). The control, the planted call, and start, page load and restart on an `--internal` network with only loopback attempts all passed (3 of 4). The browser smoke did not finish: with the bundled extension the page never reaches Playwright's `networkidle`, so that spec timed out before its same-origin and hook-log checks. That is a wait condition in 46-03's spec meeting a busy bundled extension, not an outbound call seen, but the page-side check for the release image is still unproven. It belongs with the release image (an egress run in the Release workflow, or a spec wait that does not need network idle), which this plan did not change. The test images were removed afterwards.

## Planning choices (as reported)

1. **Changed on the coordinator's direction: TLS instead of a shared loopback.** The plan had the workbench join OpenBao's network namespace (`--network container:<bao>`) to reach `http://127.0.0.1:8200`. The coordinator asked for TLS if it keeps production rules unchanged, and it does: `startDevOpenBao({ network, tls: true })` adds a second listener on 8443 (`-config` with a listener file) whose certificate a throwaway CA signs for the network alias, and the workbench uses `https://openbao-<n>:8443` with `STERLING_OPENBAO_CA_FILE`, exactly as a site does. The hook's allow list is loopback plus that one host. So the acceptance grep for `network container:` is 0 by design, and `startDevOpenBao` has a `tls` option instead of `publish`. Reversible.
2. "Survives a restart" is a removed container and a new one. Reversible.
3. The README is the one place Phase 47 reads. Costly: the names are final.

## Alignment with Phase 47's lab run (coordinator message, `origin/feat/phase-47-wave-4`, `deploy/`)

| Item | 46 plan text / 46-07 as first built | Phase 47 `deploy/` | Now |
|------|------|------|------|
| Signing policy | one `sterling-workbench-stepup` policy holding sign, lookup-self and revoke-self | `sterling-workbench-sign`, only `transit/sign/person-{{identity.entity.id}}` | fixture and README match 47 (commit `a83c830a`) |
| Step-up role policies | the step-up policy alone | `sterling-workbench` and `sterling-workbench-sign` | match |
| Step-up token life | `token_ttl` and `token_max_ttl` 5 min | plus `token_explicit_max_ttl` = window, `token_period` 0, `token_no_default_policy` | match |
| Audience | "the workbench audience" | `sterling-sessions` | README names it |
| `STERLING_OPENBAO_STEPUP_ROLE` | 46-07 setting, default `sterling-workbench-stepup` | not in `sterling-site-env` (ten names) | no mismatch: the default is 47's role name. If 47 ever renames the role, its ConfigMap must add this setting |
| Re-login before each signature | already so in 46-07 | the step-up token stops working when the window ends | the key service test now asserts a second signature logs in again |
| Transit key names | `person-<id>` ed25519, `kek-<id>` aes256-gcm96 | the same (`enrol.mjs`) | no mismatch |
| Audit devices in server config; `X-Vault-Wrap-TTL` on key moves | not used by the workbench | 47's own concern | no workbench change |

## Tasks

| Task | Commit | Content |
|------|--------|---------|
| 1 | `f3eb5339` | hosted-e2e.test.ts, session.spec.ts, secrets.spec.ts, the secret-probe fixture, the TLS option of `startDevOpenBao`, `dnsNames` in `makeTestCertificate` |
| 1 (fix found) | `7871b54f` | openbao-client: a request that throws before it is sent settles once as unreachable; regression test |
| 1 (alignment) | `a83c830a` | 46-07's dev OpenBao fixture matched to Phase 47's roles and policies; re-login per signature asserted |
| 2 | `3774a298` | workbench/README.md: Settings, Interface with Phase 47, What Phase 47 closes, Browser harness and air-gapped runs |

## Verification (tests run, separate from tests added)

- Added: 6 tests. That is 5 in `container/hosted-e2e.test.ts` (driving 6 Playwright runs of the two new specs) and 1 regression test in `openbao-client.test.ts`. Extended: one assertion block in `key-service.test.ts`.
- `npm --prefix workbench run lint`: clean.
- `npm --prefix workbench test`: 82 run, 82 passed.
- `npm --prefix workbench run test:container` with a freshly built image of this tree (`WORKBENCH_TEST_IMAGE`, built once and reused): 35 run, 35 passed (egress 4, hosted-e2e 5, image 9, openbao-identity 5, openbao-keys 8, smoke 4).
- The README check from the plan: `README names 13`, nothing missing. Acceptance greps: `^## Interface with Phase 47$` 1, `loginURLParameters` 1, `THEIA_HOSTS` 1, `revoke-self` 3, em-dashes 0; `context.secrets` in the fixture 3; `extraHTTPHeaders` in session.spec.ts 1; `network container:` 0 (choice 1).
- No container, network or test image was left behind by the suites.

TDD: the end-to-end tests describe a system 46-07 had already built, so they could not fail on a base without it; their first runs failed for real reasons instead. The first run found the openbao-client bug below and that the hook's allow list needs the bare host name (a DNS lookup has no port). The second run found that Theia's workspace trust dialog makes the page inert until answered, which the session spec now answers. The client regression test failed first on the unfixed client (`expected an OpenBaoError, got TypeError [ERR_INVALID_CHAR]`) and passes on the fix.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 1 - Bug] A request that failed before it was sent crashed later in the backend**
- **Found during:** Task 1 (first hosted run).
- **Issue:** In `createOpenBaoClient` (46-02), when `transport.request()` threw synchronously, the promise rejected with the raw error and the abort listener stayed registered; at the timeout it called `request.destroy()` on a variable still in its temporal dead zone, logging `Uncaught Exception: ReferenceError: Cannot access 'E' before initialization` in the running backend. A header value Node refuses does the same in production.
- **Fix:** the request is created inside `try`; a synchronous failure settles the call as `unreachable` with the error's code only (no token can appear), and the timer listener is removed.
- **Files:** `workbench/extension/src/node/openbao-client.ts`, `workbench/test/openbao-client.test.ts`. **Commit:** `7871b54f`.

**2. [Coordinator direction] 46-07's step-up fixture matched to Phase 47's `deploy/openbao`** (table above). **Commit:** `a83c830a`.

**3. The README corrects an old claim**: the local compatibility container no longer "has an in-memory credential store"; it says "Secrets are unavailable" and saves fail visibly.

## Known Stubs

None.

## Threat Flags

None. The fixture extension and the TLS test CA are test-only and never enter the image.

## Self-Check: PASSED

All 5 created and 6 modified files exist, and the commits `7871b54f`, `a83c830a`, `f3eb5339` and `3774a298` are ancestors of HEAD on the integration branch.
