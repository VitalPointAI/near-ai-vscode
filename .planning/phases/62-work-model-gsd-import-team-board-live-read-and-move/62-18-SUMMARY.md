---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 18
subsystem: ui
tags: [team-mode, board, sidebar, team-section, g-62-1, flaky-test]
status: complete

requires:
  - phase: 61-17
    provides: "teamSectionModel's board slot (TeamBoardSummary, boardSummaryText)"
  - phase: 61-21
    provides: "createTeamSectionHost's boardSummary dependency, refreshed on session state change, handle change, own actions and visibility"
  - phase: 62-17
    provides: "the board is one editor tab only, so the sidebar's whole board surface is this line and Open board"
provides:
  - "src/domain/team/board.ts: boardSummary(state, viewerId), pure, built on buildBoardModel"
  - "src/services/team/teamCommands.ts: TeamModeHandle.boardSummary(), undefined with no session, before the board module loads, or for a removed member; the board domain module loads with the board view in bringUpBoard"
  - "src/extension.ts: createTeamSectionHost gets boardSummary: () => team.boardSummary()"
  - "src/services/team/teamSession.ts: sameFailureKey(reason), so a failure that differs only in a time or byte figure is not written again"
affects: [62-19, 62-20, 62-21, 62-22, 62-23, 62-24]

actuals:
  tokens: 7300
  tasks: 2
  commits: 5
plan_head_before: cb6d48180cbbcb545fba2ff717e65819d79c0604
plan_head_after: 9e49bc5e0509092355c689667eec27956fbaccba

tech-stack:
  added: []
  patterns:
    - "A sidebar number that summarises the board is computed from buildBoardModel, never counted separately, so it cannot disagree with the board"
    - "Dedupe keys for channel lines drop time and byte figures from git's reason; the line written keeps them"

key-files:
  created:
    - src/test/teamBoardSummary.test.ts
    - .planning/phases/62-work-model-gsd-import-team-board-live-read-and-move/62-18-SUMMARY.md
  modified:
    - src/domain/team/board.ts
    - src/services/team/teamCommands.ts
    - src/extension.ts
    - src/services/team/teamSession.ts
    - src/test/teamSectionHost.test.ts
    - src/test/teamSoloParity.test.ts
    - src/test/teamSession.test.ts
    - .planning/phases/62-work-model-gsd-import-team-board-live-read-and-move/deferred-items.md
    - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/deferred-items.md

key-decisions:
  - "boardSummary builds the board model with canWrite false: the counts do not read it, and it skips the per-card move checks, so a section refresh costs one plain model build (T-62-59)"
  - "Mine and Blocked leave out Done and Cancelled cards explicitly; Ready and Blocked still equal the board's counts, because the log refuses to mark a blocked card done and cancelling ends a block"
  - "The handle returns undefined for a removed member (isRemoved, a removedEvent on this member, or a removed board status), so a removed person never sees team numbers"
  - "The intermittent teamSession failure was a product bug, not a test fault: git's unreachable-remote reason carries the connect time, which moves with load, and the session's dedupe key included it. Fixed in the session with sameFailureKey; the original test's assertions are unchanged"

patterns-established:
  - "A test that needs git to fail differently each try wraps the session's GitRunner and rewrites only the failed results"

requirements-completed: [BOARD-01, BOARD-02]

