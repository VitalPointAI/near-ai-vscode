---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 19
subsystem: compliance CI and release
status: complete
one_liner: "CI collects compliance evidence and release workflows validate and attest the assessment package, with owner setup recorded separately."
requires:
  - phase: 44
    provides: Compliance catalogue, evidence bundle, and release package tooling from plans 02, 09, and 14–18
provides:
  - Pull request, daily, and weekly evidence workflows
  - Release package validation and attestation
  - CODEOWNERS review routing and operator instructions
key-files:
  created: [.github/workflows/compliance-scheduled.yml, .github/workflows/codeql.yml, .github/CODEOWNERS, compliance/src/commands/resolve-check.ts]
  modified: [.github/workflows/ci.yml, .github/workflows/release.yml, scripts/test/workflow-files.test.mjs, compliance/README.md]
metrics:
  completed_date: 2026-11-22
  commits: 5
  plan_head_before: d2f628202bd87258523ae8d2ad3ad6793cced587
  plan_head_after: 2064f6441e5bf87f6a2a12d8138297ad5f956ecf
actuals:
  tokens: 13011
  tasks: 4
  commits: 5
---

# Phase 44 Plan 19: Compliance workflows and release gates

The CI compliance job has contents and actions read access. The relay image scan has contents read access. Scheduled daily evidence has contents, actions, pull requests, statuses, security events, and attestations read access. Weekly source and OSCAL jobs inherit contents read access. CodeQL has contents read and security events write access.

The release package job has contents and actions read access. The attestation job has contents read, OIDC token write, and attestations write access. The Trestle job has contents read access. CODEOWNERS routes reviews to the repository owner.

New action pins are setup-java `d1374f8ac74474200d16ef8ecee22c7ae7a51880`, setup-python `6d4fd22b20465ccc0f7354476588e8df7c9ca0e0`, CodeQL `1bd86f2fdb4b86187fa4059f16f31a3202acc9ea`, and attest `1e69f48acb82d1966a394da916b4c1698aa569d6`.

## Local verification

The plan's focused workflow, merge, resolution, lint, and acceptance checks passed. The user systemd bus was unavailable, so the focused checks ran with bounded process limits instead. Commits `4246dfec` and `2064f644` add regression coverage for comparing OSCAL control IDs only and keeping scheduled scan findings report-only.

## Owner checkpoint and live evidence

On 2026-11-22 the owner asked the executor to do what it could and report the remaining owner actions. This is recorded as the plan's deferred response. No owner action was confirmed complete. The steps remain listed in `compliance/README.md`.

The integration PR's first CI run, the protected gate approval, and the first release's package, attestation, and Trestle results remain pending. Phase completion and its verification verdict are tracked separately from this plan summary.

## Self-Check: PASSED

The four declared new files are present and all five plan commits are reachable from the plan branch.
