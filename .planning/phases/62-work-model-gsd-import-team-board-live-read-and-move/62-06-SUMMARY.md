---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 06
subsystem: team-board-model
tags: [team-mode, board, kanban, planMove, permissions, accessibility, pure-domain]

requires:
  - phase: 62-work-model-gsd-import-team-board-live-read-and-move
    provides: transitionProblem, readiness, effectiveColumn, progressOf, isCard (62-01, 62-04); ItemHistory and HistoryEntry (62-04)
provides:
  - planMove, availableMoves, columnMove in board.ts: the one pure decision behind the menu, the drop targets and the write path
  - buildBoardModel: plain-JSON board (eight columns, cards, four lane groupings, milestones, facets, viewer facts)
  - buildCardDetail: card detail with dependencies, task checklist, not-ready sentences, editing rights and history sentences
  - boardText.ts: every authored board string, the formatters and the accessible card name
  - teamBoardWorld.ts test helper: an in-memory signed team with every role
affects: [62-07, 62-08, 62-09, 62-10, 62-11, 62-12, 62-13, 62-14, 63, 64]

actuals:
  tokens: 27400
  tasks: 3
  commits: 7

tech-stack:
  added: []
  patterns:
    - "One planner decides a move: availableMoves is the moves whose planMove succeeds, columnMove maps a drop target to a planMove key or a refusal, and the host re-runs planMove on fresh state inside the append"
    - "The 62-01 state machine is asked on a synthetic envelope (transitionProblem reads only type and body), so the board and the log can never disagree"
    - "Teammate text is flattened to one bounded line (flattenName) before it reaches the model; the model is JSON-safe with no undefined values"
    - "Hold direction is inferred for history rows from the log's guarantees (holds alternate, creation and cancel/reopen/done end a hold) because HistoryEntry does not store it"

key-files:
  created:
    - src/domain/team/board.ts
    - src/domain/team/boardText.ts
    - src/test/teamBoardModel.test.ts
    - src/test/teamBoardMoves.test.ts
    - src/test/helpers/teamBoardWorld.ts
  modified: []

key-decisions:
  - "Hold is offered and accepted only for a card showing in Ready (UI-SPEC 'Backlog (put on hold) from Ready'), although the log would accept a hold on any unclaimed card; the board is deliberately narrower than the log"
  - "Counts (columns, lanes, counts) describe the default milestone selection; cards of every milestone are in the model with milestoneId so the client can switch milestone and recompute with no host round trip, and board items belong to every selection"
  - "Phase and milestone lane keys are the item ids ('phase:90'); the board-item lane key is 'board'; member lane is 'unassigned' and the none lane is 'all'; phase facets carry milestoneId so the client can filter them"
  - "In Done and Cancelled plans run newest number first and board items follow, newest first; elsewhere plans ascend and board items follow in log order"
  - "A viewer with no device key, or a removed member, gets a distinct read-only reason; a reason supplied by the host (offline, paused) wins when canWrite is false"
  - "Release is offered for a held card even when other reasons keep it out of Ready; dropping such a card on Ready names every reason instead"

patterns-established:
  - "Move table as data: nine card states by seven viewer kinds by seven moves, with the exact refusal sentence per cell, asserted against code that never computes expectations"
  - "A signed in-memory team (real Ed25519 owner, roster members placed in the state) for model tests that need the real materialiser without git"

requirements-completed: []
requirements-advanced: [BOARD-01, BOARD-02, BOARD-03]

