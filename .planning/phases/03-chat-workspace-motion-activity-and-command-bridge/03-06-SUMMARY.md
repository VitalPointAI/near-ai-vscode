---
phase: 03-chat-workspace-motion-activity-and-command-bridge
plan: 06
subsystem: chat-progress
tags: [vscode, open-gsd, runtime-metadata, activity, redaction, testing]
requires:
  - phase: 03-chat-workspace-motion-activity-and-command-bridge
    provides: Open-GSD runner, normalized progress cards, structured prompt bridge, and bounded activity ledger
provides:
  - Allowlisted and bounded runtime lifecycle metadata parsing
  - Rich metadata propagation through progress cards and durable activity events
  - Shared command-panel activity store and serialized activity-write ordering
affects: [04-agents-routing-approvals-analytics]
actuals:
  tokens: 26055
  tasks: 2
  commits: 0
plan_head_before: unavailable
plan_head_after: unavailable
commits: 0
tech-stack:
  added: []
  patterns: [allowlisted runtime metadata parsing, normalized live/durable lifecycle projection, serialized activity writes]
key-files:
  created: []
  modified:
    - src/services/gsdRunner.ts
    - src/domain/chatProgress.ts
    - src/services/chatBridge.ts
    - src/services/chat.ts
    - src/domain/activity.ts
    - src/services/activityStore.ts
    - src/test/gsdRunner.test.ts
    - src/test/chatBridge.test.ts
    - src/test/activityStore.test.ts
key-decisions:
  - "Parse only an explicit runtime metadata allowlist with bounded scalar validation; unknown, malformed, and credential-shaped values are omitted without interrupting output streaming."
  - "Build the durable activity update from the same normalized progress card sent to the webview, and serialize appends so terminal history is not raced by later reads."
  - "Reuse the chat panel's ActivityStore for Open-GSD command sessions so history and reopen observe the active command immediately."
requirements-completed: [CHAT-02, OBS-01, TEST-01, SEC-01]
coverage:
  - id: D1
    description: "Runtime lifecycle metadata for phase, action/tool, model, agent/count, attempt/retry, and approval survives into normalized progress cards."
    requirement: CHAT-02
    verification:
      - kind: unit
        ref: src/test/gsdRunner.test.ts#rich runtime lifecycle metadata survives the child boundary and rejects unsafe fields
        status: pass
      - kind: unit
        ref: src/test/chatBridge.test.ts#progress cards preserve the same safe runtime metadata used by activity summaries
        status: pass
    human_judgment: false
  - id: D2
    description: "The same safe operational metadata is persisted in bounded activity events without raw prompts, secrets, or unrestricted runtime output."
    requirement: OBS-01
    verification:
      - kind: unit
        ref: src/test/activityStore.test.ts#activity store persists rich operational metadata without raw runtime output
        status: pass
      - kind: other
        ref: npm test
        status: pass
    human_judgment: false
  - id: D3
    description: "Invalid runtime metadata is ignored while the command stream remains healthy, with lint, full tests, and packaging passing."
    requirement: SEC-01
    verification:
      - kind: unit
        ref: src/test/gsdRunner.test.ts#rich runtime lifecycle metadata survives the child boundary and rejects unsafe fields
        status: pass
      - kind: other
        ref: npm run package
        status: pass
    human_judgment: false
duration: approximately 35m
completed: 2026-10-25
status: complete
---

# Phase 3 Plan 6: Runtime Metadata Preservation Summary

**Rich Open-GSD lifecycle metadata now survives the runner boundary into identical redacted live progress cards and durable activity events.**

## Performance

- **Tasks:** 2 completed
- **Files modified:** 9 implementation/test files
- **Commits:** 0; Git is unavailable in this mounted workspace.

## Accomplishments