coverage:
  - id: D1
    description: "boardSummary gives the board's own Ready and Blocked counts for the current milestone and the viewer's unfinished Mine cards"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/teamBoardSummary.test.ts#boardSummary gives the board's own numbers: Ready and Blocked as the board counts them, and the viewer's unfinished cards"
        status: pass
    human_judgment: false
  - id: D2
    description: "A lead's real session: undefined before it starts, then the board's numbers; the Team section posts model.board with the three numbers and the sentence, beside Open board; extension.ts wires the handle"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "src/test/teamBoardSummary.test.ts#tracer: a lead's running session gives the sidebar Team section a summary line with ready, blocked and mine counts"
        status: pass
      - kind: unit
        ref: "src/test/teamBoardSummary.test.ts#extension.ts gives the Team section host the Team Mode handle's board summary"
        status: pass
    human_judgment: false
  - id: D3
    description: "The rules: Done and Cancelled never count; a blocked Backlog card is blocked, not ready; another milestone counts nowhere; a developer's mine is their own board item only; observer and reviewer have 0"
    requirement: BOARD-02
    verification:
      - kind: unit
        ref: "src/test/teamBoardSummary.test.ts#Done and Cancelled cards never count: a finished or cancelled card of the developer's own is not theirs to do, and a done plan is not ready"
        status: pass
      - kind: unit
        ref: "src/test/teamBoardSummary.test.ts#a blocked card in Backlog counts as blocked and not as ready"
        status: pass
      - kind: unit
        ref: "src/test/teamBoardSummary.test.ts#cards of a milestone other than the current one count in neither ready nor blocked"
        status: pass
      - kind: unit
        ref: "src/test/teamBoardSummary.test.ts#a developer's mine counts the board item they added and nothing a lead added; an observer's mine is 0"
        status: pass
    human_judgment: false
  - id: D4
    description: "A teammate's block reaches the line after the lead's session syncs (ready one lower, blocked one higher), with no timer from the section, the section model or the summary"
    requirement: BOARD-02
    verification:
      - kind: integration
        ref: "src/test/teamBoardSummary.test.ts#a teammate blocks a ready plan: after the lead's session syncs, the line shows one fewer ready and one more blocked, with no timer of its own"
        status: pass
      - kind: unit
        ref: "src/test/teamBoardSummary.test.ts#the Team section host has no timer of its own: its refreshes come from the session, Team Mode, its own actions and visibility"
        status: pass
    human_judgment: false
  - id: D5
    description: "A removed member's handle gives undefined and the section shows the removed sentence with no board line and no button"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "src/test/teamBoardSummary.test.ts#a removed member's handle gives no summary, and the section shows the removed state with no board line"
        status: pass
    human_judgment: false
  - id: D6
    description: "A project without a team: handle.boardSummary() is undefined, and neither domain/team/board.js nor services/team/boardView.js is loaded after activation and a section refresh"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/teamSoloParity.test.ts#solo project: the Team Mode handle has no boardSummary, and activation plus a section refresh load neither board module"
        status: pass
    human_judgment: false
  - id: D7
    description: "A remote that stays down writes the paused line once, whatever connect time git reports (the intermittent teamSession failure)"
    verification:
      - kind: integration
        ref: "src/test/teamSession.test.ts#a remote that stays down is written once even when git reports a different connect time on every try"
        status: pass
      - kind: unit
        ref: "src/test/teamSession.test.ts#sameFailureKey leaves out only the time and byte figures of a git failure"
        status: pass
      - kind: integration
        ref: "src/test/teamSession.test.ts#an unreachable remote pauses with a redacted reason, backs off to 10 minutes, retries on focus and recovers"
        status: pass
    human_judgment: false
  - id: D8
    description: "In a real VS Code window the line shows under the Team section and follows a teammate's change"
    verification: []
    human_judgment: true
    rationale: "No e2e was run in this plan (its verification is unit and host level, and the machine is shared). The real-window repeat is 62-24 and the owner's hands-on check"

duration: 18min
completed: 2026-11-04
---

# Phase 62 Plan 18: Sidebar Board Summary Summary

**The sidebar Team section now shows "On the board: N ready, N blocked, N are yours." beside Open board. The numbers come from the running session through `TeamModeHandle.boardSummary()`, which calls a pure `boardSummary` built on `buildBoardModel`. A project without a team loads no board module. Also fixed: the intermittent teamSession failure. Its root cause was git's connect time inside the session's dedupe key.**

## Performance

- **Duration:** about 18 min
- **Started:** 2026-11-04T01:44:00Z
- **Completed:** 2026-11-04T02:02:00Z
- **Tasks:** 2 of 2, plus the extra flaky-test fix
- **Files modified:** 8 code and test files, 3 planning files

## Accomplishments

- G-62-1 sidebar half closed. `boardSummary(state, viewerId)` in board.ts is a thin pure function over `buildBoardModel`. Ready is the board's own count for the current milestone. Blocked and Mine are taken from the same shown cards, with Done and Cancelled left out. So the line always matches the board, and it reads no clock.
- `TeamModeHandle.boardSummary()` returns undefined in three cases: no session runs, the board module has not loaded yet, or this computer's member was removed. The board domain module loads in `bringUpBoard` with the board view, before `changed()` fires. A solo project loads neither.
- `extension.ts` passes `boardSummary: () => team.boardSummary()` to `createTeamSectionHost`. The host already calls it on every refresh, and the refreshes come from the session's state changes. So a teammate's change shows on the next sync, and no timer was added.
- Extra item: the teamSession test "an unreachable remote pauses ..." failed intermittently under load. The cause was in the product: `showStatus` deduplicated on `state:reason`, and git's reason contains "after 0 ms", which moves with load. `sameFailureKey` drops time and byte figures from the key. The original test is unchanged and now passes under load.