coverage:
  - id: D1
    description: "A board model built from real signed events: eight columns in order with captions, the ready card's moves and refusal copy, a hold planned with planMove and applied, and the card moving from Ready to Backlog"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "dist/test/teamBoardModel.test.js#tracer: a model from real events, a hold planned with planMove and applied, and the card moving from Ready to Backlog"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every move for nine card states and seven viewer kinds is offered or refused from a data table, the menu equals the moves that succeed, and every allowed intent is accepted by the materialiser for the owner and a lead"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "dist/test/teamBoardMoves.test.js#planMove answers every move for every state and viewer from the table, and availableMoves lists exactly the moves that succeed"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardMoves.test.js#every intent planMove builds for an allowed move is accepted by the materialiser for the owner and for a lead"
        status: pass
    human_judgment: false
  - id: D3
    description: "Drop targets map to a move, to nothing, or to the exact UI-SPEC sentence (claim columns, not-ready wording, reopen sentence, blocked to Done), and each card's refusals map equals the table"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "dist/test/teamBoardMoves.test.js#every drop target maps to a move, to nothing, or to the exact sentence the board shows"
        status: pass
      - kind: unit
        ref: "dist/test/teamBoardMoves.test.js#the card carries the same answers: a refusal for every column it may not enter, and none for the ones it may"
        status: pass
    human_judgment: false
  - id: D4
    description: "Block and cancel reasons are flattened, limited to 200 characters and refused when empty or secret-like; a cancel reports its dependents; the stale refusal names the teammate"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "dist/test/teamBoardMoves.test.js#a block or cancel reason is trimmed into the intent, flattened to one line, and refused when empty, too long or secret-like"
        status: pass
      - kind: unit
        ref: "dist/test/teamBoardMoves.test.js#each move says what kind of prompt follows, and a cancel reports how many unfinished plans wait for the card"
        status: pass
    human_judgment: false
  - id: D5
    description: "Lanes by member, phase, milestone and none with weighted progress and collapsed empty phases; milestone list; phase and requirement facets; deterministic numeric card order"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/teamBoardModel.test.js#lanes: member gives one Unassigned lane, phase and milestone lanes carry weighted progress, and an empty phase starts collapsed"
        status: pass
      - kind: unit
        ref: "dist/test/teamBoardModel.test.js#cards sort by phase then plan number in each column (numerically), board items after plans, and the reverse in Done and Cancelled"
        status: pass
    human_judgment: false
  - id: D6
    description: "Card face and accessible name, hostile names flattened to one bounded line, plain-JSON model, viewer permissions and read-only reasons"
    requirement: BOARD-02
    verification:
      - kind: unit
        ref: "dist/test/teamBoardModel.test.js#the card face: display ids, estimate and age text, flags, dependency count and the accessible name"
        status: pass
      - kind: unit
        ref: "dist/test/teamBoardModel.test.js#a name or reason with a newline and 200 characters becomes one bounded line wherever it appears in the model"
        status: pass
      - kind: unit
        ref: "dist/test/teamBoardModel.test.js#viewer facts: what each role may do and the banner that says why not"
        status: pass
    human_judgment: false
  - id: D7
    description: "Card detail: must-haves, dependencies with state, task checklist, not-ready reasons, editing rights, history sentences newest first and capped at 50"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/teamBoardModel.test.js#card detail for a plan: must-haves, requirements, dependencies with their state, files, tasks, facts and the reasons it is not ready"
        status: pass
      - kind: unit
        ref: "dist/test/teamBoardModel.test.js#history stops at the latest 50 changes and says so"
        status: pass
    human_judgment: false
  - id: D8
    description: "No authored string and no string in any model or detail contains an em-dash or en-dash"
    verification:
      - kind: unit
        ref: "dist/test/teamBoardModel.test.js#no authored string and no string in a model or detail contains an em-dash or an en-dash"
        status: pass
    human_judgment: false

duration: about 70min
completed: 2026-11-02
status: complete
plan_head_before: ab47b3ba41226e9872ab88f8d39c945b4759aae5
plan_head_after: 9e9957e3c8a3b661e00b9d898e32fa465da87783
commits: 7
---

# Phase 62 Plan 06: Board model, move planner and card detail Summary

**A pure Team Board: planMove decides every move once (permission, 62-01 state machine, reason rules) and feeds the menu, the drop targets and the write path, while buildBoardModel and buildCardDetail turn the log into plain JSON with lanes, facets, card faces, accessible names and history sentences.**

## Performance

- **Duration:** about 70 min
- **Completed:** 2026-11-02T19:20:00Z
- **Tasks:** 3 (1 tracer, 2 TDD)
- **Files:** 5 new (2 domain, 2 test suites, 1 test helper), 1652 lines added

## Accomplishments

