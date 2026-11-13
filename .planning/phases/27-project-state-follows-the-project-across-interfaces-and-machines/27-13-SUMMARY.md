---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 13
subsystem: state-sync
tags: [cold-objects, partial-clone, lazy-fetch, archive, consolidation, size-limits, promisor, d-08]

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-01 sealObject/openObject/buildManifest/openManifest; 27-07 thread archive (bundle-object format, class 'cold', delta.jsonl, applyRetention); 27-11 StateTransport; 27-12 StateSync, stateRecords, syncFixtures"
provides:
  - "src/services/stateTransport.ts: configurePartialClone(url), filtered fetch (blob:none through the mirror's 'state' promisor remote), currentTip(), missingObjects(), PARTIAL_CLONE_FILTER; mktree --missing"
  - "src/services/stateSync.ts: cold push of archives, fetchColdThread(id), consolidation (HOT_CONSOLIDATE_COUNT, HOT_CONSOLIDATE_FLOOR_BYTES) with a superset check, SYNC_WARN_BYTES, SYNC_COLD_STOP_BYTES, MAX_LISTED_OBJECTS, SyncOutcome.stayLocal/syncedBytes"
  - "src/services/stateRecords.ts: ColdParts, IndexThread (cold, coldEntries, turns), LocalThread.archived/cold, applyMerged writes entries for archived or online-only threads to the archive's delta file and raises their last use"
  - "src/services/threadStore.ts: ThreadLocation ('local' | 'remote'), setColdFetcher, prepareOpen, noteArchivedMeta, indexedMeta, write guard"
  - "src/services/threadArchive.ts: bundleOf, archiveParts, installArchive, writeArchive"
  - "src/domain/state/archiveProblem.ts: ArchiveProblemReason, ArchiveUnreadableError, archiveProblemText"
affects: [27-14, 27-15, 27-17, sync, history, restore]

actuals:
  tokens: 22000
  tasks: 3
  commits: 8
plan_head_before: b037aa4cdeeb6a8e896c8785d054c1c1e828ad2d
plan_head_after: 5b065c535bf7841a59f9344e0cd40c621058ed5f

tech-stack:
  added: []
  patterns:
    - "The private mirror is a partial clone: remote 'state' with promisor=true and partialclonefilter=blob:none, set in the mirror's own config only; every fetch passes --filter=blob:none and a lazy blob fetch runs under the same SAFE_GIT_CONFIG, timeout and byte cap. A host that cannot filter sends everything and nothing else changes"
    - "A locally archived thread goes up as its own sealed parts (the archive's file names and bytes, class 'cold'), listed in the sealed manifest and in the sealed index (`cold` names, `coldEntries`, `turns`); entries a cold object holds are not also sent hot, and the sync state remembers which ids are cold-covered"
    - "A computer that does not hold a thread lists it from the index (state archived, location remote) and downloads nothing; opening it fetches exactly that thread's parts, authenticates each as a cold object of this project, checks the bundle names this thread, installs the archive byte for byte, then the ordinary unarchive folds it with whatever waited in delta.jsonl"
    - "What another computer adds to an archived thread (here or online-only) is appended to the archive's delta file and the index line is raised to the merged last use: the archive is never decompressed or rewritten during a pull, and the next retention pass ranks the thread live"
    - "Hot consolidation is built from the old hot objects themselves (union with local state, less cold-covered entries), sealed, and used only if it holds every entry and record the old objects held and everything this push sends; the old objects stay in git history"
    - "Size limits stop new uploads, never delete: past 1 GiB or the manifest's object limit an archived thread is kept back whole (no cold object, no hot entries, no records) and the message says how many stay on this computer only"

key-files:
  created:
    - src/domain/state/archiveProblem.ts
    - src/test/stateLazyFetch.test.ts
    - src/test/archiveMerge.test.ts
    - src/test/archiveUnreadable.test.ts
  modified:
    - src/services/stateTransport.ts
    - src/services/stateSync.ts
    - src/services/stateRecords.ts
    - src/services/threadStore.ts
    - src/services/threadArchive.ts
    - src/services/chat.ts
    - src/test/helpers/syncFixtures.ts

