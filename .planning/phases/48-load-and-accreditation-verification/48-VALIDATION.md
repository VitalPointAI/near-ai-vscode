---
phase: "48"
slug: "load-and-accreditation-verification"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-23"
---

# Phase 48 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Seeded from `48-RESEARCH.md` "Validation Architecture"; the planner fills the per-task map.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` through `scripts/run-tests.mjs` (TypeScript by Node 24 type stripping in `compliance/`; `.mjs` in `docs-site/`) |
| **Config file** | none; `npm --prefix compliance ci --ignore-scripts` once per checkout |
| **Quick run command** | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 node scripts/run-tests.mjs <the one mapped test file>` |
| **Full suite command** | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 npm --prefix compliance test`, then the same wrapper on the docs-site and load-test tests (one heavy run at a time) |
| **Estimated runtime** | ~120 seconds |

---

## Sampling Rate

- **After every task commit:** the single mapped test file with the capped wrapper
- **After every plan wave:** `npm --prefix compliance test`, `node scripts/resource-check.mjs`, then docs and load-test tests
- **Before `/gsd-verify-work`:** full suite once, `node compliance/src/cli.ts validate`, a local `bundle` with the real hosted levels, the dashboard JSON inspected for the hosted scope
- **Max feedback latency:** 300 seconds

---

## Per-Task Verification Map

Filled by the planner from the requirement map below.

| Req | Behaviour | Test type | Command (capped wrapper) | Exists |
|-----|-----------|-----------|--------------------------|--------|
| VER-01 | Stage controller holds, bursts, records an unreached stage with its reason | unit, fake service | `node scripts/run-tests.mjs loadtest/test/stages.test.ts` | ❌ W0 |
| VER-02 | Run file hashes canonically, refuses a tampered file, stores the queries; percentiles and start times from object timestamps | unit on fixtures | `node scripts/run-tests.mjs loadtest/test/runfile.test.ts loadtest/test/measure.test.ts` | ❌ W0 |
| VER-03 | Docs check fails on a hand-typed capacity figure and on an unreached stage printed as a number | unit | `node scripts/run-tests.mjs docs-site/test/capacityFigures.test.mjs` | ❌ W0 |
| VER-04 | Every component in `levels.json` has a definition; one responsibility per requirement | unit (edit) | `node scripts/run-tests.mjs compliance/test/levels.test.ts compliance/test/components.test.ts` | ✅ edit |
| VER-05 | Every statement has a rule; every test rule resolves | existing | `node scripts/run-tests.mjs compliance/test/components.test.ts` | ✅ |
| VER-06 | Deployment collector accepts a valid signed export, refuses tampered, unknown-key, oversize or future-dated exports with no observation; derives pass from counts; stale after its window | unit, fixture signer | `node scripts/run-tests.mjs compliance/test/collectorDeployment.test.ts compliance/test/evidenceRules.test.ts` | ❌ W0 |
| VER-07 | Hosted level lists every hosted component; a lapsed export shows Stale | integration on `buildDashboard` | `node scripts/run-tests.mjs compliance/test/dashboard.test.ts` | ✅ edit |
| VER-08 | Each DESIGN 10 condition maps to a statement with a rule or a gap with owner and milestone | unit (edit) | `node scripts/run-tests.mjs compliance/test/gaps.test.ts` | ✅ edit |
| VER-09 | Verification records document is fresh; each open item has a gap with owner and date | existing collector + one assertion | `node scripts/run-tests.mjs compliance/test/collectorDocuments.test.ts compliance/test/gaps.test.ts` | ✅ edit |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Load-test test scaffold (fake Theia Cloud service, fake metrics, fake Kubernetes output)
- [ ] `compliance/test/collectorDeployment.test.ts` with a fixture signer generated in the test (no key material committed)
- [ ] `docs-site/test/capacityFigures.test.mjs`
- [ ] Edit the component id list in `compliance/test/components.test.ts`; levels-reference-real-components assertion in `levels.test.ts`
- [ ] `npm --prefix compliance ci --ignore-scripts`
- [ ] Reconcile component ids with the landed Phase 46 and 47 plans

---

## Manual-Only Verifications

| Behaviour | Requirement | Why manual | Instructions |
|-----------|-------------|------------|--------------|
| Load stages to the HQ target of 400 sessions, then beyond as headroom (revised 2026-11-24, owner) | VER-01, VER-02 | Needs the owner's rig | Run the harness per stage; commit the run file; a stage not reached is recorded as such |
| Traefik, prewarm with volumes, step-up, `kms-pkcs11`, CRL refresh | VER-09 | Rig and HSM hardware | Recorded experiment per item, or a gap with owner and date |
| Gate-path pull requests | VER-04 to VER-07 | Owner approval | Owner checkpoint at the end of each gate plan |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 300s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
</content>
</invoke>
<invoke name="Bash">
<parameter name="command">cd /home/aaron/projects/codequity/near-ai-vscode/.claude/worktrees/agent-a1c201a906117a518 && git add .planning/phases/48-*/48-VALIDATION.md && git commit -q -m "docs(phase-48): add validation strategy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git log --oneline -1 && sed -n 500,600p ~/aspire-home/.claude/gsd-core/workflows/plan-phase.md