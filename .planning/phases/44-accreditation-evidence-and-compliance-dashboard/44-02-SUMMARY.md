---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 02
subsystem: testing
tags: [node-test, reporter, ndjson, secret-scan, gate-paths, evidence]

requires: []
provides:
  - "NEAR_AI_TEST_REPORT=<path>: opt-in per-test NDJSON report from scripts/run-tests.mjs (TestReportRow lines)"
  - "scripts/test-report-reporter.mjs: node:test custom reporter (default export async generator)"
  - "scripts/secret-scan.mjs --dir <folder> and --json"
  - "GATE_PATHS entries for compliance/tailoring/, compliance/sources.json, compliance/catalogs/, compliance/attestations/"
affects: [44-07, 44-09, 44-19]

actuals:
  tokens: 9004
  tasks: 3
  commits: 3
plan_head_before: 932f73c9db34fc18b44f45e812a35cd68d249ce3
plan_head_after: f635be0818ec703d74a2771de5f59190f3f1db78

tech-stack:
  added: []
  patterns:
    - "Opt-in behaviour through one environment variable read by the top-level runner and removed from the child environment"
    - "Folder scans walk with lstat and open with O_NOFOLLOW; non-regular entries are findings"

key-files:
  created:
    - scripts/test-report-reporter.mjs
  modified:
    - scripts/run-tests.mjs
    - scripts/test/run-tests.test.mjs
    - scripts/secret-scan.mjs
    - scripts/test/secret-scan.test.mjs
    - scripts/lib/workflow.mjs
    - scripts/test/workflow.test.mjs

key-decisions:
  - "Report row shape is exactly { file, path, name, status, skip, ms }; skip carries only a skip reason (null for todo rows and for a skip without a reason)"
  - "Only describe suites are left out of the report; a test() with subtests is a row as well as each subtest; a file that fails to load is one failed row named after the file"
  - "secret-scan --json writes finding locations (path and rule, never text) to stderr so CI logs still show what to look at; stdout holds the one JSON line only"
  - "allowlisted in the JSON is the number of allowlist entries (the same number the human line prints), 0 in dir mode"

patterns-established:
  - "Evidence-producing options keep the default path byte-for-byte unchanged and prove it with a before/after comparison test"

requirements-completed: [ACCR-04, ACCR-05, ACCR-11]

coverage:
  - id: D1
    description: "NEAR_AI_TEST_REPORT writes one NDJSON row per leaf test with file, suite path, name, status, skip reason and duration; console output and exit code unchanged; unset changes nothing; nested runs never write into the outer report; the report folder is created"
    requirement: ACCR-04
    verification:
      - kind: unit
        ref: "scripts/test/run-tests.test.mjs (6 NEAR_AI_TEST_REPORT tests)"
        status: pass
      - kind: integration
        ref: "NEAR_AI_TEST_REPORT=<tmp> node scripts/run-tests.mjs scripts/test/*.test.mjs (175 tests, 175 rows)"
        status: pass
    human_judgment: false
  - id: D2
    description: "secret-scan --dir scans an untracked folder with the same rules, symlinks and non-regular entries and files above 16 MiB are findings, binaries skipped, allowlist not applied, --dir with --range refused; --json prints counts only"
    requirement: ACCR-11
    verification:
      - kind: unit
        ref: "scripts/test/secret-scan.test.mjs (6 new --dir/--json tests)"
        status: pass
      - kind: other
        ref: "node scripts/secret-scan.mjs (repository scan clean; output identical to the base script for tracked and range modes)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Compliance trust roots (tailoring, sources.json, catalogs, attestations) are GATE_PATHS; CI_CHECKS unchanged"
    requirement: ACCR-05
    verification:
      - kind: unit
        ref: "scripts/test/workflow.test.mjs (2 new tests) plus merge, review and auto-review tests"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-11-21
status: complete
---

# Phase 44 Plan 02: Per-test report, folder secret scan and compliance gate paths Summary

**Opt-in NEAR_AI_TEST_REPORT NDJSON reporter beside Node's spec output, a symlink-refusing `--dir` folder scan with a counts-only `--json` line in the secret scan, and four compliance trust roots added to GATE_PATHS.**

## Performance

- **Duration:** about 10 min
- **Started:** 2026-11-21T18:05:34Z
- **Completed:** 2026-11-21T18:15:30Z
- **Tasks:** 3 of 3
- **Files modified:** 7 (1 created, 6 modified)

