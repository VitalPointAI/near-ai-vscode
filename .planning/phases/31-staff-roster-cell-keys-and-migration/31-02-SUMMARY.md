---
phase: 31-staff-roster-cell-keys-and-migration
plan: 02
subsystem: replica
tags: [replica, fold, dedupe, holds, denial-of-service, property-tests]
status: complete

requires:
  - phase: 30-replication-contract-and-co-editing-core
    provides: fold.ts (ingest, retryHeld, addEntries, the late-effect refold path), verify.ts, textFold.ts and versions.ts hold reasons
  - phase: 31-01
    provides: the agent-seat test worlds (no direct use here)
provides:
  - "fold.ts knownCopy: a re-delivered copy of a verified entry costs a header-shape parse and a hash, no signature check or decryption"
  - "FoldResult.dropped: count of inputs with no readable header, not part of any digest"
  - "fold.ts OUTCOME_RANK { verified: 0, held: 1, rejected: 2 } and compareOutcomes"
  - "at most one held copy per (entry hash, hold reason), an intact copy preferred, judged again from the best rejection"
  - "holdWaits.ts: HoldWait, waitOf(held, entry), waitAnswered(wait, ctx, newlyAdmitted)"
  - "addEntries releases reducer-stage holds the same context object can now answer, refolding from the earliest one"
affects: [31-04, 31-07, 31-13, 33]

actuals:
  tokens: 10272
  tasks: 3
  commits: 3
plan_head_before: 81d8ec5cd17ccad6040c6e8e00f51deacdd006b6
plan_head_after: 6f1142cdc481a046ef6aa98702568973a9532233

tech-stack:
  added: []
  patterns:
    - "Hold retries declared by what the hold waits for (holdWaits.ts), asked before the unchanged-state early return and on every delivery"
    - "Duplicates keyed by entry hash after a cheap header-shape parse; the hash-keyed chosen map is the seen set"

key-files:
  created:
    - src/domain/replica/holdWaits.ts
  modified:
    - src/domain/replica/fold.ts
    - src/test/replicaReevaluation.test.ts

key-decisions:
  - "A blob wait carries the cell stream and epoch and asks for the key as well as a blob whose bytes match its name, because versions.ts holds missing-blob also when the key is missing, and a damaged blob must not make every delivery refold"
  - "An entry wait counts as answered only when this call admitted an entry that sorts before the held one; one sorting after it is after it in the from-scratch fold too, so no extra refolds"
  - "Unreadable inputs keep one rejected record per reason (bounded by the closed reason set) besides the dropped count, because replicaEntry and replicaCheckpoint pin that record"
  - "The objectless seen set is removed rather than turned into a Set<string>: the chosen map is already keyed by entry hash"
  - "While a writer is unknown an intact copy replaces a corrupt one held for the same reason, so bounding held copies never loses the good copy"

patterns-established:
  - "Store choices compare by numeric OUTCOME_RANK then reason, never by arrival order"
  - "A hold reason a reducer emits that should be retried under the same context gets a row in holdWaits.ts, not code in fold.ts"

requirements-completed: [MUS-06, MUS-01]

coverage:
  - id: D1
    description: "A re-delivered entry (2000 JSON clones) is verified once; corrupt copies after the good one are skipped; junk inputs are counted in dropped and change no digest"
    requirement: MUS-06
    verification:
      - kind: unit
        ref: "src/test/replicaReevaluation.test.ts#(c) a valid entry delivered again as 2000 JSON clones is verified once, by addEntries in one call or in many"
        status: pass
      - kind: unit
        ref: "src/test/replicaReevaluation.test.ts#(c) foldEntries over an entry and 2000 clones of it equals foldEntries over the entry, with the verification work of one copy"
        status: pass
      - kind: unit
        ref: "src/test/replicaReevaluation.test.ts#(c) inputs that are not objects or have no readable header are counted in dropped, kept to one record per reason, and change no digest"
        status: pass
    human_judgment: false
  - id: D2
    description: "Held copies bounded per (hash, reason); a second reason is kept; numeric outcome rank with held beating rejected"
    requirement: MUS-06
    verification:
      - kind: unit
        ref: "src/test/replicaReevaluation.test.ts#(c) 500 distinct held copies with one header hash and one hold reason leave one copy to look at again"
        status: pass
      - kind: unit
        ref: "src/test/replicaReevaluation.test.ts#IN-03: a good copy that is permanently rejected and a corrupt copy that is only held report the entry held, whichever arrives first"
        status: pass
    human_judgment: false
  - id: D3
    description: "Blobs and keys put behind the same context release held entries, and the incremental fold equals the from-scratch fold"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaReevaluation.test.ts#(d) property: 80 seeded deliveries with blobs and keys put behind one context at random points equal the from-scratch fold after every step"
        status: pass
      - kind: unit
        ref: "src/test/replicaReevaluation.test.ts#CR-02: one entry at a time in random order, and in random chunks, equals the fold from scratch with hostile and honest compactions (120 orders)"
        status: pass
    human_judgment: false

