---
phase: 02-near-ai-client-models-and-costs
verified: 2026-10-25T21:25:00Z
status: human_needed
score: 6/6 must-haves verified
covered_files:
  - src/services/nearAiClient.ts
  - src/test/nearAiClient.test.ts
covered_digest: "v3:sha256:18b06f2e5934e0e7ecc3976ff6202d446a3e2e78f3f103c2265ed859c2f078cc"
behavior_unverified: 0
overrides_applied: 0
decision_coverage:
  honored: 0
  total: 0
  not_honored: []
human_verification:
  - test: Configure a valid NEAR AI API key and exercise model discovery, one streamed completion, cancellation, and usage reconciliation against the supported provider endpoint.
    expected: Models and pricing load; streamed text terminates cleanly; cancellation emits no completion; provider request ID, usage, latency, estimate/actual cost distinction, and TEE/verification status are shown or explicitly unavailable.
    why_human: Repository tests use mocked fetch responses and no live provider endpoint or credentials are available for deterministic verification here.
---

# Phase 2: NEAR AI Client, Model Catalog, and Cost Telemetry Verification Report

**Phase Goal:** Implement the typed NEAR AI client boundary with streaming, model/pricing discovery, request metadata, usage/cost estimation, actual-cost reconciliation, cancellation, retries, and provider/verification status.

**Verified:** 2026-10-25

**Status:** human_needed

**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | Client authentication and model/catalog/pricing data are normalized into stable typed metadata. | ✓ VERIFIED | `nearAiClient.ts:79-87,188-217,225-244`; mocked catalog tests pass and assert normalized IDs, context length, and prices. |
| 2 | Streaming emits ordered text/status/done events with request identity, usage, latency, and verification metadata. | ✓ VERIFIED | `nearAiClient.ts:98-180,246-299`; ordered lifecycle/metadata test passes. |
| 3 | Cancellation terminates streaming without a completion event and cancels the underlying reader path. | ✓ VERIFIED | `nearAiClient.ts:137-145,157-180`; named cancellation test and full suite pass. |
| 4 | Estimates use normalized model pricing, while actual reconciliation remains distinct and unavailable values are not fabricated. | ✓ VERIFIED | `estimateCostUsd` at lines 66-69; reconciliation clears estimates at lines 90-96; cost/reconciliation value assertions pass. |
| 5 | Only transient failures retry, with bounded attempts and abort-aware backoff. | ✓ VERIFIED | `nearAiClient.ts:188-217,327-337`; named retry/cancellation test and classification assertions pass. |
| 6 | Provider errors and structured metadata do not expose credentials, and provider/TEE status is normalized. | ✓ VERIFIED | `NearAiError` redacts at lines 49-59; header/payload normalization at lines 267-299; redaction and verification assertions pass. |

**Score:** 6/6 truths verified (0 present-but-behavior-unverified)

## Deferred Items

| # | Item | Addressed In | Evidence |
|---|---|---|---|
| 1 | Full conversation-state/user-flow completion for CHAT-01 is not part of this provider-boundary verification. | Phase 3 | Roadmap Phase 3 explicitly builds “the chat UI and conversation state”; Phase 2 verifies the streaming/cancellation boundary. |

## Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src/services/nearAiClient.ts` | Typed client, catalog, streaming, metadata, costs, reconciliation, retries | ✓ VERIFIED | 341 substantive lines; imported and used by `src/services/chat.ts`; real fetch responses flow into normalized output. |
| `src/test/nearAiClient.test.ts` | Boundary tests for catalog, streaming, cancellation, metadata, costs, reconciliation, retry/redaction | ✓ VERIFIED | 160 lines; compiled test runner executes it; all 13 tests pass. |

## Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `src/services/chat.ts` | `src/services/nearAiClient.ts` | `NearAiClient`, `listModelsWithPricing`, `streamChat` | WIRED | `chat.ts:5,49-52,82` imports, constructs, loads models, and consumes deltas. |
| `NearAiClient` | NEAR AI provider | injected/native `fetch` with bearer header | WIRED | `nearAiClient.ts:188-217` builds URL, sends bearer auth, handles retries/errors, and returns response data. |
| Phase 2 tests | `NearAiClient` | direct imports and mocked fetch/streams | WIRED | Tests invoke all public Phase 2 boundary methods and helpers. |

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| `listModelsWithPricing` | `ModelInfo[]` | Provider JSON `/models/pricing` → `jsonRows` → normalization | Yes; no static success fallback | ✓ FLOWING |
| `streamChat` / `streamChatEvents` | deltas/events and `UsageMetadata` | Provider response body SSE → `readEvents` → payload/header metadata | Yes; body and headers are consumed | ✓ FLOWING |
| `reconcileUsage` | `actualCostUsd` | Provider JSON `/usage/{requestId}` → `usageFromPayload` | Yes, only when provider reports it | ✓ FLOWING |
| `chat.ts` model/cost surface | model options and estimate | client catalog and completed-stream metadata | Yes; posted to webview/read by completion handler | ✓ FLOWING |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Full lint, compile, and unit tests | `npm run check` | 7 files, 13 tests, 0 failures | ✓ PASS |
| Cancellation invariant | `node --test dist/test/nearAiClient.test.js --test-name-pattern='cancellation ends a stream without a completion event'` | Matching test passed | ✓ PASS |
| Retry/cancellation invariant | `node --test dist/test/nearAiClient.test.js --test-name-pattern='transient failures use bounded exponential retry and cancellation stops retries'` | Matching test passed | ✓ PASS |
| Package output | `npm run package` | VSIX packaged successfully | ✓ PASS |

## Probe Execution

No Phase 2 probe was declared or found (`scripts/**/tests/probe-*.sh`). Not applicable.

## Requirements Coverage

| Requirement | Source Plan | Status | Evidence |
|---|---|---|---|
| MODEL-01 | 02-01, 02-02 | ✓ SATISFIED for Phase 2 boundary | Catalog normalization is tested; chat loads choices and sends the selected/default model (`chat.ts:45-52,82-83`). |
| CHAT-01 | 02-01 | ? NEEDS HUMAN / deferred completion state | Streaming, cancellation, and errors pass; full conversation state is explicitly Phase 3 scope. |
| COST-01 | 02-01, 02-02 | ✓ SATISFIED for provider boundary | Estimate, actual reconciliation, explicit unavailable values, and UI estimate wiring are tested/traced. |
| PRIV-01 | 02-01, 02-02 | ✓ SATISFIED for provider boundary | Header/payload verification normalization is implemented and asserted. |
| TEST-01 | 02-01, 02-02 | ✓ SATISFIED for Phase 2 boundary | Lint, full unit suite, named behavior checks, and packaging pass. |

## Anti-Patterns Found

| File | Pattern | Severity | Impact |
|---|---|---|---|
| `src/test/nearAiClient.test.ts` | Fake credential values such as `secret` in mocks | Info | Intentional fixtures; production errors redact them and the assertion passes. |

No debt markers, placeholder implementations, empty production returns, disabled tests, or circular expected-value generators were found in Phase 2 files.

## Human Verification Required

### Live NEAR AI provider smoke test

**Test:** Configure a valid API key and exercise model discovery, one streamed completion, cancellation, and provider usage reconciliation against the supported endpoint.

**Expected:** Live model/pricing data loads; stream lifecycle and cancellation behave as tested; request ID, usage, latency, estimate/actual cost distinction, and verification state are surfaced or explicitly unavailable.

**Why human:** Automated tests use mocked fetch responses and this workspace has no live provider credentials or endpoint contract fixture.

## Gaps Summary

No code or wiring gaps block the Phase 2 goal. All six derived goal truths are implemented, wired, data-flowing, and behaviorally exercised. The outstanding gate is a live-provider smoke test; broader conversation state is intentionally deferred to Phase 3.

---

_Verified: 2026-10-25T21:25:00Z_
_Verifier: the agent (gsd-verifier)_
