---
phase: 06-team-studio-and-multimodal-agent-skills
plan: 09
subsystem: memory, security, ui, testing
tags: [context-graphs, exact-approval, fingerprints, expiry, replay-protection, accessibility, redaction]

# Dependency graph
requires:
  - phase: 06-team-studio-and-multimodal-agent-skills
    provides: bounded scoped context graphs, provenance-aware memory operations, strict chat protocol, and local-only policy from Plan 06-05
  - phase: 06-team-studio-and-multimodal-agent-skills
    provides: host-owned chat/webview lifecycle and accessible protocol patterns from Plans 06-07 and 06-08
provides:
  - host-created exact memory approval descriptors, redacted previews, fingerprints, TTL expiry, bounded registry, and one-shot consumption
  - exact approval enforcement for correct, merge, retract, reset, and export with optimistic graph-version checks
  - strict memory preview/confirmation handlers, redacted bounded audit metadata, and forged/scope/version/replay/raw-content regressions
  - accessible interactive graph presentation with keyboard-selectable nodes, metadata table, and outline/tension fallback
affects: [MEM-04, MEM-05, MEM-06, context graph memory, chat webview, privacy and security verification]

# Actuals (#2632)
actuals:
  tokens: 67738
  tasks: 2
  commits: 0
plan_head_before: unavailable-git-metadata
plan_head_after: unavailable-git-metadata
commits: 0

# Tech tracking
tech-stack:
  added: []
  patterns:
    - canonical host-only approval descriptors hashed with a per-preview nonce
    - bounded pending/consumed approval registry with expiry, replay rejection, and redacted audit events
    - internal host authorization objects required by graph mutation/export services
    - metadata-only approval DTOs and strict discriminated preview/confirmation parsing
    - keyboard-selectable SVG graph nodes paired with table and outline fallback

key-files:
  created:
    - src/services/memoryApproval.ts
    - src/test/memoryApproval.test.ts
    - .planning/phases/06-team-studio-and-multimodal-agent-skills/06-09-SUMMARY.md
  modified:
    - src/domain/contextGraph.ts
    - src/services/contextGraphMemory.ts
    - src/services/chatBridge.ts
    - src/services/chat.ts
    - src/test/contextGraph.test.ts
    - src/test/contextGraphProtocol.test.ts

key-decisions:
  - "Memory previews are created and retained by the host; confirmation carries only the host-issued fingerprint and explicit intent, so the webview cannot replace the approved descriptor."
  - "All five protected memory operations are local-only and require a matching operation, scope, graph version, IDs, mutation digest, session, and project identity; stale graph checks remain after authorization."
  - "Approval previews expose only bounded IDs, lengths/digests, opaque identities, expiry, and policy facts; audit records never include fingerprints or raw mutation content."
  - "The graph UI uses an interactive, keyboard-addressable SVG presentation while retaining a semantic table and outline with provenance, confidence, freshness, tension, and conflict labels."

requirements-completed: [MEM-06]

coverage:
  - id: D1
    description: "Host-created exact approvals authorize one matching correction, merge, retraction, reset, or export and reject forged, mismatched, expired, stale, and replayed authority."
    requirement: MEM-06
    verification:
      - kind: unit
        ref: src/test/memoryApproval.test.ts#host-created exact correction approval authorizes one matching mutation
        status: pass
      - kind: unit
        ref: src/test/memoryApproval.test.ts#shape-valid fingerprints and descriptor mismatches fail before a memory mutation
        status: pass
      - kind: unit
        ref: src/test/memoryApproval.test.ts#expired approvals, stale versions, operation reuse, and export bypasses fail closed
        status: pass
    human_judgment: false
  - id: D2
    description: "Strict memory protocol previews and confirmations reject extra fields, raw content, provider claims, duplicate IDs, and malformed fingerprints."
    verification:
      - kind: unit
        ref: src/test/contextGraphProtocol.test.ts#memory approval preview and one-shot confirmation messages are strict and bounded
        status: pass
      - kind: unit
        ref: src/test/contextGraphProtocol.test.ts#memory mutation messages require opaque IDs, expected versions, and explicit approval
        status: pass
    human_judgment: false
  - id: D3
    description: "Memory inspection provides an interactive graph plus accessible table/outline fallback with provenance, confidence, freshness, tension, conflict, and local-only action state."
    verification:
      - kind: automated_ui
        ref: src/test/contextGraphProtocol.test.ts#memory explorer exposes interactive graph, table, outline fallback, and safe labels
        status: pass
      - kind: unit
        ref: src/test/contextGraph.test.ts#freshness and decay remain visible rather than deleting old evidence
        status: pass
    human_judgment: true
    rationale: "Automated source/protocol checks prove labels, keyboard handlers, and fallback markup; actual VS Code webview keyboard, screen-reader, and visual graph usability still merits human review."

# Metrics
duration: approximately 1h 10m
completed: 2026-10-26
status: complete
---

# Phase 06 Plan 09: Exact host-created memory approvals and accessible graph inspection Summary

**Every scoped memory mutation and export now uses a one-shot host-created exact approval, with redacted previews, replay protection, strict version checks, and an accessible graph/table explorer.**

## Performance

- **Duration:** approximately 1h 10m
- **Started:** 2026-10-26T03:56:00Z (approximate)
- **Completed:** 2026-10-26T05:06:07Z
- **Tasks:** 2
- **Files modified:** 8 implementation/test files, plus this summary
- **Commits:** 0; Git commits were explicitly prohibited by the user and the mounted `.git` metadata is unusable.

## Accomplishments

