---
phase: "46"
slug: "native-theia-foundation"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-23"
---

# Phase 46 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: `46-RESEARCH.md`, "Validation Architecture".

`CAP` = `systemd-run --user --scope -q -p MemoryMax=4G choom -n 1000 -- timeout 900`. One heavy run at a time (image build, container suite, Playwright, root compile): heavy runs go under the host-wide lock `flock "$HEAVY_LOCK"`, as each plan's verify block shows.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` through `scripts/run-tests.mjs` (as `hub/`); `@playwright/test` (pinned) for the browser spec |
| **Config file** | `workbench/scripts/build.mjs`, `workbench/test/e2e/playwright.config.ts` (both new, Wave 0) |
| **Quick run command** | `cd workbench && CAP npm test` |
| **Full suite command** | `cd workbench && CAP npm run test:container`, plus `node scripts/resource-check.mjs` and the root `npm test` (copy lint) |
| **Estimated runtime** | quick ~30 s; full ~10 min (image build) |

---

## Sampling Rate

- **After every task commit:** the workbench quick run plus the touched root test file; `node scripts/resource-check.mjs` when a manifest or Dockerfile changed.
- **After every plan wave:** the container suite once, plus `npm run lint` in `workbench/`.
- **Before `/gsd-verify-work`:** root `npm test`, hub and relay suites once, `node scripts/resource-check.mjs`, container suite and Playwright; CI `workbench` job green.
- **Max feedback latency:** 60 seconds for the quick run.

---

## Per-Requirement Verification Map

| Requirement | Behaviour | Test Type | Automated Command | File Exists |
|-------------|-----------|-----------|-------------------|-------------|
| FND-T-01 | Package builds and tests from `workbench/`; build writes only inside it; localhost bind by default; no dev tools in the runtime image | unit + container | `cd workbench && CAP npm test`; `CAP npm run test:container` | ❌ W0 |
| FND-T-01 (src/) | `nearAi.setup` and the compare command return nothing and report a rejection | unit | `CAP npm test` (root, after `npm run compile`) | extend existing |
| FND-T-02 | Refusal crosses the shared RPC helper unchanged; missing engine bundle gives the refusal, not a crash | unit + e2e | as FND-T-01 | ❌ W0 |
| FND-T-03 | KV path encoding never escapes `users/<entity>/`; six key-store methods against a fake OpenBao; no in-memory fallback; secret survives a container restart through `SecretStorage` | unit + container | as FND-T-01 | ❌ W0 |
| FND-T-04 | Sign, wrap, unwrap against dev OpenBao; sign refused with stale or missing `acr`/`auth_time`; refused plainly when the key is missing; no Transit admin calls | unit + container | as FND-T-01 | ❌ W0 |
| FND-T-05 | Identity state machine transitions, timeout and Retry; mismatch and missing header in hosted mode are `failed`; renew, re-login, revoke on stop; token never in RPC results or logs | unit + container | as FND-T-01 | ❌ W0 |
| FND-T-06 | Telemetry off; no gallery; outbound allow-list empty by default; container on an internal network attempts no connection outside it | container | `CAP npm run test:container` | ❌ W0 |
| FND-T-07 | Playwright: Get Started, Team preview round trip, secret restart, no external requests | e2e | `CAP npm run test:container` | ❌ W0 |
| FND-T-08 | `engines.node` `>=26.13.1 <27`; the image reports Node 26 | unit + container | as FND-T-01 | ❌ W0 |
| FND-T-09 | Digest-pinned `FROM` lines; non-empty CycloneDX SBOM; Grype recorded; signing of the published image in the Release workflow's `publish` job (protected `container-release` environment, #165) with a key, never keyless | CI + workflow-file test | `CAP node scripts/run-tests.mjs scripts/test/workflow-files.test.mjs` | extend existing |
| FND-T-10 | Fit check passes with the workbench manifests; copy lint scans the workbench and accepts Sterling and SovAI | unit | `CAP node scripts/resource-check.mjs`; root `CAP npm test` | extend existing |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] First, the evidence gate for D-13/D-34: the image skeleton on UBI 9 minimal with Node 26 opens Get Started with drivelist and node-pty loaded. If it fails, stop and report to the owner.
- [ ] `workbench/scripts/build.mjs`, test scripts in `workbench/package.json`, `workbench/test/helpers/` (fake OpenBao, JWT signer on `node:crypto`, outbound recording hook after `hub/test/noOutbound.test.ts`)
- [ ] `workbench/test/container/*.test.ts`, `workbench/test/e2e/*`, the secret-probe fixture VSIX
- [ ] `@playwright/test` pinned and Chromium installed

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Step-up sign-in through a real Keycloak and oauth2-proxy refreshes `acr` and `auth_time` | FND-T-05 | Needs the Phase 47 stack | In the Phase 47 end-to-end run: sign, see the refusal, confirm with the passkey or security key, sign again |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
</content>
