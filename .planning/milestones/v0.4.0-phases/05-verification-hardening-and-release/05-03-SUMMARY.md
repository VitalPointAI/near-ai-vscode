---
phase: 05-verification-hardening-and-release
plan: 03
subsystem: wallet-entitlements
tags: [near-wallet, staking, entitlements, approvals, redaction, vscode, security]

requires:
  - phase: 05-verification-hardening-and-release
    plan: 01
    provides: Scoped API-key profiles and host-only provider boundary kept separate from wallet state.
  - phase: 05-verification-hardening-and-release
    plan: 02
    provides: Exact approval, bounded audit, attribution, and redaction patterns.
provides:
  - Versioned injected staking contracts with explicit fresh, stale, and unavailable entitlement states.
  - External-wallet-only authorization bridge with state-bound callback handling and no local key API.
  - Exact transaction previews with canonical fingerprints, approval binding, explicit confirmation, and fail-closed writes.
  - Bounded allowlisted wallet audit/history facts and strict chat protocol messages.
affects: [release, wallet-entitlements, staking, security, chat]

actuals:
  tokens: 37459
  tasks: 3
  commits: 0

tech-stack:
  added: []
  patterns: [injected verified configuration, external-wallet-only signing, canonical preview fingerprints, stale-last-known status, allowlisted wallet audit facts]

key-files:
  created:
    - src/domain/staking.ts
    - src/services/stakingService.ts
    - src/services/walletAuthorization.ts
    - src/test/staking.test.ts
    - src/test/walletAuthorization.test.ts
  modified:
    - src/domain/approval.ts
    - src/services/auditStore.ts
    - src/services/chatBridge.ts
    - src/services/chat.ts
    - src/extension.ts
    - src/test/chatBridge.test.ts

key-decisions:
  - "No concrete NEAR AI staking endpoint, network, validator, pool, method, or callback value is shipped; all such values must arrive through a verified injected configuration."
  - "Absent or expired verified configuration makes entitlement status unavailable and disables all stake-changing writes before wallet authorization or approval dispatch."
  - "Wallet state is a separate host-owned boundary and never uses AuthService, ProfileStore, API-key attribution, prompts, model history, or local credential files."
  - "A transaction preview fingerprint covers signer, receiver, operation, serialized arguments, amount, gas, deposit, expected fee, network, validator, configuration digest, and expiry-bound approval."

patterns-established:
  - "Fail-closed integration seam: unavailable defaults provide typed status and user recovery copy without inventing remote values."
  - "Wallet history allowlist: account, network, verified validator, operation, amount, transaction ID, timestamp, status, and bounded outcome only."

requirements-completed: [AUTH-04, COST-05, STAKE-01, STAKE-02, STAKE-03, CHAT-04, TEST-01, SEC-01, SEC-02]

coverage:
  - id: D1
    description: "Missing verified staking configuration produces explicit unavailable status and denies wallet authorization and submission."
    requirement: STAKE-02
    verification:
      - kind: unit
        ref: src/test/staking.test.ts#missing verified configuration is explicit unavailable and cannot authorize or submit a wallet transaction
        status: pass
    human_judgment: false
  - id: D2
    description: "Read-only balances and entitlement data are identity-checked, stale-aware, and never fabricated when unavailable."
    requirement: COST-05
    verification:
      - kind: unit
        ref: src/test/staking.test.ts#verified read-only status rejects wrong identity and preserves stale last-known values without fabricating credit
        status: pass
    human_judgment: false
  - id: D3
    description: "Exact stake previews require fresh approval and explicit fingerprint confirmation before one external wallet call."
    requirement: STAKE-01
    verification:
      - kind: unit
        ref: src/test/staking.test.ts#exact preview requires fresh approval, explicit confirmation, and one immutable wallet call
        status: pass
      - kind: unit
        ref: src/test/walletAuthorization.test.ts#wallet bridge rejects forged preview payloads before the external adapter is called
        status: pass
    human_judgment: false
  - id: D4
    description: "Wallet callback, status, audit/history, protocol, and UI copy reject secrets and project/profile leakage."
    requirement: SEC-01
    verification:
      - kind: unit
        ref: src/test/walletAuthorization.test.ts#external wallet callback is state-bound, expires, and rejects replay without exposing signing material
        status: pass
      - kind: unit
        ref: src/test/chatBridge.test.ts#wallet protocol is strict and unavailable/stale UI copy is explicit without profile or secret material
        status: pass
      - kind: other
        ref: npm run lint && npm test && npm run package
        status: pass
    human_judgment: false

