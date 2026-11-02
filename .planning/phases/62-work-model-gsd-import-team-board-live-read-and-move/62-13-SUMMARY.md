---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 13
subsystem: team-board-items
tags: [team-mode, webview, vanilla-js, new-item-form, validation, secret-refusal, permissions, node-vm, real-git]

requires:
  - phase: 62-work-model-gsd-import-team-board-live-read-and-move
    provides: "parseBoardMessage with new-item and edit-item, BoardController, boardTap and the post helpers (62-08); window.NearAiBoard with registerForm, openForm, onMessage, drawer, announce (62-09); CardDetail with kind, estimateTokens, description, files and editable (62-06, 62-12); ItemCreatedBody, isScopePattern, isOwnDraft, transitionProblem (62-01)"
provides:
  - "src/services/team/boardView.ts: new-item and edit-item handling. Host re-validation (trim, caps, file patterns, whole-number estimate), secret refusal before any intent, permission check on fresh state inside the append, one item.created that carries the estimate, item.updated plus item.estimated in one commit for an edit, and the saved { itemId } reply"
  - "media/board/form.js: the New item and Edit item form, registered with NearAiBoard.registerForm, living in the shared aside#detail (drawer in the kanban, drill-in in the list)"
  - "media/board/board.js: NearAiBoard.getDraft and setDraft, so the form's unsent draft is stored in the same page state as the board's own settings"
  - "src/test/teamBoardItems.test.ts (11 tests on real clones) and src/test/boardForm.test.ts (20 vm tests with the real board model and card detail)"
affects: [62-14]

actuals:
  tokens: 20000
  tasks: 3
  commits: 5
plan_head_before: de36e9ab109edf755d0b3d9b97cc43e6fe623b69
plan_head_after: 98a202013f5483aae4570ff2c78c5e7a391d015f

tech-stack:
  added: []
  patterns:
    - "One writeItem path for create and edit: plan(fresh) runs inside log.append and returns either a plain refusal sentence (turned into a { conflict }) or the batch of intents"
    - "A malformed form message is dropped silently (hostile), except when only its estimate is not a whole number from 1 up: then the page gets the form's own sentence"
    - "form.js hides the card detail's own children while its form is open and puts them back on close, so the two scripts share aside#detail without knowing about each other"

key-files:
  created:
    - media/board/form.js
    - src/test/boardForm.test.ts
    - src/test/teamBoardItems.test.ts
    - .planning/phases/62-work-model-gsd-import-team-board-live-read-and-move/deferred-items.md
  modified:
    - src/services/team/boardView.ts
    - media/board/board.js

key-decisions:
  - "Page protocol additions: host-to-page saved { itemId } (the new item's id, or the edited item's id), and refused { itemId: '', reason } for a new item that has no id yet. Both are additions to the UI-SPEC message list"
  - "The draft lives in board.js state: the real webview lets a page acquire the VS Code API only once, so form.js cannot call acquireVsCodeApi itself. board.js gained getDraft/setDraft and its persist() keeps the draft beside its own settings"
  - "An estimate that is not a whole number from 1 up never passes parseBoardMessage (62-08 tests require that), so the controller answers it from the parse failure path with the estimate sentence; every other malformed draft still gets no reply"
  - "Permission for create and edit is decided with decideTeamAction on the fresh state inside the append; the sentence depends on the role (developer editing someone else's item: 'You can edit only the items you added.'), and prepareEvents and the reader still re-check"
  - "An estimate can be changed but not removed (no event removes one), so an emptied estimate in the edit form is a validation error"

patterns-established:
  - "Tests read announcements through said(h), which moves the fake clock 150 ms first (the live region is cleared and set again after 100 ms)"
  - "Refusal wording lives in one frozen FORM_TEXT table in boardView.ts, and tests assert the exact sentences and the absence of U+2013 and U+2014"

requirements-advanced: [BOARD-01, BOARD-03]
requirements-completed: []

