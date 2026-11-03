---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 21
subsystem: team
tags: [gap-closure, G-61-5, sidebar, webview, team-section, tdd]
status: complete

requires:
  - phase: 61-17
    provides: "teamSectionModel, TEAM_ACTION_COMMANDS, TeamActionId, TeamBoardSummary, SharedView; media/chat/team.js page and its team-e2e responder"
  - phase: 61-19
    provides: "TeamModeHandle.onDidChange; nearAi.team.share"
  - phase: 61-16
    provides: "teamSetupShared (src/team/projectHome.ts)"
provides:
  - "src/services/team/teamSectionHost.ts: createTeamSectionHost, parseTeamSectionMessage, teamSectionTap, TeamSectionHost, TeamSectionHostDeps, TeamSectionMessage"
  - "NearAiPanelViewProvider.setTeamSection(host); section#team in the sidebar and team.js after chat.js"
  - "extension.ts: the host made from the registerTeamMode handle and handed to the sidebar before the view provider is registered"
  - "managerStatus(name, otherMembers, pendingInvites, waiting): the manager status says how many people wait in Members"
affects: [61-22, 61-23, 62, 63]

plan_head_before: 678e5147757fe13c6d50f9a2c728393a5c96a1d6
plan_head_after: 2701b372d11e71ee38e32f17b3dbe642ae10a680
actuals:
  tokens: 14606
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Sidebar sections are hosts with attach(webview, onDidChangeVisibility, visible) and refresh(); the provider attaches them after the chat and detaches on dispose"
    - "Refreshes are serialized; a refresh asked while one waits joins it and keeps any recheck request"
    - "A network check behind a page is throttled on an injected monotonic clock, only while the page is shown, and forced after the actions that change its answer"
    - "Page-to-host action ids are checked against a Record<TeamActionId, true> so the compiler ties the host's list to the model's without a static import"

key-files:
  created:
    - src/services/team/teamSectionHost.ts
    - src/test/teamSectionHost.test.ts
  modified:
    - src/services/panelView.ts
    - src/extension.ts
    - src/domain/team/teamSection.ts
    - src/domain/team/teamSectionText.ts
    - src/test/sidebarChat.test.ts
    - src/test/teamSoloParity.test.ts
    - src/test/teamSectionModel.test.ts

key-decisions:
  - "A team project whose session is still starting is not drawn as a passing state: the host waits for handle.ready once, then draws the session; if Team Mode did not start it shows the team by name, unreachable, with Check the team first"
  - "The online check (teamSetupShared) runs only for an owner or a lead, at most once a minute on a monotonic clock and never while the sidebar is hidden, and at once after Share, Invite, Link, Turn on and Join or refresh({recheckShared:true}); a check that throws is shown as unknown"
  - "The check uses this computer's team.json (read fresh), as Share Team Setup does, falling back to the session's"
  - "The manager status adds 'N person is / people are waiting for you in Members.' when memberAttention has items (owner rule: the sentence lives in teamSectionText.ts)"
  - "A rejected command is not reported by the host: every Team Mode command is guarded and reports its own failure; the section refreshes either way and buttons work again"
  - "The probe is a module-level teamSectionTap like boardTap; it is installed only with testSeams (default NEAR_AI_E2E === '1'), validates click against the action list, runs nothing itself, and is removed when its host is disposed"

patterns-established:
  - "Solo parity for a sidebar section: one fs.stat, no timer, process, channel, status item or storage, and only the host plus pure model modules loaded"

requirements-completed: [TEAM-02]

