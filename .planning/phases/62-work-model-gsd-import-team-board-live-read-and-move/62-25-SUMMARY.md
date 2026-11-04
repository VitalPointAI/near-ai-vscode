---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 25
subsystem: team-domain
tags: [team-mode, signed-log, assignment, permissions, self-assignment, g-62-5]
status: complete

requires:
  - phase: 62-15
    provides: "item.assigned { id, memberId } and item.unassigned { id }, the item.assign row (owner and lead), assignProblem and mayBeAssigned"
provides:
  - "item.assign-self permission row (owner, lead, developer, reviewer; never observer) labelled 'assigning items to themselves'"
  - "actionForEvent maps a member's own assignment of a free card, or taking themselves off their own card, to item.assign-self; everything else stays item.assign"
  - "mayBeAssigned: a current, confirmed member whose role is not observer (reviewers can now hold an assignment)"
  - "teamSelfAssign.test.ts: two-clone tracer, forgery, and the role and case table on write and read"
affects: [62-19, 62-20, 62-24, phase-63-claims]

actuals:
  tokens: 8406
  tasks: 3
  commits: 3
plan_head_before: 00292559cc4e4a51e5d571ab2f1ba54c4969dfa1
plan_head_after: 54092d7

tech-stack:
  added: []
  patterns:
    - "A second permission path for the same signed event, chosen by actionForEvent from the state before the event, so no body or hash moves"

key-files:
  created:
    - src/test/teamSelfAssign.test.ts
  modified:
    - src/domain/team/permissions.ts
    - src/domain/team/work.ts
    - src/test/teamItemAssign.test.ts
    - src/test/teamPermissions.test.ts

key-decisions:
  - "Task 1 checkpoint (gate blocking, auto mode, owner confirmed 2026-11-03): confirm-recorded. Self-assignment only on an unassigned card (or one already the author's, which the rules then refuse as a repeat); a teammate's card changes hands only when they unassign themselves or a lead reassigns it"
  - "A self-assignment of an item that is not on the board maps to item.assign-self, so the reader answers 'item not found' rather than a misleading 'assigning items to others'"
  - "mayBeAssigned no longer asks the claim row and drops its itemKind parameter; work.ts no longer imports permissions.ts, which removes the run-time import cycle 62-15 documented"

patterns-established:
  - "Owner-changed expectations in older tests are moved to the cases the rule still forbids, each with a comment citing the decision, never deleted"

requirements-completed: [BOARD-02, BOARD-03]

coverage:
  - id: D1
    description: "A developer assigns a card to themselves on one computer and the lead's computer shows it after one sync; taking themselves off travels the same way"
    requirement: BOARD-02
    verification:
      - kind: integration
        ref: "src/test/teamSelfAssign.test.ts#a developer assigns a card to themselves, the lead sees it after one sync, takes themselves off the same way, and cannot assign the lead on write or by forging"
        status: pass
    human_judgment: false
  - id: D2
    description: "A developer or reviewer cannot assign someone else, take someone else off, or take a teammate's card: refused on write, forged events rejected by both clones, nothing changes"
    requirement: BOARD-03
    verification:
      - kind: integration
        ref: "src/test/teamItemAssign.test.ts#a lead assigns a plan to a developer on one computer, the developer sees it after one sync, and a developer cannot assign on write or by forging"
        status: pass
      - kind: unit
        ref: "src/test/teamSelfAssign.test.ts#a developer or reviewer cannot put someone else on a card, take someone else off, or take a teammate's card, and nothing changes"
        status: pass
    human_judgment: false
  - id: D3
    description: "Observers, joined members still waiting for a lead and removed members cannot assign themselves, and a lead cannot assign them"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamSelfAssign.test.ts#an observer, a joined member still waiting for a lead and a removed member cannot assign themselves, on write and on read"
        status: pass
    human_judgment: false
  - id: D4
    description: "The owner and leads still assign and unassign anyone, now including reviewers"
    requirement: BOARD-02
    verification:
      - kind: unit
        ref: "src/test/teamSelfAssign.test.ts#the owner and a lead still assign and unassign anyone, as after 62-15, including the reviewer and themselves"
        status: pass
    human_judgment: false
  - id: D5
    description: "The permission row, its label and the event-to-action mapping with and without a state"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamPermissions.test.ts#actionForEvent sends a member's own assignment to item.assign-self and everything else to item.assign, and needs a state to do so"
        status: pass
      - kind: unit
        ref: "src/test/teamPermissions.test.ts#matrix: item.assign-self"
        status: pass
    human_judgment: false
  - id: D6
    description: "Nothing signed or hashed moved: event bodies, WorkItem key set, STATE_HASH_VERSION and the pinned hashes are unchanged"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamAssignHashes.test.ts; src/test/teamItemEvents.test.ts; src/test/teamItemSnapshot.test.ts; git diff --quiet 28b62c1 over types.ts, validate.ts, materialize.ts, canonical.ts, eventLog.ts"
        status: pass
    human_judgment: false

