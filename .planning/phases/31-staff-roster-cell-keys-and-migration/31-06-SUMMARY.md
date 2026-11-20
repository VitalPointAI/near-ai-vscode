---
phase: 31-staff-roster-cell-keys-and-migration
plan: 06
subsystem: replica
tags: [replica, equivocation, forks, device-release, chain]
status: complete

requires:
  - phase: 30-replication-contract-and-co-editing-core
    provides: equivocation proofs, classifyChains, excludedEntries, staticRosterView.chosenBranch
  - phase: 31-staff-roster-cell-keys-and-migration
    plan: 01
    provides: RosterView contracts (unchanged here)
provides:
  - EquivocationProof.branches (in memory only, not enumerable) filled by findEquivocations and by classifyChains for found and carried proofs
  - withBranches(proof, hashes)
  - forkChosen accepting any branch of the slot
  - forkStanding(proofs, roster, held) with ForkResolution and ForkStanding; quarantineRecords(proofs, roster, held?) built on it
  - classifyChains excludes and quarantines from forkStanding
affects: [31-08, 31-14]

actuals:
  tokens: 10000
  tasks: 2
  commits: 4
plan_head_before: 81d8ec5cd17ccad6040c6e8e00f51deacdd006b6
plan_head_after: fa1fcaab8e22aec55deda0bf1def409a770ef785

tech-stack:
  added: []
  patterns:
    - "In-memory annotation on a wire value as a non-enumerable property, so JSON, canonical bytes, deepEqual and Object.keys never see it"
    - "Fork slots of one log taken in seq order; doubt (an untraceable past) keeps the quarantine"

key-files:
  created: []
  modified:
    - src/domain/replica/equivocation.ts
    - src/domain/replica/chain.ts
    - src/test/replicaEquivocation.test.ts
    - src/test/replicaChain.test.ts

key-decisions:
  - "branches is a non-enumerable property set by withBranches, so a proof that carries it is byte for byte the same proof on the wire (P-31-08); a proof read from the wire has none"
  - "Each proof lists every branch the machine knows at its slot: held headers plus the headers of every other proof of that slot"
  - "One release resolves the whole fork: after a resolved slot, a later slot is resolved when at most one of its branches follows the kept history (Rule 1 deviation, see below)"
  - "A branch whose past cannot be traced through held headers counts as possibly kept, so doubt keeps the quarantine"
  - "After a release, an explicit choice at a later slot counts only for a branch that may follow the kept history"

patterns-established:
  - "forkStanding is the single place that decides which fork slots are resolved and what is kept; excludedEntries and the quarantine records read it"

requirements-completed: [MUS-04, MUS-01]

coverage:
  - id: D1
    description: "WR-03 re-verified, then a release naming any of three or four branches resolves the fork"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaEquivocation.test.ts#WR-03: a fork with three branches is resolved when the release names the highest hash, which is not one of the two in the proof"
        status: pass
      - kind: unit
        ref: "src/test/replicaEquivocation.test.ts#a four-branch fork accepts each of its four branches; a hash that is not a branch at the slot, or a choice at another seq, resolves nothing"
        status: pass
  - id: D2
    description: "Wire form, canonical bytes and proofHash unchanged; vectors.json unchanged since c1dba334"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaEquivocation.test.ts#the branches never reach the wire: JSON, canonical bytes and proofHash equal the proof of the two lowest headers alone (D-39)"
        status: pass
      - kind: unit
        ref: "dist/test/replicaVectors.test.js; git diff --quiet c1dba334 -- test/fixtures/replica/vectors.json"
        status: pass
  - id: D3
    description: "Three- and four-branch forks with later entries on every branch, every choice, every order of the fork headers, from scratch and in chunks through addEntries"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaChain.test.ts#a three-branch fork: a release naming any branch admits it and its later entries and excludes the others, in all 6 orders, from scratch and in chunks"
        status: pass
      - kind: unit
        ref: "src/test/replicaChain.test.ts#a four-branch fork: a release naming any of the four branches resolves it the same way in all 24 orders, from scratch and in chunks"
        status: pass
  - id: D4
    description: "A carried proof first, the third branch later: the release of the third branch resolves it in every arrival order"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaChain.test.ts#a carried proof of two branches, then the third branch arriving: a release naming the third resolves the fork, in every arrival order"
        status: pass
  - id: D5
    description: "Forbidden transitions: no choice, a non-branch, a choice at another seq, a new fork on the kept branch, a later choice of a set-aside branch, an untraceable later fork"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaChain.test.ts#with no choice, or a choice that is not a branch at the fork seq, every branch from the fork seq on stays excluded and the writer quarantined"
        status: pass
      - kind: unit
        ref: "src/test/replicaChain.test.ts#after a release, a new fork on the kept branch needs its own choice, and a later choice of a set-aside branch lifts nothing"
        status: pass
      - kind: unit
        ref: "src/test/replicaChain.test.ts#a later fork whose branches cannot be traced back to the release keeps the quarantine; given the headers between, the release covers it"
        status: pass

