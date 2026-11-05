---
status: diagnosed
trigger: "0.6.4 re-test (owner, 2026-11-05), board steps 12 and 16: a finished (Done) plan card will not move to Backlog, by drag or by Move to..., for alice (team owner)"
created: 2026-11-05T17:00:00Z
updated: 2026-11-05T19:30:00Z
---

## Current Focus

hypothesis: CONFIRMED. Nothing refuses the move. The drop on Backlog and Move to... -> "Backlog (reopen)" both write item.reopened, the log accepts it, and the materializer stores the plan as backlog; but the board draws a stored-backlog card in Ready whenever it is ready (work.ts columnOf), and an imported plan with files, an estimate and finished dependencies is ready the moment it is open again. The card leaves Done and appears in Ready, never in Backlog where it was dropped.
test: src/test/teamBoardReopenColumn.test.ts (RED: 2 fail, 1 boundary neighbour passes)
expecting: fixed when a card dropped on Backlog (or moved with the menu item that names Backlog) is drawn in Backlog
next_action: none in this session (diagnose only). Owner decision needed on the semantics, then gap-closure plan 62-28.
bug_class: Bohrbug (deterministic for every ready-shaped plan)

reasoning_checkpoint:
  hypothesis: "a reopened ready-shaped plan is drawn in Ready because board.ts:338/100 and boardText.ts:21 promise Backlog for reopen, materialize.ts:483 stores 'backlog', and work.ts:239-240 draws a stored backlog item that passes readiness in Ready"
  confirming_evidence:
    - "the real log has two reopens by alice (lamport 158 plan:62-14, lamport 162 plan:61-14), both accepted (replay: 162 accepted, 0 rejected)"
    - "the replay draws both plans in 'ready' (state backlog, no hold); plan columns done 38, ready 2"
    - "RED: drop on Backlog -> 'ready' !== 'backlog'; Move to... names Backlog -> 'ready' !== 'backlog'; a plan without an estimate (not ready once open) does land in Backlog"
  falsification_test: "if the replay showed a rejected reopen or a plan still 'done', the refusal theory (permission, materializer, import) would stand; it shows neither"
  fix_rationale: "make the move and the drawn column agree: a drop on Backlog keeps the card in Backlog (reopen plus hold, or a reopen that lands held), a drop on Ready reopens into Ready when it is ready, and the menu names where the card will be drawn"
  blind_spots: "the owner's exact clicks are not logged; two reopens are in the log and nothing else was written, so other attempts (if any) were refused on the page or never sent. Board-created items (bug, chore, spike) follow the same rule when they have files and an estimate."
  candidate_causes:
    - "code: move target vs derived column mismatch (board.ts:100/338, boardText.ts:21, work.ts:239-240)"
    - "permission: owner may reopen (ruled out: planMove ok, log accepted)"
    - "data/import: the GSD import re-marking the plan done (ruled out: no item.updated after the reopens; import.json unchanged)"
    - "page/host: drag or menu not sending (ruled out: the events are in the log)"
  and_gate: "yes, two conditions together: the reopen targets stored state 'backlog' AND the plan is ready-shaped (files, estimate, finished dependencies); every imported plan in the scratch project is ready-shaped, so every reopen there lands in Ready"

## Symptoms

expected: RETEST.md step 12 "Drag a finished plan from Done to Backlog. Expect: it moves." The Move to... item for a done card reads "Backlog (reopen)" (src/domain/team/boardText.ts:21).
actual: the card does not end up in Backlog, by drag or by Move to...
errors: none reported
reproduction: alice (owner), board in its own tab, Columns view, open Done in the Unassigned lane, drag a done plan to Backlog, or Move to... -> Backlog (reopen)
started: 0.6.4 preview (62-27 made every kanban card draggable; first time the owner could try this drop)

## Eliminated

- hypothesis: "permission: the owner may not reopen an imported plan"
  evidence: replay: planMove(owner, plan:62-13, 'reopen') = ok with intent item.reopened; permissions.ts:230 maps a reopen of a done card to moveBy (item.move for the owner); the log accepted both reopens.
  timestamp: 2026-11-05T17:05:00Z
- hypothesis: "the materializer rejects the reopen, or the GSD import owns plan state and puts it back to done"
  evidence: replay rejected [] ; no item.updated or item.imported after lamport 158; plan:62-14 and plan:61-14 are state 'backlog' at the head.
  timestamp: 2026-11-05T17:05:00Z
- hypothesis: "the page's drag or menu never sends the move (or the host drops it)"
  evidence: the two item.reopened events (15:22:58.604Z and 15:33:46.667Z, author alice) are in the shared mirror at refs/team/coordination 88778d6.
  timestamp: 2026-11-05T17:05:00Z

