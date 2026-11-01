---
phase: "60"
slug: "team-core-identity-signed-event-log-git-transport-roster"
status: complete
nyquist_compliant: true
wave_0_complete: true
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

### Phase gate result (plan 60-11)

| Check | Result |
|-------|--------|
| `npm run check` (lint + full `npm test`, existing suite unchanged) | green: 918 tests, 910 pass, 0 fail, 8 skipped (existing live tests) |
| `node --test dist/test/team*.test.js` | green on Node 24.22.2: 348 tests, 0 fail |
| Team suites under the Node 22 floor | not run: this host has only Node 24 and no `/usr/bin/node`; run on a Node 22 machine before release |
| `npm run test:e2e` | green: 7 project and 2 plain scenarios, including "registers every contributed command" with both new commands (run with `DISPLAY=:0` because this host has no `xvfb-run`) |
| `npm run verify:release` | green: 227 entries, `dist/team`, `dist/domain/team` and `dist/services/team` packaged, `dist/test` excluded |
| Solo-parity diffs against the merge base with main | clean: no existing test file modified or deleted, `src/services/chat.ts` and `src/domain/redaction.ts` unchanged, `package.json` dependency maps unchanged, `src/extension.ts` gains one import and one call, no `vscode` import under `src/domain/team` or `src/team` |

---

## Per-Requirement Verification Map

| Requirement | Behavior | Test Type | Automated Command | File Exists |
|-------------|----------|-----------|-------------------|-------------|
| TEAM-04 | Canonical JSON vectors and rejections (floats, -0, undefined, depth, lone surrogate) | unit | `node --test dist/test/teamCanonical.test.js` | ✅ green |
| TEAM-04 | Ed25519 identity: generate, store/load, sign/verify, tamper, strict base64url | unit | `node --test dist/test/teamIdentity.test.js` | ✅ green |
| TEAM-04 | Input validation of names, ids, branches and sizes shared by the write and read sides | unit | `node --test dist/test/teamValidate.test.js` | ✅ green |
| TEAM-04 | `reduce`: genesis anchor, bad signature, unbound/revoked device, removed member, Lamport rule, duplicates, unsupported type/`v`, size, non-canonical bytes | unit | `node --test dist/test/teamMaterialize.test.js` | ✅ green |
| TEAM-04 | Determinism property (seeded PRNG), incremental vs full, snapshot+tail equals full | property | `node --test dist/test/teamMaterialize.test.js` | ✅ green |
| SEC-04 | Full role x action matrix, policy cells, lead cannot act on owner or owner's devices | unit | `node --test dist/test/teamPermissions.test.js` | ✅ green |
| SEC-04 | Write-side refusal and read-side rejection use the same decision | integration | `node --test dist/test/teamForgery.test.js` | ✅ green |
| TEAM-04 | Two clients on two clones converge; forged events rejected identically and listed | integration (real git) | `node --test dist/test/teamGitTransport.test.js dist/test/teamLog.test.js` | ✅ green |
| TEAM-04 | Transport behaviours: genesis, existing log, retry with rebuild, conflict, offline/paused, rewritten branch, hooksPath, permanent reject | integration | `node --test dist/test/teamGitTransport.test.js` | ✅ green |
| TEAM-04 | Concurrency: N forked clients, every event exactly once, linear history, no force | integration | `node --test dist/test/teamConcurrency.test.js` | ✅ green |
| TEAM-01 | `team.json` parse, strict keys, atomic write, trust pin | unit | `node --test dist/test/teamFile.test.js` | ✅ green |
| SEC-01 | Secret detector positives and negatives | unit | `node --test dist/test/teamSecrets.test.js` | ✅ green |
| SEC-01 | Canary across Enable + roster events: all git objects, team.json, settings, audit, output text | integration | `node --test dist/test/teamEnable.test.js` | ✅ green |
| SEC-01 | Canary across the Enable and Verify commands: channel lines, notifications, status bar, storage, settings never written | integration (vscode stub) | `node --test dist/test/teamCommands.test.js` | ✅ green |
| TEAM-01 | Enable preconditions, team.json commit only, no code push, second Enable | integration | `node --test dist/test/teamEnable.test.js` | ✅ green |
| TEAM-01 | Enable and Verify through the UI: questions and defaults, Push only when clicked, quiet cancel, existing team, failures | integration (vscode stub) | `node --test dist/test/teamCommands.test.js` | ✅ green |
| TEAM-01 | Solo parity: no timers, storage, status item or channel without team.json; one `fs.stat`; no team core module loaded | unit (vscode stub) | `node --test dist/test/teamSoloParity.test.js` | ✅ green |
| TEAM-01 | Existing suite unchanged and green | regression | `npm test` | ✅ green |
| SEC-01 | `team-roster` audit mirror, idempotent, rejected never audited | unit | `node --test dist/test/teamAudit.test.js` | ✅ green |
| TEAM-04 | Polling scheduler: intervals, focus, nudge, single flight, backoff to 10 minutes | unit | `node --test dist/test/teamScheduler.test.js` | ✅ green |
| TEAM-04 | Verify Team Log output; sync-paused status with backoff | unit (vscode stub) | `node --test dist/test/teamSession.test.js` | ✅ green |
| TEAM-01 | Manifest: commands and `nearAi.team.pollSeconds`; all registered | unit + e2e | `node --test dist/test/teamManifest.test.js`; `npm run test:e2e` at the gate | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] The `src/test/team*.test.ts` files above
- [x] `src/test/helpers/teamHarness.ts` (bare remote + clones, MemorySecrets, client factory, seeded PRNG), `src/test/helpers/teamCanary.ts` (canary scanners), `src/test/helpers/vscodeStub.ts` (recording vscode stub) and `src/test/helpers/teamAppendChild.ts` (fork target)
- [x] A fault-injecting git runner for offline, auth and lock-contention cases
- [x] No framework install needed

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Enable Team Mode against a real hosted remote (GitHub) | TEAM-01 | Needs the owner's real remote and credentials; never automated against real accounts | Owner runs Enable on a scratch repo, then Verify Team Log from a second clone |
| Team suites under the Node 22 floor | TEAM-04 | Only Node 24 was available on the execution host | Run `node --test dist/test/team*.test.js` with Node 22 before release |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved at the 60-11 phase gate, except the Node 22 team run, which is recorded above as not run on this host.
