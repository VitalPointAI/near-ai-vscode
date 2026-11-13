---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 02
subsystem: state-sync
tags: [merge, crdt, canonical-json, thread-log, hash-chain, property-tests, temp-files]

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-CONTEXT decisions D-07, D-08, D-12 and 27-RESEARCH Patterns 6, 11, 14 (no code dependency; wave 1)"
provides:
  - "src/domain/state/records.ts: StateRecord, RecordKind, MERGE_POLICY, canonicalJson, revOf, makeRecord, parseRecord, baseId"
  - "src/domain/state/merge.ts: mergeRecord, mergeRecordSets, liveRecords, forkId, compareRecords, unionLog"
  - "src/domain/state/threadEntries.ts: ThreadEntry, entryId, unionEntries, threadLines, threadTip, capToolResult, TOOL_RESULT_CAP_BYTES"
  - "random 8-byte temporary names in six shared writers"
affects: [27-03, 27-04, 27-05, 27-06, 27-07, 27-09, sync, migration, thread-log, comparison-store, run-markers]

actuals:
  tokens: 16172
  tasks: 3
  commits: 3
plan_head_before: 80b42870b1a592c0b3c97de100cb5d5670906188
plan_head_after: 4976814df91c4deef4842b87d1fa0b5530a792cb

tech-stack:
  added: []
  patterns:
    - "Set-wise merge: the result is a function of the records held, not of delivery order"
    - "Seeded xorshift32 property tests (no Math.random) over 500 histories"
    - "Hash-chain entry ids (Crockford base32 of sha256 over parent, role, canonical body)"

key-files:
  created:
    - src/domain/state/records.ts
    - src/domain/state/merge.ts
    - src/domain/state/threadEntries.ts
    - src/test/stateMerge.test.ts
    - src/test/threadMerge.test.ts
    - .planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/deferred-items.md
  modified:
    - src/services/auditStore.ts
    - src/services/resumableExecution.ts
    - src/gsd/runtime.ts
    - src/services/emergencyStop.ts
    - src/services/teamKnowledgeStore.ts
    - src/services/cyberLedgerStore.ts

key-decisions:
  - "mergeRecordSets is a set function (group by family, dedupe by rev, drop superseded, apply tombstones, keep newest under the id and fork the rest), not a pairwise fold, because a fold gave different forks for different association orders"
  - "Fork kinds are normalised to a canonical placement: newest under the family id, every other version under forkId(baseId, rev); a tombstone for an id also covers forks made from it"
  - "The newest tombstone of each id is always kept, even when an edit shadows it, so a later-arriving older copy is still removed the same way; liveRecords() reads what a person should see"
  - "Equal-revision copies keep the later written one; thread entries with one id keep the earliest copy (not first-seen), so neither depends on which side is local"
  - "unionEntries keys by (thread, id) so two threads that start with the same first message are never merged into one"
  - "makeRecord takes an optional base record and stamps the edit strictly after it, so descendants are never ordered before what they edit"

requirements-completed: [SYNC-05, SYNC-01]

coverage:
  - id: D1
    description: "A thread continued on two machines from the same tip keeps every entry of both continuations; main line is the newest leaf's path and the other continuation is a branch forked at the shared tip"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "dist/test/threadMerge.test.js#two machines continuing one thread from the same tip keep all 9 entries"
        status: pass
    human_judgment: false
  - id: D2
    description: "Thread merge is set union: commutative, associative, idempotent, and no delivery order or partial batch drops an entry (500 seeded threads); equal times order by writer then id"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "dist/test/threadMerge.test.js#delivering one machine's entries in any order and in partial batches never drops an entry"
        status: pass
      - kind: unit
        ref: "dist/test/threadMerge.test.js#thread union is commutative, associative and idempotent"
        status: pass
      - kind: unit
        ref: "dist/test/threadMerge.test.js#SYNC-05 ordering edge"
        status: pass
    human_judgment: false
  - id: D3
    description: "Entry ids are a hash chain over (parent, role, canonical body without time); the same continuation has one id on every machine"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "dist/test/threadMerge.test.js#an entry id depends on the parent, the role and the body"
        status: pass
    human_judgment: false
  - id: D4
    description: "Record merge rule: equal rev keeps one, a descendant wins, a divergent edit keeps the newer and forks the older for fork kinds, a tombstone wins only when strictly newer; commutative, associative and idempotent over 500 seeded histories each for fork kinds, lww kinds and tombstones"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "dist/test/stateMerge.test.js#merging record sets is commutative, associative and idempotent (3 variants)"
        status: pass
      - kind: unit
        ref: "dist/test/stateMerge.test.js#a divergent edit of a saved comparison is never lost"
        status: pass
      - kind: unit
        ref: "dist/test/stateMerge.test.js#a tombstone wins only when strictly newer than the record"
        status: pass
    human_judgment: false
  - id: D5
    description: "D-12 cap: a tool result over 2 MiB is shortened to at most 2 097 152 bytes on a character boundary with shortenedBytes set; everything else is stored whole"
    verification:
      - kind: unit
        ref: "dist/test/threadMerge.test.js#D-12: a tool result over 2 MiB is shortened"
        status: pass
    human_judgment: false
  - id: D6
    description: "No merge path deletes a thread or a thread entry (SYNC-01): no remove/delete/drop/prune export in the three modules, and threads have no tombstone"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/threadMerge.test.js#a thread has no tombstone and no function that removes an entry"
        status: pass
      - kind: unit
        ref: "dist/test/stateMerge.test.js#every kind has a merge policy ... no function in the merge modules removes a record"
        status: pass
    human_judgment: false
  - id: D7
    description: "parseRecord rejects ids with path separators, NUL or over 200 characters and any malformed field (T-27-08)"
    verification:
      - kind: unit
        ref: "dist/test/stateMerge.test.js#parseRecord rejects ids that could be used as paths"
        status: pass
    human_judgment: false
  - id: D8
    description: "auditStore, resumableExecution, gsd runtime, emergencyStop, teamKnowledgeStore and cyberLedgerStore use random 8-byte temporary names instead of pid-only names (T-27-82)"
    verification:
      - kind: unit
        ref: "auditStore, resumableExecution, emergencyStop, cyberEmergencyStop, teamKnowledgeStore, cyberLedger test files: 49 tests, 0 failing; grep 'process.pid}.tmp' is 0 in all six files"
        status: pass
    human_judgment: false

