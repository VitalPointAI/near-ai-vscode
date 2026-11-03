---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 20
subsystem: team-membership-commands
tags: [gap-closure, G-61-2, G-61-3, G-61-4, G-61-5, invite, join, share, prompts-seam, tdd]
status: complete

requires:
  - phase: 61-18
    provides: "prepareJoin catch-up with onStep('update'), ready.updated and not-ready reasons (src/team/join.ts, src/team/joinCatchUp.ts)"
  - phase: 61-19
    provides: "ensureTeamSetupShared with reason invite, SHARE_TEXT, teamPrompts and promptTap, LOCAL_ONLY_TEXT"
  - phase: 61-24
    provides: "LINK_EXPLANATION, LINK_NOW_CHOICE, NOT_NOW_CHOICE; the plain-language scan of memberCommands.ts"
provides:
  - "memberCommands.ts: Invite shares the team setup first (organization choice, then ensureTeamSetupShared reason invite, then the questions); INVITE_NEEDS_SHARE_TEXT"
  - "memberCommands.ts: Join under a 'Joining' progress with the catch-up step, JOIN_TEXT (updated, localChanges, otherVersion, notShared, offline, cloneNeeded, freshCopy, tryAgain)"
  - "memberCommands.ts: every input, pick and message goes through teamPrompts (0 direct vscode.window.show* calls)"
  - "src/test/teamInviteShare.test.ts and src/test/teamJoinCommand.test.ts (real git, vscode stub)"
affects: [61-21, 61-22, 61-23]

plan_head_before: d5294b854b4e4a8f95a0cbce1a85aa74fb507af2
plan_head_after: 7e1bfeb45e150bd00a38998cd392f178d18c27ba
actuals:
  tokens: 19527
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Invite order: requireTeam, requireManager, local reachability check (no network), organization choice, ensureTeamSetupShared('invite'), the questions, lead sign-in, inviteMember, bundle modal"
    - "linkFlow(projectRoot, offerShare): false inside Invite, so the invite's single share confirmation covers the link"
    - "Join preparation loop: prepareJoin under withSteps('Joining'), each not-ready reason mapped to one JOIN_TEXT sentence and button; Try again re-runs with the paste held only in that call"

key-files:
  created:
    - src/test/teamInviteShare.test.ts
    - src/test/teamJoinCommand.test.ts
  modified:
    - src/services/team/memberCommands.ts
    - src/test/teamMemberCommands.test.ts

key-decisions:
  - "Before the organization choice, Invite checks the project's online address locally with checkOnlineHome (no network). A project kept only on this computer, or at an address that cannot be given out, gets the share flow's modal before anything is asked, and nothing is written"
  - "A declined share is followed by INVITE_NEEDS_SHARE_TEXT ('No invite was made, because your team setup must be online before anyone can join with an invite. Nothing was changed.'). For not-reachable and failed, the share flow's own sentence is the only one shown, and the channel gets one line"
  - "Link now inside Invite reports 'Linked <team> to <org>.' without a Share with my team offer. The Link command and Manage Team Members keep their offer until 61-23 moves them to the share flow"
  - "The remote-url refusal (the address changed between the check and the invite) is now a modal: 'No invite was made, because the address your project is kept at online cannot be given to teammates as it is.' Its detail says what to do, and it has Show details"
  - "Join's not-ready sentences are non-modal warnings. local-changes and unshared-work share one sentence. other-version has its own. Both offer Get a fresh copy, which runs git.clone with the invite's address only when chosen. not-shared has no button. offline has Try again. The channel gets '(reason)' and the redacted detail"
  - "'Your copy of the project was brought up to date.' is reported (shown and kept in the channel) after the preparation and before the name question"
  - "The clone-needed sentence now points at Join a team in the NEAR AI sidebar instead of the palette command"

patterns-established:
  - "Membership prompts are scriptable: under NEAR_AI_E2E=1 with promptTap.script set, the whole invite runs with VS Code shown nothing, and promptTap.shown holds each prompt in order. Only the bundle modal's record holds the invite"

requirements-completed: [TEAM-02]

