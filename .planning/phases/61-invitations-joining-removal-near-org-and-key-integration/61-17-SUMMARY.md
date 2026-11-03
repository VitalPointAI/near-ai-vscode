---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 17
subsystem: team
tags: [gap-closure, G-61-5, sidebar, webview, accessibility, tdd]
status: complete

requires:
  - phase: 61-14
    provides: "fix-pass baseline; Role type, memberAttention and boardStatus kinds the model input mirrors"
provides:
  - "src/domain/team/teamSection.ts: teamSectionModel, teamSetupSteps, TEAM_ACTION_IDS, TEAM_ACTION_COMMANDS, isTeamActionId and the TeamSectionInput, TeamSectionModel, TeamSectionAction, TeamSetupStep, TeamBoardSummary, SharedView types"
  - "src/domain/team/teamSectionText.ts: every Team section label, hint, setup title and sentence"
  - "media/chat/team.js: the sidebar Team section renderer (team-state in, team-action out) and the team-e2e probe responder; window.nearTeam.render"
  - "media/chat/chat.js: window.nearChat = Object.freeze({ post })"
  - "fakeDom harness options scripts:'chat', teamSection, nearChat"
affects: [61-19, 61-21, 61-22, 61-24, 62, 63]

actuals:
  tokens: 14048
  tasks: 3
  commits: 6
plan_head_before: de5a4b924533e2a30d43cccf3821d711bfd5fa55
plan_head_after: a5b76ddf635541b4875a270ceebecff1e80694ab

tech-stack:
  added: []
  patterns:
    - "Pure section model (state in, heading, status, ordered actions out) with every word in a *Text.ts table"
    - "Primary action first, the rest in TEAM_ACTION_IDS order, so buttons never jump between states"
    - "Page buttons keyed by action id and updated in place; the posted id is bound in the click closure from the page's own ACTIONS list"

key-files:
  created:
    - src/domain/team/teamSection.ts
    - src/domain/team/teamSectionText.ts
    - media/chat/team.js
    - src/test/teamSectionModel.test.ts
    - src/test/teamSectionPage.test.ts
  modified:
    - media/chat/chat.js
    - media/chat/chat.css
    - scripts/verify-release-content.mjs
    - src/test/helpers/fakeDom.ts

key-decisions:
  - "Offline or paused makes Check the team the one primary action and the status the connection text (ending in a full stop); every other action of the state stays offered as secondary"
  - "While the team setup is not shared (no, or not reachable by teammates) a manager gets Share instead of Invite someone, since invites cannot work yet"
  - "A team this computer is not on gets Join a team (primary) and Open board; joined and waiting gets Open board only; removed gets no action and no board summary"
  - "compact is true for no team, not on the team, waiting and removed (status and buttons only, heading hidden); false for confirmed members and managers"
  - "Setup steps: turn-on and share are required, invite (just me for now) and link are optional; invite counts as done with a pending invite or another member"
  - "The page answers team-e2e without its own gate: the host (61-21) sends the probe only under NEAR_AI_E2E=1, and a probe can only click a button that is drawn"

patterns-established:
  - "Sidebar modules post through window.nearChat (chat.js's frozen post), never call acquireVsCodeApi or setState themselves"

requirements-completed: [TEAM-02]

