---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 15
subsystem: team-domain
tags: [team-mode, signed-log, assignment, permissions, snapshots, g-62-5]
status: complete

requires:
  - phase: 61-22
    provides: "Phase 61 fix pass complete: confirmed joins, member removal releasing held work, real-git flow rig"
  - phase: 62-01
    provides: "Work item events, transitionProblem, the frozen body and key-set pins"
provides:
  - "item.assigned { id, memberId } and item.unassigned { id } as signed, permission-checked work events (owner and lead)"
  - "WorkItem.assignee (optional member id, left out when empty) with set, replace, unassign and removal clearing"
  - "Assignment rules in transitionProblem shared by the reader, the writer's replay and the board planner"
  - "Snapshot parse of assignee and ItemHistory.memberId for both events"
  - "Three state hashes pinned before the change (teamAssignHashes.test.ts)"
affects: [62-19, 62-20, 62-24, phase-63-claims]

actuals:
  tokens: 14315
  tasks: 3
  commits: 5
plan_head_before: 64bbdddbe4bba22d3f43cab20c4e1b62127044db
plan_head_after: 9840154183a6877df6295454da48af9c3bbfc919

tech-stack:
  added: []
  patterns:
    - "Hash pins recorded at HEAD before a state-shape change, over a deterministic log (fixed seed, ids, times)"
    - "An optional hashed key is left out when empty so older logs keep their state hash"

key-files:
  created:
    - src/test/teamAssignHashes.test.ts
    - src/test/teamItemAssign.test.ts
  modified:
    - src/domain/team/types.ts
    - src/domain/team/validate.ts
    - src/domain/team/work.ts
    - src/domain/team/permissions.ts
    - src/domain/team/materialize.ts
    - src/domain/team/itemHistory.ts
    - src/test/teamValidate.test.ts
    - src/test/teamItemSnapshot.test.ts
    - src/test/teamItemEvents.test.ts
    - src/test/helpers/teamEvents.ts

key-decisions:
  - "Task 1 checkpoint (gate blocking, auto mode): auto-selected confirm-recorded after the pre-change hashes were recorded at 64bbddd; bodies, field, mapping and rules exactly as recorded in the plan"
  - "Eligibility asks decideTeamAction for item.claim on the item kind (owner, lead, developer today) plus not removed, not an unused invitation, no pending role; work.ts imports permissions.ts, a run-time-only cycle that is safe in either load order"
  - "A snapshot assignee must also name a current, joined member on the roster (stricter than the plan's member-id rule): no log can produce anything else, since removal clears and invitations cannot be assigned"
  - "ItemHistory follows assignees from the accepted events it records (including member.removed) so an unassign names who it removed; it never reads TeamState"

patterns-established:
  - "New work events join transitionProblem and the materialiser reference step together, so write and read give the same reason"

requirements-completed: [BOARD-02, BOARD-03]

