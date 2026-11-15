---
phase: "69"
slug: "team-mode-reconciliation-identities-and-signed-events-on-main"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-15"
---

# Phase 69 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: 69-RESEARCH.md "Validation Architecture".

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` on compiled JS (Node 24), run by `scripts/run-tests.mjs` |
| **Config file** | none; `tsconfig.json` compiles `src/**/*.ts` to `dist/` |
| **Quick run command** | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npx tsc -p tsconfig.json && node --test dist/test/<file>.test.js'` |
| **Team group command** | same wrapper, `node --test --test-concurrency=2` over the `dist/test/team*.test.js` files the phase owns (explicit list, never a glob); `teamConcurrency`, `teamSharedMirror` and `teamMirrorIsolation` each alone with `--test-concurrency=1` |
| **Full suite command** | `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npm run lint && npm test'` |
| **E2E command** | `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env -u WAYLAND_DISPLAY -u WAYLAND_SOCKET npm run test:e2e` (xvfb via the script) |
| **Estimated runtime** | quick ~60 s (compile plus one file); team group ~5 min; full suite ~20 min |

---

## Sampling Rate

- **After every task commit:** the test file or small group the task touched (quick command).
- **After every plan wave:** the team group command plus the isolation test, one heavy run at a time.
- **Before `/gsd-verify-work`:** full suite, e2e, `npm run verify:release` and `node scripts/secret-scan.mjs --range origin/main..HEAD`, once.
- **Max feedback latency:** 300 seconds for a task-level check.
- Security checks (secrets canary, forgery, permission matrix, mirror isolation, payload signer) block immediately whenever touched.

---

## Per-Task Verification Map

Filled by the plans' `<verify>` blocks; requirement to test mapping:

| Requirement | Behavior | Test Type | Test files | File Exists |
|-------------|----------|-----------|------------|-------------|
| TMR-01 | Archive branch on the remote at 4207080, legacy worktree clean | record check | `git ls-remote origin refs/heads/feat/team-fix-pass`; evidence in `.planning/research/v0.6.0-disposition.md` | ❌ W0 (record) |
| TMR-02 SC1 | Enable Team Mode, key only in SecretStorage, `team.json`-only commit | integration, real git | teamEnable, teamCommands, teamAudit, teamSecrets, teamFile, teamIdentity | ported |
| TMR-02 SC2 | Two clones converge, replay deterministic | integration, property | teamLog, teamMaterialize, teamGitTransport, teamCanonical | ported |
| TMR-02 SC3 | Forged, unbound, under-privileged events rejected both sides with a reason | unit, integration | teamForgery, teamPermissions, teamValidate | ported |
| TMR-02 SC4 | Concurrent appends lose nothing, no force push; two windows on one mirror | process-level | teamConcurrency, teamSharedMirror | ported / from 3e11c0e |
| TMR-02 SC5 | No team file: one `fs.stat`, no timers or storage; scheduler cadence | unit with fakes | teamSoloParity, teamScheduler, teamSession, teamRunGit | ported |
| TMR-02 boundary | No `vscode` import and no new dependency in `src/domain/team`, `src/team` | static | teamBoundaries (new), teamManifest (rewritten, D-27) | ❌ W0 |
| TMR-03 | Solo parity, canary absent from log, `team.json`, settings, audit; full suite green | integration, suite | teamSoloParity, teamEnable canary, full suite, e2e | ported |
| D-11, D-12, D-23 | Team sync and state sync at once: separate mirrors and locks, reserved refs refused | integration, real git | teamMirrorIsolation (new), teamFile ref table | ❌ W0 |
| TMR-04 | Every v0.6.0 phase and requirement has a disposition; TM- prefixes; links | static doc check | teamDisposition (new) | ❌ W0 |
| TMR-05 sign/verify | Round trip per purpose, domain separation, tamper, version, never throws, implicit account id | unit, fuzz | teamSignedPayload (new) | ❌ W0 |
| TMR-05 key status | Active, rotated, revoked, unknown; verifier honours them with plain messages | unit | teamKeyStatus (new) | ❌ W0 |
| TMR-05 device.rotated | Schema, matrix row, transition, positional rejection, snapshot | unit, property | teamValidate, teamPermissions, teamMaterialize, teamForgery, teamLog | extended |
| TMR-05 solo key history | Create, rotate, revoke; tampered or truncated history fails closed; lock | unit, process-level | teamKeyHistory (new), teamIdentity | ❌ W0 |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `npm ci` and `npm run compile` in the worktree, inside the memory cap
- [ ] `src/test/helpers/mirrorLockChild.ts` adapted to `acquireFileLock` and `near-ai-team-sync.lock`
- [ ] New test files: `teamBoundaries`, `teamMirrorIsolation`, `teamSignedPayload`, `teamKeyStatus`, `teamKeyHistory`, `teamDisposition`
- [ ] `.planning/research/v0.6.0-disposition.md` skeleton so the doc test has a target

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Archive branch present on GitHub | TMR-01 | Remote state, not suite material | `git ls-remote origin refs/heads/feat/team-fix-pass` prints 4207080ca394d36cf36bbed37b179d8f8400b721; record in the disposition file |
| Enable Team Mode in a real window with preview on | TMR-02 | Real VS Code window UX | Turn on `nearAi.team.preview`, run Enable Team Mode on a scratch repo with a local bare remote, then Verify Team Log |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 300s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
