---
phase: 05-verification-hardening-and-release
plan: 02
subsystem: analytics
tags: [attribution, activity, analytics, approvals, budgets, audit, exports, redaction, vscode]

requires:
  - phase: 05-verification-hardening-and-release
    plan: 01
    provides: Validated project/profile selection, host-only provider resolution, and non-sensitive profile metadata.
  - phase: 04-agents-routing-approvals-and-analytics
    plan: 04
    provides: Exact-scope approvals, layered budgets, emergency stop, bounded audit records, and estimate/actual cost semantics.
  - phase: 04-agents-routing-approvals-and-analytics
    plan: 05
    provides: Host-side analytics aggregation, fleet drill-down, filters, quiet mode, and safe export contracts.
provides:
  - Immutable host-derived organization-profile and workspace-project attribution snapshots across activity, provider usage, approvals, budgets, audit, analytics, drill-down, and export.
  - Estimate/actual reconciliation that merges one request identity without double-counting or fabricating unavailable provider values.
  - Explicit legacy/unknown attribution for records written before profile attribution existed.
  - Strict organization/project filters and UI display/export DTOs that exclude credentials, prompts, context, commands, paths, and signing material.
affects: [release, cost-ownership, observability, verification]

actuals:
  tokens: 42842
  tasks: 3
  commits: 0
  estimate_tokens: 12951
  plan_head_before: unavailable
  plan_head_after: unavailable

tech-stack:
  added: []
  patterns: [immutable attribution snapshots, request-keyed estimate/actual reconciliation, explicit legacy bucket, allowlisted audit DTOs, host-recomputed analytics filters]

key-files:
  created: []
  modified:
    - src/domain/activity.ts
    - src/services/activityStore.ts
    - src/domain/analytics.ts
    - src/services/analyticsStore.ts
    - src/domain/approval.ts
    - src/services/approvalService.ts
    - src/services/auditStore.ts
    - src/services/chatBridge.ts
    - src/services/chat.ts
    - src/services/fleetView.ts
    - src/test/activityStore.test.ts
    - src/test/analyticsStore.test.ts
    - src/test/approvalService.test.ts
    - src/test/auditStore.test.ts
    - src/test/chatBridge.test.ts

key-decisions:
  - "Capture project/profile ownership at session/request start and copy it onto every durable event; later profile switches cannot relabel history."
  - "Represent legacy ownership as an explicit unknown bucket and keep unavailable provider estimate/actual values undefined rather than converting them to zero."
  - "Aggregate by provider request identity, merging estimate and actual fields independently; audit cost is only added when no matching activity request exists."
  - "Treat organization and project filters as presentation queries only: the host recomputes authoritative analytics and the webview cannot submit cost, count, or owner values."
  - "Use allowlisted bounded labels for audit and export records; no NEAR credential files or signing material are accessed."

patterns-established:
  - "AttributionSnapshot: versioned status, project ID/label, organization profile ID, and organization display name captured by the host."
  - "Provider reconciliation: request IDs connect lifecycle estimate and provider actual usage while preserving both values."
  - "Legacy normalization: old activity/audit rows load safely as legacy-unknown and are never assigned the current selection."

requirements-completed: [COST-03, COST-04, CHAT-04, AGENT-03, OBS-01, TEST-01, SEC-01, SEC-02]

