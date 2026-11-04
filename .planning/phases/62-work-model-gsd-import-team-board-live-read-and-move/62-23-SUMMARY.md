---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 23
subsystem: testing
tags: [team-mode, board, drag-and-drop, e2e, devtools-protocol, real-input-drag, xvfb, g-62-6]
status: complete

requires:
  - phase: 62-16
    provides: "src/test/e2e/cdp.ts: connectCdp, webviewFrameRect, mouseDrag, interceptedDrag, pressKey"
  - phase: 62-22
    provides: "the board launch on a full-screen hidden window, sizeTo, applyTheme, photograph, screens/index.json, probe actions open/group/blur"
provides:
  - "run.ts: the board launch alone gets --remote-debugging-port on a free 127.0.0.1 port and NEAR_AI_E2E_CDP_PORT"
  - "suite.ts: real drags in a real VS Code window: an offered drop (Ready to Backlog, on hold), Escape over the offered Ready cell, a refused drop on the folded In progress column, a drop into another phase row, and the Move to... keyboard path with real keys"
  - "board.js: renders are held back while a drag is active and drawn once when it is dropped or ends; e2e facts carry dragLog (last 20), dragCount, refusals, live, hasFocus, focusedText"
  - "drag.js: the e2e drag log (data-e2e only), the Member-row refusal pointing to Assign to, and a refused card scrolled into view with its reason"
  - "cdp.ts: pressKey also sends ArrowDown"
affects: [62-24]

actuals:
  tokens: 10724
  tasks: 2
  commits: 6
plan_head_before: 447c42381b8f4faad0b9e8a7811efdfff2aab0a6
plan_head_after: 0025c368a39c2a1d7b7b0b1241d64b1c94a97b4f

tech-stack:
  added: []
  patterns:
    - "A real drag in the e2e is DevTools Protocol mouse input on the VS Code window, aimed with the probe's rects plus the webview frame offset; the page's own drag log proves the browser's dragstart, dragenter, drop and dragend"
    - "Page renders wait while a drag is active (api.setDragging), so the dragged node is never moved or replaced mid-drag"

key-files:
  created: []
  modified:
    - src/test/e2e/run.ts
    - src/test/e2e/suite.ts
    - src/test/e2e/cdp.ts
    - media/board/drag.js
    - media/board/board.js
    - src/test/boardDrag.test.ts
    - src/test/cdpClient.test.ts
    - .planning/phases/62-work-model-gsd-import-team-board-live-read-and-move/deferred-items.md

key-decisions:
  - "Drag path: mouse. Input.dispatchMouseEvent (press, 24 held moves, release) started a native drag in this Electron (Chrome/150.0.7871.250) on the first try in every run; the intercepted fallback is wired but was never needed"
  - "Escape: a DevTools-driven drag does not hear keys while the button is held (the page got no keydown either). The test presses Escape through pressKey, and when the drag log shows the drag still alive, ends it with Input.cancelDragging, Chromium's own cancel that the system drag loop does on Escape; the page then gets the dragend with no drop and announces 'Move cancelled. The card is still in Backlog.' The run prints which one ended the drag"
  - "The render held back during a drag is drawn at the drop as well as at dragend, so a dragend that never reaches the board cannot freeze it"
  - "Grouped by member, the other-row refusal reads 'This card stays in its own row. To give it to someone else, use Assign to in its Move to... menu. Nothing was moved.'; other groupings keep REFUSALS.differentRow"
  - "The keyboard path uses real keys (pressKey m, ArrowDown, Enter): a page-made Enter does not press a button, so the probe's key action could not show it"

patterns-established:
  - "e2e page errors are compared from a baseline taken before the steps under test, so notices from earlier steps do not hide or fake a result"

requirements-completed: [BOARD-03]

