---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 27
subsystem: sync
tags: [security, review-gap-closure, sync-settings, online-home, editor-storage]
requires: ["27-26"]
provides:
  - "SyncSettingsStore, mementoSyncSettings(memento, root, legacy), memorySyncSettings(root), SyncEnv.settings; resolveRemote and every flow read and write through it"
  - "OnlineHomeProgressStore, mementoProgressStore(memento, root), memoryProgressStore(root); readProgress(store), writeProgress(store, progress); OnlineHomeInput.progress and CodePushLaterInput.progress"
affects: [27-36]
tech-stack:
  added: []
  patterns: ["nothing inside the project folder decides where state goes", "editor storage (globalState) keyed by a hash of the project folder and bound to the state id"]
key-files:
  created: []
  modified:
    - src/services/syncFlows.ts
    - src/services/syncCommands.ts
    - src/services/codePushLater.ts
    - src/services/onlineHome.ts
    - src/services/onlineHomeVscode.ts
    - src/test/syncFlows.test.ts
    - src/test/onlineHome.test.ts
key-decisions:
  - "Whether sync is on and which remote it uses live in globalState under nearAi.sync.projects (entry per project: stateId, enabled, remote, legacyChecked); meta.json is never given a sync field again."
  - "A switch an earlier 0.4.20 build kept in meta.json is adopted once per editor and project, only when StateKeys.dataKey() returns a key and the remote named is one git lists for the project; a transient failure of that check is not recorded, so it is looked at again."
  - "A stored entry whose state id differs from meta.json's reads as off (and its remote is dropped); an entry written before any state home existed carries no id and is not bound."
  - "The online-home setup's progress lives in globalState under nearAi.onlineHome.progress; the in-project online-home.json is never read or written, and the flow no longer creates the state home as a side effect."
requirements-completed: [SYNC-05, SYNC-09]
status: complete
commits: 2
plan_head_before: 96cd2e1dacab1dd5c163ac0236d77503bec5f018
plan_head_after: c50df6c3595cb774ffc01226b0084cbddeaf5cef
actuals:
  tokens: 14500
  tasks: 2
  commits: 2
completed: 2026-11-13
---

# Phase 27 Plan 27: Sync switch, remote and online-home progress in the editor's storage Summary

Whether project sync is on, which remote it uses and how far the online-home setup got are now kept in this editor's own storage, so a meta.json or an online-home.json planted in a project changes nothing (REVIEW B1, "where state goes" boundary).

## What changed

- `syncFlows.ts`: `SyncSettingsStore`, `memorySyncSettings(root)` (per resolved root per process, never a file) and `mementoSyncSettings(memento, root, legacy?)`. `readSyncSettings` and the meta.json `sync` writer are gone. `resolveRemote(env, ui)` now takes `{ root, git, settings }` and keeps its order (stored, origin, the only one, the person's pick). `turnOnFlow`, `finishTurnOn`, `enterCodeFlow`, `newCodeFlow` and `turnOffFlow` use the store; enabling writes first make sure the state home exists so the entry is bound to its state id.
- `syncCommands.ts`: `runtimeFor` builds `env.settings` from `context.globalState`; `runOnce` resolves the remote through it; activation enables the scheduler from `env.settings.read()`; the online-home flow gets `mementoProgressStore`.
- `codePushLater.ts`, `onlineHomeVscode.ts`: the code push gets the editor's progress and settings stores.
- `onlineHome.ts`: `OnlineHomeProgressStore`, `memoryProgressStore`, `mementoProgressStore`; `readProgress(store)` keeps its strict parse and `writeProgress(store, ...)` writes only the four fields. `progressFile`, the in-project folder creation and `OnlineHomeInput.home` are removed.
- Tests: 8 new syncFlows tests (planted switch tracer, store-only turn on and off, remote pick, guarded legacy adoption, refused adoption, state id binding, second editor, strict parse) and 2 new onlineHome tests (planted progress file never read, editor-storage resume); the old readProgress and resolveRemote assertions were moved to the stores and the token-hygiene test now also covers the stored record.

## Verification (memory-capped, targeted)

- Task 1 set (syncFlows, codePushLater, stateHostileFolder, stateRestoreProfile): 64 tests, 64 pass, 0 fail.
- Task 2 set (onlineHome, codePushLater, codePushCheck, syncFlows) plus stateHostileFolder: 124 tests, 124 pass; onlineHomeNames and syncControl: 38 of 38 pass.
- `npm run lint`: clean.
- Acceptance greps: `updateMeta({ sync` 0 (was 1); `export async function readSyncSettings` 0 (was 1); `mementoSyncSettings` in syncCommands 2; `readProgress(home` 0 (was 2); `mementoProgressStore` in onlineHomeVscode and syncCommands 4 in total.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Source-shape test referenced the removed reader**
- **Found during:** Task 1
- **Issue:** the syncFlows activation test sliced `syncCommands.ts` from the text `readSyncSettings(runtime.env.home)`, which no longer exists.
- **Fix:** it now slices from `runtime.env.settings` (the new activation read); the assertion that `refreshSyncHome` follows is unchanged.
- **Files modified:** src/test/syncFlows.test.ts
- **Commit:** 445b326

**2. [Plan wording] `home` removed from `OnlineHomeInput`, and the online-home flow no longer calls `home.ensure()`**
- The plan removed "the in-project folder creation" for the progress file; the flow's `home.ensure()` existed only to make that folder, and no caller passed `home`, so both went. The turn-on flow still creates the state home when sync is turned on (before the settings are written).

**3. [Plan wording] The code-push command's settings store is built without the legacy adoption**
- `registerCodePushCommand` has no keys or state home to offer the adoption; it reads the same globalState entry the runtime already adopted into at activation.

## Known Stubs

None.

## Threat Flags

None. T-27-110, T-27-111 and T-27-112 are mitigated and covered by the planted-meta, planted-progress and state-id tests.

## Next Phase Readiness

For plan 27-36 (docs): sync is now turned on per editor. A second editor on the same computer shows "Sync off · Turn on" until its person clicks, and turning on there shows the consent screen and no new recovery code. A dev install that turned sync on with an earlier 0.4.20 build keeps syncing once after the update (guarded one-time adoption), and an online-home setup that an earlier dev build left half-done starts over from its first question (the flow still checks GitHub before creating anything, so nothing is duplicated).

## Self-Check: PASSED

- All seven modified files present; commits 445b326 and c50df6c are on the branch.
