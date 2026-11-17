---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 28b
pr: 4b
subsystem: release (close-out)
status: complete (PR not opened: the coordinator opens it)
tags: [close-out, PR-4b, D-49, D-48]
requires: ["70-20", "70-21"]
provides: ["the 4b CHANGELOG entry", "the gate record", "the PR body (kept outside the repository for the coordinator)"]
affects: [70-22, 70-28c]
tech-stack:
  added: []
  patterns: []
key-files:
  created: []
  modified: [CHANGELOG.md, src/services/teamStudioPanel.ts, src/services/gateCommands.ts, src/test/gateLabelCommands.test.ts]
decisions:
  - "Merged origin/main (no rebase) as the coordinator asked, instead of the plan's rebase --onto; the PR's three-dot diff holds only 4b's changes, and a squash merge makes it one commit"
  - "The PR is not pushed or opened here: the coordinator does that with the body this plan wrote"
metrics:
  completed: 2026-11-17
  tasks: 3
estimate:
  tokens: 30016
actuals:
  tasks: 3
---

# Phase 70 Plan 28b: Close-out of PR 4b Summary

PR 4b (plans 20 and 21, plus the owner's answers D-61 to D-64) stands on `origin/main` with only its own changes in the PR diff. Its CHANGELOG entry and docs match its code. The full gate passed once inside the cap. The PR body is written but not pushed: the coordinator opens the PR.

## Merged check (Task 1)

- PR 4a is #81, as 70-28a-SUMMARY.md records, merged as `9e430e262c102f606bce7bb613a6f64e8bb17c38`. `git merge-base --is-ancestor 9e430e26 origin/main` exited 0 after `git fetch origin`.
- `origin/main` at the close-out was `c72910ec` (#82 Team Studio and #83 merged after #81). It was merged into `feat/gate-labels` as `2fea04f0` with no rebase and no force, as the coordinator asked. This replaces the plan's `rebase --onto`.
- The merge brought #82's new team icon request, which asked the gate host for a runtime before each image and named a `gateHost` parameter `teamAiDeps` no longer had. It was fixed to use the per-panel resolver (`5808a3e8`); gateRouteGuard's Team Studio source check requires that.
- `git log --oneline origin/main..HEAD` lists 41 commits, because the earlier merge kept PR 4a's branch history from before its squash. The PR diff, `git diff origin/main...HEAD`, holds only 4b's changes: 45 files, +3877 / -152.
- **Diff:** 383,898 bytes, under the 950,000 budget. The projection after review is about 845 KB at the plan's 2.2 ratio, which is over the ~650 KB target; that is an owner question in the PR body. `package-lock.json` is unchanged.
- **CHANGELOG** `## Unreleased` (`d4d7b486`) covers: Set Label; agents cannot read above your clearance (including the branch-switch accept); Edit Policy and Apply Policy Draft; a local runtime counts as local only on this computer unless your organization names its host; labels do not change where content is sent yet. Two 4a bullets in the same Unreleased section said "Nothing can be labelled yet" and now say a label does not change where a request is sent yet. `grep -c "^## Unreleased" CHANGELOG.md` prints 1.
- **Docs against the code:**
  - SECURITY.md, README and Show Policy name the three commands package.json contributes, say a label does not change where content is sent yet, and carry both constants word for word (gateDocs, gateCommands).
  - One mismatch was found and fixed (`aac1cbba`): Show Policy still said only Reset Policy to Defaults changes the policy. A usable policy now also names Edit Policy, with a test that was red first. A failed policy keeps the old sentence, which the existing gateCommands test pins unchanged.

## Gate record (Task 2), each run once, in order, inside the cap

| Command | Result |
|---|---|
| `npm run lint && npm test` (6G, 1800 s) | exit 0; 3610 tests, 3601 pass, 0 fail, 0 cancelled, 9 skipped |
| `npm run test:e2e` under xvfb, Wayland variables removed (6G) | exit 0; both scenarios, 24 tests passed, 0 failed |
| `npm run verify:release` (4G) | exit 0; release content verified (396 entries, 316 runtime JavaScript files, 50 required assets); no artifacts line |
| `node scripts/secret-scan.mjs --range origin/main..HEAD` | exit 0; clean, 1270 tracked files, 41 commits |

No gate was rerun; none failed.

## The owner's answers built before the close-out (D-61 to D-64)

D-60 is held for 4c's outbound check, so the answers took D-61 to D-64 in 70-CONTEXT.md (`c3b37743`).

- **D-61 (`c7ee4bb7`):**
  - A branch switch (an older or different signed label file) is `other-revision`. It holds agent reads with one message and one button, Use this branch's labels.
  - Accepting signs that file again above the marker and records `label.branch-accepted`. Declining changes nothing.
  - A deleted file stays `rolled-back` with no accept and points at git restore.
  - Tests: hold, accept, decline, deletion.
- **D-62 (`c7ee4bb7`):**
  - The marker moved to SecretStorage (hash, revision, signing time, entry count, payload hash; never a path). The verified payload stays as a base copy, used only while it matches.
  - Deleting files no longer erases the marker. Without the base copy, a hand-edited file holds reads.
  - A marker on disk from an earlier build migrates once.
  - Tested with the in-memory secret store.
- **D-63 (`a0fe8002`):**
  - Open-GSD runtime reads (resolved through links) are judged at the default label.
  - A real place in the project keeps its label, so a link from the runtime into the project is refused at the project file's label. Search results are filtered the same way.
  - Tests: runtime read allowed in a project labelled above clearance, project file refused, search, link.
- **D-64 (`c7ee4bb7`):** `label.declassify-rejected` and `label.branch-accepted` are on LABEL_EVENT_IDS; Set Label under a broken policy says plainly that nothing can be labelled; plan 21 Task 4 stays in 4b.
- **SECURITY.md (`d62b9aae`)** says each of these, pinned by gateDocs.

### Existing tests changed in this round

- **gateLabelStore** (this branch's own, not on main): the D-59 replay and removal tests now expect `other-revision` where they expected `rolled-back`, and read the marker from SecretStorage, as D-61 and D-62 decide.
- **gateDocs:** the pinned phrase 'deleted or replaced by an older copy, stops agents reading the project' follows the reworded sentence ('or that was deleted, stops agents reading the project'), and a new test pins the D-61 to D-63 phrases.

All new tests were run red first: compile failures for the D-61, D-62 and D-64 tests, and 2 failures for D-63, 2 for docs and 1 for Show Policy.

## PR body (Task 3)

Written to the session's scratchpad as `pr-4b-body.md`, outside the repository. It has the title `feat(gate): labels on files and folders, clearance checks on reads, and Edit Policy (Phase 70, part 4b)` and every template section filled. It names D-23, D-25, D-27, D-48, D-49 and D-53, the words "label map" and "labels.json", the D-48 release blocker section, the D-23 post-release check, the owner questions, the test totals, the diff size and the rollback.

The executor did not push, open, merge or approve anything; the coordinator opens the PR.

## Deviations from Plan

1. **[Coordinator] `git merge origin/main` instead of `git rebase --onto`.** There is no force push. The PR's three-dot diff is still only 4b's changes.
2. **[Coordinator] The PR is not pushed or opened.** Task 3's CI watch and agent-review record wait for the coordinator.
3. **[Rule 1] Fixed #82's icon request after the merge** (`5808a3e8`) and Show Policy's change sentence (`aac1cbba`).

## Self-Check: PASSED

Commits `c3b37743`, `c7ee4bb7`, `a0fe8002`, `d62b9aae`, `2fea04f0`, `5808a3e8`, `d4d7b486` and `aac1cbba` are ancestors of HEAD; the CHANGELOG section exists once.
