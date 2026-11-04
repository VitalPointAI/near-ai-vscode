---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 30
subsystem: ui
tags: [team-mode, connect-screen, sidebar, join, ask-to-join, team-key, saved-profile, gap-closure, G-61-9]

requires:
  - phase: 61-29
    provides: "nearAi.team.askToJoin, TeamModeHandle.joinRequestPending(), TeamSession.onKeyInstalled()"
  - phase: 61-27
    provides: "nearAi.useSavedProfile (a profile set up in another project)"
  - phase: 61-25
    provides: "readiness.js, the one profile-readiness rule (window.nearReadiness)"
  - phase: 61-26
    provides: "Working with your agents, Just me for now and the quiet empty-chat line"
provides:
  - "The 'ask' Team section action (nearAi.team.askToJoin) in the model, the host and the page"
  - "TeamSectionModel.connect: the Connect screen's status and team buttons for every situation before a profile works, plus the fallback block words"
  - "team.js: section#team-connect in the empty chat on this branch, and one .team-connect group inside PR #7's #welcome-connect after the merge"
  - "Host inputs joinRequestPending and team.awaitingKey, and a refresh-status request to the page when a team key is installed"
  - "Join Team in a team without an organization: one pick of Paste your own key, Use a saved profile or Later"
  - "installedKeyId(storageDir) in teamKeyProfile.ts and NO_KEY_NOTICE in join.ts"
affects: [61-31, 61-uat-retest, setup-next-steps-merge]

actuals:
  tokens: 23171
  tasks: 3
  commits: 7
plan_head_before: f077eeeca9cc18c8533a9d23d8163379f085dac5
plan_head_after: 73e930f25f10120784bd6dd68c82079502bc656e

tech-stack:
  added: []
  patterns:
    - "A sidebar module that adds to another component's panel adds one group of its own inside it and never changes the panel's elements; a test snapshots every attribute and text of the panel before and after"
    - "team.js redraws on its own profile-status listener as well as on readiness.onChange, because it loads after chat.js and so sees what setup.js has already shown"
    - "The host asks the page for a fresh profile status with {type:'host-request', payload:{type:'refresh-status'}}, which chat.js posts back and chat.ts answers"

key-files:
  created: []
  modified:
    - src/domain/team/teamSection.ts
    - src/domain/team/teamSectionText.ts
    - media/chat/team.js
    - src/services/team/teamSectionHost.ts
    - src/services/team/memberCommands.ts
    - src/team/teamKeyProfile.ts
    - src/team/join.ts
    - src/test/teamSectionModel.test.ts
    - src/test/teamSectionPage.test.ts
    - src/test/teamSectionHost.test.ts
    - src/test/teamJoinCommand.test.ts
    - src/test/teamMemberCommands.test.ts
    - src/test/e2e/suite.ts

key-decisions:
  - "The Connect part is drawn only when the profile state is known and is neither ready nor no-folder. Before the first profile-status nothing is drawn, so a page never shows the Connect screen on a working project for a moment."
  - "awaitingKey is true only for someone on a team that pays through its organization who is not the owner, and only until the key delivered to them is the one in key.json. A record that cannot be read counts as not installed, so Check again stays offered."
  - "Waiting for the key has two sentences: 'once a lead confirms you' while the person still waits for a lead, and 'once a lead sends it' once they are confirmed."
  - "On a team without an organization the Connect screen has no team button. Its status names both ways in, and Set up a new profile and Use a saved profile are the buttons."
  - "With a working profile, a waiting request also relabels the section's Ask to join as Show my request, with the waiting status, the same as on the Connect screen."
  - "Use a saved profile runs nearAi.useSavedProfile only after the join has finished, never inside the join's progress. Whether the project is ready is read from the project's profile list (the active profile's key was checked)."
  - "Join Team and Ask to Join a Team share nextAfterJoin. In a linked team they say 'Once a lead confirms you, your team key becomes this project's profile.'"

patterns-established:
  - "Connect-screen labels that differ from the section's (Show my request, Check again) live in TEAM_CONNECT_LABELS and TEAM_CONNECT_HINTS. The fallback block words live in TEAM_CONNECT_FALLBACK."

requirements-completed: [TEAM-02]

