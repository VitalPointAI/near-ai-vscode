---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 04
subsystem: state-sync
tags: [run-markers, heartbeat, writer-id, checkpoints, activity-history, double-spend, auto-resume]

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-03 stateHome.ts (stateHomeFor, ensure, paths.runs, paths.checkpoints, writeFileAtomic), src/domain/scratch.ts stateFolder, test fixtures tempProject/gitInit/gitStatus"
provides:
  - "src/services/stateHome.ts: MementoLike, editorWriter(globalState), writerEditor(writer)"
  - "src/services/runMarkers.ts: RunMarker version 2 (writer), HEARTBEAT_MS, FOREIGN_LIVE_MS, RunState, RunMarkerOptions.dir/.writer/.beforeWrite, RunMarkers.runState/.liveElsewhere/.markerOf/.idle/.dispose, ownEditorMarkers"
  - "src/agent/checkpoints.ts: snapshot format 2 ({rel} | {abs, outside}), RunCheckpointsOptions {root, beforeWrite}, load containment check"
  - "src/services/agentSession.ts: AgentConversation.worktreeRoot and .checkpointPrepare"
  - "src/services/activityStore.ts: mergeSessions, closeInterrupted(summary, liveElsewhere), closeInterruptedRuns(root, writer)"
affects: [27-05, 27-06, 27-07, 27-09, 27-10, 27-12, sync, restore, migration, team-mode]

requirements-completed: [SYNC-01, SYNC-07]

actuals:
  tokens: 14573
  tasks: 3
  commits: 3
plan_head_before: 6a95d4292a220a3565fe46aae404018e22e3ef33
plan_head_after: 81ef1f510795aa4aba1ea0b244846562ccd48720

tech-stack:
  added: []
  patterns:
    - "Run liveness across editors by writer id plus heartbeat: a pid is trusted only for markers of the same editor (same pid namespace); for any other editor the marker's activeAt decides, live while under 3 minutes old"
    - "Only the editor's own cut-off markers may reach autoResumeChoice; a foreign cut-off run is reopened with its Resume button and waits for a click"
    - "Stores that write below .near-ai/state take a beforeWrite hook that calls the state home's ensure(), so the inner .gitignore is the first file written"
    - "Checkpoint paths are root-relative inside the project and absolute-with-outside-flag elsewhere; a relative path is resolved against the current root and refused if it is absolute or climbs out"
    - "Shared history file: read, merge by session id (newer updatedAt, then more events, then memory), atomic write; stores of one process take turns"

key-files:
  created:
    - src/test/runMarkersForeign.test.ts
    - src/test/stateStores.test.ts
    - src/test/activityShared.test.ts
  modified:
    - src/services/stateHome.ts
    - src/services/runMarkers.ts
    - src/agent/checkpoints.ts
    - src/services/agentSession.ts
    - src/services/activityStore.ts
    - src/services/chat.ts
    - src/extension.ts
    - src/test/conversations.test.ts
    - src/test/runRecovery.test.ts

key-decisions:
  - "A marker is 'cut-off' for the same editor when its pid is gone, and for any other editor (or a version 1 marker with no writer) only after 180 s without a heartbeat; the pid of another editor is never consulted"
  - "Without a writer option RunMarkers uses a stand-in writer derived from the pid under the editor name 'legacy', so the old (storageDir, root) callers and tests keep the old pid behaviour"
  - "The 3-minute 'no run link' rule in closeInterrupted applies only when a liveElsewhere predicate is given, so callers without a writer behave exactly as in 0.4.19"
  - "Checkpoint files move to {format: 2, snapshots: [...]}; a bare array is format 1 and still loads"
  - "Run markers written to the old per-extension storage location by 0.4.19 are not read any more; only runs in the state home are recovered"

patterns-established:
  - "Pattern: tests that simulate a dead extension host rewrite the marker with a new instance id under the same editor id and a dead pid (killHost helper)"

