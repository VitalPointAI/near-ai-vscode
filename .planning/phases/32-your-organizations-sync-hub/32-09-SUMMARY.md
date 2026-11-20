---
phase: 32-your-organizations-sync-hub
plan: 09
subsystem: staff replica (label cells on the host)
status: complete
tags: [replica, cells, labels, clearance, legacy, membership, D-15, D-19, D-20, D-23]
requires: [32-01, 32-04, 32-08]
provides:
  - "labelCells.ts: LABEL_CELL_REFUSALS, NOT_CLEARED_TEXT, labelCellOf, ensureLabelCell, ensureLegacyCell, productCellOf, appendProductEntry, proposeVersion, cellLabelTexts"
  - "ReplicaProject.heldCells() and ReplicaProject.findOwnAll(kind, predicate); HeldCell type"
  - "membership.ts exports: CellInfo, Change, Gate, gateOf, cellsAt, clearedFor, clearedDevices, writerProblem, headOf, append, LEGACY_GIVEN_TEXT; the legacy cell rule"
  - "src/test/helpers/labelCellWorld.ts: install, leadWith, bringIn, syncTo, grantsOn, streamEntries, orgLabel, orgClearance (for 32-10 to 32-13)"
affects: [32-10, 32-11, 32-12, 32-13, Phase 33]
tech-stack:
  added: []
  patterns:
    - "cell made in the writeRekeys order: key with grant hash, founding grant to this device only, cell.create, then one grant per cleared device"
    - "every refusal decided from the fold and roster at the head before the first write"
key-files:
  created:
    - src/staff/replica/labelCells.ts
    - src/test/staffReplicaLabelCells.test.ts
    - src/test/helpers/labelCellWorld.ts
  modified:
    - src/staff/replica/replicaProject.ts
    - src/staff/replica/membership.ts
decisions:
  - "ensureLabelCell checks D-19 first, then reuses a held cell of that label, and only then needs a roster writer: a member may write into a cell it already holds, and nobody reuses a cell their declared clearance no longer covers"
  - "Reusing a cell also gives every cleared person device that holds nothing of it its grants (when this device is a roster writer with the keys), so a run stopped after cell.create never leaves a cleared member without the cell"
  - "The stopAfter test seam throws, simulating a crash; it also has 'create' (stop after cell.create) for the case above"
  - "syncTo carries the grants of the base cell and of the named streams only, not every grant on disk, so a member below a cell never receives its founding grant (D-23) and its roster view answers cellGrantees undefined"
  - "product.create of a name this device folds in any other cell (the base cell included) is label-change"
  - "Labels are accepted as Phase 70 label values or as scale/level text; an unknown one is refused label-unknown"
  - "Host pin check uses project.context().cellOrder, or cellOrderHook with the host's scales when the project folds with none (stricter than the fold, never looser)"
  - "handOverLead's legacy grants name the roster the handover cites (the old lead is no longer a roster writer at the handover entry, so the fold would refuse a grant there); nameDeputy's name the deputy.name entry"
  - "giveLegacy gives nothing (and the role change stands) when this device does not hold the legacy keys"
metrics:
  duration: "about 20 minutes"
  completed: 2026-11-20
estimate:
  tokens: 85044
  tasks: 3
actuals:
  tokens: 23530
  tasks: 3
  commits: 2
plan_head_before: 1436653310d39a7b6eb30e4bece44c68953fa25c
plan_head_after: d416967375e8bfb14a6dd6b89eb1f2dafca9c5b2
---

# Phase 32 Plan 09: Label cells on the host Summary

A shared project now makes a cell for a label on demand, gives its key only to the person devices whose declared clearance covers the label (never a hub), writes each product into the cell for its label with every refusal decided before anything is written, and keeps the old ledgers in a legacy cell that only a cleared lead or deputy can hold.

## What was built

- `src/staff/replica/labelCells.ts` (host, Node only, no vscode):
  - `ensureLabelCell(shared, label, { stopAfter? })`: D-19 check (no declared clearance: org/Public only, D-68), reuse a held cell with that sealed label, else not-a-roster-writer / roster-split, then key with grant hash, founding grant wrapped to this device only with the label sealed, `cell.create` citing the head, then one `earlierEpochGrants` grant per other cleared person device at the `cell.create` roster.
  - `ensureLegacyCell(shared, labels)`: the same with `legacyCellLabel`; every label must pass the D-19 check; grants follow the legacy rule.
  - `appendProductEntry(shared, kind, data, { label?, deps?, actor? })`: product.create into the label's cell (org/Internal when none); other kinds into `productCellOf`. Refuses base-cell-products, label-change, pin-above-cell (for version.propose), product-unknown, not-cleared-for-label.
  - `proposeVersion(shared, { product, text, header, pins, snapshot, deps?, actor? })`: label-change on the header's scale/level, the pin check, the text and header sealed into a blob under the cell's current epoch key, `version.propose` citing the deps and each pinned version entry.
  - `labelCellOf`, `productCellOf`, `cellLabelTexts` (held label cells only, never the base or legacy cell).
  - `LABEL_CELL_REFUSALS` and `NOT_CLEARED_TEXT(label)` (the D-19 sentence, word for word, once in the file).
