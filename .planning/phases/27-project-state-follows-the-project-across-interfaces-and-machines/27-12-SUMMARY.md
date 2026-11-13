---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 12
subsystem: state-sync
tags: [sync, merge, recovery-code, two-machines, leak-scan, refusal, records]

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-01 sealObject/openObject/buildManifest/openManifest, wrapDataKey, StateRefusedError; 27-02 mergeRecordSets, unionEntries, makeRecord; 27-04 run markers and checkpoints in the state home; 27-07 thread store and archive; 27-09 model choices; 27-10 spend mirror; 27-11 StateTransport"
provides:
  - "src/services/stateSync.ts: StateSync (sync, pullOnly, unlockFromRemote), SyncOutcome, SyncKind, MAX_PUSH_ATTEMPTS, CONSOLIDATE_AT_OBJECTS, StateSyncOptions"
  - "src/services/stateRecords.ts: SYNCED_KINDS, CHECKPOINT_SYNC_RUNS, CHECKPOINT_SYNC_BYTES, collectLocal, applyMerged, mergeAll, foldHeads, withoutBody, recordKey, relativeSnapshots, LocalSnapshot, HotPayload, IndexPayload, ProfileSource, SecretSource"
  - "src/services/stateKeys.ts: RecoveryWrap, writeRecoveryWrap, readRecoveryWrap, storeRecoveryWrap, adoptDataKey, parseRecoveryWrap"
  - "src/services/stateHome.ts: ensure({ stateId })"
  - "src/services/modelChoices.ts: mergeProjectChoices; src/services/spendMirror.ts: parseSpendLines, mergeSpendLines, spendFileText; src/services/stateTransport.ts: StateFileRef (writeCommit carries an unchanged object by blob id)"
  - "src/test/helpers/syncFixtures.ts: machine, syncedPair, chain, treeHash, writeMarker, remotePayloads, remoteFiles, replaceRemoteTree"
affects: [27-13, 27-14, 27-15, 27-17, sync, restore, pickup]

actuals:
  tokens: 26900
  tasks: 3
  commits: 5
plan_head_before: 24d1b9ce35326e7adb826bfca6335cf1de476213
plan_head_after: 0c37e20e4e70811c0bf47d6815edfd39a4f4a26c

tech-stack:
  added: []
  patterns:
    - "A sync is fetch, verify everything (manifest, state id, index, every object not read before, sequence number), merge, apply, then build one hot object, a new index and a new manifest on the remote tip; a rejected push fetches, merges and retries up to 5 times with jittered waits, never forced"
    - "The sync holds no lock of its own around transport calls (the transport's mirror lock is not re-entrant); an in-process queue serialises sync, pull and unlock, and MirrorBusyError becomes the 'waiting' outcome"
    - "Local bookkeeping in sync/state.json: highest sequence number seen (rollback protection), first file name of every object already merged, entry ids the remote holds per thread, and record 'heads' (kind, id, rev, at, writer, no body) so a record is sent only when the remote lacks that revision"
    - "A changed local record is built as an edit of the remote head (makeRecord base), so one writer evolving a record never forks against itself; only a genuinely concurrent edit forks"
    - "Spend months are not decided by 'newer wins': the lines of every copy are united (the mirror's own keying), and heads for spend keep every revision seen so a union is never re-sent"
    - "Thread meta crosses machines without counts, tip, size or archived state (each machine works those out from its own log), so equal content has equal revision and a second sync is a no-op"

key-files:
  created:
    - src/services/stateRecords.ts
    - src/services/stateSync.ts
    - src/test/stateTwoMachines.test.ts
    - src/test/helpers/syncFixtures.ts
  modified:
    - src/services/stateHome.ts
    - src/services/stateKeys.ts
    - src/services/stateTransport.ts
    - src/services/threadStore.ts
    - src/services/modelChoices.ts
    - src/services/spendMirror.ts
    - src/test/stateLeak.test.ts
    - src/test/stateRecovery.test.ts

