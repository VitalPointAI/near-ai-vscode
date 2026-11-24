# Codex takeover marker

- **Taken over:** 2026-11-21T13:35:07-05:00
- **Local checkout:** `/home/aaron/projects/codequity/near-ai-vscode`
- **Local branch / HEAD:** `main` at `c1dba334`
- **Observed tracking branch:** `origin/main` at `932f73c9` (`main` was 26 commits behind and 0 ahead)
- **Requested starting action:** `$gsd-progress`

## Baseline before Codex changes

Codex made no implementation, planning-state, Git, worktree, branch, dependency, or test changes before writing this marker. The only write made at takeover is this file.

The main checkout was already dirty (16 paths). In particular, `.gitignore` and `.planning/config.json` were modified, and several planning, research, PDF, and temporary files were untracked. These pre-existing changes belong to the user or earlier agents.

Git registered 74 worktrees. Nine were dirty, including the main checkout. Phase 44 work was visibly active immediately before takeover: commits were created between 13:15 and 13:28 local time, and these worktrees retained uncommitted files:

- `.claude/worktrees/feat-phase-44-04-status-rules`
- `.claude/worktrees/feat-phase-44-05-dashboard-words`
- `.claude/worktrees/feat-phase-44-07-collectors-local`
- `.claude/worktrees/feat-phase-44-08-collectors-github`

Codex treats every pre-existing worktree as owned by the earlier Claude workflow. Do not infer that Codex merged, cleaned, pruned, rebased, switched, or reused any of them.

## GSD snapshot at takeover

- Milestone reported by local planning files: `v0.5.0 Governed agent platform`.
- `roadmap.analyze`: 55 plans and 55 summaries; Phases 68–70 implementation-executed; Phase 71 next.
- Canonical verification routing: Phase 68 `stale`, Phase 69 `stale`, Phase 70 `missing`.
- `STATE.md` still reported `status: executing`, Phase 70, and was last updated 2026-11-18.
- The default `$gsd-progress` route therefore pointed to `$gsd-execute-phase 68` to refresh verification, but Codex did **not** invoke it because the local checkout is behind and Phase 44 worktrees are in flight.
- Verification debt: 4 current-milestone human-UAT items and 8 archived human-UAT items.
- Windows ledger: 11 open, 0 waived.
- Existing `.planning/HANDOFF.json`: `activeAgents: 0`, `pendingApprovals: 4`, created 2026-11-13. It was not modified.

## Safety boundary for continuation

Before doing implementation work, reconcile the still-active Phase 44 worktrees and decide whether the local `main` should be advanced to the observed `origin/main`. Preserve all dirty files and worktrees until their owners or purpose are known.

Future Codex work and verification notes should be appended below this line so Claude can review from this baseline.

## Codex work after takeover

### Phase 44 recovery and Wave 2 completion — 2026-11-21

- Confirmed the earlier Claude workers were no longer running; no live process, open handle, or operation lock was found. Their worktrees and branches were preserved.
- Resumed the partial Phase 44 plans in their existing worktrees and completed plans 44-04 through 44-09 without cleaning, resetting, rebasing, or deleting the inherited work.
- The owner approved `parse5@7.3.0`, `yaml@2.9.1`, `oscal-cli@3.2.0`, `Syft@1.57.2`, `Grype@0.122.1`, and the latest researched Compliance Trestle release, `5.2.1`.
- Merged completed plans 44-04 through 44-09 into the existing Phase 44 integration worktree at `.claude/worktrees/feat-phase-44-compliance`.
- Verified the combined Wave 2 result: compliance lint passed, all 234 compliance tests passed, and the docs-site test passed. One initial test failure was caused by the sandbox refusing a child process; the same suite passed when run with the required permission.
- Updated only the Phase 44 progress entries in `.planning/ROADMAP.md` to show plans 44-01 through 44-09 complete. An automated helper attempted to recalculate global `.planning/STATE.md` totals incorrectly because Phase 44 is parallel work; that change was caught and fully restored before committing.
- Phase 44 integration HEAD after Wave 2 tracking is `d6dbdff841f29cd6bc24b47f2d574099c3098cc0` on `feat/phase-44-compliance`.

### Wave 3 started — 2026-11-21

- Started plans 44-10, 44-11, and 44-12 in three new GSD-managed isolated worktrees based on the tested integration HEAD above.
- Worktrees: `.claude/worktrees/agent-p44-10-codex`, `.claude/worktrees/agent-p44-11-codex`, and `.claude/worktrees/agent-p44-12-codex`.
- Their branches are `worktree-agent-p44-10-codex`, `worktree-agent-p44-11-codex`, and `worktree-agent-p44-12-codex`.
- No inherited Claude worktree has been removed. The remaining Wave 3 plans (44-13 through 44-15) will start after these three finish, using the available parallel-agent capacity.

### Wave 3 completed and Wave 4 started — 2026-11-21

