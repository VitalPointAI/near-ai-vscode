---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 06
subsystem: team-core
tags: [removal, release, claims, leases, allocations, snapshot-compat, determinism, materialiser]
status: complete

requires:
  - phase: 61-invitations-joining-removal-near-org-and-key-integration
    provides: "61-01 invite and join; 61-05 member.key-sealed with nearApiKeyId, nearKeyDevices, nearKeyEvent, retiredNearKeyIds"
provides:
  - member.removed releases everything an active member held, in the materialiser (releaseHeldWork)
  - src/test/teamRelease.test.ts - release fixtures, positional rejection, snapshot compatibility, seeded determinism and the key invariant
affects: [61-10, 61-11, 63, 66]

plan_head_before: 8ec66e663dc1d0f0239cb65c3dab3dd38532f6e6
plan_head_after: 45c9a03387fa50795b6182d8b8727ae7fdc8b5fa
actuals:
  tokens: 7400
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "release is one pure transition over TeamState Maps in insertion order, so every client computes the same result"
    - "a World test class grows a team by signed events only and asserts every planned verdict, used both for hand-written and seeded logs"

key-files:
  created:
    - src/test/teamRelease.test.ts
  modified:
    - src/domain/team/materialize.ts

key-decisions:
  - "A released claim keeps its leaseIds list untouched (the plan says branch, base and spend are kept and the leases are dropped from state.leases); the ids become dangling references until Phase 63 defines claim events"
  - "The Phase 60 hash is checked by rebuilding the hash recipe from the serialised text plus an exact allowed key list per member, because the pinned value from 61-05 needs a fixed key and a log with extra events cannot be signed by it"

requirements-completed: []  # TEAM-03 is only partly delivered here (state-level release); later plans finish it, so REQUIREMENTS.md was left unticked

coverage:
  - id: D1
    description: "member.removed for an active member releases active, in-review and integrating claims with branch kept, returns their items to ready with no claimId, drops the member's leases and the leases of released claims, removes the member's allocations and takes released claims out of the integration queue; merged, expired, done, cancelled and other members' work is untouched"
    requirement: TEAM-03
    verification:
      - kind: unit
        ref: "dist/test/teamRelease.test.js#tracer: a lead removes a member holding claims, leases and allocations and every client releases them the same way"
        status: pass
    human_judgment: false
  - id: D2
    description: "Removing an invited member only marks the record removed; events signed by the removed member's device after the removal are rejected with 'author was removed before this event' while earlier events stay valid; no device is revoked by removal"
    requirement: TEAM-03
    verification:
      - kind: unit
        ref: "dist/test/teamRelease.test.js#cancelling an invitation only marks the record removed and releases nothing; #tracer (removedAuthor and revokedEvent assertions)"
        status: pass
    human_judgment: false
  - id: D3
    description: "State with invited members, joined members with seal keys and delivered and retired key ids round-trips through serialiseState and deserialiseState (and a signed snapshot file) with an unchanged hash; a Phase 60 log keeps its hash recipe and member keys; STATE_HASH_VERSION is 1"
    requirement: TEAM-03
    verification:
      - kind: unit
        ref: "dist/test/teamRelease.test.js (invited and joined members ... round-trip; a Phase 60 log keeps its hash ...)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Replaying a seeded log twice, incrementally versus one reduce, and resumed from the middle give byte-identical serialiseState for 20 seeds mixing invites, joins, confirms, sealed keys, cancels, removals and late events from removed members; the current key id is never retired and current plus retired equal the delivered key ids"
    requirement: TEAM-03
    verification:
      - kind: property
        ref: "dist/test/teamRelease.test.js#for 20 seeds a log of invites, joins, confirms, sealed keys, cancels and removals replays identically and keeps the key invariant"
        status: pass
    human_judgment: false

duration: 10 min
completed: 2026-11-02
---

# Phase 61 Plan 06: Release on removal Summary

**Removing an active member now releases everything they held in one deterministic materialiser transition (claims released with branches kept, items back to ready, leases and allocations dropped, queue filtered), and 20 seeded logs prove that this phase's invite, join, key and removal events keep snapshots compatible and replay byte-identical.**

