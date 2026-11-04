---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 27
subsystem: team-domain
tags: [team-mode, signed-log, permissions, board, drag, code-server, g-62-5, g-62-6]
status: complete

requires:
  - phase: 62-25
    provides: "item.assign-self and the probe-event pattern in planAssign (actionForEvent asked on write and on read)"
  - phase: 62-26
    provides: "WorkItem.assignedBy; the card's assignee is stable data both callers read"
provides:
  - "item.move-own permission row (owner, lead, developer, reviewer; never observer), label 'moving cards assigned to them'"
  - "actionForEvent maps the assignee's hold, release, mark done, block, unblock and reopen-from-Done to item.move-own; cancel, reopen of a cancelled card, anyone else's move and any move without a state stay item.move"
  - "planMove and columnMove decide card by card through actionForEvent; the model's board-wide gate is about the viewer only"
  - "REFUSALS.notAssigneeMove, cancelManagersOnly, observerMove; new developer banner"
  - "The page shows Move to... and lets people pick cards up by the model's moves, not the role (observers still excluded)"
  - "codeServerBoard step 4: the developer's real-mouse drags in code-server"
affects: [phase-63-claims, 62-verification]

actuals:
  tokens: 24110
  tasks: 3
  commits: 6
plan_head_before: 9b5920b739b49c5d1281c8912409599a1ffa730e
plan_head_after: e13e908

tech-stack:
  added: []
  patterns:
    - "A permission row chosen by actionForEvent from the state before the event (the assignee), so writer, reader and board ask one mapping"
    - "Board move planning: viewer gate, then card gate, then card rules, then decideTeamAction on the probe event"

key-files:
  created:
    - src/test/teamMoveOwn.test.ts
  modified:
    - src/domain/team/permissions.ts
    - src/domain/team/board.ts
    - src/domain/team/boardText.ts
    - media/board/board.js
    - media/board/detail.js
    - media/board/drag.js
    - src/test/helpers/teamBoardWorld.ts
    - src/test/e2e/codeServerBoard.ts
    - src/test/teamPermissions.test.ts
    - src/test/teamBoardMoves.test.ts
    - src/test/teamBoardModel.test.ts
    - src/test/teamBoardView.test.ts
    - src/test/boardClient.test.ts
    - src/test/boardDetail.test.ts
    - src/test/boardDrag.test.ts
    - src/test/boardMenu.test.ts

key-decisions:
  - "The assignee's moves use a new item.move-own row (EVERYONE_ACTIVE); cancel and reopening a cancelled card always map to item.move, the orchestrator default from the owner decision of 2026-11-04"
  - "planMove refuses a card that is not the viewer's (for non-managers) before the card's own rules, so every column of a teammate's card says the same not-assignee sentence; this only ever refuses what the log refuses too"
  - "The page drops the owner-and-lead role check but still never shows Move to... or a pick-up to an observer, keeping the existing 'read-only viewer never sees a move control, whatever the model says' test"
  - "A reviewer now picks cards up on the kanban, since she may move the cards assigned to her; the reviewer and observer banners are unchanged"

patterns-established:
  - "codeServerBoard swaps the model the harness posts by rewriting the model file (fs.watchFile in the harness), and scrolls the board's own area into view before each real-mouse drag"

requirements-completed: [BOARD-03]

