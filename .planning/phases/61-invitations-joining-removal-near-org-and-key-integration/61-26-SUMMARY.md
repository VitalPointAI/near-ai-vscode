---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 26
subsystem: ui
tags: [team-section, sidebar, just-me, invite, workspace-state, plain-language, e2e]

requires:
  - phase: 61-25
    provides: "readiness.js rule: nothing team-related shows until a NEAR AI profile works"
  - phase: 62-23
    provides: "e2e runner with x11 and the board drag scenarios (suite.ts settled)"
provides:
  - "No-team section headed Working with your agents with Invite someone, Join a team and Just me for now"
  - "Just me for now kept per project in VS Code workspace state (JUST_ME_KEY), with one quiet empty-chat line (Invite people, Join a team)"
  - "Invite someone in a project with no team sets the team up on the way (Enable in invite mode) and carries on into the invite"
  - "Quiet team states: invite, members, board until someone joins; then members and board; share and check only when needed; no link button"
  - "Members lists Invite someone first for the owner and leads"
  - "'Team Mode' banned in every people-facing Team literal; on-screen sentences speak of your team"
  - "teamSetupSteps: Invite people (optional), share, link, with skipped; merge note for registerSetupStep"
affects: [62-24, setup-01-merge, 61-uat-retest]

actuals:
  tokens: 39570
  tasks: 3
  commits: 5
plan_head_before: 20a9c16126b790f9173859af61ad161cc45390be
plan_head_after: 3a30dcdfcaad12b3b1f77391713a5f8773d54c79

tech-stack:
  added: []
  patterns:
    - "A model placement field: 'section' or 'empty-chat-line', so one model drives either the sidebar section or one quiet line inside #welcome"
    - "A per-project choice kept only in VS Code workspace state, read lazily when the sidebar asks, never in a team record"

key-files:
  created: []
  modified:
    - src/domain/team/teamSectionText.ts
    - src/domain/team/teamSection.ts
    - media/chat/team.js
    - src/services/team/teamSectionHost.ts
    - src/services/team/teamCommands.ts
    - src/services/team/memberCommands.ts
    - src/services/team/teamSession.ts
    - src/test/helpers/plainWords.ts
    - src/test/teamSectionModel.test.ts
    - src/test/teamSectionPage.test.ts
    - src/test/teamSectionHost.test.ts
    - src/test/teamCommands.test.ts
    - src/test/teamMemberCommands.test.ts
    - src/test/teamSessionMembers.test.ts
    - src/test/teamSoloParity.test.ts
    - src/test/teamManifest.test.ts
    - src/test/e2e/suite.ts

key-decisions:
  - "Just me for now lives only in workspaceState under nearAi.team.justMe; setJustMe(false) removes the value; it is cleared when a team session starts or restarts (created here or joined)"
  - "Enable has an invite mode: same connect, online-home and existing-team checks, team name and your name prefilled, no email question, no closing message; the invite's own share confirmation puts the setup online"
  - "Once someone else joined, the owner or lead section shows only Members (with the waiting badge) and Open board; inviting more people is the first row of Members"
  - "The online-home warning's button is now 'Set up anyway' (was 'Turn on anyway'), because nothing is turned on any more"
  - "The no-team section is not compact, so its heading Working with your agents is shown"
  - "teamSetupSteps: share and link are skipped together with Invite people after Just me for now in a project with no team; nothing is skipped once a team exists"

patterns-established:
  - "Quiet line: p.team-solo inside #welcome, link-styled buttons with the same closure-bound clicks; chat.js hides #welcome during a conversation, so the line never shows there"

requirements-completed: [TEAM-01, TEAM-02]

