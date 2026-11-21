---
phase: 32-your-organizations-sync-hub
plan: 24
subsystem: staff replica (the hub in the roster)
status: complete
tags: [hub, roster, membership, cell-grants, rekey, D-22, D-40, D-41, D-64]
requires: [32-04, 32-08, 32-09, 32-15]
provides:
  - "src/staff/replica/hubMembership.ts: HUB_GRANT_TRADE_OFF, HUB_MEMBERSHIP_REFUSALS, HubMembershipResult, AdmitHubInput, admitHub, GrantCellToHubInput, grantCellToHub, revokeHub, HubStanding, hubStanding"
affects: [32-25 (enrolment and join through the hub build on admitHub), Phase 33 (commands and UI)]
tech-stack:
  added: []
  patterns:
    - "every refusal decided from the roster and fold at the head before the first write"
    - "resume from the roster: write only the roster entries and grants the roster shows missing"
    - "crash simulation with node:test mock.method on ReplicaProject.appendOwn and putGrants (no test seam in the module)"
key-files:
  created:
    - src/staff/replica/hubMembership.ts
    - src/test/staffReplicaHubMembership.test.ts
  modified: []
decisions:
  - "Admission writes hub.admit, hub.grant for the base cell, then one grant per base cell epoch at the hub.grant roster (D-64), the order 32-19's enrolment expects; the legacy cell is never granted (checked first in grantCellToHub, and clearedFor/clearedDevices also exclude it)"
  - "The D-22 refusal checks baseCellHeldProducts (32-08) and also a project.import in the base stream, since the 0.4.35 preview imported whole ledgers there and Phase 32 migration imports nothing into the base cell"
  - "The D-22 sentence is written literally in HUB_MEMBERSHIP_REFUSALS (the plan's acceptance grep counts it in this file) and a test asserts it equals PREVIEW_WAY_FORWARD_TEXT, so the two cannot drift"
  - "grantCellToHub check order: cell known to the roster, legacy cell, trade-off confirmed, roster writer and split, hub in force, already held, label readable here, ceiling dominance (membership's clearedFor with Phase 70 dominance and the host clock), every epoch key held"
  - "Grants to the hub name the hub.grant roster, or an epoch's own founding entry when that came later (a grant may not name a roster before its epoch)"
  - "revokeHub finishes any earlier unfinished rekeys first (as every roster flow), writes hub.revoke, then calls finishRekeys and words the result as a removal, ending with REKEY_KEEP_TEXT; revoking an already revoked hub finishes what its revoke left, else is refused hub-revoked"
  - "The hub's ceiling is validated before writing (roster clearance shape and the project's scales), refused ceiling-invalid otherwise; on a resumed admission the ceiling stays as the roster has it"
  - "grantCellToHub takes an optional hub id; without one it uses the only hub in force (no-hub or hub-not-named otherwise)"
metrics:
  duration: "about 55 minutes"
  completed: 2026-11-20
estimate:
  tokens: 60000
  tasks: 3
actuals:
  tokens: 14950
  tasks: 3
  commits: 3
plan_head_before: 1d470ad91ea2c9a3a93b19a174595e83e4d99c34
plan_head_after: b41ae3a4aa6140858cbe1212f82acc272e277c1e
---

# Phase 32 Plan 24: The hub in the roster Summary