## Accomplishments

- Any CI job can get exact per-test evidence by setting `NEAR_AI_TEST_REPORT=<path>`; nothing about running tests changes without it.
- The evidence bundle (and later the release package) can be secret-scanned with the repository's one rule set before upload; `--json` gives the workflow a stable result to read.
- Changes to tailoring, catalogues, sources and the risk-acceptance signer list now wait for the owner's gate approval.

## Report row shape as built (contract for 44-01 `TestReportRow` and 44-07)

One JSON object per line, keys in this order:

```json
{"file":"scripts/test/auto-review.test.mjs","path":[],"name":"the review refuses the owner's account before running anything","status":"passed","skip":null,"ms":7.563173}
```

- `file`: the test file relative to the runner's working directory, forward slashes (`''` if Node gives no file). For the extension suite this is a `dist/test/X.test.js` path; the collector maps it to `src/test/X.test.ts`.
- `path`: suite names, outermost first (`[]` at top level). Built from `test:start` events per file (files run in their own processes and their events can interleave).
- `name`: the test's own name.
- `status`: `failed` for `test:fail` (cancelled tests included); otherwise `skipped` if `skip` is set, `todo` if `todo` is set, else `passed`.
- `skip`: the skip reason string for a skipped test given one; `null` otherwise (also `null` for `it.skip` without a reason and for every todo row, even `todo: 'text'`).
- `ms`: Node's `duration_ms`.

Rows that later plans must expect:
- `describe` suites are not rows. A `test()` that runs subtests through `t.test` is a row of its own (after its subtests), and each subtest is a row with `path: ['<parent>']`.
- A test file that fails to load (for example a missing `dist/` module) is a single row `{ "path": [], "name": "<the file path>", "status": "failed" }`. Seen during this plan's full run before `npm run compile`.

## Node 24 default console reporter as found

Node v24.22.3 prints the `spec` reporter by default through `scripts/run-tests.mjs` even when stdout is not a TTY (piped output shows `✔`, `﹣ ... # SKIP`, `# TODO`, `▶ suite`, the `ℹ tests/suites/pass/fail/cancelled/skipped/todo/duration_ms` summary and the `✖ failing tests:` section). With the variable set, the runner adds, before the caller's arguments:

`--test-reporter=<abs path>/scripts/test-report-reporter.mjs --test-reporter-destination=<report> --test-reporter=spec --test-reporter-destination=stdout`

A test compares the console output with and without the variable (timings removed) and requires it to be identical.

## Task Commits

1. **Task 1 (tracer): NEAR_AI_TEST_REPORT NDJSON report** - `f0aa15c3` (feat)
2. **Task 2: secret scan `--dir` and `--json`** - `285728f9` (feat)
3. **Task 3: compliance trust roots become gate paths** - `f635be08` (feat)

Tracer feedback gate (Task 1): the `<verify>` command was re-run end to end after the commit (9 of 9 passing), and the real `scripts/test/*.test.mjs` suite was run with the variable set (175 tests, 175 rows, all passed), so expansion continued.

## TDD record (each new test failed on the base first)

| File | New tests | Failed on base | Note |
|------|-----------|----------------|------|
| scripts/test/run-tests.test.mjs | 6 | 5 | "NEAR_AI_TEST_REPORT unset" is a regression guard of today's behaviour and passes on the base by design; the sixth test (deep suites over several files) was added so that at least 5 new tests failed first |
| scripts/test/secret-scan.test.mjs | 6 | 6 | |
| scripts/test/workflow.test.mjs | 2 | 2 | |

Mutation check: with the `delete childEnv.NEAR_AI_TEST_REPORT` line removed, the nested-run test first still passed (the outer row overwrote the shorter nested row in place); the inner fixture's test name was made longer than the outer one, after which the mutation is caught.

## Files Created/Modified

