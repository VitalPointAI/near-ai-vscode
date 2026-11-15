---
phase: 68-relay-foundation
plan: 08
subsystem: infra
tags: [relay, ci, branch-protection, release-content, phase-gate]

requires:
  - phase: 68-07
    provides: "hardened relay image, Compose project and the npm run test:container suite that the CI job runs"
provides:
  - ".github/workflows/ci.yml: job relay (Node 26.13.1, SHA-pinned actions, no persisted credentials, npm ci --ignore-scripts, audit, lint, tests, container tests)"
  - "scripts/lib/workflow.mjs: CI_CHECKS lists relay, so REQUIRED_CHECKS, the merge gate and the tag gate wait for it"
  - "scripts/verify-release-content.mjs: refuses extension/relay and extension/.dockerignore in the VSIX"
  - "docs/development-workflow.md and CONTRIBUTING.md: relay as the eighth required check, seven CI jobs, branch protection command with relay"
  - "src/test/relayIsolation.test.ts: three more guards (CI job, CI_CHECKS entry, release-content patterns)"
  - "A green phase gate: relay, container, root lint, full root test, verify:release, secret scan"
affects: [69, 71, 75, 76]

status: complete
actuals:
  tokens: 1635
  tasks: 2
  commits: 2
plan_head_before: c14d035c851a9f75dff825b74096b71294d35838
plan_head_after: 2fe6e976ceda86fe800620f2012d78fe85c6779d

tech-stack:
  added: []
  patterns:
    - "Gate and CI-shape facts are asserted by reading ci.yml, workflow.mjs and verify-release-content.mjs as text from the root test suite (the root has no YAML package)"

key-files:
  created: []
  modified:
    - .github/workflows/ci.yml
    - scripts/lib/workflow.mjs
    - scripts/verify-release-content.mjs
    - src/test/relayIsolation.test.ts
    - docs/development-workflow.md
    - CONTRIBUTING.md

key-decisions:
  - "The relay job names its own Node version (26.13.1) and leaves the workflow-level NODE_VERSION '24' for the extension jobs; the relay's own lockfile feeds the setup-node cache."
  - "CHANGELOG.md stays unchanged: nothing user-visible changes in the extension, and the relay is not in the VSIX (verified against the branch's real base, origin/main)."
  - "The plan stops at Task 3 (owner-only): nothing was pushed, no PR opened, no deployment approved, no branch protection changed."

requirements-completed: []

coverage:
  - id: D1
    description: "ci.yml has a relay job on Node 26.13.1 with SHA-pinned actions, persist-credentials false, working directory relay and the six steps; the extension jobs keep NODE_VERSION 24"
    requirement: RELAY-01
    verification:
      - kind: unit
        ref: "src/test/relayIsolation.test.ts#CI runs the relay job on Node 26.13.1 with pinned actions"
        status: pass
      - kind: integration
        ref: "the relay job's steps run locally in CI order on Node 26.13.1: npm ci --ignore-scripts, npm audit (0 vulnerabilities), lint, npm test, npm run test:container"
        status: pass
    human_judgment: false
  - id: D2
    description: "CI_CHECKS includes relay so the merge and tag gates require it, and the existing workflow script tests still pass"
    requirement: RELAY-01
    verification:
      - kind: unit
        ref: "src/test/relayIsolation.test.ts#the merge gates require the relay check"
        status: pass
      - kind: unit
        ref: "scripts/test/workflow.test.mjs, workflow-files.test.mjs, merge.test.mjs (72 tests with relayIsolation, 0 fail)"
        status: pass
    human_judgment: false
  - id: D3
    description: "verify-release-content refuses extension/relay and extension/.dockerignore, and the real npm run verify:release passes on this branch (330 entries, no relay file)"
    requirement: RELAY-01
    verification:
      - kind: unit
        ref: "src/test/relayIsolation.test.ts#the release check refuses relay files in the VSIX"
        status: pass
      - kind: integration
        ref: "npm run verify:release on the real packaged VSIX"
        status: pass
    human_judgment: false
  - id: D4
    description: "The whole phase gate passes and CHANGELOG.md is unchanged on the branch"
    requirement: RELAY-01
    verification:
      - kind: integration
        ref: "npm test --prefix relay (147/147), npm run test:container --prefix relay (10/10), npm run lint, npm test (2064 tests, 2055 pass, 0 fail, 9 environmental skips), npm run verify:release, node scripts/secret-scan.mjs (tracked and range), git diff of CHANGELOG.md against the merge-base with origin/main"
        status: pass
    human_judgment: false
  - id: D5
    description: "The owner approves the agent-review-gates environment for the PR and re-applies main's branch protection with relay as a required check (D-19)"
    requirement: RELAY-01
    verification:
      - kind: manual
        ref: "Task 3 (checkpoint:human-action): the owner answered \"applied\" on 2026-11-15; read-only gh api check of main's branch protection lists relay"
        status: pass
    human_judgment: true
