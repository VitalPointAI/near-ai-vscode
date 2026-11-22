---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 12
subsystem: compliance-reference-imports
tags: [oscal, itsp-10-171, baseline-controls, cpcsc, itsg-33]
requires:
  - phase: 44-06
    provides: guarded importer foundation and licence gate
provides:
  - ITSP.10.171 catalogue parsing with assessment objectives and contractor overlay
  - baseline-control and CPCSC Level 1 reference import/check surfaces
  - ITSG-33 Annex 3A identifier parser and authored crosswalk classification
affects: [44-15, 44-16, 44-17]
tech-stack:
  added: []
  patterns: [main-scoped-html-parsing, ids-only-restricted-source-checks, ours-marked-mappings]
key-files:
  created: [compliance/src/import/itsp-10-171.ts, compliance/src/import/baseline-controls.ts, compliance/src/import/cpcsc-level-1.ts, compliance/src/import/itsg-33.ts]
  modified: [compliance/src/import/lib/oscalBuild.ts, compliance/src/import/lib/licence.ts]
decisions:
  - "CPCSC Level 1 retains only the 13 checked ITSP.10.171 identifiers and its source link, never Canada.ca prose."
  - "Baseline-control mappings are authored judgements and mark each row ours."
actuals:
  tokens: 8030
  tasks: 3
  commits: 4
commits: 4
plan_head_before: d6dbdff841f29cd6bc24b47f2d574099c3098cc0
plan_head_after: 8efd0de7f8bb4a0b6e9ef2e8ca696e8df8a59885
duration: 11min
completed: 2026-11-21
status: complete
---

# Phase 44 Plan 12: Reference Sets Summary

**Import-ready Canadian reference sets now cover ITSP.10.171 assessment objectives, baseline controls, the constrained CPCSC Level 1 overlay, and ITSG-33 Annex 3A crosswalk inputs.**

## Accomplishments

- Parsed ITSP.10.171 controls beneath `<main>`, joined each available ITSP.10.171-01 determination as an `assessment-objective`, report unmatched determinations, and supplied the include-all overlay profile.
- Imported five baseline steps and thirteen controls from their headed source form; authored reviewable baseline-to-ITSP.10.033 mappings, the matching Unclassified selections, and the exact 13-ID CPCSC profile/check without retaining restricted Canada.ca text.
- Parsed ITSG-33 Annex 3A identifiers and titles, Profile 3 selections, and classified our crosswalk entries as `same-id`, `added`, `withdrawn`, or `text-changed` with `ours: true`.

The baseline mapping maps incident response planning to `ir-01`, account protection to `ac-02`, backups to `cp-09`, patching to `si-02`, malware controls to `si-03`, secure configuration to `cm-02`, access limitation to `ac-03`, monitoring to `au-02`, network security to `sc-07`, information protection to `si-04`, supplier care to `sa-09`, continuous improvement to `si-05`, and portable media to `mp-02`. One fixture ITSP.10.171 requirement names an ITSP.10.033 source control; one has none.

## Task Commits

1. **Task 1: ITSP.10.171 tracer** — `73a6fcdb`
2. **Task 2: baseline and CPCSC profiles** — `a7ac04f3`
3. **Task 3: ITSG-33 Annex 3A crosswalk inputs** — `8efd0de7`

## Verification

- `npm --prefix compliance run lint`
- `node scripts/run-tests.mjs compliance/test/importItsp171.test.ts compliance/test/importBaseline.test.ts compliance/test/unclassifiedProfiles.test.ts compliance/test/importItsg33.test.ts compliance/test/licenceGate.test.ts compliance/test/oscalValid.test.ts compliance/test/noStatus.test.ts`
- Result: 7 test files passed; 0 failed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected invalid OSCAL source provenance placement**

- **Found during:** Task 1
- **Issue:** The shared catalogue builder put `source-id` in `catalog.props`, which the OSCAL schema rejects.
- **Fix:** Moved provenance to `catalog.metadata.props`, retained legacy licence-gate reading, and added regression coverage.
- **Files modified:** `compliance/src/import/lib/oscalBuild.ts`, `compliance/src/import/lib/licence.ts`, `compliance/test/licenceGate.test.ts`
- **Commit:** `1f2e382f`

## Self-Check: PASSED

- Required importers, profiles, mapping, fixtures, and tests exist.
- Commits `1f2e382f`, `73a6fcdb`, `a7ac04f3`, and `8efd0de7` are ancestors of `HEAD`.
