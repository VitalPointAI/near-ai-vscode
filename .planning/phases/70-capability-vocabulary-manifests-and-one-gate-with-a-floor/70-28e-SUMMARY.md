---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 28e
pr: 4e
subsystem: release (close-out of part 4e and of Phase 70)
status: complete (PR not opened: on the coordinator's instruction, nothing is pushed; the PR title and body are kept outside the repository)
tags: [close-out, PR-4e, CLAS-08, CLAS-07, OFFL-01, D-34, D-48, D-49, D-51, D-56]
requires: ["70-27"]
provides: ["the 4e CHANGELOG entry", "COVERAGE.md part 4 map with merged PR numbers", "70-VALIDATION.md part 4 records", "the gate record", "the last #89 review fixes", "the PR body (kept outside the repository for the coordinator)"]
affects: []
tech-stack:
  added: []
  patterns: []
key-files:
  created: []
  modified: [CHANGELOG.md, .planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/COVERAGE.md, .planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-VALIDATION.md, .planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-26-SUMMARY.md, .planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-27-SUMMARY.md, src/services/gateCommands.ts, src/services/nearAiClient.ts, src/services/agentSession.ts, src/gate/sessionMark.ts, src/services/chatInView.ts, src/domain/gate/trustBadge.ts]
decisions:
  - "Rebased onto origin/main after #92 and release 0.4.32 (#93) landed; the release had moved the Unreleased section, so the 4e entry was moved back under a new Unreleased in its own commit and 0.4.32's notes left as released"
  - "On the coordinator's instruction, the last #89 review findings are one commit after the plan work, and the full gate ran once on the branch with that commit"
  - "On the coordinator's instruction, no push and no PR: the title and body are written to the session's scratchpad"
  - "ROADMAP.md, STATE.md and REQUIREMENTS.md are left to the coordinator on main, as for parts 4a to 4d"
metrics:
  completed: 2026-11-18
  tasks: 3
estimate:
  tokens: 36019
actuals:
  tasks: 2
  commits: 4
---

# Phase 70 Plan 28e: Close-out of PR 4e and of Phase 70 Summary

PR 4e (plans 26 and 27: the trust badge, kept, seen end to end and documented, plus the last minor findings of #89's review) stands on current `origin/main` with only its own commits, has its CHANGELOG entry and the phase's coverage and validation records, and passed the full gate once inside the cap. It is not pushed or opened: the coordinator does that.

## Merged check and rebase (Task 1)

- PR 4d is #89, as 70-28d-SUMMARY.md and the coordinator say. `gh pr list --state merged --head feat/gate-attested-routing --base main` lists #89 with merge commit `542cc54b324fedee3fa32651a775def237ee5ba4`; after `git fetch origin`, `git merge-base --is-ancestor 542cc54b origin/main` exited 0.
- PR4E_BASE (70-26-SUMMARY.md) is `0333533c`. While plans 26 and 27 ran, #92 (relay sidecar pin) and release 0.4.32 (#93) landed, so `git rebase --onto origin/main 0333533c feat/gate-trust-badge` moved the branch onto `0f1938fe03f9a07de9496bed960bc41a5981e350`. The rebase was clean. The release had moved the Unreleased section into 0.4.32, so the rebased CHANGELOG commit put the 4e bullets into 0.4.32's notes and edited one of its 4d bullets; `3a29aa38` moves the 4e bullets under the new `## Unreleased`, adds a line for the review fixes, and leaves 0.4.32's notes exactly as released (`git diff origin/main -- CHANGELOG.md` adds lines only under Unreleased). The plan 26 and 27 SUMMARY hashes were updated to the rebased ones.
- **CHANGELOG** (`ee89292a`, `3a29aa38`): the trust badge and its three states, the automatic check and its cost, Check again and Show full attestation, reopened chats, and the review fixes. No em-dash, no phase number, no decision id.
- **Phase close-out** (`e61b3399`): COVERAGE.md's part 4 map names the merged PR of each part for every requirement (4a #81, 4b #85, 4c #87, 4d #89, 4e this PR; PR 1 #66), one row per requirement for CLAS-01 to CLAS-08, GATE-07 and OFFL-01. 70-VALIDATION.md's part 4 delivery map lists the test files the plans created (from their SUMMARYs), and each manual verification is marked open with who does it: the security officer's preset check, the D-48 code-server check before publishing the release that carries 4e, the plain-wording read, the live connection-binding comparison (now read from the trust badge), and the badge themes. None was recorded as done, so none is marked done.
- 4e's tests and the parity set (`gate*`, attestation, threadMerge, threadLog, conversations, checkNow, steering, syncControl, responsivePanels, teamBoundaries): 955 tests, 0 failed.
- `git log --oneline origin/main..HEAD` before this SUMMARY:

```
3a29aa38 docs(changelog): the 4e entry goes under Unreleased, after release 0.4.32
1bccf4a1 fix(gate): the last minor findings of PR #89's review, each with a test
e61b3399 docs(70): part 4 coverage and validation records
ee89292a docs(changelog): part 4e, the trust badge
6f029e1c docs(70-27): complete the kept and documented trust badge plan
6d562f15 docs(gate): the trust badge in SECURITY.md and README
0e902764 test(gate): the trust badge renders in the real chat page
6b4021b9 feat(gate): trust badges come back when a chat reopens, never stronger
3ef28140 docs(70-26): complete the trust badge plan
aec4129a feat(gate): the trust badge explains itself and shows the full attestation on request
c86d6381 feat(gate): the trust badge shows what the checks proved, once per answer, and never waits forever
dca96bd3 feat(gate): a trust badge on every cloud answer
```

Only plans 26 and 27, this plan's commits, and the review-fix commit the coordinator asked for.

## The last #89 review findings (`1bccf4a1`, each with a test)

1. **Set Label's "the chat keeps its label" notice** is shown only when the new label is absent or does not cover the chat's mark (`chatKeepsLabel` in gateCommands.ts); a raise says nothing. Test: gateChatLabel "review 89 minor 1" (lowered, removed, raised, same level, another scale, a chat that did not hold the old label).
2. **No attested answer goes unrecorded.** An answer whose request the route allowed at attested-cloud but which cannot be checked records `route.attestation-checked` as unavailable with a plain reason (`UNCHECKABLE_ANSWER_REASONS`): no signature id on a streamed answer, or a read path that keeps no hashes (non-streamed completions, images, transcriptions, the plain text streams). Test: gateTrustBadge "review 89 minor 2" (a stream with no chat id, then a non-streamed answer, each recorded once with its reason, no stop).
3. **Check again after the newest-50 list.** Each failed answer check's run, model, hashes, client and route are kept for the whole chat (`routeFailures`, at most `FAILED_CHECKS_KEPT` = 100), and `verifyRun` reads them from there, so Check again on a failed answer whose run left the newest-50 list can still clear the stop. A failure dropped past the bound keeps the stop, and Check again's result (`CHECK_AGAIN_NEW_CHAT_TEXT`) and the badge (`TRUST_BADGE_TEXT.earlierFailedLost`) say plainly that a new chat is needed. Tests: gateRouteTiers "review 89 minor 3" (both runs evicted: the second's Check again leaves the stop, the first's clears it and records `route.attestation-cleared`; a failure no longer kept: the stop stays, both texts say so, a new chat clears it). The existing review 89.3 test passes unchanged.
4. **The `ChatInView` doc comment** is back directly above its type. Test: gateChatLabel "review 89 minor 4".

The owner's answer to 4d's question is kept: a new chat or a window reload also clears the stop.

## Size and lock

`package-lock.json` is unchanged against `origin/main`. The PR diff was 272,018 bytes (35 files, +2,501 / -229) before this SUMMARY, under the 950,000 budget; at the plan's 2.2 ratio it projects to about 598 KB after review, under the ~650 KB target.

## Gate record (Task 2), each run once, in order, inside the cap, under the shared lock

| Command | Result |
|---|---|
| `npm run lint && npm test` (6G, 1800 s) | exit 0; 3862 tests, 3853 pass, 0 fail, 0 cancelled, 9 skipped (the same 9 as before this branch) |
| `npm run test:e2e` under `xvfb-run -a` with `WAYLAND_DISPLAY`, `XDG_SESSION_TYPE` and `WAYLAND_SOCKET` removed, VS Code 1.144.1 from the local cache (6G, 1800 s) | exit 0; both scenarios passed, 22 tests (17 project, 5 plain), 0 failed, including "✔ [project] the trust badge renders under a cloud answer in the real chat page, not under a local one, and comes back after the view reloads (CLAS-08)" |
| `npm run verify:release` (4G) | exit 0; release content verified (405 entries, 324 runtime JavaScript files, 50 required assets); no artifacts line |
| `node scripts/secret-scan.mjs --range origin/main..HEAD` | exit 0; clean, 1298 tracked files, 12 commits |

No gate failed or was rerun. The e2e launch accepted `NODE_OPTIONS`.

## PR body (Task 3)

Written to the session's scratchpad as `pr-4e-body.md`, outside the repository, with the title on its first line: `feat(gate): a trust badge on every cloud answer (Phase 70, part 4e)`. It describes CLAS-08 as built (three states from checks that ran, the details and full attestation on request, replayed when a chat reloads, seen end to end), the owner's decision of 2026-11-16 and its cost, D-51, D-56, the pinned-connection rule for Verified private model, the review fixes, that the PR closes Phase 70 with the COVERAGE.md table, the theme check left for a person, the D-48 release blocker, the owner's questions, the test totals, the size and the rollback. Task 3's push, CI watch and agent review are left to the coordinator.

## Owner questions (in the PR body)

1. Should a sub-agent's answer ever show a badge, for example in Team Live? Recommendation: not now.
2. Should requests at any-cloud also go over the pinned connection when a fresh bound fact exists, so a Public chat's TEE answers can show Verified private model? Recommendation: yes, falling back to an unpinned send (Model verified, connection not proven) on a pin mismatch rather than refusing.

## Deviations from Plan

1. **[Coordinator] No push, no PR, no CI watch.** The coordinator opens the PR from the body file.
2. **[Coordinator] The review-fix commit** sits after the plan work; the gate ran once on the branch with it.
3. **The rebase moved the branch** onto `0f1938fe`; the CHANGELOG entry needed its own follow-up commit because a release landed meanwhile (above).
4. **ROADMAP.md, STATE.md and REQUIREMENTS.md** were not updated on this branch, as with the earlier part 4 close-outs; the coordinator updates them on main once 4e merges.
5. **The e2e run used the cached VS Code 1.144.1** (`VSCODE_TEST_VERSION=1.144.1`, copied into the worktree's ignored `.vscode-test/`), so no download was needed.

## Self-Check: PASSED

CHANGELOG has one `## Unreleased` holding the 4e entry; every commit above is an ancestor of HEAD; `git diff --quiet origin/main...HEAD -- package-lock.json` exits 0; COVERAGE.md has no "pending (70-28e)" left.
