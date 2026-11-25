---
phase: 33-live-multi-user-staff-projects
plan: 03
status: complete
subsystem: roster kinds roster.require and hub.readmit, and the feature stop
tags: [staff, replica, roster, post-01, d-04, d-06, d-08, d-42]
requires: [33-18]
provides: [roster.require, hub.readmit, RosterState.required, requireProblem, ensureRequireArmed, REQUIRE_ARMED_FEATURE, PROJECT_REFUSALS_HOST needs-update, ReplicaProjectDeps.knownFeatures, applyHubReadmit, hubReadmitPositions, RosterView.hubPin, RosterView.hubReadmits, readmitWitness, WitnessState.readmitted, MAX_READMITTED, welcomeProjectOf]
affects: [33-07, 33-08, 33-11, 33-21, 33-24]
tech-stack:
  added: []
  patterns: [lead-only linear roster kind, union-only required set, fold stop before any other family, once-per-entry-hash witness clearing]
key-files:
  created:
    - src/staff/replica/requireGate.ts
    - src/test/staffRequireGate.test.ts
    - src/test/replicaRosterRequire.test.ts
    - src/test/replicaHubReadmit.test.ts
  modified:
    - src/domain/replica/kinds.ts
    - src/domain/replica/kindSchemas/roster.ts
    - src/domain/replica/roster.ts
    - src/domain/replica/rosterMembers.ts
    - src/domain/replica/rosterView.ts
    - src/domain/replica/hubWitness.ts
    - src/domain/replica/invite.ts
    - src/staff/replica/replicaProject.ts
    - src/test/replicaTracer.test.ts
    - src/test/replicaRosterTracer.test.ts
    - src/test/replicaProductCells.test.ts
    - src/test/replicaKinds.test.ts
    - src/test/replicaContracts.test.ts
    - src/test/staffReplicaProject.test.ts
    - src/test/staffMultiUserCommands.test.ts
    - src/test/staffReplicaMigration.test.ts
    - src/test/staffReplicaStartAgain.test.ts
requirements: [POST-01, MUS-09]
requirements-completed: []
actuals:
  tokens: 22000
  tasks: 3
  commits: 3
completed: 2026-11-24
plan_head_before: c3b5f70a3491b58049cbe3bcd72250579de55b1c
plan_head_after: 6971900c0f9dcc0875f0e0a4f29a72a8c4f14498
---

# Phase 33 Plan 03: roster.require and hub.readmit Summary

Both new roster kinds are settled in one plan, as D-42 asks. A shared project now requires features through `roster.require`. A computer that lacks a required feature stops the whole shared work with the Sterling update sentence and keeps every entry. The staff lead has a signed `hub.readmit` that clears a fork or rollback finding on members' computers, once per entry.

## Base and branch

The work started from `origin/feat/phase-33-engine-wave-1` (wave 1: 33-05, 33-06, 33-18). `origin/main`, with the native re-plans from #171, was merged in first (`c3b5f70a`), with no conflicts. Another worktree holds the local branch `feat/phase-33-engine-wave-1`, so the work is committed on this agent's worktree branch and pushed with `HEAD:feat/phase-33-engine-wave-1`.

D-01 check: every name the plan reads was found once. `replicaProject.ts` had 1199 lines, not 1173, because waves 1 and 2 had already grown it. See deviation 1.

## Contract choices (reported to the owner)

1. Feature ids are checked only with `isReplicaFeature` from 33-18, through the schema. There is no second pattern. The schema takes 1 to 16 ids that are distinct and sorted, so one set has one wire form. Whether this build knows an id is decided only by `KNOWN_REPLICA_FEATURES`, in `requireGate.ts`.
2. The pin field of `hub.readmit` is `certPin`, the same name `hub.admit` uses. D-42 calls it `pin`. `fromCheckpoint` is an optional 64-hex hash.
3. A `roster.require` whose features are all required already applies as a no-op and keeps its place in the line. Two leads arming at once split the roster like any two roster changes, and the required set is the same whichever branch the chooser picks (tested).
4. `hub.readmit` opens a new version of the hub's record with the new pin. The hub's device, ceiling and cells carry over, and the version is marked `readmit: true`. A revoked hub is refused `hub-revoked`. Its sentence is "Your organization's server was removed from this shared work, so it cannot be trusted again. Admit it again as a new server instead."
5. `readmitWitness` also drops the witness's newest checkpoint and its seen heads. A hub restored from a backup legitimately shows an older copy than before, and the lead compared its pin before re-admitting it. Waiting citations, own waits and the replay count are kept. It remembers at most 64 re-admissions per hub (`MAX_READMITTED`). Past that limit, a new re-admission clears nothing and the lead admits a new hub instead. This fails closed.

## Kind counts

