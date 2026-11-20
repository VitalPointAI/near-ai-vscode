---
phase: 30-replication-contract-and-co-editing-core
verified: 2026-11-19T21:00:00Z
status: human_needed
score: 4/4 roadmap success criteria verified in code and tests (re-verified after the review fixes CR-01, CR-02 and CR-03); 3 owner decisions open (client id registration race, late-joiner chains after a checkpoint, Y.decodeUpdate eager allocation R-1), see Human Verification
covered_files:
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-01-PLAN.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-01-SUMMARY.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-02-PLAN.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-02-SUMMARY.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-03-PLAN.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-03-SUMMARY.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-04-PLAN.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-04-SUMMARY.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-05-PLAN.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-05-SUMMARY.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-06-PLAN.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-06-SUMMARY.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-07-PLAN.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-07-SUMMARY.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-08-PLAN.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-08-SUMMARY.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-09-PLAN.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-09-SUMMARY.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-10-PLAN.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-10-SUMMARY.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-11-PLAN.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-11-SUMMARY.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-12-PLAN.md"
  - ".planning/phases/30-replication-contract-and-co-editing-core/30-12-SUMMARY.md"
  - "SECURITY.md"
  - "package.json"
  - "scripts/crdt-vendor.json"
  - "scripts/entries/yjs.mjs"
  - "scripts/vendor-libs.mjs"
  - "scripts/verify-release-content.mjs"
  - "src/domain/replica/attribution.ts"
  - "src/domain/replica/causal.ts"
  - "src/domain/replica/chain.ts"
  - "src/domain/replica/checkpoint.ts"
  - "src/domain/replica/decisions.ts"
  - "src/domain/replica/digest.ts"
  - "src/domain/replica/doc.ts"
  - "src/domain/replica/entry.ts"
  - "src/domain/replica/equivocation.ts"
  - "src/domain/replica/fold.ts"
  - "src/domain/replica/integrityFold.ts"
  - "src/domain/replica/kindSchemas/doc.ts"
  - "src/domain/replica/kindSchemas/integrity.ts"
  - "src/domain/replica/kindSchemas/obs.ts"
  - "src/domain/replica/kindSchemas/project.ts"
  - "src/domain/replica/kindSchemas/registers.ts"
  - "src/domain/replica/kindSchemas/roster.ts"
  - "src/domain/replica/kindSchemas/runs.ts"
  - "src/domain/replica/kindSchemas/shared.ts"
  - "src/domain/replica/kindSchemas/versions.ts"
  - "src/domain/replica/kindSchemas/watches.ts"
  - "src/domain/replica/kinds.ts"
  - "src/domain/replica/order.ts"
  - "src/domain/replica/projectFold.ts"
  - "src/domain/replica/reducers.ts"
  - "src/domain/replica/rosterView.ts"
  - "src/domain/replica/textFold.ts"
  - "src/domain/replica/transport.ts"
  - "src/domain/replica/verify.ts"
  - "src/domain/replica/versions.ts"
  - "src/domain/team/signedPayload.ts"
  - "src/test/replicaDoc.test.ts"
  - "src/test/replicaReevaluation.test.ts"
  - "test/fixtures/replica/vectors.json"
