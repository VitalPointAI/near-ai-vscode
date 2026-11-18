---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 28c
pr: 4c
subsystem: release (close-out)
status: complete (PR not opened: PR 4b, #85, is not merged; the coordinator opens 4c after it)
tags: [close-out, PR-4c, D-49, D-48, D-69, D-70, D-71, D-72]
requires: ["70-22", "70-23", "70-24"]
provides: ["the 4c CHANGELOG entry", "the owner's answers D-69 to D-72 built", "the gate record", "the PR body (kept outside the repository for the coordinator)"]
affects: [70-25, 70-28d]
tech-stack:
  added: []
  patterns: []
key-files:
  created: []
  modified: [CHANGELOG.md, SECURITY.md, src/agent/outboundCheck.ts, src/agent/gateAdapter.ts, src/services/gateCommands.ts, src/test/gateDocs.test.ts, src/test/gateOutbound.test.ts, src/test/gateChatLabel.test.ts, .planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-CONTEXT.md]
decisions:
  - "D-69 to D-72 (owner, 2026-11-17) recorded in 70-CONTEXT.md and built"
  - "On the coordinator's instruction, no rebase, push or PR: PR 4b (#85) is still open, so the branch stays stacked on origin/feat/gate-labels"
metrics:
  completed: 2026-11-17
  tasks: 3
estimate:
  tokens: 31016
actuals:
  tasks: 3
---

# Phase 70 Plan 28c: Close-out of PR 4c Summary

PR 4c (plans 22, 23 and 24, the D-60 outbound check, the PR #85 carry-overs and the owner's answers D-69 to D-72) has its CHANGELOG entry, docs that say routing by label is live, and the full gate passed once inside the cap. It is not rebased, pushed or opened: PR 4b is not merged yet.

## Merged check (Task 1)

- PR 4b is #85 (as 70-28b-SUMMARY.md records). `gh pr view 85` says OPEN. The plan's precondition is not met, so, as the coordinator instructed, the rebase onto `origin/main` and the PR are left for after #85 merges. The branch stands on `origin/feat/gate-labels` (`d5e1348c`, unchanged since PR4C_BASE): `git merge-base --is-ancestor origin/feat/gate-labels HEAD` exits 0, and `git log HEAD..origin/feat/gate-labels` is empty.
- When #85 merges as a squash, run `git rebase --onto origin/main d5e1348c feat/gate-session-mark` (PR4C_BASE from 70-22-SUMMARY.md), then rerun the gate.
- **CHANGELOG** `## Unreleased` (`85c17b5a`): the chat's label and how reading raises it, where requests go at each label, calls held at strict labels (and the outbound check at Internal and Confidential), writes taking the label, Lower This Chat's Label, a sync never lowering it, and other computers keeping the higher label. The 4b lines that said a label does not change where a request is sent, and that Show Policy names the default label, now say what 4c does. `grep -c "^## Unreleased" CHANGELOG.md` prints 1; no em-dash, no phase number, no decision id in it.
- **Docs against the code:** no text in SECURITY.md, README, CHANGELOG's Unreleased section, Show Policy or the sources still says a label does not change where content is sent. The section Classification labels and routing carries the three constants in order (gateDocs). No mismatch found beyond the owner's answers below.

## The owner's answers (`a407f21c`, recorded as D-69 to D-72 in `b10abfb3`)

- **D-69:** lowerings from other computers are rejected until verified devices, in and outside Team Mode. SECURITY.md says so, and Lower This Chat's Label adds `LOWERED_HERE_ONLY_TEXT` to its message.
- **D-70:** signed lowerings stay in 4c.
- **D-71:** no phase numbers in user-facing text. "the sandbox planned for Phase 72" and the two "(Phase 72)" limitation rows now read "a planned sandbox around the shell". gateDocs checks the new section, the Known limitations table, README's policy bullet and the outbound text for a phase number.
- **D-72:** past 200,000 fingerprints the refusal is `OUTBOUND_FULL_TEXT`, which says why and suggests a new chat or lowering the chat's label with a reason. gateOutbound tests it.
- Red first: with the production files at the previous commit, 4 of 52 tests failed (gateDocs, gateOutbound, gateChatLabel); after, 71 of 71 pass with gateMark.

## Gate record (Task 2), each run once, in order, inside the cap

| Command | Result |
|---|---|
| `npm run lint && npm test` (6G, 1800 s) | exit 0; 3673 tests, 3664 pass, 0 fail, 0 cancelled, 9 skipped (the same 9 as before this branch) |
| `npm run test:e2e` under xvfb, Wayland variables removed (6G) | exit 0; both scenarios, 21 test lines passed (5 plain, 16 project), 0 failed |
| `npm run verify:release` (4G) | exit 0; release content verified (400 entries, 320 runtime JavaScript files, 50 required assets); no artifacts line |
| `node scripts/secret-scan.mjs --range origin/feat/gate-labels..HEAD` | exit 0; clean, 1282 tracked files, 19 commits |

No gate failed or was rerun.

## Size and lock

`package-lock.json` is unchanged. The diff against `origin/feat/gate-labels` before this SUMMARY was 345,293 bytes (50 files, +3396 / -110), under the 950,000 budget. At the plan's 2.2 ratio it projects to about 760 KB after review, over the ~650 KB target; the owner kept signed lowerings in 4c anyway (D-70), and the PR body says so.

## PR body (Task 3)

Written to the session's scratchpad as `pr-4c-body.md`, outside the repository, title on the first line: `feat(gate): the chat's label, raised by what agents read, decides where its requests go (Phase 70, part 4c)`. It names D-29, D-30, D-37, D-48, D-50, D-54, D-58, D-60 and D-69 to D-72, the words "Lower This Chat's Label", the routing meanings it makes live, the mark's rules, why 22 and 23 ship together, the carry-overs, the size against the target, the D-48 release blocker, the answered questions and the one still open, the test totals and the rollback. Not pushed or opened; Task 3's CI watch and agent review wait for #85.

## Deviations from Plan

1. **[Coordinator] No rebase, push or PR**, because PR 4b is not merged; the branch stays stacked on 4b's branch.
2. **[Coordinator] The owner's answers D-69 to D-72 were built here** before the gate.

## Self-Check: PASSED

Commits `a407f21c`, `b10abfb3` and `85c17b5a` are ancestors of HEAD; the CHANGELOG section exists once.