---

# Phase 68 Plan 08: Relay CI job, required check and phase gate Summary

**The relay is now a required CI check (own job on Node 26.13.1, listed in CI_CHECKS), the release check refuses any relay file in the VSIX, and the whole phase gate is green; the owner completed both D-19 steps (PR #50 merged as 052d5cf, `relay` required on main since 2026-11-15).**

## Performance

- **Duration:** about 35 minutes (most of it the relay, container and root suites)
- **Tasks:** 3 of 3 done; Task 3 was the owner's (answered "applied" on 2026-11-15)
- **Files modified:** 6

## Accomplishments

- `ci.yml` gets a `relay` job after `secret-scan`: pinned checkout and setup-node (copied from the lint job), `persist-credentials: false`, `node-version: '26.13.1'`, the relay lockfile as the cache key, `npm ci --ignore-scripts`, `npm audit --omit=dev --audit-level=high`, `npm run lint`, `npm test` and a named step for `npm run test:container`. The workflow-level `NODE_VERSION: '24'`, permissions and concurrency block are untouched, and the header comment lists relay.
- `CI_CHECKS` gets `'relay'` (one word added), so `REQUIRED_CHECKS`, the merge gate and the tag gate now wait for the relay job. The existing workflow script tests needed no change.
- `verify-release-content.mjs` refuses `extension/relay` and `extension/.dockerignore`. The real `npm run verify:release` passes (330 entries).
- Docs: a `relay` row in the gate table, "eight check names", "seven jobs" (slowest is e2e or relay), the other "six" counts changed to seven, a note that relay is the one job not on Node 24, relay in the required-check list in section 8, and `{"context": "relay", "app_id": 15368}` in the branch protection command. `CONTRIBUTING.md` lists relay with the other required jobs.
- `relayIsolation.test.ts` gains three tests (the CI job, the CI_CHECKS entry, the release patterns). The first two were written first and failed (RED) before the CI change.

## Task Commits

1. **Task 1 (tracer): relay CI job and required-check entry** - `4a9c61c` (feat)
2. **Task 2: release-content patterns, docs, phase gate** - `2fe6e97` (feat)
3. **Task 3: owner approval and branch protection** - done by the owner (PR #50 approved and merged as 052d5cf; branch protection re-applied 2026-11-15)

**Plan metadata:** committed separately after this summary (docs).

## Phase gate (run once, after the last code commit, each inside the memory cap)

Wrapper: `systemd-run --user --scope -q -p MemoryMax=4G (6G for the root suite and the container suite) -p MemorySwapMax=0 choom -n 1000 -- timeout 900 (1800 for those two) env NODE_OPTIONS=--max-old-space-size=1536 ...`. Relay commands used `PATH="$HOME/.nvm/versions/node/v26.13.1/bin:$PATH"`; root commands ran on the default Node 24.22.2.

| Step | Command | Result |
| --- | --- | --- |
| Tracer, root tests | `npx tsc -p tsconfig.json && node --test dist/test/relayIsolation.test.js scripts/test/workflow.test.mjs scripts/test/workflow-files.test.mjs scripts/test/merge.test.mjs` | 72 tests, 72 pass, 0 fail |
| Tracer, relay job steps in CI order | `cd relay && npm ci --ignore-scripts && npm audit --omit=dev --audit-level=high && npm run lint && npm test && npm run test:container` | exit 0; audit 0 vulnerabilities; relay 147 tests (144 pass, 3 skipped: the old-Node cases, which need NEAR_AI_RELAY_OLD_NODE); container 10/10 |
| Relay suite | `NEAR_AI_RELAY_OLD_NODE=$HOME/.nvm/versions/node/v24.22.2/bin/node npm test --prefix relay` | 147 tests, 147 pass, 0 fail, 0 skipped |
| Container suite | `npm run test:container --prefix relay` | 10 tests, 10 pass, 0 fail, 0 skipped, 0 cancelled |
| Root lint | `npm run lint` | exit 0 |
| Root full test | `npm test` | 2064 tests, 2055 pass, 0 fail, 9 skipped (environmental: ripgrep and LibreOffice are not installed here) |
| Release content | `npm run verify:release` | "Release content verified: 330 entries, 252 runtime JavaScript files, and 50 required release assets." |
| Secret scan, tracked files | `node scripts/secret-scan.mjs` | clean, 945 tracked files, 8 allow-listed fixtures |
| Secret scan, range | `node scripts/secret-scan.mjs --range "$(git merge-base HEAD origin/main)..HEAD"` | clean, 35 commits |
| CHANGELOG | `git diff --exit-code "$(git merge-base HEAD origin/main)" HEAD -- CHANGELOG.md` | exit 0, unchanged |

Docker: image, container, volume and network lists were taken before the relay and container runs and after; they are identical, no Compose project `near-ai-relay-test` is left and `relay/secrets` does not exist. The packaged `near-ai-vscode-0.4.22.vsix` (git-ignored) was removed by exact name.

## Files Created/Modified

- `.github/workflows/ci.yml`, `scripts/lib/workflow.mjs`, `scripts/verify-release-content.mjs` - gate paths: the PR carrying them waits for the owner's `agent-review-gates` approval
- `src/test/relayIsolation.test.ts`, `docs/development-workflow.md`, `CONTRIBUTING.md`

## Deviations from Plan

### Auto-fixed Issues

None in the code.

### Check made against the right base (not a weakening)

The plan writes `git merge-base HEAD main` for the range secret scan and the CHANGELOG check. This worktree's local `main` is stale (it points at an old docs commit, `6cb73b2`, so the merge-base is `72ebd4e` and the CHANGELOG diff showed the 0.4.20 to 0.4.22 releases the branch already carries from main). Both checks were re-run against `origin/main` (`7fc4f6a`, the branch's real base): the range scan covers 35 commits and is clean, and CHANGELOG.md is unchanged. Both were also run as written, and the range scan passed either way; only the CHANGELOG diff differs, and only because of the stale local ref.

### Notes (not deviations)

- In CI the three old-Node tests in the relay suite will skip (only Node 26.13.1 is installed there); they ran and passed locally with `NEAR_AI_RELAY_OLD_NODE`.
- The gate also rebuilt the relay image from the cached base images, so it needed no pulls and created no Docker objects.

## Issues Encountered

None. All three first-run results were green except the CHANGELOG check against the stale local `main`, explained above.

## Known Stubs

None.

## Threat Flags

None. T-68-30 (gate paths hold the change for the owner's approval; Task 3 is owner-only), T-68-31 (relay is in CI_CHECKS and guarded by a test), T-68-32 (release check refuses the relay paths; verify:release passes), T-68-33 (read-only token, `persist-credentials: false`, SHA pins asserted) and T-68-34 (`npm ci --ignore-scripts`) are mitigated and tested.

## Task 3: answered "applied" (D-19)

No agent approved a deployment or changed branch protection; the owner did both. The owner approved the `agent-review-gates` environment for PR #50, which merged as 052d5cf on 2026-11-15, and then re-applied main's branch protection with `relay` as a required check, answering "applied" the same day.

Confirmed with the read-only check `gh api repos/VitalPointAI/near-ai-vscode/branches/main/protection --jq '[.required_status_checks.checks[] | "\(.context):\(.app_id)"]'`, which returned `lint`, `test`, `e2e`, `release-content`, `audit`, `secret-scan` and `relay` (each app 15368) and `agent-review`. The pending line was removed from STATE.md.

## Next Phase Readiness

The phase is done: the code is merged (PR #50, 052d5cf) and `relay` is a required check on main. Requirements RELAY-01 to RELAY-04 are not ticked here; the orchestrator ticks them.

## Self-Check: PASSED

- Modified files found: `.github/workflows/ci.yml`, `scripts/lib/workflow.mjs`, `scripts/verify-release-content.mjs`, `src/test/relayIsolation.test.ts`, `docs/development-workflow.md`, `CONTRIBUTING.md`.
- Commits found: `4a9c61c`, `2fe6e97` are ancestors of HEAD.
