---
phase: 30-replication-contract-and-co-editing-core
verified: 2026-11-19T18:30:00Z
status: human_needed
score: 4/4 roadmap success criteria verified in code and tests; 1 owner decision open (client id registration race, see Human Verification)
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
  - "test/fixtures/replica/vectors.json"
covered_digest: "v4:sha256:68da1fb20c81d44be5909db20f47d04f975a17ab18551a902703eb1bd1677fe0"
behavior_unverified: 0
overrides_applied: 0
re_verification: false
human_verification:
  - test: "Decide whether a rostered writer being able to win a Yjs client id registration race against another writer is acceptable for drop A, or whether Phase 31/33 must bind client ids to writers."
    expected: "Either an owner decision recorded (accept as an insider-only risk, with the registration-refused report shown in Phase 33), or a follow-up item to bind a client id to its writer so a later or concurrent registration cannot displace an earlier one."
    why_human: "Reproduced in this verification (see Gaps and Findings). It is an owner-decided design rule (D-18, D-19, T-30-28: the earlier claim in the total order wins), so it is not a failure of what was planned, but it weakens the MUS-02 wording 'unforgeable attribution' against an admitted insider. Whether that is acceptable is a risk decision, not a code check."
  - test: "Record the two items the orchestrator already named as open: late-joiner chains that start after a checkpoint (decision needed in Phase 31/33), and the Y.decodeUpdate eager allocation residual under the 4 MiB byte cap."
    expected: "Each has an owner or phase assigned. Neither blocks Phase 30 goal achievement."
    why_human: "Recorded, not decided. 30-06-SUMMARY and 30-12-SUMMARY flag the late joiner; the allocation residual is a known limit of the vendored decoder."
---

# Phase 30: Replication contract and co-editing core Verification Report

**Phase Goal:** Every machine that holds the same signed entries computes the same staff state, and product text can be edited by several people and agents at once with every change attributed.
**Verified:** 2026-11-19
**Status:** human_needed
**Re-verification:** No, initial verification

All four ROADMAP success criteria hold in the code, and the tests that prove them are real, not vacuous. Status is human_needed because one adversarial probe found a case that the owner should accept or reject on purpose (below), and two known open items need an owner or phase attached. Nothing here is a blocker for starting Phase 31.

## Goal Achievement

### Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Entry format v2 (per-writer, per-stream chains with cited heads, sealed bodies, blobs), the deterministic fold and the digest exist as pure code; any delivery order, duplication or partition of entries from up to five writers folds to the same state and digest (MUS-01) | VERIFIED | `src/domain/replica/{entry,verify,chain,order,fold,digest,checkpoint}.ts` exist and are substantive (3953 lines in the folder). `src/test/replicaConvergence.test.ts` runs 200 seeded random worlds of 2 to 5 writers (it asserts the generator really produced released versions, forks, tampered, future-dated, held, refused and kept entries, two streams and five writers) under four shuffled deliveries with five duplicates each, two partitions joined both ways, one-at-a-time arrival, and Kahn reference order equal to the sort. I ran it: pass. Purity: no `vscode` import, no clock or random reads in `src/domain/replica`, only `doc.ts` loads Yjs (`replicaBoundaries.test.ts` pass). |
| 2 | Two signed entries at one position by one writer produce a proof and quarantine that device on every machine, whatever the arrival order; a changed old entry breaks only that writer's chain (MUS-01) | VERIFIED | `replicaEquivocation.test.ts`: "a cloned device that signs two histories gives one proof and quarantine from the fork, identical under all 24 arrival orders"; proof checks with no roster; a proof sent as an entry quarantines on a machine holding one branch; another writer citing an excluded entry is still applied. `replicaChain.test.ts`: "a changed old entry is rejected bad-signature, its writer's later entries are held chain-broken, and every other writer is applied as before". Both pass in my run. |
| 3 | Product text is a Yjs document carried in signed entries; random concurrent edits converge; every character's author is the writer that inserted it; an update under another writer's client id is rejected; Yjs and lib0 vendored at pinned versions with licences (MUS-02) | VERIFIED, with a flagged residual | Foreign-client rejection and unregistered-client hold are tested (`replicaDoc.test.ts`, whole-document re-encode refused). Hostile updates (embeds, formats, maps, nested types, Skip, 40 KB nested arrays, GC struct claiming 4,294,967,295 clocks, over-cap bytes) are refused and never throw. `replicaAttribution.test.ts` runs 150 seeds of persons and agent runs and checks every character against the client that typed it, in every delivery order. Vendoring: `package.json` pins `yjs` 13.6.33 and `lib0` 0.2.119 as exact devDependencies (no `dependencies` block); `vendor/yjs/yjs.cjs` hashes to the manifest value `74fe708b...1ef4` in `scripts/crdt-vendor.json`; `LICENSES.txt` holds both MIT texts; `verify-release-content.mjs` checks the packaged bytes; SECURITY.md documents it; `replicaVendor.test.ts` passes. Residual: see Findings 1. |
| 4 | Versions pin a content hash that must equal the text at the state vector named; concurrent conflicting decisions fold to "contested" and only a fresh decision that has seen them settles it; no agent actor can approve, reject, release or supersede (MUS-03) | VERIFIED | `versions.ts` accepts `version.propose` only when the blob opens, the hash matches, and the text at the snapshot equals the blob text (`text-not-in-document`, `hash-mismatch`; delete-only edit case D-34 tested). `decisions.ts` is a pure maximal-element algebra: one outcome class is effective, more than one is contested, nothing reads order, rank or time. Tests `replicaVersionDecisions.test.ts` (G7, G8, D11, D12, D14, D15, D16 to D20) and `replicaForbiddenActs.test.ts` (F1 to F9, including "the refusal is release.ts itself: every human-only event for an agent or a hub is refused agent-cannot-decide, in every state") pass. `src/domain/staff/release.ts` is unchanged (git diff since the phase start shows only `signedPayload.ts` changed outside `replica/`, `scripts/`, tests, SECURITY.md and package files). |