- `planMove(state, viewerId, itemId, move, input)` asks `decideTeamAction('item.move')` first (no viewer is the read-only no-device-key text, a removed member gets the removal text, developers, reviewers and observers get "Only the team owner or a lead can move cards. Nothing was moved."), then the 62-01 `transitionProblem` on a synthetic envelope, then the board rules (hold only from Ready, reasons for block and cancel). Refusals are in board words and all end "Nothing was moved."
- `availableMoves` is exactly the moves whose plan succeeds, in menu order (done, cancel, hold, release, reopen, block, unblock); cancel also reports `dependents`, the unfinished plans waiting for the card, for the host's second confirmation.
- `columnMove` maps a drop target to a move key, to nothing (own column), or to the exact UI-SPEC sentence: the four claim and integration columns, the reopen-only sentence for Done and Cancelled, a not-ready list built from readiness reasons ("it has no estimate, it lists no files"), a lone hold becoming a release, and a blocked card dropped on Done naming "Unblock it first".
- `buildBoardModel` returns eight columns with captions, cards (plans and board items only), lanes by member, phase, milestone and none with estimate-weighted progress and collapsed empty phases, the milestone list with the active one first and selected, phase and requirement facets, counts, viewer facts with a read-only reason, and every card's `moves`, `refusals` map and accessible name. Card order never reads a clock.
- `buildCardDetail` returns facts, must-haves, requirements, dependencies with their state (or "(not on the board)"), files, the task checklist (done when the plan is done), "why this is not ready" sentences, `editable` (never for imported items; owner and lead for any board item; a developer only for an own unclaimed draft) and up to 50 history sentences newest first, with the hold direction inferred and "Someone" for an unknown author.
- Tests: a nine-state by seven-viewer by seven-move table, a materialiser-acceptance sweep for every allowed intent, a compile-time proof that `MoveIntent` is an `EventIntent`, and a sweep over more than 300 strings proving no U+2014 or U+2013.

## Task Commits

1. **Task 1 (tracer): a model from real events, a hold planned and applied, the card leaving Ready**
   - RED `55c9b08` (test), GREEN `b9d5f22` (feat), refactor `2e08a1a` (literal UI-SPEC sentences so the acceptance grep matches)
2. **Task 2: the move table, reason rules, dependents, exact drop-target sentences**
   - RED `89bbf90` (test), GREEN `9ea50e7` (feat)
3. **Task 3: lanes, filters, ordering, viewer facts, card detail**
   - RED `3de79c0` (test), GREEN `9e9957e` (feat)

**Plan metadata:** the docs commit that adds this file (docs: complete plan)

## Files Created/Modified

- `src/domain/team/board.ts` - MOVE_KEYS, planMove, availableMoves, columnMove, buildBoardModel, buildCardDetail and the model types
- `src/domain/team/boardText.ts` - COLUMN_LABELS, COLUMN_CAPTIONS, MOVE_LABELS, REFUSALS, notReadyText, notReadyRefusal, notReadySentences, staleRefusal, estimateText, estimateSpoken, ageText, historySentence, cardLabel, flattenName and the fixed strings
- `src/test/teamBoardModel.test.ts` - tracer, lanes, milestones, facets, ordering, card face, hostile names, JSON safety, viewer facts, detail, history, text and the dash sweep (22 tests)
- `src/test/teamBoardMoves.test.ts` - the move table, drop targets, reasons and prompts (11 tests)
- `src/test/helpers/teamBoardWorld.ts` - in-memory signed team with owner, lead, developer, reviewer and observer (not a suite)

## Decisions Made

See `key-decisions`. The ones the host and client plans depend on: counts describe the default milestone selection while cards of every milestone are in the model; lane keys are `unassigned`, item ids, `board` and `all`; `refusals` has no entry for the card's own column or for a column it may enter; and a card with no permitted moves has `moves: []` and a refusal for every other column carrying the viewer's reason.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] A shared test world helper had to be added**
- **Found during:** Task 1
- **Issue:** Both test files need the same signed team (owner plus lead, developer, reviewer and observer in the roster); the plan lists only the two test files and importing a `.test` file would run its suite.
- **Fix:** Added `src/test/helpers/teamBoardWorld.ts` (no `.test` suffix, like the other helpers).
- **Files modified:** src/test/helpers/teamBoardWorld.ts
- **Committed in:** 55c9b08

**2. [Rule 1 - Bug] Claim refusals were built by interpolation, so the acceptance grep for the literal sentence could not match**
- **Found during:** Task 1 acceptance check
- **Issue:** `grep -n "Claiming a plan arrives in a later update. Nothing was moved." boardText.ts` found nothing because the sentence was a template.
- **Fix:** The claim, terminal and not-manager sentences are spelled out in full.
- **Files modified:** src/domain/team/boardText.ts
- **Committed in:** 2e08a1a

**3. [Rule 1 - Bug] A test of mine listed too few drop targets and so asserted too little**
- **Found during:** Task 2 GREEN
- **Issue:** Some rows of the drop table did not list every column, and the card-refusals test accepted any refusal for unlisted columns, which weakened it.
- **Fix:** Every row now lists all columns and the test requires the card's `refusals` map to equal the table exactly. Stricter, not weaker.
- **Files modified:** src/test/teamBoardMoves.test.ts
- **Committed in:** 9ea50e7

