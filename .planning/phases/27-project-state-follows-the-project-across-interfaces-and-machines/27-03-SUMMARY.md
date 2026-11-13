---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 03
subsystem: state-sync
tags: [state-home, gitignore, data-key, secretstorage, aes-gcm, hkdf, atomic-write, api-key-copy]

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-01 src/domain/state/keys.ts (newDataKey, subKey, aadFor, seal, open, newStateId) and CONTEXT decisions D-04, D-10, D-15"
provides:
  - "src/domain/scratch.ts: STATE_DIR, stateFolder(root), '.near-ai/state/' in SCRATCH_IGNORE_LINES"
  - "src/services/stateHome.ts: STATE_FORMAT, StateMeta, StatePaths, ProjectStateHome (exists, ensure, readMeta, updateMeta, ensureFolder), stateHomeFor, writeFileAtomic, createExclusive, THIS_WRITER, newWriterId"
  - "src/services/stateKeys.ts: SecretsLike, dataKeySecretName, StateKeys (dataKey, ensureDataKey, transcriptKey, storeDeviceCopy, hasRecoveryWrap, removeLocalKeyFile), stateKeysFor"
  - "src/services/stateApiKey.ts: ApiKeyCopy, writeApiKeyCopy, openApiKeyCopy, removeApiKeyCopy, apiKeyCopyHooks, ApiKeyCopyHooks"
  - "src/test/helpers/stateFixtures.ts: tempProject, MemorySecrets, git, gitInit, gitStatus"
  - "package.json settings nearAi.history.liveConversations and nearAi.sync.keepKeyInProject"
  - "AuthService.keyCopy hooks, ProfileStore written/removed calls, activation wiring"
affects: [27-04, 27-05, 27-06, 27-07, 27-09, 27-10, 27-12, 27-15, 27-16, thread-store, run-markers, sync, restore, migration]

actuals:
  tokens: 15161
  tasks: 3
  commits: 4
plan_head_before: 1cbd803ebec28c279264230f8950304121ac4f17
plan_head_after: e8f62ff3b2a22dd245f3ba724463ab234cfc2fe0

tech-stack:
  added: []
  patterns:
    - "Self-ignoring state folder: an inner .gitignore holding * is the first file written, so nothing below it can be staged, whatever the project's own .gitignore says"
    - "Exclusive create by temp file plus hard link (fallback to wx), so a reader never sees a half-written key or meta file"
    - "A candidate data key is trusted only if it opens the sealed key check in meta.json"
    - "Sealed per-profile copy of a credential under an HKDF subkey with AAD (state id, kind, profile); plaintext only in memory"

key-files:
  created:
    - src/services/stateHome.ts
    - src/services/stateKeys.ts
    - src/services/stateApiKey.ts
    - src/test/helpers/stateFixtures.ts
    - src/test/stateHome.test.ts
    - src/test/stateKeys.test.ts
    - src/test/stateApiKey.test.ts
  modified:
    - src/domain/scratch.ts
    - src/domain/state/keys.ts
    - src/services/auth.ts
    - src/services/profileStore.ts
    - src/extension.ts
    - src/test/scratch.test.ts
    - package.json
    - .planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/deferred-items.md

key-decisions:
  - "Exclusive creation is temp-file plus hard-link, falling back to wx on filesystems without links, so a concurrent reader of keys/local.key or meta.json never sees an empty or partial file"
  - "ensure() always (re)creates the inner .gitignore before meta.json, and a present meta.json with a missing .gitignore is repaired, so the self-ignore invariant does not depend on first creation"
  - "StateKeys trusts a device (SecretStorage) copy only when meta.keyCheck exists; a key file is accepted with no check only to finish an interrupted first run, and the check is then written"
  - "transcriptKey() is a writer path (creates the home and key on first use); dataKey() is the non-creating reader path, which is what keeps 'opening a folder writes nothing'"
  - "The API key copy is asked for once per scope per extension host and only ever released to the endpoint it was sealed for; removing a key on purpose in this editor marks the scope as asked so it is not brought back in the same session"
  - "The sealed copy for a hybrid profile carries the local runtime key too; the hook resolves the local scope by recomputing localKeyScope for each copy file name"
  - "No nearAi.sync.remote setting is declared (D-09 defers it); the plan's research suggestion to declare it now is overruled by the locked decision"

