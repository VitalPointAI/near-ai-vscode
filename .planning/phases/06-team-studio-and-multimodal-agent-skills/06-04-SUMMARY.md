---
phase: 06-team-studio-and-multimodal-agent-skills
plan: 04
subsystem: capability-bound-media-generation
tags: [image-generation, video-generation, capabilities, approvals, cost, privacy, provenance, publication, redaction]
requires:
  - phase: 06-team-studio-and-multimodal-agent-skills
    provides: capability-aware routing, privacy preflight, and host-managed multimodal intake
  - phase: 05-verification-hardening-and-release
    provides: provider credential boundaries, attribution, usage, and packaging conventions
provides:
  - explicit image/video generation contracts and provider adapter boundaries
  - capability, model metadata, privacy, attribution, estimate/actual usage, approval, budget, cancellation, and emergency-stop enforcement
  - managed generated-artifact provenance and separate publication approval/containment
  - strict generation bridge protocol and redacted host UI controls
affects: [team-studio, multimodal-generation, chat, analytics, publication]
tech_stack:
  added: []
  patterns:
    - exact capability snapshots and provider-operation allowlists
    - ephemeral raw prompt/content handles with metadata-only persistence
    - bounded asynchronous lifecycle polling with unknown-state fail-closed behavior
    - separate generation and publication approvals with workspace containment
key_files:
  created:
    - src/domain/generation.ts
    - src/services/generationService.ts
    - src/test/generationService.test.ts
    - src/test/generationProtocol.test.ts
  modified:
    - src/domain/capabilities.ts
    - src/domain/policy.ts
    - src/domain/teamStudio.ts
    - src/services/capabilityRouter.ts
    - src/services/nearAiClient.ts
    - src/services/chatBridge.ts
    - src/services/chat.ts
    - src/services/activityStore.ts
    - src/services/analyticsStore.ts
decisions:
  - "NEAR AI is adapted only for documented image generation and image edit routes; no NEAR video endpoint is invented or implied."
  - "Video is provider-neutral at the adapter boundary and requires advertised create, status, content, and cancellation operations before dispatch."
  - "Generation and publication use separate exact-scope approvals; generated artifacts remain workspace-managed and unpublished by default."
  - "Capability and cost metadata are host-derived and snapshotted; forged webview claims, unknown models, missing prices, and unknown provider states fail closed."
requirements_completed: [GEN-01, GEN-02, MULTI-02, MULTI-03, COST-01, COST-02, COST-03, COST-04, SAFE-02, OBS-01, TEST-01, SEC-01, SEC-02]
actuals:
  tokens: 39200
  tasks: 3
  commits: 0
plan_head_before: unavailable
plan_head_after: unavailable
status: complete
---

# Phase 6 Plan 4: Capability-bound image/video generation Summary

Capability-accurate image and provider-neutral video generation now run through explicit adapters with host-owned approvals, budgets, privacy, attribution, usage/cost accounting, managed provenance, cancellation, and separate publication controls.

## Delivered

- Added versioned generation contracts for image generation, image editing, and asynchronous video lifecycle states, including immutable route/model metadata, provider operations, estimated and actual usage/cost, attribution, lineage, and publication state.
- Added `GenerationService` with exact `CapabilityRouter` checks, adapter allowlists, privacy preflight, approval/budget/emergency-stop gates, abortable execution, bounded video polling, restart-to-unknown behavior, managed output storage, and separate publication approval with path containment.
- Extended the NEAR client only with documented `/images/generations` and `/images/edits` calls. Provider-hosted URLs are not silently fetched, and NEAR video remains unavailable without a real documented adapter.
- Added strict generation bridge parsing and host UI review/status/cancellation/publication controls. The webview cannot provide provider URLs, capability claims, approval authority, or raw media handles.
- Added media policy capabilities to team-tool capability typing and bounded pricing/provider-operation metadata to keep orchestrator and router integration type-safe.
- Redacted generation prompts/media from activity and analytics summaries while retaining bounded route, model, lifecycle, attribution, request, estimate, and actual-cost metadata.

## Negative coverage

Tests cover forged capability claims, unsupported/unknown models, missing provider endpoints, missing prices, absent lifecycle operations, silent-generation prevention, approval/budget/emergency-stop blocks, cancellation, unknown provider state, provider-hosted media URLs, raw prompt/media non-leakage, publication without exact approval, traversal/absolute publication destinations, and separate publication authorization.

## Verification

Passed:

- `npm run lint`
- `npm run compile`
- Focused compiled suites: `generationService.test.js`, `generationProtocol.test.js`, and `nearAiClient.test.js` — 3 suites, 0 failures, 0 skipped, 0 todo.

Per the latest user instruction, the broader `npm test` suite and `npm run package` were not rerun after the focused green verification; they remain the next release-boundary checks.

## Deviations from Plan

### Auto-fixed Issues

1. **Rule 2 — capability integration:** Added `mediaGeneration` and `mediaPublication` to the shared team-tool capability union so the agent orchestrator cannot widen or lose the generation policy boundary.
2. **Rule 2 — fail-closed metadata:** Added explicit image/video pricing and lifecycle operation metadata, exact adapter validation, and unknown-provider-state handling required for safe cost and lifecycle accounting.
3. **Rule 1/3 — integration/type fixes:** Corrected record-to-ID calls, concrete abort signals, lifecycle-to-activity status mapping, route provider-boundary propagation, and `Buffer`-backed image edit blobs without weakening types.

No authentication gates occurred. No new package dependency was required. No Git commits were created, as explicitly requested by the user; the repository Git metadata is also not usable in this workspace.

## Known Stubs

None. NEAR video is intentionally unavailable because no documented NEAR video endpoint was supplied; provider-neutral video tests use an injected adapter and do not claim NEAR support.

## Self-Check: PASSED

- Summary file exists at `.planning/phases/06-team-studio-and-multimodal-agent-skills/06-04-SUMMARY.md`.
- Generation contracts, service, protocol tests, focused service tests, and client tests exist.
- Verification results above were observed directly.
- Commit checks are intentionally not applicable because commits were explicitly prohibited.