**4. [Rule 1 - Bug] A history test I wrote described an impossible log**
- **Found during:** Task 3 GREEN
- **Issue:** The "cut window" case put a release straight after a cancel, which the log cannot produce; the forward inference rightly read it as a hold.
- **Fix:** The scenario was rebuilt as a consistent log and a second case added for a single entry placed by the card's own hold flag.
- **Files modified:** src/test/teamBoardModel.test.ts
- **Committed in:** 9e9957e

---

**Total deviations:** 4 auto-fixed (1 blocking, 3 bugs in my own tests or strings before they shipped)
**Impact on plan:** None on scope. No assertion was loosened; one was tightened.

## Issues Encountered

- The editor tool turns ` ` and ` ` written in source into the raw characters, which broke a regex literal twice (once in `boardText.ts`, once in a test). Fixed by re-escaping with a script; the sources now contain only the escape sequences.

## TDD Gate Compliance

- **Task 1 RED (`55c9b08`):** a stub `board.ts` (final types, empty behaviour) made the tracer fail on `assert.deepEqual(before.columns.map(key), BOARD_COLUMNS)` with an empty list. `gsd_run check tdd-red-evidence` returned `RED_EVIDENCE_OK` (`target_test_failed`). Semantic assessment: the target ran to the planned first assertion (the fixture seeded without a rejection), no build or fixture fault.
- **Task 2 RED (`89bbf90`):** four tests failed on assertions: the reason rules (a newline survived in the reason), the dependents count, the not-ready drop sentence and the card refusals map (generic "cannot move there" where the table wants the not-ready list). Classified `RED_EVIDENCE_OK` for both the drop-target and the reason targets. Semantic assessment: planned reasons; the seven tests that passed first time (the full planMove table, the materialiser sweep, role refusals) are regression guards for behaviour Task 1 already shipped.
- **Task 3 RED (`3de79c0`):** 12 of 22 tests failed (lanes, milestones, facets, ordering, viewer facts, detail, history). Classified `RED_EVIDENCE_OK` for the lanes and the detail targets. The card face, hostile-name, JSON-safety, text and dash tests passed at RED because Task 1 already shipped `boardText.ts` and the card face; they stay as guards.
- Gate sequence: `test(62-06)` then `feat(62-06)` three times, plus one `refactor(62-06)`.

## Known Stubs

None. The RED-phase stub in `board.ts` was replaced in the GREEN commits.

## Threat Flags

None. Pure domain code: no endpoint, auth path, file access or schema change. Threat register T-62-19 to T-62-22: the role table drives every offered move (T-62-19), the planner is pure over the state it is given so the host can re-run it inside `log.append` and `staleRefusal` names who got there first (T-62-20), `flattenName` bounds every name, reason, title and glob (T-62-21), and a flagged reason is refused before any intent exists (T-62-22).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plans 07 to 09 can read the model from `buildBoardModel(state, { nowMs, status, viewerId, canWrite, readOnlyReason })`, post it as JSON, call `buildCardDetail` on demand with `ItemHistory.forItem(id)`, and re-run `planMove` inside the append for every `move` message. The host owns block and cancel reasons (native prompts) and passes them in `input.reason`; a `prompt: 'confirm'` move needs the Mark done modal, and a cancel move with `dependents > 0` needs the second modal.
- The client composes the milestone summary from `milestones[].progress.text`, recomputes counts after a milestone or filter change (model counts are for the default selection), and uses `lane.milestoneId` to hide lanes of other milestones.
- Verification run: `npm run lint` clean; `node --test dist/test/teamBoard*.test.js` 33 pass; `node --test dist/test/team*.test.js` 860 tests, 858 pass, 2 skipped as before, 0 fail.

## Self-Check: PASSED

- Files exist: src/domain/team/board.ts, src/domain/team/boardText.ts, src/test/teamBoardModel.test.ts, src/test/teamBoardMoves.test.ts, src/test/helpers/teamBoardWorld.ts
- Commits exist: 55c9b08, b9d5f22, 2e08a1a, 89bbf90, 9ea50e7, 3de79c0, 9e9957e

---
*Phase: 62-work-model-gsd-import-team-board-live-read-and-move*
*Completed: 2026-11-02*
