---
phase: 32-your-organizations-sync-hub
plan: 10
subsystem: staff replica (Make Multi-User into label cells; projection over held cells)
status: complete
tags: [replica, migration, cells, labels, clearance, legacy, projection, D-15, D-16, D-17, D-18, D-19, D-20, D-21, D-22, D-23]
requires: [32-03, 32-05, 32-06, 32-08, 32-09]
provides:
  - "migrate.ts: MIGRATION_STEPS with cells; MigrationOptions.leadClearance and scales; MigrationResult.cells, scoped and unversioned; verifyLegacyLedgers(root, deps, options) returning labels; refusal not-cleared-for-label (with labels); neededLabels; VerifyOptions, VerifiedLedgers, MigrationCell, ScopedLedger, UnversionedProduct"
  - "projection.ts: importOf (whole only), scopedImportsOf, ScopedImport, replayScopedImport, ProjectionInput.cellLabels, PROJECTION_PROBLEMS['label-mismatch']"
  - "projectionInputOf fills cellLabels from cellLabelTexts(project)"
affects: [32-11, 32-12, 32-13, 32-24]
tech-stack:
  added: []
  patterns:
    - "every import looked up by ledger, scope and stream before it is sealed"
    - "a cell import is a byte-for-byte subset of the ledger's lines, each line verified on its own, seqs strictly rising"
key-files:
  created: []
  modified:
    - src/staff/replica/migrate.ts
    - src/staff/replica/projection.ts
    - src/test/staffReplicaMigration.test.ts
    - src/test/staffReplicaProjection.test.ts
    - src/test/staffReplicaCopy.test.ts
    - src/test/staffReplicaHostMode.test.ts
decisions:
  - "The lead's clearance is written with membership updateMember (not a bare appendOwn), so a raised or lowered clearance takes the same rekey path as every other change; it is compared canonically and skipped when equal, so a resumed run writes no second member.update"
  - "Whole imports now carry scope 'whole' explicitly (the plan's wording); Phase 31 imports with no scope still read as whole"
  - "verify's not-cleared-for-label message: the refusal sentence, then per label NOT_CLEARED_TEXT(label) and 'Products with that label: <names>.' (ten named, then ', and N more'); a label needed only by the calculator or wargame ledger says 'No product has that label: the calculator or wargame ledger of this project is kept at it.' The refusal also carries labels (the uncovered label texts) for 32-12"
  - "The no-clearance rule (D-68) and the clearance rule are the ones labelCells.ts uses: sameLabel with org/Public, or membership clearedFor; a label the scales do not know is never covered"
  - "The legacy cell is made for the set of product labels (not org/Internal for the calculator, which is not in it); it is made when the product ledger or the decision log is present, with an empty set when only the decision log is"
  - "unversioned lists only pin-above-cell (the plan's case); a product whose text is unknown or too large stays live-text-only as before and is not listed"
  - "replayScopedImport also refuses a seq at or above the whole ledger's count, and returns entries = its own line count with the whole ledger's head"
  - "When the whole import is held but does not replay, the projection shows no imported history (as before) rather than falling back to cell imports"
  - "Defaults of 32-CONTEXT.md taken as accepted; the plan has no checkpoint. The tracer gate passed on the automated verify."
metrics:
  duration: "about 70 minutes"
  completed: 2026-11-20
estimate:
  tokens: 95049
  tasks: 3
actuals:
  tokens: 17036
  tasks: 3
  commits: 4
plan_head_before: 88c75dc9757acc0f290eb0e2cb730264f891b327
plan_head_after: 4478c959
---

# Phase 32 Plan 10: Make Multi-User converts labelled projects into label cells Summary

Make This Staff Project Multi-User now puts every product into the cell for its label, keeps the whole product ledger and decision log in the lead-only legacy cell, gives each label cell a products import holding only its own products' lines, refuses only the labels the lead's declared clearance does not cover (D-19 sentence per label, naming its products), and the projection shows exactly the products of the cells a machine holds.

## What was built