coverage:
  - id: D1
    description: "A real mouse drag in a real VS Code window puts a Ready bug on hold: the browser's dragstart, a drop on Backlog of the same row with verdict ok, one move request { type: 'move', itemId, target: 'hold' }, one more signed event on the coordination record, and the next state draws it in Backlog (G-62-6)"
    requirement: BOARD-03
    verification:
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[board] a real mouse drag of the Ready bug into Backlog of its own row puts it on hold: one move request, one more signed event, and the card drawn in Backlog"
        status: pass
    human_judgment: false
  - id: D2
    description: "A refused drop on the folded In progress column moves and writes nothing, leaves the card in Backlog with the model's sentence on it, announces it, and the card is in view; drag-refused-dark-1400.png"
    requirement: BOARD-03
    verification:
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[board] a real drag of the held bug onto the folded In progress column is refused ..."
        status: pass
      - kind: unit
        ref: "src/test/boardDrag.test.ts#62-23: a refused drop brings the card with its reason into view (nearest edge), and an offered drop does not scroll"
        status: pass
    human_judgment: false
  - id: D3
    description: "A drop into another row is refused: Group by Phase with the row sentence (real window), Group by Member pointing to Assign to in Move to... (fake DOM)"
    requirement: BOARD-03
    verification:
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[board] grouped by phase, a real drag into another phase row is refused with the row sentence and nothing is moved"
        status: pass
      - kind: unit
        ref: "src/test/boardDrag.test.ts#62-23: in Group by Member a drop in another person's row is refused with the way forward ..."
        status: pass
    human_judgment: false
  - id: D4
    description: "Cancelling a real drag over an offered cell posts and writes nothing and announces that the card is still in its column; drag-over-dark-1400.png shows the offered cells"
    requirement: BOARD-03
    verification:
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[board] Escape during a real drag over the offered Ready cell cancels it ..."
        status: pass
    human_judgment: true
    rationale: "Escape itself does not reach a DevTools-driven drag; the e2e ends it with Input.cancelDragging (what the system drag loop does on Escape). Escape in a person's real drag is the browser's own behaviour plus the page's dragend path (boardDrag.test.ts 'Escape during a drag ...'); the owner confirms it by hand in 62-24"
  - id: D5
    description: "A board update during a drag never moves or replaces the dragged card; it is drawn when the drag is dropped or ends"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/boardDrag.test.ts#62-23: a state that arrives during a drag never removes, moves or replaces the dragged card; the render after dragend draws it"
        status: pass
    human_judgment: false
  - id: D6
    description: "Move to... is the keyboard path in the same window: real M, Down to 'Ready (release the hold)', Enter releases the hold"
    requirement: BOARD-03
    verification:
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[board] Move to... is still the keyboard path in the same window ..."
        status: pass
    human_judgment: false
  - id: D7
    description: "The DevTools endpoint exists only for the board e2e launch, on a free 127.0.0.1 port, and no shipped file mentions remote debugging; the e2e makes no drag event in the page"
    verification:
      - kind: unit
        ref: "src/test/boardDrag.test.ts#62-23: only the board e2e launch opens a DevTools port, on a free port of this computer, and no shipped file mentions remote debugging"
        status: pass
      - kind: other
        ref: "grep -cE 'new DragEvent|dispatchEvent\\(' src/test/e2e/suite.ts = 0"
        status: pass
    human_judgment: false
  - id: D8
    description: "Dragging works for the owner in their own VS Code (desktop, possibly Wayland) and in code-server"
    verification: []
    human_judgment: true
    rationale: "The e2e runs Electron on X11 under Xvfb with DevTools input; the owner's report may come from a Wayland session or code-server, which only a hands-on check in 62-24 covers"

duration: 30min
completed: 2026-11-04
---

# Phase 62 Plan 23: Real mouse drag in a real window Summary

**The board e2e now drags cards with DevTools Protocol mouse input in a real VS Code window on the hidden screen: a Ready bug lands on hold in Backlog with one signed event, a drop on In progress snaps back with the model's reason, a drop into another phase row is refused, a cancelled drag writes nothing, and Move to... still works from the real keyboard. Mouse input started a native drag in this Electron (Chrome 150) on the first try, so the intercepted fallback was never needed. The page now holds renders back during a drag, keeps an e2e-only drag log, points a Member-row drop to Assign to, and scrolls a refused card's reason into view.**

