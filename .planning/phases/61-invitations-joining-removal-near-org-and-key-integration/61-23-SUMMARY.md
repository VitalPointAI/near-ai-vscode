---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 23
subsystem: team-membership-commands
tags: [gap-closure, G-61-3, G-61-5, invite, link, share, tdd]
status: complete

requires:
  - phase: 61-19
    provides: "ensureTeamSetupShared with reason link, SHARE_TEXT.linkQuestion, teamPrompts and promptTap"
  - phase: 61-20
    provides: "linkFlow(projectRoot, offerShare) with the Invite flow's single share confirmation; every membership prompt through teamPrompts"
  - phase: 61-21
    provides: "The sidebar Team section with Share and Members, which the new sentences point at"
provides:
  - "memberCommands.ts: presentBundle shows 'Invite ready for <name>' with the invite, a blank line and INVITE_TEXT.howToSend, button 'Copy invite'; closing it asks 'Close without copying? The invite is not shown again.' (Copy invite, Close)"
  - "memberCommands.ts: shareLink runs ensureTeamSetupShared with reason 'link' after a new link from the Link command or Manage Team Members; LINK_NOT_SHARED_TEXT when declined"
  - "memberCommands.ts: pushBranch, offerPush, currentBranch and their constants removed; no membership command pushes a branch"
affects: [61-22]

plan_head_before: 44cc6900fc9c580602bd1f47a1653ec4635fa9cc
plan_head_after: 43b3e0764690b4f558da794d7955b10eb236a562
actuals:
  tokens: 12263
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Invite modal: message 'Invite ready for <name>', detail `${bundle}\\n\\n${INVITE_TEXT.howToSend}`, one button 'Copy invite'; anything else asks the second modal once; Close or dismiss gives the 'not copied' sentence"
    - "linkFlow(projectRoot, share): share false only inside Invite. Otherwise a changed link is followed by 'Linked <team> to <org>.' and the share flow's one confirmation (reason link)"

key-files:
  created: []
  modified:
    - src/services/team/memberCommands.ts
    - src/test/teamMemberCommands.test.ts
    - src/test/teamInviteShare.test.ts
    - src/test/teamSectionHost.test.ts

key-decisions:
  - "The instruction paragraph: 'Send it to them in a private message, such as a direct chat or an email. It works once. To join, they open the project in VS Code, open the NEAR AI sidebar, choose Join a team and paste the invite. If they do not have the project yet, Join a team offers to download it.' The last sentence covers an invitee with no copy yet; the 61-20 clone-needed path already offers the download."
  - "The 'not copied' sentence now points at the sidebar: 'The invite for <name> was not copied. You can issue it again from Members in the Team section of your NEAR AI sidebar.' It keeps the 'The invite for <name>' prefix."
  - "The second modal is a warning with no detail, so the invite is in exactly one prompt record. Dismissing it counts as Close."
  - "Link shares through shareLink, which reads team.json again after the restart and uses the session's integration branch, as Share Team Setup does. Only 'declined' adds LINK_NOT_SHARED_TEXT. For not-reachable and failed, the share flow's own sentence is the one shown, and the channel gets one line."
  - "The NEAR line in Manage Team Members (unlinked team) also uses linkFlow(…, true), so it shares the same way. Linking the same organization again ('already linked') runs no share, as before."

patterns-established:
  - "The share flow is the only way the membership commands put anything online. A source-scan test pins pushCodeBranch, offerPush, pushBranch and 'Share with my team' as absent from memberCommands.ts."

requirements-completed: [TEAM-02]

