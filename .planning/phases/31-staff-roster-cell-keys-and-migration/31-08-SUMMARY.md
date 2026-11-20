---
phase: 31-staff-roster-cell-keys-and-migration
plan: 08
subsystem: replica
tags: [checkpoint, late-joiner, chain, fold, vectors]
status: complete

requires:
  - phase: 31-02
    provides: fold.ts shape (hash-keyed chosen map, holdWaits, FoldResult.dropped)
  - phase: 31-06
    provides: chain.ts with forkStanding and slot enrichment
provides:
  - Checkpoint format version 2 (CHECKPOINT_VERSION 2) with per-head lamport and roster; version 1 still reads and verifies
  - CheckpointHead, CheckpointBase, checkpointBases(checkpoints), checkpointHeads(entries, roster)
  - classifyChains(verified, ctx, verifyRejected?, bases?) accepting a writer chain that starts right after a base
  - fold passes the bases of the version 2 checkpoints that verify under the roster
  - checkpointV2 section in test/fixtures/replica/vectors.json; every Phase 30 section byte-identical
affects: [phase-32 hub checkpoint signing, phase-33 author-not-yet-checked display, 31-14 roster fold checkpointSigner]

actuals:
  tokens: 17295
  tasks: 3
  commits: 5
plan_head_before: 509c39abacafeebedc0f942a6b8faf8e0e16fcd0
plan_head_after: 1365eef2332a7cdee3f5b928843931d639a8018a

tech-stack:
  added: []
  patterns:
    - "A version 2 checkpoint head is an admitted virtual predecessor (a base) for the chain checks; its lamport and roster are what the checks read"
    - "A new format gets a new vector section, and the old sections are pinned by the SHA-256 of their canonical bytes"

key-files:
  created:
    - src/test/replicaCheckpointHeads.test.ts
  modified:
    - src/domain/replica/checkpoint.ts
    - src/domain/replica/chain.ts
    - src/domain/replica/fold.ts
    - src/test/helpers/replicaVectors.ts
    - src/test/replicaVectors.test.ts
    - test/fixtures/replica/vectors.json

key-decisions:
  - "signCheckpoint signs the version it is given: version 2 for every new checkpoint, version 1 only to reproduce older ones (existing tests and the Phase 30 vector sign v1 and must pass unchanged)"
  - "A base is used for its lamport and roster whether or not the head entry is also held, so a joiner and a full holder decide every later entry the same way"
  - "The fold re-verifies version 2 checkpoints before taking bases from them (cached per checkpoint and roster view), because a base admits entries without their predecessors"
  - "Two checkpoints naming one head hash with different values give no base for that head"
  - "A prev naming an unknown hash stays held missing-predecessor (not bad-prev); bad-prev is reserved for a prev naming a base of another writer, stream or seq"

requirements-completed: [MUS-04, MUS-01]

coverage:
  - id: D1
    description: "Checkpoint format version 2 round trip; version 1 still reads and verifies; malformed version 2 heads refused; non-signer refused"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaCheckpointHeads.test.ts (tests 1-6)"
        status: pass
  - id: D2
    description: "A late joiner admits a chain that starts after a verified head; its order is the full fold's suffix; bad-prev, bad-lamport, stale-roster-citation, bad-dep, conservative hold; compaction-only text stays unverified"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaCheckpointHeads.test.ts (tests 7-14)"
        status: pass
  - id: D3
    description: "checkpointV2 vector section; Phase 30 sections byte-identical"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaVectors.test.ts (tests 10-12); git diff c1dba334 -- test/fixtures/replica/vectors.json is additions only"
        status: pass

duration: 13min
completed: 2026-11-20
---

# Phase 31 Plan 08: Checkpoint heads for late joiners Summary

**Checkpoints now record each writer head's lamport and newest roster (format version 2), and a person who joins late can check a writer's log that starts right after a verified checkpoint head, with the same prev, seq, lamport and roster checks a member who holds everything applies.**

## Performance

- Started 2026-11-20T04:04:19Z, finished 2026-11-20T04:17:14Z (about 13 minutes)
- 3 tasks, 5 commits, 7 files

## Accomplishments

