---
phase: 68-relay-foundation
plan: 03
subsystem: infra
tags: [relay, vsix, vscodeignore, gitignore, isolation, node-test]

requires:
  - phase: 68-01
    provides: "relay/ workspace with its own manifest and lockfile"
provides:
  - ".vscodeignore deny lines relay/** and .dockerignore, proven with the real vsce ls"
  - ".gitignore lines for relay/state/, relay/secrets/ and SQLite files under relay/"
  - "src/test/relayIsolation.test.ts: root test (Node 24) that fails if the relay leaks into the VSIX, the root manifest, the root lockfile or the root compile"
affects: [68-04, 68-07, 68-08]

actuals:
  tokens: 1100
  tasks: 2
  commits: 2
plan_head_before: 414a9b60903564cd9ca21cfa04a5840b2a50d067
plan_head_after: 453b7c5052cee105dff256c32fe59654195e4bb0

tech-stack:
  added: []
  patterns:
    - "Ignore-file lines are pinned by a root test that reads the non-comment lines; the .gitignore rules are also checked with git check-ignore"
    - "Packager behavior is proven against real probe files with vsce ls, not by reading the ignore file alone"

key-files:
  created:
    - src/test/relayIsolation.test.ts
  modified:
    - .vscodeignore
    - .gitignore

key-decisions:
  - "The new .vscodeignore lines were appended after the existing 'Repository workflow files' block, with their own comment line, rather than inside it."
  - "The git-ignore test checks five probe paths (relay.db, relay.db-wal, relay.db-shm, a secrets file, and a .db file in an arbitrary relay subfolder) with git check-ignore."

patterns-established:
  - "Plan 08 adds the CI and release-content assertions to src/test/relayIsolation.test.ts."

requirements-completed: [RELAY-01]

coverage:
  - id: D1
    description: "With relay source, a probe database and a probe secret file present, vsce ls lists package.json and nothing under relay/ or .dockerignore"
    requirement: RELAY-01
    verification:
      - kind: integration
        ref: "vsce ls --no-dependencies probe command from 68-03-PLAN Task 1 (exit 0; baseline listed relay/ paths)"
        status: pass
      - kind: unit
        ref: "src/test/relayIsolation.test.ts#the VSIX ignores relay/ and the root .dockerignore"
        status: pass
    human_judgment: false
  - id: D2
    description: "relay/state/, relay/secrets/ and relay SQLite files cannot be committed"
    requirement: RELAY-01
    verification:
      - kind: unit
        ref: "src/test/relayIsolation.test.ts#relay state and secrets are git-ignored"
        status: pass
    human_judgment: false
  - id: D3
    description: "Root package.json has no workspaces or dependencies, root lockfile has no relay entry, root tsconfig compiles only src/, relay has its own private lockfile and package"
    requirement: RELAY-01
    verification:
      - kind: unit
        ref: "src/test/relayIsolation.test.ts (3 further tests)"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-11-14
status: complete
---

# Phase 68 Plan 03: Extension isolation from relay/ Summary

**The extension is blind to the relay: `.vscodeignore` skips `relay/**` and `.dockerignore`, `.gitignore` covers the relay's state, secret and SQLite files, and a root Node 24 test fails if any of that or the root manifest, lockfile or tsconfig isolation regresses.**

## Accomplishments

- Reproduced Pitfall 3 first: with probe files `relay/state/vsce-probe.db` and `relay/secrets/vsce-probe` in place, `vsce ls --no-dependencies` listed relay paths. After the two `.vscodeignore` lines, the same probe sequence lists `package.json` and no `relay/` or `.dockerignore` line. Probes were removed afterwards.
- `.gitignore` ignores `relay/state/`, `relay/secrets/`, `relay/**/*.db`, `relay/**/*.db-wal`, `relay/**/*.db-shm`; `relay/node_modules`, `relay/dist` and `.env` files were already covered by the unanchored existing lines.
- `src/test/relayIsolation.test.ts` has the five tests named in the plan. It was written first and run red (the `.gitignore` test failed with the relay/state/ message), then green after the `.gitignore` edit. The root `npm test` glob (`dist/test/*.test.js`) picks it up.
- No root `package.json`, `package-lock.json` or `tsconfig.json` change.

## Task Commits

1. **Task 1: tracer, the real VSIX packager lists no relay/ path** - `7073fc3` (feat)
2. **Task 2: git-ignore relay state and secrets, pin the isolation in a root test** - `453b7c5` (test; RED confirmed first, then green)

**Plan metadata:** committed separately after this summary (docs).

## Verification

Root commands on the default Node 24, each inside `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 ...`.

- `npm ci` at the root (committed lockfile, nothing added): succeeded. It warned that three packages have install scripts not covered by allowScripts (vsce-sign, esbuild, keytar); no config change was made.
- Task 1 verify command (`mkdir probes; L=$(npx vsce ls --no-dependencies) ...`): exit 0. Baseline run before the edit listed `relay/` paths.
- Task 2 verify: `sh -c 'npx tsc -p tsconfig.json && node --test dist/test/relayIsolation.test.js && git check-ignore -q relay/state/relay.db && git check-ignore -q relay/secrets/teams_app_secret && git check-ignore -q relay/state/relay.db-wal'`: exit 0, 5 tests, 5 pass, 0 fail.
- `npm run lint` (root, `tsc --noEmit`): clean.
- Acceptance greps: `grep -cx 'relay/\*\*' .vscodeignore` is 1; `.dockerignore` line is 1; `relay/state/` and `relay/secrets/` lines in `.gitignore` are 1 each; probe files are gone; `git status --porcelain -- package.json package-lock.json tsconfig.json` prints nothing.
- The full root suite and the relay suite were not re-run: this plan touches only two ignore files and one new root test, and no relay file. The full root suite runs at the phase boundary.
- `.planning/config.json` and `.planning/state.json` were not committed.

## Files Created/Modified

- `.vscodeignore` - comment, `relay/**`, `.dockerignore`
- `.gitignore` - comment and five relay lines
- `src/test/relayIsolation.test.ts` - five node:test cases, helper `nonCommentLines(file)`

## Deviations from Plan

None - plan executed exactly as written.

Notes: the `verify-release-content.mjs` pattern for `relay/` stays with plan 08 as the plan states. The `.dockerignore` deny line is in place before plan 07 creates that file.

## Issues Encountered

None.

## Known Stubs

None.

## Threat Flags

None. T-68-06, T-68-07 and T-68-08 are mitigated and tested; T-68-SC held (root `npm ci` from the committed lockfile only).

## Next Phase Readiness

Plan 04 can write to `relay/state/` without risk of committing it. Plan 07 can add the root `.dockerignore` and plan 08 the release-content and CI assertions in the same test file.

## Self-Check: PASSED

- Created file found: `src/test/relayIsolation.test.ts`.
- Commits found: `7073fc3`, `453b7c5` are ancestors of HEAD.
