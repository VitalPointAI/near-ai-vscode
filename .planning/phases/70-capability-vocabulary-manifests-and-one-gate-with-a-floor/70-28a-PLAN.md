---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 28a
pr: 4a
type: execute
wave: 20
depends_on: ["70-19"]
files_modified:
  - CHANGELOG.md
autonomous: true
requirements: [CLAS-06, CLAS-05, GATE-07, OFFL-01]
user_setup: []
estimate:
  tokens: 32017
  raw_tokens: 32000
  tasks: 3
  confidence: high
must_haves:
  truths:
    - "Plan 28a starts only while PR #76 is on main: after `git fetch origin`, `gh pr view 76 --json state,mergeCommit` shows MERGED and its merge commit is an ancestor of origin/main; otherwise it stops with a plain message and changes nothing, and never waits on, polls for, asks for or performs a merge (D-34, D-49)."
    - "PR 4a is rebased with `git rebase --onto origin/main <PR4A_BASE> feat/gate-route-check` (PR4A_BASE from 70-19-SUMMARY.md), keeps only plan 19's and this plan's commits, compiles, its tests and the parity set pass, its diff is under 950,000 bytes and package-lock.json is unchanged; the SUMMARY records the diff bytes and the projected size after review (about 2.2 times) against the ~650 KB target (D-34, D-49)."
    - "Before shipping, the log growth of D-52 is measured and recorded: the bytes of a short and of a full infer record, the model requests per working day (from this machine's spend ledger, counts only, when one exists, else an assumption of 400 stated as one), and the days a project's 5 MB decision log then holds before it rolls over, with and without the infer records (D-52)."
    - "CHANGELOG.md has a `## Unreleased` entry for 4a in plain words: every model request is now checked against the chat's label before it is sent and leaves a short record; nothing changes where requests go on a fresh install (D-24, D-34)."
    - "The full gate passes once inside the cap: lint and suite, e2e under xvfb with the Wayland variables removed, verify:release and the range secret scan (D-34)."
    - "PR 4a is open into main with the title `feat(gate): one route check before every model request, and a record of each (Phase 70, part 4a)`; its body says what changes (every model request passes one route check at the client's choke point and is recorded, D-31, D-52; nothing changes on a fresh install, D-24), names D-50 (levels that need an attested cloud route local-only until PR 4d, invisible until labels exist), names the ids and record fields added for all of part 4 (D-49), reports the D-52 measurement and asks the owner whether to keep the short record, repeats the D-48 code-server check as a release blocker, lists the test totals and the rollback; the executor never merges (D-34, D-48)."
  artifacts: []
  key_links: []
  prohibitions:
    - requirement_id: CLAS-06
      category: safety
      status: resolved
      verification: judgment
      statement: "MUST NOT open PR 4a before PR #76 is merged, and MUST NOT merge, approve or push to main from the execution session."
---

<objective>
Close PR 4a, the first of part 4's five PRs (D-49): check PR #76 is on main, rebase keeping only 4a's commits, measure the log growth the owner asked for, write the CHANGELOG entry, run the full gate once and open the PR with the D-48 release blocker and the owner's questions.

