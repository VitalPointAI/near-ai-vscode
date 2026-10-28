---
phase: 05-verification-hardening-and-release
verified: 2026-10-26T02:59:10Z
status: human_needed
score: 19/19 must-haves verified
covered_files:
  - ".planning/phases/05-verification-hardening-and-release/05-01-PLAN.md"
  - ".planning/phases/05-verification-hardening-and-release/05-01-SUMMARY.md"
  - ".planning/phases/05-verification-hardening-and-release/05-02-PLAN.md"
  - ".planning/phases/05-verification-hardening-and-release/05-02-SUMMARY.md"
  - ".planning/phases/05-verification-hardening-and-release/05-03-PLAN.md"
  - ".planning/phases/05-verification-hardening-and-release/05-03-SUMMARY.md"
  - ".planning/phases/05-verification-hardening-and-release/05-04-PLAN.md"
  - ".planning/phases/05-verification-hardening-and-release/05-04-SUMMARY.md"
  - ".planning/phases/05-verification-hardening-and-release/05-05-PLAN.md"
  - ".planning/phases/05-verification-hardening-and-release/05-05-SUMMARY.md"
  - ".vscodeignore"
  - "README.md"
  - "SECURITY.md"
  - "docs/marketplace/near-ai-overview.gif"
  - "docs/marketplace/near-ai-setup.gif"
  - "near-ai-vscode-0.1.0.vsix"
  - "package.json"
  - "scripts/verify-release-content.mjs"
  - "src/services/activityStore.ts"
  - "src/test/activityStore.test.ts"
covered_digest: "v3:sha256:f209741b3c9208d29b40c44148b5fb49cafb44d2f20c0f9e1d29ca6162c9af9a"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 17/19
  gaps_closed:
    - "Historical request/session/agent/cost/token attribution is immutable across profile switches and reloads."
    - "Release verification evidence, trust/security reporting, Marketplace documentation, and a release-scoped VSIX are complete."
  gaps_remaining: []
  regressions: []
decision_coverage:
  honored: 0
  total: 0
  not_honored: []
  skipped: true
  reason: "CONTEXT.md missing"
---

# Phase 5: Verification, Hardening, Account Entitlements, and Release Verification Report

**Phase Goal:** Exercise end-to-end flows, close the scoped NEAR AI credential/profile and organization/project attribution boundary, and add an explicitly authorized NEAR wallet/entitlement flow for verified staking, credit-balance, and stake-status visibility. Run continuous security/privacy gates, perform credential and backdoor-oriented review, verify failure recovery and accessibility, complete packaging and Marketplace documentation, publish the trust/security report, and produce a release candidate VSIX. Staking remains separate from API-key profiles and never accesses local NEAR credential files.

