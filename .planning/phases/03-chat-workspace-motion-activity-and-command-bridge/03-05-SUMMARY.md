---
phase: 03-chat-workspace-motion-activity-and-command-bridge
plan: 05
subsystem: chat-progress
tags: [vscode, chat, prompts, accessibility, progress, redaction, testing]
requires:
  - phase: 03-chat-workspace-motion-activity-and-command-bridge
    provides: Open-GSD runner, typed chat bridge, activity ledger, motion semantics
provides:
  - Typed structured prompt protocol with choice, free-form, cancel, and resume handling
  - Accessible normalized lifecycle progress cards with recovery actions and reduced-motion safety
  - Redacted runtime prompt/progress round trip through the active Open-GSD session
affects: [04-agents-routing-approvals-analytics]
actuals:
  tokens: 14348
  tasks: 2
  commits: 0
tech-stack:
  added: []
  patterns: [normalized lifecycle presentation, strict session-bound prompt protocol, redacted stdin/stdout runtime bridge]
key-files:
  created: [src/domain/chatProgress.ts, src/test/chatProgress.test.ts]
  modified: [src/services/chatBridge.ts, src/services/chat.ts, src/services/gsdRunner.ts, src/test/chat.test.ts, src/test/gsdRunner.test.ts]
key-decisions:
  - "Normalize prompt and lifecycle data before either webview rendering or activity persistence so live UI and durable history share the same safe operational shape."
  - "Bind runtime prompts to the ActivityStore session created for the active command and reject stale, cross-session, unknown-choice, credential-shaped, and extra-field responses."
  - "Use line-delimited JSON over the existing Open-GSD child stdin/stdout boundary; no shell interpolation, raw command output, private prompts, or hidden reasoning is exposed."
requirements-completed: [CHAT-02, CHAT-03, CHAT-04, OBS-01, TEST-01, SEC-01]
coverage:
  - id: D1
    description: "Structured Open-GSD prompts render choices/free-form input and preserve session context through answer, cancel, and resume."
    requirement: CHAT-03
    verification:
      - kind: unit
        ref: src/test/chatProgress.test.ts#structured prompt accepts ordered choices and free-form answers
        status: pass
      - kind: unit
        ref: src/test/gsdRunner.test.ts#structured runtime prompts are surfaced and validated responses reach active stdin
        status: pass
    human_judgment: true
    rationale: "Packaged webview interaction and a live Open-GSD prompt require an extension-host smoke test."
  - id: D2
    description: "Chat renders ordered accessible lifecycle cards for waiting, approval, retry, completion, cancellation, and failure with recovery text."
    requirement: CHAT-02
    verification:
      - kind: unit
        ref: src/test/chatProgress.test.ts#progress cards normalize lifecycle states, redact output, and expose recovery
        status: pass
      - kind: other
        ref: npm run package
        status: pass
    human_judgment: true
    rationale: "Visual readability and reduced-motion behavior require packaged webview inspection."
  - id: D3
    description: "The same normalized card summaries feed live command progress and non-sensitive activity events."
    requirement: OBS-01
    verification:
      - kind: unit
        ref: src/test/chatBridge.test.ts#structured prompt bridge validates IDs and progress cards stay operational and redacted
        status: pass
      - kind: other
        ref: npm test
        status: pass
    human_judgment: false

duration: approximately 45m
completed: 2026-10-25
status: complete
plan_head_before: unavailable
plan_head_after: unavailable
commits: 0
---

# Phase 3 Plan 5: Structured Prompts and Accessible Progress Cards Summary

**Typed, session-preserving Open-GSD prompts and redacted accessible lifecycle cards now share one normalized activity/progress boundary.**

## Performance

- **Duration:** approximately 45 minutes
- **Completed:** 2026-10-25
- **Tasks:** 2 completed
- **Files modified:** 7 planned files plus the runner boundary and this summary

## Accomplishments

