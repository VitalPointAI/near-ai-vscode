---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 11
subsystem: team-board-client
tags: [team-mode, webview, vanilla-js, drag-and-drop, accessibility, fake-dom, node-vm]

requires:
  - phase: 62-work-model-gsd-import-team-board-live-read-and-move
    provides: "board.js core with the NearAiBoard API (onRender, onMessage, cardData, cardElement, setPending, showRefusal, announce, layout) and the drag classes in board.css (62-09); BoardCard.moves and refusals (62-06); the Move to... menu that draws refusals only for its own requests (62-10); drag.js already listed in BOARD_SCRIPTS (62-08)"
provides:
  - "media/board/drag.js: native HTML5 drag and drop for the kanban. Cards with offered moves are draggable; the offered cells of the card's own row light up; an offered drop posts exactly one { type: 'move', itemId, target } request with the pending line; every other drop snaps back with the card's own reason shown and announced"
  - "Cancel handling (Escape, or a drag that ends without a drop), the foreign-drag guard (only the application/x-near-ai-card type is acted on), the transient Can't drop here caption, and a 150 ms FLIP glide that is skipped entirely under prefers-reduced-motion"
  - "src/test/boardDrag.test.ts: 16 vm tests with the real buildBoardModel, board.js and (for the no-duplicate-refusal proof) menu.js"
affects: [62-12, 62-13, 62-14]

actuals:
  tokens: 9100
  tasks: 2
  commits: 4
plan_head_before: 1d7eddd8a46f07f35b65a3da2eb40d642a6dd67a
plan_head_after: 0d2e4d47df44050c957a371bc03acb036236bd81

tech-stack:
  added: []
  patterns:
    - "Delegated drag listeners on the persistent #board element, so cells and cards that board.js recreates never need rewiring; NearAiBoard.onRender only re-syncs draggable, highlights and motion"
    - "A drag session object { id, lane, state: active | dropped | cancelled } that outlives the drop until dragend, so the end of the drag can tell a drop from a cancel"
    - "Refusals of requests this script sent are tracked in an awaiting map by item id (same idea as menu.js), so each of the three senders draws its own refusal once and never on the wrong card"
    - "FLIP keyed by card id: last known rects are refreshed at every render and again at dragstart; only cards whose column changed glide; the starting transform is set, a rect read forces the style, then the 150 ms transition is switched on"

key-files:
  created:
    - media/board/drag.js
    - src/test/boardDrag.test.ts
  modified: []

key-decisions:
  - "Every cell accepts the drop (dragover is prevented for any cell while a board drag is active) so a refused drop can give its reason instead of the browser flying the drag image back without a word, as the UI-SPEC says"
  - "A drag still in the active state when dragend arrives counts as cancelled whatever dropEffect says, a superset of the 'dropEffect none and no drop' rule; it is the truthful reading (nothing was changed) and covers a drop the handler declined"
  - "A card is draggable only in the kanban, with at least one offered move, for an owner or lead, and not while the board is offline, paused or removed or while the card has a pending write (aria-busy); this mirrors the conditions board.js uses for the Move to... button"
  - "The caption has pointer-events none (set through style.setProperty, no CSS added) so it can never cause a dragleave flicker; dragleave also ignores moves into a child of the same cell"
  - "The refusal for a column that is neither offered nor in the card's refusals map falls back to 'This card cannot be moved there. Nothing was moved.' so a refused drop can never be silent (prohibition T-62-BOARD-03)"

patterns-established:
  - "Feature scripts that share the host message type 'refused' each keep their own awaiting map; none draws a reason for a request it did not send"

requirements-advanced: [BOARD-03]
requirements-completed: []

