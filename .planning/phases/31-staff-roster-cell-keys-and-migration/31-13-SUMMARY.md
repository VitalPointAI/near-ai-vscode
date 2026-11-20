---
phase: 31-staff-roster-cell-keys-and-migration
plan: 13
subsystem: staff-replica
tags: [replica, store, rollback, high-water-marks, secret-storage, file-lock, decode-check, crash-safety, security-docs, tdd]
status: complete

requires:
  - phase: 31-02
    provides: fold re-delivery by hash (the store dedupes by the same entry hash)
  - phase: 31-09
    provides: the staff-replica-mark payload purpose in PAYLOAD_PURPOSES
  - phase: 31-10
    provides: DecodeHost (wired into the ForeignCheck by 31-18) and the SECURITY.md multi-user section
provides:
  - "src/domain/staff/multiUser.ts: REPLICA_DIR, REPLICA_PROJECT_FILE, LEGACY_DIR (pure, no I/O)"
  - "src/staff/replica/marks.ts: REPLICA_MARK_SECRET_PREFIX, MAX_MARK_HEADS, MarkHead, ReplicaMark, MarkFileState, MarkRead, markKey, parseReplicaMark, readMark, writeMark, compareWithMark"
  - "src/staff/replica/store.ts: ReplicaStore (open, appendOwn, ingestForeign, entries, heldForCheck, has, head, refresh, blob, putGrant, grants, putCheckpoint, checkpoints, recordRosterHead, damagedLines), STORE_REFUSALS, ForeignCheck, IngestResult, ReplicaStoreDeps, parseSealed, REPLICA_LOCK_FILE, STORE_GITIGNORE"
  - "src/test/helpers/replicaStoreChild.ts: forked appender and FileSecrets (file-backed secret storage shared by processes)"
  - "SECURITY.md ### The replica store and rollback detection"
affects: [31-14, 31-15, 31-16, 31-17, 31-18, 31-19, 31-20, 31-21, 31-22, 32]

actuals:
  tokens: 24831
  tasks: 4
  commits: 5
plan_head_before: a93388dc3e06fe48f5f4edfd863a946b2a617e38
plan_head_after: e1316b0444adc891140c9a0b8c7b33d44862cccb

tech-stack:
  added: []
  patterns:
    - "Two locks, outer in-process (withRegisterLock) and inner cross-process (withFileLock), with no locked method calling another"
    - "Catch up inside the lock: every locked step first reads the bytes other windows appended since this store object last looked"
    - "Torn tail cut under the lock: bytes after the last newline were never an entry, so they are truncated before the next append and can never become a second entry at a seq"
    - "Signed high-water marks per (stream, writer) with seq, hash and count, merged with the stored mark inside the lock so no window's head is lost"
    - "Held before written: a refused foreign entry is recorded in held.json before its line is appended, so a crash can never let it reach the fold"

key-files:
  created:
    - src/domain/staff/multiUser.ts
    - src/staff/replica/marks.ts
    - src/staff/replica/store.ts
    - src/test/helpers/replicaStoreChild.ts
    - src/test/staffReplicaStore.test.ts
  modified:
    - SECURITY.md

key-decisions:
  - "Store path and layout as planned (costly-reversibility task 1, plan default): .planning/staff/replica/ with streams/<stream>/<writer>.jsonl, blobs/<hash>, grants/<cell>/<epoch>-<hash>.json, checkpoints/<hash>.json, held.json, .gitignore ('*', '!.gitignore'), replica.lock"
  - "A mark head carries count (distinct entries in the file) besides stream, writer, seq and hash, so a file cut short below its highest line (entries from outside arrive out of seq order) is still refused rolled-back"
  - "compareWithMark takes the store's per-file state (count and hashes at a seq) rather than a single head per file, because a file may hold two entries at one seq (equivocation is kept, the fold judges it)"
  - "A torn tail is truncated before the next append (under the lock) instead of being closed with a newline: a crash that leaves a whole entry without its newline would otherwise resurrect it beside the retried entry and fork the writer"
  - "appendOwn refuses an entry that does not follow the file's head (seq + 1, prev naming the head) with a seventh refusal, out-of-order, and skips an entry already stored (a retry); this keeps two windows sharing one device key from forking it"
  - "ingestForeign runs the check before taking the lock and writes held.json before the lines; a check that throws counts as a refusal; reasons are one line, at most 200 characters"
  - "held.json that cannot be read refuses the store (unreadable), never reads as empty, because an empty list would let refused entries into the fold"
  - "The store checks the body hash and size of every entry it reads or receives (no signature: the fold's job), so a damaged copy is dropped and cannot shadow a good copy with the same header"
  - "rosterHead is set by recordRosterHead(hash) (called by the host after folding, 31-18); open refuses rolled-back when the mark's roster head entry is not in the store"

