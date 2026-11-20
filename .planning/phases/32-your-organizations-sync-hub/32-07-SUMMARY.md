---
phase: 32-your-organizations-sync-hub
plan: 07
subsystem: staff replica store
status: complete
tags: [replica, marks, flood-bound, fsync, D-14, D-06, D-03, MUS-06]
requires:
  - 32-01 (syncFolder and setFolderSyncProbe in src/staff/staffFiles.ts; store.ts as 32-01 left it)
provides:
  - MAX_REFUSED_PER_WRITER = 1_000, FLOODED_REASON, FLOODED_TEXT and ReplicaStore.flooded() in store.ts
  - IngestResult.flooded and IngestResult.deferred
  - ReplicaStoreDeps.limits (tests only)
  - MAX_MARK_LISTED = 10_000 (held) and MAX_MARK_WAITING = 100_000 (waiting) in marks.ts
  - lists folder sync (writeListsFile, ensureListsFolder) before the signed record is stored
affects:
  - Phase 33 Staff Room (shows FLOODED_TEXT for each entry of store.flooded())
  - the hub delivery path (a deferred entry must be delivered again; flooded entries are not)
tech-stack:
  added: []
  patterns: [per-writer and per-store bound with one marker line, check skipped for a writer the batch will flood, folder fsync after rename and mkdir]
key-files:
  created:
    - src/test/staffReplicaMarks.test.ts
  modified:
    - src/staff/replica/store.ts
    - src/staff/replica/marks.ts
    - src/test/staffReplicaStore.test.ts
    - SECURITY.md
decisions:
  - A flooded line is a held item with FLOODED_REASON, so the lists file keeps its version 3 shape and 0.4.35 marks still read (unless their held list is over 10,000)
  - The check is not run for a writer already flooded or that this batch will flood; under the locks an unchecked entry whose writer turns out not to be flooded is deferred, so it is checked when it comes again
  - A refused entry the full held list has no room for is counted in flooded (not deferred), as the plan says; its writer is not flooded, so its passing entries are still written
  - limits values above their constants fall back to the constants, so a test cannot make a store write a mark that does not read back
metrics:
  duration: about 30 minutes
  completed: 2026-11-20
actuals:
  tokens: 17669
  tasks: 3
  commits: 3
plan_head_before: f9694b721bc4827ce85b5664d9ea395443289eb6
plan_head_after: e2d10c79a8e176980e9e518282f6833d269764b0
---

# Phase 32 Plan 07: Mark durability and bounds Summary

One device can no longer grow this device's signed mark until it cannot be written: refused entries are held up to 1,000 per writer per stream (the 1,000th as that writer's one flooded line) and 10,000 per store, waiting entries up to 100,000 with the rest deferred, and the lists folder is synced to disk before the signed record names the lists file.

## What changed

- `src/staff/replica/store.ts`
  - `MAX_REFUSED_PER_WRITER = 1_000`, `FLOODED_REASON` (equal to `heldReason` of itself), `FLOODED_TEXT` (the Phase 33 sentence).
  - Per (stream, writer) held counts, a store total and the flooded set, rebuilt from `held` at the end of every `syncMark` (stored entries only) and kept current by `hold()`.
  - `ingestForeign`, in input order under the locks: an entry of a flooded file is not written (`flooded`); a refused entry is held, or held as the flooded line when it is its writer's 1,000th or fills the held list (10,000), or not kept when the held list is full (`flooded`); an entry that would wait while the waiting list is full is not written (`deferred`). The check is not called for a writer already flooded or that this batch floods.
  - `recheck`: the same bounds. A flooded writer's waiting entries are not checked and stay waiting; a refusal the full held list cannot take stays waiting.
  - `runCheck`: a check reason equal to `FLOODED_REASON` is stored as `check: ...` (T-32-20).
  - `flooded()`, `IngestResult.flooded` and `.deferred`, `ReplicaStoreDeps.limits` (tests only).
