---
phase: 31-staff-roster-cell-keys-and-migration
plan: 17
subsystem: replica
tags: [replica, roster, deputy, handover, split, choose, observer]
status: complete

requires:
  - phase: 31-12
    provides: "roster driver (foldRoster, applyOne, isRosterWriterAt, leads and deputies histories, pending, rosterBranchPending seam), replicaRosterWorld helper"
  - phase: 31-01
    provides: "optional RosterView.rosterBranchPending"
provides:
  - "roster.ts: deputy authority in isRosterWriterAt; deputy.name and lead.handover applied; roster splits with ROSTER_SPLIT_TEXT; roster.choose at the split point; RosterState.pending (with text), choices, notChosen; rosterBranchPending over unchosen branches and their descendants"
  - "ROSTER_REFUSALS: deputy-cannot-name-deputy, not-an-active-member, names-the-lead, handover-not-allowed, choose-not-allowed, choose-not-a-branch, choose-superseded"
  - "verify.ts: VERIFY_HOLDS roster-branch-not-chosen (before missing-roster); KEEP_REASONS observer-only"
affects: [31-14, 31-15, 31-20, 32, 33]

actuals:
  tokens: 14200
  tasks: 3
  commits: 3
plan_head_before: 6cacd66f216763046e33ca50c9e1ac71eaf9f3a8
plan_head_after: 7e907d84

tech-stack:
  added: []
  patterns:
    - "Lead and deputy as position histories; a deputy record with no member ends the role"
    - "roster.choose occupies one position between the split point and the chosen branch (A12)"

key-files:
  created:
    - src/test/replicaRosterSplit.test.ts
  modified:
    - src/domain/replica/roster.ts
    - src/domain/replica/verify.ts
    - src/test/replicaRosterTracer.test.ts

key-decisions:
  - "One-way Task 1 taken as planned (D-10, owner decision 5): lead and deputy devices write the roster; only the lead writes deputy.name"
  - "Choose encoding as planned (A12): roster.choose cites the split point and names a child; it takes one position and the chosen child the next, its rosterPrev still the split point"
  - "Chooser: the lead at the split point, or the deputy there when the lead has no active device (D-09, D-48). A lead who handed over is no longer the lead, so the member they handed over to chooses"
  - "Two allowed choices at one split: the one signed latest applies, ties to the smaller hash; the other is refused choose-superseded. Every allowed choice there is by one member, so this is that person's last word, and a split can never be stuck between two choices"
  - "A choice naming the only branch at a head (no split seen yet) applies, so machines that saw one branch and machines that saw both reach the same line"
  - "A deputy who becomes the lead stops being the deputy at that position; an old lead is a plain member after a handover unless named deputy"
  - "deputy.name and lead.handover must name an active member who is not the lead (not-an-active-member, names-the-lead)"
  - "observer-only keep: a member who holds observer and not member at the cited roster; checked after unauthorised and before newer-version"

requirements-completed: [MUS-04]

coverage:
  - id: D1
    description: "Deputy named by the lead, deputy writes the roster, deputy cannot name a deputy, replaced deputy's earlier entry stays applied"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaRosterSplit.test.ts (Task 1, 3 tests)"
        status: pass
  - id: D2
    description: "lead.handover by the lead or by the deputy with lead-lost; main fold judges at the cited roster after a handover"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaRosterSplit.test.ts (Task 2, 5 tests)"
        status: pass
  - id: D3
    description: "15.1 roster head -> split and split -> chosen branch in every delivery order; chooser rules; holds and observer keep in the main fold"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaRosterSplit.test.ts#15.1 roster head -> split"
        status: pass
      - kind: unit
        ref: "src/test/replicaRosterSplit.test.ts#15.1 split -> chosen branch"
        status: pass

duration: 13min
completed: 2026-11-20
---

# Phase 31 Plan 17: Roster authority (deputy, handover, split and choose) Summary

**The roster now has a deputy lead who writes every roster entry the lead can except naming the deputy, a lead handover the deputy may sign only when the lead is lost, and visible roster splits that wait for the lead's (or the leadless deputy's) signed choice; entries citing an unchosen branch are held `roster-branch-not-chosen`, and an observer's entries are kept `observer-only`.**

## Performance

