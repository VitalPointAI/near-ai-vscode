---
phase: 46-native-theia-foundation
plan: guide-secret-store-readiness
subsystem: workbench
tags: [theia, secret-storage, accessibility, i18n]
status: partial
requires:
  - phase: 46-07
    provides: Startup-selected store status and existing secret operation refusals
  - phase: 46-08
    provides: Standalone Workbench secret probe and Playwright case
provides:
  - Native secret storage setup and limited-mode guidance
affects: [46, 47, 32.1]
tech-stack:
  added: []
  patterns: [Transient Theia bottom panel, bounded backend status check]
key-files:
  modified:
    - workbench/extension/src/browser/secret-store-frontend-module.ts
    - workbench/extension/src/common/secret-store.ts
    - workbench/test/key-store.test.ts
    - workbench/test/e2e/secrets.spec.ts
key-decisions:
  - Use Ordres permanents and Standing Orders in the new guide on the owner's direction.
  - Keep Check again bounded to five seconds and preserve the last confirmed choice after an inconclusive check.
requirements-completed: []
duration: 31min
completed: 2026-11-28
commits: 7
plan_head_before: 9525754fdb7c9f4daab9de56a31aec52f598eeca
plan_head_after: 54680c3bb6b90eeff8dfa4ee3020e7b9f24411f4
integration_base: 2b4d41ac3037ef2c22881f156966ff6304f6a664
---

# Workbench secret storage setup guide summary

**The native guide opens once after the backend confirms that secret storage is unavailable. It explains the supported remedy and the limits of continuing, and stays reachable from the status item and Command Palette.**

The guide opens in the bottom panel, focuses its heading and restores focus on dismissal. It provides English and Canadian French guidance and reuses the internal Documentation command when enabled. An inconclusive check keeps the last confirmed choice explicit. A selected keyring or organization store reports the backend's choice and points out that sign-in and secret operations have their own checks. The guide reads the existing status RPC, and its widget factory rejects restored layout requests.

## Execution

Approved plan SHA-256 `4664fd5e39e69817eee8931b226b85e4ffabb168166b50a4632149967233ff8d` was confirmed before source work. The worktree was fast-forwarded to the pinned base. The owner's Standing Orders wording replaces Governance Rules in the new display and its browser assertion.

| Commit | Work |
|---|---|
| `65378f123` | Tests-first guidance assertions and local Playwright case |
| `315fab0a7` | Native panel, keyboard access, bounded checks and bilingual guidance |
| `7dfb9d38e` | Tests-first delayed confirmation after early dismissal |
| `4c71244a4` | Count only visible confirmed guidance and dispose a widget that failed to attach |
| `2af13e192` | Preserve a named guide landmark within the native Workbench tabpanel |
| `54680c3bb` | Integrate the landed Resource Inventory preview. All four reviewed guide files are byte-identical to `2af13e192`. |

The measured range from the original plan base through the integration merge includes the five guide commits, the landed inventory commit and the local merge. The source diff from the landed inventory base covers four guide files.

## Verification

Added five focused unit cases and extended three existing store-selection cases and the existing local Playwright case.

- RED passed lint and the test build. Seven expected assertions failed and ten checks passed. GSD returned `RED_EVIDENCE_OK`. The named assertion observed no guidance for a confirmed unavailable status with an unfamiliar reason. RED evidence SHA-256 `45672b1884c9c37d5d04fc6b4857022ae22f3d36f62f52306689efa152760e15`.
- Independent review found that closing a manually opened guide during its first check could suppress the automatic guide, and that attachment failure could leave the widget cached. The delayed-check regression produced one expected RED and 17 passes. GSD returned `RED_EVIDENCE_OK`. RED evidence SHA-256 `5edd7a9f308fc231a198d9f1551cd4d740e8bfa7535938eda09e303dcac80d53`. The fix counts a confirmation only when the guide is visible and disposes failed attachments so explicit reopen can retry.
- The full non-container boundary on `4c71244a4` ran 273 checks. It passed 271, including the built frontend bundle boundary check. Two existing real-hub cases skipped because their optional runtime setting was absent. No tests failed.
- The disposable source-preview browser on `4c71244a4` timed out locating the named guide region. DOM inspection confirmed the heading and status item appeared before any manual action. Lumino assigns the widget root its tabpanel role, so the fix names an inner section. The exact landmark fix passed Workbench lint, the test build and all 18 focused key-store checks. Its production build succeeded without network routes.
- The private native source browser passed on `2af13e192`. It verified automatic opening of the named guide, the recovery and capability statements, keyboard dismissal and status-item reopening, recheck, and offline Documentation. Evidence `guide-final/native-guide-verified.log` has SHA-256 `56e142d92ba4f21865fd8e9fe815b678b8f2ac8e18b673a9747bc72a741d22ce`.
- The integrated source `54680c3bb` passed a route-free production build, Workbench lint and the full non-container suite. Of 277 checks, 275 passed and the two optional real-hub cases skipped. Build and suite logs are `integrated-production-build.log` and `integrated-boundary.log` alongside the package manifest.
- The integrated production package uses lock-matched cached dependencies and Node 26.13.1. Its verified 155-file manifest is `workbench/engine/guide-proof.gLhDCEU4/candidate-54680c3bb-manifest.sha256` with SHA-256 `0b44e6c13d3260b90baa022fbe3fba8d5f888ca6ecfb1ce7d60a8ca6dc976a2d`. The Workbench lock SHA-256 is `aa97b95f83b72c140e5a373ac4a7d3e6800ed7a38a271985f08bf25ed0e65044`.
- The user feedback preview now runs the integrated native Workbench package from `54680c3bb`. Its verification covers the recovery interface and offline Documentation. The installed synthetic secret probe and hosted secret operations remain open below.
- Exact diff review covers four source and test paths. The changes use the existing status RPC and internal Documentation command. The guide sends no secret or configuration data.

The first PR CI finished with a passing Workbench job and one root test failure from the user-facing word “Profiles.” The repair says “AI connections” in English and uses the equivalent French wording. Existing copy-lint checks passed 35/35, and the Workbench test and extension TypeScript projects passed. The baseline stayed as recorded. Final local log SHA-256 `f418f0d60e7650a36cdb4437cfa8fd9ed93f4692b7f58bcffd0e73b033ce3d2e`.

## Open conditions

- Exact installed-Workbench Playwright with `SPEC_STEP=unavailable` needs a disposable, no-egress local launch approval covering the candidate, cached Chromium and existing synthetic secret probe. Playwright 1.65.0 pins Chromium Headless Shell 1254 / 158.0.8127.18. The cached binary SHA-256 is `41ff61e6e65b8d16b40631f4f094b46ec02f1a0f5375ae477c1d478f1fc2d89d`. The checked-in probe's package and extension SHA-256 values are `d23270b086fe93f5b32ff9b7b6a6c78b877ce2ab2626b32014365da8568d7575` and `ad28f909bbed6a13abd5c694aad6ca1f2c949fafd63d781eb56bdfba2d17428a`.
- Installed probe refusal, browser layout restoration with a different backend choice, and hosted browser status and secret-operation verification remain open.
- Qualified Canadian French review remains open under G561.

## Self-Check: PASSED

Verified the four scoped source and test files, all five task commits, the local integration merge and all 155 package files.
