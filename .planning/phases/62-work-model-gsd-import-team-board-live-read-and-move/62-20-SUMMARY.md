---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 20
subsystem: team-board
tags: [team-mode, board, assignment, self-assignment, webview, native-prompts, g-62-5]
status: complete

requires:
  - phase: 62-19
    provides: "planAssign, availableAssignActions, assignCandidates, BoardCard.assignee and assignActions, CardDetail.assignee and assignActions"
  - phase: 62-25
    provides: "item.assign-self for any confirmed member who is not an observer"
  - phase: 61-19
    provides: "teamPrompts.pick, so the real-window test can answer the person list"
provides:
  - "Page messages { type: 'assign' | 'unassign', itemId } with exact keys; the person always comes from the host"
  - "The host's native person list (owner and leads) through teamPrompts.pick, self-assignment with no list for everyone else, and three-step planning with planAssign"
  - "Assign to..., Unassign {name}, Assign to me and Unassign me in the Move to... menu after the moves and a separator"
  - "Assigned to in the detail facts, and Assign..., Change person..., Unassign, Assign to me and Unassign me buttons in the detail"
  - "The assignee chip on the card face, Move to... for cards that can only be assigned, Mine wording for assigned cards"
affects: [62-21, 62-22, 62-24, phase-63-claims]

actuals:
  tokens: 17057
  tasks: 3
  commits: 6
plan_head_before: 9622e9dfc02df8ead399ebc20d04235f84ef43eb
plan_head_after: d1746d2ede1ef83a9dcbe58c2407b914ac6a9e82

tech-stack:
  added: []
  patterns:
    - "A host prompt answer maps back to the domain object by the item object the list returned (index in the items array), never by reading the label"
    - "An assignment is stale when the card's person changed since the page asked, checked on known, current and fresh state, and the stale sentence names the newest author"

key-files:
  created:
    - src/test/teamBoardAssignView.test.ts
  modified:
    - src/services/team/boardView.ts
    - src/domain/team/board.ts
    - media/board/menu.js
    - media/board/board.js
    - media/board/detail.js
    - media/board/board.css
    - src/test/boardMenu.test.ts
    - src/test/boardDetail.test.ts
    - src/test/boardClient.test.ts
    - src/test/teamBoardLive.test.ts
    - src/test/teamBoardAssignModel.test.ts
    - src/test/teamBoardPhaseCards.test.ts

key-decisions:
  - "The host chooses the path from the log, not the page: decideTeamAction(item.assign) allowed means the person list; anyone else assigns themselves; unassign never prompts and takes off whoever has the card (the log allows that only for a lead, or for the member on their own card)"
  - "A lead's assignment is refused as stale whenever the card's person changed after the page asked, even though the rules would allow a reassignment, so a lead never silently overrides a teammate's choice made while the list was open"
  - "Choosing the person who already has the card, or closing the list, answers refused with an empty reason (no change, no sentence), the same as a dismissed move prompt"
  - "Every assign and unassign takes one token from the T-62-49 write bucket before any list is shown; extras get the existing busy sentence"
  - "The detail's assignee carries roleLabel so the fact reads 'Dana (Developer)'; the detail keeps its own Move to... for moves only, and the assignment buttons live beside it"
  - "Move to... shows for a card with moves (owner or lead) or with assignment actions (anyone but an observer); drag.js is unchanged, so only cards with moves are draggable"

patterns-established:
  - "Older page tests that listed the menu exactly now list the moves and then the assignment items, through one offered(card) helper, each change commented with the owner decision of 2026-11-03"

requirements-completed: [BOARD-02, BOARD-03]

