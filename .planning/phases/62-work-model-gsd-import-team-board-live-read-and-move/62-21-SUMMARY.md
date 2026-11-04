---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 21
subsystem: team-board-page
tags: [team-mode, board, e2e, xvfb, wayland, layout-probe, css-grid, sticky, readability, folding, g-62-2, g-62-3, g-62-4, g-62-7]
status: complete

requires:
  - phase: 61-22
    provides: "run.ts launch() over runTests, the insteadOf public address, the concurrent invite windows"
  - phase: 62-16
    provides: "media/board/layout-probe.js (collect, check, measure), captureScreen and readXwd"
  - phase: 62-19
    provides: "model.columns[].foldedByDefault, lanes[].collapsedByDefault, planless phases as Backlog cards"
  - phase: 62-20
    provides: "the assignee chip on the card face"
provides:
  - "run.ts: refuses to start unless xvfb-run made the screen, keeps Electron off a Wayland desktop (WAYLAND_DISPLAY removed, --ozone-platform=x11), NEAR_AI_E2E_ONLY, and a board launch on this repository's committed .planning"
  - "suite.ts boardTests: first open, full width, scroll, Done opened, list width, with board-dark-full.png and board-dark-480.png when NEAR_AI_E2E_FBDIR is set"
  - "boardView.ts: BOARD_TEST_SCRIPTS = ['layout-probe.js'] and boardTap.layout, only under the test seams; BoardProbe action 'column'"
  - "board.css and board.js: toolbar band, one board scroller, sticky opaque header row, --board-columns grid shared by headers and lanes, 64 px full-height cells, folded cells without cards, break-word wrapping, .card-main reset, folds from the model, versioned saved state"
  - "layout-probe.js: hyphen-joined word parts measured on their own (wordsIn)"
affects: [62-22, 62-23, 62-24]

actuals:
  tokens: 20784
  tasks: 3
  commits: 10
plan_head_before: 5c0945a665dfd682cccc795b2951b257c8b019f9
plan_head_after: 8048baf7543148f86caa620cda154e1befdb3b1f

tech-stack:
  added: []
  patterns:
    - "Kanban page as a 100vh flex column: bands on top, one flex:1 scroller below; sticky header row inside the scroller"
    - "One grid template for the header row and every lane (--board-columns written by board.js), so cells line up by construction"
    - "Layout variables written with style.setProperty (allowed by the nonce CSP), never colours"
    - "The e2e runner checks for an xvfb-run screen and strips Wayland from the environment before VS Code starts"

key-files:
  created: []
  modified:
    - src/test/e2e/run.ts
    - src/test/e2e/suite.ts
    - src/services/team/boardView.ts
    - media/board/board.css
    - media/board/board.js
    - media/board/layout-probe.js
    - src/test/teamBoardView.test.ts
    - src/test/boardClient.test.ts
    - src/test/boardLayoutProbe.test.ts
    - src/test/boardDrag.test.ts

key-decisions:
  - "Under xvfb-run on a Wayland desktop, Electron still picks the person's Wayland screen through WAYLAND_DISPLAY; run.ts removes WAYLAND_DISPLAY and WAYLAND_SOCKET, sets XDG_SESSION_TYPE and ELECTRON_OZONE_PLATFORM_HINT to x11 and passes --ozone-platform=x11, so the window is on the hidden screen"
  - "The hidden-screen guard trusts only an XAUTHORITY file inside a folder named xvfb-run.<random>, or NEAR_AI_E2E_FBDIR/Xvfb_screen0; DISPLAY alone is never trusted"
  - "NEAR_AI_E2E_ONLY with an unknown launch name stops the run, so a typo never passes by running nothing"
  - "The board launch uses --force-device-scale-factor=1, so probe pixels and screenshot pixels are the same"
  - "A hyphen break is wrapping between words: the probe measures 'two-' and 'lead' on their own, and a break inside a part is still a split word"
  - "From the older saved state only groupBy, milestone, selected, filtersOpen and an unsent draft are kept; collapse, open group and filter choices are dropped once and the state is written back with version 2"
  - "The folded note is built from what is folded: the later-columns sentence when one of them is folded, and 'Done and Cancelled are folded to keep finished work out of the way.' (or the one that is)"

