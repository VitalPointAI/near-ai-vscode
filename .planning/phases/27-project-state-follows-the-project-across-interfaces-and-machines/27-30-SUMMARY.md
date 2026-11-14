---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 30
subsystem: state-sync
tags: [sync, review-gap-closure, locks, recovery-wrap, bookkeeping]
requires: ["27-27", "27-28"]
provides:
  - "syncOwnerFor(root): one in-process queue per project folder; SyncOwner.run(work, timings?, lock = true) holds .near-ai/locks/sync.lock"
  - "Recovery wrap generations: RecoveryWrap.gen, generationOf, nextGeneration, StateKeys.storeRecoveryWrapIfNewer (the only writer of keys/recovery.json)"
  - "IndexPayload.wrapGen (the sealed index carries the generation of the header's wrap)"
  - "SyncState lastTip, remoteId, seqFloor, wrapGen and the reset rule; StateTransport.isAncestor and addressId"
  - "The honest new-code message"
affects: [27-31, 27-36]
tech-stack:
  added: []
  patterns: ["one owner per project folder plus a cross-process lock for bookkeeping files", "higher generation wins, replace-if-newer under the meta lock", "bookkeeping tied to the remote tip and address, with a sequence floor"]
key-files:
  created:
    - src/test/syncBookkeeping.test.ts
  modified:
    - src/services/stateSync.ts
    - src/services/stateKeys.ts
    - src/services/stateRecords.ts
    - src/services/stateTransport.ts
    - src/services/syncFlows.ts
    - src/test/syncFlows.test.ts
    - src/test/stateRecovery.test.ts
    - src/test/stateKeyTrust.test.ts
key-decisions:
  - "Opening the remote with a code (openRemote, unlockFromRemote) and asking what it holds (remoteState) keep their place in the owner's queue but take no lock file: they never touch sync/state.json, and the lock folder would break 'a wrong code creates nothing'."
  - "Work started from inside a run of the same owner (an archived thread opened during a merge calls fetchColdThread) runs at once, tracked with AsyncLocalStorage; waiting for the run it is part of would never end."
  - "Taking over the wrap of a project just opened with its code replaces a kept wrap that does not open to the same data key (a join replaced the key), whatever its generation; otherwise the generation rule decides."
  - "A different wrap of an equal generation that the remote vouches for replaces the kept one (the tie rule for wraps from earlier builds, which have no generation); a strictly lower generation never does."
  - "Data-key rotation (re-keying) is deferred as a follow-up: it means re-sealing and re-uploading every thread, archive and cold object, including archives held only online. The message says so honestly."
requirements-completed: [SYNC-04, SYNC-05]
status: complete
commits: 3
plan_head_before: 10b6395b6e528614af8431f9ef17050b0c3ae007
plan_head_after: 8fb547ee412c3230fa1cc274f7786a1ecd74482c
actuals:
  tokens: 15000
  tasks: 3
  commits: 3
completed: 2026-11-14
---

# Phase 27 Plan 30: One owner for sync bookkeeping, wrap generations, the reset rule Summary

Every StateSync of a project folder now runs through one owner that holds a cross-process lock for the whole run; a recovery wrap carries a generation so a new code is never undone; and sync/state.json resets when the remote's branch is gone, re-pointed or rewritten, so no computer is refused afterwards.

## What changed

- `stateSync.ts`
  - `SyncOwner` and `syncOwnerFor(root)` (map by resolved folder). Every public operation goes through `owner.run(...)`; `sync`, `pullOnly` and `fetchColdThread` hold `withStateLock(root, 'sync')` from reading sync/state.json to writing it back. `StateBusyError` and `MirrorBusyError` read as `waiting` (and a cold fetch that cannot get the lock reads as offline). New option `lockTimings` for tests. The old per-instance `chain` is gone.
  - `chooseWrap` decides by generation: the remote's generation counts only when the sealed index names the header's wrap; a newer local wrap is pushed (even with nothing else to send), a newer vouched remote wrap is adopted through `storeRecoveryWrapIfNewer` and adds "A newer recovery code made on another computer now opens this project." to the outcome; the same wrap at a higher remote generation refreshes the local copy; an unvouched header is never adopted; a header older than `state.wrapGen` is never adopted. `markWrapChanged` is removed; `wrapPending` is still parsed and only breaks a tie.
  - The index a push seals carries `wrapGen`; `openRemote` reads the generation from the remote's index so a new computer starts with the right one.
  - `SyncState` gains `lastTip`, `remoteId`, `seqFloor`, `wrapGen`, all parsed strictly. In `attempts`, after the fetch and before `loadRemote`, `historyChanged` resets the state (`resetState`: fresh, keeping `seqFloor = max(old floor, lastSeenSeq)`, `wrapGen`, and a legacy pending mark) when the address id changed, the branch is gone while state.json shows history, or the tip is not a descendant of `lastTip`. A push's sequence is above the remote's, `lastSeenSeq` and `seqFloor`. After a reset, conversations this computer lists as archived but cannot send (the remote lacks them too) are counted in one plain sentence; they stay listed.
