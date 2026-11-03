---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 24
subsystem: team-command-wording
tags: [gap-closure, G-61-6, plain-language, organization, naming-scan, tdd]
status: complete

requires:
  - phase: 61-invitations-joining-removal-near-org-and-key-integration
    provides: "61-15 core wording (NO_ORG_NOTICE, the pin texts naming NEAR AI: Link Your Organization, manual steps at your organization's settings on the NEAR AI website)"
provides:
  - "src/test/helpers/plainWords.ts: BANNED_TERMS (now with NEAR organization in four forms), NAMING_TERMS, bannedPattern, namingPattern, organizationPattern, literalsOf, readable, bannedIn, namingIn, LEGACY_PEOPLE_FACING, peopleFacingFiles, namingScanFiles"
  - "LINK_EXPLANATION, LINK_NOW_CHOICE ('Link now') and NOT_NOW_CHOICE ('Not now, everyone uses their own key') exported from src/services/team/memberCommands.ts"
  - "command titles 'Link Your Organization' and 'Sign Out of NEAR AI for This Team' (ids unchanged)"
  - "a discovery-based people-facing scan and a naming scan over every Team Mode literal and command title"
affects: [61-19, 61-20, 61-21, 61-22, 61-23]

plan_head_before: 579c4e1ac7ab807ff036eead062f95e3f86e4cdf
plan_head_after: c7c5eba1cc2b27eead204fc61e9e4fc5f0af671a
actuals:
  tokens: 23800
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "people-facing files are found by convention (src/services/team/*, *Text.ts, media/board/*.js, media/chat/team*.js); a new file there is scanned without editing the test"
    - "the naming scan reads every literal, output channel text included, plus every package.json command title"
    - "one askToLink step (explanation as placeholder, Link now or Not now) used by Invite and by Link Your Organization"

key-files:
  created:
    - src/test/helpers/plainWords.ts
  modified:
    - src/test/teamPlainLanguage.test.ts
    - package.json
    - src/test/teamManifest.test.ts
    - src/services/team/memberCommands.ts
    - src/services/team/teamSession.ts
    - src/services/team/teamStatusBar.ts
    - src/services/nearSignIn.ts
    - src/test/teamMemberCommands.test.ts
    - src/test/teamSessionMembers.test.ts
    - src/test/teamBoardLive.test.ts
    - src/test/nearSignIn.test.ts

key-decisions:
  - "Link Your Organization shows the explanation only when the team has no organization link; a linked team goes straight to the organization and workspace pickers (same link says so, a different one asks before replacing), because 'Not now, everyone uses their own key' would be untrue for a linked team"
  - "Not now from the Link command says 'Nothing was changed. ' followed by NO_ORG_NOTICE; closing the pick changes nothing silently, like every other closed pick"
  - "'Invite without NEAR' became 'Invite without signing in' (it is the linked-team, not-signed-in choice, so 'Not now, everyone uses their own key' would be wrong there), matching 'Continue without signing in'"
  - "Manage Team Members: first row 'NEAR AI sign-in: <account>' or 'NEAR AI sign-in: not signed in'; cleanup rows 'Still to finish: <step> for <name>'; the status tooltip line ' NEAR AI sign-in: <account>.'"
  - "A member's key is the 'AI key' in the command and session text (as in 61-15); the lead's join notice reads 'You joined your organization, the account that pays for your team's AI.'"
  - "The naming scan leaves out src/domain/team files other than *Text.ts: PERMISSION_REASONS and TEAM_REJECTION_REASONS are stored in state.rejected and covered by the state hash"

patterns-established:
  - "test helpers that hold shared rules live in src/test/helpers without a .test suffix, so the test glob never runs them"

requirements-completed: [TEAM-02, TEAM-03]

duration: 35min
completed: 2026-11-03
---

# Phase 61 Plan 24: Command and session text name your organization, with a one-line link explanation and a naming scan Summary

**Every Team Mode command, session notice and command title now calls the paying account "your organization" and names NEAR AI only as the AI provider. Linking is explained in one line with "Link now" or "Not now, everyone uses their own key". A shared plain-words scanner fails on any "NEAR organization" in people-facing text, and on "NEAR organization", "NEAR console", "NEAR key" or "NEAR link" in any Team Mode literal or command title.**