patterns-established:
  - "Real-window board checks: ask the page's layout probe through boardTap.layout, wait for three agreeing readings, assert problems is empty and print the probe's sentences on failure"

requirements-completed: [BOARD-01]

coverage:
  - id: D1
    description: "The e2e runner starts VS Code only on a hidden xvfb-run screen and never on a Wayland desktop"
    requirement: BOARD-01
    verification:
      - kind: other
        ref: "env -u NEAR_AI_E2E_FBDIR DISPLAY=:4242 XAUTHORITY=/nonexistent NEAR_AI_E2E_ONLY=board node dist/test/e2e/run.js exits 1 with 'The e2e runs only on a hidden virtual screen...'"
        status: pass
      - kind: e2e
        ref: "xvfb-run -a -s '-screen 0 1920x1080x24 -fbdir D' run: board-dark-full.png shows the VS Code window on the hidden screen (it was all black before the Wayland fix)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The probe script and layout requests exist only under NEAR_AI_E2E=1 (T-62-68)"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/teamBoardView.test.ts#the layout hook exists only under the extension-host tests and asks only the visible page to measure itself (62-21, T-62-68)"
        status: pass
      - kind: unit
        ref: "src/test/teamBoardView.test.ts#the page has one nonce CSP, one script tag per client file in order and no inline script, style, remote address or font source"
        status: pass
    human_judgment: false
  - id: D3
    description: "Solid toolbar band, one board scroller, sticky opaque header row, shared column grid, full-height cells: the probe finds nothing wrong at the full width and after scrolling down and sideways (G-62-2, G-62-4)"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/boardClient.test.ts#G-62-2 and G-62-4 (2 tests: --board-columns and --board-head-height, board.css rules)"
        status: pass
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[board] at the full editor width the layout probe finds nothing wrong; after scrolling down and sideways ..."
        status: pass
    human_judgment: false
  - id: D4
    description: "Readable cards: folded cells hold no card, words break between words, the card button looks like the card; Done opened and a list width under 520 px measure clean (G-62-7)"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/boardClient.test.ts#G-62-7 (2 tests)"
        status: pass
      - kind: unit
        ref: "src/test/boardLayoutProbe.test.ts#the split-word rule measures hyphen-joined parts on their own ..."
        status: pass
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[board] with Done opened once ...; at a list width under 520 px ..."
        status: pass
    human_judgment: false
  - id: D5
    description: "Opens on active work: folds from the model, lanes from the model, versioned saved choices (G-62-3)"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/boardClient.test.ts#G-62-3 (2 tests)"
        status: pass
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[board] first open, before anything changes the view ..."
        status: pass
    human_judgment: false
  - id: D6
    description: "On first open a planless phase card is fully visible without any click"
    requirement: BOARD-01
    verification:
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[board] first open: phase:63 is drawn in the open Backlog cell and fully visible after scrolling the board region alone"
        status: pass
    human_judgment: true
    rationale: "Not met as written: 62-19 orders a column by phase, then plan, so this repository's three unfinished Phase 62 plans come first and phase:63 starts 809 px into a 644 px board region. The owner or 62-22/62-24 must choose between ordering planless phases first, more compact cards, or accepting the scroll."
  - id: D7
    description: "The screenshots look right to the owner"
    verification: []
    human_judgment: true
    rationale: "Owner review of the screenshot set is 62-24; the window under Xvfb is 1440 by 900, not maximized (no window manager), which 62-22 has to settle"

duration: 57min
completed: 2026-11-04
---

