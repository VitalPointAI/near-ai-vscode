---
phase: 32-your-organizations-sync-hub
plan: 18
subsystem: hub
status: complete
tags: [hub, store, node-sqlite, wal, blobs, kill-drill]
requires: [32-14]
provides:
  - openHubStore(dir) and HubStore (projects, entries, commitAppend, enrolProject, blobs, grants, checkpoints, equivocations, enrolments, invites, join requests)
  - StoreError, STORE_REFUSALS, BLOB_SWEEP_AFTER_MS, INVITE_LOCK_AFTER, BODY_MAX_BYTES
  - schema v1 (MIGRATIONS, migrate) with append-only triggers on history
  - blobFolder (writeBlobFile, readBlobFile, removeBlobFile, sweepOrphans, syncFolder)
  - HubStore.openReport and damaged() for the 32-20 health probe
  - kill -9 drill and its child fixture hubCrashWriter
affects: [32-19, 32-20, 32-21, 32-22, 32-25, 32-26, 32-28]
tech-stack:
  added: []
  patterns: [copied relay store and drill with a source line, append-only triggers in the schema, file before row with orphan sweep at open]
key-files:
  created:
    - hub/src/store/schema.ts
    - hub/src/store/hubStore.ts
    - hub/src/store/blobFolder.ts
    - hub/src/store/node-sqlite-database.d.ts
    - hub/test/hubStore.test.ts
    - hub/test/killDrill.test.ts
    - hub/test/fixtures/hubCrashWriter.ts
  modified: []
decisions:
  - "Database methods are synchronous (node:sqlite is), so a method returns after COMMIT; only the blob methods (putBlob, readBlob, sweepBlobs, enrolProject) are async because they touch files."
  - "An entry row is {header text, body base64url, receivedAt}. The store reads stream, writer, seq and hash from the header itself (parseHeaderShape, canonical text check, entryHash) and checks the body size and sha256 against the header, so a row can never be filed under the wrong place. Seq continuity and prev are left to 32-19's checks."
  - "entriesFrom always gives the first entry even when it alone is over maxBytes, so a page never stalls."
  - "History is append-only in the schema: triggers refuse UPDATE and DELETE on entries, blob_refs, grants, checkpoints and equivocations; a referenced blob row cannot be deleted and its referenced_at is set once."
  - "Grants must be canonical JSON whose sha256 is their hash (what grantHash computes), because they are served by hash through the blob route. Checkpoints, proofs and join requests are kept as the JSON record text given (evidence), with size caps."
  - "putInvite: the same invitation with the same check key is held and takes the new expiry (remakeInvite rebuilds the same key); another check key is refused. useInvite returns false when the invitation is used or locked."
  - "enrolProject refuses not-found, enrolment-used and project-exists before writing any blob file; if the transaction is refused later, files it wrote that no row kept are removed. Expiry and the enrolment MAC are 32-19's checks."
  - "readBlob checks size and sha256 on every read; a missing or changed file throws damaged-store and sets damaged(). Open reports orphan files and stale temporary files removed and rows whose file is missing; it never drops such a row."
  - "sweepBlobs deletes rows in one transaction, then unlinks the files synchronously, so no putBlob can run in between. A putBlob answered held just before its blob is swept leads to 409 blob-missing on append and the client puts it again (32-23's transport already retries once)."
  - "hub_meta keeps schema_version and instance_id only (no created_at), because the store reads no clock."
metrics:
  duration: "about 18 min"
  completed: 2026-11-20
estimate:
  tokens: 70036
  tasks: 3
actuals:
  tokens: 32200
  tasks: 3
  commits: 3
plan_head_before: 31cfffc8d7b921fd480d282eb69de42d5143c0fc
plan_head_after: 02b8968f0509d16f285aae18f6fd053d3b8c63a4
---

# Phase 32 Plan 18: Hub store Summary

The hub keeps everything in one node:sqlite database (WAL, synchronous FULL, STRICT tables, append-only triggers on history) plus a content-addressed blob folder written file-before-row with fsyncs, and a 15-round kill -9 drill shows a killed hub loses nothing it acknowledged.

## What was built

- **Schema v1 (`hub/src/store/schema.ts`):** hub_meta, projects, entries, blobs, blob_refs, grants, checkpoints, equivocations, enrolments, invites, join_requests, all STRICT, with length checks on ids and hashes. Entries are unique by `(project, stream, writer, seq)` and by `(project, hash)`. Triggers make entries, blob references, grants, checkpoints and proofs append-only; a referenced blob can never be deleted. `migrate()` is the relay's (version per migration in one transaction, `newer-schema` refusal). StoreError and STORE_REFUSALS live here so the schema and the store share them without a new file.
- **Store (`hub/src/store/hubStore.ts`):** `openHubStore(dir)` creates `hub.db` 0600 (O_NOFOLLOW) and `blobs/` 0700, sets WAL, synchronous FULL and foreign keys, migrates, then sweeps the blob folder. Every write runs in `BEGIN IMMEDIATE ... COMMIT` with bound parameters. Rows are checked before any SQL. Methods: createProject, project, appendEntries, entriesFrom, entryAt, entryByHash, headOf, heads, putBlob, readBlob, blobInfo, referenceBlobs, unreferencedBytesOf, sweepBlobs, damaged, putGrant, grants, grant, putCheckpoint, checkpoints, latestCheckpoint, putEquivocation, equivocations, commitAppend, putEnrolment, enrolment, enrolProject, putInvite, invite, recordInviteFailure, useInvite, putJoinRequest, joinRequests, acceptJoinRequest, removeAcceptedBefore, durability, schemaVersion, instanceId, close.
- **Refusals:** invalid-record, seq-taken, hash-taken, unknown-project, project-exists, blob-mismatch, blob-too-large, blob-missing, enrolment-used, not-found, damaged-store, newer-schema. Each is one plain sentence with no value in it; a refused batch carries the index of the first refused row.
- **Blob folder (`hub/src/store/blobFolder.ts`):** `blobs/<project>/<hash>`, temporary file `.<hash>.<8 hex>.tmp`, fsync, rename, folder fsync (and the root when a project folder is new). Links are refused on write, read, unlink and at open; the folder is checked again just before the rename.
- **Drill (`hub/test/killDrill.test.ts`, `hub/test/fixtures/hubCrashWriter.ts`):** each step puts a 32 KiB blob and commits a batch of three entries that reference it, then prints `ack N`. The header comment says what the drill proves and what it does not (power loss), and points later plans at `hub/test/helpers/hubProcess.ts` (32-14) and `hub/test/api.test.ts` (32-20).

