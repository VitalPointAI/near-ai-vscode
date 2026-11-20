---
phase: 31-staff-roster-cell-keys-and-migration
plan: 03
subsystem: replica
tags: [replica, yjs, decode-bomb, denial-of-service, limits, snapshot, hub-side, testing]
status: complete

requires:
  - phase: 30-replication-contract-and-co-editing-core
    provides: doc.ts (inspectUpdate, applyUpdate, decodeSnapshot, the snapshot helpers), kindSchemas/doc.ts, SealedBlob and SEALED_OVERHEAD in entry.ts
  - phase: 31-staff-roster-cell-keys-and-migration
    provides: 31-01 (phase branch base; no direct API used)
provides:
  - updateGuard.ts (pure, hub-side, no Yjs) with readVaruint, skimUpdate, skimSnapshot, sealedBlobWithin, SkimResult, SkimError
  - MAX_UPDATE_BYTES = 256 KiB, MAX_STATE_BYTES = 2 MiB, MAX_STRUCTS = 100 000 in kindSchemas/doc.ts (doc.ts re-exports MAX_STRUCTS)
  - every Yjs decode of outside bytes in doc.ts gated by the byte limit for its use and the skim (inspectUpdate, applyUpdate, applyRemote, scratch loads, buildFromCompaction, decodeSnapshot)
  - inspectState (inspectUpdate with the state limit, for doc.compact states)
  - rangesCovered (linear merge walk) behind deletesCovered
  - snapshotReport (missing, text and runs from one scratch build); snapshotMissing, textAtSnapshot and attributionAtSnapshot are thin wrappers
  - updateClients removed (IN-02)
affects: [31-04, 31-07, 31-10, 31-13, 32]

actuals:
  tokens: 14070
  tasks: 4
  commits: 7
plan_head_before: 81d8ec5cd17ccad6040c6e8e00f51deacdd006b6
plan_head_after: fe1f8b4b67a65c93915b3e0896c04008d86443a7

tech-stack:
  added: []
  patterns:
    - "Pre-decode skim: walk the wire format with one cursor object, read counts first and refuse above the cap before walking, allocate nothing per struct"
    - "One gate function (applyWithin) per decode path, parameterised by the byte limit of the use (update or state)"
    - "Heap ceilings measured in tests with a forced GC (v8.setFlagsFromString('--expose-gc') + vm.runInNewContext('gc')) and probes built with a varuint writer"

key-files:
  created:
    - src/domain/replica/updateGuard.ts
    - src/test/replicaUpdateGuard.test.ts
  modified:
    - src/domain/replica/doc.ts
    - src/domain/replica/kindSchemas/doc.ts
    - src/test/replicaBoundaries.test.ts
    - src/test/replicaDoc.test.ts

key-decisions:
  - "Byte limits taken at the D-43 defaults with no change: 256 KiB per doc.update, 2 MiB per state or snapshot, MAX_STRUCTS 100 000 (one-way task, plan default)"
  - "The skim also caps client groups, delete-set clients and snapshot state-vector clients at MAX_STRUCTS (Yjs allocates per group and per client); honest Yjs output never has more groups than structs"
  - "applyRemote is gated too (state limit plus skim), so no doc.ts path hands outside bytes to Yjs unchecked"
  - "inspectState added so a doc.compact state (larger than any one update may be) can be inspected with the state limit; textFold.applyCompaction still calls inspectUpdate and must switch (see Next Phase Readiness)"
  - "rangesCovered sorts copies of both range lists, so a hostile snapshot with unsorted or overlapping ranges gets the same answer as the old scan"

patterns-established:
  - "updateGuard.ts is the hub-side home of decode limits; the Phase 32 hub imports the same function and numbers"

requirements-completed: [MUS-06, MUS-02]