duration: 26min
completed: 2026-11-20
---

# Phase 31 Plan 06: Many-branch forks resolved by any branch Summary

**A lead's device.release naming any branch of a fork with three or more branches now resolves it on every machine and in every arrival order, including when each branch has gone on, while the proof's wire form and hash stay byte for byte the same.**

## Performance

- Duration: about 26 minutes (2026-11-20T03:33Z to 03:59Z)
- Tasks: 2 of 2
- Files: 4 modified

## Accomplishments

- `equivocation.ts`: `EquivocationProof.branches?: readonly string[]`; `withBranches` sets it as a frozen, non-enumerable property (sorted, a and b included); `findEquivocations` still builds the proof from the two lowest hashes and fills `branches` with every hash at the slot; `forkChosen` accepts a, b or any listed branch. `canonicalProof`, `parseProof` and `proofHash` build fresh plain objects and never carry `branches`.
- `equivocation.ts`: new `forkStanding(proofs, roster, held)` takes the fork slots of each (writer, stream) in seq order and returns one `ForkResolution` per resolved slot, plus the first unresolved slot, and the quarantine records. `quarantineRecords` is now `forkStanding(...).quarantined` (optional `held` argument; existing callers unchanged).
- `chain.ts`: before any resolution, every proof (found or carried from an `equivocation.proof` entry) gets every branch this machine knows at its slot; `excludedEntries` and `quarantined` come from `forkStanding`.

## Task Commits

1. Task 1, tracer, RED: `e39a28d6` (test) - WR-03 re-verified and failing tests for three and four branches and the wire form
2. Task 1, GREEN: `96bea727` (feat) - branches, withBranches, forkChosen accepting any branch
3. Task 2, RED: `3ff307b9` (test) - chain permutation, chunked, carried-proof and forbidden-transition tests
4. Task 2, GREEN: `fa1fcaab` (feat) - slot enrichment in classifyChains and forkStanding

## Re-verification of WR-03

Before any code change, a probe on the compiled Phase 30 code with three headers at one seq gave: choosing either of the two lowest hashes returned the hash; choosing the highest returned `undefined`. The RED run of the Task 1 tests then failed 3 of 16 (no `branches`).

## Decisions