## Performance

- **Duration:** about 10 min
- **Tasks:** 2 (one tracer, one hardening task)
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments

- `releaseHeldWork` in `src/domain/team/materialize.ts`, called from the `member.removed` transition unless the member is still `invited`. It walks `state.claims` in insertion order and releases the member's `active`, `in-review` and `integrating` claims (status `released`; branch, base and spend kept), sets the item back to `ready` and clears `claimId` when the item still points at that claim, deletes leases held by the member or belonging to a released claim, filters the member's allocations out (unspent amount returns to the pool), and removes released claim ids from `integrationQueue`. Merged, handed-off, expired and already released claims, done and cancelled items and every other member's work are left alone.
- Removal stays positional: devices are not revoked; `boundKey` rejects later events with `removedAuthor` while earlier events stay valid.
- `teamRelease.test.ts` holds six tests: the tracer fixture (owner, lead, two developers, six claims, leases, allocations, queue; two clients compared through a plain dump), cancel of an invitation, removal of a member holding nothing, a snapshot round trip for invited and joined members with all new fields (also through a signed snapshot file), Phase 60 compatibility, and the 20-seed property test.

## Task Commits

1. **Task 1 (tracer):** RED `725b559` (test), GREEN `f9a5677` (feat)
2. **Task 2:** `45c9a03` (test only; no parse gap was exposed, so `parseMember` and `parseDeviceKey` needed no change)

## TDD Gate Compliance

- **RED (Task 1):** the tracer test failed on `claim-a1` expected `released`, actual `active` (assertion for the planned behaviour). TAP evidence from `node --test --test-reporter=tap dist/test/teamRelease.test.js` returned `RED_EVIDENCE_OK` (`target_test_failed`) from `gsd_run check tdd-red-evidence`. Semantic assessment: the target ran, reached the first release assertion after the fixture and the earlier availability event were accepted, and failed for the intended reason (no release logic yet).
- **GREEN (Task 1):** `releaseHeldWork` made all teamRelease and teamMaterialize tests pass.
- **Task 2:** test-only by plan. The new tests passed on first run because Phase 61 plans 01 to 05 had already made every new member field snapshot-safe; they are regression gates, not a red-green pair. Flagged here as the unexpected-green case the TDD rules ask to investigate: the cause is that no production change was planned for Task 2, and the 20-seed test asserts that every event kind occurred at least once so it cannot pass vacuously.

## Deviations from Plan

None. The plan executed as written. One small addition: a test for removing a joined member who holds nothing (kept as a plain-removal guard).

## Decisions

- A released claim keeps its `leaseIds` list; the lease records are dropped from `state.leases`. Phase 63 (claim events) decides whether a released claim should clear the list.
- The Phase 60 hash is asserted by recomputing the recipe (hash version 1 plus the state minus `accepted`, `seenEventIds`, `rejected`, `snapshots`) from the serialised text, with an exact allowed key list per member and a check that no new key names appear in the text. The fixed-key hash pinned in 61-05 (`teamKeySealedEvent.test.ts`) continues to guard the exact value from pre-Phase-61 code.

## Verification

- `npm run lint` exits 0.
- `node --test dist/test/teamRelease.test.js dist/test/teamMaterialize.test.js dist/test/teamInvite.test.js dist/test/teamKeySealedEvent.test.js`: 60 tests pass.
- `node --test dist/test/team*.test.js`: 483 tests pass.

## Known Stubs

None.

## Threat Flags

None. No new network endpoint, auth path or file access; mitigations T-61-24 (positional `removedAuthor` asserted) and T-61-25 (deterministic order, replay-twice and incremental property test) are covered. T-61-26 (allocations deleted, not archived) is accepted as planned.

## Self-Check: PASSED

- `src/test/teamRelease.test.ts`: found
- `src/domain/team/materialize.ts` contains `releaseHeldWork`: found
- Commits `725b559`, `f9a5677`, `45c9a03`: present in history