coverage:
  - id: D1
    description: "Strict pre-decode skim with struct cap and content allow list on the inspectUpdate path"
    requirement: MUS-06
    verification:
      - kind: unit
        ref: "dist/test/replicaUpdateGuard.test.js (skimUpdate parity, refusals, 120 000-struct heap ceiling)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Same gates on applyUpdate, applyRemote, scratch loads, buildFromCompaction and decodeSnapshot; sealedBlobWithin; 2 000 000-struct heap ceiling"
    requirement: MUS-06
    verification:
      - kind: unit
        ref: "dist/test/replicaUpdateGuard.test.js (Task 2 group)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Linear delete check and one shared snapshot inspection; unused export removed"
    requirement: MUS-02
    verification:
      - kind: unit
        ref: "dist/test/replicaUpdateGuard.test.js (Task 3 group); dist/test/replicaVersions.test.js; dist/test/replicaVersionDecisions.test.js"
        status: pass
    human_judgment: false
  - id: D4
    description: "30-page state measured against the limits; updateGuard registered hub-side"
    requirement: MUS-06
    verification:
      - kind: unit
        ref: "dist/test/replicaUpdateGuard.test.js (30-page test); dist/test/replicaBoundaries.test.js"
        status: pass
    human_judgment: false

duration: 23min
completed: 2026-11-20
---

# Phase 31 Plan 03: Update guard Summary

**A pure, hub-side skim now counts structs and delete ranges and refuses forbidden content before Yjs decodes anything, with D-43 byte limits of 256 KiB per update and 2 MiB per state. The 4 MB hostile probe that grew the heap by 191 MB now grows it by 0 MB.**

## Performance

- **Duration:** about 23 min
- **Started:** 2026-11-20T03:34:16Z
- **Completed:** 2026-11-20T03:57Z
- **Tasks:** 4 of 4
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments

- `updateGuard.ts` (new, pure, no Yjs, hub-side): `readVaruint` (at most 8 bytes, bounds checked, safe integers only), `skimUpdate`, `skimSnapshot`, `sealedBlobWithin`. The skim walks the Yjs v1 layout with one cursor object. It reads each declared count first and refuses as soon as the running total passes the cap, before it walks those structs. It accepts only GC (0), deleted (1) and string (4) content, and refuses a truncated input, an over-long varuint or trailing bytes as malformed.
- `doc.ts`: every decode of outside bytes passes the byte limit for its use and then the skim. Updates use 256 KiB. States, scratch loads, a peer's whole state (`applyRemote`) and snapshots use 2 MiB. `decodeSnapshot` checks the size and `skimSnapshot` first (new defect 2). `inspectState` is new.
- `deletesCovered` now calls `rangesCovered`, a linear merge walk. `snapshotReport` answers missing, text and runs from one scratch build, and the three old functions are thin wrappers over it, so `versions.ts` compiles unchanged. `updateClients` is deleted.
- `HUB_SIDE` gains `domain/replica/updateGuard`, and the closure test passes. updateGuard imports only `entry` and `kindSchemas/doc`, which are both hub-side.

## Measurements

**Re-verification of WR-07 on the old code** (compiled base 81d8ec5c, Node with forced GC, scratch script):

| Probe | Bytes | Old result | Old heap growth | New result | New heap growth |
|-------|-------|-----------|-----------------|------------|-----------------|
| 120 000 GC structs | 240 007 | too-large, only after decoding all 120 000 | +15.1 MB (32 ms) | too-large from the skim | 0.00 MB |
| 2 000 000 GC structs | 4 000 007 | too-large, only after decoding | +191.4 MB (348 ms) | too-large (byte limit; the skim alone also refuses it) | 0.00 MB through inspectUpdate and through skimUpdate |
| 100 001-range snapshot | 391 754 | (not measured on the old code) | n/a | undefined from skimSnapshot | 0.00 MB |

The research recorded +211 MB for the 2 000 000-struct probe. This machine measured +191 MB. Both are well above the 64 MB ceiling the test now enforces.

**Delete check:** three checks of 20 000 snapshot ranges against 20 000 held ranges took 5.7 ms with the merge walk. The old scan took 387 ms on the same sorted input in a scratch run. On unsorted or worst-case input the old scan is quadratic, and the new walk is not.