- **In memory only (P-31-08):** `branches` is a non-enumerable property, so `JSON.stringify`, `canonicalBytes`, `Object.keys` and `assert.deepEqual` ignore it. A proof the replicator (Phase 33) writes as an entry from `FoldResult.proofs` therefore still parses (parseProof requires exactly three keys) and hashes the same. Tested by comparing JSON, canonical bytes, keys and proofHash against `canonicalProof` of the two lowest headers.
- **Branches known at a slot:** the held headers there and the a and b headers of every proof of that slot, so a found proof and a carried proof of one slot list the same branches.
- **Conservative doubt:** a branch whose past cannot be traced through the held headers counts as possibly following the kept history, so a later fork the machine cannot place keeps the quarantine.
- **Tracer gate (Task 1):** verify re-run passed (25 of 25), expanded to Task 2 without stopping (owner asleep, brief says never wait).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] One release did not resolve a fork whose branches had each gone on**
- **Found during:** Task 2 (RED run of the plan's own behaviour test, "two later entries chained on every branch")
- **Issue:** once two branches each have an entry at seq n+1, that seq is a slot with two signed headers too, so `findEquivocations` gives a proof there. Nothing in the roster chooses at seq n+1, so the writer stayed quarantined from n+1 and the chosen branch's later entries stayed excluded. This was latent in Phase 30 for two branches as well; it blocked the plan's must-have ("the chosen branch's entries are admitted") and DESIGN 15.2 (quarantined to active by `device.release` naming a branch).
- **Fix:** `forkStanding` in `equivocation.ts`. Slots of one log are taken in seq order. A slot is resolved by an explicit choice of one of its branches (forkChosen), or, once an earlier slot is resolved, when at most one of its branches follows the kept history (traced by prev through the held headers and the proofs' headers). The first unresolved slot quarantines the writer from there, as before. Forbidden cases, each tested: a new fork on the kept branch (two branches follow it) needs its own choice; after a release, an explicit later choice of a set-aside branch is ignored; a later fork that cannot be traced keeps the quarantine; no choice or a non-branch choice behaves as before. Wire form, proofs and proofHash are untouched; every Phase 30 replica test passes unchanged.
- **Files modified:** src/domain/replica/equivocation.ts, src/domain/replica/chain.ts
- **Commit:** fa1fcaab

### Notes

- The plan's test-shape expectation of one proof per fork does not hold once branches continue: every seq where the lines differ is a valid proof slot. The tests assert the actual slots (seq 1, 2 and 3) and that each lists every branch there.
- Entry hashes vary per run (a fresh IV per sealed body), so hash order varies. One of my tests first failed in some runs because it gave `forkStanding` a seq 3 branch by hash only (no header), which the conservative rule counts as possibly kept. The test now supplies the headers, as the chain stage does. The chain and equivocation files were then run five times in a row, all green.
- Commands used the phase brief's lock file instead of the plan's `heavy.lock` path, with MemoryMax=4G.
- Scratch probe files were left in the session scratchpad (outside the repo); a removal command was refused by a safety check and was not retried.

## Test Results

All runs under the shared lock and `systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 timeout ... NODE_OPTIONS=--max-old-space-size=1536`.

- Task 1 RED: replicaEquivocation 16 tests, 13 pass, 3 fail (expected).
- Task 1 GREEN: replicaEquivocation and replicaVectors, 25 pass, 0 fail.
- Task 2 RED: replicaChain 12 tests, 9 pass, 3 fail (expected).
- Task 2 verify: replicaChain (15), replicaEquivocation (16), replicaConvergence, replicaVectors: 45 pass, 0 fail.
- Every replica test file (`dist/test/replica*.test.js`, 21 files; there are no staffReplica files yet): 282 pass, 0 fail.
- Acceptance: replicaEquivocation 16 tests (at least 15), replicaChain 15 tests (at least 11); `grep -c "branches?: readonly string\[\]" src/domain/replica/equivocation.ts` is 1; `git diff --quiet c1dba334 -- test/fixtures/replica/vectors.json` exits 0.

The full `npm test` was not run (the orchestrator runs it at the end).

## Known Stubs

None.

## Threat Flags

None. No new endpoint, file access or trust boundary. T-31-14 mitigated (any branch accepted, permutation tests); T-31-15 mitigated (branches never serialised, vectors unchanged); T-31-SC: no package installed.

## Self-Check: PASSED

- FOUND: src/domain/replica/equivocation.ts, src/domain/replica/chain.ts, src/test/replicaEquivocation.test.ts, src/test/replicaChain.test.ts
- FOUND: commits e39a28d6, 96bea727, 3ff307b9, fa1fcaab on HEAD