**Verified:** 2026-10-26T02:59:10Z  
**Status:** human_needed  
**Re-verification:** Yes — after closure of the two previously failing gaps

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | Dispatch requires an explicitly selected, provider-validated organization/company profile. | ✓ VERIFIED | Existing auth/profile/provider implementation and the full 29-file test suite remain green. |
| 2 | Credentials use versioned project/profile SecretStorage keys and cannot be implicitly read across scopes. | ✓ VERIFIED | Scoped auth implementation remains present and lint/full tests pass. |
| 3 | Profile changes are explicit and invalidate stale validation before use. | ✓ VERIFIED | Profile-store implementation remains present and lint/full tests pass. |
| 4 | Legacy API-key migration is explicit and is not a dispatch fallback. | ✓ VERIFIED | Existing migration/dispatch boundary remains present; full tests pass. |
| 5 | Webview/status surfaces expose bounded profile metadata, never credentials. | ✓ VERIFIED | Host/webview allowlists remain present; full tests pass. |
| 6 | Historical request/session/agent/cost/token attribution is immutable across profile switches and reloads. | ✓ VERIFIED | `normalizeSession` computes the session attribution snapshot and passes it to `normalizeEvent`; `normalizeEvent` clones that snapshot at `src/services/activityStore.ts:133,137-138`. The tampering regression writes valid B attribution into a session owned by A, reloads a fresh store, appends, reconciles, and asserts every event remains A. |
| 7 | Estimated and actual usage remain distinct and unavailable values are not fabricated. | ✓ VERIFIED | Activity reconciliation and analytics implementation remain present; full tests pass. |
| 8 | Live and durable analytics filter by organization/project with request, token, model, latency, budget, approval, and outcome facts. | ✓ VERIFIED | Host analytics/filter wiring remains present; full tests pass. |
| 9 | Analytics/exports are recomputed in the host and webview messages cannot inject attribution or cost values. | ✓ VERIFIED | Host-side analytics/export boundaries remain present; full tests pass. |
| 10 | Legacy records remain explicitly unknown/legacy rather than being assigned to current scope. | ✓ VERIFIED | The legacy regression asserts `legacy-unknown` session and event ownership despite conflicting current-looking persisted event attribution. |
| 11 | Secrets, raw prompt/context, and unrestricted paths are absent from activity, audit, analytics, UI, and exports. | ✓ VERIFIED | Existing redaction/negative coverage remains present; full tests pass. |
| 12 | External wallet authorization never reads, imports, overwrites, archives, or deletes `~/.near-credentials`. | ✓ VERIFIED | External-wallet-only boundary and negative scans/tests remain present. |
| 13 | Read-only entitlement status distinguishes verified network/validator/balances/freshness from stale or unavailable. | ✓ VERIFIED (fail-closed limitation) | Injected verified-config coverage remains present. Production defaults to unavailable without independently verified official configuration; writes remain disabled. |
| 14 | Stake-changing requests use verified configuration and show exact signer/receiver/method/arguments/amount/gas/deposit/fee/freshness before confirmation. | ✓ VERIFIED (fail-closed limitation) | Exact injected-config preview/approval implementation and tests remain present; missing/stale production configuration cannot enable writes. |
| 15 | Wallet invocation requires fresh exact-scope approval and confirmation; cancel/change/mismatch prevents submission. | ✓ VERIFIED | Approval fingerprint, expiry, callback validation, and one-call submission coverage remain present; full tests pass. |
| 16 | Stake/unstake/credit/balance history is bounded, non-sensitive, and separate from API-key/model context. | ✓ VERIFIED | Bounded wallet history/audit implementation and tests remain present. |
| 17 | Forged balances, wrong network/validator, silent submission, seed/key-shaped, and API-key/profile-shaped values are rejected/redacted. | ✓ VERIFIED | Negative staking, wallet, redaction, and credential-boundary tests remain present; full tests pass. |
| 18 | Release verification commands pass and a VSIX is produced. | ✓ VERIFIED | `npm run verify:release` exited 0; it compiled and packaged `near-ai-vscode-0.1.0.vsix` and reported 53 archive entries, 45 runtime JavaScript files, and 7 required release assets. |
| 19 | Release contents, Marketplace documentation, and public trust/security reporting are complete. | ✓ VERIFIED | `README.md`, `SECURITY.md`, `.vscodeignore`, `scripts/verify-release-content.mjs`, and `package.json` are substantive and wired. The release verifier exited 0; direct archive inspection found 53 entries, zero `.codex`, planning, source-map, or test entries, and all seven required entries. |

