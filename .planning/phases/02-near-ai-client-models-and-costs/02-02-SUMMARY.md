---
phase: 02-near-ai-client-models-and-costs
plan: 02
subsystem: api
tags: [near-ai, usage, costs, reconciliation, retries, verification, testing]
requires:
  - phase: 02-near-ai-client-models-and-costs
    provides: Typed NEAR AI client, model catalog, streaming metadata, and cost estimation
provides:
  - Provider usage and actual-cost reconciliation boundary
  - Bounded exponential retry/backoff with cancellation handling
  - Broader request, usage, pricing, and verification metadata normalization
affects: [03-chat-workspace, 04-agents-routing-approvals-analytics]
tech-stack:
  added: []
  patterns: [bounded exponential retry, explicit estimated-vs-actual cost DTOs, provider reconciliation endpoint]
key-files:
  created: [.planning/phases/02-near-ai-client-models-and-costs/02-02-SUMMARY.md]
  modified: [src/services/nearAiClient.ts, src/test/nearAiClient.test.ts]
key-decisions:
  - "Expose reconcileUsage as a separate provider boundary so actual cost cannot be confused with an estimate."
  - "Limit retries to at most three attempts and make backoff abort-aware."
  - "Keep unavailable provider values undefined rather than fabricating usage, cost, or verification state."
requirements-completed: [MODEL-01, COST-01, PRIV-01, TEST-01]
metrics:
  duration: 20m
  completed: 2026-10-25
  status: complete
commits: 0
plan_head_before: unavailable
plan_head_after: unavailable
actuals:
  tokens: 6400
  tasks: 1
  commits: 0
status: complete
---

# Phase 2 Plan 2: Usage, Cost, and Provider Metadata Completion Summary

**NEAR AI usage reconciliation now reports provider actual cost separately from estimates, with bounded retry/backoff and cancellation-safe metadata normalization.**

## Performance

- **Duration:** approximately 20 minutes.
- **Completed:** 2026-10-25.
- **Tasks:** 1 plan task completed.
- **Files modified:** 2 implementation/test files, plus this summary.

## Accomplishments

- Added `reconcileUsage(requestId)` for provider-reported request identity, token usage, verification, provider, and actual cost.
- Preserved the estimated-vs-actual distinction by clearing estimates on reconciliation responses and leaving unavailable values undefined.
- Normalized additional request ID, provider, token, pricing, TEE, verification, and numeric string forms.
- Added bounded exponential retry/backoff for transient HTTP and network failures, with cancellation stopping both retries and backoff waits.
- Added tests for reconciliation, actual-cost separation, retry bounds, cancellation, and the existing metadata/error contracts.

## Task Commits

The task could not be committed because this workspace contains an empty read-only `.git` directory. Git reports “not a git repository,” so no commit hash is available and none is fabricated.

1. **Task 1: Complete usage, cost, provider metadata, retry, cancellation, and tests** — no commit (repository unavailable)

## Verification Results

- `npm run lint` — passed.
- `npm test` — passed; 7 test files, 13 tests, 0 failures.
- `npm run package` — passed; produced `near-ai-vscode-0.1.0.vsix`.
- Verification coverage confirms completed streams preserve request ID, latency, usage, estimated cost, and verification metadata where supplied; reconciliation keeps actual cost distinct; authentication, malformed request, policy, and cancellation failures are not retried.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Treat abort-after-response as cancellation**
- **Found during:** Task 1 verification.
- **Issue:** A cancellation arriving after a transient HTTP response could be surfaced as a non-retryable `NearAiError` instead of an abort error.
- **Fix:** Check the request signal immediately after fetch resolves and before HTTP retry classification.
- **Files modified:** `src/services/nearAiClient.ts`, `src/test/nearAiClient.test.ts`.
- **Verification:** Cancellation test passes and the full test suite passes.
- **Committed in:** Not committed; repository unavailable.

**Total deviations:** 1 auto-fixed bug; no scope expansion.

## Known Stubs

None found in the files created or modified by this plan.

## Issues Encountered

- `rg` is unavailable in the environment; targeted scans used `find`/`grep` where needed.
- Git is unavailable because `.git` is an empty read-only directory. Per-task and metadata commits, commit measurement, and commit hash self-checks are therefore impossible.
- The requirements helper could not match the project’s prose-formatted `REQUIREMENTS.md` entries (`MODEL-01`, `COST-01`, `PRIV-01`, `TEST-01`); no requirements file change was made.

## Next Phase Readiness

Plan 02-02 is complete. Phase 3 was not started.

## Self-Check: PASSED

- Summary file exists at the required path.
- `status: complete` is present.
- Verification commands passed.
- No commit claims were made because the repository is unavailable.
