---
phase: 03-chat-workspace-motion-activity-and-command-bridge
plan: 03
subsystem: command-bridge
tags: [vscode, open-gsd, codex, child-process, webview, security, testing]
requires:
  - phase: 03-chat-workspace-motion-activity-and-command-bridge
    provides: Validated GSD command catalog, chat webview, planning status parser, and extension entry points
provides:
  - Cancellable official Open-GSD command runner with typed ordered progress events
  - Live chat command execution and nearAi.gsdProgress routing
  - Planning artifact discovery, safe workspace links, and VS Code document opening
  - Automated runner, protocol, artifact, and catalog coverage
affects: [04-agents-routing-approvals-analytics, 05-verification-hardening-release]
actuals:
  tokens: 10985
  tasks: 2
  commits: 0
plan_head_before: unavailable
plan_head_after: unavailable
tech-stack:
  added: []
  patterns: [typed argv child-process boundary, redacted line progress events, planning-scoped artifact allowlist]
key-files:
  created: [src/services/gsdRunner.ts, src/test/gsdRunner.test.ts, src/test/chat.test.ts]
  modified: [src/services/chat.ts, src/services/chatBridge.ts, src/extension.ts, src/test/chatBridge.test.ts]
key-decisions:
  - "Invoke the installed Open-GSD Codex command form through typed codex exec argv with the active workspace as cwd; never interpolate a shell command."
  - "Expose only redacted stdout/stderr lifecycle text and non-sensitive planning artifact paths to the webview."
  - "Permit opening only discovered .planning STATE, ROADMAP, phase PLAN, SUMMARY, and VERIFICATION files beneath the workspace root."
requirements-completed: [GSD-01, GSD-02, CHAT-02, TEST-01, SEC-01]
status: complete
commits: 0
duration: 35m
completed: 2026-10-25
coverage:
  - id: D1
    description: "Catalogued Open-GSD workflows map to an official runtime invocation with workspace cwd, ordered output, completion, and cancellation."
    requirement: GSD-01
    verification:
      - kind: unit
        ref: src/test/gsdRunner.test.ts#Open-GSD progress workflow uses workspace cwd, typed argv, ordered output, and completion
        status: pass
      - kind: unit
        ref: src/test/gsdRunner.test.ts#cancellation reaches only the active Open-GSD process
        status: pass
      - kind: other
        ref: npm run package
        status: pass
    human_judgment: true
    rationale: "The packaged VS Code extension path is type-checked and packaged, but live Codex/Open-GSD execution requires an extension-host smoke test."
  - id: D2
    description: "Chat and nearAi.gsdProgress use the live command runner and render typed command progress states."
    requirement: CHAT-02
    verification:
      - kind: unit
        ref: src/test/gsdRunner.test.ts#every catalogued workflow maps to the official runtime command form
        status: pass
      - kind: other
        ref: npm test
        status: pass
    human_judgment: true
    rationale: "Runtime webview rendering and the host command registration need interactive VS Code validation."
  - id: D3
    description: "Chat exposes safe links for discovered GSD planning artifacts and opens them through VS Code document APIs."
    requirement: GSD-02
    verification:
      - kind: unit
        ref: src/test/chat.test.ts#chat artifact links are planning-scoped and exclude arbitrary workspace files
        status: pass
      - kind: unit
        ref: src/test/chatBridge.test.ts#webview message parsing accepts only the typed chat protocol
        status: pass
    human_judgment: true
    rationale: "Actual click-through and document opening require a VS Code extension-host smoke test."
  - id: D4
    description: "Command and artifact boundaries reject unknown commands, traversal paths, arbitrary absolute paths, and secret-bearing output."
    requirement: SEC-01
    verification:
      - kind: unit
        ref: src/test/gsdRunner.test.ts#unknown commands and unsafe workspace values are rejected before spawning
        status: pass
      - kind: unit
        ref: src/test/chat.test.ts#chat artifact links are planning-scoped and exclude arbitrary workspace files
        status: pass
    human_judgment: false
---

# Phase 3 Plan 3: Open-GSD Command Bridge Summary

**Real Open-GSD command execution with typed streamed progress, live progress entry points, and safe planning-artifact links.**

## Performance