duration: 13min
completed: 2026-11-13
status: complete
---

# Phase 27 Plan 02: Merge laws and thread entries Summary

**Pure, order-independent merge for project-state records (canonical-JSON revisions, descendant/fork/tombstone rules) and an append-only hash-chained thread-entry model with main line plus continuations and the 2 MiB tool-result cap, proven on seeded random histories; six shared writers moved to random temporary names.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-11-13T13:35:00Z
- **Completed:** 2026-11-13T13:48:00Z
- **Tasks:** 3
- **Files modified:** 12 (5 created source/test files, 6 modified services, 1 deferred-items log)

## Accomplishments

- A thread continued on two machines from the same tip keeps every entry of both; `threadLines` puts the newest leaf's path on the main line and every other chain in a branch with `forkAt` set to the shared entry. Entries whose parent has not arrived are shown as their own branch, and corrupt parent cycles are shown rather than hung on.
- Merge laws are executable: 500 seeded histories each for fork kinds, lww kinds and tombstones, plus 500 seeded thread deliveries in shuffled, partial and repeated batches, all commutative, associative, idempotent and byte-identical to the all-at-once result.
- `mergeRecordSets` never drops a saved comparison/checkpoint: the older divergent edit is kept under `forkId(id, rev)`. A tombstone wins only when strictly newer, covers forks of its id, and is retained when shadowed.
- D-12: `capToolResult` is the only shortening (2 097 152 bytes, character boundary, `shortenedBytes` = original byte length).
- The pid-only `.tmp` names in `auditStore`, `resumableExecution`, `gsd/runtime`, `emergencyStop`, `teamKnowledgeStore` and `cyberLedgerStore` are now random, so a code-server container and the host editor cannot collide.

## Task Commits

1. **Task 1: Tracer, two machines continue one thread; merge keeps everything** - `2d117b9` (feat). Tracer verified end to end (3 tests, 0 failing) before expansion.
2. **Task 2: Merge laws as seeded property tests** - `384e3d3` (feat). Contains the redesign of `mergeRecordSets` that the property tests forced (see Deviations).
3. **Task 3: Random temporary names in six shared writers** - `4976814` (fix)

**Plan metadata:** the docs commit that carries this SUMMARY, STATE.md, ROADMAP.md and the deferred-items log.

## Files Created/Modified

- `src/domain/state/records.ts` - record shape, merge policy table, `canonicalJson`, `revOf`, `makeRecord` (with `base` stamping), `parseRecord` validation, `baseId`
- `src/domain/state/merge.ts` - `mergeRecord` (pair rule), `mergeRecordSets` (set function), `liveRecords`, `forkId`, `compareRecords`, `unionLog`
- `src/domain/state/threadEntries.ts` - entry ids, union, `threadLines`/`threadTip`, `capToolResult`
- `src/test/stateMerge.test.ts` - 11 tests including the seeded property laws
- `src/test/threadMerge.test.ts` - 8 tests including seeded partial-delivery and ordering edges
- Six services: temporary file name only (`${file}.${randomBytes(8).toString('hex')}.tmp`), imports added where missing

## Decisions Made

