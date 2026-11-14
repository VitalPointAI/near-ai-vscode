---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 31
subsystem: state-sync
tags: [sync, join, review-gap-closure, locks, data-loss]
requires: ["27-28", "27-30"]
provides:
  - "SyncEnv.runsLive; enterCodeFlow refuses while a chat runs here or in another editor and joins inside syncOwnerFor(root).run"
  - "catchUpFromPrevious(root, from, to, previous, copied?, { writer? }) and FileSnapshot"
  - "AdoptResult.notCarried and AdoptResult.copied; not-carried.json marker inside the kept folder"
  - "state.previous-<UTC time>-<hex> names; recoverInterruptedAdoption picks the newest by time (modification time for older names)"
  - "discardPreviousState(root, threads?) removes a kept folder only when every conversation in it is in the joined state and nothing was marked as not carried"
  - "ThreadStore drops its caches when the state id it reads changes"
affects: [27-36]
tech-stack:
  added: []
  patterns: ["join as one operation of the project's sync owner", "catch-up by file snapshot taken before the copy", "a marker inside the kept folder, so a folder that holds the only copy is never discarded"]
key-files:
  created:
    - src/test/joinSafety.test.ts
  modified:
    - src/services/syncFlows.ts
    - src/services/syncCommands.ts
    - src/services/stateRestore.ts
    - src/services/threadStore.ts
    - src/test/syncFlows.test.ts
key-decisions:
  - "A conversation that cannot be carried is recorded in not-carried.json inside the folder kept from before the join, and a folder with that marker is never removed. By thread-folder id alone, an archived thread kept only online (no folder on disk) or an unreadable thread whose id also exists online would not have kept the folder."
  - "The discard after a scheduler sync runs only for mode 'sync' with outcome 'synced': a pull-only sync does not push the joined state, so it is no proof the joined conversations are online."
  - "The first refusal (before the code is asked) applies only when this computer already has a state folder; a computer with none cannot lose anything to a join. The same check is made again under the lock, so a run that starts after the question was answered still stops the join."
  - "If the not-carried marker cannot be written after the swap, the swap is undone (the join fails), because an unmarked folder could later be removed."
requirements-completed: [SYNC-04, SYNC-05]
status: complete
commits: 2
plan_head_before: 3eee70affaa882ca1b44b16f0db937aef53ebc47
plan_head_after: 25931c0b897c21edfaee3e01b5bc907aa13a3c5d
actuals:
  tokens: 14000
  tasks: 2
  commits: 2
completed: 2026-11-14
---

# Phase 27 Plan 31: Join safety Summary

A join now waits for running chats, holds the project's sync lock from the copy to the catch-up, carries lines another editor wrote in between, and never deletes a folder that holds a conversation the joined state lacks.

## What changed

- `syncFlows.ts`
  - `SyncEnv.runsLive?: () => Promise<boolean>`. `enterCodeFlow` asks it after `recoverInterruptedAdoption` and before the code is asked (when this computer has a state folder), and returns `refused` with: "A chat is running in this project, in this editor or another one. Enter the recovery code again when it has finished. Nothing was changed."
  - The join (adopt, `adoptDataKey`, `storeRecoveryWrapIfNewer`, `catchUpFromPrevious`) runs as one operation of `syncOwnerFor(env.root).run(...)`; runs are checked again inside it. A `StateBusyError` reads "A sync of this project is running. Enter the recovery code again in a moment. Nothing was changed." The first sync after the join starts after the operation returned.
  - The not-carried sentence is appended to the restored or pending message; `discardPreviousState(root, env.threads)` replaces the unconditional discard.
- `stateRestore.ts`
  - `adoptRemoteIdentity` collects `notCarried` (locked, kept only online, or `readOldThread` gave nothing), takes a size and modification-time snapshot of the carried files, `threads/` and `archive/` before reading, names the kept folder by UTC time, and writes `not-carried.json` into it after the swap (undoing the swap if that fails).
  - `catchUpFromPrevious` re-reads only threads whose files are new or changed since the snapshot (all of them without one), adds missing entries to the joined state with the joined key (union by entry id through `importThread`), and copies changed plain files again. Ids it cannot read again are returned and added to the marker.
  - `recoverInterruptedAdoption` orders previous folders by the time in the name, by modification time for older names. `discardPreviousState` described above.