- `replicaProject.ts`: `heldCells()` (cells at head with a held epoch, label opened from a grant of a held epoch, newest first) and `findOwnAll(kind, predicate)`.
- `membership.ts`: the listed helpers exported with no behaviour change. `CellInfo.legacy`. `cellLabel` reads `readLegacyCellLabel` before `parseLabel`. `clearedFor(..., leadOrDeputy)`: a legacy cell clears only the lead or deputy at that position, with a declared clearance dominating every label (or holding it, when none is declared). `clearedDevices` passes it from `leadAt`/`deputyAt` and never puts a hub on a legacy cell (D-64). `grantPlans` takes `leadOrDeputy` (false at admission). `nameDeputy` and `handOverLead` give a cleared new deputy or lead the legacy cell and add `LEGACY_GIVEN_TEXT`. `cellOrderHook` answers no for a legacy cell, since it has no single label.

## Verification

All runs used the memory cap wrapper and the shared focused lock.

- Plan verify (Task 3 set): staffReplicaLabelCells, staffReplicaMembership, staffReplicaProject, staffMultiUserCommands, replicaCellLeak, then `npm run lint`: **115 tests, 115 pass, 0 fail, lint exit 0**. staffReplicaMembership and staffMultiUserCommands pass unchanged.
- Neighbours: staffReplicaMigration, staffReplicaCopy, staffReplicaProjection, staffReplicaKeyring, replicaProductCells: 117 pass, 0 fail.
- staffReplicaLabelCells.test.js: 20 tests, including "not-cleared-for-label", "base-cell-products", "label-change", "one cell.create", "legacy" and "awaiting-key".
- Acceptance greps: `heldCells` in replicaProject.ts 2; the D-19 phrase in labelCells.ts 1; `readLegacyCellLabel` in membership.ts 2.

### Failing first

- Task 1, on the unchanged code: TS2307, no module '../staff/replica/labelCells'; TS2551, `findOwnAll` does not exist on ReplicaProject.
- Tasks 2 and 3, tests written before the module: TS2307 for labelCells and TS2305 for `LEGACY_GIVEN_TEXT`.
- Task 3, with labelCells built but the membership legacy rule not yet in place: 18 pass, 2 fail ("naming a cleared deputy gives their device the legacy cell..." and "handing the lead to a cleared member..."). The first run of the handover test after the rule also failed (the grant named the handover roster, where the old lead is no longer a roster writer). That led to the fix described in Decisions.

### Mutation proofs (D-66; compiled JS changed, run, then restored and compared byte for byte)

| Mutation | Tests that failed |
| --- | --- |
| D-19 check off (`mayHold` returns true) | 3: both not-cleared-for-label tests, legacy with no declared clearance |
| Grants to every device, cleared or not | 4: the tracer, one cell.create, stopped after cell.create, legacy lead-only |
| Host pin check off | 1: pin-above-cell |
| Legacy rule ignores lead or deputy | 3: admission never grants it, naming a deputy, handover |
| base-cell-products refusal removed | 1: base-cell-products |
| label-change refusals removed | 1: label-change |

## Deviations from Plan

1. **[Rule 2, stuck state] A stop after cell.create is finished by the next call.** As planned, a re-run after a stop past `cell.create` would reuse the cell, and the cleared members would never get their grants. Reuse now gives every cleared person device that holds nothing of the cell its grants. This writes grants only, never a roster entry. Test: "a run stopped after cell.create gives the cleared devices their grants...". The seam gains `'create'`.
2. **[Plan wording] syncTo grant scope.** The plan says syncTo delivers "every grant on from's disk". It also says N's roster view must answer cellGrantees undefined after syncTo. Delivering the founding grant to N would make that false and would break D-23. So syncTo delivers the grants of the base cell and of the named streams.
3. **[Rule 1, bug] Handover grants.** The legacy grants written after `lead.handover` must name the roster the handover cites. The fold places a grant only from a roster writer at the roster it names.
4. **Additions:** a `label-unknown` refusal for a label the scales do not know, and `version-too-large` for a version over the state limit. Exports beyond the plan's list: `Change` (a parameter type of the exported `clearedDevices`) and `LEGACY_GIVEN_TEXT`.
5. **Commits:** two instead of one per task. The tests came first (RED), then the implementation. The three tasks share labelCells.ts and membership.ts, and the worktree has no hunk-level staging.

Files touched: only the five in the plan's files_modified, plus this summary.

## Known limits

- A product.create of a name already in the same cell is written, and the fold refuses it as product-exists. The host does not refuse it first, because the plan names no refusal for this.
- When `giveLegacy` cannot give the legacy cell because this device does not hold its keys, it says nothing. The role change stands. No flow gives the cell later. A later plan can add that to the reuse path of `ensureLegacyCell`, which already gives missing grants to cleared devices.
- After a handover, the old lead is no longer lead or deputy. The next roster flow (`finishPending`) moves the legacy cell to a new key without the old lead's devices. This follows D-20, but no test covers it here.

## Known Stubs

None.

## Threat Flags

None beyond the register. T-32-204 is covered by `clearedDevices` at the `cell.create` position, with one grant per device and no hub, and by the member-below test. T-32-205 by base-cell-products, org/Public included. T-32-206 by not-cleared-for-label before any write. T-32-207 by the legacy rule in `clearedFor`, which admission never grants and which a deputy change rekeys. T-32-208 by the key kept with its grant hash before the grant and `cell.create`, so a re-run makes one cell. T-32-SC: no package was installed.

## Self-Check: PASSED

- FOUND: src/staff/replica/labelCells.ts, src/test/staffReplicaLabelCells.test.ts, src/test/helpers/labelCellWorld.ts
- FOUND: 6af1176a, d4169673 (ancestors of HEAD)
