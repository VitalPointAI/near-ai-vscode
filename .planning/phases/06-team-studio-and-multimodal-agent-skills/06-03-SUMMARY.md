---
phase: 06-team-studio-and-multimodal-agent-skills
plan: 03
subsystem: multimodal-intake-and-lineage
tags: [multimodal, attachments, privacy, provenance, lineage, approvals, analytics, security]
requires:
  - phase: 06-team-studio-and-multimodal-agent-skills
    provides: capability-aware routing, fail-closed provider metadata, and reusable team policy contracts
  - phase: 04-agents-routing-approvals-and-analytics
    provides: privacy preflight, policy gate, bounded activity/analytics, approval, budget, and cancellation patterns
  - phase: 05-verification-hardening-and-release
    provides: scoped attribution and release packaging verification
provides:
  - bounded host-side intake for image, video, audio, document, and structured-data attachments
  - content-addressed managed references with realpath/symlink containment, detected-content checks, provenance, privacy, consent, and local-only metadata
  - exact approval-gated multimodal orchestration with raw-content handles isolated from default metadata flows
  - immutable source-to-derived lineage, bounded lifecycle persistence, cancellation, budget stops, and restart recovery
  - strict attachment/control chat protocol and visible local-only attachment UI
affects: [06-04, multimodal-generation, context-graph, analytics, chat-workspace]
actuals:
  tokens: 49608
  tasks: 3
  commits: 0
plan_head_before: unavailable
plan_head_after: unavailable
tech-stack:
  added: []
  patterns:
    - content-addressed local media staging with opaque webview IDs and host-only raw handles
    - explicit modality profiles, magic/content detection, bounded structured-data validation, and fail-closed reason codes
    - exact source/route/operation approval fingerprints with local-only enforcement and no silent cloud fallback
    - immutable lineage edges and metadata-only activity/analytics serialization
key-files:
  created:
    - src/domain/multimodal.ts
    - src/services/multimodalIntake.ts
    - src/services/multimodalOrchestrator.ts
    - src/test/multimodalIntake.test.ts
    - src/test/multimodalOrchestration.test.ts
  modified:
    - src/domain/privacy.ts
    - src/services/privacyPreflight.ts
    - src/services/activityStore.ts
    - src/services/analyticsStore.ts
    - src/services/chatBridge.ts
    - src/services/chat.ts
key-decisions:
  - "Raw media is staged only in host-managed local storage and is never part of attachment previews, prompts, activity, analytics, exports, or lineage metadata by default."
  - "Every provider-bound operation requires a current declared multimodal route; cloud transfer, raw-content use, and publication require an exact, expiring approval fingerprint."
  - "Derived outputs inherit source privacy/provenance and require immutable source IDs and lineage edges; recovery always pauses work and requires fresh approval."
  - "Unsupported MIME/content, malformed structured data, path escapes, symlinks, forged IDs, stale capability metadata, and scope mismatches fail closed."
