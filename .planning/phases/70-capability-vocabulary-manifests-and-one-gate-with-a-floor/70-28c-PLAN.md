---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 28c
pr: 4c
type: execute
wave: 27
depends_on: ["70-24"]
files_modified:
  - CHANGELOG.md
autonomous: true
requirements: [CLAS-01, CLAS-02, CLAS-04, CLAS-06, CLAS-07, GATE-07]
user_setup: []
estimate:
  tokens: 31016
  raw_tokens: 31000
  tasks: 3
  confidence: high
must_haves:
  truths:
    - "Plan 28c starts only once PR 4b is on main: `gh pr list --state merged --head feat/gate-labels --base main` names a merge commit and `git merge-base --is-ancestor <that commit> origin/main` exits 0 after `git fetch origin`; otherwise it stops with a plain message and changes nothing, and never waits on, polls for, asks for or performs the merge (D-34, D-49)."
    - "PR 4c is rebased with `git rebase --onto origin/main <PR4C_BASE> feat/gate-session-mark` (PR4C_BASE from 70-22-SUMMARY.md), keeps only plans 22, 23, 24 and this plan's commits, compiles, its tests and the parity set pass, its diff is under 950,000 bytes and package-lock.json is unchanged; the SUMMARY records the diff bytes and the projected size after review against the ~650 KB target, and the PR body says plainly if the projection is over it (D-34, D-49)."
    - "CHANGELOG.md has a `## Unreleased` entry for 4c in plain words: the chat shows its label, reading a labelled file raises it, only you can lower it with a reason, a sync never lowers it, content at strict labels stays on this computer, and levels that need an attested cloud stay on this computer in this version (D-34, D-50)."
    - "Before the gate, SECURITY.md, README and Show Policy are read against the code once more: no text still says a label does not change where content is sent, the section Classification labels and routing carries the three constants in order, and gateDocs and gateCommands pass (CLAS-07)."
    - "The full gate passes once inside the cap: lint and suite, e2e under xvfb with the Wayland variables removed, verify:release and the range secret scan (D-34)."
    - "PR 4c is open into main with the title `feat(gate): the chat's label, raised by what agents read, decides where its requests go (Phase 70, part 4c)`; its body names the routing meanings it makes live (D-30, D-37, D-50), the session mark's rules (D-29, D-54: only rises, kept and synced with the chat, lowered only by a person with a reason, the merge rule for a lowering made on another computer), that 22 and 23 ship together on purpose, the size against the target, the D-48 release blocker, the owner's questions, the test totals and the rollback; the executor never merges (D-34)."
  artifacts: []
  key_links: []
  prohibitions:
    - requirement_id: CLAS-04
      category: safety
      status: resolved
      verification: judgment
      statement: "MUST NOT open PR 4c before PR 4b is merged, MUST NOT split plans 22 and 23 across PRs, and MUST NOT merge, approve or push to main from the execution session."
---

<objective>
Close PR 4c (D-49): check PR 4b is on main, rebase keeping only 4c's commits, write the CHANGELOG entry, confirm the docs now say routing by label is live, run the full gate once and open the PR that makes the chat's label decide where its requests go.

Purpose: D-34, D-29, D-30, D-37, D-48, D-49, D-50, D-54. This is the release where labels first change where content is sent, so its body names the routing meanings for the owner before release.
Output: PR 4c open from `feat/gate-session-mark` into `main` with green checks; `70-28c-SUMMARY.md`.

Size: 4c is the largest of the five (plans 22, 23 and 24, about 212,000 plan tokens), projected at about 700 KB after review against the ~650 KB target. The client-level local-only tests already moved to 4b by default (D-57), which brought 4c to about 640 KB; the planner then added plan 23 Task 3, the signed lowerings (D-58, the author's decision, pending 4c's review). This plan reports the measured size and the projection in the PR body; the further split that would bring it under (shipping plan 23 Task 3 in 4d) is an open owner question recorded in COVERAGE.md, not done here.
</objective>

<artifacts_produced>
## Artifacts this phase produces

Phase-wide index: 70-01-PLAN.md for plans 01 to 18; part 4's index and requirement map are in COVERAGE.md (replanned 2026-11-17, D-49).

This plan creates no source symbol. It writes the 4c entry under `## Unreleased` in CHANGELOG.md and produces PR 4c (plans 22, 23 and 24) from `feat/gate-session-mark` into `main`, with the merged check and the gate record in `70-28c-SUMMARY.md`.
</artifacts_produced>

<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-22-SUMMARY.md
@.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-24-SUMMARY.md
@.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-28b-SUMMARY.md
Read before acting, not as includes: docs/development-workflow.md sections 1 to 4, .github/pull_request_template.md, .claude/commands/review-pr.md; 70-23-SUMMARY.md; 70-VALIDATION.md "Manual-Only Verifications" and "Part 4 delivery map"; 70-CONTEXT.md D-29, D-30, D-37, D-48 to D-50, D-54.