coverage:
  - id: D1
    description: "Invite and Re-issue show one modal 'Invite ready for <name>' whose detail is the invite, a blank line and how to send it, with the only button 'Copy invite'. Choosing it copies once and says so"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamMemberCommands.test.ts#tracer: Invite to Team asks its questions, writes member.invited, and shows the bundle once with Copy invite, how to send it, and nowhere else"
        status: pass
      - kind: integration
        ref: "src/test/teamMemberCommands.test.ts#Cancel ends a pending invitation and Re-issue replaces it with a new bundle shown once in the same modal with Copy invite"
        status: pass
      - kind: integration
        ref: "src/test/teamInviteShare.test.ts#tracer: inviting with the team setup not online asks once to share it first, shares exactly team.json, then asks the questions and shows the invite"
        status: pass
    human_judgment: false
  - id: D2
    description: "Closing the invite asks 'Close without copying? The invite is not shown again.' with Copy invite and Close. Copy invite copies the invite, and Close or dismissing says it can be issued again from Members"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamMemberCommands.test.ts#closing the invite asks once more before it is lost; Close says it can be issued again from Members and never repeats the invite"
        status: pass
      - kind: integration
        ref: "src/test/teamMemberCommands.test.ts#dismissing both invite modals is the same as Close: nothing is copied and the person reads where to issue it again"
        status: pass
      - kind: integration
        ref: "src/test/teamMemberCommands.test.ts#choosing Copy invite in the second question copies the invite once and announces it"
        status: pass
      - kind: unit
        ref: "src/test/teamInviteShare.test.ts#under the extension-host test variable, closing the invite asks once more, and Copy invite there copies it; only the first record holds the invite"
        status: pass
    human_judgment: false
  - id: D3
    description: "The invite and its code are in no other notification, prompt record, channel line, setting, SecretStorage entry, extension storage file or team folder file (T-61-98)"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamMemberCommands.test.ts#tracer: Invite to Team asks its questions, writes member.invited, and shows the bundle once with Copy invite, how to send it, and nowhere else"
        status: pass
      - kind: unit
        ref: "src/test/teamInviteShare.test.ts#under the extension-host test variable a script answers every invite prompt, each is recorded in order, and VS Code is shown none"
        status: pass
    human_judgment: false
  - id: D4
    description: "Link Your Organization shares the team setup with one confirmation (reason link), and the online team.json then has the link. Declining keeps the link on this computer and points at Share in the Team section"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamMemberCommands.test.ts#Link signs in, lists only organizations the lead owns or administers, commits team.json only, and shares the team setup after one confirmation"
        status: pass
      - kind: integration
        ref: "src/test/teamMemberCommands.test.ts#declining the share after Link keeps the link on this computer and says teammates will not see it until it is shared, pointing at Share in the Team section"
        status: pass
      - kind: integration
        ref: "src/test/teamInviteShare.test.ts#choosing Link now while inviting links first, and the one share confirmation puts the linked team.json online; the bundle carries the link"
        status: pass
    human_judgment: false
  - id: D5
    description: "No membership command pushes a branch: the push offer and push helper are gone from memberCommands.ts (T-61-99)"
    verification:
      - kind: unit
        ref: "src/test/teamMemberCommands.test.ts#no membership command pushes a branch: memberCommands.ts has no push offer or push helper, and the team setup goes online only through the share flow"
        status: pass
    human_judgment: false
  - id: D6
    description: "Whether the invite modal's instructions read as easy to follow in a real VS Code window (G-61-5)"
    verification: []
    human_judgment: true
    rationale: "The wording and prompt order are pinned by tests, but how the modal reads and wraps in a real window is the owner's hands-on judgment (61-22 real-window test and UAT)"

duration: 11min
completed: 2026-11-03
---

# Phase 61 Plan 23: Invite modal with Copy invite and how to send it; Link shares through the share flow Summary

**The invite now shows once, in a modal titled 'Invite ready for <name>'. Its detail is the invite, a blank line, and one plain paragraph that says how to send it and what the invitee does (open the project, open the NEAR AI sidebar, choose Join a team, paste it). Its only button is 'Copy invite'. Closing it asks once more ('Close without copying? The invite is not shown again.'). Link Your Organization now shares the changed team setup with one confirmation (reason link). The old push offer and push helper are gone, so no Team Mode membership command pushes a branch.**

## Performance

- Duration: about 11 minutes (2026-11-03T23:22:38Z to 2026-11-03T23:33:11Z)
- Tasks: 2 (one tracer, one auto), each RED then GREEN
- Files: 4 modified (218 insertions, 105 deletions)

## Accomplishments

- G-61-5: `presentBundle` (used by Invite and Re-issue) shows `Invite ready for <name>`. The detail is `<invite>\n\n<INVITE_TEXT.howToSend>`, and the only button is `Copy invite`. Any other answer opens a warning modal, `Close without copying? The invite is not shown again.`, with `Copy invite` and `Close`. Copy invite writes the invite to the clipboard once and says "Invite for <name> copied. Send it to them in a private message." Close or dismissing says "The invite for <name> was not copied. You can issue it again from Members in the Team section of your NEAR AI sidebar." All the sentences are in `INVITE_TEXT` and three small text functions, next to the other invite text.
- G-61-3: after a new link, the Link command and the NEAR line in Manage Team Members run `shareLink`. It calls `ensureTeamSetupShared(..., { reason: 'link' })`, which asks 'Share your team setup so teammates see the organization link?' once, with Share. Afterwards the online team.json has the link. Declining keeps the link on this computer and says LINK_NOT_SHARED_TEXT: "The link is saved on this computer only. Teammates will not see it until you share your team setup. Choose Share in the Team section of your NEAR AI sidebar." Link now inside Invite still asks no share question of its own (`share` false).
- The push offer is removed: `offerPush`, `pushBranch`, `currentBranch`, `PUSH_ACTION`, `SHARED_TEXT`, `SHARE_FAILED_TEXT`, `NOT_ON_A_VERSION_TEXT` and `COPY_ACTION`. `grep -c pushCodeBranch src/services/team/memberCommands.ts` prints 0 (it was 2).

