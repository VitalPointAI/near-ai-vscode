---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 28e
pr: 4e
type: execute
wave: 32
depends_on: ["70-27"]
files_modified:
  - CHANGELOG.md
  - .planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/COVERAGE.md
  - .planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-VALIDATION.md
autonomous: true
requirements: [CLAS-08, CLAS-07, OFFL-01]
user_setup: []
estimate:
  tokens: 36019
  raw_tokens: 36000
  tasks: 3
  confidence: high
must_haves:
  truths:
    - "Plan 28e starts only once PR 4d is on main: `gh pr list --state merged --head feat/gate-attested-routing --base main` names a merge commit and `git merge-base --is-ancestor <that commit> origin/main` exits 0 after `git fetch origin`; otherwise it stops with a plain message and changes nothing, and never waits on, polls for, asks for or performs the merge (D-34, D-49, D-51)."
    - "PR 4e is rebased with `git rebase --onto origin/main <PR4E_BASE> feat/gate-trust-badge` (PR4E_BASE from 70-26-SUMMARY.md), keeps only plans 26, 27 and this plan's commits, compiles, its tests and the parity set pass, its diff is under 950,000 bytes and package-lock.json is unchanged; the SUMMARY records the diff bytes and the projected size after review against the ~650 KB target (D-34, D-49)."
    - "CHANGELOG.md has a `## Unreleased` entry for 4e in plain words: a trust badge on every cloud answer with its three states, the automatic check and what it costs, Check again and Show full attestation; the old Verify signature row is gone (D-34, CLAS-08)."
    - "The phase close-out is written on this branch before the gate: COVERAGE.md's part 4 table names, for each of CLAS-01 to CLAS-08, GATE-07 and OFFL-01, the merged PR number that delivered each part and the one that completed it, and 70-VALIDATION.md's part 4 delivery map and manual verifications are brought up to date (each manual check marked done with its date, or still open with who does it); the phase's verification report itself is left to the execute-phase verifier that runs after this plan (D-49)."
    - "The full gate passes once inside the cap: lint and suite, e2e under xvfb with the Wayland variables removed (including plan 27's badge test), verify:release and the range secret scan (D-34)."
    - "PR 4e is open into main with the title `feat(gate): a trust badge on every cloud answer (Phase 70, part 4e)`; its body describes CLAS-08 (the three states, set only from checks that ran, the details and full attestation on request, replayed when a chat reloads), the owner's decision of 2026-11-16 that each cloud answer from a TEE model is checked once automatically and what that costs, D-51 (why the badge ships last), D-56 (never stuck at 'Checking now', lead answers only), the theme check left for a person, the D-48 release blocker, that this PR closes Phase 70, the owner's questions, the test totals and the rollback; the executor never merges (D-34)."
  artifacts:
    - path: .planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/COVERAGE.md
      provides: "part 4's requirement map with the merged PR numbers"
  key_links: []
  prohibitions:
    - requirement_id: CLAS-08
      category: safety
      status: resolved
      verification: judgment
      statement: "MUST NOT open PR 4e before PR 4d is merged (the badge's meaning depends on 4d), and MUST NOT merge, approve or push to main from the execution session."
---

<objective>
Close PR 4e, the last of part 4 (D-49), and the phase: check PR 4d is on main, rebase keeping only 4e's commits, write the CHANGELOG entry and the phase's coverage and validation records, run the full gate once and open the trust badge PR.

