---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 05
subsystem: compliance-dashboard
tags: [dashboard-contract, local-overlay, oscal, copy-lint]
requires: [44-01]
provides:
  - "Strict v1 dashboard, overlay, manifest, control-text, refresh, and responsibility schemas"
  - "Import-free browser/Node dashboard library with safe parsing, local overlay merge, counters, filtering, and CSV export"
  - "OSCAL component loader, responsibility resolver, and Phase 41-parity output word lint"
affects: [44-14, 44-15, 44-17, 44-18]
tech-stack:
  added: []
  patterns:
    - "Dashboard-only types stay in dashboard.ts; model.ts remains owned by Plan 44-04"
    - "Organization overlays are strictly parsed and cloned before local merge"
    - "Generated copy is linted with the Phase 41 phrases, while official text is excluded by path"
key-files:
  created:
    - compliance/schemas/dashboard.schema.json
    - compliance/schemas/overlay.schema.json
    - compliance/schemas/bundle-manifest.schema.json
    - compliance/schemas/control-text.schema.json
    - compliance/schemas/refresh.schema.json
    - compliance/schemas/responsibility.schema.json
    - docs-site/src/compliance/lib.mjs
    - compliance/src/components.ts
    - compliance/src/responsibility.ts
    - compliance/src/wordLint.ts
  modified:
    - compliance/src/dashboard.ts
    - compliance/test/dashboard.test.ts
    - docs-site/test/lib.test.mjs
decisions:
  - "Dashboard fields are local dashboard.ts types, preventing conflicts with the model.ts owner"
  - "Overlay files are read only, capped, prototype-key-refusing, and merged into a structured clone"
  - "CSV cells are quoted and spreadsheet formula prefixes are apostrophe-neutralized"
  - "Word-lint parity reads the Phase 41 source text rather than importing extension-only dependencies"
metrics:
  duration: 9 min
  completed: 2026-11-21
  tasks: 4
  files: 26
actuals:
  tokens: 20242
  tasks: 4
  commits: 5
commits: 5
plan_head_before: 0d81e1dda623f974cbe0abdc30dc8eb822b451c7
plan_head_after: c82d7b310ddede6419a9a116c039ad7222922e7e
status: complete
---

# Phase 44 Plan 05: Dashboard contract, local overlay, and word-lint Summary

**The compliance producer and docs reader now share a strict dashboard contract, with local-only organization evidence, deterministic responsibility allocation, and Phase 41-compatible claim linting.**

## Accomplishments

- Created dashboard v1 with `schemaVersion`, evidence source and timestamps, levels/counts, rows/components, gaps, collectors, matrix, text index, and refused acceptances. The producer fills reason sentences and state counts; the docs reader validates the basic shape before rendering.
- Added the strict overlay, bundle manifest, control text, refresh, and responsibility table schemas. The sample overlay marker strings are listed in `compliance/test/fixtures/overlay/markers.txt`.
- Added import-free `docs-site/src/compliance/lib.mjs`: `parseDashboard`, `filterRows`, `levelCounts`, `isOld`, `gapsByLevelsBlocked`, `toCsv`, `parseOverlayIndex`, and `mergeOverlay`, plus public path constants.
- Added OSCAL component loading with exact namespaced responsibility props, duplicate/id checks, statement metadata, and a resolver with implemented > exception > family precedence.
- Added output word lint. `OUR_TEXT_FIELDS` covers row reasons/components, gaps, matrix rows, and level notes; `OFFICIAL_TEXT_FIELDS` excludes row titles and control titles/parts. Source-text parity keeps its phrase list and negation regex aligned with Phase 41.

## Verification

- `npm --prefix compliance run lint` — passed.
- `node scripts/run-tests.mjs compliance/test/*.test.ts docs-site/test/*.test.mjs` — 9 files passed, 0 failed.
- `git diff --check 0d81e1dd..HEAD` — passed.
- The plan's `systemd-run --user` memory wrapper could not run because this container has no user systemd bus; the equivalent direct scoped test commands passed.

## Task Commits

1. `4d97ee81` — dashboard schema and docs-reader tracer.
2. `8b2f40f1` — local organization overlays and package-shape schemas.
3. `214a07d3` — component loader and responsibility resolver.
4. `7e842377` — generated-output word lint and parity test.
5. `c82d7b31` — dashboard-only type relocation for parallel-work safety.

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 2 - Parallel-work safety] Removed dashboard types from `model.ts`.**
   - **Found during:** final verification.
   - **Issue:** inherited Task 1 work extended the file reserved to Plan 44-04, creating an avoidable merge conflict.
   - **Fix:** localized the dashboard contract types to `dashboard.ts`.
   - **Commit:** `c82d7b31`.

2. **[Rule 1 - Behavior] Recognized “Nothing … makes … accredited” as sentence-local negation.**
   - **Found during:** Task 4 test execution.
   - **Issue:** the exact Phase 41 regex does not include the lexical form “Nothing”, although the plan requires that honest sentence to pass.
   - **Fix:** retained exact exported regex parity and added the equivalent sentence form to the output linter.
   - **Commit:** `7e842377`.

## Known Stubs

None.

## Self-Check: PASSED

All listed artifacts exist and task commits `4d97ee81`, `8b2f40f1`, `214a07d3`, `7e842377`, and `c82d7b31` are ancestors of `HEAD`.
