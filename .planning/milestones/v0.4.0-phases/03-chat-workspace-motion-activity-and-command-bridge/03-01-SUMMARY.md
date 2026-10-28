---
phase: 03-chat-workspace-motion-activity-and-command-bridge
plan: 01
subsystem: ui
tags: [vscode, webview, chat, streaming, near-ai, cancellation, redaction]
requires:
  - phase: 02-near-ai-client-models-and-costs
    provides: Typed NEAR AI model catalog, lifecycle streaming events, cancellation, retry, and redacted provider errors
provides:
  - Conversation-aware VS Code webview chat workspace with model selection and streamed rendering
  - Typed extension-host/webview message boundary with credential-shaped payload rejection
  - Actionable setup routing, cancellation state recovery, and redacted provider error presentation
  - Unit coverage for chat routing, model options, conversation history, and error safety
affects: [03-02-activity-and-command-bridge, 04-agents-routing-approvals-analytics]
actuals:
  tokens: 2400
  tasks: 1
  commits: 0
plan_head_before: unavailable
plan_head_after: unavailable
commits: 0
tech-stack:
  added: []
  patterns: [typed webview message parsing, lifecycle-event-driven streaming UI, bounded in-memory conversation history]
key-files:
  created: [src/services/chatBridge.ts, src/test/chatBridge.test.ts]
  modified: [src/services/chat.ts]
key-decisions:
  - "Keep API keys and provider clients in the extension host; the webview receives only typed display messages and model options."
  - "Use streamChatEvents lifecycle events so cancellation returns the composer to a usable state without inventing a completion."
  - "Append assistant turns only after a completed stream, preventing partial or cancelled output from contaminating the next provider request."
requirements-completed: [CHAT-01, CHAT-02, MODEL-01, PRIV-01]
coverage:
  - id: D1
    description: "Typed webview message routing rejects malformed and credential-shaped payloads."
    requirement: PRIV-01
    verification:
      - kind: unit
        ref: src/test/chatBridge.test.ts#webview message parsing accepts only the typed chat protocol
        status: pass
    human_judgment: false
  - id: D2
    description: "Model catalog options and completed conversation history are normalized for chat requests."
    requirement: MODEL-01
    verification:
      - kind: unit
        ref: src/test/chatBridge.test.ts#model options preserve catalog IDs and keep pricing display separate
        status: pass
      - kind: unit
        ref: src/test/chatBridge.test.ts#conversation history appends completed assistant turns only
        status: pass
    human_judgment: false
  - id: D3
    description: "Chat host wiring streams ordered provider text, supports cancellation recovery, and routes missing credentials to Setup."
    requirement: CHAT-01
    verification:
      - kind: other
        ref: npm test; npm run package
        status: pass
    human_judgment: true
    rationale: "Automated tests cover the bridge and provider boundary, but this workspace has no VS Code extension-host smoke harness or live provider credential for interactive webview verification."
  - id: D4
    description: "Provider failures remain actionable and credential-safe when presented to the chat UI."
    requirement: CHAT-02
    verification:
      - kind: unit
        ref: src/test/chatBridge.test.ts#provider errors are actionable and never expose credential material
        status: pass
    human_judgment: false
metrics:
  duration: 35m
  completed: 2026-10-25
  status: complete
---

# Phase 3 Plan 1: Chat Workspace and Provider Streaming Summary

**Conversation-aware Near AI VS Code chat with model selection, lifecycle-based streaming, safe host/webview routing, setup guidance, and cancellation recovery.**

## Performance

- **Duration:** approximately 35 minutes.
- **Started:** 2026-10-25T21:25:00Z.
- **Completed:** 2026-10-25.
- **Tasks:** 1 plan task completed.
- **Files modified:** 3 implementation/test files, plus this summary.

## Accomplishments

- Added a typed chat bridge that validates webview messages, rejects unknown credential-shaped fields, formats model catalog options, and maintains only completed conversation turns.
- Updated the chat host to send the full conversation to the typed NEAR AI lifecycle stream, render ordered text events, route missing credentials to the visual Setup action, and recover the composer after cancellation.
- Added actionable provider error messages with request IDs where available while preserving redaction and keeping credentials in SecretStorage/extension-host code only.
- Added focused unit coverage; strict lint, the full test suite, and VSIX packaging all pass.

