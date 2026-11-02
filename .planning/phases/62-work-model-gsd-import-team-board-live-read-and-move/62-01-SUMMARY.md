---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 01
subsystem: team-core
tags: [team-mode, signed-event-log, work-items, permissions, state-machine]

requires:
  - phase: 60-team-core-identity-signed-event-log-git-transport-roster
    provides: signed log, materialiser pipeline, decideTeamAction, TeamLog/prepareEvents, CAS transport
  - phase: 61-invitations-joining-removal-near-org-and-key-integration
    provides: roster with joined members, releaseHeldWork (stored ready), session wiring
provides:
  - eight implemented item event types (item.imported, created, updated, estimated, blocked, unblocked, cancelled, reopened) with exact-key bodies
  - WorkItem stored shape (origin, stateSince, createdBy, description, hold, summary, active, source)
  - work.ts with item id patterns, scope rule, isOwnDraft and transitionProblem (one decision for write and read)
  - item.move permission row (owner and lead) and actionForEvent(event, state)
  - eight item rejection reasons in TEAM_REJECTION_REASONS
affects: [62-02, 62-03, 62-04, 62-05, 62-06, 62-07, 62-08, 62-09, 62-10, 62-11, 62-12, 62-13, 62-14, 63, 65]

actuals:
  tokens: 20303
  tasks: 3
  commits: 4

tech-stack:
  added: []
  patterns:
    - "One pure transitionProblem called from referenceProblem on read; the write side reaches it through the transport's checkCandidate replay"
    - "Stored optional keys are assigned only when present and false booleans are stored as an absent key, so logs without items hash as before"
    - "Move and permission tables as data, every row run through applyEntry and through prepareEvents plus checkCandidate"

key-files:
  created:
    - src/domain/team/work.ts
    - src/test/teamItemEvents.test.ts
  modified:
    - src/domain/team/types.ts
    - src/domain/team/validate.ts
    - src/domain/team/permissions.ts
    - src/domain/team/materialize.ts
    - src/team/eventLog.ts
    - src/test/teamValidate.test.ts
    - src/test/teamPermissions.test.ts
    - src/test/teamSession.test.ts
    - src/test/teamMaterialize.test.ts
    - src/test/teamRelease.test.ts

key-decisions:
  - "Task 1 decision confirm-recorded: bodies, stored shape, item.move row and transition rules exactly as recorded in the plan"
  - "The schema layer judges only the shape of parentId; whether the parent exists and has the kind above it is itemParent at the reference step"
  - "Marking a held item done also ends its hold, since a finished item waits for nothing"
  - "A blocked item may be held, and a phase may be held (a held phase is a frozen phase) although phases never move through the other states"

patterns-established:
  - "Item events are validated in validate.ts with shared field validators (title, description, scope, requirements, mustHaves, dependsOn, tags, estimate, gsd, reason, source)"
  - "Permission for a developer's edit or estimate is decided from the stored item (origin board, createdBy, unclaimed) against the pre-batch state"

requirements-completed: []
requirements-advanced: [BOARD-01, BOARD-03]

coverage:
  - id: D1
    description: "The eight item events are implemented with exact-key bodies and join the implemented types (12 to 20)"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/teamValidate.test.js#valid bodies for every implemented type pass, with and without optional fields"
        status: pass
      - kind: unit
        ref: "dist/test/teamItemEvents.test.js#the canonical body of one recorded example per item event type is frozen"
        status: pass
    human_judgment: false
  - id: D2
    description: "An item created and blocked by the owner on clone A over real git is materialised identically on clone B"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "dist/test/teamItemEvents.test.js#the owner creates and blocks a board item on clone A over real git and clone B materialises exactly the same item"
        status: pass
    human_judgment: false
  - id: D3
    description: "Only owner and leads import and move items; a developer creates items and edits or estimates only their own unclaimed board item; decided the same on write and read"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "dist/test/teamItemEvents.test.js#permission: * (14 rows x 6 roles)"
        status: pass
      - kind: unit
        ref: "dist/test/teamPermissions.test.js#actionForEvent maps the item events"
        status: pass
    human_judgment: false
  - id: D4
    description: "Every move is checked against stored state on write and read with one fixed reason; no event can enter claimed, in-progress, in-review or integrating"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "dist/test/teamItemEvents.test.js#move: * (70 rows) and no item event can store a claim or integration state"
        status: pass
    human_judgment: false
  - id: D5
    description: "A log with no item events keeps its Phase 60 serialised state and state hash"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/teamItemEvents.test.js#a log with no item events keeps the Phase 60 serialised state and state hash"
        status: pass
    human_judgment: false

duration: 13min
completed: 2026-11-02
status: complete
plan_head_before: dea19c2b74b662350e53bb469d61fda24111dd10
plan_head_after: 3a7cc6dac92d40158618e158b1a4919b22a70e64
commits: 4
---

