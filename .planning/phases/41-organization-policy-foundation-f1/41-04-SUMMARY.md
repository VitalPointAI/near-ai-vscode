---
phase: 41-organization-policy-foundation-f1
plan: 04
subsystem: gate labels (the one label module)
status: complete
tags: [labels, dominance, clearance-meet, staff, chat-label, export-control]
requires: [safety patch S7 and S8 on the base, 41-01]
provides:
  - labels.ts splitLabelKey (moved from labelAlgebra.ts, re-exported there) and parseLabelKey
  - dominance.ts LabelLevel, atLeast, belowOnScale, markAtLeast, meetClearance
  - labels.ts RESERVED_EXPORT_COMPARTMENTS, ReservedExportCompartment, EXPORT_COMPARTMENT_SHOWN, shownCompartment, exportMarkingsShown
  - labelAlgebra.ts labelKeyShownWithMarkings
affects: [41-10 (meetClearance for the effective clearance, trust line), 41-14 (labelShown calls labelKeyShownWithMarkings)]
tech-stack:
  added: []
  patterns: [one dependency-free label module, oracle tables against the replaced expressions, seeded random equivalence, meet soundness property]
key-files:
  created:
    - src/test/gateLabelModule.test.ts
  modified:
    - src/domain/gate/labels.ts
    - src/domain/gate/dominance.ts
    - src/domain/gate/labelAlgebra.ts
    - src/domain/staff/guardScan.ts
    - src/domain/staff/obs/importers.ts
    - src/domain/staff/obs/store.ts
    - src/domain/staff/obs/feeds.ts
    - src/gate/chatLabel.ts
decisions:
  - "meetClearance across scales holds the result below any mapping out of its scale that the other clearance cannot follow (a mapping chain would otherwise let the meet reach a third scale neither input reaches); no level that satisfies this gives undefined."
  - "meetClearance gives undefined when either expiresAt cannot be read (fail closed), and tries the a-covers-b placement before b-covers-a when both cover each other."
  - "observation.ts needed no edit: labelAtLeast and joinTemplateLabels were already one-line calls into labelKeyAtLeast and joinLabelKeys, which now rank through the module."
  - "chatLabel's markOf takes the scales read once per judgement, so parsing and ranking a lowering use one reading of the active policy."
metrics:
  duration: ~25 min
  completed: 2026-11-20
actuals:
  tokens: 13967
  tasks: 4
  commits: 4
plan_head_before: ce786119bcb5b7bd1016ed5ae49029d277c58bda
plan_head_after: d5e9780d9f8441fa62da226be609adc75d0fe1fc
---

# Phase 41 Plan 04: One Label Module Summary

labels.ts and dominance.ts are now the one dependency-free label module (D-35, FND-06): parseLabelKey, atLeast, belowOnScale, markAtLeast and meetClearance answer every label question in the gate, the staff tools and the chat label on the active policy's scales, and the module carries the reserved export compartments CGP, ITAR and EAR with their shown words (D-62).

## What was built

- **Task 1 (tracer, ac4d1325):** `splitLabelKey` moved into labels.ts (labelAlgebra.ts re-exports it, one splitter) and `parseLabelKey(text, scales)` added: the level is everything after the first slash, own-property scale lookup, frozen label. `atLeast(label, floor, scales)` in dominance.ts. The guard scan header check parses with parseLabelKey on `activeScales()` and allows only `atLeast(ceiling, label)`; `org/Internal/x` is now held.
- **Task 2 (a812769b):** `belowOnScale`, `markAtLeast` and `meetClearance` in dominance.ts. labelAlgebra.ts keeps every exported name and default; `labelKeyAtLeast` calls atLeast on parsed texts and `joinLabelKeys` folds `joinLabels`. importers.ts `clampImportLabel`, store.ts `rowFits` and both feeds.ts label checks call `belowOnScale(..., activeScales())`. chatLabel.ts lost its private `raiseBy` and `covers`; `judgeChatLowering` reads `activeScales()` once and uses `markAtLeast`.
- **Task 3 (735c956e):** custom-scale agreement tests (importer, store, guard scan and a signed chat lowering agree with atLeast and dominates on a policy whose org scale holds Partner; with the source cleared, org/Partner is refused or held) and the purity test (labels.ts imports only `./shape`, dominance.ts only `./labels`).
- **Task 4 (d5e9780d):** `RESERVED_EXPORT_COMPARTMENTS`, `EXPORT_COMPARTMENT_SHOWN`, `shownCompartment`, `exportMarkingsShown` in labels.ts and `labelKeyShownWithMarkings` in labelAlgebra.ts ("Canada, Protected: Protected B · Controlled goods (Canada) · ITAR", "Organization: Sensitive · ITAR").

