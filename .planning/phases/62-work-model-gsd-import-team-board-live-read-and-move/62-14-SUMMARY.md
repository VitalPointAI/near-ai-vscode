---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 14
subsystem: team-board-e2e-release
status: complete
tags: [team-mode, e2e, vscode-test, release-check, webview, phase-gate]

requires:
  - phase: 62-work-model-gsd-import-team-board-live-read-and-move
    provides: "boardTap hooks, OPEN_BOARD_COMMAND and IMPORT_PLANS_COMMAND, BOARD_SCRIPTS and BOARD_STYLES (62-08); the board client files (62-09 to 62-13); enableTeamMode, TeamLog, GitTransport and the importer (62-02 to 62-05); the session poll and nudge (62-07)"
provides:
  - "src/extension.ts: NearAiTestApi.team { handle, secrets, globalStorageDir }, returned only when NEAR_AI_E2E=1"
  - "src/test/e2e/run.ts: a third scenario 'team' on a git project with a bare remote and the fixture roadmap pushed on main"
  - "src/test/e2e/suite.ts: teamTests (enable, open board, import, move through the real page, refused move, second-client update) and a solo check appended to the project scenario"
  - "scripts/verify-release-content.mjs: the six media/board files are required entries"
  - "src/test/teamBoardAssets.test.ts: existence, release list, no dashes, no markup sinks or network, IIFE shape, no colour literals"
  - "BOARD-01, BOARD-02 (git half) and BOARD-03 ticked in REQUIREMENTS.md; 62-VALIDATION.md filled in and signed off for the automated part"
affects: [phase-63, phase-67]

actuals:
  tokens: 8700
  tasks: 3
  commits: 4
plan_head_before: cc43d6844e1d0026a688d18670d3f1835fb3f979
plan_head_after: 9c9b8abb2af5c95799d73a77ed72fbbc09985eef

tech-stack:
  added: []
  patterns:
    - "The e2e scenario drives the real page through boardTap.request (host-request passthrough) and observes both directions with boardTap.toView and fromView"
    - "A second client in the same host is a second TeamLog on its own mirror directory, signing with the owner's device key from SecretStorage"
    - "A test that depends on V8's address-space behaviour runs its check in a child started under the cap it protects"

key-files:
  created:
    - src/test/teamBoardAssets.test.ts
  modified:
    - src/extension.ts
    - src/test/e2e/run.ts
    - src/test/e2e/suite.ts
    - scripts/verify-release-content.mjs
    - src/test/teamBoardLive.test.ts
    - src/test/teamHarnessAddressSpace.test.ts
    - .planning/REQUIREMENTS.md
    - .planning/phases/62-work-model-gsd-import-team-board-live-read-and-move/62-VALIDATION.md

key-decisions:
  - "The host does not send a `state` message with `error` when the board model cannot be built (decision asked for in 62-09). Left as is: building the model reads only the in-memory, already verified state, a failure is written to the NEAR AI Team output, and the page shows the slow-load message with Try again and Show details after 10 seconds. A session that fails to start is reported by its own warning and the status bar. Revisit only if a real user reports a blank board."
  - "The session imports the roadmap when it starts, so in the e2e the cards are already on the board when Import Plans runs; the test therefore waits for any state with the cards and runs the command to show it can be repeated (it writes nothing)."
  - "The e2e uses a real local bare remote and the owner's own device key, so nothing in the scenario needs NEAR, the network or a signed-in user."

patterns-established:
  - "Counting coordination events on the remote with git rev-list --count refs/heads/near-ai/coordination to prove a refusal wrote nothing"

requirements-completed: [BOARD-01, BOARD-02, BOARD-03]

