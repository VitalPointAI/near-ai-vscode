---
phase: 30-replication-contract-and-co-editing-core
plan: 05
subsystem: replica-chain-integrity
tags: [replication, equivocation, quarantine, lamport, roster-citation, withholding, integrity-family]
status: complete

requires:
  - phase: 30-02
    provides: entry format v2, causal graph, per-writer chain stage, fold engine, RosterView, replicaWorld test helper
provides:
  - chain.ts completed: forks admitted as graph nodes, exclusion from the fork seq (and across streams for entries that follow a forked one), chosen branches, exact lamport rule, stale roster citation, future-dated hold against the injected now, chain-broken labelling, withholdingReport
  - equivocation.ts: canonicalProof, verifyProof (needs no roster), parseProof, proofHash, acceptableProof, findEquivocations, forkChosen, quarantineRecords
  - kindSchemas/integrity.ts and integrityFold.ts (integrityReducer, INTEGRITY_REFUSALS): equivocation.proof and digest.report
  - src/test/helpers/replicaForks.ts (forkAt, tamperHeader, resealAt, futureEntry, openWorldBody)
affects: [30-09 checkpoints (withholdingReport heads), 30-10 decisions (stale roster citation at the chain), 30-12 reducer registration, Phase 31 device.release, Phase 33 withholding display and proof writing]

actuals:
  tokens: 16450
  tasks: 3
  commits: 3
plan_head_before: f2c4c62aab440dbb5734ae8b8b9f1bb83eadebd2
plan_head_after: 2e1eb45ed26f470315c054c4dd91043746bc793c

tech-stack:
  added: []
  patterns: [Kahn-style admission with a worklist (no repeated full passes), proofs derived from the verified set so quarantine is order independent, forward label propagation in lamport order for cross-stream exclusion, injected now only]

key-files:
  created:
    - src/domain/replica/equivocation.ts
    - src/domain/replica/integrityFold.ts
    - src/test/helpers/replicaForks.ts
    - src/test/replicaChain.test.ts
    - src/test/replicaEquivocation.test.ts
  modified:
    - src/domain/replica/chain.ts
    - src/domain/replica/kindSchemas/integrity.ts

key-decisions:
  - "Excluded entries are a subset of admitted entries. An entry that is not yet admitted (missing predecessor, future-dated) stays in held, so exclusion never hides a hold."
  - "A proof counts only when it checks out alone AND the roster knows that writer under that public key (acceptableProof), so a stranger cannot quarantine a device, or pollute a stream digest, by inventing a pair. verifyProof itself needs no roster."
  - "verifyProof and proofHash are order agnostic (the pair is normalised by entry hash), so a proof carried with its headers swapped is the same proof."
  - "A roster choice resolves a fork only when the chosen hash is one of the proof's two headers; anything else resolves nothing and the quarantine stands."
  - "Cross-stream exclusion is computed by propagating, in lamport order, the streams of the writer's excluded entries along prev and dep edges (O(entries) per forked writer), not by calling past() per entry (O(entries squared) memory). The graph's preds() is used for the edges."
  - "classifyChains gained an optional third argument, the places of entries refused at verify, to label a writer's later entries chain-broken. fold.ts does not pass it yet (see Follow-ups)."
  - "Added the rejection reason bad-prev (prev names an entry that is not seq-1 of the same writer and stream, or seq above 0 with the genesis prev). The 30-02 hold conflicting-seq and chain-break are gone: forks are proofs, and a wrong prev is permanent."

requirements-completed: [MUS-01]