coverage:
  - id: D1
    description: "A live run in editor A is 'running elsewhere' in editor B (even when B's own pid check says gone) and 'cut off' only after 4 minutes of silence; a heartbeat keeps it live for 10 minutes; after end() no heartbeat writes again"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/runMarkersForeign.test.js#tracer: a live run in editor A is running elsewhere in editor B, never cut off, never auto-resumed"
        status: pass
      - kind: unit
        ref: "dist/test/runMarkersForeign.test.js#a heartbeat keeps the run running elsewhere however long it lasts"
        status: pass
    human_judgment: false
  - id: D2
    description: "PERF-05 unchanged for this editor: after a reload its own cut-off run (pid gone) is cut off at once and still auto-resumes; a sibling window of the same editor with a live pid is left alone"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/runMarkersForeign.test.js#the same editor after a reload: a gone pid is cut off at once, a live one is left alone"
        status: pass
      - kind: unit
        ref: "dist/test/conversations.test.js#sidebar: with nearAi.agent.autoResumeAfterReload on, a cut-off run carries on by itself with a notice, keeping the step that finished"
        status: pass
    human_judgment: false
  - id: D3
    description: "SYNC-07: nothing resumes automatically because of another editor's marker; autoResumeChoice receives only this editor's markers and a foreign cut-off run keeps its Resume button; version 1 markers count as foreign and never auto-resume"
    requirement: SYNC-07
    verification:
      - kind: unit
        ref: "dist/test/runMarkersForeign.test.js#SYNC-07: only this editor's cut-off markers can resume by themselves; another editor's keeps its Resume button"
        status: pass
      - kind: unit
        ref: "dist/test/runMarkersForeign.test.js#a version 1 marker (no writer) still parses and counts as another editor's: cut off only after 3 minutes without activity"
        status: pass
    human_judgment: false
  - id: D4
    description: "Checkpoints in the state home are format 2 (root-relative inside, absolute marked outside), a second editor reverts them, a moved project resolves them against its new root, format 1 files still load"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/stateStores.test.js#checkpoints in the state home are format 2: inside the project root-relative, outside absolute and marked; a second editor reverts"
        status: pass
      - kind: unit
        ref: "dist/test/stateStores.test.js#a project moved to another path still reverts: relative paths are resolved against the current root"
        status: pass
      - kind: unit
        ref: "dist/test/stateStores.test.js#a format 1 checkpoint file (absolute paths only) still loads and reverts"
        status: pass
    human_judgment: false
  - id: D5
    description: "T-27-17: a relative checkpoint path that is absolute, empty, '.', or climbs out with '..' is dropped on load, so a revert never writes outside the project"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/stateStores.test.js#T-27-17: a relative path that climbs out of the root or is absolute is refused on load, so a revert never writes outside the project"
        status: pass
    human_judgment: false
  - id: D6
    description: "D-04: the first checkpoint and the first run marker in a fresh project create the inner .gitignore first; git status shows nothing from the state folder; sub-agent worktrees stay in the editor's storage"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/stateStores.test.js#D-04: the first checkpoint and the first run marker in a fresh project write the inner .gitignore before anything else, and git sees nothing"
        status: pass
      - kind: unit
        ref: "dist/test/stateStores.test.js#sub-agent worktrees stay in the editor's own storage, never inside the project"
        status: pass
    human_judgment: false
  - id: D7
    description: "Two editors share activity.json: both sessions and every event survive interleaved and concurrent writes; the newer copy wins; closeInterrupted leaves a session open while another editor keeps its run alive, and an unlinked session for 3 minutes"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/activityShared.test.js#two stores on one project, interleaved: the file ends with both sessions and every event of each"
        status: pass
      - kind: unit
        ref: "dist/test/activityShared.test.js#mergeSessions: the newer updatedAt wins, a tie goes to the copy with more events then to memory, and the union of ids never shrinks"
        status: pass
      - kind: unit
        ref: "dist/test/activityShared.test.js#closeInterruptedRuns(root, writer): a fresh marker from another editor keeps its session open; a silent one does not"
        status: pass
    human_judgment: false
  - id: D8
    description: "Real behaviour of a desktop VS Code and a code-server container on one host: the heartbeat timer actually firing every 30 s in an extension host, and the 'running in another editor' notice shown in the real chat view"
    verification: []
    human_judgment: true
    rationale: "Unit tests drive the heartbeat with mocked timers and model two editors as two writer ids over one temp folder; the timing in real extension hosts and the wording in the real view are owner-observable and not asserted by any test in this plan"

duration: 11min
completed: 2026-11-13
status: complete
---

# Phase 27 Plan 04: Run liveness across editors Summary

**Run markers and run checkpoints now live in the shared git-ignored state home with a writer id and a 30 s heartbeat, so a desktop VS Code never mistakes a live code-server run for a cut-off one (the pid of another editor is never consulted), nothing resumes by itself because of another editor's marker, and activity.json keeps both editors' sessions.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-11-13T14:10:00Z
- **Completed:** 2026-11-13T14:21:00Z
- **Tasks:** 3
- **Files modified:** 12 (3 created tests, 9 modified source and test files)

