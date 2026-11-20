---
phase: 30-replication-contract-and-co-editing-core
plan: 07
subsystem: replica-core
tags: [replication, decisions, contested, causal-precedence, pure-function]
status: complete

requires:
  - phase: 30-02
    provides: permutations helper in src/test/helpers/replicaWorld.ts
provides:
  - src/domain/replica/decisions.ts: DECISION_OUTCOMES, OUTCOME_CLASS, DecisionAct, DecisionInput, DecisionResult, DECISION_REFUSALS, resolveDecisions
  - src/test/replicaDecisions.test.ts: decision table rows D1-D20 and D22-D24, each under every permutation of its acts
affects: [30-10 versions fold wiring]

actuals:
  tokens: 6600
  tasks: 2
  commits: 2
plan_head_before: f2c4c62aab440dbb5734ae8b8b9f1bb83eadebd2
plan_head_after: e0063c05014928707224b23c3a46de782fa18ca9

tech-stack:
  added: []
  patterns:
    - "Pure algebra over acts plus an injected causal relation: output is sorted by id, input order is never read"
    - "Validity of an act is judged against its own causal past, visiting smaller pasts first"

key-files:
  created:
    - src/domain/replica/decisions.ts
    - src/test/replicaDecisions.test.ts
  modified: []

key-decisions:
  - "Precedence is the transitive closure of (before OR seen), so a capped deps list cannot break a chain"
  - "An act that saw a held act is held with it (cascade), so D24 holds the whole dependent chain until the unknown entry arrives"
  - "Terminal is judged against the act's own causal past: an act whose past resolves to an effective WITHDRAW or SUPERSEDE is refused terminal; a contested past never makes it terminal, so a fresh act covering the contest settles it"
  - "A decline that saw no act, or saw a confirmed one, is refused decline-not-pending"
  - "Acts in a precedence cycle are held (precedence-cycle) and acts with a non-listed outcome are dropped; honest hash-linked entries cannot produce either, the function stays total"

requirements-completed: [MUS-03]

duration: short
completed: 2026-11-19
---

# Phase 30 Plan 07: Decision algebra Summary

`resolveDecisions` is a pure function of one version's acts and a causal relation. Maximal acts under causal-or-seen precedence are grouped into outcome classes; one class is effective with all names, more than one is contested and neither applies. Nothing reads fold order, array order, rank, names or time.

## What was built

- `src/domain/replica/decisions.ts`: classes APPROVE (approve, release), REJECT, WITHDRAW, SUPERSEDE; `decline` has no class. Result lists (effective, contested, pending, superseded, refused, held) are sorted by id. `terminal` is true for an effective WITHDRAW or SUPERSEDE; `finalBeforeDispute` is set for a contest between a final and a non-final act (wording only). The file imports nothing.
- `src/test/replicaDecisions.test.ts`: 31 tests. Every row D1-D20 and D22-D24 has a named test run over all permutations of its acts (at most 6 acts, so at most 720 orders), plus: supersede concurrent with withdraw is contested, supersede terminal, release no-approval, supersede no-release, decline-not-pending, precedence by past equals precedence by seen, a name-rotation test (status, outcome and effective ids unchanged), and a totality test (duplicate ids, a precedence cycle, a hostile outcome name). D21 is a chain-level row tested through the fold in 30-10.

## Verification

Under the memory cap and shared lock: `node scripts/vendor-libs.mjs && tsc -p tsconfig.json && node scripts/run-tests.mjs dist/test/replicaDecisions.test.js` gave tests 31, pass 31, fail 0. `grep -cE "from '\./(fold|reducers|versions)'|staff/release"` on decisions.ts is 0; 23 `test('D<n> ` titles; "permutations" appears twice in the test file. The full suite was not run (instructed).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Maximal-act test used the precedence arguments the wrong way round**
- **Found during:** Task 2 (first full run, 10 rows failed)
- **Issue:** `settle` treated an act as non-maximal when it was in the past of another in the wrong direction, so later acts never superseded earlier ones.
- **Fix:** swapped the arguments (`preceded(m, o)`) and documented the direction on `settle`.
- **Files modified:** src/domain/replica/decisions.ts
- **Commit:** e0063c05 (fixed before the Task 2 commit; Task 1 rows D1, D2 and D4 do not depend on direction)

### Other notes

- Two choices beyond the plan text: the `held` reason `precedence-cycle`, and the cascade that holds an act that saw a held act. Both only add handling for input that honest entries cannot produce, or that D24 implies.
- The Task 1 commit already contains the whole algorithm (validity rules included) rather than a reduced core; Task 2 added the remaining tests and the direction fix. The tracer rows pass under both.

## Known Stubs

None.

## Threat Flags

None. T-30-29 and T-30-30 are mitigated by the contested and pending rules and their all-permutation tests.

## Files touched outside files_modified

None (this SUMMARY aside).

## Self-Check: PASSED

- src/domain/replica/decisions.ts and src/test/replicaDecisions.test.ts exist.
- Commits e27ed9cb and e0063c05 are on agent-30-07.
