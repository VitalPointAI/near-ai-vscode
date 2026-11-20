---
phase: 31-staff-roster-cell-keys-and-migration
plan: 05
subsystem: replica
tags: [replica, decisions, causal-graph, project, governance, hardening]
status: complete

requires:
  - phase: 31-staff-roster-cell-keys-and-migration
    provides: 31-01 roster view contracts and agent seat fixtures
provides:
  - PROJECT_REFUSALS['agent-cannot-decide']; projectReducer refuses non-person actors for project.genesis and project.import
  - decisions.ts holds only the act that names an unknown id (WR-09)
  - DecisionInput.strict (a precedence cycle throws when true)
  - one-pass precedence closure in topological order, cycle detection by strongly connected parts (WR-06 algorithm)
  - causal.ts lamport bound in isBefore and concurrent, CausalGraph.stats().pastsBuilt
affects: [31-07, 31-12, 31-17]

actuals:
  tokens: 7970
  tasks: 3
  commits: 3
plan_head_before: 81d8ec5cd17ccad6040c6e8e00f51deacdd006b6
plan_head_after: 02cd087711bbc6d032c40e9d895674d6898a1ea7

tech-stack:
  added: []
  patterns:
    - "Guard a shortcut by an invariant checked at build time: the lamport bound is used only when every in-graph edge has a rising lamport"
    - "Freeze a seeded random corpus of old results inside the test before an algorithm swap"
    - "Strict flag for impossible states: throw in tests, keep the safe hold in production"

key-files:
  created: []
  modified:
    - src/domain/replica/projectFold.ts
    - src/domain/replica/decisions.ts
    - src/domain/replica/causal.ts
    - src/test/replicaKinds.test.ts
    - src/test/replicaDecisions.test.ts

key-decisions:
  - "Precedence order is topological over the act relation itself, not lamport order: DecisionInput carries no lamport, and a seen link can point to an act with a larger lamport when deps are capped"
  - "The lamport bound in causal.ts is applied only when every edge of the graph has a rising lamport (true for every chain-admitted graph); other graphs answer from ancestor sets alone"
  - "D24's chained case changed on purpose (WR-09): it now holds only x, and y is effective REJECT"

duration: 45min
completed: 2026-11-19
---

# Phase 31 Plan 05: Decisions, causal graph and project reducer hardening Summary

Governance acts now come only from persons, one bogus decisionsSeen id holds only the act that names it, the decision precedence is built in one topological pass with cycles found as strongly connected parts (throwing in strict mode), and the causal graph answers isBefore without building an ancestor set whenever the lamport bound already settles it.

## What changed

- **projectFold.ts (WR-02 project part, T-31-11):** `project.genesis` and `project.import` from an actor whose kind is not `person` are refused `agent-cannot-decide` before the staff lead role check. New plain sentence in `PROJECT_REFUSALS`.
- **decisions.ts (WR-09, T-31-12):** the held fixpoint that spread through held ids is replaced by one filter: an act is held `unknown-decision-seen` exactly when one of its seen ids is neither an act of this version nor a known entry.
- **decisions.ts (IN-01):** `DecisionInput.strict?: boolean`. A precedence cycle throws `Decision precedence cycle on version <hash>: <ids>` when strict; unset keeps the production hold. The decision table builder in the tests runs every row strict.
- **decisions.ts (WR-06 algorithm, T-31-13):** direct precedence edges are computed once (at most one `before` call per ordered pair, seen links checked first); cyclic acts are found with an iterative Tarjan pass; the transitive closure is built in one pass in topological order (a predecessor already in a set is skipped); validity settling visits the same topological order. The repeated fixpoint and the second `closureOf` on a cycle are gone.
- **causal.ts (WR-06):** `isBefore` returns false at once when either entry is outside the graph or a's lamport is not below b's, and only then builds or reads `past(b)`. `concurrent` goes through `isBefore`, so at most one of its two directions builds a set. `stats(): { pastsBuilt }` counts built ancestor sets.

## Re-verification on the old code

- **WR-02:** a `project.genesis` written on the staff lead's device with actor `{ kind: 'agent', member: 'j2-chief', run: 'r-1' }` was applied by the old reducer: `applied: 1, refused: [], project name "Renamed by an agent", lead mbr-lead`. The three new tests failed on the old code and pass now.
- **WR-09:** the new WR-09 tests and D24's chained case failed on the old code (both acts held). They pass now.
- **IN-01:** the strict-mode test failed on the old code (no throw). It passes now.
- **WR-06 call count:** the plan expected the old code to call `before` far more than 80,000 times for 200 acts. It did not: the old `closureOf` made exactly n(n-1) = 39,800 calls (79,600 with a cycle). The superlinear work was the internal fixpoint, which never calls `before`. Measured with a scratch script on the same inputs (old -> new): random 200 acts 39,800 calls, 50.5 ms -> 38,757 calls, 38.0 ms; a 300-act seen chain 89,700 calls, 156-190 ms -> 89,401 calls, 113-121 ms. The call-count test therefore pins the bound (it passed on the old code too) rather than catching a regression; the 40-case frozen equivalence test and the `pastsBuilt` test are the ones that check the change itself.

