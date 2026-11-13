---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 29
subsystem: agent-boundary
tags: [security, review-gap-closure, protected-paths, checkpoints]
requires: []
provides:
  - "src/domain/protectedPaths.ts: PROTECTED_WRITE, STATE_FOLDER_PATH, STATE_FOLDER_TEXT, protectedWriteReason(relative, shown), normalizeRelative"
  - "RunCheckpointsOptions.allowedRoots: load and revert are bounded to the project and this editor's sub-agent worktree folder"
affects: [27-30, 27-31, 27-36]
tech-stack:
  added: []
  patterns: ["one shared path rule for the file tools and the shell guard", "nothing inside the project folder decides which files outside the workspace are touched"]
key-files:
  created:
    - src/domain/protectedPaths.ts
    - src/test/protectedPaths.test.ts
    - src/test/checkpointBounds.test.ts
  modified:
    - src/agent/tools.ts
    - src/agent/commandSafety.ts
    - src/agent/checkpoints.ts
    - src/services/agentSession.ts
    - src/test/stateMigration.test.ts
key-decisions:
  - "PROTECTED_WRITE covers every segment that is or ends in .git, .planning/.near-ai, and everything under .near-ai/ except scratch/ and attachments/ (so the state folder, the locks folder and hooks all ask, even after 'allow edits for this run' and in fully-autonomous mode)"
  - "The state folder and its state.previous-* / state.adopt-* siblings are sensitive for Read (isSensitivePath), the Grep result filter, and the shell guard (KB_OR_SECRET and SENSITIVE_TEXT)"
  - "RunCheckpoints is bounded only when a root or allowedRoots is given; a caller that gives neither (the benchmark runner and unit tests with no project) keeps the old unbounded behavior. Every production caller passes both."
  - "Revert checks the lexical path and the real path of the nearest existing parent folder against the real paths of the roots, so a project folder that became a link out is not written through"
requirements-completed: [SYNC-01, SYNC-03]
status: complete
commits: 2
plan_head_before: 60ee73e68f9285dd1cb7931c50226c2fcaed311e
plan_head_after: 0b5b29943b3a83bbfed331e066ab7fdb66c2ffcc
actuals:
  tokens: 9600
  tasks: 2
  commits: 2
completed: 2026-11-13
---

# Phase 27 Plan 29: Agent boundary for the state folder, and bounded checkpoints Summary

The agent now asks before it writes anything under `.near-ai/` (except its scratch and attachments folders) or in any `*.git` folder, and before it reads the state folder's keys; a saved checkpoint can no longer make Revert write or delete a file outside the project or this editor's worktrees.

## What changed

**Task 1 (tracer), commit f47df6c.** `src/domain/protectedPaths.ts` is the one rule. `tools.ts` (`protectedWrite`, `isSensitivePath`) and `commandSafety.ts` (`pathFacts`, `KB_OR_SECRET`, `SENSITIVE_TEXT`) use it; both local `PROTECTED_WRITE` copies are gone. Sentences for `.git` and `.planning/.near-ai` are unchanged; `.near-ai` and a `*.git` folder get their own. The shell guard's reasons name `.near-ai` too. The extension's own writes into the state folder do not go through these guards.

**Task 2, commit 0b5b299.** `RunCheckpoints` takes `allowedRoots`. Load drops format 1 and format 2 entries whose absolute path is in neither the project nor an allowed root. `revert()` re-checks each snapshot (lexical, then the real path of the nearest existing parent against the real roots) and skips and does not report one that fails, including snapshots taken in memory. `agentSession.ts` passes `allowedRoots: [this.worktreeDir]` where it makes or loads checkpoints.

## Verification

Run one at a time under the memory cap.
- Task 1 command: 67 tests, 65 pass, 0 fail, 2 skipped (ripgrep not installed here). 5 new protectedPaths tests.
- Task 2 command: 63 tests, 61 pass, 0 fail, 2 skipped. 6 new checkpointBounds tests.
- `npm run lint`: exit 0.
- Acceptance greps: `PROTECTED_WRITE = ` in tools.ts and commandSafety.ts: 0 (baseline 2); `protectedPaths` in tools.ts and commandSafety.ts: 2 and 1; `allowedRoots` in checkpoints.ts and agentSession.ts: 3 and 2.

## Deviations from Plan

**1. [Rule 1 - existing test encoded the old contract] stateMigration checkpoint test**
- **Found during:** Task 2
- **Issue:** `src/test/stateMigration.test.ts` ("checkpoints: only this project's are copied...") loaded a migrated checkpoint with an entry in the old editor's storage folder (outside the project) with `{ root }` only and expected it to load. That is exactly what the plan forbids.
- **Fix:** The load in that test now passes `allowedRoots: [storage]` (the entry still loads, the original intent), and a second load with only `root` asserts the outside entry is dropped. Nothing was removed or weakened.
- **Files modified:** src/test/stateMigration.test.ts
- **Commit:** 0b5b299

**2. [Design choice] Unbounded when neither root nor allowedRoots is given**
- The plan says "without allowedRoots, only paths inside root load". With no root at all (existing tests such as "checkpoints captured in parallel" and the benchmark runner use `new RunCheckpoints(id)` or no root), nothing could load, which would break those unchanged tests. A caller that names no project gets the old behavior; every production caller passes `root` and `allowedRoots`.

## Known Stubs

None.

## Threat Flags

None. T-27-118, T-27-119 and T-27-120 are mitigated and tested; T-27-121 (a recursive shell read of the whole project root) is accepted as planned.

## Issues Encountered

None beyond the deviation above.

## Self-Check: PASSED

- FOUND: src/domain/protectedPaths.ts, src/test/protectedPaths.test.ts, src/test/checkpointBounds.test.ts
- FOUND commits: f47df6c, 0b5b299