coverage:
  - id: D1
    description: "With no profile, the Connect screen offers Join a team and Ask to join. On this branch a Connect block in the empty chat shows Connect NEAR AI to start, Set up a new profile, Use a saved profile and the team buttons. Inside PR #7's panel only one .team-connect group is added, and the panel's own elements are unchanged. A working profile removes either one and shows the 61-26 section."
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/teamSectionPage.test.ts#tracer: without PR #7's panel and with no profile, a Connect block in the empty chat offers a new profile, a saved profile, Join a team and Ask to join"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionPage.test.ts#inside PR #7's panel team.js adds one .team-connect group with Join a team, Ask to join and Use a saved profile, and changes nothing of the panel"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionPage.test.ts#a working profile removes the Connect part and shows the Team section as before; a profile that stops working brings it back"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionPage.test.ts#the probe reports the Connect part and a click probe reaches a team action in it"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionModel.test.ts#tracer: with no team the Connect screen offers Join a team and Ask to join, with no status, and the fallback words of the Connect block"
        status: pass
    human_judgment: true
    rationale: "Only unit tests in the fake DOM cover the layout, the look in a real sidebar and the path through PR #7's real panel after the merge. The owner's UAT retest (61-UAT test 10) should look at it."
  - id: D2
    description: "No dead ends before a profile works. Each situation says what happens next: not on the team, a waiting request (Show my request), waiting for the team key (Check again), and a team without an organization (own key or saved profile). A removed person sees nothing. The not-on-team section offers Join a team, Ask to join and Open board."
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/teamSectionModel.test.ts#every situation before a profile works gives its plain sentence and its team buttons on the Connect screen"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionModel.test.ts#with a working profile a team this computer is not on offers Join a team first, then Ask to join and Open board; a waiting request shows itself"
        status: pass
      - kind: integration
        ref: "src/test/teamSectionHost.test.ts#a member of a team that pays through its organization waits for the team key until the delivered key is the one installed here"
        status: pass
      - kind: integration
        ref: "src/test/teamSectionHost.test.ts#a waiting request to join comes from the handle: the Connect screen shows Show my request and says the request waits"
        status: pass
    human_judgment: false
  - id: D3
    description: "When the team key is installed, the host posts refresh-status to the page once and then the new team state. A new session is followed, and the old one is let go."
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamSectionHost.test.ts#when the team key is installed the host asks the page for a fresh profile status once, then posts the new team state; a new session is followed"
        status: pass
    human_judgment: false
  - id: D4
    description: "Joining a team without an organization asks one pick: Paste your own key, Use a saved profile or Later. Use a saved profile runs nearAi.useSavedProfile and says the project is ready when that profile works. Later says the sidebar offers both. A linked team asks no key and says the team key becomes this project's profile once a lead confirms them."
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamJoinCommand.test.ts#a team without an organization: one pick offers Paste your own key, Use a saved profile and Later; Paste your own key keeps the masked box and the check"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinCommand.test.ts#Use a saved profile runs NEAR AI's saved-profile choice after joining and says the project is ready once that profile works"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinCommand.test.ts#a team that pays through its organization asks for no key, and says the team key becomes this project's profile once a lead confirms them"
        status: pass
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[team-join] Join a team from the quiet line with the pasted invite brings the copy up to date by itself and joins as an observer waiting for a lead"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-04
status: complete
---

# Phase 61 Plan 30: Join a team from the Connect screen Summary

**A person with no working profile can now join a team (or ask to join one) right from the Connect screen.** This works on this branch and inside PR #7's panel after the merge.

What happens next depends on the team:
- **A team that pays through its organization:** the lead-made team key becomes the project's profile by itself, and the sidebar refreshes without a reload.
- **A team without one:** the join asks, in the same flow, for the person's own key or a saved profile, or lets them choose later.

## Performance

- **Duration:** about 25 min
- **Started:** 2026-11-04T21:40:19Z
- **Completed:** 2026-11-04T22:05:00Z
- **Tasks:** 3
- **Files modified:** 13 (no new files)

## Accomplishments

- **Model** (`teamSection.ts`, `teamSectionText.ts`)
  - New `'ask'` action, which runs `nearAi.team.askToJoin`.
  - New `connect` part with a status, the team buttons and the fallback words for every situation before a profile works:
    - No team: Join a team and Ask to join.
    - Not on the team: the same two buttons, and the team named.
    - A request waits: Show my request, and that this computer joins by itself.
    - Waiting for the team key: Check again, and that the key arrives and NEAR AI then uses it here.
    - No organization: each person uses their own key or a saved profile.
    - Removed: no connect part at all.
  - The not-on-team section now offers Join a team (primary), Ask to join and Open board.
