---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 22
subsystem: team-board-page
tags: [team-mode, board, e2e, xvfb, x11, screenshots, layout-probe, themes, high-contrast, readability, g-62-2, g-62-4, g-62-7]
status: complete

requires:
  - phase: 62-21
    provides: "the board launch on a hidden Xvfb screen, boardTap.layout, the settled-reading helper, captureScreen, the column probe action"
  - phase: 62-16
    provides: "media/board/layout-probe.js (measure, scroll, focus) and xwdPng.ts"
provides:
  - "src/test/e2e/x11Window.ts: fillScreen gives the test window the whole hidden screen and parks the pointer at the last pixel, with Node built-ins only"
  - "suite.ts: the screenshot matrix (4 themes x 480, 900, 1400, full; scroll and focus at each kanban width; Done open at 1400 in each theme; scrolled, detail, menu and Group by Phase views) writing .vscode-test/screens/*.png and index.json"
  - "board.js e2e probe actions 'open', 'group' and 'blur'; e2e-facts report detailOpen and groupBy"
  - "board.css: readable selected Group by choice in light themes, a high contrast marker on the chosen Group by and pressed filters, a spaced detail head"
affects: [62-23, 62-24]

actuals:
  tokens: 13166
  tasks: 2
  commits: 12
plan_head_before: d8f9c05852bc29b09903f431dcae6da8ac42c824
plan_head_after: 54a9e185cc6ffe820c2d46134b87061d358e7e2f

tech-stack:
  added: []
  patterns:
    - "Without a window manager under Xvfb, the e2e sizes its own window with an X11 ConfigureWindow request (no installed tool, no dependency)"
    - "A screenshot is written only after a settled probe reading with zero problems; index.json records file, theme, asked and reached width, layout, view and problem count"
    - "Before a measurement the probe lets go of focus, so focus left by an earlier step is not judged as a person's own keyboard focus"
    - "Themes are VS Code's own defaults per kind (workbench.colorTheme default for dark, the preferred light, high contrast and high contrast light defaults), written to the fresh test user settings"

key-files:
  created:
    - src/test/e2e/x11Window.ts
    - src/test/x11Window.test.ts
  modified:
    - src/test/e2e/suite.ts
    - media/board/board.js
    - media/board/board.css
    - src/services/team/boardView.ts
    - src/test/boardClient.test.ts

key-decisions:
  - "The e2e gives VS Code's test window the whole Xvfb screen through a raw X11 ConfigureWindow (VS Code skips saved window state for test windows and maximize needs a window manager); the full editor width is now 1862 px on 1920x1080"
  - "The theme matrix uses VS Code 1.144's own defaults: Dark 2026, Light 2026, Default High Contrast, Default High Contrast Light"
  - "The probe's focus rule is kept as is; the matrix blurs before each top and scroll measurement, as a click on empty space would"
  - "In high contrast the chosen Group by and pressed filters carry a 2 px contrastActiveBorder outline; aria-checked and aria-pressed stay the source of truth"
  - "First-screen ordering is unchanged (pending the owner); with the full-screen window Phase 63 is the third Backlog card and fully visible on the first screen"

patterns-established:
  - "Screenshot matrix: sizeTo(width) within 40 px in up to 4 logged tries, then blur, settle, assert zero problems, clear notification toasts, capture, append to index.json"

requirements-completed: [BOARD-01]