coverage:
  - id: D1
    description: "The page can send only { type: assign | unassign, itemId }; a member id, extra keys or odd ids are refused by the parser and nothing is written (T-62-64)"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/teamBoardAssignView.test.ts#parseBoardMessage accepts exactly { type: assign or unassign, itemId } and refuses a member id, extra keys and odd ids"
        status: pass
      - kind: integration
        ref: "src/test/teamBoardAssignView.test.ts#an assign message that names a person is ignored: no list is shown and nothing reaches the remote"
        status: pass
    human_judgment: false
  - id: D2
    description: "A lead opens Assign to..., picks Dana in the native list (names, role words, the current one marked, titled with the card), one item.assigned is written, and the card shows Dana in her lane; choosing the same person or closing the list changes nothing"
    requirement: BOARD-03
    verification:
      - kind: integration
        ref: "src/test/teamBoardAssignView.test.ts#tracer: a lead chooses Assign to..., picks Dana from the host list, and the card comes back showing Dana in her lane"
        status: pass
      - kind: integration
        ref: "src/test/teamBoardAssignView.test.ts#the person list marks the one who has the card, and choosing them again or closing the list changes nothing"
        status: pass
    human_judgment: false
  - id: D3
    description: "Unassign writes one item.unassigned with no prompt; developers and reviewers assign and unassign themselves with no list; observers get nothing and are refused before any write"
    requirement: BOARD-03
    verification:
      - kind: integration
        ref: "src/test/teamBoardAssignView.test.ts#Unassign takes the person off with no prompt: one item.unassigned, and the card is back in Unassigned"
        status: pass
      - kind: integration
        ref: "src/test/teamBoardAssignView.test.ts#a developer assigns themselves with no list and takes themselves off again (62-25)"
        status: pass
      - kind: integration
        ref: "src/test/teamBoardAssignView.test.ts#a reviewer assigns themselves and takes themselves off the same way"
        status: pass
      - kind: integration
        ref: "src/test/teamBoardAssignView.test.ts#an observer is offered nothing, and an assign sent anyway is refused before anything is written"
        status: pass
    human_judgment: false
  - id: D4
    description: "Stale, offline and busy refusals: a card someone changed first is refused naming them, an offline append gives the offline sentence, too many requests give the busy sentence; nothing is written in each case"
    requirement: BOARD-03
    verification:
      - kind: integration
        ref: "src/test/teamBoardAssignView.test.ts#a developer whose card a lead took meanwhile is told who changed it first, and nothing is written"
        status: pass
      - kind: integration
        ref: "src/test/teamBoardAssignView.test.ts#while the list is open a lead takes the card, so choosing Dana is refused naming the lead, and nothing is written"
        status: pass
      - kind: integration
        ref: "src/test/teamBoardAssignView.test.ts#an append that fails offline gives the offline sentence, and the failure is written to the output channel without card text"
        status: pass
      - kind: integration
        ref: "src/test/teamBoardAssignView.test.ts#T-62-66: more assignment requests than the write bucket allows get the busy sentence and write nothing"
        status: pass
    human_judgment: false
  - id: D5
    description: "Move to... menu: Assign to... and Unassign {name} for owner and leads, Assign to me and Unassign me for others, after the moves and a separator, with pending lines, refusals and announcements"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/boardMenu.test.ts (21 tests, 4 new for assignment)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Detail: Assigned to 'Dana (Developer)' or 'Nobody yet'; Assign..., Change person..., Unassign for a lead, Assign to me and Unassign me otherwise, disabled with the offline reason, none for an observer"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "src/test/boardDetail.test.ts (3 new tests for assignment)"
        status: pass
    human_judgment: false
  - id: D7
    description: "The card face shows the initials chip and the name first in its meta row; assign-only cards show Move to... and are not draggable; Mine speaks of cards assigned to you or that you added; the chip keeps its border in high contrast and forced colours"
    requirement: BOARD-02
    verification:
      - kind: unit
        ref: "src/test/boardClient.test.ts (3 new tests and the updated Mine test)"
        status: pass
    human_judgment: false
  - id: D8
    description: "A lead assigns a card on one computer and the developer's open board shows it after exactly one poll interval and not before, with no reload"
    requirement: BOARD-02
    verification:
      - kind: integration
        ref: "src/test/teamBoardLive.test.ts#member A (lead) assigns a card to member B (developer), and B's open board shows it after exactly one poll interval and not before"
        status: pass
    human_judgment: false
  - id: D9
    description: "How the assignment controls look and feel in a real VS Code and code-server window (the native list, the chip, the menu and detail buttons)"
    verification: []
    human_judgment: true
    rationale: "Only fake-DOM and stubbed-host tests cover this plan; the real-window run that answers the list through teamPrompts and the owner's screenshot review are 62-22 and 62-24"

duration: 22min
completed: 2026-11-04
---

# Phase 62 Plan 20: Assign and unassign cards from the Move menu and the detail (G-62-5) Summary

**The owner and leads now put a person on a card from Move to... or the detail through a native list the host builds from the log, everyone else can assign or unassign themselves with one click, the card shows who has it, and a teammate sees it on the next poll. The page only ever sends the card id.**

## Performance

