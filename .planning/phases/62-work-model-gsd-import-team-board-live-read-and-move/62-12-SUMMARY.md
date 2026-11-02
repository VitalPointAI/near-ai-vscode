---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 12
subsystem: team-board-client
tags: [team-mode, webview, vanilla-js, card-detail, accessibility, fake-dom, node-vm, out-of-memory]

requires:
  - phase: 62-work-model-gsd-import-team-board-live-read-and-move
    provides: "board.js core with the NearAiBoard API (registerDetail, openDetail, onRender, onMessage, cardData, cardElement, focusCard, setFilter, openMenu, openForm, drawer, layout, model, announce) and the empty aside#detail plus its board.css rules (62-09); buildCardDetail and the CardDetail message (62-06), served by the host (62-08); the Move to... menu (62-10)"
provides:
  - "media/board/detail.js: the card detail as a non-modal drawer in the kanban and a drill-in page with Back to list in the list, drawn from the host's detail message in the eleven UI-SPEC sections, text only"
  - "src/test/boardDetail.test.ts: 14 vm tests with the real buildCardDetail over a signed in-memory log, board.js and menu.js"
  - "src/test/helpers/fakeDom.ts: fake DOM nodes keep their tree links out of util.inspect, so a failing assertion on a node prints about 30 lines instead of exhausting memory; src/test/fakeDom.test.ts guards it"
affects: [62-13, 62-14]

actuals:
  tokens: 10971
  tasks: 2
  commits: 6
plan_head_before: 4a63e5cf0f3dc6badb5798486b5422dae0fc4a95
plan_head_after: 7d0cd27

tech-stack:
  added: []
  patterns:
    - "The title block (heading, state line, badges, Move to..., Edit, Close or Back) is built once and updated in place, so focus on it survives every refresh; the body is rebuilt and focus is restored by a data-focus key"
    - "A detail reply is drawn only for the open item id, and only when its JSON differs from the last one drawn; a changed card signature on render asks the host again"
    - "Controls a viewer may not use are left out of the DOM (Edit), not hidden, where the UI-SPEC says the control exists only for some viewers"
    - "Fake DOM nodes keep doc, parentNode, childNodes, listeners and onText as non-enumerable own properties so Node's assert, which prints with customInspect off, sees only the node's own fields"

key-files:
  created:
    - media/board/detail.js
    - src/test/boardDetail.test.ts
    - src/test/fakeDom.test.ts
  modified:
    - src/test/helpers/fakeDom.ts

key-decisions:
  - "The out-of-memory fix is in the fake DOM, not in detail.js: product code never grew memory (a step replay of the hog test stayed at 59 to 82 MB). The plan's owner rule says plan 62-12 never edits the fake DOM helper; the orchestrator authorised a harness fix, and the change only alters what util.inspect sees, never how the tree behaves"
  - "util.inspect.custom cannot help: Node's AssertionError prints with customInspect false, so the tree links are made non-enumerable instead"
  - "Edit is in the DOM only for a board item the viewer may edit while the board is up; imported items show the project plans note and have no Edit at all, hidden or not (UI-SPEC title block). Move to... keeps the hidden toggle the UI-SPEC describes ('hidden when no moves')"
  - "A blocked card shows both the blocked notice and 'It is blocked.' under Why this is not ready: blocking puts the card in Backlog and the host sends that sentence (UI-SPEC Card Detail 3). The page formats nothing it can take from the message, so it does not filter the host's list"
  - "Following a dependency whose card the active filters hide still opens its detail and leaves the filters alone; nothing in the UI-SPEC asks the board to reveal it"

patterns-established:
  - "Tests over the fake DOM may compare nodes with assert.equal again without risking the machine; a failed comparison prints the node's tag and attributes"
  - "Arrays read from the page (NearAiBoard.cardData, model) belong to the vm realm; copy them ([...array]) before deepEqual against a test-side array"

