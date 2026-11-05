---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 32
subsystem: team-mode
tags: [team-mode, join, profiles, secret-storage, sidebar, connect-screen, css, gap-closure]

requires:
  - phase: 61-31
    provides: "The Team section host's refresh-status after a delivered team key (61-30), the Connect-screen group in PR #7's panel and this branch's Connect block, the RED tests of 5297b2d"
provides:
  - "installOwnKey and OWN_KEY_PROFILE_NAME ('My NEAR AI key'): the key pasted at Join becomes the person's own profile through ProfileStore"
  - "TeamModeHandle.onProfileChanged (member commands: own-key join, unfinished-join reset) and TeamSession.onProfileChanged (delivered team key, own-removal clean-up)"
  - "One refresh-status from the Team section host per Team Mode profile change"
  - "Connect-screen spacing rules (.team-connect, .team-connect-actions, .team-connect-status) and gapAbovePx in the probe facts"
affects: [61-34, 62-28, 61-33, 61-35, 62-29, 62-30, team-preview merge, sidebar Connect screen]

actuals:
  tokens: 19845
  tasks: 3
  commits: 6
plan_head_before: 17f51d9947acefd48c20d5752c889ca4b45f7c68
plan_head_after: a89171e204e19bcad4537cdda46f13560e62404f

tech-stack:
  added: []
  patterns:
    - "A Team Mode profile change is a signal (onProfileChanged on the handle and the session); the host turns each into exactly one refresh-status"
    - "Layout facts in the e2e probe are measured with getBoundingClientRect and are null when nothing is laid out"

key-files:
  created:
    - src/test/teamOwnKeyProfile.test.ts
  modified:
    - src/team/teamKeyProfile.ts
    - src/team/join.ts
    - src/services/team/memberCommands.ts
    - src/services/team/teamCommands.ts
    - src/services/team/teamSession.ts
    - src/services/team/teamSectionHost.ts
    - media/chat/chat.css
    - media/chat/team.js
    - src/test/teamJoin.test.ts
    - src/test/teamJoinCommand.test.ts
    - src/test/teamFlow.test.ts
    - src/test/teamSectionHost.test.ts
    - src/test/teamSectionPage.test.ts
    - src/test/e2e/suite.ts
    - .planning/debug/join-own-key-connect-stuck.md

key-decisions:
  - "61-32: a key pasted at Join is installed by installOwnKey as the person's own profile 'My NEAR AI key' (profile id deriveProfileId(projectRoot, name), organization = the organization id from check_api_key), one check, no join.json or key.json; installTeamKey is used only for lead-delivered team keys"
  - "61-32: the Team section host follows the session's onProfileChanged instead of onKeyInstalled (production fires both for a delivered key), plus the handle's onProfileChanged for member-command changes; the handle does not forward session events, so nothing posts refresh-status twice"
  - "61-32: the join message for an own key is 'Your NEAR AI key is now this project's profile.', also after 'Your lead confirms you as ...' for a pending role"
  - "61-32: the removal and unfinished-join refresh tests live in teamOwnKeyProfile.test.ts so teamConnectRefresh.test.ts stays byte-identical to 5297b2d"

patterns-established:
  - "profileChanged(): every Team Mode path that changes the project's profile outside the chat's own flow tells the host once"

requirements-completed: [TEAM-02]

coverage:
  - id: D1
    description: "Join with Paste your own key: the sidebar is asked once for a fresh profile status, so the Connect screen gives way to the chat without a reload"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamConnectRefresh.test.ts#Join with Paste your own key: the page is asked for a fresh profile status once the key works, so the Connect screen gives way to the chat"
        status: pass
    human_judgment: false
  - id: D2
    description: "The pasted own key is the person's own profile 'My NEAR AI key': selected, in the saved-profile list, kept on removal, personal spend, never replaced by a later team key, bound to its checked address, never written outside secure storage"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamConnectRefresh.test.ts#Join with Paste your own key: the own key becomes the person's own profile, not the team key profile"
        status: pass
      - kind: unit
        ref: "src/test/teamOwnKeyProfile.test.ts (9 tests)"
        status: pass
      - kind: integration
        ref: "src/test/teamJoin.test.ts, src/test/teamJoinCommand.test.ts, src/test/teamFlow.test.ts (own-profile expectations)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Every Team Mode profile change (own key at Join, delivered team key, own-removal clean-up, unfinished-join reset) posts exactly one refresh-status"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamOwnKeyProfile.test.ts#after the person's own removal ...; #the unfinished-join reset ..."
        status: pass
      - kind: unit
        ref: "src/test/teamSectionHost.test.ts (key-installed, session profile change, handle profile change)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Clear space and a thin line above the team group on the Connect screen"
    verification:
      - kind: unit
        ref: "src/test/teamSectionPage.test.ts#chat.css sets the team group apart ...; #the probe reports the space above the team group ..."
        status: pass
      - kind: e2e
        ref: "NEAR_AI_E2E_ONLY=invite: [team-join] with no NEAR AI profile ... (gapAbovePx >= 10)"
        status: pass
    human_judgment: true
    rationale: "This branch has only a fake of PR #7's panel; the in-panel gap and its look must be checked after main is merged for the next preview build, in code-server"

