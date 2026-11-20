---
phase: 32-your-organizations-sync-hub
plan: 08
subsystem: replica (pure domain rules for products in several cells)
status: complete
tags: [replica, cells, pins, project-import, labels, hub]
requires: []
provides:
  - "productCells.ts: PRODUCT_CELL_REFUSALS, PinCandidate, pinProblem, DEFAULT_PRODUCT_LABEL, BASE_CELL_KINDS, baseCellAllows, baseCellHeldProducts, PREVIEW_WAY_FORWARD_TEXT, importScopeOf, labelText, labelFromText, sameLabel, legacyCellLabel, readLegacyCellLabel"
  - "versions.ts: pin-above-cell refusal in checkProposal"
  - "project.import scope (whole or cell) and lines, listed by the project fold"
affects: [32-09, 32-10, 32-12, 32-13, 32-24]
tech-stack:
  added: []
  patterns: ["one pure rule shared by the fold and the host", "unknown counts as above so machines holding different cells agree"]
key-files:
  created:
    - src/domain/replica/productCells.ts
    - src/test/replicaProductCells.test.ts
  modified:
    - src/domain/replica/versions.ts
    - src/domain/replica/projectFold.ts
    - src/domain/replica/kindSchemas/project.ts
    - src/test/replicaKinds.test.ts
decisions:
  - "The pin check runs first in checkProposal, only when ctx.cellOrder is set and the proposal has pins, so a refused pin counts against the proposal cap and no blob is opened"
  - "labelText form: scale/level, then //COMPARTMENTS joined by '/', then //REL and the releasability joined by ', ', each list sorted; handling flags are not in the text"
  - "labelFromText reads only scale/level text (the staff ledger form) into a label with empty token lists"
  - "readLegacyCellLabel accepts exactly { legacy: 1, labels } (0 to 256 labels the scales know) and returns the normalised sorted set"
  - "ProjectImport.scope is always set ('whole' when absent); lines is listed only on a cell import; imports sort by ledger, head, count, then whole before cell"
metrics:
  duration: "about 45 minutes"
  completed: 2026-11-20
estimate:
  tokens: 60031
  tasks: 2
actuals:
  tokens: 12870
  tasks: 2
  commits: 3
plan_head_before: ffddff86
plan_head_after: 3311be5b
---

# Phase 32 Plan 08: Product cell rules Summary

Pure rules for products kept in several cells: a version may pin only products at its own label or below (pin-above-cell, decided by one function the fold and the host share), a project.import can carry one cell's part of a ledger, and a 0.4.35 preview project (products in the base cell) can be told apart with baseCellHeldProducts.

## What was built