coverage:
  - id: D1
    description: "A developer adds a chore through the page message and the real host: one signed item.created with the exact body (estimate included), id item:<ulid>, saved reply, a state in which the card is Ready and mine, and the owner's clone shows origin board with the developer as creator"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "dist/test/teamBoardItems.test.js#tracer: a developer adds a chore through the page and the host, the remote gains one item.created with the estimate, and the owner sees the developer as its creator"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardItems.test.js#an item with only a title is written without a description or an estimate and waits in the backlog"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardItems.test.js#a title typed with line breaks is stored as one line, and a description keeps its line feeds"
        status: pass
    human_judgment: false
  - id: D2
    description: "Editing: item.updated for text and files and item.estimated for the size in one commit; developers edit only their own unclaimed items, owner and lead any board item; imported items are never editable; observers cannot add; a window that cannot write says why; an item that left the board is refused"
    requirement: BOARD-03
    verification:
      - kind: integration
        ref: "dist/test/teamBoardItems.test.js#a developer edits their own chore: one commit holds item.updated for the text and item.estimated for the size, and the owner sees both"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardItems.test.js#a developer cannot edit another member's chore, the owner can edit the developer's, and nothing is appended on a refusal"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardItems.test.js#an imported plan is never editable on the board, whoever asks"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardItems.test.js#an observer cannot add an item and a window that cannot write says why; neither writes anything"
        status: pass
    human_judgment: false
  - id: D3
    description: "Nothing secret-like or malformed is written: key-like text in a title, description or file line is refused with the secret sentence, the remote holds no trace of it (a positive control proves the scan sees saved text), bad file lines and estimates get the form's own sentences, and every refusal is free of em-dashes and en-dashes"
    requirement: BOARD-03
    verification:
      - kind: integration
        ref: "dist/test/teamBoardItems.test.js#text that looks like a key is refused in the title, the description and a file line, and no trace of it reaches the remote"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardItems.test.js#malformed files and sizes are refused with the form's own sentences and write nothing"
        status: pass
    human_judgment: false
  - id: D4
    description: "The form in the page: fields and hints exactly as the UI-SPEC, validation on blur and submit with aria-invalid and aria-describedby, focus on the first invalid field and the live region count, Adding... with aria-busy, in-form alert on refusal with fields kept, discard rule with focus on Keep editing, Escape, saved closes and focuses the new card (or New item when filters hide it), draft kept through setState, edit mode from the detail reply sending only changed fields"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/boardForm.test.js#New item opens form#item-form in the drawer with every field, the hints and the buttons, and focus on Type"
        status: pass
      - kind: unit
        ref: "dist/test/boardForm.test.js#each rule has its own message, on blur and on submit, and several problems are counted"
        status: pass
      - kind: unit
        ref: "dist/test/boardForm.test.js#a valid submit sends exactly one new-item with trimmed lines and a number, leaves an empty description out, and shows Adding..."
        status: pass
      - kind: unit
        ref: "dist/test/boardForm.test.js#saved closes the form, announces the new item, and focuses its card once the next state shows it"
        status: pass
      - kind: unit
        ref: "dist/test/boardForm.test.js#with the Blocked filter on, the new card is not shown, so focus goes to the New item button"
        status: pass
      - kind: unit
        ref: "dist/test/boardForm.test.js#Close form on a changed form asks Discard this item? with focus on Keep editing; Keep editing goes back, Discard changes closes"
        status: pass
      - kind: unit
        ref: "dist/test/boardForm.test.js#the draft is kept with setState on every change, and a reloaded page reopens the form with the same values"
        status: pass
      - kind: unit
        ref: "dist/test/boardForm.test.js#Edit asks the host for the detail, pre-fills the form, shows the type as text, and sends only what changed under Save changes"
        status: pass
      - kind: unit
        ref: "dist/test/boardForm.test.js#form.js registers through the client API, writes text only, never says Cancel and holds no em-dash or en-dash in any string"
        status: pass
    human_judgment: false
  - id: D5
    description: "The form looks right and is comfortable to use in a real VS Code window (drawer width, drill-in in the sidebar, focus rings, high contrast)"
    requirement: BOARD-01
    verification: []
    human_judgment: true
    rationale: "Layout, theme and screen-reader behaviour need the real editor; the fake DOM proves structure, focus and text only. Left to the 62-14 end-to-end plan and the owner."

duration: about 1h45 (start time was not logged; estimated)
completed: 2026-11-02
status: complete
---

# Phase 62 Plan 13: Board items and the New item form Summary