coverage:
  - id: D1
    description: "No-team section: Working with your agents, Want people to work with you too?, Invite someone (primary), Join a team, Just me for now"
    requirement: TEAM-01
    verification:
      - kind: unit
        ref: "src/test/teamSectionModel.test.ts#with no team the section offers Invite someone, Join a team and Just me for now, with the words of the owner"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionPage.test.ts#tracer: with no team the page draws Invite someone, Join a team and Just me for now, and Just me for now posts the solo action"
        status: pass
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[team-lead] before a NEAR AI profile works the Team section is hidden; once a local profile is connected it shows Working with your agents without a reload"
        status: pass
    human_judgment: false
  - id: D2
    description: "Just me for now hides the section for the project (workspace state only) and leaves one quiet empty-chat line with Invite people and Join a team; gone once the project has a team"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/teamSectionHost.test.ts#Just me for now keeps the choice through the handle only: no command, no file, no event, and the next model is the quiet empty-chat line"
        status: pass
      - kind: unit
        ref: "src/test/teamCommands.test.ts#Just me for now is kept per project in VS Code workspace state under one key, tells the listeners, and writes nothing else"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionPage.test.ts#an empty-chat-line model hides the section and draws one quiet line inside the empty chat, whose two links post invite and join"
        status: pass
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[team-join] Just me for now puts the section away and leaves one quiet line on the empty chat with Invite people and Join a team"
        status: pass
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[team-join] the Team section then says a lead confirms them, with nothing to invite, and the quiet line is gone for good"
        status: pass
    human_judgment: false
  - id: D3
    description: "Invite someone from a project with no team sets the team up on the way and goes straight on into the invite (consent prompts kept, only team name and your name added)"
    requirement: TEAM-01
    verification:
      - kind: integration
        ref: "src/test/teamMemberCommands.test.ts#Invite someone in a project with no team sets the team up on the way and carries on into the invite in the same command"
        status: pass
      - kind: integration
        ref: "src/test/teamMemberCommands.test.ts#dismissing the team name while inviting from a project with no team stops with nothing changed"
        status: pass
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[team-lead] Invite someone from no team sets the team up on the way, shares it with the invite's one confirmation and shows the invite once with Copy invite"
        status: pass
    human_judgment: false
  - id: D4
    description: "A team that exists does not nag: invite, members, board until someone joins; then members and board with the board line; Members lists Invite someone first for managers"
    requirement: TEAM-01
    verification:
      - kind: unit
        ref: "src/test/teamSectionModel.test.ts#every state gives its heading, status, primary action and ordered actions"
        status: pass
      - kind: integration
        ref: "src/test/teamMemberCommands.test.ts#Members lists Invite someone first for the owner and leads, and choosing it runs the invite"
        status: pass
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[team-confirm] Members in the section confirms E2E Joiner as a developer"
        status: pass
    human_judgment: false
  - id: D5
    description: "No on-screen text names Team Mode; the plain-language scan bans it; palette titles unchanged"
    verification:
      - kind: unit
        ref: "src/test/teamPlainLanguage.test.ts#no Team Mode text a person reads uses a developer term; git words stay in the output channel (owner principle, 2026-11-02)"
        status: pass
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[team-lead] every prompt of the lead's window was answered and spoke plain words, without the old feature name"
        status: pass
    human_judgment: false
  - id: D6
    description: "The new wording and the quiet line feel right to a person working alone (61-UAT test 9 retest)"
    verification: []
    human_judgment: true
    rationale: "The owner's finding is about how the section feels for a solo developer; tests prove the words and flows, the retest of 61-UAT test 9 judges the feel"

duration: 25min
completed: 2026-11-04
status: complete
---

# Phase 61 Plan 26: Working with your agents and Just me for now Summary

**The Team section now speaks of working with your agents, Invite someone sets a team up on the way in one flow, Just me for now puts the section away per project (VS Code workspace state only) and leaves one quiet "Invite people any time" line on the empty chat, a team that exists stops nagging, and no on-screen text says Team Mode.**

## Performance

- **Duration:** about 25 min
- **Started:** 2026-11-04T11:51:22Z
- **Completed:** 2026-11-04T12:16Z
- **Tasks:** 3 (tracer, auto, auto)
- **Files modified:** 17 source and test files

## Accomplishments