# Phase 62 Plan 01: Work items in the signed log Summary

**Eight signed item events (import, create, update, estimate, block, unblock, cancel, reopen) with exact-key bodies, a stored WorkItem shape, an item.move permission row, and one transitionProblem that decides every move identically on write and read, proven by a two-clone round trip over real git.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-11-02T17:51:16Z
- **Completed:** 2026-11-02T18:05:00Z
- **Tasks:** 3 (1 decision checkpoint auto-selected, 1 tracer, 1 table task)
- **Files modified:** 12 source and test files (1081 lines added, 17 removed)

## Accomplishments

- The owner creates and blocks a board item on clone A over real git and clone B materialises the same item: `serialiseState` is byte-identical, `blocked.since` is the block event's time and `stateSince` stays at the create event's time.
- `IMPLEMENTED_EVENT_TYPES` grows from 12 to 20; ids follow D-04 (`milestone:`, `phase:`, `plan:`, `task:` from GSD, `item:<ulid>` for the board) and a prefix that disagrees with the kind is rejected.
- Permission: `item.move` is one new matrix row for owner and lead; `actionForEvent(event, state)` computes own-draft from the stored item, and `prepareEvents` passes the pre-batch state so the writer and the reader answer the same question.
- State machine: `transitionProblem` in `work.ts` is called from `referenceProblem`; 70 move rows and a 14 by 6 permission table confirm the reader and the writer (prepareEvents, then the transport's `checkCandidate`) give the same reason.
- No event written in this phase can put an item into claimed, in-progress, in-review or integrating; the validators refuse to name those states and a table test checks every accepted row.
- Phase 60 and 61 logs are unchanged: a log with no item events keeps the pinned state hash `e41fe7cb...` and serialises `"items":[]`.

## Task Commits

1. **Task 1: Confirm item event bodies, stored shape and move rules** - decision checkpoint, auto-selected `confirm-recorded` (no commit)
2. **Task 2: Tracer (two clones over real git)**
   - RED `0f67102` (test): failing tracer, validation, permission and pin tests
   - GREEN `6f9b9cf` (feat): types, work.ts, validators, permissions, materialiser, eventLog
3. **Task 3: Full move and permission table, frozen pins**
   - RED `42d7414` (test): tables and pins; the wrong-kind parent rows fail until the fix
   - GREEN `3a7cc6d` (fix): parent kind left to the reference step

**Plan metadata:** the docs commit that adds this file (docs: complete plan)

## Files Created/Modified

- `src/domain/team/work.ts` - id patterns, `itemKindOf`, `isScopePattern`, `isUnclaimed`, `isOwnDraft`, `transitionProblem`
- `src/domain/team/types.ts` - item body types, `WorkItem` fields, 20 implemented types, eight reasons
- `src/domain/team/validate.ts` - eight exact-key body validators with shared field validators
- `src/domain/team/permissions.ts` - `item.move` row and label, `actionForEvent(event, state?)`
- `src/domain/team/materialize.ts` - item reference checks and transitions
- `src/team/eventLog.ts` - `prepareEvents` passes the pre-batch state to `actionForEvent`
- `src/test/teamItemEvents.test.ts` - tracer, tables, validator checks, frozen pins (103 tests)
- `src/test/teamValidate.test.ts`, `teamPermissions.test.ts`, `teamSession.test.ts`, `teamMaterialize.test.ts`, `teamRelease.test.ts` - deliberate pin updates

## Decisions Made

- **Task 1 (auto-selected):** `confirm-recorded`. The permanent bodies, the stored `WorkItem` key set, the `item.move` row ("moving items", owner and lead) and the transition rules are as recorded in the plan, with no revisions. Logged as `Auto-selected: confirm-recorded` (checkpoint `gate="blocking"`, auto mode active).
- Where the plan was silent, these small rules were fixed and are pinned by the tables: a mark done also clears a hold; a blocked item may be held or cancelled; a phase may be held, cancelled and reopened, but only plans and board items are marked done or blocked; cancelling or reopening an item ends its block and hold.
- Reason texts are the plan's; `itemBlocked` ("item is blocked") serves both "mark done while blocked" and "block an already blocked item".

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] A fourth test used `item.created` as the "unsupported type" stand-in**
- **Found during:** Task 2 (searching for pins before changing the implemented set)
- **Issue:** `src/test/teamMaterialize.test.ts:447` built a "future event" by retyping an event as `item.created`; once `item.created` is implemented that event is a bad body, not an unsupported type. The plan listed only teamValidate and teamSession.
- **Fix:** Switched it to `claim.taken` in the RED commit, the same deliberate move as the listed pins.
- **Files modified:** src/test/teamMaterialize.test.ts
- **Committed in:** 0f67102

