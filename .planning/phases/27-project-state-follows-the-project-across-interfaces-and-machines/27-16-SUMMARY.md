---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 16
subsystem: release-and-owner-check
tags: [phase-gate, owner-check, release, readme, security, changelog, 0.4.20]
status: complete

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-01 to 27-15 (project state, history, model choices, migration, pick-up card, encrypted sync); 27-17 and 27-18 (online home D-14, sync control D-16); gap closure 27-19 to 27-36"
provides:
  - "README.md: project state, sync and the recovery code, the online home, the same-computer key copy, what the git host can see, the three settings, when sync runs, the file-permissions sentence, troubleshooting"
  - "SECURITY.md: the encryption model, no escrow, anonymous commits, residual leaks, the recovery-code limit"
  - "CHANGELOG.md: the ## 0.4.20 section with the known limits"
  - "Release 0.4.20: feature PR #40 and release PR #41, both squash-merged; tag v0.4.20; publish approved by the owner"
  - "The owner's check on the real host: 27-UAT.md test 8 passed on 2026-11-17 with 0.4.29"
affects: [27-UAT, 27-VERIFICATION, ROADMAP, STATE]

requirements-completed: [SYNC-08]

key-files:
  created: []
  modified:
    - README.md
    - SECURITY.md
    - CHANGELOG.md
    - package.json
    - package-lock.json

key-decisions:
  - "The release went first (2026-11-14) and the owner's host check last (2026-11-17), not in the plan's order: the code and docs were ready and gated, and the check that only real editors can do waited for the gap fixes to ship."
  - "Task 2's steps were split by who can do them. Steps that a real VS Code window or a real GitHub account can do were automated on 2026-11-13 (27-UAT.md tests 1 to 7). The one step only the owner's own editors can do, opening the owner's old encrypted chats, is test 8, which the owner passed."
  - "Every difference the automated run found became a gap (G-27-2, G-27-4a to 4d, G-27-6a to 6c), each with an executed gap-closure plan and a passing regression test, which is the plan's own acceptance rule for Task 2."

coverage:
  - id: D1
    description: "Phase gate before the PR: full suite, e2e, release-content check and secret scan, each memory-capped and alone"
    requirement: SYNC-08
    verification:
      - kind: other
        ref: "Gate of 27-36 Task 2 (the same command as Task 1): lint exit 0; npm test 2000 tests, 1991 pass, 0 fail, 9 Windows-only skips; e2e exit 0; release content verified; secret scan clean"
        status: pass
      - kind: other
        ref: "CI on PR #40 and on PR #41: required checks green before each merge"
        status: pass
    human_judgment: false
  - id: D2
    description: "README and SECURITY.md describe the feature, its privacy model and its settings"
    requirement: SYNC-08
    verification:
      - kind: other
        ref: "README.md on main: nearAi.history.liveConversations 2, nearAi.sync.keepKeyInProject 3, nearAi.sync.intervalMinutes 2, 'file permissions' 2, 'online home' 10; 'NEAR organization' 0 in README.md and SECURITY.md"
        status: pass
    human_judgment: false
  - id: D3
    description: "The owner confirms the real scenario on the host: both editors list and open the owner's own old chats"
    requirement: SYNC-01
    verification:
      - kind: manual
        ref: "27-UAT.md test 8: owner, 2026-11-17, 0.4.29 in code-server and desktop VS Code; Show Chat History lists both editors' old chats and they open in full"
        status: pass
    human_judgment: true
  - id: D4
    description: "The rest of the Task 2 scenario (same chats, comparisons, pick-up card with no spend, sync control, same-host key, restore with the recovery code, online home, what GitHub sees)"
    requirement: SYNC-06
    verification:
      - kind: other
        ref: "27-UAT.md tests 1 to 7: real VS Code windows and a real private GitHub repository, 2026-11-13; tests 1, 3, 5 and 7 passed; the defects in tests 2, 4 and 6 were fixed by 27-19 to 27-25 and re-verified on 2026-11-17 (every gap resolved)"
        status: pass
    human_judgment: false
  - id: D5
    description: "CHANGELOG ## 0.4.20 states the known limits: spend limit counts one editor, sub-agent steps as linked threads later, the 2 MiB marker, the old recovery code still opens what is synced"
    requirement: SYNC-08
    verification:
      - kind: other
        ref: "awk '/^## 0.4.20/,/^## 0.4.19/' CHANGELOG.md: spend or daily limit 1, sub-agent 3; the recovery-code, 2 MiB, join-instant and Chat-view error lines are present"
        status: pass
    human_judgment: false
  - id: D6
    description: "0.4.20 reaches main only through squash-merged PRs, is tagged, and is published only with the owner's approval"
    requirement: SYNC-08
    verification:
      - kind: other
        ref: "PR #40 (feat/project-state-sync, merged 2026-11-14 as 765fb96) and PR #41 (release/0.4.20, merged 2026-11-14 as 4eac510, package.json 0.4.20); tag v0.4.20 on origin; Release workflow build, release and publish succeeded, with the marketplace environment approved by the owner"
        status: pass
    human_judgment: false