- G-61-8 (61-UAT test 9) closed. With no team (and a working profile) the section is headed "Working with your agents" and asks "Want people to work with you too?". It offers Invite someone (primary), Join a team and Just me for now.
- Just me for now: the host calls `handle.setJustMe(true)` and nothing else. No command runs, no file is written and no event is appended. The next model has `placement: 'empty-chat-line'`, and team.js draws `p.team-solo` inside `#welcome`: "Working solo with your agents. Invite people any time." with Invite people and Join a team. chat.js hides `#welcome` during a conversation, so the line never shows then. The flag is cleared when a team session starts or restarts.
- Invite someone in a project with no team calls `deps.startTeam()`, which is Enable in invite mode. The connect, online-home and existing-team checks stay. Team name and your name are asked, both filled in. There is no email question and no "team is ready" message. The invite then carries on, and its one "Share and continue" puts the setup online.
- Quiet team states. An owner or lead with nobody else joined sees Invite someone, Members and Open board ("Only you so far.", or how many invited people have not joined). Once someone joined they see Members (with the waiting badge) and Open board, plus the board line. Share is added only while the setup is not online, and Check the team only while the team cannot be reached. There is no Link button and no turn-on anywhere.
- Manage Team Members lists Invite someone first for the owner and leads.
- `teamSetupSteps`: team.invite "Invite people" (optional; done once someone joined or an invite waits), then share and link. All three are skipped after Just me for now when the project has no team. A merge note for `registerSetupStep` sits above it.
- Every on-screen sentence that said Team Mode now speaks of your team, for example "Your team for X is ready.", the SOLO_TEXT pointing at Invite someone, and the join offer. `plainWords.BANNED_TERMS` includes 'Team Mode'. package.json titles are unchanged.

## Task Commits

1. **Task 1 (tracer) RED:** `73d28bc` test(61-26): expect the working-with-your-agents section, Just me for now and its quiet empty-chat line, and quiet team states
2. **Task 1 GREEN:** `24a27ff` feat(61-26): the Team section speaks of working with your agents, Just me for now leaves a quiet empty-chat line, and teams stop nagging
3. **Task 2 RED:** `fe0d122` test(61-26): expect Just me for now on the handle, Invite someone from no team in one flow, Invite someone first in Members, and no old feature name on screen
4. **Task 2 GREEN:** `8d38627` feat(61-26): Just me for now kept per project, Invite someone sets the team up on the way, Members starts with Invite someone, and the old feature name leaves the screen
5. **Task 3:** `3a30dcd` test(61-26): real windows: the lead invites from no team in one flow; the invitee says Just me, then joins from the quiet line

## TDD Gate Compliance

- **Task 1 RED:** `node --test --test-reporter=tap dist/test/teamSectionModel.test.js dist/test/teamSectionPage.test.js` exited 1: 40 tests, 15 pass, 25 fail. The target was "tracer: with no team the page draws Invite someone, Join a team and Just me for now, and Just me for now posts the solo action". It failed on its heading assertion ('Team' !== 'Working with your agents'). Classifier: RED_EVIDENCE_OK (target_test_failed). Semantic assessment: the modules loaded and compiled against a declared-only surface (stub text functions returning '', optional placement, the justMe input), so this was the planned behaviour assertion, not a load fault. A first attempt with throwing stubs made the model file fail at load; that run was not used, and the stubs were changed to return '' before the recorded RED.
- **Task 2 RED:** the same reporter over the nine Task 2 test files exited 1: 152 tests, 133 pass, 19 fail. The target was "Just me for now keeps the choice through the handle only ...". It failed on its first assertion: the parser refused `solo`. Classifier: RED_EVIDENCE_OK. Semantic assessment: the handle surface was declared only (`justMe: () => false`, `setJustMe` a no-op), so the failures are the planned behaviour. Two tests passed trivially against the stub ("a team starting clears Just me" and "Just me is ignored once the project has a team") and stay as guards.
- **Tracer feedback gate:** auto mode. The Task 1 verify was re-run after the GREEN commit and passed (51 tests, 50 pass, 1 skipped), so expansion continued.
- **Task 3:** e2e scenarios over behaviour Tasks 1 and 2 built, so there is no separate RED. The one page-test addition (the probe reports the board line) failed first (1 fail of 27), then passed once team.js reported it. It was committed with the scenarios as `test`.
- Every RED commit precedes its GREEN commit. There are no REFACTOR commits.

## Verification