requirements-completed: [MULTI-01, MULTI-02, MULTI-03, PRIV-02, PRIV-03, PRIV-04, PRIV-05, OBS-01, COST-03, COST-04, TEST-01, SEC-01, SEC-02]
coverage:
  - id: D1
    description: "Host-side intake accepts bounded image, video, audio, document, and structured-data files and returns safe opaque previews."
    requirement: MULTI-01
    verification:
      - kind: unit
        ref: src/test/multimodalIntake.test.ts#validates image, video, audio, document, and structured data with detected content
        status: pass
      - kind: unit
        ref: src/test/multimodalIntake.test.ts#rejects traversal, absolute paths, symlink escapes, and missing files before staging
        status: pass
    human_judgment: false
  - id: D2
    description: "Privacy, local-only, consent, capability, and exact cloud approval gates prevent unsafe or silent provider transfer."
    requirement: PRIV-02
    verification:
      - kind: unit
        ref: src/test/multimodalOrchestration.test.ts#cloud transfer requires exact approval and cannot silently fall back or accept forged fingerprints
        status: pass
      - kind: unit
        ref: src/test/multimodalOrchestration.test.ts#unknown, stale, unsupported, and scope-expanded routes fail closed
        status: pass
    human_judgment: false
  - id: D3
    description: "Approved operations create bounded derived artifacts with immutable source relationships and inherited privacy/provenance."
    requirement: MULTI-03
    verification:
      - kind: unit
        ref: src/test/multimodalOrchestration.test.ts#approved local operation creates a derived artifact with immutable source lineage and no raw bytes
        status: pass
      - kind: unit
        ref: src/test/multimodalOrchestration.test.ts#raw handles are released only after explicit raw-content approval and remain absent from derived metadata
        status: pass
    human_judgment: false
  - id: D4
    description: "Activity and analytics expose only bounded operation metadata while cancellation, budgets, and restart recovery remain safe."
    requirement: OBS-01
    verification:
      - kind: unit
        ref: src/test/multimodalOrchestration.test.ts#cancellation, budget stop, restart pause, and recovery require safe terminal or fresh approval states
        status: pass
      - kind: unit
        ref: src/test/multimodalOrchestration.test.ts#activity and analytics contain bounded operation metadata and never raw media
        status: pass
    human_judgment: false
  - id: D5
    description: "Strict chat attachment/control parsing and UI wiring keep filesystem references and approval authority host-owned."
    requirement: SEC-01
    verification:
      - kind: unit
        ref: src/test/multimodalIntake.test.ts#strict chat attachment protocol rejects paths, forged metadata, and scope escalation
        status: pass
      - kind: other
        ref: npm run lint && npm test && npm run package
        status: pass
    human_judgment: true
    rationale: "Automated checks prove the protocol and generated markup compile; interactive VS Code keyboard/screen-reader review remains a human judgment."
duration: 18m
completed: 2026-10-26
status: complete
commits: 0
---

# Phase 6 Plan 3: Secure Multimodal Intake and Lineage Summary

**Secure local multimodal attachment intake with exact transfer approval, metadata-only observability, and restart-safe source-to-derived lineage.**

## Performance

- **Duration:** approximately 18 minutes
- **Started:** 2026-10-26T03:22:00Z
- **Completed:** 2026-10-26T03:40:31Z
- **Tasks:** 3 completed
- **Files modified:** 11 implementation/test files, plus this summary
- **Commits:** 0; Git commits were explicitly prohibited and the mounted `.git` directory is unusable.

## Accomplishments

- Added versioned multimodal contracts and host-only attachment staging with bounded MIME/extension profiles, size limits, magic/content validation, structured-data shape checks, SHA-256 identity, realpath containment, symlink rejection, consent, privacy state, and opaque managed references.
- Added strict webview attachment/control messages and a local attachment UI; raw paths and bytes never cross the webview boundary.
- Added route- and capability-aware orchestration with exact approval fingerprints, local-only enforcement, explicit raw-content authorization, budget/cancellation/emergency-safe lifecycle states, and restart pause/recovery requiring fresh approval.
- Added immutable derived-artifact lineage with inherited privacy/provenance, route snapshots, attribution, usage/cost fields, bounded persistence, and metadata-only activity/analytics serialization.
- Added negative coverage for traversal, symlinks, forged metadata and IDs, secret/media leakage, malformed/oversized inputs, unsupported content, local-only/cloud fallback, approval mismatch, provenance, cancellation, budget stop, restart recovery, and analytics redaction.

## Task Commits

No Git commits were created, per the explicit user request. The workspace `.git` directory is not a usable repository, so no hashes are fabricated.

1. **Task 1: Trace one local image attachment from strict chat input to a redacted staged artifact** — no commit.
2. **Task 2: Expand bounded intake and privacy contracts across all supported modalities** — no commit.
3. **Task 3: Orchestrate derived artifacts with immutable source lineage and bounded observability** — no commit.

## Decisions Made

- Kept raw bytes behind host-managed references and an explicit authorization seam; attachment records, previews, prompts, activity, analytics, and exports contain IDs and bounded metadata only.
- Reused `PrivacyPreflight`, `PolicyGate`, `ActivityStore`, and `AnalyticsStore` rather than introducing a second policy or observability plane.
- Treated current capability metadata, known MIME/content, valid provenance, exact approval fingerprints, and bounded source IDs as prerequisites; unknown or contradictory states are unavailable.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected stable rejection classification for missing and symlinked paths**
- **Found during:** Task 1 tracer verification
- **Issue:** Missing files were initially reported as workspace containment failures, and symlink escapes were classified only after realpath resolution.
- **Fix:** Check path-component symlinks before realpath containment and distinguish missing references from containment failures.
- **Files modified:** `src/services/multimodalIntake.ts`
- **Verification:** Intake negative tests pass for traversal, absolute paths, missing files, and symlink escapes.

