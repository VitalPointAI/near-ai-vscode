---
phase: 04-agents-routing-approvals-and-analytics
plan: 04
subsystem: approvals-audit-continuity
tags: [approvals, budgets, emergency-stop, audit, resumability, privacy, security]
requires:
  - phase: 04-agents-routing-approvals-and-analytics
    plan: 02
    provides: PolicyGate, privacy preflight, redacted provider-boundary decisions
  - phase: 04-agents-routing-approvals-and-analytics
    plan: 03
    provides: policy-gated agent lifecycle and paused restart state
provides:
  - Redacted approval previews with exact-scope decisions and cost visibility
  - Request/session/project budget warnings, hard stops, and emergency stop control
  - Bounded local audit persistence, filtering, export, and corruption recovery
  - Restart-safe continuation snapshots requiring fresh policy and approval
affects: [04-05]
actuals:
  tokens: 7773
  tasks: 2
  commits: 0
  estimate_tokens: 30000
  plan_head_before: unavailable
  plan_head_after: unavailable
commits: 0
tech-stack:
  added: []
  patterns: [exact-scope approval previews, bounded atomic audit ledger, non-executable resume snapshots, estimated-versus-actual cost accounting]
key-files:
  created:
    - src/domain/approval.ts
    - src/services/approvalService.ts
    - src/services/auditStore.ts
    - src/services/resumableExecution.ts
    - src/test/approvalService.test.ts
    - src/test/auditStore.test.ts
    - src/test/resumableExecution.test.ts
  modified:
    - src/services/privacyPreflight.ts
key-decisions:
  - "Risky capabilities require a preview-bound approval decision; approvals are single-scope, time-limited, and never silently reused for another request."
  - "Budget enforcement reports request, session, and project state separately, preserving estimated cost before dispatch and actual cost after dispatch."
  - "Emergency stop blocks new dispatch while allowing audit and terminal bookkeeping to continue."
  - "Audit and resume records are bounded, versioned, operational-only, and redact sensitive content; resume restoration never replays commands or auto-approves work."
  - "Git commits were unavailable because the mounted workspace is not a usable Git repository; no commit hashes are fabricated."
metrics:
  duration: approximately 1h
  completed: 2026-10-25
  tasks: 2
  files: 8
  commits: 0
status: complete
---

# Phase 4 Plan 4: Approval, Budget, Audit, and Resumable Execution Summary

Risky work is now presented as a redacted, explainable approval preview, checked against layered budgets and an emergency stop, recorded as structured audit telemetry, and recoverable as non-executable continuation state.

## Accomplishments

- Added `ApprovalPreview`, approval decision, budget, emergency-stop, and structured `AuditEvent` contracts for the UI/reporting boundary.
- Implemented `ApprovalService` with provider/privacy evaluation, capability-aware approval requirements, exact preview binding, expiry/stale rejection, request/session/project budget status, estimated-versus-actual cost fields, and emergency-stop enforcement.
- Added `AuditStore` with versioned bounded persistence, atomic replacement, filtering by session/project/phase/agent/role/model/time/type, safe export, explicit redaction, and corrupt-data recovery.
- Added `ResumableExecution` snapshots for agent ledger, pending approval IDs, budget state, last safe event, and next action. Restored state is explicitly marked as requiring fresh policy and approval.
- Tightened privacy preview redaction for private prompt/context and tool-output markers so the approval UI and audit serialization do not expose raw sensitive content.
- Added negative tests for credentials/private context, denied and stale approvals, budget warnings/hard stops, emergency stop, estimated/actual cost distinction, bounded audit history, filtered export, corruption recovery, pending approval restore, no replay, and credential-safe persistence.

## Verification

- `npm run lint` — passed.
- Focused approval/audit/resume verification — passed after correcting budget aggregation and retaining approved previews through dispatch.
- `npm test` — passed: 23 test files, 23 passed, 0 failed, 0 skipped/todo.
- `npm run package` — passed; `near-ai-vscode-0.1.0.vsix` produced.
- Required implementation and test files exist.
- Stub scan of plan files — no TODO/FIXME/placeholder/empty-rendering stubs found.
- No NEAR credential files were read, transmitted, overwritten, or deleted.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected approval preview redaction and dispatch retention**
- **Found during:** Task 1 focused verification.
- **Issue:** Initial focused tests identified sensitive marker leakage in preview serialization and approved previews being removed before dispatch could consume them.
- **Fix:** Redacted private prompt/context markers in privacy previews and retained the preview as the exact dispatch authorization record until lifecycle completion.
- **Files modified:** `src/services/privacyPreflight.ts`, `src/services/approvalService.ts`
- **Verification:** Approval redaction, approval lifecycle, and full test suite pass.
- **Commit:** unavailable; repository is not usable Git.

**2. [Rule 1 - Bug] Applied aggregate session/project budget hard stops at dispatch**
- **Found during:** Task 1 budget verification.
- **Issue:** Preview state included accumulated session/project spend, but dispatch initially checked only the project budget.
- **Fix:** Dispatch now rejects any request/session/project budget in hard-stop state while preserving warning states for the preview/reporting surface.
- **Files modified:** `src/services/approvalService.ts`, `src/test/approvalService.test.ts`
- **Verification:** Budget warning/hard-stop and emergency-stop tests, full suite, and packaging pass.
- **Commit:** unavailable; repository is not usable Git.

No package installation, authentication gate, architectural expansion, 04-05 work, or Phase 5 work occurred.

## Threat Surface Review

- **T-04-10 spoofing:** Approval records bind preview ID, request ID, exact scope, policy version, and expiry; denied/stale/unknown approvals cannot dispatch.
- **T-04-11 elevation of privilege:** Resume state is display/continuation metadata only and requires fresh policy/preflight/approval; stored commands are never persisted or replayed.
- **T-04-12 information disclosure:** Audit fields are allowlisted operational metadata, bounded and redacted; export and corrupt-data tests cover sensitive fixtures.
- No new external endpoint or credential access path was introduced.

## Known Stubs

None found in files created or modified by this plan.

## Git Availability

Git task commits and metadata commits were unavailable. `git status` reports that the mounted workspace is not a Git repository, so `commits: 0`, `plan_head_before: unavailable`, and `plan_head_after: unavailable` are recorded honestly. No Git metadata was initialized or changed.

## Self-Check: PASSED

- Summary file exists at the required path.
- All seven plan implementation/test artifacts exist.
- Lint, full tests, focused security/privacy tests, and VSIX packaging pass.
- No stubs or skipped tests were left behind.
- Git commit/ancestry verification is not applicable because the workspace is not a usable Git repository.

---
*Phase: 04-agents-routing-approvals-and-analytics*
*Plan: 04*
*Completed: 2026-10-25*
