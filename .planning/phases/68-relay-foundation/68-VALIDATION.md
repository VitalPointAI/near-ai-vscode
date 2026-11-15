---
phase: "68"
slug: "relay-foundation"
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-11-14"
validated: "2026-11-15"
open_manual: []
---

# Phase 68: Validation Strategy

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

The requirement-level map, as verified. Counts are from the 2026-11-15 housekeeping run on `fix/relay-housekeeping` (relay on Node 26.13.1 with `NEAR_AI_RELAY_OLD_NODE` set, so the old-Node cases ran rather than skipped); each file was also run on its own to get its count. At phase close the gate record in `68-08-SUMMARY.md` had 147/147 relay tests and 10/10 container tests; the relay suite has since grown to 172 through the PR #50 review fixes and this housekeeping.

| Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|-----------|-------------------|-------------|--------|
| RELAY-01 | engines `>=26.13.1 <27`, only `jose` as dependency, `engine-strict`, one non-dev lock entry, import boundary | unit | `node --test dist/test/workspace.test.js` | ✅ `relay/test/workspace.test.ts` | ✅ green (12/12) |
| RELAY-01 | Node guard refuses <26.13.1 and >=27 with a plain message, exit 1 (real Node 24 via `NEAR_AI_RELAY_OLD_NODE`) | unit | `node --test dist/test/workspace.test.js` | ✅ `relay/test/workspace.test.ts` | ✅ green (in the 12 above) |
| RELAY-01 | Extension isolation: `.vscodeignore relay/**`, no root workspaces/deps, relay CI job on 26.13.1, hotfix-only skip, `CI_CHECKS`, release patterns | unit (root, Node 24) | `npx tsc -p tsconfig.json && node --test dist/test/relayIsolation.test.js` | ✅ `src/test/relayIsolation.test.ts` | ✅ green (10/10) |
| RELAY-01 | VSIX has no `relay/` entry | build check | root `npm run verify:release` | ✅ `scripts/verify-release-content.mjs` | ✅ green (331 entries) |
| RELAY-02 | `/healthz` exact five fields, `not-configured` components, no tenant data, 405/404 | integration | `node --test dist/test/health.test.js` | ✅ `relay/test/health.test.ts` | ✅ green (12/12) |
| RELAY-02 | spawned `bin.mjs` serves healthz, `--healthcheck` exit 0, SIGTERM exits promptly | integration | `node --test dist/test/startup.test.js` | ✅ `relay/test/startup.test.ts` | ✅ green (9/9) |
| RELAY-03 | `RelayStore` contract suite on `sqliteStore` | contract | `node --test dist/test/sqliteStore.test.js` | ✅ `relay/test/sqliteStore.test.ts`, `relay/test/contract/relayStore.contract.ts` | ✅ green (47/47) |
| RELAY-03 | kill -9 drill, 15 rounds, acked implies present, no duplicates | integration | `node --test dist/test/killDrill.test.js` | ✅ `relay/test/killDrill.test.ts` | ✅ green (16/16) |
| RELAY-03 | state dir 0700, owner/symlink refusal, tighten own too-open dir (D-17), files 0600 | unit | `node --test dist/test/stateDir.test.js` | ✅ `relay/test/stateDir.test.ts` | ✅ green (15/15) |
| RELAY-03 | schema migrations once, newer DB refused, stable instance id | unit | `node --test dist/test/schema.test.js` | ✅ `relay/test/schema.test.ts` | ✅ green (8/8) |
| RELAY-04 | secret loader: file-only sources, mode refusal, plain env refused, name-only errors | unit | `node --test dist/test/secrets.test.js` | ✅ `relay/test/secrets.test.ts` | ✅ green (14/14) |
| RELAY-04 | redacting logger, no field overwrites another, no console use outside logger | unit | `node --test dist/test/logging.test.js` | ✅ `relay/test/logging.test.ts` | ✅ green (25/25) |
| RELAY-04 | pseudonym labels stable across restarts (D-18) | unit | `node --test dist/test/pseudonymKey.test.js` | ✅ `relay/test/pseudonymKey.test.ts` | ✅ green (6/6) |
| RELAY-04 | no-leak run: fake secrets absent from output, state files and listing | integration | `node --test dist/test/noLeak.test.js` | ✅ `relay/test/noLeak.test.ts` | ✅ green (8/8) |
| RELAY-04 | container: digest pins, no shell, uid 65532, hardened run healthy, kill/restart keeps state, Compose profile for signal, sidecar pin dates | container | `npm run test:container --prefix relay` | ✅ `relay/test/container/container.test.ts` | ✅ green (10/10) |

Relay total: 172 tests, 172 pass, 0 fail, 0 skipped (`npm test --prefix relay`). In CI the old-Node cases run too: the `relay` job installs Node 24 and sets `NEAR_AI_RELAY_OLD_NODE`.

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] Node 26.13.1 installed through nvm without changing the default (human-verify package pins first, D-20)
- [x] `relay/` workspace: package.json, lockfile, tsconfig, `.npmrc`, `.nvmrc`, build and check-node scripts
- [x] `relay/test/contract/relayStore.contract.ts` and `relay/test/fixtures/crashWriter.ts`
- [x] Root: `src/test/relayIsolation.test.ts`, `.vscodeignore`, `.gitignore`, `.dockerignore`, `verify-release-content` pattern
- [x] Root `npm ci` on Node 24 in the worktree for root checks

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Status |
|----------|-------------|------------|--------|
| `relay` added as a required check in branch protection | RELAY-01 (D-19) | Owner-only GitHub setting | Done 2026-11-15 by the owner. Read-only check `gh api repos/VitalPointAI/near-ai-vscode/branches/main/protection --jq '[.required_status_checks.checks[] \| "\(.context):\(.app_id)"]'`: main requires lint, test, e2e, release-content, audit, secret-scan and relay (all app 15368) and agent-review. |
| Package pins accepted | RELAY-01 (D-20) | Human supply-chain judgement | Done. The owner chose `jose` 6.2.17 and `@types/node` 26.6.6 (recorded in `68-01-SUMMARY.md`). |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 120s (relay suite about 15 s, container suite about 20 s with cached base images)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** every automated row is green and both manual items are done (D-20 at 68-01, D-19 on 2026-11-15).
