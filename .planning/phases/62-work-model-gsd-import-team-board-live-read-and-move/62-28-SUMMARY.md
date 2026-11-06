---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 28
subsystem: team-mode
tags: [team-mode, board, timeline, reopen, hold, gap-closure, code-server]

requires:
  - phase: 62-27
    provides: "Every kanban card draggable, item.move-own for an assignee's own moves, and the drag log the browser check reads"
  - phase: 61-34
    provides: "The plan order this runs in, and the saved-profile work that left the tree clean"
provides:
  - "MoveResult.intents: the list of intents a move writes, in order (intent is always intents[0])"
  - "planMove's 'reopen' plans item.reopened then item.updated { hold: true }, so every reopen lands in Backlog and stays there until Release"
  - "The host appends every planned intent, so the pair lands together or not at all"
  - "seedRetestBoard's readyShaped option: finished plans with files, an estimate and a finished dependency, as imported plans are"
  - "The code-server board check plans every move with the real model on the step's signed world, and adds a release drag from Backlog to Ready"
affects: [61-33, 61-35, 62-29, 62-30, the 0.6.5 preview build, the owner's re-test]

actuals:
  tokens: 11860
  tasks: 3
  commits: 4
plan_head_before: b132e65
plan_head_after: a9e9f5b

tech-stack:
  added: []
  patterns:
    - "A move is planned as the list of intents it writes, so a two-event move is one append and cannot half-land"
    - "A browser check plans moves with the real model on its own signed world, so a move the log would refuse fails the step instead of being drawn"

key-files:
  created: []
  modified:
    - src/domain/team/board.ts
    - src/services/team/boardView.ts
    - src/test/teamBoardReopenColumn.test.ts
    - src/test/teamTimeline.test.ts
    - src/test/teamBoardMoves.test.ts
    - src/test/teamBoardModel.test.ts
    - src/test/helpers/teamBoardWorld.ts
    - src/test/e2e/codeServerBoard.ts
    - .planning/phases/62-work-model-gsd-import-team-board-live-read-and-move/62-CONTEXT.md
    - .planning/debug/board-reopen-lands-in-ready.md

key-decisions:
  - "62-28: a reopen is the existing signed pair item.reopened then item.updated { hold: true } in one append, not a materialiser change; a reopen holds by itself only would make 0.6.4 clients draw the same log differently and disagree on the snapshot hash"
  - "62-28: every reopen lands in Backlog and is held there, whatever the card's readiness (owner decision A, 2026-11-05); Release moves it on, and a released card that is not ready to start stays in Backlog with its reason"
  - "62-28: MoveResult gained intents so a move can write more than one event; intent stays intents[0], so every existing reader of a single move is unchanged"
  - "62-28: the code-server browser check no longer moves a card itself; it plans each move with planMove for the step's viewer and accepts the intents into the step's signed world, then draws the rebuilt model"
  - "62-28: a reopened card's timeline dot shows the hold (timeline.js draws a held card as on hold), and the test proves both the dot's state and the card's Backlog column"

patterns-established:
  - "One append, many intents: a move that needs two signed events plans both and appends them together, so a half move cannot exist"

requirements-completed: [BOARD-03]

coverage:
  - id: D1
    description: "A finished card dropped on Backlog, or moved with Move to... then Backlog (reopen), is reopened and held in Backlog, even when its plan has files, an estimate and finished dependencies"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamBoardReopenColumn.test.ts#the owner drops a finished, ready-shaped plan on Backlog: it is drawn in Backlog afterwards; #Move to... on a finished plan: the column the menu names is the column the card is drawn in afterwards"
        status: pass
      - kind: e2e
        ref: "NEAR_AI_CODE_SERVER=... NEAR_AI_E2E_BROWSER=... xvfb-run node dist/test/e2e/codeServerBoard.js (37 checks, including the reopen and the release drag)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The reopen is one append of item.reopened then item.updated { hold: true }; every clone accepts both for the owner, a lead and the card's assignee and rejects them from anyone else; if the append is refused, neither lands"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamBoardReopenColumn.test.ts (pair shape, replay, acceptance for three viewers, the cancelled card, the shared permission row); src/test/teamBoardMoves.test.ts and src/test/teamBoardModel.test.ts (the shape pins)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Nothing signed or stored changed: no event body, stored WorkItem shape, permission row, STATE_HASH_VERSION or pinned hash"
    requirement: BOARD-03
    verification:
      - kind: integration
        ref: "the invariant command over the first 62-28 commit's parent (types.ts, validate.ts, materialize.ts, permissions.ts, canonical.ts, work.ts, eventLog.ts, media/board/timeline.js unchanged; STATE_HASH_VERSION is 1); src/test/teamAssignHashes.test.ts and src/test/teamMaterialize.test.ts unchanged and green"
        status: pass
    human_judgment: false
  - id: D4
    description: "Move to... on a timeline card makes the same reopen, and timeline dots stay non-draggable"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamTimeline.test.ts#a reopened finished plan is a dot in Backlog with the reopen menu entry gone and Release offered, and its dot never drags"
        status: pass
    human_judgment: true
    rationale: "The owner sees the dot's hold and the Release entry in 0.6.5; the timeline's own drawing rules are unchanged."

duration: 130min
completed: 2026-11-05
status: complete
---

# Phase 62 Plan 28: every reopen lands in Backlog and stays there, on the board and on the timeline, with nothing signed changed

**A finished card dropped on Backlog, or moved with Backlog (reopen), is reopened and held in Backlog by one append of the two existing signed events, so it stays where it was dropped until someone releases it; the browser check now proves it by planning every move with the real model instead of moving the card itself.**

## Performance

- **Duration:** about 130 min across two sittings (the first was interrupted by an unrelated question)
- **Completed:** 2026-11-05
- **Tasks:** 3, each RED then GREEN (Task 2 and Task 3's tests were written against Task 1's GREEN, as the plan allows)
- **Files modified:** 10

## Accomplishments

- `MoveResult` now carries `intents`, the list of events a move writes, with `intent` always `intents[0]`. Every move but a reopen still plans one intent, so nothing changed for them.
- `planMove(..., 'reopen')` plans `item.reopened` then `item.updated { hold: true }` (`intentsFor` in src/domain/team/board.ts). The materialiser's `settle` clears a hold on a reopen, so the second event is what keeps the card in Backlog; a held card is drawn in Backlog by `work.ts columnOf`, which is why the move's promise and the drawn column now agree.
- `boardView.ts` appends every planned intent inside the same append builder, so the pair lands together or not at all.
- `seedRetestBoard` gained `readyShaped` (off by default): finished plans with files, an estimate and a finished dependency, which is what made the bug invisible to the old fixtures.
- The code-server browser check now plans every move request with `planMove` for the step's viewer and accepts the intents into the step's signed world, then draws the rebuilt model. It no longer moves a card itself. It uses ready-shaped finished plans, and step 3 now also drags the reopened card to Ready and checks the release.
- The owner's decision is recorded in 62-CONTEXT.md, and the debug session `board-reopen-lands-in-ready` is resolved.

## Task Commits

1. **Task 1 (tracer): the reopen stays in Backlog, planned by the real model in a real browser**
   - `ad719db` test (RED): `intents` added as `[intent]`, the host writes `planned.intents`, `readyShaped`, the harness plans with the real model, and the release drag. RED failed on behaviour only: `'ready' !== 'backlog'` for both 6ff8876 tests, and the browser step 3 with `live: Moved plan 60-03 to Ready.`
   - `da64fd7` fix (GREEN)
2. **Task 2: the pair is one append, accepted and refused by the right people**
   - `7c23b06` test (the plan's Task 2 tests, written against Task 1's GREEN; they passed on the first run except for three fixture mistakes of mine, fixed in the same commit)
3. **Task 3: the timeline makes the same move**
   - `a9e9f5b` test (passed on Task 1's GREEN, as the plan predicted), plus the debug session's resolution and 62-CONTEXT.md

## Test results (all under the memory cap)

- Task 1 unit set (reopen column, moves, model, drag): 68 tests, 68 pass, 0 fail.
- Task 1 browser check: 37 checks, all pass, exit 0 (code-server 4.144.0 with Code 1.144.0, Brave 156).
- Task 2 set (board view, reopen column, moves, move-own, item forgery, item events, assign hashes, materialize): 205 tests, 205 pass, 0 fail.
- Invariant command: no change since before 62-28 to types.ts, validate.ts, materialize.ts, permissions.ts, canonical.ts, work.ts, eventLog.ts or media/board/timeline.js; STATE_HASH_VERSION is 1.
- Task 3 set (timeline, board timeline, timeline interaction): 47 tests, 47 pass, 0 fail.
- Board and timeline launches (`NEAR_AI_E2E_ONLY=board,timeline`, hidden screen): 75 window checks, 0 failed, exit 0.
- Full `npm test` before Task 2's tests: 2235 tests, 2222 pass, 2 fail (the 62-28 RED tests), 11 skipped; both RED tests are now green.

## Decisions Made

See key-decisions. In short: the pair of existing events, not a materialiser change; a reopen always lands held in Backlog; `intents` is additive so every existing reader is unchanged; the browser check must use the real model, or it can pass while the product is wrong.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The plan's Task 3 timeline assertion could not hold**
- **Found during:** Task 3
- **Issue:** the timeline dot reports `data-state` as `held` for a held card (`timeline.js` stateOf: blocked, then on hold, then the column), so an assertion that the dot says `backlog` failed even though the card was correctly in Backlog.
- **Fix:** the check asserts the dot shows the hold and, from the board model, that the card is in Backlog and held; the exact wording of the timeline's drawing rules is unchanged.
- **Files modified:** src/test/e2e/codeServerBoard.ts
- **Commit:** `da64fd7`

**2. [Rule 1 - Bug] Three fixture mistakes of mine in Task 2's tests**
- A done card cannot be assigned (`item.assigned` refuses a terminal card), so the assignee fixture assigns while the plan is open and then marks it done; a done card cannot be cancelled either, so the cancelled-card case reopens first, then cancels; and the owner and a lead move a card on `item.move`, not `item.move-own`, so the shared-row assertion expects the row each viewer actually gets. No product code was changed for any of them.
- **Files modified:** src/test/teamBoardReopenColumn.test.ts
- **Commit:** `7c23b06`

**3. [Test setup] The RED commit had to compile**
- As the plan requires, `intents` was added filled with the single intent, so the RED failed on behaviour (`'ready' !== 'backlog'`) and not on compilation.
- **Commit:** `ad719db`

---

**Total deviations:** 3 (2 of my own test bugs, 1 test setup). **Impact:** none on product behaviour; the owner's decision is implemented exactly as recorded.

## Issues Encountered

- The browser check needs a code-server copy; `/home/aaron/projects/scratch/code-server-copy` was made with `docker cp` from the `code-server` container for this run, since the container was not restarted or otherwise touched.

## Owner re-test items this closes

- 0.6.4 re-test board item 3 (steps 12 and 16): a finished card reopened by a drag or by Move to... now stays in Backlog. The re-test script for 0.6.5 should use a plan card for steps 13 to 16, because step 13's card last time was a planless phase card, which cannot move.
