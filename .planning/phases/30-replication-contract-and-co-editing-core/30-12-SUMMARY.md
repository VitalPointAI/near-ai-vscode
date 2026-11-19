---
phase: 30-replication-contract-and-co-editing-core
plan: 12
subsystem: replica-core
tags: [replication, integration, convergence, property-tests, phase-gate]
status: complete

requires:
  - phase: 30-03
    provides: the vendored Yjs bundle and the CRDT spike verdict
  - phase: 30-10
    provides: decisions on versions through the decision algebra
  - phase: 30-11
    provides: canonical vectors and the replica import boundary
provides:
  - DEFAULT_REDUCERS = doc, project, versions, integrity (the four families Phase 30 folds)
  - FoldView.streamPosition, and stream-relative act positions in the versions output
  - src/test/replicaIntegration.test.ts (a whole staff scenario through the default fold; the schema-pending gate)
  - src/test/replicaConvergence.test.ts (randomWorld, the 200-seed convergence property, the 50-seed unrelated-stream invariant, two quarantine-and-checkpoint scenarios)
  - a digests key in test/fixtures/replica/vectors.json
affects: [Phase 31 store and roster fold, Phase 32 hub, Phase 33 and 34 transports]

actuals:
  tokens: 15700
  tasks: 3
  commits: 2
plan_head_before: 0e783315401e4d8b29b286b283cf2a4a4afa5da2
plan_head_after: e20dce6d9697cbd3e6c2a73eafcfeb8d4aed473d

tech-stack:
  added: []
  patterns: [one seeded world builder shared by the property and the invariant, a counting reducer wrapper to observe which entries a refold applies again, a positional reducer to prove the invariant test has teeth, fixture regenerated with one key added]

key-files:
  created:
    - src/test/replicaIntegration.test.ts
    - src/test/replicaConvergence.test.ts
  modified:
    - src/domain/replica/reducers.ts
    - src/domain/replica/fold.ts
    - src/domain/replica/versions.ts
    - src/test/helpers/replicaVectors.ts
    - src/test/replicaVectors.test.ts
    - src/test/replicaVersions.test.ts
    - src/test/replicaChain.test.ts
    - src/test/replicaCheckpoint.test.ts
    - test/fixtures/replica/vectors.json

key-decisions:
  - "Act positions in the versions output are the index among the entries of the product's own stream (new FoldView.streamPosition), not the index in the total order of every stream together. The global index moves whenever an unrelated stream gains an entry, which the unrelated-stream invariant (T-30-47) forbids. FoldView.position stays for comparing two entries and is documented as never to be reported."
  - "fold.ts now passes its verify-stage rejected list to classifyChains (the 30-05 follow-up), so a tampered writer's later entries are held chain-broken, not missing-predecessor."
  - "The vector context moved into the helper (vectorContext) so the digest in the fixture and the test that reads the fixture use one reader."

requirements-completed: [MUS-01, MUS-02, MUS-03]

coverage:
  - id: D1
    description: "A whole staff scenario (two persons and an agent run co-edit, the owner agent proposes v1, tradecraft and guard pass it, the owner side submits, the commander approves and releases) folds through the default reducers to doc, project, versions and integrity, with v1 released and the attribution naming both persons and the agent run, identical in forward, reverse and shuffled one-at-a-time delivery"
    requirement: MUS-03
    verification:
      - kind: unit
        ref: "src/test/replicaIntegration.test.ts#a whole staff scenario folds through the default reducers to every family, and to the same families and digests in forward and reverse order"
        status: pass
  - id: D2
    description: "No kind in REPLICA_KINDS is answered by the schema-pending stub"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaIntegration.test.ts#no kind in REPLICA_KINDS is answered by the schema-pending stub"
        status: pass
  - id: D3
    description: "200 random worlds of 2 to 5 writers (persons and agent runs, one or two streams, up to 60 entries, forks, tampered and future-dated entries, later-phase and unknown kinds) fold to one result under 4 shuffled deliveries with 5 duplicates each, two partitions joined both ways, and one-at-a-time random arrival; Kahn order equals the sort"
    requirement: MUS-01
    verification:
      - kind: property
        ref: "src/test/replicaConvergence.test.ts#200 random worlds of 2 to 5 writers fold to one state and one digest"
        status: pass
  - id: D4
    description: "An unrelated writer in another stream changes no digest and no family row of the original streams (50 seeds), and a reducer that reports the global index does change, so the check has teeth"
    requirement: MUS-02
    verification:
      - kind: property
        ref: "src/test/replicaConvergence.test.ts#an unrelated writer in another stream, at any interleaving"
        status: pass
      - kind: unit
        ref: "src/test/replicaConvergence.test.ts#the unrelated-stream invariant has teeth"
        status: pass
      - kind: unit
        ref: "src/test/replicaVersions.test.ts#regression: an unrelated stream changes no recorded act position"
        status: pass
  - id: D5
    description: "Quarantine crossed with checkpoint finality: a late fork after a prefix refolds once from the prefix snapshot with no prefix entry applied again; a fork inside the prefix refolds from the start and excludes the covered branch; both equal the from-scratch fold with the same checkpoint, and the result still names the checkpoint"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaConvergence.test.ts#quarantine after a checkpoint prefix"
        status: pass
      - kind: unit
        ref: "src/test/replicaConvergence.test.ts#quarantine inside a checkpoint prefix"
        status: pass
  - id: D6
    description: "The canonical vectors pin the per-stream digest of the vector entries folded with the default reducers"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaVectors.test.ts#the digests vector is the digest of each stream"
        status: pass
  - id: D7
    description: "Phase gate: full suite once, verify:release once, secret scan, scope check"
    requirement: MUS-01
    verification:
      - kind: integration
        ref: "npm test (4754 tests, 0 fail); npm run verify:release (Release content verified); node scripts/secret-scan.mjs (clean)"
        status: pass