- `threadStore.ts`: `followState(stateId)` called from `readMaterial` and `writeMaterial` drops all caches when the state id changes.
- `syncCommands.ts`: `env.runsLive` from `runsInFlight(root)` and `markers.liveRuns()`; after a `sync` (not pull) that returns `synced`, `void discardPreviousState(root, parts.threads)`.

## Verification (memory-capped, targeted)

- Task 1 set (joinSafety, syncFlows, threadLog, stateTwoMachines, runMarkersForeign): 90/90 pass.
- Task 2 set (joinSafety, syncFlows, threadArchive, historyRetention): 83/83 pass; joinSafety alone 11/11 after the last two tests were added (5 tests for Task 1, 6 for Task 2).
- Sweep of every `dist/test/state*.test.js` and `sync*.test.js` (21 files, one capped command): 269/269 pass, 0 cancelled. This includes `stateStores` and `stateRecovery`, which 27-30 listed as failing or changed.
- `npm run lint` (tsc --noEmit): clean.
- Mutation checks on the compiled output (source untouched): catch-up removed fails the late-write test; the owner run removed fails the held-lock test; `followState` disabled fails the stale-editor test; the discard rule disabled fails four Task 2 tests.
- Acceptance greps: `runsLive` 3 in syncFlows.ts and 1 in syncCommands.ts; `catchUpFromPrevious` 2 and `notCarried` many in stateRestore.ts; `discardPreviousState` 2 in syncCommands.ts.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] A marker file keeps a folder that no id can describe**
- **Found during:** Task 2 design
- **Issue:** the plan's id rule (thread and archive folder names) cannot protect an archived thread kept only online (there is no folder for it) or an unreadable thread whose id also exists in the joined state.
- **Fix:** `not-carried.json` inside the kept folder; a folder with it is never discarded. The id rule stays as the second check.
- **Commit:** 5b5f4a0

**2. [Rule 1 - Test fixture] A damaged thread is not "locked" in the index**
- **Found during:** Task 2 tests
- **Issue:** the index cache still lists a thread whose meta and log were overwritten, so `locked` is not set; it is the read that fails.
- **Fix:** the test asserts the thread cannot be read instead. The join counts it as not carried either way.
- **Commit:** 25931c0

**3. [Plan wording] The scheduler path is tested through `discardPreviousState`**
- `runOnce` lives in `syncCommands.ts`, which imports vscode, so it cannot run on plain node. The test runs a real sync through `buildStateSync(...).sync()` and then calls `discardPreviousState(root, threads)`, which is exactly what `runOnce` calls.

**4. [Process] Both tasks' source landed in the first commit**
- Both tasks edit the same functions in `stateRestore.ts` and `syncFlows.ts`, so the Task 1 commit (5b5f4a0) holds all source and the tests that existed then; the second commit (25931c0) adds the remaining joinSafety tests and the syncFlows assertion.

No existing test was changed except one added assertion in syncFlows.test.ts (the ordinary join says nothing about conversations that were not carried).

## Deferred Issues

- A write by another editor in the instant between the two renames (state folder missing) would make `home.ensure()` create a fresh folder and the second rename fail, which undoes the join. The window is a few microseconds and a failed join leaves the original intact; closing it fully needs ThreadStore writes to take a lock, which is outside this plan.
- Re-copying of the sealed profile-key copies (`keys/api`) written during a join is not done; they are re-sent by the next sync.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-27-127, T-27-128 and T-27-129 are mitigated and covered by the tests above.

## Next Phase Readiness

Plan 27-36 (README troubleshooting), exact sentences:

- Running chat: "A chat is running in this project, in this editor or another one. Enter the recovery code again when it has finished. Nothing was changed."
- Sync busy: "A sync of this project is running. Enter the recovery code again in a moment. Nothing was changed."
- Not carried, plural: "N conversations on this computer could not be added to the online project, because they could not be opened here. They are kept beside this project's saved state, and nothing was deleted."
- Not carried, one: "1 conversation on this computer could not be added to the online project, because it could not be opened here. It is kept beside this project's saved state, and nothing was deleted."
- The kept folder is `.near-ai/state.previous-<UTC time>-<hex>`; it holds `not-carried.json` when something could not be carried and is then never removed by the extension. Docs should say it can be deleted by hand once those conversations are opened elsewhere.

## Self-Check: PASSED

- src/test/joinSafety.test.ts found; commits 5b5f4a0 and 25931c0 are ancestors of HEAD.