completed: 2026-11-17
---

# Phase 27 Plan 16: Phase gate, owner's check on the real host and release 0.4.20 Summary

**0.4.20 shipped on 2026-11-14 through two squash-merged PRs with README, SECURITY.md and the CHANGELOG updated and the owner's publish approval, and on 2026-11-17 the owner confirmed on the real host that both editors list and open their own old chats in full (0.4.29). Every defect the host scenario found was closed by plans 27-19 to 27-25, and the PR #40 review by 27-26 to 27-36.**

## What was done

**Task 1: the phase gate and the docs.** README.md (the Marketplace listing) gained the sections on the project's state, sync between computers with the recovery code, giving a project an online home, the same-computer key copy, what the git host can see, the three settings and when sync runs, the sentence that chats at rest are protected by file permissions and end-to-end encrypted everywhere they leave the machine, and troubleshooting entries. SECURITY.md gained the encryption model (data key, scrypt-wrapped recovery code, AES-256-GCM objects, no escrow, anonymous commits, residual leaks). Commits 437b591 (README and SECURITY.md), 3191c5f (the CHANGELOG Unreleased section) and b316b47 (keeps a slash-command test off the real teams library), on the feature branch, squashed into 765fb96. The full gate later ran once more for the whole gap closure (27-36 Task 2) and passed on its first run.

**Task 2: the owner's check on the real host.** Run in two parts (27-UAT.md):

- 2026-11-13, automated in real VS Code windows and against a real private GitHub repository: tests 1 to 7. Tests 1, 3, 5 and 7 passed. Tests 2, 4 and 6 found the defects recorded as gaps G-27-2, G-27-4a to 4d and G-27-6a to 6c.
- 2026-11-17, the owner: test 8, "Your own old chats open in both real editors", passed with 0.4.29 in code-server and desktop VS Code. Show Chat History lists both editors' old chats, and they open in full. This is the one step only the real editors can do, because the owner's old chats are encrypted with keys each editor holds.

**Task 3: the release.** PR #40 (feat/project-state-sync) was squash-merged as 765fb96 and PR #41 (release/0.4.20, the version bump and the ## 0.4.20 CHANGELOG section with the known limits) as 4eac510, both on 2026-11-14 after CI and the agent review. merge-pr tagged v0.4.20; the Release workflow built and released it and published after the owner approved the marketplace environment. Nothing was pushed to main directly.

## Gap closure (27-17 to 27-36)

Before the host check, plans 27-17 and 27-18 added the owner's decisions D-14 to D-17: the online home on GitHub with the separate checked code push, and the visible sync control in the chat panel.

The host scenario's defects, each closed by an executed plan with regression tests (re-verified on main at 0.4.29 on 2026-11-17, see 27-UAT.md Gaps):

