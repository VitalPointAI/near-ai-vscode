---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 18
subsystem: compliance-content
tags: [oscal, evidence-rules, dashboard, overlays]
requires:
  - phase: 44-07
    provides: exact mapped-test checks and local collectors
  - phase: 44-13
    provides: controlled-goods and ITAR mappings
  - phase: 44-16
    provides: imported catalogue data
provides:
  - component statements tied to literal tests or named collector observations
  - service, release, and provider component definitions
  - export-control rows that remain non-Met when legal questions are unsettled
affects: [44-19, compliance-dashboard]
tech-stack:
  added: []
  patterns: [exact-test-evidence, responsibility-per-requirement, unsettled-overlay-boundaries]
key-files:
  created: [compliance/components/model-endpoints.json, compliance/components/relay.json, compliance/components/hub.json, compliance/components/release-pipeline.json, compliance/components/appliance.json]
  modified: [compliance/components/extension.json, compliance/evidence-rules/extension.json, compliance/test/components.test.ts, compliance/README.md]
key-decisions:
  - "Mapped test rules use exact literal test names and collector rules use documented subjects."
  - "CGP-37-1, CGP-37-2, and ITAR-120.54-a5 retain their mapping-set unsettled flags, so evidence cannot make them Met."
  - "The appliance retains a schema-required boundary record with an explicit no-implementation statement; it has no evidence rule and therefore cannot claim a safeguard."
actuals:
  tokens: 10906
  tasks: 4
  commits: 4
commits: 4
plan_head_before: 39cfac3981275f743d989b5e46f51bb16db57649
plan_head_after: 7ff743a08a9582b91cb2a16304c980726ae7631c
duration: 1h
completed: 2026-11-21
status: complete
---

# Phase 44 Plan 18: Compliance Component Content Summary

**Product and service statements now name the evidence that supports them, while provider and export-control boundaries remain explicit rather than presenting authorization as a product claim.**

## Accomplishments

- Added six OSCAL component definitions with exactly one responsibility per implemented requirement.
- Connected extension, provider, relay, and hub statements to exact compiled test names; release rules use CI, review-trail, and settings collector subjects.
- Added SC-13 split evidence for listed algorithms and separately recorded X25519/scrypt observations.
- Kept CGP-37-1, CGP-37-2, and ITAR-120.54-a5 unsettled; those rows cannot become Met even if their local-only rule passes.
- Documented statement and evidence-rule authoring guidance and strengthened checks for all component definitions and mapped test targets.

## Verification

- `npm run compile` — passed.
- Compiled `dist/test/gateDecide.test.js` with `NEAR_AI_TEST_REPORT` — 23 passed, 0 failed.
- `components`, `contentTracer`, `noStatus`, `oscalValid`, `gaps`, and `overlayMappings` tests — 6 passed, 0 failed.
- `node compliance/src/cli.ts validate` and README word lint — passed.

## Task Commits

1. `bfa994cf` — compiled CommonJS leaf reporting.
2. `a17d5128` — tracer evidence from the gate report through dashboard status.
3. `cdd33369` — relay, hub, appliance, and release evidence components.
4. `7ff743a0` — extension/provider statements, overlay boundaries, README, and component integrity checks.

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 3 - Schema compatibility] Appliance boundary record required a statement by the vendored OSCAL schema.**
   - **Found during:** Task 3
   - **Fix:** Added an explicit no-implementation statement with no evidence rule, so it remains Not met rather than implying a Classified safeguard.
   - **Commit:** `cdd33369`

## Known Stubs

None. The appliance's no-implementation statement is deliberate boundary content and is evaluated as lacking evidence.

## Self-Check: PASSED

- All six component files and six evidence-rule files exist.
- All four task commits are ancestors of HEAD.
- Focused plan verification passed with no test failures.
