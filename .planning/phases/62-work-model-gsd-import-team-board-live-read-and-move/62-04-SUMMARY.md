---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 04
subsystem: team-core
tags: [team-mode, work-items, computed-ready, snapshots, item-history, forgery]

requires:
  - phase: 62-work-model-gsd-import-team-board-live-read-and-move
    provides: eight item events, WorkItem stored shape, transitionProblem (plan 62-01)
provides:
  - readiness, effectiveColumn, BOARD_COLUMNS, isCard, progressOf, countReady in work.ts (pure, no clock)
  - ItemHistory, a bounded (50 per item) in-memory card history outside TeamState and the state hash
  - deserialiseState rebuilds items through a strict parseWorkItem, so snapshots with items load
  - buildScenario(seed, length, { items: true }) mixing item events with roster events
  - validate.ts exports the item field validators (shared by events and snapshots)
affects: [62-05, 62-06, 62-07, 62-08, 62-09, 62-10, 62-11, 62-12, 62-13, 62-14, 63, 64, 65]

actuals:
  tokens: 22000
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Board facts are derived from the item map alone by pure functions; the per-call plan-by-phase index keeps a whole-board scan linear"
    - "Snapshot items are held to the event validators' own limits by sharing the validator functions, so the two cannot drift"
    - "Card history is plain entries fed from verdict-bearing CommittedEvent arrays and never touches TeamState"

key-files:
  created:
    - src/domain/team/itemHistory.ts
    - src/test/teamWork.test.ts
    - src/test/teamItemSnapshot.test.ts
    - src/test/teamItemForgery.test.ts
  modified:
    - src/domain/team/work.ts
    - src/domain/team/materialize.ts
    - src/domain/team/validate.ts
    - src/test/helpers/teamEvents.ts

key-decisions:
  - "A phase with no live (non-cancelled) plan counts as complete only when it is itself stored done, so an unplanned phase never releases the phases that wait on it"
  - "readiness for an id that is not on the board, or is not a card, is not ready with no reasons"
  - "A dependsOn entry on a card or a phase that names a phase uses the phase-complete rule; any other entry must be stored done"
  - "Snapshot items do not accept claimId or ringFenceNanoUsd yet: nothing in this phase stores them and claims must stay empty, so a later claim phase widens parser and writer together"
  - "ItemHistory.record skips an event id it already holds, so showing the same entries again adds nothing, and clear() lets the board rebuild after a full re-read"

patterns-established:
  - "Hostile-snapshot table: one tampered field per row, each run directly through deserialiseState and inside a validly signed snapshot file"
  - "Seeded item scenarios check each candidate event on a copy of the live state and skip it when the rules would refuse it, so no draw is forged by accident"

requirements-completed: []
requirements-advanced: [BOARD-01, BOARD-02, BOARD-03]

coverage:
  - id: D1
    description: "Two real clones derive the same ready column, readiness reasons, ready count and lane progress as a dependency is marked done"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "dist/test/teamWork.test.js#two clones derive the same ready column and the same ready count as a dependency is marked done"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every not-ready reason alone and combined (sorted, no duplicates), columns for settled and claimed items, cards versus graph nodes, and progress by estimate tokens with count fallback and no overflow"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/teamWork.test.js#each reason is produced alone"
        status: pass
      - kind: unit
        ref: "dist/test/teamWork.test.js#reasons combine, are sorted and carry no duplicates"
        status: pass
      - kind: unit
        ref: "dist/test/teamWork.test.js#progress cannot overflow on very large estimates"
        status: pass
    human_judgment: false
  - id: D3
    description: "A snapshot of a state with items round trips to the same text and hash, a signed snapshot file loads, 45 hostile item shapes are refused as invalid snapshot items, and a snapshot at a random cut plus the tail equals the full replay"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "dist/test/teamItemSnapshot.test.js#a state with items serialises and deserialises to the same text and the same hash"
        status: pass
      - kind: unit
        ref: "dist/test/teamItemSnapshot.test.js#each malformed item is refused as an invalid snapshot, directly and inside a validly signed snapshot file"
        status: pass
      - kind: unit
        ref: "dist/test/teamItemSnapshot.test.js#over seeded random logs with work items a snapshot at a random cut plus the tail equals the full replay, also through the signed file"
        status: pass
    human_judgment: false
  - id: D4
    description: "Card history keeps at most 50 accepted item events per item, newest first, with reason or changed keys, outside the state hash"
    requirement: BOARD-02
    verification:
      - kind: unit
        ref: "dist/test/teamWork.test.js#history holds at most 50 entries per item, keeps the newest, and recording the same entries again adds nothing"
        status: pass
      - kind: unit
        ref: "dist/test/teamWork.test.js#history is not part of the state: it holds plain entries, never the state or its items"
        status: pass
    human_judgment: false
  - id: D5
    description: "Over 20 seeded logs mixing roster and item events, any commit batching gives the same state hash and readiness for every item; roster-only seeds keep their pinned sequence and the Phase 60 fixture hash is unchanged"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/teamWork.test.js#over 20 seeded logs that mix roster and item events, any commit batching gives the same state hash and the same readiness for every item"
        status: pass
      - kind: unit
        ref: "dist/test/teamWork.test.js#roster-only seeded scenarios keep their pinned event sequence now that item events exist"
        status: pass
      - kind: unit
        ref: "dist/test/teamItemSnapshot.test.js#the Phase 60 fixture keeps its recorded state hash and a Phase 60 snapshot still loads"
        status: pass
    human_judgment: false
  - id: D6
    description: "Eight forged item events pushed straight to the coordination branch are rejected with their reasons on both clones, change no state, and do not block the next honest event"
    requirement: BOARD-03
    verification:
      - kind: integration
        ref: "dist/test/teamItemForgery.test.js#forged item events written straight to the coordination branch are rejected with their reasons on both clones and change no state"
        status: pass
    human_judgment: false