**Score:** 19/19 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src/services/activityStore.ts` | Reload normalization derives event attribution only from the owning session snapshot | ✓ VERIFIED | Exists, substantive, and fixed path is exercised by the tampering/reload test. |
| `src/test/activityStore.test.ts` | Tampered persisted-attribution and legacy-unknown regression coverage | ✓ VERIFIED | Exists and contains both regression paths; exact ActivityStore test command passed. |
| `README.md` | Marketplace listing and installation/privacy/troubleshooting/roadmap documentation | ✓ VERIFIED | Contains Marketplace-facing value, installation, permissions, privacy/sovereignty/TEE, GSD, costs, wallet limitation, troubleshooting, and roadmap content. |
| `SECURITY.md` | Public trust/security report with evidence and limitations | ✓ VERIFIED | Contains permissions, outbound boundaries, provenance, reproducible commands, source-review results, limitations, and remediation status. |
| `.vscodeignore` | Development-only release exclusions | ✓ VERIFIED | Contains `.codex/**`, `.agents/**`, planning/source/test/map exclusions. |
| `scripts/verify-release-content.mjs` | Fail-closed VSIX contents/runtime integrity test | ✓ VERIFIED | Checks required entries, all non-test runtime JS, forbidden development entries, and package main. |
| `package.json` | Release command wired to package then archive verifier | ✓ VERIFIED | `verify:release` runs `npm run package && node scripts/verify-release-content.mjs`. |
| `near-ai-vscode-0.1.0.vsix` | Release candidate archive | ✓ VERIFIED | 53 entries; 45 runtime JS files; 7 required assets; no forbidden development/source/test entries. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `src/services/activityStore.ts:normalizeSession` | `src/services/activityStore.ts:normalizeEvent` | Normalized session attribution is the sole event ownership snapshot during reload | ✓ WIRED | Automated checker could not parse the colon-qualified `from` value, but manual source trace confirms `normalizeSession` passes `attribution` and `normalizeEvent` clones it. |
| `src/test/activityStore.test.ts` | `src/services/activityStore.ts` | Fresh store reloads directly written conflicting ledger JSON | ✓ WIRED | Automated checker found the `writeFile`/fresh `ActivityStore` reload pattern; exact test passed. |
| `.vscodeignore` | `near-ai-vscode-*.vsix` | `vsce` applies ignore rules during packaging | ✓ WIRED | `.codex/**` is present and the actual archive contains zero `.codex` entries. |
| `package.json:verify:release` | `scripts/verify-release-content.mjs` | Package then archive-content verification | ✓ WIRED | Automated checker could not parse the colon-qualified `from` value, but the script is present in the package command and `npm run verify:release` exited 0. |
| `README.md` | `docs/marketplace/near-ai-overview.gif` | Repository-local demo link | ✓ WIRED | Link exists in README and required archive entry exists. |
| `SECURITY.md` | `package-lock.json` and verification commands | Reproducible dependency/release evidence | ✓ WIRED | Report documents lockfile/provenance and the verification command set. |

### Data-Flow Trace (Level 4)

| Artifact | Data variable | Source | Produces real data | Status |
|---|---|---|---|---|
| `src/services/activityStore.ts` | Session/event attribution | Host dispatch snapshot, then normalized session snapshot on reload | Yes | ✓ FLOWING; persisted event ownership cannot override the session. |
| `src/services/analyticsStore.ts` | Analytics/filter/export records | Durable activity, approval, and audit stores | Yes | ✓ FLOWING |
| `src/services/stakingService.ts` | Entitlement/preview/history | Injected verified configuration and external wallet seam | Yes when configured; explicit unavailable otherwise | ✓ FAIL-CLOSED FLOW |
| `near-ai-vscode-0.1.0.vsix` | Release runtime/assets | Current `dist`, manifest, docs, and VSIX ignore rules | Yes | ✓ FLOWING; archive verifier confirms required entries and rejects forbidden entries. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Persisted event attribution cannot relabel a reloaded session | `node --test --test-name-pattern='tampered persisted event attribution|legacy activity records' dist/test/activityStore.test.js` | ActivityStore test file passed; exit 0 | ✓ PASS |
| Release package and archive contents are clean | `npm run verify:release` | Exit 0; 53 entries, 45 runtime JS files, 7 required assets | ✓ PASS |
| TypeScript lint | `npm run lint` | Exit 0 | ✓ PASS |
| Full unit suite | `npm test` | 29 test files passed, 0 failed, 0 skipped/todo | ✓ PASS |

### Probe Execution

No phase-declared or conventional `scripts/*/tests/probe-*.sh` probes were present. Probe execution was not applicable.

### Requirements Coverage

| Requirement | Source Plan | Status | Evidence |
|---|---|---|---|
| AUTH-01, AUTH-03, AUTH-04 | 05-01, 05-03 | ✓ SATISFIED | Scoped SecretStorage and external-wallet-only boundaries remain covered by source and tests. |
| MODEL-03, MODEL-04 | 05-01 | ✓ SATISFIED | Explicit validated provider/profile selection remains present. |
| COST-03, COST-04, COST-05 | 05-02, 05-03 | ✓ SATISFIED with documented fail-closed limitation | Analytics attribution is immutable after reload; injected entitlement paths are tested and production remains unavailable without verified official configuration. |
| STAKE-01, STAKE-02, STAKE-03 | 05-03 | ✓ SATISFIED with documented fail-closed limitation | Exact approval/history boundaries and no-local-credential-file constraints remain covered. |
| CHAT-04, AGENT-03, OBS-01 | 05-02 | ✓ SATISFIED | Durable history, filterable analytics, and bounded lifecycle records remain wired and tested. |
| TEST-01 | 05-01–05-05 | ✓ SATISFIED | Lint, focused regression, full tests, packaging, and archive verification passed. |
| SEC-01, SEC-02, SEC-03 | 05-01–05-05 | ✓ SATISFIED | Negative/security boundaries remain covered; `SECURITY.md` and reproducible evidence are present. |
| PKG-01, PKG-02 | 05-05 | ✓ SATISFIED | Installable VSIX, Marketplace documentation, visual assets, and clean archive verification passed. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---:|---|---|---|
| `src/services/activityStore.ts` | — | No unreferenced `TBD`, `FIXME`, or `XXX` markers; reload normalizes event ownership from the session | None | Previous attribution blocker is closed. |
| `.vscodeignore`, `README.md`, `SECURITY.md`, `scripts/verify-release-content.mjs`, `package.json` | — | No unreferenced debt markers or release stubs found | None | Release artifacts are substantive and wired. |
| `src/services/stakingService.ts`, `README.md`, `SECURITY.md` | — | Explicit unavailable/fail-closed wallet state | INFO / INTENTIONAL | Documented limitation; no verified configuration means no wallet write is attempted. |

### Advisory (New Scope, Unevidenced)

None. No new-scope blocker or unevidenced finding was raised during re-verification.

### Human Verification Required

#### 1. Official wallet callback smoke flow

**Test:** After the official NEAR AI staking configuration and wallet callback contract are supplied, manually exercise connect, cancel, network change, validator change, amount change, and mismatched-callback flows in a VS Code Extension Development Host.

**Expected:** Only a fresh exact-scope approved preview can submit; cancellation, scope changes, stale approval, or a mismatched callback prevents submission. Until then, entitlement status remains unavailable and stake-changing writes remain disabled.

**Why human:** The official external callback contract is not available in this checkout, so this interactive VS Code integration cannot be executed programmatically. This is a documented fail-closed limitation, not an implementation gap.

## Gaps Summary

Both previously failing gaps are closed:

1. Persisted ActivityStore event attribution is now session-authoritative across reload, append, and provider reconciliation, including legacy-unknown records.
2. Release documentation, trust/security reporting, ignore rules, archive verification, and the release-scoped VSIX are present and independently verified.

The final status is `human_needed` only because the documented official wallet callback smoke test cannot run without the external contract. The wallet limitation remains explicitly fail-closed: missing official configuration produces unavailable status and keeps stake-changing writes disabled; no local `~/.near-credentials` fallback is used.

---

_Verified: 2026-10-26T02:59:10Z_  
_Verifier: the agent (gsd-verifier)_
