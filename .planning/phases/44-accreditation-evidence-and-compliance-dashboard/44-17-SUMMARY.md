---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 17
subsystem: compliance-evidence
tags: [oscal, release-package, sha256, pr-summary]
requires:
  - phase: 44-14
    provides: verifiable evidence bundles and dashboard rows
  - phase: 44-15
    provides: docs-site bundle verifier
provides:
  - release documentation package builder with OSCAL drafts and SHA256SUMS
  - pull request state-transition summary with an opt-in failure switch
affects: [44-18, 44-19, release-workflow]
tech-stack:
  added: []
  patterns: [fixture-first OSCAL package generation, state-transition-only PR reporting]
key-files:
  created: [compliance/src/package.ts, compliance/src/oscalSsp.ts, compliance/src/oscalAssessment.ts, compliance/src/oscalPoam.ts, compliance/src/prSummary.ts]
  modified: [compliance/src/cli.ts, compliance/src/readable.ts]
key-decisions:
  - "The builder consumes real component definitions when integrated but uses fixture-level inputs in this plan."
  - "PR summaries compare only state transitions; fail-on-drop remains opt-in."
requirements-completed: [ACCR-09, ACCR-10, ACCR-11]
actuals:
  tokens: 9446
  tasks: 3
  commits: 3
commits: 3
plan_head_before: ddeb9b38d489582dff8baca2a7f67b3ddb57a62a
plan_head_after: fe9bd65f469a33c28f3f431228502a22214a468e
duration: 28min
completed: 2026-11-21
status: complete
coverage:
  - id: D1
    description: Schema-validated fixture OSCAL package with readable assessor artifacts and SHA256SUMS.
    requirement: ACCR-09
    verification:
      - kind: unit
        ref: compliance/test/package.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Bundle manifest parity between the producer and docs-site verifier.
    requirement: ACCR-11
    verification:
      - kind: integration
        ref: compliance/test/refreshParity.test.ts
        status: pass
    human_judgment: false
  - id: D3
    description: Pull-request control-state transition summary and opt-in drop failure behavior.
    requirement: ACCR-10
    verification:
      - kind: unit
        ref: compliance/test/prSummary.test.ts
        status: pass
    human_judgment: false
---

# Phase 44 Plan 17: Release Package and PR Summary Summary

**Fixture-validated OSCAL release-package drafts with tamper checks and focused PR control-state summaries.**

## Accomplishments

- Added `package`, which generates SSP drafts, an assessment plan and results, POA&M, readable artifacts, a redacted evidence copy, README, and deterministic SHA256SUMS.
- Added schema-valid OSCAL builders and fixtures, with producer/consumer evidence-bundle parity coverage.
- Added `pr-summary --fail-on-drop`, which reports only changed control states and remains non-blocking unless the explicit flag is supplied.

## Task Commits

1. Task 1 — `eb116bb0` — SSP package tracer, checksums, and verifier parity.
2. Task 2 — `5638eb82` — assessment plan/results, POA&M, and readable package artifacts.
3. Task 3 — `fe9bd65f` — pull-request transition summary and opt-in drop failure.

## Verification

- Passed: 10 package tests, 7 PR-summary tests, 4 SSP tests, and 2 docs-site/bundle parity tests.
- Passed: generated package `SHA256SUMS` validation.
- Passed: pinned oscal-cli 3.2.0 download SHA-256 verification and POA&M validation.
- Deferred: oscal-cli validation of the fixture SSP and assessment documents cannot resolve their profile/catalogue references until the real level profile/catalogue content from Plans 44-16 and 44-18 is integrated. No production component, evidence-rule, profile, or catalogue content was invented here.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking dependency] Used fixture-level package generation while content plans remain parallel.**
- **Found during:** Task 2 external OSCAL validation.
- **Issue:** Real profiles, catalogues, components, and evidence rules are absent from this worktree and owned by Plans 44-16 and 44-18.
- **Fix:** Kept the builder ready to load `compliance/components` when it exists, generated only fixture-level documents, and deferred reference-resolution validation to the integration boundary.
- **Files modified:** package and fixture/test files only.
- **Verification:** AJV schema validation, focused tests, SHA256SUMS, and the pinned CLI POA&M validation passed.

## Issues Encountered

- The complete compliance TypeScript lint remains unavailable in this isolated worktree because its pre-existing `yaml` dependency is absent; focused runtime tests were used instead.

## Next Phase Readiness

Plan 44-19 can invoke the package command after Plans 44-16 and 44-18 land, then run the deferred pinned oscal-cli validation against real profiles and catalogues.

## Self-Check: PASSED

- All 19 declared implementation and fixture files exist.
- Task commits `eb116bb0`, `5638eb82`, and `fe9bd65f` are ancestors of HEAD.