- Added explicit allowlisting and bounded validation for runtime phase, action/tool, model, agent identity/count, attempt, retry, and approval metadata.
- Preserved safe metadata on prompt, output, waiting, retry, completion, and failure event paths while ignoring unknown, malformed, and credential-shaped values.
- Mapped one normalized card into both the webview and ActivityStore, including tool/action, model, agent/count, attempt/retry, approval, phase, and terminal state.
- Reused the chat panel's ActivityStore for command sessions and serialized activity appends to prevent stale history and terminal-state races.
- Added focused runner, bridge, and activity redaction/regression coverage.

## Task Commits

Git commits were unavailable. The workspace contains an empty read-only `.git` directory, and Git reports that it is not a repository. No commit hashes are fabricated.

1. **Task 1: Carry one rich runtime lifecycle event end to end** — no commit (repository unavailable)
2. **Task 2: Persist the normalized metadata with the live card** — no commit (repository unavailable)

## Files Modified

- `src/services/gsdRunner.ts` — allowlisted runtime JSON metadata parsing and safe lifecycle propagation.
- `src/domain/chatProgress.ts` — normalized action/retry card fields.
- `src/services/chatBridge.ts` — enriched command progress and activity summaries.
- `src/services/chat.ts` — shared activity store, ordered writes, and visible metadata rendering.
- `src/domain/activity.ts` / `src/services/activityStore.ts` — durable tool/action, agent-count, attempt, and retry fields with redaction.
- `src/test/gsdRunner.test.ts`, `src/test/chatBridge.test.ts`, `src/test/activityStore.test.ts` — metadata and privacy regressions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Information disclosure] Removed runtime-output wording from durable redaction markers**
- **Found during:** Task 2 verification
- **Issue:** Activity summaries replaced private prompts but could retain the phrase `raw command output` beside a redaction marker, weakening the serialized-record privacy contract.
- **Fix:** Treat raw-command-output descriptions as redacted context before bounded persistence.
- **Files modified:** `src/services/activityStore.ts`
- **Verification:** Activity metadata regression and full test suite pass.
- **Committed in:** No commit; repository unavailable.

**2. [Rule 2 - Information disclosure] Rejected absolute paths in runtime metadata labels**
- **Found during:** Final threat-surface review
- **Issue:** Runtime metadata labels were secret-filtered but could otherwise carry absolute host paths.
- **Fix:** Apply bounded path rejection to model, tool, action, phase, and agent scalar metadata before it reaches cards or activity.
- **Files modified:** `src/services/gsdRunner.ts`
- **Verification:** Final lint, full test suite, and package verification pass.
- **Committed in:** No commit; repository unavailable.

**Total deviations:** 2 auto-fixed Rule 2 issues. No package installation, architectural change, 03-07/03-08 execution, or Phase 4 work was introduced.

## Verification

- `npm run lint` — passed.
- Focused metadata command — passed; all 13 test files completed successfully under the project test command.
- `npm test` — passed: 13 test files, 13 passed, 0 failed, 0 skipped/todo.
- `npm run package` — passed; `near-ai-vscode-0.1.0.vsix` found.
- No live VS Code extension-host or configured Open-GSD smoke test was available; that remains human verification from the phase verification report.

## Issues Encountered

- Git commits, commit ledger, ancestry checks, and measured commit ranges were unavailable because `.git` is an empty read-only directory. This is recorded as `commits: 0`; repository metadata was not initialized or changed.

## User Setup Required

None.

## Next Phase Readiness

03-06 is complete on disk. Production runtime events now have a strict metadata path through runner, bridge, cards, and activity history. Plans 03-07 and 03-08 remain untouched, and Phase 4 was not started.

---
*Phase: 03-chat-workspace-motion-activity-and-command-bridge*
*Plan: 06*
*Completed: 2026-10-25*

## Self-Check: PASSED

- Summary file exists at the required path.
- `status: complete` is present.
- All plan-listed implementation/test surfaces compile and pass lint.
- Full tests and packaging pass.
- Git commit claims are intentionally absent because the workspace has no usable Git repository.
