---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 28d
pr: 4d
type: execute
wave: 29
depends_on: ["70-25"]
files_modified:
  - CHANGELOG.md
autonomous: true
requirements: [CLAS-05, OFFL-01, GATE-07, CLAS-07]
user_setup: []
estimate:
  tokens: 31016
  raw_tokens: 31000
  tasks: 3
  confidence: high
must_haves:
  truths:
    - "Plan 28d starts only once PR 4c is on main: `gh pr list --state merged --head feat/gate-session-mark --base main` names a merge commit and `git merge-base --is-ancestor <that commit> origin/main` exits 0 after `git fetch origin`; otherwise it stops with a plain message and changes nothing, and never waits on, polls for, asks for or performs the merge (D-34, D-49)."
    - "PR 4d is rebased with `git rebase --onto origin/main <PR4D_BASE> feat/gate-attested-routing` (PR4D_BASE from 70-25-SUMMARY.md), keeps only plan 25's and this plan's commits, compiles, its tests and the parity set pass, its diff is under 950,000 bytes and package-lock.json is unchanged; the SUMMARY records the diff bytes and the projected size after review against the ~650 KB target (D-34, D-49)."
    - "CHANGELOG.md has a `## Unreleased` entry for 4d in plain words, written from plan 25's research finding: whether content at levels that need an attested cloud can now reach a private NEAR AI Cloud model over a proven connection, or still stays on this computer; each such answer is checked afterwards, and a failed check stops that level for the chat until Check again passes (D-34, D-55)."
    - "Before the gate, SECURITY.md and Show Policy are read against the code once more: CONNECTION_BINDING_TEXT word for word, the research finding sentence matches 70-25-SUMMARY.md, the proxy sentence and both limitation rows are present; gateDocs and gateCommands pass (CLAS-07)."
    - "The full gate passes once inside the cap: lint and suite, e2e under xvfb with the Wayland variables removed, verify:release and the range secret scan (D-34)."
    - "PR 4d is open into main with the title `feat(gate): attested-cloud only over a proven connection, checked after each answer (Phase 70, part 4d)`; its body quotes the 'NEAR AI Cloud connection binding' finding from 70-25-SUMMARY.md and says plainly whether attested-cloud levels can reach NEAR AI Cloud now or stay on this computer, describes the owner's CLAS-05 amplification as built, D-36 and D-55 (the after-answer check, its stop and Check again), proxies, the live comparison left for a person when it was not made, the D-48 release blocker, the owner's questions, the test totals and the rollback; the executor never merges (D-34)."
  artifacts: []
  key_links: []
  prohibitions:
    - requirement_id: CLAS-05
      category: safety
      status: resolved
      verification: judgment
      statement: "MUST NOT open PR 4d before PR 4c is merged, MUST NOT describe attested-cloud levels as reaching NEAR AI Cloud when the research finding says the binding is not exposed, and MUST NOT merge, approve or push to main from the execution session."
---

<objective>
Close PR 4d (D-49): check PR 4c is on main, rebase keeping only 4d's commits, write the CHANGELOG entry from the research finding, confirm the docs match it, run the full gate once and open the PR that lets attested-cloud levels reach NEAR AI Cloud only over a proven connection.

Purpose: D-34, D-36, D-48, D-49, D-50, D-55 and the owner's CLAS-05 amplification, with plan 25's research finding put in front of the owner.
Output: PR 4d open from `feat/gate-attested-routing` into `main` with green checks; `70-28d-SUMMARY.md`.
</objective>

<artifacts_produced>
## Artifacts this phase produces

Phase-wide index: 70-01-PLAN.md for plans 01 to 18; part 4's index and requirement map are in COVERAGE.md (replanned 2026-11-17, D-49).

This plan creates no source symbol. It writes the 4d entry under `## Unreleased` in CHANGELOG.md and produces PR 4d (plan 25) from `feat/gate-attested-routing` into `main`, with the merged check and the gate record in `70-28d-SUMMARY.md`.
</artifacts_produced>

<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-25-SUMMARY.md
@.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-28c-SUMMARY.md
Read before acting, not as includes: docs/development-workflow.md sections 1 to 4, .github/pull_request_template.md, .claude/commands/review-pr.md; 70-VALIDATION.md "Manual-Only Verifications" and "Part 4 delivery map"; 70-CONTEXT.md "Owner decisions after planning (2026-11-16)", D-36, D-48 to D-50, D-55.

One heavy run at a time. Full suite and e2e with MemoryMax=6G and timeout 1800; e2e under xvfb with the Wayland variables removed; if the e2e launch itself rejects `NODE_OPTIONS`, rerun it once in the same cap without it and record both. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; the PR body ends with the attribution lines the session gives. Plain words, no em-dashes, "your organization" never "NEAR organization", NEAR AI named only as the provider, no local machine paths.
</context>

