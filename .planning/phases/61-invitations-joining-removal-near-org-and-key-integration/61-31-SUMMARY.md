---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 31
subsystem: testing
tags: [team-mode, e2e, connect-screen, join, ask-to-join, saved-profile, gap-closure, G-61-9]

requires:
  - phase: 61-30
    provides: "The Connect screen's team part (model.connect, the probe's connect facts and clicks), the own-key pick of Join Team, USE_SAVED_PROFILE_COMMAND"
  - phase: 61-29
    provides: "Ask to Join a Team, Accept a request in Members, the automatic join and automatic confirm"
  - phase: 61-27
    provides: "Use a saved profile (a profile set up in another project, used by reference)"
provides:
  - "src/services/savedProfileUi.ts: Use a saved profile's pick and messages through teamPrompts, so the e2e script can answer them"
  - "The invite launch with a third window: the requester's copy and window (team-ask) after the invitee's, and team-accept in the lead's window"
  - "team-join from the Connect screen with no profile and a saved profile from another folder"
  - "Just me for now and Invite people on the quiet line in the lead's window"
  - "The 61-VALIDATION.md rows for 61-27 to 61-31 after one full gate"
affects: [61-uat-retest, 62.1, setup-next-steps-merge, 0.4.15]

actuals:
  tokens: 14200
  tasks: 3
  commits: 4
plan_head_before: 5be81b14e8c91b7b072136c093208224ce7c0d16
plan_head_after: c3a8ab48f0dbe82cd52572dac0c19155f88b6a85

tech-stack:
  added: []
  patterns:
    - "A prompt that a team flow can reach (even one owned by a solo command, such as Use a saved profile) goes through teamPrompts, so the e2e script answers it and assertPlain scans it; outside the extension-host tests it is the same VS Code call as before"
    - "A third e2e window is chained after the second, never beside it: the lead's window runs throughout, so at most two windows run at once"
    - "Reading the team online in a long wait polls every 3 seconds (until's everyMs), and each read's mirror folder is removed with the window's temporary folders"

key-files:
  created:
    - src/services/savedProfileUi.ts
    - src/test/savedProfileUi.test.ts
  modified:
    - src/extension.ts
    - src/test/e2e/run.ts
    - src/test/e2e/suite.ts
    - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-VALIDATION.md

key-decisions:
  - "Use a saved profile's pick, ready message and error go through teamPrompts (Rule 3): Join Team runs that command after joining, and its own VS Code pick could not be answered in a real window, so the join never finished. Outside the extension-host tests nothing changes."
  - "The invitee's window now starts with no profile, so Just me for now moved to the lead's window. The lead's invite now starts from the quiet line's Invite people, which also proves that setting up a team clears Just me for now."
  - "The requester's window opens even if the invitee's failed, so the lead's window is never left waiting for a request; the invitee's failure still fails the run."

patterns-established:
  - "E2E helpers: kit.connectScreen(what, predicate) waits for the Connect screen's team part; kit.saveProfileElsewhere(api, name) puts a working profile in another folder's saved list"

requirements-completed: [TEAM-02]

