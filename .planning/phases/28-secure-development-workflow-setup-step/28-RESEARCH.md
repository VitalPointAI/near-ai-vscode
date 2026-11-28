# Phase 28 secure development workflow setup research

<user_constraints>

## User Constraints (from CONTEXT.md)

### Approved scope

The [roadmap](../../ROADMAP.md#phase-28-secure-development-workflow-setup-step)
and [requirements](../../REQUIREMENTS.md) provide the Phase 28 product brief. This phase
adds an optional, reopenable step to the software Project Setup path. The DevOps member
prepares a reviewable pull-request workflow kit for the selected project. CI, independent
review and an owner-approved release are the downstream result when the owner has enabled
the required repository settings.

Repository files and remote settings are separate. The step previews local changes before
applying them to the selected project. It adds missing kit files, preserves custom files by
default, and presents actual differences for conflicts. The owner carries out branch
protection, deployment environment and credential setup. The step checks actual remote state
afterward and reports unknown or missing requirements. This phase does not grant authority
to change repository settings, approve a review or release, handle tokens, or run a live trial
on this repository.

### Baseline on main

SovAI already runs its own CI, independent review and release workflows from
`.github/workflows/`. The software profile includes a DevOps member with workflow guidance.
The registered Project Setup steps on `5bfeba0af` do not yet provide a guided workflow
export for another project or verify the target repository's protections.

### Planning interpretation

Use the existing Project Setup presentation, existing DevOps role and published workflow
patterns where they fit. Preserve the current default theme. Expose the distinct states for
unstarted, skipped, reviewable proposal, locally applied, awaiting owner setup and verified.
Preview and application depend on the selected project's current files. Verification depends
on the selected repository and its current rules. Surface a stale proposal, different repository
or inaccessible remote as a recoverable state. Narrow the first implementation to one concrete
supported project profile, then cover the complete requirements on that path. The research and
plans will identify that profile and the evidence for extending support.

The planning worktree starts at `5bfeba0af`. The existing merge order and owner checkpoints
apply to any later code or live acceptance.

</user_constraints>

**Researched:** 2026-11-26. **Domain:** Project Setup and GitHub repository workflow provisioning.
**Confidence:** High for the SovAI reuse points. Medium for platform availability because
the target repository's plan, organization policy and credentials are only observable at setup.

## Summary

Build a project-scoped, deterministic kit planner with separate inspect, preview, apply and
verify operations. The existing DevOps member prepares a proposal and explains results.
Give the setup path typed operations at the local host boundary. Generic team tools and
arbitrary command generation add no capability needed by this step. The owner places approved
files on a branch or opens the PR, applies remote configuration, and performs the initial
review bootstrap outside the wizard.

Use GitHub.com with one initially supported package profile inferred from a checked-in
`package.json`, an npm lockfile and real declared test/build scripts, subject to an explicit
profile check and preview. This is a planning recommendation, not a platform requirement or a
claim that every software project uses npm. A repository with competing lockfiles, a missing
test script, another repository host, custom publishing or unsupported protection options gets
a precise unmet item. Later adapters supply their own deterministic inputs and acceptance.
GitHub's starter workflows provide useful language-specific build examples. SovAI's versioned
kit supplies the independent reviewer, source verification and owner gates those examples
do not provide as a complete package. [GitHub starter workflows](https://github.com/actions/starter-workflows) · [Node action and lockfile options](https://github.com/actions/setup-node)

## Architectural Responsibility Map

| Capability | Primary owner | Boundary |
| --- | --- | --- |
| Find the relevant setup step and show progress | Extension Project Setup and existing DevOps team member | Local UI passes a selected project, displays inspect and review results, and can skip or reopen. |
| Discover project profile and propose deterministic files | Local kit planner | Project metadata and a bound GitHub repository are typed inputs. Templates are reviewed product assets, and repository files provide data. |
| Apply exact approved changes and reflect drift | Local workspace host | Bind preview to project identity, kit version, target file preconditions and approved bytes. Recheck before writing. |
| Apply branch rules, environment rules, reviewer identity and credentials | Repository owner | Human runs the reviewed exact administrative steps with credentials already under their control. |
| Confirm effective remote protections | Local read-only adapter | Selected repository, current default ref and fixed metadata reads. Missing visibility is unknown. |
| Run the installed checks and publish releases | Target GitHub repository | CI tests proposed bytes with minimal permissions. A separate reviewer evaluates the same head. Publication consumes an approved, verified artifact. |

<phase_requirements>

## Phase Requirements

| ID | Requirement | Planning implication |
| --- | --- | --- |
| DEVF-01 | Optional, reopenable software Project Setup step carried out by DevOps | One typed project-scoped path and independently observable completion. |
| DEVF-02 | Adapt CI, separate reviewer and owner gates, merge, tag, release and bootstrap | Profile-specific templates and a shared merge/review verification contract. Install files locally and cover bootstrap as a distinct handoff. |
| DEVF-03 | People alone run remote settings and credentials steps. Report remaining items | Human-only commands, typed readback, explicit unsupported and unknown results, no credential values. |
| DEVF-04 | Repeat safely and show differences before overwriting | File comparisons and bound approvals, one writer for a project, repeat-safe application and clear conflict recovery. |

</phase_requirements>

## Project Constraints (from AGENTS.md)

The inherited project directions require separate worktrees for independent work, tests first,
focused tests throughout and one complete applicable check at the phase boundary. Reuse
existing infrastructure. Guard trust-boundary changes immediately. Keep owner approval and
merge ordering in the existing workflow. Never handle the protected signing or NEAR key
stores. Keep future tests and administrative acceptance isolated from active owner services.
Source: inherited owner directions and the handover in the primary checkout.

## Standard Stack and reuse points

Use the existing extension host, TypeScript, Node built-ins and the repository's existing
test runner. No new runtime package is necessary for the planning recommendation. Generate
source-controlled templates from typed, validated inputs. Extend other project profiles
through tested adapters instead of accepting executable text from the setup UI.

| Existing source | Exact reference anchors and reuse |
| --- | --- |
| Project Setup lifecycle | [VERIFIED: src/services/setupSteps.ts:29-42,103-130,159-180] `SetupStep`, `isAvailable`, `isDone`, `registerSetupStep`, `registerSetupFacts`, `buildSetupMenu`. Register the new step and keep done items reopenable. An availability exception defaults to visible, so absent evidence must deliberately return false for non-software projects. |
| Project selection | [VERIFIED: src/services/setupMenu.ts:9-44,69-74] `nearAi.projectSetup`, `showSetupMenu`, `registerProjectSetup`. The menu guards a moved project while prompting. The new controller must hold an immutable root through preview, apply and verify rather than relying on the old one-prompt check. |
| Existing software profile | [VERIFIED: src/agent/projectTypes.ts:127-147,314-323] `id: 'software'`, `name: 'devops'`, `role: 'devops'`, `path.join(root, '.planning', '.near-ai', 'project.json')`. Read the persisted project type plus the chosen profile. The role's existing `'Bash'` and `'SecurityScan'` tools do not have to be used by the guided capability. |
| Portable CI pattern | [VERIFIED: .github/workflows/ci.yml:5-40] `name: CI`, `pull_request:`, `contents: read`, `persist-credentials: false`, `npm ci --ignore-scripts`. Retain job names from a single kit record shared by the generated workflows and verification. Export only actual checks supported by the selected profile. |
| Secret-scan behavior | [VERIFIED: scripts/secret-scan.mjs:1-22] `--range A..B`, `--json`. Preserve masked findings and scan tracked content and the relevant addition history. Check the scanner's helper imports, expected configuration and semantics before shipping it as an export. |
| Check-source proof | [VERIFIED: scripts/lib/workflow.mjs:4-27,334-361] `CI_CHECKS`, `AGENT_REVIEW_CONTEXT = 'agent-review'`, `REVIEW_ACCOUNT = 'near-ai-reviewer'`, `evaluateCommit`. Reuse the verification semantics. The source names and identities are SovAI data and must come from the exported profile for a target repository. |
| Separate reviewer workflow | [VERIFIED: .github/workflows/agent-review.yml:28-67,107-138] `workflow_run:`, `workflow_dispatch:`, `ref: ${{ github.event.repository.default_branch }}`, `persist-credentials: false`, `EXPECTED_HEAD`. Review PR data with trusted default-branch code and recheck exact PR head before any approval. |
| Initial handoff | [VERIFIED: scripts/bootstrap-agent-review.mjs:1-25,29-59] `scripts/bootstrap-agent-review.mjs`, `--approve-gates`. The in-repo script describes the default-branch bootstrap circularity. Test and document an owner-controlled, isolated bootstrap that runs reviewed kit code. The wizard does not run the bootstrap, retrieve its inputs or settle the first PR. |
| Release inputs | [VERIFIED: scripts/prepare-release.mjs:18-36,38-47] `'package.json'`, `'package-lock.json'`, `'CHANGELOG.md'`, `'--no-git-tag-version'`. This helper is specifically npm. Keep equivalent version, default-branch commit and notes checks in the npm adapter. [VERIFIED: .github/workflows/release.yml:550-569] `name: container-release` is SovAI-specific. Preserve separation of build and approval-gated publication while selecting a target-appropriate artifact and environment. |
| Remote reader and fixture seam | [VERIFIED: scripts/lib/gh.mjs:16-41,63-74] `setRunner`, `ghJson`, `protectedContexts`. Prefer injected fixed read calls. The helper's existing 404-to-empty semantics are insufficient for proving whether all target protections are effective. |
| Owner configuration | [VERIFIED: docs/development-workflow.md:599-645] `agent-review-gates`, `container-release`, `can_admins_bypass`, `allow_force_pushes`. Reuse intent and prove prerequisites. The literal repository, reviewer identities, CI list, environment names and provider settings in this file are SovAI-specific. Remote commands must preserve any additional protections. |

## Architecture Patterns

1. **Inspect, preview, apply, verify.** Inspect resolves one project root, one profile and an
   explicit repository identity. Preview emits a fixed file list, hashes and real differences.
   A missing file is addable, matching bytes need no action and differing bytes are retained
   pending a path-specific decision. A preview is invalid when the selected project, remote,
   kit version or relevant bytes change. An interrupted apply can retry using the recorded
   applied subset. Many-files writes require preflight, race checks and truthful partial
   reporting. Use established atomic per-file writes or a dedicated branch.
2. **Preserve source boundaries.** Resolve paths beneath the chosen project and require that
   each target and parent directory remains in that project after symlink checks. Keep writes
   to a closed manifest and review actual bytes. An existing file with the same name, an
   equivalent custom workflow under a different name, an ambiguous remote, and a project path
   selected while another proposal was open each need an explicit resolution.
3. **Verify the intended source.** CI uses stable job names, PR coverage and read-only
   privileges, including fork-safe test execution. A privileged follow-up reads PR metadata and
   diffs from trusted code. It does not run PR code, install PR dependencies or load PR outputs
   as executable inputs. Pin reviewed external actions by full SHA. Review identity must differ
   from the authoring identity, and both review and approval must be scoped to the same head.
   [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use) · [Workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
4. **Separate release approval from build.** Build from a verified default-branch release
   commit, retain exact artifact and digest, and protect the publishing job by an owner-set
   environment. Restrict who can create, move or delete release tags and prevent unauthorized
   alternate publish paths. A configured environment name alone proves neither protected
   reviewers nor valid publication eligibility. Detect required-reviewer plan/visibility
   limits and admin bypass. Prevent self-review where the approved operating model supports
   different initiator and approver identities. [GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) · [Release rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
5. **Read effective state.** Start with exact repository identity and canonical default branch.
   Verify enabled classic protection and applicable active rulesets, source-pinned required
   checks and relevant bypass entries, tag restrictions, deployment environments, reviewer
   identities and secret-name presence for the configured kit. Confirm trusted template revision
   in the remote default branch and check evidence from the selected workflow and exact
   revision. A denied request, ambiguous 404 or entirely unobservable settings are not
   completion evidence. Secret listing establishes only presence by name. Credential usability
   and trusted source identity come from terminal workflow evidence of the approved reviewer.
   [Protected branches](https://docs.github.com/en/rest/branches/branch-protection) · [Rulesets](https://docs.github.com/en/rest/repos/rules) · [Environments](https://docs.github.com/en/rest/deployments/environments) · [Secret metadata](https://docs.github.com/en/rest/actions/secrets)
6. **Keep remote changes human.** Show owner instructions and the actual required changes for
   the selected host/repository/ref, including assertions that local approval has no remote
   effect. For existing settings use a read-modify-review contract that preserves unrelated
   requirements. Avoid a blanket branch-protection replacement, generic shell, hidden GitHub
   write, token display or auto-run copy/paste. The owner enters secrets into GitHub's own UI or
   interactive CLI. App-side readback uses an approved existing session with bounded
   argument-vector GET operations, sanitized outputs and no auth-prompt fallback. A read adapter
   should select GET explicitly since adding fields to `gh api` can change the method.
   [GitHub CLI API manual](https://cli.github.com/manual/gh_api) · [Secrets in Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets?tool=cli)

## Don't Hand-Roll

| Need | Reuse |
| --- | --- |
| Setup menu and profile routing | Existing Project Setup registry and persisted project metadata. |
| Model-powered independent review | Existing trusted-runner review contract and its fixture-tested verification. Keep model output within the existing verdict/evidence boundary. |
| Hosted enforcement | GitHub rulesets, required checks and deployment environments. One profile-level verification contract for Phase 28 and later merge-train integration. |
| App-side secrets and remote credentials | Existing approved CLI authentication and GitHub native secret configuration. Setup persists no credential data. |
| Generic project-pipeline inference | One explicit profile contract, fixture-backed templates and a missing-profile result. GitHub starter workflows are a comparison, not downloaded executable content. |

## Common Pitfalls

- A kit on local disk or a reviewed PR is different from verified installed protection. Recheck
  the canonical remote and default ref on reopen. Baseline unknown, missing, awaiting approval
  and verified should have distinct outcomes.
- Traditional protections and inherited rulesets can coexist. A green unrelated job with a
  duplicate name, inactive rules, or a privileged identity that can certify its own work is
  insufficient evidence. Include a stable verified source and the expected reviewer/head.
- The initial reviewer workflow itself needs trusted bootstrap prior to normal protected operation.
  A plan should reserve this separate fixture or approved human trial and explain the supported
  sequencing without bypassing the guard.
- Required CI checks need a real execution result. An unrecognized project or unavailable
  dependency audit does not yield a green placeholder, skipped protection or fake test.
- The npm preparation helper presumes package files and version metadata. Keep its assumptions
  inside the npm profile. Only present publishing commands and artifact conventions that fit that
  profile and the configured review.
- Applying a later preview must not overwrite an unrelated workflow or older selected project's
  files. Give the user the exact difference and a new preview when a precondition changes.
- If an owner can only verify options manually, state the specific unknown and what they can
  inspect. Failed remote reads must not trigger web login, token collection or writes.

## Validation Architecture

Start with existing `node:test` tests and recording adapters. Use the shared repository cap
for verification. Add only assertions proving a changed behavior or trust boundary.

| Requirement | Evidence | Suggested run |
| --- | --- | --- |
| DEVF-01 | Optional and reopenable flow from software project setup, with distinct locally applied and verified states. Covers target change. | Existing setup menu tests plus compact controller test. |
| DEVF-02 | Generated template fixtures exercise locked tests, scan, audit, exact-head reviewer, merge/release policy and bootstrap workflow order. | Existing workflow unit and file tests with controlled export fixtures. |
| DEVF-03 | Recording remote adapter shows only typed reads. Bad response, unsupported visibility, missing roles, incomplete settings, and secret metadata cause accurate results. | Mock GitHub facts and later owner-approved disposable-repository trial for live settings and actual protection. |
| DEVF-04 | Missing, unchanged, differing and raced-file cases. Repeat a partial apply and confirm it completes the permitted subset without deleting unrelated files. | Temp-directory integration with byte comparison and bound previews. |

The planner should name exact files and commands. For existing surfaces, the current conventions
are `npm run compile`, `node scripts/run-tests.mjs dist/test/setupSteps.test.js`, and
`node scripts/run-tests.mjs scripts/test/workflow.test.mjs scripts/test/workflow-files.test.mjs`.
Verify release and docs only where their checked inputs change. No GitHub mutation or privileged
workflow execution should occur in fixture tests.

## Security Domain

| Concern | Mitigation |
| --- | --- |
| Authentication, session and access control | Reuse the approved existing host session for fixed reads. Verify canonical target and expected reviewer identity. Remote writes, setting changes and approvals remain human-controlled. |
| Input validation | Closed profile and path contracts, strict repository/ref and response validation, argv-only calls, display findings as data. |
| Integrity | Compare exact proposal and applied bytes. Bind review to the tested head and trusted source. Retain hash and provenance from build through publication. |
| Confidentiality | No raw credential handling. Suppress untrusted errors and raw payloads from the UI. Secret metadata is never taken as value or proof of permission. |
| Partial writes and concurrency | Recheck preconditions, preserve custom files, report completed subset and allow safe repeat. Separate protected publication and initial fixture acceptance from routine setup. |

## Environment Availability

| Dependency | Observation | Use |
| --- | --- | --- |
| Node | Local `node --version` returned `v24.22.3`. | Use the repository's pinned runtime when executing each surface. |
| GitHub CLI | Local `gh --version` returned `2.105.0`. | Recording adapters exercise validated GET contracts. No authenticated target or administrative request was made in research. |
| GitHub environment and tag settings | Capability and effective policy are target-specific. | Require the planned owner-controlled acceptance before declaring product deployment verified. |

## Assumptions and open questions

- [ASSUMED] GitHub.com with a locked npm package and existing test/build scripts is a useful
  first supported profile. Confirm this at implementation planning and hold unsupported package,
  registry and non-GitHub profiles as explicit outcomes. It grants no approval to publish any
  existing repository's artifacts.
- The target repository's available plan, permissions, official reviewer identity, model consent
  and initial protected bootstrap have no live evidence. Use synthetic facts for automation
  and the applicable owner checkpoint for real acceptance.
- Split implementation into a tested core kit and evidence path, then attach the software
  setup UX and DevOps review. Keep complete DEVF-01–04 acceptance visible across waves.

## Sources and metadata

The GitHub product and CLI references are primary documentation read for this phase
on 2026-11-26. The repository paths were inspected at `5bfeba0af`. Review platform
capability details again when implementing the first profile.

- [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
- [Protected branch requirements](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [Required environment reviewers and deployment policy](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [GitHub-maintained starter workflow source](https://github.com/actions/starter-workflows)
