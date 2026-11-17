---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 28b
pr: 4b
type: execute
wave: 23
depends_on: ["70-21"]
files_modified:
  - CHANGELOG.md
autonomous: true
requirements: [CLAS-01, CLAS-02, CLAS-03, CLAS-07, GATE-07]
user_setup: []
estimate:
  tokens: 30016
  raw_tokens: 30000
  tasks: 3
  confidence: high
must_haves:
  truths:
    - "Plan 28b starts only once PR 4a is on main: `gh pr list --state merged --head feat/gate-route-check --base main` names a merge commit and `git merge-base --is-ancestor <that commit> origin/main` exits 0 after `git fetch origin`; otherwise it stops with a plain message and changes nothing, and never waits on, polls for, asks for or performs the merge (D-34, D-49)."
    - "PR 4b is rebased with `git rebase --onto origin/main <PR4B_BASE> feat/gate-labels` (PR4B_BASE from 70-20-SUMMARY.md), keeps only plans 20, 21 and this plan's commits, compiles, its tests and the parity set pass, its diff is under 950,000 bytes and package-lock.json is unchanged; the SUMMARY records the diff bytes and the projected size after review against the ~650 KB target (D-34, D-49)."
    - "CHANGELOG.md has a `## Unreleased` entry for 4b in plain words: Set Label, Edit Policy and Apply Policy Draft; agents cannot read files above your clearance; labels do not change where content is sent yet (D-34)."
    - "Before the gate, SECURITY.md, README and Show Policy are read against the code once more: they name the three commands package.json contributes, say a label does not change where content is sent yet, and carry LABELS_NOT_ACCREDITATION_TEXT and CLEARANCE_SELF_ASSERTED_TEXT word for word; gateDocs and gateCommands pass (CLAS-07)."
    - "The full gate passes once inside the cap: lint and suite, e2e under xvfb with the Wayland variables removed, verify:release and the range secret scan (D-34)."
    - "PR 4b is open into main with the title `feat(gate): labels on files and folders, clearance checks on reads, and Edit Policy (Phase 70, part 4b)`; its body names the project file format it first writes (label map v1 at .planning/.near-ai/labels.json, signed under the purpose label-map, D-25), still cheap to change until a release ships it; the fail-open fixes of D-53; that labels do not change where content is sent yet (D-49); that labels, compartment names included, are readable by anyone who can read the project; that a clearance is self-declared until verified credentials arrive (D-27); the post-release check by your organization's security officer of the NATO list and the two Canadian scales, which Set Label now offers (D-23); the D-48 release blocker; the owner's questions; the test totals and the rollback; the executor never merges (D-34)."
  artifacts: []
  key_links: []
  prohibitions:
    - requirement_id: CLAS-07
      category: safety
      status: resolved
      verification: judgment
      statement: "MUST NOT open PR 4b before PR 4a is merged, and MUST NOT merge, approve or push to main from the execution session."
---

<objective>
Close PR 4b (D-49): check PR 4a is on main, rebase keeping only 4b's commits, write the CHANGELOG entry, confirm the docs say what 4b makes live, run the full gate once and open the labels PR, naming the project file format it introduces and the checks that wait for a person.