- Added strict prompt contracts and validation for ordered choices, bounded free-form answers, cancellation, resumption, stale IDs, unknown choices, extra fields, and credential-shaped payloads.
- Added real line-delimited runtime prompt detection and validated response delivery through the active Open-GSD child process while preserving the ActivityStore session.
- Added normalized progress cards for tool/action, project phase, model, agent count, waiting/approval, retries, completion, cancellation, failure, recovery, accessibility live regions, and reduced-motion-safe rendering.
- Persisted the same redacted operational card summaries used by the live webview into activity events.

## Task Commits

Git commits were unavailable. The workspace contains no discoverable Git repository across its filesystem mount boundary; no commit hashes are fabricated.

1. **Task 1: Complete one structured prompt round trip** — no commit (repository unavailable)
2. **Task 2: Render complete lifecycle progress cards and recovery states** — no commit (repository unavailable)

## Files Created/Modified

- `src/domain/chatProgress.ts` — typed prompt, progress-card, normalization, redaction, and validation contracts.
- `src/services/chatBridge.ts` — strict webview prompt parsing, card mapping, and safe activity summaries.
- `src/services/chat.ts` — session-bound prompt routing, active-run response delivery, accessible prompt/card webview rendering, and activity updates.
- `src/services/gsdRunner.ts` — structured prompt event detection and validated response writes over child stdin.
- `src/test/chatProgress.test.ts` — prompt, lifecycle, redaction, recovery, and reduced-motion-safe contract tests.
- `src/test/chatBridge.test.ts` — protocol, ID, extra-field, and safe card tests.
- `src/test/chat.test.ts` — chat prompt-control protocol tests.
- `src/test/gsdRunner.test.ts` — runtime prompt round-trip test.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Connected validated prompt responses to the active Open-GSD process**
- **Found during:** Task 1
- **Issue:** The existing runner exposed output events but no stdin seam, so a prompt could be displayed and validated without actually resuming the runtime.
- **Fix:** Added optional child stdin, line-delimited structured prompt detection, and a `respond` method that accepts only the typed prompt response union. Runtime prompts are rebound to the ActivityStore session created for the command.
- **Files modified:** `src/services/gsdRunner.ts`, `src/services/chat.ts`, `src/test/gsdRunner.test.ts`
- **Verification:** Full lint, 13-suite test run, and VSIX packaging passed.
- **Committed in:** Not committed; repository unavailable.

**Total deviations:** 1 Rule 2 auto-fix.
**Impact on plan:** Required to make the planned prompt round trip real; no new package, service, schema, or Phase 4 work was introduced.

## Issues Encountered

- Git status, per-task commits, commit ledger, and ancestry checks were unavailable because Git reports this mounted workspace is not a repository. This is recorded as `commits: 0`; no commit claims are made.
- No live VS Code extension-host smoke test or live Open-GSD process was available. Packaged webview interaction remains human verification.

## Known Stubs

None introduced by this plan. Existing HTML `placeholder` attributes remain intentional input guidance.

## Verification

- `npm run lint` — passed.
- `npm test` — passed: 13 test files/suites, 13 passed, 0 failed, 0 skipped/todo.
- `npm run package` — passed; `near-ai-vscode-0.1.0.vsix` produced.
- Focused prompt/progress tests — passed.
- Human follow-up: exercise choice, free-form, cancel/resume, waiting/approval, retry, completion, and failure in the packaged VS Code webview with reduced motion enabled.

## Next Phase Readiness

Plan 03-05 is complete on disk. Phase 4 was not started. The remaining verification is interactive extension-host validation of the packaged prompt and progress-card experience.

---
*Phase: 03-chat-workspace-motion-activity-and-command-bridge*
*Plan: 05*
*Completed: 2026-10-25*

## Self-Check: PASSED

- Summary exists at the required path.
- All planned prompt/progress implementation and test files exist.
- `npm run lint`, `npm test`, focused prompt/progress tests, and `npm run package` passed.
- Git ancestry/commit checks were not possible because the workspace is not a discoverable Git repository; this is documented as `commits: 0`.