- `scripts/test-report-reporter.mjs` - node:test custom reporter writing TestReportRow NDJSON
- `scripts/run-tests.mjs` - reads NEAR_AI_TEST_REPORT once, makes the report folder, adds the reporter flags before the file arguments, removes the variable from the child environment; header comment
- `scripts/test/run-tests.test.mjs` - fixture helper and 6 report tests
- `scripts/secret-scan.mjs` - `--dir` (lstat walk, O_NOFOLLOW|O_NONBLOCK open, symlink / not-regular-file / too-large findings, no allowlist), `--json`, `--dir` with `--range` refused; usage comment
- `scripts/test/secret-scan.test.mjs` - 6 tests for `--dir` and `--json`
- `scripts/lib/workflow.mjs` - four GATE_PATHS entries and one comment sentence
- `scripts/test/workflow.test.mjs` - 2 tests for kept and dropped compliance paths

## Decisions Made

See key-decisions in the frontmatter. Also: in dir mode the human success line reads `Secret scan clean: <n> files in <dir>. The allowlist does not apply to a folder.`; the tracked and range human output is byte-identical to the base script (compared on this repository).

## Deviations from Plan

1. **[Rule 2 - Hardening] Folder scan opens files with O_NOFOLLOW and O_NONBLOCK and re-checks with fstat.** Found during Task 2. A link or FIFO swapped in between the lstat walk and the read would otherwise be followed or block. Committed in `285728f9`.
2. **[Rule 2 - Usability] `--json` writes finding locations (path and rule, no text) to stderr.** The plan only fixes stdout; with nothing on stderr a failed bundle scan in CI would say how many findings but not where. No part of a matched value is printed (tested). Committed in `285728f9`.
3. **Extra rule name `not-regular-file`** for entries that are neither files, folders nor symlinks (FIFOs, sockets, devices), per the plan's "a symlink or other non-regular entry is a finding". Committed in `285728f9`.
4. **One extra runner test** (see TDD record) so that at least five new tests failed on the base.
5. **Branch naming:** the plan names `feat/phase-44-02-scripts` from `feat/phase-44-accreditation`; the orchestrator dispatched `feat/phase-44-02-test-report` from `feat/phase-44-compliance` (932f73c9). Work is on the dispatched branch.

**Total deviations:** 5 (2 Rule 2, 3 recording-only). No scope creep; no file outside `files_modified` changed except this SUMMARY.

## Issues Encountered

- The first full `scripts/test/*.test.mjs` run failed one file (`scripts/test/orgIssuer.test.mjs`) because `dist/` was not built in this worktree; that test needs `npm run compile` first (its header says so). After a capped `npm run compile` the full run passed: 175 of 175.

## Tests run

- `node scripts/run-tests.mjs scripts/test/run-tests.test.mjs`: 9 pass, 0 fail
- `node scripts/run-tests.mjs scripts/test/secret-scan.test.mjs` then `node scripts/secret-scan.mjs`: 15 pass, 0 fail; repository scan clean (4597 tracked files)
- `node scripts/run-tests.mjs scripts/test/workflow.test.mjs scripts/test/merge.test.mjs scripts/test/review.test.mjs scripts/test/auto-review.test.mjs`: 97 pass, 0 fail
- `NEAR_AI_TEST_REPORT=<scratch> node scripts/run-tests.mjs scripts/test/*.test.mjs` (after `npm run compile`): 175 pass, 0 fail, 175 report rows
- Acceptance greps: NEAR_AI_TEST_REPORT in run-tests.mjs 3, in its test 10; `'dir'` 2, `'json'` 1, `--dir` in the test 20; `compliance` in workflow.mjs 7, in its test 12; the CI_CHECKS line unchanged (1)

All runs used the systemd-run memory cap.

## Owner actions

None for this plan. Every file here except `scripts/run-tests.mjs` and the reporter is a gate path, so the integration PR carries the owner's gate approval (already planned).

## Notes for later plans

- 44-01 `TestReportRow`: match the field names and value rules above exactly; `skip` is never the todo text.
- 44-07 collector: expect file-load failure rows named after the file, and parent `test()` rows beside their subtests.
- 44-19: CI can call `node scripts/secret-scan.mjs --dir <bundle> --json`; exit 1 on any finding stops the upload. Use `NEAR_AI_TEST_REPORT` without reporter flags of your own on the same command line (Node requires reporter and destination counts to match).

## Next Phase Readiness

Ready for 44-07 (collectors read the rows) and 44-19 (workflow wiring). No blockers.

---
*Phase: 44-accreditation-evidence-and-compliance-dashboard*
*Completed: 2026-11-21*

## Self-Check: PASSED

All created and modified files exist; commits f0aa15c3, 285728f9 and f635be08 are on the branch.