- `checkpoint.ts`: `CHECKPOINT_VERSION = 2`; `CheckpointHead { writer, seq, hash, lamport, roster }` (the shared `Dep` type is unchanged); `readCheckpoint` reads version 1 (heads with exactly writer, seq, hash) and version 2 (exactly those plus lamport in 1..MAX_LAMPORT and a 64-hex roster), each with a closed key list; a mixed checkpoint is refused. `normaliseCheckpoint` keeps the head keys of the checkpoint's version. `CheckpointBase` and `checkpointBases(checkpoints)` give one base per version 2 head keyed by head hash, none for version 1, and none for a head two checkpoints disagree about. `checkpointHeads(entries, roster)` builds version 2 heads (the hub can use it from Phase 32). `CHECKPOINT_MAX_BYTES` stays 64 KiB, with a comment that this is about 400 version 2 heads.
- `chain.ts`: `classifyChains(verified, ctx, verifyRejected = [], bases = new Map())`. A prev naming a base must be the same writer and stream at `base.seq + 1`, else `bad-prev`; a dep naming a base must match its writer and seq, else `bad-dep`; admission does not wait for a base; the lamport check and the stale-roster check read the base's lamport and roster. A dep naming a covered entry that is not a head stays `missing-predecessor`. No bases gives exactly the Phase 30 behaviour (a test compares `classifyChains` with and without an empty map).
- `fold.ts`: `prepare` passes `checkpointBases` of the version 2 checkpoints in `FoldOptions.checkpoints` that verify under `ctx.roster`. `planCheckpoints` and `checkpointCoverage` are unchanged, so a joiner's checkpoint (heads not in the graph) fixes no order and `FoldResult.checkpoint` stays null for it.
- Vectors: the builder keeps the version 1 `checkpoint` section exactly and adds `checkpointV2` (same entries, heads from the production `checkpointHeads`, its own signature by writer A). The fixture diff is 87 added lines and no removed line.

## Task Commits

1. Task 1 (tracer), RED: `f5e58cfe` test(31-08): version 2 checkpoint heads, version 1 still verifies, join bases
2. Task 1 (tracer), GREEN: `443f8ad8` feat(31-08): checkpoint format version 2 with per-head lamport and roster
3. Task 2, RED: `b601576e` test(31-08): a joiner's chain starts after a version 2 checkpoint head
4. Task 2, GREEN: `10fe57f7` feat(31-08): a joiner's chain may start after a verified checkpoint head
5. Task 3: `1365eef2` test(31-08): checkpointV2 vector section, Phase 30 sections byte-identical

## TDD evidence

