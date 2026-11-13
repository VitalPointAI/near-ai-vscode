---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 07
subsystem: state-sync
tags: [thread-archive, retention, cold-objects, aead, crash-safety, d-08, run-end-hook, history]

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-05 ThreadStore (log, context, meta, index.enc, scan, locked listing); 27-06 history list and index state labels, restore() from the log; 27-03 objects.ts (sealObject/openObject), stateKeys, stateHome (paths.archive); 27-04 RunMarkers (runState)"
provides:
  - "src/domain/state/retention.ts: LIVE_CONVERSATIONS_DEFAULT/MIN/MAX, clampLiveConversations, rankThreads"
  - "src/services/threadArchive.ts: archiveThread, unarchiveThread, reconcileArchives, applyRetention, protectedThreadIds, readArchive, archiveMeta, ArchiveBundle"
  - "src/services/threadStore.ts: archived state decided by the files, transparent unarchive on entries/lines/load, archive support methods (archiveKeys, archivedIds, liveSnapshot, removeLive, restoreLive, appendArchiveDelta, archiveDeltaEntries, serial/isBusy), exported validMeta/validEntry"
  - "src/services/runEndHooks.ts: RunEndedEvent, onRunEnded, runEnded"
  - "src/services/settings.ts: readHistoryLimits"
  - "src/services/runMarkers.ts: liveRuns"
  - "src/services/chat.ts: runEnded after endRun, retention on run end, at start and after a thread is opened from history"
affects: [27-10, 27-13, history-view, sync]

requirements-completed: [SYNC-01]

actuals:
  tokens: 18190
  tasks: 3
  commits: 4
plan_head_before: 25a80a07e11279d1ab6f2a379226be9be024cec0
plan_head_after: 342cf873b111e7804cc87c83d8d1469fc1c01484

tech-stack:
  added: []
  patterns:
    - "Archive = one sealed bundle { format, entries, context, meta } per thread in the bundle-object format (sealObject class 'cold'), parts listed in a plaintext parts.json written last; the archive of a thread is opened with openObject and must name the same thread in meta and every entry"
    - "Archive is write, reopen and compare (entry id set and tip), then remove; removal is refused when the live files changed since the snapshot (a stamp over log size, context.enc and meta.enc), so a thread that was used meanwhile is never taken out from under its user"
    - "Placement is decided by the files, not by the index cache: a live meta means live, an archive without one means archived; a crash between the two steps never leaves the list wrong"
    - "Per-thread serial work (ThreadStore.serial) so an archive, a reopen and a reconcile of one thread never overlap; applyRetention calls on one store are chained"

key-files:
  created:
    - src/domain/state/retention.ts
    - src/services/threadArchive.ts
    - src/services/runEndHooks.ts
    - src/test/threadArchive.test.ts
    - src/test/historyRetention.test.ts
  modified:
    - src/services/threadStore.ts
    - src/services/settings.ts
    - src/services/chat.ts
    - src/services/runMarkers.ts

key-decisions:
  - "Reopening a thread from the history (or any read of an archived thread) touches it: its lastUsedAt becomes now, so it ranks first and the lowest-ranked live thread is archived in its place. A restore the rank rule or a crash recovery asks for keeps the thread's own last-use time, so retention cannot reorder the threads it is placing"
  - "applyRetention also brings back an archived thread the rank rule puts among the live ones (the setting was raised, or the thread was continued elsewhere), as Pattern 12(c) expects; it does so without counting that as a use"
  - "A removal of the live files is refused if the log size, context.enc or meta.enc changed since the snapshot the archive was made from; the thread is then simply not archived this time, and the next pass retries"
  - "Protection is the union of the tab ids of every chat of this editor (a module-level registry of tab-id sources, since the side view and the panel are separate chats) and every conversation whose marker is running here or elsewhere (RunMarkers.liveRuns)"
  - "delta.jsonl next to an archive holds sealed entry lines in the log's own format (purpose 'thread-entry', thread id as AAD), written through ThreadStore.appendArchiveDelta; plan 13 can use that unchanged"
  - "A refused archive (modified part, wrong thread, no key) leaves the archive in place and reads as an empty thread: the person is told the conversation is no longer saved here (existing history-error path)"