key-decisions:
  - "One cold object per thread: a computer adds an archive as a cold object only when the remote's index lists none for that thread; entries gained later travel hot (or in the delta file beside the archive), so a thread archived, continued and archived again never piles up copies of itself"
  - "The 200-object consolidation rule is replaced: cold objects are the only copy of an archive that is not on a computer and are never consolidated away, so the rule counts hot objects (more than 20 after the push, or together over twice the size of what they hold once they add up to 2 MiB). A manifest of 3 500 objects is about 700 KB of the 1 MiB allowed, and cold uploads stop there"
  - "Consolidation is built from the old objects, not from this computer's state alone, and its superset check also covers what the push itself sends; a fault-injected payload that loses the newest entry is refused, the old objects stay and the push goes ahead as usual"
  - "A thread archived here has no thread-context record (its working context lives in the archive), and its meta is the merge of the archive's meta and the index line, so an archived thread never reports an older title or last use than another computer's"
  - "Opening an archived conversation that cannot be opened is explained and opens nothing: the history shows the reason (damaged, needs the recovery code, could not be downloaded) and no tab is made; any write to such a thread (appendEntries, save, checkpoint, captureTranscript, create) is refused with that reason, so an empty view can never be saved over it"
  - "The online-only thread keeps its place in the history through the index alone; retention never downloads one (only opening does), so a normal sync and a retention pass cost no cold bandwidth"

patterns-established:
  - "Lazy-fetch tests read the mirror itself (git rev-list --objects --missing=print) to prove which blobs were and were not downloaded, and compare a hash of every path and byte of the state home before and after a refused open"
  - "Limit tests inject the measured size (`measure`) and the object limit (`maxListedObjects`) instead of writing a gigabyte, and flip the injected size to prove that what was kept back goes up later"

requirements-completed: [SYNC-05, SYNC-01]

