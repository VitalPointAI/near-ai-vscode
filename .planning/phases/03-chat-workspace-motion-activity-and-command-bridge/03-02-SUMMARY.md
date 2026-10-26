---
phase: 03-chat-workspace-motion-activity-and-command-bridge
plan: 02
subsystem: ui
tags: [vscode, webview, gsd, motion, accessibility, command-discovery, status]
requires:
  - phase: 03-chat-workspace-motion-activity-and-command-bridge
    provides: Conversation-aware chat webview, provider streaming, status refresh, and setup routing from Plan 03-01
provides:
  - Parsed GSD planning status with phase/plan progress, execution state, agent count, and cost/budget context
  - Accessible NEAR motion states for reasoning, streaming, waiting, completion, and failure with reduced-motion fallback
  - Searchable in-chat Open-GSD command launcher with validated host routing and project-aware prompts
  - Recommended continuation controls after completion, cancellation, failure, and setup recovery
affects: [04-agents-routing-approvals-analytics, 05-verification-hardening-release]
tech-stack:
  added: []
  patterns: [non-sensitive planning metadata parsing, explicit UI motion state machine, validated webview command routing]
key-files:
  created: [src/domain/motion.ts, src/test/motion.test.ts]
  modified: [src/domain/gsdStatus.ts, src/domain/gsdCommands.ts, src/services/chat.ts, src/services/chatBridge.ts, src/services/gsdCommands.ts, src/test/gsdStatus.test.ts, src/test/gsdCommands.test.ts]
key-decisions:
  - "Keep status parsing limited to non-sensitive STATE.md and ROADMAP.md metadata; never expose prompts or chain-of-thought." 
  - "Represent motion as explicit reasoning/streaming/waiting/complete/failure states with aria-live copy and a prefers-reduced-motion fallback." 
  - "Validate command selections against the known Open-GSD catalog before routing them into chat, while allowing broad text search across command metadata." 
requirements-completed: [ONB-02, ONB-03, CHAT-03, CHAT-04, CHAT-05, GSD-03]
coverage:
  - id: D1
    description: "GSD status parsing and formatting expose project completion, phase/plan, execution, agents, and cost context without sensitive content."
    requirement: CHAT-05
    verification:
      - kind: unit
        ref: src/test/gsdStatus.test.ts#planning state parses progress, execution, agents, and cost context
        status: pass
      - kind: other
        ref: npm run lint
        status: pass
    human_judgment: false
  - id: D2
    description: "Chat motion communicates reasoning, streaming, waiting, completion, and failure with accessible status semantics and reduced-motion CSS."
    requirement: CHAT-03
    verification:
      - kind: unit
        ref: src/test/motion.test.ts#motion states provide accessible status copy without exposing reasoning
        status: pass
      - kind: other
        ref: npm run package
        status: pass
    human_judgment: true
    rationale: "Automated checks verify state copy and packaging; visual animation and keyboard/screen-reader behavior still need interactive VS Code webview validation."
  - id: D3
    description: "Users can search Open-GSD command names, descriptions, and categories, then open a project-aware chat workflow prompt."
    requirement: GSD-03
    verification:
      - kind: unit
        ref: src/test/gsdCommands.test.ts#command discovery searches command, title, category, and description
        status: pass
      - kind: other
        ref: npm test
        status: pass
    human_judgment: true
    rationale: "The catalog/search boundary is automated; clicking the launcher in a VS Code webview remains an interactive smoke check."
  - id: D4
    description: "Completed, cancelled, failed, and setup-blocked responses leave a visible actionable continuation or recovery control."
    requirement: CHAT-04
    verification:
      - kind: other
        ref: npm run package
        status: pass
    human_judgment: true
    rationale: "The webview event wiring is packaged and type-checked, but terminal-state visibility requires interactive extension-host verification."
metrics:
  duration: approximately 45m
  completed: 2026-10-25
  status: complete
commits: 0
plan_head_before: unavailable
plan_head_after: unavailable
status: complete
---

# Phase 3 Plan 2: GSD Progress, Motion, and Next-Action Guidance Summary

