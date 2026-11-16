---
phase: 69-team-mode-reconciliation-identities-and-signed-events-on-mai
plan: 04
subsystem: team-mode
tags: [team-mode, git-transport, file-lock, shared-mirror, reserved-refs, isolation, port]

requires:
  - phase: 69-03
    provides: event log, team.json handling, audit mirror and Enable on main
provides:
  - "Two windows of one editor on one team mirror take turns through main's acquireFileLock under near-ai-team-sync.lock (fix 3e11c0e)"
  - "team.json refuses coordination refs equal to, under or a parent of sync's state ref, and anything at or under sync's incoming ref"
  - "A test pins the reserved refs to STATE_REF and INCOMING_REF from stateTransport"
  - "A test that runs a team append and a project state sync together on one remote, with each lock held in turn"
affects: [69-05, 69-06, 69-07, 69-08, 69-10]

actuals:
  tokens: 14004
  tasks: 3
  commits: 3
plan_head_before: 5d4b09d6aa759d580880eac729775be4fed84f8c
plan_head_after: c92604238f1fedcb6da431240c84fcde7fc485fd

tech-stack:
  added: []
  patterns:
    - "One lock implementation: the team transport reuses acquireFileLock from src/services/stateMirrorLock.ts with its own lock file name, as stateLocks.ts does"
    - "The team.json parser hard-codes the sync refs and a test pins them to the sync constants, so the parser never imports the sync transport"

key-files:
  created:
    - src/test/helpers/mirrorLockChild.ts
    - src/test/teamSharedMirror.test.ts
    - src/test/teamMirrorIsolation.test.ts
  modified:
    - src/team/gitTransport.ts
    - src/team/teamFile.ts
    - src/test/teamFile.test.ts

key-decisions:
  - "3e11c0e is applied as a patch (12 hunks, offsets and two fuzz-1 hunks, no rejects), then the branch lock module's two imports and one call are swapped for acquireFileLock; src/team/mirrorProcessLock.ts is never created"
  - "The team lock file is named near-ai-team-sync.lock and lives in the team mirror folder; sync's near-ai-state-sync.lock lives in sync's own folder, so the two never share a name or a folder"
  - "collidesWithSyncRef refuses a ref that is equal to, under, or a parent of a reserved ref (git cannot hold a branch and a branch under it), compared in lower case"

patterns-established:
  - "Isolation tests hold one feature's lock and run the other feature under a time bound, so a wrong implementation fails fast"

requirements-completed: [TMR-02, TMR-03]

duration: 25min
completed: 2026-11-15
status: complete
---

# Phase 69 Plan 04: One team mirror lock, reserved sync refs and the isolation test Summary

**The 3e11c0e fix (two windows on one team mirror) runs on main's own `acquireFileLock` under the team's own lock file name, `team.json` refuses the project sync branch names, and a new test proves a team append and a state sync on one remote share no mirror, lock or branch.**

## Performance

- **Duration:** about 25 min
- **Tasks:** 3 of 3
- **Files created:** 3, modified: 3 (all in files plan 02 and 03 added, so no file that existed on main is touched)

## Accomplishments

- Task 1 (tracer): `git show 3e11c0e -- src/team/gitTransport.ts` applied with `patch -p1` (12 hunks, no rejects). The branch's lock module was not taken: the two imports became `acquireFileLock`, `MirrorBusyError` and the types `HeldMirrorLock`, `MirrorLockTimings` from `../services/stateMirrorLock`, `TEAM_MIRROR_LOCK_FILE = 'near-ai-team-sync.lock'` was added with a comment that sync uses its own name, and `exclusive()` calls `acquireFileLock(this.mirrorDir, TEAM_MIRROR_LOCK_FILE, ...)`. The in-process chain, the busy result and the transport's own `MIRROR_BUSY_*_REASON` text are exactly as in 3e11c0e. `mirrorLockChild` and `teamSharedMirror` came from `3e11c0e:<path>` with only the lock imports changed (child: `acquireFileLock` with `TEAM_MIRROR_LOCK_FILE`; test: `TEAM_MIRROR_LOCK_FILE` from the transport). All six shared-mirror cases pass, including the forced second writer at every git step of an append, a crashed holder, a stale holder, a waiter giving up and a taken-over lock left in place.
- Task 2: `RESERVED_SYNC_REFS` (two hard-coded strings) and `collidesWithSyncRef` in `teamFile.ts`; `validRef` refuses colliding refs with the existing `team.json has a missing or invalid "coordination.ref" and was not used.` message (never echoing the value). Seven refused and four accepted refs are tested, `RESERVED_SYNC_REFS` is deep-equal to `[STATE_REF, INCOMING_REF]` imported from `stateTransport`, and the team's `LOCAL_REF`, `INCOMING_REF` and quarantine prefix are checked to sit outside `refs/near-ai/` and apart from both sync refs.
- Task 3: `teamMirrorIsolation.test.ts` (4 tests) on one bare remote with one machine that has both sync (a pushed thread) and Team Mode (enabled through `enableTeamMode` with its own secrets and storage). A team append and a state sync run in `Promise.all`; both finish, both remote refs move, `team.json` is byte-identical, `team.json` is not on the state branch, and the decrypted payloads contain neither the team id, the team name nor the text `team.json`. Holding the team mirror lock does not delay a sync; holding sync's lock does not delay a team append (both bounded at 60 s, with a 400 ms lock wait on the team transport so a wrong implementation reports busy at once). The two mirror folders differ and neither is inside the other.
- No package was added; `package.json` and the lockfile are unchanged. The Phase 69 diff against 4e5dbb9 still shows only `src/domain/approval.ts` and `src/services/auditStore.ts` as modified source files (plus the planning tracker files).

