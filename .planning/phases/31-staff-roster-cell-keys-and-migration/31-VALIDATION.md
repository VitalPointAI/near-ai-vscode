---
phase: "31"
slug: "staff-roster-cell-keys-and-migration"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-19"
---

# Phase 31: Validation Strategy

> Per-phase validation contract for feedback sampling during execution. The full map is in 31-RESEARCH.md, section "Validation Architecture"; this file is the contract the plans must meet.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` with `node:assert/strict`, compiled by `tsc` to `dist/test/`, run by `scripts/run-tests.mjs` |
| **Config file** | `tsconfig.json` (no separate test config) |
| **Quick run command** | `flock "${HEAVY_LOCK:-/home/aaron/.cache/claude-code-tmp/claude-1000/-home-aaron-projects-codequity-near-ai-vscode/3d22e8c9-071a-44b3-b6fc-358cc97299ea/scratchpad/heavy.lock}" systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'node scripts/vendor-libs.mjs && node node_modules/typescript/bin/tsc -p tsconfig.json && node scripts/run-tests.mjs dist/test/<file>.test.js'` |
| **Full suite command** | `flock "${HEAVY_LOCK:-/home/aaron/.cache/claude-code-tmp/claude-1000/-home-aaron-projects-codequity-near-ai-vscode/3d22e8c9-071a-44b3-b6fc-358cc97299ea/scratchpad/heavy.lock}" systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'node scripts/vendor-libs.mjs && npm test'` |
| **Estimated runtime** | about 30 to 60 s per file; full suite up to 30 min |

---

## Sampling Rate

- **After every task commit:** the task's own compiled test file(s) under the 4G wrapper.
- **After every plan wave:** every `dist/test/replica*.test.js`, `staffReplica*.test.js`, `teamSignedPayload.test.js`, `teamBoundaries.test.js`, `staffRelease.test.js`, `staffLedgerIntegrity.test.js`, `staffBranchLedger.test.js` under the 4G wrapper.
- **Before `/gsd-verify-work`:** full suite once under the 6G wrapper, then `npm run verify:release` once.
- **Immediately blocking:** security, authorization, key handling, data integrity and migration tests in the task that touches them.

---

## Per-Task Verification Map

Filled by the plans. Each requirement maps to at least these files (all new unless marked existing):

| Requirement | Test files |
|-------------|-----------|
| Hardening D-01..D-05 | existing `replicaDoc`, `replicaEquivocation`, `replicaChain`, `replicaReevaluation`, `replicaVersions`, `replicaDecisions`, `replicaVersionDecisions`, `replicaForbiddenActs`, `replicaConvergence`, `replicaIntegration`, `replicaVectors`; new `replicaClientIds`, `replicaCheckpointHeads`, `replicaUpdateGuard`, `staffReplicaWorker` |
| MUS-04 | `replicaRoster`, `replicaRosterSplit`, `replicaInvite`, `replicaSafetyCode`, `replicaRosterTracer` |
| MUS-05 | `replicaCellKeys`, `replicaCellLeak`, `staffReplicaKeyring` |
| MUS-06 | `staffReplicaStore`, `staffReplicaMigration`, `staffReplicaProjection`, `staffReplicaCopy`, `staffReplicaParity`, `staffMultiUserCommands`, `staffMultiUserManifest`; existing staff ledger tests unchanged |
| Boundary | existing `replicaBoundaries` (extended) |

*Status: pending until execution.*

---

## Wave 0 Requirements

- [ ] New test files above are created by the plan that adds the behaviour (test first where the plan is `type: tdd`).
- [ ] `test/helpers/replicaRosterWorld` helper for a real roster stream with lead, deputy and members.
- [ ] `test/fixtures/replica/vectors.json` gains a `checkpointV2` section; old sections byte-identical.
- [ ] Pinned kind counts updated for `invite.void` (extended, not weakened).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Six-word safety code compared by voice between two people | MUS-04 | Human comparison is the control | Two installs, invite and join by file, read the words aloud, admit only when equal |
| Command wording and the rekey sentence read well | MUS-05, MUS-06 | Wording judgement | Turn on the preview setting, run each command, read every message |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency under 120 s per task
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