**People can add bugs, chores and spikes on the Team Board and edit their own: the form validates as they type, the host validates again and refuses key-like text, and one signed item.created (or item.updated plus item.estimated) reaches every teammate, with the 6.3 permissions checked on fresh state.**

## Performance

- **Duration:** about 1h45 (start time not logged)
- **Completed:** 2026-11-02
- **Tasks:** 3 (one tracer, two auto)
- **Files:** 3 created (form.js and two test files) plus deferred-items.md, 2 modified (boardView.ts, board.js)
- **Tests:** 11 host tests on real clones and 20 page tests; boardClient, boardDetail, boardMenu, boardDrag and fakeDom still pass (89 together); `npm run lint` clean

## Accomplishments

- `boardView.ts` handles `new-item` and `edit-item` through one `writeItem` path. Fields are trimmed (a title is flattened to one line, a description keeps its line feeds, blank file lines are dropped), checked against the caps and `isScopePattern`, and run through `findSecrets` before any intent exists. The write plans again inside `log.append` on the freshest state: `decideTeamAction` for create, edit and estimate, `isOwnDraft` for developers, imported items refused, estimates refused on finished items.
- One `item.created` carries the estimate (Pitfall 6). An edit writes `item.updated` for title, description and files and `item.estimated` for the size in one batch, so one commit. The page gets `saved { itemId }` and then, at once, the latest state.
- `form.js` builds `form#item-form` in the shared `aside#detail`. Validation runs on blur and on submit with the UI-SPEC messages, invalid fields carry `aria-invalid` and `aria-describedby`, focus goes to the first invalid field and the live region says "N fields need attention.". Submit reads "Adding..." with `aria-busy`. Success closes the form, announces "Added chore 7F3K: Tidy settings page." and focuses the new card when the filters show it, else the New item button. A refusal shows the host's reason in an in-form alert and keeps every field. A changed form asks "Discard this item?" (Escape and Close form alike), focus on Keep editing.
- Edit mode asks the host for the detail, fills the form, shows the type as text, and sends only the changed fields under "Save changes".
- The draft is kept in page state on every change and comes back after the first state of a reloaded page.

## Task Commits

1. **Task 1: Tracer** - `7ab6a67` (test, RED), `2fe4f3e` (feat, GREEN)
2. **Task 2: Editing, permissions and refusals** - `ddfec5f` (test)
3. **Task 3: The form in the page** - `98a2020` (feat)

`commits: 5` in the frontmatter is the measured count from the ledger; one of the five (`1a5fced`, a `docs(project)` commit) landed on the branch from another session during the run and is not part of this plan.

**Plan metadata:** the docs commit that carries this file and the state update follows it.

## Wiring notes for the next plan (62-14)

- `BOARD_SCRIPTS` already lists `form.js` last; nothing else needs registering. The finished client is now `board.js`, `menu.js`, `drag.js`, `detail.js`, `form.js`.
- New host-to-page message: `saved { itemId }`. A refusal for a new item is `refused { itemId: '', reason }`; menu.js, drag.js and detail.js ignore it because no card has the empty id.
- Page state now holds `draft` beside the board settings. `NearAiBoard.getDraft()` and `setDraft(value)` are the only way to touch it.
- Known edge, not fixed: while the New item form is open, clicking a card still opens that card's detail in the same drawer behind the form (detail.js cannot be told). The form stays on top; closing it returns to the drawer's previous state.
- The e2e suite (62-14) should add a real-window check of the form (D5).

## Decisions Made

See `key-decisions`.

## TDD Gate Compliance

`gsd_run check tdd-red-evidence` was not run (the 62-08 to 62-12 practice); RED output was read by hand.