- Added `MemoryApprovalRegistry` with canonical descriptor hashing, host-only pending previews, bounded TTL, one-shot consumption, expiry/replay/mismatch outcomes, and metadata-only audit records.
- Required internal host authorization for correction, merge, retraction, reset, and export; exact scope, graph version, IDs, summaries/source sets, local boundary, and host session/project identity are enforced before graph mutation, with stale-version checks preserved afterward.
- Added strict memory preview/approval protocol messages and redacted error/preview handling; direct legacy-shaped mutation messages can only execute when they match an existing host preview exactly.
- Added focused negative tests for forged fingerprints, operation/scope/version/node/summary/source/boundary/session/project mismatches, expiry, replay, export bypass, raw content, duplicate IDs, and extra protocol fields.
- Added an interactive keyboard-addressable graph view and semantic table/outline fallback exposing provenance, confidence, freshness/decay, tension polarity/weight, conflict, and local-only status.

## Task Commits

No Git commits were created, per the explicit user instruction. The mounted `.git` directory is not a usable repository, so no commit hashes are recorded.

## Files Created/Modified

- `src/services/memoryApproval.ts` - Host-only exact descriptor registry, fingerprints, expiry, one-shot authorization, and bounded audit metadata.
- `src/domain/contextGraph.ts` - Approval descriptor, preview, operation, provider-boundary, and audit DTO contracts.
- `src/services/contextGraphMemory.ts` - Authorization-gated mutation/export methods and approval outcomes in audit records.
- `src/services/chatBridge.ts` - Strict memory preview/confirmation protocol and safe preview message DTO.
- `src/services/chat.ts` - Host-derived session/project previews, exact consumption handlers, and accessible graph/table/action UI.
- `src/test/memoryApproval.test.ts` - Exact approval, mismatch, expiry, replay, operation, audit, and export bypass regressions.
- `src/test/contextGraphProtocol.test.ts` - Strict parser, redaction, graph UI, and accessibility-contract regressions.
- `src/test/contextGraph.test.ts` - Existing direct mutation coverage migrated to registry-issued authorizations.

## Decisions Made

- The webview is allowed to request a bounded operation, but only the host registry can create the approval fingerprint and retain the authoritative descriptor.
- Approval confirmation resolves the stored descriptor by fingerprint; the webview cannot submit a replacement operation after the preview is shown.
- Approval DTOs use summary length/digest rather than raw correction text, and audit records omit fingerprints, summaries, credentials, paths, and provider claims.
- Graph presentation is dependency-free and host-controlled: SVG interaction is paired with a semantic table and outline fallback instead of introducing a graph backend or UI dependency.

## Deviations from Plan

### User-directed execution constraint

Git commits were intentionally omitted despite the standard GSD task-commit and metadata-commit protocol because the user explicitly requested “no Git commits.” The workspace also has unusable Git metadata. All implementation, tests, summary, and state changes remain on disk for review.

### Auto-fixed Issues

**1. [Rule 1 - Bug] Preserved explicit expiry outcomes during registry consumption**
- **Found during:** Task 1 focused test execution
- **Issue:** Purging expired pending entries before lookup converted an expired approval into an ambiguous unknown-fingerprint error.
- **Fix:** Consumption purges consumed records separately and reports the pending entry as expired before removal.
- **Files modified:** `src/services/memoryApproval.ts`
- **Verification:** `src/test/memoryApproval.test.ts#expired approvals, stale versions, operation reuse, and export bypasses fail closed`

**2. [Rule 2 - Missing Critical] Added approval-consumed outcomes to graph mutation audit records**
- **Found during:** Task 2 security review
- **Issue:** Export recorded approval consumption, but correction, merge, retract, and reset audit records did not identify their authorization outcome.
- **Fix:** Added bounded `approvalOutcome: consumed` metadata to all five protected operation audit records.
- **Files modified:** `src/services/contextGraphMemory.ts`, `src/domain/contextGraph.ts`
- **Verification:** Full test suite and audit redaction assertions pass.

**3. [Rule 1 - Bug] Tightened direct mutation parser operation allowlists**
- **Found during:** Task 2 protocol review
- **Issue:** Legacy direct export/reset messages could carry an unused node ID, and duplicate merge IDs were silently deduplicated.
- **Fix:** Added per-operation key allowlists and duplicate-source rejection.
- **Files modified:** `src/services/chatBridge.ts`, `src/test/contextGraphProtocol.test.ts`
- **Verification:** Strict protocol negative tests pass.

**Total deviations:** 3 auto-fixed issues, plus the explicit no-commit execution constraint.
**Impact on plan:** All fixes strengthen the requested host boundary; no dependency or architectural scope expansion was introduced.

## Issues Encountered

- Existing graph unit tests used the old boolean/optional authorization API. They were migrated to create and consume typed host approvals; no boolean approval bypass was retained.
- The repository’s mounted `.git` metadata is unusable. This was documented rather than repaired because commits were explicitly forbidden.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

MEM-06 is implemented and ready for phase re-verification. Plan 06-10 remains the next incomplete phase plan. A human VS Code webview pass should still inspect graph readability, keyboard focus order, screen-reader announcements, and export-download presentation.

## Verification

- `npm run lint` - passed.
- Focused context graph, protocol, and approval suites - passed (8/8, 5/5, and 4/4 tests).
- `npm test` - passed (40/40 tests).
- `npm run package` - passed; VSIX packaged successfully.
- GSD requirement marking was attempted for `MEM-06`; the project requirement registry has no matching entry, so no checkbox was changed.

## Self-Check: PASSED

- Summary file exists at the required phase path.
- All implementation and test files listed above exist.
- No commit claims were made; commit count is explicitly recorded as zero.

---
*Phase: 06-team-studio-and-multimodal-agent-skills*
*Completed: 2026-10-26*
