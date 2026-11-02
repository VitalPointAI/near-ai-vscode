---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 07
subsystem: team-session
tags: [team-mode, live-board, status-bar, auto-import, polling, accessibility]
requires:
  - phase: 62-work-model-gsd-import-team-board-live-read-and-move
    provides: 62-04 countReady, isCard, effectiveColumn and ItemHistory, 62-05 importPlans and importResultText, 62-02 remoteBranchHead
provides:
  - TeamSession.onStateChange, itemHistory, setBoardVisible, importPlans, boardStatus and canWrite
  - Automatic re-import for owner and lead windows (role-gated, once a minute, one notice per window)
  - The D-17 status bar (ready and pending counts, icons, tiers, accessibility information, per-state click target)
  - LiveTimers, withLiveTeam and pushFixturePlanning test helpers, and accessibilityInformation in the vscode stub
affects: [62-08, 62-09, 62-10, 62-11, 62-12, 62-13, 62-14]
actuals:
  tokens: 21100
  tasks: 3
  commits: 7
tech-stack:
  added: []
  patterns:
    - "The board-visible flag only changes what the scheduler's focused() reads; focusChanged and setBoardVisible both call scheduler.focusChanged with the combined value, so no timer is added"
    - "Imports go through one promise chain in the session, so the command and the automatic check never overlap and the later one finds nothing to write"
    - "statusText returns a view (text with icon, plain form for the channel, tooltip, accessibility label, command, tier) so the bar, the output lines and the tests read one source"
key-files:
  created:
    - src/test/teamBoardLive.test.ts
    - src/test/teamSessionImport.test.ts
    - src/test/helpers/teamLiveRig.ts
  modified:
    - src/services/team/teamSession.ts
    - src/services/team/teamStatusBar.ts
    - src/team/importPlans.ts
    - src/test/helpers/vscodeStub.ts
    - src/test/teamSession.test.ts
    - src/test/teamSessionMembers.test.ts
    - src/test/teamSoloParity.test.ts
    - src/test/teamCommands.test.ts
key-decisions:
  - "Opening the board while the window is unfocused syncs at once (the scheduler treats a focus gain as a run) and then polls at the focused interval; closing it moves the wait back to the unfocused delay, still with one timer"
  - "The automatic check remembers the last head it handled in memory and skips it, so a push that changes no planning file costs one ls-remote a minute and not a fetch each time"
  - "A failed automatic check is one output line per distinct reason through reportIssue and never a popup; a later good check clears it"
  - "canWrite means a device key for a member who is not removed; whether the log is reachable or trusted is the board's job through boardStatus"
  - "The refused-log tooltip starts with the UI-SPEC sentence and keeps the reason and the 'events are being ignored' note after it"