coverage:
  - id: D1
    description: "Invite with the team setup not online asks once ('Share and continue') before any question, shares exactly team.json to main, then asks and shows the invite"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamInviteShare.test.ts#tracer: inviting with the team setup not online asks once to share it first, shares exactly team.json, then asks the questions and shows the invite"
        status: pass
    human_judgment: false
  - id: D2
    description: "No invitation without the team setup online: declined, local-only project and offline home leave the log without member.invited and the remote unchanged"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamInviteShare.test.ts#declining the share asks no question, makes no invite, leaves the online home unchanged and says why"
        status: pass
      - kind: integration
        ref: "src/test/teamInviteShare.test.ts#a project kept only on this computer is explained in a modal before any question, with what to do, and nothing is written"
        status: pass
      - kind: integration
        ref: "src/test/teamInviteShare.test.ts#an online home that cannot be reached is said plainly before the questions; nothing is written and no address is shown"
        status: pass
    human_judgment: false
  - id: D3
    description: "Link now inside Invite links, asks no share of its own, and the one share confirmation puts the linked team.json online; the bundle carries the link"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamInviteShare.test.ts#choosing Link now while inviting links first, and the one share confirmation puts the linked team.json online; the bundle carries the link"
        status: pass
      - kind: integration
        ref: "src/test/teamMemberCommands.test.ts#inviting in a linked team whose organization link is not shared yet asks once to share the team setup first, and then the online setup has the link"
        status: pass
    human_judgment: false
  - id: D4
    description: "Every invite prompt goes through teamPrompts. Under the e2e variable a script answers all of them, VS Code sees none, and only the bundle modal record holds the invite"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/teamInviteShare.test.ts#under the extension-host test variable a script answers every invite prompt, each is recorded in order, and VS Code is shown none"
        status: pass
    human_judgment: false
  - id: D5
    description: "Join from a behind, clean copy brings it up to date, says so and joins. Local changes, unshared work, another version, not shared, offline and a different or missing project each get their own plain sentence and button, and nothing in the copy changes"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamJoinCommand.test.ts#a behind, clean copy of the same project is brought up to date by itself, says so, then asks the name and joins as an observer"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinCommand.test.ts#a copy with changes that are not online yet is left untouched; Get a fresh copy downloads the invite's project and nothing else runs"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinCommand.test.ts#an online home that cannot be reached offers Try again, which prepares again with the same paste and then joins"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinCommand.test.ts#when the team setup is not online yet the person is told to ask the inviter to choose Share, with no button, and nothing changes"
        status: pass
    human_judgment: false
  - id: D6
    description: "Whether the invite and join steps read as seamless and easy to follow in a real window (G-61-5)"
    verification: []
    human_judgment: true
    rationale: "The plain-language scans and the prompt order pass, but how easy the flow is to follow is the owner's hands-on judgment (61-22 real-window test and UAT)"

duration: 12min
completed: 2026-11-03
---

# Phase 61 Plan 20: Invite shares the team setup first, Join brings an existing copy up to date Summary

**Invite now asks the organization choice first, then makes sure the team setup is online with one 'Share and continue' confirmation, and only then asks its questions. A project teammates cannot reach, or an online home that cannot be reached, is said plainly before the questions, and nothing is written. Join brings a behind, clean copy up to date by itself ('Your copy of the project was brought up to date.'). Any other copy gets one plain sentence with Get a fresh copy, Try again or no button. Every prompt of the membership commands goes through teamPrompts.**

## Performance

- Duration: about 12 minutes (2026-11-03T22:50:58Z to 2026-11-03T23:02:58Z)
- Tasks: 2 (one tracer, one auto), each RED then GREEN
- Files: 2 created, 2 modified (806 insertions, 102 deletions)

## Accomplishments

- G-61-3: an invite is only made when the team setup is on the team's main version online. `inviteNeedsShared` calls `ensureTeamSetupShared(..., { reason: 'invite' })`. A setup that is not online gets one modal ('Before you invite anyone, your team setup must be online so the invite can find the team. Share it now?', button 'Share and continue'). Once the setup is shared or already online, the questions follow. Declining gives "No invite was made ..." and asks nothing.
- G-61-2: before the organization choice, `checkOnlineHome` (local, no network) catches a project kept only on this computer, or at an address that cannot be given out. The share flow's modal (LOCAL_ONLY_TEXT or NOT_SHAREABLE_TEXT, with what to do in the detail) is shown before anything is asked. An online home that cannot be reached gets the share flow's offline sentence with Try again, before the questions.
- Link now inside Invite links without its own share offer, so the invite's single confirmation shares the team.json that holds the link. The old after-the-fact warning about an unshared link and its `teamFileUnpushed` check are gone (count 0, baseline 2).
- G-61-4: Join runs `prepareJoin` under a 'Joining' progress that shows 'Getting the latest version of the project'. The reasons map as follows:
  - updated: 'Your copy of the project was brought up to date.'
  - local-changes or unshared-work: the changes-not-online sentence with Get a fresh copy
  - other-version: the different-version sentence with Get a fresh copy
  - not-shared: ask the inviter to choose Share in the Team section of their NEAR AI sidebar (no button)
  - offline: Try again, which prepares again with the same paste
  - a different or missing project: Get the project, with a sentence that points at Join a team in the NEAR AI sidebar
  This replaces 61-18's interim sentence. WINDOWS.md entry 13 is marked fixed.
