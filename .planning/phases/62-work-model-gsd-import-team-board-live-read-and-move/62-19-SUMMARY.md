---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 19
subsystem: team-board-model
tags: [team-mode, board-model, assignment, self-assignment, phase-cards, folding, g-62-3, g-62-5]
status: complete

requires:
  - phase: 62-15
    provides: "item.assigned and item.unassigned, WorkItem.assignee, transitionProblem's assignment rules and HistoryEntry.memberId"
  - phase: 62-18
    provides: "boardSummary(state, viewerId) reading card.mine and card.column"
  - phase: 62-25
    provides: "item.assign-self permission path chosen by actionForEvent; mayBeAssigned(state, memberId) for any current confirmed non-observer"
provides:
  - "BoardCard.assignee { id, name, initials } and assignActions; member lanes by assignee; Mine as assigned to me or my unassigned board item"
  - "planAssign, availableAssignActions and assignCandidates, deciding exactly as the log does (transitionProblem plus decideTeamAction on actionForEvent's action)"
  - "ASSIGN_LABELS, unassignLabel, ROLE_LABELS, ASSIGN_REFUSALS and the assignment history sentences in boardText.ts"
  - "Planless phases as Backlog cards (isPhaseCard), with their own card face, refusals, order, counts and detail"
  - "BoardColumnInfo.foldedByDefault and the open-work lane collapse rule"
  - "CardDetail.assignee and assignActions"
affects: [62-20, 62-21, 62-22, 62-24, phase-63-claims]

actuals:
  tokens: 18735
  tasks: 3
  commits: 8
plan_head_before: 00061f437264f3431a40f9cde9c34070b84e306a
plan_head_after: ed8bdf17c7e5f8faad88b98b64a21f333f9eaa30

tech-stack:
  added: []
  patterns:
    - "A board planner asks the log's own two questions on a probe envelope (transitionProblem, then decideTeamAction on actionForEvent's action), and the test proves agreement by signing and applying every planned and refused case in a fresh world"
    - "A display-only card rule (phase cards) lives in the board model, so the log's isCard, readiness and hashes do not move"

key-files:
  created:
    - src/test/teamBoardAssignModel.test.ts
    - src/test/teamBoardPhaseCards.test.ts
  modified:
    - src/domain/team/board.ts
    - src/domain/team/boardText.ts
    - src/test/teamBoardModel.test.ts
    - src/test/boardClient.test.ts

key-decisions:
  - "planAssign checks the viewer first (no device key, removed, then not a member who works on cards), then the card's rules (transitionProblem), then the permission for this exact event (actionForEvent gives item.assign or item.assign-self). Rules before permission gives the more useful sentence (a developer unassigning a free card hears 'not assigned to anyone'), and both orders refuse the same events"
  - "The no-device-key and removed refusals reuse the existing board sentences, as the plan says, so those two do not end 'Nothing was changed.'; every assignment-specific refusal does"
  - "Owners and leads get only Assign to... and Unassign (never the -me forms); other non-observers get only Assign to me and Unassign me. assignCandidates is empty unless Assign to... is offered, and keeps the current assignee in the list, marked"
  - "History says 'Dana assigned this to themselves.' and 'Dana unassigned themselves.' when a member acts on themselves (62-25), besides the planned 'Lee assigned this to Dana.' and 'Lee unassigned Dana.'"
  - "columnMove gives a phase card the phase sentence for every other column, before the viewer's move permission, so the drop path and the card's refusals agree; planMove is unchanged and still answers 'no longer on the board' for a phase"
  - "The ungrouped board's single All cards lane never starts collapsed (folding it would show an empty board); every other lane follows the open-work rule over the shown cards"

patterns-established:
  - "Owner-changed expectations in older tests are updated in place with a comment citing the decision of 2026-11-03; where a check's intent was 'a lane starts collapsed', the setup is changed (the phase is cancelled) so the check still exercises a collapsed lane"

requirements-completed: [BOARD-01, BOARD-03]