## Performance

- **Duration:** about 30 min
- **Started:** 2026-11-04T11:19:52Z
- **Completed:** 2026-11-04T11:50Z
- **Tasks:** 2 of 2
- **Files modified:** 8

## Accomplishments

- **DevTools port, board launch only.** `freeLocalPort()` gets a free port from the system on 127.0.0.1. The board launch alone gets `--remote-debugging-port=<port>` and `NEAR_AI_E2E_CDP_PORT`. Chromium printed `DevTools listening on ws://127.0.0.1:<port>`, and the endpoint closes with that VS Code. A unit test checks that no other launch and no shipped file (src without src/test, media, package.json) mentions remote debugging.
- **Real drags.** `aim()` brings the card into view, then adds the webview frame's place in the window (`webviewFrameRect`) to the probe's page positions. The drop point is the middle of the target cell at the card's own height, inside the visible region. `realDrag()` calls `mouseDrag` first, and if the page's drag log shows no dragstart within 2 s it tries `interceptedDrag`. Every run printed `drag path: mouse`.
- **What a real drag looks like (drag log, offered drop):** `dragstart unassigned/ready started; dragenter unassigned/ready own; dragenter unassigned/backlog ok; drop unassigned/backlog ok; dragend unassigned/ready dropped`.
- **Findings in the real window:**
  - Nothing stops a drag here. Of the 38 cards drawn at first open, 33 can be dragged by the owner (32 plans and the bug). The 5 that cannot are phase cards, which have no moves.
  - A refused card grew below the region's edge, so its reason was out of sight; drag.js now scrolls it into view.
  - Escape does not reach a DevTools-driven drag (see Decisions).
  - A page-made Enter does not press a menu button, so the keyboard path uses real keys.
- **Page changes:**
  - `api.setDragging` holds renders back during a drag and draws once at the drop or dragend.
  - The drag log has `{ event, column, lane, verdict }`, one dragenter per cell entered, and keeps the last 20 entries, only on data-e2e pages.
  - The Member-row sentence points to Assign to.
  - Refused cards are scrolled into view.
- **Screens.**
  - `drag-over-dark-1400.png` was taken mid-drag with 0 probe problems. It shows the faded card and the dashed offered cells Ready, Done and Cancelled.
  - `drag-refused-dark-1400.png` was taken after a clean reading. It shows the bug in Backlog with "Starting work from the board arrives with claims in a later update. Nothing was moved."
  - Both frames are listed in `screens/index.json` with view `drag-over` and `drag-refused`.

## Task Commits

1. **Task 1 (tracer): a real mouse drag puts a Ready card on hold**
   - `dc75d72` test: failing tests for render deferral, the e2e drag log and the board-only DevTools port (RED)
   - `36391d8` feat: real mouse drag in a real window, render deferral, drag log, DevTools port (GREEN)
2. **Task 2: refusals, other row, Escape, keyboard path, screenshots**
   - `045ef44` test: failing test for the Member-row refusal pointing to Assign to (RED)
   - `d9caf71` feat: Member-row sentence, refused card in view, e2e steps and frames, ArrowDown key (GREEN)

The measured count from `plan_head_before` is 6. That includes two planning commits the orchestrator made on this branch while the plan ran (`1d1c00a` docs(61): record the solo-friendly Team section finding, `0025c36` docs(61): plan 61-26). This plan made 4 commits, plus the SUMMARY commit.

## TDD Gate Compliance

