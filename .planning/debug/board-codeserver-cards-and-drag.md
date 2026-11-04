---
status: awaiting_human_verify
trigger: "Owner re-test on preview 0.6.3 in code-server (Brave/Chromium): (1) 'I don't see any cards under Backlog which says it has 5. Only five cards are showing under unassigned even though it says it has 45 and Done has 40.' (2) '12. fail - no drag and drop working'. Neither shows in the real-VS-Code-window e2e."
created: 2026-11-04T17:20:00Z
updated: 2026-11-04T18:45:00Z
---

## Current Focus

hypothesis: "CONFIRMED. Issue 1 is not saved state: the board drew exactly what the model held (5 phase cards in Backlog of the Unassigned row, 40 done plans in folded Done), but nothing on screen said where the counted cards were: the row count (45) included the folded column's 40 cards whose cell showed nothing, and the open Backlog header was stretched into a 163 px empty box, so the cards below the row band read as Unassigned's. Issue 2 is not a browser defect: real mouse drags of a card with a move work in the owner's code-server build in Brave and Chromium; on the owner's board no drawn card could be picked up (phase cards have no move; a developer has none at all) and the page answered the attempt with nothing."
test: "Done: fake-DOM RED then GREEN; each part of each fix reverted alone; the kept code-server browser test (src/test/e2e/codeServerBoard.ts) fails 7 of 14 on the 0.6.3 board files and passes 14 of 14 on the fix in Brave 156 and Chromium 156; board e2e 57 of 57 in the real VS Code window; full unit suite 1937 pass, 1 unrelated flake."
expecting: "The owner re-checks in code-server (see the report): the row says (45, 40 in folded columns), Done's folded cell shows 40, the Backlog header is compact, a phase card drag shows 'Plan this phase first...', and opening Done then dragging a done plan to Backlog reopens it."
next_action: "Owner re-test in code-server on the next preview build; then archive this session."
reasoning_checkpoint:
  hypothesis: "Issue 1: the page counts cards it does not show and gives no visible sign where they are (folded-column cards in the row count; an open header stretched to look like an empty column; and, found by the invariant test, a person with cards only in another milestone has no row when that milestone is chosen). Issue 2: on the owner's data every drawn card has no move, and drag.js makes only cards with moves draggable (and only for owner/lead), so a drag never starts and nothing is said."
  confirming_evidence:
    - "Replay of the owner's own coordination log (copied from code-server's globalStorage) with dist buildBoardModel: Backlog 5 (phase:63..67, moves []), Done 40, Unassigned row count 45, exactly the owner's numbers."
    - "That model in the owner's code-server 4.144.0 build in Brave 156: the 5 cards are drawn in Backlog of the Unassigned row; the Backlog header is 256x163 px and empty below its caption; the folded Done cell shows nothing (screenshot out-owner/shot-1.png)."
    - "Real mouse drag (Input.dispatchMouseEvent) in the same setup of done plan 62-14 onto Backlog works end to end on the unchanged 0.6.3 board code (move 'reopen' posted, 'Reopened plan 62-14 in Backlog.'); the kept browser test's reopen checks also pass on the 0.6.3 files."
    - "On the 0.6.3 files the kept browser test reports phase:63 draggable false and an empty drag log for its drag; fake DOM: phase:91 and every developer card have no draggable attribute."
  falsification_test: "If the drag failure were browser-specific, the reopen drag of a card with a move would fail in code-server + Brave; it passes on old and new code. If Issue 1 were saved state, a fresh profile (no saved state at all) would draw differently from the owner's report; the fresh harness profile reproduces the owner's view exactly."
  fix_rationale: "Issue 1: the counts now say where the cards are (row count names folded cards, the folded cell shows its number, compact open headers) and the model gives every person with a card a row in every milestone, so a header never counts a card that no row draws. Issue 2: every kanban card can be picked up by the owner, a lead or a developer, and a card that cannot move gives the model's own reason on the drop (D-16), so a drag is never silent."
  blind_spots: "Brave on the owner's native Wayland session was not tested: DevTools mouse input cannot drive Wayland's own drag start, and no headless Wayland compositor with input injection is installed. The owner's live code-server was not driven (scratch copy of the same build and a recorded model instead of a live team session)."
  candidate_causes:
    - "data/state: saved webview state from 0.6.0-0.6.2 (eliminated: no serializer, panel state cannot cross versions; owner's IndexedDB holds no board state)"
    - "code (page): counts include cards with no visible sign (confirmed)"
    - "code (model): member lanes only from the selected milestone (confirmed, second path)"
    - "environment: browser-only HTML5 drag failure in nested webview iframes (eliminated for Chromium on X11; Wayland not testable here)"
    - "code (drag rule): only cards with moves, owner/lead, are draggable; no feedback otherwise (confirmed)"
    - "data: the scratch project has no card with a move in an open column (the trigger, by design of the scratch data)"
  and_gate: "yes for Issue 2: the silent no-drag rule (code) AND data where every drawn card has no move (the scratch roadmap, or a developer viewer) are both needed; the e2e board has many plans with moves, so it never met it. Issue 1 needs the count rules (code) AND data with most cards in a folded column."
