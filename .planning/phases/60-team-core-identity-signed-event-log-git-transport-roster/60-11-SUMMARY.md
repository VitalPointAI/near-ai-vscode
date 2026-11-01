---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
plan: 11
subsystem: team
tags: [activation, solo-parity, commands, enable-team-mode, verify-team-log, package-manifest, canary, phase-gate]

requires:
  - phase: 60-08
    provides: "enableTeamMode, checkEnablePreconditions, enableDefaults, pushCodeBranch"
  - phase: 60-09
    provides: "createVscodeTeamSession, TeamSession.verifyLog, status bar pointing at nearAi.team.verifyLog, vscodeStub helper"
  - phase: 60-10
    provides: "cross-process concurrency proof of the transport"
provides:
  - "registerTeamMode: both commands registered synchronously, one fs.stat in solo projects, lazy session start in team projects"
  - "NEAR AI: Enable Team Mode flow with defaults, progress, Push and Verify Team Log offers, quiet cancel and plain-language failures"
  - "package.json contributions: nearAi.team.enable, nearAi.team.verifyLog, nearAi.team.pollSeconds (application scope, 5..3600, default 15)"
  - "Phase 60 gate evidence: lint, full suite, team suites, e2e and verify:release green; final validation map"
affects: [61]

actuals:
  tokens: 13267
  tasks: 3
  commits: 5
plan_head_before: 1c59083599b715810199b0cee499428b2afebf9a
plan_head_after: 1d0917f51fc2a73a3d7b047b99a88bf4bef75af5

tech-stack:
  added: []
  patterns:
    - "Solo-safe activation: static imports are vscode, Node built-ins and types only; every team module loads by dynamic import after team.json is found or inside a command"
    - "Output channel created on first use through a lazy getter, so a solo project never gets one"
    - "Every command is wrapped so a failure becomes a channel line plus a message, never a rejected promise"
    - "Solo parity is proven by spying on fs/promises and global timers, and by checking require.cache for team modules"

key-files:
  created:
    - src/services/team/teamCommands.ts
    - src/test/teamSoloParity.test.ts
    - src/test/teamManifest.test.ts
    - src/test/teamCommands.test.ts
  modified:
    - src/extension.ts
    - package.json
    - src/test/helpers/vscodeStub.ts
    - .planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-VALIDATION.md

key-decisions:
  - "A missing team.json and a file where the .planning folder should be (ENOENT and ENOTDIR) both mean solo; any other stat error goes to the channel and resolves error"
  - "Enable checks for an existing team before asking any question, so a second run names the team and asks nothing"
  - "Push is offered only when the repository is on a branch; a detached HEAD gets only Verify Team Log"
  - "A commit-failed result still starts the session, because the team already exists on the remote and the key is kept"
  - "The stub records notification buttons in a parallel notificationActions array so the 60-09 session tests keep their exact notification shape"

requirements-completed: [TEAM-01, SEC-01]

coverage:
  - id: D1
    description: "Enable Team Mode and Verify Team Log are contributed and registered in every project, and nearAi.team.pollSeconds is contributed as an application-scoped number 5..3600 with default 15"
    requirement: TEAM-01
    verification:
      - kind: unit
        ref: "src/test/teamManifest.test.ts (5 tests via node --test dist/test/teamManifest.test.js)"
        status: pass
      - kind: e2e
        ref: "npm run test:e2e: [project] activates in a project set up with the extension and registers every contributed command"
        status: pass
    human_judgment: false
  - id: D2
    description: "A solo project does one fs.stat and nothing else: no timers, storage, status bar item, output channel or team core module, and a team command only explains how to enable Team Mode"
    requirement: TEAM-01
    verification:
      - kind: unit
        ref: "src/test/teamSoloParity.test.ts#solo project: activation makes one fs.stat and no timers, channel, status item, storage or team module"
        status: pass
      - kind: unit
        ref: "src/test/teamSoloParity.test.ts#Verify Team Log in a solo project only explains how to turn Team Mode on"
        status: pass
      - kind: e2e
        ref: "npm run test:e2e: [plain] does not activate on startup in a folder not set up with the extension"
        status: pass
    human_judgment: false
  - id: D3
    description: "A team project lazily loads the session, shows Team: <name> and clears its poll timer when the context is disposed"
    requirement: TEAM-01
    verification:
      - kind: integration
        ref: "src/test/teamSoloParity.test.ts#a team project loads the session lazily, shows Team: <name> and stops its poll timer when disposed"
        status: pass
    human_judgment: false
  - id: D4
    description: "Enable asks for team name, owner name and email with folder and git defaults, creates team.json, starts the session, pushes the code branch only when Push is clicked, returns quietly on cancel and reports the existing team"
    requirement: TEAM-01
    verification:
      - kind: integration
        ref: "src/test/teamCommands.test.ts (14 tests via node --test dist/test/teamCommands.test.js)"
        status: pass
    human_judgment: false
  - id: D5
    description: "No access key, reporting token, refresh token, remote password, plain email or device key rendering reaches a channel line, notification, status bar text, tooltip, storage file, team.json or any git object, and settings are never written"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "src/test/teamCommands.test.ts#SEC-01 canary: after Enable and Verify no secret or device key reaches the UI, settings, storage, team.json or any git object"
        status: pass
      - kind: integration
        ref: "src/test/teamCommands.test.ts#a secret typed as the team name is refused without repeating it anywhere"
        status: pass
    human_judgment: false
  - id: D6
    description: "Phase 60 gate: lint, the full suite with the existing tests unchanged, team suites, e2e and verify:release all pass and the solo-parity diffs against the merge base are clean"
    requirement: TEAM-01
    verification:
      - kind: other
        ref: "npm run check; node --test dist/test/team*.test.js; npm run test:e2e; npm run verify:release; git diff --diff-filter=MD against the merge base"
        status: pass
    human_judgment: false
  - id: D7
    description: "Wording and flow of the Enable questions, confirmation message and Push and Verify buttons in a real editor window"
    requirement: TEAM-01
    verification: []
    human_judgment: true
    rationale: "The look and feel of the input boxes and notification buttons in a real VS Code window is a UX judgment that the vscode stub cannot assert"

