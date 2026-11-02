---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 10
subsystem: team-board-client
tags: [team-mode, webview, vanilla-js, accessibility, keyboard, fake-dom, node-vm]

requires:
  - phase: 62-work-model-gsd-import-team-board-live-read-and-move
    provides: "board.js core with the NearAiBoard API (registerMenu, setPending, showRefusal, onMessage, onRender, focusCard) and board.css #menu styles (62-09); card.moves from buildBoardModel (62-06); the move message and refused reply (62-08)"
provides:
  - "media/board/menu.js: the Move to... menu. Registered with NearAiBoard.registerMenu, it lists exactly the card's moves array in order with a separator before Block and Unblock, sends one { type: 'move', itemId, target } request, and shows the pending line"
  - "Refusals of the menu's own requests shown on the card with the error icon and Dismiss message, announced once as \"Can't move plan 90-01 to Backlog. REASON\", with focus back on Move to..."
  - "src/test/boardMenu.test.ts: 13 vm tests with the real buildBoardModel and board.js"
affects: [62-11, 62-12, 62-13, 62-14]

actuals:
  tokens: 11600
  tasks: 2
  commits: 4
plan_head_before: 8c790f15c878aa0bb4543796f89882d4c110f360
plan_head_after: ffefdfacfea5480172166093abbc0ae4c9441c0c

tech-stack:
  added: []
  patterns:
    - "One persistent #menu element created by menu.js, hidden when closed (so aria-controls=\"menu\" always points at something), rebuilt on open from cardData(id).moves"
    - "Refusals are drawn only for requests this script sent (an awaiting map by item id, ended by a refusal or by a state that shows the move happened), so the drag handler and the form can show their own refusals for the same message type without a double announcement"
    - "Tab moves focus to the opener and leaves the key alone, so the browser continues from the opener to the next element in page order"

key-files:
  created:
    - media/board/menu.js
    - src/test/boardMenu.test.ts
  modified: []

key-decisions:
  - "Enter and Space on a menu item run through the button's click, not a keydown handler, so the browser's own activation is used and nothing runs twice"
  - "The menu closes when the card's moves change under it (a teammate acted) or the card leaves the board, instead of offering stale moves; the host still re-plans every request"
  - "Refusal focus goes to the card's Move to... button, falling back to the opener and then the card itself; an empty reason (dismissed prompt) only restores focus when it was lost to the page body"
  - "Pending text is derived from the model: Moving to COLUMN... (column label from model.columns) for moves that change column, Saving... for Block and Unblock"

patterns-established:
  - "Feature scripts that share a host message type with another script guard on their own outstanding requests"

requirements-advanced: [BOARD-03]
requirements-completed: []

coverage:
  - id: D1
    description: "Every card with offered moves has a Move to... button and an M, Shift+F10 or ContextMenu path; the menu is labelled Move 90-01 to, items equal the moves array in order, separator before Block and Unblock; claim and integration targets never appear"
    requirement: BOARD-03
    verification:
      - kind: test
        ref: "dist/test/boardMenu.test.js#tracer: M opens the menu on a ready card, Down and Enter choose Backlog (put on hold), and one move request is posted with the pending line shown"
        status: pass
      - kind: test
        ref: "dist/test/boardMenu.test.js#tracer: in the list layout the row Move to... button opens the same menu with Enter"
        status: pass
    human_judgment: false
  - id: D2
    description: "Full keyboard model: Down and Up wrap, Home, End, letter jump, Enter and Space run, Escape returns focus to Move to..., Tab closes and continues, outside click closes, one menu at a time"
    requirement: BOARD-03
    verification:
      - kind: test
        ref: "dist/test/boardMenu.test.js#Up wraps from the first to the last item; Home and End jump; a letter jumps to the next item starting with it"
        status: pass
      - kind: test
        ref: "dist/test/boardMenu.test.js#Escape closes and focuses the Move to... button; Tab closes and leaves the key to the page; a click outside closes"
        status: pass
      - kind: test
        ref: "dist/test/boardMenu.test.js#the Move to... button opens, and pressing it again closes; opening a second card closes the first"
        status: pass
    human_judgment: false
  - id: D3
    description: "A refusal shows the reason on the card with the error icon and Dismiss message, is announced once, and returns focus to Move to...; an empty reason clears the pending line silently; no menu without moves, read-only, or offline"
    requirement: BOARD-03
    verification:
      - kind: test
        ref: "dist/test/boardMenu.test.js#a refusal shows on the card with the error icon and Dismiss message, is announced once, and returns focus to the Move to... button"
        status: pass
      - kind: test
        ref: "dist/test/boardMenu.test.js#a refusal with an empty reason (a dismissed prompt) clears the pending line and announces nothing"
        status: pass
      - kind: test
        ref: "dist/test/boardMenu.test.js#a card with no moves has no Move to... button and M opens nothing; a read-only model has none; an offline model cannot open it"
        status: pass
    human_judgment: false
  - id: D4
    description: "Text-only rendering and no dashes: no markup sink in menu.js, no U+2014 or U+2013, labels wrap inside the 320 px menu"
    requirement: BOARD-03
    verification:
      - kind: test
        ref: "dist/test/boardMenu.test.js#menu.js has no markup sink and no em or en dash in it"
        status: pass
    human_judgment: false
  - id: D5
    description: "Feel of the menu in the real view (placement near the edges, focus ring, screen reader wording of the menu and the refusal)"
    requirement: BOARD-03
    verification: []
    human_judgment: true
    rationale: "UI-SPEC backstop rows: vm tests assert structure, strings and focus but cannot see rendering or hear a screen reader"

