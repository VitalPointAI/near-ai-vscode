---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 26
subsystem: team-domain
tags: [team-mode, signed-log, assignment, permissions, board, g-62-5]
status: complete

requires:
  - phase: 62-15
    provides: "item.assigned { id, memberId } and item.unassigned { id }, WorkItem.assignee, the snapshot assignee checks"
  - phase: 62-25
    provides: "item.assign-self and actionForEvent's self mapping, asked on write and on read"
provides:
  - "WorkItem.assignedBy: the member id of the author of the item.assigned that set the current assignee, present only while assignee is"
  - "actionForEvent maps item.unassigned to item.assign-self only when the author is both the assignee and assignedBy"
  - "Snapshot parser and checks carry assignedBy (member id, on the roster, removed allowed, never without an assignee)"
  - "Board: Unassign me only on cards the member took; CardDetail.assignedBy and assignNote; ASSIGN_REFUSALS.assignedByOther; takenBy by assigner"
affects: [62-27, phase-63-claims]

actuals:
  tokens: 9317
  tasks: 3
  commits: 4
plan_head_before: e7d15ec78167ff935dc0628b4fb587be0c95b8dd
plan_head_after: 79106cc51ebedc9994932ffb25cb8d382ba4e919

tech-stack:
  added: []
  patterns:
    - "A stored fact derived from the event author (assignedBy) narrows a permission mapping without changing any event body or the hash version"

key-files:
  created:
    - src/test/teamAssignedBy.test.ts
  modified:
    - src/domain/team/types.ts
    - src/domain/team/materialize.ts
    - src/domain/team/permissions.ts
    - src/domain/team/board.ts
    - src/domain/team/boardText.ts
    - media/board/detail.js
    - src/test/teamItemEvents.test.ts
    - src/test/teamItemSnapshot.test.ts
    - src/test/teamPermissions.test.ts
    - src/test/teamBoardAssignModel.test.ts
    - src/test/teamBoardPhaseCards.test.ts
    - src/test/boardDetail.test.ts
    - src/test/teamBoardAssignView.test.ts

key-decisions:
  - "Task 1 checkpoint (gate blocking, auto mode, auto_select): confirm-recorded. WorkItem.assignedBy and the narrower item.unassigned mapping exactly as recorded, with the replay consequences for 0.6.x preview logs accepted (the previews are unreleased test builds)"
  - "The snapshot check refuses an assigner whose member record is still only an invitation, like the assignee check, because nobody who has not joined can sign an assignment; a removed assigner is allowed"
  - "takenBy gained an optional second argument (did the holder take it themselves); the default is the stricter 'A lead can change that.'"

patterns-established:
  - "Owner-changed board expectations are moved to the case the rule still allows (Dana takes the card herself), with the lead-assigned case covered by a new test, never deleted"

requirements-completed: [BOARD-03]

