---
phase: 30-replication-contract-and-co-editing-core
plan: 09
subsystem: replica-core
tags: [replication, ordering, checkpoints, incremental-fold, transport-types]
status: complete

requires:
  - phase: 30-02
    provides: the fold, causal graph, total order, reducer contract and shared test world
provides:
  - incremental folding (FoldState, createFoldState, addEntries) that equals the from-scratch fold
  - signed checkpoints with count and orderTip per stream, verification, recomputation and hub equivocation proofs
  - the rule that checkpointed order is final (nested chain, isFinal, FoldResult.checkpoint)
  - ReplicaTransport and its types (types only) and an in-memory fake transport for tests
affects: [30-10, 30-11, 30-12, Phase 32 hub, Phase 33 and 34 transports]

actuals:
  tokens: 23000
  tasks: 3
  commits: 4
plan_head_before: f2c4c62aab440dbb5734ae8b8b9f1bb83eadebd2
plan_head_after: e80141ec22728c6315a1f028b84fbe2aa93cca76

tech-stack:
  added: []
  patterns: [one apply loop shared by the from-scratch and incremental paths, copy-on-write fold state, refold from a prefix snapshot, hub-side checkpoint module with no fold or Yjs import]

key-files:
  created:
    - src/domain/replica/checkpoint.ts
    - src/domain/replica/transport.ts
    - src/test/helpers/replicaFakeTransport.ts
    - src/test/replicaOrder.test.ts
    - src/test/replicaCheckpoint.test.ts
  modified:
    - src/domain/replica/fold.ts
    - src/domain/replica/order.ts
    - src/domain/replica/digest.ts

key-decisions:
  - "orderTip_k = sha256(rawBytes(tip_(k-1)) || rawBytes(entryHash_k)) from 64 zeros, over the stream's covered entries in final order."
  - "The checkpoint hash is sha256 of canonical {payload, sig}; FoldResult.checkpoint carries it."
  - "verifyCheckpoint requires the sorted, duplicate-free form signCheckpoint writes, so one meaning has one set of bytes."
  - "A checkpoint conflict without entries is equal count with different tips for one stream from one signer; with entries it is not-nested (the earlier covers entries the later does not) or prefix-mismatch (the later's tip differs from the nested order after the earlier)."
  - "An addEntries call on an empty state is never counted as a refold, even when a checkpoint becomes usable in that call."
  - "A change in which checkpoint is used, or in the size of the final set, forces a refold rather than an append, so isFinal never changes under entries already applied."

requirements-completed: [MUS-01]

coverage:
  - id: D1
    description: "Incremental folding appends when everything new sorts last and refolds for a late concurrent entry; the result equals foldEntries for any delivery order, duplication and partition"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaOrder.test.ts (5 incremental tests, plus the 200-seed property and the 100-seed random-checkpoint property)"
        status: pass
  - id: D2
    description: "totalOrder equals a Kahn topological sort on 200 seeded random histories"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaOrder.test.ts#totalOrder equals a Kahn topological sort with the same tie-break on 200 seeded random histories"
        status: pass
  - id: D3
    description: "Checkpoint format, signing with purpose staff-replica, verification against the device key and RosterView.checkpointSigner, header/checkpoint cross-refusal"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaCheckpoint.test.ts (round trip, bad-signature, not-a-checkpoint-signer, unknown-signer, header cross-refusal, hostile input)"
        status: pass
  - id: D4
    description: "Checkpointed order is final: sort(covered) then sort(rest), nested chains, isFinal, FoldResult.checkpoint, non-nesting checkpoints reported"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaCheckpoint.test.ts (final prefix, nested checkpoints, non-nesting checkpoint)"
        status: pass
  - id: D5
    description: "recomputeCheckpoint names count, order tip and digest mismatches; checkpointConflict gives hub equivocation proofs with and without entries"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaCheckpoint.test.ts (recompute, equal-count proof, prefix and not-nested proofs)"
        status: pass
  - id: D6
    description: "ReplicaTransport and its types exist as types only; two replicas converge through the in-memory fake; refold from the prefix snapshot does not re-apply prefix entries"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaCheckpoint.test.ts (fake transport convergence, snapshot refold, late entry inside the prefix)"
        status: pass
---

# Phase 30 Plan 09: Ordering, finality and incremental folding Summary

A machine that folds entries as they arrive now reaches the same state and digests as one that folds them all at once, checkpoints make their covered order final, and the transport interface exists as types.

## What was built

