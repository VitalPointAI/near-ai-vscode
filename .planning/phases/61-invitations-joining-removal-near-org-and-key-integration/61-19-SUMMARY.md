---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 19
subsystem: team-enable-and-share
tags: [gap-closure, G-61-1, G-61-2, G-61-3, prompts-seam, online-home, share, tdd]
status: complete

requires:
  - phase: 61-16
    provides: "checkOnlineHome, planShare, shareTeamSetup (src/team/projectHome.ts)"
  - phase: 61-24
    provides: "plainWords scanner that discovers every file in src/services/team (new text here is scanned)"
provides:
  - "src/services/team/teamPrompts.ts: teamPrompts (input, pick, message), promptTap, PromptRecord, PromptStep; scripted answers only with NEAR_AI_E2E exactly '1'"
  - "src/services/team/shareFlow.ts: ensureTeamSetupShared, ShareReason, ShareOutcome, ShareDeps, ShareFlowInput, SHARE_TEXT"
  - "teamCommands.ts: SHARE_COMMAND (nearAi.team.share), TeamModeOptions.connectNearAi, TeamModeHandle.onDidChange, CONNECT_NEAR_AI_ACTION, NOT_CONNECTED_TEXT, STILL_NOT_CONNECTED_TEXT, TURN_ON_ANYWAY_ACTION, NOT_NOW_ACTION, LOCAL_ONLY_TEXT/DETAIL, NOT_SHAREABLE_TEXT/DETAIL, new SOLO_TEXT"
  - "package.json: nearAi.team.share 'Share Team Setup' (NEAR AI, $(cloud-upload))"
affects: [61-20, 61-21, 61-22, 61-23]

plan_head_before: c2f529a400dc4b3912284c849fb0f44641a1a688
plan_head_after: 1d25cbfea37e33140c1b2e7b074283e34fac6911
actuals:
  tokens: 16932
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Every Team Mode prompt goes through teamPrompts; the e2e script is read only when NEAR_AI_E2E === '1' and promptTap.script is set (same gate as the board probe)"
    - "Share experience: plan under a 'Checking' progress, one modal confirmation worded by reason and plan, share under a 'Sharing' progress, fixed plain sentence per result, technical detail via appendLine only"
    - "TeamModeHandle.onDidChange is a plain listener set fired after start, restart, every Enable attempt and dispose"

key-files:
  created:
    - src/services/team/teamPrompts.ts
    - src/services/team/shareFlow.ts
    - src/test/teamPrompts.test.ts
    - src/test/teamShareFlow.test.ts
  modified:
    - src/services/team/teamCommands.ts
    - src/extension.ts
    - package.json
    - src/test/teamCommands.test.ts
    - src/test/teamManifest.test.ts
    - src/test/teamSoloParity.test.ts
    - src/test/teamMemberCommands.test.ts

key-decisions:
  - "Enable's not-initialised precondition is handled before enableStopped: modal 'NEAR AI is not connected in this project yet. Connect it to turn on Team Mode.' with Connect NEAR AI; after the key setup the preconditions are checked once more; still missing gives 'NEAR AI was not connected, so Team Mode was not turned on and nothing was changed.' The channel line never names NEAR AI: Set Up"
  - "The online-home warning sentences (LOCAL_ONLY_TEXT, NOT_SHAREABLE_TEXT and their details) live in teamCommands.ts and shareFlow.ts imports them, so Enable and Share Team Setup use the same words; shareFlow is loaded only by dynamic import, so the solo rule holds"
  - "Enable offers Share with my team only when the home is shareable and HEAD is on a branch; Turn on anyway ends with 'Team Mode is on for <team>, for you only until the project is online where teammates can reach it.' and only Check the team"
  - "Share with my team runs vscode.commands.executeCommand('nearAi.team.share', { reason: 'enable' }); the command reads this computer's team.json and the integration branch from the session's policy"
  - "Consent is kept across Try again for fast-forward and setup-only plans; a plan that turns into a first upload is asked again because it sends the whole project"
  - "Already online: reason command or enable says so, invite and link stay silent; declined always says 'Nothing was shared.'"
  - "teamPrompts.js is allowlisted at solo activation (it requires only vscode, checked by a new test); allowlisting was pulled into Task 1 because the static import lands there"

