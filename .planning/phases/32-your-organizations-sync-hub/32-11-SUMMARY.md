---
phase: 32-your-organizations-sync-hub
plan: 11
subsystem: staff replica (Make a Single-Machine Copy and the staff host over held cells)
status: complete
tags: [replica, single-machine-copy, cells, labels, clearance, staff-host, D-20, D-22, D-23, MUS-05, MUS-06]
requires: [32-03, 32-05, 32-09, 32-10]
provides:
  - "singleCopy.ts: NOT_CLEARED_PARTS_TEXT; importedDrafts (whole import when held, otherwise each held cell import that verifies); lacksACell (heldCells against the roster's cells at head); LEFT_REASONS"
  - "staffHost.ts: the shared-mode comment for several cells (no behaviour change)"
affects: [32-12]
tech-stack:
  added: []
  patterns:
    - "each imported product's lines are taken only from the import the projection shows it from (state.imported.entry), then sorted by seq"
key-files:
  created: []
  modified:
    - src/staff/replica/singleCopy.ts
    - src/staff/staffHost.ts
    - src/test/staffReplicaCopy.test.ts
    - src/test/staffReplicaHostMode.test.ts
decisions:
  - "The host needed no code change. The tracer found no gap: on the merged wave 4 code a member's StaffHost already lists exactly the held cells' products, so only the comment changed"
  - "A cell is missing when the roster at head gives it an epoch (epochAt) and heldCells() does not list it. The notice is one fixed sentence after the D-13 lines and names no cell and no count"
  - "Each imported product's lines are read only from the import the projection shows that product from (ProjectedProductState.imported.entry). A second cell import that verifies but is not that import is never read, so no line is carried twice"
  - "A cell import whose file does not match its hash, or that replayScopedImport refuses, goes into left as ledger 'products', with the same sentences verifiedImport already used. They are now one LEFT_REASONS table, word for word as before"
  - "When the whole import is held but does not replay, the copy behaves as before: nothing is imported, nothing is listed in left, and there is no fallback to cell imports. This matches 32-10's projection"
  - "Defaults of 32-CONTEXT.md taken as accepted; the plan has no checkpoint. The tracer gate passed on the automated verify"
metrics:
  duration: "about 50 minutes"
  completed: 2026-11-20
estimate:
  tokens: 65034
  tasks: 2
actuals:
  tokens: 8438
  tasks: 2
  commits: 2
plan_head_before: 7a065afbaae6b715a04c741da67836e1b85feed3
plan_head_after: 60f2956b14f14a74ffff44585e1aabe8efe4fa77
---

# Phase 32 Plan 11: Host and copy over the cells a device holds Summary

Make a Single-Machine Copy now carries every cell this device holds. Imported products come from the whole product ledger when it is held, otherwise from each held cell import that verifies. The decision log, calculator and wargame ledgers come across only when their whole import is held. When the roster names a cell this device holds no key for, the notices end with "Parts of this project you are not cleared for were not copied." The staff host already showed exactly the held cells, and new tests now prove it on the lead and on a member.

## What was built

**singleCopy.ts**
- `NOT_CLEARED_PARTS_TEXT`, exported. `makeSingleMachineCopy` adds it after `multiUserNoticeLines()` when `lacksACell(project)` is true. That check is true when the roster at head has a cell with an epoch that `heldCells()` does not list.
- `importedDrafts(input, shown, left)`:
  - It maps each product the projection shows as imported to its `imported.entry`.
  - With a whole import (`importOf`), it reads that import, but only when `projectImportedLedger` holds, as before.
  - Without one, it reads each `scopedImportsOf` record:
    - a record whose file does not match its hash goes to `left`;
    - a record that `replayScopedImport` refuses goes to `left`;
    - every other record is read.
  - From each import read, only the lines of products shown from that same import are kept. All kept lines are sorted by their original seq.
- `productDrafts` takes `left` and uses `importedDrafts`. The fold path is unchanged, so a product whose only import failed is carried from the fold.
- `verifiedImport` still reads whole imports only. A ledger whose import sits in a cell this device does not hold is absent, never reported as broken.
- The `left` reasons are now one `LEFT_REASONS` table, with the same sentences as before.
- The file comment covers held cells and preview projects.

**staffHost.ts**: the shared-mode comment now says:
- the fold folds every cell this device holds;
- the shared read shows each cell's products with their own labels (all of them on the lead's machine);
- nothing of a cell this device does not hold reaches a status, list or replay text (D-23).

There is no behaviour change.

**Tests**: the stale "(W-1)" comment in both test files now says the org/Public product goes into the org/Public cell, which the lead's org/Internal clearance covers.

## Verification

All runs used the memory cap wrapper and the shared focused lock.

- Task 1 verify (staffReplicaHostMode, staffReplicaCopy): **42 tests, 42 pass, 0 fail**.
- Task 2 verify (staffReplicaCopy, staffReplicaHostMode, staffReplicaProjection, staffMultiUserCommands), then `npm run lint`: **129 tests, 129 pass, 0 fail, lint clean**.
- Acceptance greps: `NOT_CLEARED_PARTS_TEXT` in singleCopy.ts 3 (at least 2); `scopedImportsOf` in singleCopy.ts 2 (at least 1).
- Test names: "not cleared" (in both files), "cell import" and "preview" (copy).

### New tests