patterns-established:
  - "Pattern: state-level files go through writeFileAtomic after ensure(); never write below .near-ai/state before ensure() has written the inner .gitignore"
  - "Pattern: tests that must prove ignore rules use real git (gitInit, gitStatus, check-ignore) from stateFixtures"

requirements-completed: [SYNC-01, SYNC-03]

coverage:
  - id: D1
    description: "Editor A creates the state home and writes an encrypted file; editor B with an empty SecretStorage decrypts it with no manual step and keeps its own SecretStorage copy under nearAi.state.<stateId>.dataKey"
    requirement: SYNC-03
    verification:
      - kind: unit
        ref: "dist/test/stateKeys.test.js#tracer: editor A writes an encrypted file and editor B opens it with no manual step"
        status: pass
    human_judgment: false
  - id: D2
    description: "keys/local.key is mode 0600 inside a 0700 folder with its own keys/.gitignore; with keepKeyInProject off no key file is written, the key lives only in SecretStorage and a new editor is locked"
    requirement: SYNC-03
    verification:
      - kind: unit
        ref: "dist/test/stateKeys.test.js#the key file is private and ignored twice; the folder is owner-only"
        status: pass
      - kind: unit
        ref: "dist/test/stateKeys.test.js#keepKeyInProject off: no key file is written, the key lives only in SecretStorage, a new editor is locked"
        status: pass
    human_judgment: false
  - id: D3
    description: "Portable identity: a random stateId in meta.json; a state home copied to another path opens with the same stateId and data key; two editors calling ensure() or ensureDataKey() at once end with one stateId and one key"
    requirement: SYNC-03
    verification:
      - kind: unit
        ref: "dist/test/stateKeys.test.js#a state home copied to another path opens with the same stateId and the same data key"
        status: pass
      - kind: unit
        ref: "dist/test/stateHome.test.js#D-04: two instances calling ensure() at the same moment, 20 times, always agree on one stateId"
        status: pass
      - kind: unit
        ref: "dist/test/stateKeys.test.js#two editors creating the key at the same moment end with one key"
        status: pass
    human_judgment: false
  - id: D4
    description: "SYNC-01 self-ignore: with real git, status stays empty after ensure() and writes, check-ignore names the inner .gitignore, and git add of a state file is refused"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/stateHome.test.js#SYNC-01: after ensure() and three writes, git sees nothing and names the inner .gitignore as the rule"
        status: pass
    human_judgment: false
  - id: D5
    description: "SYNC-01 adjacency and empty edges: 20 concurrent atomic writers leave one complete payload and no temporary file; opening a folder creates nothing and readers return empty results until ensure()"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/stateHome.test.js#SYNC-01 adjacency: 20 writers to one target leave exactly one complete payload and no temporary files"
        status: pass
      - kind: unit
        ref: "dist/test/stateHome.test.js#SYNC-01 empty edge: opening a folder creates nothing; readers see an empty result until ensure()"
        status: pass
    human_judgment: false
  - id: D6
    description: "A wrong key in SecretStorage or a planted key file is refused by the key check (T-27-13); a damaged meta.json is a plain error and is left as found"
    requirement: SYNC-03
    verification:
      - kind: unit
        ref: "dist/test/stateKeys.test.js#a wrong key in SecretStorage is rejected by the key check, and a planted key file is not trusted"
        status: pass
      - kind: unit
        ref: "dist/test/stateHome.test.js#the stateId is random and never derived from the folder; a damaged meta.json is a plain error, not replaced"
        status: pass
    human_judgment: false
  - id: D7
    description: "package.json declares nearAi.history.liveConversations (number, 5, 1 to 50) and nearAi.sync.keepKeyInProject (boolean, true), no nearAi.sync.remote, and the saveTranscripts text no longer says chats are never saved in the project"
    verification:
      - kind: unit
        ref: "dist/test/stateHome.test.js#D-08, D-10: the phase settings are declared with their limits, and no sync remote setting is"
        status: pass
    human_judgment: false
  - id: D8
    description: "D-15: a second editor on the host uses the project's NEAR AI key from the sealed copy with no prompt and sync off, storing it in its own SecretStorage under the local project scope; a hybrid profile's local key travels the same way"
    requirement: SYNC-03
    verification:
      - kind: unit
        ref: "dist/test/stateApiKey.test.js#D-15: a second editor on this host uses the key with no prompt and sync off, and keeps it in its own SecretStorage"
        status: pass
      - kind: unit
        ref: "dist/test/stateApiKey.test.js#D-15: the plaintext key is on no disk file and in no log line; a hybrid local key is shared the same way"
        status: pass
    human_judgment: false
  - id: D9
    description: "D-15 refusals and lifecycle: tampered, renamed-to-another-profile and foreign-project copies are refused with one plain notice; unopenable without keys/local.key and SecretStorage; saving rotates the copy, removing the profile removes it; a copy for another endpoint is never released; no copy for team or reused profiles; asked once per scope per host and creates nothing"
    requirement: SYNC-03
    verification:
      - kind: unit
        ref: "dist/test/stateApiKey.test.js#D-15: a tampered copy, a copy renamed to another profile, and a copy from another project are each refused"
        status: pass
      - kind: unit
        ref: "dist/test/stateApiKey.test.js#D-15: saving a new key rotates the copy, removing the profile removes it, and a copy for another endpoint is never released"
        status: pass
      - kind: unit
        ref: "dist/test/stateApiKey.test.js#D-15: the sealed copy is asked for at most once per scope per host, and asking creates nothing"
        status: pass
    human_judgment: false
  - id: D10
    description: "Real behaviour across a code-server container and a desktop VS Code on one host (separate SecretStorage, shared project folder) in the actual editors"
    verification: []
    human_judgment: true
    rationale: "The unit tests model two editors with two MemorySecrets over one temp folder; SecretStorage behaviour in code-server (research A10) and file permissions across a container bind mount are owner-observable and not asserted by any test in this plan"