coverage:
  - id: D1
    description: "In the kanban a card is draggable only with offered moves; the list and a model without moves have no draggable element at any width under 520 px"
    requirement: BOARD-03
    verification:
      - kind: test
        ref: "dist/test/boardDrag.test.js#tracer: in the kanban only a card with offered moves is draggable; the list and a model without moves have none"
        status: pass
      - kind: test
        ref: "dist/test/boardDrag.test.js#at 400 px nothing is draggable and drag events do nothing"
        status: pass
    human_judgment: false
  - id: D2
    description: "dragstart sets the id under application/x-near-ai-card only, marks the offered cells of the card's own row, and a drop on one posts exactly one move for that column's key with the pending line while the card stays put until the next state"
    requirement: BOARD-03
    verification:
      - kind: test
        ref: "dist/test/boardDrag.test.js#tracer: dragstart carries the id under the board type, marks the offered cells of its own lane, and a drop on Backlog posts the hold with the pending line"
        status: pass
      - kind: test
        ref: "dist/test/boardDrag.test.js#a not-ready backlog card gets the model sentence on the Ready cell, and a done card gets the reopen sentence"
        status: pass
    human_judgment: false
  - id: D3
    description: "A refused drop (claim and integration columns, not-ready, reopen-only, another row) posts nothing, never moves the card, shows the card's own reason, announces Can't move plan 90-01 to COLUMN. REASON, and shows the hover caption; the own column does and says nothing"
    requirement: BOARD-03
    verification:
      - kind: test
        ref: "dist/test/boardDrag.test.js#a drop on a claim or integration column posts nothing, leaves the card where it is, shows the reason on the card and announces it"
        status: pass
      - kind: test
        ref: "dist/test/boardDrag.test.js#hovering a refused cell shows the caption inside it, and the caption goes on leave and on drop"
        status: pass
      - kind: test
        ref: "dist/test/boardDrag.test.js#a drop in another row is refused with the row sentence; a drop on the card's own column does and says nothing"
        status: pass
    human_judgment: false
  - id: D4
    description: "Escape or a drag that ends without a drop clears every highlight and announces Move cancelled. The card is still in Ready. once; a dropped drag announces no cancel"
    requirement: BOARD-03
    verification:
      - kind: test
        ref: "dist/test/boardDrag.test.js#Escape during a drag, or a drag that ends with no drop, clears the highlights and announces the cancel once"
        status: pass
      - kind: test
        ref: "dist/test/boardDrag.test.js#a drag that is dropped on an offered cell does not announce a cancel when it ends"
        status: pass
    human_judgment: false
  - id: D5
    description: "Drops that do not carry the board's data type are ignored, and a host refusal of a drop is drawn once on that card with the menu and the drag script never double-announcing"
    requirement: BOARD-03
    verification:
      - kind: test
        ref: "dist/test/boardDrag.test.js#drops that do not carry the board type are ignored"
        status: pass
      - kind: test
        ref: "dist/test/boardDrag.test.js#a drop sent by drag.js that the host refuses shows the reason once on that card, and the menu does not draw it again"
        status: pass
      - kind: test
        ref: "dist/test/boardDrag.test.js#a refusal for a request the menu sent is left to the menu, and a dismissed drop prompt clears the pending line silently"
        status: pass
    human_judgment: false
  - id: D6
    description: "A confirmed move glides with a 150 ms transform transition when motion is allowed and sets no transform under prefers-reduced-motion; the 3 second changed outline stays; no markup sink, no dashes, no inline style attribute"
    requirement: BOARD-03
    verification:
      - kind: test
        ref: "dist/test/boardDrag.test.js#after a confirmed drop the card relocates with a 150 ms transform transition that is cleared afterwards"
        status: pass
      - kind: test
        ref: "dist/test/boardDrag.test.js#under reduced motion no transform is ever set, and the changed outline for a teammate move stays"
        status: pass
      - kind: test
        ref: "dist/test/boardDrag.test.js#drag.js reads the reduced motion setting, names the row sentence, and keeps every string free of em and en dashes"
        status: pass
    human_judgment: false
  - id: D7
    description: "How dragging feels in a real browser and webview: drag image, drop target legibility in light, dark and high contrast, the glide, native Escape cancel, and a real pointer drag across lanes"
    requirement: BOARD-03
    verification: []
    human_judgment: true
    rationale: "UI-SPEC backstop rows: vm tests drive synthetic drag events against a fake DOM and cannot show the browser's native drag image, Escape handling or rendering; the owner reviews the real view (UX-CONTRACT)"

duration: 6 min
completed: 2026-11-02
status: complete
---

# Phase 62 Plan 11: Kanban drag and drop Summary

**Native HTML5 drag and drop for the kanban that lights up only the columns a card may move to in its own row, sends exactly one move request for an offered drop, and snaps every other drop back on the spot with the card's own reason shown and announced, proven in node:vm against the real board model.**

## Performance

- **Duration:** about 6 min (20:40 to 20:46 UTC)
- **Tasks:** 2 (tracer, snap back and the rest)
- **Files created:** 2 (drag.js, boardDrag.test.ts)
- **Tests:** 16 new vm tests, all passing; boardClient (24) and boardMenu (13) still pass (53 together); `npm run lint` clean

