---
phase: 69-team-mode-reconciliation-identities-and-signed-events-on-mai
plan: 07
subsystem: team-mode
tags: [team-mode, identity, ed25519, secret-storage, e2e, canary, rollback]

requires:
  - phase: 69-06
    provides: the nearAi.team.preview gate, the nearAi.team.active context key and the team core boundary test
provides:
  - "One Ed25519 identity per person per install under nearAi.identity.deviceKey (DEVICE_KEY_SECRET), created on first need by loadOrCreateDeviceIdentity under identity-create.lock"
  - "forgetCreatedDeviceIdentity and the D-22 rollback rule: a failed Enable forgets a key only when that call created it and it is still the stored one"
  - "Verify Team Log resolves to its VerifyReport; test-only NearAiTestApi.team (ready, session, deviceKeyEvidence) built only inside the NEAR_AI_E2E return"
  - "Digest scanners (deviceKeyFormDigests, scanFilesForDigests, scanGitObjectsForDigests) so the e2e canary never holds the key"
  - "Real-window e2e for Team Mode: palette gate (preview off then on), Enable with default answers, Verify Team Log, canary, plain folder"
affects: [69-08, 69-09, 69-10, 69-14]

actuals:
  tokens: 14200
  tasks: 3
  commits: 3
plan_head_before: f24eb9d8809ecd4f0ae7bed589fe87906f7867be
plan_head_after: 8ce9b38d90be1f76f33d494b9ae1608c613543ca

tech-stack:
  added: []
  patterns:
    - "First-need creation of a secret under a file lock: check, create, store, read back, compare fingerprints"
    - "A test seam that returns digests of a secret instead of the secret, with a scanner that hashes every window of each length in every base64/hex run"
    - "The Command Palette is driven by quickOpen with a '>' prefix and acceptSelectedQuickOpenItem, which also answers the input boxes the command opens"

key-files:
  created: []
  modified:
    - src/team/identity.ts
    - src/team/enable.ts
    - src/team/eventLog.ts
    - src/services/team/teamSession.ts
    - src/services/team/teamCommands.ts
    - src/extension.ts
    - src/test/helpers/teamCanary.ts
    - src/test/helpers/teamHarness.ts
    - src/test/helpers/teamEvents.ts
    - src/test/helpers/teamAppendChild.ts
    - src/test/teamIdentity.test.ts
    - src/test/teamEnable.test.ts
    - src/test/teamLog.test.ts
    - src/test/teamSession.test.ts
    - src/test/teamCommands.test.ts
    - src/test/teamMirrorIsolation.test.ts
    - src/test/e2e/run.ts
    - src/test/e2e/suite.ts

key-decisions:
  - "The identity module keeps its team-era error texts for an unreadable or non-Ed25519 stored value ('The stored team device key ...') because the plan keeps those checks as they are; only the 'already has a key' refusal was reworded"
  - "A session whose identity is not in the roster says READ_ONLY_TEXT once (guarded by state.deviceIndex.size > 0 so an empty or unread roster never triggers it), in the same words as a computer with no identity"
  - "deviceKeyEvidence computes its private-rendering digests inside teamCommands.ts rather than importing the test helper; the unit test pins that the helper's deviceKeyFormDigests equals the seam's result for the same stored secret"
  - "The e2e git-object scanner control plants a made-up look-alike value as an unreachable blob in the e2e's own bare remote, so no third temporary folder and no extra git location is used"

patterns-established:
  - "createOwner and the test helpers take no team id for the key; each actor still gets its own MemorySecrets and so its own key"

requirements-completed: [TMR-05, TMR-02, TMR-03]

duration: not recorded
completed: 2026-11-15
status: complete
---

# Phase 69 Plan 07: One identity per person, the D-22 rollback rule and the Team Mode e2e Summary

**Team Mode now uses one Ed25519 identity per person per install (`nearAi.identity.deviceKey`, created once under `identity-create.lock`), a failed Enable forgets a key only when that call created it, and a real VS Code window proves Enable Team Mode (behind the preview, from the Command Palette) and Verify Team Log work end to end without the private key ever reaching the test window.**

## Accomplishments