The lead can now admit your organization's hub from the operator's hub file (hub.admit, hub.grant for the base cell, then the base cell grants to the hub's X25519 key), give it more cells only after confirming the DESIGN 10.2 trade-off sentence, and revoke it, which moves every cell it held to a new key; every refusal is decided before anything is written and a stopped admission finishes on the next try.

## What was built

`src/staff/replica/hubMembership.ts` (host, Node I/O through ReplicaProject and the membership flows only, no vscode):

- **admitHub(shared, hubFileText, { ceiling })**: `readHubFile` with the host clock (signature by the hub's own key, key binding, expiry), then: roster writer and not split (`writerProblem`), the D-22 check, hub id not a member's, then either a fresh admission (device not in the roster, ceiling valid, next free slot) or a resume (the hub's device and pin match the file; refused hub-already-admitted when it holds every base epoch; hub-revoked when revoked). Every base epoch key is checked before the first write. Writes hub.admit (unless resumed), hub.grant for the base cell (unless the roster has it), then one `earlierEpochGrants` grant per epoch the hub does not hold. The result carries the hub id and its writer id only.
- **grantCellToHub(shared, { cell, confirmed, hub? })**: refuses the legacy cell first (`CellInfo.legacy` or `readLegacyCellLabel` on the sealed label), then without `confirmed === true`, then as every roster change, then a cell the hub already holds, a label this device cannot read (no-grant-key), and a label above the hub's ceiling. Writes hub.grant and one grant per epoch with the label sealed; the notices carry `HUB_GRANT_TRADE_OFF`.
- **revokeHub(shared, { hub? })**: refuses a hub holding a cell whose label this device cannot read (it could not be moved here); finishes earlier unfinished rekeys; writes hub.revoke; `finishRekeys` moves the base cell and every granted cell to a new key with reason hub-revoked. An interrupted revoke is finished by revokeHub again or by the next roster flow.
- **hubStanding(shared)**: each hub's id, writer, pin, ceiling, cells and standing (admitted or revoked), sorted; writes no entry or grant.
- `HUB_MEMBERSHIP_REFUSALS`: device-exists and member-exists (the fold's sentences), trade-off-not-confirmed (ends with the trade-off sentence), legacy-cell, above-hub-ceiling, hub-holds-cell, cell-unknown, no-hub, hub-not-named, hub-unknown, hub-revoked, hub-already-admitted, hub-file-differs, ceiling-invalid, base-cell-held-products (D-22 word for word). Hub file refusals use `HUB_FILE_REFUSALS`; roster ones use `MEMBERSHIP_REFUSALS`.

Reused from membership.ts, unchanged: `writerProblem`, `append`, `headOf`, `cellsAt`, `clearedFor`, `gateOf`, `finishRekeys`, `unfinishedRekeys`. `freeSlot` is private there, so a three-line copy lives here (named as such in its comment).

## Tests (focused, under the memory cap)

- `staffReplicaHubMembership.test.js`: **33 tests, 33 pass**. Names include "base cell rekey", "trade-off", "above-hub-ceiling", "legacy-cell", "revoke", "base-cell-held-products", "resume" and "secret".
- Task 2 verify: staffReplicaHubMembership + staffReplicaMembership **59/59 pass**.
- Final: staffReplicaHubMembership, staffReplicaMembership, staffReplicaLabelCells, replicaBoundaries **103/103 pass**; `npm run lint` exit 0.
- Acceptance greps: `'hub.admit'` 1; "Anyone who takes over the hub server can read it too." 1; "its products sit in the part of the project the hub must read" 1; em-dash 0 in both files.

### Failing first

- Task 1: compile failed, TS2307 cannot find module '../staff/replica/hubMembership'.
- Task 2: compile failed, TS2305 for HUB_GRANT_TRADE_OFF, grantCellToHub, revokeHub; TS7053 for the new refusal keys.
- Task 3: compile failed, TS2305 for hubStanding. With a temporary empty hubStanding over the Task 2 code (removed before committing): **33 tests, 24 pass, 9 fail**: ceiling-invalid, hub-revoked file, both base-cell-held-products refusals, hubStanding, hub-already-admitted, hub-file-differs, and both resume tests.

### Mutation proofs (D-66; compiled JS changed, run, restored and compared byte for byte)

| Mutation | Tests that failed |
| --- | --- |
| hub.grant for the base cell not written (D-64) | 2: the D-64 order test, base cell rekey |
| legacy-cell check off | 1: legacy-cell (it was then refused above-hub-ceiling, since clearedFor never clears the legacy cell for a hub) |
| trade-off confirmation not required | 1: trade-off not confirmed |
| ceiling check off | 1: above-hub-ceiling |
| no rekeys after hub.revoke | 1: revoke |
| D-22 refusal off | 2: both base-cell-held-products refusals |
| base-stream import check off | 1: the legacy import refusal |
| the hub's X25519 key put in the result | 2: tracer, no secret |
| hub-already-admitted check off | 1: hub-already-admitted |

## Deviations from Plan

1. **[Rule 2, correctness] Base-stream legacy imports refused too.** 32-08 notes baseCellHeldProducts sees only product-family entries the fold applied or held. ReplicaProject has no read of other writers' base-stream entries by kind, and replicaProject.ts belongs to 32-23 in this wave, so the kind check with baseCellAllows could not be added without touching its file. From the fold, this plan adds the other way a preview project put readable content in the base cell: a project.import there (whole ledgers, including the product ledger and decision log). Phase 32 migration imports nothing into the base cell (migrate.ts importLedgers), so no Phase 32 project is refused by it. Test: "a whole legacy import in the base stream is refused too".
2. **[Rule 2, correctness] Extra refusals** beyond the plan's list, each tested: ceiling-invalid, hub-file-differs, hub-revoked, plus no-hub, hub-not-named, hub-unknown and cell-unknown for grantCellToHub and revokeHub input.
3. **[Plan wording] "A single-machine copy made multi-user again is admitted"** is tested with its result: a new shared project whose product is written into its own label cell (appendProductEntry) is admitted. Running the copy and migration flows end to end is covered by their own suites.
4. **[Plan wording] The plan's Branch line** names `feat/phase-32-24-hub-roster`; the orchestrator's worktree branch is `feat/phase-32-24-hub-in-roster`.

## Known limits (for 32-25 and later)

- The D-22 check cannot see a product entry the fold refused or kept in the base stream (32-08 known limit). Closing it needs a ReplicaProject read of base-stream entry kinds (with `baseCellAllows`); that belongs in replicaProject.ts, owned by 32-23 in this wave. The 0.4.35 host never produced only-refused product entries.
- revokeHub cannot run on a device that cannot read the label of a cell the hub holds; it is refused no-grant-key and the lead's device does it.
- Enrolment (32-25) reads the hub file again; this module stores neither the file nor its enrolment secret.

## Decisions

The owner accepted every 32-CONTEXT.md default; this plan had no checkpoints. The decisions made while building are in the frontmatter `decisions` list.

## Files touched outside the plan's list

None. membership.ts, labelCells.ts and replicaProject.ts were read, not changed. The compiled `dist/staff/replica/hubMembership.js` was changed only for the mutation proofs and restored.

## Threat Flags

None beyond the register: T-32-96 (hub file reader refusals, tested), T-32-97 (base cell only at admission, D-22 refusal, legacy cell never granted), T-32-98 (dominance before hub.grant), T-32-99 (hub.revoke then rekeys, checkpoint signer refused after), T-32-100 (result and file search for the secret). No package was installed (T-32-SC).

## Known Stubs

None.

## Self-Check: PASSED

- FOUND: src/staff/replica/hubMembership.ts, src/test/staffReplicaHubMembership.test.ts
- FOUND: 325cfba0, fc40c373, b41ae3a4 (ancestors of HEAD)
