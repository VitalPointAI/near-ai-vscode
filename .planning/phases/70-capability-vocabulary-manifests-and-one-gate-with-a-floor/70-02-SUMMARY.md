---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 02
subsystem: gate
tags: [labels, scale-presets, clearance-dominance, session-mark, property-test, pure-domain]

requires:
  - phase: 70-01
    provides: "src/domain/gate/shape.ts (checkKeys, Parsed, refused, closed refusal reasons) and the domain/gate import boundary test"
provides:
  - "Labels v1 and the four scale presets in src/domain/gate/labels.ts, with parseLabel, parseClearance, parseMapping and the three plain-words constants"
  - "src/domain/gate/dominance.ts: five-condition dominates, whyNotDominated with a closed reason list, joinLabels, raiseMark, markDominated, markLabelKeys"
  - "A seeded xorshift property test (2,500 dominance cases, 25,824 weaker variants, 2,000 join cases)"
affects: [70-03, 70-05, 70-06, 70-08, 70-09]

actuals:
  tokens: 14400
  tasks: 2
  commits: 2
plan_head_before: 9df670297b262dad5237b1b5f200dd2354f0c2bf
plan_head_after: 842801e183ee27f3c57cfd6e6a90719454ed48c3
commits: 2

tech-stack:
  added: []
  patterns:
    - "Closed label shape: exact keys, sorted unique token lists, plain refusal reasons from the closed shape.ts list"
    - "Own-property scale lookup so a hostile scale name is simply unknown"
    - "Property test with an independent oracle of the five conditions, plus weaker-variant monotonicity and shuffle invariance"

key-files:
  created:
    - src/domain/gate/labels.ts
    - src/domain/gate/dominance.ts
    - src/test/gateLabels.test.ts
    - src/test/gateDominance.test.ts
  modified: []

key-decisions:
  - "joinLabels, raiseMark and DominanceContext take the scale table: ranking levels needs the ordered lists, which the plan's two-argument signature did not carry"
  - "Joining two non-empty releasability sets that share nothing yields the reserved token RELEASABLE-TO-NONE, never an empty (unrestricted) set"
  - "A mark may keep two labels on one scale when the scales cannot order them (unknown level); markDominated then denies, so unknown only narrows access"
  - "now is epoch milliseconds supplied by the caller; an unreadable expiresAt on a hand-built clearance is treated as expired"

requirements-completed: [CLAS-01, CLAS-02, CLAS-03, CLAS-04]

duration: about 30 min
completed: 2026-11-16
status: complete
---

# Phase 70 Plan 02: Labels v1, scale presets, dominance and the mark join Summary

**Labels as a closed `{scale, level, compartments, releasability, handling}` shape over four ordered scale presets, a hand-written five-condition dominance check where anything unknown is no access, and a mark join, all pure and covered by a seeded property test that needs no dependency.**

## Performance

- **Duration:** about 30 min (start time was not captured, so this is an estimate)
- **Completed:** 2026-11-16
- **Tasks:** 2 (a tracer, then the full build)
- **Files:** 4 created

## Accomplishments

- `parseLabel` refuses an unknown scale or level (`not-allowed-here`), an unknown or missing field, a wrong type or malformed token (`wrong-type`), an unsorted list (`not-sorted`), a repeated entry (`duplicate`) and any handling value other than `local-only` and `no-agent-tools`. `attested-cloud-ok` is refused, so a label cannot relax a routing tier (D-47). Level names and tokens compare by exact string equality, with no case folding and no Unicode normalisation.
- `SCALE_PRESETS` holds exactly `org`, `ca-protected`, `ca-classified` and `nato` (D-23), each frozen, and the test compares every list element by element. `labelKey` is `scale/level`, so `org/Confidential` and `ca-classified/Confidential` are different labels.
- `dominates` is true only when the scale matches or a bundle mapping covers it, the level is at least the label's, every compartment is held, releasability is met (an empty clearance releasability cannot read a restricted label) and the clearance has not expired. `whyNotDominated` returns the first failing reason from the closed `DOMINANCE_REASONS` list (`no-clearance`, `scale`, `level`, `compartment`, `releasability`, `expired`).
- `joinLabels` takes the higher level, the union of compartments and handling and the intersection of non-empty releasability sets; `raiseMark` returns a new mark, never lowers it and keeps labels on unmapped scales side by side.
- `CLEARANCE_SELF_ASSERTED_TEXT`, `LABELS_NOT_ACCREDITATION_TEXT` (the D-40 wording from research section 12, asserted as one literal string) and `SCALE_PRESETS_CAVEAT_TEXT` are single exported sources; the test checks the denial order, no em-dash, no "NEAR organization" and no "verified clearance".
- The property test: 2,500 dominance cases (686 allowed, 1,814 denied) checked against an oracle of the five conditions written separately in the test; 25,824 weaker variants (drop a compartment, a releasability entry or a mapping, lower the level, move `now` past the expiry, pull the expiry earlier) never turn a denial into an allowance; shuffling compartments, releasability, mappings, clearances and mark labels never changes the answer; 2,000 join cases show commutative, associative, idempotent, never-lowering, and that dominating a join dominates both sides.
- A deliberate mutation of `hasAll` (compartments) made two property tests fail, so the test has teeth; the code was restored before the commit.

## Task Commits