duration: 21min
completed: 2026-11-20
---

# Phase 31 Plan 02: Fold re-delivery cost, bounded held copies and same-context hold retry Summary

**A re-delivered entry now costs one header parse and one hash. The fold keeps one held copy per hash and reason. Blobs or keys that a store puts behind the same context object now release reducer-stage holds through a new pure `holdWaits.ts`, and the incremental fold still equals the fresh fold.**

## Performance

- **Duration:** 21 min
- **Started:** 2026-11-20T03:35:51Z
- **Completed:** 2026-11-20T03:57Z
- **Tasks:** 3 of 3
- **Files modified:** 3 (1 created)

## Accomplishments

- Finding (c), WR-08: `ingest` calls `knownCopy` (`parseHeaderShape` plus `entryHash`) before `verifyEntry`. A copy of an already verified entry is skipped. The identity-keyed `Set<unknown>` is gone. Unreadable inputs are counted in `FoldResult.dropped` and not kept.
- Held copies: at most one per (hash, reason). A copy held for another reason is kept as a second copy. Held copies are judged again from the best rejection, as a from-scratch fold would judge them.
- IN-03: the numeric `OUTCOME_RANK` record (verified 0, held 1, rejected 2) replaces the string rank. A comment explains why a held copy deliberately beats a rejected one.
- Finding (d): `addEntries` asks each reducer-stage hold, through `waitOf` and `waitAnswered`, whether the context can now answer it. It does this before the unchanged-state early return and on every delivery. An answerable hold refolds from its position through the existing late path; if nothing is answerable, the very same state object comes back.

## Re-verification against the old code (D-01)

| Finding | Test | Result on the old fold.ts |
|---|---|---|
| (c) | 2000 JSON clones by addEntries | context lookups `{ deviceKey: 2004, keys: 2004 }` against `{ 4, 4 }` for the 4 real entries: 2000 extra signature checks and decryptions. The research measured 2001 verifications |
| (c) | 2000 clones by foldEntries | same 2004 against 4 |
| (c) | corrupt copy after the good one | 1 extra deviceKey lookup (5 against 4) |
| (c) | junk counted | `dropped` was undefined |
| (c) bound | 500 held copies, one hash and reason | 500 signature checks per later delivery (expected 1) |
| (c) bound | good copy held missing-key after a corrupt copy | the good copy was dropped; once the key arrived the entry stayed held while the fresh fold applied it (a real divergence, fixed here) |
| IN-03 | rejected good copy plus held corrupt copy | passes on the old code as well, as the plan expected: IN-03 changes how the rule is written, not what it does |
| (d) | doc.compact blob put behind the same ctx | `addEntries(state, [], ctx)` returned the same state, still held |
| (d) | version.propose text blob behind the same ctx | refolds 0 (expected 1); still held |
| (d) | reducer-stage missing-key, key ring regains the key | refolds unchanged; still held |
| (d) | the 80-seed property, and the same-context variants added to the CR-02 and CR-03 properties | diverged from the fresh fold (applied list short by the compactions) |

## Task Commits

1. **Task 1 (tracer): skip a re-delivered entry by its hash before any verification**: `f9c0b125` (fix). Tracer gate: verify re-run end to end and passed, then expansion went ahead.
2. **Task 2: bounded held copies and numeric outcome rank (IN-03)**: `2c1c42df` (fix)
3. **Task 3: retry reducer-stage holds the same context can now answer**: `6f1142cd` (fix)

Each commit holds its tests and the code together. The RED runs above were taken on the unchanged code before each fix and are recorded here.

## Files Created/Modified

- `src/domain/replica/holdWaits.ts` (new, pure; imports `blobBytesHash` from `entry` and types from `chain`, `rosterView` and `verify`, no reducer): `HoldWait`, `waitOf`, `waitAnswered`.
- `src/domain/replica/fold.ts`:
  - `knownCopy`, `bodyIntact`, `OUTCOME_RANK` and `compareOutcomes`.
  - `Chosen` holds `retry: Map<reason, copy>` and `rejected`.
  - `retryHeld` judges kept copies from the best rejection.
  - `FoldResult.dropped`.
  - `earliestAnswerable`, wired into `addEntries`.
- `src/test/replicaReevaluation.test.ts`: 12 new tests (from 6 to 18), plus same-context variants added to the CR-02 120-order property, the CR-03 blob property (80 more orders) and the CR-03 key test. No existing assertion was changed (P-31-03); the only removed lines are three import lines that were widened.

## Decisions Made