coverage:
  - id: D1
    description: "The test window fills the 1920x1080 hidden screen and the pointer is parked off the board, so 1400 px and the full width can be reached and frames are unobstructed"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/x11Window.test.ts (6 tests: Xauthority, local display only, request layout, fillScreen against a fake X server with the pointer parked, refused cookie and empty screen, real Xvfb handshake)"
        status: pass
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[board] the window fills the hidden screen ... (log: 1440 by 900 at 240,90 now fills 1920 by 1080, pointer at 1919,1079; editor area 1862 by 979 px)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every theme (dark, light, hc, hc-light) at 480 (list), 900, 1400 and the full width (kanban) measures zero problems at the top, after a scroll 600 down and 400 right, and with the last card of the first open lane focused (G-62-2, G-62-4)"
    requirement: BOARD-01
    verification:
      - kind: e2e
        ref: "xvfb-run -a -s '-screen 0 1920x1080x24 -fbdir D' board run: 38/38 board passes, 16 top frames with problems 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "Cards readable in every state the board shows: Done open in every theme at 1400, the detail open on a phase card with the selected card visible beside the drawer, the Move to... menu open, Group by Phase (G-62-7)"
    requirement: BOARD-01
    verification:
      - kind: e2e
        ref: "board run: board-<theme>-1400-done.png x4, board-dark-1400-detail.png, board-dark-1400-menu.png, board-dark-1400-by-phase.png, all problems 0"
        status: pass
      - kind: unit
        ref: "src/test/boardClient.test.ts#the e2e probe opens a card's detail and picks a Group by choice ... (62-22); #the e2e probe lets go of a card's focus ... (62-22)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Readability fixes the frames showed: the selected Group by word readable in light themes, the chosen Group by and pressed filters marked in high contrast, the detail head spaced"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/boardClient.test.ts#62-22: the selected Group by choice and a pressed filter are readable in every theme, and the detail head spaces its parts"
        status: pass
      - kind: automated_ui
        ref: "board-light-1400.png, board-hc-1400.png, board-dark-1400-detail.png (looked at after the run)"
        status: pass
    human_judgment: false
  - id: D5
    description: "25 PNG frames and index.json in .vscode-test/screens, one index line per PNG, problems 0 everywhere, 4 themes"
    requirement: BOARD-01
    verification:
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[board] the screenshot index lists every frame with no problem in any; node -e acceptance check exit 0"
        status: pass
    human_judgment: false
  - id: D6
    description: "The screenshots look right to the owner"
    verification: []
    human_judgment: true
    rationale: "Owner review of the screenshot set is 62-24; the probe cannot judge everything a person sees (the three CSS defects here were found by looking at the frames)"

duration: about 1h 15m of work, across a pause
completed: 2026-11-04
---

# Phase 62 Plan 22: Screenshot matrix Summary

**The board e2e now photographs the board at 480, 900, 1400 px and the full width in four themes, scrolled, focused, with Done open, the detail drawer, the Move to... menu and Group by Phase. That is 25 frames, each written only after a zero-problem layout probe reading. To reach those widths the e2e sizes its own window to the whole hidden screen with a few raw X11 requests. The frames also showed three readability defects the probe cannot see, and board.css now fixes them: a near-invisible selected Group by word in light themes, nothing marking the chosen Group by or pressed filters in high contrast, and a detail head whose parts ran together.**

## Performance

- **Duration:** about 1h 15m of work. Started 2026-11-04T04:21Z; the run paused when the session ended and resumed later; finished 2026-11-04T11:14Z.
- **Tasks:** 2 of 2
- **Files:** 2 created, 5 modified

## Accomplishments

- **Window fills the screen.** VS Code ignores saved window state for extension test windows, and "maximized" needs a window manager, so under Xvfb the window stayed 1440 by 900 and 1400 px was out of reach. `src/test/e2e/x11Window.ts` reads the xvfb-run cookie and finds the largest shown top-level window. It sends ConfigureWindow to 0,0 1920 by 1080 and WarpPointer to the last pixel, then reads the size back. Only a local display is used and the cookie is never logged. The editor area is now 1862 by 979 px.
- **Matrix helpers in suite.ts.**
  - `sizeTo` reaches each width within 40 px in up to 4 logged tries. Every width landed on try 1. On a screenshot run an unreachable width fails with the measured room; otherwise it is logged as not measured.
  - `photograph` refuses a frame whose reading had problems. It clears notification toasts, checks the PNG is the whole screen and appends to `screens/index.json`.
  - `applyTheme` picks VS Code's own default per kind and waits for the probe's theme field.
  - `scrollAndFocus` scrolls 600 down and 400 right, then focuses the last card of the first open lane. Its readings must be clean, and the focused card must be visible below the header row.
- **Probe actions (board.js, data-e2e pages only).** `open` clicks a drawn card, `group` presses a Group by choice and `blur` lets go of focus. e2e-facts now report `detailOpen` and `groupBy`.
- **Readability fixes (board.css).**
  - `.group-by > .label`, so the caption grey no longer colours the chosen word on the blue fill.
  - High contrast and high contrast light: a 2 px `--vscode-contrastActiveBorder` outline on the chosen Group by and pressed filters. Forced colours get the same with currentColor.
  - The detail state line, badges and actions are spaced flex rows, and dependency icons keep a space.