coverage:
  - id: D1
    description: "The sixth thread archives the oldest into archive/<id>/ (parts.json plus sealed parts) and its live folder is removed; it is still listed, with its title and state archived"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadArchive.test.js#the sixth thread archives the oldest: its live folder goes, the archive holds sealed parts, and it is listed archived with its title"
        status: pass
    human_judgment: false
  - id: D2
    description: "Opening an archived thread returns every entry it had, makes it live with its context, removes the archive, and the now-oldest live thread is archived in its place"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadArchive.test.js#opening the archived thread returns every entry it had, makes it live, and the now-oldest live thread is archived in its place"
        status: pass
    human_judgment: false
  - id: D3
    description: "The archive is in the bundle object format: its parts open with openObject(dataKey, stateId, 'cold') and not as another class"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadArchive.test.js#the archive's parts open as bundle objects of class cold under the project's data key, and not as any other class"
        status: pass
    human_judgment: false
  - id: D4
    description: "Crash safety: a crash after the archive is written (live adds nothing: finished; live adds entries: made whole by union), in the middle of removing the live files (complete live thread), and for a thread that must stay live; no entry is lost"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadArchive.test.js#a crash after the archive is written but before the live files are removed: a live copy that adds nothing is finished, one that adds entries is made whole"
        status: pass
      - kind: unit
        ref: "dist/test/threadArchive.test.js#a crash in the middle of removing the live files (log removed, meta kept) leaves a complete live thread and loses no entry"
        status: pass
      - kind: unit
        ref: "dist/test/threadArchive.test.js#a thread that must stay live (open in a tab) is made live again by reconcile instead of being finished"
        status: pass
    human_judgment: false
  - id: D5
    description: "Prohibition (SYNC-01): no live copy is removed before the archive is written and verified, and a thread used while it was archived is left alone"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadArchive.test.js#when the archive cannot be written the live thread is untouched: nothing is removed before an archive exists and has been checked"
        status: pass
      - kind: unit
        ref: "dist/test/threadArchive.test.js#a thread used while its archive was being made is not removed: the live files are kept when they changed since the snapshot"
        status: pass
    human_judgment: false
  - id: D6
    description: "More than 50 threads are all kept and listed: sixty threads with five live give fifty-five archived, none deleted, each with a complete archive"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadArchive.test.js#sixty threads with five live leave sixty listed threads, fifty-five archived, and every archived thread has a complete archive"
        status: pass
    human_judgment: false
  - id: D7
    description: "Tampering: a modified archive part, or an archive of another thread put in this thread's folder, is refused; nothing is read or removed"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadArchive.test.js#a modified archive is refused: nothing is read from it, nothing is removed, and the thread stays archived"
        status: pass
      - kind: unit
        ref: "dist/test/threadArchive.test.js#an archive of another thread put in this thread's folder is refused"
        status: pass
    human_judgment: false
  - id: D8
    description: "The rank rule: the N most recent are live, equal times rank by id ascending, a protected old thread is live in addition, lowering and raising the count moves threads to and from the archive, and the setting's clamp and constants equal package.json"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/historyRetention.test.js#threads used at the same moment rank by id ascending, whatever order they arrive in"
        status: pass
      - kind: unit
        ref: "dist/test/historyRetention.test.js#the default, minimum and maximum equal what package.json declares for nearAi.history.liveConversations"
        status: pass
      - kind: unit
        ref: "dist/test/threadArchive.test.js#lowering the setting archives more and raising it brings them back without making them the most recently used"
        status: pass
    human_judgment: false
  - id: D9
    description: "A delta file next to an archive is folded in on reopen; the protected ids are the open tabs and the runs running here or elsewhere; a run-end listener that throws never breaks a run"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadArchive.test.js#a delta file next to an archive is folded in when the thread is opened, and the archive's own entries are all there too"
        status: pass
      - kind: unit
        ref: "dist/test/historyRetention.test.js#the protected ids are every open tab and every conversation whose run is running here or elsewhere, and no finished or cut-off one"
        status: pass
      - kind: unit
        ref: "dist/test/historyRetention.test.js#a run-end listener hears the event, and one that throws or rejects never breaks the others or the run"
        status: pass
    human_judgment: false
  - id: D10
    description: "chat.ts calls runEnded after each run, runs retention on that event, once at start and after a thread is opened from history, protecting every open tab of the editor; the wiring itself"
    requirement: SYNC-01
    verification: []
    human_judgment: true
    rationale: "chat.ts runs inside VS Code and no unit test drives the real send handler end to end with a state home; the pieces (protected ids, hook registry, applyRetention, the settings reader) are tested, the wiring is for the phase's manual check (open six conversations, confirm the oldest is listed 'Archived' and opens in full)"
