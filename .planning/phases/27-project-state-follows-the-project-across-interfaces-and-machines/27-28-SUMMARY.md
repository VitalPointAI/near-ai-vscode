---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 28
subsystem: state-keys
tags: [security, review-gap-closure, keys, locks, meta-json]
requires: []
provides:
  - "StateKeys.readKeyFile: the one way a key file or the recovery wrap is read (not tracked by git, private regular file of this user, key check required)"
  - "StateRefusalReason 'foreign-folder' with its plain sentence"
  - "ProjectStateHome.trackedByGit(), privateFileProblem(file), withMetaLock(work), updateMetaHeld(change)"
  - "stateLocks.ts: withStateLock(root, 'sync' | 'meta', work, options), STATE_LOCKS_DIR, StateBusyError"
  - "stateMirrorLock.ts: acquireFileLock and withFileLock (any lock file name)"
affects: [27-30, 27-31, 27-36]
tech-stack:
  added: []
  patterns: ["nothing inside the project folder decides which key is used", "one owner plus a cross-process lock for bookkeeping files"]
key-files:
  created:
    - src/services/stateLocks.ts
    - src/test/stateKeyTrust.test.ts
  modified:
    - src/domain/state/keys.ts
    - src/services/stateHome.ts
    - src/services/stateKeys.ts
    - src/services/stateMirrorLock.ts
    - src/test/stateKeys.test.ts
    - src/test/stateHome.test.ts
key-decisions:
  - "Provenance on this computer, not 'this editor only': a key file is used when it is untracked, a regular non-link file owned by this user with no group or other bits, and a key check opens with it. A literal this-editor rule would break D-10 and D-15."
  - "A tracked state folder is refused for every key source (file, recovery wrap, and the device copy too) in dataKey, ensureDataKey, keepDeviceCopy, adoptDataKey, storeRecoveryWrap and writeLocalKeyFile"
  - "Key creation order inside the meta lock: this editor's device copy, then the key file (replacing a check-less file), then the key check"
  - "Reads open the key file with O_NOFOLLOW where the platform has it, so a link swapped in after the check is not followed"
requirements-completed: [SYNC-03, SYNC-01]
status: complete
commits: 2
plan_head_before: 95cd71c03d29ffbe7fbeacd057a614bda39a7404
plan_head_after: 7bb52c7be7b7d71c5c53be6b71b82749bbc1e574
actuals:
  tokens: 13700
  tasks: 2
  commits: 2
completed: 2026-11-13
---

# Phase 27 Plan 28: Which key is used, and one owner for meta.json Summary

A key file or recovery wrap is used only when it is this user's private regular file in a state folder that git does not track and, for the key, a key check opens with it; key creation and every meta.json change now run under one cross-process lock (`.near-ai/locks/meta.lock`), and the cached key is tied to the state id.

## What changed

- `keys.ts`: `'foreign-folder'` refusal reason with the plain sentence.
- `stateHome.ts`: `trackedByGit(git?)` (`git ls-files -z --cached -- .near-ai/state .near-ai/locks`, any failure counts as not tracked, reused 30 s), exported `privateFileProblem(file)` (link, non-regular file, link parent; on POSIX owner and group/other bits), `withMetaLock`, `updateMetaHeld`; `updateMeta` is now `withMetaLock(() => updateMetaHeld(...))` and re-reads meta.json inside the lock; the per-instance `metaQueue` is gone.
- `stateKeys.ts`: private `readKeyFile` (throws `StateRefusedError('foreign-folder')` for a tracked folder, undefined for a file that fails `privateFileProblem`); `find` uses a file key only with a key check that opens with it (the "trusted once" branch is deleted) and refuses a tracked folder before any key source; cache is `{ stateId, key }`, dropped when meta.json names another id; `dataKey()` turns `foreign-folder` into undefined, `ensureDataKey()` lets it through; creation and `adoptDataKey` run inside `withMetaLock` with the order device copy, key file (`writeFileAtomic`, replacing a check-less or planted file), key check (`updateMetaHeld`); `writeLocalKeyFile` replaces an untrusted file with the verified key under the lock.
- `stateMirrorLock.ts`: `acquireFileLock` / `withFileLock` (in-process chain keyed by the full lock file path, optional `busy()` error); `acquireMirrorLock` / `withMirrorLock` are thin wrappers with unchanged behaviour.
- `stateLocks.ts` (new): `withStateLock(root, 'sync' | 'meta', ...)` makes `.near-ai/locks` owner-only, writes its `.gitignore` (`*`) first with an exclusive create, then takes the file lock; `StateBusyError` carries the plain sentence. Header documents the order rule (a holder of 'sync' may take 'meta'; 'meta' never takes 'sync') and that the locks are not re-entrant.
- Tests: `stateKeyTrust.test.ts` (7 tests: tracked folder in a real repository, 0644 vs 0600, symbolic link, planted key without check and tracked planted check, recovery wrap tracked/link/0640, cache follows state id, second editor on the same computer); 5 new `stateHome.test.ts` tests (two child processes creating the key at once for 10 rounds, two child processes interleaving 20 `updateMeta` calls each, dead-process lock takeover and live-lock `StateBusyError`, locks `.gitignore` first and clean `git status`, planted check-less key replaced).

