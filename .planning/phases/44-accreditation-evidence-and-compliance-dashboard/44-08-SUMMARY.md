---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 08
subsystem: compliance-evidence
tags: [typescript, github-api, cyclonedx, grype, npm-audit, codeql]
requires:
  - phase: 44-01
    provides: Collector and observation contracts with freshness windows
  - phase: 44-02
    provides: fixture test runner and dashboard rule evaluation
provides:
  - Redacted audit, SBOM, image-scan, release, attestation, settings, review, and CodeQL observations
  - Injected GitHub REST helper with bounded pagination and permission-safe errors
affects: [44-14-bundle, 44-19-workflows, compliance-dashboard]
actuals:
  tokens: 16651
  tasks: 3
  commits: 3
commits: 3
plan_head_before: 0d81e1dda623f974cbe0abdc30dc8eb822b451c7
plan_head_after: 18ae275e4175eefe29980c9b6617b5466f39c46f
tech-stack:
  added: []
  patterns: [injected-fetch-json, redacted-observation-counts, fixture-only-collectors]
key-files:
  created: [compliance/src/collectors/audit.ts, compliance/src/collectors/sbom.ts, compliance/src/collectors/release.ts, compliance/src/collectors/attestations.ts, compliance/src/collectors/settings.ts, compliance/src/collectors/reviews.ts, compliance/src/collectors/codeScanning.ts]
  modified: [compliance/src/collectors/github.ts]
key-decisions:
  - "Collectors retain only pass/fail, hashes, times, counts, and PR numbers; they never retain API response text, identities, or vulnerability details."
  - "The docs required check is independently observed so G12 remains visible until the owner adds it."
  - "GitHub collection uses an injected HTTPS-only helper and turns 401/403 into permission errors, never passing evidence."
patterns-established:
  - "Collect GitHub facts through githubGet/githubList, with fixture-only fetches in unit tests."
requirements-completed: [ACCR-05, ACCR-12]
coverage:
  - id: D1
    description: Daily npm audit evidence becomes a fresh, stale, or failed dashboard rule result.
    requirement: ACCR-05
    verification:
      - kind: unit
        ref: compliance/test/collectorAudit.test.ts and compliance/test/tracer.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Supply-chain and GitHub evidence is collected as redacted observations from local fixtures.
    requirement: ACCR-12
    verification:
      - kind: unit
        ref: npm --prefix compliance run lint && node scripts/run-tests.mjs collector fixtures
        status: pass
    human_judgment: false
duration: 43min
completed: 2026-11-21
status: complete
---

# Phase 44 Plan 08: GitHub and Supply-Chain Collectors Summary

Fixture-driven collectors turn daily audit, supply-chain, release, GitHub setting, review, and CodeQL facts into redacted observations with the planned freshness windows.

## Performance

- **Duration:** 43 min
- **Tasks:** 3/3
- **Files modified:** 30

## Accomplishments

- Added daily npm audit evidence whose 25-hour lapse evaluates as Stale rather than Met.
- Added CycloneDX, Grype, release-integrity, and provenance-attestation observations.
- Added bounded GitHub pagination plus settings, review-trail, and CodeQL collectors without networked unit tests.

## Task Commits

1. **Task 1: daily npm audit tracer** — `eedfa88f`
2. **Task 2: SBOMs, scan, release and attestations** — `8ef43686`
3. **Task 3: settings, reviews and code scanning** — `18ae275e`

## Collector Endpoints and Windows

- `audit`: local npm audit JSON; `audit` (24 hours).
- `sbom` and `image-scan`: local CycloneDX/Grype JSON; `head`.
- `release`: `/git/ref/tags/{tag}`, `/compare/{sha}...main`, and `/releases/tags/{tag}`; `attestation` (365 days).
- `attestation`: `/attestations/sha256:{digest}`; `attestation`.
- `settings`: branch protection, rulesets, environments, and CODEOWNERS errors; `settings` (7 days).
- `review-trail`: closed PRs, commit status, reviews, and changed files; `settings`.
- `code-scanning`: analyses and open alerts; `head`.

## Decisions Made

- Never serialize response details into observations; only permitted evidence fields survive.
- Keep `docs-required` separate from required-checks so the owner action is visible.

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 1 - Bug] Allowed GitHub compare paths using `...` while retaining traversal rejection**
- **Found during:** Task 2
- **Fix:** Changed the helper to reject `.` and `..` path segments rather than every occurrence of two dots.
- **Verification:** Release fixture tests pass.

2. **[Rule 1 - Bug] Corrected strict TypeScript collector method annotations**
- **Found during:** Task 2
- **Fix:** Added explicit collector input and context types after lint exposed implicit parameters.
- **Verification:** `npm --prefix compliance run lint` passes.

**Total deviations:** 2 auto-fixed (Rule 1).

## Verification

- `npm --prefix compliance run lint` — pass.
- `node scripts/run-tests.mjs compliance/test/collectorAudit.test.ts compliance/test/tracer.test.ts compliance/test/collectorSbom.test.ts compliance/test/collectorRelease.test.ts compliance/test/collectorAttestations.test.ts compliance/test/collectorSettings.test.ts compliance/test/collectorReviews.test.ts compliance/test/collectorCodeScanning.test.ts` — 8 files passed, 0 failed.

## Next Phase Readiness

Plan 44-14 can bundle every collector result; Plan 44-19 can wire their scheduled and main-only inputs.

## Self-Check: PASSED

- All seven collector modules, fixture tests, and all three task commits exist on this branch.
- Acceptance greps passed: one audit collector export, an attestation digest endpoint, `docs-required`, and `REVIEW_ACCOUNT` references.
