---
phase: "32"
slug: "your-organizations-sync-hub"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-20"
---

# Phase 32: Validation Strategy

> Per-phase validation contract for feedback sampling during execution. The full map is in 32-RESEARCH.md, section "Validation Architecture"; this file is the contract the plans must meet.

---

## Test Infrastructure

| Property | Extension (Parts A, B and the client pieces of C) | Hub workspace (`hub/`) |
|----------|-------|-------|
| **Framework** | `node:test` with `node:assert/strict`, compiled by `tsc` to `dist/test/`, run by `scripts/run-tests.mjs` | `node:test`, bundled by esbuild to `hub/dist/test/`, run by `../scripts/run-tests.mjs` (as the relay does) |
| **Node** | the extension's CI version | 26.13.1 (needs `node:sqlite`); real-hub client tests live here (D-52) |
| **Quick run** | `flock "$HEAVY_LOCK" systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'node scripts/vendor-libs.mjs && node node_modules/typescript/bin/tsc -p tsconfig.json && node scripts/run-tests.mjs dist/test/<file>.test.js'` | `cd hub && systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env NODE_OPTIONS=--max-old-space-size=1536 npm test` |
| **Full run** | the same wrapper with MemoryMax=6G and timeout 1800, `npm test`, inside `flock "$HEAVY_LOCK"` | `npm test` and `npm run test:container` under the 6G wrapper |

`HEAVY_LOCK` is the shared lock file the executor is given; no test file is ever run with bare `node --test`.

---

## Sampling Rate

- **After every task commit:** the task's own test files under the 4G wrapper, plus lint for the workspace touched.
- **After every wave:** every `replica*`, `staffReplica*`, `staffMultiUser*`, `teamSignedPayload` test (extension), and the whole hub suite once the hub exists (wave 6 on).
- **Once, in 32-28:** the full extension suite, the hub suite with the container test, e2e (`xvfb-run`, results read from the logs), `npm run verify:release` and `npm run smoke:staff`.
- **Immediately blocking:** key handling, label cells and leak tests, append checks, sessions, rollback and equivocation handling, in the task that touches them.

---

## Requirement to test map

| Requirement | Must be shown by | Plans |
|---|---|---|
| Part A (hardening of MUS-04..06) | crash-point Start Again tests; flood bound; copy mark order; id-matched Remove; key-phrase assertions | 32-01..32-07 |
| Part B (MUS-05, MUS-06) | products in label cells; conversion of labelled projects; leak test with canaries for two compartments | 32-08..32-13 |
| MUS-07 | hub workspace, image, Compose, CI job; append checks; sessions; SSE and presence; checkpoints; join through the hub | 32-14..32-25 |
| MUS-08 | the hub witness; malicious-hub harness; restore drill; ciphertext-only byte capture; operator section | 32-16, 32-23, 32-26..32-28 |

Every changed state transition has a test, forbidden transitions included (D-58).