## Task Commits

1. **Task 1 (tracer): the summary line from a lead's running session**
   - `a422365` test(62-18): expect a board summary line from a lead's running session (RED)
   - `40d2b91` feat(62-18): the sidebar Team section shows ready, blocked and mine counts beside Open board (GREEN)
2. **Task 2: rules, live refresh, removed member, solo parity**
   - `6145c35` test(62-18): the board summary's rules, its live refresh after a teammate's change, and solo parity
3. **Extra: the intermittent teamSession failure**
   - `35ac2b9` test(62-18): a remote that stays down must be written once whatever connect time git reports (RED)
   - `9e49bc5` fix(62-18): a remote that stays down is written to the channel once, whatever connect time git reports (GREEN)

No REFACTOR commits were needed.

## TDD Gate Compliance

- **Task 1 RED** (`a422365`): `npx tsc -p tsconfig.json && node --test --test-reporter=tap dist/test/teamBoardSummary.test.js` exited 1 with 3 tests, 0 pass and 3 fail. `gsd-tools check tdd-red-evidence` returned RED_EVIDENCE_OK (target_test_failed) for the target "tracer: a lead's running session gives the sidebar Team section a summary line with ready, blocked and mine counts". Semantic assessment: the build compiled (the RED test read the new export and the handle method through a loose accessor). The target ran its real lead session and failed on its planned assertion "the Team Mode handle has boardSummary()" (expected 'function', got 'undefined'). The pure test failed on "board.ts exports boardSummary". The wiring test failed because extension.ts passed no boardSummary. There was no load, fixture or build fault.
- **Task 1 tracer gate (auto mode):** after GREEN the verify command ran again and passed 43 of 43, so expansion went ahead.
- **Task 2:** each behaviour was written as a test first. All 10 summary tests and the solo parity test passed on their first run, because Task 1's implementation already covered these rules. The plan's action expected this ("adjust ... where a case fails"). There was no RED, so the tests were checked by mutating the compiled code instead. Each mutation was caught by its target test:
  - Mine counting Done and Cancelled cards: caught by the Done and Cancelled test.
  - Ready counted over every milestone: caught by the other milestone test.
  - Blocked counted over every milestone: caught by the same test.
  - No removed-member check in the handle: caught by the removed member test.
  - The board module required when teamCommands loads: the new solo test and seven older solo tests failed.
- **Flaky-test RED** (`35ac2b9`): the new regression test failed with "the paused state is written once while it lasts: 4 !== 1" (RED_EVIDENCE_OK, target_test_failed), and the original test passed in the same run. Semantic assessment: the failure is the exact symptom from the full runs, made deterministic.
- **GREEN:** `40d2b91` passed 43 of 43. `9e49bc5` passed 23 of 23 in teamSession.test.js, and 38 of 38 with teamSessionMembers, 3 times in a row.

## Root Cause: the intermittent teamSession failure

- Symptom: "the paused state is written once while it lasts: 3 !== 1" (or 2 !== 1), only in full runs with other suites on the machine. It passed alone.
- Diagnosis: I printed the paused lines from a passing run. git's reason is "fatal: unable to access 'http://127.0.0.1:1/team.git/': Failed to connect to 127.0.0.1 port 1 after 0 ms: Could not connect to server". `TeamSession.showStatus` writes a line when `state:reason` changes. On a loaded machine the connect time is 1 to 3 ms on some polls, so those polls looked like new failures and wrote the paused line again. It was not real-timer leakage and not an un-awaited tick. The test uses fake timers and waits for each scheduled retry. The bug is in the product, and it would also repeat the line in a user's output channel.
- Fix: `sameFailureKey(reason)` replaces "N ms", "N milliseconds", "N seconds", "N bytes" and "with N out of N bytes" with "#" for the key only. `showStatus`, `reportIssue` and the key-install warning check use it. The written line is unchanged. A different port, host or kind of failure is still new (unit test).
- Proof: the new test wraps the session's git runner so every failed fetch reports its own time. It failed 4 !== 1 before the fix and passes after. The original test passed 6 of 6 when 6 copies ran at once to load the machine. Its assertions were not changed.

## Files Created/Modified

