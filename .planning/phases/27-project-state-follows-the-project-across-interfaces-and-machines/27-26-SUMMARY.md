---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 26
subsystem: sync
tags: [git, security, review-gap-closure, sync-mirror, hooks]
requires: []
provides:
  - "privateHooksDir() and the empty-real-directory check in runStateGit (GitHooksFolderError)"
  - "StateTransport refusal of a mirror or hooks folder inside the project (symbolic links resolved)"
  - "SyncParts.mirrorRoot, mirrorFolderName(root), defaultMirrorRoot(), removeOldInProjectSyncFolders(home)"
affects: [27-27, 27-28, 27-29]
tech-stack:
  added: []
  patterns: ["nothing inside the project folder decides what git runs"]
key-files:
  created: [src/test/stateHostileFolder.test.ts]
  modified:
    - src/services/stateGit.ts
    - src/services/stateTransport.ts
    - src/services/syncFlows.ts
    - src/services/syncCommands.ts
    - src/services/stateMirrorLock.ts
    - src/test/syncMirrorCredentials.test.ts
key-decisions:
  - "A missing hooks folder is made (mode 0700) by runStateGit before the emptiness check, so a transport's first call before the mirror exists still works"
  - "Without a mirrorRoot (tests, fakes) the mirror goes under one per-process private temporary folder (defaultMirrorRoot)"
requirements-completed: [SYNC-05]
status: complete
commits: 2
plan_head_before: 3110b24ca269ea278e1d7bb66bee43177cbc3a9a
plan_head_after: 4c36fecbb3e8d82731499e1f70bee90312981f36
actuals:
  tokens: 14000
  tasks: 2
  commits: 2
completed: 2026-11-13
---

# Phase 27 Plan 26: Sync mirror and hooks out of the project Summary

Sync's private mirror and hooks folder no longer live in the project: git is pointed at one private empty hooks folder and the mirror sits under the editor's globalStorage, so a planted hook or mirror config runs nothing and is never read (REVIEW B1, git boundary).

## What changed

- `stateGit.ts`: `privateHooksDir()` (once-per-process mkdtemp, 0700) replaces the internal helper; `runStateGit` first checks that the hooks folder it would use is a real, empty directory (a missing one is made) and otherwise rejects with `GitHooksFolderError` without spawning git.
- `stateTransport.ts`: the constructor resolves root, mirror and hooks folders through the nearest existing ancestor's realpath and throws "Sync's private folders must be outside the project folder. Nothing was changed." when either is inside or equal to the project.
- `syncFlows.ts`: `mirrorRoot`, `mirrorFolderName`, `defaultMirrorRoot`; `buildStateSync` builds `<mirrorRoot>/<name>/mirror.git` with `privateHooksDir()`; the unlock flow's scratch mirror uses `privateHooksDir()`; `removeOldInProjectSyncFolders(home)` removes the old in-project `mirror.git` and `hooks` (real folders removed, symbolic links unlinked, never followed, nothing else touched, only when the state home exists).
- `syncCommands.ts`: `mirrorRoot = <globalStorage>/sync-mirrors`; the one-time removal at activation.
- `stateMirrorLock.ts`: header comment updated (comment only).
- `stateHostileFolder.test.ts` (9 tests): tracer with planted hooks (pre-push, reference-transaction, post-update, pre-commit, update) and a planted mirror.git config (core.sshCommand, core.fsmonitor, credential.helper, include.path, remote.state.url) against a real local bare remote; sentinel never appears, the trap remote gets nothing, the planted folders are byte-identical afterwards; placement and naming; transport refusals incl. symbolic links; runStateGit refusals; privateHooksDir; the removal (real, symlinked, no state home, second call); source checks.

## Verification (memory-capped, targeted)

- stateHostileFolder: 9/9 pass.
- Task 1 set (stateHostileFolder, stateSyncGit, stateRemote, stateIdentity, stateLeak, syncFlows, stateTwoMachines, syncMirrorCredentials): 83 tests, 83 pass after the fixture update below.
- Task 2 set plus onlineHome and stateLazyFetch (stateHostileFolder, syncFlows, syncControl, syncMirrorCredentials, onlineHome, stateLazyFetch): 122/122 pass.
- `npm run lint`: clean. Acceptance greps: `paths.sync, 'mirror.git'` 0, `export function privateHooksDir` 1, `outside the project folder` 2.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] syncMirrorCredentials test read the mirror at its old in-project path**
- **Found during:** Task 1 verification
- **Issue:** `src/test/syncMirrorCredentials.test.ts` read `<state home>/sync/mirror.git`, which no longer exists after the move; its userinfo scan also no longer covered the mirror files.
- **Fix:** the test now locates the mirror through `defaultMirrorRoot()` and `mirrorFolderName()`, and the userinfo scan additionally covers both mirror folders (the file-count threshold was kept, not lowered). No assertion was weakened.
- **Files modified:** src/test/syncMirrorCredentials.test.ts
- **Commit:** fac60a2

**2. [Plan wording] Task 2's `removeOldInProjectSyncFolders` was written in the Task 1 commit** because it lives in syncFlows.ts with the other mirror code; Task 2's commit holds the syncCommands.ts wiring. Both tasks' tests ran after both commits.

## Known Stubs

None.

## Threat Flags

None. T-27-107, T-27-108 and T-27-109 are mitigated and covered by the sentinel and symbolic-link tests.

## Notes for later plans

- Two different editors on one project now keep two mirrors (each in its own storage). This is safe because the remote's compare-and-swap push keeps it correct; the mirror lock covers windows of one editor.

## Self-Check: PASSED

- src/test/stateHostileFolder.test.ts found; commits fac60a2 and 4c36fec are on the branch.