coverage:
  - id: D1
    description: "A cloned device signing two histories gives exactly one portable proof, quarantine from the fork seq, W1a, W1b and W2 excluded, others applied, identical under all 24 arrival permutations; verifyProof false for a swapped header, equal headers, a foreign key, an altered header and junk input"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaEquivocation.test.ts (first four tests)"
        status: pass
  - id: D2
    description: "A changed old entry is rejected bad-signature; that writer's later entries are held (chain-broken when the refused place is passed to classifyChains); other writers applied and their stream digest equals a fold without the broken writer's later entries"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaChain.test.ts#a changed old entry is rejected bad-signature..."
        status: pass
  - id: D3
    description: "withholdingReport gives haveThrough, citedSeq and count (3 missing; 2 when the cited entry itself is held; none when all delivered; -1 when nothing delivered)"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaChain.test.ts#withholding: ..."
        status: pass
  - id: D4
    description: "bad-lamport (too high, equal to predecessor, 2 with no predecessor), stale-roster-citation (through a dep and along one log), future-dated at the exact 10 minute limit, static refusals bad-genesis, bad-prev, bad-dep, and chain stage independent of input order"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaChain.test.ts (6 further tests)"
        status: pass
  - id: D5
    description: "Chosen branch lifts the quarantine and admits the chosen branch and its descendants; retry gives the same entry and no proof, re-seal is a fork; other writers citing an excluded entry are applied; other streams excluded only for entries following a forked one"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaEquivocation.test.ts (four tests after the first four)"
        status: pass
  - id: D6
    description: "A proof carried as an equivocation.proof entry quarantines the writer on a machine holding one branch; an altered or unknown-device proof is refused invalid-proof; digest.report applied and listed per stream; schema rejects malformed reports; output and digests identical under 24 permutations"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/replicaEquivocation.test.ts (last four tests)"
        status: pass
---

# Phase 30 Plan 05: Fork-proof, tamper-evident chains Summary

Per-writer chains are now tamper-evident and fork-proof: two signed headers at one place give one portable proof, the writer is quarantined from the fork on every machine in every arrival order, a changed old entry breaks only its writer's chain, withholding is measurable, and the lamport, roster-citation and future-time rules are enforced at the chain stage. A proof can also travel as an entry, so a machine that only ever saw one branch learns of the fork. Nothing in the extension calls any of this yet.

## Commits

| Commit | Task |
|--------|------|
| `79d93ea4` | Task 1 (tracer): equivocation.ts, fork-aware admission and exclusion in chain.ts, replicaForks.ts, the 24-permutation test |
| `c6107e08` | Task 2: lamport, stale roster citation, future hold, chain-broken, withholdingReport, chosen branch, retry versus re-seal; replicaChain.test.ts |
| `2e1eb45e` | Task 3: integrity schema and reducer, carried proofs in chain.ts, four more equivocation tests |

## Verification

All runs under the memory cap (4 GB, no swap, 300 s) and the shared heavy lock, not the plan's 6 GB / 1800 s, because the full suite was not run. Each used `node scripts/vendor-libs.mjs && tsc -p tsconfig.json && run-tests`.

- Task 1: `replicaEquivocation` + `replicaTracer`: 14 tests, 14 pass (tsc clean).
- Task 2: `replicaChain` + `replicaEquivocation` + `replicaTracer`: 26 tests, 26 pass (before the eighth chain test was added; it was in the Task 3 run).
- Task 3 / final: `replicaEquivocation` (12 tests) + `replicaChain` (8 tests) + `replicaTracer` (10): all pass. `replicaContracts` (17) was added to that run: 15 pass, 2 fail, see Known Issues below.
- Acceptance greps: `verifyProof` in equivocation.ts 2; `FUTURE_HOLD_MS` and `stale-roster-citation` present in chain.ts; `Date.now|new Date()` in chain.ts 0; `SCHEMA_PENDING` in kindSchemas/integrity.ts 0; `invalid-proof` in integrityFold.ts 2. No em-dash in any file written. `fold.ts` is not in the diff.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Proofs only count for a device the roster knows under that key**
- **Found during:** Task 1 design
- **Issue:** the plan says a carried proof that `verifyProof` accepts quarantines the named writer. `verifyProof` needs no roster, so any member could sign two headers with a fresh key and quarantine an invented writer id, changing the `quarantined` list and so the digest of the stream.
- **Fix:** `acceptableProof` additionally requires `roster.deviceKey(writer).publicKey` to equal the proof's key. Detected proofs already use the roster key. A proof for an unknown device is refused `invalid-proof` by the reducer and ignored by the chain. Tested with a stranger's real fork.
- **Files:** `equivocation.ts`, `chain.ts`, `integrityFold.ts`, `replicaEquivocation.test.ts`

