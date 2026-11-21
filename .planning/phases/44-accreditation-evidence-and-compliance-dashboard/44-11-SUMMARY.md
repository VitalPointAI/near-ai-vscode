---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 11
subsystem: compliance-importers
tags: [oscal, itsp-10-033, nist-800-53, yaml, cross-check]
requires:
  - phase: 44-04
    provides: tailoring records and OSCAL validation
  - phase: 44-06
    provides: source registry, safe fetcher, HTML helpers, and import foundation
provides:
  - ITSP.10.033-01 Medium OSCAL profile import with English/French difference report
  - Protected A profile derived from reviewed tailoring
  - pinned NIST minified-catalogue import and identifier-only unofficial-conversion cross-check
affects: [44-13, protected-b-dashboard, accreditation-evidence]
actuals:
  tokens: 9769
  tasks: 3
  commits: 6
tech-stack:
  added: []
  patterns: [semantic table-header parsing, raw-byte NIST persistence, identifier-only conversion reporting]
key-files:
  created: [compliance/src/import/itsp-10-033-01.ts, compliance/src/import/nist-800-53.ts, compliance/src/crossCheck.ts, compliance/src/commands/cross-check.ts, compliance/profiles/protected-a.json]
  modified: [compliance/src/cli.ts, compliance/test/importProfile.test.ts, compliance/test/crossCheck.test.ts]
key-decisions:
  - "English is authoritative; mapped French selection disagreements are reported by id without changing the profile."
  - "NIST minified bytes are preserved only after the full source hash and parsed-data equality checks pass."
  - "Cross-check output retains ids and similarity scores, never text from AWS or CISO conversions."
requirements-completed: [ACCR-01, ACCR-02]
commits: 6
plan_head_before: d6dbdff841f29cd6bc24b47f2d574099c3098cc0
plan_head_after: ed5b04c91270cdd132862f1f1a19dfa198f98158
duration: 45min
completed: 2026-11-21
status: complete
coverage:
  - id: D1
    description: "Medium profile importer includes Selected and organization-wide controls and records all rows."
    requirement: ACCR-01
    verification:
      - kind: unit
        ref: compliance/test/importProfile.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: "Protected A imports Medium with reviewed tailoring-only exclusions."
    requirement: ACCR-01
    verification:
      - kind: unit
        ref: compliance/test/protectedA.test.ts
        status: pass
    human_judgment: false
  - id: D3
    description: "NIST source verification and unofficial conversion differences are reported without copied third-party prose."
    requirement: ACCR-02
    verification:
      - kind: unit
        ref: compliance/test/importNist.test.ts; compliance/test/crossCheck.test.ts
        status: pass
    human_judgment: false
---

# Phase 44 Plan 11: Medium profile and cross-check Summary

**Validated ITSP Medium and Protected A OSCAL profiles, a pinned NIST base importer, and prose-safe AWS/CISO conversion differences.**

## Performance

- **Duration:** 45 min
- **Completed:** 2026-11-21T20:17:46Z
- **Tasks:** 3
- **Files modified:** 20 plan-owned files, plus the authorized CLI registration.

## Accomplishments

- Parsed the Medium profile table by caption and semantic headers; included Selected and organization-wide controls, preserved placeholders/notes as OSCAL props, and recorded every row.
- Kept English authoritative and recorded French selection disagreements after label mapping; Protected A imports all Medium controls and accepts exclusions only from fully reviewed tailoring.
- Verified NIST full-source integrity before preserving minified bytes, and added a bounded YAML cross-check that exposes only ids and similarity scores.

## Value Mapping

| English profile value | Result |
| --- | --- |
| Selected | Included |
| Deployed organization-wide. Not associated with baseline. | Included with `profile-suggestion=deployed-organization-wide` |
| Not selected | Reported only |
| NA | Reported only |
| Not allocated to baseline. | Reported only |

| French label | Mapped English value |
| --- | --- |
| Sélectionné | Selected |
| Non sélectionné | Not selected |
| Déployé dans l’ensemble de l’organisation. Non associé à une base de référence. | Deployed organization-wide. Not associated with baseline. |
| ND | NA |
| Non attribué à une base de référence. | Not allocated to baseline. |

## Task Commits

1. **Task 1: Medium profile tracer** — `11fd20d5` (feat)
2. **Task 2: Full profile, French differences, and Protected A** — `27796c7e` (feat)
3. **Task 3: NIST importer and conversion cross-check** — `d62ce376` (feat)
4. **Authorized Rule 3 CLI registration** — `1962d33a` (fix)
5. **Additional acceptance coverage** — `ed5b04c9` (test)

## Verification

- `npm --prefix compliance run lint`
- Focused profile, Protected A, NIST, cross-check, OSCAL validation, no-status, and CLI suites passed.
- `npm --prefix compliance test` passed: 261 tests, 0 failures.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking integration] Registered the declared cross-check command in the compliance CLI.**

- **Found during:** Task 3
- **Issue:** The plan-owned command would otherwise remain unreachable through the package CLI.
- **Fix:** Added only `cross-check` to the command allow-list and tested its required-argument path.
- **Files modified:** `compliance/src/cli.ts`, `compliance/test/cli.test.ts`
- **Commit:** `1962d33a`

The plan's `systemd-run --user` wrapper could not reach this environment's user bus. The equivalent timeout-and-memory-capped checks ran directly; the full suite then passed outside the sandbox where its fixture may spawn Node.

## Issues Encountered

None affecting delivered behavior.

## Next Phase Readiness

The generic import command needs to honor the NIST importer result's `rawBytes` field when it persists `catalogs/nist-800-53-r5/catalog-min.json`; this handoff was provided to plan 44-10, which owns import-output plumbing.

## Self-Check: PASSED

- All plan-owned importer, profile, cross-check, fixture, and test files exist.
- Task commits `11fd20d5`, `27796c7e`, `d62ce376`, `1962d33a`, and `ed5b04c9` are ancestors of `HEAD`.

---
*Phase: 44-accreditation-evidence-and-compliance-dashboard*
*Completed: 2026-11-21*