coverage:
  - id: D1
    description: "Activity and provider usage retain an immutable organization/profile and workspace-project snapshot through estimate and actual reconciliation."
    requirement: COST-04
    verification:
      - kind: unit
        ref: src/test/activityStore.test.ts#activity snapshots host attribution and appends provider reconciliation without relabelling history
        status: pass
      - kind: unit
        ref: src/test/analyticsStore.test.ts#analytics snapshots organization and project attribution, preserves estimate versus actual, and isolates profile switches
        status: pass
    human_judgment: false
  - id: D2
    description: "Approval, budget, and audit lifecycle records preserve attribution and reject forged or corrupted sensitive ownership data."
    requirement: SEC-01
    verification:
      - kind: unit
        ref: src/test/approvalService.test.ts#approval and budget audit events retain the preview attribution after a later profile switch
        status: pass
      - kind: unit
        ref: src/test/auditStore.test.ts#audit attribution is allowlisted, filterable, and legacy rows remain explicitly unknown
        status: pass
    human_judgment: false
  - id: D3
    description: "Host-recomputed analytics expose organization/project filters, attribution-aware drill-down, grouped cost summaries, and explicit unavailable values."
    requirement: AGENT-03
    verification:
      - kind: unit
        ref: src/test/chatBridge.test.ts#webview message parsing accepts only the typed chat protocol
        status: pass
      - kind: unit
        ref: src/test/analyticsStore.test.ts#analytics rejects forged filter values and leaves provider values unavailable when absent
        status: pass
    human_judgment: false
  - id: D4
    description: "Filtered analytics export and webview DTOs contain non-sensitive attribution only and never credentials, prompts, context, commands, paths, or signing material."
    requirement: SEC-02
    verification:
      - kind: other
        ref: npm run lint
        status: pass
      - kind: other
        ref: npm test
        status: pass
      - kind: other
        ref: npm run package
        status: pass
    human_judgment: false

metrics:
  duration: approximately 1h 15m
  completed: 2026-10-25
  status: complete
status: complete
---

# Phase 05 Plan 02: Immutable Organization and Project Cost Attribution Summary

**Host-derived organization/profile and workspace-project attribution now survives request lifecycle, provider reconciliation, approvals, budgets, audit, analytics, drill-down, filtering, reload, and safe export without exposing credentials or private context.**

## Performance

- **Duration:** approximately 1 hour 15 minutes.
- **Started:** 2026-10-25T22:27:00Z (execution start was not captured exactly by the runtime).
- **Completed:** 2026-10-25T23:42:27Z.
- **Tasks:** 3 completed.
- **Files modified:** 16 implementation/test files, plus this summary.

## Accomplishments

- Added versioned attribution snapshots to activity sessions/events, including stable project ID/label and organization profile ID/display name; existing records normalize to an explicit `legacy-unknown` bucket.
- Added provider request identity, cache metadata, and a reconciliation append path. Analytics merges one request's estimate and actual independently, preserves unavailable values, and avoids duplicate cost from matching audit events.
- Propagated attribution through approval previews, budget lifecycle events, emergency stop, dispatch, denial, and durable audit records while retaining exact project budget scope and separate estimated/actual tokens and costs.
- Added host-side organization/profile and project filters, grouped attribution cost summaries, attribution-aware agent/timeline drill-down, reload-safe fleet rendering, explicit unavailable UI labels, quiet-mode preservation, and filtered export.
- Added negative coverage for profile switching, legacy rows, forged owners/cost filters, stale approval context, corrupted audit rows, request reconciliation, and redaction of API keys, refresh tokens, prompts, context, commands, paths, and signing material.

## Task Commits

Git commits were unavailable. `.git` is an empty non-repository directory and Git reports that the workspace is not a repository. No repository was initialized and no hashes are fabricated.

1. **Task 1: Trace selected organization/project attribution from a provider result into analytics and export** — no commit (repository unavailable).
2. **Task 2: Preserve attribution through approvals, budgets, audit events, and durable drill-down** — no commit (repository unavailable).
3. **Task 3: Expose attribution-aware analytics filters, status, drill-down, and safe export** — no commit (repository unavailable).

**Plan metadata:** no commit (repository unavailable).

## Files Created/Modified

- `src/domain/activity.ts` / `src/services/activityStore.ts` — immutable session/event ownership snapshots, request IDs, bounded reconciliation, and legacy normalization.
- `src/domain/analytics.ts` / `src/services/analyticsStore.ts` — attribution-aware filters, grouped cost summaries, unique-request estimate/actual aggregation, timeline DTOs, and safe export.
- `src/domain/approval.ts` / `src/services/approvalService.ts` — preview and audit attribution plus lifecycle propagation and budget events.
- `src/services/auditStore.ts` — strict event-type and field allowlists, attribution normalization, bounded redaction, and organization filtering.
- `src/services/chatBridge.ts` / `src/services/chat.ts` / `src/services/fleetView.ts` — strict filter protocol, host recomputation, attribution-aware status/drill-down, and safe UI/export presentation.
- `src/test/activityStore.test.ts`, `src/test/analyticsStore.test.ts`, `src/test/approvalService.test.ts`, `src/test/auditStore.test.ts`, `src/test/chatBridge.test.ts` — focused positive and negative telemetry/security coverage.