**migrate.ts**
- Steps: verify, genesis, cells, import, reconstruct, move-legacy, projections, complete.
- verify (`verifyLegacyLedgers(root, deps, { leadClearance?, scales?, now? })`): the label-above-base check is gone (D-21). It computes the labels needed (each product's label, plus org/Internal when a calculator or wargame ledger is present, sorted) and refuses `not-cleared-for-label` for every label the declared clearance does not cover (none declared: only org/Public, D-68). It returns `labels`. `BASE_CELL_LABEL` stays exported, now documented as the base cell's label for the roster only.
- cells: writes the lead's declared clearance through `updateMember` when it differs, then `ensureLabelCell` per needed label and `ensureLegacyCell(product labels)` when the product ledger or decision log is present. Each cell is reused when held, so a resumed run makes no second `cell.create`.
- import (D-20): the whole product ledger (file, mark, scope whole) and decision log go into the legacy cell. The calculator and wargame ledgers go whole into the org/Internal cell. Each label cell with products gets a `scope: 'cell'` products import with only its products' lines (byte for byte, joined by newlines and ending with one), `lines`, and the whole ledger's head and count. Each import is looked up by ledger, scope and stream before it is sealed. Nothing goes into the base cell.
- reconstruct: each product goes into its cell through `appendProductEntry` and `proposeVersion`, citing that cell's import (the version also cites each pinned version entry). The lead's role change is a roster entry with no deps. A dependency whose label the product's label does not cover gives no version, and the product is listed in `unversioned` with `pin-above-cell` (D-18). This is decided before anything is written.
- `MigrationResult` gains `cells`, `scoped` and `unversioned`. `imported` still has one item per ledger (the whole import), so the command's ledger count is unchanged.
- `projectionInputOf` adds `cellLabels` from `cellLabelTexts(project)`.

**projection.ts**
- `importOf` returns whole imports only. `scopedImportsOf(fold, ledger)` lists cell imports with their stream.
- `replayScopedImport(record, bytes)` refuses the import when:
  - the file hash does not match;
  - the line count is not `lines`;
  - a line fails its signature (verified with `AS_VERIFIED_AT_IMPORT`) or does not parse;
  - a person's step is not signed by that person's own key;
  - the seqs do not strictly rise, or a seq is past the whole count.
  
  Otherwise it applies each product's lines with today's `apply()`.
- `overlayImported` uses the whole import when this machine holds it. Otherwise it uses each cell import, which shows only its own products and vouches through its own entry. `onlyImported` accepts a version citing any import of the ledger, so the lead's view is the same as before.
- `cellLabels`: the fallback meta label is the cell's label (scale/level) when known, else `DEFAULT_PRODUCT_LABEL`. A product in a named cell whose label is not the cell's is tampered with `label-mismatch` and sends no events. Base cell products (preview projects) are never checked.

## Verification

All runs used the memory cap wrapper and the shared focused lock.

- Plan verify (Task 3 set): staffReplicaProjection, staffReplicaMigration, staffReplicaCopy, staffReplicaHostMode, staffMultiUserCommands, staffReplicaLabelCells, then `npm run lint`: **176 tests, 176 pass, 0 fail, lint exit 0**.
- Neighbours: staffReplicaParity, staffReplicaProject, staffReplicaMembership, replicaProductCells (76 pass), replicaDoc (36 pass).
- staffReplicaCopy and staffReplicaHostMode pass with only `leadClearance` org/Internal added to their `makeMultiUser` calls.
- Acceptance greps: `ensureLabelCell` in migrate.ts 2, `'cells'` in migrate.ts 2, `scopedImportsOf` in projection.ts 4. Test names include "label cells", "not-cleared-for-label", "interrupted after cells", "legacy cell", "scoped import", "preview" and "label-mismatch".

### Failing first

The tests were written and run on the unchanged code before any implementation. The run gave TS errors for the missing `cells`, `scoped`, `unversioned`, `leadClearance`, `not-cleared-for-label`, `replayScopedImport` and `scopedImportsOf`. tsc still emitted the JS. **123 tests, 91 pass, 32 fail.** The 32 failures were every rewritten or new migration test (the full template now holds an org/Internal product, which the old code refused as label-above-base) and the five new projection tests. Copy and host mode passed on the old code, as expected (they only gained an option).

### Mutation proofs (D-66; compiled JS changed, run, restored byte for byte)

| Mutation | Tests that failed |
| --- | --- |
| M1 scoped seq check removed | 1: scoped import refusals (products' lines out of ledger order) |
| M2 scoped signature check removed (payload read without its verdict) | 1: scoped import refusals (an agent line with its time changed) |
| M3 scoped line count check removed | 1: scoped import refusals |
| M4 importOf takes cell imports | 4: member view from cell imports, importOf/scopedImportsOf, projected replay, MJ-09 race |
| M5 cell label check off | 1: label-mismatch |
| M6 fallback ignores the cell label | 1: label-mismatch fallback |
| M7 pin label check off | 1: pins across cells |
| M8 D-19 check off (covers always true) | 3: both not-cleared-for-label tests, verify labels |
| M9 import lookup ignores the stream | 12: all four ledgers, every interruption test, and others |
| M10 lead clearance written every run | 6: five interruption tests and MJ-09 rerun |

M1 and M2 passed at first. Their subcases were caught by `apply()` or by `parseLedgerEntry(undefined)` instead of the check under test. The test now uses a reorder that keeps each product's own order (two products one after the other) and forges an agent's line, so each check alone catches its case.

## Deviations from Plan

1. **[Rule 1, test accuracy] Two subcases of my own new scoped-import test were strengthened** before the final commit, after the mutation run showed other checks caught them (see above). No assertion was removed.
2. **[Plan wording] Branch name:** the plan names `feat/phase-32-10-convert-labelled`. The orchestrator made `feat/phase-32-10-migrate-label-cells`, and that branch was used.
3. **[Fixture] The full template's annex is now org/Internal** (it was org/Public). One template therefore covers the Task 1 tracer (an org/Public and an org/Internal product plus a calculator ledger) and the Task 2 pin across cells (annex org/Internal pins conops@1 org/Public). Tests that pinned Phase 31 placement were rewritten to assert exact cells, counts and refusal ids. For example, `importEntries` went from 4 to 6, and new checks assert one `cell.create` per label and the exact kind list including `cell.create`.
4. **Commits:** four, not one per task: tests first (RED), the projection, the conversion, and a follow-up that writes the em-dash checks as a unicode escape (backslash u2014) instead of the character. The three tasks share migrate.ts and the migration test.

Files touched: only the six in the plan's files_modified, plus this summary.

## Known limits

- The stale comment "Labelled org/Public: Make Multi-User refuses a product labelled above the base cell (W-1)" is left in staffReplicaCopy.test.ts, staffReplicaHostMode.test.ts and staffMultiUserCommands.test.ts. The plan says nothing else may change in the first two, and the third is not this plan's file. 32-11 and 32-12 own them next.
- The command (staffMultiUserCommands.ts, 32-12) does not pass `leadClearance` yet. Until it does, the command converts only all-org/Public projects with no calculator or wargame ledger. Anything else is refused not-cleared-for-label with the D-19 sentence.
- Suppose a conversion was interrupted under 0.4.34 after its import or reconstruct (base cell placement), then resumed on this code. It is refused project-refused (label-change or a base import left in place), not converted into cells. The way out is Start Again or a single-machine copy. There is no test for this case.
- When this machine holds the whole import but it does not replay, no imported history is shown. The projection does not fall back to the cell imports.

## Known Stubs

None.

## Threat Flags

None beyond the register:
- **T-32-209:** the whole files are only in the legacy cell. Cell imports carry only their own products' lines (tracer, member view, admission tests).
- **T-32-210:** every base cell entry, opened with the base key, is a BASE_CELL_KINDS kind (tracer).
- **T-32-211:** file hash, line count, per-line signatures and rising seqs (scoped import refusal test, M1 to M3).
- **T-32-SC:** no package was installed.

## Self-Check: PASSED

- FOUND: src/staff/replica/migrate.ts, src/staff/replica/projection.ts, src/test/staffReplicaMigration.test.ts, src/test/staffReplicaProjection.test.ts
- FOUND: 9e490435, fde80292, df64e8da, 4478c959 (ancestors of HEAD)