## Frames (.vscode-test/screens, 25 PNG + index.json, all 1920 by 1080)

| Theme | Frames | Probe problems |
|---|---|---|
| dark (Dark 2026) | 480 (list), 900, full (1862), 1400, 1400-scrolled, 1400-done, 1400-detail, 1400-menu, 1400-by-phase | 0 in each |
| light (Light 2026) | 480 (list), 900, full, 1400, 1400-scrolled, 1400-done | 0 in each |
| hc (Default High Contrast) | 480 (list), 900, full, 1400, 1400-done | 0 in each |
| hc-light (Default High Contrast Light) | 480 (list), 900, full, 1400, 1400-done | 0 in each |

The run printed one line per theme: 9, 6, 5 and 5 frames. Besides the photographed views, every kanban width in every theme also passed the scroll and focus checks with zero problems.

## Task Commits

1. **Task 1 (tracer): dark row, helpers, index**
   - `b8cc364` test: failing tests for the window sizer (RED)
   - `136a921` feat: fillScreen through X11 requests (GREEN)
   - `b7dfa5e` test: dark row at four widths, sizeTo, photograph, index.json
2. **Task 2: four themes, scroll and focus, Done, extra views, fixes**
   - `d23e245` / `6c4160c` test/feat: probe `open` and `group`
   - `25da781` / `3bb4f59` test/feat: pointer parked at the last pixel
   - `55b4ba6` / `8b424ef` test/feat: probe `blur`
   - `c8765a7` / `66f6d37` test/feat: readable Group by, high contrast markers, spaced detail head
   - `54a9e18` test: the full matrix in suite.ts

## TDD Gate Compliance

Each RED record was checked with `gsd-tools check tdd-red-evidence` and returned RED_EVIDENCE_OK (target_test_failed). The records are in `.vscode-test/red/62-22-t1.json`, `t2.json`, `t2b.json`, `t2c.json` and `t2d.json`.
- **Window sizer.** The target failed on the fill result's deepEqual against a stub that sized nothing (all zeros). The handshake and fixture were sound, since the 3 pure tests passed.
- **open/group.** The target failed on its first assertion: `detailOpen` was missing from the facts. 38 other tests passed.
- **Pointer.** The target failed on `pointer` missing from the result. The other 5 tests passed.
- **blur.** The target failed on "no card has focus after the blur" (`plan:90-01` still focused).
- **CSS.** The target failed on "the caption colour does not reach the words inside the choices". 40 other tests passed.
- Every RED commit is followed by a GREEN `feat(62-22)` commit. `b7dfa5e` and `54a9e18` are test-only e2e changes, with no production code to drive.
- **Tracer gate (auto mode).** The Task 1 verify was re-run after its commit and passed: 11/11 board passes and four dark frames with 0 problems. Expansion continued from there.

## Verification