coverage:
  - id: D1
    description: "The NEAR AI chat sidebar shows the Team section; Turn on Team Mode runs nearAi.team.enable and every action runs only its mapped command"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/teamSectionHost.test.ts#tracer: a project with no team gets Turn on Team Mode (primary) then Join a team, and clicking Turn on Team Mode runs Enable"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionHost.test.ts#every action id runs only the command mapped to it"
        status: pass
      - kind: unit
        ref: "src/test/sidebarChat.test.ts#the sidebar has the Team section between the attention line and the conversation, and loads team.js after chat.js with the same nonce"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionHost.test.ts#extension.ts builds the host from the Team Mode handle and gives it to the sidebar before the view provider is registered"
        status: pass
    human_judgment: false
  - id: D2
    description: "The page cannot make the host run anything else (T-61-88): unknown actions, command ids, extra keys and non-objects are refused; one action at a time"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/teamSectionHost.test.ts#the page cannot make the host run anything else: unknown actions, command ids, extra keys and junk are refused"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionHost.test.ts#a second click while a team action still runs is ignored, and buttons work again once it has finished"
        status: pass
    human_judgment: false
  - id: D3
    description: "The section shows the next useful action from the running session: Share before Invite, not on the team, joined and waiting, 1 waiting until confirmed, removed, offline, display-safe names"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamSectionHost.test.ts#a real lead and joiner: Share first, then Invite; the joiner waits; the lead sees 1 waiting until they confirm"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionHost.test.ts#a removed member sees only the removed sentence and no button"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionHost.test.ts#an offline session puts Check the team first and says what the connection says"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionHost.test.ts#names from the team record are shown as safe plain text"
        status: pass
    human_judgment: false
  - id: D4
    description: "The section stays current without polling, with the online check throttled (T-61-90) and the board summary slot for Phase 62"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/teamSectionHost.test.ts#the section follows Team Mode: a handle change, a session update and a restart each post a new model"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionHost.test.ts#the online check runs at most once a minute when the sidebar is shown, and right after a share, invite, link, turn-on or join"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionHost.test.ts#the online check runs only for the owner or a lead: a developer never calls it"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionHost.test.ts#the board summary slot: shown when the provider gives counts, and absent when it gives nothing"
        status: pass
    human_judgment: false
  - id: D5
    description: "The e2e probe exists only under NEAR_AI_E2E=1 (T-61-91), and a project without a team pays one fs.stat for the section"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/teamSectionHost.test.ts#without NEAR_AI_E2E exactly 1 there is no probe, and facts from the page are ignored"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionHost.test.ts#under NEAR_AI_E2E=1 the probe asks the page what it drew, may ask it to click a drawn button, and the answer is kept"
        status: pass
      - kind: integration
        ref: "src/test/teamSoloParity.test.ts#solo project: the sidebar Team section costs one fs.stat and no timer, channel, status item, storage, git or team core module"
        status: pass
    human_judgment: false
  - id: D6
    description: "The Team section looks right and works in a real NEAR AI sidebar (theme, button row, refresh on show, the buttons opening the real flows)"
    verification: []
    human_judgment: true
    rationale: "Unit tests drive the host with a stub webview; the real-window check (Chromium page plus host) is the e2e scenario of 61-22 and the owner's hands-on review"

duration: 11 min
completed: 2026-11-03
---

# Phase 61 Plan 21: Sidebar Team Section Host Summary

**The NEAR AI chat sidebar now has a live Team section: a host feeds the 61-17 model from the running team session (Share before Invite, join, waiting, "1 waiting" on Members, removed, offline), runs only the Team Mode command mapped to a clicked button, refreshes on Team Mode and session changes, after its own buttons and when shown, and checks the online setup at most once a minute for owners and leads.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-11-03T23:08:27Z
- **Completed:** 2026-11-03T23:19:15Z
- **Tasks:** 3 (tracer, two auto), each RED then GREEN
- **Files modified:** 9 (2 created, 7 modified)

## Accomplishments

- G-61-5 host half: `createTeamSectionHost` builds the model input from the session (display-safe team name, role and pending role, removed, owner or lead from the `member.invite` decision, `memberAttention` count, unused invites, other members, organization link, connection text) and posts `{type:'team-state', model}`; no user text lives in the host.
- `parseTeamSectionMessage` accepts exactly `{type:'team-action', action}` with a known id (and `team-e2e-facts` with a finite id); the command comes only from `TEAM_ACTION_COMMANDS`; a second click while a command runs is ignored.
- Refresh triggers: `handle.onDidChange` (start, restart, Enable, stop), the session's `onStateChange` (re-followed when a restart brings a new session), the host's own actions, the sidebar becoming visible, and the page's `chat-ready` is not needed because posts after the html are buffered by VS Code.
- `teamSetupShared` check only for owners and leads, throttled to once a minute on a monotonic clock while shown, forced after Share, Invite, Link, Turn on and Join.
- Board summary slot (`boardSummary` provider) ready for Phase 62.
- Sidebar: `section#team` (role region, aria-label Team, hidden) between `#needs-you` and `#transcript`, `team.js` after `chat.js` with the same nonce; `setTeamSection` and attach after the chat; wired in extension.ts and disposed with the extension.
- e2e probe `teamSectionTap.probe` only under `NEAR_AI_E2E=1`; solo parity proven for the sidebar.

## Task Commits

1. Task 1 (tracer) RED: `9fb8d64` test(61-21): expect the sidebar Team section for a project with no team, and Turn on Team Mode to run Enable
2. Task 1 GREEN: `fa7db9c` feat(61-21): put the Team section in the NEAR AI sidebar; Turn on Team Mode runs Enable
3. Task 2 RED: `23d333d` test(61-21): expect the Team section to follow the running team session, the throttled online check and the board slot
4. Task 2 GREEN: `232c0d6` feat(61-21): the Team section follows the running team session, with a throttled online check and the board slot
5. Task 3 RED: `a5965e1` test(61-21): expect the Team section probe only under NEAR_AI_E2E=1, and a solo sidebar to cost one fs.stat
6. Task 3 GREEN: `2701b37` feat(61-21): the Team section e2e probe, only under NEAR_AI_E2E=1

## TDD Gate Compliance

