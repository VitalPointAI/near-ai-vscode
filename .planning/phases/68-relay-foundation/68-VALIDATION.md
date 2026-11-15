---
phase: "68"
slug: "relay-foundation"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-14"
---

# Phase 68 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Derived from `68-RESEARCH.md` "Validation Architecture".

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` + `node:assert/strict` on Node 26.13.1 (relay); root suite stays on Node 24 |
| **Config file** | none; `relay/scripts/build.mjs` bundles `relay/test/**/*.test.ts` to `relay/dist/test/` (Wave 0 installs) |
| **Quick run command** | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 PATH="$HOME/.nvm/versions/node/v26.13.1/bin:$PATH" sh -c 'cd relay && npm run lint && node scripts/build.mjs && node --test dist/test/<file>.test.js'` |
| **Full suite command** | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 PATH="$HOME/.nvm/versions/node/v26.13.1/bin:$PATH" npm test --prefix relay` |
| **Container suite** | `npm run test:container --prefix relay` (Docker; phase gate and CI only) |
| **Estimated runtime** | ~60 seconds (relay unit/integration); container suite a few minutes |

---

## Sampling Rate

- **After every task commit:** relay `npm run lint` plus the changed module's test file (cap wrapper).
- **After every plan wave:** full relay `npm test`; container suite only when Dockerfile, Compose or secrets changed.
- **Before `/gsd-verify-work`:** relay `npm test`, `npm run test:container`, root `npm run lint`, root `npm test`, root `npm run verify:release`, `node scripts/secret-scan.mjs`, all green.
- **Max feedback latency:** 120 seconds.
- Security, secrets, state-directory, kill drill and isolation checks block immediately inside a wave.

---

## Per-Task Verification Map

Filled by the planner per task; the requirement-level map is:

| Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|-----------|-------------------|-------------|--------|
| RELAY-01 | engines `>=26.13.1 <27`, only `jose` as dependency, `engine-strict`, one non-dev lock entry | unit | `node --test dist/test/workspace.test.js` | ❌ W0 | ⬜ pending |
| RELAY-01 | Node guard refuses <26.13.1 and >=27 with a plain message, exit 1 | unit | `node --test dist/test/workspace.test.js` | ❌ W0 | ⬜ pending |
| RELAY-01 | Extension isolation: `.vscodeignore relay/**`, no root workspaces/deps, relay CI job on 26.13.1 | unit (root, Node 24) | root `npm test` (`src/test/relayIsolation.test.ts`) | ❌ W0 | ⬜ pending |
| RELAY-01 | VSIX has no `relay/` entry | build check | root `npm run verify:release` | ✅ (pattern added) | ⬜ pending |
| RELAY-02 | `/healthz` exact five fields, `not-configured` components, no tenant data, 405/404 | integration | `node --test dist/test/health.test.js` | ❌ W0 | ⬜ pending |
| RELAY-02 | spawned `bin.mjs` serves healthz, `--healthcheck` exit 0, SIGTERM exits promptly | integration | `node --test dist/test/startup.test.js` | ❌ W0 | ⬜ pending |
| RELAY-03 | `RelayStore` contract suite on `sqliteStore` | contract | `node --test dist/test/sqliteStore.test.js` | ❌ W0 | ⬜ pending |
| RELAY-03 | kill -9 drill, 15 rounds, acked implies present, no duplicates | integration | `node --test dist/test/killDrill.test.js` | ❌ W0 | ⬜ pending |
| RELAY-03 | state dir 0700, owner/symlink refusal, tighten own too-open dir (D-17), files 0600 | unit | `node --test dist/test/stateDir.test.js` | ❌ W0 | ⬜ pending |
| RELAY-03 | schema migrations once, newer DB refused, stable instance id | unit | `node --test dist/test/schema.test.js` | ❌ W0 | ⬜ pending |
| RELAY-04 | secret loader: file-only sources, mode refusal, plain env refused, name-only errors | unit | `node --test dist/test/secrets.test.js` | ❌ W0 | ⬜ pending |
| RELAY-04 | redacting logger, pseudonym labels (D-18), no console use outside logger | unit | `node --test dist/test/logging.test.js` | ❌ W0 | ⬜ pending |
| RELAY-04 | no-leak run: fake secrets absent from output, state files and listing | integration | `node --test dist/test/noLeak.test.js` | ❌ W0 | ⬜ pending |
| RELAY-04 | container: digest pins, no shell, uid 65532, hardened run healthy, kill/restart keeps state, Compose profile for signal | container | `npm run test:container --prefix relay` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Node 26.13.1 installed through nvm without changing the default (human-verify package pins first, D-20)
- [ ] `relay/` workspace: package.json, lockfile, tsconfig, `.npmrc`, `.nvmrc`, build and check-node scripts
- [ ] `relay/test/contract/relayStore.contract.ts` and `relay/test/fixtures/crashWriter.ts`
- [ ] Root: `src/test/relayIsolation.test.ts`, `.vscodeignore`, `.gitignore`, `.dockerignore`, `verify-release-content` pattern
- [ ] Root `npm ci` on Node 24 in the worktree for root checks

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `relay` added as a required check in branch protection | RELAY-01 (D-19) | Owner-only GitHub setting | Owner runs the `gh api` command the plan gives, after the PR's gate approval |
| Package pins accepted | RELAY-01 (D-20) | Human supply-chain judgement | Owner confirms `jose` and `@types/node` versions at the checkpoint |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
