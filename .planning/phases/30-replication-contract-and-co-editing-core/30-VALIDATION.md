---
phase: "30"
slug: "replication-contract-and-co-editing-core"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-19"
---

# Phase 30: Validation Strategy

> Per-phase validation contract for feedback sampling during execution. The full test map is in `30-RESEARCH.md`, section "Validation Architecture".

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` with `node:assert/strict`, compiled by `tsc` to `dist/test/`, run by `scripts/run-tests.mjs` |
| **Config file** | `tsconfig.json` (no separate test config) |
| **Quick run command** | `flock "${HEAVY_LOCK:-<scratchpad>/heavy.lock}" systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'node scripts/vendor-libs.mjs && node node_modules/typescript/bin/tsc -p tsconfig.json && node scripts/run-tests.mjs dist/test/replica<Concern>.test.js'` |
| **Full suite command** | the same wrapper around `npm test` (once, at the end of the phase) |
| **Estimated runtime** | about 30 seconds per quick run (16 s type check plus tests); full suite several minutes |

`<scratchpad>` is the planning session's `/home/aaron/.cache/claude-code-tmp/claude-1000/-home-aaron-projects-codequity-near-ai-vscode/3d22e8c9-071a-44b3-b6fc-358cc97299ea/scratchpad`, the default when `HEAVY_LOCK` is unset. An executor in another session sets `HEAVY_LOCK` to its own session's `heavy.lock` and runs `mkdir -p "$(dirname "$HEAVY_LOCK")"` before the first heavy run. One heavy run at a time per machine.

---

## Sampling Rate

- **After every task commit:** the task's own `dist/test/replica<Concern>.test.js` file
- **After every plan wave:** `dist/test/replica*.test.js`, `teamSignedPayload.test.js`, `teamBoundaries.test.js`, `staffRelease.test.js`
- **Before `/gsd-verify-work`:** full suite green, then `npm run verify:release` once under the wrapper
- **Max feedback latency:** about 60 seconds

---

## Per-Task Verification Map

Filled by the planner from the plans; the exact commands are in each PLAN.md `<verify>` block (all inside the wrapper above, after `node scripts/vendor-libs.mjs` and `tsc`). Requirement coverage: MUS-01 (entry, kinds, chain, equivocation, order, checkpoint, convergence tests), MUS-02 (vendor, doc, attribution, boundary tests), MUS-03 (versions and decisions tests).

| Task | Plan | Wave | Requirement | Test type | Test files run | Threat refs |
|------|------|------|-------------|-----------|----------------|-------------|
| 30-01 T1 | 01 | 1 | MUS-02 | pin gate (registry) + unit | pin gate one-liner; replicaVendor | T-30-02, T-30-03, T-30-SC |
| 30-01 T2 | 01 | 1 | MUS-02 | unit (hashes, teeth) | replicaVendor, staffCopSymbols | T-30-01 |
| 30-01 T3 | 01 | 1 | MUS-01, MUS-02 | unit + release check | teamSignedPayload, replicaVendor; `npm run verify:release` | T-30-04, T-30-05 |
| 30-02 T1 | 02 | 2 | MUS-01, MUS-02 | tracer, end to end; type check before each of six layer commits | replicaTracer, teamSignedPayload | T-30-06, T-30-08 |
| 30-02 T2 | 02 | 2 | MUS-01 | unit (fail-closed family schema files) | replicaContracts, replicaTracer | T-30-09 |
| 30-02 T3 | 02 | 2 | MUS-01, MUS-02 | unit | replicaContracts, replicaTracer | T-30-09 |
| 30-03 T1 | 03 | 2 | MUS-02 | spike script (small) | crdt-spike.mjs report | T-30-11 |
| 30-03 T2 | 03 | 2 | MUS-02 | spike script (30 pages, 3 seeds) | crdt-spike.mjs report | T-30-11, T-30-12 |
| 30-04 T1 | 04 | 3 | MUS-01 | unit + seeded fuzz | replicaEntry, replicaTracer | T-30-07, T-30-13, T-30-14, T-30-15 |
| 30-04 T2 | 04 | 3 | MUS-01 | unit | replicaKinds | T-30-13, T-30-17 |
| 30-04 T3 | 04 | 3 | MUS-01 | unit | replicaKinds, replicaEntry, replicaTracer | T-30-16 |
| 30-05 T1 | 05 | 3 | MUS-01 | exhaustive permutations (24) | replicaEquivocation, replicaTracer | T-30-18 |
| 30-05 T2 | 05 | 3 | MUS-01 | unit | replicaChain, replicaEquivocation | T-30-19 to T-30-22 |
| 30-05 T3 | 05 | 3 | MUS-01 | unit + permutations | replicaEquivocation, replicaChain | T-30-18 |
| 30-06 T1 | 06 | 3 | MUS-02 | tracer, end to end | replicaAttribution, replicaTracer | T-30-23 |
| 30-06 T2 | 06 | 3 | MUS-02 | unit (hostile updates) | replicaDoc, replicaAttribution | T-30-23 to T-30-26, T-30-28 |
| 30-06 T3 | 06 | 3 | MUS-02 | unit + property (150 seeds) | replicaDoc, replicaAttribution | T-30-27 |
| 30-07 T1 | 07 | 3 | MUS-03 | unit | replicaDecisions | T-30-29 |
| 30-07 T2 | 07 | 3 | MUS-03 | table rows under all permutations | replicaDecisions | T-30-29, T-30-30 |
| 30-08 T1 | 08 | 3 | MUS-03 | tracer | replicaVersions, staffRelease | T-30-31 |
| 30-08 T2 | 08 | 3 | MUS-03 | unit | replicaVersions | T-30-31, T-30-32 |
| 30-08 T3 | 08 | 3 | MUS-03 | unit + permutations (24) | replicaVersions, staffRelease, replicaTracer | T-30-33, T-30-34 |
| 30-09 T1 | 09 | 3 | MUS-01 | tracer | replicaOrder, replicaTracer | T-30-37 |
| 30-09 T2 | 09 | 3 | MUS-01 | property (200 seeds) + unit | replicaOrder, replicaCheckpoint | T-30-35, T-30-36, T-30-38 |
| 30-09 T3 | 09 | 3 | MUS-01 | property (200 seeds) | replicaOrder, replicaCheckpoint, replicaTracer | T-30-37 |
| 30-10 T1 | 10 | 4 | MUS-03 | tracer | replicaVersionDecisions, replicaVersions, staffRelease | T-30-39 |
| 30-10 T2 | 10 | 4 | MUS-03 | every 15.4 and 15.5 row and forbidden act | replicaVersionDecisions, replicaForbiddenActs, replicaVersions, replicaDecisions | T-30-39 to T-30-42 |
| 30-10 T3 | 10 | 4 | MUS-03, MUS-02 | unit | replicaVersionDecisions, replicaForbiddenActs, replicaVersions, staffRelease | T-30-39 |
| 30-11 T1 | 11 | 4 | MUS-01 | canonical vectors | replicaVectors; secret scan | T-30-43, T-30-45 |
| 30-11 T2 | 11 | 4 | MUS-01, MUS-02 | boundary with teeth | replicaBoundaries, teamBoundaries | T-30-44 |
| 30-12 T1 | 12 | 5 | MUS-01, MUS-02, MUS-03 | tracer, integration | replicaIntegration, replicaTracer | T-30-46 |
| 30-12 T2 | 12 | 5 | MUS-01 | property (200 + 50 seeds) + quarantine crossed with checkpoint refold | replicaConvergence, replicaVectors | T-30-46, T-30-47, T-30-49 |
| 30-12 T3 | 12 | 5 | all | full suite once, release once | `npm test`; `npm run verify:release`; secret scan | T-30-48 |

DESIGN 15.4 and 15.5 coverage: rows 1 to 5 (G1 to G5) and forbidden act F8 in `replicaVersions.test.ts` (30-08); rows 6 to 11 (G6 to G11), G12 (terminal) and forbidden acts F1 to F9 in `replicaVersionDecisions.test.ts` and `replicaForbiddenActs.test.ts` (30-10); every 15.5 transition abstractly under all permutations in `replicaDecisions.test.ts` (30-07, rows D1 to D24 except D21) and through the fold with signed entries in `replicaVersionDecisions.test.ts` (30-10, including D21).

---

## Wave 0 Requirements

- [ ] `src/test/replica*.test.ts` files (none exist yet)
- [ ] `test/fixtures/replica/vectors.json` and its fixed-IV generator (test only)
- [ ] one shared test world builder (`src/test/helpers/replicaWorld.ts`), reusing `mulberry32` from `src/test/helpers/teamEvents`
- [ ] `scripts/crdt-vendor.json` and the `verify-release-content.mjs` check

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| lib0 and yjs versions confirmed before the first install | MUS-02 | Supply-chain choice; the install touches the shared `node_modules` | Automated by the owner's instruction: plan 30-01 Task 1 runs a blocking pin gate on the npm registry (range, 14-day age, no install scripts, integrity) before `npm install` and stops on any failure; no manual step remains |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