- **Blob wait:** `{ kind: 'blob'; hash; stream; epoch }`. It asks for the key and for a blob whose bytes match its name, not only `ctx.blobs(hash) !== undefined`. versions.ts `readBlobText` holds missing-blob also when the key is missing. A damaged blob under the right name would otherwise make every later delivery refold without releasing anything. A test pins that a wrong-bytes blob returns the same state.
- **Entry wait:** `newlyAdmitted` is true only when this call admitted an entry that sorts before the held entry. Such an arrival already refolds through `commonPrefix`. One sorting after the hold is also after it in the fresh fold. So entry waits never add refolds, and the existing refold counts in replicaOrder, replicaCheckpoint and replicaConvergence stay exact.
- **Unreadable inputs:** they still leave one rejected record per reason, because the reason set is closed and therefore bounded. replicaEntry ("rejected unknown-header-version") and replicaCheckpoint pin that record. The inputs themselves are not kept. A delivery of junk alone returns a new state whose only change is the `dropped` count, with no refold, so the incremental `dropped` equals the fresh fold's.
- **Seen set:** removed rather than turned into a `Set<string>`. The `chosen` map is already keyed by entry hash and is what `knownCopy` consults.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] A good copy held for one reason was dropped when a copy held for a smaller reason arrived first**
- **Found during:** Task 2
- **Issue:** with the string rank, a corrupt copy (`body-missing-or-corrupt`) beat a good copy held `missing-key`. The good copy was never put on the retry list. After the key arrived, the entry stayed held while the fresh fold applied it. Re-ingested copies whose reason changed were also lost.
- **Fix:** keep one copy per hold reason (as the plan asked) and judge kept copies again from the best rejection.
- **Files modified:** src/domain/replica/fold.ts
- **Verification:** test "(c) a copy held for a different reason is kept as a second copy..." failed on the old code and passes now.
- **Committed in:** 2c1c42df

**2. [Rule 2 - Correctness] Bounding held copies could have lost the good copy while the writer is unknown**
- **Found during:** Task 2
- **Issue:** `unknown-writer` is reached before the body check, so an intact copy and a corrupt copy share that reason. Keeping only the first copy could keep the corrupt one.
- **Fix:** `bodyIntact` (a body length and sha256 check, no decryption) lets an intact copy replace a corrupt one under the same reason.
- **Files modified:** src/domain/replica/fold.ts
- **Verification:** test "(c) while the writer is unknown, an intact copy is kept..." covers both arrival orders.
- **Committed in:** 2c1c42df

**3. [Plan shape] `HoldWait` blob variant carries stream and epoch; holdWaits.ts imports one value (`blobBytesHash`) from entry**
- The plan listed `{ kind: 'blob'; hash: string }` and type-only imports. See Decisions for why the key and the byte check are needed. The guard in the plan (no import of textFold, versions or projectFold) holds: the count is 0.

**4. [Test scope] The plan's "re-run the full suite"**
- Replaced by every replica test file, as the brief says: 21 files, 283 tests, all pass.

**Total deviations:** 2 auto-fixed (1 bug, 1 correctness) and 2 shape notes. **Impact:** both fixes are needed for the incremental fold to equal the fresh fold once copies are bounded. No scope creep: only the three planned files changed.

## Issues Encountered

- My first version of the property scenario never reached `updates-missing`: the early proposal cited nothing, sorted before product.create and was held `product-unknown`. Citing product.create fixed it. The property now asserts that it reaches missing-blob, missing-key, unregistered-client and updates-missing.
- A copy of an entry whose chosen outcome is rejected is still verified again on each delivery. Each such copy may carry a different body, and the plan scopes the skip to verified entries. This is not a defect: the cost per copy is the same as for a new entry. A later hardening could skip header-only rejections (`bad-signature`).

## Test Results

- Task 1: replicaReevaluation 10/10 (was 6).
- Task 2: replicaReevaluation, replicaConvergence and replicaCheckpoint: 33/33; replicaReevaluation has 14 tests.
- Task 3: replicaReevaluation, replicaConvergence, replicaVersions, replicaDoc, replicaBoundaries and replicaCheckpoint: 86/86; replicaReevaluation has 18 tests.
- All 21 `dist/test/replica*.test.js` files: 283/283 pass. Every run was memory-capped and behind the shared build lock.
- Acceptance greps:
  - `knownCopy` in fold.ts: 2
  - `Set<unknown>`: 0
  - `OUTCOME_RANK`: 2
  - `waitAnswered`: 2
  - reducer imports in holdWaits.ts: 0

## User Setup Required

None. This change is internal; there is no CHANGELOG entry and no new dependency, endpoint or agent ability.

## Next Phase Readiness

- 31-13 (the store) can feed the fold repeatedly under one long-lived context object and fill in blobs and keys behind it.
- New reducer hold reasons that should be retried under the same context need a row in `holdWaits.ts`. 31-04 and 31-07 own textFold.ts and versions.ts; any hold reason they add is otherwise retried only when something new is admitted, as before.

## Self-Check: PASSED

- FOUND: src/domain/replica/holdWaits.ts, src/domain/replica/fold.ts, src/test/replicaReevaluation.test.ts
- FOUND commits: f9c0b125, 2c1c42df, 6f1142cd (ancestors of HEAD)

---
*Phase: 31-staff-roster-cell-keys-and-migration*
*Completed: 2026-11-20*