## Tests

Hub suite with `NEAR_AI_HUB_OLD_NODE` set: **151 tests, 151 pass, 0 fail, 0 skipped** (110 before this plan). hubStore.test.js has 26 tests and killDrill.test.js 15 kill rounds. `npm run lint` (tsc) is clean. The drill ran clean 5 times in a row.

### Failing-first evidence

- **Task 1:** hubStore.test.ts written first; the build failed with `Could not resolve "../src/store/hubStore"`. After the tracer: 9 of 9 pass.
- **Task 1 teeth (D-66, stated mutations, run together then restored):** skipping the hash-taken check fails the seq-taken/hash-taken test; dropping the entries append-only triggers fails the append-only test. Dropping the body sha256 check at first broke no test: the "body hash differs" case also changed the length, so the size check caught it. The case now keeps the length and changes the bytes, and a separate "body size differs" case was added. With the mutation applied it fails; restored, it passes.
- **Task 2:** the new tests failed at the build (`No matching export ... BLOB_SWEEP_AFTER_MS`, `INVITE_LOCK_AFTER`). After the implementation: 26 of 26 pass.
- **Task 2 teeth:** dropping the blob sha256 check, the enrolment-used check, the cleanup of files from a refused enrolment, or locking at 4 failures instead of 5 failed 3 tests together. A sweep window of 23 h at first broke no test, because the test used the constant. The test now pins `BLOB_SWEEP_AFTER_MS` to 24 h and uses the literal, and the mutation fails it.
- **Task 3:** the drill passed on the Task 2 store with no store fix needed. Its teeth: (A) the open sweep no longer removes temporary files: 2 of 15 rounds fail with "a temporary file was left behind"; (B) putBlob writes the row before the file: 2 of 15 rounds fail with "a row names a blob file that is missing".

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Correctness] Per-round wait before the SIGKILL in the drill**
- **Found during:** Task 3
- **Issue:** if the parent kills the child right after writing the permit, as the relay drill does, the kill always reaches the child before it reads the permit. Every round then stopped between steps, and mutations A and B above passed all 15 rounds.
- **Fix:** the parent busy-waits `(round - 1) * 150` microseconds between the permit and the kill, so the kill lands at different points inside the next step. The kill point and the permit protocol are unchanged.
- **Files modified:** hub/test/killDrill.test.ts
- **Commit:** 02b8968f

**2. [Rule 2 - Correctness] Three refusal ids beyond the plan's list**
- `blob-missing` (a blob reference to a blob the project does not hold, inside the same transaction, the race-free place for it), `damaged-store` (a missing or changed blob file, a link in the blob folder) and `newer-schema` (the relay's migrate refusal).

**3. [Rule 2 - Correctness] Extra read methods for later plans**
- `entryAt` and `entryByHash` (32-19 names entryAt), `grant(project, hash)` (D-69 serves grants by hash), `blobInfo`, `damaged()` and `openReport` (32-20's health probe), `durability`, `schemaVersion`.

## Decisions

The owner accepted the 32-CONTEXT defaults. No checkpoint or one-way decision came up. The decisions made while building are in the frontmatter `decisions` list.

## Notes for later plans

- **32-19:** `commitAppend(project, {entries, grants?, equivocations?, blobRefs?, at})` returns the stored entries in batch order. A blob reference must name an entry already kept or in the same batch, with the same stream. Grants are idempotent by hash; so are proofs. `unreferencedBytesOf` feeds the 256 MiB pending quota. The anchor given to `enrolProject` must be canonical JSON text.
- **32-20:** call `openHubStore` after `prepareStateDir`, and use `store.damaged()` (and `openReport`) in the health probe. Run the hourly `sweepBlobs(now)`. The app bundle gains `node:sqlite` as an external once main.ts imports the store.
- **32-25:** `recordInviteFailure` returns the new count and locks at 5 (the first lock time stays). `removeAcceptedBefore(now - 7 days)` removes accepted requests only.
- **32-28:** the schema version is 1 (`PRAGMA user_version` and `hub_meta.schema_version`). A newer database is refused at open with a plain sentence. Back up the state directory with the hub stopped (hub.db, its -wal file and blobs/ together).

## Known Stubs

None.

## Threat Flags

None. The store adds no network surface. It writes only under the state directory and refuses links there.

## Self-Check: PASSED

- All 7 created files are present; commits 0ded6602, 532fa6a4 and 02b8968f are on the branch.
