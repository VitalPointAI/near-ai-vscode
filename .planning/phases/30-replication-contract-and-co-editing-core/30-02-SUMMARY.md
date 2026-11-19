---
phase: 30-replication-contract-and-co-editing-core
plan: 02
subsystem: replica-core
tags: [replication, entry-format-v2, yjs, crdt, causal-graph, fold, signed-payload, aes-gcm]
status: complete

requires:
  - phase: 30-01
    provides: vendored Yjs 13.6.33 and lib0 0.2.119 bundle, the staff-replica signing purpose
provides:
  - src/domain/replica/: entry format v2, RosterView contract, closed list of 50 kinds, one schema file per kind family, verification, causal graph with transitive queries, per-writer chains, total order, reducer contract, fold engine, per-stream digest, the Yjs adapter and the text reducer
  - the tracer: two writers, one signed and sealed doc.update each, same text, state vector and digest in all delivery orders
  - src/test/helpers/replicaWorld.ts, the shared test world for every later replica plan
affects: [30-03 through 30-12, Phase 31 migration and roster fold, Phase 32 hub]

actuals:
  tokens: 28400
  tasks: 3
  commits: 8
plan_head_before: d00b14ee2c7ab9e68c5bfb1d0d834cdaf321b007
plan_head_after: 5e1a4aeac99ea1df39144e538db913ef081757a8

tech-stack:
  added: []
  patterns: [entry format v2 with constant signedAt for deterministic re-signing, AAD without sig and body.hash, reducer contract with apply/finish/canonical/clone, hub-side modules with no Yjs import, fail-closed schema files per family]

key-files:
  created:
    - src/domain/replica/entry.ts
    - src/domain/replica/rosterView.ts
    - src/domain/replica/kinds.ts
    - src/domain/replica/kindSchemas/shared.ts
    - src/domain/replica/kindSchemas/project.ts
    - src/domain/replica/kindSchemas/roster.ts
    - src/domain/replica/kindSchemas/doc.ts
    - src/domain/replica/kindSchemas/versions.ts
    - src/domain/replica/kindSchemas/registers.ts
    - src/domain/replica/kindSchemas/watches.ts
    - src/domain/replica/kindSchemas/runs.ts
    - src/domain/replica/kindSchemas/obs.ts
    - src/domain/replica/kindSchemas/integrity.ts
    - src/domain/replica/verify.ts
    - src/domain/replica/causal.ts
    - src/domain/replica/chain.ts
    - src/domain/replica/order.ts
    - src/domain/replica/reducers.ts
    - src/domain/replica/fold.ts
    - src/domain/replica/digest.ts
    - src/domain/replica/doc.ts
    - src/domain/replica/textFold.ts
    - src/test/helpers/replicaWorld.ts
    - src/test/replicaTracer.test.ts
    - src/test/replicaContracts.test.ts
  modified: []

key-decisions:
  - "textAtSnapshot returns undefined (not partial text) when the supplied updates do not reach the snapshot; snapshotMissing tells that case apart from an undecodable snapshot."
  - "decodeSnapshot accepts only bytes that re-encode to themselves, so trailing bytes and non-canonical input are refused."
  - "past(hash) is cached per queried entry, not per ancestor, so a 5000-entry chain costs one walk and no quadratic memory."
  - "snapshotMissing also checks that every deleted range in the snapshot is deleted in the scratch doc, because a missing delete-only update leaves the state vector short of nothing."

requirements-completed: [MUS-01, MUS-02]

coverage:
  - id: D1
    description: "Two writers each register a Yjs client id and sign and seal one doc.update; foldEntries gives the same text, state vector and per-stream digest in either delivery order and with duplicates, all four entries applied and nothing held, rejected or kept"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaTracer.test.ts#two writers each sign and seal one doc.update, and the fold gives the same text, state vector and digest in either delivery order"
        status: pass
      - kind: unit
        ref: "src/test/replicaTracer.test.ts#every one of the 24 delivery orders of the four entries gives one text and one digest"
        status: pass
      - kind: unit
        ref: "src/test/replicaTracer.test.ts#delivering every entry twice gives the same digest and the same lists as delivering each once"
        status: pass
  - id: D2
    description: "Entry format v2, deterministic signing, AAD binding, blob offload over 16 KB, missing-key held, wrong key rejected, wrong device key rejected as bad-signature"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaTracer.test.ts (10 tests, all pass)"
        status: pass
  - id: D3
    description: "A foreign client id is refused as foreign-client and changes no text"
    requirement: MUS-02
    verification:
      - kind: unit
        ref: "src/test/replicaTracer.test.ts#an update that inserts text under a client id registered to the other writer is refused as foreign-client and changes no text"
        status: pass
  - id: D4
    description: "One fail-closed schema file per kind family; kinds.ts dispatches by family; doc.client and doc.update validate with a path in each refusal"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaContracts.test.ts (3 Task 2 tests)"
        status: pass
  - id: D5
    description: "Causal relations (past, isBefore, concurrent, closure), the full static roster view and Yjs snapshot text, as tested shared contracts"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaContracts.test.ts (14 Task 3 tests, including a 5000-entry chain and delete-only snapshot cases)"
        status: pass
