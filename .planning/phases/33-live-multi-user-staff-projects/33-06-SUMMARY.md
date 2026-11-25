---
phase: 33-live-multi-user-staff-projects
plan: 06
status: complete
subsystem: server address, compactor and live projector
tags: [staff, replica, compaction, projection, d-10, d-43]
requires: []
provides: [compactionDue, publishCompaction, compactAfterCheckpoint, COMPACTION_REFUSALS, projectLive, LAST_PROJECTED_FILE, lastProjectedFile, replaceKeepingEdits, readLocalSettings, writeLocalSettings]
affects: [33-09, 33-14, 33-24]
tech-stack:
  added: []
  patterns: [checked append with a recheck before signing, move-aside and no-replace link for a file swap, per-device settings beside the genesis pin]
key-files:
  created:
    - src/staff/replica/liveProjection.ts
    - src/test/staffLiveProjection.test.ts
  modified:
    - src/staff/replica/compactor.ts
    - src/staff/replica/hubAddress.ts
    - src/staff/replica/projection.ts
    - src/staff/staffFiles.ts
    - src/test/staffCompactor.test.ts
requirements: [MUS-09]
requirements-completed: []
actuals:
  tokens: 16000
  tasks: 3
  commits: 2
completed: 2026-11-24
plan_head_before: aaf39703e50372bb380642562d10d9ab59562b57
plan_head_after: d9a3736996de01b643784d111d240f850def5a3a
---

# Phase 33 Plan 06: Server address, compactor and live projector Summary

The three producers the native engine needs are now complete. The address of your organization's server is stored per project on each device. A due product is compacted from the checkpointed prefix, rechecked against the latest fold on every append attempt. Product files that are not open follow the fold without ever replacing a person's edit, including an edit that lands during the file swap.

## Reconciled from Codex

`git cherry` against the integration branch showed `feat/phase-33-06-hub-address`, `-compactor`, `-compaction-coverage` and `-snapshot-guard` fully merged. Task 1 (`hubAddress.ts`) and the preparation half of Task 2 (`compactionCheckpoint`, `prepareCompaction`, the stale-snapshot append guard) were already in place. Nothing needed to be cherry-picked.

## What this plan added

- **Task 2, publication.** `compactionDue(output, order)` is true only after at least 50 accepted updates since the newest compaction of the product, by any writer. That is stricter than the fold's per-writer rule, so a compaction it allows is never refused for the window. `publishCompaction` stores the sealed blob, then uses the store's checked append. On every attempt, with a fresh fold each time another window or a received entry moved the store, it checks again before signing that the roster head is still the one the compaction cites and that the window still allows it. The signed entry is then folded in preview and appended only when the fold applies it as a verified compaction. `compactAfterCheckpoint(project, { hub, memory })` is the one call the live engine makes when a checkpoint arrives. It selects the witnessed checkpoint, collects each writer's entries up to the exact head it names (any fork or missing entry stops it), and prepares and publishes each due product one at a time. Its caller is the native engine (33-24).
- **Task 3, the live projector.** `projectLive(root, input, { globalStorageDir, project, bound })` writes each product file as `writeProjections` would. It writes only where the file's text is the text this device last projected there, or where no file exists. Before any record exists, it also writes where only the header differs, which is the Phase 30 rule. Bound products are skipped. Incomplete, edited and unreadable files are left as they are and listed. An empty product with no file stays without one. The record `projected.json` sits beside `hub.json` and maps each product to the sha256 of the file text written. It is mode 0600 inside a 0700 folder and holds only hashes. A damaged record reads as empty.
- **The race recorded in this plan is closed.** `replaceKeepingEdits` in `staffFiles.ts` moves the current file aside, compares the moved bytes, and links the new text into place, and a link never replaces an existing file. Afterwards it compares the held copy again. A write that lands at any point stands: a replace before the move goes back, a file created while the old one is aside stays, and a write through an old handle after the swap is restored over the new text. The only file removed is the held copy, and only after its bytes have been checked to still equal the text that was read. `liveProjection.ts` calls no `rm`, `unlink` or `rmdir`. The path is briefly absent while the old file is aside.
- **File helpers reused for the address file.** The address file's private-file reader and writer moved out of `writeHubAddress` and `readHubAddress` into exported `readLocalSettings` and `writeLocalSettings` in `hubAddress.ts`, with no change in behaviour. The projector's record uses them too. `productBodyOf` is exported from `projection.ts`, `writeProjections` is unchanged, and its comment now points at `liveProjection.ts`. `projection.ts` is 674 lines.

## Deviations from Plan

1. **[Rule 1, data integrity] A new compare-and-swap writer, rather than a change to `writeIfUnchanged`.** `writeIfUnchanged` keeps its behaviour for every existing caller. The new `replaceKeepingEdits` follows the plan's suggested approach (hold the old file aside, compare afterwards, restore on a mismatch). It moves the file aside instead of hard-linking it, because a hard link alone cannot catch a replace that lands just before the rename.
2. **The compaction window check is stricter than the fold's** (any writer, not per writer). This keeps redundant compactions down, and the fold's own rule still judges the preview.
3. **`compactAfterCheckpoint` is tested over a fake project on the existing witnessed fixture world, not a live hub.** The late-joiner scenario over a real hub belongs to 33-14.

## Verification

Run under the shared heavy lock, MemoryMax=6G and choom: `npm run compile`, which compiled cleanly with the same tsc check as `npm run lint`, then `run-tests` on staffLiveProjection, staffCompactor, staffHubAddress, replicaCheckpointHeads, staffReplicaProject, staffReplicaCopy, staffReviewRound4, staffDrop2Writes, copyLint and architecture. **132 tests passed and 0 failed.**

- Tests added: 11. `staffLiveProjection.test.ts` is new, with 7 tests: the tracer; the private record and recovery from a damaged one; an edited file left alone; the Phase 30 header rule before any record exists; bound, incomplete and empty products; and the three swap races. `staffCompactor.test.ts` gained 4: publish, a concurrent compaction found not due on recheck, a moved roster and a refused preview, and `compactAfterCheckpoint`.
- No existing test was changed. The hub-address tests pass unchanged after the reader and writer moved into the shared helpers. The `writeIfUnchanged` race tests (staffReviewRound4, staffDrop2Writes) also pass unchanged.
- A first run failed the copy lint for one mode word ("roster") in a compaction refusal. The refusal text was reworded, so no baseline moved. `grep -cE "\b(unlink|rm|rmdir)\(" src/staff/replica/liveProjection.ts` gives 0, and `projection.ts` is 674 lines.
- The tests were written with the code rather than run red first on the base, because the base had no `publishCompaction` or `projectLive` to fail against.

## Known Stubs

None. `compactAfterCheckpoint` and `projectLive` have no caller yet. Their caller is the native engine (33-24, D-51), as the re-aim states.

## Threat Flags

None beyond the plan's register. T-33-24, projection over a person's edit, now also covers the swap window.