coverage:
  - id: D1
    description: "Every client records who made the current assignment, and a member cannot leave a card a lead assigned them: refused on write, a forged event rejected by both clones, the card keeps them"
    requirement: BOARD-03
    verification:
      - kind: integration
        ref: "src/test/teamAssignedBy.test.ts#a lead assigns the developer and the developer cannot take themselves off, on write or by forging; a card the developer took they can leave"
        status: pass
    human_judgment: false
  - id: D2
    description: "Case table on writer and reader: lead replacing a self-assignment, reviewer, owner and leads unassign anyone, removal of the assignee or the assigner, a 0.6.3-style replay"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamAssignedBy.test.ts (6 in-memory tests)"
        status: pass
      - kind: unit
        ref: "src/test/teamPermissions.test.ts#actionForEvent sends a member's own assignment to item.assign-self and everything else to item.assign, and needs a state to do so"
        status: pass
    human_judgment: false
  - id: D3
    description: "Nothing signed or pinned moved; snapshots carry assignedBy, round-trip with the same hash, equal the full replay, and refuse a malformed or orphaned assigner"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamAssignHashes.test.ts; src/test/teamItemEvents.test.ts#the stored WorkItem key set is frozen; src/test/teamItemSnapshot.test.ts; git diff --quiet f9c2b5d over validate.ts, canonical.ts, eventLog.ts, itemHistory.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "The board offers Unassign me only on cards the member took, says 'Assigned to you by {name}. Ask a lead to change it.' under Assigned to, and refuses an unassign sent anyway naming who assigned it"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamBoardAssignModel.test.ts#a card a lead assigned: the member is offered nothing, hears who assigned it, and the detail says so; a card they took they can leave"
        status: pass
      - kind: automated_ui
        ref: "src/test/boardDetail.test.ts#on a card a lead assigned, the drawer says who assigned it under Assigned to, as text, with no Unassign me; on a card the member took, no note"
        status: pass
      - kind: integration
        ref: "src/test/teamBoardAssignView.test.ts#a developer is offered nothing on a card a lead assigned them, and an unassign sent anyway is refused naming the lead, with nothing written"
        status: pass
    human_judgment: false
  - id: D5
    description: "Owner re-test of the rule on the next preview in code-server (Bob cannot leave a card Alice assigned, can leave one he took)"
    requirement: BOARD-03
    verification: []
    human_judgment: true
    rationale: "The finding came from the owner's hands-on re-test; the owner confirms it on the next preview"

duration: 18min
completed: 2026-11-04
---

# Phase 62 Plan 26: A member leaves only a card they took themselves (G-62-5) Summary

**Every client now stores who made each card's current assignment (WorkItem.assignedBy) and maps a member's unassign to item.assign-self only when they are both the assignee and the assigner, so a card a lead gave Bob stays his until a lead changes it; the board shows Unassign me only on cards he took and says "Assigned to you by {name}. Ask a lead to change it." on the rest. No event body, the hash version or a pinned hash moved.**

## Performance

- **Duration:** 18 min
- **Started:** 2026-11-04T19:35:14Z
- **Completed:** 2026-11-04T19:53:16Z
- **Tasks:** 3 (1 decision checkpoint auto-selected, 1 tracer TDD, 1 auto TDD)
- **Files modified:** 14 (1 new test file, 6 source files, 7 test files)

## Accomplishments

- `item.assigned` sets `assignee` and `assignedBy` (the event author), so a lead who replaces a self-assignment becomes the assigner. `item.unassigned` deletes both, and removing the assignee clears both. Removing the assigner leaves `assignedBy` in place, so the card still needs the owner or a lead.
- `actionForEvent` maps `item.unassigned` to `item.assign-self` only when the author is both the assignee and `assignedBy`. Every other unassign stays on the owner and lead row. The writer, the reader and the board all ask this one mapping.
- The snapshot parser accepts `assignedBy` as an optional member id. `checkAssignees` refuses it on a card with no assignee, and refuses one that names nobody on the roster or only an invitation. A removed assigner is allowed.
- Board: `selfRefusal` answers `assignedByOther` ("Lee assigned this card to you. Ask a lead to change it. Nothing was changed."). `takenBy` says "Dana or a lead" only when Dana took the card herself; otherwise it says "A lead". `CardDetail` gains `assignedBy` and, for the member on a card the owner or a lead gave them, `assignNote`. `detail.js` writes the note as text in a `dd` right under Assigned to. `availableAssignActions` needed no new rule.

## Task Commits

1. **Task 1: Confirm the stored assigner and the narrower self-unassign rule (checkpoint:decision, gate blocking)**: no commit. Auto mode took `confirm-recorded`, as the orchestrator instructed.
2. **Task 2: Tracer (tdd)**
   - `07dcd5e` test(62-26): add failing tracer for a lead's assignment the developer cannot leave, and the case table (RED)
   - `10aebf3` feat(62-26): every client records who made each assignment, and a member leaves only a card they took themselves (GREEN)
