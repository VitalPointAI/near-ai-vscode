---
phase: 05-verification-hardening-and-release
plan: 04
subsystem: activity-store-security
tags: [activity-store, attribution, persistence, redaction, regression, security]

requires:
  - phase: 05-verification-hardening-and-release
    provides: Host-derived attribution snapshots, estimate/actual reconciliation, legacy-unknown normalization, and redaction coverage from Plan 05-02.
provides:
  - Persisted ActivityStore events always inherit the owning normalized session attribution during reload.
  - Tampered valid event ownership cannot relabel historical sessions, appended events, or reconciled provider usage.
  - Legacy sessions and their events remain explicitly legacy-unknown despite conflicting event-shaped attribution.
affects: [verification, release, analytics, observability, security]

actuals:
  tokens: 1200
  tasks: 2
  commits: 0

tech-stack:
  added: []
  patterns: [session-owned reload normalization, tampered-ledger regression fixtures, explicit legacy-unknown propagation]

key-files:
  created:
    - .planning/phases/05-verification-hardening-and-release/05-04-SUMMARY.md
  modified:
    - src/services/activityStore.ts
    - src/test/activityStore.test.ts

key-decisions:
  - "The normalized session attribution is the sole ownership source for every rehydrated event; persisted event attribution is never consulted as an owner."
  - "Legacy or malformed session attribution continues to use the explicit legacy-unknown snapshot for both session and events, without consulting current selection state."
  - "No Git commits were created because the user explicitly requested no commits and the mounted .git directory is not a usable repository."

patterns-established:
  - "Reload normalization clones the bounded session attribution snapshot into each event."
  - "Security fixtures write conflicting durable JSON directly, then verify behavior through a fresh ActivityStore instance."

requirements-completed: [COST-04, CHAT-04, AGENT-03, OBS-01, TEST-01, SEC-01]

coverage:
  - id: D1
    description: "Reloaded attributed sessions retain one immutable organization/profile and workspace-project owner across persisted, appended, and reconciled events."
    requirement: COST-04
    verification:
      - kind: unit
        ref: "src/test/activityStore.test.ts#tampered persisted event attribution cannot relabel a reloaded session or later reconciliation"
        status: pass
      - kind: other
        ref: "npm test -- --test-name-pattern='tamper|attribution|reconcile'"
        status: pass
    human_judgment: false
  - id: D2
    description: "Legacy activity remains explicitly unknown and cannot inherit a current project or organization from persisted event data."
    requirement: SEC-01
    verification:
      - kind: unit
        ref: "src/test/activityStore.test.ts#legacy activity records remain explicitly unknown despite conflicting persisted event attribution"
        status: pass
      - kind: other
        ref: "npm run lint && npm test -- --test-name-pattern='legacy|activity store|attribution'"
        status: pass
    human_judgment: false
  - id: D3
    description: "Activity redaction, estimate/actual separation, and repository-wide unit behavior remain intact after the normalization hardening."
    requirement: OBS-01
    verification:
      - kind: other
        ref: "npm run lint"
        status: pass
      - kind: other
        ref: "npm test"
        status: pass
    human_judgment: false

metrics:
  duration: approximately 20 minutes
  completed: 2026-10-26
  status: complete
plan_head_before: unavailable
plan_head_after: unavailable
commits: 0
status: complete
---

# Phase 05 Plan 04: Persisted Activity Attribution Immutability Summary

**Persisted ActivityStore reloads now preserve session-owned attribution across tampering, append, reconciliation, and legacy-unknown records.**

## Performance

- **Duration:** Approximately 20 minutes.
- **Tasks:** 2 completed.
- **Files modified:** 2 scoped source/test files, plus this summary.

## Accomplishments