coverage:
  - id: D1
    description: "An archived thread is pushed as a cold object (its own parts, unchanged); a computer that syncs lists it archived from the sealed index without downloading it (rev-list --missing lists exactly the cold blobs); opening it fetches exactly its parts, shows the same lines as the computer that archived it, and makes it live"
    requirement: SYNC-05
    verification:
      - kind: integration
        ref: "dist/test/stateLazyFetch.test.js#tracer: an archived thread is pushed cold, listed on B without being downloaded, and fetched in full when B opens it"
        status: pass
      - kind: integration
        ref: "dist/test/stateLazyFetch.test.js#after B opens an archived thread, its next sync does not send the thread again"
        status: pass
    human_judgment: false
  - id: D2
    description: "A cold part changed on the remote is refused when the thread is opened (sha256 and AEAD under the cold class), nothing is written, the state home is byte-identical and the thread stays listed; a remote that cannot filter still syncs and opens the thread"
    requirement: SYNC-05
    verification:
      - kind: integration
        ref: "dist/test/stateLazyFetch.test.js#a cold part changed on the remote is refused when the thread is opened: nothing is written and the thread is still listed"
        status: pass
      - kind: integration
        ref: "dist/test/stateLazyFetch.test.js#a remote that cannot filter still syncs correctly: it sends everything, and an archived thread still opens"
        status: pass
    human_judgment: false
  - id: D3
    description: "A thread archived on A and continued on B ends on both with every entry: A keeps B's entries in the delta file beside the untouched archive, ranks the thread live by the merged last use, and folds both by union; a third computer lists it and opens it with both; a second sync on each side sends nothing; computers with different live counts agree on every thread's content"
    requirement: SYNC-05
    verification:
      - kind: integration
        ref: "dist/test/archiveMerge.test.js#archived on A and continued on B: A keeps B's new entries next to the archive, ranks the thread live, and folds both by union"
        status: pass
      - kind: integration
        ref: "dist/test/archiveMerge.test.js#a third computer that never had the thread lists it archived and opens it with the archive and the entries added since"
        status: pass
      - kind: integration
        ref: "dist/test/archiveMerge.test.js#two computers that keep different numbers of threads live agree on what every thread holds; only which are live differs"
        status: pass
    human_judgment: false
  - id: D4
    description: "Hot objects are replaced by one when more than 20 would be listed or when together they are over twice what they hold, only after a check that the replacement holds every entry and record the old ones held and what the push sends; a fault that loses an entry is refused; parts never exceed 8 MiB"
    requirement: SYNC-05
    verification:
      - kind: integration
        ref: "dist/test/archiveMerge.test.js#more than twenty hot objects are replaced by one: nothing is lost and another computer syncs the same"
        status: pass
      - kind: integration
        ref: "dist/test/archiveMerge.test.js#a consolidation that would lose one entry is refused: the old objects stay and the push goes ahead as usual"
        status: pass
      - kind: integration
        ref: "dist/test/archiveMerge.test.js#hot objects are also replaced when together they are more than twice the size of what they hold now"
        status: pass
      - kind: integration
        ref: "dist/test/archiveMerge.test.js#no object part is over 8 MiB: a larger payload is split and a second computer still reads it"
        status: pass
    human_judgment: false
  - id: D5
    description: "Plain-words limits: a warning from 500 MB, no new cold object from 1 GiB or at the manifest's object limit with the number of conversations that stay on this computer only named, nothing deleted anywhere, and the kept-back archives go up once there is room"
    requirement: SYNC-01
    verification:
      - kind: integration
        ref: "dist/test/archiveMerge.test.js#at 600 MB of synced ciphertext sync says so in plain words, and everything still syncs"
        status: pass
      - kind: integration
        ref: "dist/test/archiveMerge.test.js#at 1.1 GB no new cold object is added: the message says which stay on this computer, nothing is deleted, and they go up once there is room"
        status: pass
      - kind: integration
        ref: "dist/test/archiveMerge.test.js#when the manifest would list more objects than allowed no new cold object is added either, and it says so"
        status: pass
      - kind: unit
        ref: "dist/test/archiveMerge.test.js#the manifest lists at most as many objects as its own size limit allows, with wide margin"
        status: pass
    human_judgment: false
  - id: D6
    description: "Carry-forward from 27-07: an archive that is damaged (modified part, another thread's archive, missing part) or needs the recovery code is explained in plain words, is never shown as an empty conversation, its files and the whole state home are byte-identical after every attempt to open it or write to it, and no write can save over it; a healthy archive is still brought back whole before a write; a sync that brings entries for a damaged archive does not fail"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/archiveUnreadable.test.js#a modified archive part opens as a plain notice, not an empty thread, and is never saved over"
        status: pass
      - kind: unit
        ref: "dist/test/archiveUnreadable.test.js#an archive of another thread put in this thread's folder opens as a plain notice and is never saved over"
        status: pass
      - kind: unit
        ref: "dist/test/archiveUnreadable.test.js#an archive with a missing part opens as a plain notice and is never saved over"
        status: pass
      - kind: unit
        ref: "dist/test/archiveUnreadable.test.js#on a computer with no key for the project, the archive is explained as needing the recovery code, and nothing is written"
        status: pass
      - kind: integration
        ref: "dist/test/archiveUnreadable.test.js#a sync that brings entries for a thread whose archive is damaged does not fail and does not touch the archive"
        status: pass
    human_judgment: false
  - id: D7
    description: "chat.ts asks the thread store to open the thread before making a tab and posts the plain notice (history-error) instead of opening anything when it cannot be opened"
    verification: []
    human_judgment: true
    rationale: "chat.ts runs inside VS Code and no unit test drives the real history-open handler; the store behind it (prepareOpen, the write guard, the notice text) is tested. The phase's manual check: damage an archive part in a copy of a project, choose the conversation in NEAR AI: Show Chat History, and see the notice and no new tab"
---

# Phase 27 Plan 13: Cold archives, lazy fetch and safe growth Summary