coverage:
  - id: D1
    description: "An assigned card carries its person (id, flattened name, up to two initials) and 'Assigned to {name}.' in its accessible name; member lanes are one per person with a shown card, alphabetical, the viewer's marked '(you)', Unassigned last"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/teamBoardAssignModel.test.ts#tracer: a lead assigns a plan to Dana, and the model puts it in her lane with her name and initials, marks it hers and counts it in her summary"
        status: pass
      - kind: unit
        ref: "src/test/teamBoardAssignModel.test.ts#initials come from the first letters of up to two words of the flattened name"
        status: pass
      - kind: unit
        ref: "src/test/teamBoardAssignModel.test.ts#member lanes: one per person with a shown card, sorted by name, the viewer marked, Unassigned always last"
        status: pass
    human_judgment: false
  - id: D2
    description: "Mine means assigned to me, or added by me with nobody assigned; the sidebar summary's mine count follows"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/teamBoardAssignModel.test.ts#Mine: cards assigned to me, or cards I added that nobody is assigned to"
        status: pass
      - kind: unit
        ref: "src/test/teamBoardSummary.test.ts (14 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "planAssign returns the event to write or one plain refusal, and agrees with the real materialiser for every role, target and starting point"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamBoardAssignModel.test.ts#planAssign for a lead: the intent to write, or one plain refusal for each rule the log would apply"
        status: pass
      - kind: unit
        ref: "src/test/teamBoardAssignModel.test.ts#planAssign for a member assigning themselves (62-25): their own free card yes, anyone else or a teammate's card no"
        status: pass
      - kind: unit
        ref: "src/test/teamBoardAssignModel.test.ts#planAssign and the log agree for every role, every target and both starting points"
        status: pass
    human_judgment: false
  - id: D4
    description: "Offered actions (Assign to... and Unassign for owner and leads; Assign to me and Unassign me for other non-observers; nothing for observers) and the person list"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamBoardAssignModel.test.ts#the offered actions: Assign to... and Unassign for the owner and leads, Assign to me and Unassign me for other members, nothing for observers"
        status: pass
      - kind: unit
        ref: "src/test/teamBoardAssignModel.test.ts#the person list: exactly the members who may take the card, by name, with role and the current assignee marked; empty for everyone else"
        status: pass
    human_judgment: false
  - id: D5
    description: "Card detail names the assignee, offers the same actions, and history says who assigned whom, names flattened"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/teamBoardAssignModel.test.ts#the card detail names the person, offers the same actions, and its history says who assigned whom"
        status: pass
    human_judgment: false
  - id: D6
    description: "Planless phases are Backlog cards titled 'Phase {n}: {title}', with no moves, one refusal per other column, ordered with plans, counted as cards but never as ready, with their own detail; a phase with plans is never a card"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/teamBoardPhaseCards.test.ts (5 phase card tests)"
        status: pass
    human_judgment: false
  - id: D7
    description: "Backlog and Ready open, the later columns plus Done and Cancelled folded by default; a lane collapses only when it holds nothing open"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/teamBoardPhaseCards.test.ts#Backlog and Ready start open; the four later columns, Done and Cancelled start folded"
        status: pass
      - kind: unit
        ref: "src/test/teamBoardPhaseCards.test.ts#a lane starts collapsed only when it holds nothing outside Done and Cancelled"
        status: pass
    human_judgment: false
  - id: D8
    description: "What the owner sees on the real board (phase cards, folded columns, the person on cards) once 62-20 and 62-21 wire the page"
    verification: []
    human_judgment: true
    rationale: "This plan changes the model only; the page does not yet read foldedByDefault, assignee or assignActions (62-20, 62-21), and the owner reviews real screenshots in 62-22 and 62-24"

duration: 28min
completed: 2026-11-04
---

# Phase 62 Plan 19: Board model for assignment, planless phases and folding (G-62-3, G-62-5) Summary

**The board model now shows who each card belongs to (person, initials, their own lane, Mine), decides every assignment exactly as the log does through planAssign, shows each phase that has no plans as a Backlog card, and opens on active and upcoming work while finished work starts folded.**

## Performance

- **Duration:** 28 min
- **Started:** 2026-11-04T02:21:53Z
- **Completed:** 2026-11-04T02:49:51Z
- **Tasks:** 3 (1 tracer, 2 auto, all TDD)
- **Files modified:** 6 (2 new test files, 2 domain files, 2 test files)

