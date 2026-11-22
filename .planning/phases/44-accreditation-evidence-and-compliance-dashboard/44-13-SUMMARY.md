---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 13
subsystem: compliance
tags: [oscal, controlled-goods, itar, ear, ecfr, mappings]
requires:
  - phase: 44-04
    provides: status rules and unsettled-question vocabulary
  - phase: 44-06
    provides: source import, licensing, and OSCAL validation infrastructure
provides:
  - CGP and ITAR/EAR requirement importer contracts with source notices and reports
  - Authored OSCAL mappings with open legal questions and official-signature flags
  - Controlled-goods and ITAR overlay profiles
affects: [44-15, compliance dashboard, import command integration]
actuals:
  tokens: 22382
  tasks: 3
  commits: 11
commits: 11
plan_head_before: 5ad59aed08acefb9883ffea7d122de2cfdcaf9b0
plan_head_after: 8823384062b331e42029eec8e6b5f657bfb98130
tech-stack:
  added: []
  patterns: [parse5 structural paragraph selection, versioned eCFR fixture imports, source mapping flags]
key-files:
  created: [compliance/src/import/cgp.ts, compliance/src/import/itar.ts, compliance/mappings/cgp-to-itsp10033.json, compliance/mappings/itar-to-sp80053.json]
  modified: [compliance/src/import/lib/licence.ts, compliance/src/validate.ts]
key-decisions:
  - "CGP paragraphs and eCFR XML paragraphs are selected by identifiers and markers, never offsets."
  - "TEE and third-party encrypted storage remain explicit unsettled mapping rows; official person and endpoint decisions carry signature flags."
  - "The no-status guard permits only schema-required mapping provenance lifecycle status at its exact OSCAL path."
requirements-completed: [ACCR-13, ACCR-14]
coverage:
  - id: D1
    description: CGP, ITAR, and EAR importers preserve source notices, eCFR dates, selected requirement text, and report contracts.
    requirement: ACCR-13
    verification:
      - kind: unit
        ref: compliance/test/importCgp.test.ts and compliance/test/importItar.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: OSCAL mappings and overlays include all source requirements with constrained unsettled and official-signature flags.
    requirement: ACCR-14
    verification:
      - kind: unit
        ref: compliance/test/overlayMappings.test.ts
        status: pass
      - kind: unit
        ref: compliance/test/oscalValid.test.ts and compliance/test/noStatus.test.ts
        status: pass
    human_judgment: false
duration: 17 min
completed: 2026-11-21
status: complete
---

# Phase 44 Plan 13: CGP and ITAR Requirement Catalogues Summary

**Controlled-goods and ITAR/EAR requirement import contracts, OSCAL overlays, and authored control mappings with unresolved export questions kept visibly non-final.**

## Performance

- **Duration:** 17 min
- **Started:** 2026-11-21T20:23:29Z
- **Completed:** 2026-11-21T20:40:27Z
- **Tasks:** 3/3
- **Files modified:** 22

## Accomplishments

- Added structural `parse5` importers for the DPA, Controlled Goods Regulations, ITAR, and EAR fixtures. CGP contains 22 requirements; ITAR/EAR contains 14, with title-specific eCFR as-of dates.
- Added result contracts for `catalogs/cgp/catalog.json`, `catalogs/itar/catalog.json`, and their report destinations. CGP reports its excluded section 37(3) definition; ITAR reports Title 15 and 22 dates.
- Added valid include-all CGP/ITAR profiles and complete authored mappings to ITSP.10.033 and SP 800-53. The four unsettled cases and five official-signature cases are test-pinned.

## Task Commits

1. **Task 1: CGP tracer** — `7a363945` (RED), `349cdb70` (GREEN)
2. **Task 2: CGP, ITAR, and EAR catalogues** — `83222745` (RED), `64470f3c` (GREEN), `8c58d478` (coverage), `88233840` (report contracts)
3. **Task 3: mappings and ITAR profile** — `ec14a057` (RED), `368015ed` (GREEN)
4. **Security/standards corrections** — `27040143` / `f91ac23a` (grouped licence gate), `abfb8339` (mapping provenance status)

## Files Created/Modified

- `compliance/src/import/cgp.ts` — imports numbered DPA and CGR requirements and exposes the CGP report contract.
- `compliance/src/import/itar.ts` — reads eCFR title dates, versioned XML sections, and exposes the ITAR/EAR report contract.
- `compliance/mappings/*.json` — authored mapping collections with `ours`, unsettled, and signature props.
- `compliance/profiles/overlay-{cgp,itar}.json` — include-all profiles for the two catalogue destinations.
- `compliance/test/importCgp.test.ts`, `importItar.test.ts`, and `overlayMappings.test.ts` — importer, report, mapping, and profile coverage.

## Decisions Made

- Store the official-text disclaimer in catalogue metadata remarks, with individual requirement links back to their source sections.
- Treat TEE eligibility and third-party encrypted storage as separate unsettled mapping rows so the status engine cannot present them as Met.
- Keep mapping provenance's OSCAL-required lifecycle `status` narrowly allowed; it is schema metadata, not a product assessment.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] Grouped controls bypassed the text-licence gate.**
- **Found during:** Task 2
- **Fix:** Recursively scan OSCAL groups for prose-bearing controls and added a regression test.
- **Files modified:** `compliance/src/import/lib/licence.ts`, `compliance/test/licenceGate.test.ts`
- **Verification:** `compliance/test/licenceGate.test.ts` passes.
- **Committed in:** `f91ac23a`

**2. [Rule 2 - Standards compatibility] OSCAL mapping provenance requires a lifecycle status while the source-status guard rejected it.**
- **Found during:** Task 3
- **Fix:** Allowed only `mapping-collection.provenance.status`; tests retain rejection everywhere else and OSCAL rejects invalid values.
- **Files modified:** `compliance/src/model.ts`, `compliance/src/validate.ts`, `compliance/test/noStatus.test.ts`
- **Verification:** `noStatus`, mapping, and OSCAL tests pass.
- **Committed in:** `abfb8339`

**Total deviations:** 2 auto-fixed (both Rule 2 correctness/security requirements).

## Integration Follow-up

The inherited worktree's old import dispatcher only recognizes registry IDs matching module names, so it cannot yet invoke `cgp.ts` or `itar.ts` or persist their report contracts. Per executor coordination, the integration branch owner will add current-dispatch aliases and report/output wiring after merge; this plan supplies and tests the complete importer result contracts for that work.

## Verification

- `npm --prefix compliance run lint` — passed.
- `npm --prefix compliance test` — passed: 257 tests, 0 failures.
- All task-specific constrained verification commands passed.

## User Setup Required

None.

## Next Phase Readiness

The dashboard can consume the two profiles and mapping flags. Import-command alias/report persistence wiring is the integration-branch follow-up above.

## Self-Check: PASSED

- Summary file exists and all recorded task and correction commits are ancestors of `HEAD`.

---
*Phase: 44-accreditation-evidence-and-compliance-dashboard*
*Completed: 2026-11-21*