patterns-established:
  - "Online-home warning: one modal, plain text plus what to do in the detail, Turn on anyway / Not now in Enable and Show details in the share flow; git steps only in appendLine"

requirements-completed: [TEAM-01, TEAM-02]

coverage:
  - id: D1
    description: "teamPrompts delegates every input, pick and message to VS Code unless NEAR_AI_E2E is exactly '1' and a script is set; scripted answers, validateInput refusals, hidden password answers and unanswered modals are recorded"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/teamPrompts.test.ts#without NEAR_AI_E2E exactly 1 every prompt reaches VS Code even when a script is set, and nothing is recorded"
        status: pass
      - kind: unit
        ref: "src/test/teamPrompts.test.ts#the answer to a password input is recorded as hidden, never as the value"
        status: pass
    human_judgment: false
  - id: D2
    description: "Enable where NEAR AI is not connected offers Connect NEAR AI, runs the key setup and carries on, or says plainly nothing changed; dismiss changes nothing"
    requirement: TEAM-01
    verification:
      - kind: integration
        ref: "src/test/teamCommands.test.ts#Enable where NEAR AI is not connected offers Connect NEAR AI in one modal; once connected the questions follow and Team Mode turns on"
        status: pass
      - kind: integration
        ref: "src/test/teamCommands.test.ts#Enable where NEAR AI is still not connected after the key setup says so plainly, asks nothing and changes nothing"
        status: pass
    human_judgment: false
  - id: D3
    description: "Enable warns before any question when teammates cannot reach the project (local folder, password in the address), with Turn on anyway or Not now and the technical steps in the channel"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamCommands.test.ts#Enable with the project kept only on this computer warns first in a modal; Not now changes nothing and asks no question"
        status: pass
      - kind: integration
        ref: "src/test/teamCommands.test.ts#Enable with a password in the online home address warns with the not-shareable wording; the channel has the reason and never the address"
        status: pass
    human_judgment: false
  - id: D4
    description: "Share Team Setup shares exactly team.json after one confirmation, with plain results for already, declined, first upload, unreachable, refused and offline; Enable's Share with my team runs it"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamShareFlow.test.ts#tracer: Share Team Setup asks once, then the online main holds exactly this computer's team.json and the person reads that it is online"
        status: pass
      - kind: integration
        ref: "src/test/teamShareFlow.test.ts#declining the confirmation shares nothing, leaves the online home unchanged and says so"
        status: pass
      - kind: integration
        ref: "src/test/teamCommands.test.ts#choosing Share with my team runs Share Team Setup: one confirmation, then the online main holds this computer's team.json"
        status: pass
    human_judgment: false
  - id: D5
    description: "nearAi.team.share is contributed and registered (ten Team Mode commands), only the owner or a lead may run it, and solo activation loads only teamPrompts.js extra"
    requirement: TEAM-01
    verification:
      - kind: unit
        ref: "src/test/teamManifest.test.ts#package.json contributes Share Team Setup under the NEAR AI category with an icon (G-61-3)"
        status: pass
      - kind: integration
        ref: "src/test/teamSoloParity.test.ts#solo project: activation makes one fs.stat and no timers, channel, status item, storage or team module"
        status: pass
      - kind: integration
        ref: "src/test/teamMemberCommands.test.ts#a member without management rights is told who can share the team setup, and nothing is asked or shared"
        status: pass
    human_judgment: false
  - id: D6
    description: "The wording of the connect, warning and share modals reads plainly to a non-developer in a real window"
    verification: []
    human_judgment: true
    rationale: "Plain-language scans pass, but whether the modals read clearly in the real VS Code window is the owner's hands-on judgment (61-22 real-window test and UAT)"

