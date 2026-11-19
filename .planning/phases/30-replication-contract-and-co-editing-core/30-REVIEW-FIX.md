---
phase: 30-replication-contract-and-co-editing-core
fixed_at: 2026-11-19T20:00:00Z
review_path: .planning/phases/30-replication-contract-and-co-editing-core/30-REVIEW.md
iteration: 1
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 30: Code Review Fix Report

**Fixed at:** 2026-11-19T20:00:00Z
**Source review:** .planning/phases/30-replication-contract-and-co-editing-core/30-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 3 (CR-01, CR-02, CR-03; the nine warnings and three info items were not in scope and remain in REVIEW.md)
- Fixed: 3
- Skipped: 0

Verification ran in the phase worktree `.claude/worktrees/plan-phase-30` (branch `plan/phase-30`), not in the main checkout. Type check (`tsc -p tsconfig.json`)
and the replica, signed payload, team boundary and staff release test files were run there with a memory cap; the full suite was not run.
Final totals of that run: 303 tests, 303 pass, 0 fail, 0 skipped (23 files: every `replica*.test.js`, `teamSignedPayload`, `teamBoundaries`, `staffRelease`).

## Fixed Issues

### CR-01: A provisional `doc.compact` lets any admitted device write text that is attributed to another device and member

**Files modified:** `src/domain/replica/attribution.ts`, `src/domain/replica/textFold.ts`, `src/test/replicaDoc.test.ts`
**Commit:** cc0d6b2f
**Status:** fixed: requires human verification (attribution rule, see below)
**Applied fix:** Option (a) of the review. `attributeText` takes an optional proof (`AttributionProof`): how far the accepted updates reach for each client
(the state vector of the document built from accepted updates) and the writer of the newest unverified compaction. A character at (client, clock) that
no accepted update backs gets `unverified: true`; it is attributed to the compaction's writer when its client id is registered to that writer, and is
`UNATTRIBUTED_WRITER` (no writer, no member) otherwise. Runs are split exactly where the accepted updates end. `summariseAuthors` keeps unverified
characters in their own rows. `ProductText.provisional` now records the writer of each provisional compaction. Digests are unchanged (attribution is not
in the canonical state). Once the log holds the covered updates, the same text is proven and attributed to its real author.
**Existing test changed on purpose:** "a set with the registrations and a compaction but none of the covered updates loads the compaction
provisionally" asserted that a joiner holding only the compaction sees the full log's writers on every span, which is the forged behaviour itself. It now
asserts the same text, state vector and span places, that every span is unverified and unattributed, and that adding the covered updates gives exactly the
full log's attribution. Nothing else was relaxed.
**Regression tests:** `src/test/replicaDoc.test.ts` "CR-01: text a provisional compaction holds under another device's client id is never attributed ..."
and "CR-01: the log's own text keeps its author next to unverified text ..." (both fail on the old `textFold.ts`).

### CR-02: The outcome of a compaction depends on whether its cover entries had arrived, so the incremental and the from-scratch fold diverge

**Files modified:** `src/domain/replica/fold.ts`, `src/domain/replica/reducers.ts`, `src/domain/replica/textFold.ts`, `src/test/replicaReevaluation.test.ts` (new)
**Commit:** 5936754f
**Status:** fixed: requires human verification (fold logic)
**Applied fix:** The review offered two shapes; this is the second ("the incremental path must refold when a later entry changes an earlier outcome"),
because the first (decide from the compaction's own past only) would change two committed test expectations (a hostile compaction that names updates it does
not cite is refused `compact-mismatch` once those updates are in the set, and loaded provisionally when they are not). A reducer may now declare
`lateDependencies(entry)`: the hashes of other entries whose later arrival changes that entry's outcome. The text reducer names the covers of every
`doc.compact`. `addEntries` computes, for the entries newly admitted, the earliest entry of the old order that one of them can change
(`earliestLateEffect`); when there is one it does not append but starts again, from the prefix snapshot only if the snapshot was taken at or before that
entry, otherwise from scratch, and counts it in `refolds`. The from-scratch outcome is unchanged, so no committed vector moved.
**Regression tests:** `src/test/replicaReevaluation.test.ts` CR-02 group: a hostile compaction whose cover is delivered last (and the refold count);
120 random one-at-a-time and chunked deliveries of hostile (cover sorts after, cover never arrives) plus honest compactions equal `foldEntries` on the whole
result; a compaction inside a checkpoint prefix whose cover arrives later is judged again instead of read from the snapshot. All three fail on the old `fold.ts`.

### CR-03: Holds that depend on the context (blob, key, clock) are never retried

**Files modified:** `src/domain/replica/fold.ts`, `src/test/replicaReevaluation.test.ts`
**Commit:** 58a0b53f
**Status:** fixed: requires human verification (fold logic)
**Applied fix:** `addEntries` treats a `ctx` that is not the object the state was folded under as a change: it no longer returns the old state, and when
anything was applied it starts again from the beginning (the prefix snapshot was taken under the old context, so it is not reused) and counts the start in
`refolds`. A new context with nothing applied yet is simply taken. The same object, or none, with nothing new still returns the same state, so a stable
context costs nothing. The doc comment of `addEntries` now says this. Verify-stage holds (unknown writer, missing key or roster) were already retried by
`retryHeld`; chain-stage `future-dated` is recomputed by `prepare` and only failed because of the early return.
**Regression tests:** `src/test/replicaReevaluation.test.ts` CR-03 group: a compaction held `missing-blob` is applied when a context with the blob replaces
the old one, with and without new entries, and in 80 random orders with the context replaced at a random point (fails on the old code); entries held for a
missing key are applied when the key arrives (passes on the old code too, since that hold is verify-stage); a future-dated entry and the entry chained
after it are released when the clock moves on, and held again when it moves back (fails on the old code).
**Not done:** `replicaConvergence.test.ts` was not extended; the context-change property lives in the new file instead (cheaper, and no existing assertion
is touched).

## Skipped Issues

None.

## Notes for the owner and the reviewer

- A reducer-stage `missing-key` hold can only arise when a key ring loses a key after the entry was verified; a from-scratch fold under that ring holds the
  entry at verify instead, so there is nothing to compare, and no test was written for it.
- Outcomes decided under an old context for entries that were verified or rejected (not held) are not re-verified when a context is replaced; the store
  keeps no copy of those inputs. The roster is linear and append-only, so this does not matter for Phase 30; Phase 31 should decide whether a roster change
  can reject something that was admitted.
- The fold's cost: a replaced context is a full refold. Callers should pass the same context object while nothing changed.

---

_Fixed: 2026-11-19T20:00:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
