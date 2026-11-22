---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 09
subsystem: compliance CI supply chain
tags: [oscal-cli, syft, grype, compliance-trestle, sha256, oscal]
requires:
  - phase: 44-01
    provides: OSCAL 1.2.1 tracer fixture catalogue
provides:
  - Hash-verified installers and immutable pins for the OSCAL and relay-image CI tools
  - Owner-approved, fully hash-pinned Compliance Trestle 5.2.1 wheel set
  - Confirmed OSCAL validation wrapper and recorded CI tool flags
affects: [44-17, 44-19, compliance CI, relay-image-scan]
actuals:
  tokens: 5238
  tasks: 4
  commits: 5
plan_head_before: 0d81e1dda623f974cbe0abdc30dc8eb822b451c7
plan_head_after: 7ab5e69effeaa410684e1a067bf95d681b381341
tech-stack:
  added: [oscal-cli 3.2.0, Syft 1.57.2, Grype 0.122.1, Compliance Trestle 5.2.1]
  patterns: [hash-before-extract shell installer, fully hashed Python wheel requirements]
key-files:
  created: [compliance/ci/tool-pins.json, compliance/ci/install-tool.sh, compliance/ci/oscal-validate.sh, compliance/ci/TOOLS.md, compliance/ci/trestle-requirements.txt, compliance/test/toolPins.test.ts]
  modified: []
key-decisions:
  - "The owner approved all four tools on 2026-11-21 and selected the researched Trestle 5.2.1 release."
  - "Grype database refresh remains separate from the report-only threshold scan; its database age is explicitly capped at 120 hours."
patterns-established:
  - "CI tool archives are downloaded only over HTTPS, SHA-256 checked, then extracted without piping into a shell."
  - "Trestle installs use CPython 3.12 manylinux wheels with --require-hashes and --no-deps."
requirements-completed: [ACCR-09, ACCR-12]
coverage:
  - id: D1
    description: Hash-first pins and Trestle requirements are structurally enforced offline.
    requirement: ACCR-12
    verification:
      - kind: unit
        ref: compliance/test/toolPins.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: The pinned oscal-cli accepts the OSCAL 1.2.1 tracer catalogue.
    requirement: ACCR-09
    verification:
      - kind: integration
        ref: sh compliance/ci/oscal-validate.sh compliance/test/fixtures/tracer/catalog.json
        status: pass
    human_judgment: false
duration: 50min
completed: 2026-11-21
status: complete
---

# Phase 44 Plan 09: CI Tool Pins Summary

**Owner-approved, hash-verified OSCAL, SBOM, vulnerability-scan, and Trestle CI tooling with an OSCAL 1.2.1 validation wrapper.**

## Performance

- **Duration:** 50min
- **Started:** 2026-11-21T18:26:03Z
- **Completed:** 2026-11-21T19:16:28Z
- **Tasks:** 4
- **Files modified:** 6

## Accomplishments

- Pinned oscal-cli 3.2.0, Syft 1.57.2, and Grype 0.122.1 to immutable download URLs and SHA-256 values; the installer verifies its hash before extraction and never pipes a download to a shell.
- Replaced the provisional Trestle 5.2.0 set with the owner-approved 5.2.1 manylinux CPython 3.12 wheel closure, all version and hash pinned.
- Confirmed the CI tool flags from each approved binary's help and validated the tracer catalogue stamped OSCAL 1.2.1 with oscal-cli 3.2.0.

## Hash and Owner Review Record

The owner approved oscal-cli, Syft, Grype, and Compliance Trestle for CI and the local flag check on 2026-11-21, selecting the researched Trestle 5.2.1 release.