duration: about 10 min
completed: 2026-11-01
status: complete
---

# Phase 60 Plan 11: Team Mode commands, solo-safe activation and phase gate Summary

**registerTeamMode wires Enable Team Mode and Verify Team Log into the extension with a single fs.stat in solo projects, lazy session start in team projects, a UI canary scan, and the Phase 60 gate (lint, 918-test suite, e2e, verify:release) green**

## Performance

- **Duration:** about 10 min (start time was not recorded precisely)
- **Started:** about 2026-11-01T13:37:00Z
- **Completed:** 2026-11-01T13:47:00Z
- **Tasks:** 3
- **Files modified:** 8 (4 new, 4 changed)

## Accomplishments
- `registerTeamMode(context)` registers `nearAi.team.enable` and `nearAi.team.verifyLog` synchronously and nothing else. Asynchronously it runs one `fs.stat` on `.planning/.near-ai/team.json`. No file means solo: no timer, output channel, status bar item, storage or team module (proved by spies on `fs/promises` and the global timers, and by checking `require.cache`). A file means it dynamically imports the team modules and starts the session, which shows `Team: <name>` and polls.
- Enable runs the D-20 flow: preconditions, an existing-team check (D-22) before any question, three input boxes with folder and git defaults, `enableTeamMode` under a progress notification, then `Team Mode is on for <name>. team.json is committed on <branch>. Push it when you are ready so teammates can see the team.` with Push and Verify Team Log. The code branch moves only when Push is clicked; the command never writes settings.
- Cancelling any input box returns quietly. Failures show as errors or warnings in plain language and the same text goes to the NEAR AI Team channel; a failing `commit-msg` hook gives the exact manual command.
- `package.json` contributes both commands (icons `$(organization)` and `$(verified)`) and `nearAi.team.pollSeconds` (number, default 15, minimum 5, maximum 3600, application scope). `src/extension.ts` gains one import and one call; `src/services/chat.ts` is untouched.
- The SEC-01 canary test seeds an access key, reporting token, refresh token, remote password and plain email, runs Enable and Verify Team Log, and finds none of them or any device key rendering in the channel, notifications, status bar, storage, `team.json`, mirror, remote or project git objects.
- The Phase 60 gate passed (see Verification below) and `60-VALIDATION.md` now names the final test files, all green, with `nyquist_compliant: true`.

## Task Commits

1. **Task 1: registerTeamMode, extension wiring, manifest** - `8a2ba79` (chore, package.json), `ebf2814` (feat, teamCommands.ts and extension.ts), `024de80` (test, solo parity and manifest tests plus the stub additions)
2. **Task 2: Enable and Verify flows with UI canary scan** - `16c05d2` (test)
3. **Task 3: Phase gate and validation map** - `1d0917f` (docs)

**Plan metadata:** recorded in the following docs commits.

## Files Created/Modified
- `src/services/team/teamCommands.ts` - `registerTeamMode`, command handlers, lazy session start, Enable flow
- `src/extension.ts` - one import and one `registerTeamMode(context);` call
- `package.json` - two commands and the `nearAi.team.pollSeconds` setting
- `src/test/teamSoloParity.test.ts` - D-24 proof (6 tests)
- `src/test/teamManifest.test.ts` - manifest, registration and dependency checks (5 tests)
- `src/test/teamCommands.test.ts` - command flows and canary scan (14 tests)
- `src/test/helpers/vscodeStub.ts` - `workspaceFolders`, `inputRequests`, `notificationActions`, `createFakeContext`
- `60-VALIDATION.md` - final map, gate results, sign-off