- **Incremental fold** (`fold.ts`): `createFoldState` and `addEntries` share the verify cache, chain classification and the one apply loop with `foldEntries`, which stays the from-scratch path. New entries that sort after everything applied are appended to cloned reducer states. Anything else (a late concurrent entry, an entry that leaves the admitted set, a change in what is final) refolds, counted in `refolds`. Verify outcomes are cached by entry hash, held entries are looked at again on each call, and an earlier `FoldState` is never changed.
- **Prefix snapshot**: the reducer states at the end of the final prefix are kept, so a late entry outside the prefix refolds from there. A counting reducer in the tests shows prefix entries applied once, against twice for the first entry without a checkpoint.
- **Checkpoints** (`checkpoint.ts`): `{type, v, project, signer, rosterHead, streams[{stream, heads, count, orderTip, digest?}]}` signed through `signPayload` with purpose `staff-replica` and the constant `signedAt`. `verifyCheckpoint` never throws and checks shape, the signer's device key, the signature, then `RosterView.checkpointSigner` at `rosterHead`. `checkpointCoverage`, `orderTipOf`, `recomputeCheckpoint` (count, orderTip, digest, missing entries, unlisted streams) and `checkpointConflict` (hub equivocation proof) are exported. The module imports no fold, reducer or Yjs code.
- **Order** (`order.ts`): `kahnOrder` (test reference, not called by the fold) and `checkpointOrder`. The fold picks the longest nested chain of checkpoints, independent of the order the caller lists them in, and reports non-nesting ones in `FoldResult.checkpointConflicts`.
- **Transport** (`transport.ts`): types only. `createFakeTransport` in the test helpers is an in-memory bundle-like transport.
- `digest.ts` documents that digests are compared only between results with the same `FoldResult.checkpoint`.

## Verification

All runs under the shared lock with a 4 GB cap, no swap, 300 s timeout (not the plan's 6 GB / 1800 s).

- `replicaOrder.test.js`: 10 tests (Kahn property over 200 seeds, 200-seed delivery/duplicate/partition equivalence, 100-seed random-checkpoint equivalence), pass.
- `replicaCheckpoint.test.js`: 14 tests, pass.
- `replicaTracer.test.js`: 10 tests, pass. `replicaContracts.test.js` and `replicaVendor.test.js`: 24 tests, pass.
- `tsc -p tsconfig.json` clean. Whole run of the three plan targets: 34 tests, 34 pass, about 21 s.
- Acceptance greps: `grep -c kahnOrder fold.ts` = 0; `grep -c orderTip checkpoint.ts` = 10; `grep -c "interface ReplicaTransport" transport.ts` = 1; no runtime export in `transport.ts`; `grep -c refolds fold.ts` = 7.

## Deviations from Plan

None that change behaviour. Additions and notes:

- **[Rule 2 - additive API]** Exports beyond the plan's list: `checkpointHash`, `readCheckpoint`, `normaliseCheckpoint`, `CHECKPOINT_VERSION`, `ORDER_TIP_START`, `CHECKPOINT_MISMATCHES`, `CHECKPOINT_CONFLICTS`, `CheckpointNote`. `recomputeCheckpoint` takes an optional fourth argument `earlier` (checkpoints it nests after), needed so a later checkpoint's tip is recomputed under the nested order the fold uses.
- **[Rule 1 - found while testing]** The first version counted a refold when a checkpoint became usable in the very first `addEntries` call from an empty state. Fixed: nothing applied means nothing to start again.
- A checkpoint offered to `verifyEntry` as a header is refused at the header shape with `unknown-header-version` (its `v` is 1), not `malformed-header`. It is still rejected and never an entry; changing `entry.ts` to report it differently was outside this plan's files.
- `reducers.ts` still says in a comment that `isFinal` answers false until plan 30-09; the file is not in this plan's ownership and the comment is now out of date.
- The `commits:` count of 4 is measured before this SUMMARY commit.

## Known Stubs

None.

## Threat Flags

None. The mitigations T-30-35 to T-30-38 are implemented and tested: `verifyCheckpoint` (T-30-35), count and orderTip with `checkpointConflict` (T-30-36), refold on late entries with the 200-seed equivalence properties (T-30-37), and the `type` field with closed keys refused in both directions (T-30-38).

## Self-Check: PASSED

Files found: checkpoint.ts, transport.ts, replicaFakeTransport.ts, replicaOrder.test.ts, replicaCheckpoint.test.ts, 30-09-SUMMARY.md. Commits 8b4b90b8, 8dd785a8, 119d748f, e80141ec are ancestors of HEAD on agent-30-09.