requirements-completed: []
requirements-advanced: [BOARD-01, BOARD-02]
coverage:
  - id: D1
    description: "Member A blocks a card and member B's materialised state shows it after exactly one of B's poll intervals and not before, with the change hook, card history from the first sync and no extra timer"
    requirement: BOARD-02
    verification:
      - kind: integration
        ref: "dist/test/teamBoardLive.test.js#tracer: member A blocks a card and member B sees it after exactly one poll interval and not before"
        status: pass
    human_judgment: false
  - id: D2
    description: "A poll with no new events notifies no listener, a throwing listener is reported once and never reaches the transport, own appends notify listeners and a disposed listener hears nothing"
    requirement: BOARD-02
    verification:
      - kind: integration
        ref: "dist/test/teamBoardLive.test.js#a poll that brings nothing new notifies no listener, and a listener that throws never reaches the transport"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardLive.test.js#the session own appends notify listeners too, and a disposed listener hears nothing more"
        status: pass
    human_judgment: false
  - id: D3
    description: "A visible board keeps the 15 s interval in an unfocused window with one timer, window focus and board visibility combine, and nothing about who looked reaches the output channel, the storage folder or the remote"
    requirement: BOARD-02
    verification:
      - kind: integration
        ref: "dist/test/teamBoardLive.test.js#a visible board keeps the focused poll interval in an unfocused window, creates no timer of its own and writes nothing about who looked"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardLive.test.js#window focus and board visibility combine: either one keeps the focused interval"
        status: pass
    human_judgment: false
  - id: D4
    description: "The status bar shows ready and pending counts with singular and plural forms, the team text without counts before any card exists, and a paused, untrusted or removed state with icon, tier, label and click target; icon syntax in a team name is escaped"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/teamBoardLive.test.js#status text with cards: ready and pending counts, singular and plural forms, the open-board target and an accessibility label"
        status: pass
      - kind: unit
        ref: "dist/test/teamBoardLive.test.js#paused, not trusted and removed states: icon, plain form, tooltip ending, tier, click target and an accessibility label that carries the action"
        status: pass
      - kind: unit
        ref: "dist/test/teamBoardLive.test.js#a team name that looks like an icon is shown as typed in the text, the tooltip and the label"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardLive.test.js#a session with no items shows the team text with the icon and a label; once the log has cards it shows the ready count from the same poll"
        status: pass
    human_judgment: false
  - id: D5
    description: "Owner and lead windows with a roadmap file import on their own, at most once a minute on the injected monotonic clock, with one notice per window; developers, windows with no key, autoImport false and folders without a roadmap never ask the remote; the command path still imports without the file"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "dist/test/teamSessionImport.test.js#tracer: an owner window imports after its first trusted sync, says so once, checks the remote at most once a minute and imports a later push without a second notice"
        status: pass
      - kind: integration
        ref: "dist/test/teamSessionImport.test.js#a developer, a window with no device key, a window with the check turned off and a folder with no roadmap never ask the remote; the command still imports in the last one"
        status: pass
    human_judgment: false
  - id: D6
    description: "A command import started during an automatic import waits for it and returns upToDate; a failed check writes one redacted line with no popup and recovers; boardStatus and canWrite follow sync, key, trust and removal"
    requirement: BOARD-02
    verification:
      - kind: integration
        ref: "dist/test/teamSessionImport.test.js#a command import started while an automatic import runs waits for it and finds nothing left to write"
        status: pass
      - kind: integration
        ref: "dist/test/teamSessionImport.test.js#a failed automatic import writes one redacted line, shows no popup, does not repeat for the same reason, and recovers on the next good check"
        status: pass
      - kind: integration
        ref: "dist/test/teamSessionImport.test.js#boardStatus is live after a good sync, offline with a reason after a failed fetch, paused when the log is not trusted and removed after removal; canWrite follows the device key"
        status: pass
    human_judgment: false
  - id: D7
    description: "The status bar reads clearly and the click lands on a working Open Team Board in a real editor window"
    requirement: BOARD-01
    verification: []
    human_judgment: true
    rationale: "The command nearAi.team.openBoard is registered by plan 62-08; until then a click has no handler, and how the icon, wording and colours read in a real theme needs eyes on a real window"
duration: about 22 min (started 2026-11-02T19:22Z)
completed: 2026-11-02
status: complete
plan_head_before: e9e2a4f48b865e0eb17c674b90e83e7bca19e8a9
plan_head_after: 537d0b31be768626374727e0999ca80712f6cb52
commits: 7
---

# Phase 62 Plan 07: Live board session Summary

**The team session now feeds a live board: a move by one member reaches another window in exactly one poll, a visible board keeps the fast poll without a new timer, owner and lead windows keep the board in step with the integration branch on their own, and the status bar shows how many plans are ready and who is waiting.**

## Performance

- **Duration:** about 22 min
- **Started:** 2026-11-02T19:22Z
- **Completed:** 2026-11-02T19:44Z
- **Tasks:** 3 (1 tracer, 2 auto), all TDD
- **Files:** 3 created, 8 modified (plus `dist` build output, which is not tracked)

## Accomplishments

- The tracer runs two members on two real clones under fake timers. The owner blocks `plan:90-02`; the developer's state still shows it unblocked until its one 15 000 ms timer fires, then shows it blocked with the reason, the change listener got the entry, and the card history starts with the blocked event and reaches back to the import. The card moves from the Ready column to Backlog because a blocked card is not ready (D-10, D-11).
- `TeamSession` subscribes to the transport before the first sync, feeds an `ItemHistory`, and tells `onStateChange` listeners about remote and own events. A throwing listener is reported once and never reaches the transport. `setBoardVisible` changes only what the scheduler reads, so there is still one timer.
- The status bar is rewritten to the D-17 table: `$(organization) Team: N ready · M pending` once cards exist, the team name before that, warning and error tiers with their backgrounds, accessibility information with role button, the Open Team Board click target while sync works and Verify Team Log otherwise, and `displayText` on teammate-authored text. The output channel gets a plain form with no icon syntax.
- Owner and lead windows with a roadmap file import automatically after a trusted sync: role check first, then one `ls-remote` at most every 60 000 ms of the monotonic clock, then `importPlans` only when the head differs from the recorded source. One notice per window; failures are one redacted line, no popup. `session.importPlans` queues behind any running import.
- `boardStatus` (`live`, `syncing`, `offline`, `paused`, `removed`, with the chip words) and `canWrite` are in place for the board adapter in plan 62-08.

## Task Commits