- G-61-5 (command half): `ask`, `pick`, Show details, the share offer and every modal of memberCommands.ts now go through teamPrompts. `grep -c "vscode.window.show" src/services/team/memberCommands.ts` prints 0, so 61-22 can script Invite and Join end to end.

## Task Commits

1. Task 1 (tracer) RED: `8eb22fa` test(61-20): expect Invite to share the team setup first with one confirmation, and say plainly when it cannot
2. Task 1 GREEN: `a94407a` feat(61-20): Invite shares the team setup first with one confirmation, then asks; every membership prompt goes through teamPrompts
3. Task 2 RED: `b0e4fde` test(61-20): expect Join to bring an existing copy up to date, or say plainly why not with Get a fresh copy
4. Task 2 GREEN: `7e1bfeb` feat(61-20): Join brings an existing copy up to date, or says plainly why not with Get a fresh copy

## TDD Gate Compliance

- Task 1 RED: `node --test --test-reporter=tap dist/test/teamInviteShare.test.js` exited 1, with 7 tests and 7 failing. The target, the tracer, failed because the first modal was the bundle, not SHARE_TEXT.inviteQuestion. The other tests failed on missing behaviour: there was no share modal, the questions were asked first, and the pick 'Not now' was not offered because the role pick came first. Classifier: RED_EVIDENCE_OK (target_test_failed). Semantic assessment: everything compiled against the declared INVITE_NEEDS_SHARE_TEXT, and every failure was the planned order or share behaviour being absent.
- Task 2 RED: `node --test --test-reporter=tap dist/test/teamJoinCommand.test.js` exited 1, with 7 tests and 7 failing. Each not-ready case got 61-18's interim sentence instead of its JOIN_TEXT sentence. The catch-up case had no 'Joining' progress, and clone-needed still had the old sentence. Classifier: RED_EVIDENCE_OK. Semantic assessment: JOIN_TEXT was declared and not wired, so every failure was the planned wording and button behaviour.
- Tracer feedback gate: auto mode. The Task 1 verify re-run passed (45/45), so the plan expanded.
- Every RED commit precedes its GREEN commit. There were no REFACTOR commits.

## Verification

- Task 1 verify (tsc, then teamInviteShare and teamMemberCommands, MemoryMax=4G): exit 0, 45 tests, 45 pass. The adjacent suites (teamPlainLanguage, teamSoloParity, teamShareFlow, teamCommands, teamManifest, teamPrompts) had 67 tests, 67 pass.
- Task 2 verify (tsc, then teamJoinCommand, teamMemberCommands, teamInviteShare, teamPlainLanguage and teamSoloParity): exit 0, 67 tests, 67 pass.
- Broader impacted run, all `dist/test/team*.test.js` plus nearSignIn and toolsPage (MemoryMax=6G, timeout 1800): 1071 tests, 1067 pass, 2 skipped, 2 fail. Both failures are the known deferred self-import tests: teamGsdImport "every plan committed at HEAD parses ..." and teamImport "this repository's own .planning at HEAD imports ...". They are owned by 61-22 and were not weakened.
- Acceptance checks:
  - `ensureTeamSetupShared` appears in memberCommands.ts.
  - `grep -c teamFileUnpushed src/services/team/memberCommands.ts` prints 0.
  - "Get a fresh copy" appears in memberCommands.ts.
  - `grep -c "^test(" src/test/teamJoinCommand.test.ts` prints 7.
  - memberCommands.ts has no em-dash. Its static imports are vscode, node:fs/promises, node:path, types and teamPrompts only.

## Tests changed from the old behaviour (owner rule)

