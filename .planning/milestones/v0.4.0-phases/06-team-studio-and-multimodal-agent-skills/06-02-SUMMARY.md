---
phase: 06-team-studio-and-multimodal-agent-skills
plan: 02
subsystem: capability-routing
tags: [capabilities, modalities, model-catalog, routing, reputation, privacy, teams, multimodal]

requires:
  - phase: 06-team-studio-and-multimodal-agent-skills
    provides: reusable versioned teams, bounded member contracts, immutable project bindings, and host-owned team previews
  - phase: 04-agents-routing-approvals-and-analytics
    provides: role-specific decaying reputation, bounded exploration, policy gates, and lifecycle records
  - phase: 05-verification-hardening-and-release
    provides: scoped provider/profile attribution and release packaging checks
provides:
  - strict provider/model capability snapshots from declared catalog metadata
  - fail-closed modality, skill, generation, privacy, locality, pricing, cancellation, and publication compatibility checks
  - capability-first reputation routing with explainable exclusions, freshness, and immutable route snapshots
  - capability-aware team preview DTOs with explicit refresh-required and unavailable states
  - focused negative tests for unsupported image/video/audio, forged metadata, stale pricing, incompatible routes, and webview injection
affects: [06-03, multimodal-intake, generation, team-studio, provider-routing, analytics]

actuals:
  tokens: 45930
  tasks: 3
  commits: 0
plan_head_before: unavailable
plan_head_after: unavailable

tech-stack:
  added: []
  patterns:
    - allowlisted provider catalog normalization with explicit unknown/contradictory metadata
    - two-stage routing: hard capability/policy eligibility before role-specific reputation and exploration
    - immutable bounded capability and route snapshots in explanations, lifecycle events, and reputation evidence
    - host-generated capability preview DTOs with no authoritative webview fields

key-files:
  created:
    - src/domain/capabilities.ts
    - src/services/capabilityRouter.ts
    - src/test/capabilityRouter.test.ts
  modified:
    - src/domain/routing.ts
    - src/services/nearAiClient.ts
    - src/services/agentOrchestrator.ts
    - src/services/reputation.ts
    - src/services/chatBridge.ts
    - src/services/chat.ts
    - src/test/reputation.test.ts

key-decisions:
  - "Provider/model capability is proven only by current, declared, freshness-bound metadata; model names never imply image, video, audio, or generation support."
  - "Capability compatibility is a hard eligibility stage before reputation scoring, so a high-scoring incompatible member can never displace a compatible candidate."
  - "Local/cloud/privacy, pricing, readiness, cancellation, publication, and provider operation constraints are explicit; unknown or missing facts produce unavailable or denied results with no silent fallback."
  - "Route and capability snapshots are cloned into explanations and lifecycle/reputation records; refresh or profile changes require a new route decision."

requirements-completed: [MULTI-02, GEN-02, ROUTE-01, ROUTE-02, AGENT-05, TEST-01, SEC-01, SEC-02]