## Verification (Phase 60 gate)
- `npm run lint`: exit 0. `npm run check`: 918 tests, 910 pass, 0 fail, 8 skipped (existing live tests).
- `node --test dist/test/team*.test.js`: 348 tests, 0 fail, on Node 24.22.2. **Node 22 floor check: not run** (this host has only Node 24 and no `/usr/bin/node`); recorded in 60-VALIDATION.md as a manual item.
- `npm run test:e2e`: 7 project scenarios and 2 plain scenarios pass, including the one asserting every contributed command has a handler. Run as `env -u ELECTRON_RUN_AS_NODE DISPLAY=:0 node dist/test/e2e/run.js` because there is no `xvfb-run`; the VS Code 1.144.0 test build is in the worktree's own `.vscode-test` (gitignored).
- `npm run verify:release`: 227 entries; `dist/team`, `dist/domain/team` and `dist/services/team` packaged; no `dist/test`.
- Against the merge base with main: no existing file under `src/test`, and not `src/services/chat.ts` or `src/domain/redaction.ts`, is modified or deleted; dependency maps are equal; `src/extension.ts` has exactly 2 added lines; no `vscode` import under `src/domain/team` or `src/team`.

## Decisions Made
See `key-decisions` above. Rationale: treating ENOTDIR as solo avoids a spurious error when `.planning` is a file; checking for an existing team first avoids three questions that end in "already exists"; starting the session after a commit-failed Enable keeps a team that exists on the remote usable.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] ENOTDIR treated as solo, not as an error**
- **Found during:** Task 1
- **Issue:** The plan treats only ENOENT as solo. A project where `.planning` is a regular file makes `fs.stat` fail with ENOTDIR, which would write an error line and create the channel in a project that has no team.
- **Fix:** ENOENT and ENOTDIR both resolve solo; every other stat error is reported and resolves error.
- **Files modified:** `src/services/team/teamCommands.ts`
- **Verification:** solo-parity tests; the code path is shared with the Verify handler.
- **Committed in:** `ebf2814`

**2. [Rule 3 - Blocking] Stub notification shape kept; button labels recorded separately**
- **Found during:** Task 2
- **Issue:** Recording button labels inside each `notifications` entry broke two existing 60-09 `deepEqual` assertions in `teamSession.test.ts`.
- **Fix:** Reverted the entry shape and added a parallel `notificationActions` array in `vscodeStub.ts`. `teamSession.test.ts` is unchanged.
- **Files modified:** `src/test/helpers/vscodeStub.ts`, the three new test files
- **Verification:** `teamSession.test.js` 13 of 13 pass.
- **Committed in:** `16c05d2`

### Plan variances (not rule-driven)

- **Enable handler landed with Task 1.** The plan completes the Enable handler in Task 2, but both live in one file, so `teamCommands.ts` was committed once with the full handler (`ebf2814`) and Task 2 added the tests and stub support (`16c05d2`). All Task 2 behavior is covered by tests that pass.
- **Existing-team message.** The Enable flow checks `readTeamFile` before asking questions and shows `This project already has a team: <name>. Joining an existing team arrives with team invitations.` It names the team but not its id, unlike the text from `enableTeamMode`, which is still the fallback if the file appears between the check and the run.
- **Gate commands.** The plan's verify chain uses `xvfb-run` and `/usr/bin/node`; neither exists here, so `DISPLAY=:0` and Node 24 were used (see Verification).
- **Manifest dependency test** skips (with a stated reason) only when the checkout has no merge base with `main`; it ran and passed here.

---

**Total deviations:** 2 auto-fixed (1 missing critical, 1 blocking), 4 plan variances.
**Impact on plan:** No scope creep; every plan acceptance criterion and gate command passed except the Node 22 run, which could not be executed on this host.

## Issues Encountered
- The first e2e attempt did not start because a `git check-ignore` guard in my own command chain returned non-zero for a directory that did not exist yet; the rerun passed. No product code was involved.

## Known Stubs

None.

## Threat Flags

None. No new network endpoints, auth paths or file access beyond the plan's threat model (T-60-47 to T-60-50 are covered: no configuration writes, one stat in solo projects, Push only on click, application-scoped setting).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 60 is complete from the plan side: all 11 plans have summaries once this one is committed. The phase verifier still needs to run, and the Node 22 team run and a real hosted-remote Enable (manual item in 60-VALIDATION.md) remain open.
- Phase 61 can add Join next to Enable; the D-22 message already says joining arrives with team invitations. `TeamModeHandle.session()` gives later plans access to the running session.
- The session still exposes no `append`; plans that write roster events need the signing `TeamLog` (carry-forward from 60-09).

## Self-Check: PASSED

- Files present: `src/services/team/teamCommands.ts`, `src/test/teamCommands.test.ts`, `src/test/teamManifest.test.ts`, `src/test/teamSoloParity.test.ts`.
- Commits present on this branch: `8a2ba79`, `ebf2814`, `024de80`, `16c05d2`, `1d0917f`.
- Acceptance criteria re-run: `registerTeamMode(context);` count 1 and 2 added lines in `src/extension.ts`; `src/services/chat.ts` unchanged; one match each for the two command ids and the `pollSeconds` setting; no static import from `../../team/` in `teamCommands.ts`; no em-dash in `teamCommands.ts`; `withProgress` and `pushCodeBranch` present; no `getConfiguration`; no empty catch or discarded promise in `src/services/team`; `nyquist_compliant: true` set.

---
*Phase: 60-team-core-identity-signed-event-log-git-transport-roster*
*Completed: 2026-11-01*
