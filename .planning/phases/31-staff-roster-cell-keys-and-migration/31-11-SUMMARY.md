---
phase: 31-staff-roster-cell-keys-and-migration
plan: 11
subsystem: staff-replica
tags: [replica, projection, ledger, staff-products, events, header-tamper-check, tdd]
status: complete

requires:
  - phase: 31-07
    provides: versions reducer hardening (gate seat check, caps)
  - phase: 31-08
    provides: checkpoint heads (the fold the projection reads)
provides:
  - "src/staff/replica/projection.ts: ProjectionInput, ProjectionEntry, projectionEntry, projectProductStates, projectLedgerReplay, projectProductFile, projectStaffEvents, productsHead, PROJECTION_PROBLEMS"
  - "src/test/helpers/staffReplicaHistory.ts: TWIN_SCENARIOS (12), SCENARIO_STEPS, twinHistory(scenario), twinPerson, GUARD_DEVICE"
  - "src/test/staffReplicaProjection.test.ts: 48 tests, table-driven over every release state"
affects: [31-19, 31-21, 31-22, 33]

actuals:
  tokens: 15164
  tasks: 3
  commits: 6
plan_head_before: cceb466e11083984bea59e98ed3ab13bde83d547
plan_head_after: aa6174894bff0904aa202b4343e02141c82d244d

tech-stack:
  added: []
  patterns:
    - "Projection by re-derivation: fold acts become today's LedgerEntry values, read back through parseLedgerEntry and replayed through ledger.ts apply, so today's reducers are reused unchanged (D-28)"
    - "Check the projection against the fold: any version whose projected state differs from the fold's release record turns the product into the fold's own record, marked tampered"
    - "Twin histories: one scenario drives today's real StaffHost (tools and decide) and the replica world step by step, each replica entry stamped with its legacy line's time"

key-files:
  created:
    - src/staff/replica/projection.ts
    - src/test/helpers/staffReplicaHistory.ts
    - src/test/staffReplicaProjection.test.ts
  modified: []

key-decisions:
  - "The projection replays synthesized ledger entries through today's apply() instead of building ProductState by hand; it never edits src/domain/staff (P-31-13 holds: git diff c1dba334 -- src/domain/staff is empty)"
  - "When today's ledger cannot tell the fold's story (concurrent disagreeing verdicts, contested or unconfirmed decisions, an act on a version today's ledger replaced), the product shows the fold's record of its newest version with no gate mark or request and is marked tampered with PROJECTION_PROBLEMS.disagrees; it sends no events"
  - "A deciding person is presented as the fold presents it (roster name, the decision role, the signing device); the device fingerprint is derived from the roster's device key with today's fingerprintOf, so it equals the fingerprint today's ledger records for the same key"
  - "Version hashes: a version without pins has the same hash both ways; a pinned version gets today's hash from its text passed in ProjectionInput.texts (fold hash -> text), else the fold's hash stands"
  - "History and event runs: an agent act carries its run; a person's step takes the open request's run or the last step's run, as today's host does; projectStaffEvents' run argument is used only for a step with no run"

patterns-established:
  - "ProjectionEntry is built from a VerifiedEntry with projectionEntry(); the caller supplies times, the fold supplies order"

requirements-completed: [MUS-06]

duration: 12min
completed: 2026-11-20
---

# Phase 31 Plan 11: Projection adapter Summary

**The fold of a multi-user project now projects to exactly today's ProductState, LedgerReplay, product file bytes and staff events for every release state, by replaying the fold's accepted acts through today's unchanged ledger reducer and checking the result against the fold's own records.**

## Performance

- Duration: about 12 minutes (2026-11-20T04:25Z to 04:37Z)
- Tasks: 3 of 3
- Files: 3 created, 0 modified

## Accomplishments