## Accomplishments

- Run markers are version 2 with `writer` (`<editor>.<instance>`, the editor id kept in globalState, the instance new per extension host) and a heartbeat that refreshes `activeAt` every 30 s while the run is live. `runState` gives `finished | running-here | running-elsewhere | cut-off`: the pid is consulted only for the same editor; for anyone else the run is live while its heartbeat is under 3 minutes old. The tracer proves a run in editor A reads as running elsewhere in editor B even when B's pid check says "gone", turns cut-off after 4 silent minutes, and stays live for 10 minutes while heartbeating.
- SYNC-07: `autoResumeChoice` is given `ownEditorMarkers(...)` only, in the chat's `ready()` block and in the emergency-stop notice. A cut-off run left by another editor reopens with its Resume button and runs only on a click. A version 1 marker (no writer) counts as foreign. A conversation whose run is live in another editor shows "This conversation is running in another editor right now..." and is not marked interrupted.
- Checkpoints are format 2 in `.near-ai/state/checkpoints/`: a file in the project is saved root-relative, one outside is saved absolute with `outside: true`. A second editor loads and reverts them; a project at a new path resolves against its new root; format 1 files still load. A relative path that is absolute, empty, `.` or climbs out with `..` is dropped on load (T-27-17). Sub-agent worktrees go to `AgentConversation.worktreeRoot` in the editor's own storage, never into the project.
- Every writer below `.near-ai/state` (markers, checkpoints) calls `ensure()` first through `beforeWrite`; a test with a fresh project shows the inner `.gitignore` exists before `runs/` or `checkpoints/`, and real git sees nothing.
- `activity.json`: `mergeSessions(disk, memory)` (newer `updatedAt`, then more events, then memory; union of ids) now carries the read-merge-write that was inline in `writeNow`, stores of one process take their turns on the file, and temporary names are random. `closeInterrupted(summary, liveElsewhere)` leaves a session open while another editor keeps its run alive (or, with no run link, while it was updated in the last 3 minutes); `closeInterruptedRuns(root, writer)` builds the predicate from the shared markers and is wired at activation and in the chat.

## Task Commits

1. **Task 1 (tracer): writer, heartbeat and runState; markers in the state home; own-editor-only auto-resume** - `faf1c13` (feat). Tracer verified end to end (runMarkersForeign 6 tests plus runRecovery, autoResume, conversations: 39 pass, 0 fail) before expansion.
2. **Task 2: checkpoints format 2, containment check, worktrees out of the project** - `9af0c5e` (feat)
3. **Task 3: activity.json with two writers, writer-aware closeInterrupted** - `81ef1f5` (feat)

**Plan metadata:** the docs commit that carries this SUMMARY, STATE.md and ROADMAP.md.

## Verification

- Plan tests: runMarkersForeign (7), stateStores (7), activityShared (5) all pass; conversations, agentFleet, activityStore, agentTools, agentBasics, runRecovery, autoResume, profileIndex still pass. `npm run lint` (tsc --noEmit) is clean.
- Full `dist/test/*.test.js` run once at the end under the memory cap: 1372 tests, 1343 pass, 9 skipped, 20 fail. One is the known `chatSendPath` "GSD slash command" failure. The other 19 are PDF, graphics, deck and MCP tests that stop with "Cannot find module .../vendor/..." because this worktree's `vendor/` was not built (only `tsc` was run, not `npm run compile`'s `vendor-libs` step). None touches markers, checkpoints or activity.

## Files Created/Modified

- `src/services/runMarkers.ts` - version 2 markers, heartbeat, runState, liveElsewhere, ownEditorMarkers, `dir`/`writer`/`beforeWrite` options, random temporary names
- `src/services/stateHome.ts` - `editorWriter`, `writerEditor`, `MementoLike`
- `src/agent/checkpoints.ts` - format 2, `root`/`beforeWrite` options, strict load with containment
- `src/services/agentSession.ts` - `worktreeRoot`, `checkpointPrepare`, root passed to checkpoints
- `src/services/activityStore.ts` - `mergeSessions`, per-file turn taking, writer-aware `closeInterrupted` and `closeInterruptedRuns`
- `src/services/chat.ts` - `runMarkersFor` over the state home, own-editor auto-resume, "running elsewhere" notice, checkpoint dir and worktree root, writer to `closeInterruptedRuns`
- `src/extension.ts` - writer to `closeInterruptedRuns` at activation
- `src/test/runMarkersForeign.test.ts`, `stateStores.test.ts`, `activityShared.test.ts` - new
- `src/test/conversations.test.ts`, `runRecovery.test.ts` - marker location and dead-host simulation updated (see Deviations)