<tasks>

<task type="tracer">
  <name>Task 1: Tracer: PR 4c is on main, PR 4d is rebased onto it with only its own commits, its docs match the research finding, green and under the budget</name>
  <precondition>PR 4c is merged: `gh pr list --state merged --head feat/gate-session-mark --base main --json number,mergeCommit` lists the PR whose number 70-28c-SUMMARY.md records, with a merge commit. If it lists nothing, stop with "PR 4c is not on main yet, so PR 4d was not rebased or opened. Run plan 70-28d again after PR 4c merges." and change nothing.</precondition>
  <files>CHANGELOG.md (and conflict-resolution commits only if the rebase needs them)</files>
  <read_first>.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-25-SUMMARY.md (PR4D_BASE and the "NEAR AI Cloud connection binding" finding), 70-28c-SUMMARY.md (PR 4c number), CHANGELOG.md (the Unreleased section), SECURITY.md (Classification labels and routing, Checking a response's signature, Known limitations)</read_first>
  <action>
`git fetch origin`, confirm the precondition's merge commit is an ancestor of `origin/main`; if not, stop with the same message and do nothing else. Then `git rebase --onto origin/main <PR4D_BASE> feat/gate-attested-routing`. Resolve `.planning` conflicts by keeping main's text and adding this branch's lines; code conflicts in favour of what main has plus 4d's changes. Write the 4d bullets under `## Unreleased` in CHANGELOG.md (create the section at the top if a release has moved the last one), from the research finding: either "content at Internal, Confidential and the other levels that need an attested cloud can again use a private NEAR AI Cloud model, but only over a connection proven to end inside its private hardware" or "content at those levels still stays on this computer, because NEAR AI Cloud's attestation does not yet show where the connection ends"; each such answer is checked afterwards, and a failed check stops that level for the chat until Check again under that answer passes. Commit `docs(changelog): part 4d, attested-cloud over a proven connection`. Read SECURITY.md and Show Policy against the code and the finding once more; any mismatch is fixed with a commit and named in the SUMMARY. Compile and run 4d's tests and the parity set, then the commit list and budget checks. Record the PR 4c number, its merge commit, the `origin/main` commit, `git log --oneline origin/main..HEAD`, the diff bytes and the projection after review. Never skip, weaken or delete a test.
  </action>
  <verify>
    <automated>sh -c 'C=$(gh pr list --state merged --head feat/gate-session-mark --base main --json mergeCommit --jq ".[0].mergeCommit.oid // empty") && test -n "$C" && git fetch -q origin && git merge-base --is-ancestor "$C" origin/main'</automated>
    <fails_when>non-zero exit: no merged PR from feat/gate-session-mark into main, or its merge commit is not on origin/main (the plan must stop here)</fails_when>
    <automated>systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gate*.test.js dist/test/attestation.test.js dist/test/nearAiClient.test.js dist/test/providerFactory.test.js dist/test/privateMembers.test.js dist/test/conversations.test.js dist/test/checkNow.test.js dist/test/agentLoop.test.js dist/test/teamBoundaries.test.js'</automated>
    <fails_when>non-zero exit, or the node --test summary shows "# fail" above 0, "# cancelled" above 0 or "# tests 0"</fails_when>
    <automated>sh -c 'git merge-base --is-ancestor origin/main HEAD && git diff --quiet origin/main...HEAD -- package-lock.json && D=$(git rev-parse --git-path phase70-pr4d.diff) && git diff origin/main...HEAD > "$D" && B=$(wc -c < "$D") && echo "PR diff bytes: $B, projected after review: $((B * 22 / 10))" && test "$B" -lt 950000'</automated>
    <fails_when>non-zero exit: the branch is not on top of origin/main, package-lock.json changed, or the PR diff is 950,000 bytes or more</fails_when>
  </verify>
  <acceptance_criteria>
    - The SUMMARY records the PR 4c number (equal to the one in 70-28c-SUMMARY.md), its merge commit, and that `git merge-base --is-ancestor` exited 0 against `origin/main`.
    - `git log --oneline origin/main..HEAD` lists only plan 25's and this plan's commits (recorded in the SUMMARY).
    - The SUMMARY records the diff bytes (below 950,000) with the projection after review, and the test totals with 0 failed.
    - `grep -c "^## Unreleased" CHANGELOG.md` prints 1 and the section names Check again.
  </acceptance_criteria>
  <done>PR 4c is confirmed on main without anyone being asked, and 4d stands on main with only its own commits, docs that match the research finding, green and under the budget.</done>
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
  <done>4d is green on top of main across the whole gate.</done>
</task>

<task type="auto">
  <name>Task 3: Open PR 4d with the research finding, the release blocker and the owner's questions, and see CI and the agent review through without merging</name>
  <files>(no source file; fix commits only for CI or review defects)</files>
  <read_first>.github/pull_request_template.md, docs/development-workflow.md (sections 2 to 4), .claude/commands/review-pr.md, .planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-VALIDATION.md (Manual-Only Verifications)</read_first>
  <action>
`git push -u origin feat/gate-attested-routing`, then `gh pr create --base main --head feat/gate-attested-routing` with the title `feat(gate): attested-cloud only over a proven connection, checked after each answer (Phase 70, part 4d)` and every template section filled in plain words. The body says: the owner's CLAS-05 amplification as built (a level that needs attested-cloud is sent only over a connection whose certificate NEAR AI Cloud's attestation binds to the enclave, and the request's own connection is pinned to it; otherwise it stays on this computer), quoting the "NEAR AI Cloud connection binding" finding from 70-25-SUMMARY.md and saying plainly whether attested-cloud levels can reach NEAR AI Cloud from this release or still stay on this computer (D-50); the after-answer check (D-36) with its 10-minute report cache, its stop and Check again (D-55); that a proxy which inspects encrypted traffic keeps these levels on this computer; these routing meanings are still cheap to change until a release ships this PR; when plan 25 made no live comparison, the manual check left for a person (run one Confidential chat on NEAR AI Cloud and read the answer's Verify signature result, 70-VALIDATION.md); a section "Before publishing a release that contains this PR (D-48)" repeating the owner's pre-publish code-server check, as in 70-28a; the owner's questions: "Is clearing the stop on a new chat or a window reload, as well as on a passing Check again, the right escape?" and, when the binding is not exposed, "Should we ask NEAR AI to expose it, or accept that these levels stay on this computer?"; the test totals; the rollback (revert the squash commit; attested-cloud levels then route local-only again, D-50). End with the attribution lines the session gives.

