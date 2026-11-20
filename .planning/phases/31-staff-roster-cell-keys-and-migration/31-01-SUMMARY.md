---
phase: 31-staff-roster-cell-keys-and-migration
plan: 01
subsystem: replica
tags: [replica, roster, yjs, client-id, agent-seats, testing]
status: complete

requires:
  - phase: 30-replication-contract-and-co-editing-core
    provides: RosterView, ReplicaContext, staticRosterView, the replica test world helper
provides:
  - clientIds.ts (pure, hub-side) with the D-41 slot layout slot * 2^20 + counter
  - optional RosterView members canRunAgent, clientIdOwner, deviceEncryptionKey, cellGrantees, rosterBranchPending
  - optional ReplicaContext.cellOrder
  - observer role word in ROSTER_ROLE_PATTERNS
  - staticRosterView.canRunAgent (default deny) and clientIdOwner (only when a device has a slot)
  - WorldMemberSpec.agentSeats and WorldMemberSpec.slots
  - agent seat fixtures in six Phase 30 replica test files (inert until 31-04 and 31-07)
affects: [31-04, 31-07, 31-15, 31-17, 31-12, 31-14]

actuals:
  tokens: 7737
  tasks: 4
  commits: 4
plan_head_before: 73df8b2ddc190e1a9d97a961b65de8ce350fb918
plan_head_after: 1072a673

tech-stack:
  added: []
  patterns:
    - "Optional interface growth: new RosterView questions are optional members, spread in conditionally so a static view without the data has no member at all"
    - "Client id arithmetic by multiplication and integer division only, never a shift operator"

key-files:
  created:
    - src/domain/replica/clientIds.ts
    - src/test/replicaClientIds.test.ts
  modified:
    - src/domain/replica/rosterView.ts
    - src/test/helpers/replicaWorld.ts
    - src/test/replicaBoundaries.test.ts
    - src/test/replicaVersions.test.ts
    - src/test/replicaForbiddenActs.test.ts
    - src/test/replicaVersionDecisions.test.ts
    - src/test/replicaConvergence.test.ts
    - src/test/replicaIntegration.test.ts
    - src/test/replicaAttribution.test.ts

key-decisions:
  - "D-41 client id layout taken as planned (one-way task): slot 1..4095, counter 0..2^20-1, id = slot * 2^20 + counter"
  - "Seat fixtures grant every agent seat a device actually writes, including in tests that expect a refusal for another reason, so those tests keep asserting their own reason once the seat checks switch on"
  - "nextClientId throws on a slot out of range (like clientIdOf) rather than returning undefined, so undefined means only 'slot full'"

patterns-established:
  - "Optional RosterView member: absent means the Phase 30 behaviour (no enforcement), present means the roster answers"

requirements-completed: [MUS-04, MUS-02, MUS-03]

coverage:
  - id: D1
    description: "Client id slot arithmetic with edges at slots 1, 2047, 2048, 4095 and refusals of bad slots and counters"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaClientIds.test.ts"
        status: pass
  - id: D2
    description: "Static roster names the owner of a client id only when a device has a slot"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaClientIds.test.ts#a static roster whose devices have slots names the writer that owns a client id at the cited roster"
        status: pass
  - id: D3
    description: "canRunAgent answers from agent seats at the cited roster, default deny"
    requirement: MUS-02
    verification:
      - kind: unit
        ref: "src/test/replicaClientIds.test.ts#canRunAgent denies by default: an unknown member, an unknown roster, and a member with no agent seats"
        status: pass
  - id: D4
    description: "Every Phase 30 replica test and the vectors pass unchanged"
    requirement: MUS-03
    verification:
      - kind: unit
        ref: "node scripts/run-tests.mjs dist/test/replica*.test.js"
        status: pass

duration: 7min
completed: 2026-11-20
---

# Phase 31 Plan 01: Roster view contracts and client id slots Summary

**The roster can now be asked who may run an agent seat (default deny) and who owns a Yjs client id, with the D-41 slot layout as tested pure code and every Phase 30 outcome unchanged.**

## Performance

- Duration: about 7 minutes (2026-11-20T03:23Z to 03:30Z)
- Tasks: 4 of 4
- Files: 2 created, 9 modified

## Accomplishments

- `src/domain/replica/clientIds.ts` (new, pure, hub-side, imports nothing): `CLIENT_COUNTER_BITS`, `CLIENT_COUNTER_SPAN`, `MAX_SLOT`, `isSlot`, `clientIdOf` (throws on out-of-range input), `slotOfClientId` (never throws, 0 for no slot), `nextClientId`. Multiplication and `Math.floor` division only; no shift operator.
- `src/domain/replica/rosterView.ts`: optional `canRunAgent`, `clientIdOwner`, `deviceEncryptionKey`, `cellGrantees`, `rosterBranchPending` on `RosterView`; optional `cellOrder` on `ReplicaContext`; `observer` role word; `StaticRosterMember.agentSeats` and device `slot`; `staticRosterView` implements `canRunAgent` always (default deny) and spreads in `clientIdOwner` only when some device in any roster position has a slot. The other three members stay absent from the static view.
- `src/test/helpers/replicaWorld.ts`: `WorldMemberSpec.agentSeats` and `slots` (one per device). A world built without them produces the same roster spec object shape as before (tested by key lists).
- `HUB_SIDE` in `replicaBoundaries.test.ts` lists `domain/replica/clientIds`; the hub-side closure test passes.
- Agent seat fixtures added to six Phase 30 test files (world specs only).

## Task Commits

