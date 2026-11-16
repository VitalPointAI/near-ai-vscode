---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 07
subsystem: gate
tags: [pull-request, full-gate, review-budget, pure-domain]

requires:
  - phase: 70-01
    provides: "capability vocabulary v1"
  - phase: 70-02
    provides: "labels v1, scale presets, dominance"
  - phase: 70-03
    provides: "policy bundle v1"
  - phase: 70-04
    provides: "route decision, label map v1"
  - phase: 70-05
    provides: "tool and MCP manifests"
  - phase: 70-06
    provides: "floor, decide(), decision record"
provides:
  - "PR 1 (feat/gate-vocabulary into main): the pure gate foundation, opened for review, not merged"
affects: [70-08]

actuals:
  tokens: 6000
  tasks: 3
  commits: 0
plan_head_before: 40fd7d5bfacd464a60900c9228bb9bf83e911a51
plan_head_after: 40fd7d5bfacd464a60900c9228bb9bf83e911a51

key-files:
  created: []
  modified: []

key-decisions:
  - "No rebase was needed: origin/main had not moved since the branch was cut, so the branch already sat on top of it (git rebase origin/main reported up to date)"

patterns-established: []

requirements-completed: [GATE-01, GATE-07, OFFL-03, CLAS-02, CLAS-03]

duration: gate runs and PR review
completed: 2026-11-16
status: complete
---

# Phase 70 Plan 07: PR 1 opened, full gate green Summary

**PR 1 (the pure gate foundation, plans 01 to 06) stands on today's origin/main, passes the whole gate once (lint, 2840 unit tests, both e2e scenarios, verify:release, range secret scan) and was opened for review without being merged.**

## Performance

