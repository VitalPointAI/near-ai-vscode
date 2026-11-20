---
phase: 41-organization-policy-foundation-f1
plan: 12
subsystem: architecture test (layer rules with a shrinking baseline)
status: complete
tags: [architecture, layers, baseline, ratchet, test-only]
requires: [41-07]
provides:
  - src/test/helpers/architectureScan.ts (LAYERS, SEAMS, SCALE_PRESETS_ALLOWED, ARCHITECTURE_RULES, FROZEN_ABOVE, WARN_ABOVE, importsOf, layerOf, unplacedTopLevel, findViolations, scanArchitecture, foldersInCycles, compareWithBaseline, baselineText)
  - src/test/architecture.test.ts (13 tests: teeth per rule, ratchet, size budget, tightness, write mode)
  - src/test/architecture-baseline.json (82 rule lines, 9 frozen sizes)
affects: [41-09, 41-10, 41-11, 41-13, 41-14 (any new violation fails the wave merge), 41-15 (sets NEAR_AI_BASELINE_TIGHT=1)]
tech-stack:
  added: []
  patterns: [checked-in violation baseline that may only shrink, write mode that always fails so the diff is reviewed, Tarjan folder-cycle detection]
key-files:
  created:
    - src/test/helpers/architectureScan.ts
    - src/test/architecture.test.ts
    - src/test/architecture-baseline.json
  modified: []
decisions:
  - "Upward-import is decided by layer rank (a target above the source's layer), plus the domain rule (a domain file may import nothing outside src/domain). This covers the plan's two cases (domain to anything outside domain, engine to services) and also flags an engine or editor file importing extension.ts. Only relative imports are resolved, as the plan says; a package or node: import from domain is not part of this rule."
  - "The SEAMS apply to gate and team only, as the plan and teamBoundaries.test.ts say. staff/** reaching services/auth and services/stateMirrorLock is therefore recorded in the baseline (10 lines) rather than declared a seam; declaring a staff seam is a later, reviewed decision."
  - "scale-presets also reports a property read `.SCALE_PRESETS` on a non-comment line (namespace import or require), so a namespace import cannot bypass the rule. No file on the base uses that form."
  - "The vscode rule uses importsOf verbatim, so a `require('vscode')` written inside a comment is still reported (conservative). Static-form comments are not reported, as before."
  - "Re-recording is one step: NEAR_AI_WRITE_BASELINE=1 makes the ratchet test write src/test/architecture-baseline.json and then fail on purpose; review the diff and run again without it. The plan already specified this mode."
metrics:
  duration: 35m
  completed: 2026-11-20
  tasks: 3
  files: 3
actuals:
  tokens: 9200
  tasks: 3
  commits: 3
plan_head_before: 97a9bd229f899f1e0b8065c20260c3a57e76f5f4
plan_head_after: 5c98d198153b9343ce56385a1b13808dbf3927a4
---

# Phase 41 Plan 12: Architecture test with a recorded baseline Summary

One architecture test now places every non-test file under src in the DEVELOPER-STRUCTURE layer table and checks five rules plus a file-size budget against a checked-in baseline that records today's violations, so it passes on the day it lands and fails on any new violation or any frozen file that grows.

## Base check

- `KNOWN_BUNDLE_FEATURES` in `src/domain/gate/bundle.ts`: 2 (expected at least 1).
- `src/domain/provider/endpoint.ts` exists (41-07 merged).
- `services/nearAiClient` in `domain/state/threadView.ts` and `threadCapture.ts`: both 0 (expected 2 files at 0).
- `STATIC_FORM` in `src/test/teamBoundaries.test.ts`: 2 (expected at least 1).

## Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Tracer: layer table, upward-import rule, recorded baseline, ratchet | 8aac183c | architectureScan.ts, architecture.test.ts, architecture-baseline.json |
| 2 | vscode-below-editor, folder-cycle, scale-presets, get-configuration, size budget | 776c28b2 | architectureScan.ts, architecture.test.ts |
| 3 | Full baseline, ratchet over every rule, tightness check | 5c98d198 | architecture.test.ts, architecture-baseline.json |

Tracer gate (Task 1): the tracer's verify was re-run end to end (architecture plus teamBoundaries, 13 of 13 pass) before Task 2.

## Tests written first (RED on the base)

- Task 1, on the unchanged base: `tsc` failed with `Cannot find module './helpers/architectureScan'`, so no test could run.
- Task 2, on the Task 1 code: `tsc` failed: `'scale-presets'` and `'get-configuration'` are not rules, and `grown`, `tooLarge`, `warnings`, `shrunk` do not exist on the comparison.
- Task 3, on the Task 2 code and its upward-import-only baseline: 13 tests, 10 pass, 3 fail: the ratchet over every rule ("new violations"), "frozen files are exactly the files above 1,200 lines" ("expected at least 3 frozen files, found 0"), "the baseline file is sorted" ("one list per rule, in rule order").
- Refused and allowed sides for each rule: planted domain, agent, gate and team imports of services are reported while the gate and team seams (type-only auth, the mirror lock) are not; vscode in four forms in agent, gate and domain files is reported, in services and extension.ts it is not; a two-folder and a three-folder engine cycle report every edge, while domain, editor, same-folder and one-way edges do not; SCALE_PRESETS in services (named, multi-line and namespace forms) is reported, `SCALE_PRESETS_CAVEAT_TEXT`, a comment, domain/gate and the two fallbacks are not; getConfiguration in services and extension.ts is reported, in settings.ts and in comments it is not; sizes 1,001 over a frozen 1,000 is grown, 1,201 not frozen fails, 900 and 1,200 warn, 800 is silent; a scan with one file under a minimum of 400 throws "an empty scan proves nothing".

