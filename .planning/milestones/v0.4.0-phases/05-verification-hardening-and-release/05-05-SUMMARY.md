---
phase: 05-verification-hardening-and-release
plan: 05
subsystem: release-security-documentation
tags: [marketplace, security, provenance, vsix, packaging, privacy]

requires:
  - phase: 05-verification-hardening-and-release
    plan: 03
    provides: Fail-closed wallet boundary, redaction evidence, and explicit provider/TEE limitations.
  - phase: 05-verification-hardening-and-release
    plan: 04
    provides: Immutable persisted ActivityStore attribution and current phase verification findings.
provides:
  - Accurate Marketplace README covering installation, permissions, privacy, sovereignty, TEE qualification, GSD, model/cost transparency, wallet limitation, troubleshooting, and roadmap.
  - Public SECURITY.md trust report with dependency provenance, release evidence, backdoor-oriented review, limitations, and remediation status.
  - Fail-closed VSIX content verification wired to the package script, including runtime JavaScript and Marketplace asset integrity checks.
  - Sanitized repository-local animated GIF demos and explicit development-artifact exclusions.
affects: [marketplace, release, security, packaging, verification]

actuals:
  tokens: 324973
  tasks: 2
  commits: 0

tech-stack:
  added: []
  patterns: [fail-closed VSIX archive verification, repository-local dependency-free GIF generation, qualified public security claims]

key-files:
  created:
    - SECURITY.md
    - scripts/verify-release-content.mjs
    - scripts/generate-marketplace-gifs.mjs
    - docs/marketplace/near-ai-overview.gif
    - docs/marketplace/near-ai-setup.gif
  modified:
    - README.md
    - .vscodeignore
    - package.json

key-decisions:
  - "Keep the README visual links repository-relative and pass --no-rewrite-relative-links because no repository URL is available to this mounted workspace; the actual GIF files are still required in the VSIX."
  - "Exclude nested source maps with **/*.map while retaining every non-test compiled runtime JavaScript module under dist."
  - "Keep the production dependency tree empty and document dev-only tooling separately; no dependency was added."
  - "Do not claim universal TEE, production staking, or configured NEAR account token exchange; document provider-reported and fail-closed states explicitly."
  - "No Git commits were created because the user prohibited commits and the mounted workspace is not a usable Git repository."

patterns-established:
  - "Release verification derives the VSIX name from package metadata, checks required entries, compares current runtime JavaScript to archive entries, and rejects development content."
  - "Security evidence records observed commands and results together with scope and limitations rather than generic assurances."

requirements-completed: [PKG-01, PKG-02, SEC-01, SEC-02, SEC-03, TEST-01]

coverage:
  - id: D1
    description: "Marketplace README and public SECURITY report accurately describe implemented host/provider, privacy, approval, wallet, TEE, and release boundaries."
    requirement: PKG-02
    verification:
      - kind: other
        ref: "README.md and SECURITY.md source review against 05-VERIFICATION.md, src/extension.ts, and implemented host/webview services"
        status: pass
    human_judgment: true
    rationale: "The automated gates verify files and commands, but final Marketplace wording and trust claim judgment remain human-reviewable."
  - id: D2
    description: "The VSIX contains all required runtime and listing assets and excludes development runtime, source, tests, planning, and source-map entries."
    requirement: PKG-01
    verification:
      - kind: other
        ref: "npm run verify:release — 53 VSIX entries, 45 runtime JavaScript files, 7 required assets, zero forbidden entries"
        status: pass
    human_judgment: false
  - id: D3
    description: "Dependency provenance, production audit, lint, full unit tests, packaging, and source-review checks are reproducible without adding dependencies."
    requirement: SEC-03
    verification:
      - kind: other
        ref: "npm ci; npm ls --omit=dev --all; npm audit --omit=dev --audit-level=high; npm run lint; npm test; npm run package"
        status: pass
    human_judgment: false

duration: 10m
completed: 2026-10-26
status: complete
plan_head_before: unavailable
plan_head_after: unavailable
commits: 0
---

# Phase 05 Plan 05: Marketplace Release and Trust Evidence Summary

**Marketplace documentation, public trust evidence, sanitized demos, and fail-closed VSIX content verification are complete without adding runtime dependencies.**

## Performance

- **Duration:** Approximately 10 minutes.
- **Started:** 2026-10-26T02:38:00Z.
- **Completed:** 2026-10-26T02:48:22Z.
- **Tasks:** 2 completed.
- **Files modified:** 9 repository files, plus the generated VSIX release artifact.

## Accomplishments

- Replaced the development README with a Marketplace-ready listing grounded in the actual extension commands, host/webview boundary, SecretStorage behavior, privacy preflight, approval policy, model/cost telemetry, TEE qualification, wallet limitation, troubleshooting, and roadmap.
- Added `SECURITY.md` with explicit permissions, outbound data boundaries, no-local-credential-file scope, wallet/API-key separation, dependency resolution/integrity evidence, source-review results, reproducible gates, limitations, and remediation status.
- Added two sanitized animated GIFs generated by a dependency-free repository-local Node script and linked them from the README.
- Added `.codex/**`, `.agents/**`, nested source-map, source/test/planning, lockfile, and script exclusions while preserving the manifest, README, license, compiled runtime JavaScript, SECURITY report, and Marketplace assets.
- Added `npm run verify:release`, which packages the current extension and fails closed on missing required assets, missing compiled runtime modules, or development entries in the actual VSIX.

## Task Commits

No task or metadata commits were created. The user explicitly prohibited Git commits, and Git reports that the mounted `.git` path is not a usable repository. No repository metadata was initialized and no hashes were fabricated.