duration: 11min
completed: 2026-11-13
status: complete
---

# Phase 27 Plan 03: State home and portable data key Summary

**A git-ignored `.near-ai/state/` home (inner `.gitignore` of `*` written first, random portable `stateId`), a per-project AES data key that a second editor on the same host picks up from `keys/local.key` with no manual step, and a sealed per-profile copy of the NEAR AI key so that editor needs no set-up either, proven with real git and two separate secret stores.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-11-13T13:58:00Z
- **Completed:** 2026-11-13T14:09:00Z
- **Tasks:** 3
- **Files modified:** 15 (7 created source/test files, 7 modified source/test/config files, 1 deferred-items log)

## Accomplishments

- The state home exists only after a person's action (`ensure()`); opening a folder creates nothing. Once created, `git status --porcelain` stays empty and `git check-ignore -v` names `.near-ai/state/.gitignore`, and `git add` of a state file is refused.
- Two editors with separate SecretStorage share one project's encrypted files: B reads `keys/local.key` (mode 0600, own `.gitignore`), proves it against the sealed key check in `meta.json`, and then keeps its own copy under `nearAi.state.<stateId>.dataKey`. With `keepKeyInProject` off no file is written and a new editor is locked until it has the recovery code.
- `writeFileAtomic` (random 8-byte temporary name, `wx`, atomic rename) leaves exactly one complete version under 20 concurrent writers; `createExclusive` and `ensure()` give one `stateId` and one key under concurrent creation.
- The project's NEAR AI key (and a hybrid profile's local key) is sealed per profile in `keys/api/<profileId>.enc` under the HKDF `api-key` subkey with AAD over state id, kind and profile. A second editor uses it with no prompt even with sync off; tampered, renamed and foreign copies are refused; saving rotates it, removing the profile deletes it, and it is released only to the endpoint it was sealed for.
- Both phase settings are declared in `package.json`; the `saveTranscripts` description now says chats are saved encrypted in the git-ignored `.near-ai/state` folder.