**2. [Rule 1 - Bug avoided] A prev that names the wrong place is a permanent refusal**
- **Issue:** with several entries allowed at one seq, the 30-02 rule "prev must equal the candidate at seq-1" no longer makes sense, and an entry whose prev names another writer's entry would have waited forever as missing-predecessor.
- **Fix:** new rejection `bad-prev` (also for seq above 0 with the genesis prev). Added to `CHAIN_REJECTIONS` with a plain sentence.

**3. [Plan wording] chain-broken needs the verify-stage refusals, which `classifyChains` does not receive from fold.ts**
- **Issue:** the plan requires a changed old entry to leave the writer's later entries "held chain-broken", but a header refused at verify never reaches `classifyChains(verified, ctx)`, and `fold.ts` may not be edited here.
- **Fix:** `classifyChains` takes an optional third argument (the places of entries refused earlier; `RefusedPlace` is a subset of `RejectedEntry`, so the fold can pass its verify-stage `rejected` list unchanged). Chain-level refusals (bad-lamport and the rest) label followers chain-broken with no help. Through `foldEntries` today the later entries of the tampered writer are held `missing-predecessor` (state and digests are exactly as specified); with the third argument they are chain-broken (tested at chain level).

### Other choices within the plan

- `excluded` holds only admitted entries; held entries stay in `held`.
- 3 or more branches at one seq produce one proof (the two lowest hashes), as the plan says; a roster choice of a third branch resolves nothing.
- `withholdingReport` counts places with no entry at all (admitted, held or rejected all count as delivered), so a cited entry that is itself held for another gap is not double counted.

## Follow-ups for other plans

1. **fold.ts (30-12 or whichever plan next owns it):** pass the verify-stage rejected list as the third argument: `classifyChains(verified, ctx, rejected)` where `rejected` holds the entries refused at verify. One line; it turns the tamper hold reason into `chain-broken` in the fold output.
2. **30-12:** register `integrityReducer` (and expect `families.integrity` to be an array of `{ stream, proofs, reports }` rows). The 30-02 contract tests below must be updated at integration time.
3. **Phase 33:** write `FoldResult.proofs` that are not yet carried by an entry as `equivocation.proof` entries; `withholdingReport` takes the held entries' missing deps with the citing stream, or checkpoint heads.

## Known Issues

- **`src/test/replicaContracts.test.js` has two failing tests that assert the old stub behaviour** and are owned by 30-02, not by this plan: "every known kind except doc.client and doc.update fails closed with the schema-pending reason" (now stops at `equivocation.proof`, which has a real schema) and "validateData dispatches each family to its own file" (its table row for `digest.report` expects the pending reason). They fail because this plan, as specified, replaced the integrity stub. Every other plan that writes a family schema in this phase (30-04 for six families, 30-06 doc.compact, 30-08 versions) will break the same two tests. I did not edit the file (outside `files_modified`, and six executors would conflict on the same lines). Integration fix: drop each finished family's kinds from the "others" list and its row from the dispatch table, ending with the plan 30-12 assertion that no kind returns the pending reason.

## Known Stubs

None added. `FoldView.isFinal` still answers false until 30-09; the integrity reducer is not in `DEFAULT_REDUCERS` until 30-12 (tests pass it explicitly).

## Threat Flags

None beyond the plan's register. T-30-18 (portable proof, quarantine in any order, carried proofs), T-30-19 (bad-signature, chain-broken), T-30-20 (withholdingReport), T-30-21 (bad-lamport, future-dated against injected now, no clock read in chain.ts) and T-30-22 (stale-roster-citation) each have a named passing test. The roster-key requirement above closes a spoofing gap the register did not list.

## Self-Check: PASSED

Files present: `src/domain/replica/chain.ts`, `equivocation.ts`, `integrityFold.ts`, `kindSchemas/integrity.ts`, `src/test/helpers/replicaForks.ts`, `src/test/replicaChain.test.ts`, `src/test/replicaEquivocation.test.ts`. Commits `79d93ea4`, `c6107e08` and `2e1eb45e` are ancestors of HEAD on `agent-30-05`. Files touched outside `files_modified`: none (equivocation.ts, integrityFold.ts and replicaForks.ts are in the list; `replicaWorld.ts`, `fold.ts`, `reducers.ts`, `kinds.ts`, `causal.ts` and `rosterView.ts` are unchanged).