- Started 2026-11-20T05:03Z (after reading the plan, context, research, DESIGN 7.1 and 15.1, and summaries 31-06 and 31-12), finished about 05:17Z
- 3 tasks, 3 task commits, 1 test file created, 3 files modified

## Accomplishments

- **Deputy (Task 1, D-08, D-10):** `isRosterWriterAt` accepts an admitted device of an active member who is the lead or the deputy at the head, so the deputy writes the roster and signs grants (D-22). `deputy.name` applies only from the lead (`deputy-cannot-name-deputy`), names an active member who is not the lead, and is recorded in the deputy history at its position. The view answers `deputy_lead` from that history while the member is active.
- **Handover (Task 2, D-10, D-48):** `lead.handover` applies from the lead for either reason and from the deputy only with `lead-lost` (`handover-not-allowed`). The new lead holds `staff_lead` from the handover's position on, the old lead at every earlier roster; a deputy who becomes the lead stops being the deputy there. The main fold still accepts the genesis and a `product.create` the old lead wrote at the earlier roster, refuses the old lead's `product.owner` at the later roster (`not-authorised`) and accepts the new lead's.
- **Split and choose (Task 3, D-09, D-11, D-48):** two or more roster changes by roster writers on one head are recorded in `pending` with `ROSTER_SPLIT_TEXT` and the sorted branch hashes, and nothing on either branch applies. A `roster.choose` citing the split point and naming one of its branches, from an allowed chooser, takes the next position and the chosen branch the one after it; the split moves to `choices`, and the other branches stay unapplied. `notChosen` holds every unchosen branch and every roster entry chained after it; `rosterBranchPending` answers from it, and the roster fold's own leftovers on those branches are held `roster-branch-not-chosen`.
- **verify.ts (D-11, D-12):** `verifyEntry` returns the hold `roster-branch-not-chosen` when the view says the cited roster is on such a branch, before `missing-roster`; the fold retries it when a new context replaces the old one, so an entry citing the branch later chosen applies. An entry from a member who holds `observer` and not `member` at the cited roster is kept `observer-only`.
- The roster driver's probe view answers `rosterBranchPending` with no, so roster-stream bodies are still opened once.

## Task Commits

1. Task 1 (tracer): `ea1c527d` feat(31-17): deputy lead writes the roster and only the lead names the deputy
2. Task 2: `7dc8ba72` feat(31-17): lead handover by the lead, or by the deputy when the lead is lost
3. Task 3: `7e907d84` feat(31-17): roster split, the person's choice, and holds on unchosen branches

## Decisions

- One-way Task 1 (D-10, owner decision 5): taken as planned (owner asleep; defaults approved).
- Tracer gate: after the Task 1 commit the verify (split and tracer tests, 13 of 13) was re-run end to end before expanding.
- See the frontmatter `key-decisions`: chooser rule, the latest signed choice wins between two allowed choices, a choice of the only branch applies, deputy ends on becoming lead, the two new naming refusals, and the observer keep order.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The tracer's pending-kinds test listed deputy.name and lead.handover**
- **Found during:** Task 1 (and again in Task 2)
- **Issue:** `replicaRosterTracer.test.ts` ("a roster entry of a kind whose rule is not written yet is refused roster-kind-pending ...", written by 31-12) used `deputy.name` and `lead.handover` as examples of kinds with no rule. Once this plan applies them, that test fails, and the plan's own verify runs it. The file is outside this plan's `files_modified`.
- **Fix:** the two kinds are removed from its list, and the owner-module assertion now expects `['cells', 'members']` (the roster module has no pending kind left). No assertion was loosened for any kind still pending.
- **Files modified:** src/test/replicaRosterTracer.test.ts
- **Commits:** ea1c527d, 7dc8ba72
- **Merge note for the orchestrator:** 31-14 (`member.update`, `member.remove`, `device.revoke`, `invite.void`) and 31-15 (`cell.create`) make the same list stale for their kinds and will touch the neighbouring lines, so expect a small conflict in that list. Resolve to the kinds still pending after all four plans; if none is left in a module, drop that module from the owner assertion (and if no pending kind is left at all, the test needs a new subject, for example a kind that is routed but has no rule).

