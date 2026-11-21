---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 06
subsystem: compliance-importer
tags: [oscal, licence-gate, parse5, yaml, source-watch]
requires:
  - phase: 44-01
    provides: compliance package and OSCAL validation foundation
provides:
  - licensed source registry, guarded catalogue writer, and licence re-check command
  - host-bound polite fetcher and normalized Cyber Centre page hashes
  - shared HTML, OSCAL, notice, import-dispatch, and watch helpers
affects: [44-08, 44-09, 44-10, 44-16]
actuals:
  tokens: 12432
  tasks: 3
  commits: 3
tech-stack:
  added: [parse5 7.3.0, yaml 2.9.1]
  patterns: [licence gate before catalogue writes, injected network edges, normalized-main hashing]
key-files:
  created: [compliance/src/import/lib/licence.ts, compliance/src/import/lib/sourceRegistry.ts, compliance/src/import/lib/cyberHtml.ts]
  modified: [compliance/package.json, compliance/src/cli.ts]
key-decisions:
  - "Owner approved parse5@7.3.0 and yaml@2.9.1 on 2026-11-21 before installation."
  - "Catalogue prose is refused unless its source is text-authorized by the registry."
requirements-completed: [ACCR-01, ACCR-02, ACCR-13]
commits: 3
plan_head_before: 0d81e1dda623f974cbe0abdc30dc8eb822b451c7
plan_head_after: 4d595bff
duration: 36min
completed: 2026-11-21
status: complete
---

# Phase 44 Plan 06: Governed importer foundation Summary

**A licence-gated OSCAL importer foundation with source provenance, safe fetching, normalized change detection, and reusable Cyber Centre parsing helpers.**

## Accomplishments

- Added the full researched source registry, text-licence invariant, catalogue scan, and CKAN licence re-check command.
- Added fixed-host HTTPS fetching with redirect, timeout, cap, and rate-limit protections.
- Installed owner-approved parser dependencies and added shared HTML, hash, notice, OSCAL, watch, and importer-dispatch utilities.

## Task Commits

1. **Task 1: importer foundation tracer** — `ff3c3747`
2. **Task 2: package review checkpoint** — owner approved exact pins on 2026-11-21; no code commit.
3. **Task 3: parsers, hashes, watch, and NOTICE** — `07524240`, `4d595bff`

## Verification

- `npm --prefix compliance ci --ignore-scripts`
- `npm --prefix compliance run lint`
- 26 focused compliance tests passed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Made the guarded import dispatcher load future source importers**

- **Found during:** Task 3
- **Fix:** Replaced the placeholder command return with constrained dynamic source dispatch that always writes through the licence gate.
- **Commit:** `4d595bff`

The plan's systemd resource wrapper could not access the sandbox's user bus, so the identical timeout, memory-cap, lint, and focused-test command ran directly. This was infrastructure-only; verification passed.

## Self-Check: PASSED

- Required source and test files exist.
- All three task commits are ancestors of `HEAD`.

## Next Phase Readiness

Wave 3 importers can use the registry, fetcher, writer, page helpers, normalized hashes, notices, and guarded command dispatch.