duration: 18 min
completed: 2026-11-02
status: complete
---

# Phase 62 Plan 10: Move to... menu Summary

**A keyboard-first Move to... menu that offers exactly the host's moves, sends one move request with a pending line, and turns a refusal into a visible, announced reason with focus back on the button, proven in node:vm with the real board model.**

## Performance

- **Duration:** about 18 min
- **Tasks:** 2 (tracer, full keyboard model and refusals)
- **Files created:** 2 (menu.js, boardMenu.test.ts)
- **Tests:** 13 new vm tests, all passing; boardClient (24), teamBoardView, teamBoardModel and toolsPage suites still pass; `npm run lint` clean

## Accomplishments

- `menu.js` builds `#menu` (role menu, label "Move 90-01 to") from `cardData(id).moves`, with a role separator before Block and Unblock, positions it under the opener with `style.setProperty`, and sets `aria-expanded` on the Move to... button. It is the only way to move a card in the list layout and a full keyboard path in the kanban.
- Choosing an item closes the menu, returns focus to the opener, shows the pending line ("Moving to Backlog..." from the model's column label, or "Saving..." for Block and Unblock) and posts exactly `{ type: 'move', itemId, target }` once.
- Refusals to those requests reach `showRefusal`, which draws the reason with the error icon and Dismiss message and announces "Can't move plan 90-01 to Backlog. REASON" once; focus returns to Move to.... An empty reason (dismissed prompt) clears the pending line silently through the core.
- Read-only models, cards without moves and offline, paused or removed boards never open the menu.

## Task Commits

1. **Task 1 (tracer):** `a9ce670` test (RED, menu.js missing), `6910535` feat: open, Down/Up wrap, choose, pending line, list and kanban
2. **Task 2:** `e6e0e99` test (full keyboard model, refusals, edge cases), `ffefdfa` feat: Home, End, letter jump, Escape, Tab, outside click, refusal handling, follows the model

## Deviations from Plan

None - plan executed exactly as written. Notes: the standard test board has no blocked card, so the Unblock test adds a lead block event to the in-memory world; the plan's "state message that confirms the move clears the pending line" is board.js behaviour from 62-09 and is covered here as a regression test.

## Wiring notes for later plans

- The menu draws a `refused` reason only for a request it sent. 62-11 (drag) and 62-13 (form) reply handling for the same `refused` type must show their own refusals; they will not be duplicated by the menu.
- Only one `#menu` exists, appended to `document.body`, hidden when closed. It closes on a click outside, Escape (with `stopPropagation`, so a detail Escape handler on the document does not also fire), Tab, and when the card's moves change.
- `scripts/verify-release-content.mjs` still lists no media/board files (carried from 62-09; belongs with 62-14).

## Known Stubs

None.

## Threat Flags

None. T-62-35 transferred (the menu shows only the model's moves; the host re-plans on fresh state); T-62-36 mitigated (text-only rendering, markup-throwing fake DOM, negative grep for markup sinks and dashes); T-62-SC no installs.

## Self-Check: PASSED

- media/board/menu.js and src/test/boardMenu.test.ts exist.
- Commits a9ce670, 6910535, e6e0e99 and ffefdfa are on the branch; `npx tsc -p tsconfig.json && node --test dist/test/boardMenu.test.js dist/test/boardClient.test.js` reports 37 pass, 0 fail; `npm run lint` exits 0; `grep NearAiBoard.registerMenu media/board/menu.js` matches; the markup-sink grep returns nothing; `grep "already changed this card" src/test/boardMenu.test.ts` matches.
