---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 10
subsystem: compliance-importer
tags: [oscal, itsp-10-033, parse5, bilingual, licence-gate]
requires:
  - phase: 44-06
    provides: licence-gated importer dispatcher, OSCAL builders, HTML parsing, and source registry
provides:
  - Deterministic English and French ITSP.10.033 OSCAL catalogue importer with reconciliation report
  - Nested enhancements, activities, Canada-only markers, relations, references, and GC discussion parsing
  - Generic importer support for language selection, structured reports, and byte-preserved raw outputs
affects: [44-11, 44-16, compliance-catalog-data]
actuals:
  tokens: 7763
  tasks: 3
  commits: 4
commits: 4
plan_head_before: 69d528e120ba1e86e0dadcdc65c5d722be8156db
plan_head_after: 5ac7de7fbaf6b573af35f883c02223dddbc3a76e
tech-stack:
  added: []
  patterns: [id-based bilingual pairing, licence-gated importer writes, raw-byte preserving import output]
key-files:
  created: [compliance/src/import/itsp-10-033.ts, compliance/src/import/lib/itspControl.ts, compliance/test/importItsp.test.ts]
  modified: [compliance/src/commands/import.ts, compliance/test/fixtures/import/itsp10033/pages.json]
key-decisions:
  - "English remains authoritative; French text attaches only to an English control with the same normalized id."
  - "Unrecognized enhancement markup and French parsing failures are report data rather than silently omitted controls."
  - "A generic importer may replace validated JSON serialization with verified raw bytes when a source hash requires byte identity."
requirements-completed: [ACCR-01, ACCR-02]
coverage:
  - id: D1
    description: English ITSP.10.033 pages import as deterministic, licence-gated OSCAL catalogue controls.
    requirement: ACCR-01
    verification:
      - kind: unit
        ref: compliance/test/importItsp.test.ts#imports the English fixture family into a labelled OSCAL control
        status: pass
      - kind: unit
        ref: compliance/test/importItsp.test.ts#the same offline pages produce byte-identical output
        status: pass
    human_judgment: false
  - id: D2
    description: Enhancements, activities, Canada-only markers, related controls, references, and reconciliation counts are retained.
    requirement: ACCR-02
    verification:
      - kind: unit
        ref: compliance/test/importItsp.test.ts#lists unrecognized enhancement markup in the reconciliation report
        status: pass
    human_judgment: false
  - id: D3
    description: French material pairs by id and reports single-language ids and nonfatal parse failures.
    requirement: ACCR-02
    verification:
      - kind: unit
        ref: compliance/test/importItsp.test.ts#reports ids that exist in only one language and malformed French pages
        status: pass
    human_judgment: false
duration: 8min
completed: 2026-11-21
status: complete
---

# Phase 44 Plan 10: ITSP.10.033 Catalogue Importer Summary

**Deterministic, licence-gated OSCAL import of ITSP.10.033 controls with nested enhancements, Canada-only provenance, and French text paired by control id.**

## Accomplishments

- Imported official-shaped English family pages into valid OSCAL catalogue groups with parameters, guidance, GC discussion, references, related links, activities, and nested enhancements.
- Added a per-family reconciliation report with source hashes, dates, counts, unrecognized enhancement markup, one-language ids, and nonfatal French parsing failures.
- Attached French titles and parts beside matching English controls by normalized id, without trusting landing-page order.
- Extended generic command plumbing to accept `--lang`, write importer reports, and preserve verified raw source bytes for hash-sensitive importers.

## Task Commits

1. **Task 1: English tracer importer** — `f70d977f`
2. **Task 2: Enhancements and reconciliation** — `aaeae378`
3. **Task 3: French pairing and discrepancy reporting** — `43a7bd8b`
4. **Coordinator follow-up: raw-byte output plumbing** — `5ac7de7f`

## Files Created/Modified

- `compliance/src/import/itsp-10-033.ts` — source importer, report assembly, and English/French page handling.
- `compliance/src/import/lib/itspControl.ts` — OSCAL control construction, enhancement variants, and id-based language pairing.
- `compliance/src/commands/import.ts` — source-neutral language, report, and raw-byte output plumbing.
- `compliance/test/importItsp.test.ts` — 16 focused importer and generic output-boundary tests.
- `compliance/test/fixtures/import/itsp10033/` — official-shaped, synthetic bilingual offline fixtures.

## Decisions Made

- English controls are authoritative; `--lang fr` is refused, and French material is appended only after an id match.
- The h3 label table maps `Control`/`Contrôle`, `Activity`/`Activité`, English/French GC discussion, related-control, and reference labels into stable OSCAL structures.
- Strong and h4 enhancement headings are recognized; unmatched list items are retained in the reconciliation report with family and position.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] Added generic language and report plumbing to the import dispatcher.**
- **Found during:** Task 1
- **Issue:** The 44-06 dispatcher discarded `--lang` and supported only one catalogue file, making required CLI language selection and reconciliation report output impossible.
- **Fix:** Passed validated language options to importers and added source-neutral, output-root-bound report writing.
- **Files modified:** `compliance/src/commands/import.ts`
- **Verification:** Focused importer, licence-gate, OSCAL validity, and no-status tests pass.
- **Committed in:** `f70d977f`

**2. [Rule 3 - Blocking issue] Added source-neutral raw-byte output support.**
- **Found during:** Coordinator follow-up after Task 3
- **Issue:** A later importer must preserve verified downloaded bytes exactly; JSON serialization would invalidate its full-file hash.
- **Fix:** Retained the in-memory catalogue for licence validation, then replaced its output with `rawBytes` under the same lexical boundary.
- **Files modified:** `compliance/src/commands/import.ts`, `compliance/test/importItsp.test.ts`
- **Verification:** Focused byte-preservation and output-boundary test passes.
- **Committed in:** `5ac7de7f`

**Total deviations:** 2 auto-fixed (Rule 3).

## Issues Encountered

- The prescribed `systemd-run --user` wrapper cannot access the sandbox user bus. The equivalent memory-limited focused lint and test commands ran directly and passed each time.

## User Setup Required

None.

## Next Phase Readiness

44-16 can run the importer against live, approved source pages and use the report to reconcile data and raise French failures as POA&M items.

## Self-Check: PASSED

- Required importer, helper, test, and bilingual fixture files exist.
- Task commits `f70d977f`, `aaeae378`, `43a7bd8b`, and `5ac7de7f` are ancestors of `HEAD`.