**30-page state (research assumption A10):** the test used 20 authors with 32-bit client ids and 2 126 updates shaped like the spike: typing batches of 1 to 40 characters, 500 to 3 000 character pastes, deletions and paragraph rewrites. Each batch landed at a random place, which gives an upper bound on splits. Result: 94 578 characters, **243 363 bytes** and **3 927 structs** (516 delete ranges). That is 8.6 times under MAX_STATE_BYTES and 25.5 times under MAX_STRUCTS. The largest single update was 2 962 bytes. The test produces fewer bytes per character than the spike did. The spike's largest gc-off full state, 520 879 bytes, is still 4.0 times under the limit. No limit needed changing (P-31-04 held).

## Task Commits

1. **Task 1: Tracer: skim before decode on the inspectUpdate path.** RED `0b76e7da` (test), GREEN `b05d510a` (feat). The tracer gate re-ran the automated verify end-to-end: 45/45 passed, then the work expanded.
2. **Task 2: Same gates on applyUpdate, snapshots and states, plus the heap ceiling.** RED `e9b71c45` (test), GREEN `9f731bcb` (feat).
3. **Task 3: Linear delete check, snapshotReport, IN-02.** RED `22c4d4e8` (test), GREEN `41eac961` (feat).
4. **Task 4: 30-page measurement and HUB_SIDE.** `fe1f8b4b` (test). This task is a measurement plus a list entry, so there is no RED phase; the measurement passed on its first run.

## TDD Gate Compliance

For tasks 1 to 3, a `test(31-03)` commit comes before each `feat(31-03)` commit. RED evidence for each: tsc failed on the missing exports (`updateGuard` module, `MAX_STATE_BYTES`, `MAX_STRUCTS`; then `skimSnapshot` and `sealedBlobWithin`; then `rangesCovered` and `snapshotReport`). The first behavioural RED was the measurement script on the old code shown above.

## Test Results (focused, all under the memory cap and the shared build lock)

| Run | Files | Result |
|-----|-------|--------|
| Task 1 verify | replicaUpdateGuard, replicaDoc, replicaContracts | 45 pass, 0 fail |
| Task 2 verify | replicaUpdateGuard, replicaDoc, replicaAttribution, replicaVersions | 63 pass, 0 fail |
| Task 3 verify | replicaUpdateGuard, replicaVersions, replicaVersionDecisions | 66 pass, 0 fail |
| Task 4 verify | replicaUpdateGuard, replicaBoundaries | 24 pass, 0 fail |
| Final | all 22 `src/test/replica*.test.ts` files (no `staffReplica*` file exists yet) | 289 pass, 0 fail, 0 skipped |

replicaUpdateGuard.test.js has 18 tests. Plan acceptance required at least 6, then 11, 14 and 15; one test name contains "heap". Acceptance greps: `MAX_UPDATE_BYTES = 256 \* 1024` = 1, `MAX_STATE_BYTES` in kindSchemas = 1, Yjs/vendor/require in updateGuard = 0, `skimSnapshot` in doc.ts = 2, files naming `updateClients` = 0, `export function snapshotReport` = 1, `domain/replica/updateGuard` in replicaBoundaries = 1.

The full `npm test` was not run, as the brief requires; the orchestrator runs it.

## Files Created/Modified

- `src/domain/replica/updateGuard.ts` (new): the skim, the varuint reader and the sealed-blob size gate.
- `src/domain/replica/kindSchemas/doc.ts`: the three D-43 limits.
- `src/domain/replica/doc.ts`: gated decode paths, `inspectState`, `rangesCovered`, `snapshotReport` and wrappers; `updateClients` removed.
- `src/test/replicaUpdateGuard.test.ts` (new): 18 tests.
- `src/test/replicaBoundaries.test.ts`: `HUB_SIDE` entry.
- `src/test/replicaDoc.test.ts`: one existing expectation changed (see Deviations).

## Decisions Made