## Tests

All runs used the flock lock and the systemd-run memory cap; compile (`tsc -p tsconfig.json`) exited 0 and `npm run lint` exited 0.

| Run | Tests | Pass | Fail |
|-----|-------|------|------|
| replicaKinds (Task 1) | 22 (19 at HEAD) | 22 | 0 |
| replicaDecisions + replicaVersionDecisions (Task 2) | 61 | 61 | 0 |
| replicaDecisions + replicaVersionDecisions + replicaOrder + replicaChain + replicaConvergence (Task 3) | 89 | 89 | 0 |
| replicaForbiddenActs + replicaIntegration + replicaVersions + replicaContracts + replicaCheckpoint + replicaKinds (other files the change could reach) | 90 | 90 | 0 |

replicaDecisions.test.ts has 39 tests (31 at HEAD). The full `npm test` was not run, per the executor brief; the orchestrator runs it at the end.

New tests:
- replicaKinds: agent genesis through the fold (both delivery orders with a real genesis), agent import through the fold, hub and agent actors straight into the reducer with a view that grants every role.
- replicaDecisions: WR-09 withdraw-with-bogus-id plus honest approve (and the contested variant), WR-09 chain of three, IN-01 strict throw in every permutation plus the unchanged non-strict hold, 40 frozen seeded cases (cycles, bogus ids, stale versions, repeated ids, declines, terminal acts), the 200-act call bound with order independence, a 300-act seen chain in both input orders, the lamport bound with `pastsBuilt`, and a graph without rising lamports.

## Decisions

- No checkpoints in this plan; nothing taken on a default.
- Topological order, not lamport order, drives the one pass (see Deviations 2).
- The lamport bound is guarded by a build-time check that every edge has a rising lamport, so a hand-built or not yet chain-checked graph keeps the true ancestor relation (a test covers this).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] D24's chained assertion changed on purpose**
- **Found during:** Task 2
- **Issue:** the must-have says rows D1 to D24 pass unchanged, but D24's last assertion pinned the old WR-09 behaviour (`['x', 'y']` held). WR-09 changes exactly that.
- **Fix:** set to the new exact value `['x']`, and added `outcome === 'REJECT'` for y. All other rows are unchanged.
- **Files modified:** src/test/replicaDecisions.test.ts
- **Commit:** 35b5a967

**2. [Rule 1 - Bug] One pass in topological order instead of lamport order**
- **Found during:** Task 3
- **Issue:** the plan asked to visit acts in lamport order. `DecisionInput` has no lamport, and lamport order is not a valid order for seen links: with capped deps an act can name, in decisionsSeen, an act whose lamport is larger.
- **Fix:** the pass visits a topological order of the act relation itself (depth-first post-order, roots in id order). The result does not depend on which topological order is used, which the frozen corpus and the permutation tests confirm.
- **Files modified:** src/domain/replica/decisions.ts
- **Commit:** 02cd0877

**3. [Rule 2 - Correctness] Lamport bound guarded by an invariant**
- **Found during:** Task 3
- **Issue:** the bound is only sound when every edge has a rising lamport. Chain admission enforces that, but `buildCausalGraph` is also called on hand-built entries (for example the 5000-entry chain test has no lamports).
- **Fix:** the graph checks every edge at build time and uses the bound only when all rise.
- **Files modified:** src/domain/replica/causal.ts, src/test/replicaDecisions.test.ts
- **Commit:** 02cd0877

**4. [Plan expectation] The WR-06 call-count test does not fail on the old code**
- See "Re-verification on the old code". The test was kept as a bound on `before` calls, recorded honestly here.

## Known limits

- Validity settling still calls `settle` on each act's past, which is cubic in the number of acts in map lookups (no injected calls). The per-writer act cap of WR-06 (plan 31-07, `versions.ts`) bounds the number of acts.

## Threat Flags

None. No new endpoint, dependency or agent capability; the change narrows what an agent or hub label can do.

## Self-Check: PASSED

- FOUND: src/domain/replica/projectFold.ts, src/domain/replica/decisions.ts, src/domain/replica/causal.ts, src/test/replicaKinds.test.ts, src/test/replicaDecisions.test.ts
- FOUND commits: 88988b19, 35b5a967, 02cd0877