- Changed `normalizeEvent` so every rehydrated event receives a clone of the normalized owning session attribution; a valid-looking event-level attribution can no longer relabel history.
- Added a direct durable-ledger tampering fixture proving project/profile A survives an event claiming valid project/profile B, including later append and provider reconciliation.
- Expanded legacy coverage so records without valid session attribution remain `legacy-unknown` for every event even when persisted event JSON contains a current-looking attribution.
- Preserved estimate/actual separation and existing serialized redaction assertions.

## Task Commits

No Git commits were created. The user explicitly requested no commits, and the mounted `.git` directory is empty/non-usable; Git reports that the workspace is not a repository. No repository metadata was initialized and no hashes were fabricated.

1. **Task 1: Trace one tampered persisted event through reload without changing session ownership** — no commit.
2. **Task 2: Preserve legacy-unknown ownership under conflicting persisted event data** — no commit.

**Plan metadata:** no commit.

## Files Created/Modified

- `src/services/activityStore.ts` — forces rehydrated event attribution to clone the normalized session snapshot.
- `src/test/activityStore.test.ts` — adds tampered persisted-attribution, append/reconciliation, legacy-unknown, and ownership assertions.
- `.planning/phases/05-verification-hardening-and-release/05-04-SUMMARY.md` — records execution and verification evidence.

## TDD Evidence

### RED

The newly added tests failed before the implementation change on the planned assertions: the tampered event reloaded as Company B instead of Company A, and the legacy event did not remain in the unknown bucket. The direct test run exited 1 with two `AssertionError` failures; the failure was behavioral rather than a compile, load, or fixture error.

### GREEN

`normalizeEvent` now ignores persisted event ownership and clones the normalized session snapshot. The focused tampering and legacy tests pass, as do append/reconciliation and existing redaction assertions.

No RED/GREEN Git commits were made because the repository is unusable and the user prohibited commits.

## Verification and Security Evidence

- `npm test -- --test-name-pattern='tamper|attribution|reconcile'` — passed.
- `npm run lint` — passed.
- `npm test -- --test-name-pattern='legacy|activity store|attribution'` — passed.
- `npm test` — passed: 29 test files, 29 passed, 0 failed, 0 skipped/todo.
- No credentials were accessed or modified. No package or release command was run, and no unrelated release files were changed.

## Deviations from Plan

### User-Directed Repository Constraint

**1. No per-task or metadata commits**
- **Found during:** Execution initialization.
- **Issue:** The mounted `.git` path is an empty directory and Git cannot operate on the workspace; the user also explicitly prohibited commits.
- **Action:** Preserved the working tree changes and documented commits as unavailable/zero. No Git metadata was created or altered.
- **Impact:** Code, focused tests, lint, full unit verification, and this summary are complete; only commit-based provenance checks are unavailable.

**Total deviations:** 1 user-directed execution constraint.
**Impact on plan:** No production or test scope was expanded; the attribution-integrity blocker is closed.

## Issues Encountered

None beyond the pre-existing unusable Git workspace. The planned RED failure was reproduced and resolved.

## Known Stubs

None in the files created or modified by this plan.

## Threat Surface Review

The plan’s T-05-17 and T-05-18 mitigations are implemented: durable event fields cannot select ownership during reload, and invalid/missing session attribution remains explicit legacy-unknown without current-scope inference. No new endpoint, credential path, dependency, schema, or external trust boundary was introduced.

## Next Phase Readiness

The persisted ActivityStore attribution blocker identified by `05-VERIFICATION.md` is closed. Plan 05-05 may address the separate release documentation and packaging gaps; this plan intentionally did not touch those files.

## Self-Check: PASSED

- `src/services/activityStore.ts` exists and contains session-snapshot-only event normalization.
- `src/test/activityStore.test.ts` exists and contains tampering and legacy-unknown regression tests.
- Focused tests, lint, and the complete unit suite all pass.
- Summary status is `complete` and records `commits: 0` with unavailable Git heads honestly.
- No credentials, package dependencies, or unrelated release files were touched.

---
*Phase: 05-verification-hardening-and-release*
*Plan: 05-04*
*Completed: 2026-10-26*