- **Duration:** approximately 35 minutes
- **Completed:** 2026-10-25
- **Tasks:** 2 completed
- **Files modified:** 7 implementation/test files, plus this summary

## Accomplishments

- Added `GsdRunner`, which validates the catalog, invokes the installed Codex/Open-GSD command form with typed argv and workspace cwd, streams redacted stdout/stderr, reports lifecycle states, and cancels only its active child process.
- Replaced chat command prefill behavior with real host-side execution and routed `nearAi.gsdProgress` through the same live `/progress` runner.
- Added typed command-progress and artifact-link protocol messages, planning artifact discovery, traversal/allowlist checks, and VS Code document opening for discovered planning files.
- Added deterministic fake-process coverage for workspace arguments, output ordering, completion, cancellation, all catalog entries, protocol validation, artifact discovery, and path containment.

## Task Commits

Git commits were unavailable. The workspace contains an empty read-only `.git` directory and Git reports that it is not a repository. No commit hashes are fabricated; `commits: 0` is intentional.

1. **Task 1: Run one Open-GSD progress workflow end to end** — no commit (repository unavailable)
2. **Task 2: Expand command entry points and planning-artifact links** — no commit (repository unavailable)

## Files Created/Modified

- `src/services/gsdRunner.ts` - Typed, cancellable Open-GSD process boundary and invocation builder.
- `src/services/chatBridge.ts` - Command-progress, artifact-link, protocol, discovery, and path-safety helpers.
- `src/services/chat.ts` - Live command routing, progress messages, artifact links, and safe document opening.
- `src/extension.ts` - Real `nearAi.gsdProgress` and catalog command entry-point routing.
- `src/test/gsdRunner.test.ts` - Runner, cancellation, safety, and catalog coverage.
- `src/test/chatBridge.test.ts` - Webview protocol safety coverage.
- `src/test/chat.test.ts` - Planning artifact discovery and containment coverage.

## Decisions Made

- The runner uses the installed Codex runtime command form (`codex exec --cd <workspace> $gsd-<command>`) with `shell: false`; no package installation or shell interpolation was added.
- Webview command output is line-oriented, redacted, and limited to lifecycle text; credentials, prompts, environment dumps, and arbitrary filesystem paths are not bridged.
- Artifact links are generated from the local `.planning` tree and limited to `STATE.md`, `ROADMAP.md`, phase `PLAN`, `SUMMARY`, and `VERIFICATION` files.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] Preserved the existing provider chat path while adding a separate command runner**
- **Found during:** Task 1
- **Issue:** The existing chat stream and command launcher share a webview but have different cancellation and data-boundary requirements; replacing the provider path would have expanded scope and risked regression.
- **Fix:** Added an independent `GsdRunner` state/process boundary and command-progress protocol while leaving the provider stream separate.
- **Files modified:** `src/services/gsdRunner.ts`, `src/services/chat.ts`, `src/services/chatBridge.ts`
- **Verification:** `npm run lint`, `npm test`, and `npm run package` passed.
- **Committed in:** Not committed; repository unavailable.

**Total deviations:** 1 scope-preserving implementation adjustment. No package was installed and no Phase 4/03-04/03-05 work was executed.

## Known Stubs

- `src/services/chat.ts:163,166,183` - Native `placeholder` attributes provide input/search guidance. They are intentional UI hints, not missing data sources.

## Verification

- `npm run lint` — passed.
- `npm test` — passed, 11 tests, 0 failures, 0 skipped/todo.
- `npm run package` — passed; `near-ai-vscode-0.1.0.vsix` produced.
- No live VS Code extension-host smoke test or configured Codex/Open-GSD process run was available in this environment; that remains human verification for the packaged path.

## Next Phase Readiness

03-03 implementation and automated verification are complete. Plans 03-04 and 03-05 remain untouched. Phase 4 was not started. The remaining verification need is interactive VS Code validation of command execution, progress rendering, artifact clicks, and `nearAi.gsdProgress`.

---
*Phase: 03-chat-workspace-motion-activity-and-command-bridge*
*Plan: 03*
*Completed: 2026-10-25*

## Self-Check: PASSED

- Summary file exists at the required path.
- All seven planned implementation/test files exist.
- `npm run lint`, `npm test`, and `npm run package` passed.
- Git commit claims were not made because the workspace has no usable Git repository.
