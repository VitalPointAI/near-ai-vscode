---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 19
subsystem: model-comparison-storage
tags: [gap-closure, G-27-2, comparisons, migration, parseSavedRun, backward-compat]
status: complete

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-10 editor-storage migration (migrateComparisons); ComparisonStore; stateRecords sync record path"
provides:
  - "src/benchmark/results.ts: LEGACY_RUN_MODES (frozen table of older mode values to current RunMode), applied inside parseSavedRun"
affects: [27-20, release-notes]

requirements-completed: [SYNC-06, SYNC-02]

actuals:
  tokens: 2100
  tasks: 2
  commits: 3
plan_head_before: 0f710309c30942226a0299790dfa0801c154604f
plan_head_after: cfa0a013d0eaf7eacc3bd369bc77be04a43d4104

tech-stack:
  added: []
  patterns:
    - "One table of older saved values (LEGACY_RUN_MODES) mapped inside the single parser every reader uses, so the next renamed value is fixed in one place; own-property lookup only, so inherited names such as toString are never mapped"

key-files:
  created: []
  modified:
    - src/benchmark/results.ts
    - src/test/benchmarkResults.test.ts
    - src/test/stateMigration.test.ts

key-decisions:
  - "A comparison saved with mode \"run\" by an older build is read as \"rerun\" (an older build's run meant running every model again); parseSavedRun maps before validating, so the returned SavedRun always carries a current mode and serializeRun writes it back normalised"
  - "stateMigration.ts, store.ts and stateRecords.ts were not touched: they already read through parseSavedRun, and a source test now fails if any of them stops doing so or a second validator of the mode appears outside results.ts"

patterns-established:
  - "Fix the class: a renamed saved value goes into the parser's table, never into a reader"

coverage:
  - id: D1
    description: "A comparison an older build saved with mode run is migrated into the state home as a rerun comparison (comparisons 1, skipped 0), listed by ComparisonStore, and a second migration reports 0 and leaves the comparisons folder byte-identical"
    requirement: SYNC-06
    verification:
      - kind: unit
        ref: "src/test/stateMigration.test.ts#comparisons: one an older build saved with mode \"run\" is migrated as a rerun comparison, listed by the store, and a second migration changes nothing"
        status: pass
    human_judgment: false
  - id: D2
    description: "parseSavedRun reads mode run as rerun, serializeRun writes rerun, and an unknown mode (again, or an inherited name such as toString) is still refused"
    requirement: SYNC-06
    verification:
      - kind: unit
        ref: "src/test/benchmarkResults.test.ts#a comparison an older build saved with mode \"run\" reads as \"rerun\" and is written back that way; an unknown mode is still refused (G-27-2)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Every reader accepts the older value: the store lists and loads it (and skips an unknown mode), the Compare Models history entry shows rerun, the table maps only to current modes and shadows none, and a source check shows each reader calls parseSavedRun with one mode validator in results.ts"
    requirement: SYNC-02
    verification:
      - kind: unit
        ref: "src/test/benchmarkResults.test.ts#the store lists and loads a comparison with an older mode value as a rerun, and skips one with a mode nobody ever wrote (G-27-2)"
        status: pass
      - kind: unit
        ref: "src/test/benchmarkResults.test.ts#every older mode value maps to a current mode and none is itself a current one, so the table can never shadow a current value"
        status: pass
      - kind: unit
        ref: "src/test/benchmarkResults.test.ts#the Compare Models history shows a comparison saved with an older mode as a rerun"
        status: pass
      - kind: unit
        ref: "src/test/benchmarkResults.test.ts#every reader of a saved comparison goes through parseSavedRun, and no second validator of the mode exists to bypass the older-value table"
        status: pass
    human_judgment: false

duration: 8 min
completed: 2026-11-13
---

# Phase 27 Plan 19: Older comparison mode value Summary

**Comparisons an older build saved with `mode: "run"` are now read as `"rerun"` by the one parser every reader shares, so they migrate into the state home, list in Compare Models, and sync, while unknown modes are still refused.**

## Accomplishments

- Added the frozen `LEGACY_RUN_MODES` table (`run` to `rerun`) in `src/benchmark/results.ts` and applied it inside `parseSavedRun` before the mode check. No other check was loosened (format, version, id, startedAt, status, taskSet, runsPerTask).
- Tracer: a synthetic editor storage holding a `mode: "run"` comparison (two models, two completed rows, shaped like the UAT file with synthetic values) migrates with `comparisons: 1, skipped: 0`, is listed by `ComparisonStore` as `rerun`, and a second migration reports 0 with the comparisons folder byte-identical (D-05).
- Guards on every reader: store list and load, history entry for the Compare Models tab, table shape (values current, keys never current, frozen, inherited property names not mapped), and a source check that `stateRecords.ts`, `stateMigration.ts` and `store.ts` read through `parseSavedRun` and that only `results.ts` holds the pair of mode literals in one array.

## TDD

- RED: `1bb6ff7` `test(27-19)`: two target tests (parse/serialize in benchmarkResults.test.ts; migration in stateMigration.test.ts) failed on the planned assertions (`older` was undefined: "a comparison with mode run is readable"; `comparisons` was 0, expected 1). The other 37 tests in the two files passed. Semantic assessment: the target tests executed and failed for the intended reason (the older comparison was refused), not a build, load or fixture fault. The default spec reporter was used, so `check tdd-red-evidence` (TAP) was not run; evidence is the captured console report.
- GREEN: `17318da` `feat(27-19)`: both pass, all 39 tests in the two files pass.
- Task 2 added guards that the plan expected to pass straight away after Task 1 (store, page, unknown value) plus new structural guards; committed as `test(27-19)` `cfa0a01`. No refactor commit.

## Task Commits

1. Task 1 (tracer) RED: `1bb6ff7`; GREEN: `17318da`
2. Task 2: `cfa0a01`

Tracer gate: re-ran the tracer `<verify>` end to end (tsc plus both test files, 39/39 pass) before expanding.

## Verification

- `tsc -p tsconfig.json && node --test dist/test/benchmarkResults.test.js dist/test/stateMigration.test.js dist/test/modelComparisonPage.test.js`: 55 tests, 55 pass, 0 fail (under the memory cap).
- `npm run lint` (tsc --noEmit): exit 0.
- `grep -c LEGACY_RUN_MODES src/benchmark/results.ts`: 2.
- 4 new tests in benchmarkResults.test.ts plus 1 tracer test there and 1 in stateMigration.test.ts (6 new in total).

## Deviations from Plan

None - plan executed exactly as written. The page-model function `historyEntries` in `src/services/modelComparisonPage.ts` is exported and was tested directly.

## Known Stubs

None.

## Threat Flags

None. T-27-94 mitigated: only exact own keys of a frozen table are mapped, each to a current mode; inherited names (`toString`, `constructor`, `__proto__`) and unknown values are refused (tested).

## Self-Check: PASSED

- FOUND: src/benchmark/results.ts, src/test/benchmarkResults.test.ts, src/test/stateMigration.test.ts
- FOUND commits: 1bb6ff7, 17318da, cfa0a01
