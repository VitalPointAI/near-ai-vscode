---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
plan: 05
subsystem: team
tags: [materializer, validation-pipeline, lamport, positional-revocation, snapshots, property-test, determinism]

requires:
  - phase: 60-01
    provides: "types.ts contracts, canonical JSON and Ed25519 verification, tracer materialiser exports"
  - phase: 60-02
    provides: "decideTeamAction, actionForEvent and the permission reasons"
  - phase: 60-04
    provides: "parseEventFile, validate.ts patterns, applyPolicyChanges"
provides:
  - "applyEntry with the full D-09 order (schema, team and replay, bound device, signature, Lamport, permission, references) and fixed reasons"
  - "State transitions for the ten Phase 60 event types, positional revocation and removal (D-11), owner-only genesis joins"
  - "checkCandidate and cloneState so the write side can pre-check a batch without touching live state"
  - "Fixed-shape serialiseState, sha256 stateHash, snapshotBody, deserialiseState and parseSnapshotFile (provisional, owner or lead signed)"
  - "src/test/helpers/teamEvents.ts: signed event factory, fixture members, signed snapshot, seeded scenario builder, mulberry32"
affects: [60-06, 60-07, 60-08, 60-09, 60-10, 60-11]

actuals:
  tokens: 19200
  tasks: 2
  commits: 4
plan_head_before: c2cbf7a98db0ad6a180ca0f7721fd152090ba11e
plan_head_after: 892cbd2c850c1c4956447436e6c29da26d064c68

tech-stack:
  added: []
  patterns:
    - "Checks run in D-09 order and nothing is mutated until all pass; the single exception is state.rejected"
    - "Lamport high-water mark moves on accepted events only, with a 1000 jump cap"
    - "Snapshot state is rebuilt by an exact-shape parser and must re-serialise to the same bytes"
    - "Seeded scenario builder runs every entry through a live state and asserts the planned verdict while generating"

key-files:
  created:
    - src/test/helpers/teamEvents.ts
    - src/test/teamMaterialize.test.ts
  modified:
    - src/domain/team/materialize.ts

key-decisions:
  - "member.joined outside genesis is rejected as 'not permitted: only the owner joins at genesis in this version' (the tracer used the bare reason)"
  - "A member.availability event without workingHours keeps the hours already on record"
  - "stateHash covers state.rejected (it is part of serialiseState), so a snapshot.written must be computed after any rejections that precede it; replay is deterministic so every client agrees"
  - "deserialiseState requires the Phase 60 empty defaults for items, claims, leases, allocations, budget and queue, and ties the state to the anchor (genesis equal, owner holds the anchored genesis device); later phases extend this"
  - "parseSnapshotFile caps files at 8 MB and returns fixed SNAPSHOT_REASONS strings; hash, head, binding, role and signature are checked in that order"

patterns-established:
  - "Reference checks return a reason or undefined, and lookupMember returns the member or the reason, so no non-null assertions are needed"
  - "Test world helper: reject(w, event, reason) also proves nothing but state.rejected changed"

requirements-completed: [TEAM-04, SEC-04]