coverage:
  - id: D1
    description: "A lead's assignment on one computer shows on the developer's computer after one sync (real git, two clones)"
    requirement: BOARD-02
    verification:
      - kind: integration
        ref: "src/test/teamItemAssign.test.ts#a lead assigns a plan to a developer on one computer, the developer sees it after one sync, and a developer cannot assign on write or by forging"
        status: pass
    human_judgment: false
  - id: D2
    description: "A developer, reviewer or observer cannot assign or unassign: refused on write, forged events rejected on read by both clones, nothing changes"
    requirement: BOARD-03
    verification:
      - kind: integration
        ref: "src/test/teamItemAssign.test.ts#a lead assigns a plan to a developer on one computer, the developer sees it after one sync, and a developer cannot assign on write or by forging"
        status: pass
      - kind: unit
        ref: "src/test/teamItemAssign.test.ts#only the owner and a lead may assign or unassign, on read"
        status: pass
    human_judgment: false
  - id: D3
    description: "Each refused assignment gets its own reason (kind, terminal, missing, not eligible, already assigned, not assigned)"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamItemAssign.test.ts#each assignment the rules refuse is rejected with its own reason, and nothing changes"
        status: pass
      - kind: unit
        ref: "src/test/teamItemAssign.test.ts#the board planner and the reader give the same answer, because both ask transitionProblem"
        status: pass
    human_judgment: false
  - id: D4
    description: "Replace, unassign (also on a done card), removal clears in the same step, state moves keep the assignee and assignment never moves stateSince"
    requirement: BOARD-02
    verification:
      - kind: unit
        ref: "src/test/teamItemAssign.test.ts#a planless phase, a backlog plan and a board chore take the owner, a lead and a developer in turn, each replacing the last"
        status: pass
      - kind: unit
        ref: "src/test/teamItemAssign.test.ts#blocking, holding, releasing, marking done, reopening and cancelling never change the assignee, and assignment never moves stateSince"
        status: pass
      - kind: unit
        ref: "src/test/teamItemAssign.test.ts#removing a member clears every card assigned to them in the same step and leaves the others alone"
        status: pass
    human_judgment: false
  - id: D5
    description: "No older log changes its state hash; STATE_HASH_VERSION stays 1"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamAssignHashes.test.ts (4 tests, hashes recorded at 64bbddd)"
        status: pass
      - kind: unit
        ref: "src/test/teamItemSnapshot.test.ts#the Phase 60 fixture keeps its recorded state hash and a Phase 60 snapshot still loads"
        status: pass
    human_judgment: false
  - id: D6
    description: "Snapshots carry assignees, equal the full replay, and refuse a non-member assignee; the seeded random snapshot test draws assignment events"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamItemSnapshot.test.ts#a state with three assignees serialises and deserialises to the same text and the same hash"
        status: pass
      - kind: unit
        ref: "src/test/teamItemSnapshot.test.ts#a snapshot whose assignee is not a member id, or names nobody on the roster, is refused as an invalid snapshot"
        status: pass
      - kind: unit
        ref: "src/test/teamItemSnapshot.test.ts#over seeded random logs with work items a snapshot at a random cut plus the tail equals the full replay, also through the signed file"
        status: pass
    human_judgment: false
  - id: D7
    description: "Card history names the person assigned or taken off, in log order, within the 50-entry cap"
    requirement: BOARD-02
    verification:
      - kind: unit
        ref: "src/test/teamItemAssign.test.ts#card history records who was assigned and who was taken off, in log order, within the 50-entry cap"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-11-04
---

# Phase 62 Plan 15: Assignment events (G-62-5, domain half) Summary

**Two signed work events, item.assigned { id, memberId } and item.unassigned { id }, limited to the owner and leads on write and read, stored as an optional WorkItem.assignee that removal clears, snapshots carry and card history names, with three older state hashes pinned unchanged.**

## Performance

- **Duration:** 20 min (measured from the plan start stamp to the last task commit)
- **Started:** 2026-11-04T00:11:19Z
- **Completed:** 2026-11-04T00:31:04Z
- **Tasks:** 3 (1 checkpoint auto-selected, 1 tracer, 1 auto TDD)
- **Files modified:** 12 (2 new test files, 6 domain files, 4 test files and helpers)

## Accomplishments