- **Tasks:** 3 of 3
- **Source commits by this plan:** 0 (no defect needed a fix; only this SUMMARY is committed, and `commits: 0` counts the plan's own code and fix commits, measured before the SUMMARY commit)
- **Files modified:** none (SUMMARY only)

## Task 1: PR 1 on top of main, compiling, tests green, under the budget

- `git fetch origin`; `origin/main` is `5070c55b3a587a414e655d2f9692377117b66a2a`. `git merge-base HEAD origin/main` is the same commit, and `git rebase origin/main` printed "Current branch feat/gate-vocabulary is up to date." No conflict, no conflict-resolution commit.
- `git log --oneline origin/main..HEAD` (22 commits, all plans 01 to 06 plus the orchestrator's state commit):

```
40fd7d5 docs(70): record plans 01 to 06 executed in state and roadmap
b430e30 docs(70-06): complete the floor, decide() and decision record plan
6fcc54e feat(gate): OCSF-shaped decision records and offline decisions
99d27eb feat(gate): the full floor, presence, ceiling and shadow mode, proved by a matrix
9cb0fd3 feat(gate): decide() with the floor above the settings layer, and the decision record
9e3b074 docs(70-05): remove a dash character from the summary
a4c09c5 docs(70-05): complete tool and MCP manifests plan
90e4a10 feat(gate): MCP manifests with restrictive and legacy defaults, and words for every verb
23debc9 feat(gate): tool manifests v1, effects from the call, and their plain words
ee8a2e2 docs(70-04): complete route decision and label map plan
ef30af9 feat(gate): label map v1, raise-only unverified maps and the label-map purpose
fc0d2ba feat(gate): pure route decision by the session's label
dad3762 docs(70-03): complete signed policy bundle v1 plan
9d1e33b feat(gate): fail-closed bundle states with plain fixes, the clock rule and renewal
094fdf0 feat(gate): policy bundle v1 and its default, signed through the one signer
a1d5073 docs(70-02): remove a dash character from the summary
2f71185 docs(70-02): complete labels, scale presets and dominance plan
842801e feat(gate): scale presets, mappings, dominance with a property test, and the label texts
7098110 feat(gate): labels v1, the org scale, dominance and the mark join
9df6702 docs(70-01): complete capability vocabulary v1 plan
6ae399d feat(gate): every v1 verb, integer-only spend, reserved gpu and the one-way shorthand mapping
b0d89dc feat(gate): closed capability vocabulary v1, first verbs and the pure gate folder boundary
```

- Tests: `systemd-run ... sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gate*.test.js dist/test/teamSignedPayload.test.js dist/test/teamBoundaries.test.js dist/test/agentTools.test.js'`: exit 0; 233 tests, 231 pass, 0 fail, 0 cancelled, 2 skipped (the two ripgrep tests in agentTools, which skip because ripgrep is not installed on this machine).
- Budget: `git merge-base --is-ancestor origin/main HEAD` true; `git diff --quiet origin/main...HEAD -- package-lock.json` clean; PR diff bytes: **500171** (below 950000). Exit 0.
- `git diff --name-status origin/main...HEAD -- src`: 24 A lines (12 files under src/domain/gate, src/domain/glob.ts, and 11 gate test files) plus exactly five M lines: src/agent/glob.ts, src/domain/config.ts, src/domain/team/signedPayload.ts, src/test/teamBoundaries.test.ts, src/test/teamSignedPayload.test.ts. This matches the acceptance criterion.

```
M	src/agent/glob.ts
M	src/domain/config.ts
A	src/domain/gate/bundle.ts
A	src/domain/gate/decide.ts
A	src/domain/gate/dominance.ts
A	src/domain/gate/floor.ts
A	src/domain/gate/labelMap.ts
A	src/domain/gate/labels.ts
A	src/domain/gate/manifest.ts
A	src/domain/gate/record.ts
A	src/domain/gate/routing.ts
A	src/domain/gate/shape.ts
A	src/domain/gate/vocabulary.ts
A	src/domain/gate/words.ts
A	src/domain/glob.ts
M	src/domain/team/signedPayload.ts
A	src/test/gateBundle.test.ts
A	src/test/gateDecide.test.ts
A	src/test/gateDominance.test.ts
A	src/test/gateFloor.test.ts
A	src/test/gateLabelMap.test.ts
A	src/test/gateLabels.test.ts
A	src/test/gateManifestFormat.test.ts
A	src/test/gateOffline.test.ts
A	src/test/gateRecords.test.ts
A	src/test/gateRouting.test.ts
A	src/test/gateVocabulary.test.ts
M	src/test/teamBoundaries.test.ts
M	src/test/teamSignedPayload.test.ts
```

- The other files in the PR diff (38 in all) are `.planning/ROADMAP.md`, `.planning/STATE.md`, `.planning/state.json` and the six plan SUMMARY files. None matches `GATE_PATHS` in scripts/lib/workflow.mjs (checked with `gateFileChanges` over the 38 paths: an empty list), so the PR is not held for the gate-change approval.

## Task 2: the full gate, once each, one heavy run at a time

All four ran once; none needed a rerun. Memory was checked with `free -g` before each (about 11 to 13 GB available).

1. `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npm run lint && npm test'`: exit 0. Totals: 2840 tests, 2831 pass, 0 fail, 0 cancelled, 9 skipped, 0 todo. The nine skips are environment skips (two ripgrep, LibreOffice, the real Open-GSD runtime, five live NEAR AI tests that need a key), none of them from this PR.
2. `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env -u WAYLAND_DISPLAY -u DISPLAY -u XDG_SESSION_TYPE -u GDK_BACKEND -u QT_QPA_PLATFORM -u ELECTRON_OZONE_PLATFORM_HINT NODE_OPTIONS=--max-old-space-size=1536 npm run test:e2e` (the owner's longer form of the plan's command, run under xvfb which the script starts): exit 0. The project scenario passed 15 checks and the plain-folder scenario passed 5, with `Exit code: 0` for both and no failure line. Electron accepted NODE_OPTIONS, so no rerun was needed.
3. `... npm run verify:release` (MemoryMax=4G, timeout 900): exit 0; "Release content verified: 369 entries, 291 runtime JavaScript files, and 50 required release assets."; the "development or source artifacts are present" line did not appear.
4. `... node scripts/secret-scan.mjs --range origin/main..HEAD` (MemoryMax=4G, timeout 900): exit 0; "Secret scan clean: 1158 tracked files and 22 commit(s) in origin/main..HEAD. Allowlisted fixtures: 8."

`git status --short` was clean after the gate (the packaged .vsix and `dist` are ignored).

## Task 3: the pull request

- **PR 1: https://github.com/VitalPointAI/near-ai-vscode/pull/66**, `feat/gate-vocabulary` into `main`, title `feat(gate): capability vocabulary, labels and policy bundle formats (Phase 70, part 1)`. State: OPEN. The executor did not merge, approve, enable auto-merge or push to main.
- The body fills every template section in plain words; says nothing calls the new code yet so no behaviour changes; names vocabulary v1 (D-03, D-35), labels v1 and the four presets (D-22, D-23, D-47), policy bundle v1 (D-12), label map v1 with the `label-map` purpose (D-25) and decision record v1 (D-20); says PR 2 first writes a bundle and records and PR 4 first writes a label map, so each format is still cheap to change; gives the test totals and the rollback. It also lists three owner questions raised by the summaries: the `RELEASABLE-TO-NONE` token (70-02), the `action_id` 3 / `disposition_id` 3 coding of an `asked` record (70-06), and a verb absent from `ceiling.contexts` being allowed in no context (70-03).
- The `gh pr edit` command fails on this machine (a deprecated Projects classic GraphQL field), so the body was set through `gh api -X PATCH repos/.../pulls/66`.

### Required checks on the head when the PR opened (before the second rebase; its short hash was d083a49)

lint pass (25s), test pass (3m29s), e2e pass (3m57s), release-content pass (33s), audit pass (22s), secret-scan pass (7s), relay pass (1m20s). No infrastructure failure, so no `gh run rerun`.

### Agent review

`agent-review` status success, set by `near-ai-reviewer` on that first head: "PASS: 0 major, 4 minor, 0 nit"; review state APPROVED, recommendation MERGE, no blocker. Findings, none of them fixed in this plan, because each is either a format choice that belongs to the owner or a hardening with no caller yet (a fix would change the formats and need a new gate run and review):

1. [MINOR] `src/domain/config.ts:49` exports the live mutable `LOOPBACK_HOSTS` set, which also feeds `isSecureEndpoint`; a caller could add a host. Suggested: export a frozen copy or an `isLoopbackHost()` predicate. The export itself is one of the plan's recorded edits (70-04, so the route decision can name loopback hosts). Not fixed; offered to the owner as a small follow-up commit.
2. [MINOR] `src/domain/gate/record.ts:40`: `disposition_id: 3` for an ask is not an OCSF disposition value (1, 2, 8, 25, 26) while the record advertises OCSF 1.9.0. Same as owner question 2 in the PR body; the alternative is "Other" plus an `unmapped` detail. Not fixed; waits for the owner's answer.
3. [MINOR] `src/domain/gate/bundle.ts` (`parseList` for clearances and mappings) accepts two identical entries, so two semantically equal bundles hash differently, and the hash is carried in decision records. Suggested: refuse duplicates as labels do. Not fixed; a format tightening for the owner to confirm.
4. [MINOR] `src/domain/gate/labels.ts:237`: `expiryMs` accepts timestamps without a fractional second while `bundle.ts` requires exactly three digits, so two timestamp spellings could coexist in signed files. Suggested: pick one before anything is written to disk. Not fixed; a format choice for the owner.

Findings 2 to 4 are cheap to change now (before PR 2 writes anything) and costly after release, so they are worth an owner decision before merge.

## Deviations from Plan

- **Rebase not needed:** `origin/main` had not moved, so `git rebase origin/main` was a no-op and there were no conflicts (the plan allowed for them).
- **PR diff includes the orchestrator's state commit:** the diff holds `.planning/STATE.md`, `.planning/ROADMAP.md` and `.planning/state.json` (from `40fd7d5`) as well as the plan summaries; not edited by this plan.
- **Second push for the SUMMARY:** the SUMMARY records the PR number and review result, which exist only after the PR is open, so it was pushed to the PR branch afterwards (a docs-only commit that starts a fresh CI and review round; its result is in the hand-off report).
- No auto-fix deviations; no auth gates; no stubs; no threat flags (no new endpoint, file access or auth path: the code is not called yet).

## Second rebase after the PR opened

While the first CI and review round ran, PR #65 merged into main (`aacbd69ec636057e6b2112cef60072990f8fdca4`, "docs(plan): NEAR function-call keys ... (#65)"), so GitHub reported the PR as conflicting (dirty). `git fetch origin` then `git rebase origin/main`:

- One conflict, in `.planning/STATE.md` frontmatter (current_plan, status, stopped_at, last_updated, state_head, last_activity_desc), because the state commit `40fd7d5` and #65 both edited it. Resolved by keeping this branch's execution position and folding main's last-activity text into `last_activity_desc` after "before that:". The orchestrator hand-edits STATE.md afterwards, as agreed. `ROADMAP.md` and `state.json` merged without conflict.
- Main's delta since the first base (`5070c55`) is documentation only (PROJECT.md, REQUIREMENTS.md, ROADMAP.md, STATE.md, three phase plans, PATTERNS, RESEARCH and two research notes), so no source file changed under this branch and the heavy gate was not rerun; instead the cheap checks were repeated: PR diff 513244 bytes, `package-lock.json` unchanged, `git diff --name-status origin/main...HEAD -- src` still 24 A and 5 M with the same files, range secret scan clean (24 commits, 1160 tracked files), exit 0.
- The branch was pushed with `git push --force-with-lease origin feat/gate-vocabulary` (this branch only). The earlier approval from the first head was dismissed by the push, as designed; a fresh CI and review round ran on the new head (see the hand-off report for its result).
- The second review round (on the docs-only SUMMARY commit, before this rebase) passed with 0 major, 5 minor, 0 nit. It repeated findings 1, 2 and 4 above (the mutable `LOOPBACK_HOSTS`, `disposition_id: 3`, the fractional-second grammar) and added two: `src/domain/gate/bundle.ts:88` (a comment says the default bundle decides and routes as before, but with `unattendedMcp: []` the ceiling denies every MCP tool in unattended runs and every verb in `relay` and `routine` contexts; say so in the comment) and `src/domain/gate/floor.ts:55` (the team settings exemption uses `endsWith('/.planning/.near-ai/team.md')`, so `sub/.planning/.near-ai/team.md` also skips the protected-write ask; exempt only the project-root path). Not fixed here; offered to the owner as one follow-up commit with the other minors.

## Self-Check: PASSED

- SUMMARY exists; the first SUMMARY commit is an ancestor of HEAD and on origin; PR 66 is OPEN into main; `package-lock.json` unchanged; no em-dash in this file.