---

# Phase 30 Plan 12: Integration and phase gate Summary

Every Phase 30 reducer is registered, convergence is proven over every family with 200 random worlds, the digest is pinned in the canonical vectors, and the phase gate (full suite once, release content once, secret scan, scope) is green.

## Phase gate results

| Check | Result |
| --- | --- |
| `npm test`, once, under the 6 GB wrapper | `ℹ tests 4754`, `ℹ pass 4746`, `ℹ fail 0`, `ℹ skipped 8`, `ℹ cancelled 0`, `ℹ todo 0`, duration 96 s |
| `npm run verify:release`, once | `Release content verified: 593 entries, 488 runtime JavaScript files, and 63 required release assets.` (no hash mismatch lines) |
| `node scripts/secret-scan.mjs` | `Secret scan clean: 1673 tracked files. Allowlisted fixtures: 10.` |
| Scope: `git diff --name-only bfdde162 -- src ':!src/domain/replica' ':!src/test' ':!src/domain/team/signedPayload.ts'` | prints nothing; the only source file outside the replica core and the tests is `src/domain/team/signedPayload.ts` (the staff-replica purpose) |
| `git diff bfdde162 -- package.json` | only the `lib0` 0.2.119 and `yjs` 13.6.33 devDependency lines |
| SECURITY.md | read against what was built (bundle path `vendor/yjs/yjs.cjs`, manifest `scripts/crdt-vendor.json`, the three checks, "does not use it yet"); every fact matches, so it is unchanged; 0 em-dashes, "replica core" appears 3 times |

The 8 skipped tests are environmental and unrelated to Phase 30: two ripgrep tests (not installed here), one Open-GSD runtime test (`NEAR_GSD_HOME` unset) and five live NEAR AI tests (`NEAR_AI_API_KEY` unset).

Time of the new property file under the 4 GB wrapper: about 17 to 30 seconds for all five tests (the 200-seed property alone 17 to 30 s depending on machine load), under the 60 s guide, so no seed was cut. The 200-seed property printed these counts on the last run: 200 worlds, 4568 applied entries, 37 worlds with a released version, 18 with a cloned device, 24 with a tampered entry, 19 with a future-dated one, 37 with held entries, 122 with refused entries, 182 with kept entries, 72 with two streams, widest world 5 writers. The test asserts floors on these so a quiet generator cannot pass.

## Spike verdict (30-03, carried into the phase result)

