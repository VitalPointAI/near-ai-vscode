---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 25
subsystem: ui
tags: [sidebar, webview, team-section, profile-readiness, e2e, gap-closure]

requires:
  - phase: 61-17
    provides: "media/chat/team.js Team section page and its e2e probe"
  - phase: 61-21
    provides: "section#team in sidebarHtml, team.js after chat.js, the team-state feed and the probe tap"
  - phase: 61-22
    provides: "the real-window invite e2e (team-lead, team-join, team-confirm) and inviteKit"
provides:
  - "media/chat/readiness.js: the one profile-readiness rule of the sidebar page (welcomeState, isReady, track, current, onChange), window.nearReadiness, body data-profile"
  - "Team section drawn only while the project's NEAR AI profile works; it hides again when the profile stops working and focus moves to the message box"
  - "Planning-file links hidden by CSS until body data-profile is ready"
  - "PR #7 parity test that turns on by itself when media/chat/setup.js arrives with main"
  - "inviteKit.connectProfile and hidden-then-shown checks in the real-window team-lead and team-join scenarios"
affects: [merge of main 0.4.14 into Team Mode, PR #7 Connect NEAR AI panel, 62-21, 62-23, 62-24]

actuals:
  tokens: 9827
  tasks: 3
  commits: 5
plan_head_before: 52974e32c43db559585d9d4a437f46b868a72ee6
plan_head_after: de6dd1250802a4baf2a4a43f82dfd162f48c0864

tech-stack:
  added: []
  patterns:
    - "UMD page module (module.exports under Node for tests, window.nearReadiness in the page) shared by several page scripts"
    - "Presentation gate in the page from an existing host message, no host-side file reads"

key-files:
  created:
    - media/chat/readiness.js
    - src/test/sidebarReadiness.test.ts
  modified:
    - media/chat/team.js
    - media/chat/chat.css
    - src/services/panelView.ts
    - scripts/verify-release-content.mjs
    - src/test/teamSectionPage.test.ts
    - src/test/sidebarChat.test.ts
    - src/test/e2e/suite.ts

key-decisions:
  - "readiness.js copies PR #7's welcomeState line for line, so the parity test passes on every case; proven by running it once against the real feat/setup-next-steps setup.js (temporary copy, removed)"
  - "Before the first profile-status the state is unknown (current() undefined, probe profile null) and counts as not ready"
  - "The section keeps the latest model while hidden and draws it when the profile works, without waiting for another team-state"
  - "A click probe while the whole section is hidden answers error 'hidden'; a click on an action that is not drawn while shown still answers the old not-shown text"
  - "Each window's fake model servers close in a finally in run(), after the window's last scenario"

patterns-established:
  - "Merge note: keep readiness.js as the rule; make setup.js's welcomeState delegate to root.nearReadiness.welcomeState (or keep its copy, which the parity test checks); keep readiness.js before setup.js and chat.js in sidebarHtml"

requirements-completed: [TEAM-02]

coverage:
  - id: D1
    description: "One readiness rule (welcomeState, isReady) identical to PR #7's, with a tracker that writes body data-profile"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/sidebarReadiness.test.ts#welcomeState gives no-folder, connect, choose, select or ready from the profile-status value, row by row"
        status: pass
      - kind: unit
        ref: "src/test/sidebarReadiness.test.ts#every profile-status message sets body data-profile to the state and tells each listener once; a removed listener hears nothing"
        status: pass
    human_judgment: false
  - id: D2
    description: "Team section hidden until the profile works, shown by itself once it does, hidden again with focus moved to the message box; probe reports hidden and profile"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/teamSectionPage.test.ts#tracer: no Team section before a profile works; it appears by itself once the profile works and hides again when it stops"
        status: pass
      - kind: unit
        ref: "src/test/teamSectionPage.test.ts#while hidden the probe reports hidden and the profile state, and a click probe is refused with hidden and posts no team-action"
        status: pass
    human_judgment: false
  - id: D3
    description: "Planning-file links hidden by CSS until data-profile is ready; readiness.js loaded before chat.js and shipped"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/sidebarReadiness.test.ts#the planning-file links are hidden by CSS until body data-profile is ready"
        status: pass
      - kind: unit
        ref: "src/test/sidebarChat.test.ts#the sidebar loads readiness.js with the page nonce after composer.js and before chat.js and team.js"
        status: pass
      - kind: other
        ref: "npm run verify:release"
        status: pass
    human_judgment: false
  - id: D4
    description: "Real windows: no Team section before a profile works, shown without a reload once a local profile is connected; the whole invite flow stays green"
    requirement: TEAM-02
    verification:
      - kind: e2e
        ref: "xvfb-run -a node dist/test/e2e/run.js (32 tests, all scenarios)"
        status: pass
    human_judgment: false
  - id: D5
    description: "With no profile the sidebar now offers only the existing setup path (welcome, its cards and the Set up chip); the owner's wish for one single setup button arrives with PR #7's Connect panel at the merge"
    verification: []
    human_judgment: true
    rationale: "Whether the remaining welcome is acceptable before PR #7 lands is the owner's call (61-UAT test 8 re-test)"

duration: 9min
completed: 2026-11-04
status: complete
---

# Phase 61 Plan 25: No Team section until a NEAR AI profile works Summary

**A shared page module, media/chat/readiness.js, holds the one readiness rule (PR #7's welcomeState, case for case) and tracks profile-status. While no profile works the sidebar's Team section and the planning-file links are hidden. The section appears by itself once the profile works. Real VS Code windows prove the hidden-then-shown sequence before the full invite flow.**

## Performance

- **Duration:** about 9 min
- **Started:** 2026-11-04T01:03:29Z
- **Completed:** 2026-11-04T01:12Z
- **Tasks:** 3 (tracer, auto, auto)
- **Files modified:** 9 (2 created, 7 modified)

## Accomplishments

- G-61-7 (61-UAT test 8) closed in the page. There is no Team section and there are no planning-file links while the project has no folder, no saved profile, a selected profile whose key needs checking, or saved profiles with none chosen. No team button can be seen or clicked.
- `readiness.js` (UMD: `module.exports` for tests, `window.nearReadiness` in the page) exports `welcomeState`, `isReady`, `track`, `current` and `onChange`. On every profile-status it sets `body[data-profile]` to the state and tells its listeners. It keeps only the state name.
- `team.js` keeps the latest model and draws it only while the state is `ready`. It subscribes with `onChange`, so the section appears or hides without a new team-state. When the section hides with focus inside, focus moves to `#input`. The probe facts gain `hidden` and `profile`, and a click probe while hidden answers `error: 'hidden'` and posts nothing.
- `chat.css` has `body:not([data-profile="ready"]) #project-links { display: none; }`. `sidebarHtml` loads `readiness.js` after `composer.js` and before `chat.js` and `team.js`, with the page nonce. The file is on the release content list.
- PR #7 parity seam: the test requires `media/chat/setup.js` when it exists and compares `welcomeState` on the whole rule table plus `{noWorkspace:true}`. On this branch it is skipped with the stated reason. It was run once against the real PR #7 file (copied in temporarily, then removed) and passed.
- In the e2e, `inviteKit.connectProfile` connects a local profile against a fake model server, checks that it is valid, and refreshes the sidebar. team-lead and team-join each start with the section hidden (`profile: 'connect'`, a click is refused). After the profile is connected the section is shown without a reload. The invitee's copy stays clean.

## Task Commits

1. **Task 1 (tracer) RED:** `8792dd7` test(61-25): expect no Team section until a NEAR AI profile works, from one readiness rule
2. **Task 1 GREEN:** `c15c022` feat(61-25): draw the Team section only while a NEAR AI profile works
3. **Task 2 RED:** `b4dea52` test(61-25): expect the planning-file links to follow the readiness rule, readiness.js in the page and release, and the PR #7 parity seam
4. **Task 2 GREEN:** `d25e988` feat(61-25): hide the planning-file links until a profile works, load readiness.js before chat.js, and ship it
5. **Task 3:** `de6dd12` test(61-25): real windows show no Team section until a local profile is connected, then the invite flow runs as before

## TDD Gate Compliance

- **Task 1 RED:** `node --test --test-reporter=tap dist/test/sidebarReadiness.test.js dist/test/teamSectionPage.test.js` exited 1: 27 tests, 16 pass, 11 fail. The target was "tracer: no Team section before a profile works; it appears by itself once the profile works and hides again when it stops". It failed on its first assertion, "a model before any profile-status is not shown" (`false !== true`). Classifier: RED_EVIDENCE_OK (target_test_failed). Semantic assessment: readiness.js was declared only (each function throws "not implemented") and team.js did not read it yet. The modules loaded, so this was the planned behaviour assertion, not a load fault. The test "the tracker keeps only the state name" already passed against the stub and is kept as a guard.
- **Task 2 RED:** `node --test --test-reporter=tap dist/test/sidebarReadiness.test.js dist/test/sidebarChat.test.js` exited 1: 22 tests, 18 pass, 3 fail, 1 skipped. The target was "the planning-file links are hidden by CSS until body data-profile is ready", which failed on deepEqual because chat.css had no data-profile rule. Classifier: RED_EVIDENCE_OK. The other two failures were the script order and the release entry. The data-profile, safety and IIFE tests already passed because Task 1 built them, and they stay as guards.
- **Tracer feedback gate:** in auto mode the Task 1 verify was re-run and passed (37/37), so expansion continued.
- **Task 3:** the e2e checks test behaviour that Tasks 1 and 2 already built, so there is no separate RED. They are committed as `test`.
- Every RED commit comes before its GREEN commit. There are no REFACTOR commits.

## Verification

| Check | Result |
|-------|--------|
| Task 1: tsc, then sidebarReadiness, teamSectionPage, teamSectionModel (4G wrapper) | exit 0, 37 tests, 37 pass |
| Task 2: tsc, then sidebarReadiness, sidebarChat, teamSectionPage, teamSectionHost, teamSoloParity, teamPlainLanguage (4G wrapper) | exit 0, 77 tests, 76 pass, 0 fail, 1 skipped: "PR #7 parity ... # media/chat/setup.js arrives with 0.4.14 (PR #7); this parity check turns on when main is merged into Team Mode" |
| Parity against the real PR #7 setup.js (temporary copy of `feat/setup-next-steps:media/chat/setup.js`, removed afterwards) | 1 test, 1 pass |
| Task 3: `npm run compile && xvfb-run -a node dist/test/e2e/run.js` (6G wrapper, timeout 1800) | exit 0, 32 tests pass, 0 fail: project 8, plain 2, team 7, team-lead 6, team-join 6, team-confirm 3 |
| Broader impacted run: every fake-DOM and sidebar test (agentBasics, board*, fakeDom, sidebarChat, sidebarReadiness, teamBoardAssets, teamPlainLanguage, teamSectionHost, teamSectionModel, teamSectionPage, teamSoloParity) | 213 tests, 212 pass, 0 fail, 1 skipped (the parity seam) |
| `npm run verify:release` | exit 0: 271 entries, 191 runtime JS files, 52 required release assets (51 before plus readiness.js) |
| Prohibition: `git diff --quiet 52974e3 -- src/services/team/teamSectionHost.ts src/extension.ts media/chat/chat.js src/test/teamSoloParity.test.ts` | exit 0 (no host file check added, chat.js unchanged) |
| Acceptance greps | `function welcomeState` in readiness.js (line 20); `nearReadiness` in team.js (2); `extension/media/chat/readiness.js` in verify-release-content.mjs (74); `readiness.js` in panelView.ts (131); `connectProfile` in suite.ts (467) |

## Files Created/Modified

- `media/chat/readiness.js`: the one readiness rule and the profile-status tracker. Its header holds the merge note.
- `media/chat/team.js`: keeps the latest model, draws it only while the profile is ready, conceals with the focus move, and adds `hidden` and `profile` facts and the hidden click refusal.
- `media/chat/chat.css`: the `#project-links` gate rule.
- `src/services/panelView.ts`: the readiness.js script tag.
- `scripts/verify-release-content.mjs`: the `extension/media/chat/readiness.js` entry.
- `src/test/sidebarReadiness.test.ts`: the rule table, the tracker, the link gate, asset safety and the PR #7 parity seam.
- `src/test/teamSectionPage.test.ts`: setup now delivers a ready profile-status first. Adds the hidden, shown, re-hidden, focus, kept-model, probe and no-module cases. The probe test expects `hidden: false, profile: 'ready'`.
- `src/test/sidebarChat.test.ts`: the script order with the page nonce.
- `src/test/e2e/suite.ts`: `connectProfile`, `assertHiddenWithoutProfile`, a new first test in team-lead and team-join, `SectionFacts.hidden` and `profile`, and the window's fake model servers closed in `run()`.

## Decisions Made

See key-decisions in the frontmatter.

## Merge note (main with 0.4.14 into Team Mode)

- Keep `media/chat/readiness.js` as the rule.
- Make `setup.js`'s `welcomeState` delegate to `root.nearReadiness.welcomeState`, or keep its copy, which `sidebarReadiness.test.ts` then compares case for case. The parity test turns on by itself once `setup.js` exists.
- In `sidebarHtml`, keep `readiness.js` before `setup.js` and `chat.js`.
- PR #7's Connect NEAR AI panel then replaces the welcome while the state is not ready. The Team section and the planning-file links already follow the same state.

## Deviations from Plan

None. The plan was executed as written. Additions within its scope:
- The rule table has extra malformed rows: a text value, an empty object, profiles that are not a list, and empty entries.
- The e2e also checks that a click is refused while hidden, and that the invitee's copy has a clean `git status --porcelain` after the profile is connected.
- There is a page test for a missing readiness module, which counts as not ready.

## Issues Encountered

None.

## Known Stubs

None.

## User Setup Required

None. No external service configuration is required.

## Next Phase Readiness

- 61-UAT test 8 can be re-tested. With no profile, the sidebar shows only the existing welcome and the Set up chip. There is no Team section and there are no planning links.
- 62-21, 62-23 and 62-24 can edit `src/test/e2e/suite.ts` on top of this. A new team scenario must call `kit.connectProfile(api)` before it expects the Team section.

---
*Phase: 61-invitations-joining-removal-near-org-and-key-integration*
*Completed: 2026-11-04*

## Self-Check: PASSED

- media/chat/readiness.js and src/test/sidebarReadiness.test.ts exist.
- Commits 8792dd7, c15c022, b4dea52, d25e988 and de6dd12 are on this branch, and none of them deletes a file.
- The acceptance greps, the Task 2 and Task 3 verify commands and the prohibition diff were re-run, and all pass.