- Task 1 RED: tsc reported the missing exports (`checkpointBases`, `checkpointHeads`, `CheckpointHead`, and `v: 2` not assignable); tsc still emits, and the six new tests then ran and failed (6 of 6), each on the missing API or on readCheckpoint refusing version 2. GREEN: 29 of 29 across replicaCheckpointHeads, replicaCheckpoint and replicaVectors.
- Task 2 RED: tsc reported the 4-argument `classifyChains` call; of 14 tests the 6 new target tests failed on their planned assertions (the joiner's entries were `missing-predecessor`, no `bad-prev`, `bad-lamport`, `stale-roster-citation` or `bad-dep` was given, and the compaction entry was not admitted). The 2 new control tests (no usable checkpoint; v2 equals v1 for a full holder) passed, as controls should. GREEN: 14 of 14.
- Tracer gate: Task 1's verify was run again after GREEN and passed before Task 2 started.

## Test results

- Task 1 verify (replicaCheckpointHeads, replicaCheckpoint, replicaVectors): 29 pass, 0 fail.
- Task 2 verify (replicaCheckpointHeads, replicaChain, replicaOrder, replicaCheckpoint, replicaReevaluation, replicaConvergence) plus replicaBoundaries (chain.ts now imports a type from checkpoint.ts; both are hub-side): 82 pass, 0 fail.
- Task 3 verify (replicaVectors, replicaCheckpointHeads): 26 pass, 0 fail. replicaVectors has 12 tests (9 before); replicaCheckpointHeads has 14, one named with "suffix".
- Final: every `dist/test/replica*.test.js` and `staffReplica*.test.js` (23 files) after a full tsc compile: 357 pass, 0 fail, 0 skipped, 0 cancelled. The full `npm test` was not run, as the brief says; the orchestrator runs it.
- Acceptance checks: `grep -c "CHECKPOINT_VERSION = 2" src/domain/replica/checkpoint.ts` is 1; `grep -c checkpointBases src/domain/replica/fold.ts` is 2; the fixture has `checkpointV2`; the number of old sections that differ from c1dba334 is 0.

## Canonical vectors

No existing vector changed. `test/fixtures/replica/vectors.json` gained one top-level key, `checkpointV2`, appended after `digests`; every Phase 30 section (`note`, `labels`, `roster`, `writers`, `epochKeys`, `entries`, `blobs`, `checkpoint`, `proof`, `versionHashes`, `digests`) is byte-identical to c1dba334. Before regenerating, the SHA-256 of the canonical bytes of each of those sections was taken from the committed file and written into `replicaVectors.test.ts` (`PHASE_30_SECTIONS`), so any later change to an old section fails a test. Note for 31-07, which runs in parallel and owns `versions.ts`: the `versionHashes` section is pinned there too.

## Decisions

- One-way decision (Task 1, D-04/D-42): format version 2 as the plan and the owner decision describe; taken as written.
- `signCheckpoint` signs the version it is given. The truth "signCheckpoint writes version 2" holds for every new checkpoint (built with `v: CHECKPOINT_VERSION`); it also still signs version 1 because the existing checkpoint, order, convergence, re-evaluation and version-decision tests and the Phase 30 vector sign version 1 checkpoints and had to pass unchanged.
- The head's `roster` is the roster hash with the highest position cited by the head or anything in its causal past (31-RESEARCH.md recommendation). For an admitted head this is its own roster, since the chain stage refuses a stale citation.
- A base counts as an admitted predecessor whether or not the head entry is also held, and the checks read the base's lamport and roster. This keeps the result a function of the entry set plus the checkpoints (a joiner and a full holder classify every later entry alike, and an arriving head entry never changes an earlier decision).
- Defence in depth for T-31-19: the fold re-verifies each version 2 checkpoint under `ctx.roster` before taking bases from it, even though `FoldOptions.checkpoints` is documented as already verified, because a base admits entries without their predecessors. The verdict is cached in a WeakMap per signed object and roster view, so `addEntries` does not check a signature again. `checkpointBases` itself reads the shape only, as the plan names it.
- A prev naming a hash that is neither held nor a base stays `missing-predecessor`, as for a full log; `bad-prev` after a checkpoint means a prev naming a base of another writer or stream, or a seq that is not `base.seq + 1`. The test for "a wrong prev" grafts onto another writer's head (T-31-20).

## Deviations from Plan

### Auto-added

**1. [Rule 2 - Missing functionality] `checkpointHeads(entries, roster)` in checkpoint.ts**
- Found during: Task 1
- Issue: the plan defines the head's roster ("the highest-position roster cited by the head or its past") but gives no code that computes it; the tests, the vector builder and Phase 32's hub would each have had their own copy.
- Fix: one pure exported helper in checkpoint.ts (already hub-side and already importing the causal graph); the tests check it independently on a two-roster case, and the vector builder uses it.
- Files: src/domain/replica/checkpoint.ts
- Commit: 443f8ad8

**2. [Rule 2 - Security] Fold re-verifies version 2 checkpoints before using their bases** (see Decisions; T-31-19)
- Files: src/domain/replica/fold.ts
- Commit: 10fe57f7

**3. [Rule 2 - Correctness] Conflicting heads give no base** (two checkpoints naming one head hash with different lamport or roster)
- Files: src/domain/replica/checkpoint.ts
- Commit: 443f8ad8

### Interpretation

- "The digests of the streams agree with a full fold that uses the same checkpoint": a joiner without the prefix cannot have the prefix's text, so the test checks it the way D-42 states it: the joiner's order equals the full fold's suffix, and once the prefix is served (`addEntries`) its order, applied list and digests equal the full fold that uses the same checkpoint. The joiner's own text updates wait at the reducer stage with `unregistered-client` because the registrations are in the prefix; the test asserts exactly that reason, which is the documented D-42 limitation (non-text state before the checkpoint is rebuilt only when the prefix is served).
- The compaction test gives the joiner the three registrations (as the welcome could) but not the covered updates; the compaction is admitted through the bases of the update heads, its text loads provisionally and every span keeps `unverified: true`; with the updates present the same compaction is verified.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model. T-31-19 (non-signer base): mitigated by verifyCheckpoint in the fold and tested. T-31-20 (grafting onto a wrong head): prev, seq, lamport, roster and dep checks against the base, tested. T-31-21 (compaction-only text shown as checked): the CR-01 flag is kept and tested for a joiner. No package was installed.

## Next Phase Readiness

- Phase 32 can sign version 2 checkpoints with `checkpointHeads` plus the existing count and order tip, and test against the `checkpointV2` vector.
- 31-14's roster fold implements `checkpointSigner`; the name is kept.
- Not done here (by design, D-42): serving the prefix on demand (Phase 32) and the "author not yet checked" display (Phase 33). A joiner's `FoldResult.checkpoint` stays null because its checkpoint fixes no order; if Phase 33 needs to show which checkpoint vouched for a joiner's log, that is a new field.

## Self-Check: PASSED

- Files exist: src/test/replicaCheckpointHeads.test.ts, src/domain/replica/checkpoint.ts, src/domain/replica/chain.ts, src/domain/replica/fold.ts, src/test/helpers/replicaVectors.ts, src/test/replicaVectors.test.ts, test/fixtures/replica/vectors.json.
- Commits on the branch: f5e58cfe, 443f8ad8, b601576e, 10fe57f7, 1365eef2.