duration: 12min
completed: 2026-11-04
---

# Phase 62 Plan 25: Self-assignment for any non-observer member (G-62-5) Summary

**A new item.assign-self permission path lets any confirmed owner, lead, developer or reviewer put themselves on a free card and take themselves off their own, decided by the same actionForEvent on write and on read, with no change to the signed events or any hash.**

## Performance

- **Duration:** 12 min (plan start stamp to the last task commit)
- **Started:** 2026-11-04T02:05:40Z
- **Completed:** 2026-11-04T02:17:08Z
- **Tasks:** 3 (1 checkpoint auto-selected, 1 tracer, 1 auto TDD)
- **Files modified:** 5 (1 new test file, 2 domain files, 2 test files)

## Accomplishments

- A developer appends item.assigned naming themselves on an unassigned plan with their own key, and the lead's clone shows it after one sync; their item.unassigned does the same. Assigning the lead is refused on write, and the same event forged into the remote is rejected by both clones with "not permitted: the developer role does not allow assigning items to others".
- actionForEvent answers item.assign-self only when the body names the author and the card has no assignee (or is already theirs), or when the author is the card's current assignee for an unassign. Anything else, including taking a teammate's card, stays on the owner and lead row. Without a state, both events still map to item.assign, the stricter answer.
- mayBeAssigned is now "a current, confirmed member whose role is not observer", so reviewers can hold an assignment and leads can assign them.
- types.ts, validate.ts, materialize.ts, canonical.ts and eventLog.ts are unchanged since 28b62c1. The pinned hashes, frozen bodies and the WorkItem key set tests pass unchanged.

## Task Commits

1. **Task 1: Confirm the self-assignment rules (checkpoint:decision, gate blocking)**: no commit. Auto mode took `confirm-recorded`, which the owner confirmed on 2026-11-03 (62-CONTEXT.md).
2. **Task 2: Tracer (tdd)**:
   - `c80d07a` test(62-25): add failing tracer for a developer assigning and unassigning themselves across two clones (RED)
   - `250507c` feat(62-25): any confirmed member who is not an observer assigns and unassigns themselves (GREEN)
3. **Task 3: Every role and case, the permission table (tdd)**:
   - `54092d7` test(62-25): every role and case of self-assignment on write and read, and the new permission row

No REFACTOR commits were needed.

## TDD Gate Compliance

- **Task 2 RED** (`c80d07a`): `node --test --test-reporter=tap dist/test/teamSelfAssign.test.js dist/test/teamItemAssign.test.js`, exit 1, 10 tests, 9 pass, 1 fail. `gsd-tools check tdd-red-evidence` returned RED_EVIDENCE_OK (target_test_failed). Semantic assessment: the target tracer ran and failed on its first planned assertion (`assigned.ok` expected true, actual false, reason "not permitted: the developer role does not allow assigning items to others"), because no client allowed a developer's own assignment yet. There was no build, load or fixture fault. The moved 62-15 tracer cases already passed, because they test what the rule still forbids.
- **Task 2 GREEN** (`250507c`): the plan's verify command passed with 14 tests, 14 pass, 0 fail. Tracer feedback gate (auto mode): the verify was re-run green before expanding.
- **Task 3**: there was no valid RED. Task 2's GREEN had already put the row, the mapping and the eligibility rule in place, so the table describes behavior that already existed. The tests were written before any further source change. The first run had 199 tests, 198 pass, 1 fail. That failure was a wrong expectation in the new test, not missing behavior: the reader rejects a removed author at its author check, which runs before the permission check for every event type. The expectation was corrected, and no source change was made.
- **Task 3 final**: the plan's verify command passed with 199 tests, 199 pass, 0 fail.

## Files Created/Modified

