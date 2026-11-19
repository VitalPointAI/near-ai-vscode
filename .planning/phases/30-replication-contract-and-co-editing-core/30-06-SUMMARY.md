---
phase: 30-replication-contract-and-co-editing-core
plan: 06
subsystem: replica-core
tags: [replication, yjs, crdt, attribution, ownership, compaction]
status: complete

requires:
  - phase: 30-02
    provides: the Yjs adapter, the text reducer, replicaWorld test helpers, the fold
provides:
  - src/domain/replica/doc.ts: inspectUpdate, encodeDiff, attributionRuns, attributionAtSnapshot, pendingState, encodeFullState, buildFromCompaction, MAX_STRUCT_LENGTH, MAX_STRUCTS
  - src/domain/replica/attribution.ts: attributeText, summariseAuthors, AuthorSpan, AuthorSummary
  - src/domain/replica/textFold.ts: ownership, clock rule, deletion records, incomplete flag, compaction handling; per-product output gains attribution, deletions, incomplete, compactions
  - src/domain/replica/kindSchemas/doc.ts: the doc.compact schema
  - src/test/helpers/replicaYjs.ts: test-only loader of the vendored bundle and hostile update builders
affects: [30-08, 30-09, 30-10, 30-12, Phase 31, Phase 33]

actuals:
  tokens: 17100
  tasks: 3
  commits: 3
plan_head_before: f2c4c62aab440dbb5734ae8b8b9f1bb83eadebd2
plan_head_after: 06f445a543c80172f8df04734ec0d7295d7f5297
commits: 3

tech-stack:
  added: []
  patterns: [inspect an update before applying it, compaction as a verified cache, attribution from signed registrations only]

key-files:
  created:
    - src/domain/replica/attribution.ts
    - src/test/helpers/replicaYjs.ts
    - src/test/replicaDoc.test.ts
    - src/test/replicaAttribution.test.ts
  modified:
    - src/domain/replica/doc.ts
    - src/domain/replica/textFold.ts
    - src/domain/replica/kindSchemas/doc.ts
    - src/test/replicaContracts.test.ts

key-decisions:
  - "A GC struct is told from a Skip struct by the ref byte it writes into a UpdateEncoderV1, because the minified bundle has no usable class names and the structs expose no kind field."
  - "The clock rule is checked per (product, client) in fold order: below the next expected clock is clock-overlap, above it is admitted and the product reports incomplete."
  - "A compaction is applied at output time, with the log's updates winning over the compaction's structs; only the newest unverified compaction is merged."
  - "One client id means one author: the same device registering a client id again under a different actor is refused client-collision."

requirements-completed: [MUS-02]

coverage:
  - id: D1
    description: "Random concurrent edits by persons and agent runs converge in four shuffled orders with duplicates, and every character's span names the writer, member, agent member and run of the client that typed it (150 seeds)"
    requirement: MUS-02
    verification:
      - kind: unit
        ref: "src/test/replicaAttribution.test.ts#150 seeds of random concurrent edits by persons and agents converge in every delivery order and every character is attributed to the client that typed it"
        status: pass
      - kind: unit
        ref: "src/test/replicaAttribution.test.ts#a person and an agent run co-edit one product and every character names the writer, member and run that typed it"
        status: pass
  - id: D2
    description: "An update is accepted only if every inserted struct is under a client registered to its writer; foreign, whole-document and unregistered cases are refused or held, collisions resolve by total order in all 24 delivery orders, id 0 is bad-data"
    requirement: MUS-02
    verification:
      - kind: unit
        ref: "src/test/replicaDoc.test.ts (foreign-client, unregistered-client, held-not-rejected, collision tests)"
        status: pass
  - id: D3
    description: "Content allow list, byte and struct caps, malformed and deeply nested updates, clock overlap and gap, deletion records"
    requirement: MUS-02
    verification:
      - kind: unit
        ref: "src/test/replicaDoc.test.ts (forbidden-content, malformed-update, too-large, clock rule, deletions tests)"
        status: pass
  - id: D4
    description: "doc.compact is verified against the log when the covered updates are held (verified or compact-mismatch), loads provisionally otherwise, refuses unregistered clients, and compaction plus later updates equals the full log"
    requirement: MUS-02
    verification:
      - kind: unit
        ref: "src/test/replicaDoc.test.ts (compaction tests and the 25-seed equivalence test)"
        status: pass
---

# Phase 30 Plan 06: Co-editing core Summary

Product text is a Yjs document carried in signed entries, every character is attributed to the writer, person, agent and run that typed it from signed `doc.client` registrations only, hostile updates are refused or held without crashing the fold, and `doc.compact` works as a cache checked against the log.

## Commits

| Commit | What |
|--------|------|
| `b490923c` | Task 1: attribution.ts, doc.ts inspection and attribution functions, textFold.ts ownership, clock rule, deletions, compaction handling, J2 tracer tests |
| `be224f6d` | Task 2: replicaYjs.ts hostile update builders and the ownership hardening tests |
| `06f445a5` | Task 3: doc.compact schema, compaction tests, 150-seed property, the two 30-02 contract expectations updated |

The three tasks share doc.ts and textFold.ts, so the source for all three landed in the first commit and the second and third commits hold the tests and schema that belong to their tasks. The source was written before its tests (not test first), so there is no RED commit.

## What was built

