---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 28d
pr: 4d
subsystem: release (close-out)
status: complete (PR not opened: on the coordinator's instruction, nothing is pushed; the PR body is kept outside the repository)
tags: [close-out, PR-4d, CLAS-05, D-36, D-48, D-49, D-50, D-55]
requires: ["70-25"]
provides: ["the 4d CHANGELOG entry", "the gate record", "the PR body (kept outside the repository for the coordinator)"]
affects: [70-26, 70-27, 70-28e]
tech-stack:
  added: []
  patterns: []
key-files:
  created: []
  modified: [CHANGELOG.md, .planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-25-SUMMARY.md]
decisions:
  - "Rebased onto origin/main after release 0.4.31 (#88) landed while plan 25 ran; the rebase was clean"
  - "On the coordinator's instruction, no push and no PR: the title and body are written to the session's scratchpad"
metrics:
  completed: 2026-11-18
  tasks: 3
estimate:
  tokens: 31016
actuals:
  tasks: 2
  commits: 1
---

# Phase 70 Plan 28d: Close-out of PR 4d Summary

PR 4d (plan 25: attested-cloud over a proven connection, checked after each answer, plus the last PR #87 review fixes) stands on current `origin/main` with only its own commits, has its CHANGELOG entry, docs that match the research finding, and passed the full gate once inside the cap. It is not pushed or opened: the coordinator does that.

## Merged check and rebase (Task 1)

- PR 4c is #87, as 70-28c-SUMMARY.md and the coordinator say. `gh pr list --state merged --head feat/gate-session-mark --base main` lists #87 with merge commit `0dcfd0c08a1adbfe3f6fab2d5d7e37840917c3ee`; after `git fetch origin`, `git merge-base --is-ancestor 0dcfd0c0 origin/main` exited 0.
- PR4D_BASE (70-25-SUMMARY.md) is `0dcfd0c0`. While plan 25 ran, release 0.4.31 (#88, `77ffcaac`) landed on main, so `git rebase --onto origin/main 0dcfd0c0 feat/gate-attested-routing` did move the branch, onto `77ffcaac0e186d6bbd5fc253094d8b1d554c60dc`. It was clean (the release changed only CHANGELOG.md, package.json and package-lock.json). The plan 25 SUMMARY's commit hashes were updated to the rebased ones.
- **CHANGELOG** (`d9f60f1b`): 0.4.31 had moved the last `## Unreleased`, so a new one was created at the top. Written from the research finding: content at Internal, Confidential and the other attested-cloud levels can again use a private NEAR AI Cloud model, but only over a connection proven to end inside its private hardware; each such answer is checked afterwards, and a failed check stops that level for the chat until Check again under that answer passes; proxies; the review fixes. `grep -c "^## Unreleased" CHANGELOG.md` prints 1; no em-dash, no phase number, no decision id in it.
- **Docs against the code and the finding:** SECURITY.md carries `CONNECTION_BINDING_TEXT` word for word after the attested-cloud sentence and before the not-accreditation block; its finding sentence ("NEAR AI Cloud's attestation names the key of the certificate its endpoint serves, so from this release content at these levels can reach a private NEAR AI Cloud model again, whenever that check passes") matches 70-25-SUMMARY.md; the proxy sentence and both limitation rows are there; Show Policy's `POLICY_ROUTING_TEXT` says the same. No stale "for now" or "cannot prove" wording is left in SECURITY.md or README. No mismatch needed a fix commit.
- 4d's tests and the parity set (`gate*`, attestation, nearAiClient, providerFactory, privateMembers, conversations, checkNow, agentLoop, teamBoundaries): 835 tests, 0 failed.
- `git log --oneline origin/main..HEAD` before this SUMMARY:

```
d9f60f1b docs(changelog): part 4d, attested-cloud over a proven connection
452b7ab4 docs(70-25): complete the attested-cloud routing plan
20393bc8 docs(gate): the signature section says every attested-cloud answer is checked, tool-call turns included
a9ccd487 fix(gate): the last PR #87 review findings, each with a test
f0dd08f6 docs(gate): what the connection and answer checks prove and rely on
5ddd0ad6 feat(gate): attested-cloud is checked after every answer, stops on a failed check, and Check again clears it
33d12015 feat(gate): NEAR AI Cloud's attestation proves the connection, and attested requests are pinned to it
```

Only plan 25's commits (with the review fixes the coordinator asked for) and this plan's.

## Size and lock

`package-lock.json` is unchanged against `origin/main`. The PR diff was 245,195 bytes (32 files, +2,148 / -184) before this SUMMARY, under the 950,000 budget; at the plan's 2.2 ratio it projects to about 540 KB after review, under the ~650 KB target.

## Gate record (Task 2), each run once, in order, inside the cap, the heavy ones under the shared lock

| Command | Result |
|---|---|
| `npm run lint && npm test` (6G, 1800 s) | exit 0; 3786 tests, 3777 pass, 0 fail, 0 cancelled, 9 skipped (the same 9 as before this branch) |
| `npm run test:e2e` under `xvfb-run -a` with `WAYLAND_DISPLAY`, `XDG_SESSION_TYPE` and `WAYLAND_SOCKET` removed (6G, 1800 s) | exit 0; both scenarios, 21 test lines passed (5 plain, 16 project), 0 failed |
| `npm run verify:release` (4G) | exit 0; release content verified (402 entries, 322 runtime JavaScript files, 50 required assets); no artifacts line |
| `node scripts/secret-scan.mjs --range origin/main..HEAD` | exit 0; clean, 1290 tracked files, 7 commits |

No gate failed or was rerun. The e2e launch accepted `NODE_OPTIONS`.

## PR body (Task 3)

Written to the session's scratchpad as `pr-4d-body.md`, outside the repository, with the title on its first line: `feat(gate): attested-cloud only over a proven connection, checked after each answer (Phase 70, part 4d)`. It quotes the "NEAR AI Cloud connection binding" finding and says plainly that attested-cloud levels can reach NEAR AI Cloud from this release, but only over a proven connection; describes the CLAS-05 amplification as built, D-36's after-answer check with its 10-minute report cache, D-55's stop and Check again; proxies; that the routing meanings are still cheap to change until a release ships; the live comparison left for a person; the D-48 release blocker; the owner's question; the review fixes; the test totals; the size; and the rollback (D-50). Task 3's push, CI watch and agent review are left to the coordinator.

## Deviations from Plan

1. **[Coordinator] No push, no PR, no CI watch.** The coordinator opens the PR from the body file.
2. **The rebase moved the branch.** The coordinator expected none, since the branch started from current main; release 0.4.31 landed in between. It was clean and changed no 4d file.

## Self-Check: PASSED

CHANGELOG has one `## Unreleased` naming Check again; every commit above is an ancestor of HEAD; `git diff --quiet origin/main...HEAD -- package-lock.json` exits 0.
