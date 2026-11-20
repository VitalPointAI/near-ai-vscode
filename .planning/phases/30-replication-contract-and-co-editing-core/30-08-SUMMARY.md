---
phase: 30-replication-contract-and-co-editing-core
plan: 08
subsystem: replica-versions
tags: [replication, versions, release-gate, yjs-snapshot, causal-order, fold]
status: complete

requires:
  - phase: 30-02
    provides: fold engine, reducer contract, causal graph, textAtSnapshot and snapshotMissing, replica test world
provides:
  - src/domain/replica/versions.ts: versionsReducer, replicaVersionHash, OWNER_PROMPT_THRESHOLD, isOwnerSide, actorForTransition, VERSION_REFUSALS, VERSION_HOLDS and the VersionView, VersionRecord and ProductVersions types
  - src/domain/replica/kindSchemas/versions.ts: validateVersionsData for the nine versions-family kinds
  - src/test/replicaVersions.test.ts: 21 tests
affects: [30-10, 30-12, Phase 31, Phase 33]

requirements-completed: [MUS-03]

actuals:
  tokens: 15500
  tasks: 3
  commits: 3
plan_head_before: f2c4c62aab440dbb5734ae8b8b9f1bb83eadebd2
plan_head_after: bf6b79bdee32680c9f2049e519e0161f1858bf09

key-files:
  created:
    - src/domain/replica/versions.ts
    - src/test/replicaVersions.test.ts
  modified:
    - src/domain/replica/kindSchemas/versions.ts

key-decisions:
  - "version.propose carries textBlob as the hash of a sealed blob in the shared blob store (not the entry's own body blob). Blob absent: held missing-blob. Blob unreadable or not exactly { text, header }: refused bad-blob."
  - "Check order for a proposal: product known (held product-unknown), owner side (refused not-owner), blob, hash (refused hash-mismatch), duplicate hash (refused no-change), snapshot covered (held updates-missing), text at snapshot equals blob text (refused text-not-in-document)."
  - "Per-version gate state is derived in finish from the version's acts: tradecraft verdicts, then guard verdicts, then submit, each through release.ts transition(). A CLEARED counts as having the tradecraft sign-off only when the effective sign-off is in its causal past; otherwise release.ts refuses it tradecraft-required."
  - "Disagreeing maximal verdicts (HOLD with CLEARED, NOT READY with SIGN-OFF) apply the negative one and set verdictConflict, until a fresh verdict has all of them in its past. A submit counts only after an effective CLEARED in its past; differing decision_for among maximal submits sets submitConflict and leaves the version guard-checked."
  - "product.create and product.owner need a person actor (an agent act is refused not-authorised) and a role at the cited roster: section_lead of the product's section, staff_lead or deputy_lead for create; section lead or staff lead for owner. Concurrent product.owner entries resolve by fold order."
  - "Each version keeps the roles in force when it was proposed, so a later product.owner changes later proposals only."

duration: single session
completed: 2026-11-19
---

# Phase 30 Plan 08: Products and versions through the release gate Summary

Products and their versions now fold on the replica layer: a proposal must pin text that really was in the document (blob hash, version hash with pins, Yjs snapshot including the delete set), numbering, concurrent proposals and "N changes since" are fold outputs, and each version runs the gate chain up to awaiting-decision through today's `release.ts` `transition()`, independent of arrival order.

## Commits

| Commit | Task | What |
|--------|------|------|
| `b7947bf8` | 1 (tracer) | `versions.ts`, `kindSchemas/versions.ts`, tracer tests (2) |
| `7f21f654` | 2 | tests: authority, held and refused proposals, D-34, numbering, concurrency, changes since, owner prompt, products and owners, schema shapes |
| `bf6b79bd` | 3 | tests: G2 to G5, concurrent verdicts, 24 delivery orders, release.ts reasons |

The reducer was written in one pass, so commit `b7947bf8` already holds the Task 2 and Task 3 logic; commits 2 and 3 add the tests for those tasks. Every test was run against the final code (see Verification).

## Verification

All runs under the shared lock and cap (4 GB, no swap, 300 s), after `node scripts/vendor-libs.mjs` and `tsc -p tsconfig.json` (clean, no output):

- `replicaVersions` + `staffRelease`: 34 tests, 34 pass, 0 fail (21 in replicaVersions, 13 in staffRelease).
- `replicaTracer`: 10 pass. `replicaContracts`: 15 pass, 2 fail, see Cross-plan fallout. The full suite was not run (owner instruction).
- Acceptance: `grep -c textAtSnapshot versions.ts` 3, `OWNER_PROMPT_THRESHOLD` 2 (the N4 test asserts the value 20), `proposedAtSameTimeAs` 3, `grep -cE "G1|G2|G3|G4|G5|F8"` in the test 9, `git diff --stat f2c4c62a..HEAD -- src/domain/staff src/test/staffRelease.test.ts` prints nothing, no em-dash in the three files.

## Deviations from Plan

None to the plan's behaviour. Two reading choices worth knowing (both in key-decisions): `product.create` and `product.owner` require a person actor, and a CLEARED needs the sign-off in its causal past (stricter than "present in the set"), which is what makes "CLEARED before SIGN-OFF" refused independent of delivery order.

## Cross-plan fallout (needs the orchestrator at integration)

`src/test/replicaContracts.test.ts` (owned by 30-02, outside this plan's files) holds two tests that assert every non-doc family still returns the `schema not yet defined` reason: "every known kind except doc.client and doc.update fails closed with the schema-pending reason" and "validateData dispatches each family to its own file" (the `product.create` row). Filling the versions schema makes both fail. Every wave-3 plan that fills a family schema (30-04, 30-05, 30-06) will break the same two tests, so the fix belongs in one place at integration: make those tests expect `SCHEMA_PENDING` only for the families still pending (or drop filled families from the list). I did not edit the file (not in files_modified).

## Notes for 30-10 and 30-12

- Register `versionsReducer` after `textReducer` (it reads `view.state('doc')` as `TextState`). Its family id is `versions`.
- `ProductVersions.records[].acts` holds every withdraw, decide, release and supersede act that names the version hash, unjudged, with `release` (the `ProductRecord` at awaiting-decision at most). Unattached verdict and submit acts are reported as `stale-version` in `ProductVersions.refusals`; gate refusals from `transition()` also land there (not in the fold's `refused` list, which carries apply-time refusals).
- Writers must set `deps` to the heads they have seen when proposing, so the updates the snapshot names are before the proposal in the total order; otherwise the proposal is held `updates-missing`. This is a write-path rule for Phase 31.
- `view.state('doc')` map keys are `${stream}/${product}` (as in textFold.ts); 30-06 must keep that.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-30-31 (text never in the document: F8 and D-34 tests), T-30-32 (non-owner: `not-owner` tests), T-30-33 (concurrent verdicts: D-37 test, 14 delivery orders) and T-30-34 (an agent is never presented as a person: `actorForTransition`) are covered.

## Self-Check: PASSED

Files exist: `src/domain/replica/versions.ts`, `src/domain/replica/kindSchemas/versions.ts`, `src/test/replicaVersions.test.ts`. Commits `b7947bf8`, `7f21f654`, `bf6b79bd` are ancestors of HEAD on `agent-30-08`. No file outside the plan's `files_modified` was touched (the diff from `f2c4c62a` is these three files plus this summary).