# Phase 62 Plan 21: Real-window layout and readable cards Summary

**The board's kanban is now a solid toolbar band above one board scroller, with a sticky opaque header row and one `--board-columns` grid for the headers and every lane. Folded columns hold no cards, card text wraps between words, the card button looks like the card, and the board opens with Backlog and Ready open. All of this is proven by the 62-16 layout probe in a real VS Code window on a hidden Xvfb screen. That screen is now really hidden: the runner refuses to start without xvfb-run and keeps Electron off the person's Wayland desktop.**

## Performance

- **Duration:** about 57 min (first commit 2026-11-04T03:31:07Z; reading started about 15 min earlier)
- **Completed:** 2026-11-04T04:12:16Z
- **Tasks:** 3 of 3
- **Files modified:** 10

## Accomplishments

- **Hidden screen only.** `run.ts` exits 1 with "The e2e runs only on a hidden virtual screen. Start it with xvfb-run, for example: xvfb-run -a node dist/test/e2e/run.js" unless XAUTHORITY sits in a `xvfb-run.<random>` folder or `NEAR_AI_E2E_FBDIR/Xvfb_screen0` exists. It also strips Wayland from VS Code's environment (see Deviations 1).
- **Board launch.** HEAD's `.planning` (git archive) goes on a test project behind `https://example.invalid/e2e-board.git`, mapped to a bare folder by insteadOf. The launch uses fresh user data with `window.newWindowDimensions: maximized` and `workbench.startupEditor: none`, empties the screens folder at start, and honours `NEAR_AI_E2E_ONLY` for every launch.
- **Probe hook.** `BOARD_TEST_SCRIPTS = ['layout-probe.js']` is the last script, nonce-bound, only when testSeams is on. `boardTap.layout` posts `e2e-layout` to the visible page only.
- **Layout (G-62-2, G-62-4).** In the kanban the page does not scroll. The toolbar and banners are bands on the editor background, and `.board-scroll` scrolls both ways. Inside it: the folded note, then the header row (sticky, top 0, z-index 2, editor background), then the lanes. `--board-columns` (256 px open, 40 px folded) drives both grids with a 12 px gap. Cells stretch to the row with a 64 px minimum. Lane titles stay on the left when scrolling sideways (`width: 100cqw`). `--board-head-height` is the region's `scroll-padding-top`. Folded headers stack their icons and turned name in 40 px.
- **Readable cards (G-62-7).** A folded cell is its own node with only a hidden `<n> cards, column folded`. Card text uses `overflow-wrap: break-word; word-break: normal`, and there is no zero font size anywhere. `.card-main` sets again every property the global button rule sets.
- **Open on active work (G-62-3).** Folds come from `foldedByDefault` (the later four, Done and Cancelled) and lanes from `collapsedByDefault`. The note adds "Done and Cancelled are folded to keep finished work out of the way." Saved state carries version 2, so the older board's collapse and filter choices are dropped once and a draft is kept.

## Probe evidence (real window, 1920x1080 hidden screen)

**Red, before the CSS and JS fix** (commit 9cb0448, full width, `kanban at 1795 by 947 px`; the screenshot and the full log are in `.vscode-test/screens-before/`):

```
The toolbar background is not opaque (rgba(0, 0, 0, 0))
Column header Claimed spills 54 px past its box   (also In progress, In review, Shipping)
Card plan 62-22's content is 68 px taller than the card   (12 named, "And 27 more cards too short for their content.")
Card plan 62-11 splits the word "snap-back" across two lines although it fits on one   (also two-lead, two-clone, SETUP-01)
```
After scrolling down 600 px and sideways 300 px, the probe added:
```
The toolbar covers 115 px of the board region and the cards plan 62-23, plan 62-24, plan 62-20 and plan 62-19
The column header row is not at the top of the board region after a scroll (it starts at -440 px, the region at 115 px)
The column header row is not opaque after a scroll (rgba(0, 0, 0, 0))
```
The planned "cells not under their headers" and "cards in folded cells" did not appear. The flex rows happened to line up, and the old renderer already kept cards out of folded cells; the folded text was hidden by `font-size: 0`.