`30-CRDT-SPIKE.md`: no size or garbage collection problem found. Convergence and attribution held on every seed. A garbage-collection-off fold document and compaction blobs are affordable at this size (gc-off full state 4.7 to 5.7 bytes per character; gc-on was at least 61.3 percent smaller, which is input for Phase 33's compaction default and changes nothing in Phase 30). SECURITY.md says nothing about sizes, so nothing contradicts it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Act positions in the versions output depended on a global sequence**
- **Found during:** Task 1 (the "kept entries in another stream change nothing" check of the integration test)
- **Issue:** `VersionAct.position` was `view.position(hash)`, the index in the total order of every stream together. An entry in an unrelated stream shifted it, so `families.versions` differed between a fold with and without that stream. This is exactly T-30-47 (a reducer depending on global position). It was not in the digest (acts are not canonical), which is why no earlier test saw it.
- **Fix:** `FoldView.streamPosition` (index among the entries of the entry's own stream) added in `fold.ts` and `reducers.ts`; `versions.ts` uses it. `position` stays, documented as never to be reported.
- **Files modified:** `src/domain/replica/fold.ts`, `reducers.ts`, `versions.ts`
- **Regression tests:** `replicaVersions.test.ts` ("regression: an unrelated stream changes no recorded act position", verified to fail with the old line and pass with the new one), plus the invariant and the positional-reducer teeth test in `replicaConvergence.test.ts`.
- **Commit:** dcdf6eee

**2. [Rule 1 - Bug] The 30-05 follow-up: the fold did not pass its verify-stage rejected list to the chain stage**
- **Issue:** a tampered writer's followers were held `missing-predecessor` instead of `chain-broken` in the fold output.
- **Fix:** `classifyChains(verified, ctx, verifyRejected)` in `fold.ts` (one line). The orchestrator's integration note covered this; it is wired, not left for later.
- **Regression test:** `replicaChain.test.ts` now asserts the fold's own output labels both followers `chain-broken`.
- **Commit:** dcdf6eee

**3. [Rule 1 - Stale comment] `FoldView.isFinal` comment** claimed it answered false until 30-09; corrected. **Commit:** dcdf6eee

**4. [Rule 3 - Blocking] A 30-09 checkpoint test compared a one-reducer fold with the default fold**
- **Issue:** with four default reducers, `replicaCheckpoint.test.ts` "a late concurrent entry outside the final prefix refolds from the prefix snapshot" compared `families` and `digests` of a counting-reducer fold with a `foldEntries` call that used the default list, so they no longer matched.
- **Fix:** the two from-scratch folds in that test now pass the same one-reducer list. No assertion weakened.
- **Commit:** e20dce6d

### Other notes

- The vectors test's reader context moved from the test file into the helper (`vectorContext`) so the fixture builder folds with the same context the test reads; behaviour unchanged.
- The plan listed `src/domain/replica/chain.ts` as possibly edited; no change was needed. `SECURITY.md` was checked and not edited.
- The 30-02 contract tests were already updated by the orchestrator; nothing to do here.

## Open items

- **Late joiner (flagged in 30-06, not decided):** a joiner whose set lacks the old `doc.update` entries also lacks those writers' chain prefixes, so the full fold holds those writers' later entries. Admitting chains that start after a checkpoint is not defined by D-01..D-37 and needs a decision when Phase 31 or 33 plans the late joiner.
- **Hostile `Y.decodeUpdate` residual risk (30-06):** a 4 MiB update of tiny GC structs can allocate up to about two million struct objects before the struct-count cap is checked; a tighter pre-decode count needs a lazy reader the bundle does not export.
- **Write-path rules for Phase 31 (from 30-08 and 30-10):** a proposer must cite the heads it has seen in `deps`, and a submit, release or withdraw must list the decision acts it saw in `deps` and `decisionsSeen` (`deps` is capped at 16). The convergence generator follows both.
- **Roster removal (30-10):** a removal whose roster entry is not in the fold yet is treated as absent; Phase 31's roster fold should keep `roleWithdrawnBy` returning the roster entry's hash.
- **Phase 33:** write `FoldResult.proofs` that no entry carries yet as `equivocation.proof` entries; `withholdingReport` takes the held entries' missing deps with the citing stream.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-30-46 (convergence across every family, forks, tampering, future entries, partitions, incremental arrival: the 200-seed property), T-30-47 (the 50-seed invariant, the teeth test and the stream-position fix), T-30-48 (full suite, verify:release and the scope check above), T-30-49 (the two quarantine-and-checkpoint scenarios, equal to the from-scratch fold) and T-30-SC (no package installed; verify:release re-checked the vendored bundle hash) each have a passing check.

## Self-Check: PASSED

Files present: `src/test/replicaIntegration.test.ts`, `src/test/replicaConvergence.test.ts`, `src/domain/replica/reducers.ts` (DEFAULT_REDUCERS has four reducers), `test/fixtures/replica/vectors.json` (a `digests` key; the diff adds only that key). Commits `dcdf6eee` and `e20dce6d` are ancestors of HEAD on `plan/phase-30`. Files touched outside `files_modified`: `src/domain/replica/versions.ts` (fix 1), `src/test/replicaVersions.test.ts`, `src/test/replicaChain.test.ts` and `src/test/replicaCheckpoint.test.ts` (regression tests and the stale comparison, all in replica modules the plan allows fixing in this wave).