1. **Task 1: Trace the documented release contract through VSIX packaging and content verification** — no commit.
2. **Task 2: Add Marketplace visuals and complete dependency/provenance and security evidence** — no commit.

**Plan metadata:** no commit; repository unavailable.

## Files Created/Modified

- `README.md` — Marketplace listing, installation, permissions, privacy, sovereignty, TEE, GSD, cost, wallet, troubleshooting, and roadmap documentation.
- `SECURITY.md` — public trust/security report and observed release evidence.
- `.vscodeignore` — release exclusions for development-only content and nested source maps.
- `package.json` — `verify:release` script and packaging link-rewrite behavior.
- `scripts/verify-release-content.mjs` — required-entry, runtime-module, and forbidden-entry archive verifier.
- `scripts/generate-marketplace-gifs.mjs` — dependency-free local generator used for sanitized demo assets; excluded from the VSIX.
- `docs/marketplace/near-ai-overview.gif` — chat/activity operational-transparency demo.
- `docs/marketplace/near-ai-setup.gif` — setup/privacy/approval/wallet-limitation demo.
- `near-ai-vscode-0.1.0.vsix` — regenerated release candidate artifact.

## Verification and Security Evidence

- `npm ci` — passed after a network-restricted first attempt failed with `EAI_AGAIN`; the escalated lockfile-only retry installed 290 packages. npm reported two high-severity findings in the complete development tree; the production-only gate below passed.
- `npm ls --omit=dev --all` — passed with an empty runtime dependency tree.
- `npm audit --omit=dev --audit-level=high` — passed: `found 0 vulnerabilities`.
- `npm run lint` — passed.
- `npm test` — passed: 29 test files, 29 passed, 0 failed, 0 skipped/todo.
- `npm run package` — passed with `--no-rewrite-relative-links` and produced the release VSIX.
- `npm run verify:release` — passed independently: 53 archive entries, 45 runtime JavaScript files, 7 required assets, zero `.codex`, planning, source-map, or test entries.
- Backdoor-oriented scans found no `eval`, `new Function`, VM evaluation, or `shell: true`; expected GSD process execution uses explicit argv and `shell: false`.
- Credential-file scans found only denylist/negative-test references to `.near-credentials`; no wallet filesystem reader or mutation path was introduced.
- GIF validation confirmed both assets are valid animated 480×300 GIFs (3 and 4 frames).

## Decisions Made

- Documentation claims remain qualified to repository evidence: provider-reported TEE status is not independent attestation, and staking/account sign-in remain explicitly unavailable or prepared-only.
- No dependency was added. Release verification uses Node standard-library filesystem/child-process APIs plus a dependency-free ZIP central-directory fallback for runtimes where spawning `unzip` is sandbox-blocked.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Made packaging compatible with repository-local README images**
- **Found during:** Task 1.
- **Issue:** `vsce package` failed because no repository URL is available to rewrite relative Marketplace image links.
- **Fix:** Added `--no-rewrite-relative-links` to the package script so the repository-local GIF links remain intact and the actual assets are still verified in the archive.
- **Files modified:** `package.json`.
- **Verification:** `npm run package` and `npm run verify:release` passed.

**2. [Rule 3 - Blocking] Excluded nested source maps and handled sandboxed archive listing**
- **Found during:** Task 1.
- **Issue:** `*.map` did not exclude nested `dist/**/*.map` files, and Node child-process spawning of `unzip` returned `EPERM` in this managed sandbox.
- **Fix:** Added `**/*.map` and implemented a standard-library ZIP central-directory fallback while retaining the local `unzip` child-process path when available.
- **Files modified:** `.vscodeignore`, `scripts/verify-release-content.mjs`.
- **Verification:** Final archive contained zero source maps and the verifier passed with the required runtime/assets checks.

**Total deviations:** 2 auto-fixed blocking issues plus the user-directed no-commit constraint.
**Impact on plan:** All release/security deliverables are complete; no runtime dependency or extension data contract was expanded.

## Known Stubs

- `SECURITY.md:185` — interactive VS Code wallet callback smoke verification remains unavailable because the official callback contract is not supplied. This is an intentional fail-closed limitation already recorded as the Phase 05 `unrun-verify` entry in `.planning/WINDOWS.md`; it does not enable wallet writes or block the archive/documentation goal.

## Threat Surface Review

The plan’s T-05-19 through T-05-22 mitigations are present. The VSIX verifier closes the source/dependency-to-archive boundary; README/SECURITY claims are qualified and evidence-linked; no runtime dependency was added; packaging uses the existing local `vsce`; and the production audit, lint, tests, package, and archive checks pass. No new endpoint, credential path, signing API, or trust claim was introduced.

## Next Phase Readiness

Phase 05 release documentation and archive hygiene are ready for human Marketplace/trust review. The remaining known limitation is the pre-existing official wallet callback/staking configuration gap; production wallet writes remain disabled until verified configuration exists. Git commits remain unavailable in this mounted workspace by user direction and repository state.

## Self-Check: PASSED

- All plan-listed documentation, verifier, ignore-rule, and Marketplace asset paths exist.
- The release candidate VSIX exists and was independently verified with 53 entries, 45 runtime JavaScript files, 7 required release assets, and no `.codex` entries.
- `status: complete` and `commits: 0` are recorded honestly; no Git metadata was fabricated.
- No `~/.near-credentials` file was accessed or modified.

---
*Phase: 05-verification-hardening-and-release*
*Plan: 05*
*Completed: 2026-10-26*
