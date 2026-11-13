---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 34
subsystem: run-liveness
tags: [review-gap-closure, run-markers, migration, activity, sync]
requires: []
provides:
  - "chat.ts: RUNNING_ELSEWHERE_HOLD, setFollowElsewhereMs, the hold on send, open-command, Resume, Dismiss and Continue, followElsewhere(tab), run-marker stores disposed with the extension"
  - "stateMigration.ts: stampedAsMigrated (open markers get <editor id>.migrated), MIGRATION_RETRY_FIRST_MS, MIGRATION_RETRY_MAX_MS, MigrationExtras.now"
  - "activityStore.ts: closeInterrupted options { only, onSkipped }, recheckSkipped, setActivityRecheckMs"
  - "runMarkers.ts: WRITER exported"
affects: [27-36]
tech-stack:
  added: []
  patterns: ["one conversation is run by one editor at a time", "an unreadable run is looked at again on a timer, not left until the next reload"]
key-files:
  created: []
  modified:
    - src/services/chat.ts
    - src/services/stateMigration.ts
    - src/services/activityStore.ts
    - src/services/runMarkers.ts
    - src/test/chatSendPath.test.ts
    - src/test/stateMigration.test.ts
    - src/test/activityShared.test.ts
key-decisions:
  - "The hold sits at the start of a turn, before the user's message is logged, so a held message leaves nothing in the conversation's log, thread or run marker. Resume, Dismiss and Continue check it before they change anything (Dismiss would otherwise end the other editor's marker through settle())."
  - "A migrated marker is stamped only when the result is a valid writer id (WRITER pattern); a short test writer such as edA.1 leaves the marker as it was rather than making it unreadable."
  - "closeInterrupted keeps returning the count; the skipped ids come through an options callback, so every existing caller is unchanged."
  - "Each activity re-check tick uses a fresh ActivityStore, because the other editor wrote the file since the first store read it."
requirements-completed: [SYNC-07, SYNC-02]
status: complete
commits: 3
plan_head_before: f9aa544eb670822cedddc841d1bcb8bb7e2ca230
plan_head_after: 3b747750ba8079db19d0631921c0d0b439f14244
actuals:
  tokens: 13400
  tasks: 3
  commits: 3
completed: 2026-11-13
---

# Phase 27 Plan 34: Run liveness: hold, follow, migrated markers, back-off, activity re-check Summary

A conversation that another editor is running is no longer run from a second editor: send, Resume, Dismiss and Continue are held with one sentence, the waiting view reloads the conversation when that run ends, and the related migration and activity gaps are closed.

## What changed

**Task 1 (tracer), commit 5227208.** `chat.ts` asks `runMarkersFor(context, root).liveElsewhere(tab.id)` before a turn (send and open-command), and in `settleInterrupted` and `continueStopped` before they change anything. When it is live elsewhere the chat posts "This conversation is running in another editor right now. Wait for it to finish there, or start a new conversation here." and returns: no request, no log entry for the message, no thread write, no marker write. `followElsewhere(tab, root)` starts when `restoreInto` shows the running-elsewhere notice. It checks every 30 seconds (`setFollowElsewhereMs` is the test seam) with an unref'd timer; when the run is no longer live it reloads the conversation through `restoreInto` and shows it, so the newest steps appear and a run that was cut off shows Resume. It stops when the tab closes, when the tab starts a run of its own, when the panel is disposed, and when the extension's subscriptions are disposed. `runMarkersFor` pushes `{ dispose }` for each store it makes into `context.subscriptions`.

**Task 2, commit 901e872.** `migrateMarkers` stamps an open marker that has no writer with `<this editor id>.migrated` (version 2), so in this editor a run cut off by the upgrade is cut off at once (its process is gone) and counts as this editor's own run for automatic resume; another editor sees it as running elsewhere for 3 minutes and cut off after. An ended marker, or one with a writer, is left alone. `ensureMigrated` keeps the time and count of failures per project and waits 1 minute, doubling to 30 minutes; asks in between return undefined without running; each failure logs "State merge did not finish; it will be tried again in N minutes."; a success clears the entry. The clock is `MigrationExtras.now`.

**Task 3, commit 3b74775.** `closeInterrupted` takes `options.only` and `options.onSkipped`. `closeInterruptedRuns` remembers the sessions it skipped and re-checks only those every `FOREIGN_LIVE_MS` (unref'd timer, `setActivityRecheckMs` seam), closing each with the same "Run stopped" summary and its last activity as the end, and stops the timer when none are left. With nothing skipped no timer is made.

## Verification

Run one at a time under the memory cap (4G, no swap, choom 1000, timeout 900, 1536 MB heap).
- Task 1 command (chatSendPath, runMarkersForeign, autoResume, sidebarChat) plus conversations: 78 tests, 78 pass, 0 fail. 6 new chatSendPath tests.
- Task 2 command (stateMigration, runMarkersForeign, autoResume): 36 tests, 36 pass, 0 fail. 3 new stateMigration tests.
- Task 3 command (activityShared, activityStore, activity): 23 tests, 23 pass, 0 fail. 3 new activityShared tests.
- After all three: conversations plus chatSendPath, 37 pass, 0 fail.
- `npm run lint` (`tsc --noEmit`): exit 0.
- Acceptance greps: `liveElsewhere` in chat.ts 3 (at least 2); `followElsewhere` in chat.ts 6 (at least 2); `MIGRATION_RETRY_FIRST_MS` in stateMigration.ts present; `writerEditor(` in stateMigration.ts present.

## Deviations from Plan

### Auto-fixed

**1. [Rule 1 - Bug] A merge that failed at once was remembered forever.** In `ensureMigrated` the async function ran its `try` synchronously up to the first await, so a failure there deleted the run from the map before `runs.set` stored it, leaving the failed promise cached and the back-off unreachable. The function now yields once (`await Promise.resolve()`) before its work. The new back-off test found it.
- **Files modified:** src/services/stateMigration.ts
- **Commit:** 901e872

### Design choices within the plan

- The hold is placed before the user's message is logged (the plan said after the root and profile checks); a held message leaves no trace in the conversation's log. The check needs only the project root, so a project without a profile now sees the hold sentence first for a conversation running elsewhere, which is accurate.
- Dismiss is held as well as Resume: `RunMarkers.settle` would otherwise end the other editor's live marker.
- `WRITER` is now exported from runMarkers.ts so the migration can check that the stamp is a valid writer id.
- Continue was tested in the editor that ran the conversation (a 5-turn limit via a settings override), because Continue exists only in the tab whose run stopped short.

## Known Stubs

None.

## Threat Flags

None. T-27-135 (two editors running one conversation) is covered by the held-send, held-Resume/Dismiss and held-Continue tests (no request reaches the fake server and the thread and marker files are unchanged byte for byte). T-27-136 is covered by the migrated-marker test, T-27-137 by the back-off test.

## Next Phase Readiness

For plan 27-36 (README troubleshooting): when a message, Resume or Continue reaches a conversation that another editor is running, the chat says: "This conversation is running in another editor right now. Wait for it to finish there, or start a new conversation here." A reopened conversation that shows "running in another editor" checks again every 30 seconds while it is open and reloads itself when that run ends, with Resume if the run was cut off (3 minutes without a sign of life from the other editor).

## Self-Check: PASSED

- Commits 5227208, 901e872, 3b74775 are in HEAD's history.
- Files changed exist and compile (`npm run lint` exit 0).