duration: 18min
completed: 2026-11-05
status: complete
---

# Phase 61 Plan 32: Own key at Join becomes your own profile, the sidebar refreshes on every Team Mode profile change, and the Connect screen's team group gets clear space Summary

**A key pasted at Join is now checked once and saved as the person's own profile 'My NEAR AI key' (never the team key profile), every Team Mode profile change asks the sidebar once for a fresh profile status so the Connect screen gives way at once, and the team group on the Connect screen sits 12px below a thin line.**

## Performance

- **Duration:** 18 min (from the recorded start; reading the plan and context came before it)
- **Started:** 2026-11-05T16:49:10Z
- **Completed:** 2026-11-05T17:07:12Z
- **Tasks:** 3 (tracer + 2 auto), each RED then GREEN
- **Files modified:** 16

## Accomplishments

- `installOwnKey` (src/team/teamKeyProfile.ts): one `check_api_key`, then `ProfileStore.configure` as 'My NEAR AI key' with the organization id the check named, the key bound to the checked address, the Buffer zero-filled in `finally`, no team storage file written. `installPastedKey` in src/team/join.ts uses it; a refused key says 'NEAR AI did not accept this key. Check it and try again.' then the existing next step.
- `TeamModeHandle.onProfileChanged` and `MemberCommandDeps.profileChanged()`: told after an own-key join and after Remove unfinished keys. `TeamSession.onProfileChanged`: told after a delivered team key is installed and after the own-removal clean-up (whether it finished or threw). The Team section host subscribes to both and posts one `{type:'host-request', payload:{type:'refresh-status'}}` per change, then refreshes.
- The join message for an own key ends 'Your NEAR AI key is now this project's profile.' ('Your team key is installed for this project' is gone).
- chat.css: `#welcome-connect .team-connect` (margin-top 12px, padding-top 10px, 1px top line in `--vscode-panel-border`), `.team-connect-actions` (wrapping flex, gap 6px 10px), `#welcome .team-connect-status` (bottom margin) and `#team-connect .team-connect-status` (12px above). team.js reports `gapAbovePx` in the Connect facts.
- Debug session join-own-key-connect-stuck: resolved, awaiting the owner's re-test.

## Task Commits

1. **Task 1 (tracer): own key at Join is the own profile, one refresh-status**
   - `942df1b` test (RED)
   - `3db137e` fix (GREEN). Tracer gate: verify re-run green, then expanded.
2. **Task 2: every profile change refreshes once; own-profile guarantees**
   - `48c7ba5` test (RED)
   - `889a718` fix (GREEN)
3. **Task 3: space above the team group, measured in a real window**
   - `8ae694e` test (RED)
   - `a89171e` fix (GREEN) + debug session resolution

## Test results (all under the memory cap)

- Task 1 set (teamConnectRefresh, teamJoin, teamJoinCommand, teamMemberCommands, teamSectionHost, teamAskToJoin, teamJoinRequest): 125 tests, 125 pass, 0 fail. Both RED tests of 5297b2d green; `git diff --quiet 5297b2d -- src/test/teamConnectRefresh.test.ts` exits 0.
- Task 2 set (teamOwnKeyProfile, teamConnectRefresh, teamSectionHost, teamRemove, teamKeyScope, teamFlow, teamSessionMembers, teamConfirm, profileIndex, teamAskToJoin): 126 tests, 126 pass, 0 fail.
- Task 3 set (teamSectionPage, teamPlainLanguage): 44 tests, 44 pass, 0 fail.
- Invite launch (`NEAR_AI_E2E_ONLY=invite`, xvfb-run, WAYLAND_DISPLAY, XDG_SESSION_TYPE and DISPLAY unset, MemoryMax=6G): 25 passed, 0 failed, exit 0, including the team-join window's gapAbovePx >= 10.
- Full `npm test` (MemoryMax=6G, timeout 1800): 2222 tests, 2209 pass, 2 fail, 11 skipped. The 2 failures are the RED tests committed in 6ff8876 (src/test/teamBoardReopenColumn.test.ts, reopen to Backlog), which plan 62-28 closes; not caused by this plan.

## Decisions Made

See key-decisions above. In short: the own key never goes through `installTeamKey`; the host turns each profile signal into exactly one refresh-status; the handle does not forward session events (that would post twice).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The own-key sentence was dropped for a joiner with a pending role**
- **Found during:** Task 1 GREEN
- **Issue:** `nextAfterJoin` returned early for a pending role, so an observer waiting to be confirmed (the normal case) never saw the own-key sentence, and the command test's 'the join message ends ...' failed.
- **Fix:** the pending-role sentence is followed by ' Your NEAR AI key is now this project's profile.' when the key was installed.
- **Files modified:** src/services/team/memberCommands.ts
- **Commit:** 3db137e