## Test evidence

Per-file counts, each run alone under the cap wrapper after a clean `npx tsc -p tsconfig.json`:

| Test file | Tests | Pass | Fail | Cancelled |
|-----------|-------|------|------|-----------|
| teamSharedMirror | 6 | 6 | 0 | 0 |
| teamConcurrency | 2 | 2 | 0 | 0 |
| teamGitTransport | 37 | 37 | 0 | 0 |
| teamFile + teamEnable (Task 2 command) | 46 | 46 | 0 | 0 |
| teamMirrorIsolation | 4 | 4 | 0 | 0 |
| teamLog + teamForgery + teamAudit + teamGitTransport (regression, after the teamFile change) | 75 | 75 | 0 | 0 |

## Commands run

All under `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout <N> env NODE_OPTIONS=--max-old-space-size=1536 sh -c '...'`, one heavy run at a time (`timeout 1800` for teamSharedMirror, `900` otherwise):

- Task 1: `npx tsc -p tsconfig.json && node --test --test-concurrency=1 dist/test/teamSharedMirror.test.js` (6 pass), then `node --test --test-concurrency=1 dist/test/teamConcurrency.test.js` (2 pass) and `... dist/test/teamGitTransport.test.js` (37 pass).
- Task 2: `npx tsc -p tsconfig.json && node --test dist/test/teamFile.test.js dist/test/teamEnable.test.js` (46 pass). The red step was the compile failure of the new test imports before `RESERVED_SYNC_REFS` and `collidesWithSyncRef` existed.
- Task 3: `npx tsc -p tsconfig.json && node --test --test-concurrency=1 dist/test/teamMirrorIsolation.test.js` (4 pass).
- Regression: `node --test --test-concurrency=1 dist/test/teamLog.test.js dist/test/teamForgery.test.js dist/test/teamAudit.test.js dist/test/teamGitTransport.test.js` (75 pass).
- The repository's lint script is `tsc -p tsconfig.json --noEmit`, which the builds above already cover (no eslint config exists).

## Task Commits

1. Task 1: `160efaf` fix(team): two windows on one team mirror take turns through the shared file lock (from 3e11c0e)
2. Task 2: `fe085e0` fix(team): team.json refuses the project sync branch names (D-12, D-23)
3. Task 3: `c926042` test(team): team sync and project state sync on one remote never share a mirror, lock or branch (D-11, D-15)

## Deviations from Plan

- Commit trailer: the plan names `Claude Opus 5.5`; the commits carry `Claude Sonnet 5.5`, the model that actually ran, as the owner rules require.
- `teamSharedMirror.test.ts` is not in `ae5e9e1` (3e11c0e extends a file that 2ce4981 created), so it was taken whole from `3e11c0e:src/test/teamSharedMirror.test.ts`, as the plan says. Only the lock imports changed; no case was dropped or loosened and both `win32` skips are kept.
- Task 3 uses the availability value `focus` for the team append, because `busy` is not a member of this repository's availability type (`available`, `offline`, `focus`, `away`). No product change.
- The lock file is removed when released, so "each mirror holds only its own lock file name" is asserted while one lock is held (the held name is present, the foreign name is absent in both mirrors) and after the concurrent run (both foreign names absent), not by sampling mid-operation.
- Actuals: the realised diff is about 14,000 tokens (chars/4 over `git diff` of the six files, 56,016 characters), far below the plan's 80,042 estimate because the transport patch and the shared-mirror test are ports.

## Notes for L2 (Phases 61, 62, 62.1)

- `policy.integrationBranch` (Phase 65) is a branch name of the project's own code, not a coordination ref, but it too must refuse the sync branch (`refs/heads/near-ai/state` and anything under or above it) when that phase adds it. Reuse `collidesWithSyncRef` rather than a second check. Enable always writes `DEFAULT_COORDINATION_REF`, so Enable needed no change here.
- If the sync side ever renames `STATE_REF` or `INCOMING_REF`, the pinning test in `teamFile.test.ts` fails, which is the signal to update `RESERVED_SYNC_REFS` and to add the old name as a second reserved value for one release.

## Auth gates

None.

## Known Stubs

None.

## Threat Flags

None. No new network endpoint, auth path or schema: the plan's threats T-69-08 (shared mirror, covered by teamSharedMirror), T-69-09 (ref names, covered by the teamFile cases) and T-69-10 (lock and mirror sharing, covered by teamMirrorIsolation) are each exercised by a test, and no package was added (T-69-SC).

## Self-Check: PASSED

- Created files exist: `src/test/helpers/mirrorLockChild.ts`, `src/test/teamSharedMirror.test.ts`, `src/test/teamMirrorIsolation.test.ts`.
- `grep -c "near-ai-team-sync.lock" src/team/gitTransport.ts` is 1 and `grep -c "acquireFileLock(this.mirrorDir, TEAM_MIRROR_LOCK_FILE" src/team/gitTransport.ts` is 1; `src/team/mirrorProcessLock.ts` does not exist; `grep -rn mirrorProcessLock src` prints nothing.
- `collidesWithSyncRef` appears twice in `teamFile.ts`; `STATE_REF` appears 3 times in `teamFile.test.ts`; `teamMirrorIsolation.test.ts` has 4 tests and uses both lock names.
- Commits `160efaf`, `fe085e0` and `c926042` are ancestors of HEAD.