- **D-43 limits taken as written** (one-way task, plan default; the owner approved the defaults): 256 KiB, 2 MiB, 100 000.
- **Extra counts capped:** the skim also caps client groups, delete-set clients and snapshot state-vector clients at the same cap. Yjs allocates a map entry or array for each of these, and Yjs never writes more groups than structs, so no honest input is affected.
- **applyRemote gated:** it uses the state limit because tests and the coming editor binding pass a peer's whole state through it. Every existing caller still passes.
- **inspectState added** for doc.compact states (see Next Phase Readiness).
- **snapshotReport error handling:** if an inspection throws, the report is undefined, so `snapshotMissing` gives false where it used to throw. If `createDocFromSnapshot` throws, the report is missing false with text and runs undefined, which matches the old behaviour of `textAtSnapshot` and `attributionAtSnapshot`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The 20 000-deep nested-array test in replicaDoc expected `malformed`, but the plan's skim makes it `forbidden-content`**
- **Found during:** Task 1
- **Issue:** `replicaDoc.test.ts` asserted that `nestedArrayUpdate(20_000)` is `malformed` (the decoder's stack overflow) and that the fold reason is `malformed-update`. The plan's own must-have requires the skim to refuse every content ref except 0, 1 and 4 as `forbidden-content` before decoding. The nested arrays are map-value content (ref 8), so the refusal now comes earlier and with that reason. The two requirements cannot both hold.
- **Fix:** That one test now expects `forbidden-content` from `inspectUpdate` and from the fold for the nested entry, and still expects `malformed-update` for the random and truncated entries. The assertions are as exact as before, the "never throws out of the fold" property still holds, and the test has a comment saying why.
- **Files modified:** `src/test/replicaDoc.test.ts`. This file is outside 31-03's files_modified and is owned by 31-04 in this wave. The hunk is lines 47 to 61, an existing test that 31-04 does not plan to edit (31-04 adds tests and a world seat). A merge conflict is unlikely, but the merge of wave 2 should check it.
- **Committed in:** `b05d510a`

**2. [Rule 2 - Missing critical] applyRemote and states needed the gate too**
- **Found during:** Task 2
- **Issue:** `applyRemote` passed outside bytes straight to Yjs. After the update limit dropped to 256 KiB, a compaction state above 256 KiB would also have failed in the shared `applyUpdate` used by scratch loads.
- **Fix:** one internal `applyWithin(doc, bytes, maxBytes)` for every path, with the update limit for `applyUpdate` and the state limit for `applyRemote`, `scratchDocWith` and `buildFromCompaction`. `inspectState` was also added.
- **Committed in:** `9f731bcb`

**3. [Test bug] Wrong expected clock in my own new test** (21 characters, not 22). It was fixed before the GREEN commit `9f731bcb`.

**Total deviations:** 2 auto-fixed (1 Rule 3, 1 Rule 2) plus one test typo. **Impact:** both fixes are needed for the plan's own truths. There is no scope creep.

## Next Phase Readiness / Handoffs

- **textFold.applyCompaction (31-07, or the wave-2 merge):** it calls `inspectUpdate(plain)` on the opened compaction state. With `MAX_UPDATE_BYTES` now 256 KiB, an honest compaction state above 256 KiB (the spike's 30-page states are 437 to 521 KB) would be refused `too-large`. Switch that call to the new `inspectState(plain)`, next to the `sealedBlobWithin(blob, MAX_STATE_BYTES)` gate 31-07 already plans. `buildFromCompaction` already uses the state limit. No current test covers a compaction that large, so nothing fails today.
- `snapshotReport` and `sealedBlobWithin` are ready for 31-07. `skimUpdate`, `skimSnapshot` and `inspectState` are ready for the decode worker in 31-10.

## Known Stubs

None.

## Threat Flags

None. No new endpoint, auth path or package. T-31-05 and T-31-06 are mitigated and tested. For T-31-07, the gate function now exists, and wiring it in is 31-07 and 31-13.

## Self-Check: PASSED

- FOUND: src/domain/replica/updateGuard.ts, src/test/replicaUpdateGuard.test.ts
- FOUND commits: 0b76e7da, b05d510a, e9b71c45, 9f731bcb, 22c4d4e8, 41eac961, fe1f8b4b (all ancestors of HEAD)