## Task Commits

1. **Task 1: Tracer, editor A writes and editor B decrypts with no manual step** - `f5a79ef` (feat). Tracer verified end to end (3 tests, 0 failing) before expansion. Includes the `scratch.test.ts` array update that the new `.near-ai/state/` ignore line forces.
2. **Task 2 RED/tests: self-ignore with real git, atomic and ensure races, key opt-out, settings** - `bdf2cec` (test). 1 of 25 failed on the planned assertion (settings not declared).
3. **Task 2 GREEN: settings in package.json** - `75a4fb1` (feat)
4. **Task 3: sealed NEAR AI key copy shared on this host (D-15)** - `e8f62ff` (feat)

**Plan metadata:** the docs commit that carries this SUMMARY, STATE.md and ROADMAP.md.

## Files Created/Modified

- `src/services/stateHome.ts` - state home paths, `ensure()`, atomic and exclusive writes, writer id
- `src/services/stateKeys.ts` - data key lookup order, device copy, key check, key file opt-out
- `src/services/stateApiKey.ts` - sealed NEAR AI key copy and the hooks AuthService calls
- `src/services/auth.ts`, `src/services/profileStore.ts`, `src/extension.ts` - `keyCopy` hook point, rotate/remove calls, activation wiring (no I/O at activation)
- `src/domain/scratch.ts`, `src/domain/state/keys.ts` - `STATE_DIR`/`stateFolder` and the `api-key` purpose
- `src/test/stateHome.test.ts` (10 tests), `stateKeys.test.ts` (8), `stateApiKey.test.ts` (9), `helpers/stateFixtures.ts`, `scratch.test.ts` (expected arrays updated)
- `package.json` - the two settings and the new `saveTranscripts` wording

## Decisions Made

See `key-decisions`. In short: exclusive create by hard link so readers never see a partial key file; `ensure()` repairs a missing inner `.gitignore`; a device copy is trusted only against a key check; reader path never creates; the key copy is asked once per scope per host and bound to its endpoint.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `scratch.test.ts` expected arrays broke with the new ignore line**
- **Found during:** Task 1
- **Issue:** appending `.near-ai/state/` to `SCRATCH_IGNORE_LINES` changes `gitignoreAdditions`, so four expected arrays in `scratch.test.ts` no longer matched. The plan schedules this edit in Task 2, but leaving it out of the Task 1 commit would have left a red test in that commit.
- **Fix:** updated the four expected arrays and one comment in the Task 1 commit; no assertion loosened.
- **Files modified:** `src/test/scratch.test.ts`
- **Commit:** `f5a79ef`

**2. [Rule 2 - Missing critical] Exclusive create had a torn-read window**
- **Found during:** Task 1 (design)
- **Issue:** a plain `wx` create exposes an empty file to a concurrent reader between create and write. For `keys/local.key` and `meta.json` that reads as a missing or corrupt key.
- **Fix:** `createExclusive` writes a temporary file and hard-links it into place (fails with `EEXIST` if present), with a `wx` fallback where links are unsupported.
- **Files modified:** `src/services/stateHome.ts`
- **Commit:** `f5a79ef`

**3. [Rule 2 - Missing critical] Key check and trust rules for the device copy**
- **Found during:** Task 1
- **Issue:** the plan accepts a candidate only if it opens `meta.keyCheck`, but did not say what to do with a key file when no check exists yet (an interrupted first run) or with a device copy when none exists.
- **Fix:** a key file with no check yet is trusted once and the check is written; a SecretStorage copy is never trusted without a check.
- **Files modified:** `src/services/stateKeys.ts`
- **Commit:** `f5a79ef`