coverage:
  - id: D1
    description: "Official-shaped model metadata becomes a current capability snapshot and routes an image-analysis request only when declared metadata is compatible."
    requirement: MULTI-02
    verification:
      - kind: unit
        ref: src/test/capabilityRouter.test.ts#model capability metadata and image-analysis route preserve source, freshness, privacy, and pricing facts
        status: pass
      - kind: unit
        ref: src/test/capabilityRouter.test.ts#orchestration exposes a capability route explanation and blocks unverified routes before reputation
        status: pass
    human_judgment: false
  - id: D2
    description: "Unsupported or uncertain image/video/audio/generation routes fail closed with explicit reasons and never fall back to generic chat."
    requirement: GEN-02
    verification:
      - kind: unit
        ref: src/test/capabilityRouter.test.ts#unknown capability metadata fails closed even when the model name resembles a generator
        status: pass
      - kind: unit
        ref: src/test/capabilityRouter.test.ts#unsupported image, video, and audio requirements never fall back to generic chat
        status: pass
      - kind: unit
        ref: src/test/capabilityRouter.test.ts#stale metadata and unavailable pricing produce explicit no-route results
        status: pass
    human_judgment: false
  - id: D3
    description: "Only capability-compatible candidates reach decaying role-specific reputation and bounded deterministic exploration."
    requirement: ROUTE-01
    verification:
      - kind: unit
        ref: src/test/reputation.test.ts#an incompatible high-reputation profile is never selected over a compatible lower-scoring profile
        status: pass
      - kind: unit
        ref: src/test/reputation.test.ts#compatible lower-scoring profiles remain eligible for deterministic exploration
        status: pass
      - kind: unit
        ref: src/test/reputation.test.ts#capability compatibility excludes member, modality, locality, privacy, cancellation, publication, and pricing mismatches
        status: pass
    human_judgment: false
  - id: D4
    description: "Team previews expose bounded capability status, route metadata, freshness, readiness, pricing, privacy, and explicit refresh-required states."
    requirement: ROUTE-02
    verification:
      - kind: unit
        ref: src/test/capabilityRouter.test.ts#team capability preview shows current model metadata and explicit unavailable states without catalog payloads
        status: pass
      - kind: other
        ref: npm run lint && npm test && npm run package
        status: pass
    human_judgment: true
    rationale: "Automated checks validate the host DTO and generated markup; interactive VS Code keyboard/screen-reader review remains a human judgment."
  - id: D5
    description: "Forged catalog fields, capability injections, raw catalog payloads, and mutable route snapshots cannot expand authority or leak provider response data."
    requirement: SEC-01
    verification:
      - kind: unit
        ref: src/test/capabilityRouter.test.ts#malformed forged modality metadata is unavailable rather than coerced into support
        status: pass
      - kind: unit
        ref: src/test/capabilityRouter.test.ts#team capability preview shows current model metadata and explicit unavailable states without catalog payloads
        status: pass
      - kind: unit
        ref: src/test/reputation.test.ts#route explanations hold immutable capability snapshots until a fresh route is requested
        status: pass
    human_judgment: false

duration: approximately 1h 10m
completed: 2026-10-26
status: complete
commits: 0
---

# Phase 6 Plan 2: Capability-Aware Routing Summary

**Declared provider/model capabilities now gate multimodal and generative routing before explainable reputation selection, with explicit unavailable states in team previews.**

## Performance

- **Duration:** approximately 1h 10m
- **Started:** 2026-10-26T02:16:00Z
- **Completed:** 2026-10-26T03:26:34Z
- **Tasks:** 3 completed
- **Files modified:** 10 source/test files, plus this summary
- **Commits:** 0; the mounted workspace has no usable Git metadata and the user explicitly requested no Git commits.

## Accomplishments

- Added `ModelCapabilitySnapshot`, bounded modality/skill/generation requirements, pricing/readiness/privacy/freshness contracts, and a metadata-only `CapabilityRouter`.
- Normalized NEAR AI catalog fields including input/output/architecture modalities, supported features, provider operations, readiness, context/output limits, privacy/TEE verification, cancellation/publication support, and pricing without changing existing chat behavior.
- Made orchestration perform hard capability and route checks before reputation, preserve explicit exclusions and score components, retain bounded exploration, and record immutable capability/attribution metadata.
- Added fail-closed negative coverage for unsupported image/video/audio, model-name spoofing, malformed metadata, stale/unpriced routes, locality/privacy mismatch, missing lifecycle support, incompatible high-reputation candidates, and snapshot refresh.
- Extended team preview protocol/rendering with host-generated route capability status and explicit refresh-required/unavailable states; injected provider/model/cost/eligibility fields remain rejected by the strict webview parser.

## Task Commits

No Git commits were created, per the user request. The workspace `.git` directory is absent/unusable, so no commit hashes are fabricated.

1. **Task 1: Trace one provider model capability from official catalog metadata into a compatible route** — no commit (user-requested no-commit execution).
2. **Task 2: Expand compatibility constraints and reputation-aware route selection** — no commit (user-requested no-commit execution).
3. **Task 3: Surface capability-aware team previews and explicit unavailable states** — no commit (user-requested no-commit execution).

## Files Created/Modified

- `src/domain/capabilities.ts` — capability requirements, snapshots, pricing, lifecycle support, availability, and reason-code contracts.
- `src/services/capabilityRouter.ts` — injected-catalog, clock-bound, fail-closed compatibility evaluation and candidate partitioning.
- `src/services/nearAiClient.ts` — allowlisted official catalog metadata normalization with freshness/source markers.
- `src/domain/routing.ts` — capability-aware candidates, explanations, lifecycle metadata, and reputation evidence references.
- `src/services/agentOrchestrator.ts` — capability-first route eligibility, immutable route snapshots, project/profile attribution, and capability-linked evidence.
- `src/services/reputation.ts` — safe persistence of capability requirement/snapshot references.
- `src/services/chatBridge.ts` — capability-aware team preview DTOs and host-generated unavailable states.
- `src/services/chat.ts` — provider catalog loading for previews and accessible capability status rendering.
- `src/test/capabilityRouter.test.ts` — tracer, negative, snapshot, orchestration, preview, and webview-injection tests.
- `src/test/reputation.test.ts` — compatibility matrix, hard eligibility, exploration, and route refresh tests.

