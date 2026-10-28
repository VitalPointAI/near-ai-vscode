---
phase: "13"
slug: "sovereignty-gate-post-quantum-cryptography-and-the-encrypted"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-28"
---

# Phase 13 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | node:test + node:assert/strict (e2e: @vscode/test-electron) |
| **Config file** | none — tsconfig.json compiles src/** to dist/; tests are dist/test/*.test.js |
| **Quick run command** | `npx tsc -p tsconfig.json && node --test dist/test/<file>.test.js` |
| **Full suite command** | `npm test` (then `npm run test:e2e` once at phase gate) |
| **Estimated runtime** | ~10 s type check + per-file run; full suite several minutes |

---

## Sampling Rate

- **After every task commit:** Run `npx tsc -p tsconfig.json && node --test` of the touched test files
- **After every plan wave:** Run all `dist/test/kb*.test.js`, `teeGatedClient`, `pqcKats` plus existing suites touching changed seams
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 13 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| (filled by planner) | — | — | SOV-01..06, LOG-01..04, PQC-01..03 | — | see 13-RESEARCH.md § Validation Architecture test map | unit/integration | per RESEARCH test map | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `scripts/entries/pq.mjs` + `scripts/vendor-libs.mjs` bundle + `scripts/verify-release-content.mjs` required entries + exact-pinned devDependencies
- [ ] `src/test/helpers/networkSpy.ts`, `canaryScan.ts`, `fakeNearServer.ts`, `fakeMemento.ts`, shared `MemorySecrets`
- [ ] Test files: kbMode, teeGatedClient, kbSendPath, kbWebSwitch, kbPlaintext, kbGeneration, kbLog, kbFold, kbEnvelope, kbVerify, pqcKats, kbErasure, kbIdentity, kbNetwork, memoryExport, shellSensitive
- [ ] Committed KAT fixtures: X-Wing vector 1; phrase -> fingerprint; seed -> public-key hashes
- [ ] Envelope freeze decision record before envelope/segment code lands

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Crypto + e2e on VS Code 1.101.0 engine floor | PQC-01 | needs floor-version VS Code download | run `npm run test:e2e` against 1.101.0 once at phase gate |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 13s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
