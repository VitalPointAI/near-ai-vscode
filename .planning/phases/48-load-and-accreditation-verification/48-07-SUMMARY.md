---
phase: 48-load-and-accreditation-verification
plan: 07
subsystem: compliance
status: checkpoint (Task 3, owner approval of gate PR 2, pending; no PR opened, by instruction)
tags: [compliance, workbench, release-pipeline, statements, evidence-rules, VER-04, VER-05]
requires: [48-05, 48-06, "Phase 46 (46-01 to 46-08) on main"]
provides:
  - five workbench statements with 19 test rules on Phase 46 tests, one deployment observation and one dated-record rule
  - release-pipeline image statements (si-07 signature and attestation, cm-08 image SBOM) on workflow-files tests
  - contentTracer.test.ts workbench tracer on the real hosted Protected B level
  - 15 workbench register entries moved from extension to workbench
affects: [48-08 (section 10 rows 38, 41 and 42), 48-10, 46 follow-up (G480, G481)]
key-files:
  created:
    - compliance/evidence-rules/workbench.json
    - compliance/test/fixtures/content/workbench-report.ndjson
  modified:
    - compliance/components/workbench.json
    - compliance/components/release-pipeline.json
    - compliance/evidence-rules/release-pipeline.json
    - compliance/resources.json
    - compliance/test/contentTracer.test.ts
    - docs-site/content/architecture/components/workbench.md
    - compliance/gaps.json
    - docs/security/hosted-verification-records.md
decisions:
  - The tracer control is ia-05, per-person secrets; Theia's key store holds extension secrets (tokens), which is authenticator protection
  - The image SBOM statement is on cm-08, not cm-02, so cm-02 keeps the installer-SBOM limitation the bundle test pins
  - The VSIX statements stay, because the release still builds the VSIX and the Sterling image bundles it (workflow-files test "the Sterling image bundles the verified VSIX and is smoke-tested before archiving")
  - The compliance job's workbench-image sbom input was not added, because the compliance job does not need the workbench job (G481)
  - No crypto inventory row was needed, because no statement uses the crypto collector
metrics:
  completed: 2026-11-25
actuals:
  tasks: 2
  commits: 16
plan_head_before: 32007751db9e9a85bfaf163cc1098c790b29a10e
plan_head_after: 0880727e1e41b3f33ccf01740e88d523a8a92a09
---

# Phase 48 Plan 07: Phase 46 workbench and the release pipeline re-assessed for the image Summary

The Sterling workbench now has statements, each proven by Phase 46 unit tests named literally. Its per-person secret store reads Met on hosted Protected B from a passing workbench report. If the tracer row is skipped it reads test-skipped, and if the row is removed, test-not-run. The release pipeline now also covers the image: it signs and attests the one tested digest with your organization's cosign key, and records the image SBOM.

The branch is `feat/phase-48-statements`, shared with 48-08. `commits: 16` is measured over the whole branch. The 48-07 commits are 362f3b95, 5a82d556, 934f4ef0, 8ea7d555, 58924314 and 5956f228, plus cbcc4eb0, which it shares with 48-08.

## Statements and their rules

| Component, control | Statement (short) | Rules |
|---|---|---|
| workbench ia-05 (tracer) | Theia's key store rebound to the person's own OpenBao KV path with the session token; refusals without a session; plain refusals; the keyring locally, and saving fails rather than using memory | key-store.test.ts: 5 tests (tracer `workbench.ia-05.kv-write`); kv-path.test.ts: 1 |
| workbench sc-12 | Signing only through OpenBao's step-up role after a fresh step-up, with the token revoked after use; data keys use the person's own key-encryption key; none in local mode | key-service.test.ts: 4 |
| workbench ia-02 | OpenBao login only when the token, the email header and the session person agree; someone else's token is ignored; renewal at half lease; revoke on stop | session-identity.test.ts: 5 |
| workbench sc-07 | Backend requests for the page reach only the configured Open VSX address and model server hosts; empty by default; plain http only to loopback | egress.test.ts: 4 |
| workbench sc-13 | Sampled sessions report Node's FIPS provider on (export); the RHEL 9 provider is certificate #5573 (dated record) | deployment `workbench/fips-provider`; documents `docs/security/hosted-verification-records.md` |
| release-pipeline si-07 | Publish waits for container-release approval, checks the tested image, signs and attests that one digest with your organization's key with no transparency log and no keyless signing, then verifies both | workflow-files.test.mjs: 2 |
| release-pipeline cm-08 | Release image CycloneDX SBOM, hash-checked into publish; CI image SBOM, scan and image ID; Grype is report-only | workflow-files.test.mjs: 2 |