## Performance

- Duration: about 35 minutes
- Tasks: 3 (one tracer, two auto). Each was RED then GREEN.
- Files: 1 created, 11 modified

## Accomplishments

- `src/test/helpers/plainWords.ts` now holds the banned-term list, the scanner and the file discovery that used to be in teamPlainLanguage.test.ts, with no change in what they do. It adds "NEAR organization" in four forms (singular, plural, and both British spellings) to BANNED_TERMS. It also adds NAMING_TERMS and namingIn, which check every literal with no exemption for the output channel, plus `peopleFacingFiles` and `namingScanFiles`. If a file on the legacy list is missing, peopleFacingFiles throws instead of skipping it.
- The people-facing scan now also reads `src/domain/team/teamSectionText.ts` and `media/chat/team.js`, which it finds on its own. Both were already clean.
- In package.json, the titles of `nearAi.team.linkNearOrganization` and `nearAi.team.signOutNear` are now "Link Your Organization" and "Sign Out of NEAR AI for This Team". The ids are unchanged, and teamManifest and teamSoloParity both pass.
- Every people-facing literal in memberCommands.ts and teamSession.ts follows the terminology table. That covers progress steps, buttons, picker titles and placeholders, messages, the manage rows, the personal-key warning and the confirm, send-key and rotate-key notices. The command titles quoted in that text use the new names.
- Invite into an unlinked team now shows LINK_EXPLANATION as the placeholder, with "Link now" and "Not now, everyone uses their own key". Choosing Not now continues the invite and shows NO_ORG_NOTICE. Link Your Organization asks the same question before any sign-in. The invite path asks once, because linkFlow itself does not ask.

## Task Commits

1. Task 1 (tracer) RED: `bdbd0fb` test(61-24): share the plain-words scanner, ban NEAR organization and expect the renamed command titles
2. Task 1 GREEN: `5848bb7` feat(61-24): rename the two command titles to Link Your Organization and Sign Out of NEAR AI for This Team
3. Task 2 RED: `de884ba` test(61-24): expect your organization, AI key and NEAR AI sign-in in the command and session text
4. Task 2 GREEN: `8ac43ad` feat(61-24): speak of your organization and NEAR AI as the provider in the command and session text
5. Task 3 RED: `0bc3b56` test(61-24): expect the one-line organization explanation with Link now or Not now
6. Task 3 GREEN: `c7c5eba` feat(61-24): explain the organization in one line with Link now or Not now, everyone uses their own key

## TDD Gate Compliance

- Task 1 RED: `node --test --test-reporter=tap --test-name-pattern="scanner|scan covers|plain titles|contributes" dist/test/teamPlainLanguage.test.js dist/test/teamManifest.test.js` exited 1 with 7 tests, 2 failing. The target "package.json contributes the five membership commands ... with plain titles" failed on ERR_ASSERTION because the titles were still the old ones. The second failure was a wrong expected string in the new sample test (template head spacing), fixed before the commit. Classifier: RED_EVIDENCE_OK (target_test_failed).
- Task 2 RED: the new expectations were run against the unchanged sources (the source edits were set aside for the run). Five files (teamMemberCommands, teamSessionMembers, teamSession, teamBoardLive, nearSignIn) ran 84 tests and failed 16. Every failure was an edited wording expectation failing on ERR_ASSERTION. Classifier: RED_EVIDENCE_OK.
- Task 3 RED: teamPlainLanguage plus teamMemberCommands ran 43 tests, 33 failing. LINK_NOW_CHOICE and NOT_NOW_CHOICE were not exported yet, so every invite answer was undefined and the explanation test failed. The naming scans were also red. Classifier: RED_EVIDENCE_OK (behavioural failures; the JS was emitted even though tsc reported the missing exports).
- GREEN for each task: the plan's verify command exited 0 (results below).

## Verification

