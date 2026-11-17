---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 18
subsystem: gate
tags: [floor, pr3, close-out, review]

requires:
  - phase: 70-16
    provides: "command effect tags, shellReachesCredentialStore, floorFactsFor"
  - phase: 70-17
    provides: "the floor enforced in every mode, the one-shot late approval, SECURITY.md and README rewrites"
provides:
  - "PR #74, merged into main as 377967c on 2026-11-17"
affects: [70-19, 70-28a]

pr3_base: 93fa275346f402a9490352b49031d3cc84e68f8c
merge_commit: 377967ce8c4fee9dbdb2b118a96d3349e3b3b29e

tech-stack:
  added: []
---

# Phase 70 plan 18: PR 3 closed and merged

PR 3 (#74, "a floor no mode can override; fully-autonomous asks before protected writes, publishing and destruction") was opened from `feat/gate-floor` after PR 2 (#70) was already on main, so the plan's merged check passed at once and no rebase was needed: the branch was cut straight from main at 93fa275. The owner approved the gate change and merged it as 377967c on 2026-11-17. This summary is written from the PR's record after the merge, so the tooling sees plan 18 as complete.

## What the PR carried

- Plans 70-16 and 70-17 (see their summaries), the seven carry-overs from #70's review (`70-17a-CARRYOVERS.md`), and twelve rounds of review fixes, all logged in `70-17a-CARRYOVERS.md` and the PR description.
- The floor code, the one deliberately changed test (`protectedPaths`, D-19) and the SECURITY.md and README rewrites in one PR, never split (D-34).
- The D-48 code-server check named in the PR body as a release blocker.

## The gate

- Lint, the full suite (3396 tests at the last local run, 0 failing), e2e under xvfb, `verify:release` and the range secret scan passed; CI was green on every pushed head.
- The agent review passed on the merged head (469a5ba) after rounds that each fixed the findings; the last round's minor and nit were left for a follow-up and recorded in the PR body.
- The diff was about 810 KB, under the 950 KB budget; `package-lock.json` was unchanged.

## Deviations

- No rebase (`rebase --onto`) was needed: PR 2 had merged before PR 3's branch was cut.
- The review loop ran twelve rounds instead of the usual few. The recurring class (text checks that missed a way to hide a command) ended with an invariant: a command's effects are complete only when the classifier read it whole; every other path is unknown and asks. The real fix for what text checks cannot see is the sandbox in Phase 72.

## Owner questions carried out of PR 3

All were answered on 2026-11-17 and built in #76 (merged as 2e287a8): the credential-read hold (D-18), GitHub writes (D-46), more credential stores and token printers (A5), routine git maintenance, logins, outside-project paths, local MCP declarations and records for malformed arguments.

## Self-Check: PASSED

- #74 is MERGED with merge commit 377967c on main.
- 70-16-SUMMARY.md and 70-17-SUMMARY.md exist; this summary closes plan 18.
