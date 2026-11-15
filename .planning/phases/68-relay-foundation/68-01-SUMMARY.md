---
phase: 68-relay-foundation
plan: 01
subsystem: infra
tags: [relay, node26, esbuild, jose, healthz, node-http]

requires: []
provides:
  - relay/ workspace with its own manifest, lockfile, tsconfig, .npmrc (engine-strict) and .nvmrc
  - guard entry (dist/bin.mjs) that refuses Node older than 26.13.1 in one plain sentence, then loads dist/app.mjs
  - strict RELAY_HOST, RELAY_PORT, RELAY_STATE_DIR settings (unknown RELAY_* names stop startup)
  - HealthRegistry and GET /healthz with the five D-12 fields, plus --healthcheck
  - single Node version rule (src/nodeVersion.ts) shared by the guard and scripts/check-node.mjs
  - workspace.test and startup.test
affects: [68-02, 68-03, 68-04, 68-05, 68-06, 68-07, 68-08, 71]

actuals:
  tokens: 7600
  tasks: 3
  commits: 2
plan_head_before: 57bad82d2f36abc4f0c723d4f7bdb53e49000e58
plan_head_after: 6dbc3b19353df063f706cf7257242e1f719fcb47

tech-stack:
  added: [jose 6.2.17, "@types/node 26.6.6", typescript 5.9.3, esbuild 0.28.2]
  patterns:
    - guard entry plus bundled app, dynamic import held in a variable
    - closed list of settings, errors name the variable and never echo the value
    - literal route table on node:http, GET-only, no body parsing

key-files:
  created:
    - relay/package.json
    - relay/package-lock.json
    - relay/.npmrc
    - relay/.nvmrc
    - relay/tsconfig.json
    - relay/scripts/build.mjs
    - relay/scripts/check-node.mjs
    - relay/src/bin.ts
    - relay/src/main.ts
    - relay/src/config.ts
    - relay/src/health.ts
    - relay/src/nodeVersion.ts
    - relay/src/http/server.ts
    - relay/test/startup.test.ts
    - relay/test/workspace.test.ts
  modified: []

key-decisions:
  - "D-20 answered by the owner: newest pins, jose 6.2.17 and @types/node 26.6.6 (typescript 5.9.3 and esbuild 0.28.2 unchanged)."
  - "Failed starts exit 1 with no output until plan 02's logger exists (D-11); bin.ts catches a throw from main() and exits 1, while an import failure of app.mjs is left to Node so a broken build stays diagnosable."
  - "Source files import each other without file extensions (module preserve, moduleResolution bundler); only scripts/check-node.mjs imports a .ts file directly."

patterns-established:
  - "Every relay command runs Node 26 by PATH prefix inside the memory cap; nvm install never changes the owner's default."
  - "Old-Node behavior is tested against the real Node 24 binary via NEAR_AI_RELAY_OLD_NODE, never skipped silently."

requirements-completed: [RELAY-01, RELAY-02]

coverage:
  - id: D1
    description: "relay/ installs on Node 26.13.1 with one runtime dependency (jose) and its own lockfile; root manifest and lockfile untouched"
    requirement: RELAY-01
    verification:
      - kind: unit
        ref: "relay/test/workspace.test.ts#package.json keeps one exact runtime dependency, exact dev pins and the engine range"
        status: pass
      - kind: unit
        ref: "relay/test/workspace.test.ts#package-lock.json is lockfile version 3 and its runtime packages are exactly the workspace and jose"
        status: pass
    human_judgment: false
  - id: D2
    description: "Node 24 is refused at install (EBADENGINE) and at start (one plain sentence, exit 1, no SyntaxError)"
    requirement: RELAY-01
    verification:
      - kind: unit
        ref: "relay/test/workspace.test.ts#npm ci under an older Node stops with EBADENGINE because .npmrc sets engine-strict"
        status: pass
      - kind: unit
        ref: "relay/test/workspace.test.ts#an older Node running dist/bin.mjs prints one plain sentence naming Node 26.13.1 and exits 1 without a SyntaxError"
        status: pass
    human_judgment: false
  - id: D3
    description: "A running relay answers GET /healthz with exactly version, uptimeSeconds, teams, signal, inFlightRuns; --healthcheck and SIGTERM behave; nothing is printed"
    requirement: RELAY-02
    verification:
      - kind: integration
        ref: "relay/test/startup.test.ts (6 tests)"
        status: pass
    human_judgment: false

duration: 70min
completed: 2026-11-14
status: complete
---