## Accomplishments

- `drag.js` is one IIFE using only the `NearAiBoard` API and the DOM. Listeners are delegated on the persistent `#board` element; `onRender` re-syncs `draggable`, re-applies the highlights during a drag and runs the glide.
- Drag start sets the id under `application/x-near-ai-card` (never `text/plain`), `effectAllowed = move`, the `.dragging` class, `.drop-ok` on offered cells of the card's own row, and `.lane.drag-active` / `.column.drag-active`.
- A drop resolves to one of three verdicts per cell: own column (silent), offered (one `move` post, pending line `Moving to COLUMN...`, card stays until the state arrives), or refused (no post, the model's `refusals[column]` text shown on the card through `showRefusal`, which also announces `Can't move plan 90-01 to COLUMN. REASON`). A different row gets `This card stays in its own row. Drop it in another column of the same row.`
- Hovering a refused cell shows a transient `Can't drop here: REASON` caption inside it (`role="presentation"`, `aria-hidden`, no pointer events), removed on leave, on moving elsewhere and on drop.
- Escape (document keydown) or a `dragend` still in the active state clears everything and announces `Move cancelled. The card is still in Ready.` once.
- Host `refused` replies for drops this script sent are drawn once on that card; replies for menu requests are left to the menu (tested with both scripts loaded).
- FLIP glide: a card whose column changed slides from its last position over 150 ms through `style.setProperty`; under `prefers-reduced-motion` nothing is read or animated.

## Task Commits

1. **Task 1 (tracer):** `3997e51` test (RED: scaffold drag.js, tests fail on assertions), `0452731` feat (draggable, dragstart marks, offered drop posts and shows pending)
2. **Task 2:** `9e4d7fe` test (RED: snap back, caption, rows, cancel, foreign data, list, motion), `0d2e4d4` feat (all of the above)

## TDD Gate Compliance

RED then GREEN for both tasks. Task 1 RED: 2 of 3 tests failed on assertions (`draggable` false, no data under the board type) and the static check failed to find the data type in the scaffold. Task 2 RED: 8 of 16 failed on assertions (empty refusal line, no caption, no cancel announcement, no transform, missing reduced-motion string); the 8 that already passed were behaviours Task 1 delivered (host refusal drawn once, drop on an offered cell, list width, reduced-motion no-op). Two test defects were fixed before GREEN, both in the test file: the first-load announcement landing during a count, and an extra stray `dragend` in the own-column test. No refactor commit.

## Deviations from Plan

None - plan executed exactly as written. Notes:

- The `dragend` rule is a superset of the plan's wording (cancel whenever the drag is still active at `dragend`, not only when `dropEffect` is `none`); recorded under key-decisions.
- The plan's `files_modified` lists only drag.js and the test file; `drag.js` was already in `BOARD_SCRIPTS` from 62-08, so no host change was needed.

## Wiring notes for later plans

- 62-12 (detail) and 62-13 (form) add their own `refused` handling by item id as menu.js and drag.js do; neither needs to know about the other.
- During a drag the `.dragging` class is re-applied on every render because `board.js` rewrites `li.className` when a card's signature changes; `setPending` and `showRefusal` also reset the class, which is why the drop handler removes it first.
- The glide's last-known rects are refreshed at each render and at `dragstart`. If a card moves after the person scrolled without a drag (a teammate's move), the starting offset can be off by the scroll amount for 150 ms; cosmetic and accepted.
- `scripts/verify-release-content.mjs` still lists no media/board files (carried from 62-09 and 62-10; belongs with 62-14).

## Known Stubs

None.

## Threat Flags

None. T-62-37 mitigated (a drop is acted on only when its data transfer carries `application/x-near-ai-card` and the id matches the active session; tested with text, files and no active drag); T-62-38 transferred (refused drops never post, offered drops are re-planned by the host); T-62-SC no installs.

## Self-Check: PASSED

- media/board/drag.js and src/test/boardDrag.test.ts exist.
- Commits 3997e51, 0452731, 9e4d7fe and 0d2e4d4 are on the branch; `npx tsc -p tsconfig.json && node --test dist/test/boardDrag.test.js dist/test/boardClient.test.js dist/test/boardMenu.test.js` reports 53 pass, 0 fail; `npm run lint` exits 0.
- Acceptance greps hold: `application/x-near-ai-card`, `This card stays in its own row` and `prefers-reduced-motion` match in drag.js; the markup-sink grep and the em/en dash grep return nothing.