## Evidence

- timestamp: 2026-11-05T16:55:00Z
  checked: the shared coordination mirror (code-server globalStorage team/team-e00e55d0.../coordination.git, read only), refs/team/coordination at 88778d6
  found: two item.reopened events by alice (mbr-e7669941a74b51df, the owner): lamport 158 plan:62-14 at 15:22:58.604Z and lamport 162 plan:61-14 at 15:33:46.667Z
  implication: the page and the host did write the reopen both times; nothing upstream of the log refused it.
- timestamp: 2026-11-05T16:58:00Z
  checked: replay of all 163 log entries through the preview's materializer (scratchpad replay.js, dist of team-preview 8777d43)
  found: accepted 162, rejected [] ; plan:62-14 and plan:61-14 both state 'backlog', summary true, no hold, effectiveColumn 'ready'. Plan columns: done 38, ready 2. columnMove(owner, plan:62-13, 'backlog') = {ok:true, move:'reopen'}.
  implication: the reopen was accepted and the card is drawn in Ready. The owner looked for it in Backlog.
- timestamp: 2026-11-05T17:00:00Z
  checked: src/domain/team/board.ts:100 (MOVE_COLUMN reopen -> 'backlog'), :338 (a drop on Backlog of a done card asks 'reopen'), src/domain/team/boardText.ts:21 (label 'Backlog (reopen)'), src/domain/team/materialize.ts:482-483 (item.reopened -> settle(item, 'backlog')), src/domain/team/work.ts:238-240 (columnOf: a stored backlog/ready item is drawn in Ready whenever readinessOf says ready)
  found: the move promises Backlog, the materializer stores state 'backlog', and the board derives the drawn column from readiness, so an imported plan with scope, an estimate and finished dependencies is drawn in Ready right after the reopen. boardView.ts move() (755-819) says nothing on success, so the person is not told where the card went.
  implication: the move's promised column and the column the card lands in disagree for every ready-shaped plan.
- timestamp: 2026-11-05T18:30:00Z
  checked: RED test src/test/teamBoardReopenColumn.test.ts (node --test dist/test/teamBoardReopenColumn.test.js, under the memory cap)
  found: 'the owner drops a finished, ready-shaped plan on Backlog: it is drawn in Backlog afterwards' fails 'ready' !== 'backlog'; 'Move to... on a finished plan: the column the menu names is the column the card is drawn in afterwards' fails 'ready' !== 'backlog'; 'a finished plan without an estimate dropped on Backlog is drawn in Backlog' passes.
  implication: reproduced in the pure model; the boundary neighbour shows the readiness derivation is the deciding condition.
- timestamp: 2026-11-05T18:35:00Z
  checked: RETEST.md step 16 against the log
  found: step 13's "alice's card" was phase:63 (item.assigned lamport 159), a planless phase card, which correctly cannot move (G-62-3). Step 16 expected it to move.
  implication: step 16's failure is the script's (no plan card was open in this project), not a product defect; the next script should use a reopened plan for steps 13 to 16.

## Resolution

root_cause: "src/domain/team/board.ts:338 maps a drop on Backlog of a done or cancelled card to 'reopen', and board.ts:100 plus boardText.ts:21 ('Backlog (reopen)') promise Backlog; src/domain/team/materialize.ts:483 settles the item to state 'backlog'; src/domain/team/work.ts:239-240 then draws any stored backlog item that passes readiness in Ready. A reopened plan with files, an estimate and finished dependencies (every imported plan in the scratch project) is therefore drawn in Ready, not Backlog, and the host says nothing (boardView.ts move() has no success notice). The move is not refused: both of alice's reopens are accepted in the log."
fix: ""
verification: ""
files_changed: []
correct_behaviour_options: "Owner to choose. (A) A drop on Backlog, or Move to... -> Backlog, reopens and holds the card in one append (item.reopened then item.updated {hold:true}), so it is drawn in Backlog and Release moves it to Ready; a drop on Ready reopens it and it is drawn in Ready when ready (refused with the not-ready reason when it is not). (B) Keep one reopen, but the menu and the drop name the real destination ('Reopen (goes to Ready)') and the board says where the card went. A matches the owner's expectation in step 12."
red_commit: 6ff8876
red_tests: ["src/test/teamBoardReopenColumn.test.ts: the owner drops a finished, ready-shaped plan on Backlog: it is drawn in Backlog afterwards", "src/test/teamBoardReopenColumn.test.ts: Move to... on a finished plan: the column the menu names is the column the card is drawn in afterwards"]