Purpose: D-34 (reviewed PRs under the budget, main green, no merge by the executor), D-48 (no release with the fail-closed policy file before the owner's code-server check), D-49 (each part 4 PR has its own close-out), D-52 (log growth measured before shipping).
Output: PR 4a open from `feat/gate-route-check` into `main` with green checks; `70-28a-SUMMARY.md` with the merged check, the measurement, the gate record and the PR number.

Plan 28 of the first draft was one close-out for one PR 4 built on `feat/gate-floor`; that branch is merged (PR #74) and one PR would have been more than twice the budget. It is now five close-out plans, 70-28a to 70-28e, one per PR, each run right after its PR's last plan (D-49). This plan's diff is CHANGELOG.md and its SUMMARY; it adds no source symbol.
</objective>

<artifacts_produced>
## Artifacts this phase produces

Phase-wide index: 70-01-PLAN.md for plans 01 to 18; part 4's index and requirement map are in COVERAGE.md (replanned 2026-11-17, D-49).

This plan creates no source symbol. It writes the 4a entry under `## Unreleased` in CHANGELOG.md and produces PR 4a (plan 19) from `feat/gate-route-check` into `main`, with the merged check, the D-52 measurement and the gate record in `70-28a-SUMMARY.md`.
</artifacts_produced>

<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-19-SUMMARY.md
Read before acting, not as includes: docs/development-workflow.md sections 1 to 4, .github/pull_request_template.md, .claude/commands/review-pr.md; 70-VALIDATION.md "Manual-Only Verifications" and "Part 4 delivery map"; 70-CONTEXT.md D-48 to D-52; CHANGELOG.md (the `## Unreleased` section PR #76 left).

One heavy run at a time. Full suite and e2e with MemoryMax=6G and timeout 1800; e2e under xvfb with the Wayland variables removed; if the e2e launch itself rejects `NODE_OPTIONS`, rerun it once in the same cap without it and record both. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; the PR body ends with the attribution lines the session gives. Plain words, no em-dashes, "your organization" never "NEAR organization", no local machine paths in the repo, the PR body or the CHANGELOG.
</context>

<tasks>

<task type="tracer">
  <name>Task 1: Tracer: PR #76 is on main, PR 4a is rebased onto it with only its own commits, measured, green and under the budget</name>
  <precondition>PR #76 is merged: `gh pr view 76 --json state,mergeCommit --jq '.state+" "+.mergeCommit.oid'` prints MERGED and a commit. If not, stop with "PR #76 is not on main yet, so PR 4a was not rebased or opened. Run plan 70-28a again after it merges." and change nothing.</precondition>
  <files>CHANGELOG.md (and conflict-resolution commits only if the rebase needs them)</files>
  <read_first>.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-19-SUMMARY.md (PR4A_BASE, the short and full record sizes), CHANGELOG.md (the Unreleased section), src/gate/decisionLog.ts (MAX_DECISION_LOG_BYTES at 18), src/services/spendLedger.ts (how billable entries are stored, for counting only)</read_first>
  <action>
`git fetch origin`, confirm the precondition's merge commit is an ancestor of `origin/main`; if not, stop with the same message and do nothing else. Then `git rebase --onto origin/main <PR4A_BASE> feat/gate-route-check`. Resolve `.planning` conflicts by keeping main's text and adding this branch's lines; code conflicts in favour of what main has plus 4a's changes. Compile and run 4a's tests and the parity set.

Measure D-52 and record it in the SUMMARY (the spend ledger and decision logs on this machine are only read, never written or copied; only aggregate counts and sizes are committed, never an entry, a model name, a path or a timestamp): the bytes of a short and of a full infer record (from plan 19's test helper, written to a temporary decision log); model requests per working day, counted from this machine's spend ledger when one exists (counts per day over the last 30 days, median of working days; nothing but counts is read, and no path or content goes into the repo or the PR), otherwise an assumption of 400 stated as one; the tool records per day and their size from the same project's decision logs when they exist, counts and sizes only; and the days a 5 MB project log holds before rolling over, with and without the infer records.

Write the 4a bullets under `## Unreleased` in CHANGELOG.md (create the section at the top if a release has moved the last one) (plain words: every model request is now checked against the chat's label before it is sent, wherever it starts, and leaves a short record in the project's decision log; on a fresh install nothing changes where requests go) and commit `docs(changelog): part 4a, a route check before every model request`. Then the commit list and budget checks. Record the PR #76 merge commit, the `origin/main` commit, `git log --oneline origin/main..HEAD`, the diff bytes and the projection after review (bytes times 2.2, against the ~650 KB target, D-49). Never skip, weaken or delete a test.
  </action>
  <verify>
    <automated>sh -c 'C=$(gh pr view 76 --json state,mergeCommit --jq "select(.state==\"MERGED\") | .mergeCommit.oid") && test -n "$C" && git fetch -q origin && git merge-base --is-ancestor "$C" origin/main'</automated>
    <fails_when>non-zero exit: PR #76 is not merged, or its merge commit is not on origin/main (the plan must stop here)</fails_when>
    <automated>systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gate*.test.js dist/test/nearAiClient.test.js dist/test/providerFactory.test.js dist/test/attachments.test.js dist/test/autoApproval.test.js dist/test/agentLoop.test.js dist/test/benchmarkRunner.test.js dist/test/cyberRun.test.js dist/test/teamBoundaries.test.js'</automated>
    <fails_when>non-zero exit, or the node --test summary shows "# fail" above 0, "# cancelled" above 0 or "# tests 0"</fails_when>
    <automated>sh -c 'git merge-base --is-ancestor origin/main HEAD && git diff --quiet origin/main...HEAD -- package-lock.json && D=$(git rev-parse --git-path phase70-pr4a.diff) && git diff origin/main...HEAD > "$D" && B=$(wc -c < "$D") && echo "PR diff bytes: $B, projected after review: $((B * 22 / 10))" && test "$B" -lt 950000'</automated>
    <fails_when>non-zero exit: the branch is not on top of origin/main, package-lock.json changed, or the PR diff is 950,000 bytes or more</fails_when>
  </verify>
  <acceptance_criteria>
    - The SUMMARY records the PR #76 merge commit and that `git merge-base --is-ancestor` exited 0 against `origin/main`.
    - `git log --oneline origin/main..HEAD` lists only plan 19's and this plan's commits (recorded in the SUMMARY).
    - The SUMMARY records the D-52 measurement (every number, and which were assumptions), the diff bytes (below 950,000) with the projection after review, and the test totals with 0 failed.
    - `grep -c "^## Unreleased" CHANGELOG.md` prints 1 (the section is created at the top when a release has already moved the last one) and the section names the route check.
  </acceptance_criteria>
  <done>PR #76 is confirmed on main without anyone being asked, and 4a stands on main with only its own commits, measured, green and under the budget.</done>
</task>

<task type="auto">
  <name>Task 2: The full gate once on the rebased branch</name>
  <files>(no source file; fix commits only for real defects)</files>
  <read_first>package.json (scripts lint, test, test:e2e, verify:release), scripts/secret-scan.mjs (header)</read_first>
  <action>
Run the four gate commands below in order, one at a time, stopping at the first failure. A demonstrably infrastructure-only failure is rerun once and recorded; anything else is a defect fixed with a new commit (fix the class), then that gate and every later one rerun. Never skip, weaken or delete a test. Record each command, its exit code and the totals in the SUMMARY.
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
    - The SUMMARY records the `npm test` totals with 0 failed and both e2e scenarios passing.
  </acceptance_criteria>
  <done>4a is green on top of main across the whole gate.</done>
</task>

<task type="auto">
  <name>Task 3: Open PR 4a with the D-48 release blocker and the owner's questions, and see CI and the agent review through without merging</name>
  <files>(no source file; fix commits only for CI or review defects)</files>
  <read_first>.github/pull_request_template.md, docs/development-workflow.md (sections 2 to 4), .claude/commands/review-pr.md, .planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-VALIDATION.md (Manual-Only Verifications)</read_first>
  <action>
`git push -u origin feat/gate-route-check`, then `gh pr create --base main --head feat/gate-route-check` with the title `feat(gate): one route check before every model request, and a record of each (Phase 70, part 4a)` and every template section filled in plain words. The body says: what changes (every model request, wherever it starts, passes one route check at the client before anything is sent, and leaves an infer record; routine allowed requests leave a short record; records never name a host or a path; D-31, D-52); that nothing changes where requests go on a fresh install (D-24), because labels arrive in 4b and the chat's label in 4c; D-50 (levels that need an attested cloud route local-only until 4d, which no one can reach before labels exist); that every rule id, event id and record field part 4 uses is added now so a later PR rolled back leaves no record older code cannot name (D-49); the D-52 measurement from the SUMMARY with the question "Keep the short record for routine allowed requests, or record them in full?"; a section "Before publishing a release that contains this PR (D-48)" repeating the owner's pre-publish code-server check (a fresh code-server profile creates the identity, signs its first policy file and stays usable for a chat and one edit; if it fails, the release waits and the identity-unavailable state is redesigned first), because every release from PR 2 on carries the fail-closed policy file; the diff size with its projection after review; the test totals; the rollback (revert the squash commit; records written while this was live may carry `route.default-session` and other new ids, which older code keeps under `record.unknown-rule`). End with the attribution lines the session gives.

Wait for the required checks with `timeout 3600 gh pr checks --watch`; fix defects with new commits (rerun the affected gate from Task 2 before pushing), rerun infrastructure failures once with `gh run rerun --failed`, and record the agent-review status and every finding with what was done. Never merge, approve, enable auto-merge or push to main.
  </action>
  <verify>
    <automated>sh -c 'S=$(gh pr view feat/gate-route-check --json state,baseRefName --jq ".state+\" \"+.baseRefName") && test "$S" = "OPEN main"'</automated>
    <fails_when>non-zero exit: no open PR from feat/gate-route-check into main</fails_when>
    <automated>sh -c 'gh pr checks feat/gate-route-check --required'</automated>
    <fails_when>non-zero exit, or any required check listed as fail or pending</fails_when>
  </verify>
  <acceptance_criteria>
    - `gh pr view feat/gate-route-check --json body --jq .body` contains D-24, D-31, D-48, D-49, D-50 and D-52 and the words "route check" and "short record".
    - The SUMMARY records the PR number and URL, every required check as pass, and the agent-review status with each finding and what was done.
    - `gh pr view feat/gate-route-check --json state --jq .state` prints `OPEN` (the executor did not merge).
  </acceptance_criteria>
  <done>PR 4a is open into main, green, with its measurement, its release blocker and its question in front of the owner.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| local branch -> public GitHub | every commit stays public after the squash |
| this machine's spend ledger and decision logs -> the measurement | only counts and sizes leave them |
| PR body -> owner's merge | the owner decides on the short record before release |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-70-79 | Information disclosure | secrets in 4a's commits | high | mitigate | range secret scan (Task 2) |
| T-70-81 | Tampering | PR 4a opened while PR #76 is not on main | medium | mitigate | automated merged check stops the plan first (Task 1) |
| T-70-89 | Denial of service | a release with the fail-closed policy file published without the code-server check | high | mitigate | the D-48 check repeated as a release blocker in the PR body (Task 3) |
| T-70-117 | Information disclosure | local paths or ledger contents copied into the repo or the PR during the measurement | low | mitigate | counts and sizes only; no path in any repo file or PR text (Task 1) |
| T-70-SC | Tampering | npm installs | high | mitigate | No package is added; `package-lock.json` unchanged is a gate (Task 1) |
</threat_model>

<verification>
- The merged check passes before anything changes; the gates exit 0, one heavy run at a time.
- PR 4a is open into main with green required checks; nothing was merged, approved or waited on by the executor.
</verification>

<success_criteria>
- PR 4a reaches review under the budget with main green (D-34, D-49); the D-52 measurement and question and the D-48 release blocker are in front of the owner.
</success_criteria>

<output>
Create `.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-28a-SUMMARY.md` when done, with the merged check, the D-52 measurement, the gate record and the PR number.
</output>