- **Duration:** 22 min
- **Started:** 2026-11-04T02:56:59Z
- **Completed:** 2026-11-04T03:19:15Z
- **Tasks:** 3 (1 tracer, 2 auto, all TDD)
- **Files modified:** 13 (1 new test file, 6 source files, 6 test files)

## Accomplishments

- **Host (boardView.ts):** two new page messages, `{ type: 'assign', itemId }` and `{ type: 'unassign', itemId }`, with exact keys and the move's item id rules. The host decides what they mean from the log:
  - The owner or a lead gets a native list through `teamPrompts.pick`. Each entry shows a name and role word, and the current person is marked "has this card now". The title is "Assign 90-02 to a person". The answer maps back to a member by the item object the list returns.
  - Anyone else is assigned or unassigned themselves, with no list.
  - Unassign never prompts.
  - Every request takes a write-bucket token first. planAssign then runs on known state, on current state after the list, and on fresh state inside `log.append`. A card whose person changed since the page asked gets `staleRefusal` naming the newest author, and nothing is written. Offline, secret, lost-key and busy failures use the same sentences as moves.
- **Menu (menu.js):** after the moves and a separator, the menu lists `Assign to...` and `Unassign Dana`, or `Assign to me` and `Unassign me`. Assign to... shows "Choosing a person...", the others "Saving...". A refusal is drawn on the card and announced as "Can't assign plan 90-01. ...". An empty refusal clears the pending line silently. The menu's state key includes the assignee, so a confirming state ends the wait. If the card's assignment actions change while the menu is open, the menu closes.
- **Detail (detail.js):** the first fact is `Assigned to`, with "Dana (Developer)" or "Nobody yet". The buttons are `Assign...` (lead, free card), `Change person...` plus `Unassign` (lead, assigned card), and `Assign to me` or `Unassign me` (others). They post the same messages as the menu. While the board is offline they are aria-disabled, with the read-only reason as their title. A viewer with no assignment actions sees none. A refusal shows in the detail and is announced.
- **Card face (board.js, board.css):** an assigned card starts its meta row with a round initials chip (aria-hidden) and the name as text. The chip uses theme colours only and keeps a 1px border in high contrast and forced colours.
- **Move to... and the M key:** these now open the menu for a card with moves (owner or lead) or with assignment actions (anyone but an observer). A phase card therefore shows Move to... with only Assign to..., or only Assign to me for Dana. drag.js is unchanged, so only cards with moves can be dragged.
- **Mine:** the chip title is "Cards assigned to you or that you added", and the empty text is "Nothing is yours yet. Cards assigned to you or that you add show up here."
- **Your own and teammates' changes are announced:** "Assigned plan 90-01 to Dana." or "Unassigned plan 90-01." for your own, and "90-02 was assigned to Dana" for a teammate's.
- **Live:** the lead assigns plan:90-02 to the developer on a real session. The developer's open board gets the assignee after exactly one poll interval and not before, with no reload.

## Task Commits