## Accomplishments

- G-62-5, showing it: an assigned card carries `assignee { id, name, initials }` ("E2E Owner" gives "EO") and says "Assigned to Dana." in its accessible name. The Member grouping has one lane per person with a shown card, sorted by name, the viewer's own as "Dana (you)", and Unassigned last. Mine is "assigned to me, or added by me with nobody assigned", so boardSummary's mine count follows with no change of its own.
- G-62-5, deciding it: `planAssign(state, viewerId, itemId, memberId)` returns the exact `item.assigned` or `item.unassigned` intent, or one plain refusal. It asks transitionProblem and then decideTeamAction with the action actionForEvent gives this very event (item.assign or item.assign-self, 62-25). A test signs and applies every case through the real materialiser, 60 fresh worlds, and the board and the log agree on all of them. `availableAssignActions` gives the menu (`assign`/`unassign` for owner and leads, `assign-me`/`unassign-me` for other non-observers, nothing for observers or waiting joiners). `assignCandidates` gives the person list for owners and leads only.
- Card detail gains `assignee` and `assignActions`. History reads "Lee assigned this to Dana.", "Lee unassigned Dana.", "Dana assigned this to themselves." and "Dana unassigned themselves.", with names flattened and "Someone" for a person who is no longer known.
- G-62-3: every phase with no plan under it is a card: "Phase 63: {title}", in Backlog (Done or Cancelled when stored so), in its own phase lane, with no moves and "Plan this phase first. Its plans move on the board, not the phase. Nothing was moved." for every other column (on the card and from columnMove). Phase cards and plans sort together by number. counts.cards includes them, ready never does, and a phase card has its own detail. isCard, readiness, countReady, planMove and every hash are unchanged.
- Folding defaults: `columns[].foldedByDefault` is true for Claimed, In progress, In review, Shipping, Done and Cancelled. A lane's `collapsedByDefault` is true only when it holds no shown card outside Done and Cancelled.

## Task Commits

1. **Task 1: Tracer (assignee on the card, member lanes, Mine)**
   - `c668aee` test(62-19): add failing tracer for an assigned card in its person's lane, marked theirs and counted in their summary (RED)
   - `23d2b16` feat(62-19): an assigned card shows its person, sits in their lane and counts as theirs (GREEN)
2. **Task 2: planAssign, the person list, offered actions, refusals, history and detail**
   - `53f8f2c` test(62-19): add failing tests for planAssign, the person list, the offered actions and the assignment history (RED)
   - `0437bd2` feat(62-19): planAssign, the person list and the offered assignment actions decide as the log does (GREEN)
   - `3baeea5` test(62-19): write the invisible and dash characters in the assignment tests as escapes
3. **Task 3: Planless phases as Backlog cards, folding defaults**
   - `eb41bd9` test(62-19): add failing tests for planless phases as Backlog cards and the folding defaults (RED)
   - `4128673` feat(62-19): planless phases show as Backlog cards, and the board opens on active and upcoming work (GREEN)
   - `ed8bdf1` test(62-19): the board page tests count the planless phase card of the standard board

No REFACTOR commits were needed.

## TDD Gate Compliance

