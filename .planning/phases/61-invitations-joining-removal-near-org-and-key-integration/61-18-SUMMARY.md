---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 18
subsystem: team
tags: [gap-closure, G-61-4, join, git, catch-up, tdd]
status: complete

requires:
  - phase: 61-15
    provides: "fix-pass baseline wording and the join core this plan extends"
provides:
  - "src/team/joinCatchUp.ts: projectAddressKey, findSameProjectRemote, catchUpCopy, CatchUpResult, CatchUpReason, CATCH_UP_PROBE_REF"
  - "prepareJoin({ projectRoot, bundleText, git?, onStep? }) answering ready (updated?: true), clone-needed, not-ready { reason, repoUrl, teamId, detail? } or refused"
  - "JoinPreparationStep ('update') for the command adapter's progress message"
affects: [61-20, 61-22, 61-24]

actuals:
  tokens: 10319
  tasks: 3
  commits: 6
plan_head_before: 5fe9f4e67d8d31f8ced18e88e10767a0d6366c65
plan_head_after: 030d4a50ed8088ece2320fbcdb23c7950a142f5e

tech-stack:
  added: []
  patterns:
    - "Same-project detection compares a normalised host/path key of the invite address with the remotes already configured in the copy; git is only ever given a remote name"
    - "Check everything first, then change once: the only change to the copy is merge --ff-only of the fetched tip commit"
    - "A private probe ref (refs/near-ai/catch-up/head) fetched to read the online default branch and deleted in a finally block"

key-files:
  created:
    - src/team/joinCatchUp.ts
    - src/test/teamJoinCatchUp.test.ts
  modified:
    - src/team/join.ts
    - src/test/teamJoin.test.ts
    - src/services/team/memberCommands.ts

key-decisions:
  - "projectAddressKey refuses an http, https or ssh address with a password even though cleanRepoUrl would strip it, so a copy whose remote holds a token keeps the old clone-needed answer"
  - "An untracked or ignored team.json in the copy is local-changes: git treats ignored files as expendable, and the fast-forward would otherwise overwrite it silently"
  - "A branch that is not online, or an online tip without the invite's team.json, is other-version when the online default branch has the team, otherwise not-shared"
  - "When the invite names a link team.json lacks, a catch-up that is refused answers not-ready with its reason; a catch-up that succeeds but still has no link keeps the existing refusal sentence"
  - "memberCommands.ts answers not-ready with one interim plain sentence (detail to the output channel) so the extension compiles and says something true; 61-20 replaces it with a sentence and button per reason"

patterns-established:
  - "Recorded git runner audit: only config (read), symbolic-ref, rev-parse, fetch, ls-remote, cat-file, merge-base, status, ls-files, update-ref -d of the probe ref, merge --ff-only; no argument holds the invite address or any URL"

requirements-completed: [TEAM-02]

coverage:
  - id: D1
    description: "A behind copy of the same project is brought up to date by itself and prepareJoin answers ready with updated; an up-to-date copy is ready with no network call"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamJoinCatchUp.test.ts#tracer: a behind clone of the same project is brought up to date by itself and prepareJoin answers ready"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinCatchUp.test.ts#a copy that is already up to date with a matching team.json is ready with no update and no network call"
        status: pass
      - kind: unit
        ref: "src/test/teamJoinCatchUp.test.ts#projectAddressKey gives one key for every way of writing the same address, and none for a local path, a file address or a password"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every unsafe catch-up is refused with local-changes, unshared-work, other-version, not-shared or offline, and HEAD, branches, index and status are unchanged; only safe git calls, never the invite address"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamJoinCatchUp.test.ts#a copy with an edited tracked file is not updated (local-changes), and the edit, HEAD, branches, index and status stay as they were"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinCatchUp.test.ts#an untracked team.json left by an earlier attempt is a local change and stays exactly as it was"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinCatchUp.test.ts#an untracked file the online version would overwrite stops the fast-forward (local-changes) with a redacted detail"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinCatchUp.test.ts#a copy with a commit that is not online is not updated (unshared-work) and nothing changes"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinCatchUp.test.ts#a copy on another version is not updated (other-version): a branch that is not online, an online branch without the team, and a detached copy"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinCatchUp.test.ts#when the owner never published the project with the team in it, the copy is not updated (not-shared)"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinCatchUp.test.ts#when the online home cannot be reached the copy is not updated (offline) and the detail is redacted"
        status: pass
    human_judgment: false
  - id: D3
    description: "Old answers kept (clone-needed for no folder, another address, not a project) and a missing organization link triggers the same catch-up"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamJoinCatchUp.test.ts#a different project, no open folder or a folder that is not a project still answers clone-needed, with no network call"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinCatchUp.test.ts#an invite naming an organization link the copy does not have yet catches the copy up, and the link comes from team.json"
        status: pass
      - kind: integration
        ref: "src/test/teamJoinCatchUp.test.ts#when the lead linked the organization but did not publish it, the join is refused with the existing sentence and nothing changes"
        status: pass
      - kind: integration
        ref: "src/test/teamJoin.test.ts#prepareJoin still answers clone-needed for a copy whose remote has a different address, and never fetches it"
        status: pass
    human_judgment: false
  - id: D4
    description: "The person reads a plain sentence for each catch-up outcome in the real Join command"
    verification: []
    human_judgment: true
    rationale: "The per-reason sentences and buttons belong to the command adapter in 61-20; this plan only returns codes, with one interim sentence"