coverage:
  - id: D1
    description: "Every D-09 step rejects with its fixed reason in order, the first event must match the genesis anchor or the whole log is refused, rejected events change only state.rejected"
    requirement: TEAM-04
    verification:
      - kind: unit
        ref: "src/test/teamMaterialize.test.ts#step order: an unbound device, a broken signature, a replay and the lamport rules each report their own reason"
        status: pass
      - kind: unit
        ref: "src/test/teamMaterialize.test.ts#genesis: a first event with another id, another key, a tampered body or a malformed file refuses the whole log"
        status: pass
    human_judgment: false
  - id: D2
    description: "Read side calls the same decideTeamAction as the write side: developer policy.changed, a lead acting on the owner and a lead adding the owner's device are rejected with not permitted plus the permissions.ts reason"
    requirement: SEC-04
    verification:
      - kind: unit
        ref: "src/test/teamMaterialize.test.ts#read side: the same decideTeamAction as the write side rejects each forbidden action with the permissions.ts reason"
        status: pass
    human_judgment: false
  - id: D3
    description: "Revocation and removal are positional: earlier events stay valid, later ones are rejected, and a full replay reproduces the split"
    requirement: SEC-04
    verification:
      - kind: unit
        ref: "src/test/teamMaterialize.test.ts#positional revocation: a revoked device is valid before the revocation and rejected after it, and a full replay agrees"
        status: pass
      - kind: unit
        ref: "src/test/teamMaterialize.test.ts#positional removal: events before the removal stay valid, events after are rejected"
        status: pass
    human_judgment: false
  - id: D4
    description: "Reducing is pure and deterministic: replay, incremental application and snapshot plus tail give byte-identical state over 40 seeded logs mixing valid and forged entries"
    requirement: TEAM-04
    verification:
      - kind: unit
        ref: "src/test/teamMaterialize.test.ts#deterministic property: replay, incremental application and snapshot plus tail agree over seeded random logs"
        status: pass
    human_judgment: false
  - id: D5
    description: "Snapshots are signed materialised state: snapshot.written is accepted only when it matches the replayed state, and a loaded snapshot is provisional and bound to the anchor"
    requirement: SEC-04
    verification:
      - kind: unit
        ref: "src/test/teamMaterialize.test.ts#snapshot.written matching the replayed state is accepted and recorded; any mismatch is rejected"
        status: pass
      - kind: unit
        ref: "src/test/teamMaterialize.test.ts#parseSnapshotFile rejects bad signatures, non-managers, hash mismatches, another team and extra keys"
        status: pass
    human_judgment: false

duration: 50min
completed: 2026-11-01
status: complete
---

# Phase 60 Plan 05: Materialiser validation pipeline Summary

**The tracer materialiser is now the full D-09 read side: seven ordered checks with fixed reasons, positional revocation and removal, the same `decideTeamAction` as the write side, ten state transitions, a byte-stable state hash and a provisional signed snapshot loader, proven deterministic by a 40-seed property test.**

## Performance

- **Duration:** about 50 min
- **Completed:** 2026-11-01
- **Tasks:** 2
- **Files:** 2 created, 1 modified

## Accomplishments