**Archived threads travel as cold objects (the archive's own sealed parts) that a computer lists from the sealed index and downloads only when someone opens one, through a private partial-clone mirror; a thread archived on one computer and continued on another keeps every entry on both; hot objects are replaced by one only after a superset check; and a refused or damaged archive is explained in plain words and can never be saved over.**

## Performance

- **Duration:** about 65 min (eight commits, 11:42 to 11:53 local after the reading and design)
- **Tasks:** 3 (one tracer, two TDD) plus the carry-forward from plan 07, done test-first
- **Files:** 4 created, 7 modified

## Accomplishments

- **Cold push and lazy fetch.** A locally archived thread goes up as its own parts, byte for byte, listed in the sealed manifest and the sealed index. The mirror is a promisor with `blob:none`, so a sync downloads the manifest, index and hot objects (git fetches each blob when it is first read) and never a cold part: after A archives one of six threads and B syncs, `rev-list --missing=print` lists exactly the cold blobs and B lists the thread archived with its title and message count. Opening it fetches those parts, shows A's lines, and makes it live. A remote with no filter support sends everything and still works.
- **Archived on A, continued on B.** B's three new entries reach A as hot entries; A writes them to the delta file next to the untouched archive and raises the thread's last use in the index to the merged value, so the next retention pass ranks it live, folds archive and delta by union and archives the lowest-ranked thread instead. A third computer lists the thread from the index, keeps the new entries beside where its archive will land, and opens it with both. Two computers with 2 and 5 live threads end with the same entries in every one of twelve threads.
- **Consolidation with a check.** More than 20 hot objects (or hot objects over twice the size of what they hold) are replaced by one, built from the old objects, kept only if it holds every entry and record they held and everything the push sends. A mutation that disables the check fails the fault-injection test. Cold objects always stay listed; what they hold is not repeated in the new hot object.
- **Plain-words limits.** The message warns from 500 MB and, from 1 GiB or the manifest's object limit, adds no cold object and says how many older conversations stay on this computer only and that nothing was deleted. The kept-back archives go up as soon as there is room.
- **Carry-forward (plan 07).** A damaged, wrong-thread or incomplete archive, or a computer with no key, opens as a plain notice (no tab, no empty thread), every file and the whole state home stay byte-identical, and every write path to that thread is refused with the reason.

## Task Commits

1. **Task 1 (tracer): archived thread pushed cold, listed without download, fetched when opened** - `60ec441` (feat)
2. **Task 2 (TDD): archived on A, continued on B; different live counts; filterless remote** - fix `2cb53bb` (mktree --missing), RED `173346d` (test, 2 of 7 fail), GREEN `091a6ee` (feat, 7 of 7)
3. **Carry-forward (TDD): a refused or damaged archive is explained and never saved over** - RED `009503c` (test, 4 of 7 fail), GREEN `1ea576a` (feat, 7 of 7)
4. **Task 3 (TDD): consolidation with a superset check, size limits** - RED `d4fa520` (test, 5 of 11 fail), GREEN `5b065c5` (feat, 11 of 11)

**Plan metadata:** the docs commit that carries this SUMMARY, STATE.md and ROADMAP.md.

**TDD evidence.** Task 2's RED run failed the continuation case on its last-use assertion and the third-computer case because the thread was created live and partial; the filterless and different-counts cases passed (the latter once `2cb53bb` was in). Carry-forward RED failed the four closed-archive cases because writes created an empty live thread beside the archive. Task 3's RED run failed the count rule, the size rule and the three limit cases; the fault-injection case passed vacuously (nothing consolidated yet), so a compiled-output mutation (the superset check switched off) was run and failed it for the intended reason (1 hot object instead of 21); the build was restored.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] A tree that names a cold part by blob id failed on a computer that never downloaded it**
- **Found during:** Task 2 (the different-live-counts case)
- **Issue:** `git mktree` refuses a blob that is not in the mirror; a computer that lists an archived thread without downloading it could not build its next tree.
- **Fix:** `mktree -z --missing` (the remote already holds the blob; that is why it is carried by id).
- **Files modified:** `src/services/stateTransport.ts`
- **Commit:** `2cb53bb`

**2. [Rule 1 - Bug] The consolidation check did not cover what the push itself sends**
- **Found during:** Task 3 (the fault-injection case)
- **Issue:** Checking only the old objects' content let a replacement that lost the newest entry (not yet in any old object) through.
- **Fix:** the check also covers the push's own entries and records.
- **Files modified:** `src/services/stateSync.ts`
- **Commit:** `5b065c5`

**3. [Rule 2 - Missing critical functionality] Carry-forward scope: store-level write guard, a new domain module, chat.ts**
- **Found during:** the carry-forward
- **Issue:** The orchestrator's carry-forward needed the reason a thread could not be opened and a way to stop writes; the plan lists neither `chat.ts` nor a new module.
- **Fix:** `src/domain/state/archiveProblem.ts` (reasons, error, plain text), `ThreadStore.prepareOpen` and `assertWritable`, one call in `chat.ts` `openSaved`.
- **Files modified:** `src/domain/state/archiveProblem.ts`, `src/services/threadStore.ts`, `src/services/chat.ts`, `src/test/archiveUnreadable.test.ts`
- **Commit:** `1ea576a`