Purpose: D-34, D-25 (the label map is the first Phase 70 file written into people's projects, so the owner sees its format before release), D-23 and D-27 carried to the owner in words, D-48, D-49, D-53.
Output: PR 4b open from `feat/gate-labels` into `main` with green checks; `70-28b-SUMMARY.md`.
</objective>

<artifacts_produced>
## Artifacts this phase produces

Phase-wide index: 70-01-PLAN.md for plans 01 to 18; part 4's index and requirement map are in COVERAGE.md (replanned 2026-11-17, D-49).

This plan creates no source symbol. It writes the 4b entry under `## Unreleased` in CHANGELOG.md and produces PR 4b (plans 20 and 21) from `feat/gate-labels` into `main`, with the merged check and the gate record in `70-28b-SUMMARY.md`.
</artifacts_produced>

<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-20-SUMMARY.md
@.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-21-SUMMARY.md
@.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-28a-SUMMARY.md
Read before acting, not as includes: docs/development-workflow.md sections 1 to 4, .github/pull_request_template.md, .claude/commands/review-pr.md; 70-VALIDATION.md "Manual-Only Verifications" and "Part 4 delivery map"; 70-CONTEXT.md D-23, D-25, D-27, D-48, D-49, D-53.

One heavy run at a time. Full suite and e2e with MemoryMax=6G and timeout 1800; e2e under xvfb with the Wayland variables removed; if the e2e launch itself rejects `NODE_OPTIONS`, rerun it once in the same cap without it and record both. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; the PR body ends with the attribution lines the session gives. Plain words, no em-dashes, "your organization" never "NEAR organization", no local machine paths.
</context>

<tasks>

<task type="tracer">
  <name>Task 1: Tracer: PR 4a is on main, PR 4b is rebased onto it with only its own commits, its docs match its code, green and under the budget</name>
  <precondition>PR 4a is merged: `gh pr list --state merged --head feat/gate-route-check --base main --json number,mergeCommit` lists the PR whose number 70-28a-SUMMARY.md records, with a merge commit. If it lists nothing, stop with "PR 4a is not on main yet, so PR 4b was not rebased or opened. Run plan 70-28b again after PR 4a merges." and change nothing.</precondition>
  <files>CHANGELOG.md (and conflict-resolution commits only if the rebase needs them)</files>
  <read_first>.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-20-SUMMARY.md (PR4B_BASE), 70-28a-SUMMARY.md (PR 4a number), CHANGELOG.md (the Unreleased section), SECURITY.md (the policy section's "Labels and clearances in this version" bullet), README.md (the labels paragraph)</read_first>
  <action>
`git fetch origin`, confirm the precondition's merge commit is an ancestor of `origin/main`; if not, stop with the same message and do nothing else. Then `git rebase --onto origin/main <PR4B_BASE> feat/gate-labels`. Resolve `.planning` conflicts by keeping main's text and adding this branch's lines; code conflicts in favour of what main has plus 4b's changes. Write the 4b bullets under `## Unreleased` in CHANGELOG.md (create the section at the top if a release has moved the last one): NEAR AI: Set Label labels a file, a folder or the project, in a signed file that travels with the project; agents cannot read a file above your clearance; NEAR AI: Edit Policy and Apply Policy Draft change your own policy through a signed, recorded draft; labels do not change where content is sent yet. Commit `docs(changelog): part 4b, labels and clearance checks`. Read SECURITY.md, README and Show Policy against the code once more (the three commands, the not-live sentence, the two constants word for word); any mismatch is fixed with a commit and named in the SUMMARY. Compile and run 4b's tests and the parity set, then the commit list and budget checks. Record the PR 4a number, its merge commit, the `origin/main` commit, `git log --oneline origin/main..HEAD`, the diff bytes and the projection after review. Never skip, weaken or delete a test.
  </action>
  <verify>
    <automated>sh -c 'C=$(gh pr list --state merged --head feat/gate-route-check --base main --json mergeCommit --jq ".[0].mergeCommit.oid // empty") && test -n "$C" && git fetch -q origin && git merge-base --is-ancestor "$C" origin/main'</automated>
    <fails_when>non-zero exit: no merged PR from feat/gate-route-check into main, or its merge commit is not on origin/main (the plan must stop here)</fails_when>
    <automated>systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gate*.test.js dist/test/commandEffects.test.js dist/test/autoApproval.test.js dist/test/agentLoop.test.js dist/test/agentTools.test.js dist/test/protectedPaths.test.js dist/test/untrusted.test.js dist/test/teamSignedPayload.test.js dist/test/teamBoundaries.test.js'</automated>
    <fails_when>non-zero exit, or the node --test summary shows "# fail" above 0, "# cancelled" above 0 or "# tests 0"</fails_when>
    <automated>sh -c 'git merge-base --is-ancestor origin/main HEAD && git diff --quiet origin/main...HEAD -- package-lock.json && D=$(git rev-parse --git-path phase70-pr4b.diff) && git diff origin/main...HEAD > "$D" && B=$(wc -c < "$D") && echo "PR diff bytes: $B, projected after review: $((B * 22 / 10))" && test "$B" -lt 950000'</automated>
    <fails_when>non-zero exit: the branch is not on top of origin/main, package-lock.json changed, or the PR diff is 950,000 bytes or more</fails_when>
  </verify>
  <acceptance_criteria>
    - The SUMMARY records the PR 4a number (equal to the one in 70-28a-SUMMARY.md), its merge commit, and that `git merge-base --is-ancestor` exited 0 against `origin/main`.
    - `git log --oneline origin/main..HEAD` lists only plans 20, 21 and this plan's commits (recorded in the SUMMARY).
    - The SUMMARY records the diff bytes (below 950,000) with the projection after review, and the test totals with 0 failed.
    - `grep -c "^## Unreleased" CHANGELOG.md` prints 1 and the section names Set Label.
  </acceptance_criteria>
  <done>PR 4a is confirmed on main without anyone being asked, and 4b stands on main with only its own commits, docs that match, green and under the budget.</done>
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
  <done>4b is green on top of main across the whole gate.</done>
</task>

<task type="auto">
  <name>Task 3: Open PR 4b naming the project file format, the release blocker and the owner's questions, and see CI and the agent review through without merging</name>
  <files>(no source file; fix commits only for CI or review defects)</files>
  <read_first>.github/pull_request_template.md, docs/development-workflow.md (sections 2 to 4), .claude/commands/review-pr.md, .planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-VALIDATION.md (Manual-Only Verifications)</read_first>
  <action>
`git push -u origin feat/gate-labels`, then `gh pr create --base main --head feat/gate-labels` with the title `feat(gate): labels on files and folders, clearance checks on reads, and Edit Policy (Phase 70, part 4b)` and every template section filled in plain words. The body says: what is new for people (Set Label from the Explorer and the Command Palette, Edit Policy and Apply Policy Draft, refusals that say why a read was refused); that labels do not change where content is sent yet, which 4c makes live (D-49); the project file format it first writes (label map v1 at `.planning/.near-ai/labels.json`, signed under the purpose `label-map`, D-25), still cheap to change until a release ships this PR, with an invitation to ask for a change in the review; the D-53 fixes (unknown effects and a broken policy fail closed, an unverified map is only signed again after you confirm, a map that cannot be read holds agent reads, a stale draft changes nothing); that anyone who can read the project can read its labels, compartment names included; that a clearance comes from your own signed policy file, so it is self-declared and not an enforced boundary until verified credentials arrive (D-27); the post-release manual check (your organization's security officer confirms the NATO list and the two Canadian scales before anyone relies on them, D-23); a section "Before publishing a release that contains this PR (D-48)" repeating the owner's pre-publish code-server check, as in 70-28a; the owner's questions: "Is holding every agent read in a project whose label file cannot be read (for example after a merge conflict) the right strictness?" and "Is the label map v1 format right before it reaches people's projects?"; the diff size with its projection; the test totals; the rollback (revert the squash commit; projects keep any `labels.json` written, which the previous build ignores). End with the attribution lines the session gives.

Wait for the required checks with `timeout 3600 gh pr checks --watch`; fix defects with new commits (rerun the affected gate from Task 2 before pushing), rerun infrastructure failures once with `gh run rerun --failed`, and record the agent-review status and every finding with what was done. Never merge, approve, enable auto-merge or push to main.
  </action>
  <verify>
    <automated>sh -c 'S=$(gh pr view feat/gate-labels --json state,baseRefName --jq ".state+\" \"+.baseRefName") && test "$S" = "OPEN main"'</automated>
    <fails_when>non-zero exit: no open PR from feat/gate-labels into main</fails_when>
    <automated>sh -c 'gh pr checks feat/gate-labels --required'</automated>
    <fails_when>non-zero exit, or any required check listed as fail or pending</fails_when>
  </verify>
  <acceptance_criteria>
    - `gh pr view feat/gate-labels --json body --jq .body` contains D-23, D-25, D-27, D-48, D-49 and D-53 and the words "label map" and "labels.json".
    - The SUMMARY records the PR number and URL, every required check as pass, and the agent-review status with each finding and what was done.
    - `gh pr view feat/gate-labels --json state --jq .state` prints `OPEN` (the executor did not merge).
  </acceptance_criteria>
  <done>PR 4b is open into main, green, with its project file format, its release blocker and its questions in front of the owner.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| local branch -> public GitHub | every commit stays public after the squash |
| PR body -> owner's merge | the last cheap moment to change the label map format |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-70-118 | Information disclosure | secrets in 4b's commits | high | mitigate | range secret scan (Task 2) |
| T-70-80 | Repudiation | a project file format released without the owner seeing it | medium | mitigate | the PR body names it with D-25; only the owner merges (Task 3) |
| T-70-119 | Tampering | PR 4b opened while PR 4a is not on main | medium | mitigate | automated merged check stops the plan first (Task 1) |
| T-70-120 | Denial of service | a release with the fail-closed policy file published without the code-server check | high | mitigate | the D-48 check repeated as a release blocker in the PR body (Task 3) |
| T-70-SC | Tampering | npm installs | high | mitigate | No package is added; `package-lock.json` unchanged is a gate (Task 1) |
</threat_model>

<verification>
- The merged check passes before anything changes; the gates exit 0, one heavy run at a time.
- PR 4b is open into main with green required checks; nothing was merged, approved or waited on by the executor.
</verification>

<success_criteria>
- PR 4b reaches review under the budget with main green (D-34, D-49); the label map format, the post-release preset check and the D-48 release blocker are in front of the owner.
</success_criteria>

<output>
Create `.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-28b-SUMMARY.md` when done, with the merged check, the gate record and the PR number.
</output>
