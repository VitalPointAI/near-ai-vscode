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
| 13-01-T1 | 01 | 1 | PQC-01 | T-13-SC | vendored bundle loads from dist | unit | `npm run compile && node --test dist/test/pqcKats.test.js` | ❌ W0 | ⬜ pending |
| 13-01-T2 | 01 | 1 | PQC-01 | T-13-01, T-13-03 | hybrid AND signature, canonical JSON | unit | same | ❌ W0 | ⬜ pending |
| 13-01-T3 | 01 | 1 | PQC-01 | T-13-02 | X-Wing KAT, key wrap context binding, OpenSSL cross-check | unit | same | ❌ W0 | ⬜ pending |
| 13-02-T1 | 02 | 1 | SOV-01 | T-13-07 | KB record resolves KB; workspace settings ignored | integration | `npx tsc -p tsconfig.json && node --test dist/test/kbMode.test.js` | ❌ W0 | ⬜ pending |
| 13-02-T2 | 02 | 1 | SOV-01 | T-13-05, T-13-06 | marker tamper with real tools, rename, no downgrade | integration | same | ❌ W0 | ⬜ pending |
| 13-03-T1 | 03 | 1 | SOV-02 | T-13-10 | forwarded refused with zero requests; loopback vs LAN | unit | `npx tsc -p tsconfig.json && node --test dist/test/teeGatedClient.test.js` | ❌ W0 | ⬜ pending |
| 13-03-T2 | 03 | 1 | SOV-02 | T-13-09, T-13-11, T-13-12 | reflection test; every gated method; attestation latch | unit | same | ❌ W0 | ⬜ pending |
| 13-03-T3 | 03 | 1 | SOV-02 | T-13-09 | consumers accept ModelClient | type + regression | `npx tsc -p tsconfig.json && node --test dist/test/agentLoop.test.js dist/test/chatSendPath.test.js` | ✅ | ⬜ pending |
| 13-04-T1 | 04 | 1 | SOV-02 (SOV-04 groundwork) | T-13-14 | NetworkSpy + allowlist | integration | `npx tsc -p tsconfig.json && node --test dist/test/kbNetwork.test.js` | ❌ W0 | ⬜ pending |
| 13-04-T2 | 04 | 1 | SOV-01 (S7) | T-13-15 | shell arguments naming secrets ask first | unit + loop | `node --test dist/test/shellSensitive.test.js` | ❌ W0 | ⬜ pending |
| 13-04-T3 | 04 | 1 | SOV-05 (S4) | T-13-16 | memory export defaults outside workspace | unit | `node --test dist/test/memoryExport.test.js` | ❌ W0 | ⬜ pending |
| 13-05-T1 | 05 | 2 | PQC-03 | T-13-20, T-13-21 | identity key file round trip | integration | `npm run compile && node --test dist/test/kbIdentity.test.js` | ❌ W0 | ⬜ pending |
| 13-05-T2 | 05 | 2 | PQC-03 | T-13-18, T-13-19, T-13-22 | lockout with zero generation; restore | integration | same | ❌ W0 | ⬜ pending |
| 13-06-T1 | 06 | 2 | LOG-01, LOG-04 | T-13-23, T-13-24 | freeze record; seal/sign/write/open | integration | `npm run compile && node --test dist/test/kbLog.test.js` | ❌ W0 | ⬜ pending |
| 13-06-T2 | 06 | 2 | LOG-03 | T-13-25, T-13-27 | genesis, keyring, lock, no-clobber | integration | same | ❌ W0 | ⬜ pending |
| 13-06-T3 | 06 | 2 | LOG-03 | T-13-26 | envelope strictness | unit | `node --test dist/test/kbEnvelope.test.js` | ❌ W0 | ⬜ pending |
| 13-07-T1 | 07 | 2 | SOV-02 | T-13-28 | seam requires policy; KB send refusal; spy | host-path | `node --test dist/test/kbSendPath.test.js` | ❌ W0 | ⬜ pending |
| 13-07-T2 | 07 | 2 | SOV-06 | T-13-29, T-13-30 | generation/multimodal/participant gated | host-path | `node --test dist/test/kbGeneration.test.js` | ❌ W0 | ⬜ pending |
| 13-07-T3 | 07 | 2 | SOV-02 | T-13-31 | picker disabled; user-confirmed re-route | host-path | `node --test dist/test/kbSendPath.test.js` | ❌ W0 | ⬜ pending |
| 13-08-T1 | 08 | 3 | LOG-04 | T-13-34 | tampered -> read-only | integration | `npm run compile && node --test dist/test/kbVerify.test.js` | ❌ W0 | ⬜ pending |
| 13-08-T2 | 08 | 3 | LOG-04 | T-13-32, T-13-33 | full tamper matrix | integration | same | ❌ W0 | ⬜ pending |
| 13-09-T1 | 09 | 4 | PQC-02 | T-13-37 | erase destroys key, log verifies | integration | `npm run compile && node --test dist/test/kbErasure.test.js` | ❌ W0 | ⬜ pending |
| 13-09-T2 | 09 | 4 | LOG-01, LOG-02 | — | as known / as happened, shuffle property | unit/property | `node --test dist/test/kbFold.test.js` | ❌ W0 | ⬜ pending |
| 13-09-T3 | 09 | 4 | PQC-02 | T-13-36, T-13-38 | tombstone wins; restored vault refused | integration | `node --test dist/test/kbErasure.test.js` | ❌ W0 | ⬜ pending |
| 13-10-T1 | 10 | 3 | SOV-03 | T-13-41 | switch controls tools in the model request | host-path | `node --test dist/test/kbWebSwitch.test.js` | ❌ W0 | ⬜ pending |
| 13-10-T2 | 10 | 3 | SOV-03, SOV-01 | T-13-40 | status bar + user-only menu | integration | `node --test dist/test/kbStatus.test.js` | ❌ W0 | ⬜ pending |
| 13-10-T3 | 10 | 3 | SOV-01 (D-07) | T-13-43 | chat-header badge | host-path | same | ❌ W0 | ⬜ pending |
| 13-11-T1 | 11 | 4 | SOV-01, PQC-03 | T-13-44, T-13-47, T-13-48 | create with blocking verified export | command | `npm run compile && node --test dist/test/kbCreate.test.js` | ❌ W0 | ⬜ pending |
| 13-11-T2 | 11 | 4 | PQC-03, LOG-04 | T-13-45, T-13-46, T-13-49 | locked/restore/tamper report and rollback | command | `node --test dist/test/kbOpen.test.js` | ❌ W0 | ⬜ pending |
| 13-11-T3 | 11 | 4 | PQC-03, SOV-01 | T-13-45 | KB turns fail closed on a locked base; real-base test fixture | host-path | `node --test dist/test/kbSendPath.test.js dist/test/kbWebSwitch.test.js` | ❌ W0 | ⬜ pending |
| 13-12-T1 | 12 | 5 | PQC-02 | T-13-50, T-13-51 | agent erasure waits for approval | loop | `npm run compile && node --test dist/test/kbEraseFlow.test.js` | ❌ W0 | ⬜ pending |
| 13-12-T2 | 12 | 5 | PQC-02 | T-13-52 | user erasure typed confirmation + notice | command | same | ❌ W0 | ⬜ pending |
| 13-13-T1 | 13 | 5 | SOV-05 | T-13-53, T-13-55 | canary run: transcripts encrypted, activity ids-only | host-path + scan | `npm run compile && node --test dist/test/kbPlaintext.test.js` | ❌ W0 | ⬜ pending |
| 13-13-T2 | 13 | 5 | SOV-05 | T-13-54 | live feed ids/counts, export refused | host-path | same | ❌ W0 | ⬜ pending |
| 13-14-T1 | 14 | 6 | SOV-05 | T-13-57 | .planning write guard | host-path | `npm run compile && node --test dist/test/kbPlaintextSurfaces.test.js` | ❌ W0 | ⬜ pending |
| 13-14-T2 | 14 | 6 | SOV-05 | T-13-58 | sealed handoff; extended canary | host-path + scan | same | ❌ W0 | ⬜ pending |
| 13-15-T1 | 15 | 7 | SOV-05 | T-13-60 | memory off in KB | host-path | `npm run compile && node --test dist/test/kbPlaintextMedia.test.js` | ❌ W0 | ⬜ pending |
| 13-15-T2 | 15 | 7 | SOV-05 | T-13-61 | media sealed at rest; locked refuses | integration | same | ❌ W0 | ⬜ pending |
| 13-15-T3 | 15 | 7 | SOV-05 | T-13-62 | audit redaction; full canary sweep | host-path + scan | same | ❌ W0 | ⬜ pending |

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
