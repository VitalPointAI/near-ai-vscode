---
phase: 31-staff-roster-cell-keys-and-migration
plan: 15
subsystem: replica
tags: [replica, roster, cell-keys, rekey, label-cells, write-down, security]
status: complete

requires:
  - phase: 31-01
    provides: optional RosterView.cellGrantees and ReplicaContext.cellOrder
  - phase: 31-09
    provides: cell.create and cell.rekey schemas (epoch and grant optional on the wire), CELL_REKEY_REASONS, the staff-cell-grant purpose
  - phase: 31-12
    provides: rosterCells.ts and cellKeys.ts seams (applyCellEntry, addGrant, granteesAt, wraps, grants), the roster world test helper
provides:
  - "rosterCells.ts: cell.create and cell.rekey applied; CELL_REFUSALS adds cell-unknown and grant-missing; GrantRecord.founding; granteesAt with a required admitted filter that answers undefined until the founding grant of the current epoch is on this machine; epochsAt"
  - "cellKeys.ts: sealLabel, openLabel (CELL_LABEL_INFO, MAX_LABEL_BYTES), REKEY_KEEP_TEXT, RekeyReason, RekeyPlan, RekeyInput, planRekey, EarlierEpochInput, earlierEpochGrants"
  - "fold.ts: write-down refusal from ctx.cellOrder before any reducer; Prepared.bases"
affects: [31-17, 31-20, 32]

actuals:
  tokens: 17773
  tasks: 3
  commits: 4
plan_head_before: 6cacd66f216763046e33ca50c9e1ac71eaf9f3a8
plan_head_after: cbf8ded5

tech-stack:
  added: []
  patterns:
    - "A label key derived from the epoch key by HKDF, so a grant's sealed label and the entries sealed under the same epoch key never share a key"
    - "Unknown is undefined: a roster view answers grantees only when this machine holds the epoch's founding grant"
    - "Fold-level refusal before the reducer (write-down), recorded with the entry's family, the entry stays a chain node"

key-files:
  created:
    - src/test/replicaCellKeys.test.ts
    - src/test/replicaCellLeak.test.ts
  modified:
    - src/domain/replica/rosterCells.ts
    - src/domain/replica/cellKeys.ts
    - src/domain/replica/fold.ts
    - src/test/replicaRosterTracer.test.ts
    - SECURITY.md

key-decisions:
  - "cell.create must carry epoch 1 and a grant hash, cell.rekey the next epoch and a grant hash; a missing commitment is refused grant-missing (new reason), a missing or wrong epoch epoch-not-next"
  - "granteesAt answers undefined when the founding grant of the cell's current epoch is not on this machine (a member below the cell learns only that a cell id exists); its admitted filter is now required"
  - "The label is sealed with AES-256-GCM under HKDF-SHA256(epoch key, info 'near-ai/cell-label/v1' NUL cell NUL epoch), with the same info as associated data"
  - "planRekey recipients are the current grantees still in clearedNow and not named by the change (a removal, revocation or hub revocation always drops the named devices; a lowered clearance only where they are no longer cleared); scheduled plans every cell given"
  - "write-down: a dep whose stream cannot be found (never happens for an applied entry) counts as a write down, so the check fails closed"

requirements-completed: [MUS-05]

coverage:
  - id: D1
    description: "cell.create founds epoch 1 with a committed founding grant; grantees and label for a cleared device"
    requirement: MUS-05
    verification:
      - kind: unit
        ref: "src/test/replicaCellKeys.test.ts#cell.create founds epoch 1 of a cell: the founding grant it commits to lists the lead and M as grantees, and M opens its wrap and reads the label"
        status: pass
  - id: D2
    description: "grant-mismatch, grant-signer, grant-recipient, grant-epoch-unknown"
    requirement: MUS-05
    verification:
      - kind: unit
        ref: "src/test/replicaCellKeys.test.ts#a grant is refused unless it is the committed one, signed by a roster writer, and wrapped only to devices admitted at the roster it names"
        status: pass
  - id: D3
    description: "Removal rekey: the removed device keeps epoch 1 and cannot open epoch 2; REKEY_KEEP_TEXT"
    requirement: MUS-05
    verification:
      - kind: unit
        ref: "src/test/replicaCellKeys.test.ts#removal: planRekey drops M from X, cell.rekey moves X to epoch 2 wrapped only to the lead, and M keeps epoch 1 but cannot open epoch 2"
        status: pass
  - id: D4
    description: "Every rekey reason; recipients never uncleared"
    requirement: MUS-05
    verification:
      - kind: unit
        ref: "src/test/replicaCellKeys.test.ts#planRekey for hub-revoked plans the hub device's cells; scheduled is a new epoch for every cell to the same cleared recipients; recipients are never uncleared"
        status: pass
  - id: D5
    description: "Earlier epochs for a device admitted later (D-45)"
    requirement: MUS-05
    verification:
      - kind: unit
        ref: "src/test/replicaCellKeys.test.ts#a device admitted at epoch 3 receives one grant per epoch 1, 2 and 3, each valid at the admission roster and each opening with its own key"
        status: pass
  - id: D6
    description: "Label leak: two cells, two devices"
    requirement: MUS-05
    verification:
      - kind: unit
        ref: "src/test/replicaCellLeak.test.ts#label leak: a device not cleared for cell X never receives its grant, holds every X entry missing-key, and its fold output has no X product, label or decision"
        status: pass
  - id: D7
    description: "Write up, never down; incremental and from-scratch folds agree"
    requirement: MUS-05
    verification:
      - kind: unit
        ref: "src/test/replicaCellLeak.test.ts#write up, never down: with the cell order an X entry citing the base cell applies and a base entry citing X is refused write-down; without it both apply"
        status: pass
      - kind: unit
        ref: "src/test/replicaCellLeak.test.ts#incremental and from-scratch folds agree on the write-down cases, in every delivery order tried and with and without the cell order"
        status: pass