bug_class: "Bohrbug (deterministic given the data); Phase 1.25 SBFL skipped: the failing behaviour had no failing test before this session."

## Symptoms

expected: "Every column whose header shows a count draws those cards when open (Backlog (5) shows 5 cards, Unassigned lane (45) shows its cards), also after upgrading from earlier previews; real mouse drag works in code-server in a browser."
actual: "In code-server on 0.6.3: Backlog says 5 but shows no cards; the Unassigned lane says 45 but only 5 cards show (Done says 40). Dragging a card does nothing in Brave/Chromium."
errors: "None reported."
reproduction: "Owner's code-server (container, data under /home/aaron/projects/services/code-server/data), scratch clones /home/aaron/projects/scratch/team-check/{alice,bob} of ALuhning/team-check-scratch, after previews 0.6.0, 0.6.1, 0.6.2 ran on the same paths."
started: "Seen on 0.6.3 (first code-server re-test after 62-19..62-25)."

## Eliminated

- hypothesis: "Saved webview state from 0.6.0-0.6.2 (getState/setState) carried old collapsed or folded choices into 0.6.3"
  evidence: "The board is an editor WebviewPanel with no registerWebviewPanelSerializer (grep: none) and no retainContextWhenHidden, so its getState/setState lives only while the panel lives; an extension update restarts the extension host, which closes the panel, so no saved board state can cross versions. In the owner's Brave IndexedDB (code-server keeps workbench state in the browser, not in state.vscdb; the workspaceStorage folders have no state.vscdb), memento/webviewView.nearAiTeamBoardView (the old 0.6.0 sidebar view) is {} in all three databases, no board webviewState exists, and workbench.parts.editor has no open editors. 62-21's version check also drops collapse, open-group and filter choices from unversioned state (existing test 'G-62-3: Done opened is kept across a reload; choices saved by the older board are dropped once...')."
  timestamp: 2026-11-04T18:05:00Z
- hypothesis: "code-server's browser (Brave/Chromium) blocks HTML5 drag inside the nested webview iframes (missing dataTransfer type, dragover not prevented, overlay pointer-events)"
  evidence: "In the owner's exact code-server 4.144.0 build (copied out of the local/code-server:stable container, run on 127.0.0.1 with a scratch profile) in Brave 156 under xvfb, a real mouse drag (Input.dispatchMouseEvent) of done plan 62-14 onto Backlog of the Unassigned row gave dragstart started, dragenter on every cell, drop backlog ok, dragend dropped, exactly one {type:'move', target:'reopen'} at the host and 'Reopened plan 62-14 in Backlog.' The webview iframe has pointer-events auto; the host page's dragover handler only adds preventDefault. Not tested: Brave on a native Wayland session (CDP input cannot drive Wayland's own drag start)."
  timestamp: 2026-11-04T18:10:00Z

