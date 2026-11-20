---
phase: 31-staff-roster-cell-keys-and-migration
plan: 04
subsystem: replica
tags: [replica, yjs, text-reducer, client-id, agent-seats, compaction, caps]
status: complete

requires:
  - phase: 31-01
    provides: clientIds.ts slot layout, RosterView.clientIdOwner and canRunAgent, WorldMemberSpec slots and agentSeats, seat fixtures
provides:
  - textFold.ts checks a compaction against the accepted covered updates only (WR-04)
  - foreign-client-id refusal binding every Yjs client id to its writer's roster slot (D-03, D-41)
  - agent-seat-not-allowed refusal for agent doc.client registrations (WR-02 client part, default deny)
  - too-many and too-many-products refusals, COMPACTION_WINDOW, MAX_REGISTRATIONS_PER_WRITER_PRODUCT, MAX_PRODUCTS_PER_STREAM
  - memoised accepted-updates scratch per product and a lazily created Yjs document
affects: [31-07, 31-15, 31-17, 32, 33]

actuals:
  tokens: 13117
  tasks: 4
  commits: 4
plan_head_before: 81d8ec5cd17ccad6040c6e8e00f51deacdd006b6
plan_head_after: 2ae2d77fa9f65e830730a3afc2bcf4602b181fe7

tech-stack:
  added: []
  patterns:
    - "Reducer caps counted in the reducer state and copied by clone, so the incremental and from-scratch folds agree"
    - "A memo in reducer state holds only immutable values, so clones may share it"
    - "Tests read the reducer's working state by wrapping textReducer.finish in a FoldOptions.reducers list"

key-files:
  created: []
  modified:
    - src/domain/replica/textFold.ts
    - src/test/replicaDoc.test.ts
    - src/test/replicaClientIds.test.ts

key-decisions:
  - "D-41 slot binding taken as planned (one-way task 2): with clientIdOwner present, a doc.client whose id the roster does not give the writer is refused foreign-client-id; without it nothing changes"
  - "Cap values as planned: COMPACTION_WINDOW 50, MAX_REGISTRATIONS_PER_WRITER_PRODUCT 4096, MAX_PRODUCTS_PER_STREAM 1024"
  - "The compaction window applies to provisional (joiner) compactions too, so ghost covers cannot bypass it"
  - "The memo holds the state vector and text hash, not a Yjs document; for the full accepted set it reads the fold document instead of rebuilding"
  - "applyClient check order: actor-mismatch, agent-seat-not-allowed, foreign-client-id, too-many-products, client-collision, too-many"

requirements-completed: [MUS-04, MUS-02]

coverage:
  - id: D1
    description: "An honest compaction with a refused or held update in its covered history is accepted as verified; a missing accepted update or a wrong vector or hash is still compact-mismatch"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaDoc.test.ts#WR-04"
        status: pass
  - id: D2
    description: "A client id outside the writer's roster slot is refused foreign-client-id; the race between two writers is impossible in every delivery order"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaClientIds.test.ts#two writers registering one id at once is not a race"
        status: pass
  - id: D3
    description: "Invariant: every accepted update inserts only under ids of its writer's slot (60 seeded worlds)"
    requirement: MUS-04
    verification:
      - kind: property
        ref: "src/test/replicaClientIds.test.ts#invariant"
        status: pass
  - id: D4
    description: "Agent registrations need the seat; default deny when the view cannot answer"
    requirement: MUS-02
    verification:
      - kind: unit
        ref: "src/test/replicaDoc.test.ts#WR-02"
        status: pass
  - id: D5
    description: "Registration, product and compaction caps, memoised scratch, lazy document, incremental equals fresh"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaDoc.test.ts (last five tests)"
        status: pass

duration: 19min
completed: 2026-11-20
---

# Phase 31 Plan 04: Text reducer hardening and client ids bound to roster slots Summary

**No admitted writer can take another writer's attribution any more: a Yjs client id is accepted only from the writer whose roster slot it comes from, an agent's text needs the roster seat, one hostile update no longer switches compaction off, and what one writer can make the text reducer hold or build is bounded.**