plan_head_before: unavailable
plan_head_after: unavailable
commits: 0
duration: approximately 2h 30m
completed: 2026-10-26
status: complete
---

# Phase 05 Plan 03: Fail-Closed NEAR AI Wallet Entitlement Boundary Summary

**Typed external-wallet entitlement and staking boundaries now fail closed without verified NEAR AI staking configuration, while preserving safe status, preview, approval, history, and redaction contracts.**

## Performance

- **Duration:** Approximately 2 hours 30 minutes across the precondition checkpoint and authorized continuation.
- **Started:** 2026-10-25T23:45:00Z (approximate; the initial executor checkpoint did not capture a runtime start timestamp).
- **Completed:** 2026-10-26T02:18:00Z.
- **Tasks:** 3 completed.
- **Files modified:** 11 plan-listed implementation/test files, plus planning ledger artifacts.

## Accomplishments

- Added versioned `VerifiedStakingConfig`, wallet session, entitlement status, balance/credit, transaction preview, outcome, and bounded history contracts. No concrete NEAR AI endpoint, validator, pool, method, or callback value is present.
- Added `StakingService` with injected read-only RPC, entitlement, wallet, approval, clock, emergency-stop, and audit seams. Missing/expired configuration returns `unavailable`; refresh failures preserve only a last verified snapshot as `stale`; malformed or mismatched remote responses are rejected.
- Added an external-wallet-only authorization bridge with bounded callback state, replay rejection, account/network binding, immutable preview validation, and no filesystem/key/seed operations.
- Added canonical exact transaction fingerprints and approval-bound confirmation. Missing approval, cancellation, changed fingerprint/configuration, stale session/preview, emergency stop, and mismatched outcomes prevent wallet submission; no silent retry occurs.
- Added strict wallet chat messages, host status/error/history DTOs, safe unavailable panel/status copy, wallet audit allowlisting, and negative tests for local credential-file access, secrets, profiles, prompts, context, forged balances, wrong scope, and silent submission.

## Task Commits

Git commits were unavailable. The mounted workspace contains a non-usable `.git` path and Git reports that it is not a repository. No repository was initialized and no hashes were fabricated.

1. **Task 1: Trace one verified wallet account into read-only NEAR AI entitlement status** — no commit (repository unavailable).
2. **Task 2: Build and submit exact staking transactions only through fresh external-wallet confirmation** — no commit (repository unavailable).
3. **Task 3: Expose safe entitlement controls and non-sensitive stake/credit history** — no commit (repository unavailable).

**Plan metadata:** no commit (repository unavailable).

## Files Created/Modified

- `src/domain/staking.ts` — verified injected configuration, status freshness, preview, outcome, history, and safe DTO contracts.
- `src/services/stakingService.ts` — read-only refresh, identity validation, stale/unavailable recovery, exact preview construction, approval-bound confirmation, transaction status validation, and bounded history.
- `src/services/walletAuthorization.ts` — external-wallet-only authorization/signing seam and replay-safe callback state.
- `src/domain/approval.ts` / `src/services/auditStore.ts` — wallet audit event type and allowlisted wallet facts.
- `src/services/chatBridge.ts` / `src/services/chat.ts` / `src/extension.ts` — strict wallet protocol, host dispatch, safe status/error copy, and fail-closed status presentation.
- `src/test/staking.test.ts`, `src/test/walletAuthorization.test.ts`, `src/test/chatBridge.test.ts` — positive and negative wallet/status/redaction coverage.

## Verification and Security Evidence