- Completed and merged plans 44-10 through 44-15 into the Phase 44 integration branch. The roadmap now records 15/19 plans complete.
- Added three narrowly tested shared corrections discovered by the parallel work: schema-valid OSCAL source provenance, recursive licence checks for grouped controls, and the exact OSCAL-required mapping provenance lifecycle field while retaining the project-wide status-field ban elsewhere.
- Resolved one merge overlap by retaining every registered CLI command from plans 44-11 and 44-14.
- Added and tested `cgp` and `itar` import-command aliases plus their report persistence on the integration branch, because plan 44-13 was intentionally based before plan 44-10's newer generic dispatcher.
- Combined verification after Wave 3: compliance lint passed; all 361 compliance tests passed; all 45 docs-site tests passed; the production docs build passed; the private-overlay build isolation check passed; dependency audits reported zero vulnerabilities.
- Phase 44 integration HEAD after Wave 3 tracking is `ddeb9b38d489582dff8baca2a7f67b3ddb57a62a` on `feat/phase-44-compliance`.
- Started plan 44-16 in `.claude/worktrees/agent-p44-16-codex` and plan 44-17 in `.claude/worktrees/agent-p44-17-codex`, both from that tested integration HEAD. Plan 44-16 must stop for the required owner licence/source confirmation before importing live catalogue data; plan 44-17 is autonomous.

### Wave 4 completed and Wave 5 started — 2026-11-21

- The owner approved the Phase 44 live-data checkpoint: public commit of licence-checked data; NIST v1.6.0 / Rev. 5.2.0; the French G14 limitation and ITSG historical drift; and explicit retention of five retired cited-page 404s.
- Completed and merged plans 44-16 and 44-17. The roadmap now records 17/19 plans complete.
- Plan 44-16 required live-source compatibility fixes for current Cyber Centre, PSPC, Justice Laws and eCFR pages. Every correction is separately committed and regression-tested; the importer remains fail-closed on missing controls, unexpected IDs, cross-host redirects and invalid OSCAL.
- Two independent live builds were byte-identical outside allowed import-report timing fields. Final accepted data includes 330 ITSP.10.033 top-level items, 151 Medium-profile rows, 131 ITSP.10.171 controls, 13 exact CPCSC IDs, 242 ITSG Annex entries, 179 current Profile 3 selections, 22 CGP requirements, and 14 ITAR/EAR requirements.
- The real AWS/CISO comparison is recorded in `compliance/import-reports/cross-check.json`; no fixture comparison was substituted.
- Plan 44-17's release-package machinery was merged with final real-content resolution explicitly deferred until plan 44-18 adds component statements/evidence rules.
- Combined Wave 4 integration verification: compliance TypeScript lint passed and all 411 compliance tests passed.
- Started plan 44-18 in `.claude/worktrees/agent-p44-18-codex` from integration HEAD `39cfac3981275f743d989b5e46f51bb16db57649`.

### Wave 5 completed and Wave 6 started — 2026-11-21

- Completed and merged plan 44-18, including the compiled-test leaf reporter correction, component definitions, responsibility defaults, evidence rules, and the three explicitly unsettled export-control overlay rows.
- Combined integration verification passed: compliance TypeScript lint and all 423 compliance tests. The nested-process collector test initially failed only because the restricted sandbox denied its child process; the same test passed 7/7 and the full suite passed outside that restriction.
- The roadmap now records 18/19 plans complete. Phase 44 integration HEAD after that tracking commit is `d2f628202bd87258523ae8d2ad3ad6793cced587` on `feat/phase-44-compliance`.
- Started final plan 44-19 in the GSD-managed isolated worktree `.claude/worktrees/agent-p44-19-codex`, branch `worktree-agent-p44-19-codex`, from the tested integration HEAD above.
- Plan 44-19 owns the workflow, release-gate, CodeQL, CODEOWNERS, scheduled-evidence, and profile-resolution changes. Its executor was instructed to stop at the mandatory owner-only GitHub settings checkpoint; no repository settings will be claimed complete without the owner's explicit response.

## Claude review and owner decisions — 2026-11-23

Claude reviewed #154–#159 and the local branches. Owner decisions from that session:

- **Sterling branding is intended.** Keep Sterling and SovAI names in the Theia edition.
- **No more Marketplace publishing.** Releases ship as a versioned Theia container image (GHCR, by digest, linked from the GitHub release). Codex's `feat/sterling-container-publish` is the right direction; Claude will review it when it is pushed. Do not ask the owner for `marketplace` environment approvals.
- **Phases 32.1 and 33 are re-aimed at Theia first.** Shared engine work stays; user-facing surfaces go to the Theia workbench before (or instead of) VS Code webviews. Claude is preparing a plan-by-plan re-aim for both phases. Pause new VS Code-only UI work on 32.1 and 33 until it lands; engine work can continue.

Open PRs from Claude (please do not duplicate):
- #160 `fix/compliance-review-docs-required`: dashboard no longer shows Met while an in-scope component is silent; release collector peels annotated tags and checks checksums via asset digests; your `fix/weekly-oscal-compliance` commits cherry-picked; compliance trust roots (`compliance/src/`, `components/`, `evidence-rules/`, `responsibility/`, `profiles/`, `levels.json`) are gate paths; `docs` added to `CI_CHECKS`; SA&A reader accepts GNU long names; phase numbers removed from the export.
- #161 `fix/codeql-triage`: two ReDoS fixes (untrusted page reader, usage footer), `crypto.randomUUID` for gate-record ids, single-quoted GSD node shim. The other 53 CodeQL alerts are false positives or test-only (reasons in the PR).

