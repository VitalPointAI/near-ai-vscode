---
phase: "44"
slug: "accreditation-evidence-and-compliance-dashboard"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-21"
---

# Phase 44: Validation Strategy

> Per-phase validation contract for feedback sampling during execution. The per-requirement test map is in `44-RESEARCH.md`, section "Validation Architecture"; the per-task map is filled from the plans.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` through `node scripts/run-tests.mjs`; `compliance/` TypeScript tests run by Node 24 type stripping; docs-site view tests are `.mjs` |
| **Config file** | `compliance/package.json`, `compliance/tsconfig.json` (created in Wave 1) |
| **Quick run command** | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env NODE_OPTIONS=--max-old-space-size=1536 node scripts/run-tests.mjs compliance/test/<file>.test.ts` |
| **Full suite command** | `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 node scripts/run-tests.mjs compliance/test/*.test.ts docs-site/test/*.test.mjs scripts/test/*.test.mjs` plus `npm --prefix compliance run lint` (collector tests are `compliance/test/collector*.test.ts`, flat, per 44-01's planning choice 4) |
| **Estimated runtime** | about 60 seconds for the compliance suite; the docs build about 5 minutes |

---

## Sampling Rate

- **After every task commit:** the single test file for the changed module, plus `npm --prefix compliance run lint` (`tsc --noEmit`).
- **After every plan wave:** all `compliance/test/**` and `docs-site/test/*`; `scripts/test/*` when a gate script changed; the docs build (capped, `timeout 900`, `--max-old-space-size=2048`) when the site changed.
- **Before verification:** the full suite once, root `npm run lint`, `npm run verify:release` (the VSIX excludes `compliance/` and `docs/security/`), the docs build, then the pinned `oscal-cli` and Trestle import in CI on a real package.
- **Always blocking when touched:** `licenceGate`, `noStatus`, `status`, `redaction`, `overlayIsolation`, `wordLintParity`, `workflow-files`.
- **Max feedback latency:** 60 seconds for a single test file.

---

## Per-Task Verification Map

Filled from the plans' `<automated>` blocks once the plans pass the checker. Each ACCR id maps to at least one test file in `44-RESEARCH.md`, "Phase Requirements to Test Map".

## Validation Audit

2026-11-22. Existing automated tests cover parts of all fourteen requirements. The coverage review found local workflow gaps and live GitHub evidence that fixtures cannot supply. Nyquist sign-off remains pending.

- ACCR-02: The watch CLI fetches registered pages and creates its output directory. The public English and French Medium editions now parse across all 20 selection tables. The generated report records 11 observed selection differences and documents the English HTML ID correction verified against the official English PDF. The first scheduled run is pending.
- ACCR-05 and ACCR-10: The bundle CLI now loads shipped profiles, components, evidence rules, remediation gaps and POA&M milestones. The local CLI regression verifies a populated, manifest-verified Protected B dashboard. Hosted bundle generation and PR comparison remain pending.
- ACCR-09: Main releases and compliance-era hotfixes require verified evidence from successful CI at the tag commit. Hotfixes from bases that predate compliance retain the attested VSIX path. Both routes have local workflow contract coverage. Hosted OSCAL validation, Trestle import, and attestations are pending.
- ACCR-12: The initial hosted checks and repository settings evidence are pending.

---

## Wave 0 Requirements (land in the first wave)

- [ ] `compliance/package.json`, lockfile, `tsconfig.json`, `.npmrc`; `npm --prefix compliance ci --ignore-scripts`
- [ ] Vendored OSCAL 1.2.1 schemas with source address and SHA-256 under `compliance/schemas/`
- [ ] `compliance/test/fixtures/`: synthetic HTML (never copied Government text), a fixture bundle, a fixture test report with a skipped test, a sample organization overlay with marker strings
- [ ] `docs-site/test/` folder
- [ ] The opt-in per-test report (`NEAR_AI_TEST_REPORT`) in `scripts/run-tests.mjs`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Licence records re-read before committing Government text | ACCR-01 | Network and a person's judgement on a changed record | Run the importer's licence check; confirm every record says `ca-ogl-lgo`; stop if not |
| English and French profile selection differences | ACCR-02 | Public editions can diverge | Review the generated import report's differences against the public editions |
| `docs` made a required check | ACCR-12 | Repository setting only the owner can change | Owner adds `docs` to branch protection; the settings collector shows it |
| Package imports into Compliance Trestle | ACCR-09 | Runs in CI on a release, not locally | Check the release workflow's Trestle step on the first tagged release |
| Pages read well in light, dark and high-contrast themes and by keyboard | ACCR-07 | Visual check | Open the Accreditation section on the local docs site |

---

## Local verification on 2026-11-22

- The pinned OSCAL CLI 3.2.0 resolved all eight checked-in profiles after the Medium importer limited alterations to selected controls, the legal catalogues assigned unique part IDs, and Protected A and ITSG-33 retained their imported structure. Seven resolved catalogues also pass the model constraints. The approved IDs-and-titles-only ITSG-33 reference lacks the statement parts required for the eighth.
- A generated, hash-verified bundle refreshed a scratch copy of the production docs build. In Chromium, the Protected B AC-03 drawer linked to the official source, opened its French text, and restored focus when closed. The production build passed private-overlay isolation.
- The root suite reported 6,180 passes, eight skips and one failure when Git encountered a temporary ref lock in the interrupted-push fixture. The failed case passed on its own.
- The GitHub branch-protection read did not list `docs` as a required check. The `compliance-settings` environment lookup returned HTTP 404. These owner controls still require live verification.

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency under 60 s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
