---
status: diagnosed
phase: 62-work-model-gsd-import-team-board-live-read-and-move
source: [62-VERIFICATION.md human_verification, owner hands-on session on the 0.6.0 team preview build]
started: 2026-11-03T20:00:00Z
updated: 2026-11-03T21:00:00Z
---

## Current Test

number: none
name: stopped by the owner: "UI is almost unusable at this point"; fix pass first (owner, 2026-11-03)
awaiting: gap closure

## Tests

Setup: preview VSIX 0.6.0, code-server, scratch project `ALuhning/team-check-scratch` seeded with this repository's v0.6.0 roadmap (40 plans in Phases 60 to 62, all done; Phases 63 to 67 have no plans).

### 1. Where the board opens
expected: the board opens where the person chooses.
result: issue
reported: "I'm seeing a team board panel that opened by itself below the chat window ... When I use the palette to open the team board, it opens in its own window which is preferable."
severity: major

### 2. Scrolling the board
expected: the toolbar stays on top and nothing shows through it.
result: issue
reported: "scrolling in it causes bottom half to scroll up and disappear behind the top half" and "the top part of the window ... remains frozen and transparent so you can see cards behind them"
severity: blocker

### 3. Import and visible work
expected: imported work is visible as cards.
result: issue
reported: "there none, unassigned has a (40) but expanding it shows them in done and they aren't immediately visible"
severity: major

### 4. Layout of columns and lanes
expected: columns and lanes never overlap.
result: issue
reported: "UI is almost unusable at this point - backlog columns expanded bleed down under unassigned."
severity: blocker

### 5. Assign a card to someone
expected: a lead can put a person on a card.
result: issue
reported: "Don't see any way to assign cards to anyone."
severity: major

### 6. Drag and drop
expected: a card can be dragged to an allowed column; a refused drop snaps back with a reason.
result: issue
reported: "can't seem to drag them anywhere"
severity: blocker

### 8. Cards are readable
expected: every card's title, state and details are readable.
result: issue
reported: "check the board cards - they look like the formatting is off/they are unreadable" ... "I just noticed them during the e2e tests, I think it's #1" (collapsed columns)
severity: major

### 7. Themes, zoom, screen reader, two windows
expected: see 62-VERIFICATION.md human_verification.
result: blocked
blocked_by: prior-phase
reason: stopped before reaching them; resume after the fix pass.

## Summary

total: 8
passed: 0
issues: 7
pending: 0
skipped: 0
blocked: 1

## Gaps

- truth: "The board opens only as an editor tab (Open board); the sidebar shows a compact Team summary (counts for ready, blocked, mine, plus Open board) instead of the full board, and nothing opens by itself when Team Mode turns on"
  status: failed
  reason: "User reported: a team board panel opened by itself below the chat window ... opening in its own window is preferable"
  severity: major
  test: 1
  root_cause: "package.json contributes nearAiTeamBoardView (webview view, when nearAi.teamMode) in the secondary sidebar container, so it appears when Team Mode turns on"
  artifacts: [package.json, src/services/team/boardView.ts]
  missing: ["remove the sidebar board view or replace with a compact summary", "Open board opens the editor panel"]
  debug_session: ""
- truth: "The sticky board toolbar has a solid theme background and sits above the cards; scrolling never shows cards behind it or hides them under it"
  status: failed
  reason: "User reported: frozen and transparent top part, cards scroll behind it"
  severity: blocker
  test: 2
  root_cause: "media/board/board.css:19 #toolbar { position: sticky; background: inherit } inherits a transparent background from its container"
  artifacts: [media/board/board.css]
  missing: ["explicit background (editor or sidebar background variable)", "visual check in a real window"]
  debug_session: ""
- truth: "Imported work is visible on open: phases without plans appear as backlog cards, active and upcoming work is shown expanded, and Done is the folded part"
  status: failed
  reason: "User reported: unassigned (40) but expanding shows them in done and they aren't immediately visible"
  severity: major
  test: 3
  root_cause: "import creates items only for plans; lanes/columns default to collapsed; finished work dominates"
  artifacts: [src/domain/team/gsdImport.ts, src/team/importPlans.ts, src/domain/team/board.ts, media/board/board.js]
  missing: ["phase cards for planless phases", "default expansion rules"]
  debug_session: ""
- truth: "Columns and lanes lay out without overlap at every width and zoom, verified with real screenshots of the board in a real VS Code window that the owner reviews"
  status: failed
  reason: "User reported: backlog columns expanded bleed down under unassigned"
  severity: blocker
  test: 4
  root_cause: "board layout CSS (lanes x columns) lets expanded column content overflow into the next lane; only fake-DOM tests and a code-only UI review existed"
  artifacts: [media/board/board.css, media/board/board.js]
  missing: ["layout fix", "real-window screenshot verification (e2e captures)", "layout-probe overflow checks like the 0.4.14 panels"]
  debug_session: ""
- truth: "A lead (owner or lead) can assign a card to a team member and unassign it, from the card's Move menu and detail; the card shows the person, the member lane shows it, and the change is a signed, permission-checked event visible to everyone within one poll. Any confirmed member who is not an observer can also assign a card to themselves and unassign themselves (Assign to me, Unassign me); observers, including joined members waiting for a lead, cannot (owner decision 2026-11-03)"
  status: failed
  reason: "User reported: Don't see any way to assign cards to anyone."
  severity: major
  test: 5
  root_cause: "assignment was scheduled for Phases 63 and 64 (claims and dispatch); item.assign exists only as a declared permission"
  artifacts: [src/domain/team/types.ts, src/domain/team/permissions.ts, src/domain/team/materialize.ts, src/domain/team/board.ts, media/board/*]
  missing: ["item.assigned event (or equivalent) with validator, permission row, materializer and read-path check", "UI to assign/unassign", "member lane uses the assignee", "self-assignment for every confirmed member who is not an observer, checked on write and read (owner decision 2026-11-03)"]
  debug_session: ""
- truth: "Dragging a card to an allowed column moves it in a real VS Code and code-server window, a refused drop snaps back with the reason, and the Move to menu remains the keyboard path; covered by a real-window e2e that performs a drag"
  status: failed
  reason: "User reported: can't seem to drag them anywhere"
  severity: blocker
  test: 6
  root_cause: "drag and drop was only exercised against the fake DOM (boardDrag.test.ts); real webview drag events/data transfer behave differently"
  artifacts: [media/board/drag.js, media/board/board.js, src/test/e2e/suite.ts]
  missing: ["working real-window drag", "e2e that drags"]
  debug_session: ""
- truth: "Every card is readable in every state, width and theme: a collapsed column shows only its name and count (never squeezed cards), titles wrap at word boundaries, and the card's clickable area keeps card styling (left-aligned, theme foreground), verified in real-window screenshots"
  status: failed
  reason: "User reported: the board cards look like the formatting is off / they are unreadable (seen in e2e windows; owner thinks it is collapsed columns)"
  severity: major
  test: 8
  root_cause: "media/board/board.css: .cell.collapsed { width: 40px; overflow: hidden; font-size: 0 } still contains rendered cards; .card and descendants use overflow-wrap: anywhere (mid-word breaks); .card-main is a button and inherits global button styles (centred, button colours)"
  artifacts: [media/board/board.css, media/board/board.js]
  missing: ["collapsed cells render no cards (only name and count)", "word-boundary wrapping for titles", "card-main resets button styles", "screenshot check of card readability"]
  debug_session: ""
