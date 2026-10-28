---
phase: 03-chat-workspace-motion-activity-and-command-bridge
plan: 07
subsystem: chat-activity
tags: [vscode, open-gsd, activity-store, history, reopen, testing]
requires:
  - phase: 03-chat-workspace-motion-activity-and-command-bridge
    provides: shared ActivityStore wiring, Open-GSD command runner, bounded activity persistence
provides:
  - Awaited terminal activity writes before command history refresh
  - Deterministic shared-store command history/reopen regression coverage
  - Terminal outcome, approval, cancellation, corruption, bounds, and redaction coverage
affects: [04-agents-routing-approvals-analytics]
actuals:
  tokens: 1450
  tasks: 2
  commits: 0
plan_head_before: unavailable
plan_head_after: unavailable
commits: 0
tech-stack:
  added: []
  patterns: [panel-scoped durable store injection, awaited terminal history refresh, fake-runner lifecycle tests]
key-files:
  created:
    - .planning/phases/03-chat-workspace-motion-activity-and-command-bridge/03-07-SUMMARY.md
  modified:
    - src/services/chat.ts
    - src/test/chat.test.ts
    - src/test/activityStore.test.ts
key-decisions:
  - "Keep one panel-owned ActivityStore as the command lifecycle boundary; runGsdCommand receives the existing instance rather than constructing one internally."
  - "Refresh history only after the serialized activity-write queue completes, so terminal history cannot race the durable append."
requirements-completed: [CHAT-04, OBS-01, TEST-01, SEC-01]
coverage:
  - id: D1
    description: "Open-GSD command sessions use the panel ActivityStore and are immediately visible to history with the same terminal outcome and session ID."
    requirement: CHAT-04
    verification:
      - kind: unit
        ref: src/test/chat.test.ts#command session shares panel activity store and history reopen sees terminal outcome
        status: pass
      - kind: other
        ref: npm test
        status: pass
    human_judgment: false
  - id: D2
    description: "Activity history preserves bounded, operational-only outcomes across waiting approval, cancellation, failure, setup blocking, corruption recovery, and reopen."
    requirement: OBS-01
    verification:
      - kind: unit
        ref: src/test/activityStore.test.ts#activity store history remains fresh across waiting approval and terminal command outcomes
        status: pass
      - kind: unit
        ref: src/test/activityStore.test.ts#activity store records every terminal outcome without executable command data
        status: pass
    human_judgment: false
  - id: D3
    description: "Shared-store lifecycle changes retain lint, full tests, packaging, and privacy-safe serialization."
    requirement: SEC-01
    verification:
      - kind: other
        ref: npm run lint && npm test && npm run package
        status: pass
    human_judgment: false

duration: approximately 15m
completed: 2026-10-25
status: complete
---

# Phase 3 Plan 7: Shared ActivityStore Command Sessions Summary

**Open-GSD command sessions now refresh history only after awaited writes to the panel’s shared durable ActivityStore, with reopen and privacy regressions covering terminal outcomes.**

## Performance

- **Duration:** approximately 15m
- **Started:** 2026-10-25T22:08:00Z
- **Completed:** 2026-10-25T22:22:52Z
- **Tasks:** 2 completed
- **Files modified:** 3 implementation/test files, plus this summary
- **Commits:** 0; Git is unavailable in this mounted workspace.

## Accomplishments

- Exported and tested the actual `runGsdCommand` lifecycle with a deterministic fake runner and one supplied `ActivityStore` instance.
- Awaited the serialized activity-write queue before posting command history, and refresh history after failure append as well.
- Added regression coverage for waiting/approval, cancellation, completed/failed/setup-blocked outcomes, corrupt-ledger recovery, bounds, reopen coherence, and raw prompt/command redaction.

## Task Commits

Git commits were unavailable. The workspace has no usable Git repository (`git` reports that the mounted `.git` path is not a repository), so no commit hashes are fabricated.

1. **Task 1: Route one command lifecycle through the panel store** — no commit (repository unavailable)
2. **Task 2: Harden shared-store freshness and terminal history** — no commit (repository unavailable)

**Plan metadata:** no commit (repository unavailable).

## Files Created/Modified

- `src/services/chat.ts` — exports the command lifecycle helper for deterministic coverage and awaits terminal history refresh after durable writes.
- `src/test/chat.test.ts` — proves one supplied panel store is used by command execution and history observes the same completed session without replay.
- `src/test/activityStore.test.ts` — covers fresh waiting/approval and cancellation persistence plus durable redaction.
- `.planning/phases/03-chat-workspace-motion-activity-and-command-bridge/03-07-SUMMARY.md` — execution record and verification matrix.

## Decisions Made

- Kept the existing panel-scoped store injection boundary; no global store or cache invalidation workaround was introduced.
- Made terminal history refresh await the existing serialized append queue, preserving bounded atomic persistence and avoiding stale reads.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Ordering bug] Prevented terminal history refresh from racing activity persistence**
- **Found during:** Task 1 verification
- **Issue:** Terminal event handling posted history with `void sendHistory(...)` before queued activity appends were guaranteed complete.
- **Fix:** Removed the fire-and-forget terminal refresh and awaited `activityWrites` before the single terminal history refresh; failure handling also refreshes after its append.
- **Files modified:** `src/services/chat.ts`
- **Verification:** Shared-store command lifecycle test, lint, full test suite, and package verification pass.
- **Committed in:** No commit; repository unavailable.

**Total deviations:** 1 auto-fixed Rule 1 ordering issue.
**Impact on plan:** Necessary for the stated history/reopen coherence guarantee; no architectural expansion or scope creep.

## Issues Encountered

- Git commits, commit ledger, ancestry checks, and measured commit ranges were unavailable because the mounted workspace has no usable Git repository. This is recorded honestly as `commits: 0`; Git metadata was not changed.
- The repository does not provide a VS Code runtime module for tests, so the chat regression stubs only the VS Code host boundary while exercising the real command lifecycle, runner contract, and ActivityStore.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

03-07 is complete on disk. Command execution, history refresh, and reopen now share one durable panel store with awaited terminal ordering. 03-08 and Phase 4 were not executed.

## Self-Check: PASSED

- Summary file exists at the required path.
- `status: complete` is present.
- `src/services/chat.ts`, `src/test/chat.test.ts`, and `src/test/activityStore.test.ts` exist.
- `npm run lint`, `npm test`, and `npm run package` passed.
- Git commit verification is not applicable because the workspace is not a Git repository; no commit claims are present.

---
*Phase: 03-chat-workspace-motion-activity-and-command-bridge*
*Plan: 07*
*Completed: 2026-10-25*
