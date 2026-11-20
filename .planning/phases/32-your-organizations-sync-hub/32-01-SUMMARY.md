---
phase: 32-your-organizations-sync-hub
plan: 01
subsystem: staff replica store
status: complete
tags: [replica, start-again, crash-safety, fsync, D-03, D-06, MUS-06]
requires: []
provides:
  - syncFolder(dir) and setFolderSyncProbe in src/staff/staffFiles.ts (for 32-02 and 32-07)
  - START_AGAIN_INTENT_FILE, START_AGAIN_LOCK_FILE, START_AGAIN_STEPS, setStartAgainProbe, finishStartAgain, sharedHistoryMissing in store.ts
  - StartedAgain { ok: true; setAside: string | null; carried: number; carriedFrom?: string }
  - store refusals start-again-unfinished and nothing-to-carry
affects:
  - 32-02 (the Start Again command sentence must handle setAside null and carriedFrom)
  - 32-07 and 32-02 (use syncFolder)
  - 32-09 (changes replicaProject.ts in wave 3)
tech-stack:
  added: []
  patterns: [intent record plus roll-forward for a two-rename swap, folder fsync after each rename, crash-injecting forked child]
key-files:
  created:
    - src/test/staffReplicaStartAgain.test.ts
    - src/test/helpers/startAgainCrashChild.ts
  modified:
    - src/staff/staffFiles.ts
    - src/staff/replica/store.ts
    - src/staff/replica/replicaProject.ts
    - src/staff/logisticsHost.ts
    - src/test/staffReplicaProject.test.ts
decisions:
  - Every locked store operation takes the .planning/staff lock (replica.start-again.lock) before the store's own locks, so no window can make or read the store folder while a Start Again holds it
  - A .planning/staff the user cannot write lets locked operations run without that lock, only when no intent is there (no Start Again can run there)
  - The intent's setAside is null when there was no store folder to set aside; recovery picks the next free set-aside name when the intent's is taken
  - Recovery of another device's intent finishes its folders but refuses start-again-unfinished when it would have to rebuild (it cannot verify another device's own entries)
  - sharedHistoryMissing means the store folder is absent and a set-aside or new folder beside it holds project.json
metrics:
  duration: about 75 minutes
  completed: 2026-11-20
actuals:
  tokens: 22900
  tasks: 3
  commits: 3
plan_head_before: ffddff863527f3bdb581bc908442b161c3804871
plan_head_after: 0c5ff777b2427cef2e752f479bfb01c09ba01a1a
---

# Phase 32 Plan 01: Start Again is resumable and never starts empty Summary

Start Again now records an intent before its first rename, syncs .planning/staff after every step, and every open rolls an unfinished one forward; a store folder that went missing is rebuilt from the newest verifying set-aside folder (named in carriedFrom), never started empty, and the project keeps reading as shared the whole time.

## What changed

- `src/staff/staffFiles.ts`: `syncFolder(dir)` (open read-only, `sync()`, close; EINVAL, ENOTSUP, EISDIR, EPERM and EBADF ignored; no sync on Windows) and `setFolderSyncProbe` for tests.
- `src/staff/replica/store.ts`:
  - Start Again builds `replica.new-<12 hex>` and syncs every folder in it (`built`), writes `.planning/staff/replica.start-again.json` (`{ v: 1, writer, setAside, temporary, source, carried, grants, blobs }`, basenames only) and syncs .planning/staff (`intent-written`), renames the store aside (`set-aside`), moves the new one in (`moved-in`), writes the mark (`marked`), then removes the intent. .planning/staff is synced after each of these.
  - `finishStartAgain` / roll-forward handles every state: store and temporary present, store gone and temporary present, both gone (rebuild from the folder the intent names), both renames done (mark unless it already accepts the store). Names must match the two exact patterns and v 1.
  - `locked()` takes the .planning/staff lock first and runs the roll-forward when an intent is there. A missing store folder is refused rolled-back (and not made) when this device's mark remains or a folder beside it holds project.json.
  - Where Start Again carries from: the store when it holds an own entry; else the newest set-aside folder, then the newest `replica.new-*`, whose own entries are one unbroken chain this device signed; else the first folder holding project.json; else `nothing-to-carry`.
  - Instance paths use the folder's own parts, so a set-aside folder can be read as a store (blobs, grants, lists) without touching the real store path.
  - Any error that is not a Refusal inside Start Again or its recovery becomes `start-again-unfinished`. Nothing is ever deleted.
- `src/staff/replica/replicaProject.ts`: `open` and `startHistoryAgain` lstat the intent first and finish it. `open` refuses store-refused rolled-back when project.json is missing and `sharedHistoryMissing`. `startHistoryAgain` runs Start Again in that case.
- `src/staff/logisticsHost.ts`: when project.json is missing, `sharedProjectRefusal` also refuses if the intent is there or a set-aside or new folder in .planning/staff holds a project.json. It checks with fs only and never loads src/staff/replica. Any other error fails closed.

## Tests