- withTeam in teamMemberCommands.test.ts now puts the team setup online after Enable with the core share (planShare and shareTeamSetup), so the other tests keep their prompt sequences. The cases where the setup is not online live in teamInviteShare.test.ts.
- Pick order only: the organization choice now comes first. The tracer, the roles and lifetimes test (indexes 0, 1, 2 rotated), the 24-hour test, close-without-copy, the validation test, the em-dash test and the inviteBundle helper answer Not now first. The cancelling test keeps its six stop points (organization choice, name, email, role, amount and lifetime) in the new order.
- "inviting in a linked team whose NEAR link is not shared yet warns ..." became "... asks once to share the team setup first, and then the online setup has the link". The owner replaced the after-the-fact warning with sharing first. The second invite still checks that no share question is asked once the setup is online.
- "choosing Link now while inviting ...": the picks now start with Link now, and the responder answers Share and continue. The assertions are unchanged.
- "Join with no project open ...": the expected clone-needed sentence is the new one, which points at Join a team in the NEAR AI sidebar. The other assertions are unchanged.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] A local reachability check before the organization choice**
- **Found during:** Task 1
- **Issue:** the order in the plan puts the organization choice before ensureTeamSetupShared. That means a lead with a local-only project could go through the NEAR AI sign-in and pick an organization, and commit a link on this computer, before learning that teammates cannot reach the project. That is the G-61-2 finding.
- **Fix:** `checkOnlineHome` runs first. It reads the address from git config, with no network. When the project is not reachable, the share flow is called right away; it shows its modal and shares nothing. When the project is reachable, the order is exactly the plan's.
- **Files modified:** src/services/team/memberCommands.ts
- **Verification:** teamInviteShare "a project kept only on this computer ..." asserts that no pick and no input were requested.
- **Committed in:** a94407a

**2. [Rule 1 - Test expectation] Three expectations in my new teamJoinCommand tests were corrected to the real behaviour**
- **Found during:** Task 2 GREEN
- **Issues:**
  - A developer joining a team without an organization reads "Your lead confirms you as a developer.", not "... and sends your team key."
  - The own-key prompt is also a password input, so "pasted once" now counts the paste prompt by its text.
  - After a successful join, the session start runs `setContext`, so "no download" now checks for git.clone only.
- **Fix:** all three are expectations in tests written in this plan. No pre-existing assertion was loosened.
- **Files modified:** src/test/teamJoinCommand.test.ts
- **Committed in:** 7e1bfeb

---

**Total deviations:** 2 auto-fixed (1 missing critical functionality, 1 test expectation).
**Impact on plan:** none on scope. The planned order holds whenever the project can be reached.

## Not changed on purpose

- The bundle modal (Copy, its wording) is unchanged. 61-23 rewrites it to 'Copy invite' with instructions.
- The Link command and Manage Team Members still offer 'Share with my team' through the old `offerPush` and `pushBranch`, now via teamPrompts. 61-23 moves them to the share flow and removes the push helpers.

## Issues Encountered

None beyond the deviations above.

## Known Stubs

None. WINDOWS.md entry 13 (61-18's interim not-ready sentence) is replaced by one sentence and button per reason and marked fixed.

## Threat Flags

None beyond the plan's register.
- T-61-84: tests scan the notifications other than the bundle modal, the inputs, picks, progress, channel, settings and storage for the bundle and its code. In e2e mode, only the bundle modal's prompt record holds the invite.
- T-61-85: declined, local-only and offline invites leave no member.invited, and the remote is unchanged.
- T-61-86: Get a fresh copy and Get the project are the only uses of the invite's address, and they run only when chosen. The catch-up uses the configured remote (61-18).
- T-61-87: every refusal is a sentence with a next step, and the channel holds the reason and the redacted detail.
- T-61-SC: no package was installed.

## User Setup Required

None.

## Next Phase Readiness

- 61-21 can call Invite and Join from the sidebar Team section. The sentences already point at the sidebar ('Join a team', 'Share').
- 61-22 can script the whole invite and join with promptTap. Fragments to match:
  - The organization choice: 'Not now'.
  - The share confirmation: 'Share and continue'.
  - The questions: 'Name of the person', 'Their email address', 'Allocation in US dollars', the role label and '7 days'.
  - The bundle: 'Invite ready'.
  - Join: 'Paste the invite', 'Your name as teammates will see it' and JOIN_TEXT.updated.
- 61-23 can rewrite presentBundle and remove offerPush and pushBranch. `linkFlow(projectRoot, offerShare)` is the single place that still offers the old share.

## Self-Check: PASSED

- The files src/test/teamInviteShare.test.ts and src/test/teamJoinCommand.test.ts exist, and src/services/team/memberCommands.ts was modified.
- Commits 8eb22fa, a94407a, b0e4fde and 7e1bfeb are ancestors of HEAD (4 commits since d5294b8).
- Every acceptance grep and both task verify commands passed as listed above.

---
*Phase: 61-invitations-joining-removal-near-org-and-key-integration*
*Completed: 2026-11-03*