requirements-advanced: [BOARD-01]
requirements-completed: []

coverage:
  - id: D1
    description: "Enter on a card posts one { type: 'detail', itemId } request, opens aside#detail (aria-label Card detail) with the title while waiting, focuses the h2, ignores replies for other ids, and Escape closes it back onto the card that opened it; aria-current marks only the open card"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/boardDetail.test.js#tracer: Enter on a plan asks the host once, shows the title while waiting, then the tasks and history; Escape closes and lands on the card"
        status: pass
      - kind: unit
        ref: "dist/test/boardDetail.test.js#a detail for another card is ignored, and nothing opens without a registered request"
        status: pass
    human_judgment: false
  - id: D2
    description: "The sections in UI-SPEC order: blocked notice with its time under the title block, Why this is not ready for Backlog cards only, facts as a dl, description for board items, must-haves, tasks with N of M tasks done and a Done or To do word, history newest first with time elements"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/boardDetail.test.js#a blocked card shows who blocked it and why, with the time, right under the title block"
        status: pass
      - kind: unit
        ref: "dist/test/boardDetail.test.js#a backlog card says in plain words why it is not ready"
        status: pass
      - kind: unit
        ref: "dist/test/boardDetail.test.js#facts are a definition list; a board item shows its description and Edit, an imported item shows the project plans note instead"
        status: pass
    human_judgment: false
  - id: D3
    description: "Edit only for a board item the viewer may edit, calling the registered form opener with the item id; imported items show the project plans note and no Edit; Move to... opens the same menu as the card and is absent without moves; a refusal for the open card shows in the detail"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/boardDetail.test.js#facts are a definition list; a board item shows its description and Edit, an imported item shows the project plans note instead"
        status: pass
      - kind: unit
        ref: "dist/test/boardDetail.test.js#Move to... in the detail opens the same menu as the card and is absent when the card has no moves"
        status: pass
      - kind: unit
        ref: "dist/test/boardDetail.test.js#a refusal for the open card is shown in the detail as well"
        status: pass
    human_judgment: false
  - id: D4
    description: "Requirement buttons (Filter the board by ID) set the core's requirement filter and close nothing; dependencies on the board are buttons that open that card's detail, missing ones read '61-09 (not on the board)' as text; closing after following a dependency lands on the card opened first"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/boardDetail.test.js#requirement buttons apply the requirement filter and leave the detail open; a dependency on the board opens its detail, one off the board is plain text"
        status: pass
    human_judgment: false
  - id: D5
    description: "Bounded and honest lists: files 8 then Show all N, history capped at 50 with 'Showing the latest 50 changes.', 'This plan has no tasks listed.' and 'No changes recorded since this window opened.'; a changed card asks the host again and a card that leaves the board closes the detail with an announcement"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/boardDetail.test.js#files show the first 8 then Show all N; the task list and history say so when they are empty"
        status: pass
      - kind: unit
        ref: "dist/test/boardDetail.test.js#history stops at 50 even when the host sends more, and says so"
        status: pass
      - kind: unit
        ref: "dist/test/boardDetail.test.js#a change to the open card asks the host again; a card that leaves the board closes the detail"
        status: pass
    human_judgment: false
  - id: D6
    description: "List layout drill-in: the detail replaces the list with Back to list, which restores the list, its scroll position and focus on the row; the close label follows the layout. Host text (hostile titles, 600 character must-haves, reasons, history) is written as text; no markup sinks, no en or em dashes"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/boardDetail.test.js#list layout: opening a row drills in with Back to list, which restores the list, its scroll position and focus on the row"
        status: pass
      - kind: unit
        ref: "dist/test/boardDetail.test.js#hostile text is drawn as text and long must-haves wrap in full"
        status: pass
      - kind: unit
        ref: "dist/test/boardDetail.test.js#detail.js writes text only and registers through the client API"
        status: pass
    human_judgment: false
  - id: D7
    description: "Out-of-memory incident fix: a failing assertion on a fake DOM node prints a short message and bounded memory in every board test file"
    verification:
      - kind: unit
        ref: "dist/test/fakeDom.test.js#a node in a bare page prints only itself, and the tree links still work"
        status: pass
      - kind: unit
        ref: "dist/test/fakeDom.test.js#a failing assertion on a node of the drawn board, with the detail open, has a short message"
        status: pass
    human_judgment: false
  - id: D8
    description: "How the drawer and the drill-in look and wrap in a real webview: no horizontal scroll for long must-haves and names, focus ring on the heading, drawer width at narrow kanban widths, light, dark and high contrast"
    requirement: BOARD-01
    verification: []
    human_judgment: true
    rationale: "The vm tests run against a fake DOM with no layout engine, so wrapping, scrolling and visual focus cannot be measured; the owner reviews the real view (UX-CONTRACT)"

