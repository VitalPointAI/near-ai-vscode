---
phase: 03-chat-workspace-motion-activity-and-command-bridge
plan: 04
subsystem: activity-history
tags: [vscode, chat, activity, persistence, privacy, redaction, testing]
requires:
  - phase: 03-chat-workspace-motion-activity-and-command-bridge
    provides: Typed chat webview, provider lifecycle events, Open-GSD command runner, planning metadata
provides:
  - Versioned bounded local activity/session ledger with atomic replacement writes
  - Chat and Open-GSD lifecycle recording with privacy-safe summaries and terminal outcomes
  - Session history listing, reopen, and non-replaying continuation controls
affects: [03-05, 04-agents-routing-approvals-analytics]
tech-stack:
  added: []
  patterns: [versioned JSON ledger, temp-file-plus-rename persistence, operational-only serialization, injectable clock/filesystem seams]
key-files:
  created: [src/services/activityStore.ts, src/test/activityStore.test.ts]
  modified: [src/domain/activity.ts, src/services/chat.ts, src/services/chatBridge.ts, src/test/chatBridge.test.ts]
key-decisions:
  - "Store operational session metadata and bounded lifecycle summaries under .planning/.near-ai/activity.json; never persist raw chat prompts or credentials by default."
  - "Reopen restores a non-executable session context and continuation prefill; it never replays a stored command or claims a completed process is still running."
  - "Git commits were unavailable because this workspace mount is not discoverable as a Git repository; no commit hashes are fabricated."
requirements-completed: [CHAT-04, OBS-01, CHAT-01, TEST-01, SEC-01]
estimate:
  tokens: 19000
actuals:
  tokens: 14472
  tasks: 2
  commits: 0
plan_head_before: unavailable
plan_head_after: unavailable
commits: 0
status: complete
duration: approximately 1h 20m
completed: 2026-10-25
---

# Phase 3 Plan 4: Durable Activity and Reopenable Session History

Versioned, bounded, privacy-safe activity persistence now connects provider/chat and Open-GSD lifecycle events to a local session history surface with safe reopen and continuation.

## Accomplishments

- Extended the activity domain with versioned session summaries, terminal outcomes including setup-blocked, agent counts, approval totals, cost fields, and privacy-safe context counters.
- Added `ActivityStore` at `.planning/.near-ai/activity.json` with stable validated session IDs, bounded sessions/events, injectable clock/filesystem seams, corrupt-store recovery, serialized operational summaries, and atomic temp-file replacement writes.
- Wired chat starts, user/assistant lifecycle events, cancellation, provider failure, and missing-key setup blocking into the store.
- Wired Open-GSD runner progress and terminal events into durable tool activity records and refreshes.
- Added history listing, selection, reopen, and continuation messages to the webview. Reopen displays project/outcome context and a safe continuation prompt without replaying commands or restoring prompts/secrets.
- Added tests for persistence, fresh-instance reopen, all terminal outcomes, bounded history, corrupt data, agent/cost summaries, protocol validation, and redaction/no-raw-prompt serialization.

## Verification

- `npm run lint` — passed.
- `npm test` — passed: 12 test files, 12 suites passed, 0 failed/skipped/todo.
- `npm run package` — passed and produced `near-ai-vscode-0.1.0.vsix`.
- Git status/commit verification unavailable: Git reports `fatal: not a git repository` at the mounted workspace boundary. No commits were created or claimed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Privacy bug] Prevented arbitrary lifecycle text from being persisted as message content**
- **Found during:** Task 1 focused tests
- **Issue:** A test lifecycle message containing private prompt text remained in the durable event summary after secret redaction.
- **Fix:** Message events now serialize only canonical operational labels; command-like and prompt-like fragments in other summaries are redacted/truncated.
- **Files modified:** `src/services/activityStore.ts`

### Execution Constraints

**2. [Execution constraint] Git commits unavailable**
- **Found during:** execution initialization
- **Issue:** `.git` is present as a directory, but Git cannot discover the repository across the filesystem mount boundary.
- **Impact:** Per-task and final metadata commits could not be made.
- **Resolution:** All changes and this summary remain on disk; commit counts are recorded as zero and no hashes are invented.

## Known Stubs

None introduced by this plan. Native HTML `placeholder` attributes in the existing chat UI remain intentional input guidance and are not activity-history stubs.

## Threat Surface Review

- Activity writes are workspace-scoped beneath `.planning/.near-ai` and use bounded records plus atomic replacement.
- Webview history serialization excludes raw event payloads and accepts only validated stable session IDs.
- Reopen is read-only with respect to stored commands: it restores display context and a continuation prefill, never executable argv or a replay request.

## Self-Check: PASSED

- `src/services/activityStore.ts` exists.
- `src/test/activityStore.test.ts` exists.
- `src/domain/activity.ts`, `src/services/chat.ts`, `src/services/chatBridge.ts`, and updated tests compile and are covered by the passing full suite.
- No commit ancestry checks were possible because Git repository discovery is unavailable in this workspace mount; this is documented above.