duration: 35min
completed: 2026-11-02
status: complete
plan_head_before: 3d3867d0c1274bbc1eec5897cd1c0245cc7c6852
plan_head_after: 0c479b895815e796439990269292f8724846c3ce
commits: 5
---

# Phase 62 Plan 04: Computed ready, snapshots with items, card history Summary

**Pure derived board facts (ready reasons, columns, BigInt-exact lane progress, ready count), snapshots that carry items through a strict parseWorkItem, a bounded outside-the-hash ItemHistory, and a two-clone forgery suite for item events.**

## Performance

- **Duration:** about 35 min
- **Completed:** 2026-11-02T18:36:00Z
- **Tasks:** 3 (1 tracer, 2 TDD)
- **Files modified:** 8 (4 new, 4 modified; 1166 lines added, 20 removed)

## Accomplishments

- `readiness` lists sorted, de-duplicated reasons (not-unclaimed, held, blocked, no-estimate, no-scope, dependency-open, dependency-missing, phase-held, phase-dependency-open); a dependency absent from the board blocks with `dependency-missing`. `effectiveColumn` never returns blocked, shows a held or otherwise not-ready stored `ready` item in backlog, and `countReady` is the status-bar N.
- The tracer shows two real clones deriving the same board: `plan:90-02` stays in backlog with `[dependency-open]` until the owner marks `plan:90-01` done, then both clones show it ready, count 1, phase and milestone progress 75 percent.
- `progressOf` weights by estimate tokens, falls back to plan counts when no live plan has an estimate, floors the percent, leaves cancelled plans out of both sides and uses BigInt so 200 plans of a trillion tokens cannot overflow.
- Snapshots carry items: `deserialiseState` replaces `emptyList(root.items)` with `parseWorkItem` (exact keys, the event validators' own limits through shared validator exports, kind and id coherence, origin rules, a parent that exists with the right kind). A 45-row hostile table is refused as `invalid snapshot: items...`, directly and inside a validly signed snapshot file; claims, leases, allocations and the queue stay required empty.
- `ItemHistory` keeps the 50 newest accepted item events per item (type, event id, author, display-only `at`, reason or changed keys), newest first, outside `TeamState`, snapshots and the hash.
- `buildScenario` gained an `items` option; 20 seeds replayed under three commit batchings give identical hashes, readiness for every item and ready counts; roster-only seeds keep their pinned sequence.
- Eight raw-pushed forgeries (developer hold, observer create, duplicate id, missing parent, reopen of a backlog item, revoked device, bad signature, unknown key) are rejected with the expected reasons on both clones and leave the board byte-identical.

## Task Commits

1. **Task 1 (tracer): two clones derive the same ready column**
   - RED `69c00e5` (test), GREEN `57dc929` (feat)
2. **Task 2: snapshots carry items, history outside the hash, seeded determinism**
   - RED `c774ab3` (test), GREEN `95127b7` (feat)
3. **Task 3: forged item events on two clones** - `0c479b8` (test)

**Plan metadata:** the docs commit that adds this file (docs: complete plan)

## Files Created/Modified

- `src/domain/team/work.ts` - board model: BOARD_COLUMNS, isCard, readiness, effectiveColumn, progressOf, countReady
- `src/domain/team/itemHistory.ts` - ItemHistory, HistoryEntry, MAX_HISTORY_PER_ITEM
- `src/domain/team/materialize.ts` - parseWorkItem, parseItems; deserialiseState rebuilds items
- `src/domain/team/validate.ts` - item field validators and TITLE_MAX, REASON_MAX exported
- `src/test/helpers/teamEvents.ts` - buildScenario items option
- `src/test/teamWork.test.ts`, `teamItemSnapshot.test.ts`, `teamItemForgery.test.ts` - new suites

## Decisions Made

See `key-decisions` above. The two that shape later plans: an unplanned phase never counts as complete for the phases that depend on it, and the snapshot parser deliberately refuses `claimId` and `ringFenceNanoUsd` until a claim phase stores them.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Item field validators had to be exported from validate.ts**
- **Found during:** Task 2
- **Issue:** The plan lists materialize.ts and itemHistory.ts for the snapshot parser, but the "same limits as the 62-01 validators" requirement is only met without drift if the parser calls the validators themselves; they were module-private.
- **Fix:** Added `export` to `validateText`, `validateDescription`, `validateScope`, `validateRequirements`, `validateMustHaves`, `validateDependencies`, `validateItemTags`, `validateEstimate`, `validateGsdRef`, `validateSource`, `TITLE_MAX` and `REASON_MAX`. No behaviour change.
- **Files modified:** src/domain/team/validate.ts
- **Committed in:** 95127b7

**2. [Rule 1 - Bug] A test counted the wrong number of items**
- **Found during:** Task 2 RED evidence capture
- **Issue:** My snapshot round-trip test asserted 11 items where the fixture builds 9, so the target test would have failed for the wrong reason.
- **Fix:** Corrected the count before capturing RED evidence.
- **Files modified:** src/test/teamItemSnapshot.test.ts
- **Committed in:** c774ab3

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug in my own test before commit)
**Impact on plan:** None on scope. No assertion was loosened.