duration: 36 min
completed: 2026-11-02
status: complete
---

# Phase 62 Plan 12: Card detail drawer and drill-in Summary

**Opening any card shows everything about it, from its blocked notice and readiness reasons to its dependencies, files, task checklist and last 50 changes, in a kanban drawer or a list drill-in that hands focus back to the card; and a fake DOM defect that made one failing assertion use gigabytes, crashing VS Code, is fixed and guarded.**

## Performance

- **Duration:** about 36 min (20:52 to 21:28 UTC), including the out-of-memory investigation
- **Tasks:** 2 (tracer, then every section and the list drill-in)
- **Files:** 3 created (detail.js, boardDetail.test.ts, fakeDom.test.ts), 1 modified (fakeDom.ts)
- **Tests:** 14 detail tests and 2 harness tests, all passing; boardClient (24), boardMenu (13) and boardDrag (16) still pass, 69 together at 164 MB peak; `npm run lint` clean

## Accomplishments

- `detail.js` is one IIFE that uses only the `NearAiBoard` API and the DOM, registers through `registerDetail`, and draws into the shared `aside#detail`. The title block is built once and updated in place; the body is rebuilt per reply with focus restored by a `data-focus` key.
- Opening a card records the opener, posts `{ type: 'detail', itemId }`, shows the title and Loading details... while waiting, focuses the `h2`, and marks the card `aria-current`. Escape, Close details or Back to list close it and return focus to the card that was opened first (also after following dependency links inside the detail).
- Sections follow the UI-SPEC order: blocked notice with `<time datetime>`, Why this is not ready (Backlog only, the host's sentences), Facts (`dl`), Description (board items), Must-haves, Requirements (buttons that call `setFilter('requirement', id)`), Dependencies (buttons that open the other card's detail, or `61-09 (not on the board)` as text), Files (8 then `Show all N`), Tasks (`N of M tasks done`, a Done or To do word on every row), History (newest first, at most 50, `Showing the latest 50 changes.`, or `No changes recorded since this window opened.`).
- Edit is put in the title block only for a board item the viewer may edit and calls `openForm(itemId)`; imported items show `This comes from the project plans. Change the plan files and the board updates.` instead. Move to... appears for owners and leads with offered moves and opens the same menu as the card.
- The open card follows the model: a changed card asks the host again, a card that leaves the board closes the detail and announces `That card is no longer on the board.`, and a refusal for the open card shows in the detail.
- In the list, the detail replaces the list (board.css `:has` rule), the button reads Back to list, and closing restores the list's scroll position and focus on the row.

## Out-of-memory incident (OOM killer took VS Code down several times)

**What happened.** Running `node dist/test/boardDetail.test.js` with all 14 tests grew memory until the OOM killer ended the test process and VS Code with it. Under a 400 MB heap cap it died in about 5 s with `Mark-Compact 200.1 -> 200.1 MB ... external memory pressure`.