- Task 1 (tracer): `identity.ts` replaces the per-team name with `DEVICE_KEY_SECRET`, drops `teamId` from `DeviceIdentity`, and adds `IDENTITY_DIR_NAME`, `identityDir`, `IDENTITY_CREATE_LOCK_FILE`, `loadOrCreateDeviceIdentity` (folder mode 0o700, then check, create, store, read back and compare fingerprints inside `withFileLock`) and `forgetCreatedDeviceIdentity`. The module still imports no `vscode`. Enable calls `loadOrCreateDeviceIdentity` and keeps `created`; the session loads with `loadDeviceIdentity(deps.secrets)` and never creates at start. The four test helpers and `teamMirrorIsolation.test.ts` call the new shapes; each actor still gets its own `MemorySecrets`.
- Task 2: `rollback` calls `forgetCreatedDeviceIdentity` only when `created` is true (the WR-01 unconfirmed-push path is unchanged). New tests, named as in the plan: "an identity that existed before a failed Enable is untouched" for three failure paths (failed push, push that throws before the remote, coordination branch that appears during the push), the mirror image "a failed Enable forgets the key it created and no other" for the same three, a successful Enable that reuses an existing identity, `forgetCreatedDeviceIdentity` with a foreign fingerprint, a held `identity-create.lock` that makes `loadOrCreateDeviceIdentity` wait and then return the other window's key, and three creations racing in one process ending with one key. `NO_DEVICE_KEY_MESSAGE`, `READ_ONLY_TEXT` and the key-unreadable line use the plain per-person sentence with no "for this team"; a session whose identity is not in the roster now says it once. The read-only session test asserts `stub.configUpdates` is empty after start and sync.
- Task 3: Verify Team Log resolves to its `VerifyReport` (`guarded` is generic; `import type` keeps solo activation free of team modules). `teamModeTestApi(context, handle)` exposes `ready`, `session()` and `deviceKeyEvidence()`, built only inside the `NEAR_AI_E2E === '1'` return of `activate`. Evidence is the fingerprint, the public key as base64, base64url and hex, the SHA-256 of the stored private key text, and SHA-256 plus length of each private rendering. `teamCanary.ts` gains `deviceKeyFormDigests`, `scanFilesForDigests` and `scanGitObjectsForDigests` (windows over every base64/base64url/hex run; objects read uncompressed through `git cat-file --batch`). `run.ts` writes an isolated git config for the project scenario (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`, `git.enabled` false) and passes `--password-store=basic` and `NEAR_AI_E2E_USER_DATA` in both scenarios. `suite.ts` adds `runFromPalette`, the four project tests and the plain test.

## Which route started Enable, and A3

Enable started from the Command Palette (`workbench.action.quickOpen` with `>NEAR AI: Enable Team Mode`, then `acceptSelectedQuickOpenItem` every 400 ms), and its three input boxes were answered by the same accept with their defaults, so neither fallback was used: the palette control passed (File: New Untitled Text File added a tab), the preview-off probe started nothing, and with `nearAi.team.preview` set true at the Global target the same route wrote `team.json`. Research assumption A3 (a setting-based `when` clause shows the command once the setting is on) is confirmed by the palette test. No `teamPromptTap` seam exists and `package.json` and `teamManifest.test.ts` are untouched.

## e2e pass lines

From `npm run test:e2e` (exit 0, no `✖` line in either scenario):

```
✔ [project] Enable Team Mode is in the Command Palette only with the preview on (D-13, D-24, A3)
✔ [project] Enable Team Mode answers its prompts with their defaults and commits only team.json (D-30)
✔ [project] Verify Team Log reports the owner and no rejected events (D-30, D-31)
✔ [project] no rendering of the new device key or the owner email reaches settings, team.json or the remote (TMR-03)
✔ [plain] a folder without team.json starts no team session and creates no identity (D-14, D-30)
```

All 15 project tests and all 5 plain tests passed.

## Test evidence

Each run under `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c '...'` after a clean `npx tsc -p tsconfig.json` (which also serves as the lint, `tsc --noEmit`). `free -g` was checked before the e2e.

| Command (after `npx tsc -p tsconfig.json &&`) | Tests | Pass | Fail |
|-----------------------------------------------|-------|------|------|
| Task 1: `node --test --test-concurrency=1 dist/test/teamIdentity.test.js dist/test/teamEnable.test.js` | 33 | 33 | 0 |
| Task 2: `node --test --test-concurrency=2 dist/test/teamEnable.test.js dist/test/teamIdentity.test.js dist/test/teamLog.test.js dist/test/teamSession.test.js dist/test/teamCommands.test.js dist/test/teamSoloParity.test.js` | 108 | 108 | 0 |
| Task 3: `node --test --test-concurrency=2 dist/test/teamCommands.test.js dist/test/teamSoloParity.test.js dist/test/teamManifest.test.js dist/test/profileIndex.test.js dist/test/codePushLater.test.js dist/test/participantRecord.test.js` | 70 | 70 | 0 |
| Extra, after the last code change: `node --test --test-concurrency=2 dist/test/team*.test.js dist/test/responsivePanels.test.js` | 546 | 546 | 0 |
| e2e: `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env -u WAYLAND_DISPLAY -u WAYLAND_SOCKET -u DISPLAY -u XDG_SESSION_TYPE -u GDK_BACKEND -u QT_QPA_PLATFORM -u ELECTRON_OZONE_PLATFORM_HINT NODE_OPTIONS=--max-old-space-size=1536 npm run test:e2e` | 20 | 20 | 0 |

0 cancelled, 0 skipped in every node run. The full root `npm test` is the plan 08 gate and was not run here.

Acceptance checks: `grep -c "nearAi.identity.deviceKey" src/team/identity.ts` prints 1 and the per-team name prints 0 (and `grep -rn "nearAi.team.deviceKey" src` prints nothing); `grep -rn "identity\.teamId" src` prints nothing; `IDENTITY_CREATE_LOCK_FILE` appears 3 times in `identity.ts`; `grep -c "for this team"` prints 0 for `eventLog.ts` and `teamSession.ts`; `stub.configUpdates, []` appears 2 times in `teamCommands.test.ts` and 2 in `teamSession.test.ts`; `teamModeTestApi(` appears once in `src/extension.ts`, on the `NEAR_AI_E2E === '1'` line, and `registerTeamMode(context)` once; `grep -rc "storedDeviceKey" src` prints no non-zero count; `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM` are each in `run.ts`; the verifyLog title prints `Verify Team Log`.

## Task Commits

1. Task 1: `7c5c8be` feat(team): one device identity per person per install, created on first need under a lock (D-06, D-07)
2. Task 2: `79da0e2` fix(team): a failed Enable never deletes an identity it did not create (D-22)
3. Task 3: `8ce9b38` test(team): Enable Team Mode and Verify Team Log in a real window, behind the preview (D-30)

## Deviations from Plan

### Auto-fixed Issues

None.

### Notes (not deviations)

- Tests for Task 3's unit cases were written alongside the product code rather than strictly red first; they were not observed failing before the handler change.
- The plan's e2e verify line was replaced by the owner-rules e2e line (display and Wayland variables stripped), as the owner rules direct.
- The `scanFilesForDigests` result for a single-file root reads `planted.txt/planted.txt: label`, matching `scanFiles`.
- `createOwner(_teamId?)` keeps an unused optional parameter so its many callers did not need to change; the key no longer depends on it.
- Commit trailer: the plan names `Claude Opus 5.5`; the commits carry `Claude Sonnet 5.5`, the model that actually ran, as the owner rules require.
- The e2e writes a made-up look-alike value as an unreachable blob into its own temporary bare remote and a control file into its own temporary user-data folder; both are in the e2e's two temporary folders (the user-data folder is a third temporary folder, but git is never run there).

## Auth gates

None.

## Known Stubs

None.

## Threat Flags

None beyond the register. T-69-15 to T-69-17 are covered by tests in Tasks 1 and 2, T-69-45 by the digest-only seam, its serialisation unit case and the source test pinning the `NEAR_AI_E2E` line, T-69-46 by the isolated git config, `git.enabled` false and `--password-store=basic`, and T-69-47 does not apply (no prompt seam). No package was added (T-69-SC).

## Self-Check: PASSED

- Modified files exist: `src/team/identity.ts`, `src/services/team/teamCommands.ts`, `src/test/e2e/suite.ts`, `src/test/e2e/run.ts`, `src/test/helpers/teamCanary.ts`.
- Commits `7c5c8be`, `79da0e2` and `8ce9b38` are ancestors of HEAD; `git rev-list --count` from the plan's starting commit to HEAD was 3 before this summary.
- `git status --porcelain` showed no unexpected files before this summary was written.