**A status-rich, accessible chat shell with explicit NEAR motion states, searchable Open-GSD command discovery, and continuation guidance after every terminal response.**

## Performance

- **Duration:** approximately 45 minutes.
- **Completed:** 2026-10-25.
- **Tasks:** 1 plan task completed.
- **Files modified:** 9 implementation/test files, plus this summary.

## Accomplishments

- Added safe parsers for `STATE.md`/`ROADMAP.md` metadata and expanded the persistent status line with calculated progress, phase/plan position, execution state, agent count, and optional estimated/budget cost values.
- Added explicit motion presentation states and wired the NEAR indicator to reasoning, streaming, waiting, completion, failure, and setup recovery; reduced-motion CSS disables animation while accessible live text remains available.
- Added searchable in-chat command discovery across command names, titles, categories, and descriptions. Selections are validated against the catalog in the extension host before a project-aware prompt is placed in chat.
- Kept the continuation card available after completion, cancellation, and failure, with progress refresh and setup recovery actions linked from the same chat surface.
- Added focused unit coverage for planning metadata, motion accessibility copy, and command search; the complete test suite and VSIX package pass.

## Task Commits

Git commits were unavailable. The workspace contains an empty read-only `.git` directory, and Git reports that it is not a repository. No commit hashes are fabricated; `commits: 0`, `plan_head_before: unavailable`, and `plan_head_after: unavailable` are intentional.

1. **Task 1: Implement GSD status, motion, command discovery, and next-action guidance** — no commit (repository unavailable)

## Files Created/Modified

- `src/domain/gsdStatus.ts` - Non-sensitive planning-state parser and expanded status formatting.
- `src/domain/motion.ts` - Explicit motion states and accessible presentation copy.
- `src/domain/gsdCommands.ts` - Searchable Open-GSD command catalog.
- `src/services/chat.ts` - Status wiring, command routing, motion transitions, command launcher, and terminal continuation behavior.
- `src/services/chatBridge.ts` - Validated `open-command` webview protocol message.
- `src/services/gsdCommands.ts` - Search catalog export and picker integration.
- `src/test/gsdStatus.test.ts`, `src/test/motion.test.ts`, `src/test/gsdCommands.test.ts` - Focused regression coverage.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected the command-search test contract**
- **Found during:** Verification.
- **Issue:** Searching `review` correctly matches the progress command's recommendation description in addition to review commands, but the first assertion assumed category-only matching.
- **Fix:** Updated the assertion to reflect the specified search-across-metadata behavior and retained a category-specific command assertion.
- **Files modified:** `src/test/gsdCommands.test.ts`.
- **Verification:** Full unit suite passes.
- **Committed in:** Not committed; repository unavailable.

### Workspace Constraints

- Git commits and measured commit ranges were unavailable because `.git` is an empty read-only directory. This is recorded rather than repaired by initializing or mutating repository metadata.
- No interactive VS Code extension-host/live-provider smoke harness or credential was available; visual motion, keyboard, screen-reader, command-click, and terminal-card behavior remain human verification items.

**Total deviations:** 1 auto-fixed test-contract issue; no scope expansion and no Phase 4 work.

## Known Stubs

- `src/services/chat.ts:133` - The composer retains the intentional input hint `Describe your project or ask what to do next…`; this is native form guidance, not a missing data source.

## User Setup Required

None added. Interactive verification requires opening the packaged extension in VS Code; live chat additionally requires the existing NEAR AI setup flow and a valid user-provided credential.

## Next Phase Readiness

Phase 3 Plans 03-01 and 03-02 are implemented and summarized. Phase 4 was not started. The chat now exposes the status, motion, command, and continuation surfaces that later agent lifecycle and approval work can populate with live activity data.

---
*Phase: 03-chat-workspace-motion-activity-and-command-bridge*
*Completed: 2026-10-25*

## Self-Check: PASSED

- Summary file exists at the required path.
- `status: complete` is present.
- Automated verification passed: `npm run lint`, `npm test` (9/9), and `npm run package`.
- No Git commit claims were made because the repository is unavailable.