covered_digest: "v4:sha256:95c78c721730f9c1a6bd817eb0924bd554693f6c360f53d4271142e7f92fc8e1"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: "4/4 roadmap success criteria verified; 1 owner decision open (client id registration race)"
  gaps_closed:
    - "CR-01 provisional doc.compact text attributed to another writer (cc0d6b2f)"
    - "CR-02 incremental fold and from-scratch fold diverge on a late cover of a compaction (5936754f)"
    - "CR-03 context-dependent holds (missing blob, clock) never retried by addEntries (58a0b53f)"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Decide whether a rostered writer being able to win a Yjs client id registration race against another writer is acceptable for drop A, or whether Phase 31/33 must bind client ids to writers."
    expected: "Either an owner decision recorded (accept as an insider-only risk, with the registration-refused report shown in Phase 33), or a follow-up item to bind a client id to its writer so a later or concurrent registration cannot displace an earlier one."
    why_human: "Reproduced in the first verification (see Gaps and Findings 1) and not touched by the review fixes. It is an owner-decided design rule (D-18, D-19, T-30-28: the earlier claim in the total order wins), so it is not a failure of what was planned, but it weakens the MUS-02 wording 'unforgeable attribution' against an admitted insider. Whether that is acceptable is a risk decision, not a code check."
  - test: "Assign the late-joiner chain question to Phase 31 or 33: a joiner whose set starts after a checkpoint lacks the old doc.update entries and the chain prefixes of those writers, so later entries are held. Note that after CR-01 a joiner that holds only a compaction now shows its text as unverified and unattributed until the covered updates arrive."
    expected: "An owner decision recorded: how a late joiner obtains chain prefixes, and whether text shown from an unverified compaction should display as 'author not yet checked' in Phase 33 until the log catches up."
    why_human: "Recorded, not decided, by 30-06 and 30-12 summaries. The CR-01 fix makes the honest late-joiner view more conservative (no author named), which is correct but is a product choice the owner should see."
  - test: "Record the Y.decodeUpdate eager allocation residual (R-1) under the 4 MiB byte cap, which the review also raised as WR-07."
    expected: "Owner decision: accept as a known limit of the vendored decoder for drop A, or schedule a pre-decode struct-count check (the review's fix) in a hardening phase."
    why_human: "Known limit of the vendored decoder, recorded not decided. It does not block Phase 30 goal achievement."
  - test: "Decide where review warnings WR-01 to WR-09 are scheduled (they are recorded below as known, non-blocking, and were not in scope of the review fix)."
    expected: "A phase or a hardening list for each. Suggested: WR-01 and WR-02 with the Phase 31 roster (they need roster.canRunAgent), WR-03 and WR-09 with the next fold fix round (correctness of fork resolution and decision liveness), WR-04 to WR-08 as one hardening item."
    why_human: "Scheduling and priority are an owner call; none of them breaks a ROADMAP success criterion on the evidence below."
---

# Phase 30: Replication contract and co-editing core Verification Report

**Phase Goal:** Every machine that holds the same signed entries computes the same staff state, and product text can be edited by several people and agents at once with every change attributed.
**Verified:** 2026-11-19 (initial 18:30Z; re-verified 21:00Z after the review fixes)
**Status:** human_needed
**Re-verification:** Yes, after the code review fixes for CR-01, CR-02 and CR-03. The initial report is kept below; the re-verification section comes first in the body.

All four ROADMAP success criteria hold in the code, and the tests that prove them are real, not vacuous. Status stays human_needed because the owner decisions from the first verification are still open (client id registration race, late-joiner chains, the decoder allocation residual) and the review warnings need a schedule. Nothing here is a blocker for starting Phase 31.

## Re-verification after the review fixes (2026-11-19, 21:00Z)

Scope: 30-REVIEW.md (3 critical, 9 warning, 3 info) was written against the code this report first verified. The three critical findings are fixed in cc0d6b2f (CR-01), 5936754f (CR-02) and 58a0b53f (CR-03), with the report in 30-REVIEW-FIX.md. I read the code diffs and the tests, and ran every `replica*` test file plus `teamSignedPayload` in this worktree under the memory cap: **tests 281, pass 281, fail 0, cancelled 0, skipped 0** (273 before; the 8 new tests are 2 for CR-01, 3 for CR-02, 3 for CR-03). `dist/` contains the fixed code (checked for `earliestLateEffect`, `lateDependencies`, `claimant` and the CR-01 tests). Orchestrator evidence for the whole suite after the fixes: tests 4762, pass 4754, fail 0, cancelled 0, skipped 8 (environmental); not re-run here.

### The three critical findings