coverage:
  - id: D1
    description: "The person a card is assigned to blocks, unblocks, finishes and reopens it from their own clone and every clone accepts it; their moves on a teammate's or free card, their cancel and their reopen of a cancelled card are refused on write and, forged, rejected by both clones"
    requirement: BOARD-03
    verification:
      - kind: integration
        ref: "src/test/teamMoveOwn.test.ts#a lead gives the developer a plan, the developer blocks, unblocks, finishes and reopens it on both clones; their moves on other cards and their cancel are refused and rejected"
        status: pass
    human_judgment: false
  - id: D2
    description: "Writer and reader case table: developer and reviewer assignees, a self-taken card, observers, owner and leads moving any card; the item.move-own row, label and mapping"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamMoveOwn.test.ts (6 in-memory tests)"
        status: pass
      - kind: unit
        ref: "src/test/teamPermissions.test.ts#actionForEvent sends the assignee's own moves to item.move-own, keeps cancel and a cancelled reopen on item.move, and needs a state to do so"
        status: pass
    human_judgment: false
  - id: D3
    description: "The board model offers each person exactly the moves the log accepts on each card, with the not-assignee, cancel and observer sentences, and the new developer banner; the host refuses before any prompt"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamBoardMoves.test.ts#a developer moves the cards assigned to them, never cancels, and the menu is exactly the moves that succeed"
        status: pass
      - kind: unit
        ref: "src/test/teamBoardMoves.test.ts#a card assigned to a lead or to nobody: the developer has no moves and every other column says the not-assignee sentence"
        status: pass
      - kind: integration
        ref: "src/test/teamBoardView.test.ts#a developer blocks the card a lead assigned them after the reason box; on the lead's card they are told why before any prompt"
        status: pass
    human_judgment: false
  - id: D4
    description: "The page follows the model's moves: Move to... on the card and in the detail, pick-up for anyone but an observer, drops refused with the model's sentence"
    requirement: BOARD-03
    verification:
      - kind: automated_ui
        ref: "src/test/boardClient.test.ts#a developer or a reviewer sees Move to... on a card assigned to them, and none on a card with no move and no assignment"
        status: pass
      - kind: automated_ui
        ref: "src/test/boardDrag.test.ts#a developer drags their assigned plan to Backlog, and is told why on Cancelled and on a card that is not theirs"
        status: pass
    human_judgment: false
  - id: D5
    description: "In code-server 4.144.0 in Brave (Chrome 156) with real mouse input, the developer's drop on Cancelled and drag of the lead's plan are refused with the plain sentences and send nothing, and their plan dragged to Backlog sends exactly one hold"
    requirement: BOARD-03
    verification:
      - kind: e2e
        ref: "NEAR_AI_CODE_SERVER=<copy of local/code-server:stable /usr/lib/code-server> NEAR_AI_E2E_BROWSER=/usr/bin/brave-browser xvfb-run -a node dist/test/e2e/codeServerBoard.js (25 of 25 checks)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Nothing signed moved: event bodies, the stored WorkItem shape, STATE_HASH_VERSION and pinned hashes unchanged"
    requirement: BOARD-03
    verification:
      - kind: other
        ref: "git diff --quiet 9b5920b over types.ts, validate.ts, materialize.ts, canonical.ts, eventLog.ts; teamAssignHashes.test.ts and the full suite pass"
        status: pass
    human_judgment: false
  - id: D7
    description: "Owner re-test on the next preview: Bob moves the cards Alice assigned him, cannot cancel them, cannot move Alice's"
    requirement: BOARD-03
    verification: []
    human_judgment: true
    rationale: "The decision came from the owner's hands-on re-test; the owner confirms it in their own code-server on the next preview"

duration: 31min
completed: 2026-11-04
---

# Phase 62 Plan 27: Assignees move their own cards (G-62-5, G-62-6) Summary

**A new item.move-own row lets the person a card is assigned to mark it done, block and unblock, hold and release, and reopen it from Done on every clone, while cancel and bringing back a cancelled card stay with the owner and leads. The board model, the page and drag now decide moves card by card through the same actionForEvent mapping the log uses, and a real-browser code-server test drives the developer's drags. No event body, stored shape, hash version or pinned hash changed.**

## Performance

- **Duration:** 31 min
- **Started:** 2026-11-04T19:57:18Z
- **Completed:** 2026-11-04T20:28:09Z
- **Tasks:** 3 (1 tracer TDD, 2 auto TDD)
- **Files modified:** 17 (1 new test file, 7 source or page files, 9 test files)

## Accomplishments