1. **Task 1: Tracer (org label, same-scale dominance, mark join)** - `7098110` (feat); `git show --name-status` lists exactly the four plan files.
2. **Task 2: Presets, mappings, compartments, releasability, handling, expiry, reasons, property tests, texts** - `842801e` (feat)

## Verification

Each run inside `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536`.

- Task 1: `sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gateLabels.test.js dist/test/gateDominance.test.js dist/test/teamBoundaries.test.js'`: 10 tests, 10 pass, 0 fail, 0 cancelled.
- Task 2 and plan level: `sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gateLabels.test.js dist/test/gateDominance.test.js dist/test/gateVocabulary.test.js dist/test/teamBoundaries.test.js'`: 54 tests, 54 pass, 0 fail, 0 cancelled, 0 skipped (gateLabels 12, gateDominance 17, gateVocabulary 19, teamBoundaries 6). No full suite or e2e was run, as the plan asks.
- Acceptance: `grep -c "Cosmic Top Secret" src/domain/gate/labels.ts` prints 1; gateLabels asserts `HANDLING_FLAGS` deep-equals `['local-only', 'no-agent-tools']` and that `attested-cloud-ok` is refused; the research text is compared as one literal string. `package.json` and `package-lock.json` are unchanged.

## Decisions Made

- **Scale table in the signatures.** Ranking levels needs the ordered lists, so `joinLabels(a, b, scales)`, `raiseMark(mark, label, scales)` and `DominanceContext { scales, mappings, now }` carry them. `dominates` and `whyNotDominated` accept `Clearance | undefined` so "no clearance" is a reason, not a special case at the call site.
- **`now` is epoch milliseconds**, because the folder holds no clock. `expiresAt` must be strict ISO 8601 UTC and a real date (`expiryMs` round-trips it, because `Date.parse` rolls February 30 over to March 2). An expiry exactly equal to `now` is expired.
- **Empty mark.** `markDominated` of an empty mark is true (it holds nothing); of any mark with a label and no clearances it is false.
- **Unknown versus plain reasons.** The refusal list in `shape.ts` is closed (ten reasons, pinned by a test), so an unknown scale or level uses `not-allowed-here` with the field path rather than a new reason.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Disjoint releasability must not join to "unrestricted"**
- **Found during:** Task 1 (writing `joinLabels`)
- **Issue:** research 9.3 says the join is "the intersection of non-empty releasability sets" and also says an empty set means unrestricted. Two labels releasable only to `CAN` and only to `USA` intersect to nothing, which would become an empty set, so content that nobody may release would become freely releasable after a join. That would also make join non-associative.
- **Fix:** the intersection of two non-empty sets that share nothing is the reserved token `RELEASABLE-TO-NONE` (it matches the token pattern and is exported as `RELEASABILITY_NONE`). `parseLabel` accepts it only on its own; `parseClearance` refuses it; dominance never counts it as shared, so no clearance can read it. Join with it stays commutative, associative and idempotent, which the property test shows.
- **Files modified:** `src/domain/gate/labels.ts`, `src/domain/gate/dominance.ts`, both test files
- **Committed in:** `7098110`, `842801e`
- **Owner note:** this adds one reserved token to label v1's closed shape. It is cheap to change now and costly after release; say so if you want a different representation.

**2. [Rule 3 - Blocking] The plan's `joinLabels(a, b)` and `raiseMark(mark, label)` cannot rank levels**
- **Issue:** the level order lives in the scale's ordered list, which two bare labels do not carry.
- **Fix:** both take the scale table as a final argument (see Decisions). Task 1's `DominanceContext` was `{ scales, now }`; Task 2 added `mappings` as the plan describes, so the Task 1 tests gained `mappings: []`. No assertion was changed, weakened or removed.
- **Committed in:** `7098110`, `842801e`

**3. [Rule 1 - Bug in my own output] A literal em-dash reached a test file**
- **Fix:** the no-em-dash check in `gateLabels.test.ts` now writes the character as the escape `—` (and the en-dash as `–`), so the repo files themselves hold no em-dash. Committed in `842801e`.

---

**Total deviations:** 3 auto-fixed. **Impact on plan:** none on scope; nothing imports the new modules yet, so the running extension is unchanged.

## Issues Encountered

None beyond the items above. The tests passed on first run after being written; a deliberate mutation of the compartment check confirmed they fail when the evaluator is wrong.

## Authentication Gates

None.

## Known Stubs

None.

## Threat Flags

None. The two new modules add no endpoints, auth paths, file access or schema beyond the plan's threat model (T-70-05 mitigated by the property test, T-70-06 by the closed handling list, T-70-07 by the fixed and tested texts, T-70-SC: no package added).

## User Setup Required

None.

## Next Phase Readiness

Later plans can import the label parsers and constants from `labels.ts` and the dominance and mark functions from `dominance.ts`. Reversibility reminder for the owner: preset ids, level names, handling values and the `RELEASABLE-TO-NONE` token end up in label maps and signed bundles, so a change after release is a label v2 beside v1.

## Self-Check: PASSED

- Files present: `src/domain/gate/labels.ts`, `src/domain/gate/dominance.ts`, `src/test/gateLabels.test.ts`, `src/test/gateDominance.test.ts`.
- Commits `7098110` and `842801e` are on `feat/gate-vocabulary`; `git rev-list --count` from the recorded base `9df6702` is 2.

---
*Phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor*
*Completed: 2026-11-16*