**2. [Rule 3 - Blocking] `WorkItem` gained required keys, breaking a test fixture**
- **Found during:** Task 2
- **Issue:** `teamRelease.test.ts` builds `WorkItem` literals without `origin` and `stateSince`.
- **Fix:** Added `origin: 'import'` and a fixed `stateSince` to the helper.
- **Files modified:** src/test/teamRelease.test.ts
- **Committed in:** 6f9b9cf

**3. [Rule 1 - Bug] The schema rejected a wrong-kind parent instead of the reference step answering `itemParent`**
- **Found during:** Task 3 (the table's wrong-parent rows)
- **Issue:** Task 3 requires an `item.imported` with a parent of the wrong kind to give `itemParent`; the Task 2 validator checked the parent's id prefix, so it answered `invalid event body: body.parentId`. The shape question (a valid imported id, absent for a milestone) belongs to the schema; the existence and kind question belongs to the log state.
- **Fix:** `validateParent` now checks shape only; `transitionProblem` answers `itemParent` for a missing parent or one of the wrong kind.
- **Files modified:** src/domain/team/validate.ts
- **Verification:** teamItemEvents 103 of 103 pass; team suite 754 pass, 0 fail, 2 skipped (unchanged)
- **Committed in:** 3a7cc6d

---

**Total deviations:** 3 auto-fixed (1 bug, 2 blocking)
**Impact on plan:** All three were needed to keep the suite honest; no scope change and no loosened assertion.

## TDD Gate Compliance

- **RED (Task 2):** tracer `the owner creates and blocks a board item on clone A over real git and clone B materialises exactly the same item` failed on `assert.equal(created.ok, true)` (the append was refused: `unsupported event type for this version`). `gsd_run check tdd-red-evidence` returned `RED_EVIDENCE_OK` (`target_test_failed`). Semantic assessment: the target ran to its first assertion and failed for the planned reason (item.created not implemented), not through a build, load or fixture fault. The test file also carried type errors against the not-yet-extended types; `tsc` still emitted, so the run reached the assertion.
- **GREEN (Task 2):** `6f9b9cf`, all 164 tests in the six named files pass, then the full `team*` suite.
- **RED (Task 3):** `42d7414`; three tests failed on the planned `itemParent` expectation (`RED_EVIDENCE_OK`, target `move: import a plan under a milestone`). The other 100 rows passed on arrival because Task 2 had already implemented every rule; the table is a characterisation of those rules. A mutation check (removing the blocked check from mark done) was caught by exactly the `mark done while blocked` row, then reverted.
- **GREEN (Task 3):** `3a7cc6d`.
- No REFACTOR commit was needed.

## Issues Encountered

- The file-writing tool turned ` ` and ` ` in a regular expression into literal separator characters, which broke the TypeScript parse; they were restored to escape sequences before the first compile.
- `checkKeys`-based "wrong type" generic tests in teamValidate require the valid body map to hold only keys that are required or implied required (for example `parentId` on a plan); the 20-entry map was written to respect that.

## Known Stubs

None.

## Threat Flags

None. The threat register's mitigations (T-62-01 to T-62-04) are implemented: item.move and own-draft are checked on write and read, transitions are checked at the reference step, bodies are exact-key with caps, and `prepareEvents` still calls `assertNoSecrets` before signing. No package was installed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Ready for the importer and the board: `item.imported`, the stored shape and the permission and move rules are in place; later plans read the shapes confirmed in Task 1.
- **For plan 62-04:** `deserialiseState` still contains `emptyList(root.items, 'items')`, so a snapshot of a state that has items does not load (snapshots are provisional and the client replays from genesis, but the round trip is the documented guarantee). 62-04 owns `parseWorkItem`; its limits should match these validators (title 200, must-have 600, description 2000, list caps) and the stored key set pinned in `teamItemEvents.test.ts`.
- **For the importer (62-0x):** each item event must fit 16 KB; `item.created` carries the estimate so a developer's single-event creation is complete (`prepareEvents` checks permission against the pre-batch state, so a same-batch create then edit by a developer is refused on write).
- BOARD-01 and BOARD-03 are advanced, not complete: they are ticked only by plan 62-14.

---
*Phase: 62-work-model-gsd-import-team-board-live-read-and-move*
*Completed: 2026-11-02*

## Self-Check: PASSED

- Created and modified files exist on disk (work.ts, teamItemEvents.test.ts and the six modified source files).
- Commits found on this branch: 0f67102, 6f9b9cf, 42d7414, 3a7cc6d.
- `gsd_run check evaluation-scope --plan 62-01 --commits-only` resolves with the plan's commits.
- Acceptance greps (ItemImportedBody, 'item.move', `kinds.length, 29`, claim.taken in both files, `actionForEvent(candidate, state)`, `export function transitionProblem`, `TEAM_REJECTION_REASONS.itemTerminal`, `.itemBlocked`, `checkCandidate`) all match.
- `npm run lint` exits 0; `node --test dist/test/team*.test.js`: 756 tests, 754 pass, 0 fail, 2 skipped.
