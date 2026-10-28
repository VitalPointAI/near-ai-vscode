---
phase: 02-near-ai-client-models-and-costs
plan: 01
subsystem: api
tags: [near-ai, fetch, sse, streaming, pricing, retries, testing]
requires:
  - phase: 01-extension-foundation-and-onboarding
    provides: TypeScript extension scaffold, secret storage boundary, and redaction helper
provides:
  - Typed NEAR AI HTTP client for model discovery and streaming chat
  - Normalized model pricing, usage, request identity, latency, and verification metadata
  - Redacted errors, cancellation-aware streaming, retry classification, and cost estimation
affects: [02-02-usage-cost-and-provider-metadata, 03-chat-workspace]
actuals:
  tokens: 4570
  tasks: 1
  commits: 0
  plan_head_before: unavailable
  plan_head_after: unavailable
tech-stack:
  added: []
  patterns: [OpenAI-compatible fetch boundary, normalized provider DTOs, SSE async generators]
key-files:
  created: []
  modified: [src/services/nearAiClient.ts, src/test/nearAiClient.test.ts]
key-decisions:
  - "Keep streamChat compatible with the existing chat service while exposing streamChatEvents for ordered status/text lifecycle events."
  - "Treat missing provider pricing as unavailable rather than fabricating an estimated cost."
  - "Classify only transient HTTP/network failures as retryable; authentication, policy, malformed-request, and cancellation paths are non-retryable."
requirements-completed: [MODEL-01, CHAT-01, COST-01, PRIV-01, TEST-01]
coverage:
  - id: D1
    description: "Typed model discovery and pricing normalization"
    requirement: MODEL-01
    verification:
      - kind: unit
        ref: src/test/nearAiClient.test.ts#model catalog normalizes provider metadata
        status: pass
    human_judgment: false
  - id: D2
    description: "Streaming chat events with metadata and cancellation"
    requirement: CHAT-01
    verification:
      - kind: unit
        ref: src/test/nearAiClient.test.ts#stream events include ordered status, usage, request identity, and verification metadata
        status: pass
      - kind: unit
        ref: src/test/nearAiClient.test.ts#cancellation ends a stream without a completion event
        status: pass
    human_judgment: false
  - id: D3
    description: "Redacted errors, cost estimates, and retry classification"
    requirement: COST-01
    verification:
      - kind: unit
        ref: src/test/nearAiClient.test.ts#request construction keeps credentials out of errors and normalizes headers
        status: pass
      - kind: unit
        ref: src/test/nearAiClient.test.ts#cost estimates use normalized per-million pricing and remain unavailable without both prices
        status: pass
      - kind: unit
        ref: src/test/nearAiClient.test.ts#authentication, malformed request, policy, and cancellation failures are not retryable
        status: pass
    human_judgment: false
metrics:
  duration: 1h 5m
  completed: 2026-10-25
  status: complete
---

# Phase 2 Plan 1: NEAR AI Client and Model Catalog Summary

**OpenAI-compatible NEAR AI client with normalized model/pricing data, metadata-rich SSE streaming, redacted failures, cancellation, retries, and cost estimation.**

## Performance

- **Duration:** 1h 5m
- **Started:** 2026-10-25T20:04:00Z (approximate; executor start timestamp was not captured by the runtime)
- **Completed:** 2026-10-25T21:09:33Z
- **Tasks:** 1 plan task completed
- **Files modified:** 2

## Accomplishments

- Implemented bearer-authenticated model and pricing discovery with stable normalized model metadata.
- Added SSE chat streaming with ordered text/status/done events, request IDs, provider and verification headers, usage, latency, and cancellation behavior.
- Added redacted provider errors, transient-failure retry classification, pricing-based estimated cost helper, and mocked-fetch unit coverage.

## Task Commits

The task could not be committed because this workspace contains an empty read-only `.git` directory and Git cannot resolve a repository. No commit hash is fabricated; the implementation remains in the working tree for handoff.

1. **Task 1: Implement NEAR AI client, catalog, streaming, metadata, retries, and tests** - no commit (repository unavailable)

**Plan metadata:** no metadata commit (repository unavailable)

## Files Created/Modified

- `src/services/nearAiClient.ts` - Typed HTTP client, normalized models/pricing, SSE event streams, metadata, errors, cancellation, retry classification, and cost estimation.
- `src/test/nearAiClient.test.ts` - Mocked-fetch coverage for requests, redaction, normalization, streaming, cancellation, cost, and failure classification.

## Decisions Made

- Preserved the existing `streamChat` delta API and added `streamChatEvents` for richer lifecycle consumers.
- Kept unavailable pricing explicit instead of producing fabricated estimates.
- Reused the existing redaction helper and never include provider response bodies or credentials in structured errors.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed stream completion and cancellation semantics**
- **Found during:** Task 1 verification
- **Issue:** The initial implementation did not emit a final delta when providers closed a stream without `[DONE]`, and cancellation could be mistaken for normal completion.
- **Fix:** Emit one clean completion event for ordinary EOF and explicitly abort the reader path when the signal is cancelled.
- **Files modified:** `src/services/nearAiClient.ts`, `src/test/nearAiClient.test.ts`
- **Verification:** Full unit suite passed, including stream completion and cancellation tests.
- **Committed in:** Not committed; repository unavailable.

**Total deviations:** 1 auto-fixed (Rule 1)
**Impact on plan:** Correctness fix directly required for the planned streaming contract; no scope expansion.

## Verification Results

- `npm run lint` — passed.
- `npm test` — passed; 7 test files, 11 tests, 0 failures.
- `npm run check` — passed.
- `npm run package` — passed; produced `near-ai-vscode-0.1.0.vsix`.
- Secret/error assertion coverage passed; test fixtures contain intentionally named fake secrets only.

## Issues Encountered

- `rg` is not installed in the environment; the final placeholder/secret scan used `grep` instead.
- Git is unavailable: `.git` exists as an empty read-only directory, so `git status`, commit staging, commit creation, and commit measurement all fail with “not a git repository.”

## User Setup Required

None - no external service configuration required for this client boundary.

## Next Phase Readiness

The client boundary is ready for Plan 02-02 to add provider reconciliation and complete usage/cost metadata. Phase 3 work was not started.

---
*Phase: 02-near-ai-client-models-and-costs*
*Completed: 2026-10-25*

## Self-Check: PASSED

- Summary file exists at the required path.
- `status: complete` is present.
- Verification commands passed.
- No commit claims were made because the repository is unavailable.
