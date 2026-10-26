---
phase: 04-agents-routing-approvals-and-analytics
plan: 05
subsystem: analytics
tags: [fleet, analytics, timeline, export, privacy, accessibility, chat, testing]
requires:
  - phase: 04-agents-routing-approvals-and-analytics
    provides: activity, audit, reputation, approval, and routing records
  - phase: 03-chat-workspace-motion-activity-and-command-bridge
    provides: bounded redacted ActivityStore and strict chat protocol
provides:
  - Bounded durable analytics queries and non-sensitive exports
  - Live fleet counts, timeline, per-agent drill-down, cost/latency/model summaries
  - Accessible chat analytics controls with quiet-mode and reduced-motion-safe presentation
affects: [05-release-and-marketplace]
actuals:
  tokens: 23244
  tasks: 2
  commits: 0
plan_head_before: unavailable
plan_head_after: unavailable
commits: 0
tech-stack:
  added: []
  patterns: [allowlisted analytics DTOs, bounded pagination, host-side recomputation, typed webview filters/export]
key-files:
  created:
    - src/domain/analytics.ts
    - src/services/analyticsStore.ts
    - src/services/fleetView.ts
    - src/test/analyticsStore.test.ts
  modified:
    - src/domain/activity.ts
    - src/services/activityStore.ts
    - src/services/chatBridge.ts
    - src/services/chat.ts
    - src/test/chatBridge.test.ts
decisions:
  - "Analytics are recomputed in the extension host from bounded ActivityStore, AuditStore, and ReputationStore records; the webview never supplies authoritative counts." 
  - "Route is persisted as an optional operational ActivityEvent field for compatible lifecycle drill-down." 
  - "Quiet mode changes labels only and never suppresses status, cost, approval, error, privacy, or provider-boundary facts."
metrics:
  duration: approximately 1h 20m
  completed: 2026-10-25
  status: complete
---

# Phase 4 Plan 5: Live Fleet and Durable Analytics Summary

The chat now exposes a privacy-safe live agent fleet, durable event timeline, per-agent drill-down, reputation evidence, cost/latency/model summaries, bounded filters, and export controls.

## Accomplishments

- Added typed analytics contracts for filters, fleet snapshots, agent details, timeline records, cost/latency/model summaries, reputation evidence, and exports.
- Implemented `AnalyticsStore` over bounded ActivityStore sessions plus audit and reputation records, with session/project/phase/model/role/time filters, pagination, stable sorting, and host-side DTO recomputation.
- Persisted optional route metadata on activity events and included estimated versus actual tokens/cost, approval state, outcomes, duration, and model distribution in drill-down projections.
- Added redaction at the analytics boundary for private prompts, authorization-shaped values, and other secret material, including prebuilt fixture records; exports contain only the versioned operational DTO.
- Added `buildFleetView` for accessible labels and quiet presentation while preserving authoritative operational facts.
- Extended the strict chat protocol with analytics loading, drill-down, filtered export, and quiet-mode messages. The chat creates accessible fleet controls with `aria-live` timeline output, keyboard buttons, and presentation controls that do not hide operational state.

## Verification

- `npm run lint` — passed.
- Focused analytics/fleet/chat protocol tests — passed.
- `npm test` — passed: 24 test files, 24 passed, 0 failed, 0 skipped/todo.
- `npm run package` — passed; `near-ai-vscode-0.1.0.vsix` produced.
- Privacy-negative tests assert raw prompt and credential-shaped values are absent from analytics export and user-visible timeline DTOs.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Information disclosure] Redacted analytics inputs independently of the ActivityStore boundary**
- **Found during:** Task 1 threat-surface review.
- **Issue:** Analytics fixtures or future alternate sources could contain prompt or authorization-shaped text even though the normal ActivityStore path already redacts it.
- **Fix:** Apply bounded secret/prompt redaction while constructing timeline summaries, agent task labels, filter values, and export DTOs; represent reputation as allowlisted evidence summaries.
- **Files modified:** `src/services/analyticsStore.ts`
- **Verification:** Analytics export negative test, lint, full tests, and packaging pass.
- **Commit:** unavailable; workspace has no usable Git repository.

**2. [Rule 2 - Missing critical functionality] Added route persistence to activity lifecycle records**
- **Found during:** Task 1 implementation.
- **Issue:** The plan requires route in per-agent drill-down, but the existing ActivityStore update contract did not persist it.
- **Fix:** Added an optional route field to ActivityEvent and ActivityUpdate, preserving legacy records and bounded serialization behavior.
- **Files modified:** `src/domain/activity.ts`, `src/services/activityStore.ts`
- **Verification:** TypeScript lint, analytics projection tests, full tests, and packaging pass.
- **Commit:** unavailable; workspace has no usable Git repository.

## Git / Commit Status

Git commits were unavailable as requested. The mounted `.git` path is not a usable repository; no commit hashes, ancestry, or commit ledger values are fabricated. `commits: 0` is recorded honestly. Phase 5 was not started.

## Known Stubs

None blocking the plan goal. Existing HTML input `placeholder` attributes are intentional accessible affordances, not unconnected analytics data sources.

## Threat Surface Review

The plan's analytics/export, webview tampering, and timeline repudiation mitigations are covered by bounded allowlists, host-side recomputation, strict filter parsing, redacted summaries, joined stable IDs/timestamps, and no filesystem path supplied by export requests. No new network endpoint or credential access path was introduced.

## Self-Check: PASSED

- Summary file exists at the required path.
- `status: complete` is present.
- All plan-listed implementation and test surfaces exist.
- `npm run lint`, `npm test`, and `npm run package` passed.
- Git verification is not applicable because the workspace is not a usable Git repository; no commit claims are present.

---
*Phase: 04-agents-routing-approvals-and-analytics*
*Plan: 05*
*Completed: 2026-10-25*
