---
phase: 32-your-organizations-sync-hub
plan: 03
subsystem: staff/replica (Make a Single-Machine Copy)
status: complete
tags: [single-machine-copy, head-mark, crash-safety, D-07, D-65, MUS-06]
requires: []
provides:
  - "stageCopy and placeCopy (writeStaged split in two) in src/staff/replica/singleCopy.ts"
  - "setCopyProbe and CopyProbe (tests only), probe point 'mark-stored'"
  - "COPY_REFUSALS['unmarked-copy'] and its check in destinationProblem"
affects:
  - "32-11 changes the same two files in wave 4"
  - "src/services/staffMultiUserCommands.ts shows COPY_REFUSALS (wording of not-shared and project-refused changed; no code change there)"
tech-stack:
  added: []
  patterns: ["test probe like setCasProbe", "compare-before-remove on a secret"]
key-files:
  created: []
  modified:
    - src/staff/replica/singleCopy.ts
    - src/test/staffReplicaCopy.test.ts
decisions:
  - "The mark is stored after stageCopy and before placeCopy; a failed placeCopy takes it back only while secret storage still holds this run's exact text. Errors while taking it back are swallowed so the error that stopped the copy is the one shown."
  - "unmarked-copy is checked before destination-has-staff-files and only when <destination>/.planning/staff/ledger/products.jsonl exists with no secret under ledgerHeadKey(destination) (D-65: the refusal lives in the copy flow, not in today's host)."
  - "not-shared and project-refused gained a closing next step so every COPY_REFUSALS sentence ends with what to do next; not-shared ends with the exact REFUSAL_NEXT_STEPS['not-shared'] text so the command layer does not repeat it."
metrics:
  duration: "about 45 minutes"
  completed: 2026-11-20
actuals:
  tokens: 5578
  tasks: 2
  commits: 3
plan_head_before: ffddff863527f3bdb581bc908442b161c3804871
plan_head_after: e8815b2d
---

# Phase 32 Plan 03: Copy mark before rename Summary

A single-machine copy now stores its signed head mark after every file is staged and before the staging folder is renamed to `.planning/staff`. If the rename fails the mark is taken back, but only while it is still this run's mark. A copy that an older version left in place without a mark is refused `unmarked-copy`, with nothing written.

## What changed

- `src/staff/replica/singleCopy.ts`
  - `writeStaged` is split into `stageCopy(destination, files)` (staging folder and every file) and `placeCopy(destination, staging)` (the existence check and the rename).
  - `makeSingleMachineCopy` runs: stageCopy, then signs and stores the mark (when the ledger has entries) and keeps the exact text, then `probe?.('mark-stored', target)` outside any catch, then placeCopy in a try. Its catch calls `takeBackMark`, which deletes the key only when `secrets.get(key)` equals the stored text, and then rethrows.
  - `setCopyProbe` / `CopyProbe` are for tests only, like `setCasProbe`.
  - `COPY_REFUSALS['unmarked-copy']` uses the plan's wording. `destinationProblem(sharedRoot, destination, secrets)` refuses it before `destination-has-staff-files` when the product ledger file exists and no mark is stored under `ledgerHeadKey(destination)`.
  - `not-shared` and `project-refused` now end with a next step. The file comment now covers the mark order, and "No file is ever deleted" replaces "Nothing is ever deleted", because a mark can now be taken back.
- `src/test/staffReplicaCopy.test.ts`: 8 new tests (19 in the file, up from 11):
  1. mark store fails: copy not in place, one staging folder kept, no mark
  2. placing fails after the mark: folder-appeared error, mark taken back, staging kept
  3. compare before remove: another run's mark is left in place
  4. happy path order: at the probe the mark exists and `.planning/staff` does not
  5. a stop between the mark and the rename leaves the mark, the staging folder and no staff project; copying again with a later clock succeeds, the new mark replaces the stale one, the replay has no break, the first staging folder is kept and the second run leaves none
  6. an older version's leftover is refused `unmarked-copy` with nothing written (no file, no secret)
  7. a finished copy with its mark, and a staff folder with no product ledger, are both still refused `destination-has-staff-files`
  8. every COPY_REFUSALS sentence: no em-dash, says nothing was written, and its last sentence starts with Choose, Make or Open

## Verification

- Final run: `staffReplicaCopy.test.js` and `staffMultiUserCommands.test.js` gave 47 tests, 47 passed, 0 failed. `npm run lint` exited 0. All runs used the memory cap.
- Acceptance checks: `grep -c placeCopy` = 2, and `grep -c "'unmarked-copy'"` = 2.

### Tests failing first

- Task 1, before any change to the code: the "mark store fails" test failed with `AssertionError: a copy without its mark is never in place` (12 tests, 11 passed, 1 failed).
- Task 2, run on the Task 1 code: the leftover test failed (`actual: 'destination-has-staff-files', expected: 'unmarked-copy'`). The refusal-sentence test also failed, on `not-shared` ending without a next step (19 tests, 17 passed, 2 failed). tsc reported the expected missing-key type errors but still emitted the JavaScript.
- The probe tests (2 to 5) need `setCopyProbe`, which did not exist before the change, so D-66 mutations prove they can fail. Each mutation was applied to a copy of singleCopy.ts and the file was restored after each run:
  - `no-takeback` (catch no longer takes back the mark): 1 failure
  - `no-compare` (takes back the mark without comparing): 1 failure
  - `old-order` (mark stored after placeCopy): 4 failures (tests 1, 2, 4 and 5)
  - `no-unmarked` (unmarked-copy check removed): 1 failure

## Deviations from Plan

**1. [Rule 2 - Missing critical functionality] Two refusal sentences had no next step**
- **Found during:** Task 2, by the plan's own "every COPY_REFUSALS sentence says what to do next" behavior.
- **Issue:** `not-shared` and `project-refused` did not say what to do next. Only the command layer's `shownRefusal` added a step.
- **Fix:** gave each a closing next step. `not-shared` reuses the command's existing step text, so nothing is shown twice.
- **Files:** src/staff/replica/singleCopy.ts. **Commit:** d3a450d7

**2. Branch name:** the plan names `feat/phase-32-03-copy-mark-first`. The orchestrator created `feat/phase-32-03-copy-mark-before-rename`, and that branch was used.

No file outside the plan's list was touched.

## Threat model

- T-32-08 is mitigated: the mark goes in before the rename (tests 1, 4, 5), and an unmarked copy is refused (test 6).
- T-32-09 is mitigated: the mark is removed only on an exact match (test 3).
- T-32-SC: no package was installed.

## Self-Check: PASSED

- src/staff/replica/singleCopy.ts and src/test/staffReplicaCopy.test.ts exist.
- Commits 6b205b74, d3a450d7 and e8815b2d are on the branch.