**2. [Rule 2 - Missing Critical] Hardened activity and analytics serializers against raw media/data URI/base64 leakage**
- **Found during:** Task 3 observability review
- **Issue:** Existing generic summary sanitization did not explicitly remove raw media markers or long encoded payloads.
- **Fix:** Added media/data URI/base64 redaction before bounded activity and analytics serialization.
- **Files modified:** `src/services/activityStore.ts`, `src/services/analyticsStore.ts`
- **Verification:** Multimodal analytics test and full suite pass with raw-media assertions.

**3. [Rule 3 - Blocking] Added the host-owned attachment selection seam and visible local attachment controls**
- **Found during:** Task 1 chat boundary review
- **Issue:** The existing chat UI had no safe path for selecting a local file without accepting a webview-supplied filesystem path.
- **Fix:** Added a strict `attachment-select` message that invokes the host file picker, stages the selected file, and returns only a safe preview; removal uses opaque artifact IDs.
- **Files modified:** `src/services/chat.ts`, `src/services/chatBridge.ts`
- **Verification:** Strict protocol tests, lint, full tests, and packaging pass.

**Total deviations:** 3 auto-fixed (1 bug, 1 missing critical safeguard, 1 blocking integration seam).
**Impact on plan:** All deviations directly strengthen the requested trust boundaries; no runtime dependency, credential path, provider endpoint, or unrestricted filesystem capability was added.

## Issues Encountered

- The mounted workspace has no usable Git metadata. The explicit no-commit instruction was honored; task commits, commit ledgers, and metadata commits were not attempted.
- Interactive VS Code keyboard/screen-reader review remains a human judgment item for the attachment section and status announcements.

## Threat Surface Review

- **T-06-11 tampering:** realpath containment, component symlink rejection, content detection, immutable hashes, and managed-copy verification reject path/content mismatch.
- **T-06-12 information disclosure:** opaque IDs, bounded previews, raw-handle isolation, media/base64 serialization redaction, and strict chat DTOs prevent raw media from default observability and webview paths.
- **T-06-13 elevation of privilege:** current route capability, explicit operation allowlists, privacy preflight, exact approval fingerprints, and explicit raw-content authorization gate dispatch.
- **T-06-14 denial of service:** pre-read size bounds, modality limits, attachment/lineage caps, budget stops, cancellation, and safe restart pause bound work.
- **T-06-15 spoofing:** content hashes, source provenance, immutable source IDs, route/model/capability snapshots, and forged-ID rejection preserve source identity.
- **T-06-16 repudiation:** operation IDs, bounded activity/audit records, approval fingerprints, attribution, reason codes, and terminal lifecycle states preserve a redacted decision trail.
- No new network endpoint, wallet/credential file access, package dependency, unrestricted path, or graph-memory write was introduced.

## Verification

- `npm run lint` — passed.
- Focused intake and orchestration suites — passed: 12 tests, 0 failures.
- `npm test` — passed: 34 test files, 34 passed, 0 failed, 0 skipped/todo.
- `npm run package` — passed; `near-ai-vscode-0.1.0.vsix` produced.
- Stub/security scan completed; no intentional stubs, skipped tests, raw media payloads, or unrun plan verification steps remain.

## User Setup Required

None — no external service configuration or package installation is required.

## Next Phase Readiness

06-04 can consume `AttachmentRecord`, `MultimodalRoute`, `MultimodalOperationRecord`, `DerivedArtifact`, and `LineageEdge` for guarded image/video generation without changing the intake or privacy boundary. Generated operations must continue using current capability snapshots, exact approvals, and separate publication controls.

## Self-Check: PASSED

- Summary file exists at the required path.
- `status: complete`, requirements, coverage, and `commits: 0` are explicit.
- All plan-listed implementation/test surfaces exist; focused/full tests, lint, and packaging passed.
- No fabricated commit hashes or credential/wallet file changes are present.
- Raw media is confined to host-managed staging and explicitly authorized raw handles; default DTO, activity, analytics, and derived metadata paths contain no media bytes.

---
*Phase: 06-team-studio-and-multimodal-agent-skills*
*Plan: 03*
*Completed: 2026-10-26*