See `key-decisions` in the frontmatter. In short: the record merge is a set function with canonical fork placement; tombstones are retained when shadowed; equal copies resolve by time so neither side is privileged; thread entries are keyed by (thread, id).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Pairwise-fold `mergeRecordSets` was not associative or commutative**
- **Found during:** Task 2 (the seeded property tests failed on seeds 255, 481 and 136 with the first implementation)
- **Issue:** Folding `mergeRecord` over the union made the result depend on association order: a fork could exist under one order and not the other, the same revision could sit under both the family id and a fork id, and a dropped middle version could not retire a fork that had already been materialised.
- **Fix:** Rewrote `mergeRecordSets` as a function of the records held: group by family (id plus its forks), collapse equal revisions, drop versions another version was written from, apply tombstones (a tombstone for an id also covers its forks), keep the newest under the family id and give every other version of a fork kind `forkId(baseId, rev)`. `mergeRecord` keeps the pair rule from the plan, and a new test checks the two agree on every pair.
- **Files modified:** `src/domain/state/merge.ts`
- **Verification:** all 11 stateMerge tests pass, including 3 x 500 seeded histories
- **Committed in:** `384e3d3`

**2. [Rule 1 - Bug] "Keep the first seen copy" in `unionEntries` made the union order-dependent**
- **Found during:** Task 1 (design, before the first test run)
- **Issue:** Two machines can write the same message at different times (same id, different `at`/`writer`), so keeping the first seen copy differs by side.
- **Fix:** keep the earliest copy by (at, writer, canonical text); output sorted by (at, writer, id).
- **Files modified:** `src/domain/state/threadEntries.ts`
- **Verification:** tracer test `an entry id depends on the parent, the role and the body` and the union-law test
- **Committed in:** `2d117b9`

**3. [Rule 2 - Missing critical] `makeRecord` `base` option, `liveRecords` and `baseId` helpers**
- **Found during:** Task 1/2
- **Issue:** the descendant rule is only a semilattice if an edit is stamped later than what it edits, and a retained shadowed tombstone needs a reader that hides it. The plan's artifact list had neither.
- **Fix:** `makeRecord(..., { base })` stamps `at` strictly after the base; `liveRecords` filters tombstones; `baseId` strips fork suffixes. All additive.
- **Files modified:** `src/domain/state/records.ts`, `src/domain/state/merge.ts`
- **Committed in:** `2d117b9`, `384e3d3`

**4. [Rule 2 - Missing critical] `unionEntries` keyed by (thread, id), `threadLines` defends against parent cycles**
- **Found during:** Task 1
- **Issue:** identical first messages in two different threads share an id by the hash-chain rule; corrupt parent loops would drop or hang.
- **Fix:** key includes the thread; unreachable-by-parent entries are emitted as single-entry branches so nothing is ever hidden.
- **Files modified:** `src/domain/state/threadEntries.ts`
- **Committed in:** `2d117b9`

---

**Total deviations:** 4 auto-fixed (2 Rule 1, 2 Rule 2). **Impact on plan:** all necessary for the plan's own invariants (laws, no lost entries); no scope creep. The TDD "red" for Task 2 was real for deviation 1 (three property tests failed before the redesign); the thread-side property tests passed first time because Task 1 already implemented the union and arrangement rules.

## Known limits (documented in `merge.ts`)

The merge laws hold for histories where an edit is stamped later than every copy of the record it edits (clock skew larger than the gap breaks the "descendant wins" ordering), and where a fork kind edited twice in a row is not merged without the middle step after it was dropped (a record keeps only `basedOn`, not its whole ancestry). Both only ever cost an extra "from another computer" copy of a fork-kind record; no entry or saved record is dropped. Lww kinds and threads are not affected by the second limit.

## Issues Encountered

None beyond the deviations above. `.planning/state.json` was already modified in the working tree before this plan and was left alone.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plans 03 onward can import `src/domain/state/*` for record revisions, set merge, thread arrangement and the tool-result cap. Out-of-scope pid-only writers found along the way are listed in `deferred-items.md` for a follow-up plan.

## Known Stubs

None.

## Threat Flags

None - pure modules with no network, auth or file access; the six service edits only change a temporary file name.

## Self-Check: PASSED

- Files: `src/domain/state/records.ts`, `merge.ts`, `threadEntries.ts`, `src/test/stateMerge.test.ts`, `src/test/threadMerge.test.ts` exist.
- Commits `2d117b9`, `384e3d3`, `4976814` are ancestors of HEAD.
- `node --test dist/test/stateMerge.test.js dist/test/threadMerge.test.js`: 19 tests, 0 failing; the five task-3 test files plus cyberEmergencyStop: 49 tests, 0 failing.
- `grep -c 'process.pid}.tmp'` is 0 in all six task-3 files; `Math.random` is 0 in both new test files; `from 'vscode'` is 0 in the three domain modules.