- `src/domain/team/board.ts`: `boardSummary`.
- `src/services/team/teamCommands.ts`: the `TeamModeHandle.boardSummary` member, the lazy `summarize` load in `bringUpBoard`, and the handle method.
- `src/extension.ts`: the host gets the handle's summary.
- `src/services/team/teamSession.ts`: `sameFailureKey`, used by `showStatus`, `reportIssue` and the key-install warning.
- `src/test/teamBoardSummary.test.ts` (new): 10 tests covering the numbers, the tracer, the wiring, the rules, the live refresh with a timer-origin spy, the timer-free sources and the removed member.
- `src/test/teamSoloParity.test.ts`: the solo case for the summary and the board modules.
- `src/test/teamSectionHost.test.ts`: the two fake handles gain `boardSummary: () => undefined` for the widened interface.
- `src/test/teamSession.test.ts`: the regression test and the `sameFailureKey` unit test.
- Both phases' `deferred-items.md`: the flaky entry is marked resolved, with its root cause.

## Decisions Made

See key-decisions in the frontmatter.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The test fakes of TeamModeHandle needed the new method**
- **Found during:** Task 1 GREEN
- **Issue:** `soloHandle()` and `teamHandle()` in teamSectionHost.test.ts build `TeamModeHandle` object literals. After the interface gained `boardSummary()` they stopped type-checking.
- **Fix:** each fake gained `boardSummary: () => undefined`. No assertion changed.
- **Files modified:** src/test/teamSectionHost.test.ts
- **Commit:** 40d2b91

**2. [Rule 1 - Bug] The key-install warning compared the stored dedupe key with the raw text**
- **Found during:** the flaky-test fix
- **Issue:** after `reportIssue` started storing `sameFailureKey(text)`, the `before !== text` check in the key install path would always differ when the text carries a figure. The warning would then show on every try.
- **Fix:** the check compares `before !== sameFailureKey(text)`.
- **Files modified:** src/services/team/teamSession.ts
- **Commit:** 9e49bc5

**3. [Scope - requested extra] The intermittent teamSession test**
- Not part of 62-18's plan. It was requested by the orchestrator and committed separately (35ac2b9 test, 9e49bc5 fix).

---

**Total deviations:** 2 auto-fixed, plus 1 requested extra. **Impact:** no assertion was weakened. The only product change outside the plan is the dedupe key.

## Issues Encountered

- `--test-name-pattern` with the tap reporter ran every test of the file in the mutation checks, which made those runs longer. Each mutation was still caught by its target test.

## Verification

- Task 1: `npx tsc -p tsconfig.json && node --test dist/test/teamBoardSummary.test.js dist/test/teamSectionHost.test.js dist/test/teamCommands.test.js` gave 43 tests, 43 pass, 0 fail. `grep -c boardSummary src/extension.ts` = 2, and `export function boardSummary` is in board.ts.
- Task 2: `npx tsc -p tsconfig.json && node --test dist/test/teamBoardSummary.test.js dist/test/teamSoloParity.test.js dist/test/teamSectionHost.test.js dist/test/extensionActivate.test.js` gave 38 tests, 38 pass, 0 fail. `grep -c "^test(" src/test/teamBoardSummary.test.ts` = 10, and `grep -c boardSummary src/test/teamSoloParity.test.ts` = 4.
- board.ts has no vscode import.
- Flaky fix: teamSession.test.js passed 23 of 23. teamSessionMembers.test.js plus teamSession.test.js passed 38 of 38, 3 runs in a row. The original test passed 6 of 6 when run 6 at a time.
- Full suite (`npm test` under MemoryMax=6G, timeout 1800): 1843 tests, 1832 pass, 0 fail, 11 skipped. The 11 skips are the existing environment skips plus the PR #7 parity seam. 62-17 had 1830 tests, and this plan adds 13.
- No e2e run in this plan (see coverage D8).

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat register.
- T-62-59 is accepted, and the cost is lower than planned: the summary builds the model with canWrite false, which skips the per-card move checks, and adds no timer (the timer-origin spy and the source check prove it).
- T-62-60 is mitigated: the board domain module loads only in `bringUpBoard`, and teamSoloParity asserts neither board module is loaded in a solo project.
- T-62-SC is mitigated: no installs.

## User Setup Required

None.

## Next Phase Readiness

- The sidebar's board surface is now complete: the one line plus Open board. 62-19 to 62-24 can rely on `TeamModeHandle.boardSummary()` and on board.ts's `boardSummary` matching the board.
- The full suite has no known intermittent failure left from this entry.

## Self-Check: PASSED

- src/test/teamBoardSummary.test.ts and this SUMMARY exist.
- Commits a422365, 40d2b91, 6145c35, 35ac2b9 and 9e49bc5 are ancestors of HEAD.

---
*Phase: 62-work-model-gsd-import-team-board-live-read-and-move*
*Completed: 2026-11-04*
