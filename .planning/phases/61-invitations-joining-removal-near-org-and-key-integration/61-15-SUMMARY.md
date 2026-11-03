---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 15
subsystem: team-core-wording
tags: [gap-closure, G-61-6, plain-language, organization, tdd]
status: complete

requires:
  - phase: 61-invitations-joining-removal-near-org-and-key-integration
    provides: "61-07 invite, 61-08 link, 61-09 join, 61-10 key delivery, 61-11 removal, 61-14 lifecycle and privacy suites"
provides:
  - "NO_ORG_NOTICE = 'No organization linked, so everyone uses their own key and spending is not capped.'"
  - "LINK_COMMIT_MESSAGE = 'chore(team): link the team organization'"
  - "NEAR_PIN_MISMATCH and its siblings name a different organization or workspace and the command title \"NEAR AI: Link Your Organization\""
  - "every manual step in remove, key delivery and the NEAR AI client points at your organization's settings on the NEAR AI website"
affects: [61-24, 61-22]

plan_head_before: 56e6cdcc002bfe3aa8e0184297b2cceb808b9996
plan_head_after: 1a16b740fdc7c3a1ab0eff78cac0805af606d02e
actuals:
  tokens: 12700
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "tests compare people-facing sentences against the exported constant (NO_ORG_NOTICE) instead of a copied literal"
    - "one fixed phrase for every manual step: your organization's settings on the NEAR AI website"

key-files:
  created:
    - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/deferred-items.md
  modified:
    - src/team/join.ts
    - src/team/invite.ts
    - src/team/remove.ts
    - src/team/keyDelivery.ts
    - src/team/nearLink.ts
    - src/team/teamFile.ts
    - src/team/nearOrg.ts
    - src/test/teamJoin.test.ts
    - src/test/teamFile.test.ts
    - src/test/teamConfirm.test.ts
    - src/test/teamRemove.test.ts
    - src/test/teamMemberCommands.test.ts
    - src/test/teamSessionMembers.test.ts

key-decisions:
  - "A member's key is called 'AI key'; a key the link protects in general ('no team key was changed') is called 'team key'"
  - "Every manual step uses the same phrase, your organization's settings on the NEAR AI website, so one regex checks them all"
  - "NEAR as a provider subject became NEAR AI ('NEAR AI did not find this key'); 'NEAR login' became 'NEAR AI account'"
  - "The pin texts already name the command title 'NEAR AI: Link Your Organization'; the command itself is renamed in 61-24"
  - "Adapter text in src/services/team (progress steps, Link prompts, 'You joined the NEAR organization.') is left for 61-24, so teamMemberCommands line 462 still checks the adapter's 'NEAR organization' notice unchanged"

patterns-established:
  - "a tracer assertion pins the exact owner wording once (teamJoin), and every other test reads the constant"

requirements-completed: [TEAM-02, TEAM-03]

duration: 30min
completed: 2026-11-03
---

# Phase 61 Plan 15: Core flow wording uses "your organization" Summary

**The join, invite, link, team file pin, removal, key delivery and NEAR AI client sentences now call the paying account "your organization", send manual steps to your organization's settings on the NEAR AI website, and name NEAR AI only as the AI provider, with no code path, event body or stored reason changed.**

## Performance

- Duration: about 30 minutes
- Tasks: 3 (tracer, two auto), each RED then GREEN
- Files: 7 source, 6 test, 1 deferred-items note

## Accomplishments

- NO_ORG_NOTICE reads "No organization linked, so everyone uses their own key and spending is not capped." and is shown unchanged by join, Invite, Confirm, Manage Team Members and the status tooltip. teamMemberCommands now imports it instead of copying it, and teamSessionMembers checks the tooltip against the escaped constant.
- Join refusals, the lead's acceptance and sign-in notices, the invite notices and retry reasons, the link refusal and save failure, LINK_COMMIT_MESSAGE and the three pin texts follow the terminology table.
- Every manual step in remove.ts, keyDelivery.ts and nearOrg.ts (cap to 0, revoke, remove from the organization, cancel a pending invitation, a new key that could not be revoked or looked up) names the person and the action and points at your organization's settings on the NEAR AI website.
- Task 3 invariants pass: no non-comment line in the seven core files matches `NEAR +(organization|console|key|link)` (37 at a7fcba5), and the domain event, permission and invite files plus the event, bundle and crypto modules are unchanged since a7fcba5. `grep -c "NEAR AI website" src/team/nearOrg.ts` is 2.

## Task Commits

1. Task 1 (tracer) RED: `69168bd` test(61-15): pin the no-organization notice to the owner's new wording
2. Task 1 GREEN: `d2799c8` feat(61-15): say 'No organization linked' in the no-organization notice
3. Task 2 RED: `a72be6a` test(61-15): expect the organization wording in join refusals and the link pin
4. Task 2 GREEN: `2a82873` feat(61-15): speak of your organization in the join, invite, link and pin sentences
5. Task 3 RED: `f5e5049` test(61-15): expect manual steps at your organization's settings on the NEAR AI website
6. Task 3 GREEN: `1a16b74` feat(61-15): point manual steps at your organization's settings on the NEAR AI website

## TDD Gate Compliance