- `stateKeys.ts`: `RecoveryWrap.gen`, `parseRecoveryWrap` accepts the two-key and three-key form, `generationOf`, `nextGeneration`, `writeRecoveryWrap(codeBytes, gen?)` (generation chosen under the meta lock), `storeRecoveryWrapIfNewer(wrap, { foreign?, acceptEqual? })` replaces `storeRecoveryWrap` for every caller.
- `stateRecords.ts`: `IndexPayload.wrapGen`.
- `stateTransport.ts`: `isAncestor(ancestor, tip)` (merge-base --is-ancestor in the mirror under the mirror lock) and `addressId()` (first 16 hex of sha256 of the clean address of the last fetch, push or blob read).
- `syncFlows.ts`: `newCodeFlow` writes a generation, no separate pending mark, and says "Your new recovery code opens this project on a new computer." (plus "It goes online the next time this project syncs." when sync is off) then the honest sentence; `enterCodeFlow` keeps the opened wrap through `storeRecoveryWrapIfNewer`.

## Verification (memory-capped, targeted)

- Task 1 set (syncBookkeeping, stateTwoMachines, stateLazyFetch, syncFlows): 63/63 pass.
- Task 2 set (syncFlows, syncBookkeeping, stateTwoMachines, stateKeys, stateKeyTrust, stateRecovery): 109/109 pass.
- Task 3 set (syncBookkeeping, stateTwoMachines, stateSyncGit, stateLazyFetch, archiveMerge, syncFlows): 95/95 pass; stateRecovery after the test change: 30/30.
- Extra set (stateLeak, archiveUnreadable, stateHostileFolder, stateRestoreProfile, syncMirrorCredentials, threadArchive, stateKeys, stateKeyTrust, stateRecovery, stateHome, stateMigration, stateStores, stateApiKey): 140/142; the two failures are described below. Second extra set (pickup, threadReplay, protectedPaths, chatBridge, chatProgress, attestation, multimodalOrchestration): 76/76.
- `npm run lint` (tsc --noEmit): clean after each task.
- Mutation checks on the compiled output (source untouched): with the lock removed from `SyncOwner.run`, all three owner tests fail; with `historyChanged` forced to false, the delete-branch, rewound-history, archived-online and re-pointed tests fail.
- Acceptance greps: `syncOwnerFor` 3 (need 2+); `private chain` 0; `markWrapChanged` 0; `until the data is re-keyed` 0; `wrapGen` 9 in stateSync.ts (need 3+); `storeRecoveryWrapIfNewer` 2 in stateKeys.ts (need 2+); `lastTip` 6 (need 3+); `isAncestor` 1 in stateTransport.ts (need 1+).
- New tests: 8 in syncBookkeeping (3 owner, 5 reset), 5 new in syncFlows, 1 added in stateRecovery.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The owner lock folder broke "a wrong code creates nothing"**
- **Found during:** Task 1 (syncFlows `newCodeFlow` test: a refused fresh computer must not have a `.near-ai` folder)
- **Issue:** routing `openRemote`, `unlockFromRemote` and `remoteState` through the file lock created `.near-ai/locks` in the project before a wrong code was refused.
- **Fix:** those three keep their queue position in the owner but take no lock file (`run(work, timings, lock = false)`); they never read or write sync/state.json. `sync`, `pullOnly` and `fetchColdThread` hold the lock.
- **Files modified:** src/services/stateSync.ts
- **Commit:** dbe1e31

**2. [Rule 2 - Missing critical] A nested operation inside a run would wait for itself**
- **Found during:** Task 1 (reading `threadStore.ensureLive` and `assertWritable`)
- **Issue:** a merge that writes entries to a thread kept only online calls the cold fetcher, which is `fetchColdThread`, which now goes through the owner: it would queue behind the run it belongs to and never finish.
- **Fix:** `SyncOwner.run` runs work started from inside a run of the same owner at once (AsyncLocalStorage), so it never takes the lock again.
- **Commit:** dbe1e31