## Decisions Made

See `key-decisions`. The one with consequences beyond this plan: markers 0.4.19 wrote into the extension's own storage are not read any more, so a run that was in flight at the moment of upgrading is not offered for resume.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Existing tests assumed the old marker location and the pid-only dead-host rule**
- **Found during:** Task 1
- **Issue:** `conversations.test.ts` read markers under `<globalStorage>/runs/<hash>` and simulated a dead host by changing only `pid`; `runRecovery.test.ts` pinned the exact marker key list. With markers in the state home and the writer rule, those simulations no longer described a dead host (same writer means running here; a different editor means heartbeat rules).
- **Fix:** `killHost` and the emergency-stop test now rewrite the marker with a new instance id under the same editor id plus a dead pid; the readers in those tests are given a writer of the same editor (`sameEditorMarkers`); `runRecovery` expects `writer` in the key list. No assertion was loosened.
- **Files modified:** `src/test/conversations.test.ts`, `src/test/runRecovery.test.ts`
- **Commit:** `faf1c13`

**2. [Rule 1 - Bug] Two stores in one process could overwrite each other's merged write**
- **Found during:** Task 3
- **Issue:** the existing `writeNow` already merged with the file, but two stores doing read-merge-write at the same moment (both read, then both write) lost one store's last event; the plan's interleaved test failed 5 events against 6.
- **Fix:** stores that share a file path take turns through a module-level queue.
- **Files modified:** `src/services/activityStore.ts`
- **Commit:** `81ef1f5`

**3. [Rule 2 - Missing critical] Containment check also rejects `.` and empty paths, and a missing root**
- **Found during:** Task 2
- **Issue:** the plan names `..` and absolute rel paths; a rel of `` or `.` would resolve to the root itself (a revert would try to write over the project folder), and a relative entry loaded with no root could resolve against the working directory.
- **Fix:** `resolveInside` refuses those, and a relative entry with no root is dropped.
- **Files modified:** `src/agent/checkpoints.ts`
- **Commit:** `9af0c5e`

### Process note on TDD

Tasks 2 and 3 are marked `tdd="true"`. The tests and the implementation were written in the same session and committed together per task, so there is no separate RED commit for them (Task 1's tracer tests were written before the implementation but also committed with it). Task 3's concurrency test did fail against the first implementation (5 events against 6) before the turn-taking fix, and Task 2's escape test failed once on a test-order mistake that was fixed in the test, not the code.

**Total deviations:** 3 auto-fixed (1 Rule 1, 1 Rule 2, 1 Rule 3) plus the TDD process note. **Impact:** no scope change.

## Known Limits

- Two editors are two processes; the turn-taking queue covers stores of one process only. A true cross-process overlap of two read-merge-write cycles can still drop the last change of one side. It heals when that side next saves the session (it holds the newer copy), and the history is a display record, not the source of money or run truth.
- The 180 s window assumes a live run heartbeats every 30 s. An extension host that is frozen for over 3 minutes (a stopped debugger, a suspended laptop) is shown as cut off elsewhere and its run keeps a Resume button; it is never resumed without a click.
- Runs cut off before the upgrade, whose markers are in the old per-extension storage, are not offered for resume.

## Threat Flags

None. The new read surface (other editors' markers, the shared activity file, checkpoint files) is the one in the plan's threat model (T-27-16, T-27-17, T-27-18 mitigated; T-27-19 accepted).

## Self-Check: PASSED

- Created files exist: runMarkersForeign.test.ts, stateStores.test.ts, activityShared.test.ts.
- Commits are ancestors of HEAD: `faf1c13`, `9af0c5e`, `81ef1f5`.
- Acceptance criteria re-run: runMarkersForeign 7 pass; `process.pid}.tmp` count 0; `ownEditorMarkers` in chat.ts 2; `new RunMarkers(context.globalStorageUri` 0; stateStores 7 pass; `worktreeRoot` in chat.ts 1; `path.join(storage, 'checkpoints')` 0; activityShared 5 pass; `mergeSessions` in activityStore.ts 2; `closeInterruptedRuns(projectRoot, ` in extension.ts 1.