coverage:
  - id: D1
    description: "In a real window with no profile, the invitee chooses Join a team on the Connect screen, pastes the invite, picks Use a saved profile and the profile set up in another folder. The copy is brought up to date, the saved profile becomes this project's working profile, the Connect screen gives way to the chat, and the Team section says a lead confirms them."
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/savedProfileUi.test.ts#tracer: under the extension-host tests a script picks the saved profile and the closing message is recorded, and VS Code is not asked"
        status: pass
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[team-join] Join a team on the Connect screen with the pasted invite brings the copy up to date, joins, and Use a saved profile makes that profile this project's"
        status: pass
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[team-join] the Connect screen gives way to the chat, and the Team section says a lead confirms them, with nothing to invite"
        status: pass
    human_judgment: false
  - id: D2
    description: "In a real window with no profile and a copy made before the team existed, the person chooses Ask to join on the Connect screen. The copy is brought up to date and the request is shown once with Copy request and its check code. The lead accepts it in Members. The requester's computer joins by itself, the lead's computer confirms them by itself, and the requester's Connect screen then says they need their own key or a saved profile."
    requirement: TEAM-02
    verification:
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[team-ask] Ask to join on the Connect screen brings the copy up to date and shows the request once, with Copy request and its check code"
        status: pass
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[team-accept] a request to join arrives from a person without an invite, and Members accepts it after its check code, as a developer with 0 dollars for seven days"
        status: pass
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[team-ask] once the lead accepts, this computer joins by itself, once, and the lead's computer confirms it as a developer by itself"
        status: pass
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[team-ask] the Connect screen then says this team has no organization, so this person needs their own key or a saved profile"
        status: pass
    human_judgment: false
  - id: D3
    description: "No sentence in any of the three windows has a git word, 'NEAR organization' or 'Team Mode', and no prompt is left unanswered. The invite and request texts are not left on disk."
    requirement: TEAM-02
    verification:
      - kind: e2e
        ref: "src/test/e2e/suite.ts#every prompt ... was answered and spoke plain words (team-lead, team-join, team-confirm, team-ask, team-accept)"
        status: pass
      - kind: other
        ref: "run.ts finally: 'The handoff folder with the invite text and the request text is removed.'"
        status: pass
    human_judgment: false
  - id: D4
    description: "The owner repeats 61-UAT test 10 in code-server: joining a team with its organization linked (the team key becomes the profile once confirmed), Ask to join, and Use a saved profile from another project"
    requirement: TEAM-02
    verification:
      - kind: manual_procedural
        ref: "61-31-SUMMARY.md#Owner re-test (61-UAT test 10)"
        status: unknown
    human_judgment: true
    rationale: "The organization-linked path (the team key delivered as the profile) runs only against the fake NEAR in unit tests. The real panel and real organization need the owner's hands-on check."

duration: 58min
completed: 2026-11-04
status: complete
---

# Phase 61 Plan 31: Connect-screen join, Ask to join and the gate Summary

**Real windows on a hidden screen now prove all of G-61-9.** A person with no profile can join from the Connect screen and use a profile they set up elsewhere. A person with no invite can ask to join; the lead accepts in Members, and both computers finish the join by themselves. The full gate passed once.

## Performance

- **Duration:** about 58 min
- **Started:** 2026-11-04T22:06:21Z
- **Completed:** 2026-11-04T23:04:00Z
- **Tasks:** 3
- **Files:** 2 created, 4 modified

## Accomplishments

- **The saved-profile prompts can be scripted.** `savedProfileUi.ts` holds Use a saved profile's pick, progress and messages. The pick and messages now go through `teamPrompts`, so the e2e script answers them and the plain-words scan reads them. Outside the extension-host tests they are the same VS Code calls with the same options. `extension.ts` uses the module.
- **team-join starts with no profile.** The window:
  1. sees no Team section, and a Connect block (not inside a panel) with Join a team and Ask to join;
  2. gets a working profile in another temporary folder, which the saved list then offers;
  3. joins from the Connect screen with the script: the invite, the name, Use a saved profile, and the profile's name.
  
  The copy is brought up to date and the saved profile becomes this project's profile (valid, key by reference). The Connect screen gives way to the Team section, which says a lead confirms them.
- **Just me for now moved to the lead's window.** The quiet line is checked there, and the lead's invite now starts from the line's Invite people. Setting the team up clears Just me for now and brings the section back.
- **run.ts** makes a second copy for the requester (E2E Requester, no `.planning/.near-ai`). Its window (team-ask) opens after the invitee's has closed. The lead's window runs team-lead, team-confirm and team-accept throughout, so at most two windows run at once. The handoff folder holds the invite and the request and is removed in `finally`.
- **team-ask:**
  1. The Connect screen offers Join a team and Ask to join.
  2. Ask to join brings the copy up to date and shows the request once, in a modal with Copy request and the check code. The clipboard holds the request.
  3. The Connect screen shows Show my request and says the request waits for a lead.
  4. The computer joins by itself, exactly once.
  5. The lead's computer confirms the requester as a developer.
  6. The Connect screen then gives the own-key sentence for a team without an organization.