**3. [Rule 2 - Missing critical] Taking over the opened wrap after a join**
- **Found during:** Task 2 design
- **Issue:** a pure generation compare could keep a stale local wrap that belongs to the previous data key after a join (the old project's wrap may have a higher generation), and then push it.
- **Fix:** `storeRecoveryWrapIfNewer(wrap, { foreign })` replaces a kept wrap that does not open to the opened data key with the code just typed. `acceptEqual` is the tie rule for wraps without a generation.
- **Commit:** 6544a27

**4. [Plan-mandated behavior change, test updated] stateRecovery "an older valid tree ... is refused"**
- **Found during:** Task 3 extra run
- **Issue:** that test moved the branch back to an older commit with `update-ref` and expected a refusal as rolled back. The plan's own Task 3 behaviour ("Rewritten history: the bare remote's branch is moved back to an older commit; A syncs: not refused") and its reversibility note say that case is now accepted, with the union merge, the wrap generation and the sequence floor as the protection.
- **Fix:** the test now puts the older tree back on top of the branch (a descendant of the last tip, so the rollback check still applies and the refusal and byte-identical assertions are unchanged), and a new test covers the moved-back branch under the new rule. No assertion was dropped; the protection against a replayed older tree on top stays tested. Flagged for the owner: it changes how a rewound branch is treated.
- **Files modified:** src/test/stateRecovery.test.ts
- **Commit:** 8fb547e

**5. [Rule 1 - Test fixture] `stateKeyTrust` called the removed `storeRecoveryWrap`**
- **Fix:** it calls `storeRecoveryWrapIfNewer(wrap)`; the assertions are unchanged.
- **Commit:** 6544a27

## Deferred Issues

- Pre-existing, unrelated: `dist/test/stateStores.test.js` "checkpoints in the state home are format 2 ... a second editor reverts" fails ("an outside file keeps today's same-machine behaviour"). It passed in plan 27-28's extra run and none of its code path is touched here (no import of stateSync, stateKeys or any file of this plan); plan 27-29 (commit 0b5b299) made `RunCheckpoints.load` and `revert()` skip an absolute path that is in neither the project nor an allowed root, and the test loads the checkpoint with `{ root }` only. That test needs `allowedRoots` for its outside file, or its expectation updated, in a plan that owns checkpoints. Not fixed here.
- Data-key rotation (re-keying so the old code stops opening later objects) is a recorded follow-up, not part of this plan.
- A `fetchColdThread` inside a run updates sync/state.json through `noteCold`, and the outer run later writes its own in-memory state over it. The only loss is a note that an archived thread's entries are already online, so a later push may send them again; it was already so before this plan.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-27-122 to T-27-126 are mitigated and covered by the tests above (off-then-on, raced and offline-pair new codes; the child-process lock; delete, re-point and rewind; the honest message).

## Next Phase Readiness

- Plan 27-36 (SECURITY.md, README, CHANGELOG), exact new-code sentences from `newCodeFlow`:
  - "Your new recovery code opens this project on a new computer."
  - With sync off, then: "It goes online the next time this project syncs."
  - When sync is on but the first sync after it did not finish: "It could not go online yet and will with the next sync."
  - Always last: "Anyone who has your old code and can read this project's repository can still open everything synced, including what is synced from now on, because your chats keep the same key. A way to change that key is planned."
  - The sentence the computer whose code lost sees in its sync outcome: "A newer recovery code made on another computer now opens this project."
  - Docs should say the data key is not rotated by a new code (it changes only who can open a new computer), and that re-keying is the recorded follow-up.
- Plan 27-31 (join): the owner is `syncOwnerFor(root)` from `src/services/stateSync.ts`. Run the join as `syncOwnerFor(env.root).run(async () => { ... })`; it queues behind any running sync and holds `.near-ai/locks/sync.lock` for the whole operation. It throws `StateBusyError` (from `stateLocks.ts`) when the lock cannot be had in time; map that to the plain sentence. A sync started from inside that operation runs at once without taking the lock again (so the first sync after the join must be started after the operation returns, as the plan says). Inside the operation take 'meta' only through `home.withMetaLock` and change meta.json only with `home.updateMetaHeld`. Outside any StateSync, `withStateLock(root, 'sync', work)` from `stateLocks.ts` takes the same lock but does not join the in-process queue, so prefer the owner. The wrap is stored with `keys.storeRecoveryWrapIfNewer(wrap, { foreign: { codeBytes, dataKey, stateId } })`.

## Self-Check: PASSED

- src/test/syncBookkeeping.test.ts found; commits dbe1e31, 6544a27 and 8fb547e are on the branch (`git merge-base --is-ancestor` for each).