# Phase 68 Plan 01: Relay workspace tracer Summary

**The `relay/` workspace on Node 26.13.1 with one runtime dependency (jose 6.2.17): a version guard that refuses Node 24 twice over, strict settings, and a node:http server answering GET /healthz with the five D-12 fields.**

## Performance

- **Duration:** about 70 min
- **Completed:** 2026-11-14
- **Tasks:** 3 (1 checkpoint answered by the owner in chat, 1 tracer, 1 TDD)
- **Files created:** 15, all under `relay/`; no root file touched

## Accomplishments

- On Node 26.13.1, `npm ci` in `relay/` installs jose as the only runtime package from `relay/package-lock.json`; the root `package.json` and lockfile are untouched.
- `dist/bin.mjs` checks the Node version and only then imports `dist/app.mjs`. On the real Node 24.22.2 it prints `near-ai-relay needs Node 26.13.1 or a later 26.x release; this is Node 24.22.2. Install Node 26.13.1 and start again.` and exits 1. `npm ci` under Node 24 stops with EBADENGINE.
- GET /healthz returns exactly `inFlightRuns, signal, teams, uptimeSeconds, version`; unknown paths answer 404 without echoing the path; other methods on /healthz answer 405 with `Allow: GET`.
- `--healthcheck` exits 0 against a running relay and 1 when nothing answers; SIGTERM exits 0 well inside 5 seconds. The relay prints nothing to stdout or stderr (D-11 holds until plan 02).
- The Node version rule lives once in `src/nodeVersion.ts`; the guard bundles it, `scripts/check-node.mjs` imports it directly. `npm run lint` (tsc) is clean.

## D-20 checkpoint record (Task 1)

The owner answered in chat on 2026-11-14: "use the newest pair", which is "approved newest": **jose 6.2.17, @types/node 26.6.6** (typescript 5.9.3 and esbuild 0.28.2 unchanged). The read-only registry queries were run before any install in `relay/` (no `relay/` directory existed until Task 2); nothing in them was alarming: every version exists, every `dist.integrity` is present, jose has no dependencies and no install scripts, and its repository is github.com/panva/jose. Output:

```
### 1  npm view jose@6.2.17 version time.6.2.17 dist.integrity repository.url dependencies scripts
version = '6.2.17'
dist.integrity = 'sha512-wOuK9V1yujQFH5S0ZWmLcDZN7+IKh9bUCC2ZPCf2HDlol3WWHy+PPyNjEI75FXRLMp3vDKQcupP59xhVU95hcg=='
repository.url = 'git+https://github.com/panva/jose.git'
(no dependencies, no scripts)
### 2  npm view jose@6.2.15 version time.6.2.15 dist.integrity
version = '6.2.15'
dist.integrity = 'sha512-qdF6ewcZARtef63fJ9AKKZPgxw+t7USH6HLXYcD4CrdmSvDp79rpJSPFEKc90QBeGS63u1KQtN2MZQHC0yDIzA=='
### 3  npm view @types/node@26.6.6 / @types/node@26.6.5  version time dist.integrity
version = '26.6.6'
dist.integrity = 'sha512-MzQj+8Kx3XI40OmUAE6Qoh58ZMNstNNMwn2nfd3qWsfe7nDNSqJNzes4njhz6AHwrSHOffSLwXU6yb474Q4aog=='
version = '26.6.5'
dist.integrity = 'sha512-uMzsv9stDdofIZBx4UGh4Z9ZgXnGC9seRDscilBcTHAeOFk67MZg/k9bWVfO+bk4qZmG+l52hRnLwUiH2LnJTg=='
### 4  typescript@5.9.3 / esbuild@0.28.2
version = '5.9.3'
dist.integrity = 'sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw=='
version = '0.28.2'
dist.integrity = 'sha512-HKVLS8dvII+xoKW9kmqxbRKrnWEXfJJr/FZhhJmiqIB0e053QNYFqOBouTMO/k5sID4MvCiUCvv8b9M4h32wIA=='
scripts.postinstall = 'node install.js'
### publish times (npm view <pkg> time --json)
jose 6.2.15 2026-11-01, 6.2.16 2026-11-08, 6.2.17 2026-11-09T18:41:21Z
@types/node 26.6.5 2026-10-09, 26.6.6 2026-10-28T18:36:36Z
```

The installed lockfile entry for jose is `jose-6.2.17.tgz` with the same integrity as query 1. The `time.<version>` fields printed nothing in the combined `npm view` form, so the publish times came from `npm view <pkg> time --json`.

## Task Commits