- **Task 1 RED** (`dc75d72`): `node --test --test-reporter=tap dist/test/boardDrag.test.js` exited 1 with 21 tests, 17 passing and 4 failing. `gsd-tools check tdd-red-evidence .vscode-test/red/62-23-t1.json` returned RED_EVIDENCE_OK (target_test_failed). Semantic assessment: the target "a state that arrives during a drag never removes, moves or replaces the dragged card..." failed on its planned assertion "it stays in Ready while the drag lasts" (true expected, false actual), because the card moved mid-drag. The drag log tests failed on the missing dragLog, and the port test failed on "the board launch passes --remote-debugging-port". There was no load or build fault.
- **Task 1 tracer gate (auto mode).** The board e2e verify was re-run after the GREEN commit: exit 0, 40 board passes, `drag path: mouse`. Expansion went ahead.
- **Task 2 RED** (`045ef44`): exited 1 with 22 tests, 21 passing and 1 failing. RED_EVIDENCE_OK on the target "in Group by Member a drop in another person's row is refused with the way forward...". It failed on the caption text, which still had the generic row sentence.
- **GREEN:** `36391d8` passed 88 of 88 (boardDrag, boardClient, boardMenu, teamBoardAssets). `d9caf71` passed 109 of 109 (those files plus cdpClient and teamPlainLanguage). No REFACTOR commits.
- Two small additions in Task 2 were not committed as separate RED commits: the refused-card scroll test, which was seen failing before the fix, and the ArrowDown pressKey test. They are listed under Deviations.

## Verification

- **Task 1 unit verify:** 88/88. **Task 1 e2e verify** (`xvfb-run -a -s "-screen 0 1920x1080x24 -fbdir D"`, NEAR_AI_E2E_ONLY=board, MemoryMax=6G, timeout 1800, choom): exit 0, 40 board passes, 0 failures, `drag path:` line present, and the same on the gate re-run.
- **Task 2 unit verify** (boardDrag, teamPlainLanguage): 30/30. **Task 2 e2e verify:** exit 0, 45 board passes, 0 failures, 27 PNG files (the 25 matrix frames and 2 drag frames), and `.vscode-test/screens/drag-refused-dark-1400.png` exists.
- **All 22 board-related unit files** (board*, teamBoard*, cdpClient, xwdPng, x11Window, teamPlainLanguage): 304/304, 0 skipped. `tsc -p tsconfig.json` is clean.
- **Acceptance checks:**

  | Check | Result |
  | --- | --- |
  | `grep -c remote-debugging-port src/test/e2e/run.ts` | 1 |
  | `grep -cE "new DragEvent\|dispatchEvent\(" src/test/e2e/suite.ts` | 0 |
  | `grep -c mouseDrag src/test/e2e/suite.ts` | 3 |
  | `grep -c "use Assign to" media/board/drag.js` | 1 |

- package.json and package-lock.json are unchanged and nothing was installed. No em or en dash was added.
- **Not run here:** the full `npm test` and the full e2e. The phase gate is 62-24.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] A refused card's reason fell below the visible region**
- **Found during:** Task 2, first real refused drop.
- **Issue:** The probe reported "The focused card Bug DRAG is not fully visible on the screen". The reason line made the card taller than the space left under it.
- **Fix:** After `showRefusal`, drag.js calls `scrollIntoView({ block: 'nearest', inline: 'nearest' })` on the refused card. Offered drops do not scroll. A fake DOM test was added first and seen failing.
- **Files:** media/board/drag.js, src/test/boardDrag.test.ts
- **Commit:** d9caf71

**2. [Rule 3 - Blocking] Escape does not reach a DevTools-driven drag**
- **Found during:** Task 2.
- **Issue:** `pressKey(Escape)` with the button held left the drag alive. The page had focus (`document.hasFocus()` true) but got no keydown, the release dropped the card on Ready, and the hold was released.
- **Fix:** The test still presses Escape. When the drag log shows no dragend after it, the test ends the drag with `Input.cancelDragging` and prints that it did. The page side is the same path a person's Escape takes: dragend with no drop, then `cancel()`, then "Move cancelled. The card is still in Backlog." Nothing was relaxed in drag.js. D4 is left to a person to confirm.
- **Commit:** d9caf71