Release 0.4.37 (#159) is on hold until #160 and #161 merge; it should go out through the container release workflow.

### Update — owner decisions later on 2026-11-23 (supersede the 32.1/33 line above)

- **32.1 and 33 are built natively in Theia now**, not through the VSIX compatibility layer: a native Get Started guide widget that draws the existing 32.1 screen models (it is what "Set up Sterling" opens on the Sterling Get Started page; the checklist becomes a section of that page; no VS Code walkthrough), and native Staff Room, presence and Monaco co-editing for 33. Engine code under `src/domain`, `src/staff/replica` and the setup controller stays host-neutral and keeps going.
- **Scale target: hundreds to thousands of concurrent users, connected and disconnected sites.** Secrets move to an OS-keyring sidecar or the organization's KMS (working offline too); setup checks use policy-listed model servers.
- Claude is researching multi-user hosting (per-user Theia sessions, sign-in, KMS) before re-planning both phases. Hold new UI work on 32.1 and 33 until that plan lands; engine plans (33-03, 33-05..33-09, 33-18; 32.1-12 apply) can continue.

### Update — merged later on 2026-11-23

- #161 (CodeQL fixes) and #164 (compliance fit check) are merged. **`node scripts/resource-check.mjs` now runs in the required `lint` job:** any new direct npm dependency (root, relay, hub, docs-site, compliance), production base image, GitHub Action (pinned to a SHA) or vendored library needs a reviewed entry in `compliance/resources.json` (a gate file) or CI fails. Your GHCR release workflow's new actions and the Theia image's base image will need entries; Debian/Alpine bases are `pass-with-conditions` at best (no validated crypto at Protected B; UBI 9 FIPS is the plan in #163).
- `docs` is a required check on main.
- #162 has a review comment: bind the image to 127.0.0.1 by default, reword MIGRATION.md (native Theia, Sterling), prune dev dependencies. Hardening goes to Phase (a) in the #163 design.
- Owner decisions also recorded in #163: no generic "project" inside a work area (each work area has its own landing and kinds of work; "project" is capability development only) and one **Defence Team** mode for the Defence edition (not Military vs Public service). Please align the Sterling work-area pages ("Create a project" etc.) with that.

## Claude takes over from Codex — 2026-11-23

The owner asked Claude to take over Codex's work. From this point Claude owns every Codex branch and worktree listed in this file and in `git branch`. Codex should not write to this repository again unless the owner hands work back.

Takeover steps, in order:
1. The owner stops Codex.
2. Claude snapshots each dirty Codex worktree with a WIP commit on its own branch (nothing discarded, nothing rebased), then pushes the unpushed Codex branches to `origin` so they are backed up.
3. Claude finishes in this order: #162 fixes and merge; the GHCR container release workflow (`feat/sterling-container-publish` + its test and runbook branches) as one gate PR, with its actions registered in `compliance/resources.json`; release 0.4.37 as the first container release; the next Theia review PRs (`feat/theia-sterling-welcome-review`, `feat/theia-sterling-reference-review`) folded into Phase 46; Phase 32.1 and 33 engine work carried into their native-Theia re-plans; Phase 44.1 and the Phase 33.1 plan after that.

## Codex handover — final state

Handover on 2026-11-23, America/Toronto. Claude owns continuation. Codex stopped implementation and saved unfinished work in branch-local `wip:` commits. The branch index below records the refs included in the backup. Local `main` remains at `c1dba334`. The observed remote `main` at handover was `f1c562d4`.

### Owner decisions in force

- Phases 32.1 and 33 ship natively in Theia. Reuse host-neutral setup, domain and replica code. The 32.1 guide and checklist belong in Get Started. Phase 33 uses native Staff Room, presence and Monaco collaboration. Follow the hosting and native re-plans in merged #163 and Phases 46–48. The product needs per-user sessions and credential storage suitable for connected and disconnected sites.
- Release versioned Sterling Theia images through GHCR, by digest, with GitHub release notes and artifacts. Marketplace publication is retired.
- The required CI lint job runs `node scripts/resource-check.mjs` after #164. Review and register covered new dependencies, Actions and base images in `compliance/resources.json`. That file is a review gate. The `docs` job is also required after #160.
- Work areas have type-specific landing and creation flows. “Project” belongs only in capability development. The Defence edition has one **Defence Team** mode. Review remaining generic creation labels and older mode language before integration.
- SA&A reports only implemented, verified controls. Scope assessor-only official statements to the authorized package and keep public Classified references to IDs and titles. Missing controls or evidence need an owner and delivery path. Track development gaps openly and close them against the actual deployment before accreditation.

### Sterling review and release

- **`feat/theia-foundation-review`, PR [#162](https://github.com/VitalPointAI/near-ai-vscode/pull/162).** Isolated Theia workbench with read-only synthetic Team Studio samples and two VSIX RPC fixes. Docker, Chromium fixture checks, exact-VSIX Setup and Compare Models, both local desktop scenarios (28 checks), and packaging passed. Local unit run had 6,200 passes, eight skips and one path-length failure which passed on short-path retry. Updated head `6fd43f5d` also passed GitHub CI, CodeQL and agent review. The PR became behind again when main advanced. Claude’s [review](https://github.com/VitalPointAI/near-ai-vscode/pull/162#issuecomment-7117731949) is still open. Next, address loopback exposure, Sterling and native-compatibility wording, and runtime dev-dependency pruning, then bring the branch up to date and rerun exact-head checks. Track signing, base-image and licence review, outbound defaults, durable credentials and air-gap needs in Phase 46. Repo auto-deletes the remote feature branch on merge. The previously requested owner consent for that deletion was never received and the stop instruction supersedes the merge request.
- **`feat/theia-sterling-welcome-review` then `feat/theia-sterling-reference-review`.** The first is based on original foundation `5e1846b8`; the second is based on welcome `2046b217`. Integrate in that order after #162 or carry both into Phase 46 as Claude planned. Welcome Docker and Chromium verified both themes and logos, responsive motion controls, tab close and rail/palette reopen, and the Team Studio fixtures. Pinned Theia's own theme picker can error on a filter with no matches. References Docker and Chromium verified 14 allowlisted guides, sidebar navigation, search and anchors, and projected compliance status, filters, warnings, and failure states across six synthetic evidence states. The image contains no evidence by default. Supply only a manifest-verified public projection with `npm --prefix docs-site run compliance:refresh`. Live evidence was not loaded in that verification.
- **`feat/sterling-container-publish`, `test/sterling-container-release`, `docs/sterling-container-runbook`, `docs/theia-container-release`.** These preserve the implementation, workflow tests, release runbook and initial policy note. The implementation builds and smoke-tests an image with the verified VSIX, carries the exact image into GHCR publishing, and links its digest from the GitHub release. A local Docker/archive/startup proof and 20 workflow contract checks passed before the handover snapshots. The test and runbook WIP diffs are already represented in the aggregate implementation, so compare before picking anything. Combine into one gate review after #162. Update the resource register for new Actions and image inputs, align with #164 and the owner’s environment decision, and run the release checks against the current branch. The code still reuses an environment named `marketplace` as a GHCR approval gate, which must be reconciled with the owner’s direction before shipping. No GHCR publish was run. `release/0.4.37` PR [#159](https://github.com/VitalPointAI/near-ai-vscode/pull/159) remains open on hold for the container workflow and readiness. The owner’s earlier conditional approval for #159 was for that earlier release path. Confirm release approval through the current workflow.
- **`feat/theia-team-studio-preview`.** Integration checkout with the working local Sterling UI, Planning redirect correction, native docs/compliance, Staff Center entry, and provisional catalogue and image work. Its `wip:` commit captures the open resource inventory, work-area, asset, acceptance and roadmap changes. The catalogue contains public-source reference data and provisional inferences. It is not an authoritative DND holdings record. Next, reconcile the review slices and naming decisions before pulling this aggregate into the shipping line. A live local container remains on `http://localhost:18878`; it is a prior build, so the backup commit is not proof of what is deployed.
- **Theia follow-up branches.** `fix/theia-credential-parity` packages an opt-in restart proof. Durable production credentials are a Phase 46 dependency. `fix/theia-setup-project-scope` preserves project switch scope and host-neutral proxy advice. `feat/theia-chat-connection-state` records draft reconnect and Stop verification. `feat/theia-defence-work-area`, `feat/theia-portfolio-room`, `feat/theia-work-area-landings`, `feat/theia-work-area-resource-links`, and `feat/theia-resource-inventory` preserve typed work areas, local portfolio display, landing pages, scoped resource links, and reference identity/policy display. Confirm overlaps with the integration checkout and reverify each surfaced flow under the native edition. Production identity, inventory and portfolio feeds remain separate work.

### Phase 32.1, 33, 33.1 and 88

- **Phase 32.1.** The plan is on `docs/phase-32.1-32.2-plan` (#153). Integration is `feat/phase-32.1-get-started`. Branches 06, 16 and 17 hold pinned endpoint approval, discovery, and front-door work. The plan 01 contract and setup-agent branches preserve intermediate models, tests and VSIX adapters. Preserve the underlying setup screens, recommendations, audit chain, residency rules and controller behavior. Implement the native guide and checklist through the Phase 46 re-plan. The existing VSIX-only UI is reference material. Compare ancestor and integration changes before selecting patches. Live setup and native UAT remain pending.
- **Phase 33.** `docs/phase-33-plan` (#151) and `feat/phase-33-live-multi-user` provide the plan and integration base. Small branches preserve the tracer, recovery, verified host access and decision stamps, hub address and compaction, per-workspace status, and attribution, binding and undo experiments. `feat/phase-33-18-wire-pieces` has an explicit WIP with feature negotiation, server wording, test files and a summary. Those final uncommitted changes were captured without a new combined test run. Next, reconcile remaining engine plans 33-03, 33-05 through 33-09 and 33-18, and reuse host-neutral pieces in the native Staff Room and Monaco re-plan under #163. The VS Code adapter is a verification and migration reference. Real multi-user native end-to-end acceptance is pending.
- **Phase 33.1.** The eight-plan signed postings and position workspace package has checkpoints `08bfb4a4` (integration) and `0595fd16` (plan branch). The final `docs/assigned-positions-delivery` WIP preserves the Plan 05 wording and Staff Team design update. `feat/staff-center-workspaces` separately preserves the Planning page and Staff Center entry with the revised artwork and shared design note. Reconcile the overlapping planning text with the native re-plan, then review the signed assignment, identity and audit boundaries before executing the plan. No Phase 33.1 implementation or acceptance is claimed on the basis of these plans.
- **Phase 88.** `9225afe1` contains eight plans in five waves, context and validation for the governed inventory. The plan review passed. The work is backed up through `feat/staff-center-workspaces`, `feat/theia-team-studio-preview` and `docs/assigned-positions-delivery`. Phase 85 and Stage 1 are deployment prerequisites. The live local catalogue is provisional. The governed backend, bulk synchronization and concurrency, audit, identities and asset images still need execution and verification. Reconcile the WIP requirement and roadmap text before starting Phase 88. Refer to the local `docs/specs/knowledge.mp4` and `knowledge 2.mp4` for the ingestion and graph UI direction for Phases 88, 96 and 97.

### Phase 44, 44.1 and SA&A

- **Phase 44.** #154 catalogue work and #155 evidence/dashboard are merged, with #156 carrying same-commit evidence and #160 plus #164 adding follow-up checks. The plan and the 44-01 through 44-19 branches preserve individual work. `worktree-agent-p44-19-codex` includes a WIP GSD config snapshot. Treat source acquisition, assessor and release evidence as separate from claims of accreditation. Start from main when extracting further corrections and retain the original licence, provenance and required-evidence checks.
- **Phase 44.1.** `docs/phase-44.1-accreditation` preserves the roadmap/state WIP and scope through Unclassified, Protected A, Protected B, Classified and adjacent overlays. Detailed closure plans remain TBD. `feat/phase-44.1-collector-inputs`, `fix/phase-44.1-codeowners-evidence`, and `fix/phase-44.1-review-proof` preserve candidate collector changes for publishable inputs, commit-bound CODEOWNERS and verified review proof. Compare with #156 and #160 before applying. Run evidence collection on the assessed exact head and reconcile the resulting POA&M against real deployment artifacts. Missing owner inputs include deployment-specific evidence and assessor validation. No Canadian Centre for Cyber Security data beyond the available sources was promised by the owner.
- **SA&A.** #158 merged the on-demand export and scoped evidence paths. The `feat/saa-*` branches preserve control-family, sponsor and overlay paths. `fix/itsp-flat-control-labels`, `fix/saa-oscal-poam-traceability`, `fix/release-trestle-import` and `fix/weekly-oscal-compliance` preserve corrective work. Compare to main and use only missing fixes. Evidence coverage paths are not completion. The submittable package still needs validated control statements, missing screenshots and other evidence, sponsor decisions and completed administrative entries, architecture visuals and authorized assessor review. Preserve the editable DOCX workflow. Local sponsor drafts, packages and source media under `docs/specs/` remain in the original checkout.

### Checks, scratch files and approvals at stop

- No Codex worker or local test invocation was left running. The disposable foundation, welcome and reference test containers were stopped. The running `sterling-theia-defence` container is the owner’s interactive instance.
- Useful existing commands: `node scripts/merge-pr.mjs 162 --dry-run --no-tag`, `TMPDIR=/dev/shm node --test scripts/test/workflow.test.mjs scripts/test/workflow-files.test.mjs`, `npm run verify:release`, and `docker build -f .planning/spikes/theia-team-studio/Dockerfile .`. The 66 targeted workflow checks passed after the earlier #162 refresh. The host’s shared `/tmp` quota prevented default Xvfb and some tests from starting. Use a short scratch path and an isolated X display for the desktop suite. Github Actions jobs already submitted were left to complete normally.
- The root handover plus roadmap UI reference and the three Codex seed notes are checkpointed on `docs/codex-final-handover`. Older unrelated root edits, reference PDFs, videos, generated SA&A packages, and transient planning JSON were preserved locally. The temporary catalogue generation checkout retains raw extraction/cache files. The integrated and review branches preserve the reviewed catalogue results. The inherited Cyber Harness, Polish, Messaging Relay and Project State Sync worktrees and an untracked dependency link in the daily-evidence checkout were left intact.
- A future merge or release requires the repository's normal CI, independent review, and any relevant owner approval. Existing open PRs and repository settings were left in place.

### Branch heads backed up

The individual commit subject describes the recorded branch checkpoint. For grouped phase work, use the corresponding continuation and outstanding acceptance above. The handover branch's own SHA is recorded by the final Git commit.

| Branch | Head | Recorded checkpoint |
| --- | --- | --- |
| `chore/phase-44-catalogue-review` | `1c79424eb4c1d46bd90a76456feeb69a05763b23` | fix(compliance): correct catalogue fidelity and assessor source data |
| `docs/assigned-positions-delivery` | `5b188718b6036ad56d3bd9ec38f54e4efa4cb0bc` | wip: preserve Phase 33.1 plan clarifications |
| `docs/feature-release-cadence` | `227afea6dd198ee7d94d483ad0a35fed148d5833` | docs: release each completed feature |
| `docs/phase-32.1-32.2-plan` | `7149ea42d009b319a8812c8b930a9a5f30b7ddd5` | docs(32.1, 32.2): record the owner's decisions |
| `docs/phase-33-plan` | `9a5513dd2e1d9b0b2ad29810eda2aa5f4dff4c8d` | docs(33): revise plans for checker warnings |
| `docs/phase-44-plan` | `d695eb3398866d653623ba4288f9b4bfd7df7d97` | Merge remote-tracking branch 'origin/main' into docs/phase-44-plan |
| `docs/phase-44.1-accreditation` | `4373c60d0e8a2b5fe529f60c3e87d2dd316eaf16` | wip: preserve Phase 44.1 accreditation roadmap and state |
| `docs/sterling-container-runbook` | `7dd8da3ea03773b625166e2576ea8bf378ef7979` | wip: preserve the GHCR release runbook |
| `docs/theia-container-release` | `041c9957573adbd000b97a9841a7e8054cc14c32` | docs: record Sterling container release workflow |
| `feat/phase-32.1-06-endpoint-proposal` | `73451637f5663537273919d4c3828ea7df9686e3` | feat(setup): propose pinned approval for found servers |
| `feat/phase-32.1-06-scan-approval` | `d506fadd26ab084a4f5ee24de141810db962bac3` | docs(setup): record Plan 06 fixture acceptance |
| `feat/phase-32.1-16-discovery` | `6a71710adac88cf0bf786e983041a7e8f5cb43b9` | docs(setup): record local discovery acceptance |
| `feat/phase-32.1-17-front-door` | `28de0b891799dc911884a993fff4eb21d13758e5` | fix(setup): clear kept state for the replaced project team |
| `feat/phase-32.1-get-started` | `4743eeb74b43e7a8bbc6dab59b570c5031559345` | feat(setup): isolate Team Studio panels and drafts by project |
| `feat/phase-33-01-tracer` | `70f516257ce15e361f86a39fa5688d716b867435` | docs(33-01): summary of the live tracer plan |
| `feat/phase-33-02-followups` | `110f6034c41dccdb4040293aeae5229929549769` | fix(33-02): verify recovery and report conversion omissions |
| `feat/phase-33-05-host-access` | `f8475c3da247405158f0c16070862c1a171a1cf2` | feat(staff): expose the verified shared replica through its host |
| `feat/phase-33-05-version-acts` | `367a45ec5b46d1e47351dbe01a846e1b190de61b` | feat(staff): capture verified shared decision stamps |
| `feat/phase-33-06-compaction-coverage` | `1ca0cd9c7c3e30bbf2b281d304c7a2a9e4afb745` | feat(staff): prepare sealed compactions from verified snapshots |
| `feat/phase-33-06-compactor` | `71e8f396b20c1901b0b1b82d2159be142fec03c5` | feat(staff): select compaction checkpoints from the verified witness |
| `feat/phase-33-06-hub-address` | `d4f4fbb3fb8cc0c3511e50995c50c86ae12558bf` | feat(staff): store hub addresses per project and device |
| `feat/phase-33-06-snapshot-guard` | `3a587c981688dd2c17d9a138bcc536a8e2d56903` | Guard replica appends against stale store snapshots |
| `feat/phase-33-10-status` | `7f703130b0ed71276a4b19f21bbd1a8b0f13e99b` | feat(staff): publish per-workspace connection status snapshots |
| `feat/phase-33-18-wire-pieces` | `c94b2f2197173ac19d08e0498d6c36584ef863ae` | wip: preserve Phase 33 wire negotiation and tests |
| `feat/phase-33-19-attribution` | `35eb53aad492d3c842fe2fbe1761ea13504cf7d7` | feat(staff): show verified shared text attribution |
| `feat/phase-33-19-binding-adapter` | `9756ede07f381fd4c14cd288b30017ee15a7b347` | feat(staff): trace shared document edits through the VS Code adapter |
| `feat/phase-33-19-history` | `0ee1fe6f9c1b4b6c4d22d19b382f3fb95b0caaff` | feat(staff): scope undo and redo to the active shared editor |
| `feat/phase-33-live-multi-user` | `09b410c62a6598aa3e96c3b1b487ce3a2bcd10d8` | feat(staff): model contested decisions and checkpoint confirmation |
| `feat/phase-44-01-tracer` | `7e10559ece7e6a6f70c4272225dda6bb6dca3905` | docs(44-01): complete the compliance package skeleton and status tracer plan |
| `feat/phase-44-02-test-report` | `8bde34b59825953f6c1f8e5d42f6e30850b08d87` | docs(44-02): complete per-test report, folder secret scan and gate paths plan |
| `feat/phase-44-03-security-docs` | `cd5b8b23bc0c3bf238230f4b856f996adc060488` | docs(44-03): complete the security documents and gap register plan |
| `feat/phase-44-04-status-rules` | `aac935abd19c0ffb28ab173a0b7d8c287ae76ce6` | docs(44-04): complete status rules plan |
| `feat/phase-44-05-dashboard-words` | `2cadbf45084ce1097f95511cddcae3b2f7a271cf` | docs(44-05): complete dashboard contract plan |
| `feat/phase-44-06-importer-core` | `d4f773236cd363aef7dc3185b695c3e2472ff164` | docs(44-06): complete importer foundation plan |
| `feat/phase-44-07-collectors-local` | `3168925611d2a58708b30314763f3ca2425cbade` | docs(44-07): complete local collectors plan |
| `feat/phase-44-08-collectors-github` | `56f5a1822b78951bf9e9081197fcf057f4a23d77` | docs(44-08): complete GitHub collectors plan |
| `feat/phase-44-09-tool-pins` | `8f7b16f2bcef49c3ea2b90f8eab9103c7b7c531a` | docs(44-09): complete CI tool pins plan |
| `feat/phase-44-compliance` | `0ec293f65945cae07492ab0e5cbd8d56ac4db886` | fix(security): parse control and changelog headings literally |
| `feat/phase-44.1-collector-inputs` | `6a55e1119bd95c6c1c9f6d084d4a748dd9cf6fb0` | fix(compliance): collect publishable documentation and crypto evidence |
| `feat/saa-ac-operations` | `28d05b228612b61b13713b436be3faa566925e91` | docs(compliance): complete Protected A access control action paths |
| `feat/saa-cpcsc-paths` | `93e12b1ad06e9254f4dbab93246c982c3ce63c0a` | docs(compliance): assign CPCSC Level 1 contract evidence paths |
| `feat/saa-export-overlay-paths` | `c63a329f1592e5b6a323776002f5054503d33e1b` | docs(compliance): assign overlay evidence paths |
| `feat/saa-ia-governance` | `9283570701e80db26921ece8d9f811d7ca1d8ad9` | docs(compliance): assign remaining Protected A IA evidence paths |
| `feat/saa-itsp-09-13` | `974e03389a7a44595f68d52c8a98b7f513cfd0a1` | docs(compliance): assign supplementary personnel and system evidence |
| `feat/saa-itsp-14-17` | `e90c612b9d21c2729ae7233fcbfaab61b3758a90` | docs(compliance): assign supplementary integrity and supply chain evidence |
| `feat/saa-itsp-171-access-audit` | `99d66b6f086f899493369136ace93d8c345df3f6` | docs(compliance): assign supplementary access training and audit evidence |
| `feat/saa-itsp-ops-paths` | `31886bd90c9d604aea2fb241810c472fc0df6d9c` | docs(compliance): assign supplementary operational evidence paths |
| `feat/saa-on-demand` | `9f77393f3a3b040d3bad6c44eee9720a4016630e` | fix(compliance): save SA&A exports through browser file handles |
| `feat/saa-pe-ps-paths` | `aaf52ccde911ffddbf83419f01e8100a6b9e9ddc` | docs(compliance): assign physical and personnel evidence paths |
| `feat/saa-sa-paths` | `0830e6d84b6743f8a2fe104b93f2487345dadbfc` | docs(compliance): assign acquisition evidence paths |
| `feat/saa-sc-paths` | `e055914b66c668997cd1b4cf7662293f5e0158fe` | docs(compliance): assign communications protection evidence paths |
| `feat/saa-sponsor-ops-paths` | `33b47d73a19840606287b0d5831800df6e6305ec` | docs(compliance): assign sponsor operating evidence paths |
| `feat/saa-sr-paths` | `904863d8d12cac3a9ee6b8f2b44628cb4e3282ca` | docs(compliance): assign supply chain evidence paths |
| `feat/staff-center-workspaces` | `e723a61d7c92bc04c0e1f551b4d657dbe2df439d` | wip: preserve Planning and Staff Center workspaces |
| `feat/sterling-container-publish` | `441c088f3feaba73377639905c983b8a99fde43a` | ci: release Sterling container images through GHCR |
| `feat/theia-chat-connection-state` | `5a04d3d3b006805edd84b5a6e043e55d8c2e2a31` | test(theia): verify Chat Stop with retained test resources |
| `feat/theia-defence-work-area` | `96b05d57113f7d959e7e10f6e7151b2846efc0eb` | feat(setup): add capability development components |
| `feat/theia-foundation-review` | `6fd43f5d404d49624d9804bbf65e71767efc5989` | Merge remote-tracking branch 'origin/main' into feat/theia-foundation-review |
| `feat/theia-portfolio-room` | `c9ae0347423a1df51370e35a37e6a472df5f5d56` | feat(theia): add local DND and CAF Portfolio Room preview |
| `feat/theia-resource-inventory` | `fb70587427736822ac18272ad2139b4080ae4aef` | feat(theia): show reported asset identities and policy references |
| `feat/theia-sterling-reference-review` | `99fd721d9eb84f8c810bf1a01fa46b0c58a1151e` | feat(theia): add native Documentation and Compliance views |
| `feat/theia-sterling-welcome-review` | `2046b217b48cf1a39fbde3fabaab8a8f0db23d27` | feat(theia): open Sterling Canadian Defence Get Started |
| `feat/theia-team-studio-preview` | `b968c8b60f43cbe1ab38493dfc697a05139498ef` | wip: preserve Sterling work areas, inventory and planning state |
| `feat/theia-work-area-landings` | `bc85f6cf71050c33ae688679b066f722073927e9` | feat(theia): link scoped resources to local work areas |
| `feat/theia-work-area-resource-links` | `f946a7286b598ca24a340d519c6d98213fdd367c` | feat(theia): link source-scoped inventory references to work areas |
| `fix/itsp-flat-control-labels` | `8c54fa6440dcb0584dcc8b7a4fce1ea35f7d274b` | Restore ITSP statements with flat bilingual labels |
| `fix/phase-44-daily-evidence` | `49a4533b2c086be9f60cffeb9c08a678cf2e9921` | fix(compliance): validate carried test evidence and provenance |
| `fix/phase-44.1-codeowners-evidence` | `5c970689e489499890964fd5cf4566bf3f388cf0` | fix(compliance): keep CODEOWNERS evidence bound to its commit |
| `fix/phase-44.1-review-proof` | `4af0077e4746abca604ffb29643f7bf4b121b81c` | fix(compliance): verify review of the assessed main merge |
| `fix/release-trestle-import` | `90b1112f1bc8458f29698ad6212c1f93f029fe30` | fix(release): read the full archive listing before Trestle import |
| `fix/saa-oscal-poam-traceability` | `e60b8193869f1251d7f1ae813141b41c2b341711` | fix(compliance): preserve standalone POAM traceability |
| `fix/theia-credential-parity` | `c240e6e2e85819182295e182d5bf841d8f3d0b04` | build(theia): package opt-in credential restart proof |
| `fix/theia-setup-project-scope` | `b24d3d33094772cb531fccbc38106299de6164a0` | fix(setup): use host-neutral proxy advice |
| `fix/weekly-oscal-compliance` | `8d0fd8c64c698fce318d3777131769cd0c1c0c3b` | fix(compliance): validate export-control mapping catalogues |
| `test/sterling-container-release` | `85ff273979c9f7797b339258f20fa448a77c564a` | wip: preserve GHCR release workflow contract checks |
| `worktree-agent-p44-10-codex` | `b32af2487ae352d99521702f8bd1b86b3c5c2450` | docs(44-10): complete ITSP catalogue importer plan |
| `worktree-agent-p44-11-codex` | `167969d68cf5805d2c0576e2f2368a3a41820c07` | docs(44-11): complete Medium profile and cross-check plan |
| `worktree-agent-p44-12-codex` | `1699aeb16271af9c29a3aed608c0a0e7cce08f1c` | docs(44-12): complete reference sets plan |
| `worktree-agent-p44-13-codex` | `2b7a5cca031b44fcfacc05bd10e7a4caad64ce2f` | docs(44-13): complete CGP and ITAR catalogue plan |
| `worktree-agent-p44-14-codex` | `b0d38effc17695545a027551a977df7b01a3b19d` | docs(44-14): complete evidence bundle dashboard plan |
| `worktree-agent-p44-15-codex` | `27465800ba9c301a96d24f1a75bfac94c986591b` | docs(44-15): complete accreditation docs plan |
| `worktree-agent-p44-16-codex` | `ef61f0aed5a4ae8d8c7a7b538d2c0a8a9d796ce7` | docs(44-16): complete catalogue data plan |
| `worktree-agent-p44-17-codex` | `ea288c1de02eaa780cbbe3ab531851212d51307e` | docs(44-17): complete release package plan |
| `worktree-agent-p44-18-codex` | `f065503cf4500d34347e5d871982e2f0d0e036d9` | fix(44-18): type content report parsing |
| `worktree-agent-p44-19-codex` | `16bb136b51d25b114dbaad4867c3a6390b1e6c23` | wip: preserve Phase 44 execution configuration |
| `worktree-agent-phase-32.1-01-contract` | `aa85270d6ebe9a17f60157cfe12a108fdb36f9a7` | docs(32.1): record the verified setup contract handoff |
| `worktree-agent-setup-32.1-02` | `e7964af6493e32fc4ba5093d750fa3e0e736b216` | feat(32.1-02): add guided setup labels and recommendations |
| `worktree-agent-setup-32.1-03` | `d189b64ec17a6ea2ff2655327febf8e2e8d0f7dd` | feat(32.1-03): build setup option cards and landing decisions |
| `worktree-agent-setup-32.1-04` | `c270a8b20f05ed02c12ae2410d7647f0277e047e` | feat(32.1-04): check model server viability |
| `worktree-agent-setup-32.1-05` | `2b4d9ce7df208970aa4c87b2953972139cc68304` | feat(32.1-05): discover announced model servers |
| `worktree-agent-setup-32.1-07` | `2e3496c091b5a057052174978c961321615185e9` | feat(32.1-07): record guided setup in a local audit chain |
| `worktree-agent-setup-32.1-08` | `82127cdd40c59d95c0b15e0591daa89173fa8a31` | feat(32.1-08): extend the shared webview and accessibility kit |
| `worktree-agent-setup-32.1-09` | `547fd8520cfe04b67a808b6d64b36733db9b8c0d` | feat(32.1-09): streamline staff and project setup prompts |
| `worktree-agent-setup-32.1-10` | `19d2c2a3f1f151c797cb8f7367daa6b8df899ad5` | feat(32.1-10): preserve and enforce project residency settings |
| `worktree-agent-setup-32.1-11` | `e4413d3e001a3b6602fe751f6b13192fa6f5a652` | feat(32.1-11): add setup navigation and change previews |
| `worktree-agent-setup-32.1-14` | `872f55a30d6da29d62d93dfde141af8b38ad548a` | feat(32.1-14): build the Get Started webview |
| `worktree-agent-setup-32.1-15` | `845bd4b447976447c496bd4992fdd5e07fe81a93` | feat(32.1-15): wire setup steps and role landing |