- **Page** (`team.js`), drawn only while the profile state is known and not working:
  - With `#welcome-connect` on the page, one `div.team-connect` goes inside it: the status, the team buttons, and Use a saved profile only while `#welcome-choose-profile` is absent or hidden.
  - Without it, one `section#team-connect` goes inside `#welcome`, with Connect NEAR AI to start, a one-line body, Set up a new profile (`open-setup`), Use a saved profile (`select-profile`) and the team buttons.
  - Click handlers are bound in the closure.
  - The probe facts gain `connect`, and a click probe reaches the connect buttons.
  - When the Connect part goes away, focus moves to the message box.
- **Host** (`teamSectionHost.ts`)
  - `joinRequestPending` from the handle, asked only for a person not on the team.
  - `team.awaitingKey`: on a linked team, not the owner, and the delivered key id is not the one in key.json (read with the new `installedKeyId`).
  - `onKeyInstalled` posts `{type:'host-request', payload:{type:'refresh-status'}}` once, then refreshes. The subscription moves to each new session, like `onStateChange`.
- **Join Team** (`memberCommands.ts`)
  - A team without an organization gets one pick: Paste your own key (the masked box and the check stay unchanged behind it), Use a saved profile (runs `nearAi.useSavedProfile` after the join, then "This project is ready..." when the profile works) or Later. Closing the pick counts as Later.
  - Choosing Later, or a saved profile that does not end up working, gives a sentence naming the sidebar's two profile buttons.
  - A linked team asks no key (D-21). Join and Ask to join now say "Once a lead confirms you, your team key becomes this project's profile."

## Task Commits

1. **Task 1 (tracer) RED:** `07cc5a5` test(61-30): the Connect screen offers Join a team and Ask to join, here and inside PR #7's panel (RED)
2. **Task 1 GREEN:** `e2e4c6f` feat(61-30): Join a team and Ask to join on the Connect screen, in a block of its own or inside PR #7's panel (GREEN)
3. **Task 2 RED:** `9db7746` test(61-30): the team states of the Connect screen, from the host, and the refresh when the team key arrives (RED)
4. **Task 2 GREEN:** `e1d3140` feat(61-30): every state before a profile works has a next step, and the team key turns into the profile on screen by itself (GREEN)
5. **Task 3 RED:** `bc1ab2f` test(61-30): joining a team without an organization offers your own key or a saved profile in the same flow (RED)
6. **Task 3 GREEN:** `ea7767f` feat(61-30): joining a team without an organization offers your own key, a saved profile or later in the same flow (GREEN)
7. **E2E script:** `73e930f` test(61-30): the invitee's e2e window answers the own-key pick with Later

No REFACTOR commits were needed.

## TDD Gate Compliance

Each RED commit also added the type declarations and words the new tests name (the `connect` type, the input fields, the sentences and the JOIN_TEXT words), so the tests compiled. Nothing filled or drew them at RED.

**Task 1 RED**
- Run: `node --test --test-reporter=tap` over teamSectionModel, teamSectionPage and sidebarReadiness. Exit 1; 60 tests, 49 pass, 10 fail.
- Target: "tracer: with no team the Connect screen offers Join a team and Ask to join...". It failed on "the model has a connect part" (expected true, actual false).
- Classifier: RED_EVIDENCE_OK (target_test_failed).
- Semantic assessment: the test compiled and ran, and it failed on the planned behaviour. The page tests failed on "the Connect block is drawn", the closed id list on the missing 'ask', and the probe tests on the missing `connect` fact. There were no load faults.