## Task Commits

1. Task 1 (tracer) RED: `f1bcd4c` test(61-23): expect the invite modal with Copy invite, how to send it, and a second chance before it is lost
2. Task 1 GREEN: `5d9ed53` feat(61-23): the invite modal with Copy invite, how to send it, and a second chance before it is lost
3. Task 2 RED: `72b4908` test(61-23): expect Link Your Organization to share with one confirmation, and no push helper left
4. Task 2 GREEN: `43b3e07` feat(61-23): Link Your Organization shares what it changed with one confirmation; the push helpers are gone

## TDD Gate Compliance

- Task 1 RED: `node --test --test-reporter=tap dist/test/teamMemberCommands.test.js dist/test/teamInviteShare.test.js` exited 1, with 48 tests, 16 passing and 32 failing.
  - The target was the teamMemberCommands tracer. It failed on its clipboard count (0 !== 1) because the modal offered only 'Copy'.
  - The other failures had the same cause: every helper and responder now answers 'Copy invite'. The new second-modal tests also failed because there was no second modal.
  - Classifier: RED_EVIDENCE_OK (target_test_failed).
  - Semantic assessment: everything compiled and ran. Each failure was the missing label, title, detail paragraph or second modal.
- Task 2 RED: the same command exited 1, with 50 tests, 31 passing and 19 failing.
  - The target was "Link signs in ... shares the team setup after one confirmation". It failed on its message assertion, because the old offer 'Linked Invite team to Team Org. Share it so your teammates see the link.' was still shown.
  - The declined test found no share question. The source scan found pushCodeBranch. Every test that uses linkAndPush failed on the helper's new check that the online team.json has the link.
  - Classifier: RED_EVIDENCE_OK (target_test_failed).
- Tracer feedback gate: auto mode. The Task 1 verify re-run passed (teamMemberCommands, teamInviteShare, teamSectionHost and teamPlainLanguage: 71/71), so the plan went on to Task 2.
- Every RED commit precedes its GREEN commit. There were no REFACTOR commits.

## Verification

- Task 1 verify (tsc, then teamMemberCommands and teamInviteShare, MemoryMax=4G): exit 0. With teamSectionHost and teamPlainLanguage added: 71 tests, 71 pass.
- Task 2 verify (tsc, then teamMemberCommands, teamInviteShare, teamJoinCommand, teamPlainLanguage, teamSessionMembers and teamSoloParity, MemoryMax=4G): exit 0, 89 tests, 89 pass.
- Broader impacted run, all `dist/test/team*.test.js` plus nearSignIn and toolsPage (MemoryMax=6G, timeout 1800): 1095 tests, 1091 pass, 2 skipped, 2 fail.
  - Both failures are the known deferred self-import tests: teamGsdImport "every plan committed at HEAD parses ..." and teamImport "this repository's own .planning at HEAD imports ...".
  - They are owned by 61-22 and were not weakened.
- `npm run lint` is `tsc --noEmit`, and it passed as part of each verify.
- Acceptance checks:
  - `grep -n "Copy invite"` and `grep -n "Close without copying"` both match in memberCommands.ts.
  - `grep -c pushCodeBranch` prints 0, and `grep -n "reason: 'link'"` matches.
  - memberCommands.ts has no em-dash.
  - Its static imports are still vscode, node:fs/promises, node:path, types and teamPrompts only.

## Tests changed from the old behaviour (owner rule)

