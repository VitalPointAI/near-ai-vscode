---
phase: "25"
slug: "cybersecurity-harness-with-offensive-and-defensive-scanning"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-30"
---

# Phase 25 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` (Node built-in) with `node:assert/strict`, run against `dist/test/*.test.js` |
| **Config file** | none — the runner is invoked from `package.json` scripts; `npm test` compiles with `tsc` first |
| **Quick run command** | `node --test dist/test/cyber*.test.js` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~45 seconds for the cyber subset; ~180 seconds for the full suite |

---

## Sampling Rate

- **After every task commit:** Run `node --test dist/test/cyber*.test.js`
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

> Seeded from the research's requirement→test map. `gsd-planner` refines the task ids and waves; each row must survive into a task's `<verify>`.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 25-XX-01 | — | — | CYBER-01 | — | Target scope resolved and shown before any probe | unit | `node --test dist/test/cyberTargets.test.js` | ❌ W0 | ⬜ pending |
| 25-XX-02 | — | — | CYBER-02 | — | Engagement record immutable once a run starts | unit | `node --test dist/test/cyberEngagement.test.js` | ❌ W0 | ⬜ pending |
| 25-XX-03 | — | — | CYBER-03 | — | Declining the disclaimer leaves the target untouched | unit | `node --test dist/test/cyberDisclaimer.test.js` | ❌ W0 | ⬜ pending |
| 25-XX-04 | — | — | CYBER-04 | — | Malicious target banner cannot steer the run | unit | `node --test dist/test/cyberProtocol.test.js` | ❌ W0 | ⬜ pending |
| 25-XX-05 | — | — | CYBER-05 | — | Unverified finding is labelled, never silently trusted | unit | `node --test dist/test/cyberCritic.test.js` | ❌ W0 | ⬜ pending |
| 25-XX-06 | — | — | CYBER-06 | T-25-01 | Defensive scan finds the seeded issues | unit | `node --test dist/test/cyberDefensive.test.js` | ❌ W0 | ⬜ pending |
| 25-XX-07 | — | — | CYBER-07 | — | Clean target reports no seeded findings | unit | `node --test dist/test/cyberCleanTarget.test.js` | ❌ W0 | ⬜ pending |
| 25-XX-08 | — | — | CYBER-08 | T-25-02 | Offensive scan reaches a verified access proof, then cleans up | integration | `node --test dist/test/cyberOffensive.test.js` | ❌ W0 | ⬜ pending |
| 25-XX-09 | — | — | CYBER-09 | — | Failed exploit reported honestly, never as clean | unit | `node --test dist/test/cyberVerdicts.test.js` | ❌ W0 | ⬜ pending |
| 25-XX-10 | — | — | CYBER-10 | T-25-05 | Stop halts within one tool call; limits enforced | unit | `node --test dist/test/cyberEmergencyStop.test.js` | ❌ W0 | ⬜ pending |
| 25-XX-11 | — | — | CYBER-11 | T-25-03 | Ledger is append-only and tamper-evident | unit | `node --test dist/test/cyberLedger.test.js` | ❌ W0 | ⬜ pending |
| 25-XX-12 | — | — | CYBER-12 | — | SARIF export validates against the schema | unit | `node --test dist/test/cyberSarif.test.js` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/test/cyberTargets.test.ts` — target-kind resolution and scope preview (CYBER-01)
- [ ] `src/test/cyberEngagement.test.ts` — engagement record and immutability (CYBER-02)
- [ ] `src/test/cyberDisclaimer.test.ts` — disclaimer gate, decline path, re-acceptance rules (CYBER-03, D-13/D-18)
- [ ] `src/test/cyberProtocol.test.ts` — step schema, parse repair, bounded retries, incompatibility detection (CYBER-04, D-19)
- [ ] `src/test/cyberCritic.test.ts` — critic verification and unverified labelling (CYBER-05, D-22)
- [ ] `src/test/cyberDefensive.test.ts` — seeded-issue detection (CYBER-06)
- [ ] `src/test/cyberCleanTarget.test.ts` — no false positives on the patched twin (CYBER-07)
- [ ] `src/test/cyberOffensive.test.ts` — exploit path, access proof, cleanup evidence (CYBER-08)
- [ ] `src/test/cyberVerdicts.test.ts` — the four verdicts (CYBER-09, D-24)
- [ ] `src/test/cyberEmergencyStop.test.ts` — stop within one tool call, rate and time limits (CYBER-10)
- [ ] `src/test/cyberLedger.test.ts` — append-only ledger and hash chain (CYBER-11, D-28)
- [ ] `src/test/cyberSarif.test.ts` — SARIF 2.1.0 export and embedded disclaimer (CYBER-12, D-16)
- [ ] `test/fixtures/cyber/vulnerable/` — seeded vulnerable service (missing headers, expired cert, outdated dependency, committed secret, one exploitable weakness)
- [ ] `test/fixtures/cyber/patched/` — the same service with every seeded issue fixed
- [ ] Container-or-temp fixture helper so the offensive tests run where docker/podman is absent (D-08's temp-folder tier)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Container network isolation under WSL | CYBER-08 | WSL networking differs from native Linux; needs a live check | Run an offensive scan against the fixture target on WSL with `docker network --internal`; confirm the sandbox reaches the target and nothing else |
| The twelve regional disclaimers read correctly | CYBER-03, D-14 | Legal prose needs owner review, not a test | Read each regional statement in the panel, confirm region detection from locale, confirm the override |
| Panel is usable in light, dark, and high-contrast themes | CYBER-01 | Visual acceptance | Open the panel in all three themes; confirm the step timeline, findings table, and disclaimer modal remain legible and never rely on colour alone |
| Cleanup proof reflects reality | CYBER-08, D-10 | Requires observing the host after a run | Run an offensive scan, then confirm no container remains (`docker ps -a`), no fixture file is left in the workspace, and the report's cleanup section matches |

*If a manual item becomes automatable mid-phase, move it into the table above and delete it here.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