3. **Task 3: The board shows the rule (tdd)**
   - `ee78ddb` test(62-26): the board shows who assigned a card and offers Unassign me only on cards the member took (RED)
   - `79106cc` feat(62-26): the board offers Unassign me only on cards the member took, and says who assigned the rest (GREEN)

No REFACTOR commits were needed.

## TDD Gate Compliance

- **Task 2 RED** (`07dcd5e`): `node --test --test-reporter=tap dist/test/teamAssignedBy.test.js` exited 1: 7 tests, 1 pass, 6 fail. `gsd-tools check tdd-red-evidence` returned RED_EVIDENCE_OK (target_test_failed). Semantic assessment: the tracer ran and failed on its first planned assertion. The developer clone was expected to hold `{ assignee: Bob, assignedBy: lead }` but held only the assignee. There was no build, load or fixture fault. The one passing test (the owner and leads unassign anyone) describes behavior that was already allowed.
- **Task 2 GREEN** (`10aebf3`): the plan's verify command passed: 206 tests, 206 pass, 0 fail. Tracer feedback gate (auto mode): the wider re-run is under Verification below. It showed only the three board-model expectations that Task 3 owns.
- **Task 3 RED** (`ee78ddb`): tap run over the model, page, host and phase-card files exited 1: 51 tests, 46 pass, 5 fail. The classifier returned RED_EVIDENCE_OK for the model target. Semantic assessment: every failure is a planned assertion. The model and host still returned the generic "You can only take yourself off a card" sentence, and the page drew no `.assign-note`. The RED commit also adds the two optional `CardDetail` fields as types only (no behavior), so the test compiles and fails on its assertions rather than on a type error.
- **Task 3 GREEN** (`79106cc`): the plan's first verify command, plus teamBoardPhaseCards, passed: 84 tests, 84 pass, 0 fail.

## Files Created/Modified

- `src/domain/team/types.ts`: `WorkItem.assignedBy?: string`, with its comment. The body interfaces are byte for byte unchanged.
- `src/domain/team/materialize.ts`: the apply cases, `releaseHeldWork`, `ITEM_OPTIONAL`, the snapshot item parser and `checkAssignees`
- `src/domain/team/permissions.ts`: the `item.unassigned` case of `actionForEvent`
- `src/domain/team/board.ts`: `CardDetail.assignedBy` and `assignNote`, `selfRefusal`, and `buildCardDetail`
- `src/domain/team/boardText.ts`: `ASSIGN_REFUSALS.assignedByOther`, `takenBy(name, tookItThemselves)` and `assignedToYouBy(name)`
- `media/board/detail.js`: one line that draws `d.assignNote` as a text `dd.assign-note` under Assigned to
- `src/test/teamAssignedBy.test.ts` (new, 7 tests): the real-git two-clone tracer with a forged unassign, plus the in-memory case table on the writer and the reader
- `src/test/teamItemEvents.test.ts`: the frozen key set gains `assignedBy`, with a comment citing the owner decision of 2026-11-04
- `src/test/teamItemSnapshot.test.ts`: the round trip asserts the assigners; a new test covers a hostile `assignedBy`
- `src/test/teamPermissions.test.ts`: the mapping table cards carry `assignedBy`, plus a new row for the lead-given card
- `src/test/teamBoardAssignModel.test.ts`, `teamBoardPhaseCards.test.ts`, `boardDetail.test.ts`, `teamBoardAssignView.test.ts`: the new board tests, and the 62-25 expectations the owner changed (see Deviations)

## Decisions Made