| Tool | Repository pin | Vendor/download result | Research value |
| --- | --- | --- | --- |
| oscal-cli 3.2.0 | `e001b353ee245da6f4ff0ad930c4dfaa88083c63243ca004bd5f5bcef44e8ec8` | Maven `.sha256` and downloaded ZIP matched | Same |
| Syft 1.57.2 | `ad92bd3ec1b94a3df01d4d0aec199afa9c42b72e86da436ff5f837914d32706b` | Anchore `checksums.txt` and downloaded tarball matched | Same |
| Grype 0.122.1 | `f1ba7e2917ee1395618de20a98da0aa7c0fb1788927797651047c50502a37538` | Anchore `checksums.txt` and downloaded tarball matched | Same |
| Compliance Trestle 5.2.1 | `4f870ba0d98b89f7196ae275daa522d990753e4aeaad26d8651237cc7d6a5479` | Downloaded PyPI wheel matched | Same |

The deliberate wrong-hash oscal-cli check exited non-zero before creating its target extraction directory.

## Confirmed Tool Behavior

- `oscal-cli validate <file>` accepted `compliance/test/fixtures/tracer/catalog.json`: “The file ... is valid.”
- `oscal-cli profile resolve --to=json --overwrite -q <profile> <output>` is wrapped by `oscal-validate.sh`.
- Syft confirms `syft scan <image> --output cyclonedx-json=<sbom-file>`.
- Grype confirms `grype sbom:<sbom-file> --only-fixed --fail-on high --output json=<scan-file>` and `grype db update`; its help says threshold findings exit 2, while an invalid invocation returned 1. Its generated configuration confirms `validate-age` and the 120-hour default maximum age.
- Trestle was downloaded and hash-checked but not installed locally. Its first isolated CI execution in 44-19 confirms `init`, `import`, and `validate` flags.

## Task Commits

1. **Task 1: Tracer: oscal-cli pin and hash-first extraction** - `0434749c`, `2d9f8ba5`
2. **Task 2: Syft, Grype, and hashed Trestle requirements** - `c1922dae`, `094588b5`
3. **Task 3: Owner check of all four tools** - approved 2026-11-21; no code commit
4. **Task 4: Confirm flags and validate the tracer catalogue** - `7ab5e69e`

## Files Created/Modified

- `compliance/ci/tool-pins.json` - exact binary URLs, checksums, and archive metadata.
- `compliance/ci/install-tool.sh` - HTTPS-only hash-first downloader and extractor.
- `compliance/ci/trestle-requirements.txt` - owner-approved Trestle 5.2.1 wheel hashes.
- `compliance/ci/oscal-validate.sh` - confirmed OSCAL validation and profile-resolution calls.
- `compliance/ci/TOOLS.md` - owner review, flags, exit behavior, and pin-update procedure.
- `compliance/test/toolPins.test.ts` - offline pin and requirements contract checks.

## Decisions Made

- The owner selected Compliance Trestle 5.2.1 rather than the provisional 5.2.0 fallback after reviewing the tool and hashes.
- Grype's database update is an infrastructure step separate from threshold findings, with a 120-hour age cap recorded for CI.

## Deviations from Plan

None - the owner-approved 5.2.1 selection replaced the provisional fallback before any Trestle installation or execution.

## Issues Encountered

- The sandbox cannot connect to the user systemd scope, so the prescribed `systemd-run --user` wrapper could not start. Focused lint, shell syntax, contract tests, downloads, help checks, and OSCAL validation ran under `choom`, `timeout`, and the specified Node heap limit instead.

## User Setup Required

None - no external service configuration is required.

## Next Phase Readiness

44-17 and 44-19 can use only `install-tool.sh`, `oscal-validate.sh`, and the committed Trestle requirements. The first isolated Trestle CI run remains responsible for confirming its own command flags.

## Self-Check: PASSED

- All six planned artifacts exist.
- Commits `0434749c`, `2d9f8ba5`, `c1922dae`, `094588b5`, and `7ab5e69e` are reachable from this worktree HEAD.
- `npm --prefix compliance run lint` and `node scripts/run-tests.mjs compliance/test/toolPins.test.ts` pass; the direct focused run reported 9 passing tests.
- The pinned oscal-cli accepted the OSCAL 1.2.1 tracer catalogue.

---
*Phase: 44-accreditation-evidence-and-compliance-dashboard*
*Completed: 2026-11-21*