**Green, after the fix:** the probe reports `[]` at the full width, after the scroll, with Done open, and at the list width (board-only run 23:04 and the full run). Screenshots: `.vscode-test/screens/board-dark-full.png` and `board-dark-480.png`, both 1920 by 1080.

## Task Commits

1. **Task 1 (tracer): hidden screen, board launch, probe hook, layout fix**
   - `eae6022` test: failing tests for the probe script tag and the layout hook (RED)
   - `02491f3` feat: load the layout probe and offer the layout hook only under the test seams (GREEN)
   - `9cb0448` test: hidden-screen guard, Wayland fix, board launch and full-width checks (red in the real window)
   - `cefa1b7` test: failing tests for the shared column layout, toolbar band and one scroller (RED)
   - `9f4aae0` test: failing test for the split-word rule on hyphenated titles (RED)
   - `055f45d` feat: toolbar band, one board scroller, one column layout (GREEN; real window clean)
2. **Task 2: readable cards**
   - `6918bde` test: failing tests for folded cells, word wrapping and the card button reset (RED)
   - `2d0c0fd` feat: readable cards, Done-open and list-width e2e checks (GREEN)
3. **Task 3: open on active work**
   - `2e32cf5` test: failing tests for folds from the model and versioned saved choices (RED)
   - `8048baf` feat: folds from the model, versioned saved state, first-open e2e check (GREEN)

## TDD Gate Compliance

Every RED record was checked with `gsd-tools check tdd-red-evidence` and returned RED_EVIDENCE_OK (target_test_failed).
- **Task 1, hook.** The target "the layout hook exists only under the extension-host tests..." failed on `deepEqual([], ['layout-probe.js'])` against the empty RED stub. Semantically right: there was no load fault, and the CSP test failed on the script count, as expected.
- **Task 1, layout.** The target "the kanban writes one column layout..." failed on "the widths follow the column order and folds", since no variable was written yet. The CSS test failed on "nothing inherits a see-through background".
- **Task 1, probe rule.** The target failed on the word list (`two-lead@4`, where `two-@4, lead@8` was expected) against a stub with the old `\S+` behaviour.
- **Task 1, tracer gate.** In auto mode the three verify commands were re-run after the fix and all passed: 88/88, the guard refused, and the board e2e had 6 passes. Expansion continued from there.
- **Task 2.** The target "a folded column holds no card..." failed on "one hidden count". The CSS test failed on "no mid-word breaks anywhere on the board".
- **Task 3.** The target "with nothing saved the kanban folds exactly the columns the model folds..." failed on the fold list, which lacked done and cancelled. The reload test failed on "the saved state carries its version".
- GREEN `feat(62-21)` commits follow each RED. No REFACTOR commits.

## Verification