1. **Task 1: Tracer** - RED `e705e84` (test), GREEN `7a76a8a` (feat)
2. **Task 2: Status bar** - RED `2f103e7` (test), GREEN `5091dce` (feat)
3. **Task 3: Automatic import** - RED `4f74bcd` (test), GREEN `ca65f9a` (feat), test fix `537d0b3` (the offline assertion matched the coordination fetch by its first argument only, which the mirror's git calls do not start with; it was left out of the GREEN commit by mistake)

## TDD Gate Compliance

Each task has a `test(62-07)` commit before its `feat(62-07)` commit. RED evidence and semantic assessment:

- Task 1: the target tests ran and failed with `TypeError: b.session.onStateChange is not a function` and `setBoardVisible is not a function`, the planned reason (the API did not exist). Setup, git, roster and import ran to that point.
- Task 2: the new tests failed on the planned assertion, for example `actual: 'Team: Alpha (1 pending)'` against `expected: '$(organization) Team: 3 ready · 1 pending'`.
- Task 3: the import tests failed on `actual: 0, expected: 13` (nothing imported) and on the missing `importPlans`, `boardStatus` and `canWrite` methods.

The classifier command `gsd check tdd-red-evidence` was not run; the assessment above is the semantic inspection. The tracer gate (auto mode) re-ran the tracer verify command: it passed, so expansion went ahead.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] A fourth status bar pin in teamCommands.test.ts**
- **Found during:** Task 3, full team test run
- **Issue:** `teamCommands.test.ts` line 116 asserted the old text `Team: Command team`; the plan's pin list named three other files.
- **Fix:** Updated to the exact new string `$(organization) Team: Command team`, the same deliberate pin change as the listed ones (asserted, not loosened).
- **Files modified:** src/test/teamCommands.test.ts
- **Commit:** ca65f9a

**2. [Rule 3 - Blocking] More Phase 61 pins than the plan listed**
- **Found during:** Task 2
- **Issue:** The plan named some line ranges; the status bar change also touched the paused, rewritten, missing, not-trusted and removed assertions in teamSession.test.ts and teamSessionMembers.test.ts (for example the rewritten tooltip now ends with the Verify Team Log sentence).
- **Fix:** Every affected assertion was updated to the new exact string, with added checks for the click target and tooltip ending. None was loosened.
- **Files modified:** src/test/teamSession.test.ts, src/test/teamSessionMembers.test.ts
- **Commit:** 2f103e7

**3. [Rule 3 - Blocking] A shared test helper and one export**
- **Found during:** Task 1 and Task 3
- **Issue:** Both new test files need the same fake-clock timers, fixture push and team setup; the automatic gate needs to read the recorded source commit from the import state file.
- **Fix:** Added `src/test/helpers/teamLiveRig.ts` (not in the plan's file list) and exported `readImportState` from `src/team/importPlans.ts` (a one-word change).
- **Commit:** e705e84, ca65f9a

**4. [Plan wording slip] "effectiveColumn unchanged" for a blocked card**
- **Found during:** Task 1
- **Issue:** The behavior line says the effective column is unchanged after A blocks the card. A ready card that is blocked is no longer ready, so it shows in Backlog (D-10, D-11 and `effectiveColumn`).
- **Fix:** The tracer asserts the real rule: Ready before, Backlog after, and the stored state unchanged. No source change.

### Notes

- A first full run of the team test files showed the tracer failing once (6.9 s) while the suite ran in parallel; it passed in 8 parallel runs of its own file and in three further full runs. I could not reproduce the cause. As a precaution the helper now waits for the first poll timer to be armed before the tests assert on timers.

**Total deviations:** 3 auto-fixed (Rule 3), 1 plan wording slip. **Impact:** none on scope; every pin change asserts the new exact strings.

## Authentication Gates

None.

## Known Stubs

None. The `nearAi.team.openBoard` command named by the status bar is registered by plan 62-08; until then a click on the item has no handler (recorded under human judgment D7).

## Threat Flags

None. The new network call (`git ls-remote` of the integration branch) is the one the plan specifies, is role-gated before any git call, and its errors pass through the existing redaction.

## Self-Check: PASSED

- Created files exist: `src/test/teamBoardLive.test.ts`, `src/test/teamSessionImport.test.ts`, `src/test/helpers/teamLiveRig.ts`.
- Commits exist: e705e84, 7a76a8a, 2f103e7, 5091dce, 4f74bcd, ca65f9a, 537d0b3.
- Acceptance greps pass: `public setBoardVisible`, `public onStateChange`, `15_000` in the live test, `accessibilityInformation` in the bar and the stub, `OPEN_BOARD_COMMAND`, the `(1 pending)` pin with the icon, `remoteBranchHead(` in the session and `Imported 13 items to the Team Board.` in the import test.
- `npm run lint` exits 0; `node --test dist/test/team*.test.js` reports 873 pass, 0 fail (two runs after the pin fix).

## Next Phase Readiness

Ready for 62-08. The board adapter can use `onStateChange`, `itemHistory`, `setBoardVisible`, `boardStatus`, `canWrite` and `importPlans`, and must register `nearAi.team.openBoard`.