---

# Phase 30 Plan 02: The replica core tracer and its shared contracts Summary

The replica core now exists end to end under `src/domain/replica/`: two writers each sign and seal a `doc.update`, and the fold verifies, orders and merges them to the same text, state vector and digest in every delivery order, with duplicates, and under hostile cases (foreign client id, missing or wrong key, wrong device key). Nothing in the extension calls it yet.

## Interruption note

This plan was executed by two agents. The first was interrupted by a machine restart (uncapped test runs had exhausted memory) after it committed Task 1 (six layer commits) and the schema files of Task 2. It left no record of whether the `<verify>` runs passed. A second agent resumed in the same worktree: it re-ran the Task 2 verify (it passed, nothing needed fixing), did Task 3, re-ran every type check, and wrote this summary. All runs below were made under the memory cap (4 GB, no swap, 300 s timeout) and the shared heavy lock, not the plan's 6 GB / 1800 s, because the full suite was not run.

## Commits

| Commit | Layer | Type check at that commit |
|--------|-------|---------------------------|
| `39dd56d3` | Task 1, layer 1 format: entry.ts, rosterView.ts | tsc --noEmit exit 0, no output |
| `eda38f64` | Task 1, layer 2 validation: kinds.ts, kindSchemas/doc.ts, verify.ts | exit 0, no output |
| `39afd3e4` | Task 1, layer 3 graph: causal.ts, chain.ts, order.ts | exit 0, no output |
| `11782770` | Task 1, layer 4 text: reducers.ts, doc.ts, textFold.ts | exit 0, no output |
| `02345c40` | Task 1, layer 5 fold: fold.ts, digest.ts | exit 0, no output |
| `2fe21abf` | Task 1, layer 6 tests: replicaWorld.ts, replicaTracer.test.ts | exit 0, no output |
| `c6b61e45` | Task 2: shared.ts, eight family schema files, kinds.ts dispatch, replicaContracts.test.ts | exit 0 (full compile in the verify run) |
| `5e1a4aea` | Task 3: causal queries, snapshot functions in doc.ts, 14 contract tests | exit 0 (full compile in the verify run) |

The type-check results for the six Task 1 layers were established after the fact by exporting each commit with `git archive` into a scratch folder and running `tsc -p tsconfig.json --noEmit` there; the original run results were not recorded before the interruption. All six passed, so each layer compiled on its own as the plan requires.

## What was done

1. **Task 1 (tracer), six commits above.** Entry format v2 (`{v: 2, stream, writer, seq, prev, epoch, body: {hash, size}, sig}`), the signer adapter on `signPayload` with purpose `staff-replica` and the constant `signedAt`, AES-256-GCM sealing through `sealRaw` with an AAD that leaves out `sig` and `body.hash`, blob offload over 16 KB, `RosterView` and `staticRosterView`, the closed list of 50 kinds, `verifyEntry`, the causal graph, per-writer chain classification, the (lamport, writer, seq, stream, hash) total order, the reducer contract, `foldEntries`, the per-stream digest, the only Yjs loader (`doc.ts`), the text reducer with client-ownership checks, and the shared `replicaWorld.ts` helper with the tracer test.
2. **Task 2, `c6b61e45`.** `kindSchemas/shared.ts` (with `SCHEMA_PENDING` and the validation helpers), eight family files that refuse every kind with `SCHEMA_PENDING: <family> <kind>`, `doc.compact` fail-closed in `kindSchemas/doc.ts`, `kinds.ts` dispatching to the nine files, and the first three contract tests. No file under `kindSchemas/` imports `kinds.ts`.
3. **Task 3, `5e1a4aea`.** `causal.ts` gained `past`, `isBefore`, `concurrent` and `closure`, all walked with an explicit stack (a 5000-entry chain is tested). `rosterView.ts` already implemented every method to the specified semantics, so only tests were added for it (three-roster spec: positions, a device admitted only at position 1, `deputy_lead`, `roleWithdrawnBy`, `chosenBranch`, `checkpointSigner`). `doc.ts` gained `snapshotOf`, `decodeSnapshot`, `snapshotStateVector`, `snapshotMissing` and `textAtSnapshot` (scratch document, garbage collection off, the fold document is never touched). 14 new tests.

