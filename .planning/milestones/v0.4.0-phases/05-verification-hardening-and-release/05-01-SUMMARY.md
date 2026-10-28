---
phase: 05-verification-hardening-and-release
plan: 01
subsystem: auth
tags: [vscode-secretstorage, near-ai, profiles, provider-factory, chat, security, testing]

requires:
  - phase: 02-near-ai-client-models-and-costs
    provides: OpenAI-compatible NearAiClient transport, bearer injection, model discovery, and redacted provider errors
  - phase: 04-agents-routing-approvals-and-analytics
    provides: Bounded atomic .planning/.near-ai persistence and non-sensitive profile/webview allowlist patterns
provides:
  - Versioned project/profile credential scopes and named organization profiles
  - Explicit validation and active-profile selection with stale-state invalidation
  - Host-only provider construction and chat dispatch gating
  - Explicit legacy SecretStorage migration with no dispatch fallback
  - Negative coverage for cross-scope access, malformed metadata, protocol tampering, and credential leakage
affects: [05-02-release-hardening, cost-attribution, chat-setup]

actuals:
  tokens: 35723
  tasks: 3
  commits: 0

tech-stack:
  added: []
  patterns: [hashed project/profile SecretStorage keys, allowlisted auth metadata, bounded atomic profile ledger, validated host provider factory, strict profile webview protocol]

key-files:
  created:
    - src/domain/auth.ts
    - src/services/providerFactory.ts
    - src/services/profileStore.ts
    - src/test/auth.test.ts
    - src/test/profileStore.test.ts
    - src/test/providerFactory.test.ts
  modified:
    - src/services/auth.ts
    - src/services/nearAiClient.ts
    - src/services/chat.ts
    - src/services/chatBridge.ts
    - src/extension.ts
    - src/test/chat.test.ts
    - src/test/chatBridge.test.ts

key-decisions:
  - "SecretStorage keys contain only a version, hashed project scope, stable profile ID, and credential kind; raw workspace paths, names, and credentials never enter the key."
  - "A profile must be explicitly selected after successful provider validation; stale, pending, invalid, missing, or cross-scope profiles cannot dispatch or load models."
  - "Legacy global credentials are readable only through explicit current-project/profile import and are never a normal request fallback."
  - "Profile metadata and validation results are the only credential-adjacent values sent to the webview; the provider client remains host-only."

requirements-completed: [AUTH-01, AUTH-03, MODEL-03, MODEL-04, TEST-01, SEC-01, SEC-02]

coverage:
  - id: D1
    description: "A validated project/profile tuple resolves one host-only NEAR AI provider and isolates other projects and profiles."
    requirement: AUTH-03
    verification:
      - kind: unit
        ref: src/test/providerFactory.test.ts#provider factory isolates project and profile SecretStorage slots and never serializes the bearer
        status: pass
      - kind: unit
        ref: npm test -- --test-name-pattern='scoped SecretStorage|credential isolation'
        status: pass
    human_judgment: false
  - id: D2
    description: "Named profiles persist allowlisted metadata, require validation before selection, stale on changes, and support explicit legacy import."
    requirement: AUTH-01
    verification:
      - kind: unit
        ref: src/test/profileStore.test.ts#profile store persists allowlisted named organization metadata and active selection
        status: pass
      - kind: unit
        ref: src/test/profileStore.test.ts#legacy import leaves the profile pending until provider validation and cannot select another project
        status: pass
      - kind: unit
        ref: npm test -- --test-name-pattern='profile migration|profile validation|profile switch'
        status: pass
    human_judgment: false
  - id: D3
    description: "Chat/setup protocol and status surfaces expose only allowlisted profile state and block dispatch until explicit validated setup."
    requirement: MODEL-04
    verification:
      - kind: unit
        ref: src/test/chatBridge.test.ts#profile protocol accepts only allowlisted metadata and rejects secret-shaped or extra fields
        status: pass
      - kind: unit
        ref: src/test/chat.test.ts#chat setup state remains blocked until an explicit validated profile is selected
        status: pass
      - kind: unit
        ref: npm test -- --test-name-pattern='profile protocol|setup blocked|secret-shaped|no provider request'
        status: pass
    human_judgment: false
  - id: D4
    description: "Release verification passes for the complete extension test, lint, and packaging gates."
    requirement: TEST-01
    verification:
      - kind: other
        ref: npm run lint
        status: pass
      - kind: other
        ref: npm test (27 test files, 27 passed)
        status: pass
      - kind: other
        ref: npm run package (VSIX produced)
        status: pass
    human_judgment: false

commits: 0
plan_head_before: unavailable
plan_head_after: unavailable
duration: approximately 20m
completed: 2026-10-25
status: complete
---

# Phase 05 Plan 01: Project/Profile-Scoped NEAR AI Credentials Summary

**Project-scoped named organization profiles now gate NEAR AI dispatch behind explicit validation and host-only SecretStorage resolution, with migration-safe legacy handling and negative security coverage.**

## Performance

- **Duration:** approximately 20 minutes.
- **Started:** 2026-10-25T23:10:00Z (approximate; execution start was not captured by the runtime).
- **Completed:** 2026-10-25T23:29:03Z.
- **Tasks:** 3 completed.
- **Files modified:** 13 implementation/test files, plus this summary.

## Accomplishments