Purpose: D-34, D-48, D-49, D-51 (the badge ships after 4d so its meaning never changes between releases), D-56, CLAS-08, and the phase close-out (requirements traceability in COVERAGE.md and 70-VALIDATION.md; the verifier's report follows this plan).
Output: PR 4e open from `feat/gate-trust-badge` into `main` with green checks; COVERAGE.md and 70-VALIDATION.md brought up to date; `70-28e-SUMMARY.md`.
</objective>

<artifacts_produced>
## Artifacts this phase produces

Phase-wide index: 70-01-PLAN.md for plans 01 to 18; part 4's index and requirement map are in COVERAGE.md (replanned 2026-11-17, D-49).

This plan creates no source symbol. It writes the 4e entry under `## Unreleased` in CHANGELOG.md, fills COVERAGE.md's part 4 table with the merged PR numbers, updates 70-VALIDATION.md's part 4 delivery map and manual verifications, and produces PR 4e (plans 26 and 27) from `feat/gate-trust-badge` into `main`, with the merged check and the gate record in `70-28e-SUMMARY.md`.
</artifacts_produced>

<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-26-SUMMARY.md
@.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-27-SUMMARY.md
@.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-28d-SUMMARY.md
@.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/COVERAGE.md
@.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-VALIDATION.md
Read before acting, not as includes: docs/development-workflow.md sections 1 to 4, .github/pull_request_template.md, .claude/commands/review-pr.md; 70-28a-SUMMARY.md to 70-28c-SUMMARY.md (the PR numbers of 4a to 4c); 70-CONTEXT.md D-48, D-49, D-51, D-56.

One heavy run at a time. Full suite and e2e with MemoryMax=6G and timeout 1800; e2e under xvfb with the Wayland variables removed; if the e2e launch itself rejects `NODE_OPTIONS`, rerun it once in the same cap without it and record both. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; the PR body ends with the attribution lines the session gives. Plain words, no em-dashes, "your organization" never "NEAR organization", NEAR AI named only as the provider, no local machine paths.
</context>

<tasks>

<task type="tracer">
  <name>Task 1: Tracer: PR 4d is on main, PR 4e is rebased onto it with only its own commits, the phase's coverage and validation records are written, green and under the budget</name>
  <precondition>PR 4d is merged: `gh pr list --state merged --head feat/gate-attested-routing --base main --json number,mergeCommit` lists the PR whose number 70-28d-SUMMARY.md records, with a merge commit. If it lists nothing, stop with "PR 4d is not on main yet, so PR 4e was not rebased or opened. Run plan 70-28e again after PR 4d merges." and change nothing.</precondition>
  <files>CHANGELOG.md, .planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/COVERAGE.md, .planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-VALIDATION.md (and conflict-resolution commits only if the rebase needs them)</files>
  <read_first>.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-26-SUMMARY.md (PR4E_BASE), 70-28a-SUMMARY.md to 70-28d-SUMMARY.md (PR numbers and merge commits), COVERAGE.md ("Part 4 requirement map"), 70-VALIDATION.md ("Part 4 delivery map", "Manual-Only Verifications"), CHANGELOG.md (the Unreleased section)</read_first>
  <action>
`git fetch origin`, confirm the precondition's merge commit is an ancestor of `origin/main`; if not, stop with the same message and do nothing else. Then `git rebase --onto origin/main <PR4E_BASE> feat/gate-trust-badge`. Resolve `.planning` conflicts by keeping main's text and adding this branch's lines; code conflicts in favour of what main has plus 4e's changes. Write the 4e bullets under `## Unreleased` in CHANGELOG.md (create the section at the top if a release has moved the last one) and commit `docs(changelog): part 4e, the trust badge`.

Phase close-out (D-49): in COVERAGE.md's "Part 4 requirement map", put the merged PR number beside each part (4a to 4d from their close-out SUMMARYs, 4e as "this PR"), and keep one row per requirement; in 70-VALIDATION.md, fill the part 4 delivery map's test files with what the plans actually created (from the SUMMARYs) and mark each manual verification done with its date or open with who does it (the D-48 code-server check per release, the security officer's preset check, the live connection-binding comparison, the badge themes). Commit `docs(70): part 4 coverage and validation records`. Compile and run 4e's tests and the parity set, then the commit list and budget checks. Record the PR 4d number, its merge commit, the `origin/main` commit, `git log --oneline origin/main..HEAD`, the diff bytes and the projection after review. Never skip, weaken or delete a test.
  </action>
  <verify>
    <automated>sh -c 'C=$(gh pr list --state merged --head feat/gate-attested-routing --base main --json mergeCommit --jq ".[0].mergeCommit.oid // empty") && test -n "$C" && git fetch -q origin && git merge-base --is-ancestor "$C" origin/main'</automated>
    <fails_when>non-zero exit: no merged PR from feat/gate-attested-routing into main, or its merge commit is not on origin/main (the plan must stop here)</fails_when>
    <automated>systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gate*.test.js dist/test/attestation.test.js dist/test/threadMerge.test.js dist/test/threadLog.test.js dist/test/conversations.test.js dist/test/checkNow.test.js dist/test/steering.test.js dist/test/syncControl.test.js dist/test/responsivePanels.test.js dist/test/teamBoundaries.test.js'</automated>
    <fails_when>non-zero exit, or the node --test summary shows "# fail" above 0, "# cancelled" above 0 or "# tests 0"</fails_when>
    <automated>sh -c 'git merge-base --is-ancestor origin/main HEAD && git diff --quiet origin/main...HEAD -- package-lock.json && D=$(git rev-parse --git-path phase70-pr4e.diff) && git diff origin/main...HEAD > "$D" && B=$(wc -c < "$D") && echo "PR diff bytes: $B, projected after review: $((B * 22 / 10))" && test "$B" -lt 950000'</automated>
    <fails_when>non-zero exit: the branch is not on top of origin/main, package-lock.json changed, or the PR diff is 950,000 bytes or more</fails_when>
  </verify>
  <acceptance_criteria>
    - The SUMMARY records the PR 4d number (equal to the one in 70-28d-SUMMARY.md), its merge commit, and that `git merge-base --is-ancestor` exited 0 against `origin/main`.
    - `git log --oneline origin/main..HEAD` lists only plans 26, 27 and this plan's commits (recorded in the SUMMARY).
    - COVERAGE.md's part 4 table has exactly one row for each of CLAS-01 to CLAS-08, GATE-07 and OFFL-01, each naming merged PR numbers; 70-VALIDATION.md marks every manual verification done or open with its owner.
    - The SUMMARY records the diff bytes (below 950,000) with the projection after review, and the test totals with 0 failed.
  </acceptance_criteria>
  <done>PR 4d is confirmed on main without anyone being asked, 4e stands on main with only its own commits, and the phase's records say which PR delivered each requirement.</done>
</task>

<task type="auto">
  <name>Task 2: The full gate once on the rebased branch</name>
  <files>(no source file; fix commits only for real defects)</files>
  <read_first>package.json (scripts lint, test, test:e2e, verify:release), scripts/secret-scan.mjs (header)</read_first>
  <action>
Run the four gate commands below in order, one at a time, stopping at the first failure. A demonstrably infrastructure-only failure is rerun once and recorded; anything else is a defect fixed with a new commit (fix the class), then that gate and every later one rerun. Never skip, weaken or delete a test. Record each command, its exit code and the totals in the SUMMARY, including the e2e badge test's line.
  </action>
  <verify>
    <automated>systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npm run lint && npm test'</automated>
    <fails_when>non-zero exit, or the test summary reports a failing or cancelled test</fails_when>
    <automated>systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env -u WAYLAND_DISPLAY -u WAYLAND_SOCKET NODE_OPTIONS=--max-old-space-size=1536 npm run test:e2e</automated>
    <fails_when>non-zero exit, or any "✖" line in either scenario</fails_when>
    <automated>systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 npm run verify:release</automated>
    <fails_when>non-zero exit, or verify-release-content prints a "development or source artifacts are present" line</fails_when>
    <automated>systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 node scripts/secret-scan.mjs --range origin/main..HEAD</automated>
    <fails_when>non-zero exit, or any finding line naming a rule id</fails_when>
  </verify>
  <acceptance_criteria>
    - The four commands exit 0 in this order, each run once (reruns only for recorded infrastructure failures).
    - The SUMMARY records the `npm test` totals with 0 failed and both e2e scenarios passing, the badge test included.
  </acceptance_criteria>
  <done>4e is green on top of main across the whole gate.</done>
</task>

<task type="auto">
  <name>Task 3: Open PR 4e, which closes Phase 70, with the release blocker and the owner's questions, and see CI and the agent review through without merging</name>
  <files>(no source file; fix commits only for CI or review defects)</files>
  <read_first>.github/pull_request_template.md, docs/development-workflow.md (sections 2 to 4), .claude/commands/review-pr.md, .planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-VALIDATION.md (Manual-Only Verifications)</read_first>
  <action>
`git push -u origin feat/gate-trust-badge`, then `gh pr create --base main --head feat/gate-trust-badge` with the title `feat(gate): a trust badge on every cloud answer (Phase 70, part 4e)` and every template section filled in plain words. The body says: the trust badge (CLAS-08: its three states, set only from checks that ran, the details and the full attestation on request, replayed when a chat reloads, seen end to end in the real page), replacing the Verify signature row; the owner's decision of 2026-11-16 that every cloud answer from a TEE model is checked once in the background, with what that costs (one signature request per answer, the attestation report reused for 10 minutes); D-51 (the badge ships after 4d so its meaning never changes); D-56 (a check that does not finish in 20 seconds shows Not verified, and the badge is on the lead agent's answers only, saying so); the manual theme check (light, dark and high contrast, 70-VALIDATION.md); a section "Before publishing a release that contains this PR (D-48)" repeating the owner's pre-publish code-server check, as in 70-28a; that this PR closes Phase 70, with the COVERAGE.md table; the owner's question: "Should a sub-agent's answer ever show a badge, for example in Team Live?"; the test totals; the rollback (revert the squash commit; a chat's stored badges are ignored by the previous build, which shows Verify signature again). End with the attribution lines the session gives.

Wait for the required checks with `timeout 3600 gh pr checks --watch`; fix defects with new commits (rerun the affected gate from Task 2 before pushing), rerun infrastructure failures once with `gh run rerun --failed`, and record the agent-review status and every finding with what was done. Never merge, approve, enable auto-merge or push to main.
  </action>
  <verify>
    <automated>sh -c 'S=$(gh pr view feat/gate-trust-badge --json state,baseRefName --jq ".state+\" \"+.baseRefName") && test "$S" = "OPEN main"'</automated>
    <fails_when>non-zero exit: no open PR from feat/gate-trust-badge into main</fails_when>
    <automated>sh -c 'gh pr checks feat/gate-trust-badge --required'</automated>
    <fails_when>non-zero exit, or any required check listed as fail or pending</fails_when>
  </verify>
  <acceptance_criteria>
    - `gh pr view feat/gate-trust-badge --json body --jq .body` contains CLAS-08, D-48, D-51 and D-56 and the words "trust badge" and "Phase 70".
    - The SUMMARY records the PR number and URL, every required check as pass, and the agent-review status with each finding and what was done.
    - `gh pr view feat/gate-trust-badge --json state --jq .state` prints `OPEN` (the executor did not merge).
  </acceptance_criteria>
  <done>PR 4e is open into main, green, with the badge, its release blocker, its question and the phase's coverage in front of the owner.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| local branch -> public GitHub | every commit stays public after the squash |
| PR body -> owner's merge | the badge's meaning reaches people with this release |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-70-128 | Information disclosure | secrets in 4e's commits | high | mitigate | range secret scan (Task 2) |
| T-70-129 | Tampering | PR 4e opened while PR 4d is not on main, so the badge's states mean less than they say | medium | mitigate | automated merged check stops the plan first (Task 1, D-51) |
| T-70-130 | Denial of service | a release with the fail-closed policy file published without the code-server check | high | mitigate | the D-48 check repeated as a release blocker in the PR body (Task 3) |
| T-70-131 | Repudiation | the phase closed with a requirement not mapped to a merged PR | medium | mitigate | COVERAGE.md one row per requirement with PR numbers, checked in Task 1 |
| T-70-SC | Tampering | npm installs | high | mitigate | No package is added; `package-lock.json` unchanged is a gate (Task 1) |
</threat_model>

<verification>
- The merged check passes before anything changes; the gates exit 0, one heavy run at a time.
- PR 4e is open into main with green required checks; nothing was merged, approved or waited on by the executor.
- COVERAGE.md and 70-VALIDATION.md name the PR that delivered each part 4 requirement.
</verification>

<success_criteria>
- PR 4e reaches review under the budget with main green (D-34, D-49, D-51); Phase 70's requirements are each traced to a merged PR, and the D-48 release blocker and the theme check are in front of the owner.
</success_criteria>

<output>
Create `.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-28e-SUMMARY.md` when done, with the merged check, the coverage update, the gate record and the PR number.
</output>