**Task 1 (tracer): pin-above-cell** (commit 295cf0c6)
- `src/domain/replica/productCells.ts`: `PRODUCT_CELL_REFUSALS` (the plan's sentence), `PinCandidate`, `CellOrder`, and `pinProblem(own, pins, candidates, cellOrder?)`. With no cell order it returns undefined. With one, each pin needs a candidate of that product name that holds the pinned hash and is in the own stream or a stream `cellOrder(own, stream)` allows. A pin nothing can place counts as above (D-67).
- `src/domain/replica/versions.ts`: `VERSION_REFUSALS` spreads in `PRODUCT_CELL_REFUSALS`. `checkProposal` now takes the state, builds candidates from `state.products` (stream, product, accepted version hashes) and refuses `pin-above-cell` before any blob is read. fold.ts is not touched.

**Task 2: scoped imports, base cell and label helpers** (commit 3311be5b)
- `kindSchemas/project.ts`: `IMPORT_SCOPES`, `ImportScope`. project.import takes optional `scope` (whole or cell) and `lines` (a count). A cell import needs file and lines and refuses mark. lines without scope cell is refused. Each refusal names the field.
- `projectFold.ts`: `ProjectImport` gains `scope` ('whole' when absent) and `lines?`. The repeat key adds scope. copyImport copies both. The canonical (digest) tuple stays ledger, legacy head, count, entry, so no digest moved (replicaVectors passes unchanged).
- `productCells.ts`: `DEFAULT_PRODUCT_LABEL` ('org/Internal'), `BASE_CELL_KINDS` (project.genesis plus every roster and integrity kind) and `baseCellAllows`, `baseCellHeldProducts(fold or versions output, base)`, `PREVIEW_WAY_FORWARD_TEXT` (the D-22 sentence word for word), `importScopeOf`, `labelText`, `labelFromText`, `sameLabel`, `legacyCellLabel`, `readLegacyCellLabel`, `MAX_LEGACY_LABELS`. The closed kind list stays at 51.

## Verification

- Task 1 run: replicaProductCells, replicaVersions, replicaVersionDecisions: 58 tests, 58 pass.
- Task 2 run (the plan's whole replica list: ProductCells, Kinds, Tracer, Versions, VersionDecisions, ForbiddenActs, Convergence, Vectors, Contracts, Integration, CellLeak, Boundaries) followed by `npm run lint`: 167 tests, 167 pass, lint clean, exit 0.
- Extra consumer checks: staffReplicaMigration and gateRouteGuard (55 pass), codePushLater and replicaReevaluation (27 pass).
- All runs were under the memory cap wrapper with the shared focused lock.

### Failing-first evidence

- Task 1: on unchanged code the new test file failed to compile (TS2307 cannot find module '../domain/replica/productCells'; TS7053 'pin-above-cell' is not a key of VERSION_REFUSALS).
- Task 1 teeth (D-66 mutation): with the built check disabled (`if (problem !== undefined && false)` in dist versions.js, restored afterwards), 3 of the 4 tests failed: the tracer, the unknown-hash case and the incomparable-cell case. The pure pinProblem unit test passed, as it does not go through versions.ts.
- Task 2: on unchanged code the test file failed to compile (TS2305 for each missing export; TS2339 `scope` and `lines` do not exist on ProjectImport). The updated replicaKinds assertion (`scope: 'whole'` on the listed import) would also fail on unchanged code.

## Acceptance criteria

- replicaProductCells.test.js has 12 tests, names including "pin-above-cell" and "baseCellHeldProducts".
- `grep -c pinProblem src/domain/replica/versions.ts` = 2.
- `grep -c scope src/domain/replica/kindSchemas/project.ts` = 6.
- `grep -c baseCellHeldProducts src/domain/replica/productCells.ts` = 1.
- replicaVectors passes unchanged.

## Deviations from Plan

**1. [Rule 1, test accuracy] Renamed one of my own new tests before committing.** I had named a test "a refused proposal still counts against the writer cap", but the test did not check that. I renamed it to describe what it does check: an incomparable cell cannot be pinned. The cap behaviour comes from the existing code path (the pin check is inside checkProposal, so a refusal counts), as the plan asked.

**2. [Plan wording] Held entries in baseCellHeldProducts.** The plan names "a doc.update held missing-key". In a real fold a chain-stage missing-key hold carries no family, because the body cannot be opened. A held entry counts only when it carries a versions or doc family. So the missing-key case is tested in the structural form (`{ held: [{ stream: base, family: 'doc' }] }`). Real-fold holds are tested with a product.owner held product-unknown and a doc.update held unregistered-client.

No other deviations. Only the six files in the plan's files_modified list were touched.

## Decisions

- Every default in 32-CONTEXT.md was taken as accepted, as the brief says. This plan had no checkpoints.
- The text format choices are listed in the frontmatter decisions. 32-09, 32-10 and 32-24 consume labelText, labelFromText and readLegacyCellLabel, so these formats are now fixed.

## Known limits (for 32-24)

- baseCellHeldProducts reads `families.versions`, `families.doc` and `held`. Refused and kept entries are not seen, because FoldResult gives them no stream. A product whose product.create was refused but whose text was written still shows in `families.doc`. A preview project only answers false if every one of its product entries was refused or kept, which the 0.4.35 host never produced. If 32-24 wants this closed fully, it can also check base-stream entries by kind with baseCellAllows (32-10 and 32-13 already do this when they open base entries).

## Known Stubs

None.

## Threat Flags

None. The new surface is covered by the plan's threat register: T-32-200 (pinProblem in the fold, unknown counts as above), T-32-201 (baseCellHeldProducts, with the limit above), T-32-202 (canonical tuple unchanged, replicaVectors unchanged).

## Self-Check: PASSED

- FOUND: src/domain/replica/productCells.ts
- FOUND: src/test/replicaProductCells.test.ts
- FOUND: .planning/phases/32-your-organizations-sync-hub/32-08-SUMMARY.md
- FOUND: 295cf0c6, 3311be5b (ancestors of HEAD)