| Finding | Closed? | Evidence in code | Regression test |
|---------|---------|------------------|-----------------|
| CR-01 provisional compaction text attributed to another writer | CLOSED | `attribution.ts` `attributeText` takes an `AttributionProof` (state vector of the document built from accepted updates, plus the compaction writer). A run is split where the proof ends; text beyond it is flagged `unverified`, is attributed only to the compaction's own writer for client ids registered to that writer, and is `UNATTRIBUTED_WRITER` otherwise. `textFold.ts` stores the writer of each provisional compaction and passes the proof in `finish`. `summariseAuthors` keeps unverified rows apart. The per-version attribution in `versions.ts` (line 722) is built from accepted updates only (`attributionAtSnapshot`), so it never had the forgery path. Digests are unchanged (attribution is not in the canonical state). | `replicaDoc.test.ts`: "CR-01: text a provisional compaction holds under another device's client id is never attributed..." (forged text under A's client 11 has no writer, no member, `unverified`; nothing names A) and "CR-01: the log's own text keeps its author next to unverified text..." (split falls exactly where accepted updates end, same in reversed delivery, own-client text shown as the compactor's but still flagged). Both pass in my run. |
| CR-02 incremental and from-scratch fold diverge on a late cover | CLOSED | `reducers.ts` adds optional `lateDependencies(entry)`; `textFold.ts` names the covers of every `doc.compact`; `fold.ts` `earliestLateEffect` finds the first entry of the old order that a newly admitted entry can change, and `addEntries` then refolds instead of appending, reusing a prefix snapshot only if it was taken at or before that entry. I checked that `ordered` is built from every admitted entry (`checkpointOrder(chains.admitted, ...)`), the same set as the causal graph, so "arrived in the order" equals "arrived in the graph", the thing `view.graph.has` tests. The only reducer lookups of entries outside an entry's own past during `apply` are the two in `applyCompaction` (`view.entry(cover)` and `view.graph.has(cover)`), both covered; the other `view.entry` and `graph.concurrent` uses in `versions.ts` run inside `finish` over the final state, so they cannot diverge. | `replicaReevaluation.test.ts` CR-02 group: hostile compaction whose cover is delivered last equals the from-scratch fold and counts one refold; 120 seeded one-at-a-time and chunked deliveries mixing hostile (cover sorts after, cover never arrives) and honest compactions equal `foldEntries` on the whole result (order, families, digests, held, rejected, kept, refused, excluded); a compaction inside a checkpoint prefix whose cover arrives later is judged again. The review asked for a hostile-compaction property test; this is it. |
| CR-03 context-dependent holds never retried | CLOSED | `fold.ts` `addEntries` treats a `ctx` that is not the object the state was folded under as a change (`replaced`), no longer returns the old state, and restarts from the beginning when something was already applied (the snapshot was taken under the old context). The same object with nothing new still returns the same state. Future-dated entries are recomputed by `prepare`; missing-blob holds are decided again by the restart. | `replicaReevaluation.test.ts` CR-03 group: missing-blob compaction applied when a context with the blob replaces the old one, with and without new entries, plus 80 random orders with the context replaced mid-stream, all equal to `foldEntries`; held-for-key entries released; a future-dated entry and its successor released when the clock moves on and held again when it moves back; identity of state kept when nothing changed. |

Known cost recorded in the fix report: a replaced context is a full refold, so callers must pass the same context object while nothing changed. That is a Phase 31 usage rule, not a defect.

### The one changed existing assertion (CR-01)

The test "a set with the registrations and a compaction but none of the covered updates loads the compaction provisionally, marked unverified" in `replicaDoc.test.ts` used to assert that a joiner holding only device C's compaction saw spans attributed to the writers of the full log (devices A and B). I compared it against the version at 8824bff6. **That change is a correction, not a weakening.** The old assertion encoded the exact behaviour CR-01 is about: a signed compaction can vouch for its own writer and for nobody else, and a fold cannot tell an honest compaction from a forged one (the forged one is the same shape). The new assertion keeps the text, state vector and span places equal to the full log, and tightens: every span must carry no writer, no member and `unverified: true`, `incomplete` stays false, and, new, once the covered updates are added the attribution must equal the full log's exactly with nothing unverified. No assertion about text, convergence or places was dropped; one about naming authors was replaced by its safe opposite plus a convergence check. The trade-off is product-visible: an honest late joiner sees text with no named author until the log supplies the covered updates (see Human Verification item 2).

### Truth status after the fixes