- **Task 1 verify:** exit 0, the four dark frames present. Acceptance `node -e` (at least 4 dark entries, all 0 problems) exit 0, on the run and on the gate re-run.
- **Task 2 unit verify** (boardLayoutProbe, boardClient, teamBoardAssets): 62/62.
- **All board-related unit files** (20 files, x11Window and xwdPng included): 279/279, 0 skipped.
- **Task 2 e2e** (`xvfb-run -a -s "-screen 0 1920x1080x24 -fbdir D"`, NEAR_AI_E2E_ONLY=board, MemoryMax=6G, timeout 1800): exit 0, 38 board passes and 0 failures, 25 PNG files.
- **Index acceptance:** every entry has 0 problems and there are 4 themes; exit 0.
- **Other checks:** no em or en dash added; package.json and package-lock.json unchanged; no installs; `tsc -p tsconfig.json` clean.
- **Not run here:** the full `npm test` and the full e2e. The phase gate is 62-24.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The window could not reach 1400 px**
- **Found during:** Task 1.
- **Issue:** VS Code skips saved window state when extensionTestsPath is set, and maximize needs a window manager. The window stayed 1440 by 900, so the full editor width was 1382 px.
- **Fix:** a new `src/test/e2e/x11Window.ts` (not in the plan's file list) with unit tests against a fake X server and a real Xvfb. It uses Node built-ins only.
- **Commits:** b8cc364, 136a921

**2. [Rule 2 - Screenshot correctness] The Xvfb pointer was drawn mid-screen in every frame**
- **Fix:** fillScreen parks the pointer at the last pixel (WarpPointer).
- **Commits:** 25da781, 3bb4f59

**3. [Rule 3 - Blocking] No way to open a card's detail, pick Group by, or let go of focus from the e2e**
- **Fix:** probe actions `open`, `group` and `blur` in board.js. BoardProbe in boardView.ts gained them (boardView.ts was not in the plan's list).
- **Commits:** d23e245, 6c4160c, 55b4ba6, 8b424ef

**4. [Rule 1 - Test sequencing] Stale focus was measured as a defect**
- **Found during:** Task 2, first matrix run (20 failures).
- **Issue:** A card focused by an earlier step stayed focused: the focus check itself, or Escape from the detail or menu. The probe's focus rule then reported it after the next scroll or resize, for example "The focused card plan 62-23 is hidden under the column headers (481 px covered)". The rule is right for a person's own keyboard focus, so it was kept.
- **Fix:** the matrix blurs before each top and scroll measurement. Done is folded back in a `finally`, so one failure no longer leaks into the next theme.
- **Commit:** 54a9e18

**5. [Rule 1 - Theme choice] The first picker chose Abyss and Light 2026**
- **Fix:** use VS Code's own defaults per kind. The dark default in 1.144 is Dark 2026, not Dark Modern.
- **Commit:** 54a9e18

**6. [Rule 1 - Readability, found by looking at the frames] Three CSS defects the probe cannot measure**
- The selected Group by word in light themes was grey on the blue fill.
- Nothing marked the chosen Group by or pressed filters in high contrast.
- The detail state line read "BacklogPhase 63", the actions touched, and the dependency icons touched their text.
- **Fix:** board.css, with a RED CSS test first.
- **Commits:** c8765a7, 66f6d37

**7. [Interruption] The session ended mid-Task 2**
- The edit that added the CSS RED test was cut off. On resume the owner chose to make the three fixes here (option a).

---

**Total deviations:** 7 (2 blocking, 1 screenshot correctness, 3 bug or readability fixes, 1 interruption). **Impact:** no probe rule was changed or weakened, and no test was skipped.

## Issues Encountered

- **Memory.** One matrix run was killed by a global out-of-memory (the machine had about 2 GB free; the run peaked at 865 MB). It waited for 4 GB or more and was repeated. One unit run also exited 143 under memory pressure and was repeated. Every e2e ran under xvfb-run with MemoryMax=6G, timeout 1800 and choom, with no other e2e running.
- **First-screen ordering.** With the full-screen window, Phase 63 (the first planless phase) is the third Backlog card and fully visible on the first screen. The ordering is unchanged and still awaits the owner's decision.
- **Second editor group.** Frames at 480, 900 and 1400 show the empty second editor group used to size the board's group. This is expected.

## Known Stubs

None. The RED stub of fillScreen was replaced in 136a921.

## Threat Flags

None beyond the register.
- **T-62-78:** themes are written only to the run's fresh user settings.
- **T-62-79:** photograph refuses frames with problems, and index.json records the count.
- **T-62-SC:** no installs.
- **x11Window.ts:** a test-only file under src/test/e2e. It uses only a local display (":N" or "unix:N") and never logs the cookie.

## User Setup Required

None.

## Next Phase Readiness

- 62-23 can drag on the same launch. The window is now full screen, and the probe's `rects` hold.
- 62-24 has the screenshot set for owner review and still needs to decide the first-screen ordering.

## Self-Check: PASSED

- src/test/e2e/x11Window.ts and src/test/x11Window.test.ts exist, and the 5 modified files exist.
- 25 PNGs and index.json are in .vscode-test/screens.
- All 12 commits (b8cc364 to 54a9e18) are ancestors of HEAD, and `git rev-list --count d8f9c05..HEAD` is 12.

---
*Phase: 62-work-model-gsd-import-team-board-live-read-and-move*
*Completed: 2026-11-04*