One heavy run at a time. Full suite and e2e with MemoryMax=6G and timeout 1800; e2e under xvfb with the Wayland variables removed; if the e2e launch itself rejects `NODE_OPTIONS`, rerun it once in the same cap without it and record both. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; the PR body ends with the attribution lines the session gives. Plain words, no em-dashes, "your organization" never "NEAR organization", no local machine paths.
</context>

<tasks>

<task type="tracer">
  <name>Task 1: Tracer: PR 4b is on main, PR 4c is rebased onto it with only its own commits, its docs say routing by label is live, green and measured</name>
  <precondition>PR 4b is merged: `gh pr list --state merged --head feat/gate-labels --base main --json number,mergeCommit` lists the PR whose number 70-28b-SUMMARY.md records, with a merge commit. If it lists nothing, stop with "PR 4b is not on main yet, so PR 4c was not rebased or opened. Run plan 70-28c again after PR 4b merges." and change nothing.</precondition>
  <files>CHANGELOG.md (and conflict-resolution commits only if the rebase needs them)</files>
  <read_first>.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-22-SUMMARY.md (PR4C_BASE), 70-28b-SUMMARY.md (PR 4b number), CHANGELOG.md (the Unreleased section), SECURITY.md (the section Classification labels and routing and the policy section), README.md (the labels paragraph)</read_first>
  <action>
`git fetch origin`, confirm the precondition's merge commit is an ancestor of `origin/main`; if not, stop with the same message and do nothing else. Then `git rebase --onto origin/main <PR4C_BASE> feat/gate-session-mark`. Resolve `.planning` conflicts by keeping main's text and adding this branch's lines; code conflicts in favour of what main has plus 4c's changes. Write the 4c bullets under `## Unreleased` in CHANGELOG.md (create the section at the top if a release has moved the last one): the chat shows its label; reading a labelled file raises it, and helpers share it; what a labelled chat writes takes its label; only you can lower it, with NEAR AI: Lower This Chat's Label and a reason, and a sync never lowers it (a lowering reaches your other computers only signed, and only where they can check it); content at Restricted, Protected B and the other local-only levels stays on this computer, and so, in this version, does content at levels that need an attested cloud; calls that could send data off this computer are refused at those labels. Commit `docs(changelog): part 4c, the chat's label decides where its requests go`. Read SECURITY.md, README and Show Policy against the code once more; any mismatch is fixed with a commit and named in the SUMMARY. Compile and run 4c's tests and the parity set, then the commit list and budget checks. Record the PR 4b number, its merge commit, the `origin/main` commit, `git log --oneline origin/main..HEAD`, the diff bytes and the projection after review. Never skip, weaken or delete a test.
  </action>
  <verify>
    <automated>sh -c 'C=$(gh pr list --state merged --head feat/gate-labels --base main --json mergeCommit --jq ".[0].mergeCommit.oid // empty") && test -n "$C" && git fetch -q origin && git merge-base --is-ancestor "$C" origin/main'</automated>
    <fails_when>non-zero exit: no merged PR from feat/gate-labels into main, or its merge commit is not on origin/main (the plan must stop here)</fails_when>
    <automated>systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gate*.test.js dist/test/commandEffects.test.js dist/test/autoApproval.test.js dist/test/agentLoop.test.js dist/test/agentTools.test.js dist/test/untrusted.test.js dist/test/threadMerge.test.js dist/test/threadLog.test.js dist/test/teamSignedPayload.test.js dist/test/teamBoundaries.test.js'</automated>
    <fails_when>non-zero exit, or the node --test summary shows "# fail" above 0, "# cancelled" above 0 or "# tests 0"</fails_when>
    <automated>sh -c 'git merge-base --is-ancestor origin/main HEAD && git diff --quiet origin/main...HEAD -- package-lock.json && D=$(git rev-parse --git-path phase70-pr4c.diff) && git diff origin/main...HEAD > "$D" && B=$(wc -c < "$D") && echo "PR diff bytes: $B, projected after review: $((B * 22 / 10))" && test "$B" -lt 950000'</automated>
    <fails_when>non-zero exit: the branch is not on top of origin/main, package-lock.json changed, or the PR diff is 950,000 bytes or more</fails_when>
  </verify>
  <acceptance_criteria>
    - The SUMMARY records the PR 4b number (equal to the one in 70-28b-SUMMARY.md), its merge commit, and that `git merge-base --is-ancestor` exited 0 against `origin/main`.
    - `git log --oneline origin/main..HEAD` lists only plans 22, 23, 24 and this plan's commits (recorded in the SUMMARY).
    - The SUMMARY records the diff bytes (below 950,000) with the projection after review, and the test totals with 0 failed.
    - `grep -c "^## Unreleased" CHANGELOG.md` prints 1 and the section names Lower This Chat's Label.
  </acceptance_criteria>
  <done>PR 4b is confirmed on main without anyone being asked, and 4c stands on main with only its own commits, docs that say routing by label is live, green and measured.</done>
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
  <done>4c is green on top of main across the whole gate.</done>
</task>

<task type="auto">
  <name>Task 3: Open PR 4c naming the routing meanings, the release blocker and the owner's questions, and see CI and the agent review through without merging</name>
  <files>(no source file; fix commits only for CI or review defects)</files>
  <read_first>.github/pull_request_template.md, docs/development-workflow.md (sections 2 to 4), .claude/commands/review-pr.md, .planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-VALIDATION.md (Manual-Only Verifications)</read_first>
  <action>
`git push -u origin feat/gate-session-mark`, then `gh pr create --base main --head feat/gate-session-mark` with the title `feat(gate): the chat's label, raised by what agents read, decides where its requests go (Phase 70, part 4c)` and every template section filled in plain words. The body says: what is new for people (the chat's label next to the model and in the status bar, Lower This Chat's Label, refusals that say why and how to get out); the routing meanings it makes live, still cheap to change until a release ships this PR (D-30 tiers, D-37 local-only means loopback or a host your organization names, D-50 levels that need an attested cloud stay on this computer until 4d, or for good if NEAR AI Cloud never offers the binding); the mark's rules (D-29, D-54: it only rises, helpers share it, files the chat writes take it, it is kept with the chat and synced with it encrypted, a sync never lowers it, a lowering reaches another copy only as a declassification signed with the person's device key that the copy can check and only when it undoes no raise there, D-58, and calls that could leave this computer are refused at strict labels by the same check as the credential-read hold); that plans 22 and 23 ship together on purpose (a mark kept only in memory would be lowered by a window reload); the measured size and its projection, saying plainly if it is over ~650 KB; a section "Before publishing a release that contains this PR (D-48)" repeating the owner's pre-publish code-server check, as in 70-28a; the owner's questions: "At Internal and Confidential (attested-cloud), web and other network tools still run, because D-29 refuses them only at local-only and deny; should they ask or be refused there too?" and "Outside Team Mode a lowering made on one computer is not applied on your other computers (they cannot check its key until Phase 71), so the higher label returns when they sync; is that acceptable, or should the signed lowerings ship later (4d) with this PR keeping only the raise-only sync?"; the test totals; the rollback (revert the squash commit; a chat's label left in its synced metadata is ignored by the previous build, which also no longer routes by it). End with the attribution lines the session gives.