`src/test/staffReplicaStartAgain.test.ts`: 23 tests. These include one per crash step (built, intent-written, set-aside, moved-in, marked) run through the forked child, a tracer in project mode, the sync order, the "both gone" rebuild, two opens at once, intents that are bad or belong to another device, two planted files, a read-only .planning/staff, a deleted store folder, an older version's leftover, an empty store folder, two set-aside folders (newer, unsigned line, gap), a reader device, nothing-to-carry, a plain unshared folder, and the refusal texts.

Failing first: the sources were put back to the plan's base. Only the new exports were stubbed (the constants, a probe that does nothing, a syncFolder that does nothing, the two refusal texts), so the test file compiled. Result: `tests 23, pass 3, fail 20`. Sample failures on the unchanged code:
- the crash children ran to the end (`"done", setAside ..., carried 3`): there was no step boundary to stop at
- a deleted store folder: "no empty store is made" failed, because open made an empty store
- an older version's leftover: `sharedProjectRefusal` returned undefined, so the folder read as unshared
- a read-only .planning/staff: a raw `EACCES: permission denied, mkdir .../replica.new-...` was thrown
- a bad intent: the store opened, because nothing read the intent

The 3 that passed pin behaviour the plan keeps "as today": the reader device, the plain unshared folder, and the refusal texts, which were part of the stubs.

Green, on the plan's six files under the cap: `tests 115, pass 115, fail 0`, and `npm run lint` exits 0. A wider replica set (those six plus staffReplicaMembership, staffReplicaKeyring, staffReplicaCopy and staffReplicaMigration): `tests 203, pass 203, fail 0`. The MJ-08 tests in staffReplicaStore.test.ts pass unchanged.

Acceptance greps: `export async function syncFolder` 1; `start-again` in logisticsHost.ts 4; `carriedFrom` in store.ts 2; `'nothing-to-carry'` 2; `'start-again-unfinished'` 6.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] staffReplicaProject.test.ts no longer compiled after the StartedAgain type change**
- **Found during:** Task 1 (lint)
- **Issue:** `path.join(lead.root, started.setAside, ...)` takes a string, and `setAside` is now `string | null`.
- **Fix:** added `assert.ok(started.setAside !== null, ...)` just before that line. This adds an assertion and weakens nothing.
- **Files modified:** src/test/staffReplicaProject.test.ts (outside the plan's file list, one line)
- **Commit:** 8db5f4a1

**2. [Rule 2 - Correctness] Every locked store operation holds the .planning/staff lock, not only Start Again and its recovery**
- **Issue:** with only an lstat of the intent before the store's lock, a window already waiting on `replica.lock` could get it inside the new store between moved-in and marked. It could also hit ENOENT while the store folder was away.
- **Fix:** `locked()` takes the .planning/staff lock before the store's locks, in the same order Start Again uses. If .planning/staff cannot be written (EACCES, EPERM, EROFS), the operation runs without that lock, but only when no intent is there.
- **Commit:** 0c5ff777

**3. [Rule 2 - Robustness] Recovery picks the next free set-aside name when the intent's name is taken**
- **Issue:** a file planted at the set-aside name would otherwise refuse every later open.
- **Fix:** the next free name is chosen and the intent is rewritten and synced before the rename. Start Again itself still refuses `start-again-unfinished` at that moment, as the plan's row requires.

**4. Commits:** the three tasks share most of store.ts, so they landed as three commits (syncFolder, tests, implementation) instead of one commit per task.

**5. syncFolder on Windows** skips the sync itself but still runs the test probe.

## Decisions

These follow the 32-CONTEXT defaults the owner accepted, plus the executor's choices above:
- The intent's `setAside` is `null` when there was no store folder. A `source` of `replica` requires a non-null `setAside`.
- For another device's intent, the folder renames are finished and this device's mark is left alone. If both the store and the temporary folder are gone, recovery refuses `start-again-unfinished` instead of rebuilding, because it cannot verify that device's own entries.
- In "store there, temporary gone" with the named set-aside folder missing, recovery refuses: the store there may still be the old one.

## Open items for the orchestrator

- **32-02:** `startHistoryAgainCommand` in src/services/staffMultiUserCommands.ts still prints `set aside in ${result.setAside}/` (it would read "null/") and does not mention `carriedFrom`. It also returns NOT_SHARED_TEXT before calling `startHistoryAgain` when project.json is missing, so from the command the leftover case only reaches the new path once 32-02 changes that check (for example, to use `sharedProjectRefusal`).
- **Possible stuck state (owner decision):** a store folder deleted while this device's mark remains, with nothing set aside beside it. Start Again answers `nothing-to-carry` and suggests a new welcome file, but `joinFromWelcome` and `createSharedProject` open the store and are refused rolled-back too. The plan asks for exactly this refusal, since starting empty could fork this device's chain. A way out, such as letting a welcome reset the mark, needs a decision.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-32-01: intent names are matched against two exact patterns and v 1, and a planted link or folder at the intent path is refused. T-32-02: a set-aside folder's own lines count only as one unbroken chain this device signed. T-32-03: sharedProjectRefusal fails closed on the intent and on leftovers.

## Self-Check: PASSED

- FOUND: src/test/staffReplicaStartAgain.test.ts, src/test/helpers/startAgainCrashChild.ts
- FOUND commits: 0ae2bea1, 8db5f4a1, 0c5ff777