- **Task 1:** `test(62-13)` `7ab6a67` then `feat(62-13)` `2fe4f3e`. RED: both tests failed on the planned assertion ("one event, one commit", 0 !== 1) because the controller ignored `new-item`.
- **Task 2:** no separate RED. The `edit-item` handler was written in the Task 1 GREEN commit together with `new-item` because both share `writeItem`, `cleanFields` and the fresh-state check, so the Task 2 tests passed when first run and act as guards. The permission, secret, imported-item, estimate and file tests were each read to be sure they assert the behaviour (for example the secret test has a positive control proving the git scan can see saved text). This is a gate violation: there is a `test(62-13)` commit for Task 2 but it has no preceding failing run.
- **Task 3:** no RED and no `test(62-13)` commit. `form.js` and `boardForm.test.ts` were written in one pass and committed together as `feat(62-13)` `98a2020`. Eight tests failed on their first run; all eight were mistakes in the tests (the live region needs the fake clock to move 150 ms, and `blur()` needs the field focused first), not in form.js.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] board.js was edited to give the form a draft store**
- **Found during:** Task 3
- **Issue:** The plan says the draft survives through `setState`, and the owner rule says form.js never edits board.js. But a webview page may call `acquireVsCodeApi()` only once (board.js does), and `board.js` rewrites the whole state object on every `persist()`, so a second state writer would be wiped by the board's next filter click.
- **Fix:** board.js (not form.js) gained `getDraft`/`setDraft` and keeps `draft` in its `persist()` object. form.js still never touches board.js internals and never calls `acquireVsCodeApi` (a test asserts that).
- **Files modified:** media/board/board.js (8 lines)
- **Verification:** boardForm draft test (draft beside `groupBy`, survives a filter change, cleared on saved), boardClient 24 tests still pass
- **Commit:** 98a2020

**2. [Rule 2 - Missing critical] An estimate of 0 or 1.5 gets the form's sentence instead of silence**
- **Found during:** Task 2
- **Issue:** The plan wants "an estimate of 0 is refused with 'Enter a whole number of tokens, 1 or more. Nothing was saved.'", but 62-08's parser (and its tests, which must not change) drop such a message with no reply, and the hostile-message test requires other malformed drafts to stay unanswered.
- **Fix:** When the parser drops a `new-item` or `edit-item` only because its estimate is a bad number, the controller replies `refused` with that sentence; everything else malformed is still ignored. All 62-08 parser and hostile-message tests are unchanged and pass.
- **Files modified:** src/services/team/boardView.ts
- **Commit:** 2fe4f3e

**3. [Rule 3 - Blocking, out of scope, deferred] teamBoardView.test.js runs out of memory as a whole file under the 1536 MB cap**
- **Found during:** Task 1 verification
- **Issue:** Pre-existing: the unchanged 62-12 code fails at the same test. Every test passes alone and in partitions (7 + 10 + 10 = 27 pass).
- **Fix:** none (outside this plan's files). Recorded in `deferred-items.md` with a suggested split.

**Total deviations:** 3 (1 blocking, 1 missing-critical, 1 deferred). **Impact:** the board.js edit is small and tested; behaviour matches the plan.

## Authentication Gates

None.

## Known Stubs

None. `T.loading` in form.js is an unused string constant, not a stub.

## Threat Flags

None. The two new page messages were already in the plan's threat model (T-62-41, T-62-42, T-62-43), and each has its mitigation proven by a test: foreign-item edits (T-62-41), key-like text with a remote scan (T-62-42), malformed fields (T-62-43).

## Issues Encountered

The `Write` tool turned ` ` escapes into literal line-separator characters in three files; each was caught by the compiler or `node` and replaced with the escape text.

## Next Phase Readiness

Ready for 62-14 (end-to-end proof and requirement ticks). BOARD-01 and BOARD-03 are advanced, not completed.

## Self-Check: PASSED

- `media/board/form.js`, `src/test/boardForm.test.ts`, `src/test/teamBoardItems.test.ts`, `deferred-items.md` exist on disk
- Commits `7ab6a67`, `2fe4f3e`, `ddfec5f`, `98a2020` are on the branch
- `npx tsc -p tsconfig.json` and `npm run lint` pass; `teamBoardItems` (11), `boardForm` (20), `boardClient`, `boardDetail`, `boardMenu`, `boardDrag`, `fakeDom` (89 together) pass; `teamBoardView` passes in three partitions (27 of 27)
- Acceptance greps: `type: 'saved'` and "You can edit only the items you added" in boardView.ts, `item:` and `scanGitObjects` in teamBoardItems.test.ts, `NearAiBoard.registerForm` and "Discard this item?" in form.js, no `innerHTML|outerHTML|insertAdjacentHTML` in form.js