Wait for the required checks with `timeout 3600 gh pr checks --watch`; fix defects with new commits (rerun the affected gate from Task 2 before pushing), rerun infrastructure failures once with `gh run rerun --failed`, and record the agent-review status and every finding with what was done. Never merge, approve, enable auto-merge or push to main.
  </action>
  <verify>
    <automated>sh -c 'S=$(gh pr view feat/gate-session-mark --json state,baseRefName --jq ".state+\" \"+.baseRefName") && test "$S" = "OPEN main"'</automated>
    <fails_when>non-zero exit: no open PR from feat/gate-session-mark into main</fails_when>
    <automated>sh -c 'gh pr checks feat/gate-session-mark --required'</automated>
    <fails_when>non-zero exit, or any required check listed as fail or pending</fails_when>
  </verify>
  <acceptance_criteria>
    - `gh pr view feat/gate-session-mark --json body --jq .body` contains D-29, D-30, D-37, D-48, D-50, D-54 and D-58 and the words "Lower This Chat's Label".
    - The SUMMARY records the PR number and URL, every required check as pass, and the agent-review status with each finding and what was done.
    - `gh pr view feat/gate-session-mark --json state --jq .state` prints `OPEN` (the executor did not merge).
  </acceptance_criteria>
  <done>PR 4c is open into main, green, with its routing meanings, its size, its release blocker and its questions in front of the owner.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| local branch -> public GitHub | every commit stays public after the squash |
| PR body -> owner's merge | the last cheap moment to change the routing meanings |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-70-121 | Information disclosure | secrets in 4c's commits | high | mitigate | range secret scan (Task 2) |
| T-70-122 | Tampering | PR 4c opened while PR 4b is not on main, or plans 22 and 23 split | medium | mitigate | automated merged check stops the plan first; the commit list must hold plans 22, 23 and 24 (Task 1) |
| T-70-123 | Denial of service | a release with the fail-closed policy file published without the code-server check | high | mitigate | the D-48 check repeated as a release blocker in the PR body (Task 3) |
| T-70-SC | Tampering | npm installs | high | mitigate | No package is added; `package-lock.json` unchanged is a gate (Task 1) |
</threat_model>

<verification>
- The merged check passes before anything changes; the gates exit 0, one heavy run at a time.
- PR 4c is open into main with green required checks; nothing was merged, approved or waited on by the executor.
</verification>

<success_criteria>
- PR 4c reaches review with main green (D-34, D-49), its size stated against the target; the routing meanings and the D-48 release blocker are in front of the owner.
</success_criteria>

<output>
Create `.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-28c-SUMMARY.md` when done, with the merged check, the gate record and the PR number.
</output>