---

# Phase 27 Plan 07: Thread archive and retention Summary

**The five most recently used threads of a project stay live and every older thread is archived inside the state home in the bundle-object format (brotli, Padme padding, AES-256-GCM, class 'cold'), written, reopened and compared before the live files go, reopened whole and live on request, never deleted; retention runs after each run, at start and after a history open, and leaves open and running threads alone.**

## Performance

- **Duration:** about 10 minutes of execution (4 commits, 10:34 to 10:38 local)
- **Tasks:** 3 (tracer, TDD task, wiring)
- **Files:** 5 created, 4 modified (9 touched with the tests)

## Accomplishments

- **Rank rule** (`retention.ts`): pure `rankThreads(index, liveCount, protectedIds)` (lastUsedAt descending, equal times by id ascending, protected ids live in addition) and `clampLiveConversations` (whole number 1 to 50, default 5 for anything not a finite number); constants equal the package.json declaration (tested by reading the file).
- **Archive** (`threadArchive.ts`): `archiveThread` seals `{ entries, context, meta }` with `sealObject(dataKey, stateId, 'cold', ...)`, writes the parts and then `parts.json`, reopens it, compares the entry id set and tip, and only then removes the live files (log, context, meta last) through `ThreadStore.removeLive`, which refuses when the live files changed since the snapshot. `unarchiveThread` unions the archive and its `delta.jsonl` into the live log, writes context and meta, checks the live set holds every archived entry, then removes the archive. A part of another thread, a modified part or a missing key is refused and nothing is removed.
- **Reconcile** (`reconcileArchives`): a live copy with no log is restored from the archive; one with entries the archive lacks (or a thread that must stay live) is made whole and its archive removed; one that adds nothing is finished. An archive that cannot be opened is left with the live copy.
- **Transparent reopen** (`threadStore.ts`): `entries`, `lines` and `load` unarchive an archived thread before reading; the list's state comes from the files, so a crash between the two steps never mislists a thread; an archive the index does not know is read for its meta.
- **Retention** (`applyRetention`): reconcile, then archive each thread beyond the rank one at a time, then bring back archived threads the rank puts live; calls on a store are chained. `readHistoryLimits()` reads the setting through the clamp; `runEndHooks.ts` is a registry whose listener failures never reach a run; `chat.ts` calls `runEnded` after `endRun()` and runs retention on that event, once at the end of `ready`, and after a thread is opened from history, protecting every open tab of this editor and every conversation whose run is running here or elsewhere.

## Task Commits

1. **Task 1 (tracer): the sixth thread archives the oldest; opening it brings it back whole and live** - `94e2fa9` (feat)
2. **Task 2 (TDD): rank rule, protection, setting clamp, crash safety, never pruned** - RED `85fb16f` (test), GREEN `bd75e80` (feat)
3. **Task 3: retention after each run and at start, open and running threads protected** - `342cf87` (feat)

## Deviations from Plan

### Auto-fixed / added

**1. [Rule 2 - Missing critical functionality] A run-marker listing so running threads can be protected**
- **Found during:** Task 3
- **Issue:** The plan protects "every conversation whose marker runState is running-here or running-elsewhere", but RunMarkers could only read one marker by conversation id.
- **Fix:** Added `RunMarkers.liveRuns()` (reads the marker folder, applies `runState`). `runMarkers.ts` is not in the plan's file list.
- **Files modified:** src/services/runMarkers.ts
- **Commit:** 342cf87