- **doc.ts.** `inspectUpdate` checks the byte size first, then decodes inside try/catch (a 40 KB update of 20 000 nested arrays overflows the decoder and gives `malformed`), accepts only string, deleted and GC structs with parent `body` and no map key, tells GC from Skip through the ref byte the struct writes (no class names), checks `MAX_STRUCT_LENGTH` (1 000 000) and `MAX_STRUCTS` (100 000), requires each client's structs to be contiguous, and returns delete ranges and each client's start and end clocks. `attributionRuns` walks `getText('body')._start` and joins neighbouring items of one client with consecutive clocks, so two documents holding the same structs split differently give the same runs. `attributionAtSnapshot` reuses the scratch document of `textAtSnapshot`.
- **attribution.ts.** `attributeText` and `summariseAuthors`; pure, no Yjs. A run whose client has no registration (impossible after the ownership check) becomes a span with an empty writer rather than failing the fold; the tests assert none appears.
- **textFold.ts.** `doc.update`: inspect, then forbidden/too-large/malformed refusals, foreign-client (refused before unregistered-client is considered), unregistered-client hold, then the clock rule, apply, deletion records (first entry in fold order records an identical range). `doc.compact`: open the blob with the stream key, inspect it, then either verify against the covered updates (verified, or compact-mismatch) or, if some covered head is absent, check that every struct belongs to a registered client and keep it as an unverified state that fills in text at output time.
- **kindSchemas/doc.ts.** `doc.compact { product, covers (at most 64 deps), stateVector (sorted unique pairs), textHash, stateBlob }`.

## Verification

Run under the memory cap and the shared heavy lock (4 GB, 300 s, not the plan's 6 GB), not the full suite:

- `tsc -p tsconfig.json`: no output.
- `replicaDoc` 19 tests, `replicaAttribution` 7 tests (including the 150-seed property, about 4 s), `replicaTracer` 10, `replicaContracts` 17: 53 tests, 53 pass, 0 fail in one run of the four files.
- Acceptance greps: `PermanentUserData` and `constructor.name` in doc.ts 0, `getRef` 4, `clock-overlap` in textFold.ts 2, `compact-mismatch` 5, `SCHEMA_PENDING` in kindSchemas/doc.ts 0, `attributeText` in attribution.ts 1. No em-dashes in the files written.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Two 30-02 contract tests asserted doc.compact was still pending**
- **Found during:** Task 3 verify
- **Issue:** `src/test/replicaContracts.test.ts` expected every kind except `doc.client` and `doc.update` to return the schema-pending reason, and listed `doc.compact` in the family dispatch test. The plan removes that pending return, so both failed.
- **Fix:** the first test now excludes all `doc.` kinds (47 others), and `doc.compact` is removed from the dispatch list. Nothing was weakened for other kinds.
- **Files modified:** `src/test/replicaContracts.test.ts` (outside this plan's `files_modified`)
- **Commit:** `06f445a5`

**2. [Rule 2 - Missing critical functionality] One client id, one author**
- **Issue:** the plan refuses a registration colliding with another writer's client id. The same device registering one client id under a second actor (a person id reused as an agent run) would make the attribution of its characters ambiguous.
- **Fix:** that second registration is refused `client-collision`; the same device repeating the identical registration stays applied. Tested.
- **Files modified:** `src/domain/replica/textFold.ts`

**3. [Rule 2 - Missing critical functionality] A failed apply rebuilds the document**
- **Issue:** if Yjs threw halfway through applying an inspected update, the fold document could be left half applied.
- **Fix:** the document is rebuilt from the accepted updates and the update is refused `malformed-update`.
- **Files modified:** `src/domain/replica/textFold.ts`

### Plan interpretations worth knowing

- `covers` is data, not `deps`. A compaction that cites the heads as `deps` would be chain-held by 30-02's chain rule until the heads arrive, so a joiner could never load it provisionally. The writer therefore cites the covered heads as `deps` only when it wants a verified compaction to sort after them; a compaction meant for joiners that lack the updates carries no such deps.
- A provisional compaction's registered-client check uses the registrations known at its position in the total order. A compaction must therefore sort after the registrations of the clients in its state; a writer whose lamport follows everything it has seen does this by construction.
- A covered update that the fold did not accept (refused or held) makes the compaction `compact-mismatch`; covered updates must also precede the compaction in fold order.
- The provisional state is merged into the output document after the log's updates, so where the log and a compaction disagree the log wins. Only the newest unverified compaction is merged.
- `Registration`, `AcceptedUpdate`, `ProductText` and `TextState` keep their names; `ProductText` gained required fields `nextClock`, `gaps`, `deletions`, `deletionKeys`, `compactions`, `provisional`. The digest input (`canonical`) is unchanged.
- An update entry's own `actor` is not compared with its client's registered actor; attribution is by client registration (D-20).

## Open item (flagged, not decided)

The late joiner: a joiner whose set lacks the old `doc.update` entries also lacks those writers' chain prefixes, so the full fold holds those writers' later entries. D-21's equivalence is proven here at the text-family level (compaction plus later updates equals the full log, both in `buildFromCompaction` and in the provisional fold path), and the full-fold path works for writers whose chains are complete. Admitting chains that start after a checkpoint is not defined by D-01..D-37 and needs a decision when Phase 31 or 33 plans the late joiner.

## Residual risk

`Y.decodeUpdate` is eager: a 4 MiB hostile update of tiny GC structs can allocate up to roughly two million struct objects before the struct-count cap is checked. The byte cap bounds it and a fold decodes each update once, but a tighter pre-decode count would need a lazy reader that the bundle does not export.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-30-23 to T-30-28 are covered by tests as listed in the coverage block.

## Self-Check: PASSED

All 8 files in the commit list exist in the worktree, and commits `b490923c`, `be224f6d` and `06f445a5` are ancestors of HEAD on `agent-30-06`.