**4. [Rule 2 - Missing critical] Scope removal and hybrid local key handling for the key copy**
- **Found during:** Task 3
- **Issue:** a key removed on purpose in one editor would be restored from the shared copy at the next read, and the hybrid local key is read under a different scope id than the profile's.
- **Fix:** `removeScopedApiKey` marks the scope as already asked for this host; the hook maps a local scope back to its profile by recomputing `localKeyScope` for each copy file name.
- **Files modified:** `src/services/auth.ts`, `src/services/stateApiKey.ts`
- **Commit:** `e8f62ff`

### Process note on TDD

Task 3 is marked `tdd="true"`, but the implementation was written before the test file in this session, so there is no genuine RED commit for it. As compensation a mutation check was run before the commit: removing the profile from the AAD and the inner profile check made the tamper/swap test fail (8 pass, 1 fail), and the file was restored byte for byte. Task 2's RED was real (the settings test failed on the planned assertion; the other 24 passed against the Task 1 implementation because it already covered those behaviours).

**Total deviations:** 4 auto-fixed (1 Rule 1, 3 Rule 2) plus the TDD process note. **Impact:** no scope change; stricter than the plan in the three places above.

## Known limits

- With `keepKeyInProject` off, two editors that create the key in the same instant can each keep their own key; the later `keyCheck` write wins and the other editor is locked until the recovery code. This is a first-creation race only and costs a recovery-code entry, never data.
- A second editor that already holds a key in its SecretStorage keeps using it after the first editor rotates the key; the shared copy is read only when this editor has no key for the scope.
- Real SecretStorage behaviour in code-server (per browser profile, research A10) and file modes across a container bind mount are not testable here (coverage D10).

## Issues Encountered

`dist/test/chatSendPath.test.js` "a GSD slash command runs the installed skill ..." fails on this machine because it reads the real home-folder Teams library; unrelated to this plan and logged in `deferred-items.md`. `.planning/state.json` was already modified before this plan and was left alone.

## Authentication Gates

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plans 04 onward can call `stateHomeFor(root)` for every path, `writeFileAtomic`/`createExclusive` for writes after `ensure()`, `THIS_WRITER` for writer fields, and `stateKeysFor(root, secrets, keep)` for `transcriptKey()` (writer) or `dataKey()` (reader). Plan 15 adds `keys/recovery.json` (which unlocks `removeLocalKeyFile()`) and re-stores keys under the local scope on restore; plan 16 carries the README sentence about file permissions. Callers must run `ensure()` before writing anywhere below `.near-ai/state` and must not call it on activation.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register (T-27-11..15, T-27-83..86 are mitigated by the tests above). The new key-copy files and `keys/local.key` sit inside the already-modelled state home.

## Self-Check: PASSED

- Files present: `stateHome.ts`, `stateKeys.ts`, `stateApiKey.ts`, `helpers/stateFixtures.ts`, `stateHome.test.ts`, `stateKeys.test.ts`, `stateApiKey.test.ts`.
- Commits `f5a79ef`, `bdf2cec`, `75a4fb1`, `e8f62ff` are ancestors of HEAD; `gsd_run check evaluation-scope --plan 27-03 --commits-only` resolves them.
- Acceptance: `stateKeys` 8 tests (needs 3), `stateHome` 10 tests (needs 4), `stateApiKey` 9 tests (needs 7), 0 failing; `grep -c "'wx'" stateHome.ts` is 3; `process.pid` is 0 in `stateHome.ts` and `stateKeys.ts`; `nearAi.state.` is 2 in `stateKeys.ts`; package.json check exits 0 and "Never saved in the project" is 0; `'api-key'` and `keyCopy` greps are non-zero in every named file.
- Plan verification: `node --test dist/test/stateApiKey.test.js profileStore auth stateHome stateKeys scratch`: 47 tests, 0 failing; providerFactory, profileIndex, setupSteps, spendSendPath, agentProfiles and plan 01/02 state tests pass; `npm run lint` clean; `node scripts/secret-scan.mjs` clean; no `vscode` import in the three service modules; activation wiring performs no I/O.