## Evidence

- timestamp: 2026-11-04T17:40:00Z
  checked: "The scratch team's coordination mirror (copied from code-server globalStorage team-55bf4b03...), replayed with dist reduce + buildBoardModel for Alice, first 155 entries (before the first assignment)"
  found: "columns backlog 5 (open), ready 0 (open), claimed..integrating 0 (folded), done 40 (folded), cancelled 0 (folded); one member lane Unassigned count 45, not collapsed; cards: phase:63..67 in Backlog (kind phase, moves [], assignActions ['assign']), 40 done plans (moves [reopen->backlog]). This is exactly the owner's numbers: Backlog 5, Unassigned 45, Done 40."
  implication: "The owner's data has no open-column card with a move: every drawn card is a phase card."
- timestamp: 2026-11-04T17:58:00Z
  checked: "That model in the owner's code-server build in Brave 156 at 1600x1000 (scratch harness extension that loads the real media/board files into a webview panel the way boardView.ts does)"
  found: "The 5 phase cards are drawn in the Backlog cell of the Unassigned row (cells backlog/unassigned 5 cards). The Backlog header box is 256x163 px and empty below its caption, stretched by the grid row to the height of the vertical folded stubs. The lane title band 'Unassigned (45)' sits between the header and the cards. The 6 folded cells of the row are blank grey strips; the 40 done cards are only in a screen-reader text '40 cards, column folded'. Screenshot: scratchpad out-owner/shot-1.png."
  implication: "A person reads the cards as 'under Unassigned', the Backlog column as empty with a count of 5, and the lane as 5 shown of 45 with nothing saying where the other 40 are. That is the owner's report word for word."
- timestamp: 2026-11-04T18:00:00Z
  checked: "62-UAT setup line and 62-23/62-24 SUMMARYs"
  found: "The scratch project has always had 40 done plans and 5 planless phases. 62-23 and 62-24 recorded 'Phase cards cannot be dragged and give no hint' as deferred; the UI-SPEC says draggable only when moves.length > 0; boardDrag.test.ts asserts the developer gets nothing draggable."
  implication: "On the owner's board, pressing and dragging any drawn card does nothing at all, with no word why; the real-window e2e board has many plans with moves, so it never met this."
- timestamp: 2026-11-04T18:10:00Z
  checked: "Real mouse drag in code-server + Brave of a card with a move (see Eliminated)"
  found: "Works end to end."
  implication: "The drag path is not browser-specific; the owner had nothing draggable on screen."

- timestamp: 2026-11-04T18:20:00Z
  checked: "Invariant test over every Group by choice and milestone choice (fake DOM, real buildBoardModel): for each column, cards drawn in rows plus folded counts equal the header count"
  found: "Failed on 'Member on milestone:v0.8.0: the ready header counts 1, the lanes draw 0': the model built member rows only from the selected milestone's cards, so a person whose cards were all in the other milestone had no row there."
  implication: "Second path to 'a header counts cards no cell draws'; fixed in the model (a row per person with a card in any milestone) and the page (a person's row shows when they have a card in the milestone shown)."
- timestamp: 2026-11-04T18:30:00Z
  checked: "Kept browser test in code-server 4.144.0, VS Code's webview frames"
  found: "Inside the board page window.parent === window (VS Code's webview host hides the real parent), so a frame walk up window.parent never ends; frameElement.ownerDocument.defaultView reaches the workbench."
  implication: "Test-tool detail only; the facts walk uses frameElement."
- timestamp: 2026-11-04T18:40:00Z
  checked: "Verification runs (see Resolution.verification)"
  found: "All green except one full-suite failure in teamConcurrency (forked clients sharing one mirror: lamport 11 twice), which imports none of the changed files and passed 3 of 3 alone."
  implication: "Logged as a separate deferred item, not caused by this fix."

## Resolution