**3. [Rule 3 - Blocking] A page-made Enter does not press a button**
- **Found during:** Task 2.
- **Issue:** The probe's `key` action sends an untrusted KeyboardEvent. Menu items are buttons that act on the browser's own Enter, so no move was posted.
- **Fix:** The keyboard path sends real keys through pressKey (m, ArrowDown, Enter). `cdp.ts` gained ArrowDown, which was not in the plan's file list, with a unit test. The e2e facts gained `hasFocus` and `focusedText`.
- **Commit:** d9caf71

**4. [Rule 1 - Robustness] Held renders also end at the drop**
- **Found during:** Task 1. An existing fake DOM test drops without a dragend.
- **Issue:** Ending the hold only at dragend would freeze the board if a dragend never reached it, for example when the source node had been detached.
- **Fix:** A second drop listener calls `setDragging(false)` once the drop is handled. The planned behaviour still holds: no render moves the card while the drag is active.
- **Commit:** 36391d8

**5. [Rule 1 - Test mechanics] Two drag log test details**
- The page's arrays come from its own realm, so the empty log is copied out before comparing.
- The long-drag part drags `plan:90-02`, because `plan:90-01` is waiting for the host after the first drop and refuses a new drag while busy.
- **Commit:** 36391d8

**6. [Scope] Page error check limited to the drags**
- **Issue:** After the width and theme matrix, the page had already caught 8 "ResizeObserver loop completed with undelivered notifications." notices before the first drag.
- **Fix:** The keyboard-path step asserts no new page error after the drag set-up. The notice is logged in `deferred-items.md` (likely `syncHeadHeight` resizing the header row inside its own observer).
- **Commit:** d9caf71

---

**Total deviations:** 6 (2 bug fixes, 2 blocking, 1 test mechanics, 1 scope). **Impact:** no verdict was relaxed, no test was weakened or skipped, and the host still decides every drop.

## Issues Encountered

- **No drag defect reproduced here.** The owner's "can't seem to drag them anywhere" did not reproduce on this X11 Electron with the 62-21/62-22 layout. Three possible causes remain, and 62-24 should check them by hand:
  - The owner's VS Code runs natively on Wayland. This e2e forces X11 (62-21), and Electron's Wayland drag and drop is a separate code path.
  - code-server.
  - Phase cards (5 of 38 at first open) cannot be dragged at all and give no hint why.
- **Another agent's e2e.** One e2e run elsewhere on the machine was waited out (about 2 minutes) before the final Task 2 run. Every e2e ran with 4 GB or more available.

## Known Stubs

None.

## Threat Flags

None beyond the register.
- **T-62-71:** the port is on 127.0.0.1, free, for the board launch only, and closes with the window. A unit test checks that no shipped file mentions it.
- **T-62-72:** drag.js still acts only on its own session's id, and the host re-plans every move.
- **T-62-73:** suite.ts makes no DOM drag events (grep 0). The log shows the browser's own dragstart, and the run prints the path.
- **T-62-SC:** no installs.

## User Setup Required

None.

## Next Phase Readiness

- 62-24 (owner check) has drag-over-dark-1400.png and drag-refused-dark-1400.png beside the 25 matrix frames.
- The owner should try a drag in their own VS Code (Wayland or X11 session) and in code-server. Things to check:
  - Ready to Backlog lands.
  - In progress refuses with the reason.
  - Escape cancels.
  - Phase cards cannot be dragged, which is expected because they have no moves.

## Self-Check: PASSED

- All 8 modified files exist, and `.vscode-test/screens/drag-over-dark-1400.png`, `drag-refused-dark-1400.png` and `index.json` exist.
- Commits dc75d72, 36391d8, 045ef44 and d9caf71 are ancestors of HEAD, and `git rev-list --count 447c423..HEAD` before this SUMMARY is 6.

---
*Phase: 62-work-model-gsd-import-team-board-live-read-and-move*
*Completed: 2026-11-04*