- `src/staff/replica/marks.ts`: `MAX_MARK_LISTED = 10_000` for held and new `MAX_MARK_WAITING = 100_000` for waiting, in `parseReplicaMark` and `signedPayloadOf`. `writeListsFile` calls `syncFolder` on the lists folder after the rename. `ensureListsFolder` syncs the parent after each `mkdir`. A sync error stops `writeMark` before the secret is stored.
- `SECURITY.md`, in `### The replica store and rollback detection`: the record stays a few hundred bytes and the lists file is bounded (1,000 per device per part of the project, 10,000 in all, 100,000 waiting; past a device's bound its later changes are not kept, noted once, everyone else still recorded). The lists folder is synced to disk before the record names it. An interrupted Start Again finishes on the next open and never starts empty, and a missing store folder is rebuilt from the newest verifying set-aside folder, which the result names.

## Tests and failing-first evidence

- **Task 1** (staffReplicaStore.test.ts, 2 new tests: "D-14 flooded: ... 1,200 refused ..." and "... a check reason that equals the flooded line ..."). On the 32-01 code, with only the new exports stubbed so it compiled: `tests 37, pass 35, fail 2` (`actual: 1200, expected: 1000`; reasons not prefixed with `check: `). After: store and Start Again `tests 60, pass 60`.
- **Task 2** (store test: store bound at the real 10 x 999 + 20 figures, recheck flooded line, recheck with a full held list, waiting bound with `limits: { waiting: 5 }`; new staffReplicaMarks.test.ts: the moved parse-limit test at the new figures, held at and over 10,000, writeMark refusals). On the Task 1 code, with `MAX_MARK_WAITING` and `limits` stubbed: store plus marks `tests 43, fail 5`, and the marks file alone `fail 3`. The two held-bound marks tests first passed on the old code because they used the constant by name, so they were changed to the written-out figures (10,000 and 100,000) and then failed as they should. After: store, marks and project `tests 58, pass 58`.
- **Task 3** (marks test: sync order with a secret store that records the probe log when `store()` runs, a sync error, a store's first mark; store test: SECURITY.md phrases). On the Task 2 code: `fail 5`. Those 5 were the 4 new tests plus the known flake below. Sample: `actual: [ [] ], expected: [ [ 'store synced', 'marks synced', 'lists synced with the lists file' ] ]`, and "Missing expected rejection" for the sync error.
- **Final:** marks, store, Start Again, project and membership `tests 127, pass 126, fail 1`; the one failure is the pre-existing flake below. Every staffReplica*.test.js file (12 files) `tests 272, pass 272, fail 0`. `npm run lint` exits 0. All runs used the memory cap.

Acceptance greps:
- `FLOODED_REASON` in store.ts: 9
- `MAX_MARK_LISTED = 100_000`: 0
- `MAX_MARK_WAITING = 100_000`: 1
- syncFolder inside writeListsFile: 1
- `10,000` in SECURITY.md: 1
- em-dashes in SECURITY.md: 0
- tests in staffReplicaMarks.test.ts: 6

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Test teeth] Held-bound tests used the constant by name**
- **Found during:** Task 2 failing-first run
- **Issue:** two new marks tests passed on the old code because `MAX_MARK_LISTED + 1` was 100,001 there.
- **Fix:** the tests use the written-out figures `HELD_BOUND = 10_000` and `WAITING_BOUND = 100_000`.
- **Files modified:** src/test/staffReplicaMarks.test.ts
- **Commit:** 1a66360f

**2. [Rule 2 - Bound the check too] No check for a writer the batch will flood**
- The plan's behaviour only requires that a flooded writer's later entries are not checked. ingestForeign and recheck also skip the check for entries after the one that will flood their writer in the same batch. So a 1,200-entry flood costs about 1,000 checks, not 1,200. If, under the locks, such an entry's writer turns out not to be flooded (another window changed the counts), the entry is deferred, not guessed.

**3. Test moved, not deleted.** The parse-limit test moved from staffReplicaStore.test.ts to staffReplicaMarks.test.ts, as the plan says. Its waiting figure is now `MAX_MARK_WAITING`, and it asserts the exact new figures. A comment marks where it was.

## Decisions

These are the 32-CONTEXT defaults, accepted by the owner:
- D-14 bounds: 1,000 per writer per stream and 10,000 per store; waiting 100,000.
- The flooded line is a held item, so `MARK_VERSION` stays 3. A mark written by 0.4.35 with more than 10,000 held entries now reads unverified, and Start Again resolves it. No shipped version could hold that many without a hostile flood.

## Known limitations and items for the orchestrator

- **Pre-existing flaky test, not caused by this plan:** "two appendOwn calls at once in one process for one writer keep seq order..." in staffReplicaStore.test.ts sometimes fails with `out-of-order`.
  - On the base commit f9694b72 it failed 1 of 10 isolated runs. Under load it failed 3 of 6 on this branch, and 0 of 10 on the final HEAD.
  - Cause (32-01): `withStartAgainLock` awaits `checkPath(root, STAFF_PARTS)` before it enters `withFileLock`'s in-process FIFO chain. Two calls made in order can therefore enter the lock in the other order.
  - Suggested fix: queue in process (a per-root promise chain) before the `checkPath`. The lock is no more re-entrant than it is today.
  - Left alone, because the lock code belongs to 32-01's scope.
- **Waiting entries found on disk are not bounded.** Lines copied into `streams/` by hand, which `take()` marks unchecked, are not capped. More than 100,000 of them would make `writeMark` refuse the mark. This needs write access to the project folder, and the hub path (ingestForeign) is bounded. A later plan could bound `take()`, for example by not advancing the mark's head past an unlisted entry.
- **The hub must deliver a deferred entry again.** A flooded writer's entries are not stored, so a hub cursor must not assume that delivered means stored.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register:
- T-32-18: per-writer and per-store bounds, with one flooded line.
- T-32-19: the waiting bound, with deferral.
- T-32-20: a check reason that imitates the flooded line gets a prefix.
- T-32-21: syncFolder after the rename and after each mkdir, before the secret.
- T-32-SC: no package was installed.

## Self-Check: PASSED

- FOUND: src/test/staffReplicaMarks.test.ts, src/staff/replica/store.ts, src/staff/replica/marks.ts, SECURITY.md
- FOUND commits: 6bd9e8d2, 1a66360f, e2d10c79