duration: 12min
completed: 2026-11-20
---

# Phase 31 Plan 15: Cell keys, wraps and rekey (WP-R1) Summary

**Each label cell now has its own key per epoch, founded by cell.create or cell.rekey with the founding grant committed by hash; grants are checked at the roster they name; planRekey turns a removal, revocation or lowered clearance into one new epoch per affected cell for the devices still cleared, with "They keep what they already received. They will not receive anything new."; a device admitted later gets the earlier epochs; a device below a cell learns nothing from it; and the fold refuses an entry that cites a higher cell from a lower one when the cell order is known.**

## Performance

- Started 2026-11-20T05:03Z (after reading the plan, context, research sections, DESIGN 8.1 to 8.3 and summaries 31-09 and 31-12), finished about 05:16Z
- 3 tasks, 4 commits (3 task commits and one test fix), 2 files created, 5 modified

## Accomplishments

- **Cells (`rosterCells.ts`, D-21, D-22, D-44):** `cell.create` founds epoch 1 of a new cell and `cell.rekey` the next epoch of an existing one, each recording its founding grant hash, the roster it cites and its position. Refusals `cell-exists`, `cell-unknown`, `epoch-not-next` and the new `grant-missing` change nothing. Grants keep a `founding` flag; `granteesAt` lists the current epoch's grantees admitted at the asked position (the filter is now required) and answers undefined while this machine does not hold the founding grant. `epochsAt` lists a cell's epochs at a position for the host's D-45 grants.
- **Keys (`cellKeys.ts`, D-23, D-45):** `sealLabel`/`openLabel` (AES-256-GCM under a label key derived by HKDF from the epoch key, cell and epoch as associated data; never throws on open); `planRekey` for all five `CELL_REKEY_REASONS`; `REKEY_KEEP_TEXT`; `earlierEpochGrants` (one signed grant per epoch to one device at its admission roster, label optional).
- **Fold (`fold.ts`, D-25, DESIGN 8.1 rule 4):** before a reducer applies an entry, when `ctx.cellOrder` exists, any dep in a stream the entry's own cell does not dominate makes it `refused` with reason `write-down` (with its family); it stays in the order and its chain. The dep's stream comes from the admitted entry or, for a checkpoint join base, from the base (now kept in `Prepared.bases`).
- **SECURITY.md:** `### Cell keys, wraps and rekey` in the multi-user section, and (carried over from 31-12) a table under Dependencies for the committed BIP-39 English word list with its source, MIT licence and the sha256 test.

## Task Commits

1. Task 1 (tracer): `a899a14f` feat(31-15): cell.create and cell.rekey with committed founding grants, sealed labels and rekey plans
2. Task 2: `7a6e5ba1` test(31-15): every rekey reason, earlier epochs for a new device, copied wraps and grantees at the cited roster
3. Task 3: `75c5a807` feat(31-15): label leak test, write up never down in the fold, and SECURITY.md cell keys
4. Test fix: `cbf8ded5` test(31-15): write the em-dash check as an escape, so the test file itself has no em-dash

## Decisions

No checkpoint in this plan. The tracer gate was run automatically: Task 1's verify (replicaCellKeys plus replicaRosterTracer, 15 of 15) passed, then a mutation run confirmed the guards bite before expanding. Choices made inside the plan's words are in the frontmatter `key-decisions`; the ones a reviewer may want to revisit:

- **Grantees unknown without the founding grant.** The leak behaviour requires `cellGrantees(X, head)` to be undefined on the view of a device below X, but that device's roster does apply the `cell.create` (the roster stream is in the base cell). So "the view knows the cell" now means "this machine holds the founding grant of the cell's current epoch". The lead's machine and every cleared device hold it; the hub (Phase 32) must be given the grants of the cells it serves to answer grantees.
- **Label key derived, not the epoch key itself.** The plan says "AES-256-GCM under the epoch key"; the label is sealed under an HKDF subkey of the epoch key so it never shares a key with the entries sealed under that epoch.
- **`grant-missing` added** to `CELL_REFUSALS` (31-09 left epoch and grant optional on the wire and asked the fold to require both).
- **An empty `recipients` list** in a plan means nobody cleared is left; the host must not write that rekey (documented on `planRekey`; 31-20 owns the command).
- **D-45 edge:** a grant at the roster an epoch's founding entry cites is refused unless it is the founding grant (31-12's rule), so when a cell gets a new epoch right at a device's admission roster, that device belongs in the founding grant. Documented on `earlierEpochGrants`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The roster tracer's pending-kind test listed cell.create**
- **Found during:** Task 1
- **Issue:** `replicaRosterTracer.test.ts` (31-12) asserted that `cell.create` is refused `roster-kind-pending` and that the pending kinds span three owner modules. With the rule written, `cell.create` applies, so the plan's own verify (which runs that file) could not pass.
- **Fix:** removed the `cell.create` row and set the pinned owner list to its new exact value `['members', 'roster']`; replicaCellKeys.test.ts now shows that each refused cell entry changes no position or answer. The file is outside this plan's `files_modified`; 31-14 and 31-17 will each remove their own rows from the same array in this wave, so the orchestrator should expect a small merge conflict in that array and the owner-list line (the right result after all three is no pending kinds left for the routed modules they finish).
- **Files modified:** src/test/replicaRosterTracer.test.ts
- **Commit:** a899a14f

**2. [Rule 2 - Missing critical functionality] granteesAt filter made required**
- **Issue:** `granteesAt` took the admitted filter as optional, so a caller could list a revoked device.
- **Fix:** the filter is required (the only production caller, `rosterView`, already passed it).
- **Commit:** a899a14f

**3. [Rule 1 - Bug] Em-dash character in a new test file**
- **Issue:** the refusal-text check in replicaCellKeys.test.ts held a literal em-dash character instead of the `—` escape.
- **Fix:** replaced with the escape. **Commit:** cbf8ded5

### Notes

- The plan names the branch `feat/phase-31-15-cells`; the orchestrator dispatched it on `feat/phase-31-15-cell-keys`.
- TDD order: Task 1 tests were written first (RED: the type check failed on the missing exports and the missing refusal key). `planRekey` and `earlierEpochGrants` were written complete in Task 1, so Task 2's tests went green on first run; mutation runs in the compiled `dist/` only (overwritten by the next compile) showed they bite: dropping the "named devices always leave" rule failed 2 tests, dropping the founding-grant rule in `granteesAt` failed 2 more, and disabling the epoch-not-next check failed the refusal test. Task 3's write-down test was RED (refused list empty) before the fold change; the leak test passed before the fold change, as expected, because it rests on the grant delivery rule and the key ring.
- `roster.ts`, `rosterMembers.ts`, `invite.ts`, `verify.ts` and the test helper were not edited.

## Test Results

All runs under the shared flock lock and `systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 timeout ... NODE_OPTIONS=--max-old-space-size=1536`, compiling with `node scripts/vendor-libs.mjs && tsc -p tsconfig.json` (exit 0).

| Run | Tests | Pass | Fail |
|-----|-------|------|------|
| Task 1: replicaCellKeys (5), replicaRosterTracer (10) | 15 | 15 | 0 |
| Task 2: replicaCellKeys | 12 | 12 | 0 |
| Task 3: replicaCellLeak, replicaCellKeys, replicaReevaluation, replicaConvergence, replicaVectors | 50 | 50 | 0 |
| Task 3 with SECURITY.md checks: the five above (replicaCellLeak now 4) plus gateDocs and staffReplicaStore | 110 | 110 | 0 |
| Final: every `dist/test/replica*.test.js` and `staffReplica*.test.js` | 492 | 492 | 0 |

The full `npm test` was not run (the orchestrator runs it at the end).

Acceptance greps: the rekey sentence in cellKeys.ts 1; `export function earlierEpochGrants` in cellKeys.ts 1; `write-down` in fold.ts 3; `### Cell keys, wraps and rekey` in SECURITY.md 1; em-dash in SECURITY.md 0 (and 0 in every file this plan changed). replicaCellKeys has 12 tests, replicaCellLeak 4.

## Known Stubs

None. `ReplicaContext.cellOrder` has no production implementation yet: the host builds it from Phase 70 dominance when it creates the context (31-20), as the plan states.

## Threat Flags

None beyond the plan's register. T-31-45 (signer, recipient and commitment checks; rekey omits removed devices), T-31-46 (new epoch on removal, revocation or lowering; the removed device's unwrap fails for the new epoch), T-31-47 (per-reader key ring; the leak test searches the whole serialised fold output and the roster view) and T-31-48 (write-down refusal with the cell order) are mitigated and tested; T-31-SC: no package installed. No new endpoint, file access or network path.

## Self-Check: PASSED

- FOUND: src/domain/replica/rosterCells.ts, src/domain/replica/cellKeys.ts, src/domain/replica/fold.ts, src/test/replicaCellKeys.test.ts, src/test/replicaCellLeak.test.ts, SECURITY.md
- FOUND: commits a899a14f, 7a6e5ba1, 75c5a807, cbf8ded5 are ancestors of HEAD