patterns-established:
  - "Every ReplicaStore method that touches disk goes through one private locked() and maps a Refusal to { refused, message } from STORE_REFUSALS"

requirements-completed: [MUS-06]

coverage:
  - id: D1
    description: "Open makes the self-ignoring folder and nothing outside it; an appended entry and its blob read back equal after reopening; the signed staff-replica-mark names the head"
    requirement: MUS-06
    verification:
      - kind: unit
        ref: "src/test/staffReplicaStore.test.ts (tests 1-3)"
        status: pass
    human_judgment: false
  - id: D2
    description: "rolled-back for a cut, deleted, restored-older or replaced file, an edited line and a missing roster head; mark-unverified for a tampered, unreadable or untrusted mark"
    requirement: MUS-06
    verification:
      - kind: unit
        ref: "src/test/staffReplicaStore.test.ts#rolled-back (4 tests), mark test, roster head test"
        status: pass
    human_judgment: false
  - id: D3
    description: "Torn tails never counted and cut off before the next append; blob over BLOB_MAX_BYTES refused with nothing written; symbolic links refused; refusal messages free of keys, long hashes and em-dashes"
    requirement: MUS-06
    verification:
      - kind: unit
        ref: "src/test/staffReplicaStore.test.ts (torn tail x2, blob-too-large, out-of-order, symlink, messages)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Two processes (two writers, and one device in two processes) and two calls in one process append at once without losing, interleaving or forking a line; the shared mark names every head"
    requirement: MUS-06
    verification:
      - kind: unit
        ref: "src/test/staffReplicaStore.test.ts (three concurrency tests, forked replicaStoreChild)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Foreign entries refused by the injected check are kept, held with their reason, left out of entries(), and the same after reopening; duplicates neither written nor checked twice; grants and checkpoints round trip and damaged files are listed unreadable"
    requirement: MUS-06
    verification:
      - kind: unit
        ref: "src/test/staffReplicaStore.test.ts (Task 4, 7 tests)"
        status: pass
    human_judgment: false

duration: 16min
completed: 2026-11-20
---

# Phase 31 Plan 13: Replica store Summary

**A multi-user staff project now has a crash-safe, window-safe store under `.planning/staff/replica/` that git ignores. It refuses a rolled-back or tampered folder using signed high-water marks kept in secret storage, and it keeps entries from outside that fail the injected decode check, holding them back from the fold.**

## Performance

- **Duration:** about 16 min
- **Started:** 2026-11-20T04:41:49Z
- **Completed:** 2026-11-20T04:58Z
- **Tasks:** 4 of 4
- **Files:** 6 (5 created, 1 modified)

## Accomplishments

- `multiUser.ts`: the three path constants, pure, so `staffHost.ts` can test for a multi-user project without loading `src/staff/replica/`.
- `marks.ts`: one secret per store under `nearAi.staff.replicaMarks.<first 32 hex of sha256(absolute store path)>`, signed with purpose `staff-replica-mark`, holding `{ v: 1, rosterHead, heads: [{ stream, writer, seq, hash, count }] }`. `readMark` returns none, mark or unverified; `compareWithMark` is pure.
- `store.ts`:
  - `open` checks for symbolic links from the project root down, makes the folder and its `.gitignore` (restored if changed), reads every stream file line by line in 64 KiB chunks, loads `held.json`, and compares with the mark, all under the locks.
  - `appendOwn` takes this device's built entries only. It skips ones already stored, refuses a broken chain (out-of-order) or an oversized blob before writing anything, then writes blobs (temporary file, fsync, rename), then each file's lines in one write plus fsync, then the merged mark.
  - `ingestForeign` checks shape and body hash, dedupes by entry hash against the store and the call, and runs the injected `ForeignCheck` once per new entry. It writes `held.json` first, then blobs and lines, then the mark.
  - Also: `entries()` (held ones left out), `heldForCheck()`, `head()`, `refresh()`, `blob()`, `putGrant`/`grants()`, `putCheckpoint`/`checkpoints()`, `recordRosterHead()`, `damagedLines()`.