- Task 1 RED: `node --test --test-reporter=tap dist/test/teamSectionHost.test.js dist/test/sidebarChat.test.js`, exit 1, 15 tests, 6 fail; target "tracer: a project with no team ..." failed on "a team-state was posted on attach" against the declared-only host. Classifier: RED_EVIDENCE_OK (target_test_failed). Semantic assessment: module compiled and loaded; behaviour absent.
- Task 2 RED: same reporter over teamSectionHost and teamSectionModel, exit 1, 24 tests, 9 fail; target "the online check runs only for the owner or a lead ..." failed because the solo-only host showed no team; the real lead test failed on `'turn-on' !== 'share'`. Classifier: RED_EVIDENCE_OK. The single-flight test already passed (Task 1 built it) and stays as a guard.
- Task 3 RED: teamSectionHost and teamSoloParity, exit 1, 26 tests, 1 fail; target "under NEAR_AI_E2E=1 the probe ..." failed on "the probe is offered". Classifier: RED_EVIDENCE_OK. The solo parity tests already passed because Tasks 1 and 2 kept to the solo rule (kept as regression guards).
- Tracer feedback gate: auto mode, Task 1 verify re-run passed (15/15), expansion continued.
- Every RED commit precedes its GREEN commit; no REFACTOR commits.

## Verification

- Task 1 command: exit 0, 15 tests, 15 pass.
- Task 2 command (tsc, teamSectionHost, teamSectionModel): exit 0, 24 tests, 24 pass.
- Task 3 command (tsc, teamSectionHost, teamSoloParity, extensionActivate, teamPlainLanguage, sidebarChat): exit 0, 44 tests, 44 pass.
- Broader impacted run, every `dist/test/team*.test.js` plus sidebarChat and extensionActivate (MemoryMax=6G): 1086 tests, 1082 pass, 2 fail, 2 skipped (pre-existing). The 2 failures are the known deferred self-import tests (teamGsdImport "every plan committed at HEAD parses ..." and teamImport "this repository's own .planning at HEAD imports ...", deferred to 61-22); not touched.
- Acceptance: `setTeamSection` in extension.ts (73) and panelView.ts (22); `team.js` in panelView.ts (132); `grep -c "^test(" src/test/teamSectionHost.test.ts` 16; `teamSetupShared` in the host; `NEAR_AI_E2E` in the host; `teamSectionHost` in teamSoloParity.test.ts.

## Decisions Made

See key-decisions in the frontmatter.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing functionality] The manager status names the people waiting**
- **Found during:** Task 2
- **Issue:** The plan's behaviour says after a join "the next model has members with the badge '1 waiting' and status mentions it", but the 61-17 model's manager status did not use the waiting count, and the owner rule keeps all words in teamSectionText.ts.
- **Fix:** `managerStatus` takes an optional `waiting` count and adds "1 person is waiting for you in Members." (or "N people are ..."); `teamPlan` passes `team.waiting`. The existing model case "a lead with a shared setup and 2 people waiting" now expects that sentence, and a new model test pins both wordings.
- **Files modified:** src/domain/team/teamSectionText.ts, src/domain/team/teamSection.ts, src/test/teamSectionModel.test.ts
- **Verification:** teamSectionModel 10/10, teamPlainLanguage pass, the real lead test sees the sentence and loses it after Confirm.
- **Committed in:** 23d333d (signature), 232c0d6 (sentence)

**2. [Rule 2 - Correctness] Wait for a starting session instead of drawing a passing state**
- **Found during:** Task 2
- **Issue:** On window open the sidebar can attach before `handle.ready`; with team.json present and no session yet the section would show a wrong state.
- **Fix:** with team.json present and no session the host awaits `handle.ready` once; if Team Mode still has no session (start failed) it shows the team by name as unreachable with Check the team first.
- **Files modified:** src/services/team/teamSectionHost.ts
- **Committed in:** 232c0d6

---

**Total deviations:** 2 auto-fixed (2 missing functionality/correctness)
**Impact on plan:** Both needed for the stated behaviour; no scope creep. src/domain/team/teamSection.ts and teamSectionText.ts were outside the plan's file list.

## Known Stubs

- `boardSummary` is not passed in extension.ts yet, so the board line is absent; this is the planned slot for Phase 62's board fix (documented in the plan's objective).

## Threat Flags

None. The only new trust boundary (sidebar page to host) is the one in the plan's threat model; T-61-88, T-61-89, T-61-90 and T-61-91 are each covered by a test listed in coverage.

## Issues Encountered

None. The deferred failures from 61-15 and 61-16 were not touched; the load-sensitive teamSession test passed in this run.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 61-22 can drive the real sidebar in the extension-host tests: `require` the compiled `services/team/teamSectionHost` and call `teamSectionTap.probe({ id, click? })`, then read `teamSectionTap.facts` (heading, status, actions with id, label and badge, error when a click was refused).
- Phase 62 can pass `boardSummary: () => ({ ready, blocked, mine })` to `createTeamSectionHost` in extension.ts and call `host.refresh()` when the board changes.
- SETUP-01 can reuse `teamSetupSteps` with the same input the host builds.

---
*Phase: 61-invitations-joining-removal-near-org-and-key-integration*
*Completed: 2026-11-03*