| Gap | What was wrong | Closed by |
|-----|----------------|-----------|
| G-27-2 | A comparison saved by an older build with mode "run" was skipped | 27-19 |
| G-27-6a | The encrypted sync branch became the repository's default branch | 27-20, 27-23 |
| G-27-6c | NEAR AI's own records (organization, endpoint, profile ids) went up with the code | 27-21 |
| G-27-4a, G-27-4c | Sync control and profile chip cut at 290 px; the error only in the tooltip | 27-22 |
| G-27-6b | After declining the code push once, there was no way to push later | 27-23 |
| G-27-4b, G-27-4d | No-remote folder did not show "No online home · Set up"; two wordings of one error | 27-24 |
| G-27-4d | 12-hour time on the card and 24-hour on the control; the sync invitation above "Connect NEAR AI to start" | 27-25 |

The PR #40 review (27-REVIEW.md) was closed by 27-26 to 27-36: nothing in the project folder decides what git runs, where state goes or which key is used (27-26 to 27-29); one owner for sync bookkeeping and a join that never loses a message (27-30, 27-31); the task list's matching and reminder (27-32); model choices that do not freeze other roles and can be cleared (27-33); run liveness across editors (27-34); five panel, participant, redaction and naming fixes (27-35); and the docs plus the one full gate (27-36). The complete review dispositions are in 27-36-PLAN.md; data-key rotation after a new recovery code is the one deferred follow-up, stated in README, SECURITY.md and the CHANGELOG.

## Deviations from Plan

- **Order.** The plan runs the owner's check (Task 2) before the release (Task 3). The release went first, on 2026-11-14, and the check finished on 2026-11-17 with 0.4.29, after the gap fixes had shipped.
- **Who ran the steps.** Steps 2 to 8 of Task 2 were run by automation in real VS Code windows and on a real GitHub account, not by the owner by hand; the owner ran the step that needs their own editors (test 8). The plan's acceptance rule allows this: every reported difference has fix commits, and each was re-checked.
- **Version the owner checked.** The owner checked 0.4.29, the current release, not the 0.4.20 VSIX the plan names, because the fixes for the gaps shipped in later 0.4.x releases.

## Notes for the owner

- Optional live re-checks, not open gaps (27-UAT.md, Owner Re-Checks): that GitHub moves the default branch to your branch after you push your code (G-27-6a, tested here against a fake GitHub API and a local remote only), and a glance at how the wrapped sync and profile chips look in your theme (G-27-4a; the probe already proves nothing is cut).

## Known Stubs

None.

## Threat Flags

None. This plan changed documentation and the version; the threats in its register (secret scan before the PR, squash PRs through review, publishing gated by the owner) were each met: secret scan clean, both PRs squash-merged after the agent review, publish approved by the owner.

## Self-Check: PASSED

- README.md and SECURITY.md on main carry every required term (D2 counts above) and no "NEAR organization".
- `grep -c "^## 0.4.20" CHANGELOG.md` is 1, and the section states the spend-limit and sub-agent limits.
- PR #40 and PR #41 are merged into main (765fb96, 4eac510); `git ls-remote --tags origin v0.4.20` returns the tag; the Release workflow's publish job succeeded after the owner's approval.
- 27-UAT.md: test 8 is `result: pass` from the owner; tests 2, 4 and 6 have every gap `status: resolved` by an executed plan; `gsd-tools phase uat-passed 27` reports tests 2, 4 and 6 resolved and no UAT blocker.
- The covering tests were run on main at 0.4.29 on 2026-11-17, one file at a time under the memory cap: benchmarkResults 21/21, stateMigration 25/25, onlineHome 39/39, codePushCheck 25/25, codePushLater 9/9, syncControl 35/35, responsivePanels 13/13, syncFlows 57/57, pickup 26/26, and the extension-host suite 23/23.