**Score:** 4/4 roadmap criteria verified; 0 present-but-behavior-unverified (every behavior-dependent truth, such as cancellation and ordering invariants, is covered by a named passing test).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/domain/replica/*.ts` (22 files) and `kindSchemas/` | Pure replication core | VERIFIED | Substantive, wired through `DEFAULT_REDUCERS` in `reducers.ts` (text, project, versions, integrity). No stubs found. |
| `vendor/yjs/yjs.cjs`, `LICENSES.txt` | Pinned, hash-checked CRDT | VERIFIED | Build output (git-ignored, produced by `npm run compile`); hash equals manifest. |
| `scripts/crdt-vendor.json` | Manifest checked at compile, test, release | VERIFIED | Contains yjs, lib0, isomorphic.js records and input hashes; output sha256 matches the file on disk. |
| `test/fixtures/replica/vectors.json` | Canonical vectors for Phases 31, 32 | VERIFIED | `replicaVectors.test.ts` pass. |
| `src/domain/team/signedPayload.ts` | `staff-replica` purpose added | VERIFIED | One-line change; `teamSignedPayload.test.ts` extended and passing. |
| `30-CRDT-SPIKE.md` | Spike numbers and verdict (D-22) | VERIFIED | Verdict: no size or garbage collection problem found; convergence and attribution held on every seed. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `reducers.ts` | text, project, versions, integrity reducers | `DEFAULT_REDUCERS` | WIRED | Order documented: versions reads the doc family's state. |
| `versions.ts` | `staff/release.ts` `transition` | import and call per gate step | WIRED | `agent-cannot-decide` comes from release.ts itself. |
| `textFold.ts` | `doc.ts` (only Yjs loader) | `inspectUpdate`, `applyUpdate`, `attributionRuns` | WIRED | No other file imports Yjs (grep). |
| `entry.ts` | `team/signedPayload.ts` | `signPayload` with purpose `staff-replica`, constant `signedAt` | WIRED | D-32. |
| `doc.ts` | `vendor/yjs/yjs.cjs` | lazy `require` | WIRED | Path resolves from `dist/domain/replica`. |

### Data-Flow Trace (Level 4)

Not applicable in the UI sense: the phase has no rendered surface. The fold output flows from signed entries through reducers to `families.*` and per-stream digests, checked end to end by the convergence property.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Every Phase 30 test file and the signer test | `node scripts/run-tests.mjs dist/test/replica*.test.js dist/test/teamSignedPayload.test.js` (capped, under the shared lock) | tests 273, pass 273, fail 0, cancelled 0, skipped 0 | PASS |
| Client id registration race | scratch script against `dist/` (not committed) | See Findings 1 | FINDING |
| Full suite and release check | not re-run, per instruction | Orchestrator evidence: tests 4754, pass 4746, fail 0, skipped 8 (environmental); `verify:release` green | ACCEPTED |

### Probe Execution

None declared by the plans; no `probe-*.sh` for this phase. SKIPPED.

### Requirements Coverage

| Requirement | Source plans | Description | Status | Evidence |
|-------------|--------------|-------------|--------|----------|
| MUS-01 | 30-01, 02, 04, 05, 09, 11, 12 | Per-writer signed hash-chained logs, deterministic fold and digest; equivocation proven and quarantined | SATISFIED | Criteria 1 and 2. |
| MUS-02 | 30-01, 02, 03, 06, 10, 11, 12 | Product text co-edited through Yjs inside signed entries, with unforgeable attribution | SATISFIED with a flagged residual | Criterion 3; Findings 1 narrows "unforgeable" for an admitted insider. |
| MUS-03 | 30-07, 08, 10, 12 | Versions pin a content hash; contested needs a fresh decision; agents never decide | SATISFIED | Criterion 4. |

All three IDs from the phase and every plan frontmatter are accounted for in REQUIREMENTS.md. No orphaned IDs (the table maps only MUS-01 to MUS-03 to Phase 30). Housekeeping: the three MUS checkboxes in `.planning/REQUIREMENTS.md` (lines 766 to 768) are still `[ ]`; tick them when the phase is closed.

### Owner decisions D-01 to D-37: honoured

Spot-verified against the code: D-01 and D-17 (pure folder, one Yjs loader, boundary test); D-02 (outside `replica/`, the only changes are the vendoring scripts, SECURITY.md, package files, the `staff-replica` purpose and a fixture); D-05 and D-32 (signer reused, constant `signedAt`, always-active key lookup, roster view decides authority); D-08 (no clock reads, `now` injected, 10 minute limit tested to the second); D-12 (portable proof, same result in all 24 orders); D-16 and D-33 (pinned devDependencies, hash manifest, lib0 0.2.119 not 0.2.120, no runtime `dependencies`); D-19 and D-35 (ownership check, content allow list, clock rule, caps, try/catch); D-21 and D-37 (compaction a verified cache); D-22 (spike written); D-24 and D-25 (release.ts reused unchanged, contested by outcome class, nothing picks by order or rank); D-30 (no em-dashes in `src/domain/replica`; SECURITY.md gets the vendored code note). D-28: tests are seeded, print the seed, and bounded.

### Anti-Patterns Found

None blocking. No TBD, FIXME or XXX markers in `src/domain/replica`, no stub returns, no `console.log` implementations (the one `console.log` is a stats line inside a test).

### Human Verification Required

#### 1. Client id registration race (owner risk decision)

**Test:** Review Findings 1 and decide: accept as an insider-only limit of drop A, or schedule a binding of Yjs client id to writer in Phase 31 or 33.
**Expected:** A recorded decision.
**Why human:** Reproduced behavior that the owner's own rule (D-18, D-19, T-30-28) produces. It is a risk call, not a defect against the plan.

#### 2. Known open items

**Test:** Assign the late-joiner chain question (a joiner whose set lacks the old `doc.update` entries also lacks those writers' chain prefixes, so later entries are held; flagged in 30-06 and 30-12 summaries) and the `Y.decodeUpdate` allocation residual to a phase.
**Expected:** Owner decision recorded for Phase 31 or 33.
**Why human:** Recorded, not decided, by the plans.

### Gaps Summary

No gaps against the four success criteria. One finding to decide on:

**Findings 1: client id registration race lets a rostered writer displace another writer's text and take its attribution.**
Reproduced with a scratch script against `dist/` (not committed, not part of the repo). Setup: writer A (older, lamport 9) registers client id 777 for product `p` and types "written by A". Writer B (lamport 1, cites no dependencies, so it is concurrent with A's entries) registers the same id 777 and re-sends A's exact update bytes in its own `doc.update`. Result: A's registration is refused `client-collision`, A's update is refused `foreign-client`, the folded text is "written by A", and the attribution for all 12 characters names B's member. The same convergence holds in every delivery order, so this is deterministic and not a convergence bug. It follows directly from D-18 and D-19 (the claim earlier in the total order wins, and lamport sorts before writer), and the plan's own threat row T-30-28 mitigates accidental collisions only. It needs an admitted writer, so it is an insider risk, and Phase 33 will show the refused registration to A. It still weakens "unforgeable attribution" in MUS-02. Possible fixes for the owner to weigh: derive or constrain the client id from the writer so two writers cannot claim one id, or let the registration that is causally earlier win over one that is merely lower in lamport. Neither is needed to proceed to Phase 31.

---

_Verified: 2026-11-19_
_Verifier: Claude (gsd-verifier)_