- A lead's assignment travels from one clone to another over real git and shows after one sync; a developer's own assignment is refused on write, and the same events forged into the remote are rejected by both clones with "not permitted: the developer role does not allow assigning items to others". Nothing changes.
- One state machine decides assignment for every caller: assignable kinds are plan, phase, bug, chore and spike; done or cancelled cards are refused; the person must be a current, confirmed member allowed to claim that kind (owner, lead or developer today); assigning the same person twice is refused; unassign needs an assignee and works in any state.
- Removal clears every card assigned to the removed member inside the same step that releases claims; blocking, holding, releasing, done, reopening and cancelling never touch the assignee, and assignment never moves stateSince.
- Three hashes recorded at 64bbddd before any source change (the Phase 60 fixture, the snapshot tests' item state, a seeded board) still match; STATE_HASH_VERSION is still 1.

## Task Commits

1. **Task 1: Confirm the event shape (checkpoint:decision, gate blocking)**: no commit. Auto mode selected `confirm-recorded` after the pre-change hashes were recorded (commit 95baaa9).
2. **Task 2: Tracer (tdd)**:
   - `95baaa9` test(62-15): pin three state hashes before the assignment events exist
   - `36950bd` test(62-15): add failing tracer for lead assignment across two clones (RED)
   - `7a6ba7d` feat(62-15): add the item.assigned and item.unassigned events (GREEN)
3. **Task 3: Rules, removal, snapshots, history (tdd)**:
   - `84f093b` test(62-15): add failing tests for assignment rules, removal, snapshots and history (RED)
   - `9840154` feat(62-15): clear assignments on removal, carry them in snapshots and card history (GREEN)

No REFACTOR commits were needed.

## TDD Gate Compliance

- **Task 2 RED** (`36950bd`): `node --test --test-reporter=tap dist/test/teamItemAssign.test.js dist/test/teamValidate.test.js`, exit 1, 24 tests, 21 pass, 3 fail. `gsd-tools check tdd-red-evidence` returned RED_EVIDENCE_OK (target_test_failed). Semantic assessment: the target tracer ran and failed on its first planned assertion (`assigned.ok` expected true, actual false, reason "not permitted"), because no client knew item.assigned yet. The other two failures were the planned validator assertions (type count 20 vs 22, and "unsupported event type" for the new bodies). No build, load or fixture fault.
- **Task 2 GREEN** (`7a6ba7d`): the plan's verify command passed, 193 tests, 193 pass, 0 fail. Tracer feedback gate (auto mode): verify re-run green, expansion continued.
- **Task 3 RED** (`84f093b`): `node --test --test-reporter=tap dist/test/teamItemAssign.test.js dist/test/teamItemSnapshot.test.js`, exit 1, 20 tests, 15 pass, 5 fail. RED_EVIDENCE_OK on the target "removing a member clears every card assigned to them...". Semantic assessment: it failed on the planned assertion (assignee still the removed developer, expected undefined). The other failures were also planned: history entries had no memberId, and the snapshot parser refused the unknown assignee key ("invalid snapshot: items[n][1]"). The rejection table, permission, replace and state-independence tests already passed, because Task 2 put those rules in place.
- **Task 3 GREEN** (`9840154`): the plan's verify command passed, 74 tests, 74 pass, 0 fail.

## Files Created/Modified

- `src/domain/team/types.ts`: both types in TEAM_EVENT_TYPES (57) and IMPLEMENTED_EVENT_TYPES (22), the two body interfaces, `WorkItem.assignee?`, and four reasons (itemNotAssignable, assigneeNotEligible, itemAlreadyAssigned, itemNotAssigned)
- `src/domain/team/validate.ts`: exact-key validators beside item.unblocked (item id rule, member id rule)
- `src/domain/team/permissions.ts`: actionForEvent maps both to `{ kind: 'item.assign' }`
- `src/domain/team/work.ts`: `transitionProblem(state: Pick<TeamState, 'items' | 'members' | 'team'>, ...)`, `mayBeAssigned`, `assignProblem`
- `src/domain/team/materialize.ts`: reference step and apply cases; releaseHeldWork clears assignees; parseWorkItem accepts assignee; checkAssignees in deserialiseState
- `src/domain/team/itemHistory.ts`: `HistoryEntry.memberId?` for both events, its own assignee map that follows removals
- `src/test/teamAssignHashes.test.ts` (new): the three pinned hashes and STATE_HASH_VERSION
- `src/test/teamItemAssign.test.ts` (new, 9 tests): the real-git tracer and forgery, plus 8 in-memory tests
- `src/test/teamValidate.test.ts`: one valid body per type, including the two new ones, and an exact-shape test
- `src/test/teamItemSnapshot.test.ts`: assignedWorld, round trip, snapshot plus tail, hostile assignees, random generator with assignments
- `src/test/teamItemEvents.test.ts`: frozen bodies 8 to 10 and the stored WorkItem key set now include the new events and key, with comments explaining why
- `src/test/helpers/teamEvents.ts`: `buildScenario` option `assignments` (off by default, so existing seeds draw the same numbers)

## Decisions Made

- **Task 1 checkpoint: `confirm-recorded` (auto-selected, auto mode).** The checkpoint has gate "blocking" and auto_select "confirm-recorded", so auto mode took that option after the pre-change hashes were recorded in 95baaa9. Bodies: item.assigned is exactly { id, memberId } and item.unassigned is exactly { id }. Permission: the item.assign row (owner and lead). Rules and the stored field are as recorded in the plan. No revision.
- The eligibility check calls `decideTeamAction(..., { kind: 'item.claim', itemKind })`, so who can be assigned follows the claim row. That makes `work.ts` import `permissions.ts`, which already imports `isOwnDraft` from `work.ts`. Both compiled modules export their functions before any require and only call each other at run time, so the cycle is safe in either load order. A comment at the import says so.
- The snapshot check goes further than the plan asked: besides the member id format, the assignee must name a member on the roster who is neither removed nor an unused invitation. No log can produce any other state, so a hostile snapshot cannot plant one. Role is not checked, because a role change does not clear an assignment.
- ItemHistory works out who an item.unassigned removed from its own record of accepted events (assigned, unassigned, member.removed). It does not read the state, so it stays a plain, state-free view (D-18).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated two frozen pins in teamItemEvents.test.ts**
- **Found during:** Task 2 (GREEN compile)
- **Issue:** `Required<WorkItem>` in "the stored WorkItem key set is frozen" no longer compiled once `assignee` existed. The frozen body list covers one example per item event type, so it was missing the two new types.
- **Fix:** Added `assignee` to the key-set literal and its sorted list. Added frozen canonical bodies for item.assigned and item.unassigned, so the expected count went from 8 to 10. Each change has a comment explaining why (owner rule: update and explain, never weaken). No assertion was loosened.
- **Files modified:** src/test/teamItemEvents.test.ts
- **Committed in:** 7a6ba7d

**2. [Rule 3 - Blocking] The random generator lives in helpers/teamEvents.ts, not in teamItemSnapshot.test.ts**
- **Found during:** Task 3
- **Issue:** The plan says to extend "the random snapshot generator in teamItemSnapshot.test.ts", but the generator is `buildScenario` in the shared helper.
- **Fix:** Added an opt-in `assignments` option. With it off, no extra random numbers are drawn, so every other seeded test (teamMaterialize, teamWork) draws exactly the same sequence as before. Only the snapshot test turns it on, and it asserts that the seeded logs really carry assignment events.
- **Files modified:** src/test/helpers/teamEvents.ts, src/test/teamItemSnapshot.test.ts
- **Committed in:** 84f093b

**Total deviations:** 2 auto-fixed (2 blocking). **Impact on plan:** both were needed to keep existing pins honest and to reach the generator. No scope creep, and no existing hash or assertion was weakened.

## Issues Encountered

- Free memory on the machine was low (2 to 6 GB available). Every run used the mandated systemd-run, choom and timeout wrapper. The broad team run used MemoryMax=6G with concurrency 2. Nothing hit a cap or a timeout.

## Verification

- Task 2 verify (`tsc` plus teamAssignHashes, teamItemAssign, teamValidate, teamItemEvents, teamPermissions): **193 tests, 193 pass, 0 fail**.
- Task 3 verify (`tsc` plus teamItemAssign, teamAssignHashes, teamItemSnapshot, teamItemForgery, teamMaterialize, teamWork): **74 tests, 74 pass, 0 fail**.
- Broader impacted run (`dist/test/team*.test.js` plus `boardDetail.test.js`, capped): **1111 tests, 1109 pass, 0 fail, 2 skipped**. The two skips are the existing live NEAR tests, which only run with NEAR_LIVE_TEAM=1.
- Acceptance checks:
  - `grep -c "'item.assigned'" src/domain/team/types.ts` = 3 (at least 2 required)
  - `STATE_HASH_VERSION = 1` is still at materialize.ts:587
  - `git diff --quiet a7fcba5 -- src/team/eventLog.ts src/domain/team/canonical.ts` exits 0
  - `grep -c "^test(" src/test/teamItemAssign.test.ts` = 9 (at least 8 required)
  - none of work.ts, materialize.ts or itemHistory.ts imports vscode (0 each), and no other file under src/domain/team does either
- The full repository suite and the e2e run were not part of this plan's verify. They run at the fix-pass gate.

## User Setup Required

None. No external service configuration is needed.

## Next Phase Readiness

- 62-19 (board model) and 62-20 (host and page) can build the Assign and Unassign actions on `transitionProblem` (the reasons map one to one) and on `actionForEvent` for permission. `WorkItem.assignee` drives the card chip and the member lane.
- `historySentence` in boardText.ts still uses its default "changed this." wording for the two new types. 62-19 or 62-20 should add sentences that use `HistoryEntry.memberId`.
- Phase 63 claims can read `assignee`. Nothing here touches `claimId` or the claim events.
- Compatibility: a client built before this change rejects both types as unsupported, so everyone on a team has to update together. That is the case for this preview.

## Self-Check: PASSED

- FOUND: src/test/teamAssignHashes.test.ts, src/test/teamItemAssign.test.ts
- FOUND commits: 95baaa9, 36950bd, 7a6ba7d, 84f093b, 9840154 (all ancestors of HEAD)

---
*Phase: 62-work-model-gsd-import-team-board-live-read-and-move*
*Completed: 2026-11-04*