| # | Truth | Status | Change |
|---|-------|--------|--------|
| 1 | Convergence of any delivery order, duplication or partition (MUS-01) | VERIFIED | Strengthened: the incremental path now equals the from-scratch fold also for late covers and changed contexts (CR-02, CR-03 tests above). `replicaConvergence.test.ts` unchanged and passing. |
| 2 | Equivocation proof and quarantine (MUS-01) | VERIFIED | Unchanged; WR-03 (three-branch fork) is a gap in lead resolution, not in detection or quarantine. Recorded below. |
| 3 | Co-edited text, every character attributed to its writer, foreign clients rejected (MUS-02) | VERIFIED, with the client id race residual | Strengthened: provisional text can no longer be attributed to another writer (CR-01). The registration race (Findings 1) is unchanged and still open. |
| 4 | Versions pin a hash; contested needs a fresh decision; agents never decide (MUS-03) | VERIFIED | Unchanged; WR-01, WR-02 and WR-09 are recorded below. `release.ts` is still untouched. |

**Score:** 4/4 truths verified, 0 present-but-behavior-unverified. The three fixed behaviours are behavior-dependent invariants (ordering, cancellation of stale outcomes, attribution), and each has a named test that fails on the old code according to the fix report; I read the tests and confirmed their assertions are on the whole result, but did not rebuild the old code to watch them fail.

### Review warnings and info: known, non-blocking

None of these is fixed at HEAD (the review fix was scoped to the criticals), none breaks a ROADMAP success criterion on the evidence in 30-REVIEW.md, and none was re-derived by me beyond reading the review. They are recorded so they are not lost.

| ID | Summary | Why it does not block Phase 30 | Suggested home |
|----|---------|--------------------------------|----------------|
| WR-01 | Gate verdicts accepted from any admitted device that labels itself as the seat's agent | Decisions still need a person holding `decision_for`, so an agent still cannot approve (MUS-03 holds); the unguarded step is the two gates before that, a documented plan choice (30-08 threat model) | Phase 31 roster (`canRunAgent`), default-deny predicate |
| WR-02 | Actor label not checked for `project.genesis` and `project.import`; agent identity in attribution is a claim | By design for text (D-06); for governance acts it needs an admitted lead device | Phase 31, one-line reducer check |
| WR-03 | A fork with three or more branches cannot be resolved by the lead's choice of the third branch | Detection and quarantine still work in every order (criterion 2); only lead resolution fails | Next fold fix round |
| WR-04 | One refused or held `doc.update` makes every later honest compaction `compact-mismatch` | The compaction is a cache; the log still gives the correct text | Hardening |
| WR-05 | Small entries force whole-history rebuilds (compaction check, version proposal) | Cost, not correctness; needs an admitted writer | Hardening |
| WR-06 | Decision algebra is cubic in the number of acts; causal graph keeps ancestor sets | Cost; needs a person holding a decision role | Hardening (cap acts per writer per version) |
| WR-07 | A hostile update allocates every struct before the struct cap applies; snapshot delete check is quadratic | This is owner item R-1, the decoder residual under the 4 MiB cap | Owner decision, then hardening |
| WR-08 | The fold keeps every delivered object forever; one Yjs document per registration, no cap | Memory growth; needs an admitted writer | Hardening |
| WR-09 | An act that saw a held act is held with it, so one bogus `decisionsSeen` id can block later honest decisions | Review calls it a design risk, not a proven break; depends on Phase 33 client behaviour | Next fold fix round or Phase 33 |
| IN-01 to IN-03 | Unreachable `precedence-cycle` hold; unused `updateClients`; `rank()` by status spelling | Cleanliness only | Any |

Not changed by the review fixes and still valid from the first verification: Findings 1 (client id registration race), the three unticked MUS checkboxes in `.planning/REQUIREMENTS.md` (lines 766 to 768), and the two named open items. The first-verification evidence follows unchanged except where marked.

## Goal Achievement

### Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Entry format v2 (per-writer, per-stream chains with cited heads, sealed bodies, blobs), the deterministic fold and the digest exist as pure code; any delivery order, duplication or partition of entries from up to five writers folds to the same state and digest (MUS-01) | VERIFIED | `src/domain/replica/{entry,verify,chain,order,fold,digest,checkpoint}.ts` exist and are substantive. `src/test/replicaConvergence.test.ts` runs 200 seeded random worlds of 2 to 5 writers (it asserts the generator really produced released versions, forks, tampered, future-dated, held, refused and kept entries, two streams and five writers) under four shuffled deliveries with five duplicates each, two partitions joined both ways, one-at-a-time arrival, and Kahn reference order equal to the sort. Pass. Purity: no `vscode` import, no clock or random reads in `src/domain/replica`, only `doc.ts` loads Yjs (`replicaBoundaries.test.ts` pass). After the review fixes, `replicaReevaluation.test.ts` adds the same equality for late covers and replaced contexts (re-verification above). |
| 2 | Two signed entries at one position by one writer produce a proof and quarantine that device on every machine, whatever the arrival order; a changed old entry breaks only that writer's chain (MUS-01) | VERIFIED | `replicaEquivocation.test.ts`: identical under all 24 arrival orders; proof checks with no roster; a proof sent as an entry quarantines on a machine holding one branch; another writer citing an excluded entry is still applied. `replicaChain.test.ts`: a changed old entry is rejected bad-signature, its writer's later entries are held chain-broken, every other writer is applied as before. Both pass. |
| 3 | Product text is a Yjs document carried in signed entries; random concurrent edits converge; every character's author is the writer that inserted it; an update under another writer's client id is rejected; Yjs and lib0 vendored at pinned versions with licences (MUS-02) | VERIFIED, with a flagged residual | Foreign-client rejection and unregistered-client hold are tested (`replicaDoc.test.ts`, whole-document re-encode refused). Hostile updates (embeds, formats, maps, nested types, Skip, 40 KB nested arrays, GC struct claiming 4,294,967,295 clocks, over-cap bytes) are refused and never throw. `replicaAttribution.test.ts` runs 150 seeds of persons and agent runs and checks every character against the client that typed it, in every delivery order. After CR-01, text that only an unverified compaction holds is never attributed to another writer. Vendoring: `package.json` pins `yjs` 13.6.33 and `lib0` 0.2.119 as exact devDependencies (no `dependencies` block); `vendor/yjs/yjs.cjs` hashes to the manifest value `74fe708b...1ef4` in `scripts/crdt-vendor.json`; `LICENSES.txt` holds both MIT texts; `verify-release-content.mjs` checks the packaged bytes; SECURITY.md documents it; `replicaVendor.test.ts` passes. Residual: see Findings 1. |
| 4 | Versions pin a content hash that must equal the text at the state vector named; concurrent conflicting decisions fold to "contested" and only a fresh decision that has seen them settles it; no agent actor can approve, reject, release or supersede (MUS-03) | VERIFIED | `versions.ts` accepts `version.propose` only when the blob opens, the hash matches, and the text at the snapshot equals the blob text (`text-not-in-document`, `hash-mismatch`; delete-only edit case D-34 tested). `decisions.ts` is a pure maximal-element algebra: one outcome class is effective, more than one is contested, nothing reads order, rank or time. Tests `replicaVersionDecisions.test.ts` (G7, G8, D11, D12, D14, D15, D16 to D20) and `replicaForbiddenActs.test.ts` (F1 to F9, including "the refusal is release.ts itself: every human-only event for an agent or a hub is refused agent-cannot-decide, in every state") pass. `src/domain/staff/release.ts` is unchanged (git diff since the phase start shows only `signedPayload.ts` changed outside `replica/`, `scripts/`, tests, SECURITY.md and package files; the review fixes touched only `src/domain/replica/` and two test files). |