## Decisions Made

- Kept capability routing provider-agnostic and credential-free; provider adapters supply catalog data, while the router never invents endpoints or performs network calls.
- Treat missing, malformed, contradictory, stale, unready, or unpriced metadata as an explicit unavailable/denied result.
- Kept local/cloud/provider selection explicit and independent of UI-provided cost, provider, model, privacy, or eligibility claims.
- Preserved existing generic text routing when no capability requirement is requested, while any explicit multimodal/generation requirement must pass the capability router.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Preserved existing ModelInfo catalog test contracts while adding capability metadata**
- **Found during:** Task 1
- **Issue:** Adding default capability fields to every normalized legacy model row changed existing deep-equality behavior.
- **Fix:** Capability fields are emitted when the provider row declares capability metadata; legacy pricing/chat rows retain their existing shape while capability routing treats missing metadata as unknown.
- **Files modified:** `src/services/nearAiClient.ts`
- **Verification:** `node dist/test/nearAiClient.test.js`, full `npm test`.

**2. [Rule 2 - Missing Critical] Added route-locality/privacy consistency checks and required known privacy/pricing facts for preview compatibility**
- **Found during:** Task 2/3 hardening
- **Issue:** A route marked local or cloud could otherwise be paired with a contradictory provider snapshot, and a preview could label an unknown privacy/pricing route compatible.
- **Fix:** Added explicit candidate-vs-snapshot locality/privacy checks and made unknown privacy/verification/pricing preview status unavailable or refresh-required.
- **Files modified:** `src/services/capabilityRouter.ts`, `src/services/chatBridge.ts`
- **Verification:** focused capability/reputation tests, full `npm test`, and packaging.

**3. [Rule 3 - Blocking] Added a provider catalog-backed preview loading seam**
- **Found during:** Task 3
- **Issue:** Team preview had no path to current provider metadata and could not distinguish current compatibility from missing catalog state.
- **Fix:** Chat preview loading now uses the selected validated provider profile when available and otherwise returns an explicit refresh-required DTO; it never falls back to another provider.
- **Files modified:** `src/services/chat.ts`, `src/services/chatBridge.ts`
- **Verification:** preview/injection tests, lint, full tests, and VSIX packaging.

**Total deviations:** 3 auto-fixed (1 bug, 1 missing critical safeguard, 1 blocking integration seam).
**Impact on plan:** All changes directly enforce the plan’s fail-closed capability, privacy, attribution, and no-silent-fallback requirements; no runtime dependency or new unrestricted endpoint was added.

## Issues Encountered

- The mounted workspace has no usable Git repository metadata. Per the user request, task commits, plan ledger measurement, and final metadata commit were not attempted; `commits: 0` and unavailable Git heads are recorded honestly.
- The initial generic GSD phase resolver did not recognize the direct `06-02` plan identifier, so execution continued from the explicit plan path after loading state and required context.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

06-03 can consume current capability snapshots, explicit route explanations, and immutable capability IDs for multimodal intake and provenance. Image/video/audio requests are now blocked unless future adapters provide declared operation, privacy, pricing, and lifecycle contracts.

## Verification

- `npm run lint` — passed.
- Focused capability, client, reputation, team-preview, and team-invocation tests — passed.
- `npm test` — passed: 32 test files, 32 passed, 0 failed, 0 skipped/todo.
- `npm run package` — passed; `near-ai-vscode-0.1.0.vsix` produced.
- Stub/security scan completed; no new intentional UI/data-source stubs or sensitive catalog/provider payload serialization were introduced.

## Self-Check: PASSED

- Summary exists at `.planning/phases/06-team-studio-and-multimodal-agent-skills/06-02-SUMMARY.md`.
- All plan requirements are listed as completed.
- All listed focused and full verification commands passed.
- No Git commits or fabricated commit hashes were created.
- Capability explanations contain bounded IDs/reasons/metadata only; raw provider responses, prompts, media, credentials, and unrestricted paths are not included.

---
*Phase: 06-team-studio-and-multimodal-agent-skills*
*Plan: 02*
*Completed: 2026-10-26*