**2. [Rule 1 - Bug] A third test pinned the old own-key-as-team-key behaviour**
- **Found during:** Task 2 GREEN (teamFlow.test.ts was in the Task 2 verify set)
- **Issue:** 'the same lifecycle in a team with no NEAR organization ...' asserted the own key was `teamProfileId(teamId)`, that join.json remembered the personal profile, and that removal restored it. The plan named only the two pins in teamJoin.test.ts and teamJoinCommand.test.ts.
- **Fix:** the assertions now expect the own profile 'My NEAR AI key' (equally strict): selected after the join, no installed-key record, `restoredProfileId` undefined on removal, the own profile still selected and the personal profile still there. The comment cites D-21 as amended in the 0.6.4 re-test. No assertion was removed without an equivalent.
- **Files modified:** src/test/teamFlow.test.ts
- **Commit:** 889a718

**3. [Owner constraint] The removal and reset refresh tests are in teamOwnKeyProfile.test.ts, not teamConnectRefresh.test.ts**
- **Found during:** Task 2 RED
- **Issue:** the plan put these two real-git tests in teamConnectRefresh.test.ts, but the orchestrator's instruction says that file must stay unchanged from 5297b2d.
- **Fix:** both tests are in src/test/teamOwnKeyProfile.test.ts (which is in the plan's Task 2 verify command), with a header comment saying why.
- **Commit:** 48c7ba5

**4. [Rule 3 - Test setup] The reset test brings the copy up to date before the window opens**
- **Found during:** Task 2 RED
- **Issue:** with a copy that is behind, no team session runs when the window opens, so Join only warns and the reset is never offered.
- **Fix:** the test pulls main into clone b before opening the window, as an interrupted join would have left it. The RED then failed for the intended reason (no refresh-status).
- **Commit:** 48c7ba5

**5. [Fact shape] gapAbovePx is added to the existing exact Connect-fact assertions**
- Two `deepEqual`s in teamSectionPage.test.ts now include `gapAbovePx: null` (the fake DOM lays nothing out). In this branch's Connect block, when the status is empty the row is measured from the body above it, so the real-window check still measures the team group.
- **Commit:** 8ae694e

---

**Total deviations:** 5 (2 bug fixes, 1 owner constraint, 1 test setup, 1 fact shape). **Impact:** no change of scope; every pinned behaviour change follows the owner's amended D-21.

## Issues Encountered

None blocking. `npx eslint` is not the project's linter (`npm run lint` is `tsc --noEmit`); the type check ran with every verify command.

## Preview-build check (backstop, after main is merged)

- When main is merged for the next preview build: run the invite launch again. The team-join window's first Connect check runs inside PR #7's real `#welcome-connect` panel (`inPanel` true) and must still give `gapAbovePx` of at least 10. Note that check also asserts `inPanel === false` today ('on this branch the Connect block is drawn on its own'); the merge must update that line for the panel.
- The owner opens a project with no profile in code-server and sees clear space, with a thin line, between Set up a new profile and the team sentence with Join a team, Ask to join and Use a saved profile.
- The owner re-tests 61-UAT 0.6.4 step 5 (bob: Join, Paste your own key, the chat appears without a reload; the profile is 'My NEAR AI key').

## Notes for 61-34

- New seams: `TeamModeHandle.onProfileChanged`, `MemberCommandDeps.profileChanged()` and `TeamSession.onProfileChanged`. Any new Team Mode path that changes the project's profile should call one of them once; the host already turns it into one refresh-status. Do not also forward session events through the handle (that would post twice).
- The host follows `session.onProfileChanged`, not `onKeyInstalled`; `onKeyInstalled` is still fired for its other users. The fake session in teamSectionHost.test.ts fires both from `fireKey()` and counts both in `keyListeners()`; `fireProfile()` fires profile listeners only.
- The own profile id is `deriveProfileId(projectRoot, 'My NEAR AI key')`. `installOwnKey` writes no join.json or key.json, so `readInstalledKey` stays undefined until a lead's team key arrives; that key then records the own profile as `previousProfileId`.
- The automatic join after an accepted request (`completeJoinRequest`) never installs a key, so it does not call `profileChanged()`. The carol step-9 issue (ask-join-connect-no-refresh) is still open and is not touched here.
- The full suite's only failures are the 62-28 RED tests from 6ff8876.

## Known Stubs

None.

## Threat Flags

None. The key goes only to SecretStorage through ProfileStore (T-61-123), bound to its checked address (T-61-124, tested), and a later team key gets its own profile (T-61-125, tested). The page gains no new message (T-61-126). No packages were installed (T-61-SC).

## Self-Check: PASSED
