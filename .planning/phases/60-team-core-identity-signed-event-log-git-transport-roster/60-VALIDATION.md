---
phase: "60"
slug: "team-core-identity-signed-event-log-git-transport-roster"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-31"
---

# Phase 60 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Derived from 60-RESEARCH.md "Validation Architecture".

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node built-in `node:test` + `node:assert/strict` |
| **Config file** | none (`package.json` scripts `lint`, `test`, `check`, `test:e2e`) |
| **Quick run command** | `npx tsc -p tsconfig.json && node --test dist/test/<file>.test.js` |
| **Team family run** | `npx tsc -p tsconfig.json && node --test dist/test/team*.test.js` |
| **Full suite command** | `npm run check` (lint + full `npm test`) |
| **Estimated runtime** | team family ~30-60 s; full suite a few minutes |

---

## Sampling Rate

- **After every task commit:** `npm run lint` plus the changed module's test file.
- **After every plan wave:** `node --test dist/test/team*.test.js` plus `npm run lint`.
- **Before `/gsd-verify-work`:** `npm run check` green, team tests once under Node 22 (`/usr/bin/node`), `npm run test:e2e` once (command registration), `npm run verify:release` once.
- **Security checks** (signature, permission, forgery, secret canary) are blocking at every wave. Never delete, skip or weaken a failing test to get green.
- **Max feedback latency:** 60 seconds for a task-level check.

---

## Per-Requirement Verification Map

| Requirement | Behavior | Test Type | Automated Command | File Exists |
|-------------|----------|-----------|-------------------|-------------|
| TEAM-04 | Canonical JSON vectors and rejections (floats, -0, undefined, depth, lone surrogate) | unit | `node --test dist/test/teamCanonical.test.js` | ❌ W0 |
| TEAM-04 | Ed25519 identity: generate, store/load, sign/verify, tamper, strict base64url | unit | `node --test dist/test/teamIdentity.test.js` | ❌ W0 |
| TEAM-04 | `reduce`: genesis anchor, bad signature, unbound/revoked device, removed member, Lamport rule, duplicates, unsupported type/`v`, size, non-canonical bytes | unit | `node --test dist/test/teamMaterialize.test.js` | ❌ W0 |
| TEAM-04 | Determinism property (seeded PRNG), incremental vs full, snapshot+tail equals full | property | `node --test dist/test/teamMaterialize.test.js` | ❌ W0 |
| SEC-04 | Full role x action matrix, policy cells, lead cannot act on owner or owner's devices | unit | `node --test dist/test/teamPermissions.test.js` | ❌ W0 |
| SEC-04 | Write-side refusal and read-side rejection use the same decision | integration | `node --test dist/test/teamForgery.test.js` | ❌ W0 |
| TEAM-04 | Two clients on two clones converge; forged events rejected identically and listed | integration (real git) | `node --test dist/test/teamGitTransport.test.js` | ❌ W0 |
| TEAM-04 | Transport behaviours: genesis, existing log, retry with rebuild, conflict, offline/paused, rewritten branch, hooksPath, permanent reject | integration | `node --test dist/test/teamGitTransport.test.js` | ❌ W0 |
| TEAM-04 | Concurrency: N forked clients, every event exactly once, linear history, no force | integration | `node --test dist/test/teamConcurrency.test.js` | ❌ W0 |
| SEC-01 | Secret detector positives and negatives | unit | `node --test dist/test/teamSecrets.test.js` | ❌ W0 |
| SEC-01 | Canary across Enable + roster events: all git objects, team.json, settings, audit, output text | integration | `node --test dist/test/teamEnable.test.js` | ❌ W0 |
| TEAM-01 | Enable preconditions, team.json commit only, no code push, second Enable | integration | `node --test dist/test/teamEnable.test.js` | ❌ W0 |
| TEAM-01 | Solo parity: no timers, storage, status item or channel without team.json | unit | `node --test dist/test/teamSoloParity.test.js` | ❌ W0 |
| TEAM-01 | Existing suite unchanged and green | regression | `npm test` | ✅ |
| SEC-01 | `team-roster` audit mirror, idempotent, rejected never audited | unit | `node --test dist/test/teamAudit.test.js` | ❌ W0 |
| TEAM-04 | Verify Team Log output; sync-paused status with backoff | unit (vscode stub) | `node --test dist/test/teamSession.test.js` | ❌ W0 |
| TEAM-01 | Manifest: commands and `nearAi.team.pollSeconds`; all registered | unit + e2e | `node --test dist/test/teamManifest.test.js`; `npm run test:e2e` at the gate | ❌ W0 |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] The 13 `src/test/team*.test.ts` files above
- [ ] `src/test/helpers/teamHarness.ts` (bare remote + clones, MemorySecrets, client factory, canary scanner, seeded PRNG) and `src/test/helpers/teamAppendChild.ts` (fork target)
- [ ] A fault-injecting git runner for offline, auth and lock-contention cases
- [ ] No framework install needed

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Enable Team Mode against a real hosted remote (GitHub) | TEAM-01 | Needs the owner's real remote and credentials; never automated against real accounts | Owner runs Enable on a scratch repo, then Verify Team Log from a second clone |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