- **Task 1 checkpoint: `confirm-recorded`** (gate blocking, auto mode, auto_select). The field, the mapping and the replay consequences for 0.6.x preview logs are exactly as recorded in the plan. The previews are unreleased test builds. Nothing was revised.
- The snapshot check refuses an assigner who is still only an invitation, for the same reason the assignee check does: nobody who has not joined can sign an assignment. Removed assigners are allowed.
- `takenBy` takes an optional `tookItThemselves`. It defaults to false, the stricter sentence ("A lead can change that.").
- The note is drawn as an extra `dd` in the Facts list, right after the Assigned to value. A `dl` allows more than one `dd` per term, so assistive technology reads it as part of that fact.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] teamPermissions.test.ts updated in Task 2 GREEN**
- **Found during:** Task 2 GREEN
- **Issue:** Task 2's verify runs teamPermissions.test.js, and its mapping table (not in the plan's file list) expected a developer to leave any card they hold.
- **Fix:** The table's cards now carry `assignedBy`. "The developer takes themselves off a card they took" still maps to SELF. A new row, the card the lead gave the developer, maps to OTHERS, with a comment citing the owner decision.
- **Committed in:** 10aebf3

**2. [Rule 1 - Owner-changed expectation] teamBoardPhaseCards.test.ts**
- **Found during:** the tracer gate's wider run after Task 2
- **Issue:** The phase-card detail test expected Dana to plan an unassign of a phase card Lee assigned her.
- **Fix:** She now gets the assignedByOther sentence, and Lee can still unassign her. A comment cites the decision.
- **Committed in:** ee78ddb

**3. [Rule 3 - Blocking] CardDetail type fields in the RED commit**
- **Found during:** Task 3 RED
- **Issue:** The new model test reads `assignedBy` and `assignNote` from `CardDetail`, so tsc refused the test, and that would have been an invalid RED.
- **Fix:** The two optional fields were added to the interface (types only) in the RED commit.
- **Committed in:** ee78ddb

The 62-25 expectations in teamBoardAssignModel.test.ts were updated as the plan anticipated. In "the offered actions", Dana now takes the card herself, so Unassign me stays covered. In "the card detail", Dana is offered nothing on Lee's assignment and sees the note. Both carry comments citing the decision, and nothing was deleted.

**Total deviations:** 3 (2 blocking, 1 owner-changed expectation). **Impact:** none on scope; nothing signed, hashed or pinned changed.

## Issues Encountered

- Between `10aebf3` and `ee78ddb`, three board-model tests were red: the offered actions, the card detail and the phase-card detail. Task 2's rule change reached the board before Task 3 updated those expectations. They are green at `79106cc`.

## Verification

- Task 2 verify (tsc plus 7 files): 206 tests, 206 pass, 0 fail.
- Tracer gate wider run (`dist/test/team*.test.js` and `dist/test/board*.test.js`, 4G cap, concurrency 2) at `10aebf3`: 1334 tests, 1329 pass, 3 fail (the three board expectations above, which Task 3 owns), 2 skipped (the live NEAR tests).
- Task 3 verify 1 (tsc plus 7 files): 84 tests, 84 pass, 0 fail.
- Task 3 verify 2 (`npm run check`, then every e2e launch under `env -u ELECTRON_RUN_AS_NODE -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE xvfb-run -a`, 6G cap): exit 0. Lint was clean. `npm test` ran 1966 tests: 1955 pass, 0 fail, 11 skipped. e2e: 90 passed, 0 failed, with no `✖ [` line and no "extension-host test(s) failed".
- `git diff --quiet f9c2b5d -- validate.ts canonical.ts eventLog.ts itemHistory.ts`: exit 0. `STATE_HASH_VERSION = 1`. `ItemAssignedBody` and `ItemUnassignedBody` are unchanged. teamAssignHashes.test.ts passes unchanged.
- `grep -c assignedBy`: 2 in types.ts and 9 in materialize.ts. `assignNote`: 2 in board.ts and 1 in detail.js. The only media/board file in a 62-26 commit is `media/board/detail.js`.
- No em or en dash in any added line, and no vscode import in src/domain/team.

## User Setup Required

None.

## Next Phase Readiness

62-27 (assignees move their own cards) can read `item.assignee` for its move rule. It does not need `assignedBy`, because the owner decision lets an assignee move a card whoever assigned it. The owner re-tests the unassign rule in code-server on the next preview (coverage D5).

## Self-Check: PASSED