- Added versioned `OrganizationProfile`, `ProjectCredentialScope`, `ActiveProfileSelection`, `ProfileValidation`, and host-only `ResolvedProvider` contracts.
- Replaced chat’s direct global-key dispatch path with validated active-profile resolution through `createNearAiProvider`; model loading uses the same boundary and has no legacy fallback.
- Added hashed project/profile SecretStorage slots for API and refresh credentials, explicit legacy import, scoped credential deletion, and no access to `~/.near-credentials`.
- Added bounded atomic profile metadata persistence with allowlists, migration/rejection of older or malformed records, explicit selection, stale validation invalidation, and credential-independent export.
- Extended strict chat/setup protocol with profile list/create/update/select/validate/import actions, redacted status output, secret-shaped input rejection, and setup blocking.
- Added negative tests covering cross-project/profile isolation, unvalidated switching, stale metadata, malformed ledgers, legacy fallback denial, protocol tampering, and webview/serialization leakage.

## Task Commits

Git commits were unavailable. The workspace has an empty/non-usable `.git` path and Git reports that it is not a repository. No repository was initialized and no hashes are fabricated.

1. **Task 1: Trace one validated profile through SecretStorage into a NEAR AI request** — no commit (repository unavailable).
2. **Task 2: Persist named profiles, explicit selection/validation, and backward-compatible migration** — no commit (repository unavailable).
3. **Task 3: Wire profile setup, switching, validation, and status into the host/webview boundary** — no commit (repository unavailable).

**Plan metadata:** no commit (repository unavailable).

## Files Created/Modified

- `src/domain/auth.ts` — versioned profile, project scope, validation, selection, and host-provider contracts.
- `src/services/auth.ts` — scoped API/refresh SecretStorage operations and explicit legacy import adapter.
- `src/services/profileStore.ts` — allowlisted atomic profile ledger, migration, validation, selection, and metadata export.
- `src/services/providerFactory.ts` — validated host-only NEAR AI client construction.
- `src/services/chat.ts` / `src/services/chatBridge.ts` — provider-gated dispatch and strict profile protocol/status wiring.
- `src/extension.ts` — workspace profile setup and non-secret status presentation.
- `src/test/auth.test.ts`, `src/test/profileStore.test.ts`, `src/test/providerFactory.test.ts`, `src/test/chatBridge.test.ts`, `src/test/chat.test.ts` — focused isolation, migration, protocol, and redaction-negative coverage.

## Verification and Security Evidence

- Focused verification passed: `npm test -- --test-name-pattern='scoped SecretStorage|profile migration|profile switch|profile validation|setup blocked|secret-shaped|credential isolation'`.
- Full verification passed: `npm run lint`, `npm test` (27 files, 27 passed, 0 failed, 0 skipped/todo), and `npm run package` (VSIX produced).
- SecretStorage key assertions prove keys contain only `nearAi.v2`, hashed `project-<sha256-prefix>`, stable profile ID, and credential kind; raw paths, names, and credential literals are absent.
- Provider factory tests prove project/profile cross-access returns no credential, mismatched scopes and stale validation are rejected, and only the selected host client receives the bearer.
- Profile ledger and webview DTO tests prove API keys, refresh tokens, prompts, context, commands, and arbitrary paths are not persisted or serialized.
- Legacy credentials are copied only by explicit confirmed import into the current project/profile; the legacy slots are not read by provider dispatch.
- No code in this plan reads, writes, overwrites, archives, or deletes files under `~/.near-credentials`.

## Decisions Made

- Stable profile IDs are authoritative; display names and organization labels are descriptive metadata only.
- Profile selection is a separate explicit action after validation, so changing metadata or credentials cannot silently change the active provider.
- Existing `nearAi.baseUrl`, `nearAi.authMode`, and `nearAi.defaultModel` settings remain readable for compatibility, while new profile metadata owns the dispatch endpoint/auth boundary.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Tamper resilience] Rejected malformed profile records individually**
- **Found during:** Task 2 review.
- **Issue:** An invalid auth mode in one persisted record could throw during normalization and cause the whole ledger load to reset, discarding valid neighboring profiles.
- **Fix:** Normalize invalid auth modes to a rejected record while retaining valid records and rewriting the current allowlisted schema.
- **Files modified:** `src/services/profileStore.ts`.
- **Verification:** Profile migration/rejection test, lint, full tests, and packaging passed.
- **Committed in:** no commit; repository unavailable.

**Total deviations:** 1 auto-fixed (Rule 2).
**Impact on plan:** Required tamper-resilience hardening; no architectural scope expansion.

## Issues Encountered

- The first local profile metadata assertion incorrectly treated the allowed `authMode: apiKey` value as secret material; the test was corrected to assert credential literals are absent. The implementation was unaffected.
- Git commit, ledger, ancestry, and metadata-commit steps were unavailable because the mounted workspace is not a usable Git repository; `commits: 0` is recorded honestly.

## Known Stubs

None found in the files created or modified by this plan. Existing HTML input `placeholder` attributes remain intentional accessible affordances, not disconnected data sources.

## Threat Surface Review

The plan’s T-05-01 through T-05-04 mitigations are covered by hashed scope keys, explicit tuple checks, validated selection, allowlisted metadata, atomic migration, redacted errors, strict webview parsing, and host-only provider construction. No new external endpoint was introduced, and no NEAR credential-file path was accessed.

## Next Phase Readiness

Plan 05-02 can consume the validated profile metadata and host-side provider boundary. Cost/analytics consumers should use the selected profile ID and project scope from host records, never credential values or webview-supplied attribution.

## Self-Check: PASSED

- Summary file exists at the required path and contains `status: complete`.
- All plan implementation and focused test files exist.
- Focused tests, lint, full tests, and VSIX packaging passed in the final verification run.
- Git commit/ancestry checks are not applicable because the workspace is not a usable Git repository; no commit claims were made.