## Performance

- Duration: about 19 minutes (2026-11-20T03:34Z to 03:53Z)
- Tasks: 4 of 4
- Files: 3 modified (textFold.ts, replicaDoc.test.ts, replicaClientIds.test.ts)

## Accomplishments

- **WR-04 (D-01 (a)):** `applyCompaction` builds its check from the covered `doc.update` entries the fold accepted. A refused or held covered update adds nothing to the text, so it is left out; a compaction that adds its text, leaves out an accepted update, or carries a wrong vector or hash still differs from the scratch and is refused `compact-mismatch`. The CR-01 provisional branch and the CR-02 `lateDependencies` are unchanged.
- **D-03, D-41:** `applyClient` asks `roster.clientIdOwner(clientId, entry.body.roster)` when the view has it and refuses `foreign-client-id` unless the answer is the entry's writer. The earlier-claim rule and `client-collision` stay as the check inside the writer's own range. A view without `clientIdOwner` (every Phase 30 world) behaves exactly as before.
- **WR-02 client part:** an agent `doc.client` is refused `agent-seat-not-allowed` unless `roster.canRunAgent(member, seat, roster)` returns true; a view without `canRunAgent` denies.
- **WR-05 and WR-08 text part:** `ProductText.doc` is created on the first accepted update; registrations per (writer, product) are capped at 4096 (`too-many`); products per stream at 1024 (`too-many-products`); a writer's compaction of a product is refused `too-many` until 50 more updates were accepted since its last accepted one; the state vector and text hash a compaction is checked against are memoised per product by which accepted updates they cover (for the full accepted set they are read off the fold document, with no rebuild). All new counters and the memo are copied by `clone`.
- New closed-map reasons in `TEXT_REFUSALS`: `foreign-client-id`, `agent-seat-not-allowed`, `too-many`, `too-many-products` (plain sentences, no em-dash).

## Task Commits

1. Task 1, tracer: compaction checked against the accepted covered updates only (WR-04): `2a037055` (fix)
2. Task 2: client ids bound to the writer's roster slot, with the invariant property: `4584b96e` (feat)
3. Task 3: agent text registration needs the roster seat: `e055781b` (feat)
4. Task 4: caps, compaction window, memoised scratch, lazy document: `2ae2d77f` (feat)

## WR-04 re-verification on the old code

Before changing `textFold.ts`, the four new WR-04 tests were run against the unchanged reducer. Two failed exactly as the research reported:

- refused covered update (`foreign-client` by C under A's client id): the honest compaction by B came back `compact-mismatch` (`actual: [[<compaction>, 'compact-mismatch'], [<forged>, 'foreign-client']]`);
- held covered update (`unregistered-client`): the honest compaction came back `compact-mismatch`.

The two "still refused" tests passed on the old code (as they should) and still pass. After the fix all four pass.

## Mutation check for the slot binding

With the `foreign-client-id` return replaced by a no-op in the compiled `dist/` only (overwritten by the next compile), four of the new `replicaClientIds` tests failed, including the invariant property. The invariant therefore goes red if a later change lets a registrant choose an id outside its slot again.

## Decisions

- **One-way task (Task 2, D-03 and D-41):** the plan's rule was taken as written. With `clientIdOwner` present, an undefined owner (id below 2^20, a slot nobody holds, any id from a device without a slot) is refused like a foreign owner.
- **Cap values:** the plan's `[ASSUMED]` numbers were used unchanged: `COMPACTION_WINDOW = 50`, `MAX_REGISTRATIONS_PER_WRITER_PRODUCT = 4096`, `MAX_PRODUCTS_PER_STREAM = 1024`.
- **Window on provisional compactions:** the window also applies to compactions loaded provisionally (covers not held). Otherwise a writer could name ghost covers to stay on the provisional path, skip the window and grow `provisional` without bound. Effect: a joiner holding two compactions of one writer and none of the covered updates keeps the first and refuses the second `too-many` until the updates arrive; because the covers are late dependencies, their arrival refolds and re-decides it.
- **Window check placement:** checked first in `applyCompaction`, before the key, blob and inspection work, so a refused compaction costs nothing.
- **Re-registering an id the writer already holds with the same actor** stays `applied` and does not count toward the 4096 cap.
- **A delete-only update** (no inserted structs) can still name a product nobody registered; it now counts toward the per-stream product cap and is refused `too-many-products` above it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Product cap on every path that can create a product**
- **Found during:** Task 4
- **Issue:** besides `doc.client`, a delete-only `doc.update` and an empty compaction can create a product; without the cap there, the per-stream limit could be bypassed.
- **Fix:** `productText` returns undefined at the cap and every caller refuses `too-many-products`.
- **Files modified:** src/domain/replica/textFold.ts
- **Commit:** 2ae2d77f

### Notes

- The plan says "memoise the accepted-prefix scratch document and state vector". The memo holds the state vector and the text hash (all the check reads), not a Yjs document. When a compaction covers every accepted update the values are read off the fold document, which already is exactly those updates, so nothing is rebuilt; a compaction covering a subset rebuilds once per distinct subset. Holding no document also keeps `clone` cheap.
- The test helper `liveScene` makes A's next update after a compaction depend on it (as an honest editor that has seen it). Without that, some of A's later updates were concurrent with the compaction and sorted before it, which moved the compaction's place in the log and made the window test measure the wrong distance. This is a test-scene fix, not a behaviour change.
- No seat fixture was missing in replicaAttribution, replicaConvergence, replicaVersionDecisions or replicaForbiddenActs; those files are unchanged. Only replicaDoc's world gained a seat (`mbr-wwww`: `j2-analyst`), as the plan says.
- The plan's verify commands use `HEAVY_LOCK`; the runs used the brief's shared lock `p31-build.lock` with the 4G cap.

## Test Results

All runs under `flock p31-build.lock systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 timeout ... NODE_OPTIONS=--max-old-space-size=1536`.

- Task 1 RED (old code): replicaDoc 25 tests, 23 pass, 2 fail (the two WR-04 acceptance tests).
- Task 1: replicaDoc (25) + replicaReevaluation (6): 31 pass, 0 fail.
- Task 2: replicaClientIds (18) + replicaDoc (25) + replicaVectors: 52 pass, 0 fail.
- Task 3: replicaDoc (27), replicaAttribution (7), replicaConvergence (5), replicaVersionDecisions (27), replicaForbiddenActs (11), replicaClientIds (18): 95 pass, 0 fail. Counts not below HEAD for any file.
- Task 4: replicaDoc (32) + replicaConvergence + replicaReevaluation + replicaVectors: 52 pass, 0 fail.
- Whole replica suite (`dist/test/replica*.test.js`, the widest run the brief allows): 288 tests, 288 pass, 0 fail (271 before this plan, plus 17 new).
- `npm run lint` (tsc --noEmit): exit 0.
- The full `npm test` was not run (the orchestrator runs it at the end).

Acceptance greps: `WR-04` in replicaDoc.test.ts 5; `foreign-client-id` in textFold.ts 2; `agent-seat-not-allowed` 2; `too-many-products` 5; `COMPACTION_WINDOW` 3. replicaDoc 32 tests (21 at HEAD), replicaClientIds 18 with one named "invariant". `test/fixtures/replica/vectors.json` unchanged.

Slowest new tests: 4097 registrations 3.1 s, 1100 products 1.1 s.

## Known Stubs

None.

## Threat Flags

None. No new endpoint, file access or trust boundary. T-31-08 (slot binding, invariant property), T-31-09 (seat check, default deny) and T-31-10 (accepted-only compaction check, caps, window, memo, lazy document) are mitigated and tested. No package was installed (T-31-SC).

## Self-Check: PASSED

- FOUND: src/domain/replica/textFold.ts, src/test/replicaDoc.test.ts, src/test/replicaClientIds.test.ts
- FOUND: commits 2a037055, 4584b96e, e055781b, 2ae2d77f on HEAD