- **Task 1 RED** (`c668aee`): `npx tsc -p tsconfig.json && node --test --test-reporter=tap dist/test/teamBoardAssignModel.test.js`, exit 1, 4 tests, 0 pass, 4 fail. `gsd-tools check tdd-red-evidence` gave RED_EVIDENCE_OK (target_test_failed). Semantic assessment: the tracer ran and failed on its planned assertion (assignee expected `{ id: Dana, name: 'Dana', initials: 'D' }`, actual undefined), because the model did not read item.assignee yet. The RED commit also declares the optional `assignee` field on BoardCard so the test compiles. No build, load or fixture fault.
- **Task 1 GREEN** (`23d2b16`): the plan's verify passed, 14 tests, 14 pass. Tracer feedback gate (auto mode): the verify was re-run green before expansion.
- **Task 2 RED** (`53f8f2c`): same command, exit 1, 11 tests, 5 pass, 6 fail. RED_EVIDENCE_OK on "planAssign for a lead: ..." (expected an item.assigned intent, actual `{ ok: false, reason: '' }` from the skeleton). The RED commit adds skeleton exports (types, an empty planAssign, availableAssignActions and assignCandidates returning nothing) and the boardText table so the tests compile. The 4 Task 1 tests and the text-table test pass on that skeleton.
- **Task 2 GREEN** (`0437bd2`): the plan's verify passed, 29 tests, 29 pass.
- **Task 3 RED** (`eb41bd9`): `... dist/test/teamBoardPhaseCards.test.js`, exit 1, 7 tests, 0 pass, 7 fail. RED_EVIDENCE_OK on "every phase with no plans is a Backlog card ..." (expected the five upcoming phases before the chore, actual only the chore). BoardColumnInfo declares `foldedByDefault` (false everywhere) so the tests compile.
- **Task 3 GREEN** (`4128673`): the plan's verify passed, 79 tests, 79 pass.

## Files Created/Modified

- `src/domain/team/board.ts`: assignee, initials, isMine, member lanes; planAssign, availableAssignActions, assignCandidates and the AssignAction, AssignIntent, AssignResult and AssignCandidate types; a probe envelope shared by transitionFor and planAssign; isPhaseCard, phaseCardOf, number ordering with phase cards, the phase card branch of columnMove and buildCardDetail; FOLDED_BY_DEFAULT; the open-work lane rule; CardDetail.assignee and assignActions
- `src/domain/team/boardText.ts`: YOU_SUFFIX, ASSIGN_LABELS, unassignLabel, ROLE_LABELS, ASSIGN_REFUSALS, the assignment history sentences (HistoryContext.assigneeName), REFUSALS.phaseCard, PHASE_NO_PLANS_DETAIL, PHASE_NO_PLANS_LABEL, phaseCardLabel, and "Assigned to {name}." in cardLabel
- `src/test/teamBoardAssignModel.test.ts` (new, 11 tests)
- `src/test/teamBoardPhaseCards.test.ts` (new, 7 tests)
- `src/test/teamBoardModel.test.ts`: four expectations follow the owner's new rules (phase:91 is a card, lane defaults, counts), each with a comment
- `src/test/boardClient.test.ts`: eight page tests count and step through the standard board's phase card, each with a comment

## Decisions Made

See key-decisions above. In short:

- planAssign checks the viewer first, then the card's rules, then the permission for this exact event.
- The no-device-key and removed refusals reuse the existing sentences.
- Owners and leads get only the person list actions, and other members only the -me actions.
- A member acting on themselves gets a "themselves" history sentence.
- columnMove gives the phase sentence for a phase card.
- The ungrouped All cards lane never starts folded.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The board page tests (boardClient.test.ts) followed the new model**
- **Found during:** the broader run after Task 3
- **Issue:** The plan named only teamBoardModel.test.ts as needing new expectations. boardClient.test.ts draws the real model of the standard board, whose phase:91 has no plans and is now a card. Eight tests counted 3 cards (now 4) or stepped from plan:90-02 straight to the chore (now through phase:91). One expected the phase:91 lane to start collapsed, which the open-work rule no longer gives.
- **Fix:** I updated the counts and keyboard steps, each with a comment citing the owner decision. In the collapsed-lane test, phase:91 is now cancelled, so its lane holds only finished work and still starts collapsed. That keeps the check exercising a collapsed lane. No assertion was removed.
- **Files modified:** src/test/boardClient.test.ts
- **Committed in:** ed8bdf1

**2. [Rule 1 - Test bug] The phase card tests filter to the selected milestone**
- **Found during:** Task 3 GREEN
- **Issue:** Two of my new RED tests listed `model.cards`, which carries every milestone's cards. The older milestone's planless phase:50 showed up in the current milestone's expected list.
- **Fix:** Added a `shownOf(model)` helper that applies the board's own milestone filter. The expectations are unchanged.
- **Committed in:** 4128673