- `replicaStoreChild.ts`: a forked appender that shares a JSON-file secret storage with its sibling. It rebuilds on its own head after an out-of-order refusal, as a host sharing one device between windows would.
- SECURITY.md: `### The replica store and rollback detection`, a new subsection inside `## Multi-user staff projects (preview)`, placed after the decode worker subsection. It covers where the store lives, that git ignores it, the locks, rollback detection, that no private keys are stored, the decode check that sets an entry aside, and symbolic links.

## Task Commits

1. **Task 1 (tracer): store, marks and paths:** `051facf1` (feat). Tracer gate: verify re-run end to end (staffReplicaStore plus staffReplicaWorker, 18 of 18), then expansion went ahead.
2. **Task 2: rollback, tampered mark, torn tail, blob size:** `8be2fcb3` (test). The guards themselves landed in the Task 1 store; this commit adds the tests, each checked against the guard disabled.
3. **Task 3: register lock and two processes:** `41de9926` (feat)
4. **Task 4: foreign entries, held list, grants, checkpoints, SECURITY.md:** `807ea99d` (feat)
5. **Follow-up:** `e1316b04` (test). The two em-dash checks in the test now use `—` instead of the literal character.

## Test results

All runs used the shared lock and the memory cap (`MemoryMax=4G`, `--max-old-space-size=1536`). The forked children inherit the same cap.

- `dist/test/staffReplicaStore.test.js`: **24 tests, 24 pass.** The plan asked for at least 3 after Task 1, 9 after Task 2, 11 after Task 3 and 15 after Task 4; the counts were 3, 14, 17 and 24.
- Final verify (`staffReplicaStore` + `staffReplicaWorker`): 39 tests, 39 pass.
- Wider focused run because SECURITY.md and a new folder under `.planning/staff` are involved: `staffReplicaStore`, `staffReplicaWorker`, `staffReplicaProjection`, `replicaBoundaries`, `gateDocs`, `protectedPaths` and `staffLedgerIntegrity` gave 150 tests, 150 pass.
- **RED evidence (mutation checks on the compiled store, then restored):**
  - With the mark comparison disabled, the 4 rolled-back tests fail.
  - With the torn-tail truncation and both blob size guards disabled, the torn-tail test and the blob-too-large test fail.
  - With `withFileLock` replaced by a direct call, the one-device two-process test fails on 3 of 3 runs, and the two-writer test fails on 1 of 3.
  - With held entries let into `entries()` and an unreadable `held.json` accepted, 3 Task 4 tests fail.
- **Acceptance greps:**
  - `withFileLock` in store.ts: 4. `staff-replica-mark` in marks.ts: 4. `rolled-back` in store.ts: 6. `withRegisterLock` in store.ts: 3.
  - The `### The replica store and rollback detection` heading appears once in SECURITY.md, and SECURITY.md has 0 em-dashes.
- Full `npm test`, e2e and `verify:release` were not run; the orchestrator runs them at the phase end.

## Decisions Made

See key-decisions in the frontmatter. The plan had no checkpoint. Task 1 is rated costly to reverse (the store path and layout), and its planned layout was taken unchanged.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2: Missing critical functionality] appendOwn checks the chain and skips stored entries (out-of-order refusal)**
- **Found during:** Task 1, then proven in Task 3.
- **Issue:** Two windows of one install share one device key, so they write to the same writer file. Without a check, both could write an entry at the same seq. That is a fork of this device's own key, which Phase 30 quarantines.
- **Fix:** inside the locks, after catching up, each new entry must have seq one above the file's head and a `prev` naming it. Otherwise nothing in the batch is written and `out-of-order` is returned (a seventh entry in `STORE_REFUSALS`). An entry already stored is skipped, so a retry after a crash is safe. `head()` lets the caller rebuild on the new head.
- **Files:** src/staff/replica/store.ts, src/test/helpers/replicaStoreChild.ts, src/test/staffReplicaStore.test.ts
- **Commits:** 051facf1, 41de9926