duration: 11 min
completed: 2026-11-03
---

# Phase 61 Plan 18: Join Catch-Up of an Existing Copy Summary

**prepareJoin now brings an open copy of the same project up to date by itself (fetch of its current branch from the matching configured remote, then a fast-forward only), and answers not-ready with local-changes, unshared-work, other-version, not-shared or offline, changing nothing, whenever that is not safe; only a different or missing project still asks to download it.**

## Performance

- Duration: 11 min (2026-11-03T21:57:47Z to 2026-11-03T22:08:30Z)
- Tasks: 3 (tracer, two auto), each RED then GREEN
- Files: 2 created, 3 modified

## Accomplishments

- G-61-4 core: in the owner's test Bob had a clone made before Team Mode, and Join told him to get the project. Now `findSameProjectRemote` recognises the copy (https, scp and ssh forms, host case, `.git`, trailing slash, port 22 all compare equal) and `catchUpCopy` brings it up to date before the join goes on.
- Safety: every check runs before any change (current branch, the online tip's team.json names the invite's team, HEAD in the online history, no tracked changes, no untracked or ignored team.json), and the only change is `merge --ff-only` of the fetched tip. No reset, stash, checkout, switch or remote add anywhere in the module.
- Hostile invite (T-61-75): the invite's address only picks among remotes the copy already has; git is told the remote name. The recorded-runner audit checks every git call in every test.
- A lead who links the organization after the invitee's copy was made no longer blocks the join: the missing link triggers the same catch-up once, and an unpublished link keeps the existing refusal.

## Task Commits

1. Task 1 (tracer) RED: `44482a2` test(61-18): expect a behind copy of the same project to be brought up to date before a join
2. Task 1 GREEN: `ba009a9` feat(61-18): bring a behind copy of the same project up to date before a join
3. Task 2 RED: `a6b960e` test(61-18): expect every unsafe catch-up to be refused with its reason and leave the copy untouched
4. Task 2 GREEN: `5e74ddf` feat(61-18): refuse every unsafe catch-up with a precise reason before anything changes
5. Task 3 RED: `77a4de4` test(61-18): expect a missing organization link to catch the copy up and the old join answers to stay
6. Task 3 GREEN: `030d4a5` feat(61-18): catch the copy up once when the invite names an organization link team.json does not have yet

## TDD Gate Compliance

- Task 1 RED: `node --test --test-reporter=tap dist/test/teamJoinCatchUp.test.js`, exit 1, 3 tests, 2 fail; target "tracer: a behind clone of the same project ..." failed on `readyOf` (actual clone-needed, expected ready). Classifier: RED_EVIDENCE_OK (target_test_failed). Semantic assessment: compiled and loaded against the declared-only module; prepareJoin still answered clone-needed, the planned behaviour gap. The projectAddressKey test failed on "not implemented"; the no-network test already passed (existing behaviour, kept as a guard).
- Task 2 RED: same command, exit 1, 10 tests, 2 fail; targets "an untracked team.json left by an earlier attempt ..." (actual ready: the fast-forward overwrote the ignored file) and "a copy on another version ..." (actual offline, expected other-version). Classifier: RED_EVIDENCE_OK for both. Semantic assessment: both failed on the planned reason assertion. The tracked-edit, overwrite, unshared-work, not-shared and offline cases already passed from Task 1's checks (kept as regression guards).
- Task 3 RED: same command, exit 1, 13 tests, 1 fail; target "an invite naming an organization link the copy does not have yet ..." got the existing link refusal instead of ready. Classifier: RED_EVIDENCE_OK. The clone-needed and unpublished-link cases already passed (guards of the old answers).
- Tracer feedback gate: auto mode, Task 1 verify re-run passed (3/3), expansion continued.
- Every RED commit precedes its GREEN commit; no REFACTOR commits.

## Verification

