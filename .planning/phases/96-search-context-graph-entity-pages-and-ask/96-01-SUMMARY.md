---
phase: 96-search-context-graph-entity-pages-and-ask
plan: "01"
subsystem: context graph acceptance
tags: [context-graph, authorization, citations, synthetic]
provides:
  - Replayable fictional corpus and fixed expectations for reader-relative graph and exact citations.
affects: [96]
requirements-completed: []
duration: not captured
completed: 2026-11-26
---

# Phase 96 Plan 01 summary

Local fixture commit `32227067c` supplies a fictional corpus and fixed
expected results for two readers. Graph output and citation lookup match the
corpus with restricted evidence absent. The same-compartment source denial
stays invisible to both readers. The reader allowed both compartments sees
additional authorized evidence and can open its exact source version and text.

## Verification

- The locked offline install succeeded in the isolated worktree. Initial
  capped compile and TAP recorded one pass and three intended failures.
  The final capped run passed all four tests with zero skips.
- Saved reports and exact file hashes are in
  `.scratch/phase-96/fixture.zCoVko/`. The independent review checked
  positive controls, exact versions and text spans, file hashes and the
  release exclusions for the test-only files. The source range scan passed.
- Governed SQL, search and browser acceptance should replay the same corpus
  through actual authorization. Phase 93 remains a production dependency.
  The fixture establishes no production access control or query behavior.

## Open conditions

None.