- `permissions.ts`: `item.move-own` kind, an EVERYONE_ACTIVE row and the label "moving cards assigned to them". `actionForEvent` gives it to hold, release, mark done, block and unblock when the author is the card's assignee before the event, and to reopen only when the stored state is done. Cancel always stays `item.move`, and so does any move without a state.
- `board.ts`: planMove first checks the viewer (no device key, removed, observer). It then checks the card: anyone who is not the owner or a lead may move only a card assigned to them. Next come the card's rules, then decideTeamAction on actionForEvent of the probe event. A refused assignee hears the cancel sentence, and anyone else hears the not-assignee sentence. columnMove uses the same two gates. The model's board-wide gate now only covers the viewer, so each card carries its own moves and refusals.
- `boardText.ts`: notAssigneeMove, cancelManagersOnly and observerMove. The developer banner now reads "You can add items, edit your own drafts and move the cards assigned to you. Leads and the owner move any card."
- Page: board.js and detail.js show Move to... whenever the model offers moves, for anyone but an observer. In drag.js, any viewer who may write and is not an observer can pick cards up.
- `seedRetestBoard(world, n, { assignedPlans: true })` adds phase:64 with plan:64-01 (the lead gave it to the developer) and plan:64-02 (the lead kept it). The option is off by default. codeServerBoard step 4 swaps in the developer's model and drives three real drags.

## Task Commits

1. **Task 1: Tracer (tdd)**
   - `19c8bc0` test(62-27): add failing tracer for an assignee moving their own card, and the case table (RED)
   - `d24cf56` feat(62-27): the person a card is assigned to moves it on every clone; cancel stays with the owner and leads (GREEN)
2. **Task 2: Model and host (tdd)**
   - `df040de` test(62-27): the board offers each person exactly the moves the log accepts on each card (RED)
   - `46fda61` feat(62-27): the board decides moves card by card, with plain refusals and the developer banner (GREEN)
3. **Task 3: Page and code-server (tdd)**
   - `0a8ebb5` test(62-27): the page follows each card's moves, not the viewer's role (RED)
   - `e13e908` feat(62-27): the page follows each card's moves, and the developer's real drags in code-server (GREEN)

No REFACTOR commits were needed.

## TDD Gate Compliance

- **Task 1 RED** (`19c8bc0`): a tap run of teamMoveOwn exited 1 with 7 tests: 2 pass, 5 fail. The classifier returned RED_EVIDENCE_OK (target_test_failed). Semantic assessment: the tracer failed on its first planned assertion. The developer's block of their assigned plan was refused with "not permitted: the developer role does not allow moving items", with no build or fixture fault. The 2 passing tests describe behavior that was already true: refusals on cards that are not the developer's, and managers moving anything.
- **Task 1 GREEN** (`d24cf56`): the plan's verify command passed with 196 tests, 196 pass, 0 fail. Tracer gate (auto mode): re-running it gave the same result, so expansion went ahead.
- **Task 2 RED** (`df040de`): a tap run over Moves, Model and View exited 1 with 73 tests: 64 pass, 9 fail. RED_EVIDENCE_OK. Every failure is a planned assertion: the old manager-only sentence, the old banner, and the assignee having no moves.
- **Task 2 GREEN** (`46fda61`): the plan's verify command plus boardMenu passed with 110 tests, 110 pass, 0 fail.
- **Task 3 RED** (`0a8ebb5`): a tap run of the page files exited 1 with 118 tests: 114 pass, 4 fail. RED_EVIDENCE_OK. The failures were Move to... hidden by the role check, the reviewer unable to pick cards up, and the reviewer's drag offering nothing. The developer drag test already passed, because developers could pick cards up before and the model now gives them moves.
- **Task 3 GREEN** (`e13e908`): the page verify passed with 118 tests, 118 pass, 0 fail.

## Verification

