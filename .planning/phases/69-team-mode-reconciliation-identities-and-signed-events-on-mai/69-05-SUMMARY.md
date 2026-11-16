---
phase: 69-team-mode-reconciliation-identities-and-signed-events-on-mai
plan: 05
subsystem: team-mode
tags: [team-mode, vscode, activation, scheduler, session, status-bar, solo-parity, port]

requires:
  - phase: 69-04
    provides: team mirror lock, reserved sync refs and the isolation test on main
provides:
  - "registerTeamMode(context) wired into main's activation between registerSpendTracking and registerSpendingLimits"
  - "Commands nearAi.team.enable (Enable Team Mode) and nearAi.team.verifyLog (Verify Team Log) and the setting nearAi.team.pollSeconds in the manifest"
  - "SyncScheduler, team status bar, TeamSession and the team commands, ported from Phase 60, with the vscode test stub"
  - "sameFailureKey: a remote that stays down is written to the channel once whatever connect time git reports (fix 9e49bc5 without its Phase 61 hunk)"
affects: [69-06, 69-07, 69-08, 69-10]

actuals:
  tokens: 38600
  tasks: 2
  commits: 2
plan_head_before: e970e46fe48000ccd9c0f0e0d35fd0630a7bb5a0
plan_head_after: 8a3091c6fb5abc331399286e14948531af0054ee

tech-stack:
  added: []
  patterns:
    - "Activation in a project without team.json does one fs.stat and loads no team module; every team module is a dynamic import behind that stat"
    - "Failure dedupe keys leave out time and byte figures (sameFailureKey), while the written line stays as git gave it"

key-files:
  created:
    - src/team/syncScheduler.ts
    - src/services/team/teamStatusBar.ts
    - src/services/team/teamSession.ts
    - src/services/team/teamCommands.ts
    - src/test/helpers/vscodeStub.ts
    - src/test/teamSoloParity.test.ts
    - src/test/teamScheduler.test.ts
    - src/test/teamSession.test.ts
    - src/test/teamCommands.test.ts
  modified:
    - src/extension.ts
    - package.json

key-decisions:
  - "Six files and three tests are copied byte for byte from ae5e9e1; extension.ts and package.json are edited by hand with exactly the Phase 60 diff (2 added lines in extension.ts, two commands and one setting in the manifest)"
  - "35ac2b9 and then 9e49bc5 are applied with patch -p1; the status dedupe hunk is edited by hand and the Phase 61 key-install hunk is skipped, never re-created"
  - "The 35ac2b9 test asserts the Phase 62 status bar text with icon prefixes; on main's Phase 60 status bar it asserts the same states without the icons"

patterns-established:
  - "The vscode stub records every workspace.getConfiguration(...).update(...) in configUpdates and the Enable and SEC-01 canary tests assert it stays empty"

requirements-completed: [TMR-02, TMR-03]

duration: 20min
completed: 2026-11-15
status: complete
---

# Phase 69 Plan 05: Team Mode in the editor, solo parity and the stays-down dedupe fix Summary

**Team Mode's scheduler, status bar, session and commands run on main, activation calls `registerTeamMode(context)`, a project without `team.json` costs exactly one `fs.stat`, and a remote that stays down is written to the channel once whatever connect time git reports.**

## Performance

- **Duration:** about 20 min
- **Tasks:** 2 of 2
- **Files created:** 9, modified: 2 (`src/extension.ts` +2 lines, `package.json` +20 lines; nothing else that existed on main)

## Accomplishments

- Task 1 (tracer): the six paths came across with `git show ae5e9e1:<path>`; `git diff --exit-code ae5e9e1 HEAD` over them is empty. In `src/extension.ts` the import of `registerTeamMode` follows the `registerSpendTracking` import and `registerTeamMode(context);` sits between `registerSpendTracking(context, auth);` and `registerSpendingLimits(context, auth);` (numstat `2 0`). In `package.json` the two commands (`$(organization)`, `$(verified)`, category NEAR AI) end `contributes.commands` and `nearAi.team.pollSeconds` (number, default 15, 5 to 3600, application scope) ends `contributes.configuration.properties`. teamSoloParity: solo activation makes one `fs.stat` with no timer, channel, status item, storage write or team module; no folder touches nothing; Verify Team Log in a solo project only explains; a team project loads the session lazily, shows `Team: <name>` and stops its timer when disposed.
- Task 2: the three tests came across from ae5e9e1 and passed as ported. Then 35ac2b9 (the test) and 9e49bc5 (`sameFailureKey`, the issue key, the status key and its test) were applied with `patch -p1`. In `teamSession.ts` two hunks applied with offsets, the status dedupe key needed the one-line manual edit, and the fourth hunk (the team key install warning, Phase 61 code that does not exist on main) was skipped. The `.rej` and `.orig` files were removed. With `sameFailureKey` forced to return its input the new test and the `sameFailureKey` unit test both fail, so the test pins the fix.
- Settings half of the TMR-03 canary: `stub.configUpdates` empty is asserted in two teamCommands tests, "Enable asks for team name, owner name and email with defaults, creates team.json, starts the session and offers Push and Verify Team Log" (Enable) and "SEC-01 canary: after Enable and Verify no secret or device key reaches the UI, settings, storage, team.json or any git object". `grep -cF "stub.configUpdates, []" src/test/teamCommands.test.ts` is 2 and `grep -c "configUpdates.push" src/test/helpers/vscodeStub.ts` is 1. Both pass.