key-decisions:
  - "SyncOutcome has a fifth kind, 'failed', carrying the transport's SyncFailure, because offline, sign-in and host-policy failures are neither 'refused' nor 'waiting' and plan 15's scheduler needs them for its status line and backoff"
  - "The remote's index object is always re-read (it is small and its file name changes every push) and its per-thread entry counts are checked against what this computer holds after reading every listed object; a bundle that lists fewer objects than its own authentic index describes is refused (missing-object)"
  - "The manifest's state id must equal this project's id (tampered): a holder of the key can seal under any id, and an empty foreign manifest would otherwise move lastSeenSeq"
  - "Without a key and state home of its own, a computer whose remote already holds state is refused with 'locked' instead of making a fresh key; unlockFromRemote verifies the unwrap and the manifest before the state home is made, so a wrong code creates no folder (the mirror for that first fetch must therefore live outside the state home: plan 13 passes a temporary mirror folder)"
  - "A consolidated push (the manifest would list 200 or more objects) seals everything into one object and lists only it; the manifest's 1 MiB cap binds near 5 000 entries, so 200 leaves wide margin and old contexts do not pile up"
  - "Thread meta is carried as thread-meta records with at = lastUsedAt, and the thread store's importThread is reused to apply entries, meta and context (it now accepts a missing context and a context that keeps its own basedOnTip)"
  - "Checkpoints of a run that is running (any marker with that run id in state running-here or running-elsewhere), comparisons still marked running, and markers of live runs are never sent, and a received copy never replaces a live local marker or checkpoint"
  - "Fork copies of comparisons are not written (a fork id is not a comparison id); fork copies of checkpoints are written under their fork id, where nothing opens them but nothing is lost"
  - "Profile and secret records are collected only through the ProfileSource and SecretSource plan 15 will pass; received ones go to applyProfiles when given, otherwise they are sealed in sync/records.enc and applied by the first sync that has it"

patterns-established:
  - "Two-machine tests run real git against a local bare remote with two project folders that share nothing but the remote; tamper cases use plain git on the bare remote (replaceRemoteTree) and compare a hash of every path and byte of the state home before and after"
  - "Every refusal case asserts the plain 'Nothing was changed.' wording and byte-identity of the state home, not only the outcome kind"

requirements-completed: [SYNC-05, SYNC-04]