- Label only, in every message responder and in the e2e script: 'Copy' became 'Copy invite'. This covers teamMemberCommands (copyWhenOffered and 8 inline responders), teamInviteShare (4 places) and teamSectionHost (copyWhenOffered). teamSectionHost.test.ts was not in the plan's file list, but its invite step would otherwise stop copying.
- In the teamMemberCommands tracer, the title is now 'Invite ready for Ana', the detail is the invite plus a blank line and the paragraph, and the button is ['Copy invite']. "Shown once" now counts details that contain the invite. Two checks were added: one that copying is announced, and one that scans settings, SecretStorage, extension storage and the team folder for the invite and its code.
- The teamInviteShare tracer, the already-online test and the scripted test now expect the new title, button and detail shape. The scripted test's detail check is now "the detail starts with the invite and a blank line".
- "closing the bundle without Copy says the invite can be issued again from Manage Team Members ..." became "closing the invite asks once more before it is lost; Close says it can be issued again from Members ...". It now expects both modals and the new sentence pointing at Members in the Team section. Two new tests cover dismissing both modals and choosing Copy invite in the second one.
- The Re-issue test also checks that Re-issue uses the same modal.
- linkAndPush answers the share confirmation instead of running `git push`, and checks that the online team.json has the link.
- "Link signs in ... and pushes only when asked" became "... and shares the team setup after one confirmation".
  - The share half now checks the one modal question with Share, the online team.json and the 'Your team setup is online' sentence. It no longer checks that the online main equals the local HEAD or the old 'Pushed main to origin.' line.
  - The old "nothing was pushed without asking" half is now its own test, "declining the share after Link ...". It checks the same facts (nothing online changed, the link committed here) plus the new sentence.
- New: a source-scan test that memberCommands.ts has no push helper and has reason: 'link'.
- In teamInviteShare's Link now case, a check was added that the Link command's share question is not asked inside Invite.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] teamSectionHost.test.ts responder updated to 'Copy invite'**
- **Found during:** Task 1 RED
- **Issue:** the 61-21 sidebar host test's copyWhenOffered answered 'Copy'. With the new label it would stop copying, and its join step would fail.
- **Fix:** the same one-word label change as in the plan's test files. No assertion was changed.
- **Files modified:** src/test/teamSectionHost.test.ts
- **Committed in:** f1bcd4c

**2. [Rule 1 - Test expectation] Two expectations in my new tests were corrected to the real behaviour**
- **Found during:** Task 1 GREEN
- **Issues:**
  - In a team without an organization, the close-without-copy test also sees the NO_ORG_NOTICE before the 'not copied' sentence.
  - The invite carries its code encoded, so the code is not plain text in any prompt record, the modal included. The scripted test now asserts 0 records hold the code, which is a stronger check than the 1 it first expected.
- **Fix:** both are expectations in tests written in this plan. No pre-existing assertion was loosened.
- **Files modified:** src/test/teamMemberCommands.test.ts, src/test/teamInviteShare.test.ts
- **Committed in:** 5d9ed53

**3. [Rule 2 - Missing critical] Manage Team Members' NEAR line shares the same way**
- **Found during:** Task 2
- **Issue:** the plan names the Link command. Manage Team Members' NEAR line in an unlinked team also ran linkFlow with the old push offer, and the plan requires that no membership command pushes a branch.
- **Fix:** both callers use `linkFlow(projectRoot, true)`, which now ends in shareLink. Only Invite passes false.
- **Files modified:** src/services/team/memberCommands.ts
- **Committed in:** 43b3e07

---

**Total deviations:** 3 auto-fixed (1 blocking, 1 test expectation, 1 missing critical).
**Impact on plan:** none on scope. They are needed to keep the existing tests honest and to keep the "no push" truth across every caller.

## Issues Encountered

None beyond the deviations above.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register.
- T-61-98: the invite is only in the first modal's detail and, after Copy invite, on the clipboard. The tests scan the channel, the other notifications, the prompt records, settings, SecretStorage, extension storage and the team folder.
- T-61-99: the push helpers are deleted. Link shares only through shareFlow, after one confirmation. A source-scan test and the acceptance grep pin pushCodeBranch at 0.
- T-61-SC: no package was installed.

## User Setup Required

None.

## Next Phase Readiness

- 61-22 can script the invite end to end. The fragments to match:
  - The bundle modal: 'Invite ready', answered 'Copy invite'.
  - The second modal, if a test closes the first: 'Close without copying', answered 'Copy invite' or 'Close'.
  - The Link command's share: 'Share your team setup so teammates see the organization link?', answered 'Share'.
- The known failing self-import tests (teamGsdImport, teamImport) remain for 61-22.

---
*Phase: 61-invitations-joining-removal-near-org-and-key-integration*
*Completed: 2026-11-03*

## Self-Check: PASSED

- src/services/team/memberCommands.ts, src/test/teamMemberCommands.test.ts, src/test/teamInviteShare.test.ts and src/test/teamSectionHost.test.ts exist and were modified.
- Commits f1bcd4c, 5d9ed53, 72b4908 and 43b3e07 (tasks) and 30df5e2 (summary) are ancestors of HEAD. There are 4 task commits since 44cc690.
- Every acceptance grep and both task verify commands passed as listed above.