| Check | Result |
|-------|--------|
| Task 1: tsc, then teamSectionModel, teamSectionPage, sidebarReadiness (4G wrapper) | exit 0, 51 tests, 50 pass, 0 fail, 1 skipped (the PR #7 parity seam) |
| Task 2: tsc, then teamSectionHost, teamCommands, teamMemberCommands, teamSessionMembers, teamPlainLanguage, teamSoloParity, teamManifest, teamInviteShare, teamJoinCommand (4G wrapper) | exit 0, 152 tests, 152 pass, 0 fail |
| Broader impacted: teamBoardSummary, teamBoardView, teamPrompts, extensionActivate, sidebarChat, sidebarReadiness, teamSectionModel, teamSectionPage | exit 0, 114 tests, 113 pass, 1 skipped |
| Task 3 / plan e2e: `npm run compile && env -u ELECTRON_RUN_AS_NODE xvfb-run -a node dist/test/e2e/run.js` (6G wrapper, timeout 1800; free memory 13 GB, no other e2e running) | exit 0, 78 tests pass, 0 fail: project 8, plain 2, team 7, team-lead 5, team-join 7, team-confirm 4, board 45 (62-23's drag scenarios included) |
| Final rerun of the Task 1 and Task 2 commands after Task 3 | exit 0: 51 (50 pass, 1 skipped) and 152 (152 pass) |
| Acceptance greps | "Working with your agents" in teamSectionText.ts: 1; "Just me for now": 2; "team-solo" in team.js: 4; JUST_ME_KEY in teamCommands.ts: line 21; startTeam in memberCommands.ts: lines 139, 563; 'Team Mode' in plainWords.ts: 1; soloLine in suite.ts: 8 |
| Invariants | no vscode import in src/team or src/domain/team; package.json unchanged since 20a9c16 |

## Existing tests changed (owner changed the flow or the words)

- `teamSectionModel.test.ts`: the state table now uses the new no-team actions and the quiet team plans. Link and turn-on are gone, a manager's status is `onlyYouStatus` / `peopleStatus` (which replace `managerStatus`), and the setup steps are invite, share, link with `skipped`.
- `teamSectionPage.test.ts`: the no-team buttons, the owner's buttons without Link, the leadWaiting fixture with people joined (Members first), the compact case uses the not-on-team state (no-team is no longer compact), and probe facts carry `soloLine`.
- `teamSectionHost.test.ts`: the tracer, the online-check action list (turn-on gone, solo added to the no-check list), the offline case (Members instead of Invite), the follows test (no-team actions), and the real lead (no Link button; Members and Open board once someone joined). The fake handles gained justMe/setJustMe.
- `teamCommands.test.ts`: the sentences without the old name (Your team for X is ready, SOLO_TEXT, the open-folder text, STILL_NOT_CONNECTED_TEXT, the commit-failed warning) and 'Set up anyway'.
- `teamMemberCommands.test.ts`: the Manage list starts with 'Invite someone' (the full-list test and the no-organization test's index).
- `teamSessionMembers.test.ts`: the join offer sentence.
- `teamSoloParity.test.ts`: SOLO_TEXT and the no-team actions (`invite, join, solo`).
- `teamManifest.test.ts`: Invite is no longer one of the "answers with SOLO_TEXT" commands in a no-team project, because it now starts the team setup. The test asserts the setup's own plain stop instead.

## Files Created/Modified

- `src/domain/team/teamSectionText.ts`: the words table. Heading, labels (solo), solo-line labels, hints, Invite people step title, noTeam/justMe/onlyYou statuses, `onlyYouStatus`, `peopleStatus`.
- `src/domain/team/teamSection.ts`: `TEAM_ACTION_IDS` (invite, join, solo, ...), `TEAM_ACTION_COMMANDS` without solo or enable, `placement`, the `justMe` input, the quiet team plans, and the new `teamSetupSteps` with the merge note.
- `media/chat/team.js`: the ACTIONS list, the `p.team-solo` line inside `#welcome` (createElement and textContent only, closure-bound clicks, removed on a section model or when the profile stops working), `soloLine` and `board` in the probe facts, and the click probe reaching a shown line action.
- `src/services/team/teamSectionHost.ts`: 'solo' handled through `handle.setJustMe(true)` (single flight, no command), `justMe` in the no-team input, the probe accepting solo.
- `src/services/team/teamCommands.ts`: `JUST_ME_KEY`, `justMe`/`setJustMe`, the flag cleared on session start and restart, Enable invite mode, `startTeam`, and every on-screen sentence reworded.
- `src/services/team/memberCommands.ts`: `startTeam` in the deps, invite from no team, the Invite someone row first for managers.
- `src/services/team/teamSession.ts`: the join offer sentence.
- `src/test/helpers/plainWords.ts`: 'Team Mode' in BANNED_TERMS.
- Tests as listed above, and `src/test/e2e/suite.ts`: the one-flow invite, Just me then join from the line, the quiet team state with the board line, and Invite someone first in Members.

## Decisions Made

See key-decisions in the frontmatter.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The host compiled against the new action list in Task 1**
- **Found during:** Task 1 (tsc over the whole project is in the Task 1 verify)
- **Issue:** `KNOWN_ACTIONS` was a Record keyed by `TeamActionId`, and `teamSectionTap.probe` took a `TeamActionId`, so the e2e suite's old `TeamActionName` stopped compiling.
- **Fix:** In Task 1 the host accepted only the command actions (turn-on gone), and the probe took a string that it checks at run time. Task 2 then added 'solo' to `KNOWN_ACTIONS` and the Just me handling.
- **Files modified:** src/services/team/teamSectionHost.ts
- **Committed in:** 24a27ff, 8d38627

**2. [Rule 1 - Owner flow change] teamSoloParity.test.ts and teamManifest.test.ts expectations**
- **Found during:** Task 2
- **Issue:** The plan says teamSoloParity.test.ts stays unchanged. It asserts the no-team actions `['turn-on', 'join']` and the old SOLO_TEXT, and teamManifest expected Invite to answer with SOLO_TEXT in a no-team project. Both describe the flow the owner replaced.
- **Fix:** Only those expectations were updated. The solo cost assertions (one fs.stat, no timer, channel, storage or extra module) are untouched and green.
- **Files modified:** src/test/teamSoloParity.test.ts, src/test/teamManifest.test.ts
- **Committed in:** fe0d122, 8d38627

**3. [Rule 2 - Test seam] The probe reports the board line**
- **Found during:** Task 3
- **Issue:** team-confirm must check "the board line when the board summary is supplied", but the probe facts did not carry it.
- **Fix:** team.js adds `board` to the facts only while the line is drawn, with a page test. Existing fact shapes are unchanged.
- **Files modified:** media/chat/team.js, src/test/teamSectionPage.test.ts
- **Committed in:** 3a30dcd

**4. [Rule 2 - Plain words] 'Turn on anyway' became 'Set up anyway'**
- **Found during:** Task 2
- **Issue:** The online-home warning now also appears from Invite someone, where nothing is turned on.
- **Fix:** The constant `TURN_ON_ANYWAY_ACTION` keeps its name and its value is 'Set up anyway'. The detail reads "You can set up your team now and share it once the project is online."
- **Committed in:** 8d38627

---

**Total deviations:** 4 auto-fixed (1 blocking, 1 owner flow change in two extra test files, 2 small additions in scope)
**Impact on plan:** Every must-have truth is proven by unit, integration and real-window tests. No production behaviour beyond the plan.

## Issues Encountered

None. One Bash call that edited a test through a Python heredoc was refused by the shell safety check (no removal was involved). The same edit was made with the Edit tool.

## Known Stubs

None.

## Threat Flags

None. The only new page-to-host message is 'solo', parsed strictly and handled only through the handle (T-61-103). Invite from no team keeps every consent prompt (T-61-104, tested). The quiet line keeps Join a team (T-61-105, proven in the e2e).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 62-24 (the Phase 62 final gate) can run; the e2e is green with every scenario.
- Merge note (main with PR #7): register team.invite ('Invite people', running the invite action) with `registerSetupStep` right after the project-team step, then team.share and team.link, using `teamSetupSteps`' done and skipped flags.
- The owner can retest 61-UAT test 9.

---
*Phase: 61-invitations-joining-removal-near-org-and-key-integration*
*Completed: 2026-11-04*

## Self-Check: PASSED

All 17 modified files exist. Commits 73d28bc, 24a27ff, fe0d122, 8d38627 and 3a30dcd are on this branch, and none deletes a file.