## Verification (memory-capped, targeted)

- Task 1 set (stateKeyTrust, stateKeys, stateHome, stateApiKey, stateRecovery, threadLog): 73/73 pass.
- Task 2 set (stateHome, stateKeys, stateKeyTrust, stateSyncGit, stateMigration, syncFlows): 96/96 pass.
- Extra key-path set (stateTwoMachines, threadArchive, archiveUnreadable, stateStores, stateRestoreProfile, stateHostileFolder, stateLeak, stateApiKey, stateRecovery, threadLog): 107/107 pass.
- `npm run lint` (tsc --noEmit): clean.
- Acceptance greps: `readFile(this.home.paths.localKey` 0; `trusted once` 0; `foreign-folder` in keys.ts 2; `withStateLock` in stateHome.ts 2; `metaQueue` 0; `withFileLock` export 1.
- Mutation check: with `updateMeta` temporarily run without the lock in the compiled output, the interleaving test failed on 3 of 3 runs (compiled file restored from a copy; source untouched).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Test fixture] The 27-03 test "removing the key file is refused until a recovery wrap exists" wrote recovery.json with the default mode**
- **Found during:** Task 1
- **Issue:** the test wrote `{}` to keys/recovery.json at mode 0644. `hasRecoveryWrap()` now reflects only a usable (private, untracked) file, so the file the test stands in for a wrap written by the extension must be mode 0600, as the extension writes it.
- **Fix:** the fixture file is written with `{ mode: 0o600 }`. No assertion was changed or removed.
- **Files modified:** src/test/stateKeys.test.ts
- **Commit:** e8f6e06

**2. [Rule 2 - Missing critical] A tracked state folder is refused for every key source and every writer, not only the file read**
- **Found during:** Task 1
- **Issue:** the plan names readKeyFile; but with the key file switched off, the SecretStorage device copy would still have opened a tracked folder's chats, and writers (adopt, store recovery wrap, write key file) would have written into it.
- **Fix:** `find` and the writers call the same tracked check first; behaviour tests cover the device-copy case.
- **Commit:** e8f6e06

**3. [Rule 1 - Bug] `writeLocalKeyFile` left an untrusted file in place**
- **Found during:** Task 2
- **Issue:** it used an exclusive create, so a planted or older untrusted file at keys/local.key stayed and the "written again" key file was never usable.
- **Fix:** it replaces the file with the verified key under the meta lock.
- **Commit:** 7bb52c7

**4. [Plan wording] Interim state between the two commits:** the Task 1 commit still created the key with the old exclusive-create race path (the winner read goes through readKeyFile); the lock and the replace-a-check-less-file order arrive in the Task 2 commit as planned. Both tasks' tests ran after both commits.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-27-113 to T-27-117 are mitigated and covered by the tests above.

## Next Phase Readiness

- Plan 27-30 (sync): reuse `withStateLock(root, 'sync', work, options?)` from `src/services/stateLocks.ts` (`STATE_LOCKS_DIR`, `StateBusyError`; a holder of 'sync' may take 'meta'). Inside `home.withMetaLock(work)` change meta.json only with `home.updateMetaHeld(change)`; `home.updateMeta(change)` takes the lock itself and deadlocks if called while it is held (the locks are not re-entrant).
- Plan 27-36 (README troubleshooting entry for a tracked folder): the 'foreign-folder' sentence is "This project's saved-state folder is part of the project's files in git, so NEAR AI does not use it. Chats still work, but they are not saved until the folder is taken out of the repository. Nothing was changed." The fix to describe is taking `.near-ai/state` and `.near-ai/locks` out of git's index (`git rm -r --cached .near-ai/state .near-ai/locks`), after which the extension's own `.gitignore` files keep them out.
- Plan 27-31 still owns the rest of the join MAJOR (refuse while runs are live, lock across copy and swap, late writes).

## Self-Check: PASSED

- src/services/stateLocks.ts and src/test/stateKeyTrust.test.ts found; commits e8f6e06 and 7bb52c7 are on the branch.