## Verification

Run under the cap and the heavy lock, from the last Task 3 code state (the commit adds no code beyond what was tested):

- `node scripts/vendor-libs.mjs && tsc -p tsconfig.json && run-tests dist/test/replicaContracts.test.js dist/test/replicaTracer.test.js dist/test/teamSignedPayload.test.js`: tsc clean, 49 tests, 49 pass, 0 fail. By file: `replicaContracts` 17 (3 from Task 2, 14 from Task 3), `replicaTracer` 10, `teamSignedPayload` 22.
- Task 2's own verify (`replicaContracts` + `replicaTracer`) ran first, before any Task 3 change: 13 tests, 13 pass.
- Acceptance checks: `staff-replica` appears 4 times and `REPLICA_SIGNED_AT` 3 times in entry.ts; the only file containing `'vendor', 'yjs'` is `doc.ts`; `REPLICA_KINDS.length` is 50; `kindSchemas/` holds 10 `.ts` files and none imports `../kinds`; `createDocFromSnapshot` appears in `doc.ts` only (3 times); `git rev-list --count --grep="feat(30-02)"` is 8 (6 layer commits plus Tasks 2 and 3); no em-dash in the files changed here.
- The full repository suite was deliberately not run (owner instruction); it belongs to the phase boundary.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug in my own test] A synthetic hash equal to GENESIS_PREV**
- **Found during:** Task 3, first test run
- **Issue:** the 5000-entry chain test numbered its entries from 0, so the first hash was 64 zeros, which is the genesis marker, so entry 1's prev was treated as "no predecessor" and `past` was one short.
- **Fix:** numbered the synthetic entries from 1. The code was right; the test data was wrong.
- **Files modified:** `src/test/replicaContracts.test.ts`
- **Commit:** `5e1a4aea`

**2. [Rule 2 - Missing critical functionality] Snapshot checks beyond the plan's wording**
- **Issue:** the plan defines `snapshotMissing` as "a clock above what the updates reach". A snapshot taken after a delete-only edit has the same state vector as before, so a missing delete update would not be noticed and `textAtSnapshot` would silently return text that still contains the deleted words.
- **Fix:** `snapshotMissing` also reports true when a deleted range of the snapshot is not deleted in the scratch document; `textAtSnapshot` returns `undefined` when the snapshot is missing anything. `decodeSnapshot` also refuses trailing bytes, non-round-tripping bytes and input over `MAX_UPDATE_BYTES`. All covered by tests.
- **Files modified:** `src/domain/replica/doc.ts`, `src/test/replicaContracts.test.ts`
- **Commit:** `5e1a4aea`

No other deviations. Files touched outside the plan's `files_modified`: none (the diff from `d00b14ee` is exactly the 25 listed files).

## Auth gates

None.

## Known Stubs

Intentional, tracked, fail-closed (not UI stubs): the eight family schema files and `doc.compact` in `kindSchemas/` refuse every kind with a reason starting with `SCHEMA_PENDING`, so nothing in them can be accepted by mistake. Owners: project, roster, registers, watches, runs, obs in 30-04; integrity in 30-05; doc.compact in 30-06; versions in 30-08. Plan 30-12 asserts no kind still returns that reason. `DEFAULT_REDUCERS` lists the text reducer only; 30-12 registers the rest. `FoldView.isFinal` answers false until 30-09. `classifyChains` leaves `excluded`, `quarantined` and `proofs` empty until 30-05. The best-effort broken-windows ledger (`.planning/WINDOWS.md`) was not appended to; this summary is the record.

## Threat Flags

None beyond the plan's register. T-30-06 (header signature, tested with a wrong-key re-sign), T-30-08 (foreign-client refusal, tested) and T-30-10 (deterministic re-signing, tested) are covered here; T-30-07 and T-30-09 are tested in 30-04 as planned.

## Notes for later plans

- Wave-3 rule from the plan: `reducers.ts`, `kinds.ts`, `causal.ts`, `rosterView.ts`, `kindSchemas/shared.ts` and `src/test/helpers/replicaWorld.ts` are not edited in wave 3; shared types may only gain fields.
- `past(hash)` returns a shared cached set; callers must not mutate it.
- `textAtSnapshot` and `snapshotMissing` take plain update bytes, so 30-08 can call them without loading Yjs types.
- The test world has one roster (position 0); plans needing several rosters use `staticRosterView` directly, as the roster tests here do.

## Self-Check: PASSED

All 25 files in the plan's list exist in the worktree. Commits `39dd56d3`, `eda38f64`, `39afd3e4`, `11782770`, `02345c40`, `2fe21abf`, `c6b61e45` and `5e1a4aea` are ancestors of HEAD on `agent-30-02`.