**2. [Rule 2] Mark heads carry a count**
- **Issue:** Entries from outside can arrive out of seq order. A file could then lose a line below its highest seq and still hold the marked hash at the marked seq.
- **Fix:** each `MarkHead` also records `count`, the number of distinct entries. A file holding fewer is refused rolled-back. This field is in addition to the planned `{ stream, writer, seq, hash }`.

**3. [Rule 1: Bug avoided] Torn tail truncated, not closed with a newline**
- **Issue:** Suppose the next append closed a torn tail with a newline. A torn tail that is a whole entry missing only its newline would then turn into a valid line, sitting next to the retried entry at the same seq: a fork.
- **Fix:** under the lock, the bytes after the last newline are cut off before the append. These bytes were never counted as an entry, so P-31-17 (never delete an entry, never rewrite a line) still holds. A test covers this exact case.

**4. [Rule 2] An unreadable held.json refuses the store**
- **Issue:** if a held list that cannot be read were treated as empty, entries the decode check had refused would reach the fold.
- **Fix:** an unreadable `held.json` gives `unreadable`, and a symbolic link gives `symlink`. Both are tested.

**5. [Additions] `head()`, `refresh()`, `recordRosterHead()`, `damagedLines()` and `parseSealed`**
- These are small public members that the planned API needed in order to be usable:
  - `head()`: a host has to build on another window's head.
  - `refresh()`: reads other windows' writes without reopening the store.
  - `recordRosterHead()`: the mark's roster head needs a setter.
  - `damagedLines()`: diagnostics.
- `grants()` and `checkpoints()` return `{ grants | checkpoints, unreadable }`, so a damaged file is listed rather than dropped.

**6. [Process] Task 2 code shipped in the Task 1 commit**
- The rollback comparison, the torn-tail rule and the blob size check were written together with the tracer store, because open and append could not be written correctly without them. Task 2's commit therefore holds only tests. RED was shown by disabling each guard in the compiled store.

## Known Stubs

None. The store is not wired to a host yet; that is planned. 31-18 passes `DecodeHost` in as the `ForeignCheck` and calls `recordRosterHead` after folding.

## Threat Flags

None beyond the plan's threat model. No new network endpoint, dependency or agent capability is added. The new on-disk folder and the new secret storage key are documented in SECURITY.md (T-31-35 to T-31-39 mitigated as planned; P-31-17 and P-31-18 hold: the store writes only sealed entries, sealed blobs, signed grants and checkpoints, its own held index and .gitignore, and the lock file).

## Next Phase Readiness

- **31-18 (project host):**
  - Opens the store with `ReplicaStore.open(root, { secrets: context.secrets, signer, keyStatus })`.
  - Passes `(entry) => decode check` to `ingestForeign`. The check has to open the body with the cell key before it can hand update bytes to `DecodeHost`.
  - Feeds `entries()` to the fold and calls `recordRosterHead` with the folded roster head.
  - Shows `heldForCheck()` and the `STORE_REFUSALS` message to the person.
  - On `out-of-order`, rebuilds on `head()`.
- **31-14 and later:** grants go to `putGrant(cell, epoch, signed)` and come back from `grants()`.
- **Migration (31-19 and later):** `REPLICA_DIR`, `REPLICA_PROJECT_FILE` and `LEGACY_DIR` are in `src/domain/staff/multiUser.ts`.
- **Not done here, out of scope:** no person-run command yet to accept an older copy after a rolled-back refusal. The refusal message does not name one.

## Self-Check: PASSED

- FOUND: src/domain/staff/multiUser.ts, src/staff/replica/marks.ts, src/staff/replica/store.ts, src/test/helpers/replicaStoreChild.ts, src/test/staffReplicaStore.test.ts, SECURITY.md subsection
- FOUND commits: 051facf1, 8be2fcb3, 41de9926, 807ea99d, e1316b04