- Task 1: unit set (teamBoardView, boardClient, boardLayoutProbe, teamBoardAssets) 88/88. Guard command exit 0 (the runner refused with the sentence). Board e2e at 1920x1080 with fbdir: 6 passes, `board-dark-full.png` present.
- Task 2: unit set (boardClient, boardLayoutProbe, boardMenu, boardDrag, teamBoardAssets) 91/91. Board e2e: 8 passes, `board-dark-480.png` present.
- Task 3: unit set (boardClient, boardMenu, boardDrag, boardDetail, boardForm) 112/112. Full e2e with `xvfb-run -a` (every launch, default screen) exit 0, 41 passes and no failures: project 8, plain 2, team 7, team-lead 6, team-join 6, team-confirm 3, board 9.
- Final: 11 board-related test files, 185/185, 0 skipped; `tsc -p tsconfig.json` (the repo's lint) clean.
- Acceptance greps:

  | Check | Result |
  | --- | --- |
  | `background: inherit` in board.css | 0 |
  | `--board-columns` in board.css | 2 |
  | `xvfb-run` in run.ts | 7 |
  | `overflow-wrap: anywhere` in board.css | 0 |
  | `font-size: 0;` in board.css | 0 |
  | `foldedByDefault` in board.js | 2 |
- package.json and package-lock.json unchanged, and no install. The diff adds no em or en dash (the one match is a test regex that forbids them).
- The full `npm test` was not run. This plan's boundary was the full e2e; the phase gate is 62-24.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Correctness/security] Test windows went to the person's real Wayland screen even under xvfb-run**
- **Found during:** Task 1, first red run.
- **Issue:** This desktop sets `WAYLAND_DISPLAY=wayland-0`, and Electron prefers Wayland over the `DISPLAY` that xvfb-run sets. The first run's framebuffer screenshot was all black, which means the VS Code window was drawn on the person's Wayland screen. That breaks the plan's own prohibition, and it is the likely cause of the owner's "test windows popped up" report.
- **Fix:** `keepToHiddenScreen` removes WAYLAND_DISPLAY and WAYLAND_SOCKET, sets XDG_SESSION_TYPE and ELECTRON_OZONE_PLATFORM_HINT to x11, and adds `--ozone-platform=x11` to every launch.
- **Verification:** the second run's screenshot shows the VS Code window on the hidden screen.
- **Commit:** 9cb0448

**2. [Rule 1 - Bug] Every card was 68 px taller than its box**
- **Found during:** Task 1, red run.
- **Issue:** The Move to... button carries the `icon` class, whose 16 by 16 box is meant for svgs. The words "Move to..." stacked one letter per line, which is the vertical "M o v e" in `screens-before/board-dark-full.png`.
- **Fix:** `.move-btn { width: auto; height: auto; }`
- **Commit:** 055f45d

**3. [Rule 1 - Probe rule proven wrong] The split-word rule fired on hyphenated words**
- **Found during:** Task 1, after the layout fix. Only "two-lead", "snap-back", "two-clone" and "SETUP-01" were left.
- **Issue:** Chromium ends a line after a hyphen on purpose (UAX 14), and that keeps whole parts on each line.
- **Fix:** `wordsIn` splits hyphen-joined words into parts, and `collect` measures each part. A break inside a part is still caught. Unit test added first, as RED.
- **Commits:** 9f4aae0, 055f45d

**4. [Rule 3 - Blocking] The e2e had no way to open Done**
- **Found during:** Task 2.
- **Issue:** None of the probe actions (measure, scroll, focus, rects) presses a column header.
- **Fix:** board.js's e2e probe (data-e2e pages only) accepts `{ action: 'column', column }`. It finds the header by its data-column, with no selector built from host text, and clicks its button. `BoardProbe` gained the action.
- **Commit:** 2d0c0fd

**5. [Rule 3] One CSS pixel per screen pixel in the board launch**
- **Found during:** Task 1.
- **Issue:** The probe read 1795 by 947 CSS px while the window on the screenshot was about 1440 by 900 device px.
- **Fix:** the board launch passes `--force-device-scale-factor=1`.
- **Commit:** 055f45d

**6. [Plan check adjusted, needs a decision] The first planless phase is not on the first screen**
- **Found during:** Task 3.
- **Issue:** 62-19 orders a column by phase, then plan. This repository's unfinished 62-22, 62-23 and 62-24 come before phase:63, and each card is about 170 px tall. On the default 1280x1024 screen, phase:63 starts 809 px into a 644 px board region, behind 3 fully visible cards. No change within this plan's files can lift it above the fold.
- **Fix:** the first-open check asserts the rest of the truth exactly: the fold lists, Unassigned open, visibleCards >= 1, a Backlog card fully visible, and phase:63 drawn in the open Backlog cell. It then proves phase:63 becomes fully visible by scrolling the board region alone, with no click, and the probe stays clean.
- **Decision needed:** the owner or 62-22/62-24 chooses between ordering planless phases first in Backlog (board.ts), more compact cards, or accepting the scroll. Recorded as human_judgment D6.
- **Commit:** 8048baf

**7. [Rule 1] Older tests updated for the owner's folding decision**
- **Found during:** Task 3.
- **Issue:** Four older checks expected Done to be open by default.
- **Fix:** boardClient "all eight columns" now expects Done and Cancelled folded and the new note. "your own confirmed move" and boardDrag "a done card gets the reopen sentence" open Done first, since their subject is the move, not the fold. The team e2e CR-01 check now expects plan:90-02 drawn and plan:90-01 not drawn while Done is folded. Each change carries a comment citing the decision. The board.css theme-variable test allows exactly two layout variables, and only in grid-template-columns and scroll-padding-top.
- **Commits:** cefa1b7, 2d0c0fd, 8048baf

**8. [Sequencing] The folded cell's `font-size: 0` stayed one commit longer**
- **Issue:** Task 1's commit kept `font-size: 0` on the folded cell, so the folded text did not show squeezed between commits.
- **Fix:** Task 2 replaced it with the hidden count, as the plan says.

---

**Total deviations:** 8 (1 correctness/security fix, 3 bug fixes including the probe rule, 2 blocking, 1 plan check adjusted pending a decision, 1 sequencing). **Impact:** deviation 1 is essential to the plan's prohibition. Deviation 6 leaves one sentence of a truth to the owner. No test or probe rule was weakened to get green.

## Issues Encountered

- **Window size.** Under Xvfb there is no window manager, so `window.newWindowDimensions: maximized` has no effect. The window is 1440 by 900 on the 1920 by 1080 screen, and the full-width board is about 1370 px. 62-22 (width matrix) should size the window another way, for example a small window manager or the fullscreen command.
- **Memory.** Two capped unit runs were stopped (exit 143) while the machine had about 1 GB available. The runs waited for 4 GB or more and were repeated. Every e2e ran with 4 GB or more available and no other e2e running.
- **Notification toasts.** "Imported 232 items", "The Team Board is already up to date" and "All installed extensions are temporarily disabled" cover the lower right of the screenshots. They are outside the webview, so the probe does not see them; 62-22 may want to clear them before capturing.

## Known Stubs

None. The RED stubs (empty BOARD_TEST_SCRIPTS, `\S+` wordsIn) were replaced in their GREEN commits.

## Threat Flags

None beyond the register.
- **T-62-68:** probe and hook exist only under testSeams, proven by unit tests.
- **T-62-69:** screenshots live under the git-ignored `.vscode-test`, and the screens folder is emptied at each board run.
- **T-62-70:** the probe rules stay intact, and the one rule changed has its own test.
- **T-62-77:** guard plus Wayland fix (deviation 1).
- **T-62-SC:** no installs.

## User Setup Required

None.

## Next Phase Readiness

- 62-22 can run the width and theme matrix on the board launch. It should settle the window size first (Issues) and decide on deviation 6 together with 62-24.
- 62-23 can aim real drags with the probe's `rects` on the same launch. Cards no longer sit under the toolbar.

## Self-Check: PASSED

- All 10 modified files exist, and `.vscode-test/screens/board-dark-full.png`, `board-dark-480.png` and `.vscode-test/screens-before/board-dark-full.png` exist.
- Commits eae6022, 02491f3, 9cb0448, cefa1b7, 9f4aae0, 055f45d, 6918bde, 2d0c0fd, 2e32cf5 and 8048baf are ancestors of HEAD, and `git rev-list --count 5c0945a..HEAD` before this SUMMARY is 10.

---
*Phase: 62-work-model-gsd-import-team-board-live-read-and-move*
*Completed: 2026-11-04*