## Test evidence

Each run under the cap wrapper after a clean `npx tsc -p tsconfig.json`.

Unchanged-port evidence: adapters (Task 2 first run, before the fix, the four files together with `--test-concurrency=2`): 64 tests, 64 pass, 0 fail, 0 cancelled. The T2 flake ("3 !== 1") did not show in that run.

| Test file (final state, run alone) | Tests | Pass | Fail |
|------------------------------------|-------|------|------|
| teamScheduler | 23 | 23 | 0 |
| teamSession (21 as ported plus the 2 new tests) | 23 | 23 | 0 |
| teamCommands | 14 | 14 | 0 |
| teamSoloParity | 6 | 6 | 0 |

The four together (plan verify command): 66 tests, 66 pass, 0 fail, 0 cancelled, 0 skipped.

## Commands run

All as `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c '...'`, one heavy run at a time:

- Task 1: `npx tsc -p tsconfig.json && node --test dist/test/teamSoloParity.test.js` (6 pass).
- Task 2, as ported: `npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/teamScheduler.test.js dist/test/teamSession.test.js dist/test/teamCommands.test.js dist/test/teamSoloParity.test.js` (64 pass).
- Task 2, after the fix (the plan's verify command): same line (66 pass).
- The lint script is `tsc -p tsconfig.json --noEmit`, covered by the builds above. The e2e suite is compiled by tsc but not run here (plan 07 and the plan 08 gate).

## Task Commits

1. Task 1: `9ee59f2` feat(team): Team Mode commands and session wired into activation, solo projects unchanged (Phase 60, ae5e9e1)
2. Task 2: `8a3091c` fix(team): a remote that stays down is written to the channel once whatever connect time git reports (from 9e49bc5, 35ac2b9)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The 35ac2b9 test asserts the Phase 62 status bar text**
- **Found during:** Task 2 (first run after the patches)
- **Issue:** the new test expected `$(warning) Team sync paused: remote unreachable` and `$(organization) Team: <name>` in the status item. The ported status bar (Phase 60) shows the same states without icon prefixes, as every other test in the file asserts (`lastItem().text` is `PAUSED_UNREACHABLE_TEXT` and `Team: <name>`).
- **Fix:** the two assertions in that one test now use `PAUSED_UNREACHABLE_TEXT` and `` `Team: ${TEAM_NAME}` ``, the same states in main's text form. No assertion was removed or loosened, and the other test assertions (written once, first reason as git gave it, recovery line) are as in 35ac2b9.
- **Files modified:** `src/test/teamSession.test.ts`
- **Commit:** `8a3091c`

### Other

- Commit trailer: the plan names `Claude Opus 5.5`; the commits carry `Claude Sonnet 5.5`, the model that actually ran, as the owner rules require.
- Actuals: chars/4 over `git diff` of src and package.json from the plan base is 38,600 tokens against the plan's 70,036 estimate (the work is ports).

## Auth gates

None.

## Known Stubs

None.

## Threat Flags

None. T-69-11 (solo activation) is covered by teamSoloParity, T-69-12 (status and channel text) by the ported `safeReason` and `redactGitMessage` plus `sameFailureKey`, T-69-44 (settings) by the two `configUpdates` assertions, and no package was added (T-69-SC).

## Self-Check: PASSED

- Created files exist: `src/team/syncScheduler.ts`, `src/services/team/teamStatusBar.ts`, `src/services/team/teamSession.ts`, `src/services/team/teamCommands.ts`, `src/test/helpers/vscodeStub.ts`, `src/test/teamSoloParity.test.ts`, `src/test/teamScheduler.test.ts`, `src/test/teamSession.test.ts`, `src/test/teamCommands.test.ts`.
- `grep -c "export function sameFailureKey"` is 1 and `grep -c "sameFailureKey(status.reason"` is 1 in `teamSession.ts`; the new test name appears once in `teamSession.test.ts`; `git status --porcelain` lists no `.rej` or `.orig`.
- `package.json` prints `nearAi.team.enable=Enable Team Mode,nearAi.team.verifyLog=Verify Team Log` and `number 15 5 3600 application`.
- Commits `9ee59f2` and `8a3091c` are ancestors of HEAD.