duration: 19min
completed: 2026-11-03
---

# Phase 61 Plan 19: Connect NEAR AI in place, warn about the online home up front, and Share Team Setup Summary

**Turning on Team Mode now connects NEAR AI right there with one Connect NEAR AI modal, warns before any question when teammates cannot reach the project (Turn on anyway or Not now), and a new Share Team Setup command (also behind Enable's Share with my team) puts exactly team.json on the team's main branch after one plain confirmation. Every Team Mode prompt in teamCommands.ts now goes through one prompts module that the real-window test can script, only under NEAR_AI_E2E=1.**

## Performance

- Duration: about 19 minutes (2026-11-03T22:26:24Z to 2026-11-03T22:45:19Z)
- Tasks: 3 (one tracer, two auto), each RED then GREEN
- Files: 4 created, 7 modified (1051 insertions, 91 deletions)

## Accomplishments

- G-61-1: Enable in a folder without .planning/.near-ai shows one modal with Connect NEAR AI. Choosing it runs `connectNearAi`, which extension.ts binds to the same `configureApiKey(auth, sidebar)` as the chat's Set up. Enable then checks again and carries on with its questions, or says plainly that nothing was changed. Nobody is pointed at "NEAR AI: Set Up".
- G-61-2: before any question, Enable runs `checkOnlineHome`. For a local folder or a password in the address it shows one warning modal with what to do (put the project online, for example on GitHub, then invite people) and Turn on anyway / Not now. The git steps and cleanRepoUrl's reason go to the NEAR AI Team channel, never the address. Turn on anyway ends with Team Mode on "for you only until the project is online" and no share button.
- G-61-3: `ensureTeamSetupShared` plans, asks once (Share, or Share and continue before an invite, with the first-upload sentence when main is not online yet), shares with `shareTeamSetup` under a plain progress title, and maps every result to a SHARE_TEXT sentence. Refusals get Show details; offline and changed get Try again, which re-plans once per click. `nearAi.team.share` is contributed and registered, gated on the member.invite permission, and Enable's Share with my team runs it. `pushCodeBranch` is gone from teamCommands.ts (count 0, baseline 2).
- `TeamModeHandle.onDidChange` fires after start, restart (Link and Join), every Enable attempt and dispose, for 61-21's sidebar Team section.
- SOLO_TEXT and the open-folder sentence point at Turn on Team Mode in the Team section of the NEAR AI sidebar.

## Task Commits

1. Task 1 (tracer) RED: `c078d2c` test(61-19): expect scripted prompts only under the e2e variable and Enable to connect NEAR AI in place
2. Task 1 GREEN: `54af90d` feat(61-19): route Team Mode prompts through one module and connect NEAR AI in place when turning on Team Mode
3. Task 2 RED: `b1f035f` test(61-19): expect an up-front warning when teammates cannot reach the project, change events and sidebar wording
4. Task 2 GREEN: `8cc8b05` feat(61-19): say up front when teammates cannot reach the project, and report Team Mode changes to listeners
5. Task 3 RED: `66f5ae0` test(61-19): expect Share Team Setup to share exactly the team setup after one plain confirmation
6. Task 3 GREEN: `1d25cbf` feat(61-19): Share Team Setup shares exactly the team setup after one plain confirmation; Enable's share button uses it

## TDD Gate Compliance

- Task 1 RED: `node --test --test-reporter=tap dist/test/teamPrompts.test.js dist/test/teamCommands.test.js` exited 1 with 25 tests and 10 failing. The target was "with NEAR_AI_E2E=1 and a script, an input step answers its prompt, is used up, and VS Code sees nothing". It failed on ERR_ASSERTION against a delegation-only teamPrompts skeleton, and the three connect tests failed on the missing behaviour. Classifier: RED_EVIDENCE_OK (target_test_failed). Semantic assessment: the module loaded and the gating test passed. Every failure was the planned scripted or connect behaviour being absent.
- Task 2 RED: `node --test --test-reporter=tap dist/test/teamCommands.test.js dist/test/teamMemberCommands.test.js dist/test/teamSoloParity.test.js` exited 1 with 67 tests and 9 failing. The target was "Enable with the project kept only on this computer warns first ...", which failed with `'info' !== 'warn'`: no warning was shown and the questions started. Classifier: RED_EVIDENCE_OK. Semantic assessment: every failure was a new wording, warning or listener expectation.
- Task 3 RED: `node --test --test-reporter=tap dist/test/teamShareFlow.test.js dist/test/teamCommands.test.js dist/test/teamManifest.test.js dist/test/teamSoloParity.test.js dist/test/teamPlainLanguage.test.js` exited 1 with 59 tests and 17 failing. The target "tracer: Share Team Setup asks once ..." failed with "not implemented" from the declared-only ensureTeamSetupShared. The manifest, solo-parity and command tests failed on the missing nearAi.team.share. Classifier: RED_EVIDENCE_OK. Semantic assessment: the behaviour was absent, with no load fault.
- Every RED commit precedes its GREEN commit. There were no REFACTOR commits.

## Verification

- Task 1 verify (tsc, then teamPrompts and teamCommands): 25 tests, 25 pass. Tracer gate (auto mode): re-run with teamSoloParity, teamPlainLanguage and teamManifest gave 50 tests, 50 pass, so the plan expanded.
- Task 2 verify (tsc, then teamCommands, teamMemberCommands and teamSoloParity): 67 tests, 67 pass. teamPlainLanguage, teamManifest and teamPrompts: 25 tests, 25 pass.
- Task 3 verify (tsc, then teamShareFlow, teamCommands, teamManifest, teamSoloParity and teamPlainLanguage): 59 tests, 59 pass. With teamMemberCommands and teamPrompts added: 105 tests, 105 pass.
- Broader impacted check, all `dist/test/team*.test.js` plus nearSignIn and toolsPage (MemoryMax=6G): 1057 tests, 1053 pass, 2 skipped, 2 fail. Both failures are the known deferred self-import tests (teamGsdImport "every plan committed at HEAD parses ..." and teamImport "this repository's own .planning at HEAD imports ..."), owned by 61-22. They were not weakened. The load-sensitive teamSession test passed in this run.
- Acceptance: `connectNearAi` appears in extension.ts. "Connect NEAR AI" and `checkOnlineHome` and `onDidChange` appear in teamCommands.ts. `NEAR_AI_E2E` appears in teamPrompts.ts. `nearAi.team.share` appears in package.json. `grep -c pushCodeBranch src/services/team/teamCommands.ts` prints 0. `export async function ensureTeamSetupShared` appears in shareFlow.ts. `tsc -p tsconfig.json` (the lint script) is clean, and no em-dash was added.

## Tests changed from the old behaviour (owner rule)

- "a folder that is not set up for NEAR AI gets an error that names NEAR AI: Set Up" became three tests: connected and continued, still not connected, and dismissed.
- "choosing Share with my team pushes the current branch ..." now checks that Share with my team runs Share Team Setup. The test confirms once, checks that only team.json reached the online main, and checks that another local branch was not pushed.
- "a failing share shows plain words with Try again ..." (a diverged main) now checks that the share lands on top of the teammate's work with only team.json and that this computer does not move. The refusal case is a new test with a pre-receive hook and Show details.
- The Enable channel line now reads "team.json is committed on main. Sharing puts only team.json on main at origin.". The SOLO_TEXT and open-folder expectations name the Team section button.
- Fixture order only: withProject in teamCommands.test.ts and withTeam in teamMemberCommands.test.ts now point origin at the public test address before Enable. The unreachable-remote test now uses an unreachable public-looking address. The SEC-01 canary test answers the new not-shareable warning with Turn on anyway. Their assertions are unchanged.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The solo-parity allowlist for teamPrompts.js was moved from Task 3 to Task 1**
- Found during: Task 1 (tracer)
- Issue: the static import of teamPrompts.ts in teamCommands.ts, which is Task 1's change, made six solo-parity tests fail ("no compiled team module was loaded").
- Fix: teamPrompts.js joins the allowlist in Task 1, together with a new test that the compiled module requires only `vscode`. The ten-command list stayed in Task 3.
- Files: src/test/teamSoloParity.test.ts
- Commit: `54af90d`

**2. [Rule 1 - Test expectation] Two expectations in the new tests were corrected to the real, correct behaviour**
- Found during: Task 3 GREEN
- Issue 1: my new non-manager share test expected the role "developer". A joined developer invitee stays an "observer" until the lead confirms them, and the product message correctly said observer.
- Issue 2: my new offline test asserted that the channel never names the unreachable path. git's own offline error names the insteadOf-rewritten location, which is technical detail that projectHome already redacts of credentials (61-16). The plan asks for no address only in what the person reads.
- Fix: the role is now "observer". The offline test now checks that the channel has the technical reason and that nothing the person reads names the path. Both were new tests written in this plan. No pre-existing assertion was loosened.
- Files: src/test/teamMemberCommands.test.ts, src/test/teamShareFlow.test.ts
- Commit: `1d25cbf`

**3. Small additions beyond the plan**
- The handle's restart event is tested through Link in teamMemberCommands.test.ts, because restartSession is reached only through Join or Link.
- A test for running Share Team Setup in a solo project was added to teamCommands.test.ts, and the share command was added to teamManifest's solo loop.

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 test expectation), plus extra coverage.
**Impact on plan:** none on scope. The production behaviour matches the plan.