- **team-accept** (the lead's window):
  1. Members, Accept a request, paste.
  2. The check modal with Continue, the same check code and "Email: none given".
  3. The email, Developer, 0 dollars, 7 days.
  4. The team record online shows the invitation for the request's member id.
  5. The lead's computer then confirms the requester by itself, with no question asked; the section says 3 people.
- **Suite helpers:**
  - `until` takes a poll interval.
  - Online reads poll every 3 seconds, and their mirror folders are removed with the window's temporary folders.
  - `assertPlain` leaves request lines out of the scan, like invite lines (both are codes).
- **61-VALIDATION.md:** rows for every task of 61-27 to 61-31, plus the gate's numbers.

## Task Commits

1. **Task 1 (tracer) RED:** `83de689` test(61-31): the invitee with no profile joins from the Connect screen and uses a saved profile; Use a saved profile's prompts are scriptable (RED)
2. **Task 1 GREEN:** `267530a` feat(61-31): Use a saved profile's pick and messages go through the join's prompts, so a person joins with a saved profile in a real window (GREEN)
3. **Task 2:** `3ce57ac` test(61-31): Ask to join from a behind copy in a third window, accepted in Members, joined and confirmed by themselves
4. **Task 3:** `c3a8ab4` docs(61-31): the verification map for 61-27 to 61-31 after the full gate

## TDD Gate Compliance

**Task 1 RED**
- Run: `node --test --test-reporter=tap dist/test/savedProfileUi.test.js`, exit 1; 2 tests, 1 pass, 1 fail.
- Target: "tracer: under the extension-host tests a script picks the saved profile...". It failed on the outcome: expected 'ready', actual 'cancelled'. The pick went to VS Code's own pick, which nothing answered.
- Classifier: RED_EVIDENCE_OK (target_test_failed). The record is in `.vscode-test/red/61-31-task1.json`, which git ignores.
- Semantic assessment: the test compiled and ran, and it failed on the planned behaviour, not on a load or fixture fault. The other test (VS Code's own pick outside the tests) passed at RED, as a regression guard for the moved code.
- No e2e was run at RED: without the fix, the join would wait on a pick nobody can answer.

**Task 1 GREEN and tracer gate (auto mode)**
- The related unit tests passed: savedProfileUi, profileIndex, profileStore, teamPrompts, teamSoloParity, teamJoinCommand and teamPlainLanguage, 58 of 58.
- The tracer's verify (the invite e2e) then passed end to end: 16 of 16 (team-lead 6, team-join 6, team-confirm 4), exit 0.
- Expansion continued.

**Task 2**
- The new team-ask and team-accept tests passed on their first run: 25 of 25 invite tests, exit 0. The behaviour already existed from 61-28 to 61-30, so no production change and no GREEN commit were needed. The tests stay as the real-window proof of G-61-9. This is the same as the tests that passed at RED in 61-29.

## Verification

- **Task 1 focused e2e** (`NEAR_AI_E2E_ONLY=invite`, xvfb-run, DISPLAY, WAYLAND_DISPLAY and XDG_SESSION_TYPE unset, MemoryMax=6G with choom): exit 0, 16 of 16.
- **Task 2 focused e2e:** exit 0, 25 of 25:
  - team-lead 6, team-join 6, team-confirm 4, team-ask 6, team-accept 3;
  - "The handoff folder with the invite text and the request text is removed."
- **`npm run check`** (lint plus the full `npm test`, pinned hashes included): exit 0. 2044 tests: 2033 pass, 0 fail, 11 skipped (the existing skips).
- **Whole e2e** (no NEAR_AI_E2E_ONLY): exit 0, 99 of 99:
  - project 8, plain 2, team 7, team-lead 6, team-join 6, team-confirm 4, team-ask 6, team-accept 3, board 57.
  - The board launch passed, so no board rerun was needed.
- **`npm run verify:release`:** exit 0, "Release content verified: 281 entries, 195 runtime JavaScript files, and 52 required release assets", no ERROR. The packaged .vsix is git-ignored.
- **Invariant:** exit 0. No vscode import in src/team or src/domain/team. validate.ts, canonical.ts, invite.ts, eventLog.ts, inviteBundle.ts, inviteCode.ts, identity.ts and keySeal.ts are unchanged since 195c30a.
- **Acceptance greps:**
  - "Use a saved profile" is in suite.ts.
  - "team-ask" is in run.ts (2) and suite.ts (1).
  - 61-VALIDATION.md now has 16 matches for 61-27 to 61-31 (it had 0 at HEAD).
- **Privacy (T-61-121):** the handoff folder is removed in `finally`, and the run reports it gone. The request holds no secret, and the invite holds only its single-use code.

## Decisions Made

See key-decisions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Use a saved profile could not be answered in a real window**
- **Found during:** Task 1
- **Issue:** Join Team runs `nearAi.useSavedProfile` after the join, and that command showed VS Code's own pick and messages. No script could answer them, so in a real window the join waited forever on the pick. Its awaited "is ready" message could also wait until it was dismissed.
- **Fix:**
  - New `src/services/savedProfileUi.ts`, which uses `teamPrompts` for the pick, the ready message and the error.
  - `extension.ts` uses it.
  - Production behaviour is the same (same calls and options), and a unit test pins that.
  - teamPrompts imports only vscode, and extension.ts already loads it through teamCommands.
- **Files:** src/services/savedProfileUi.ts, src/extension.ts, src/test/savedProfileUi.test.ts
- **Commits:** 83de689, 267530a

**2. [Rule 3 - Blocking] The Just me for now e2e check moved to the lead's window**
- **Found during:** Task 1
- **Issue:** Just me for now needs a working profile, and the invitee's window now starts without one.
- **Fix:**
  - The check moved to the lead's window, unchanged.
  - The lead's invite starts from the quiet line, which adds checks that the section comes back and that Just me for now is cleared.
  - No assertion was removed or weakened.
- **Commit:** 83de689

**3. [Rule 2 - Correctness] The online-read mirrors were left in the temp folder**
- **Found during:** Task 2
- **Issue:** `readLog` made a new mirror folder on each call and never removed it. The long waits added here would have made hundreds of them.
- **Fix:**
  - Long waits poll every 3 seconds.
  - Each mirror is added to the window's temporary folders, which are removed at the end.
  - The cleanup line now says "temporary folders removed".
- **Commit:** 3ce57ac

### Plan wording versus code

- The plan calls the check dialog's button Accept. The code's button is Continue (61-29), and the test answers Continue.

---

**Total deviations:** 3 auto-fixed (2 blocking, 1 correctness).
**Impact on plan:** one small production module, with the same behaviour outside the extension-host tests. No new dependency, and no team core change.

## Issues Encountered

None in the product. All runs passed on their first attempt after the Task 1 fix.

## Known Limitations

- The 61-29 limits still apply: an automatic completion is retried at most every 5 minutes, and a freshly opened window joins on its second sync. The e2e nudges the session, so it does not wait for the timer.
- The path through PR #7's panel is still tested only against a fake of its markup. The sidebarReadiness parity skip turns on once main is merged in.
- The organization-linked path (the team key becomes the profile once confirmed) is covered only by unit tests against the fake NEAR. The e2e team has no organization.

## Owner re-test (61-UAT test 10, in code-server)

On the scratch project:
1. **Join with an organization linked.** In a fresh copy with no profile, choose Join a team on the Connect screen. Paste an invite from a team whose organization is linked. Once the lead confirms you, the team key becomes the profile and the chat opens, with no key entered. Check that the sidebar refreshes by itself, without a reload.
2. **Ask to join.** In a copy with no invite and no profile, choose Ask to join and copy the request. On the lead's computer, open Members, choose Accept a request, paste it and check the code. Then:
   - the requester's computer joins by itself (with NEAR AI open there), and the lead's computer confirms them by itself;
   - in a team without an organization, the requester's Connect screen then says they need their own key or a saved profile.
3. **Use a saved profile.** In another project, choose Use a saved profile and pick the profile from the first project. The project is ready without entering the key again.
4. Also look at the Connect block's layout in the real sidebar. Only the fake DOM and these hidden-screen runs have checked it.

## Next Phase Readiness

- **61-27** (Use a saved profile) can be taken to main for 0.4.15 on its own. It changes only the profile store, the profile index and the Select Profile / Use a Saved Profile commands. The new `savedProfileUi.ts` imports teamPrompts, so it belongs with the Team Mode merge, not with a 0.4.15 cherry-pick of 61-27. That cherry-pick keeps extension.ts's inline UI.
- **For Phase 62.1:**
  - This plan changed no media/board file, and the board launch passed (57 of 57).
  - In the e2e, the lead's window now runs team-accept after team-confirm, and a third window (team-ask) runs after team-join. An invite launch takes about 4 to 6 minutes.
  - The suite's `until` now takes a poll interval, and the window cleanup line reads "temporary folders removed".

## Self-Check: PASSED

- FOUND: src/services/savedProfileUi.ts, src/test/savedProfileUi.test.ts, src/test/e2e/run.ts, src/test/e2e/suite.ts, src/extension.ts, 61-VALIDATION.md
- FOUND commits: 83de689, 267530a, 3ce57ac, c3a8ab4 (all ancestors of HEAD)