Wait for the required checks with `timeout 3600 gh pr checks --watch`; fix defects with new commits (rerun the affected gate from Task 2 before pushing), rerun infrastructure failures once with `gh run rerun --failed`, and record the agent-review status and every finding with what was done. Never merge, approve, enable auto-merge or push to main.
  </action>
  <verify>
    <automated>sh -c 'S=$(gh pr view feat/gate-attested-routing --json state,baseRefName --jq ".state+\" \"+.baseRefName") && test "$S" = "OPEN main"'</automated>
    <fails_when>non-zero exit: no open PR from feat/gate-attested-routing into main</fails_when>
    <automated>sh -c 'gh pr checks feat/gate-attested-routing --required'</automated>
    <fails_when>non-zero exit, or any required check listed as fail or pending</fails_when>
  </verify>
  <acceptance_criteria>
    - `gh pr view feat/gate-attested-routing --json body --jq .body` contains CLAS-05, D-36, D-48, D-50 and D-55 and the words "connection binding" and "Check again".
    - The SUMMARY records the PR number and URL, every required check as pass, and the agent-review status with each finding and what was done.
    - `gh pr view feat/gate-attested-routing --json state --jq .state` prints `OPEN` (the executor did not merge).
  </acceptance_criteria>
  <done>PR 4d is open into main, green, with the research finding, its release blocker and its questions in front of the owner.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| local branch -> public GitHub | every commit stays public after the squash |
| PR body -> owner's merge | the owner decides on the attested-cloud routing with the research finding in hand |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-70-124 | Information disclosure | secrets or an API key in 4d's commits | high | mitigate | range secret scan (Task 2); plan 25 never writes a key |
| T-70-125 | Repudiation | the PR or CHANGELOG claiming attested-cloud works when the binding is not exposed | high | mitigate | both are written from the recorded finding and checked against SECURITY.md (Task 1, Task 3) |
| T-70-126 | Tampering | PR 4d opened while PR 4c is not on main | medium | mitigate | automated merged check stops the plan first (Task 1) |
| T-70-127 | Denial of service | a release with the fail-closed policy file published without the code-server check | high | mitigate | the D-48 check repeated as a release blocker in the PR body (Task 3) |
| T-70-SC | Tampering | npm installs | high | mitigate | No package is added; `package-lock.json` unchanged is a gate (Task 1) |
</threat_model>

<verification>
- The merged check passes before anything changes; the gates exit 0, one heavy run at a time.
- PR 4d is open into main with green required checks; nothing was merged, approved or waited on by the executor.
</verification>

<success_criteria>
- PR 4d reaches review under the budget with main green (D-34, D-49); the research finding, the routing meanings and the D-48 release blocker are in front of the owner.
</success_criteria>

<output>
Create `.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-28d-SUMMARY.md` when done, with the merged check, the gate record and the PR number.
</output>