- Focused staking, wallet authorization, and chat-bridge tests passed.
- `npm run lint` passed.
- `npm test` passed: 29 test files, 29 passed, 0 failed, 0 skipped/todo.
- `npm run package` passed and produced the VSIX.
- Tests prove missing verified configuration makes status unavailable, prevents wallet authorization and submission, and never fabricates balances or credit.
- Tests prove wrong account/network/validator and forged transaction status are rejected; stale last-known values are marked stale and writes are disabled.
- Tests prove exact preview confirmation and fresh approval are both required, with one wallet call only after all bindings pass.
- Source-level negative checks prove wallet services have no filesystem imports or local credential-file operations. The implementation never reads, writes, imports, archives, overwrites, or deletes `~/.near-credentials`.
- Wallet DTOs/history/audit facts are allowlisted and negative tests reject API keys, refresh tokens, bearer values, seeds, private keys, project/profile identifiers, prompts, context, and signed payload-shaped data.

## Deviations from Plan

### User-Authorized Fail-Closed Variant

**1. Official staking precondition remained unavailable**
- **Found during:** Precondition check before Task 1.
- **Issue:** The research and repository contained no verifiable official NEAR AI staking network/RPC, validator/pool, method, entitlement endpoint, or wallet callback/status contract.
- **Decision:** Continue only with typed injected interfaces and an unavailable default. No concrete remote values or callback registration were invented. All stake-changing writes remain disabled until a verified configuration is supplied by a future integration.
- **Files modified:** `src/domain/staking.ts`, `src/services/stakingService.ts`, `src/services/walletAuthorization.ts`, `src/services/chat.ts`, `src/extension.ts`, and related tests.
- **Verification:** Unavailable-state, no-wallet-call, redaction, and safe UI-message tests pass.
- **Commit:** no commit; repository unavailable.

### Auto-Fixed Security Hardening

**2. [Rule 2 - Information disclosure/tamper resilience] Bound exact preview and bridge payloads**
- **Found during:** Task 2 security review.
- **Issue:** A preview fingerprint must bind every transaction-routing field, and a direct bridge caller must not be able to pass a credential-shaped or structurally forged preview.
- **Fix:** Included signer, receiver, operation, amount, network, validator, configuration digest, method, arguments, gas, deposit, and expected fee in canonical hashing; added runtime preview validation and sensitive-argument rejection before adapter invocation.
- **Files modified:** `src/services/stakingService.ts`, `src/services/walletAuthorization.ts`, `src/test/staking.test.ts`, `src/test/walletAuthorization.test.ts`.
- **Verification:** Exact preview and forged bridge payload tests pass.
- **Commit:** no commit; repository unavailable.

**Total deviations:** 1 user-authorized scope deviation and 1 security hardening fix.
**Impact on plan:** The implementation intentionally does not enable production staking writes without the missing official configuration. The typed boundary, read-only fail-closed behavior, safety checks, and negative evidence are complete.

## Known Stubs

- `src/services/chat.ts:300` — wallet entitlement panel is intentionally unavailable until the official NEAR AI staking configuration and callback contract are verified; this is the requested fail-closed behavior, not fabricated integration.
- `src/services/chat.ts:300` — interactive VS Code wallet callback smoke verification is unrun because no official callback contract is available. This is recorded in `.planning/WINDOWS.md` as an open `unrun-verify` item.

## Threat Surface Review

The new external-wallet and remote-read surfaces are injected only through host interfaces. No concrete endpoint, validator, pool, method, callback, dependency, filesystem credential reader, signing-material API, or project/API-key coupling was introduced. Remote identity, numeric values, freshness, preview scope, callback state, approval, and history fields are bounded and checked before presentation or submission.

## Next Phase Readiness

The release can safely ship the typed wallet/status boundary with staking writes disabled. A future integration must provide independently verified official network, RPC, validator/pool, method, entitlement, and callback/status details through `VerifiedStakingConfig` and the injected wallet/read seams before enabling writes. No local NEAR credential setup is required.

## Self-Check: PASSED

- All 11 plan-listed implementation/test files exist.
- `npm run lint`, focused tests, `npm test`, and `npm run package` passed.
- Summary has `status: complete` and records `commits: 0` with unavailable Git heads honestly.
- No repository or commit metadata was fabricated.
- The fail-closed integration stub and unavailable callback verification are documented in this summary and `.planning/WINDOWS.md`.

---
*Phase: 05-verification-hardening-and-release*
*Plan: 05-03*
*Completed: 2026-10-26*