## Task Commits

The task could not be committed because this workspace contains an empty read-only `.git` directory. Git reports “not a repository,” so no commit hash is available and none is fabricated.

1. **Task 1: Implement chat workspace, provider streaming bridge, errors, cancellation, and tests** — no commit (repository unavailable)

**Plan metadata:** no metadata commit (repository unavailable)

## Files Created/Modified

- `src/services/chat.ts` - Conversation-aware host/webview chat, lifecycle streaming, setup routing, cancellation state, model loading, and error presentation.
- `src/services/chatBridge.ts` - Typed webview protocol parsing, model option formatting, conversation helpers, and actionable redacted provider errors.
- `src/test/chatBridge.test.ts` - Host-boundary, model catalog, conversation, and error safety tests.

## Decisions Made

- Kept provider authentication and all `NearAiClient` calls in the extension host; the webview receives no API key or raw provider response.
- Used `streamChatEvents` instead of reconstructing lifecycle state from delta-only events so cancellation is explicit and completion is not fabricated.
- Kept conversation history in memory for the panel lifetime and committed assistant text only on a completed stream.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Tightened webview protocol validation**
- **Found during:** Task 1 verification.
- **Issue:** The initial parser ignored unknown fields, allowing a credential-shaped `apiKey` field to cross the host boundary even though it was unused.
- **Fix:** Reject unknown fields for every supported message shape and added a negative unit assertion.
- **Files modified:** `src/services/chatBridge.ts`, `src/test/chatBridge.test.ts`.
- **Verification:** Full unit suite passes; credential-shaped payload test passes.
- **Committed in:** Not committed; repository unavailable.

**2. [Rule 1 - Bug] Made overlapping cancellation race-safe**
- **Found during:** Task 1 implementation review.
- **Issue:** An older request's `finally` block could clear the controller for a newer request, and stale stream events could update the current UI.
- **Fix:** Track the request-local controller, ignore events from inactive requests, and clear state only when the controller is still current.
- **Files modified:** `src/services/chat.ts`.
- **Verification:** TypeScript compilation, full unit suite, and packaging pass.
- **Committed in:** Not committed; repository unavailable.

### Workspace Constraints

- Git commits were unavailable because `.git` is an empty read-only directory. Per-task commits, metadata commit, commit hashes, and commit measurement are recorded as unavailable rather than fabricated.
- `rg` is not installed; targeted scans used `grep`/`find`.

**Total deviations:** 2 auto-fixed (1 Rule 1, 1 Rule 2); no scope expansion.
**Impact on plan:** Both fixes directly protect the planned host boundary and streaming correctness.

## Issues Encountered

- No VS Code extension-host smoke harness or live NEAR AI credential is available, so interactive webview behavior remains a human verification item despite passing automated provider and bridge checks.
- The GSD requirements helper could not match `CHAT-01`, `CHAT-02`, `MODEL-01`, or `PRIV-01` because this repository records requirements as prose bullets rather than checkbox/table entries; the IDs are retained in this summary and no requirements file was changed.

## Known Stubs

- `src/services/chat.ts:133` — the composer uses the intentional input hint `Describe your project or ask what to do next…`; this is native form guidance, not a missing implementation or data source.

## User Setup Required

None - no external service configuration was added. A valid NEAR AI API key is required for live chat smoke testing and is entered through the existing Setup flow.

## Next Phase Readiness

Plan 03-01 is complete and provides the streaming chat surface for Plan 03-02. Plan 03-02 and Phase 4 were not started. Human verification remains for an interactive VS Code webview smoke test with configured credentials.

---
*Phase: 03-chat-workspace-motion-activity-and-command-bridge*
*Completed: 2026-10-25*

## Self-Check: PASSED

- Summary file exists at the required path.
- `status: complete` is present.
- Requirements and coverage are recorded for CHAT-01, CHAT-02, MODEL-01, and PRIV-01.
- Verification commands passed: `npm run lint`, `npm test`, and `npm run package`.
- No commit claims were made because the repository is unavailable.
