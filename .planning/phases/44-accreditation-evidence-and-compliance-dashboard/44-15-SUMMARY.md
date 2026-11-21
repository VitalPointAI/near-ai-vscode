---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 15
subsystem: documentation
tags: [docusaurus, react, compliance, evidence, loopback]
requires:
  - phase: 44-03
    provides: accreditation dashboard consumer contract
  - phase: 44-05
    provides: dashboard and organization-overlay fixtures
provides:
  - Accreditation docs routes and data-driven evidence views
  - Hash-verified local dashboard refresh and private loopback overlay
  - Build isolation checker and optional refresh timer templates
affects: [docs-site, accreditation, compliance]
tech-stack:
  added: []
  patterns: [browser-fetched dashboard, manifest-before-write refresh, loopback-only private overlay]
key-files:
  created: [docs-site/scripts/compliance-refresh.mjs, docs-site/src/components/accreditation/LevelPage.jsx, docs-site/scripts/check-build-isolation.mjs]
  modified: [docs-site/scripts/serve.mjs, docs-site/sidebars.js, docs-site/package.json]
key-decisions:
  - "Public pages fetch and parse the dashboard in BrowserOnly, preserving an honest empty state."
  - "Private overlays are read only by the loopback server after host, type, size, count, symlink, and path checks."
requirements-completed: [ACCR-07, ACCR-08, ACCR-11, ACCR-13]
actuals:
  tokens: 12920
  tasks: 4
  commits: 6
commits: 6
plan_head_before: d6dbdff841f29cd6bc24b47f2d574099c3098cc0
plan_head_after: 13676a2f8708ec47b290d2c582057aa5a2880cdd
duration: 13 min
completed: 2026-11-21
status: complete
coverage:
  - id: D1
    description: Verified manifest refresh into static and live build directories
    requirement: ACCR-07
    verification:
      - kind: unit
        ref: docs-site/test/refresh.test.mjs
        status: pass
    human_judgment: false
  - id: D2
    description: Accreditation routes, page copy, filters, drawers, evidence and matrix UI
    requirement: ACCR-08
    verification:
      - kind: unit
        ref: docs-site/test/pages.test.mjs
        status: pass
      - kind: other
        ref: npm run docs:build
        status: pass
    human_judgment: true
    rationale: Keyboard and theme behavior need visual review in a browser.
  - id: D3
    description: Private loopback organization overlay and build isolation
    requirement: ACCR-13
    verification:
      - kind: integration
        ref: docs-site/test/serveOverlay.test.mjs
        status: pass
      - kind: other
        ref: docs-site/scripts/check-build-isolation.mjs
        status: pass
    human_judgment: false
---

# Phase 44 Plan 15: Accreditation Docs Summary

**A twelve-route, dashboard-driven Accreditation documentation section with manifest-verified refresh and a bounded local organization overlay.**

## Performance

- **Duration:** 13 min
- **Completed:** 2026-11-21T20:39:15Z
- **Tasks:** 4/4
- **Files modified:** 37

## Accomplishments

- Added the Accreditation sidebar category, twelve MDX routes, six-state cards, filters, accessible control details, gaps, evidence, package provenance, and CSV matrix download.
- Added `compliance:refresh`, which checks an exact SHA-256 manifest before atomically publishing dashboard data to static and an existing build directory; daily bundles plainly record attestation `none`.
- Added a loopback-only, no-store overlay endpoint with DNS-rebinding Host protection, read-only JSON bounds, and a production-build leakage checker.

## Task Commits

1. **Task 1: Refresh tracer and Protected B page** — `ad708c0a`
2. **Task 2: Level, overlay, filter and control-detail pages** — `276a557a`
3. **Task 3: Gaps, matrix, evidence, package and README** — `b47f50a7`
4. **Task 4 RED: Overlay endpoint tests** — `c18305de`
5. **Task 4 GREEN: Local overlay endpoint and timer** — `ec2871f3`
6. **Task 4 follow-up: Absent static directory handling** — `13676a2f`

## Verification

- `node scripts/run-tests.mjs docs-site/test/refresh.test.mjs docs-site/test/pages.test.mjs docs-site/test/serveOverlay.test.mjs docs-site/test/lib.test.mjs` — 45 passed, 0 failed.
- `npm run docs:build` under the documented 4 GiB systemd scope — passed; generated `build/accreditation/protected-b/index.html`.
- `node docs-site/scripts/check-build-isolation.mjs --markers compliance/test/fixtures/overlay/markers.txt --dir docs-site/build --dir docs-site/static` — `Build isolation check passed: no private overlay markers found.`
- This host’s refresh implementation records a release attestation as `not-checked` and asks for a newer `gh` when `gh attestation` is unavailable; daily/merge bundles deliberately record `none` after manifest verification.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Isolation check now accepts an absent static directory as empty**
- **Found during:** Task 4 final verification
- **Issue:** The prescribed isolation command failed in this checkout because `docs-site/static/` is optional and absent.
- **Fix:** Skip directories that do not exist while still recursively scanning every supplied directory that does.
- **Files modified:** `docs-site/scripts/check-build-isolation.mjs`
- **Verification:** The prescribed build/static isolation invocation passed.
- **Committed in:** `13676a2f`

**Total deviations:** 1 auto-fixed (Rule 1).

## User Setup Required

An owner may set `NEAR_AI_COMPLIANCE_OVERLAY_DIR` (or create the git-ignored `.compliance-overlay`) and may review then run `npm run refresh-timer:install`. Neither is required for the public documentation build.

## Next Phase Readiness

The docs routes consume the dashboard and overlay contracts from the preceding compliance work. Manual browser review remains useful for keyboard flow and the light, dark, and high-contrast themes.

## Self-Check: PASSED

- All task commits are ancestors of `HEAD`.
- `docs-site/scripts/compliance-refresh.mjs`, `docs-site/src/components/accreditation/LevelPage.jsx`, and `docs-site/scripts/check-build-isolation.mjs` exist.