1. **Task 1: owner confirms package pins (D-20)** - no commit; answered by the owner in chat, recorded above.
2. **Task 2: tracer, workspace, guard, strict settings, GET /healthz** - `b3ec2d0` (feat)
3. **Task 3: workspace rules, one Node version rule, workspace test** - `6dbc3b1` (feat; written test first, RED confirmed when `src/nodeVersion.ts` did not exist, then green)

**Plan metadata:** committed separately after this summary (docs).

## Verification

All run from the worktree, Node 26.13.1 by PATH prefix, inside `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 ...`.

- Task 2: `sh -c 'cd relay && npm ci && node scripts/build.mjs && node --test dist/test/startup.test.js'` gave 6 pass, 0 fail, 0 skipped.
- Task 3 (with `NEAR_AI_RELAY_OLD_NODE=$HOME/.nvm/versions/node/v24.22.2/bin/node`): `sh -c 'cd relay && npm run lint && node scripts/build.mjs && node --test dist/test/workspace.test.js dist/test/startup.test.js'` gave 17 pass, 0 fail, 0 skipped (workspace.test has 11 tests, so at least 8 passing).
- `sh -c 'cd relay && npm test'` (same variable set): 17 pass, 0 fail, 0 skipped, through the root runner `scripts/run-tests.mjs`.
- The nvm check: `readlink ~/.nvm/current` is `versions/node/v24.22.2`, `~/.nvm/alias/default` is `24`, and `~/.nvm/versions/node/v26.13.1/bin/node -v` is `v26.13.1`, unchanged by `nvm install`.
- `git status --porcelain -- package.json package-lock.json` prints nothing; the only changes outside `relay/` and `.planning/` are none.

## Files Created/Modified

- `relay/package.json`, `relay/package-lock.json` - workspace manifest and lockfile; jose is the only runtime dependency, `allowScripts.esbuild` false
- `relay/.npmrc`, `relay/.nvmrc`, `relay/tsconfig.json` - engine-strict and exact saves, Node 26.13.1, strict type checking with a reserved `@ext/*` alias
- `relay/scripts/build.mjs` - esbuild entries table (guard, app, tests), `--app-only`, version define, fails on warnings
- `relay/scripts/check-node.mjs`, `relay/src/nodeVersion.ts` - the one Node version rule
- `relay/src/bin.ts` - guard entry
- `relay/src/main.ts` - composition root, `runHealthcheck`, signal handling
- `relay/src/config.ts` - strict RELAY_* settings
- `relay/src/health.ts` - HealthRegistry
- `relay/src/http/server.ts` - GET-only server and `listen`
- `relay/test/startup.test.ts`, `relay/test/workspace.test.ts` - tests

## Decisions Made

- D-20 pins as recorded above.
- `bin.ts` is bundled (not transpiled alone) so `nodeVersion.ts` is inlined; the variable import of `./app.mjs` stays a runtime import (build output checked: no esbuild warnings, Node 24 prints the sentence).
- `listen` is given the port from the settings and reports the bound port, so RELAY_PORT=0 works in tests.

## Deviations from Plan

None that change behavior. Small notes:

- `relay/.npmrc` was created in Task 2 with `save-exact=true` so the pinned installs saved exact versions; Task 3 added `engine-strict=true` and the workspace test covers both lines.
- `startup.test.ts` has six tests (the plan asked for at least five); the sixth covers the 404 no-echo and 405 `Allow: GET` behavior the server implements, ahead of plan 02's health test.
- The first attempt to write `startup.test.ts` through a shell heredoc inside the same command as the test run was blocked by a safety check on the command's `rm` text and did not run; the file was written with the Write tool and nothing else changed.
- Commits sit on `feat/messaging-relay`, not an `agent-*` branch, as directed by the caller (no worktree isolation for this run).

## Issues Encountered

None.

## Known Stubs

None. The `teams` and `signal` components report `not-configured` and `inFlightRuns` is a constant 0 by design; plans 04 and later wire real sources into the same registry.

## Threat Flags

None. The HTTP surface (`GET /healthz`) and the RELAY_* settings are the ones in the plan's threat model (T-68-02, T-68-03, T-68-05).

## Next Phase Readiness

Plan 02 adds the redacting logger and connects `createRelayServer`'s `onRejected` hook and the exit paths in `main.ts` to it, plus the health and logging contract tests.

## Self-Check: PASSED

- Created files found: all 15 files under `relay/` listed above exist.
- Commits found: `b3ec2d0`, `6dbc3b1` are ancestors of HEAD.