- Task 1: scanner, scan-covers, plain-titles and contributes tests: 7 tests, 7 pass, 0 fail. Tracer gate (auto mode): the end-to-end re-run passed, then the plan expanded.
- Task 2: teamMemberCommands, teamSessionMembers, teamSession, teamBoardLive, nearSignIn: 84 tests, 84 pass, 0 fail.
- Task 3: teamPlainLanguage, teamMemberCommands, teamSessionMembers, teamManifest, teamSoloParity: 75 tests, 75 pass, 0 fail. This includes both new scan tests.
- Broader impacted check: all `dist/test/team*.test.js` plus nearSignIn and toolsPage (MemoryMax=6G): 1027 tests, 1023 pass, 2 skipped, 2 fail. Both failures are the known deferred ones (teamGsdImport "every plan committed at HEAD parses ..." and teamImport "this repository's own .planning at HEAD imports ..."). They are left for 61-22 and were not weakened.
- `tsc -p tsconfig.json` is clean. No em-dash was added (0 in the added lines).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Stale text] The status tooltip and the sign-in box quoted the old names**
- Found during: Task 2
- Issue: the status tooltip's sign-in line is built in `src/services/team/teamStatusBar.ts` (" NEAR: signed in as ..."), not in teamSession.ts. The browser sign-in box text in `src/services/nearSignIn.ts` quoted "NEAR AI: Sign Out of NEAR (Team)", a title that no longer exists.
- Fix: the tooltip line now reads " NEAR AI sign-in: <account>." and the sign-in note quotes "NEAR AI: Sign Out of NEAR AI for This Team". Their expectations in teamSessionMembers, teamBoardLive and nearSignIn were updated, and each still checks the same fact.
- Files: src/services/team/teamStatusBar.ts, src/services/nearSignIn.ts, src/test/teamSessionMembers.test.ts, src/test/teamBoardLive.test.ts, src/test/nearSignIn.test.ts
- Commits: `de884ba` and `8ac43ad`

**2. [Rule 2 - Correct choice wording] The explanation is shown only when the team has no organization link**
- Found during: Task 3
- Issue: running Link Your Organization on a team that is already linked would have offered "Not now, everyone uses their own key", which is not true for that team.
- Fix: linkCommand reads team.json first. When there is no link it asks the explanation. When there is one it goes on as before ("already linked", or a confirmation before replacing). The new test checks both paths.
- Files: src/services/team/memberCommands.ts, src/test/teamMemberCommands.test.ts
- Commit: `c7c5eba`

**3. Tests strengthened beyond the plan's named lines**
- The join notice for a lead is now checked against the exact sentence (it used to be a substring match on "NEAR organization").
- The invite test also checks that Not now shows NO_ORG_NOTICE and still makes the invite.
- The Link test checks that the explanation pick comes first.
- The invite-time link test checks that the explanation is asked exactly once.
- No assertion was removed or loosened.

### Not changed on purpose

- The Manage Team Members row for an unlinked team (NO_ORG_NOTICE) still goes straight into linkFlow without the explanation step. The plan names only Invite and the Link command. 61-21 (Team section) can route its link action through the command, which now explains first.
- `src/team/nearSession.ts` ("Your NEAR sign-in for this team expired") and `src/team/cleanupChecklist.ts` ("The NEAR cleanup checklist ...") still say "NEAR" as the provider. These phrases are not naming terms, and they sit outside this plan's files and outside 61-15's table. The non-team "Match the NEAR console exactly" token text in the reporting surface is solo-mode text and outside Team Mode.

## Deferred Issues

- None new. The two failures in teamGsdImport and teamImport, and the load-sensitive teamSession test, stay deferred to 61-22 (deferred-items.md).

## Threat Flags

None. Only string literals, two command titles and one extra pick before linking changed. The pick happens before any sign-in or write, and Not now leaves team.json, HEAD and SecretStorage unchanged, which is tested (T-61-96). Command ids are pinned by teamManifest and teamSoloParity (T-61-97). No package was installed (T-61-SC).

## Self-Check: PASSED

- src/test/helpers/plainWords.ts exists and exports NAMING_TERMS. teamPlainLanguage.test.ts imports `./helpers/plainWords`.
- package.json has one line each for "Link Your Organization" and "Sign Out of NEAR AI for This Team".
- memberCommands.ts has `export const LINK_EXPLANATION`, at least one "Not now, everyone uses their own key" and at least one "NEAR AI sign-in".
- Commits bdbd0fb, 5848bb7, de884ba, 8ac43ad, 0bc3b56 and c7c5eba are ancestors of HEAD (6 commits since 579c4e1).