**Score:** 4/4 roadmap criteria verified; 0 present-but-behavior-unverified.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/domain/replica/*.ts` (22 files) and `kindSchemas/` | Pure replication core | VERIFIED | Substantive, wired through `DEFAULT_REDUCERS` in `reducers.ts` (text, project, versions, integrity). No stubs found. The review fixes changed `attribution.ts`, `fold.ts`, `reducers.ts` and `textFold.ts`; all four are used and tested. |
| `src/test/replicaReevaluation.test.ts` | Regression tests for CR-02 and CR-03 | VERIFIED | New in 5936754f and 58a0b53f; 6 tests, pass. |
| `vendor/yjs/yjs.cjs`, `LICENSES.txt` | Pinned, hash-checked CRDT | VERIFIED | Build output (git-ignored, produced by `npm run compile`); hash equals manifest. |
| `scripts/crdt-vendor.json` | Manifest checked at compile, test, release | VERIFIED | Contains yjs, lib0, isomorphic.js records and input hashes; output sha256 matches the file on disk. |
| `test/fixtures/replica/vectors.json` | Canonical vectors for Phases 31, 32 | VERIFIED | `replicaVectors.test.ts` pass; no committed vector moved with the fixes (the fix report says so, and the vector test passes). |
| `src/domain/team/signedPayload.ts` | `staff-replica` purpose added | VERIFIED | One-line change; `teamSignedPayload.test.ts` extended and passing. |
| `30-CRDT-SPIKE.md` | Spike numbers and verdict (D-22) | VERIFIED | Verdict: no size or garbage collection problem found; convergence and attribution held on every seed. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `reducers.ts` | text, project, versions, integrity reducers | `DEFAULT_REDUCERS` | WIRED | Order documented: versions reads the doc family's state. |
| `fold.ts` `addEntries` | `reducers.ts` `lateDependencies` | `earliestLateEffect` over `state.options.reducers ?? DEFAULT_REDUCERS` | WIRED | New in 5936754f; `textReducer` is the one implementer. |
| `textFold.ts` `finish` | `attribution.ts` `attributeText` | `attributionProof(product)` | WIRED | New in cc0d6b2f. |
| `versions.ts` | `staff/release.ts` `transition` | import and call per gate step | WIRED | `agent-cannot-decide` comes from release.ts itself. |
| `textFold.ts` | `doc.ts` (only Yjs loader) | `inspectUpdate`, `applyUpdate`, `attributionRuns` | WIRED | No other file imports Yjs (grep). |
| `entry.ts` | `team/signedPayload.ts` | `signPayload` with purpose `staff-replica`, constant `signedAt` | WIRED | D-32. |
| `doc.ts` | `vendor/yjs/yjs.cjs` | lazy `require` | WIRED | Path resolves from `dist/domain/replica`. |

### Data-Flow Trace (Level 4)

Not applicable in the UI sense: the phase has no rendered surface. The fold output flows from signed entries through reducers to `families.*` and per-stream digests, checked end to end by the convergence property and now by the re-evaluation property.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Every Phase 30 test file and the signer test, after the review fixes | `node scripts/run-tests.mjs dist/test/replica*.test.js dist/test/teamSignedPayload.test.js` (capped, under the shared lock) | tests 281, pass 281, fail 0, cancelled 0, skipped 0 | PASS |
| Client id registration race | scratch script against `dist/` in the first verification (not committed) | See Findings 1; not touched by the fixes | FINDING |
| Full suite and release check | not re-run, per instruction | Orchestrator evidence after the fixes: tests 4762, pass 4754, fail 0, cancelled 0, skipped 8 (environmental) | ACCEPTED |

### Probe Execution

None declared by the plans; no `probe-*.sh` for this phase. SKIPPED.

### Requirements Coverage

| Requirement | Source plans | Description | Status | Evidence |
|-------------|--------------|-------------|--------|----------|
| MUS-01 | 30-01, 02, 04, 05, 09, 11, 12 | Per-writer signed hash-chained logs, deterministic fold and digest; equivocation proven and quarantined | SATISFIED | Criteria 1 and 2; CR-02 and CR-03 closed. WR-03 recorded (three-branch fork resolution). |
| MUS-02 | 30-01, 02, 03, 06, 10, 11, 12 | Product text co-edited through Yjs inside signed entries, with unforgeable attribution | SATISFIED with a flagged residual | Criterion 3; CR-01 closed; Findings 1 still narrows "unforgeable" for an admitted insider. |
| MUS-03 | 30-07, 08, 10, 12 | Versions pin a content hash; contested needs a fresh decision; agents never decide | SATISFIED | Criterion 4. WR-01, WR-02, WR-09 recorded. |

All three IDs from the phase and every plan frontmatter are accounted for in REQUIREMENTS.md. No orphaned IDs. Housekeeping: the three MUS checkboxes in `.planning/REQUIREMENTS.md` (lines 766 to 768) are still `[ ]`; tick them when the phase is closed.

### Owner decisions D-01 to D-37: honoured

Spot-verified against the code: D-01 and D-17 (pure folder, one Yjs loader, boundary test); D-02 (outside `replica/`, the only changes are the vendoring scripts, SECURITY.md, package files, the `staff-replica` purpose and a fixture); D-05 and D-32 (signer reused, constant `signedAt`, always-active key lookup, roster view decides authority); D-08 (no clock reads, `now` injected, 10 minute limit tested to the second; CR-03 now also re-reads the injected clock when the context is replaced); D-12 (portable proof, same result in all 24 orders); D-16 and D-33 (pinned devDependencies, hash manifest, lib0 0.2.119 not 0.2.120, no runtime `dependencies`); D-19 and D-35 (ownership check, content allow list, clock rule, caps, try/catch); D-21 and D-37 (compaction a verified cache; after CR-01 a cache that stands in for missing updates no longer speaks for another person); D-22 (spike written); D-24 and D-25 (release.ts reused unchanged, contested by outcome class, nothing picks by order or rank); D-30 (no em-dashes in `src/domain/replica` or the new test file, rechecked by grep; SECURITY.md gets the vendored code note). D-28: tests are seeded, print the seed, and bounded.

### Anti-Patterns Found

None blocking. No TBD, FIXME or XXX markers in `src/domain/replica` or the new test file (rechecked after the fixes), no stub returns, no `console.log` implementations.

### Human Verification Required

#### 1. Client id registration race (owner risk decision)

**Test:** Review Findings 1 and decide: accept as an insider-only limit of drop A, or schedule a binding of Yjs client id to writer in Phase 31 or 33.
**Expected:** A recorded decision.
**Why human:** Reproduced behavior that the owner's own rule (D-18, D-19, T-30-28) produces. It is a risk call, not a defect against the plan.

#### 2. Late-joiner chains and unverified compaction text

**Test:** Decide how a joiner whose set starts after a checkpoint obtains the chain prefixes of writers it has not seen (flagged in 30-06 and 30-12), and whether Phase 33 shows compaction-only text as "author not yet checked".
**Expected:** Owner decision recorded for Phase 31 or 33.
**Why human:** Recorded, not decided, by the plans; CR-01 made the unverified display state real.

#### 3. Y.decodeUpdate eager allocation (R-1, review WR-07)

**Test:** Accept the residual under the 4 MiB cap, or schedule the pre-decode struct-count check.
**Expected:** Owner decision recorded.
**Why human:** Known limit of the vendored decoder.

#### 4. Schedule for review warnings WR-01 to WR-09

**Test:** Assign each warning to a phase or a hardening list (suggested homes in the table above).
**Expected:** A plan for each; none blocks Phase 31.
**Why human:** Priority call.

### Gaps Summary

No gaps against the four success criteria, and no gaps remain from the review's three critical findings. Decisions to make are listed above. The first-verification finding is kept below unchanged.

**Findings 1: client id registration race lets a rostered writer displace another writer's text and take its attribution.**
Reproduced with a scratch script against `dist/` (not committed, not part of the repo). Setup: writer A (older, lamport 9) registers client id 777 for product `p` and types "written by A". Writer B (lamport 1, cites no dependencies, so it is concurrent with A's entries) registers the same id 777 and re-sends A's exact update bytes in its own `doc.update`. Result: A's registration is refused `client-collision`, A's update is refused `foreign-client`, the folded text is "written by A", and the attribution for all 12 characters names B's member. The same convergence holds in every delivery order, so this is deterministic and not a convergence bug. It follows directly from D-18 and D-19 (the claim earlier in the total order wins, and lamport sorts before writer), and the plan's own threat row T-30-28 mitigates accidental collisions only. It needs an admitted writer, so it is an insider risk, and Phase 33 will show the refused registration to A. It still weakens "unforgeable attribution" in MUS-02. Possible fixes for the owner to weigh: derive or constrain the client id from the writer so two writers cannot claim one id, or let the registration that is causally earlier win over one that is merely lower in lamport. Neither is needed to proceed to Phase 31. I did not re-run this probe after the review fixes; none of the three fixes touches registration handling (`textFold.ts` registration code is unchanged in the diff), so I expect it to reproduce as before.

---

_Verified: 2026-11-19 (initial), re-verified 2026-11-19T21:00:00Z_
_Verifier: Claude (gsd-verifier)_