**2. [Rule 2 - Missing critical functionality] Protection spans every chat of the editor, and a history open runs retention**
- **Found during:** Task 3
- **Issue:** The side view and the panel are separate chats with their own tab lists; retention started from one would not see the other's open threads and could archive them. Also, opening an archived thread leaves six live until the next run ends.
- **Fix:** A module-level set of tab-id sources in `chat.ts`; `openSaved` runs retention after the thread is shown.
- **Files modified:** src/services/chat.ts
- **Commit:** 342cf87

**3. [Rule 2 - Missing critical functionality] A removal guard the plan did not name**
- **Found during:** Task 1
- **Issue:** Verifying the archive and then removing the live files leaves a gap in which the thread could be used; the plan's write-verify-remove did not cover it.
- **Fix:** `liveSnapshot` returns a stamp (log size, context.enc, meta.enc) and `removeLive` refuses when it differs; the thread is then not archived this time.
- **Files modified:** src/services/threadStore.ts
- **Commit:** 94e2fa9

**4. [Plan extension] applyRetention restores archived threads the rank puts live**
- The plan's `applyRetention` only archives. The historyRetention behavior ("back to 5 restores them") and Pattern 12(c) (an archived thread continued elsewhere ranks live) need the other direction too; it is done without touching `lastUsedAt` so retention cannot reorder what it places. Commit bd75e80.

**TDD note (Task 2):** the RED commit is partly red. The pure rank and clamp tests had no new code to wait for (the rank rule was part of Task 1's tracer), so they passed on first run; the five that failed did so for the intended reasons (reconcileArchives was a throwing stub, applyRetention did not restore, the settings reader did not exist). The Task 1 commit deliberately carries no reconcile, restore-by-rank or protected-ids code.

**Total deviations:** 3 auto-added (Rule 2) and 1 plan extension. **Impact:** all inside the plan's goal; no scope growth beyond what archiving never-losing-a-thread needs.

## Known Limits

- A refused archive (modified part, wrong thread) stays listed as archived with its title from the index and reads as an empty thread when opened (the existing "no longer saved on this machine" message); it is not shown as "locked" in the list, because telling would mean opening every archive at list time. The archive itself is untouched.
- Between the stamp check and the file removal inside `removeLive`, another editor of the same project could still append to the log; the window is a few file operations and there is no cross-process lock. Reconcile cannot recover an entry that never reached the archive.
- Editors with different `liveConversations` values on one computer would archive and restore each other's threads on every pass (placement is derived from the rule, as Pattern 12 describes); the default is the same everywhere.
- The wiring in `chat.ts` has no automated end-to-end test (no VS Code host); see coverage D10.

## Issues Encountered

None beyond the deviations above. `.planning/state.json` was already modified before this plan and was left alone. The `chatSendPath` "GSD slash command" failure is the known machine-specific one; the full suite is 1 500 tests: 1 490 pass, 9 skipped, 1 fails (that one).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 13 can push `archive/<id>/*.bin` unchanged as `cold` objects (the part names are random and the format is the bundle-object one) and write `delta.jsonl` through `ThreadStore.appendArchiveDelta`; plan 10 can call `applyRetention` at the end of migration.

## Known Stubs

None.

## Threat Flags

None. The surface is the archive folder and its files, which the plan's threat model covers (T-27-28 write-verify-remove and reconcile by union; T-27-29 sha256 plus AEAD plus thread identity checked; T-27-30 the same AEAD and padding as bundle objects, files 0600, folders 0700).

## Self-Check: PASSED

- Files: `src/domain/state/retention.ts`, `src/services/threadArchive.ts`, `src/services/runEndHooks.ts`, `src/test/threadArchive.test.ts`, `src/test/historyRetention.test.ts` exist.
- Commits `94e2fa9`, `85fb16f`, `bd75e80`, `342cf87` are ancestors of HEAD; `git rev-list --count 25a80a0..HEAD` is 4.
- Acceptance: threadArchive 15 of 15, historyRetention 11 of 11; `'cold'` in threadArchive.ts 4; `readHistoryLimits` in settings.ts 1; `runEnded(` in chat.ts 1; `applyRetention(` in chat.ts 1.
- Plan verification: tsc clean; full suite 1 500 tests with only the known failure.