**3. [Rule 2 - Consistency] columnMove answers for phase cards**
- **Found during:** Task 3
- **Issue:** The plan gives a phase card one refusal for every other column, but columnMove (the drop path the host and the card's refusals use) would have said "no longer on the board".
- **Fix:** columnMove returns the phase sentence for a phase card, or ok when it is already in that column. isCard and planMove are unchanged.
- **Committed in:** 4128673

**4. [Rule 3 - Blocking] RED commits carry compile-only skeletons**
- **Found during:** Tasks 1 to 3
- **Issue:** A test that names a field or export that does not exist fails to compile, and a build failure is not valid RED evidence.
- **Fix:** Each RED commit declares only what the tests need to compile: the optional assignee field, empty planAssign and helpers plus the text table, and foldedByDefault false. Each test then failed on its planned assertion.

**Total deviations:** 4 (2 blocking, 1 test bug, 1 consistency). **Impact:** no scope change. Nothing signed, stored or hashed changed: work.ts is untouched, and isCard still reads `return item.kind === 'plan' || item.origin === 'board';`.

## Issues Encountered

- Free memory was low (2 to 5 GB available). I waited for at least 4 GB before each broad run. Every run used the systemd-run, choom and timeout wrapper. Nothing hit a cap or a timeout.
- My shell input turned `–`, `—` and `‮` escapes into literal characters in the first test file. Commit `3baeea5` puts them back as escapes.

## Verification

- Task 3 verify (`tsc` plus teamBoardPhaseCards, teamBoardModel, teamBoardAssignModel, teamBoardSummary, teamWork, teamPlainLanguage): **79 tests, 79 pass, 0 fail**.
- Task 2 verify (`tsc` plus teamBoardAssignModel, teamBoardMoves, teamPlainLanguage): **29 tests, 29 pass, 0 fail**.
- Task 1 verify (`tsc` plus teamBoardAssignModel, teamBoardSummary): **14 tests, 14 pass, 0 fail**.
- Wider run (`dist/test/team*.test.js`, `dist/test/board*.test.js`, `dist/test/fakeDom.test.js`, capped at 4G, concurrency 2): **1252 tests, 1250 pass, 0 fail, 2 skipped**. The two skips are the live NEAR tests, which need NEAR_LIVE_TEAM=1.
- Acceptance checks:
  - `grep -c "assignee" board.ts` = 15 (at least 3 required)
  - `export function planAssign` and `export function assignCandidates` both match
  - `grep -c "^test(" teamBoardAssignModel.test.ts` = 11 (at least 8 required)
  - `grep -c foldedByDefault board.ts` = 2 (at least 1 required)
  - the isCard body check prints 1
  - board.ts and boardText.ts import no vscode, and the new text has no em or en dash
- I did not run the full `npm test` or e2e: this plan is not the phase boundary (62-20 to 62-24 remain).

## User Setup Required

None.

## Next Phase Readiness

- 62-20 (host and board) can call `planAssign` on fresh state before writing. It can offer `availableAssignActions` and use `assignCandidates` for the person picker. The labels are ASSIGN_LABELS plus `unassignLabel(name)`, and each role's word is in ROLE_LABELS. A phase card has `moves: []` and a refusal for every other column, and planMove still answers "no longer on the board" for it.
- 62-21 (page) can read `columns[].foldedByDefault`, `lanes.*[].collapsedByDefault`, `card.assignee` (initials chip) and `card.kind === 'phase'`. The page still folds columns by its own rule (Done and Cancelled open), so nothing visible changes until 62-21 wires foldedByDefault.
- The e2e suite checks drawn card ids with `includes`, so phase cards do not break it. 62-22 and 62-24 should expect phase cards in Backlog on the repository's own board.

## Self-Check: PASSED

- FOUND: src/test/teamBoardAssignModel.test.ts, src/test/teamBoardPhaseCards.test.ts
- FOUND commits: c668aee, 23d2b16, 53f8f2c, 0437bd2, 3baeea5, eb41bd9, 4128673, ed8bdf1 (all ancestors of HEAD)

---
*Phase: 62-work-model-gsd-import-team-board-live-read-and-move*
*Completed: 2026-11-04*