coverage:
  - id: D1
    description: "In a real VS Code, Team Mode enabled on a git project opens the board; the real board.js loads under the CSP, posts ready and receives a state with the imported cards"
    requirement: "BOARD-01"
    verification:
      - kind: e2e
        ref: "dist/test/e2e/run.js#[team] Team Mode is enabled and the real board page loads under the CSP and asks for its state"
        status: pass
      - kind: e2e
        ref: "dist/test/e2e/run.js#[team] the board shows the fixture roadmap, and Import Plans can be run again"
        status: pass
  - id: D2
    description: "A move sent through the real page reaches the host and shows the card on hold; a refused move produces a refused message and no new coordination event"
    requirement: "BOARD-03"
    verification:
      - kind: e2e
        ref: "dist/test/e2e/run.js#[team] a move sent through the real page reaches the host, and the next state shows the card on hold"
        status: pass
      - kind: e2e
        ref: "dist/test/e2e/run.js#[team] a refused move produces a refused message and writes no event"
        status: pass
  - id: D3
    description: "An event appended by a second client on another mirror appears in the open board after the session polls, with no reload"
    requirement: "BOARD-02"
    verification:
      - kind: e2e
        ref: "dist/test/e2e/run.js#[team] an event from a second client appears in the open board after the session polls, without a reload"
        status: pass
  - id: D4
    description: "Open Team Board in a project with no team opens no board and posts nothing; the project and plain scenarios are unchanged and pass"
    verification:
      - kind: e2e
        ref: "dist/test/e2e/run.js#[project] Open Team Board in a project with no team opens no board and posts nothing"
        status: pass
  - id: D5
    description: "Every board script and stylesheet exists, is on the release list and ships in the package; the assets keep their safety rules"
    verification:
      - kind: unit
        ref: "dist/test/teamBoardAssets.test.js"
        status: pass
      - kind: other
        ref: "npm run verify:release (260 entries, 50 required release assets)"
        status: pass
  - id: D6
    description: "Lint, the full npm test, the e2e command and verify:release all pass"
    verification:
      - kind: other
        ref: "npm run check: 1600 tests, 1590 pass, 0 fail, 10 skipped"
        status: pass
---

# Phase 62 Plan 14: Real-host proof of the Team Board and the phase gate Summary

A third e2e scenario proves the Team Board in a real VS Code (enable, open, import, move through the real page, refusal, another client's change arriving after a poll), the release check now requires the six board files, and the full gate ran green.

## Accomplishments

- **Test seam.** `NearAiTestApi.team` (the `TeamModeHandle` that `registerTeamMode` already returned, `context.secrets` and the global storage path) is returned only in the `NEAR_AI_E2E=1` branch, next to `auth` and `sidebar`. Production `activate` still returns `undefined`.
- **Team scenario.** `run.ts` prepares a git project on `main` with a local identity, the fixture roadmap copied to `.planning`, a bare remote as `origin` and `main` pushed. `teamTests()` runs six steps in the real host: activation registers every contributed command (including `nearAi.team.openBoard` and `nearAi.team.importPlans`); `enableTeamMode` returns ok and `nearAi.team.openBoard` leads to a `ready` from the real `board.js` and a `state`; the board holds `plan:90-01` in done and `plan:90-02` in ready; a `move` request sent through `boardTap.request` is re-posted by the real page with exactly that payload and the next state has `plan:90-02` in backlog with `held: true`; moving the done card `plan:90-01` to release gives a `refused` message with a reason and leaves the remote's coordination commit count unchanged; a second `TeamLog` on its own mirror (owner device key from SecretStorage) appends `item.blocked`, `session.nudge()` is called, and a later state shows the card blocked with that reason, with no reload.
- **Solo check.** One test appended to the project scenario: `nearAi.team.openBoard` with no team opens no board panel and `boardTap` sees no message in either direction. The earlier project and plain tests are untouched and pass.
- **Release content.** The six `extension/media/board/*` entries are required in `verify-release-content.mjs` (count 6, baseline 0). `teamBoardAssets.test.ts` (6 tests) checks the file list, the release list (a mutant that removed one entry fails it), no U+2013 or U+2014, no markup or network sinks, one strict IIFE per script and no colour literals in `board.css`.
- **Gate.** `npm run check` (lint plus the full suite): 1600 tests, 1590 pass, 0 fail, 10 skipped. e2e: 16 lines, project (8), plain (2), team (6), all passing. `npm run verify:release`: 260 entries, 50 required release assets, exit 0.
- **Requirements.** BOARD-01, BOARD-02 and BOARD-03 are ticked and their traceability rows are Complete. All Phase 62 success criteria except the owner-only manual checks (below) are proven by automated runs. The 2 s relay half of BOARD-02 stays with Phase 67 and is noted beside the tick. `62-VALIDATION.md` has real plan ids, commands and green statuses, `nyquist_compliant: true` and `wave_0_complete: true`.

## Task Commits

1. Task 1 (tracer): `bc0c3ea` test(62-14): a team scenario proves the board in a real VS Code
2. Task 2: `349249a` test(62-14): the release check and an asset test cover the board files
3. Task 3, fixes found by the gate: `aac0282` fix(62-14): two tests failed in the full run for reasons outside the product
4. Task 3, records: `9c9b8ab` docs(62-14): record the phase gate, tick BOARD-01 to BOARD-03 and fill the validation map

The tracer gate: in auto mode the e2e (`<verify>`) was re-run end to end and passed before the expansion tasks, so the proven slice was verified first. The first run failed one step (see deviation 1), which was a test assumption and not the product.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug in the new test] Import Plans step waited for a state that never comes**
- **Found during:** Task 1, first e2e run
- **Issue:** The session imports the roadmap when it starts, so the cards were already in an earlier state; running Import Plans then changes nothing and posts no new state, and the step timed out.
- **Fix:** The step runs the command (it must be repeatable) and waits for any state with the cards, not only a later one.
- **Files modified:** `src/test/e2e/suite.ts`
- **Commit:** `bc0c3ea`