- Task 1 verify: 196 of 196 pass.
- Task 2 verify (plus boardMenu): 110 of 110 pass.
- A wider run of `dist/test/team*` and `board*` at the Task 2 GREEN sources (4G cap, concurrency 2) gave 1352 tests: 1348 pass, 2 fail, 2 skipped. Both failures were owner-changed page expectations: the boardDrag 0.6.3 refusal sentence and the boardMenu developer menu. They were fixed in `46fda61` and `0a8ebb5`, and both pass at HEAD.
- Task 3 verify 1 (page files): 118 of 118 pass.
- Task 3 verify 2 (code-server 4.144.0 with Code 1.144.0, copied from local/code-server:stable into the scratchpad, Brave reporting Chrome/156.0.8078.80, under xvfb-run): 25 of 25 checks pass, 0 fail. The owner's 14 checks pass unchanged, and the 11 developer checks are new.
- Task 3 verify 3 (`npm run check`, then `dist/test/e2e/run.js` under `env -u ELECTRON_RUN_AS_NODE -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE xvfb-run -a`, 6G cap) exited 0. Lint was clean. `npm test` ran 1984 tests: 1973 pass, 0 fail, 11 skipped. e2e had 90 ✔ lines, 0 `✖ [` lines and no "extension-host test(s) failed".
- Acceptance greps: `item.move-own` appears 6 times in permissions.ts. The not-assignee sentence appears once in boardText.ts. The three old page role-check lines each count 0.
- Integrity: `git diff --quiet c30d4db` over validate.ts, canonical.ts, eventLog.ts and itemHistory.ts exits 0. `git diff --quiet 9b5920b` over types.ts, validate.ts, materialize.ts, canonical.ts and eventLog.ts exits 0. No 62-27 commit touches types.ts or materialize.ts (count 0). STATE_HASH_VERSION is still 1.
- No em or en dash was added, and src/domain/team gained no vscode import.

## Decisions Made

- **Card gate before card rules:** a non-manager on a card that is not theirs hears the not-assignee sentence for every move and column, instead of a rule about the card's state. The gate refuses only what the log refuses too, because actionForEvent gives anyone but the assignee `item.move`.
- **Observers still excluded on the page:** the role check for owner or lead is gone, so Move to... and pick-up follow the model. The page still refuses an observer, as the existing tampered-model test requires.
- **Reviewer can drag:** she may move the cards assigned to her, so she picks cards up like a developer. The reviewer's banner was left as it was, since the plan changed only the developer banner.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Forged events pushed one at a time in the tracer**
- **Found during:** Task 1 GREEN
- **Issue:** The tracer chained three forged events, and the second one named the first as its prev. A rejected event does not move the head, so the reader rejected it with "prev does not name the log head" and not with the permission reason.
- **Fix:** Each forgery names the current head and is pushed and synced on its own.
- **Committed in:** d24cf56

**2. [Rule 1 - Owner-changed expectation] boardMenu.test.ts (not in the plan's file list, but in Task 3's verify)**
- **Found during:** the wider run after Task 2
- **Issue:** On the card Dana took herself, the menu expected only Unassign me. She now also gets her moves.
- **Fix:** The expectation is now her moves (no Cancel), two separators and Unassign me, with a comment citing the decision.
- **Committed in:** 46fda61

**3. [Rule 1 - Owner-changed expectations] teamBoardModel tracer and teamBoardView hostile-page test**
- **Issue:** Both expected the old "Only the team owner or a lead can move cards." for a developer on an unassigned card.
- **Fix:** They now expect the not-assignee sentence, with comments citing the decision.
- **Committed in:** 46fda61

**4. [Rule 3 - Blocking] codeServerBoard scrolls the board before each developer drag**
- **Found during:** Task 3 code-server run
- **Issue:** The first run showed that the Cancelled header and the developer's row were outside the editor (off to the right, and scrolled up after a refusal). The click and the drag landed on nothing.
- **Fix:** Before each drag, the test sets the board's own scroll position. It checks that both press points are inside the board's visible area, which FACTS now reports as `view`. Every press and drag is still real mouse input. The owner steps are unchanged.
- **Committed in:** e13e908

**Total deviations:** 4 (2 blocking, 2 owner-changed expectation groups). **Impact:** none on scope. Nothing signed, stored or hashed changed.

## Issues Encountered

- Between `46fda61` and `0a8ebb5`, one page test was red: the boardDrag 0.6.3 re-test still expected the old sentence. Task 2's model change reached the page's drop text before Task 3 updated that expectation. It is green at HEAD.

## User Setup Required

None.

## Next Phase Readiness

The owner re-tests on the next preview (coverage D7). Phase 63 claims can add the claimant to the move rule through the same actionForEvent mapping.

## Self-Check: PASSED

- FOUND: src/test/teamMoveOwn.test.ts and this SUMMARY
- FOUND: 19c8bc0, d24cf56, df040de, 46fda61, 0a8ebb5, e13e908 (all ancestors of HEAD)