## The baseline at the 41-12 base (97a9bd22)

| Rule | Lines | Notes |
|------|-------|-------|
| vscode-below-editor | 0 | matches "what holds today" in DEVELOPER-STRUCTURE section 1 |
| upward-import | 30 | 3 domain leaks (`domain/auth.ts -> services/nearAiClient`, `domain/cyberLimits.ts -> agent/permissions`, `domain/state/syncStatus.ts -> services/syncFlows`); 27 engine-to-services lines (agent 10, benchmark 5, gsd 1, staff 11) |
| folder-cycle | 31 | engine folders only: agent with mcp, staff and gsd |
| scale-presets | 3 | `domain/staff/guardScan.ts`, `services/staffMultiUserCommands.ts`, `staff/replica/membership.ts` |
| get-configuration | 18 | 18 files including `extension.ts` |

Frozen sizes (9): `agent/commandSafety.ts` 2900, `services/agentSession.ts` 2754, `agent/teamTemplateHistory.ts` 2335, `services/teamStudioPage.ts` 2236, `services/nearAiClient.ts` 1861, `staff/staffHost.ts` 1612, `services/chat.ts` 1517, `agent/gateAdapter.ts` 1400, `staff/replica/membership.ts` 1384. 15 more files sit between 801 and 1,200 lines and give warnings only.

Comparison with RESEARCH audit E:
- Domain leaks: 5 on main, 3 here. 41-07 removed `threadView` and `threadCapture`, as planned.
- Cycles: the audit's "about 40" counted every folder pair including services; here services edges belong to upward-import (27 engine lines) and folder-cycle counts only engine folder pairs (31), so the two rules together cover what the audit counted.
- SCALE_PRESETS: the audit listed 10 users; the safety patch and 41-04 removed `obs/observation.ts`, `gate/chatLabel.ts`, `services/agentSession.ts` and `threadStore.ts`, the two fallbacks are allowed, and `guardScan.ts` still imports it on the base (S7 named it; it is now baselined, to be removed by later work).
- getConfiguration: 19 files in the audit, 18 here (a difference of one file since the audit; every file found is recorded).
- Over 800 lines: 23 in the audit, 24 here (9 frozen plus 15 warnings); the audit's nine largest are exactly the nine frozen files. `teamTemplateHistory.ts` grew from 2,046 to 2,335 and `agentSession.ts` from 2,738 to 2,754 since the audit; they are frozen at today's size.

## How to use the baseline

- A new violation fails: fix it in the code that added it (move the part, or import the domain instead of services), never by adding a baseline line.
- Re-record (only after removing violations, or when the orchestrator re-bases): run `architecture.test.js` with `NEAR_AI_WRITE_BASELINE=1`; the ratchet test writes the file and fails on purpose; review the diff, then run again without the flag.
- Tightness: with `NEAR_AI_BASELINE_TIGHT=1` stale lines and lowered frozen sizes fail, named one per line; without it they are printed as diagnostics. 41-15 sets it once. It passes in tight mode at this base.
- Wave 3 note: 41-09 (`src/gate/organizationStore.ts`) may import from src/services only through the type-only `services/auth` import and `services/stateMirrorLock`; anything else is a new upward-import line and fails at the wave merge.

## Verification

- `architecture.test.js`, `teamBoundaries.test.js`, `replicaBoundaries.test.js`: 28 tests, 28 pass, 0 fail (architecture 13 of 13), under the memory wrapper.
- `architecture.test.js` with `NEAR_AI_BASELINE_TIGHT=1`: 13 of 13 pass.
- `npm run lint`: exit 0.
- `git diff --quiet feat/phase-41-foundation -- src/test/teamBoundaries.test.ts src/test/replicaBoundaries.test.ts`: exit 0 (unchanged).
- Acceptance greps: `domain/auth.ts -> services/nearAiClient` 1, `domain/state/threadView.ts` 0, `"services/nearAiClient.ts"` 1, `NEAR_AI_BASELINE_TIGHT` 3, `SCALE_PRESETS_ALLOWED` 2.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] scale-presets also catches a namespace property read**
- **Found during:** Task 2
- **Issue:** the plan's rule looks only at import statements, so `import * as labels` followed by `labels.SCALE_PRESETS` would bypass it.
- **Fix:** a non-comment line with `.SCALE_PRESETS` (word boundary) outside src/domain/gate and the allowed fallbacks is also reported; planted in the teeth test.
- **Files modified:** src/test/helpers/architectureScan.ts, src/test/architecture.test.ts
- **Commit:** 776c28b2

Other notes, not deviations:
- `compareWithBaseline` returns `{ added, stale, grown, shrunk, tooLarge, warnings }` (the plan named the first four; the size budget needed the other two) and takes an optional rule list, used by the Task 2 interim ratchet and defaulting to every rule.
- The plan's integration branch name `feat/phase-41-one-foundation` is `feat/phase-41-foundation` in practice; the D-03 guard was run against the real name.
- 13 architecture tests (plan minimum 13): the tightness requirement is split into a synthetic proof of both modes and the real-repository check.

## Known Stubs

None.

## Self-Check: PASSED

- FOUND: src/test/helpers/architectureScan.ts, src/test/architecture.test.ts, src/test/architecture-baseline.json
- FOUND: 8aac183c, 776c28b2, 5c98d198 (ancestors of HEAD)