**staffReplicaHostMode**
1. "not cleared": on the lead, the shared read lists both products, with "Label: org/Public." and "Label: org/Internal.". Member M is cleared for org/Public and given the base and org/Public streams. M's host lists the concept of operations alone, and its state equals the lead's (imported marker aside). No text M reads holds "estimate", "org/Internal" or the canary phrase "Northwind ford crossing". The texts searched are the replay, list, status of each product, registry, decision queue and ledger problem.
2. A member cleared for org/Internal holding both label cells lists both products as the lead sees them.

**staffReplicaCopy**
1. "not cleared" for member M (org/Public):
   - the copy holds only the concept of operations, with the lead's state, hash, approvals and history events, and today's verifier passes it;
   - its notices are the D-13 lines plus NOT_CLEARED_PARTS_TEXT, and `left` is empty;
   - no file name or byte in the copy, and nothing in the result, holds "estimate", "org/Internal" or the canary.
2. "not cleared" for the lead: the copy holds both products, the decision log and the calculator ledger, with no notice.
3. "cell import": a member holding the org/Public and org/Internal cells but not the legacy cell.
   - Both products come from the two cell imports, with the lead's history. The approvals are carried under the copier's name.
   - The calculator ledger is carried; the decision log is not, and is not listed in `left`.
   - The not-cleared notice is shown.
4. "cell import that does not verify": the lead writes two extra imports into the org/Internal cell with appendOwn.
   - One import holds the estimate's lines with one changed byte under a signature. It is listed in `left` with "its imported entries do not verify, so it was not carried".
   - The other holds the estimate's first line alone and verifies, but it is not the import the projection shows the estimate from. It is never read: `differs` is empty and the history equals the lead's.
   - The copy verifies, and nothing of the changed import is in it. The lead's copy has an empty `left`.
5. "preview": a project whose products sit in the base cell is copied as before, with the same files and carried count, no notice and an empty `left`, both on the copier and on the lead.

### Failing first

The tests were written and run on the unchanged wave 4 code: **42 tests, 39 pass, 3 fail**.

| Test | How it failed |
| --- | --- |
| not cleared (member M's copy) | The products were `[]`, not `[concept-of-operations]`: the copy carried nothing imported |
| cell import | The products were `[]`, not both products |
| cell import that does not verify | `left` was `[]` |

Some new tests passed on the old code, as the plan expected:
- both host tests, because the host had no gap;
- the lead and preview copies, because they guard against regressions.

The mutations below prove that each of these can fail.

### Mutation proofs (D-66; compiled JS changed, both suites run, file restored and its sha256 compared)

| Mutation | Tests that failed |
| --- | --- |
| M1 the notice is never added | 2: not cleared (member copy), cell import |
| M2 the notice is always added | 3: the lead copy, preview, and the four-ledgers host test (its notices) |
| M3 replayScopedImport check off in the copy | 1: cell import that does not verify |
| M4 import identity check off (any import's lines for an imported product) | 1: cell import that does not verify (the verifying partial import is read too) |
| M5 the copy reads no cell import | 3: not cleared (member copy), cell import, cell import that does not verify |
| M6 the projection reads no cell import (the host path) | 5: both host tests and three copy tests |

## Deviations from Plan

1. **[Rule 2, test strength] A third import was added to the "does not verify" test.** It verifies but is not the one the projection shows the estimate from. Without it, nothing would test the check that each product's lines come only from its own import (M4 passed before it was added).
2. **[Plan wording] "its products are carried from the fold only".** The changed import in the test holds the estimate's lines. The estimate is still shown, and carried, from its genuine org/Internal import, because its version cites that import. So the test asserts that nothing of the changed import is carried and that the copy verifies. A product whose only import fails is not shown as imported by the projection, so `productDrafts` carries it from the fold, as it does for any product the fold made.
3. **[Plan wording] Branch name.** The plan names `feat/phase-32-11-held-cells`. The orchestrator made `feat/phase-32-11-host-copy-all-cells`, and that branch was used.
4. **Commits.** There are two: the tests first (RED), then the implementation. Both tasks share singleCopy.ts and staffReplicaCopy.test.ts.

Files touched: only the four in the plan's files_modified, plus this summary. staffMultiUserCommands.ts, its test, staffReplicaLabelLeak.test.ts, SECURITY.md and CHANGELOG.md (32-12 and 32-13) were not touched.

## Known limits

- The notice counts a cell as held when this device holds any epoch of it that `heldCells()` lists. A device that holds only an older epoch of a cell (for example, one removed from it after a rekey) gets no notice for the newer entries it cannot open.
- The copy command shows the new notice only through 32-12's change to the copy command.
- When the whole import is held but does not replay, nothing is imported and `left` says nothing, as before this plan.

## Known Stubs

None.

## Threat Flags

None beyond the register:
- **T-32-213:** the copy and the host are built only from held cells. A canary search covers every host text a member reads (host test 1) and every file name and byte of the copy and the result (copy test 1).
- **T-32-214:** the notice is one fixed sentence with no names or counts (copy test 1 asserts it word for word).
- **T-32-215:** a changed cell import is refused by replayScopedImport and listed in `left` (copy test 4, M3).
- **T-32-SC:** no package was installed.

## Self-Check: PASSED

- FOUND: src/staff/replica/singleCopy.ts, src/staff/staffHost.ts, src/test/staffReplicaCopy.test.ts, src/test/staffReplicaHostMode.test.ts
- FOUND: d1e55564, 60f2956b (ancestors of HEAD)
