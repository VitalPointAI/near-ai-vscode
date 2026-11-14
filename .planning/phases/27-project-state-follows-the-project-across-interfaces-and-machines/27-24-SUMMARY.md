---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 24
subsystem: sync-control
tags: [gap-closure, G-27-4b, G-27-4d, sync-control, local-home-check, status-sentence, extension-host-test]
status: complete

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-22 sync control with the visible detail line under it"
provides:
  - "localHomeState(root, git): 'home' | 'no-home' | 'unknown' from git's own remote list only (no fetch, no network, no write)"
  - "SyncScheduler.setHomeKnown(hasHome): moves the control between 'Sync off' and 'No online home' while sync is off; ignored while sync is on; silent when the answer is unchanged"
  - "refreshSyncHome(root) in syncCommands.ts, run at activation, after the online-home, turn-on and turn-off commands, and from chat.ts on panel set-up and on chat-ready"
  - "statusSentence(outcome, interactive): one sentence per failure, used by the scheduler's published status and by the Sync Project Now toast"
affects: [27-25, verify-work]

requirements-completed: [SYNC-09, SYNC-05]

actuals:
  tokens: 7000
  tasks: 2
  commits: 4
plan_head_before: 6cffb32970f560eb4a7f19a672a0ce98c1590e4d
plan_head_after: dd47a24796cf60a6c39544de01c4188ff7001ab8

tech-stack:
  added: []
  patterns:
    - "A cheap local check (git remote list) decides a control state at panel open instead of waiting for a failed sync"
    - "One sentence builder shared by the toast and the status, so two places cannot word one failure two ways"

key-files:
  created: []
  modified:
    - src/services/syncFlows.ts
    - src/services/syncCommands.ts
    - src/services/chat.ts
    - src/test/syncFlows.test.ts
    - src/test/e2e/suite.ts

key-decisions:
  - "localHomeState treats any non-zero git exit other than a timeout as 'no-home' (the same reading resolveRemote has of 'none'), and a timeout or a missing git as 'unknown' so the control keeps what it says"
  - "refreshSyncHome does nothing until the editor has created the project's sync runtime (at activation), and re-checks isEnabled after the git call so a turn-on that finished meanwhile is never overridden"
  - "The scheduler's private offline sentence is removed; the transport's sentence ('Could not reach your git host. Your work here is safe; sync will try again.') is the single wording"

patterns-established:
  - "Tests that read the source (wiring checks) for the places a refresh must be called, as the project already does for chat.ts"

coverage:
  - id: D1
    description: "A project with no git repository or no remote shows 'No online home · Set up' as soon as the panel opens, from a local check, without a click"
    requirement: SYNC-09
  - id: D2
    description: "While sync is off the control follows a remote appearing or going; with sync on the scheduler's state is never overridden"
    requirement: SYNC-09
  - id: D3
    description: "A failure reads the same in the toast and on the control; an automatic sync without a sign-in still says 'Sync needs you to sign in. Choose Sync Project Now.'"
    requirement: SYNC-05
---

# Phase 27 Plan 24: No online home on panel open, one sentence per failure Summary

**The sync control reads "No online home · Set up" the moment the panel opens in a folder with no remote (git's remote list only), and every sync failure has one sentence shared by the toast and the control.**

## Performance

- **Tasks:** 2 (a tracer and a TDD task), 4 commits (RED then GREEN for each)
- **Files modified:** 5, all inside the plan's `files_modified`

## What was built

- **Task 1 (tracer, G-27-4b).** `localHomeState` runs one local `git -C <root> remote`. `SyncScheduler.setHomeKnown` publishes `no-home` (with the existing sentence) or `off` only while sync is off and only on a change. `refreshSyncHome(root)` runs at activation (after the setting is read), after the online-home, turn-on and turn-off commands, and from `chat.ts` on panel set-up and on `chat-ready`; the existing `onSyncStatus` listener posts the result. A project-scenario extension-host test waits for a `sync-status` message with state `no-home`, label "No online home · Set up" and action `set-up-home`, and checks no `.git` appeared.
- **Task 2 (G-27-4d wording).** `statusSentence(outcome, interactive)` returns the transport's failure sentence, except `auth` on an automatic sync (`Sync needs you to sign in. Choose Sync Project Now.`), and `outcome.message` when there is no failure. The scheduler's `settle()` publishes it; the `nearAi.sync.now` warning toast uses `statusSentence(outcome, true)`. The `COULDNT_REACH` copy is gone.

## Verification

- `npx tsc -p tsconfig.json` and `npm run lint`: clean.
- `node --test dist/test/syncFlows.test.js dist/test/stateSyncGit.test.js dist/test/syncControl.test.js dist/test/pickup.test.js`: 97 tests, 0 failing (Task 1 run: syncFlows, syncControl, pickup, 84 tests, 0 failing). 6 new Task 1 tests and 3 new Task 2 tests.
- **The extension-host e2e (`npm run test:e2e`) was written and compiles, but was NOT run by this executor**, per the wave rule; the orchestrator runs it once after the merge. The new no-home test and the plain-scenario "writes nothing" test are the ones to watch.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Test expectations] Two existing syncFlows tests expected the scheduler's own wording**
- **Found during:** Task 2 (RED)
- **Issue:** the offline test expected "Couldn't reach your git host, will retry."; the auth test passed a throwaway failure message 'x' and clicked (interactive), which now correctly shows the transport's sentence.
- **Fix:** the offline test now expects the transport's sentence (the plan's behavior says to update it); the auth test now gives the failure its real sentence and drives the automatic path (`runEnded`) to check the sign-in sentence.
- **Files modified:** src/test/syncFlows.test.ts
- **Commit:** a80b4e5

None other. No files outside `files_modified` were touched; STATE.md and ROADMAP.md were not changed.

## Known Stubs

None.

## Threat Flags

None. The panel-open check runs only the local `remote` listing through the existing `runStateGit` runner (T-27-104); failure text still goes through `plain()` redaction and is the transport's fixed sentences (T-27-105).

## Commits

- 9d8fed1 test(27-24): no online home from panel open, from a local check only (RED)
- a5620bc feat(27-24): no online home from panel open, from a local check only (GREEN)
- a80b4e5 test(27-24): one sentence per sync failure, in the toast and on the control (RED)
- dd47a24 feat(27-24): one sentence per sync failure, in the toast and on the control (GREEN)

## Self-Check: PASSED

All five modified files exist and all four commits are ancestors of HEAD.