**Where it was.** One test, not state carried between tests: alone, 13 tests peak at 56 to 84 MB, while "facts are a definition list..." alone peaked at 2,636,204 KB RSS in 4.7 s and ended with `RangeError: Array buffer allocation failed`. A step-by-step replay of that test without assertions stayed at 59 to 82 MB, so detail.js never grew memory. The blow-up was inside one failing assertion: `assert.equal(buttonNamed(drawer(h), 'Edit'), undefined, 'imported items are not edited here')`, failing because the Task 2 work kept a hidden Edit button for imported items.

**Root cause.** `src/test/helpers/fakeDom.ts` (before the fix: lines 138 to 140 `parentNode`, `childNodes`, `listeners`; line 145 `doc`, set at line 159) gave every fake node enumerable links to the rest of the page. Node 24's strict assert prints both sides of a failed comparison with `util.inspect` at depth 1000 with getters on and custom inspectors off, even when the assertion has its own message, and then runs a myers diff that clones an `Int32Array(2L+1)` for every diff level (`internal/assert/myers_diff.js` lines 47 to 51), about 8 x L^2 bytes for L printed lines, with no size guard. Through the links each node printed the whole page again from every node on its path: 1,509 lines for a detached button, 374,757 lines (21 MB) for the bare board, millions for a drawn board. Any failing assertion with a node operand in any of the four board test files (105 such assertions exist) could do this, and TDD RED phases fail assertions on purpose.

**Fix.** `fakeDom.ts` line 137 lists `doc`, `parentNode`, `childNodes`, `listeners` and `onText`, and line 181 redefines them as non-enumerable own properties with the same values at the end of the constructor. The tree behaves exactly as before; a failed assertion now prints about 30 lines (the tag, attributes and own fields). The trigger is gone too: Edit is left out of the DOM for imported items.

**Regression test.** `src/test/fakeDom.test.ts` checks a node in a bare page first (cheap even when broken: about 2,000 lines), then every element of a drawn board with the detail open, then the incident's own shape (a node against undefined with a custom message). Its assertions compare only numbers and booleans. RED before the fix: 2 of 2 failed in 0.08 s at 56 MB; GREEN after.

**Measured after the fix.** The hog test alone: 83 MB and 0.17 s (was 2.6 GB and 4.7 s). The whole boardDetail file: 1.2 s at 119 MB with 6 ordinary assertion failures before Task 2 was finished, 0.42 s at 142 MB with 14 passing after. Against the Task 1 detail.js, 11 failing assertions still stayed at 119 MB. Debug session: `.planning/debug/board-detail-test-oom.md`.

## Task Commits

1. **Task 1 (tracer):** `aae29c7` test (RED), `f624d29` feat (open by keyboard, render the reply, close back to the card)
2. **Task 2:** `e1de372` test (RED), `2ea8397` fix (fake DOM out-of-memory, with fakeDom.test.ts), `27ab90d` test (five test defects corrected), `7d0cd27` feat (every section, Edit or the note, empty and overflow rows, list drill-in)

## TDD Gate Compliance

RED then GREEN for both tasks. Task 1 followed the normal cycle. Task 2's RED commit (`e1de372`) could not be observed by the executor that wrote it: every full run ran out of memory before an assertion message printed. Once the harness was fixed, the RED run showed 6 failures: one real product gap (Edit hidden instead of absent) and five test defects (see Deviations). After correcting the tests (`27ab90d`), the test file run against Task 1's detail.js failed 11 of 14 as expected, and with the finished detail.js all 14 pass. No refactor commit.

## Deviations from Plan

**1. [Rule 1 - Bug, blocking] Failing assertions on fake DOM nodes exhausted memory and crashed VS Code**
- Found during: Task 2 GREEN
- Issue: see the incident section; the plan's owner rule says this plan never edits the fake DOM helper
- Fix: tree links made non-enumerable in `src/test/helpers/fakeDom.ts`; new `src/test/fakeDom.test.ts`. Authorised by the orchestrator for this incident; behaviour of the fake DOM is unchanged
- Files modified: src/test/helpers/fakeDom.ts, src/test/fakeDom.test.ts (new)
- Verification: fakeDom.test.ts RED then GREEN; boardClient, boardMenu and boardDrag unchanged and passing
- Commit: `2ea8397`