## TDD Gate Compliance

- **Task 1 RED (`69c00e5`):** stub exports made the tracer and 12 table tests fail on their assertions. `gsd_run check tdd-red-evidence` returned `RED_EVIDENCE_OK` (`target_test_failed`). Semantic assessment: the target ran to the planned ready-column assertion against stubs; no build, load or fixture fault.
- **Task 2 RED (`c774ab3`):** the target `a state with items serialises and deserialises to the same text and the same hash` failed inside `deserialiseState` at `emptyList(root.items)` (`invalid snapshot: items`), classified `RED_EVIDENCE_OK` on the filtered run of the target (the whole-file TAP report was flagged "Non-TAP data" by the classifier because of an error value it prints, so the target was re-run on its own for the record). ItemHistory stubs also failed on assertions. Semantic assessment: planned reason, no build or fixture fault.
- **Task 2 note:** the seeded determinism and hostile-table tests passed before GREEN (the existing replay already satisfies determinism, and any item in a snapshot was refused by the old parser). They are kept as regression guards; the hostile table was checked by hand after GREEN to confirm each row is refused at its intended field.
- **Task 3:** no RED commit. The behaviour under test (reasons, permissions, the reader) shipped in 62-01 and the transport, so this is a characterization suite written after the fact; it passed on first run and its exact reasons were printed and confirmed.

## Issues Encountered

None.

## Known Stubs

None. The RED-phase stubs in `work.ts` and `itemHistory.ts` were replaced in the GREEN commits.

## Threat Flags

None. No new network endpoint, auth path or file access; the snapshot parser narrows an existing trust boundary (T-62-11) and the history is in-memory only (T-62-13).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plans 05 onward can read ready, columns, progress and the ready count from `work.ts`, feed `ItemHistory.record` with the `CommittedEvent` arrays the session already holds, and rely on snapshots carrying items.
- The board adapter owns the `ItemHistory` instance and should `clear()` it before a full re-read.
- Verification run: `npm run lint` and `node --test dist/test/team*.test.js` pass (807 tests, 805 pass, 2 skipped as before, 0 fail).

## Self-Check: PASSED

- Files exist: src/domain/team/itemHistory.ts, src/test/teamWork.test.ts, src/test/teamItemSnapshot.test.ts, src/test/teamItemForgery.test.ts
- Commits exist: 69c00e5, 57dc929, c774ab3, 95127b7, 0c479b8

---
*Phase: 62-work-model-gsd-import-team-board-live-read-and-move*
*Completed: 2026-11-02*