**4. [Rule 3 - Blocking] Test helper additions**
- `syncFixtures.ts` gained `mirrorDir` on `Machine` and `remoteManifest()` (opened manifest of the remote) so tests can read the mirror and the object list.

### Plan wording

- **"After 25 syncs ... the next push consolidates"** (Task 3): the rule is "more than 20 hot objects would be listed after the push", so the 21st push consolidates (20 pushes leave 20 objects; the 21st leaves 1). The test asserts that, the cap of 20, no loss, and that a second computer syncs the same.
- **"Size accounting sums the manifest's object byte counts"** is exactly that; `measure` is a test seam on top of it.
- **The 200-object rule** from plan 12 is gone (see key-decisions); the manifest's 1 MiB limit is kept consistent through `MAX_LISTED_OBJECTS` (3 500 objects, tested to stay under 80% of it), and the limit test arithmetic was corrected (a limit of 4 with 2 reserved leaves room for 2 archives, not 1).
- **Archived threads** no longer produce a `thread-context` record; the context travels inside the cold object.

**Total deviations:** 2 auto-fixed bugs, 1 added scope (carry-forward), 1 helper change, 4 wording differences. **Impact:** none on the plan's contract; seams are additive.

## Known Limits

- A thread that some other computer archived as a cold object while this computer holds more of it in its own archive sends the extra entries hot (never a second cold object); they are small.
- A first sync on a computer fetches each unread hot object and the index with one git round trip each (the cost of `blob:none`); there is no batch prefetch.
- Opening an online-only thread uses the tip of the last fetch, not a fresh one; a thread archived elsewhere after that fetch is listed only after the next sync.
- Retention never downloads an online-only thread, even when it ranks live; only opening does.
- Turning sync on, entering the recovery code and the history label for "kept online" are plan 15's flows; `StateSync` registers the fetcher itself when it is built.
- The remote address is written to the mirror's own config (inside the git-ignored state home) so a lazy fetch can find it; an address with a token in it is stored there as it is in the person's own `.git/config`.

## Issues Encountered

None beyond the deviations above. The known `chatSendPath` "GSD slash command" failure is the machine-specific one; the full suite is 1 704 tests: 1 694 pass, 9 skipped, 1 fails (that one). `.planning/state.json` was already modified and was left alone.

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: stored-remote-address | src/services/stateTransport.ts | `configurePartialClone` writes the remote's address (as `ls-remote --get-url` resolves it, userinfo included) to `sync/mirror.git/config` inside the git-ignored state home; the person's own repository already holds the same address |

The plan's register is covered: T-27-55 (a changed cold part is refused by sha256 and the cold-class AEAD before anything is written, tested), T-27-56 (superset check and fault injection, mutation-checked), T-27-57 (lazy fetch runs through the same `--git-dir` mirror runner with hooks, signing, helper transports and fsmonitor off, under the transport's timeout and byte cap; the address was validated in plan 11 and `configureLocked` re-checks it), T-27-58 (500 MB warning, 1 GiB stop, 8 MiB parts, manifest object limit, consolidation).

## Next Phase Readiness

- Plan 15 wires the turn-on and unlock flows; `StateSync` already registers `fetchColdThread` with the thread store it is given.
- `ThreadIndexItem.location` is available for a history label such as "kept online".

## Self-Check: PASSED

- Files: `src/domain/state/archiveProblem.ts`, `src/test/stateLazyFetch.test.ts`, `src/test/archiveMerge.test.ts`, `src/test/archiveUnreadable.test.ts` exist.
- Commits `60ec441`, `2cb53bb`, `173346d`, `091a6ee`, `009503c`, `1ea576a`, `d4fa520`, `5b065c5` are ancestors of HEAD; 8 measured by `git rev-list --count b037aa4..HEAD`.
- Acceptance: stateLazyFetch 4 passing, archiveMerge 11, archiveUnreadable 7, 0 failing; `grep -c "blob:none" src/services/stateTransport.ts` 1; `grep -c appendArchiveDelta src/services/stateRecords.ts` 1; `grep -c HOT_CONSOLIDATE_COUNT src/services/stateSync.ts` 3; stateTwoMachines, stateRecovery and stateLeak still pass.
- Plan verification: `npm run lint` clean; state, thread, history, archive, participant and chat tests 279 of 280 (the known failure); full suite 1 694 of 1 704 with only the known failure.