`REPLICA_KINDS` went from 51 to 53, and the roster family from 18 to 20. Non-doc kinds went from 48 to 50, and the project and roster samples in `replicaKinds.test.ts` from 20 to 22. Each count assertion now carries its reason ("roster.require (POST-01) and hub.readmit (D-42), Phase 33").

## replicaProject.ts

It went from 1199 lines to 1196. The architecture rule fails any file above 1200 lines that is not in the frozen baseline, and this file is not in it. So `welcomeProject` (12 lines) moved to `invite.ts` as `welcomeProjectOf`, beside `readWelcome`, before the hook went in. The changes are:
- a `needs-update` refusal whose message is `UPDATE_SENTENCE`;
- `knownFeatures?` in the deps, as the test stand-in for a newer build;
- one `requireProblem` check in `foldNow`, right after the roster fold and before any other family;
- `ensureRequireArmed` after a new genesis and after a reused one (the Pitfall 4 crash path).

## Deviations from Plan

1. **[Rule 3] Line budget.** The D-01 line count differed (1199, not 1173) only because earlier wave work had grown the file. All the names matched, so the plan went ahead. The 1200-line limit was kept by moving `welcomeProject` out, not by touching the architecture baseline.
2. **[Rule 1] The older-client test.** The plan wanted `roster.require` removed from a copy of the kind list. That cannot stand for 0.4.35, because `ROSTER_KIND_OWNER` would still route the kind. 0.4.35 neither lists nor routes it. The test therefore uses a roster-stream kind that no build knows, which this build handles exactly as 0.4.35 handles `roster.require`. It shows the entry kept, the line stalled, and the next roster entry held `roster-prev-not-applied`. It then shows the same line folding through with `roster.require` on this build.
3. **Existing tests that count entries after `createSharedProject`** now count the extra roster entry D-08 writes. None was weakened. Each one names the `roster.require` it now sees:
   - `staffReplicaProject.test.ts`: roster positions in 3 tests, and the next own seq in CR-02 (now 2 after the requirement).
   - `staffMultiUserCommands.test.ts`: 4 lines in the base-cell file.
   - `staffReplicaMigration.test.ts`: the kind list.
   - `staffReplicaStartAgain.test.ts`: 4 positions, 3 carried entries, next seq 3.
4. **D-48 call site.** `ensureRequireArmed` runs at creation. The "lead's next open" call for preview projects is left to the engine's open path (33-24, native). `ReplicaProject.open` is used by every device and should not write on open.
5. **Tests first.** The new test files were written with the code. They could not be red on the base, which has no `requireGate.ts` or `hub.readmit`. The changed count tests failed on the first combined run, as expected, before they were updated.

## Verification

All runs used the shared heavy lock, MemoryMax=6G and choom. `npx tsc -p tsconfig.json` was clean every time. This is the same check as `npm run lint`.

| Run | Result |
|-----|--------|
| Broad run of `staff*` and `replica*` with architecture and copyLint, after Task 1 | 1849 passed, 1 failed (a seq count, then fixed), 3 skipped |
| Task 1 and 2 focused files | 83 passed, 0 failed |
| Hub `workspace` and `append` on Node 26.13.1, after Task 2 | 59 passed, 0 failed, 3 skipped (the existing older-Node checks) |
| Task 3 focused files, including copyLint, architecture, replicaBoundaries and staffHubTransport | 254 passed, 0 failed |

On the first Task 3 run, the copy lint caught "hub" and "roster" in the new `hub-revoked` sentence. The sentence was reworded, and no baseline moved.

The full hub suite runs in 33-07, which changes the hub. Both new kinds are folded by the hub's roster cache there.

- **Tests added: 25.** `staffRequireGate` has 5, including the "no loss" test. `replicaRosterRequire` has 10. `replicaHubReadmit` has 10: 6 for the roster kind and 4 for the witness.
- **Tests changed: 15**, all count or seq updates with reasons: 3 in replicaKinds, 1 in replicaContracts, 1 in replicaTracer, 1 in replicaRosterTracer, 1 in replicaProductCells, 4 in staffReplicaProject, 1 in staffMultiUserCommands, 1 in staffReplicaMigration, and 2 in staffReplicaStartAgain.
- `replicaHubWitness.test.ts` passes unchanged.

## Known Stubs

None. `ensureRequireArmed` on a lead's open and the use of `hubReadmits` with `readmitWitness` in the exchange are 33-08 and 33-24 by design.

## Threat Flags

None beyond T-33-08 to T-33-11. Both kinds are lead-device only, agents are refused, and the schemas are closed. Only a folded `hub.readmit` clears distrust, once per entry hash.

## Self-Check: PASSED

- The files exist: `requireGate.ts`, `staffRequireGate.test.ts`, `replicaRosterRequire.test.ts` and `replicaHubReadmit.test.ts`.
- The commits are in HEAD: `4d885791`, `e786afc7` and `6971900c`.