- Task 1 command (tsc, then teamJoinCatchUp, MemoryMax=4G): exit 0, 3 tests, 3 pass. teamJoin plus teamJoinCatchUp: 19 pass.
- Task 2 command: exit 0, 10 tests, 10 pass.
- Task 3 command (tsc, then teamJoin, teamJoinCatchUp, teamFlow, teamInvitePrivacy): exit 0, 33 tests, 33 pass, 0 fail.
- Broader impacted run (every test file using prepareJoin, memberCommands, the flow rig or the plain-language scan: teamImport, teamFlow, teamBoardItems, teamPlainLanguage, teamSoloParity, teamBoardLive, teamItemForgery, teamItemPrivacy, teamJoin, teamJoinCatchUp, teamInvitePrivacy, teamBoardView, teamSessionImport, teamManifest, teamMemberCommands; MemoryMax=6G): 178 tests, 177 pass, 1 fail. The one failure is the known deferred teamImport self-import test ("this repository's own .planning at HEAD ..."), now reporting `plan:61-18` backlog because this plan's SUMMARY is not committed at HEAD yet; same cause as logged in deferred-items.md, owned by 61-22, not weakened.
- Acceptance: `export async function catchUpCopy` present; `catchUpCopy(` in join.ts (line 98); vscode imports in joinCatchUp.ts and join.ts 0 and 0; `grep -c "^test(" src/test/teamJoinCatchUp.test.ts` 13; `grep -cE "'(reset|stash|checkout|switch)'" src/team/joinCatchUp.ts` 0; `git diff --quiet a7fcba5 -- src/team/inviteBundle.ts ... src/domain/team/invite.ts` exit 0 (bundle format, join event and invite rules unchanged).

## Decisions Made

- An address with a password never matches (projectAddressKey returns undefined), even though cleanRepoUrl would strip an https password: the plan asks for it and it keeps such a copy on the old, safe clone-needed path.
- An ignored team.json is checked on its own with `ls-files --others` (no `--exclude-standard`), because git overwrites ignored files during a fast-forward without asking.
- `merge --ff-only` is given the fetched tip commit id, not the ref name, so the copy moves to exactly the commit that was checked.
- The online default branch is read only to tell other-version from not-shared (`ls-remote --symref`, private fetch into `refs/near-ai/catch-up/head`, deleted in a finally block).
- For a missing link, a refused catch-up answers not-ready with its reason (the person learns why the copy could not be updated); a successful catch-up that still has no link keeps BUNDLE_LINK_NOT_IN_PROJECT.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] memberCommands.ts had to handle the new not-ready answer to compile**
- **Found during:** Task 1 (RED commit, where the JoinPreparation type gained not-ready)
- **Issue:** the Join command destructures `teamFile` after the refused and clone-needed checks, which no longer type-checks once prepareJoin can answer not-ready. The file is not in this plan's files list; its full handling is 61-20.
- **Fix:** one interim branch: the redacted detail goes to the output channel and the person reads one plain sentence ("Your copy of this project could not be brought up to date by itself, so nothing in it was changed. Ask your lead for help, then run NEAR AI: Join Team again."). No git words; passes teamPlainLanguage and teamMemberCommands.
- **Files modified:** src/services/team/memberCommands.ts
- **Verification:** tsc clean; teamMemberCommands and teamPlainLanguage pass in the broader run.
- **Committed in:** 44482a2

**2. [Rule 2 - Critical] Extra refusal case: an untracked file the fast-forward would overwrite**
- **Found during:** Task 2
- **Issue:** the plan maps a failing ff-only merge to local-changes but had no case that exercises it.
- **Fix:** a test where the owner publishes notes.txt and the copy has its own untracked notes.txt; the merge refuses, the answer is local-changes with a redacted detail, and the person's file is untouched.
- **Files modified:** src/test/teamJoinCatchUp.test.ts
- **Committed in:** a6b960e

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 missing coverage).
**Impact on plan:** the interim adapter sentence is the only change outside the plan's files and is replaced by 61-20. No scope creep.

## Issues Encountered

None beyond the known deferred teamImport self-import failure (deferred-items.md, owned by 61-22).

## Known Stubs

- src/services/team/memberCommands.ts (join, not-ready branch): one interim sentence for every not-ready reason. Intentional; 61-20 gives each reason its own sentence and button ("Get a fresh copy" and so on).

## User Setup Required

None.

## Next Phase Readiness

Ready for 61-19. 61-20 can map `ready.updated`, `onStep('update')` and each not-ready reason to plain words in the Join command.

## Self-Check: PASSED

- FOUND: src/team/joinCatchUp.ts, src/test/teamJoinCatchUp.test.ts
- FOUND commits: 44482a2, ba009a9, a6b960e, 5e74ddf, 77a4de4, 030d4a5