coverage:
  - id: D1
    description: "Pure Team section model: every state gives heading, status, one primary action and ordered actions, with the waiting badge, board slot and setup steps"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/teamSectionModel.test.ts#every state gives its heading, status, primary action and ordered actions"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionModel.test.ts#exactly one action is primary in every state that has actions, it comes first, and the rest keep the action id order"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionModel.test.ts#the setup steps: none done with no team, and a shared, invited, unlinked team has only the optional link left"
        status: pass
    human_judgment: false
  - id: D2
    description: "Sidebar page draws the model as real labelled buttons and posts only {type:'team-action', action} for the fixed id list"
    requirement: TEAM-02
    verification:
      - kind: automated_ui
        ref: "src/test/teamSectionPage.test.ts#tracer: with no team the page draws Turn on Team Mode and Join a team as buttons, and a click posts one fixed team-action"
        status: pass
      - kind: automated_ui
        ref: "src/test/teamSectionPage.test.ts#a click posts the id bound when the button was drawn, even if the DOM is altered, and an unknown action id is never drawn"
        status: pass
    human_judgment: false
  - id: D3
    description: "Accessibility and page details: badge and accessible name, polite live status updated in place, board line, compact layout, e2e probe"
    requirement: TEAM-02
    verification:
      - kind: automated_ui
        ref: "src/test/teamSectionPage.test.ts#Members with a waiting count shows the badge in its own element and says it in the accessible name; the primary button comes first"
        status: pass
      - kind: automated_ui
        ref: "src/test/teamSectionPage.test.ts#the e2e probe answers what is drawn, clicks a drawn button through the normal handler, and refuses an action that is not drawn"
        status: pass
    human_judgment: false
  - id: D4
    description: "The Team section looks right and reads well in a real sidebar (theme colours, button row, compact vs full)"
    verification: []
    human_judgment: true
    rationale: "The section is not inserted into the sidebar until 61-21; the visual check in a real window belongs to the owner's hands-on review after that plan"

duration: 8 min
completed: 2026-11-03
---

# Phase 61 Plan 17: Sidebar Team Section Model and Page Summary

**A pure Team section model turns the project and computer state into one heading, one plain status and state-driven buttons with exactly one primary next action (Turn on Team Mode, Join a team, Share, Invite someone, Members with its waiting count, Open board, Link your organization, Check the team), and media/chat/team.js draws it as real sidebar buttons that post only a fixed team-action id.**

## Performance

- Duration: 8 min (2026-11-03T21:45:14Z to 2026-11-03T21:52:44Z)
- Tasks: 3 (tracer, two auto), each RED then GREEN
- Files: 5 created, 4 modified

## Accomplishments

- G-61-5 page half: `teamSectionModel` covers no folder, no team, not on the team, joined and waiting, confirmed member, manager not shared, manager not reachable, manager ready (shared yes, unknown or unchecked), linked, removed, offline and paused.
- `TEAM_ACTION_IDS` and `TEAM_ACTION_COMMANDS` map the eight buttons to `nearAi.team.enable`, `join`, `share`, `invite`, `manageMembers`, `openBoard`, `linkNearOrganization`, `verifyLog`; `isTeamActionId` is ready for the host parser of 61-21.
- Board slot for Phase 62 (`board` only when supplied, Open board in every team state except removed) and `teamSetupSteps` for SETUP-01 (plain data, no 0.4.14 code).
- `media/chat/team.js`: createElement and textContent only, buttons updated in place by id (focus survives an update), the primary first and described by the status, badge in its own element with the accessible name "Members, 2 waiting", polite live status, board line, compact layout, team-e2e probe.
- `chat.js` exposes `window.nearChat`; `#team` styles in chat.css use theme variables only; team.js is on the release content list.

## Task Commits

1. Task 1 (tracer) RED: `fee01d0` test(61-17): expect the sidebar Team section to draw state-driven buttons that post one fixed action
2. Task 1 GREEN: `698a81a` feat(61-17): draw the Team section for no team and for a lead as sidebar buttons
3. Task 2 RED: `60ea56b` test(61-17): expect every Team section state, the waiting badge, the board slot and the setup steps
4. Task 2 GREEN: `099f5c3` feat(61-17): give every Team section state its next action, waiting badge, board slot and setup steps
5. Task 3 RED: `59ac5a5` test(61-17): expect the Team section page's badge, live status, board line, compact layout, e2e probe and asset safety
6. Task 3 GREEN: `a5b76dd` feat(61-17): finish the Team section page with badge, live status, board line, compact layout and e2e probe

## TDD Gate Compliance

