---
phase: 33-live-multi-user-staff-projects
plan: '02'
status: verified
requires: []
provides:
  - Bound waiting join requests
  - Check a rebuilt shared history before moving it into place
  - Name the products whose history or versions were left out of conversion
affects: [33-11]
tech-stack:
  added: []
key-files:
  created:
    - src/staff/replica/startAgainCheck.ts
    - src/domain/staff/conversionNotice.ts
    - src/test/staffConversionNotice.test.ts
  modified:
    - src/staff/replica/store.ts
    - src/services/staffMultiUserCommands.ts
    - src/test/helpers/startAgainCrashChild.ts
    - src/test/staffReplicaStartAgain.test.ts
    - src/test/staffMultiUserCommands.test.ts
requirements-completed: [MUS-09]
completed: 2026-11-22
---

# Phase 33 Plan 02 Summary

The server caps waiting join requests at eight per invitation and 64 per project. Start Again compares the recorded counts of entries, grants, and blobs with the temporary folder before moving it into place. Conversion reports the names of products with history or versions it could not carry over.

## Results

- Task 1 was already implemented in `10bd9aae`. It returns the dedicated invitation-full refusal, leaves retries of existing requests held, and supplies the client sentence with the organization mode’s lead word. The base revision `1c340878` matched all six D-01 checks in order, with counts 1, 3, 1, 1, 1, 1.
- Task 2 preserves a partial folder beside the store and rebuilds from the intent’s source. It writes and syncs a provisional ignore file before copying shared history, then replaces it atomically with the finished ignore file after the data and nested folders are synced. Recovery also checks that an older temporary folder contains the project pin when the source still has one. The recovery crash test verifies that Git ignore rules are present, that the next open restores the original counts, and that the set-aside source is preserved.
- Task 3 appends ordered notices to the existing conversion message. A labelled product that refers to a higher-labelled product exercises both notices in a real conversion.

## Verification

- On the unchanged implementation, the test run reproduced five failures: three partial stores were moved in, the recovery crash point was absent, and the conversion message omitted both notices. The existing matching-folder behavior passed and remains covered.
- The hub build and required suites passed 57 checks. Three Node-version cases skipped without the older binary and then passed when rerun with Node 24.22.3. The dedicated hub cap suite includes six checks.
- Compilation, lint, and all 209 extension checks in the eight affected suites passed. This includes the expected regression cases, copy lint, and architecture. Both baselines are unchanged.
- Handoff verification reproduced a missing ignore file after a recovery crash and a provisional folder with matching counts promoted too early. All 210 focused extension checks passed on the repaired implementation, including both regressions. The hub compatibility retry passed all three older-Node checks.
- `store.ts` moved from 1,673 to 1,672 lines. The new helper uses the store’s identifier rules, checks paths against links, and counts stream records in bounded reads.

## Decisions and handoff

- Task 1 keeps the existing HTTP 403 mapping from `10bd9aae`. The client treats 429 as a retry, and the cap requires a new invitation.
- Verification used the shared heavy lock, timeouts, and a 1,536 MB Node heap cap with subprocess access. The verified follow-up files were preserved together in the Plan 33-02 worktree for local integration.
