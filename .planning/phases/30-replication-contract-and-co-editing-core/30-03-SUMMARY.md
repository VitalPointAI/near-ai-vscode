---
phase: 30-replication-contract-and-co-editing-core
plan: 03
subsystem: replica
tags: [crdt, yjs, spike, measurement]
requires:
  - phase: 30-01
    provides: vendored Yjs bundle (vendor/yjs/yjs.cjs) and scripts/crdt-vendor.json hashes
provides:
  - scripts/crdt-spike.mjs (seeded CRDT spike)
  - 30-CRDT-SPIKE.md (D-22 numbers and verdict)
affects: [phase-33]
tech-stack:
  added: []
  patterns: [seeded xorshift workload, forced-gc heap measure]
key-files:
  created:
    - scripts/crdt-spike.mjs
    - .planning/phases/30-replication-contract-and-co-editing-core/30-CRDT-SPIKE.md
  modified: []
key-decisions:
  - "Verdict: no size or garbage collection problem found; gc-off fold doc and compaction blobs are affordable."
  - "Phase 33 input: gc-on full state was 61 to 68 percent smaller than gc-off on this deletion-heavy workload."
requirements-completed: [MUS-02]
duration: 20min
completed: 2026-11-19
status: complete
commits: 2
plan_head_before: d00b14ee2c7ab9e68c5bfb1d0d834cdaf321b007
plan_head_after: 3d2638031b5b701cd47d48671a4517a047be2da7
actuals:
  tokens: 9000
  tasks: 2
  commits: 2
---

# Phase 30 Plan 03: CRDT spike Summary

A seeded spike over the shipped Yjs bundle shows a garbage-collection-off fold document costs 4.7 to 5.7 bytes per character for a 30-page, 20-author product, so no size problem was found and the Loro fallback is not needed.

## What was built

- `scripts/crdt-spike.mjs`: options `--pages --persons --agents --seed (comma list) --out`; functions `workload`, `measure`, `checkConvergence`, `checkAttribution`, `report`. It loads `vendor/yjs/yjs.cjs`, refuses to run if the file's sha256 differs from `scripts/crdt-vendor.json`, and exits 1 (printing the seed) on a convergence or attribution failure. Yjs client ids are taken from the seeded generator, so a seed replays exactly (verified by two identical runs).
- `30-CRDT-SPIKE.md`: method, environment, thresholds, per-seed tables, a summary across seeds, verdict.

## Results (12 persons, 8 agent runs, 30 pages, seeds 30 to 32)

- Final text 92 067 to 94 201 characters; 2 900 to 3 200 updates.
- Typing batches: median 53 bytes, p99 105 to 106, max 108 to 109. Paste max 2 648 to 2 909; rewrite max 3 589 to 3 961.
- Full state gc off 436 595 to 520 879 bytes (4.73 to 5.66 per character, threshold 8); gc on 166 021 to 177 248 bytes.
- Apply all updates 19 to 22 ms; compaction plus last 500 updates loads in 5 to 10 ms (threshold 500); attribution walk about 0.1 ms; heap peak 105 to 114 MB (threshold 256).
- Convergence and attribution held on every seed.
- The gc saving is above the 25 percent mark, recorded as an input for Phase 33's compaction default. Nothing changed in this phase.

## Deviations from Plan

**1. [Rule 1 - Bug] Workload first came out paste-dominated.** The first full run produced only about 250 updates (pastes reached the target at once), which would not test typing batches. Rebalanced the pattern mix (typing dominant, agents stream short chunks, more deletions and rewrites) before the final run.

**2. [Rule 1 - Bug] Non-reproducible seeds.** Yjs picks client ids at random, so the same seed gave different results. Client ids now come from the seeded generator.

The script's `workload`, `measure` and `checkConvergence` take an optional last `Y` argument (defaulting to the vendored bundle); this is an addition, not a change in behaviour.

## Notes

- The report's timings and heap figures vary a little between runs; sizes, counts and checks are deterministic per seed.
- The gc-off versus gc-on gap is the text of deleted ranges that gc-off keeps for version restore; the workload is deletion-heavy on purpose.
- No files outside `files_modified` were touched. `vendor/` was rebuilt in the worktree (gitignored).

## Known Stubs

None.

## Self-Check: PASSED

scripts/crdt-spike.mjs and 30-CRDT-SPIKE.md exist; commits 962bca4f and 3d263803 are on agent-30-03.