- Task 1 RED: `node --test --test-reporter=tap dist/test/teamSectionPage.test.js`, exit 1, 5 tests, 5 fail; target "tracer: with no team the page draws ..." failed with "not implemented" from the declared-only model. Classifier: RED_EVIDENCE_OK (target_test_failed). Semantic assessment: module compiled and loaded; behaviour absent, not a load or syntax fault.
- Task 2 RED: `node --test --test-reporter=tap dist/test/teamSectionModel.test.js`, exit 1, 9 tests, 4 fail; target "every state gives its heading, status, primary action and ordered actions" failed on its first state assertion (a team this computer is not on got the lead's status). Classifier: RED_EVIDENCE_OK. Semantic assessment: planned assertion, only the Task 1 states existed.
- Task 3 RED: `node --test --test-reporter=tap dist/test/teamSectionPage.test.js`, exit 1, 16 tests, 6 fail; target "the e2e probe answers what is drawn ..." failed on its first deepEqual (no facts posted). Classifier: RED_EVIDENCE_OK. Semantic assessment: responder absent; the other failures were the badge, live status, board line, compact layout and the missing styles and release entry. The closure-bound click, markup-as-text and asset-sink tests already passed because Task 1's page was built that way (kept as regression guards).
- Tracer feedback gate: auto mode, Task 1 verify re-run passed (16/16), expansion continued.
- Every RED commit precedes its GREEN commit; no REFACTOR commits.

## Verification

- Task 1 command (tsc, then teamSectionPage, sidebarChat, fakeDom tests): exit 0, 16 tests, 16 pass.
- Task 2 command (tsc, then teamSectionModel, teamSectionPage, teamPlainLanguage tests): exit 0, 17 tests, 17 pass (before Task 3 tests were added).
- Task 3 command (tsc, then teamSectionPage, teamSectionModel, sidebarChat, teamBoardAssets tests, MemoryMax=4G): exit 0, 43 tests, 43 pass, 0 fail.
- Broader impacted check, every test using the fake DOM harness, media/chat or the release list (boardForm, sidebarChat, agentBasics, boardClient, boardDrag, fakeDom, teamSectionPage, teamBoardAssets, boardMenu, boardDetail): 140 tests, 140 pass.
- Acceptance: `grep -n "window.nearChat" media/chat/chat.js` one line (8); vscode imports in teamSection.ts and teamSectionText.ts: 0 and 0; `grep -c "^test(" src/test/teamSectionModel.test.ts` 9; `export function teamSetupSteps` present; `extension/media/chat/team.js` on the release list (line 73); markup sink and fetch grep on team.js: 0. A manual grep of teamSectionText.ts and team.js for the plain-language banned terms and "NEAR organization" found none.

## Decisions Made

See key-decisions in the frontmatter. In short: offline or paused puts Check the team first; Share replaces Invite someone while the setup cannot be reached; compact for the simple states; setup steps mark invite and link optional.

## Deviations from Plan

None - plan executed exactly as written. (Additions within the plan's scope: the hint is the button tooltip, a markup-looking team name test, and a test that team.js's ACTIONS list equals TEAM_ACTION_IDS.)

## Known Stubs

None that block this plan's goal. Planned wiring owned by later plans: `TEAM_ACTION_COMMANDS.share` names `nearAi.team.share`, which 61-19 contributes and registers; the `section#team` element, loading team.js after chat.js, the team-state feed and the team-action parser are 61-21.

## Issues Encountered

None. The deferred failures from 61-15 and 61-16 (teamGsdImport and teamImport self-import, the load-sensitive teamSession test) were not touched; no full team run was needed for this surface.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 61-21 can insert `<section id="team" role="region" aria-label="Team" hidden>` between #needs-you and #transcript, load team.js after chat.js, send `{type:'team-state', model}` from `teamSectionModel`, and parse `{type:'team-action', action}` with `isTeamActionId` and `TEAM_ACTION_COMMANDS`.
- Phase 62 can fill `board` with ready, blocked and mine counts; SETUP-01 can adopt `teamSetupSteps`.
- 61-24 should add `src/domain/team/teamSectionText.ts` and `media/chat/team.js` to the plain-language scan (by *Text.ts discovery for the first).

---
*Phase: 61-invitations-joining-removal-near-org-and-key-integration*
*Completed: 2026-11-03*

## Self-Check: PASSED

All 5 created files exist; commits fee01d0, 698a81a, 60ea56b, 099f5c3, 59ac5a5 and a5b76dd are on this branch; no file deletions.