**2. [Rule 2 - Missing critical functionality] Two choices at one split**
- **Issue:** the plan does not say what happens when two allowed `roster.choose` entries at one split name different branches (two of the lead's devices offline). Keeping the split pending would leave it stuck for good, because any further choice also cites the split point.
- **Fix:** the choice signed latest applies (ties to the smaller hash) and the others are refused `choose-superseded`. All allowed choices at one split are by the same member, so this is that person's own last word; nothing chooses a branch nobody signed (P-31-22 holds). Tested in both delivery orders.
- **Commit:** 7e907d84

**3. [Rule 2] Naming checks for deputy.name and lead.handover**
- Both must name an active member at the cited roster who is not the lead (`not-an-active-member`, `names-the-lead`), so neither can hand a lead role to someone outside the roster or make one member lead and deputy at once. Tested.

### Notes

- The plan names the branch `feat/phase-31-17-roster-authority`; the orchestrator dispatched it on `feat/phase-31-17-roster-split`.
- TDD: Tasks 1 and 2 had a RED run (3 of 13 and 5 of 8 failing) before their code. Task 3's tests were written in the same step as the code and went green on the first compile, so its guards were checked by mutation in the compiled `dist/` only (overwritten by the next compile): dropping the `roster-branch-not-chosen` check, dropping the `observer-only` keep, and letting the deputy always choose each failed one test (15 of 16 passing each time).
- The rule for a lead whose devices are all revoked uses `devicesOfMemberAt` from the members module; `device.revoke` is 31-14's in this wave, so it is tested end to end in 31-20 as planned.
- Residual (accepted by owner decision 5, T-31-54): if the lead is lost while a split at the head is pending, and the lead still has an active device on the roster, nobody can resolve the split, because the deputy's handover and any device revocation would only add a branch. Re-founding stays the last resort. A future option is to let the deputy choose a branch that is its own `lead.handover` with reason `lead-lost`; that is an owner decision, not taken here.

## Test Results

All runs under the shared flock lock and `systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 timeout ... NODE_OPTIONS=--max-old-space-size=1536`, compiling with `node scripts/vendor-libs.mjs && tsc -p tsconfig.json` (exit 0).

| Run | Tests | Pass | Fail |
|-----|-------|------|------|
| Task 1 RED: replicaRosterSplit, replicaRosterTracer | 13 | 10 | 3 |
| Task 1 GREEN and gate re-run: same files | 13 | 13 | 0 |
| Task 2 RED: replicaRosterSplit | 8 | 3 | 5 |
| Task 2 GREEN: replicaRosterSplit, replicaRosterTracer | 18 | 18 | 0 |
| Task 3: replicaRosterSplit, replicaRosterTracer, replicaEntry, replicaReevaluation, replicaContracts | 74 | 74 | 0 |
| Final: every `dist/test/replica*.test.js` and `staffReplica*.test.js` | 492 | 492 | 0 |

The full `npm test` was not run (the orchestrator runs it at the end).

Acceptance greps: `deputy-cannot-name-deputy` in roster.ts 2; `handover-not-allowed` in roster.ts 2; `test('15.1 ` in the split test 2; `roster-branch-not-chosen` in verify.ts 2; the split sentence in roster.ts exactly 1; replicaRosterSplit has 16 tests; no em-dash in any changed file.

## Known Stubs

None. `applyOne` still answers `roster-kind-pending` for a `roster.choose` that reaches it, which cannot happen: the driver decides every choice at the split point.

## Threat Flags

None beyond the plan's register. T-31-54 (deputy handover only with lead-lost, deputy choice only when the lead has no active device, deputy cannot name a deputy; tested), T-31-55 (both branches pending, nothing applies until a signed choice, entries citing an unchosen branch held and kept; tested in every delivery order), T-31-56 (authority at the cited roster across a deputy change and a handover, in the roster fold and in the main fold; tested) and T-31-SC (no package installed) are mitigated. No new endpoint, file access or network path.

## Self-Check: PASSED

- FOUND: src/test/replicaRosterSplit.test.ts, src/domain/replica/roster.ts, src/domain/replica/verify.ts, src/test/replicaRosterTracer.test.ts
- FOUND: commits ea1c527d, 7dc8ba72, 7e907d84 are ancestors of HEAD