Section 10 rows 38, 41 and 42 now name `workbench.sc-13.provider-record`, `workbench.sc-13.fips-provider` and `workbench.sc-12.sign-after-step-up`. Row 40 (the UBI 9 base) keeps G342.

## Workbench conditions still waiting

- **UBI 9 base (row 40), Node major shared with the hub (P11), non-root user and run-time egress.** Only the container suite proves these, and it writes no report (G480; G342 for the base).
- **FIPS provider per session.** It reads missing-result until the reference export lands (G482).
- **Workbench report race.** The compliance job does not wait for the workbench job, so the image SBOM cannot be the `workbench-image` sbom subject, and the workbench report can be missed on a busy run (G481).

## VSIX decision

The VSIX statements are kept. The assessed release still builds the VSIX (`release-content` job), the release image bundles that verified VSIX, and `cm-02_smt` keeps its installer-SBOM observation and limitation.

## Verification

The boundary run, shared with 48-08:
- compliance: 556 of 556 passed.
- validate, resource-check (141 resources), word-lint and the road-to-production check: clean.
- The workflow-files, component-catalogue and resource-check root tests plus the docs-site tests: all passed once the docs-site dependencies were installed.

The workbench unit tests were run locally on Node 26.13.1: 114 of 114 passed. Those rows are the fixture.

Tests added: 2 in contentTracer: the rule targets with fixture rows, and Met, skipped or absent. Both failed on their base first (362f3b95).

## TDD Gate Compliance

- Task 1: RED 362f3b95, then GREEN 5a82d556.
- Task 2 extended existing checks:
  - contentTracer covers every workbench rule.
  - components.test checks every target.
  - bundle.test caught the cm-02 change, and the statement moved to cm-08.

## Deviations from Plan

1. **[Rule 4-avoided] No ci.yml edit.** Task 2 asked the compliance job to read the workbench image SBOM as subject `workbench-image`. That job does not need the workbench job, and a workflow-files test requires it not to. Changing that is an owner decision about the required-check graph, so it is recorded as G481 instead. The plan's acceptance grep `grep -c "workbench-image" .github/workflows/ci.yml` stays at 0.
2. **[Rule 1] The image SBOM statement is on cm-08.** On cm-02 it turned the release-pipeline row from `limitation` to `partly-statements` in bundle.test's fixture. The test was not changed.
3. **Gaps G480 and G481 added** in the reserved block.
4. **Branch and PR.** The plan names `feat/phase-48-statements-workbench`. As instructed, the work is on the shared branch, and no PR was opened.

## Owner checkpoint (Task 3, gate PR 2)

Gate files touched by this plan:
- `compliance/components/workbench.json`
- `compliance/components/release-pipeline.json`
- `compliance/evidence-rules/workbench.json`
- `compliance/evidence-rules/release-pipeline.json`
- `compliance/resources.json` (a register gate file)

Spot-check two statements against the tests they cite: for example workbench sc-12 against key-service.test.ts, and release-pipeline si-07 against workflow-files.test.mjs. Confirm the VSIX decision, then approve the gate check once a PR exists.

## Known Stubs

None.

## Open conditions

- The workbench container suite's results cannot be evidence: image base, user, Node major and run-time egress (G480).
- The UBI 9 base statement waits on that report (G342).
- The compliance job can miss the workbench report, and cannot read the image SBOM as a subject (G481).
- The FIPS provider per session waits on the reference site export (G482).

## Self-Check: PASSED

workbench.json (rules), workbench-report.ndjson and this summary exist. Commits 362f3b95, 5a82d556, 934f4ef0, 8ea7d555, 58924314, 5956f228 and cbcc4eb0 are on HEAD.