1. **Task 1: Tracer (Assign to... in the Move menu, the host's person list)**
   - `587656e` test(62-20): add failing tracer for Assign to... in the Move menu and the host's person list (RED)
   - `6b310c4` feat(62-20): a lead assigns a card from Move to... through the host's person list (GREEN)
2. **Task 2: Unassign, the detail drawer, every refusal path**
   - `08b93ff` test(62-20): add failing tests for Unassign, the detail's Assigned to and buttons, self-assignment and the refusals (RED)
   - `9d1b080` feat(62-20): Unassign, and Assigned to with the assignment buttons in the card detail (GREEN)
3. **Task 3: Chip, assign-only cards, Mine wording, one-poll visibility**
   - `b2843bf` test(62-20): add failing tests for the assignee chip, Mine wording, assign-only cards and a teammate seeing an assignment after one poll (RED)
   - `d1746d2` feat(62-20): the person on the card face, and Mine speaks of cards assigned to you or that you added (GREEN)

No REFACTOR commits were needed.

## TDD Gate Compliance

- **Task 1 RED** (`587656e`): `npx tsc -p tsconfig.json && node --test --test-reporter=tap dist/test/teamBoardAssignView.test.js dist/test/boardMenu.test.js` exited 1: 19 tests, 14 pass, 5 fail. `gsd-tools check tdd-red-evidence` gave RED_EVIDENCE_OK (target_test_failed) on the host tracer. Semantic assessment: the tracer ran and failed on its planned assertion. It expected one native person list and saw none, because the parser did not know `assign` yet and the host ignored the message. The other four failures were also missing behaviour: no parser case, no menu item (a missing menu item showed up as a TypeError), and no marked list entry. No build, load or fixture fault.
- **Task 1 GREEN** (`6b310c4`): the plan's verify (`tsc` plus teamBoardAssignView, boardMenu and teamBoardView) passed with 51 tests, 51 pass. Tracer feedback gate (auto mode): the verify was re-run green before expansion.
- **Task 2 RED** (`08b93ff`): `... teamBoardAssignView, boardDetail, boardMenu` exited 1: 46 tests, 39 pass, 7 fail. RED_EVIDENCE_OK on "Unassign takes the person off with no prompt..." (expected 23 events on the remote, actual 22, because unassign was not handled). The detail tests failed on the missing Assigned to fact and buttons, and the bucket test failed because unassign left the card assigned. The new stale, observer and developer-assign tests already passed on Task 1's host, which already planned on fresh state. They are kept as regression coverage.
- **Task 2 GREEN** (`9d1b080`): the plan's verify passed with 46 tests, 46 pass.
- **Task 3 RED** (`b2843bf`): `... boardClient, teamBoardLive, teamBoardAssets, boardDrag, teamPlainLanguage` exited 1: 76 tests, 73 pass, 3 fail. RED_EVIDENCE_OK on the chip test ("the chip comes first in the meta row", actual false). The Mine wording and chip CSS tests also failed. The assign-only card and live tests already passed on Task 1's code, as noted under Deviations.
- **Task 3 GREEN** (`d1746d2`): the plan's verify passed with 76 tests, 76 pass.

## Files Created/Modified

- `src/services/team/boardView.ts`:
  - the assign and unassign message types and parser cases
  - `assign()`, `nobodyReason()`, `pickPerson()` (teamPrompts.pick) and `writeAssignment()`
  - `staleText()` split out of `staleOrPlain()`
  - NOBODY_TEXT, the pick title and placeholder, and ASSIGN_STATE_REFUSALS
- `src/domain/team/board.ts`: `CardDetail.assignee.roleLabel`
- `media/board/menu.js`: the assignment items, `chooseAssign`, and a signature and state key that cover the assignment
- `media/board/board.js`:
  - `hasMenu(c)`, used by Move to..., the M key and the hint
  - the assignee chip
  - Mine texts
  - the assignment announcements and `showRefusal(..., action)`
- `media/board/detail.js`: the Assigned to fact and the assignment buttons
- `media/board/board.css`: `.assignee` and `.assignee-initials`, plus the high contrast and forced colours borders
- `src/test/teamBoardAssignView.test.ts` (new, 12 tests)
- `src/test/boardMenu.test.ts`: 4 new tests, and 6 older ones that list the moves and then the assignment items
- `src/test/boardDetail.test.ts`: 3 new tests, and the detail's Move to... menu list
- `src/test/boardClient.test.ts`: 3 new tests, the Mine wording, and the developer's M key
- `src/test/teamBoardLive.test.ts`: 1 new live test
- `src/test/teamBoardAssignModel.test.ts` and `src/test/teamBoardPhaseCards.test.ts`: the detail assignee now includes roleLabel

## Decisions Made

See key-decisions above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The detail needs the assignee's role word**
- **Found during:** Task 2
- **Issue:** The plan's detail shows "Dana (Developer)", but `CardDetail.assignee` from 62-19 carried only id and name, and the page knows no roles.
- **Fix:** `buildCardDetail` adds `roleLabel` from ROLE_LABELS. Two model tests that deepEqual the detail assignee now expect it, each with a comment.
- **Files modified:** src/domain/team/board.ts, src/test/teamBoardAssignModel.test.ts, src/test/teamBoardPhaseCards.test.ts
- **Committed in:** 9d1b080

**2. [Rule 1 - Owner-changed expectations] Older page tests listed the menu without the assignment items**
- **Found during:** Task 1
- **Issue:** Several older tests followed the old menu rules, which the owner's decision changed:
  - six boardMenu tests and one boardDetail test asserted the menu holds exactly the moves (and one separator)
  - a boardClient test asserted that M on a developer's card opens nothing, which is no longer true now that the card offers Assign to me
  - one boardMenu test made a card with no moves (but with an assignment action) to check that Move to... is hidden
- **Fix:** Each expectation now lists the moves and then the assignment items, through an `offered(card)` helper. The separator count is two, and the developer's M opens the menu. A new step checks that a card with neither moves nor assignment opens nothing. The no-moves card also has its assignment actions cleared. Every change has a comment citing the decision of 2026-11-03. No assertion was removed.
- **Files modified:** src/test/boardMenu.test.ts, src/test/boardDetail.test.ts, src/test/boardClient.test.ts
- **Committed in:** 6b310c4

**3. [Rule 2 - Correctness] Assignment changes end the pending line and are announced**
- **Found during:** Task 1
- **Issue:** board.js only noticed a card change when its column, blocked flag or hold changed. An assignment changes none of these, so "Choosing a person..." would have stayed on the card.
- **Fix:** The change key and the menu's state key now include the assignee id. Your own and teammates' assignments are announced in plain words.
- **Committed in:** 6b310c4

**4. [Rule 2 - Correctness] A lead's choice after a teammate reassigned the card is stale**
- **Found during:** Task 2
- **Issue:** The rules allow a lead to reassign, so planAssign alone would quietly override a choice a teammate made while the list was open. The plan expects the stale sentence instead.
- **Fix:** writeAssignment treats any change of the card's person since the page asked as stale, on current and on fresh state.
- **Committed in:** 6b310c4 (with the host), covered by the Task 2 tests

**5. [TDD note] Some Task 2 and Task 3 tests passed at RED**
- **Issue:** Task 1's host and menu already did self-assignment, the stale check, Move to... for assign-only cards and the live path, because the plan's Task 1 action asks for the self path and the Move to... rule. Each RED commit still had its named target failing on the planned assertion, with RED_EVIDENCE_OK.
- **Impact:** none. Those tests stay as regression coverage.

**Total deviations:** 5 (1 blocking, 1 owner-changed tests, 2 correctness, 1 TDD note). **Impact:** no scope change. No event, hash or permission rule changed. src/domain/team/* still does not import vscode, and the page writes text nodes only.

## Issues Encountered

- Free memory dropped to 1 to 2 GB before the wider run. I waited for 5 GB, checked that no e2e was running, and then ran the wider run. Every run used the systemd-run, choom and timeout wrapper. Nothing hit a cap or a timeout.

## Verification

- Task 1 verify (`tsc` plus teamBoardAssignView, boardMenu and teamBoardView): **51 tests, 51 pass, 0 fail**.
- Task 2 verify (`tsc` plus teamBoardAssignView, boardDetail and boardMenu): **46 tests, 46 pass, 0 fail**.
- Task 3 verify (`tsc` plus boardClient, teamBoardLive, teamBoardAssets, boardDrag and teamPlainLanguage): **76 tests, 76 pass, 0 fail**.
- Wider run (`dist/test/team*.test.js`, `dist/test/board*.test.js`, `dist/test/fakeDom.test.js`, capped at 4G, concurrency 2): **1275 tests, 1273 pass, 0 fail, 2 skipped**. The two skips are the live NEAR tests, which need NEAR_LIVE_TEAM=1.
- Acceptance checks:
  - `grep -c "'assign'" boardView.ts` = 3 (at least 1 required)
  - `grep -c teamPrompts boardView.ts` = 2 (at least 1 required)
  - `grep -c "Assign to" menu.js` = 2 (at least 1 required)
  - `grep -c "Assigned to" detail.js` = 1 (at least 1 required)
  - `grep -c "^test(" teamBoardAssignView.test.ts` = 12 (at least 8 required)
  - `grep -c assignee board.js` = 9 (at least 1 required)
  - colour literals in board.css = 0
- Changed lines have no em or en dash and no markup sink.
- I did not run the full `npm test` or e2e. This plan is not the phase boundary, since 62-21 to 62-24 remain.

## User Setup Required

None.

## Next Phase Readiness

- **62-24 (real-window test):** it can answer the person list through `promptTap.script`. The pick's title is "Assign {displayId} to a person", the placeholder is "Choose the person who takes this card", and the labels are the members' names.
- **62-21 (page layout):** the meta row now starts with `.assignee`. Phase cards show Move to... for whoever may assign them.
- **62-22:** the screenshots should show the chip on assigned cards.

## Self-Check: PASSED

- FOUND: src/test/teamBoardAssignView.test.ts
- FOUND commits: 587656e, 6b310c4, 08b93ff, 9d1b080, b2843bf, d1746d2 (all ancestors of HEAD)

---
*Phase: 62-work-model-gsd-import-team-board-live-read-and-move*
*Completed: 2026-11-04*
