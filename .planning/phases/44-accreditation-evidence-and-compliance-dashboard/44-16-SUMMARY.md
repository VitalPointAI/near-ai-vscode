---
phase: 44
plan: 16
subsystem: compliance catalogue data
tags: [oscal, provenance, canada, nist, reproducibility]
status: complete
provides:
  - Approved OSCAL catalogue data and importer reports
  - Deterministic source provenance and NOTICE generation
affects: [44-17, 44-18, 44-19]
tech-stack:
  added: []
  patterns: [daily-stable-provenance, official-source-cross-check]
key-files:
  created: [compliance/catalogs/itsp-10-033/catalog.json, compliance/sources.json, compliance/catalogs/NOTICE]
  modified: [compliance/src/commands/sources.ts, compliance/src/crossCheck.ts]
decisions:
  - Owner approved public commit of licence-checked catalogue data on 2026-11-21.
  - NIST OSCAL content v1.6.0 / SP 800-53 Rev. 5.2.0 is the accepted baseline.
  - French Medium-profile parsing limitation remains G14; English is authoritative.
metrics:
  completed_date: 2026-11-21
  tasks: 4
  commits: 29
  plan_head_before: ddeb9b38d489582dff8baca2a7f67b3ddb57a62a
  plan_head_after: 9e0f380960dbacab61100fe03571ae69f36253f2
actuals:
  tokens: 2302168
  tasks: 4
  commits: 29
---

# Phase 44 Plan 16: Catalogue Data Summary

Approved, reproducible OSCAL catalogue data covers Canadian Cyber Centre, NIST, controlled-goods, and ITAR/EAR sources with provenance and cross-check reports.

## Completed Work

- Re-read all 11 Open Canada CKAN licence records; each remained `ca-ogl-lgo`.
- Imported ITSP.10.033 (20 groups, 271 controls and 59 activities), NIST Rev. 5.2.0, ITSP.10.171, baseline controls, ITSG-33, CPCSC, CGP, and ITAR/EAR.
- Added deterministic daily provenance timestamps, `sources.json`, NOTICE generation, source hashing, and a catalogue-data gate.
- Cross-checked actual AWS Samples and CISO Assistant conversions; the checker now supports CISO's framework-nested layout.
- Rebuilt independently: all outputs except intentionally time-varying import reports are byte-identical.

## Verification

- 15 focused compliance tests passed, including catalogue-data, licence, no-status, OSCAL, importer, cross-check, fetch, and source-manifest coverage.
- `node compliance/src/cli.ts validate --root compliance` passed.
- `npm run lint --prefix compliance` passed.
- Full deterministic comparison passed. `sources.json` SHA-256: `4ac98cf16c7414da43db12add8b5276fd546e2d56eb47f651350f20a712e500c`.

## Owner Approval

On 2026-11-21 the owner approved public commit of the licence-checked data, NIST v1.6.0 / Rev. 5.2.0, the French G14 limitation and ITSG historical drift, and retaining the five cited-page 404s without substitution.

## Deviations from Plan

### Auto-fixed Issues

1. [Rule 1 - Bug] Supported the published CISO Assistant nested framework export and ignored non-assessable family headings.
2. [Rule 1 - Bug] Stabilized CGP and ITAR daily provenance timestamps so the second rebuild is byte-identical.
3. [Rule 2 - Critical functionality] Added the source snapshot and NOTICE producer required by the plan's provenance artifacts.

## Known Source Retrieval Caveats

Five non-imported cited Cyber Centre pages return 404 and are explicitly recorded in `sources.json`; no replacement was substituted. The imported Annex/Profile and all required catalogue sources were retrieved successfully.

## Self-Check: PASSED

Required catalogue files exist and all 29 plan commits are ancestors of the final data commit.