1. Task 1, tracer: client id slots and static clientIdOwner: `80c68550` (feat)
2. Task 2, agent seats with default deny and world options: `99186a31` (feat)
3. Task 3, seat fixtures part 1 (versions, forbidden acts, version decisions): `61e18bb7` (test)
4. Task 4, seat fixtures part 2 (convergence, integration, attribution) and full replica proof: `1072a673` (test)

## Seat fixtures (who got which seat)

The device-to-seat map was taken from an instrumented run, not by reading the code: the compiled world helper in `dist/` (untracked, overwritten by the next compile) was temporarily patched to log every agent-actor write with its device and member, and the seven files were run once. The result, applied to the world specs:

| File | Member (device) | agentSeats |
|------|-----------------|-----------|
| replicaVersions | mbr-lead (LEAD) | j2-chief |
| replicaVersions | mbr-p (P) | j2-chief, j2-chief-2, j2-lead, some-other-agent, release-guard |
| replicaVersions | mbr-sl (SL) | j2-chief, j2-lead, release-guard, tradecraft |
| replicaVersions | mbr-q (Q), mbr-x (X) | j2-chief |
| replicaForbiddenActs | mbr-p (P) | j2-chief, release-guard |
| replicaForbiddenActs | mbr-c (C), mbr-d (D), mbr-x (X) | j2-chief |
| replicaVersionDecisions | mbr-p (P) | j2-chief, j2-analyst, release-guard |
| replicaVersionDecisions | mbr-c (C) | j2-chief |
| replicaConvergence | mbr-w0 | j2-chief, j2-analyst, release-guard, tradecraft (new `seatsOf(index)` beside `rolesOf`) |
| replicaConvergence | mbr-w1..w4 | j2-chief, j2-analyst |
| replicaIntegration | mbr-p (P) | j2-chief, j2-analyst |
| replicaIntegration | mbr-sl (SL) | release-guard, tradecraft |
| replicaAttribution | mbr-pppp (P) | j2-analyst |
| replicaAttribution | mbr-N in seededHistory | agent-N |

`replicaDoc.test.ts` (mbr-wwww writes a j2-analyst `doc.client`) is left to plan 31-04 as the plan says.

## Decisions

- **One-way task (Task 1, D-41):** the plan's layout was taken as written; no alternative considered.
- **Seats for agent entries a test expects to be refused:** several tests write an agent entry that must be refused for a reason other than the seat (for example Q and X proposing with the owner seat, `not-owner`; SL giving a guard verdict as `j2-lead`, `not-gate-member`; LEAD creating a product as an agent, `not-authorised`; C, D and X deciding, releasing or superseding as an agent in the forbidden-acts tests). No test at HEAD intends "seat not held" (no such check exists yet), so per the plan's "exactly the seats used" each of these members was given the seat. This keeps each test asserting its own reason after 31-04 and 31-07 switch the seat checks on; those plans add their own "seat not held" regression tests. No member was deliberately left without a seat it writes.
- **`nextClientId` on a bad slot:** throws like `clientIdOf`, so `undefined` means only "the slot is full".

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Type annotation needed in replicaConvergence**
- **Found during:** Task 4
- **Issue:** after adding `agentSeats` to the mapped members, `members.push` of the unrelated writer `mbr-zz` (no seats) no longer matched the inferred element type, so tsc failed.
- **Fix:** typed the list as `WorldMemberSpec[]` (type-only import added). No behaviour or assertion change.
- **Files modified:** src/test/replicaConvergence.test.ts
- **Commit:** 1072a673

### Notes

- The `observer` role word was added in the Task 1 commit together with the other `rosterView.ts` changes rather than in Task 2; its test is in Task 2.
- Task 2 says "do not touch any other test file" while Tasks 3 and 4 add seat fixtures to six other files; Tasks 3 and 4 were followed, as the objective and must_haves describe.
- The Task 4 command in the plan uses MemoryMax=6G; the run used 4G per the phase executor brief and fit.
- Task 1 tests were written alongside the code and verified green; there is no separate RED run for it. Task 2 had a real RED run (tsc refused the new world options) before the implementation.

## Test Results

All runs under `systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 timeout ... NODE_OPTIONS=--max-old-space-size=1536` (the baseline at 6G as the plan's command).

- Baseline before any change, `dist/test/replica*.test.js`: 259 tests, 259 pass, 0 fail.
- Task 1: replicaClientIds (7) and replicaBoundaries (6): 13 pass, 0 fail.
- Task 2: replicaClientIds: 12 pass, 0 fail.
- Task 3: replicaVersions (22), replicaForbiddenActs (11), replicaVersionDecisions (27): 60 pass, 0 fail.
- Task 4, whole replica suite: 271 tests (259 Phase 30 plus 12 new), 271 pass, 0 fail.

Acceptance greps: `domain/replica/clientIds` in replicaBoundaries 1; shift operators in clientIds.ts code 0; `canRunAgent` in rosterView.ts 2; `agentSeats` in replicaWorld.ts 3; removed assert lines in the six fixture files vs c1dba334 0 and 0; `test/fixtures/replica/vectors.json` unchanged vs c1dba334.

The full `npm test` was not run (orchestrator runs it at the end).

## Known Stubs

None. `deviceEncryptionKey`, `cellGrantees`, `rosterBranchPending` and `ReplicaContext.cellOrder` are optional interface members with no implementation by design; plans 31-15, 31-17 and the roster fold implement them.

## Threat Flags

None. No new endpoint, file access or trust boundary; T-31-01 (default deny) and T-31-02 (multiplication only, edge tests at 2047, 2048, 4095) are mitigated and tested.

## Self-Check: PASSED

- FOUND: src/domain/replica/clientIds.ts
- FOUND: src/test/replicaClientIds.test.ts
- FOUND: commits 80c68550, 99186a31, 61e18bb7, 1072a673 on HEAD