## Verification and Security Evidence

- Focused Task 1, Task 2, and Task 3 verification commands all passed.
- `npm run lint` passed.
- `npm test` passed: 27 test files, 27 passed, 0 failed, 0 skipped/todo.
- `npm run package` passed and produced `near-ai-vscode-0.1.0.vsix`.
- Request-keyed aggregation proves a start estimate and later actual are both retained once; absent provider values remain unavailable.
- Reload and corrupted-ledger tests prove legacy records are explicit unknown and are never silently assigned to the selected profile/project.
- Protocol, analytics, approval, audit, and export tests assert that API keys, refresh tokens, bearer values, raw prompts, context markers, commands, paths, arbitrary event payloads, and signing material are absent.
- No code or verification command read, wrote, overwrote, archived, or deleted anything under `~/.near-credentials`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Merged estimate and actual usage for one provider request**
- **Found during:** Task 1 focused verification.
- **Issue:** Initial request-ID deduplication skipped the later actual event after seeing the request-start estimate.
- **Fix:** Aggregation now keeps a bounded per-request contribution and merges input/output tokens, estimated cost, actual cost, and cache state independently; matching audit costs are joined without double-counting.
- **Files modified:** `src/services/analyticsStore.ts`, `src/test/analyticsStore.test.ts`.
- **Verification:** Attribution/reconciliation focused suite, full tests, lint, and package pass.
- **Committed in:** no commit; repository unavailable.

**2. [Rule 2 - Information disclosure] Tightened attribution and audit normalization**
- **Found during:** Task 2 threat-surface review.
- **Issue:** Persisted or forged attribution/audit fields needed independent bounded validation so alternate ledger inputs could not introduce credential-shaped labels or invalid event types.
- **Fix:** Added safe attribution labels, explicit unknown fallback, audit event-type rejection, allowlisted scalar fields, organization filtering, and metadata key filtering.
- **Files modified:** `src/domain/activity.ts`, `src/services/auditStore.ts`, `src/test/approvalService.test.ts`, `src/test/auditStore.test.ts`.
- **Verification:** Approval/audit negative suite, full tests, lint, and package pass.
- **Committed in:** no commit; repository unavailable.

**Total deviations:** 2 auto-fixed (1 Rule 1, 1 Rule 2).
**Impact on plan:** Both fixes were required for estimate/actual correctness and telemetry privacy; no architectural scope expansion or dependency installation was needed.

## Issues Encountered

- The first focused test run found the request-ID aggregation defect described above; it was corrected before expansion and the tracer gate was rerun successfully.
- Git task and metadata commits were unavailable because the mounted `.git` path is not a repository. `commits: 0` is recorded honestly; no Git metadata was initialized or changed.
- The requirements helper could not match this project's prose-formatted `REQUIREMENTS.md` entries; the completed IDs are recorded in this summary and no requirements file was rewritten.

## Auth Gates

None encountered.

## Known Stubs

None found in the files modified by this plan. Existing HTML `placeholder` attributes are intentional accessible input affordances, not disconnected analytics data sources.

## Threat Surface Review

The plan's T-05-05 through T-05-08 mitigations are covered by host-only attribution capture, immutable lifecycle snapshots, strict bounded filters, unique-request aggregation, legacy normalization, allowlisted audit/export DTOs, and negative redaction tests. No new external endpoint or credential access path was introduced. The existing provider reconciliation boundary remains host-side and actual values are preserved only when the provider supplies them.

## Next Phase Readiness

The Phase 5 verification/release telemetry path is ready for final release review. Cost ownership is stable across profile switches, legacy data is explicit, and release checks are green. No external service setup is required.

## Self-Check: PASSED

- Summary file exists at the required path and contains `status: complete`.
- All 15 plan-listed implementation/test files exist, plus the activity-store reconciliation regression coverage.
- Focused tests, lint, full tests, and VSIX packaging passed.
- No known stubs, skipped tests, or unrun required verification remain.
- Git commit/ancestry checks are not applicable because the workspace is not a usable Git repository; no commit claims were made.

---
*Phase: 05-verification-hardening-and-release*
*Plan: 02*
*Completed: 2026-10-25*
