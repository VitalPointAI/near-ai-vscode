---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 04
subsystem: compliance-status-engine
tags: [compliance, status-engine, ed25519, risk-acceptance, poam, ajv]
requires:
  - phase: 44-01
    provides: compliance package skeleton, validation and status contracts
  - phase: 44-03
    provides: gap register and POA&M source records
provides:
  - Signed and expiring risk-acceptance verification
  - Honest control-state aggregation, tailoring, and limitation matching
  - Strict gap/POA&M schemas and evidence-derived lifecycle states
affects: [44-05-dashboard, 44-14-control-rows, 44-18-content-validation]
tech-stack:
  added: []
  patterns: [dependency-free Ed25519 envelope verification, derived state only, strict local JSON schemas]
key-files:
  created: [compliance/src/signed.ts, compliance/src/riskAcceptance.ts, compliance/src/tailoring.ts, compliance/src/limitations.ts, compliance/src/gaps.ts]
  modified: [compliance/src/status.ts, compliance/src/model.ts]
key-decisions:
  - "Risk acceptance signatures reuse the extension envelope and a compliance-specific purpose."
  - "The signer list and tailoring files ship empty until an owner-reviewed decision exists."
  - "A verified acceptance remains Not met and expires at the clock boundary."
  - "Gaps derive from evidence, milestones, and verified acceptances rather than typed status."
actuals:
  tokens: 26430
  tasks: 3
  commits: 3
plan_head_before: 0d81e1dda623f974cbe0abdc30dc8eb822b451c7
plan_head_after: 8635557caf8914775f33eddd93728cee35f90ec8
requirements-completed: [ACCR-06, ACCR-08, ACCR-12, ACCR-14]
coverage:
  - id: D1
    description: Signed risk acceptances verify against a named trusted signer, never become Met, and expire.
    requirement: ACCR-08
    verification:
      - kind: unit
        ref: compliance/test/riskAcceptance.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Control status derives from evidence, reviewed tailoring, limitations, and honesty rules.
    requirement: ACCR-06
    verification:
      - kind: unit
        ref: compliance/test/status.test.ts
        status: pass
    human_judgment: false
  - id: D3
    description: Gap and POA&M states derive from evidence, milestones, and verified acceptances.
    requirement: ACCR-12
    verification:
      - kind: unit
        ref: compliance/test/gaps.test.ts
        status: pass
    human_judgment: false
  - id: D4
    description: The compliance verifier accepts the extension's signed-payload envelope format.
    requirement: ACCR-14
    verification:
      - kind: unit
        ref: compliance/test/signedParity.test.ts
        status: pass
    human_judgment: false
duration: 15m
completed: 2026-11-21
status: complete
---

# Phase 44 Plan 04: Status Rules Summary

**Evidence-derived control, gap, and signed-risk states with expiring Ed25519 acceptances and strict compliance source validation.**

## Performance

- **Duration:** 15m
- **Started:** 2026-11-21T18:49:11Z
- **Completed:** 2026-11-21T19:04:27Z
- **Tasks:** 3/3
- **Files modified:** 29

## Accomplishments

- Added dependency-free verification of extension-format Ed25519 risk acceptances against the owner-managed signer list; accepted risks remain Not met and reopen immediately at expiry.
- Implemented D-18/D-19 states: reviewed tailoring, multi-statement aggregation, stale totals, known-limitation matching, unsettled questions, and self-signed decisions.
- Added strict gap and POA&M schemas, evidence-driven open/planned/in-progress/closed/risk-accepted states, and parity coverage against a compiled extension signature.

## Task Commits

1. **Task 1: Signed risk-acceptance tracer** — `25fae65e`
2. **Task 2: Status rules, tailoring, and limitations** — `65cb20b5`
3. **Task 3: Gap lifecycle and signed-payload parity** — `8635557c`

## Decisions Made

- The empty signer and tailoring lists deliberately invent no organizational decision.
- A limitation must be a unique, normalized prefix of at least 40 characters from SECURITY.md's Known limitations table.
- The parity fixture is generated after `npm run compile` by `make-extension-envelope.mjs`, using the SHA-256-derived fixed Ed25519 seed only in memory; the committed JSON contains only public key, payload, and signature.

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 3 - Blocking] Recovered missing inherited Task 1 dependencies**
   - **Found during:** Task 1
   - **Issue:** The inherited acceptance code referenced a missing `gaps.ts`, and `computeStatus` did not apply a verified acceptance to a failing row.
   - **Fix:** Added the initial gap reader/state path and acceptance status handling before validating the tracer.
   - **Verification:** `riskAcceptance.test.ts` and `tracer.test.ts` pass.
   - **Committed in:** `25fae65e`

2. **[Rule 1 - Bug] Fixed strict JSON schema composition and fixture signer derivation**
   - **Found during:** Tasks 2 and 3
   - **Issue:** AJV strict mode rejected the initial composed tailoring/gap schemas, and the compiled signer module does not export its internal fingerprint helper.
   - **Fix:** Used strict self-contained schema definitions and reproduced the documented SHA-256 fingerprint calculation in the generator.
   - **Verification:** Full compliance test suite and secret scan pass.
   - **Committed in:** `65cb20b5`, `8635557c`

**Impact:** Both fixes were necessary to recover the partial executor state and preserve the planned security rules; no scope was added.

## Issues Encountered

- The prescribed `systemd-run --user` wrapper cannot access a user scope bus in this executor environment. Equivalent direct commands ran with the plan's memory setting and passed.

## User Setup Required

None. The signer list intentionally remains empty until the owner names authorized risk-acceptance signers.

## Next Phase Readiness

Dashboard and content-validation plans can consume computed row summaries, tailoring lookups, verified acceptances, and derived gap states.

## Self-Check: PASSED

All listed implementation artifacts exist and all three task commits are ancestors of HEAD.