- `src/domain/team/permissions.ts`: the `item.assign-self` kind, its EVERYONE_ACTIVE row, the label 'assigning items to themselves', and the self mapping in actionForEvent
- `src/domain/team/work.ts`: `mayBeAssigned(state, memberId)` checks for a current, confirmed member who is not an observer; the permissions.ts import is gone
- `src/test/teamSelfAssign.test.ts` (new, 6 tests): the real-git tracer and forgery, plus 5 in-memory tests that check the writer (prepareEvents plus checkCandidate) and the reader (applyEntry) give the same answer
- `src/test/teamItemAssign.test.ts`: the tracer's refused and forged cases now take the lead's card; the reviewer row moves from not eligible to accepted; the developer and reviewer rows in "only the owner and a lead" now act on the lead; the planner test uses the observer; the history test's refused attempt puts the lead on the card. Each change has a comment citing the owner decision of 2026-11-03
- `src/test/teamPermissions.test.ts`: the matrix row, the kind count (30), the label and the observer's denial text, and the actionForEvent mapping table with and without a state

## Decisions Made

- **Task 1 checkpoint: `confirm-recorded`** (auto mode, gate blocking, auto_select confirm-recorded). The owner confirmed the planned rule on 2026-11-03: self-assignment applies only to an unassigned card, and a teammate's card changes hands only when that teammate unassigns themselves or a lead reassigns it. The row, label, mapping, guard and assignee rule are exactly as recorded in the plan. Nothing was revised.
- If someone assigns themselves to an item that is not on the board, it maps to item.assign-self. The reader then reports the missing item instead of "assigning items to others".
- mayBeAssigned no longer asks the claim row, so work.ts no longer imports permissions.ts. That removes the run-time import cycle that 62-15 documented.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The 62-15 in-memory test updates moved into Task 2**
- **Found during:** Task 2 GREEN
- **Issue:** Task 2's verify command runs teamItemAssign.test.js. The rejection table's reviewer row, the "only the owner and a lead" rows and the planner test (all planned for Task 3) failed as soon as the rule changed.
- **Fix:** Applied the planned changes in the GREEN commit, each with its owner-decision comment.
- **Files modified:** src/test/teamItemAssign.test.ts
- **Committed in:** 250507c

**2. [Rule 1 - Test expectation changed by the owner] The card history test's refused attempt**
- **Found during:** Task 2 GREEN
- **Issue:** The history test (not named in the plan) used a developer assigning themselves to a free card as its "rejected attempt leaves nothing" step. That attempt is now allowed.
- **Fix:** The refused attempt now puts the lead on the card, which is still refused. The test now also asserts the refusal reason. The history assertions are unchanged, and a comment cites the decision.
- **Files modified:** src/test/teamItemAssign.test.ts
- **Committed in:** 250507c

**3. [Rule 1 - Pre-existing order] The reader's reason for a removed author**
- **Found during:** Task 3
- **Issue:** The plan's table says "a removed member (rejected, removed)". The writer says "not permitted: the author was removed from this team". The reader stops earlier at its author check with "author was removed before this event", as it does for every event type.
- **Fix:** The test asserts both reasons, with a comment. The reader is unchanged, because materialize.ts must not change in this plan.
- **Committed in:** 54092d7

**Total deviations:** 3 (1 blocking, 2 test expectations). **Impact:** none on scope; nothing signed, stored or hashed changed.

## Issues Encountered

- Between 250507c and 54092d7, teamPermissions.test.ts's kind count (29) was red, because the new kind landed in Task 2 and the table update was in Task 3. It is green at 54092d7.
- Write and read can still differ in one case. When a single append batches a self-assignment and a self-unassignment of the same card, the writer checks both against the state before the batch, so the second is refused locally. The reader would accept the pair. The writer is the stricter side, and own-draft edits have always behaved this way. The board sends one event per action.

## Verification

- Plan Task 3 command (tsc plus 7 files): 199 tests, 199 pass, 0 fail.
- Wider check (`dist/test/team*.test.js` and `dist/test/board*.test.js`, 77 files, capped at 4G, concurrency 2): 1232 tests, 1230 pass, 0 fail, 2 skipped (the two live NEAR tests that need NEAR_LIVE_TEAM=1).
- `git diff --quiet 28b62c1 -- types.ts validate.ts materialize.ts canonical.ts eventLog.ts`: exit 0.
- `grep -c "item.assign-self" src/domain/team/permissions.ts`: 7. `grep -c "^test(" src/test/teamSelfAssign.test.ts`: 6. There are no vscode imports in permissions.ts or work.ts, and no dashes in the new text.
- The full `npm test` and e2e were not run: this plan is not the phase boundary (62-19 to 62-24 remain).

## User Setup Required

None.

## Next Phase Readiness

62-19 (model) and 62-20 (board) can offer "Assign to me" on an unassigned card and "Unassign me" on the viewer's own card for any non-observer. To decide what to show, they ask `decideTeamAction(state, me, actionForEvent(candidate, state))`, or check the item.assign-self row and the card's assignee. A card held by a teammate shows only the lead's reassign path.

## Self-Check: PASSED