**2. [Rule 1 - Bug] Five Task 2 tests contradicted the UI-SPEC or the test environment**
- Found during: Task 2 GREEN (first readable RED run)
- Issue and fix, each keeping or strengthening what is checked:
  - Blocked card: the test said "a ready card has no such section" about the blocked plan 90-01, but blocking puts it in Backlog and the host and UI-SPEC give it `It is blocked.` under Why this is not ready. The blocked test now checks that list; the ready-card clause is checked on plan 90-01 while it really is ready (backlog test).
  - Requirement filter: the FIX-01 filter hides plan 90-01's card, which the test then needed for its `aria-current` check. The test now proves the filter reached the board, then clears it as Clear filters does.
  - Move to... menu: `deepEqual` compared a test array with an array from the page's vm realm (different prototype). The labels are copied into a plain array.
  - Card leaves the board: `announce()` writes the live region 100 ms later; the test now advances the fake clock by 200 ms first, as boardMenu tests do.
  - Hostile text: `<script>alert(1)</script>` (25 characters) plus 576 is 601, not the 600 character must-have the test names; the filler is now 575.
- Files modified: src/test/boardDetail.test.ts
- Verification: against Task 1's detail.js the corrected file fails 11 of 14; against the finished detail.js all 14 pass
- Commit: `27ab90d`

**Total deviations:** 2 auto-fixed (1 blocking harness bug, 1 set of test defects). **Impact:** no change to product scope; the harness fix removes a machine-crashing hazard from every board test file.

## Wiring notes for later plans

- 62-13 (form): the detail's Edit calls `NearAiBoard.openForm(itemId)`; register the opener with `registerForm`. Edit only exists for a board item with `editable: true` while the board is up. After a successful edit the host's next state changes the card's signature and the open detail asks for a fresh reply by itself.
- The detail shows any `refused` reply for the open card's id, whichever script sent the request; menu.js and drag.js still draw their own refusal on the card.
- The host's `historyNote` is not read; the page shows `Showing the latest 50 changes.` itself whenever 50 or more entries arrive (same text).
- Opening a dependency that the active filters hide opens its detail without changing the filters; the card cannot show `aria-current` until the filter is cleared.
- Tests: failing assertions on fake DOM nodes are safe again, but keep running node tests under the memory caps. Arrays and objects read from the page are vm-realm values; copy arrays before `deepEqual`.
- `scripts/verify-release-content.mjs` still lists no media/board files (carried from 62-09 to 62-11; belongs with 62-14).

## Known Stubs

None.

## Threat Flags

None new. T-62-39 mitigated (text-only rendering; markup-sink grep empty; hostile title, must-have, history and blocked-by text tested with no element created). T-62-40 mitigated (files capped at 8 until asked, history capped at 50 by host and page). T-62-SC: no installs.

## Self-Check: PASSED

- media/board/detail.js, src/test/boardDetail.test.ts and src/test/fakeDom.test.ts exist; src/test/helpers/fakeDom.ts carries INSPECT_HIDDEN.
- Commits aae29c7, f624d29, e1de372, 2ea8397, 27ab90d and 7d0cd27 are on the branch.
- Capped `npx tsc -p tsconfig.json && node --test dist/test/boardDetail.test.js dist/test/boardClient.test.js`: 38 pass, 0 fail, 164 MB peak. Capped `npm run lint`: exit 0. All five board harness files together: 69 pass, 0 fail.
- Acceptance greps hold: `NearAiBoard.registerDetail`, `This plan has no tasks listed.`, `No changes recorded since this window opened.`, `Back to list` and `type: 'detail'` match in detail.js; the markup-sink grep and the en or em dash grep return nothing.