## Not changed on purpose

- memberCommands.ts still calls `vscode.window.show*` for its own prompts and still has its own push of the current branch (`pushBranch`, `pushCodeBranch`). The plan assigns both to 61-20 (prompts through teamPrompts, Invite shares first) and 61-23 (removing the old push helpers).
- The share flow's not-reachable modal offers Show details only. Turning Team Mode on anyway is an Enable choice.

## Issues Encountered

None beyond the deviations above.

## Known Stubs

None. Every new sentence is wired to a real outcome.

## Threat Flags

None beyond the plan's register. T-61-79: the script is read only with NEAR_AI_E2E === '1', tested with the variable unset, '', '0', 'true' and ' 1'. T-61-80: one confirmation before shareTeamSetup, declining leaves the remote unchanged (tested), and teamCommands.ts no longer pushes. T-61-81: people read fixed SHARE_TEXT sentences, and the credential-URL test shows no address in the channel or on screen. T-61-82: Share Team Setup requires member.invite, tested with an observer. T-61-SC: no package was installed, and teamManifest's dependency check passes.

## User Setup Required

None.

## Next Phase Readiness

- 61-20 can call `ensureTeamSetupShared(..., { reason: 'invite' })` before an invite (button "Share and continue", silent when already online) and route memberCommands' prompts through `teamPrompts`.
- 61-21 can subscribe to `handle.onDidChange` for the sidebar Team section, and offer Share via `nearAi.team.share`.
- 61-22 can drive every Enable and share prompt with `promptTap.script` under NEAR_AI_E2E=1.

## Self-Check: PASSED

- The files src/services/team/teamPrompts.ts, src/services/team/shareFlow.ts, src/test/teamPrompts.test.ts and src/test/teamShareFlow.test.ts exist.
- Commits c078d2c, 54af90d, b1f035f, 8cc8b05, 66f5ae0 and 1d25cbf are ancestors of HEAD (6 commits since c2f529a).
- Every acceptance grep and every task verify command passed as listed above.

---
*Phase: 61-invitations-joining-removal-near-org-and-key-integration*
*Completed: 2026-11-03*