- `applyEntry` keeps its signature. Position 1 must be the anchored `team.created` signed by the anchored key, otherwise the log is refused with the D-10 text and later entries are ignored without being recorded. After that: `parseEventFile` (schema), team id then duplicate id, device bound to the author then revoked then removed (D-11), signature with the bound key, Lamport (strictly above the accepted high mark, at most `MAX_LAMPORT_JUMP = 1000` above it), `decideTeamAction` at that position, then reference checks. Nothing is mutated before all checks pass.
- Transitions for all ten types. `member.joined` is only accepted as the second accepted event, for the owner, role owner, genesis device. `member.removed` marks `removedEvent` and `removedAt` and keeps the member's fingerprints indexed so they cannot be re-registered. `policy.changed` merges through `applyPolicyChanges`.
- `checkCandidate` clones the state and applies each candidate as a synthetic committed entry; `teamMaterializer.check` uses it. `cloneState` is a deep copy.
- `serialiseState` is a fixed shape (members sorted by id, device index and seen ids sorted, `refused` only when set); `stateHash` is its sha256. `snapshotBody`, `deserialiseState` (exact-shape parser that must re-serialise to identical bytes and be tied to the anchor) and `parseSnapshotFile` (owner or lead device bound in the snapshot's own state, signature over the canonical file without `sig`, returns `provisional: true`).
- `snapshot.written` is accepted only when `coversThrough`, `lamport`, `path` and `stateHash` match the replayed state at that position; a snapshot file entry is accepted only when an accepted `snapshot.written` names its path.
- Property test (`mulberry32`, 40 seeds, 60 entries each, 607 forged entries across ten forgery kinds): replay is deterministic, chunked incremental application with state copies equals replay, the forged entries are exactly `state.rejected`, removing them leaves everything but `rejected` identical, and a snapshot at a random cut plus the tail (also through a signed provisional file) equals the full replay. The suite runs in about 2 s.

## Task Commits

1. **Task 1: Full D-09 pipeline, positional roster state and the ten transitions** - `383e7b1` (feat), `2361ae1` (test, includes the helper file)
2. **Task 2: Serialisation, state hash, snapshots and the property test** - `b7f9e33` (feat), `892cbd2` (test)

**Plan metadata:** the docs commit that adds this file and the STATE and ROADMAP updates.

## Files Created/Modified

- `src/domain/team/materialize.ts` - pipeline, transitions, candidate check, serialisation, state hash, snapshot format and loader
- `src/test/helpers/teamEvents.ts` - `makeActor`, `makeDevice`, `signed`, `entryOf`, `genesisEntries`, `addFixtureMember`, `mulberry32`, `signedSnapshot`, `snapshotWrittenBody`, `buildScenario`
- `src/test/teamMaterialize.test.ts` - 24 tests

## Decisions Made

See `key-decisions` above. `addFixtureMember` documents that Phase 60 logs cannot contain non-owner members (D-07), so the read-side matrix is tested by placing members straight into the state.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Dependencies were not installed in the worktree**
- **Found during:** Task 1 (first compile)
- **Issue:** `node_modules` was absent, so `tsc` was not available. A first `npx tsc` attempt resolved to an unrelated npm package named `tsc` and printed a banner; it did not touch the project (nothing was installed in the repo).
- **Fix:** `npm ci --ignore-scripts` from the committed lockfile. `package.json` and `package-lock.json` are unchanged and `node_modules` is gitignored.

**2. [Rule 3 - Blocking] RED and GREEN not committed as separate commits**
- **Issue:** The test files import exports that do not exist before the implementation, so a test-only commit would not compile. As in plans 60-01, 60-02 and 60-04, the RED run was done locally (Task 1: 12 of 16 failed on assertions plus three missing exports; Task 2: tsc failed on nine missing exports) and each task has a `feat` commit followed by a `test` commit. No assertion was weakened; the only test edits after the first green run were two test-side mistakes (an event count of 7 instead of 6, and a snapshot body computed before an intervening rejection changed `state.rejected`).

**3. [Rule 2 - Missing critical] Snapshot size cap and anchor binding**
- **Issue:** The plan did not bound snapshot file size or tie the embedded state to the anchor beyond the genesis fields.
- **Fix:** `parseSnapshotFile` rejects files over 8 MB, and `deserialiseState` requires the owner member to hold the anchored genesis device and exactly one owner, so a state built under other keys cannot pass as this team's.

**Total deviations:** 3 (2 blocking, 1 hardening). **Impact:** none on the specified behaviour; no new dependencies.

## Issues Encountered

- The acceptance command `/usr/bin/node --test dist/test/teamMaterialize.test.js` (Node 22 engine floor) could not be run: there is no `/usr/bin/node` and only Node 24.22.1 and 24.22.2 are installed. The suite passes on Node 24.22.2 (24 of 24). Run it on a Node 22 host at the phase boundary.
- Full `npm test` was not run in this plan (it runs at the phase boundary). `node --test dist/test/team*.test.js` passes 220 of 220, which includes the 60-03 transport tests against the full materialiser; `npm run lint` exits 0.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model. T-60-21 to T-60-26 are mitigated and tested: bound device and signature (steps 3-4), `decideTeamAction` on read, positional revocation and removal, accepted-only Lamport with jump cap, duplicate-id and not-greater checks, and snapshot.written matched against the replayed hash with provisional, owner-or-lead-signed loading. No package installs; `package.json` is unchanged.

## Self-Check

- `src/domain/team/materialize.ts`, `src/test/helpers/teamEvents.ts` and `src/test/teamMaterialize.test.ts` exist; commits `383e7b1`, `2361ae1`, `b7f9e33` and `892cbd2` are ancestors of HEAD.
- Acceptance greps hold: `decideTeamAction(` and `parseEventFile(` in materialize.ts, `MAX_LAMPORT_JUMP = 1000`, `provisional: true`, `snapshotMismatch` and `snapshotOrphan`, `mulberry32` and a test named "deterministic property" in the test file; no `assertNoSecrets`, `findSecrets`, `Date.now` or `new Date(` in materialize.ts; no `vscode` import under `src/domain/team`.
- `npm run lint` exits 0; `node --test dist/test/team*.test.js` 220 of 220.

## Self-Check: PASSED

## Next Phase Readiness

60-06 and 60-07 can use `checkCandidate` for the write-side CAS re-validation, `snapshotBody` plus `signedSnapshot`-style signing for the snapshot writer, and `buildScenario` for further property tests.