**2. [Rule 1 - Bug in a test] `teamBoardLive` tracer raced the listener (known flake in deferred-items.md)**
- **Found during:** Task 3, first full run (1 of 2 failures)
- **Issue:** The test waited for `session.state()` to show the block, but the transport saves its pin before it notifies listeners, so under the full suite's load `received.length` was still 0. The product is not affected: the board reads the state when it is notified, a few milliseconds later.
- **Fix:** After the state check the test waits for the listener (`received.length > 0`) and then asserts exactly one entry. The product ordering is unchanged.
- **Files modified:** `src/test/teamBoardLive.test.ts`
- **Commit:** `aac0282`

**3. [Rule 1 - Bug in a test] `teamHarnessAddressSpace` fails when the suite runs without `ulimit -v` (2 of 2 failures)**
- **Found during:** Task 3, first full run
- **Issue:** The test asserts no single reservation of 1 GiB or more after the first fetch. With the mandated cgroup-only cap (no `ulimit -v`), V8 keeps an 8 GiB `---p` guard region for wasm memory, which costs nothing, so the test failed with "8192 MiB ---p" even though the wasm page cap works. It passed alone only under `ulimit -v 6000000`. The test file was not in this plan's list but was in the gate; it is a test-environment defect, not a product one.
- **Fix:** The test now runs its own check in a child process started under `ulimit -v 6000000` and asserts the child exits 0. Mutant check: raising the page cap to 65536 in the compiled helper makes the test fail; restored afterwards.
- **Files modified:** `src/test/teamHarnessAddressSpace.test.ts`
- **Commit:** `aac0282`

After these fixes the full gate was re-run once: `npm run check`, the e2e command and `npm run verify:release` all passed.

**Total deviations:** 3 auto-fixed (all in tests). **Impact:** none on product code; the plan's interfaces and file list are otherwise as written (the two extra test files are listed above).

## Authentication Gates

None.

## Known Stubs

None. No placeholder text or empty data flows into the board in the files this plan touched.

## Threat Flags

None. The only new surface is the e2e test seam (T-62-44), which is returned only when `NEAR_AI_E2E=1`, like the existing seam. The e2e second client runs in the test process and writes only to a temporary directory and a temporary bare remote.

## Issues Encountered

- `xvfb-run` is not installed; the e2e ran with `DISPLAY=:0` as the plan says. The VS Code test binary (1.144.1) was already cached under `.vscode-test` (git-ignored); the first run printed a download line for the worktree's own cache folder.
- Debug sessions `.planning/debug/board-detail-test-oom.md` and `team-board-view-test-oom.md` were left where they are, awaiting the owner.

## Manual checks left for the owner (backstops, not automated)

- Board in light, dark and high contrast themes: card hierarchy and spacing in both layouts.
- Drag target highlights on the real webview.
- 200 px sidebar and 400 percent zoom reflow without horizontal scrolling in the list.
- A real screen reader reading card names, the Move to... menu and the live region wording.
- Readability with this repository's own roadmap (about 100 items) and a 30-card cell.
- Two real windows on two clones: a move in one appears in the other within one poll. The e2e proves the same path with a second client inside one window.

## Next Phase Readiness

Phase 62 is complete from the automated side. Phase 67 owns the 2 s relay half of BOARD-02. The board is ready for Phase 63 (claims), which adds assignee initials and claim state to the card.

## Self-Check: PASSED

- Files: `src/test/teamBoardAssets.test.ts`, `src/test/e2e/run.ts`, `src/test/e2e/suite.ts`, `src/extension.ts`, `scripts/verify-release-content.mjs` exist.
- Commits `bc0c3ea`, `349249a`, `aac0282`, `9c9b8ab` are ancestors of HEAD.