- `projection.ts` (host folder, pure over its input): each product's versions family becomes the ledger entries today's host would have written (propose or edit with roles when a line opens, verdict, submit, approve or reject, release, withdraw, supersede on an older line), in the fold's total order, read back with `parseLedgerEntry` and replayed with `apply`. Pins map back from `product@hash` to `product@version`; persons get the roster name and today's device fingerprint.
- A safety check against the fold: every version that heads a projected line must have the fold's state, and no version the projection folded into a line may be closed in the fold. Otherwise the product shows the fold's record, without gate marks or request, marked tampered, and sends no events (T-31-28).
- `projectLedgerReplay` (never broken; head is the fold's digest of the products stream), `projectProductFile` (`renderProductHeader(projectHeader(state)) + body`, as `staffHost.writeHeader`), `projectStaffEvents` (`eventsForTransition` per projected step, as `staffHost.transitionEvents`).
- Twin histories drive today's real `StaffHost` (the staff tools and `decide`) and the replica world step by step. 12 scenarios: proposed, guard-checked (HOLD then CLEARED), tradecraft-checked (J2 SIGN-OFF then CLEARED), awaiting-decision, approved, released, rejected, revised (rejected then a new version on the same line), withdrawn (owner), withdrawn-after-approval (person), superseded (release supersedes the older released line), pinned (a dependency on an approved version).

## Task Commits

1. Task 1 (tracer): `19fb8977` test (RED), `10637867` feat
2. Task 2 (every release state): `34dc7b62` test (RED), `123ea621` feat
3. Task 3 (files and events): `8480327a` test (RED), `aa617489` feat

## Test Results

- `staffReplicaProjection.test.js`: 48 tests, 48 pass (12 state-equality, 12 file, 12 event, 12 more: tracer, superseded, revised, pin with and without text, head, request gap, agent approve refused, concurrent disagreeing verdicts, missing time, hand-edited header with four reasons, locked-changed body, tampered product sends no events).
- Together with `staffProducts`, `staffRelease`, `staffLedgerIntegrity`, `staffProductsTool`, `replicaBoundaries`: 108 tests, 108 pass. Every run under the memory cap and the shared build lock.
- Mutation check: removing the device-fingerprint mapping fails 7 of the state-equality tests (reverted at once), so the equality is not vacuous.
- Tracer gate: the tracer's verification was re-run end to end before expanding; it passed.

## TDD Gate Compliance

Each task has a RED test commit (compile failure on the missing export, recorded before the implementation) followed by a GREEN feat commit. No refactor commits were needed.

## Decisions (defaults taken, owner asleep)

- See key-decisions above. The tracer task had no blocking-human gate; the plan's defaults were taken throughout.

## Deviations from Plan

### Interface changes

**1. [Rule 3 - Blocking] `twinHistory` is async and returns more**
- It drives today's real `StaffHost`, which is asynchronous, so it returns a Promise. It also returns `scenario`, `texts` (version text by replica hash), `versionHashes` and the `world`, which the pin, forbidden-transition and event tests need.

**2. [Rule 2 - Missing critical] `ProjectionInput.texts` and `ProjectionEntry.actor` (both optional)**
- Without the version text, today's hash of a version with pins cannot be computed, and today's header check would then read an approved pinned product as changed on disk. `actor` carries an agent's run so history and event runs match today's.
- Also exported: `projectionEntry(VerifiedEntry)`, `productsHead`, `PROJECTION_PROBLEMS`.

**3. Request run is projected**
- The plan said the fold does not keep the request's run; an agent's submit does carry its run in the entry actor, so the projection uses it and the test asserts it.

**4. Verification file absent on this branch**
- Task 3's verify names `dist/test/staffReplicaWorker.test.js`; that file is created by 31-10 in a parallel worktree and does not exist here. The other two files of that command ran and passed.

### Known gap (no source in the fold)

- **The open request's options, dissent and deadline.** `version.submit` carries only `decisionFor` (closed schema in `kindSchemas/versions.ts`, not this plan's file), so a projected request has empty options and dissent and no deadline, as today's replay gives for a submit without a request. Record, meta, gate marks, approvals, older lines, history, files and events are all equal; the request is equal on decision role, time and run. A dedicated test pins the gap. Closing it needs an optional `options`/`dissent`/`deadline` on `version.submit` (a kind schema change, for whichever plan owns `kindSchemas/versions.ts`, or Phase 33).

## Next Phase Readiness

- 31-19 (migration) and 31-21 (host mode) read `projectLedgerReplay` and `projectProductFile`. They should pass `texts` for any version with pins (the decode worker or the doc family has the text), and build `entries` with `projectionEntry` from the verified entries of the store.
- A tampered projection (`PROJECTION_PROBLEMS.disagrees`) is the stand-in for Phase 33's contested and conflict cards; Phase 33 can replace it with a dedicated display state.
- Products are keyed by name, as today; if two streams hold one product name, the first stream (fold sort order) is shown.

## Threat Flags

None. No network endpoint, file access, secret or new agent ability: the module is pure over its input.

## Self-Check: PASSED

- FOUND: src/staff/replica/projection.ts, src/test/helpers/staffReplicaHistory.ts, src/test/staffReplicaProjection.test.ts
- FOUND commits: 19fb8977, 10637867, 34dc7b62, 123ea621, 8480327a, aa617489