## Red runs on the base (TDD evidence)

- Guard scan regression (Task 1): run on the unchanged base with only that test in the file; it failed as a behaviour (`an unreadable header label is held`, actual false).
- parseLabelKey, atLeast (Task 1), belowOnScale, markAtLeast, meetClearance (Task 2) and the D-62 names (Task 4): pure additions; the tests failed to compile on the prior code with TS2305 (no exported member), the accepted red for additions.
- Task 3 agreement and purity tests passed on the Task 2 code as planned: they are the agreement proof, not a regression.

## Verification

- Task 1 set (gateLabelModule, staffGuardScan, gateLabels): 33/33 pass.
- Task 2 set (nine files incl. gateDominance, gateChatLabel, staffObsContract, staffObservations, staffObsFrame, staffCopMap, staffGuardScan): 158/158 pass.
- Task 3 set (gateLabelModule, gateLabels, gateChatLabel, staffObsContract, teamBoundaries) plus lint: 99/99 pass, lint exit 0.
- Task 4 set (gateLabelModule, gateLabels, teamBoundaries) plus lint: 41/41 pass, lint exit 0.
- Final gate set: every `gate*`, `staffObs*`, `staffGuard*`, `staffCop*` and teamBoundaries test file (61 files): 1072/1072 pass. gateLabelModule.test.js holds 17 tests.
- S7 tests in gateLabels.test.ts and staffObsContract.test.ts, and gateChatLabel.test.ts, pass with no edit.
- Acceptance greps: `split('/')` is 0 in importers, store, feeds and guardScan; `startsWith('org/')` is 0 in feeds; no `function covers|raiseBy` in chatLabel; three of belowOnScale, markAtLeast, meetClearance exported; the D-62 names exported.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] meetClearance narrowed below mapping chains**
- **Found during:** Task 2 (threat T-41-42, meet wider than either input)
- **Issue:** "the side the other covers through a mapping" alone is unsound when the covered side's scale has its own mapping to a third scale: the meet would reach that third scale though the covering clearance cannot (for example org/Restricted met with ca-protected/Protected B under org to ca-protected and ca-protected to NATO mappings).
- **Fix:** the cross-scale meet takes the highest level on the covered side's scale, at or below its own, whose satisfied mappings reach only what the other clearance dominates; none gives undefined. A named test and the property test (with that mapping chain in the context) cover it.
- **Files modified:** src/domain/gate/dominance.ts
- **Commit:** a812769b

**2. [Rule 2] meetClearance fails closed on an unreadable expiresAt** (undefined rather than picking one side); tested. Commit a812769b.

### Other notes

- observation.ts is in files_modified but needed no change (see decisions).
- One verification command (`tsc --noEmit` to confirm the Task 2 red) ran once outside the memory wrapper; every other compile, test and lint run used the capped, locked wrapper.

## Deferred Issues

- `src/domain/gate/endpoints.ts` (41-01, outside this plan's files) keeps its own private `splitLabelKey`. It splits at the first slash like the module's, so it ranks the same, but it is a second splitter; a later plan touching endpoints.ts should import it from labels.ts.

## Threat Flags

None: no new network endpoint, file access or trust boundary; the plan's T-41-40 to T-41-43 are mitigated as registered.

## Self-Check: PASSED

- Files: src/domain/gate/labels.ts, dominance.ts, labelAlgebra.ts, src/domain/staff/guardScan.ts, obs/importers.ts, obs/store.ts, obs/feeds.ts, src/gate/chatLabel.ts, src/test/gateLabelModule.test.ts all present.
- Commits ac4d1325, a812769b, 735c956e, d5e9780d are ancestors of HEAD.