**Tracer gate (auto mode)**
- The Task 1 verify was re-run with teamSectionHost, teamPlainLanguage and teamSoloParity: 96 tests, 95 pass, 1 existing skip (the PR #7 parity check).
- Expansion continued.

**Task 2 RED**
- Target: "when the team key is installed the host asks the page for a fresh profile status once...". It failed on "the session is followed for installed keys" (expected 1, actual 0).
- Classifier: RED_EVIDENCE_OK.
- The other host tests failed because the connect part was undefined. The model tests failed on the missing connect states and on Ask to join missing from the not-on-team section.

**Task 3 RED**
- Target: "a team without an organization: one pick offers Paste your own key...". It failed on "asked once, after the name" (expected 1, actual 0).
- Classifier: RED_EVIDENCE_OK.
- The linked-team test failed on the old sentence, "Your lead confirms you and sends your team key."

## Verification

- **Task 1 verify** (`tsc`, teamSectionModel, teamSectionPage, sidebarReadiness): exit 0. 60 tests: 59 pass, 1 existing skip.
- **Task 2 verify** (`tsc`, teamSectionModel, teamSectionHost, teamSoloParity): exit 0. 51 tests, 51 pass. Also run: teamSectionPage, teamPlainLanguage and teamKeyProfile, exit 0.
- **Task 3 verify** (`tsc`, teamJoinCommand, teamMemberCommands, teamAskToJoin, teamPlainLanguage): exit 0. 78 tests, 78 pass. Also run: teamJoin, teamJoinRequest, teamFlow and teamManifest, 41 tests, 41 pass.
- **Full `npm test`** (MemoryMax=6G, choom, nothing else running, 13 GB available): exit 0. 2042 tests: 2031 pass, 0 fail, 11 skipped (the existing skips).
- **E2E** (`NEAR_AI_E2E_ONLY=invite,team`, xvfb-run, DISPLAY, WAYLAND_DISPLAY and XDG_SESSION_TYPE unset, MemoryMax=6G): exit 0. 29 of 29 pass, including team-lead, team-join and team-confirm.
- **Acceptance greps:**
  - `team-connect` appears in team.js 9 times (needs 2 or more).
  - `welcome-connect` appears in team.js 2 times (needs 1 or more).
  - `refresh-status` is in teamSectionHost.ts.
  - `Show my request` appears in teamSectionText.ts exactly once.
  - `nearAi.useSavedProfile` is in memberCommands.ts.

## Decisions Made

See key-decisions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Small helpers outside the plan's file list**
- `src/team/teamKeyProfile.ts` exports `installedKeyId(storageDir)`, so the host can tell whether the delivered key is the one installed. It reads the same key.json that `readInstalledKey` reads.
- `src/team/join.ts` exports `NO_KEY_NOTICE` (the same text as before), so Join Team can drop that advice when the person chose a saved profile or Later.
- **Commits:** e1d3140, ea7767f

**2. [Rule 3 - Blocking] Tests that pinned the old flow**
- `teamMemberCommands.test.ts`:
  - The existing paste-own-key case now answers the new pick with Paste your own key before the masked box. This is the change the plan names; the case is otherwise unchanged.
  - The linked join sentence is updated to the new words.
- `src/test/e2e/suite.ts`: the invitee's script answers the new pick with Later instead of the old key box, and the e2e action name type gains `ask`.
- `teamSectionPage.test.ts`: the four exact probe-fact expectations gain `connect` (null, or the Connect part on a page with no profile).
- **Commits:** 07cc5a5, ea7767f, 73e930f

**3. [Rule 2 - Correctness] Use a saved profile in PR #7's panel follows what setup.js shows**
- team.js loads after chat.js, so it also redraws on its own profile-status listener. By then setup.js has already shown or hidden `#welcome-choose-profile`, which avoids offering a second profile choice or none at all.
- **Commit:** e2e4c6f

---

**Total deviations:** 3 auto-fixed (2 blocking, 1 correctness).
**Impact on plan:** No new surface. The page posts only the chat's existing open-setup and select-profile messages, and team-action with the fixed ids (T-61-118).

## Issues Encountered

None.

## Known Limitations

- The path through PR #7's panel is tested against a fake of its markup taken from `feat/setup-next-steps` (`panelView.ts` and `setup.js`). After main is merged in, check it once against the real panel. The SETUP-01 parity skip in sidebarReadiness turns on at that point.
- The Connect block on this branch uses the existing `text-button` styles and the `#welcome` paragraph styles. It has no CSS of its own.

## User Setup Required

None.

## Next Phase Readiness

For 61-31:
- `model.connect` is in every team-state. The probe facts report `connect: { status, actions, inPanel }` or null, and `teamSectionTap.probe({ id, click: 'ask' })` clicks a connect button while no profile works.
- Two shared helpers: JOIN_TEXT.noOrgPick, the pick's placeholder that an e2e script can match, and `USE_SAVED_PROFILE_COMMAND`.
- The 61-29 limits still apply: a failed automatic completion is retried at most every 5 minutes, and on a freshly opened window the join happens on the second sync.

## Self-Check: PASSED

- FOUND: src/domain/team/teamSection.ts, src/domain/team/teamSectionText.ts, media/chat/team.js, src/services/team/teamSectionHost.ts, src/services/team/memberCommands.ts, src/team/teamKeyProfile.ts, src/team/join.ts
- FOUND commits: 07cc5a5, e2e4c6f, 9db7746, e1d3140, bc1ab2f, ea7767f, 73e930f (all ancestors of HEAD)