- Task 1 RED: `node --test --test-reporter=tap dist/test/teamJoin.test.js`, exit 1, 16 tests, 1 fail; target "the notice for a team without a linked organization says in plain words that everyone uses their own key and spending is not capped" failed on ERR_ASSERTION (old sentence). Classifier: RED_EVIDENCE_OK (target_test_failed). Semantic assessment: the target ran and failed on the planned equality assertion only.
- Task 2 RED: `node --test --test-reporter=tap dist/test/teamFile.test.js`, exit 1; target "CR-01: the NEAR link pin is taken on first sight of a linked team.json and refuses a changed or dropped link afterwards" failed on its validation function (old pin wording). Classifier: RED_EVIDENCE_OK. The four-file run also failed exactly the four edited tests (teamJoin WR-03, teamFile CR-01, teamRemove CR-01 workspace, teamConfirm CR-01) on ERR_ASSERTION.
- Task 3 RED: `node --test --test-reporter=tap dist/test/teamRemove.test.js`, exit 1; target "CR-01: a key the linked workspace does not list is a manual item for the NEAR console, never a finished cap or revoke" failed on ERR_ASSERTION (still "NEAR console"). Classifier: RED_EVIDENCE_OK. The three-file run failed exactly the 9 edited tests.
- GREEN for each task: the plan's verify command exits 0 (results below).

## Verification

- Task 1: teamJoin, teamMemberCommands, teamSessionMembers, teamFlow: 68 tests, 68 pass, 0 fail. Tracer gate (auto mode): re-run end-to-end passed, expanded.
- Task 2: teamJoin, teamFile, teamNearLink, teamInviteFlow, teamInvite plus teamRemove, teamConfirm, teamMemberCommands: 162 tests, 162 pass, 0 fail (teamNearLink and teamInviteFlow unchanged).
- Task 3: teamRemove, teamConfirm, teamNearOrg, teamMemberCommands, teamFlow, teamInvitePrivacy: 113 tests, 113 pass, 0 fail (teamNearOrg unchanged). Grep and diff invariant command exits 0.
- Broader impacted check, all `dist/test/team*.test.js` (58 files, MemoryMax=6G): 953 tests, 949 pass, 2 skipped, 2 fail. Both failures are pre-existing and unrelated (see Deferred Issues).
- `tsc -p tsconfig.json` (the repository's lint) clean.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Pin-mismatch expectations in teamRemove and teamConfirm updated in Task 2, not Task 3**
- Found during: Task 2
- Issue: renaming NEAR_PIN_MISMATCH in Task 2 breaks three assertions (teamRemove line 308, teamConfirm lines 286 and 296) that check the same "different organization or workspace" fact; leaving them for Task 3 would have left Task 2's commit red.
- Fix: those three regexes moved to the new wording in Task 2's RED commit; the fact checked is unchanged.
- Files: src/test/teamRemove.test.ts, src/test/teamConfirm.test.ts
- Commit: a72be6a

**2. [Rule 1 - Kept an existing check] Two sentences reworded to keep unchanged tests passing**
- Found during: Task 2 and Task 3
- Issue: a first wording of NO_MATCHING_INVITATION dropped "invite your NEAR", which teamJoin checks, and a first wording of the invite-role refusal dropped "cannot invite", which teamNearOrg (must pass unchanged) checks.
- Fix: "ask the lead to invite your NEAR AI email address" and "Your role in your organization cannot invite people to it." Those tests were not edited.
- Files: src/team/join.ts, src/team/nearOrg.ts
- Commits: 2a82873, 1a16b74

**3. Tests strengthened beyond the plan's named lines**
- teamJoin now also checks that a different-link join is refused naming "a different organization than this project does", and teamFile checks that the pin mismatch names "NEAR AI: Link Your Organization". teamMemberCommands' stopped-removal check (line 809) follows the new remove.ts note. No assertion was removed or loosened.

### Not changed on purpose

- teamMemberCommands line 462 (lead join "reports the organization invitation") checks the adapter notice "You joined the NEAR organization." from src/services/team/memberCommands.ts, which this plan does not touch; it passes unchanged and moves with the adapter text in 61-24. Using NO_ORG_NOTICE there would have been wrong (that team is linked).

## Deferred Issues

- `teamGsdImport` "every plan committed at HEAD parses ... finished phases 60 and 61" and `teamImport` "this repository's own .planning at HEAD imports into a correct graph" fail because they read this repository's own `.planning` and expect Phase 61 to be finished with 14 plans; they fail since the fix-pass plans were committed (7b3a441), independent of this plan. Logged in deferred-items.md for the final full-suite plan.

## Threat Flags

None. Only string literals changed; no new endpoint, file access or trust boundary.

## Self-Check: PASSED

- All 7 source files and 6 test files exist and are modified as listed.
- Commits 69168bd, d2799c8, a72be6a, 2a82873, f5e5049, 1a16b74 are ancestors of HEAD.
- Acceptance greps: the new NO_ORG_NOTICE line in join.ts (1), `import { NO_ORG_NOTICE }` in teamMemberCommands.test.ts (1), "chore(team): link the team organization" in nearLink.ts (1), "NEAR AI website" in nearOrg.ts (2).
