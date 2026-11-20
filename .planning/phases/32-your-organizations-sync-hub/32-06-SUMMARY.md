---
phase: 32-your-organizations-sync-hub
plan: 06
subsystem: tests
status: complete
tags: [test-hygiene, parity, secret-scan, phase-31-tests]
requires: []
provides:
  - "src/test/helpers/staffReplicaParityChild.ts: runWorkload, staffFiles, TODAY_LAYOUTS, replicaModules and a fork entry (modes workload, detector)"
  - "GENERATED_FIELD_CASES and pathPattern at module scope in src/test/teamSignedPayload.test.ts (32-15 extends them in wave 6)"
affects: [32-10, 32-15]
tech-stack:
  added: []
  patterns: ["module checks in a forked child with execArgv [] and a per-child time limit (the decodeHost pattern)"]
key-files:
  created:
    - src/test/helpers/staffReplicaParityChild.ts
  modified:
    - src/test/staffReplicaParity.test.ts
    - src/test/teamSignedPayload.test.ts
    - src/test/staffReplicaProject.test.ts
    - src/test/staffReplicaMigration.test.ts
    - src/test/staffReplicaKeyring.test.ts
    - .planning/phases/31-staff-roster-cell-keys-and-migration/31-CONTEXT.md
decisions:
  - "The parity child exports replicaModules so the parent's last test reads its own module cache with the same detector the children use."
  - "The generated-fields cases table moved to module scope so the token-shape test reuses every exempt path instead of copying the table."
  - "The stored-key refusal is matched on 'stored encryption key could not be read', so it cannot be satisfied by the different 'new encryption key could not be read back' error."
metrics:
  duration: "about 25 min"
  completed: 2026-11-20
estimate:
  tokens: 50026
  tasks: 2
actuals:
  tokens: 11370
  tasks: 2
  commits: 2
plan_head_before: ffddff863527f3bdb581bc908442b161c3804871
plan_head_after: a5d14fa6d7f1fbec9b7d1a7b76e7a34b077f007b
---

# Phase 32 Plan 06: Test hygiene of the PR #130 review Summary

The parity test's module checks now run in forked child processes and a last test proves the test process loaded no replica module; the random-field exemption is proven against real GitHub-style and OpenAI-style token shapes; Phase 31 sentence assertions match key phrases; 31-CONTEXT.md D-05 records that decoding runs in a forked child.

## Tasks

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Parity module checks in a child; the test process never loads a replica module (D-10) | 8e0272bd | src/test/staffReplicaParity.test.ts, src/test/helpers/staffReplicaParityChild.ts |
| 2 | Real token shapes in random fields (D-11), key-phrase assertions (D-12), D-05 amendment (D-13) | a5d14fa6 | src/test/teamSignedPayload.test.ts, src/test/staffReplicaProject.test.ts, src/test/staffReplicaMigration.test.ts, src/test/staffReplicaKeyring.test.ts, 31-CONTEXT.md |

## What changed

- **Parity (D-10).** runWorkload, its constants, staffFiles, TODAY_LAYOUTS and replicaModules moved to `src/test/helpers/staffReplicaParityChild.ts` (no .test suffix, imports nothing from src/staff/replica). Its fork entry runs only as `require.main`: mode `workload` runs the whole workload, closes the host and replies with the replica modules loaded; mode `detector` loads projection and replies. The test forks it with `execArgv: []`, `stdio: ['ignore', 'ignore', 'pipe', 'ipc']` and a 60 s limit per child; a child that errors, exits without replying or runs past the limit fails the test with its stderr. The in-process `require('../staff/replica/projection')` and the in-process module checks are gone; the file, secret and global-storage checks still run in the test process as before. A new last test checks the test process's own module cache.
- **Token shapes (D-11).** A new test builds `ghp_` plus 36 letters and digits and `sk-` plus 48 base64url characters from parts at run time. Guard: each is refused in a plain field of `grant`. Each signs and verifies at all seven exempt paths ($.labelSealed, $.wraps[1].wrap, $.secret, $.lead.x25519, $.x25519, $.x25519Sig, $.mac) and is refused with the path named at `$.name` of staff-invite and `$.note` of staff-cell-grant.
- **Key phrases (D-12).** Keyring: the three `{ message: '...' }` sentences became regular expressions ("stored encryption key could not be read", "already holds another key.*not replaced", "already has a join secret.*not replaced"). Project: the notice list compares the third line with MULTI_USER_DECLARED_TEXT and matches "declared by the staff lead" and "not verified". Migration: IMPORTED_APPROVAL_TEXT and PROJECTION_LEFT_REASONS['text-changed'] are matched on their load-bearing phrases instead of the whole sentence. Projection test: no whole-sentence assertion found, unchanged. Refusal ids (`refused.refused`, failure reasons) are still compared exactly; none was touched.
- **D-05 amendment (D-13).** One dated line after the D-05 bullet in 31-CONTEXT.md; D-05's own text is byte for byte unchanged (the diff is one added line, no removed line).

## Verification

- Failing first (Task 1): the new last test, run on the unchanged parity file, failed: `the test process loaded a replica module`, actual `[.../dist/staff/replica/projection.js]` (5 pass, 1 fail).
- After Task 1: staffReplicaParity 6 tests, 6 pass.
- Mutation proofs (Task 1, on the compiled child, then restored): the workload child loading projection after close made the first test fail; the child exiting before its reply made both child tests fail with "exited (0) without replying".
- Mutation proof (Task 2, D-66): `$.secret` taken out of GENERATED_PATHS for staff-invite made the token-shape test fail with "Nothing was signed: the payload has a secret-like value at $.secret."; reverted with `git checkout -- src/domain/team/signedPayload.ts`.
- Final focused run (all six files, capped): 132 tests, 132 pass, 0 fail; `npm run lint` exit 0. teamSignedPayload went from 24 to 25 tests.
- Acceptance greps: `require('../staff/replica` in the parity test 0; `staffReplicaParityChild` in the parity test 3; `{ message: '[A-Z]...' }` in the keyring test 0; `D-05 amendment (2026-11-20` 1; `node:worker_threads` 2 (was 1); em-dashes in 31-CONTEXT.md 0 (was 0).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Scope of D-12] Two more whole-sentence assertions in staffReplicaMigration.test.ts**
- **Found during:** Task 2
- **Issue:** The plan's grep (`'[A-Z]...'`) finds only capitalised sentences; two assertions in the migration test pinned whole lower-case sentences (IMPORTED_APPROVAL_TEXT and PROJECTION_LEFT_REASONS['text-changed']).
- **Fix:** Matched on two or three load-bearing phrases each, per the truth "Whole-sentence assertions in ... staffReplicaMigration ... match two or three load-bearing phrases".
- **Files modified:** src/test/staffReplicaMigration.test.ts
- **Commit:** a5d14fa6

## Decisions

- Defaults of 32-CONTEXT.md applied; no checkpoint in this plan. See the frontmatter decisions.

## Files outside the plan's list

None. No product code changed (the GENERATED_PATHS mutation was reverted before commit).

## Known Stubs

None.

## Self-Check: PASSED

- FOUND: src/test/helpers/staffReplicaParityChild.ts
- FOUND: 8e0272bd, a5d14fa6 (ancestors of HEAD)
