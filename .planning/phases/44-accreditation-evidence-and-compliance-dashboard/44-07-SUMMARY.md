---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 07
subsystem: compliance-evidence
tags: [typescript, node-test, ci, secret-scan, documentation, crypto-inventory]
requires:
  - phase: 44-01
    provides: compliance model, collector contracts, and evidence rule types
  - phase: 44-02
    provides: per-test NDJSON reporter and secret-scan JSON output
  - phase: 44-03
    provides: required security documents and crypto inventory contract
provides:
  - mapped-test target validation with distinct missing, renamed, skipped, todo, failed, and unrun reasons
  - local collectors for test reports, CI needs results, secret scans, required documents, and crypto inventory rows
affects: [44-14, 44-18, 44-19, compliance-bundle]
tech-stack:
  added: []
  patterns: [counts-only observations, fixture-backed local collectors, exact required-document heading checks]
key-files:
  created:
    - compliance/src/collectors/tests.ts
    - compliance/src/collectors/ci.ts
    - compliance/src/collectors/secretScan.ts
    - compliance/src/collectors/documents.ts
    - compliance/src/collectors/crypto.ts
  modified:
    - compliance/src/rules.ts
key-decisions:
  - "Mapped test names must be quoted source literals; runtime-built names cannot be safely mapped."
  - "Collector observations retain only IDs, counts, timestamps, commits, run addresses, and pass/fail states."
  - "Documents use a UTC review-date instant and exact level-two headings; the development workflow needs no review date."
patterns-established:
  - "Collector modules receive file reads and clock values through CollectorContext for hermetic fixture tests."
  - "Untrusted CI/report input is parsed strictly and malformed data becomes a failing result or explicit collector error."
requirements-completed: [ACCR-04, ACCR-05]
actuals:
  tokens: 17424
  tasks: 3
  commits: 3
plan_head_before: 0d81e1dda623f974cbe0abdc30dc8eb822b451c7
plan_head_after: 0c0ee5c4be4b1934439f1b503f0ab2fa798cf0b0
coverage:
  - id: D1
    description: Mapped tests report a distinct failing reason for missing files or names, skipped, todo, failed, and unrun tests.
    requirement: ACCR-04
    verification:
      - kind: unit
        ref: compliance/test/evidenceRules.test.ts
        status: pass
      - kind: unit
        ref: compliance/test/collectorTests.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: CI, secret-scan, document, and crypto evidence collectors emit compact local observations.
    requirement: ACCR-05
    verification:
      - kind: unit
        ref: compliance/test/collectorCi.test.ts, compliance/test/collectorSecretScan.test.ts, compliance/test/collectorDocuments.test.ts, compliance/test/collectorCrypto.test.ts
        status: pass
    human_judgment: false
duration: 52min
completed: 2026-11-21
status: complete
---

# Phase 44 Plan 07: Local Collectors Summary

**Mapped-test validation and five local collectors now produce compact, source-free compliance evidence for CI, scans, documents, and crypto inventory.**

## Performance

- **Duration:** 52 min
- **Completed:** 2026-11-21
- **Tasks:** 3/3
- **Files modified:** 22
- **Verification:** compliance lint and 51 focused tests passed.

## Accomplishments

- Added checkout-backed mapped-test validation, distinguishing missing files and names from skipped, todo, failed, and unrun report rows.
- Added counts-only test-report, CI-needs, and secret-scan collectors that do not retain outputs, logs, test names, or finding details in observations.
- Added required-document and crypto-inventory collectors with review-date, exact-heading, and per-row standing validation.

## Task Commits

1. **Task 1: Tracer: mapped test report and target reasons** - `86da4668` (feat)
2. **Task 2: CI job results and secret scan summary** - `6c1dba82` (feat)
3. **Task 3: Required documents and crypto inventory rows** - `0c0ee5c4` (feat)

## Files Created/Modified

- `compliance/src/rules.ts` - Adds cached checkout target checks before per-test report evaluation.
- `compliance/src/collectors/tests.ts` - Parses bounded NDJSON test reports and creates per-package count observations.
- `compliance/src/collectors/ci.ts` and `secretScan.ts` - Convert trusted CI needs and scan JSON into minimal observations.
- `compliance/src/collectors/documents.ts` and `crypto.ts` - Validate required documents and crypto inventory standings.
- `compliance/test/collector*.test.ts` - Fixture-backed contract coverage for all collectors.

## Decisions Made

- A test name must occur as a whole quoted literal (single, double, or non-interpolated template string) in its mapped source; dynamically composed names are intentionally unmappable and must not appear in evidence rules.
- `not listed` crypto rows remain observations but fail their rule; the collector does not hide an inventory row because its standing is unfavorable.
- A document reviewed exactly 365 days earlier retains its review timestamp; evidence freshness is then assessed by the document window.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Stabilized real-runner fixture regeneration inside Node test workers**
- **Found during:** Task 1
- **Issue:** The fixture generator's nested `scripts/run-tests.mjs` inherited Node's test-worker context, so its requested NDJSON report destination was never initialized.
- **Fix:** Isolated nested-runner temporary variables and removed `NODE_TEST_CONTEXT` when invoking the fixture generator from its verification test.
- **Files modified:** `compliance/test/fixtures/collectors/tests/make-report.mjs`, `compliance/test/collectorTests.test.ts`
- **Verification:** The real runner regenerates byte-identical `root.ndjson` and `relay.ndjson`; the complete focused suite passes.
- **Committed in:** `86da4668`

**Total deviations:** 1 auto-fixed (1 Rule 1 bug)

## Issues Encountered

The plan's `systemd-run --user` wrapper cannot connect to a user scope bus in this execution environment. The identical bounded lint/test command was rerun directly with `timeout 300` and passed; no verification was skipped.

## Known Stubs

None. The `todo` fixture rows are intentional negative cases proving the `test-todo` reason, not unwired application data.

## Threat Flags

None. The new collectors read only injected local report or checkout files and add no network or authentication surface.

## Next Phase Readiness

Phase 44 evidence rules can now consume subjects `tests/<package>`, `ci/<job>`, `secret-scan/<mode>`, `documents/<path>`, and `crypto/<algorithm-id>`. Plan 44-18 can wire its evidence rules to these collector subjects.

## Self-Check: PASSED

- All five collector modules and their fixture tests exist in the worktree.
- Task commits `86da4668`, `6c1dba82`, and `0c0ee5c4` are ancestors of `HEAD`.
- The full Plan 44-07 focused verification passed: compliance lint plus 51 tests, 0 failures.

---
*Phase: 44-accreditation-evidence-and-compliance-dashboard*
*Plan: 07*
*Completed: 2026-11-21*