coverage:
  - id: D1
    description: "Machine A pushes its state home; machine B, with the project at a different path and only the recovery code, gets A's thread with every entry and title, continues it and pushes, A pulls B's turns, and a second sync on each computer pushes nothing and leaves the remote tip where it was"
    requirement: SYNC-05
    verification:
      - kind: integration
        ref: "dist/test/stateTwoMachines.test.js#tracer: A pushes a six-entry thread, B opens it with the recovery code at another path, continues it, and A gets B's turns"
        status: pass
      - kind: integration
        ref: "dist/test/stateTwoMachines.test.js#a second sync on each computer finds nothing new and the remote tip does not move"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every promised kind syncs within its limits: finished and cut-off markers (never a running one, and a running run's checkpoint stays), newest ten checkpoints within 25 MiB with outside snapshots stripped and B's revert writing under B's root, comparisons, per-setting choices (the later wins), spend lines united by id and version, and the pick-up pointer"
    requirement: SYNC-05
    verification:
      - kind: integration
        ref: "dist/test/stateTwoMachines.test.js#markers: an ended run and a cut-off run sync; a run that is running here or elsewhere never does"
        status: pass
      - kind: integration
        ref: "dist/test/stateTwoMachines.test.js#checkpoints: of twelve runs only the newest ten sync, outside files never leave, and B reverts under its own root"
        status: pass
      - kind: integration
        ref: "dist/test/stateTwoMachines.test.js#checkpoints: fewer sync when the newest runs together pass 25 MiB"
        status: pass
      - kind: integration
        ref: "dist/test/stateTwoMachines.test.js#a checkpoint of a run that is still running is never sent"
        status: pass
      - kind: integration
        ref: "dist/test/stateTwoMachines.test.js#comparisons, model choices and the pick-up pointer sync, and the newer choice wins on both computers"
        status: pass
      - kind: integration
        ref: "dist/test/stateTwoMachines.test.js#spend lines from both computers are united by id and version, and nothing is lost"
        status: pass
    human_judgment: false
  - id: D3
    description: "Concurrent and edge cases: two computers pushing at the same moment end with both computers' threads after one push is rejected and retried, in one linear history; a pull from a remote without the branch changes nothing and says so; the first sync creates the branch; sync waits while a run is in flight and sends nothing without a recovery code"
    requirement: SYNC-05
    verification:
      - kind: integration
        ref: "dist/test/stateTwoMachines.test.js#two computers pushing at the same moment both end with both computers' threads; the lost race is retried, never forced"
        status: pass
      - kind: integration
        ref: "dist/test/stateTwoMachines.test.js#an empty remote: a pull changes nothing and says so, and the first sync creates the state branch"
        status: pass
      - kind: integration
        ref: "dist/test/stateTwoMachines.test.js#sync waits while a run is in flight in this editor, and without a recovery code it sends nothing"
        status: pass
    human_judgment: false
  - id: D4
    description: "Only the allow-listed kinds are collected and nothing else beside the state (security-scan consent, emergency stop, spend token id, saved-profile index, Team Mode, cyber engagement) is in anything sent; the leak scan over a real sync of seeded threads, choices, markers, spend and checkpoints finds no title, id, model name, prompt, key, recovery code or person identity in any blob, tree name, commit, message or ref, with a positive control that every seeded value was in what was sent"
    requirement: SYNC-05
    verification:
      - kind: integration
        ref: "dist/test/stateTwoMachines.test.js#only the allow-listed kinds are ever collected, and what is sent opens to nothing else"
        status: pass
      - kind: integration
        ref: "dist/test/stateLeak.test.js#a real sync of a state home seeded with threads, choices, markers, spend and checkpoints leaves no readable trace in the remote"
        status: pass
      - kind: integration
        ref: "dist/test/stateLeak.test.js#the remote history of a real sync carries only the anonymous identity and the constant message"
        status: pass
    human_judgment: false
  - id: D5
    description: "A tampered, cut-short, incomplete (object missing from the tree, or omitted from the manifest while an authentic index lists it), foreign (another state id, with or without objects) or older (lower sequence number) remote bundle gives one plain refusal and leaves every path and byte of the state home identical; a wrong code on a fresh computer creates no state home folder; after a refusal a later valid push is accepted"
    requirement: SYNC-04
    verification:
      - kind: integration
        ref: "dist/test/stateRecovery.test.js#a manifest with one flipped byte is refused and the state home is byte-identical"
        status: pass
      - kind: integration
        ref: "dist/test/stateRecovery.test.js#an object cut short is refused and the state home is byte-identical"
        status: pass
      - kind: integration
        ref: "dist/test/stateRecovery.test.js#a listed object missing from the tree is refused and the state home is byte-identical"
        status: pass
      - kind: integration
        ref: "dist/test/stateRecovery.test.js#an older valid tree (a lower sequence number than one already seen) is refused and the state home is byte-identical"
        status: pass
      - kind: integration
        ref: "dist/test/stateRecovery.test.js#a bundle sealed for another project (another state id), with or without objects, is refused and the state home is byte-identical"
        status: pass
      - kind: integration
        ref: "dist/test/stateRecovery.test.js#a manifest that leaves out the object an authentic index says is there is refused and the state home is byte-identical"
        status: pass
      - kind: integration
        ref: "dist/test/stateRecovery.test.js#the wrong recovery code on a fresh computer creates no state home, and a sync before opening the project creates none either"
        status: pass
      - kind: integration
        ref: "dist/test/stateRecovery.test.js#after a refusal a later valid push is accepted and the earlier refusal changed nothing"
        status: pass
    human_judgment: false

duration: 70min
completed: 2026-11-13
status: complete
---

# Phase 27 Plan 12: Two-Machine State Sync Summary

**StateSync fetches, verifies everything before the first local write, merges per record with the plan-02 rules, applies, and pushes one hot object, index and manifest on the remote tip (retrying a lost race up to five times, never forced), so a second computer with the project cloned at another path and only the recovery code gets every thread, marker, checkpoint, comparison, choice, spend line and pick-up pointer, and a tampered, truncated, incomplete, foreign or older bundle changes nothing.**

## Performance

- **Duration:** about 70 min
- **Completed:** 2026-11-13
- **Tasks:** 3 (one tracer, two TDD)
- **Files:** 4 created, 8 modified

## Accomplishments

- A thread written on computer A is restored on computer B at a different path from the recovery code alone, continued there, and the continuation comes back to A with no entry lost. A second sync on each computer pushes nothing and the remote tip does not move.
- All the promised kinds sync inside their limits (newest 10 checkpoints within 25 MiB, root-relative snapshots only, finished or cut-off runs only), through each kind's own store, with every id checked against its pattern before a path is built.
- A leak scan over a real sync of seeded state finds nothing readable in the remote; a positive control proves every seeded value was in what was sent.
- Eight refusal cases leave the state home byte-identical: flipped manifest, cut-short object, missing object, older sequence number, another project's state id, a manifest that omits an object its authentic index lists, a wrong code (no folder made), and recovery after refusal.
- Two computers pushing at the same moment end with both threads in one linear history after one push is rejected and retried.

## Task Commits

1. **Task 1: Tracer** - `7bb02a2` (feat): recovery wrap and key adoption, state home takes the remote's id, thread collect/apply, StateSync, three two-machine tests
2. **Task 2: Every synced kind** - `d039420` (test, RED: 5 of 17 failed) then `d314f9a` (feat, GREEN: 17 of 17)
3. **Task 3: Refusal leaves the state home identical** - `d64e54c` (test, RED: 2 of 27 failed) then `0c37e20` (feat, GREEN: 44 of 44 across the three files)

**Plan metadata:** the docs commit that carries this SUMMARY, STATE.md and ROADMAP.md.

**TDD evidence.** Task 2's RED run failed the marker, both checkpoint, choices/comparisons/pick-up and spend cases for the reason that none of those kinds was collected or applied; the tracer, concurrency, empty-remote and leak cases passed vacuously because only threads existed (the leak scan gained a positive control in the GREEN commit). Task 3's RED run failed exactly the two cases that needed new checks (state id, index coverage); the other six refusal cases already held through plan 01's `openManifest`/`openObject` and the tracer's presence checks. A compiled-output mutation (removing the running-run filter) failed the marker, the live-checkpoint and the concurrent-push cases for the intended reason; the build was restored.

## Files Created/Modified

- `src/services/stateSync.ts` - StateSync: sync, pullOnly, unlockFromRemote, retry loop, remote loading and verification, commit building, consolidation, sync/state.json bookkeeping, held profile/secret records
- `src/services/stateRecords.ts` - what syncs: collect each kind into records, apply a merge through each store, spend-aware merge and head folding
- `src/services/stateKeys.ts` - recovery wrap read/write/store, key adoption on a new computer
- `src/services/stateHome.ts` - `ensure({ stateId })` used only when meta.json does not exist
- `src/services/stateTransport.ts` - `writeCommit` accepts `{ name, oid }` so unchanged objects are not read and stored again
- `src/services/threadStore.ts` - `importThread` accepts a missing context and `keepContextTip`
- `src/services/modelChoices.ts` - `mergeProjectChoices` keeps an incoming entry's own time and writer
- `src/services/spendMirror.ts` - exports the mirror's own line parse, union and file text
- `src/test/stateTwoMachines.test.ts` (13 cases), `src/test/stateLeak.test.ts` (4), `src/test/stateRecovery.test.ts` (27), `src/test/helpers/syncFixtures.ts`

## Decisions Made

See `key-decisions`. The sync never holds the mirror lock around its own work (the carry-forward from plan 11), the index is checked against what was actually read, and a changed record is always an edit of the remote head so single-writer evolution cannot fork.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Seams in files the plan did not list**
- **Found during:** Tasks 1 and 2
- **Issue:** Applying received state needed `importThread` to accept a missing context and to keep a context's own `basedOnTip`; applying a choice without stamping a new time needed a merge entry point in modelChoices; spend needed the mirror's own line keying; carrying unchanged objects into a new tree without re-reading them needed a blob-id form in `writeCommit`.
- **Fix:** Small additive exports and optional fields in `threadStore.ts`, `modelChoices.ts`, `spendMirror.ts`, `stateTransport.ts`; no existing behaviour changed (the 79 related tests, and 303 of 304 in the wider state/thread/spend/choices run before a test-only fix, pass).
- **Files modified:** `src/services/threadStore.ts`, `modelChoices.ts`, `spendMirror.ts`, `stateTransport.ts`
- **Committed in:** `7bb02a2`, `d314f9a`

**2. [Rule 1 - Bug] Concurrent-push test compared one side only**
- **Found during:** Task 3 wider run
- **Issue:** Which computer wins the race is not fixed, so the winner had not yet seen the loser's thread when the test looked.
- **Fix:** Each computer syncs once more before the comparison; 8 consecutive runs pass.
- **Files modified:** `src/test/stateTwoMachines.test.ts`
- **Committed in:** `0c37e20`

**3. [Plan wording] `SyncOutcome` kinds**
- The plan lists four kinds; a fifth, `'failed'` (with the transport's `SyncFailure`), is added because offline, sign-in and host-policy outcomes fit none of them. Plan 15's scheduler needs the distinction.

**4. [Plan wording] No lock around the whole sync**
- The plan text says sync runs "inside the transport's mirror lock"; the plan-11 carry-forward says the lock is not re-entrant and transport methods must not be called inside one. The sync therefore serialises in-process and relies on the transport's per-call lock plus compare-and-swap push; two windows syncing at once cost at most one retried push.

**Total deviations:** 2 auto-fixed, 2 wording differences. **Impact:** none on the contract; seams are additive.

## Authentication Gates

None.

## Issues Encountered

None beyond the test race above. The known `chatSendPath` "GSD slash command" failure was not touched.

## Known Stubs

None. Profile and secret records have no source or apply hook yet by design: `ProfileSource`, `SecretSource` and `applyProfiles` are typed options that plan 15 fills; until then received records wait sealed in `sync/records.enc`.

## Threat Flags

None. The plan's register (T-27-49 to T-27-54) is covered by the byte-identical refusal tests, the id patterns checked before any path, outside-snapshot stripping with size and count caps, live-run exclusion, and the real-state leak scan. The one new local file, `sync/records.enc`, is sealed under the data key.

## Next Phase Readiness

- Plan 13 builds the flows: it must pass `unlockFromRemote` a transport whose mirror lives outside the state home (a temporary folder), because the first fetch happens before the home may exist, and must refuse an `undefined` from `parseRecoveryCode` with `StateRefusedError('wrong-code-or-damaged')` before calling it.
- Plan 15 supplies `profileSource`, `secretSource` and `applyProfiles` and wires `runState` from `RunMarkers`.
- Not covered: the 5-minute and 10-minute scheduling, and removal of a record on one machine (tombstones are merged and kept but nothing yet produces them).

## Self-Check: PASSED

- Files: `src/services/stateRecords.ts`, `src/services/stateSync.ts`, `src/test/stateTwoMachines.test.ts`, `src/test/helpers/syncFixtures.ts` exist.
- Commits `7bb02a2`, `d039420`, `d314f9a`, `d64e54c`, `0c37e20` are ancestors of HEAD; 5 measured by `git rev-list --count`.
- `grep -c "from 'vscode'"` is 0 for stateSync.ts and stateRecords.ts; `MAX_PUSH_ATTEMPTS` appears 2 times in stateSync.ts; `CHECKPOINT_SYNC_BYTES` 4 times in stateRecords.ts.
- stateTwoMachines 13, stateLeak 4, stateRecovery 27 passing, 0 failing; `tsc --noEmit` clean.