root_cause: "Issue 1 (Backlog 5 with no cards under it, Unassigned 45 with 5 in sight): not saved state. On the owner's data (40 done plans, 5 planless phases) the board drew the 5 phase cards in Backlog of the Unassigned row as the model said, but (a) the row count included the 40 cards of the folded Done column, whose cell showed nothing visible; (b) the open column header was stretched by the grid row to the height of the turned names of the folded stubs, so Backlog looked like a 163 px empty column and its cards, below the row band, read as Unassigned's; (c) second path, found by the invariant test: the model built member rows from the selected milestone only, so with another milestone (or All) chosen a person whose cards were all there had no row and the headers counted cards no row drew. Issue 2 (no drag and drop in code-server): not a browser defect. drag.js made a card draggable only when it had a move and the viewer was the owner or a lead; on the owner's board every drawn card was a phase card (no move) and a developer has no move at all, so nothing could be picked up and the page said nothing."
fix: "board.js: the row count says how many of its cards are in folded columns ('Unassigned (45, 40 in folded columns)'); a folded cell that holds cards shows their number (aria-hidden; the screen-reader sentence stays); a person's row is drawn when they have a card in the milestone shown. board.css: .colheads align-items: start (open headers as tall as their words); quiet theme-colour style for the folded count. board.ts: member lanes for every person with a card in any milestone (count and collapse still from the selected milestone). drag.js: every kanban card is draggable for the owner, a lead and a developer while the board is up (not for a reviewer, an observer, the list or an offline/paused/removed board); a card with no move offers no cell, shows 'Can't drop here: {reason}' on hover and the model's refusal on the drop (announced, nothing posted), its own reason before the row sentence. 62-UI-SPEC amended."
verification: |
  - RED commits 9886f8b (Issue 1: 4 failing in boardClient) and 8f6667e (Issue 2: 3 failing); GREEN 185bb54 and f9c2b5d.
  - Mutation checks: each part reverted alone, only its own test failed (lane count, folded count, page row filter, header CSS, model member lanes; drag roles, down state, reason-before-row-sentence). With the exact old drag rule exactly the 3 new or updated drag tests fail.
  - Board unit set (board*, teamBoard*, teamPlainLanguage, cdpClient): 302 of 302, then 85 of 85 for the touched files after the browser test commit.
  - Kept browser test src/test/e2e/codeServerBoard.ts (commit 0f4c7d0), owner's code-server 4.144.0 (Code 1.144.0): Brave 156 14 of 14 (twice), Chromium 156.0.8078.4 14 of 14; with the 0.6.3 media/board files put back: 7 of 14 fail (no folded counts, stretched header, phase card not draggable, no drag log, no reason) while the reopen drag passes.
  - Board e2e in the real VS Code window (NEAR_AI_E2E_ONLY=board, xvfb-run -a): exit 0, 57 of 57 board steps; '40 of 40 drawn cards can be dragged by the owner: 31 plan, 5 phase, 4 item; drag path: mouse'.
  - Full npm test (6G cap): 1949 tests, 1937 pass, 1 fail (teamConcurrency forked-mirror flake, unrelated, 3 of 3 alone), 11 skipped. tsc clean.
  - Full e2e (all launches, xvfb-run -a, 6G cap): exit 0, 90 of 90 (project 8, plain 2, team 7, team-lead 5, team-join 7, team-confirm 4, board 57).
oracle_type: "specified (the owner's exact sentences and numbers; D-16 refusal copy from the model) plus a derived invariant (header count = drawn cards + folded counts for every grouping and milestone)"
files_changed: [media/board/board.js, media/board/board.css, media/board/drag.js, src/domain/team/board.ts, src/test/boardClient.test.ts, src/test/boardDrag.test.ts, src/test/teamBoardAssignModel.test.ts, src/test/helpers/teamBoardWorld.ts, src/test/e2e/codeServerBoard.ts, src/test/e2e/cdp.ts, src/test/cdpClient.test.ts, .planning/phases/62-work-model-gsd-import-team-board-live-read-and-move/62-UI-SPEC.md]
